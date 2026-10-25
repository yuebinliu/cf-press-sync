#!/usr/bin/env node
/**
 * 一键部署引导：创建 Cloudflare 资源（D1 / KV / R2）并生成 wrangler.toml
 *
 * 用法（在 worker/ 目录下）：
 *   node scripts/setup.mjs                # 实际创建
 *   node scripts/setup.mjs --dry-run      # 只打印将执行的命令，不创建任何东西
 *   node scripts/setup.mjs --name=my-site # 自定义资源名前缀（默认 wp-static-pro）
 *   node scripts/setup.mjs --force        # 已存在 wrangler.toml 时覆盖它
 *
 * 已有资源时不必用它：直接 cp wrangler.toml.example wrangler.toml 手工填 ID 即可。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const nameArg = argv.find((a) => a.startsWith('--name='));
const base = (nameArg ? nameArg.split('=')[1] : 'wp-static-pro').trim() || 'wp-static-pro';

const rl = dryRun ? null : createInterface({ input: process.stdin, output: process.stdout });

function say(msg) { console.log(msg); }

function wrangler(args) {
    const line = 'npx wrangler ' + args.join(' ');
    if (dryRun) { say('  [dry-run] ' + line); return ''; }
    say('  $ ' + line);
    try {
        return execFileSync('npx', ['wrangler', ...args], { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
    } catch (e) {
        say('  ⚠️ 命令失败：' + String(e.message || e).split('\n')[0]);
        return '';
    }
}

/** 从 wrangler 输出里找 id（各版本格式不一，做了多种匹配；找不到就交给用户手工填） */
function pickId(out, kind) {
    if (!out) return '';
    const patterns = kind === 'd1'
        ? [/database_id\s*=\s*"([0-9a-f-]{36})"/i, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i]
        : [/id\s*=\s*"([0-9a-f]{32})"/i, /([0-9a-f]{32})/i];
    for (const re of patterns) {
        const m = out.match(re);
        if (m) return m[1];
    }
    return '';
}

async function ask(question, fallback = '') {
    if (dryRun) { say('  [dry-run] 会询问：' + question); return fallback; }
    const ans = (await rl.question(question)).trim();
    return ans || fallback;
}

async function main() {
    const tomlPath = path.join(root, 'wrangler.toml');
    if (existsSync(tomlPath) && !force && !dryRun) {
        const ans = await ask(`wrangler.toml 已存在，要覆盖吗？(y/N) `, 'n');
        if (ans.toLowerCase() !== 'y') { say('已取消（保留现有 wrangler.toml）。'); rl.close(); return; }
    }

    say('== 1/4 创建 D1 数据库 ==');
    let d1Out = wrangler(['d1', 'create', base]);
    let d1Id = pickId(d1Out, 'd1');
    let d1Name = base;
    if (!dryRun && !d1Id) {
        say('  没能从输出里识别 database_id，请到 Cloudflare Dashboard → D1 复制。');
        d1Id = await ask('  database_id（留空则写占位符，稍后手填）: ');
        d1Name = await ask(`  database_name [${base}]: `, base);
    }

    say('\n== 2/4 创建 KV 命名空间 ==');
    let kvOut = wrangler(['kv', 'namespace', 'create', base + '-cache']);
    let kvId = pickId(kvOut, 'kv');
    if (!dryRun && !kvId) {
        say('  没能识别 KV id，请到 Dashboard → KV 复制。');
        kvId = await ask('  KV id（留空则写占位符）: ');
    }

    say('\n== 3/4 创建 R2 桶 ==');
    const bucket = base;
    wrangler(['r2', 'bucket', 'create', bucket]);
    const bucketName = await ask(`  R2 桶名 [${bucket}]: `, bucket);

    say('\n== 4/4 生成 wrangler.toml ==');
    const examplePath = path.join(root, 'wrangler.toml.example');
    let toml = readFileSync(examplePath, 'utf8');
    toml = toml
        .replace(/^name = ".*"$/m, `name = "${base}"`)
        .replace(/^bucket_name = ".*"$/m, `bucket_name = "${bucketName || bucket}"`)
        .replace(/^database_name = ".*"$/m, `database_name = "${d1Name}"`)
        .replace(/^database_id = ".*"$/m, `database_id = "${d1Id || 'REPLACE_WITH_YOUR_D1_ID'}"`)
        .replace(/^id = ".*"$/m, `id = "${kvId || 'REPLACE_WITH_YOUR_KV_ID'}"`);
    if (dryRun) {
        say('  [dry-run] 将写入 wrangler.toml（内容略）');
    } else {
        writeFileSync(tomlPath, toml, 'utf8');
        say('  ✅ 已写入 ' + tomlPath);
    }

    say('\n下一步：');
    say('  1) npm run deploy                 # 部署 Worker');
    say('  2) 打开 https://<你的域名>/admin/  # 空库时会进初始化向导，创建第一个管理员');
    say('     （或用 curl：POST /api/setup {\"username\":\"…\",\"password\":\"…\",\"siteName\":\"…\"}；状态见 GET /api/setup/status）');
    say('  3) 内容来源三选一：WP 插件推送 / 第三方 md 编辑器（/wp-json/wp/v2/* + 应用密码）/ 后台直接写');
    if (rl) rl.close();
}

main().catch((e) => {
    console.error('setup 失败：', e);
    process.exit(1);
});
