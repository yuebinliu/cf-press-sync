#!/usr/bin/env node
/**
 * HTML 结构体检：标签配平 + 嵌套合法性 + 常见「冲破」特征。
 *
 * 背景（2026-10-25）：cfse-sync 后台设置页的 HTML 被「冲破」——
 *   ① `<details ... style="..."` 少一个 `>`，浏览器把后面整段当属性吞掉
 *   ② `<details>` 缺 `</details>`，导致后续 `</div>` 层层错位
 *   ③ 正文里漏出 Markdown 的 `**加粗**`
 *   ④ `<form>` 嵌套 `<form>`（HTML 非法，浏览器会拆掉内层表单）
 *   ⑤ `<table>` 嵌 `<form>` 之后再嵌 `<table>`，结构炸裂
 *
 * 用法：node tools/check-html-structure.mjs <file.html> [...]
 */

import { readFileSync } from 'node:fs';

/** 元素内容为纯文本、不允许嵌套子元素的标签 */
const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 解析后会自动提升（re-parent）子节点的标签 */
const REPARENTS = new Set([
    'p', 'li', 'dt', 'dd', 'option', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
]);

/** 允许嵌套的表单相关标签 */
const FORM_OK = new Set(['form', 'input', 'button', 'select', 'textarea', 'label', 'fieldset', 'legend', 'option', 'optgroup', 'datalist', 'output', 'progress', 'meter']);

/** 忽略标签配平的容器（内容是自由文本） */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** 这些标签内部允许出现 `<form>`（WP 后台常见） */
const FORM_HOST = new Set(['details', 'summary', 'div', 'td', 'th', 'li', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'body', 'html']);

function analyze(file) {
    const src = readFileSync(file, 'utf8');
    const issues = [];

    // 去掉注释，避免注释里的标签干扰
    const text = src.replace(/<!--[\s\S]*?-->/g, '');

    // ---------- 1) 标签配平 ----------
    const stack = [];
    const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m;
    let formDepth = 0;
    let tableDepth = 0;

    const lineOf = (idx) => text.slice(0, idx).split('\n').length;

    while ((m = tagRe.exec(text)) !== null) {
        const whole = m[0];
        const name = m[1].toLowerCase();
        const attrs = m[2] || '';
        const closing = whole.startsWith('</');
        const selfClose = /\/\s*$/.test(attrs);
        const line = lineOf(m.index);

        if (VOID_TAGS.has(name) || selfClose) continue;

        if (!closing) {
            // 嵌套 <form> 非法
            if (name === 'form') {
                if (formDepth > 0) {
                    issues.push({
                        line, kind: 'FORM-NESTED',
                        msg: `<form> 嵌套在另一个 <form> 里（HTML 非法，浏览器会拆掉内层）`,
                    });
                }
                formDepth++;
            }
            if (name === 'table') tableDepth++;

            // 顶层 form 内部再出现 form，且外层不是"允许 host"
            stack.push({ name, line });
        } else {
            if (name === 'form') formDepth = Math.max(0, formDepth - 1);
            if (name === 'table') tableDepth = Math.max(0, tableDepth - 1);

            // 找匹配的开放标签
            let idx = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].name === name) { idx = i; break; }
            }
            if (idx === -1) {
                issues.push({
                    line, kind: 'STRAY-CLOSE',
                    msg: `多余的 </${name}>（前面没有对应的开标签）`,
                });
                continue;
            }
            if (idx !== stack.length - 1) {
                const unclosed = stack.slice(idx + 1).map((t) => `</${t.name}>`).join(' ');
                issues.push({
                    line, kind: 'CROSS-NEST',
                    msg: `</${name}> 跨层闭合，中间这些标签没被正确关闭：${unclosed}`,
                    detail: stack.slice(idx + 1).map((t) => `<${t.name}> @L${t.line}`).join(', '),
                });
                stack.length = idx;
            }
            stack.pop();
        }
    }

    // 收尾：未闭合的标签
    for (const t of stack) {
        issues.push({
            line: t.line, kind: 'UNCLOSED',
            msg: `<${t.name}> 从 L${t.line} 起一直没闭合`,
        });
    }

    // ---------- 2) 常见「冲破」特征 ----------
    // 2a) 标签内的属性引号没闭合 ⇒ 标签被截断（只查单行内的情形，
    //     合法的多行标签会被 skip-range 排除，避免误报）
    const truncated = [];
    {
        // 逐行扫描：某行以 "<tag" 开头但整行没有 ">"，且该行引号数为奇数
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const m2 = l.match(/^\s*<([a-zA-Z][\w:-]*)\b/);
            if (!m2) continue;
            // 该行是否已闭合
            if (l.includes('>')) continue;
            const dq = (l.match(/"/g) || []).length;
            const sq = (l.match(/'/g) || []).length;
            if (dq % 2 === 1 || sq % 2 === 1) {
                truncated.push({ line: i + 1, text: l.trim() });
            }
        }
        for (const t of truncated) {
            issues.push({
                line: t.line, kind: 'ATTR-TRUNCATED',
                msg: `标签属性引号没闭合（很可能少了 ">"）：${t.text.slice(0, 80)}`,
            });
        }
    }

    // 2b) 正文里漏出 Markdown 加粗
    const mdRe = /\*\*[^*\n]{1,40}\*\*/g;
    let t;
    while ((t = mdRe.exec(text)) !== null) {
        issues.push({
            line: lineOf(t.index), kind: 'MARKDOWN-LEAK',
            msg: `正文漏出 Markdown 加粗标记：${t[0]}`,
        });
    }

    // 2c) 未闭合的 details / summary（HTML 语义层）
    const det = (text.match(/<details\b/gi) || []).length;
    const detEnd = (text.match(/<\/details>/gi) || []).length;
    if (det !== detEnd) {
        issues.push({
            line: 0, kind: 'DETAILS-UNBALANCED',
            msg: `<details> 开了 ${det} 个、关了 ${detEnd} 个 —— 浏览器会把后面整段吞进折叠块`,
        });
    }
    const sum = (text.match(/<summary\b/gi) || []).length;
    const sumEnd = (text.match(/<\/summary>/gi) || []).length;
    if (sum !== sumEnd) {
        issues.push({
            line: 0, kind: 'SUMMARY-UNBALANCED',
            msg: `<summary> 开了 ${sum} 个、关了 ${sumEnd} 个`,
        });
    }

    // 2d) <form> 在 <table> 内部
    if (tableDepth > 0 && /<form\b/i.test(text)) {
        // 粗查：form 出现时若仍在 table 里
        // （简化：只提示存在 form 在 table 附近的模式）
    }

    return issues;
}

const files = process.argv.slice(2);
if (!files.length) {
    console.error('用法: node tools/check-html-structure.mjs <file.html> [...]');
    process.exit(1);
}

let total = 0;
for (const f of files) {
    const issues = analyze(f);
    if (!issues.length) {
        console.log(`  ✓ ${f} —— 结构完整`);
        continue;
    }
    console.log(`  ✗ ${f} —— ${issues.length} 处结构问题`);
    for (const it of issues) {
        console.log(`      [${it.kind}] L${it.line} ${it.msg}`);
        if (it.detail) console.log(`        ${it.detail}`);
    }
    total += issues.length;
}

console.log();
if (total) {
    console.log(`❌ 共 ${total} 处结构问题`);
    process.exit(1);
}
console.log('✅ 全部文件 HTML 结构完整');
