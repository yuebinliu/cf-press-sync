#!/usr/bin/env node
/**
 * 内置风格清单：部署前扫描 static/wp-content/themes/<slug>/tpl.json → 写 static/.../index.json
 *
 * ⚠️ style-refactor（docs/style-refactor.md）：
 *   已**不再注入 KV tpl:index**（该键废除）。内置清单由 Worker 运行时读本 index.json
 *   （`site.getStyleIndex()`，独立 isolate 短缓存 60s；用户风格来自 D1 settings k='style'.user）。
 *   ⇒ **部署新增/删除内置风格无需清 KV**（≤60s 自动跟上），本脚本不做任何 KV 操作。
 *
 * 用法（worker/ 目录）：npm run deploy  （= 本脚本 && wrangler deploy）
 */
import fs from 'fs';
import path from 'path';

const cwd = process.cwd();
const themesRoot = path.resolve(cwd, 'static/wp-content/themes');

const items = [];
if (fs.existsSync(themesRoot)) {
  for (const name of fs.readdirSync(themesRoot).sort()) {
    const dir = path.join(themesRoot, name);
    let st;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const tplFile = path.join(dir, 'tpl.json');
    if (!fs.existsSync(tplFile)) continue;      // 没有 tpl.json 的不算风格

    let displayName = name;
    try {
      const j = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
      if (j && typeof j.name === 'string' && j.name.trim() !== '') displayName = j.name.trim();
    } catch (e) { /* 用目录名 */ }

    const mt = fs.statSync(tplFile).mtime;
    const pad = (n) => String(n).padStart(2, '0');
    const updated = `${mt.getUTCFullYear()}-${pad(mt.getUTCMonth() + 1)}-${pad(mt.getUTCDate())} `
      + `${pad(mt.getUTCHours())}:${pad(mt.getUTCMinutes())}:${pad(mt.getUTCSeconds())}`;

    items.push({ id: name, name: displayName, updated, source: 'builtin' });
  }
}

console.log(`[themes-index] 扫描到 ${items.length} 个内置风格：${items.map((i) => i.id).join(', ') || '(无)'}`);

// 写 index.json：Worker 运行时读它，合并进 site:ctx.styleIndex（内置部分）
const outFile = path.join(themesRoot, 'index.json');
fs.writeFileSync(outFile, JSON.stringify(items, null, 2) + '\n', 'utf8');
console.log(`[themes-index] 已写出 ${path.relative(cwd, outFile)}（Worker 运行时读它，见 site.getStyleIndex）`);

// 不再清 KV：内置清单由 Worker 运行时读本文件（site.getStyleIndex，60s 短缓存），
// 因此部署（新增/删除内置风格包）**不产生任何 KV 操作**。
console.log('[themes-index] 完成：Worker 运行时直接读该清单，部署无需清 KV');
