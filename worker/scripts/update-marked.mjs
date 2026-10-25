#!/usr/bin/env node
/**
 * update-marked.mjs —— 更新 CFSE 里 vendored 的 marked（后台 SPA 预览用）
 *                      + package.json 里 Worker 运行时（src/md.js）的 marked 版本。
 *
 * 为什么有两份：
 *   ① Worker 渲染（前台单页 / 按需渲染）：src/md.js 里 `import { marked } from 'marked'`，
 *      版本由 package.json 的 dependencies 决定，由 wrangler 打包 ⇒ 改完必须
 *      `npm install && npm run deploy` 才生效。
 *   ② 后台 SPA（浏览器）：static/admin/index.html 直接引 `/admin/vendor/marked.min.js`，
 *      是一份手动 vendored 的单文件 ⇒ 由本脚本覆盖，随 `wrangler deploy` 一起上线。
 *
 * ⚠️ marked 的文件布局变过：
 *      v12 及以前：`marked.min.js`（已压缩）
 *      v13 及以后：`lib/marked.umd.js`（UMD，浏览器可直接用，暴露 window.marked）
 *   脚本会依次尝试这两种路径，自动选能下载到的那个（落地文件名都保持 marked.min.js）。
 *
 * 用法：
 *   node worker/scripts/update-marked.mjs                # 取 npm 上的 latest
 *   node worker/scripts/update-marked.mjs --version=12.0.2
 *   node worker/scripts/update-marked.mjs --dry-run      # 只看会做什么，不写文件
 *
 * 注意：marked 跨大版本可能改 API / 输出细节 ⇒ 更新后请把一篇 md 文章的单页
 *      （线上 + 后台预览）各看一遍。老版本文件会备份到 worker/.marked-backup/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENDOR = path.join(ROOT, 'static', 'admin', 'vendor', 'marked.min.js');
const PKG = path.join(ROOT, 'package.json');
const BACKUP = path.join(ROOT, '.marked-backup');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verArg = (args.find((a) => a.startsWith('--version=')) || '').split('=')[1] || '';

// 两套布局的候选路径（按优先顺序）
const PATHS = ['marked.min.js', 'lib/marked.umd.js'];
const CDNS = [
  (v, p) => `https://cdn.jsdelivr.net/npm/marked@${v}/${p}`,
  (v, p) => `https://unpkg.com/marked@${v}/${p}`,
];

async function latestVersion() {
  const r = await fetch('https://registry.npmjs.org/marked/latest', {
    headers: { accept: 'application/json' },
  });
  if (!r.ok) throw new Error('查询 npm latest 失败：HTTP ' + r.status);
  const j = await r.json();
  return j.version;
}

async function download(ver) {
  const tried = [];
  for (const p of PATHS) {
    for (const mk of CDNS) {
      const url = mk(ver, p);
      let r;
      try {
        r = await fetch(url, { redirect: 'follow' });
      } catch (e) {
        tried.push('ERR ' + url + ' (' + e.message + ')');
        continue;
      }
      if (!r.ok) {
        tried.push('HTTP ' + r.status + ' ' + url);
        continue;
      }
      const text = await r.text();
      if (text.length < 10000 || !/marked/.test(text.slice(0, 600))) {
        tried.push('BAD-CONTENT(' + text.length + ') ' + url);
        continue;
      }
      return { url, text };
    }
  }
  throw new Error('该版本下载不到 marked（已尝试）：\n  ' + tried.join('\n  '));
}

function vendorVersion() {
  if (!fs.existsSync(VENDOR)) return '';
  const head = fs.readFileSync(VENDOR, 'utf8').slice(0, 600);
  const m = head.match(/marked v([0-9]+\.[0-9]+\.[0-9]+)/);
  return m ? m[1] : '';
}

function pkgVersion() {
  const j = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  return j.dependencies && j.dependencies.marked ? j.dependencies.marked : '';
}

const ver = verArg || (await latestVersion());
console.log('目标版本      :', ver);
console.log('vendor 现值   :', vendorVersion() || '(未识别)');
console.log('package.json  :', pkgVersion() || '(无)');

const got = await download(ver);
console.log('下载成功      :', got.url);
console.log('下载大小      :', got.text.length, '字节');

if (dryRun) {
  console.log('\n--dry-run：不写任何文件。');
} else {
  fs.mkdirSync(BACKUP, { recursive: true });
  if (fs.existsSync(VENDOR)) {
    const old = vendorVersion() || 'unknown';
    fs.copyFileSync(VENDOR, path.join(BACKUP, 'marked.min.js.' + old));
    console.log('已备份旧文件  : worker/.marked-backup/marked.min.js.' + old);
  }
  fs.writeFileSync(VENDOR, got.text);
  console.log('已写入        : worker/static/admin/vendor/marked.min.js');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  const oldDep = pkg.dependencies.marked || '(无)';
  pkg.dependencies.marked = '^' + ver;
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
  console.log('package.json  :', oldDep, '→ ^' + ver);
}

console.log('\n接下来：');
console.log('  1) cd worker && npm install && npm run deploy   # Worker 侧 src/md.js 的 marked 生效');
console.log('  2) 把 worker/static/admin/vendor/marked.min.js 同步到服务器上的插件副本（若有）');
console.log('  3) 抽查一篇 md 文章：线上单页 + 后台预览是否正常');
