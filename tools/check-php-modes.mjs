#!/usr/bin/env node
/**
 * 检查 PHP 混排文件里的「PHP 模式断点」。
 *
 * 背景：PHP 文件里 `?>` 退出 PHP 模式，直到下一个 `<?php` 才恢复。
 *      如果 `?>` 之后接的是**代码**（而不是 HTML），那段代码会被当成
 *      HTML 文本输出 —— **PHP 不报错**（语法完全合法！），但代码静默失效。
 *
 *      真实踩过的坑（2026-10-25）：class-admin-ui.php 的
 *      render_hosting_targets_table() 末尾 `<?php } ?>` 之后没恢复 PHP 模式，
 *      导致后面 7 个方法（get_export_stats / get_recent_logs / site_dir_of / …）
 *      全部变成 HTML 文本 —— 类里只剩 15 个方法，调用时无限递归，
 *      而且 `php -l` 完全通过（语法合法）。
 *
 * 检查方法：
 *   ① 先扫出所有 <script>…</script> / <style>…</style> 的内容范围
 *      （这些是 JS/CSS，被当 HTML 是正常的）
 *   ② 再扫 PHP 模式段（<?php … ?>）与 HTML 段（?> … <?php）
 *   ③ HTML 段里若出现「行首是 PHP 代码」的行 ⇒ 断点
 *
 * 用法：node tools/check-php-modes.mjs <file.php> [...]
 */

import { readFileSync } from 'node:fs';

/** 找出所有 script/style 块的内容区间 [start, end) */
function findCodeBlocks(src) {
    const blocks = [];
    const re = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
        blocks.push([m.index, m.index + m[0].length]);
    }
    return blocks;
}

function inBlocks(pos, blocks) {
    for (const [s, e] of blocks) {
        if (pos >= s && pos < e) return true;
    }
    return false;
}

/** PHP 代码特征：行首就是 PHP 语句 */
const PHP_CODE_LINE = /^(?:function\s+\w+\s*\(|(?:public|private|protected|static|abstract)\s+function\b|\$[a-zA-Z_]\w*\s*(?:[;)=]|\s*\.=|\s*\+=|\s*->)|return\b|echo\b|print\b|if\s*\(|else(?:if)?\s*(?:\{|:)|foreach\s*\(|for\s*\(|while\s*\(|do\s*\{|switch\s*\(|break;|continue;|throw\b|new\s+\w+\s*\(|try\s*\{|finally\s*\{|\}\s*$)/;

/** 扫出 PHP 段与 HTML 段 */
function scanSegments(src) {
    const segs = [];
    let i = 0;
    let inPhp = false;
    let segStart = 0;

    while (i < src.length) {
        if (!inPhp) {
            const p1 = src.indexOf('<?php', i);
            const p2 = src.indexOf('<?=', i);
            let next = -1, len = 0;
            if (p1 !== -1 && (p2 === -1 || p1 < p2)) { next = p1; len = 5; }
            else if (p2 !== -1) { next = p2; len = 3; }

            if (next === -1) {
                segs.push({ inPhp: false, start: i, end: src.length });
                break;
            }
            segs.push({ inPhp: false, start: i, end: next });
            inPhp = true;
            segStart = next;
            i = next + len;
        } else {
            const idx = src.indexOf('?>', i);
            if (idx === -1) {
                segs.push({ inPhp: true, start: segStart, end: src.length });
                break;
            }
            segs.push({ inPhp: true, start: segStart, end: idx + 2 });
            inPhp = false;
            i = idx + 2;
        }
    }
    return segs;
}

function analyze(file) {
    const src = readFileSync(file, 'utf8');
    const blocks = findCodeBlocks(src);
    const issues = [];

    for (const seg of scanSegments(src)) {
        if (seg.inPhp) continue;
        const text = src.slice(seg.start, seg.end);
        if (text.trim() === '') continue;

        const lines = text.split('\n');
        let offset = seg.start;
        for (const l of lines) {
            const lineStart = offset;
            offset += l.length + 1;

            if (inBlocks(lineStart, blocks)) continue;   // JS/CSS 块内，正常

            const t = l.trim();
            if (t === '') continue;
            if (/^<\/?[a-zA-Z]/.test(t)) continue;        // HTML 标签
            if (/^[{}();,]+$/.test(t)) continue;          // 纯括号（HTML 残片）
            if (!PHP_CODE_LINE.test(t)) continue;

            const line = src.slice(0, lineStart).split('\n').length;
            issues.push({
                line,
                code: t.slice(0, 80),
                ctx: src.slice(Math.max(0, lineStart - 100), lineStart + 100)
                    .replace(/\s+/g, ' ').trim(),
            });
        }
    }
    return issues;
}

const files = process.argv.slice(2);
if (!files.length) {
    console.error('用法: node tools/check-php-modes.mjs <file.php> [...]');
    process.exit(1);
}

let total = 0;
for (const f of files) {
    const issues = analyze(f);
    if (!issues.length) {
        console.log(`  ✓ ${f}`);
        continue;
    }
    console.log(`  ✗ ${f} —— ${issues.length} 处 PHP 模式断点`);
    for (const it of issues) {
        console.log(`      行 ${it.line}: ${it.code}`);
        console.log(`        上下文: ...${it.ctx}...`);
    }
    total += issues.length;
}

console.log();
if (total) {
    console.log(`❌ 共 ${total} 处断点（代码会被当 HTML 输出，静默失效）`);
    process.exit(1);
}
console.log('✅ 全部文件的 PHP 模式连续，无断点');
