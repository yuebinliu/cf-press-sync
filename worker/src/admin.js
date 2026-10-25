/**
 * admin.js —— Worker 管理后台 API（/api/*）
 * 鉴权：除 /api/login /api/refresh 外均需 Authorization: Bearer <access token>
 * 依赖：auth.js（JWT/登录）、cache.js（发布后清列表缓存）
 */
import { authenticate, signJwt, verifyJwt, bearerToken, loginRateLimit, accountLocked, accountFail, accountClear, hashPassword, verifyPassword } from './auth';
import { deleteCache, edgeDelete, edgePurge } from './cache';
import { CFSE_SINGLE_TPL, renderHomepage, renderCategoryPage, renderTagPage, renderArchivePage, cfseSidebarCategoryItems, cfseSidebarArchiveItems, cfseSidebarTagItems, cfseInjectHead, cfseNoReferrerImgs } from './template-engine';
import { mdToHtml, mdToText } from './md';
import { getSiteContext, clearSiteCtxMemo, getStyleIndex, clearStyleIndexMemo } from './site';
import { getActiveTpl } from './tplstore';
import { getActiveTplContent, getActiveSidebarTpl, getActiveCommentsTpl, getActiveLayout } from './tplstore';
import { getPostComments, cfseCommentItems, createComment } from './comments';
import { getCacheConfig } from './cacheconfig';
import { r2KeyFromPath, r2UrlPath } from './r2key';
import { getSidebarData } from './database';
import { validateRoutePrefix, validateDocPath, sourceKey, outKey, renderDocIndex, renderDocument, extractDocTitle, extractDocExcerpt, DEFAULT_DOC_SHELL } from './documents';

const ACCESS_TTL = 15 * 60;   // 15 min
const REFRESH_TTL = 7 * 86400; // 7 d

/** 粗略净化正文：移除脚本/样式/表单/危险属性（前台不可信编辑来源防护） */
function scrubHtml(html) {
    let h = String(html || '');
    h = h.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
    h = h.replace(/<style[\s\S]*?<\/style\s*>/gi, '');
    h = h.replace(/<(iframe|object|embed|form)\b[\s\S]*?<\/\1\s*>/gi, '');
    h = h.replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, '');
    h = h.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    h = h.replace(/\b(href|src|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"');
    return h;
}

// 写操作限速（内存滑窗：每用户 90 次/分钟；isolate 级，0 KV 成本）
const WRATE_LIMIT = 90;
const wrateMap = new Map();
function wrateAllowed(uid) {
    const now = Date.now();
    const e = wrateMap.get(uid);
    if (!e || now >= e.resetAt) {
        if (wrateMap.size > 32) { wrateMap.forEach(function (v, k) { if (now >= v.resetAt) wrateMap.delete(k); }); }
        wrateMap.set(uid, { n: 1, resetAt: now + 60000 });
        return true;
    }
    e.n++;
    return e.n <= WRATE_LIMIT;
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
}

function slugify(text) {
    let s = String(text || '').trim().toLowerCase();
    if (!s) return '';
    // 非 ASCII（中文等）→ 小写 %xx（与 WP sanitize_title 及库内既有 slug 形态一致，渲染端直接拼接）
    s = s.replace(/[^\x00-\x7F]+/g, function (m) { return encodeURIComponent(m).toLowerCase(); });
    // ASCII 部分：仅保留 a-z0-9%（%xx 编码用），其余连续字符 → '-'
    s = s.replace(/[^a-z0-9%]+/g, '-').replace(/^-+|-+$/g, '');
    return s;
}

/** WordPress 默认分类：无分类文章自动归入（对齐 WP get_option('default_category') 行为） */
const DEFAULT_CATEGORY = { name: 'Uncategorized', slug: 'uncategorized' };

/** 分类列表为空（或全部无效）时补默认分类 */
function withDefaultCategory(list) {
    const arr = (Array.isArray(list) ? list : []).filter(function (x) {
        if (!x) return false;
        return typeof x === 'string' ? x.trim() !== '' : String(x.name || '').trim() !== '';
    });
    return arr.length ? arr : [DEFAULT_CATEGORY];
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function nowDateTime() {
    return localDateTime(0);
}

/** 按站点时区偏移生成墙钟时间字符串 YYYY-MM-DD HH:MM:SS（与 WP 端 gmt_offset 对齐） */
function localDateTime(offsetSec) {
    const off = parseInt(offsetSec || 0, 10) || 0;
    const d = new Date(Date.now() + off * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
        + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

function excerptOf(content, len = 200) {
    const text = String(content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > len ? text.slice(0, len) + '...' : text;
}

/** 解析 DB 中 categories/tags 列的 JSON（失败返回空数组） */
function parseTaxoList(s) {
    try {
        const a = JSON.parse(String(s || '[]'));
        return Array.isArray(a) ? a : [];
    } catch (e) {
        return [];
    }
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** base64（UTF-8 文本）→ 字符串。**不能直接用 atob**（它按 Latin-1 解码，非 ASCII 会双重编码乱码）。 */
function b64ToUtf8(b64) {
    return new TextDecoder('utf-8').decode(b64ToBytes(b64));
}

/** 模板类型（6 类）：单页壳 / 列表条目 / 四种页面外壳 */
const TPL_KINDS = ['single', 'item', 'pageHome', 'pageCategory', 'pageTag', 'pageArchive'];
function tplKind(v) {
    const s = String(v || '');
    return TPL_KINDS.indexOf(s) >= 0 ? s : 'single';
}

/** 已废弃（tpl:index 不再使用）：返回 6 类空结构，兼容旧调用点 */
async function tplGetIndex(env) {
    const out = {};
    for (const k of TPL_KINDS) out[k] = [];
    return out;
}

// ============================================================
// 风格存储（D1 settings k='style' + wp-content/themes/<id>/tpl.json）
// 见 docs/style-refactor.md：废除 tpl:index / tpl:sindex / tpl:active / tpl:store:*
// ============================================================

/** 读 D1 settings k='style'（权威）：{active, user:[{id,name}]} */
async function getStyleSetting(db) {
    try {
        const row = await db.prepare("SELECT v FROM settings WHERE k = 'style'").first();
        const o = row && row.v ? JSON.parse(row.v) : {};
        return { active: String((o && o.active) || ''), user: Array.isArray(o && o.user) ? o.user : [] };
    } catch (e) { return { active: '', user: [] }; }
}

/** 写 D1 settings k='style'（全量） */
async function setStyleSetting(db, obj) {
    await db.prepare("INSERT INTO settings (k, v) VALUES ('style', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .bind(JSON.stringify({ active: String((obj && obj.active) || ''), user: Array.isArray(obj && obj.user) ? obj.user : [] })).run();
}

/** 读某风格 id 的 tpl.json（assets 优先 → R2）；失败返回 null */
async function readStyleTpl(env, id) {
    const key = 'wp-content/themes/' + String(id) + '/tpl.json';
    try {
        if (env.ASSETS) {
            const res = await env.ASSETS.fetch(new Request('https://assets.local/' + key));
            if (res && res.ok) { try { return await res.json(); } catch (e) { /* fallthrough */ } }
        }
    } catch (e) { /* fallthrough */ }
    try {
        const obj = await env.R2_BUCKET.get(key);
        if (obj) return JSON.parse(await obj.text());
    } catch (e) { /* fallthrough */ }
    return null;
}

/** 风格变动后清 site:ctx（生效指针即时刷新）+ 本 isolate 的风格清单缓存 */
async function touchSiteCtx(env) {
    clearSiteCtxMemo();
    clearStyleIndexMemo();
    try { await deleteCache(env.KV_CACHE, 'site:ctx'); } catch (e) {}
}

/** 风格清单（内置 + 用户合并）—— site.getStyleIndex（独立 isolate 短缓存，不再经 site:ctx） */
async function styleIndex(env) {
    return await getStyleIndex(env);
}

/** 内置风格清单 */
async function builtinIndex(env) {
    return (await styleIndex(env)).filter(function (x) { return x && x.source === 'builtin'; });
}

/** 用户风格清单（source='user'） */
async function userStyleIndex(env) {
    return (await styleIndex(env)).filter(function (x) { return x && x.source === 'user'; });
}

/** 已废弃（无多版本）：no-op，保留调用点 */
async function pruneStyleVersions(env, id, keep) { /* no-op（无多版本回退） */ }

/** 确保 styles 表存在（幂等；WP 端 schema 迁移也会建，这里兜底） */
/** 核心表结构（与 WP 插件 ensure_d1_schema 的 DDL 保持一致，便于两端混用）。幂等。 */
async function ensureCoreSchema(env) {
    const ddl = [
        "CREATE TABLE IF NOT EXISTS posts (wp_id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, content TEXT, content_format TEXT DEFAULT 'html', excerpt TEXT, date DATETIME NOT NULL, modified DATETIME, status TEXT DEFAULT 'published', comment_status TEXT DEFAULT 'open', categories TEXT, tags TEXT, featured_image TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)",
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT UNIQUE NOT NULL, user_pass TEXT NOT NULL, user_nicename TEXT, user_email TEXT, user_url TEXT, user_registered DATETIME DEFAULT CURRENT_TIMESTAMP, display_name TEXT, role TEXT DEFAULT 'admin', avatar_url TEXT, user_status INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, settings TEXT)",
        "CREATE TABLE IF NOT EXISTS taxonomies (type TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (type, slug))",
        "CREATE TABLE IF NOT EXISTS post_taxonomy (post_id INTEGER NOT NULL, taxonomy_type TEXT NOT NULL, taxonomy_slug TEXT NOT NULL, PRIMARY KEY (post_id, taxonomy_type, taxonomy_slug))",
        "CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status)",
        "CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug)",
        "CREATE INDEX IF NOT EXISTS idx_pt_post ON post_taxonomy(post_id)",
        "CREATE INDEX IF NOT EXISTS idx_pt_slug ON post_taxonomy(taxonomy_slug)",
        "CREATE TABLE IF NOT EXISTS comments (comment_id INTEGER PRIMARY KEY, wp_comment_id INTEGER DEFAULT 0, post_id INTEGER NOT NULL, parent_id INTEGER NOT NULL DEFAULT 0, author TEXT DEFAULT '', author_email TEXT DEFAULT '', author_url TEXT DEFAULT '', avatar TEXT DEFAULT '', date_text TEXT DEFAULT '', date TEXT DEFAULT '', content TEXT DEFAULT '', approved INTEGER NOT NULL DEFAULT 0, type TEXT DEFAULT 'comment', origin TEXT DEFAULT 'wp', updated_at TEXT DEFAULT '')",
        "CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)",
        "CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)",
        "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, source_prefix TEXT NOT NULL, path TEXT NOT NULL, format TEXT DEFAULT 'md', title TEXT DEFAULT '', excerpt TEXT DEFAULT '', status TEXT DEFAULT 'published', date TEXT DEFAULT '', updated_at TEXT DEFAULT '', UNIQUE(source_prefix, path))",
        "CREATE INDEX IF NOT EXISTS idx_documents_prefix ON documents(source_prefix)",
    ];
    for (const sql of ddl) {
        try { await env.D1_DATABASE.prepare(sql).run(); } catch (e) { console.error('ensureCoreSchema:', e); }
    }
}

/** 默认缓存策略 + 批量任务配置（与 WP 插件默认值一致） */
function defaultCacheConfig() {
    return {
        ttl_list: 0, ttl_sidebar: 0, ttl_site: 604800, ttl_feed: 14400,
        feed_count: 20, per_page: 10, purge_on_publish: false, task_batch: 20, task_concurrency: 4,
    };
}

/** 已废弃（styles 表不再使用）：no-op，保留历史调用点 */
async function ensureStylesTable(env) { /* no-op（风格改存 R2 wp-content/themes/<id>/） */ }

/**
 * 渲染单类模板的预览 HTML（/api/templates/preview 与 /api/templates/style/preview 共用）。
 * tplAll 可选：{item,pageHome,...}，用于风格级预览时按同一套组合渲染。
 */
export async function tplPreviewHtml(env, type, content, tplAll) {
    const site = await getSiteContext(env);
    const actItem = (tplAll && typeof tplAll.item === 'string') ? tplAll.item : await getActiveTplContent(env, 'item');
    const sample = [];
    for (let i = 1; i <= 5; i++) {
        sample.push({
            wp_id: 90000 + i, slug: 'preview-' + i, title: '预览样例文章 ' + i,
            date: '2026-09-10 12:0' + i + ':00',
            excerpt: '这是一段用于预览的摘要文字，检查条目模板的标题、日期、分类与标签渲染效果。',
            categories: JSON.stringify([{ name: '示例分类', slug: 'uncategorized' }]),
            tags: JSON.stringify([{ name: '示例标签', slug: 'demo' }]),
        });
    }
    const data = { posts: sample, totalPages: 1, currentPage: 1 };
    // 预览也带**真实**侧边栏数据 + 该风格的骨架（否则 {{SIDEBAR_*}} 渲染成空，
    // 分类/标签/归档在预览里是空白，看不出效果）。
    let pvSidebar = null;
    try { pvSidebar = await getSidebarData(env.D1_DATABASE); } catch (e) { pvSidebar = null; }
    const pvSidebarTpl = (tplAll && tplAll.sidebar && typeof tplAll.sidebar === 'object')
        ? tplAll.sidebar : await getActiveSidebarTpl(env);
    const baseOpts = { baseUrl: '/', sidebar: pvSidebar, sidebarTpl: pvSidebarTpl, site: site };
    if (type === 'item') {
        const pageHome = (tplAll && typeof tplAll.pageHome === 'string') ? tplAll.pageHome : '';
        return renderHomepage(data, 1, sample.length, Object.assign({ itemTpl: content, pageTpl: pageHome }, baseOpts));
    }
    if (type === 'single') {
        const row = {
            wp_id: 99999, title: '预览样例文章：中文标题 Test', slug: 'preview-sample',
            date: '2026-09-10 12:00:00', modified: '2026-09-10 12:00:00', excerpt: '预览用摘要',
            content: '<p>这是正文预览样例。包含一段文字与 <code>code</code> 标记。</p><p>再一段：看看段间距、行高和配色。</p><blockquote><p>引用样式预览。</p></blockquote><pre><code>console.log(1);</code></pre>',
            content_format: 'html',
            categories: JSON.stringify([{ name: '示例分类', slug: 'uncategorized' }]),
            tags: JSON.stringify([{ name: '示例标签', slug: 'demo' }]),
        };
        const pvSb = { categories: [{ name: '示例分类', slug: 'uncategorized', cnt: 1 }], archives: [{ ym: '2026-09', cnt: 1 }], tags: [{ name: '示例标签', slug: 'demo', cnt: 1 }] };
        return renderSingleHtml(row, site, content, { sidebar: pvSb });
    }
    const withItem = Object.assign({ itemTpl: actItem, pageTpl: content }, baseOpts);
    if (type === 'pageHome') return renderHomepage(data, 1, sample.length, withItem);
    if (type === 'pageCategory') return renderCategoryPage(data, 1, sample.length, Object.assign({ slug: 'demo', name: '示例分类' }, withItem));
    if (type === 'pageTag') return renderTagPage(data, 1, sample.length, Object.assign({ slug: 'demo', name: '示例标签' }, withItem));
    if (type === 'pageArchive') return renderArchivePage(data, 1, sample.length, Object.assign({ year: '2026', month: '09' }, withItem));
    return '';
}

/** 发布/删除文章后清「边缘缓存」（Cache API：免费、不消耗 KV 额度）
 *  2026-10 起这里只动 Cache API ⇒ 发布/删除文章**不再产生任何 KV 操作**。 */
async function purgeLists(env, extraKeys) {
    const cfg = await getCacheConfig(env);
    // 注：原先这里有 seo:sitemap.xml / seo:robots.txt 两次 delete。
    // sitemap 已废弃（路由层 404，不再生成）、robots 已改为静态常量（不缓存）→ 无需再清。
    // 列表/侧边栏：仅在该类缓存启用（TTL>0）且 purge_on_publish=true 时清；否则靠 TTL 自然过期
    if (!cfg.purge_on_publish) return;
    if (cfg.ttl_sidebar > 0) {
        try { await edgeDelete('sidebar:data'); } catch (e) {}
    }
    if (cfg.ttl_list > 0) {
        const keys = ['home:page:1'];
        for (const k of (extraKeys || [])) keys.push(k);
        for (const k of keys) { try { await edgeDelete(k); } catch (e) {} }
    }
}

/* ---------- 通用批量任务执行器（重建单页 / permalink 迁移共用） ----------
 * 设计：job 只负责"单条做什么"，"分批取数 + 批内并发 + 进度持久化"由这里统一处理。
 * 进度存 D1 `settings` 的 `task:<job>:progress` 行 → 刷新 / 中断后可从断点续做；跑完自动清除。
 * （2026-10 从 KV 迁到 D1：批量任务不再消耗 KV 写额度。）
 */
function batchProgressKey(job) { return 'task:' + job + ':progress'; }

/* 进度读写改走 D1 settings 表（原来存 KV —— 每次批量操作都要消耗一次 KV 写额度，2026-10 移出）。
 * 兼容：老键（KV）不再读取；进度丢失只会让任务从头开始，无副作用。 */
async function getBatchProgress(env, job) {
    try {
        const row = await env.D1_DATABASE.prepare('SELECT v FROM settings WHERE k = ?').bind(batchProgressKey(job)).first();
        if (!row || !row.v) return null;
        const o = JSON.parse(row.v);
        return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
}
async function setBatchProgress(env, job, prog) {
    try {
        await env.D1_DATABASE.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
            .bind(batchProgressKey(job), JSON.stringify(prog)).run();
    } catch (e) { console.error('save batch progress failed:', e); }
}
async function clearBatchProgress(env, job) {
    try { await env.D1_DATABASE.prepare('DELETE FROM settings WHERE k = ?').bind(batchProgressKey(job)).run(); } catch (e) {}
}

/** permalink 迁移记录的「旧 key 清单」：整份存 D1 settings 一行（原为 KV 多行 task:permalink:oldkeys:<cursor>） */
const PERMALINK_OLDKEYS = 'task:permalink:oldkeys';
async function appendPermalinkOldKeys(env, keys) {
    if (!keys || !keys.length) return;
    try {
        const d1 = env.D1_DATABASE;
        const row = await d1.prepare('SELECT v FROM settings WHERE k = ?').bind(PERMALINK_OLDKEYS).first();
        let arr = [];
        try { arr = JSON.parse((row && row.v) || '[]'); } catch (e) {}
        if (!Array.isArray(arr)) arr = [];
        for (const k of keys) { if (arr.indexOf(k) === -1) arr.push(k); }
        await d1.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
            .bind(PERMALINK_OLDKEYS, JSON.stringify(arr)).run();
    } catch (e) { console.error('record permalink oldkeys failed:', e); }
}

/** D1 批量语句分块提交（D1 batch 单次上限 100 条） */
async function runD1Batch(db, stmts, chunk) {
    const n = chunk || 50;
    for (let i = 0; i < stmts.length; i += n) { await db.batch(stmts.slice(i, i + n)); }
}

/** 批内并发跑一遍：handler(item) 返回 truthy 记为成功（并发池，最多 concurrency 条同时在跑） */
async function runBatchChunk(items, concurrency, handler) {
    let idx = 0;
    let ok = 0;
    let failed = 0;
    const workers =Math.max(1, Math.min(concurrency || 1, items.length || 1));
    const pool = [];
    for (let i = 0; i < workers; i++) {
        pool.push((async function () {
            while (idx < items.length) {
                const my = items[idx++];
                try {
                    if (await handler(my)) ok++; else failed++;
                } catch (e) { failed++; }
            }
        })());
    }
    await Promise.all(pool);
    return { ok: ok, failed: failed };
}

/**
 * 删除某个 xyz 前缀下的**全部成品**（R2 对象）。
 * 背景：`docRoutes` 只决定「谁能访问」，删配置不会让 R2 里的静态页消失 ——
 *       结果旧页面继续被静态分支直出（标题还是当时的站名），内容也下不了线。
 * 范围：只删 `xyz/` 下的成品，**不动**原稿（`abc/`）与数据库行。
 * 返回：删除的对象数。
 */
async function purgeDocArtifacts(env, xyz) {
    const p = String(xyz || '').replace(/^\/+|\/+$/g, '');
    if (!p) return 0;
    let cursor = undefined;
    let total = 0;
    for (let i = 0; i < 20; i++) {                       // 最多 20 页 × 1000 = 2 万个对象
        let list;
        try {
            list = await env.R2_BUCKET.list({ prefix: p + '/', limit: 1000, cursor: cursor });
        } catch (e) { console.error('purgeDocArtifacts list failed:', p, e); break; }
        const keys = (list.objects || []).map(function (o) { return o.key; });
        if (keys.length) {
            try { await env.R2_BUCKET.delete(keys); total += keys.length; }   // R2 支持一次删 1000 个
            catch (e) { console.error('purgeDocArtifacts delete failed:', p, e); break; }
        }
        if (!list.truncated) break;
        cursor = list.cursor;
    }
    return total;
}

/* ---------- permalink（URL 形态） → storagePattern ---------- */
const PERMALINK_MAP = {
    postname: 'slug', year: 'year', monthnum: 'month', day: 'day',
    hour: 'hour', minute: 'minute', second: 'second', post_id: 'id', category: 'category',
};
const PATTERN_BACK = { slug: 'postname', year: 'year', month: 'monthnum', day: 'day', id: 'post_id', category: 'category' };

/** '/%year%/%postname%/' → '{year}/{slug}/index.html'；同时返回不支持的记号 */
function permalinkToPattern(structure) {
    let out = String(structure == null ? '' : structure).trim();
    out = out.replace(/^https?:\/\/[^/]+/i, '');   // 容错：整条 URL 粘进来
    Object.keys(PERMALINK_MAP).forEach(function (k) {
        out = out.split('%' + k + '%').join('{' + PERMALINK_MAP[k] + '}');
    });
    const unsupported = out.match(/%[A-Za-z_]+%/g) || [];
    out = out.split('/').filter(Boolean).join('/');
    if (out && !/index\.html$/.test(out)) out += '/index.html';
    return { pattern: out, unsupported: unsupported };
}

/** storagePattern → WP 风格结构（仅用于后台回显） */
function patternToPermalink(pattern) {
    let p = String(pattern || '').replace(/\/?index\.html$/, '');
    Object.keys(PATTERN_BACK).forEach(function (k) {
        p = p.split('{' + k + '}').join('%' + PATTERN_BACK[k] + '%');
    });
    return '/' + p.split('/').filter(Boolean).join('/') + '/';
}

/** 从绝对 URL 取路径部分（预览用） */
function urlPathOf(u) {
    try { return new URL(String(u)).pathname; } catch (e) { return String(u || ''); }
}

/** 写站点 storagePattern（保留 site 行其它字段）+ 清 site:ctx */
async function setStoragePattern(env, db, newPattern, siteCtx) {
    const srow = await db.prepare("SELECT v FROM settings WHERE k = 'site'").first();
    let sObj = {};
    try { sObj = JSON.parse((srow && srow.v) || '{}'); } catch (e) {}
    sObj.storagePattern = newPattern;
    if (!sObj.name) sObj.name = (siteCtx && siteCtx.name) || '';
    if (!sObj.url) sObj.url = (siteCtx && siteCtx.url) || '';
    await db.prepare("INSERT INTO settings (k, v) VALUES ('site', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(sObj)).run();
    clearSiteCtxMemo();
    try { await deleteCache(env.KV_CACHE, 'site:ctx'); } catch (e) {}
}

/* ---------- 单页 A3：用单页壳模板把文章渲染为静态 HTML 存 R2 ---------- */
function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 按站点 storagePattern（settings）解析文章 R2 存储路径 */
function postStoragePath(row, pattern) {
    const d = String(row.date || '');
    // {category}：取首个分类的 slug（posts.categories 是 JSON [{name,slug}]）
    let catSlug = '';
    try {
        const cats = JSON.parse(row.categories || '[]');
        if (Array.isArray(cats) && cats.length) {
            const c0 = cats[0];
            catSlug = String((c0 && (c0.slug || c0.name)) || '');
        }
    } catch (e) { /* 忽略解析失败 */ }
    const vals = {
        slug: String(row.slug || ''), id: String(row.wp_id || ''),
        year: d.slice(0, 4), month: d.slice(5, 7), day: d.slice(8, 10),
        hour: d.slice(11, 13), minute: d.slice(14, 16), second: d.slice(17, 19),
        category: catSlug,
    };
    let p = pattern || '{slug}/index.html';
    Object.keys(vals).forEach(function (k) { p = p.split('{' + k + '}').join(vals[k]); });
    // R2 存储 key 用「解码后的原文」（D1 的 slug 是 %xx 形态）：与读取侧一致，浏览器访问才能命中。
    // 兜底 || p：极端情况下不返回 null，避免调用方拿到 null 崩掉。
    return r2KeyFromPath(p) || p;
}

function postPublicUrl(row, site) {
    const p = postStoragePath(row, site.storagePattern).replace(/\/?index\.html$/, '');
    // key 已是原文 ⇒ URL 需逐段编码（浏览器请求的形态）
    return (site.url || '') + '/' + r2UrlPath(p.split('/').filter(Boolean).join('/')) + '/';
}

/** 正文含代码块时给单页注入 highlight.js 资源（/hl/ 由 Worker assets 直出） */
function injectCodeAssets(html, content) {
    if (!html || !/<(?:pre|code)\b/i.test(String(content || ''))) return html;
    const css = '<link rel="stylesheet" href="/hl/github.min.css">';
    const js = '<script src="/hl/highlight.min.js"><\/script><script>document.addEventListener("DOMContentLoaded",function(){try{hljs.highlightAll()}catch(e){}});<\/script>';
    let h = html;
    if (/<\/head>/i.test(h)) { h = h.replace(/<\/head>/i, css + '</head>'); }
    else { h = css + h; }
    if (/<\/body>/i.test(h)) { h = h.replace(/<\/body>/i, js + '</body>'); }
    else { h += js; }
    return h;
}

/** 属性值转义（href/src 用；比 escHtml 多覆盖单引号） */
function cfseEscUrl(u) {
    return String(u == null ? '' : u)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * 站点横幅横条图（{{SITE_BANNER}}）：回吐 <img>；空 ⇒ 空串（配合 {{#IF_BANNER}}）。
 */
function cfseSiteBannerHtml(site) {
    const b = String((site && site.banner) || '');
    if (!b) return '';
    return '<img src="' + cfseEscUrl(b) + '" alt="' + escHtml((site && site.name) || '') + '" class="site-banner-img" />';
}

/**
 * 站点 logo 块 HTML（{{SITE_LOGO}}）
 * 提取器替换掉的是**整个 wp:site-logo 块**（含外层 div），所以这里要回吐完整结构，
 * 不能只给裸 URL —— 否则页面上会露出一个 URL 文本。空 logo ⇒ 返回空串（配合 {{#IF_LOGO}}）。
 */
function cfseSiteLogoHtml(site) {
    const logo = String((site && site.logo) || '');
    if (!logo) return '';
    const href = ((site && site.url) || '') + '/';
    const name = escHtml((site && site.name) || '');
    return '<div class="wp-block-site-logo"><a href="' + cfseEscUrl(href) + '" class="custom-logo-link" rel="home">'
        + '<img src="' + cfseEscUrl(logo) + '" class="custom-logo" alt="' + name + '" /></a></div>';
}

/** 社交链接列表 HTML（{{SOCIAL_LINKS}}；数据来自 site:ctx.social —— 后台可配。<ul> 外壳留在模板里） */
function cfseSocialLinks(site) {
    const list = (site && Array.isArray(site.social)) ? site.social : [];
    if (!list.length) return '';
    return list.map(function (s) {
        const url = String((s && s.url) || '');
        if (!url) return '';
        const svc = String((s && s.service) || '');
        const label = svc ? (svc.charAt(0).toUpperCase() + svc.slice(1)) : url;
        return '<li class="wp-block-social-link"><a href="' + cfseEscUrl(url) + '" class="wp-block-social-link-anchor" rel="me noopener">' + escHtml(label) + '</a></li>';
    }).join('');
}

/** 菜单项 URL（{{MENU}}）：type=category|tag|post 按站点 URL 拼，custom 原样用 */
function cfseMenuUrl(site, item) {
    const base = (site && site.url) || '';
    const target = String((item && item.target) || '').trim();
    if (!target) return '';
    const type = String((item && item.type) || 'custom');
    if (type === 'category') return base + '/category/' + target + '/';
    if (type === 'tag') return base + '/tag/' + target + '/';
    if (type === 'post') return base + '/' + target.replace(/^\/+|\/+$/g, '') + '/';
    return target;
}

/**
 * 主导航 HTML（{{MENU}}）：数据来自 site:ctx.menu —— CMS 后台独立维护的菜单树
 * （与 WP 后台菜单**不联动**，见 docs/skin-placeholder-split.md §2.1）。
 * 结构：[{title, type, target, children:[…]}]，type = custom|category|tag|post。
 */
function cfseMenuHtml(site) {
    const menu = (site && Array.isArray(site.menu)) ? site.menu : [];
    if (!menu.length) return '';
    const render = function (list) {
        if (!Array.isArray(list) || !list.length) return '';
        let out = '';
        for (const it of list) {
            const url = cfseMenuUrl(site, it);
            if (!url) continue;
            const kids = Array.isArray(it && it.children) ? it.children : [];
            out += '<li class="menu-item' + (kids.length ? ' menu-item-has-children' : '') + '">'
                + '<a href="' + cfseEscUrl(url) + '">' + escHtml(String((it && it.title) || '')) + '</a>';
            if (kids.length) out += '<ul class="sub-menu">' + render(kids) + '</ul>';
            out += '</li>';
        }
        return out;
    };
    return '<ul class="menu">' + render(menu) + '</ul>';
}

/**
 * 残留占位符兜底：渲染出口扫一遍未替换的 {{XXX}}，记日志 + 清空。
 * 分工上「WP 侧只管输出占位符、Worker 侧负责解析」，所以必须有一处兜底，
 * 否则某个尚未实现的占位符会被原样输出到线上页面。
 */
function cfseStripLeftovers(html, tag) {
    const RE = /[{][{][#/]?[A-Z][A-Z0-9_]*[}][}]/g;
    const hit = String(html).match(RE);
    if (hit) {
        console.log('[cfse] unreplaced placeholders' + (tag ? ' [' + tag + ']' : '') + ': ' + Array.from(new Set(hit)).join(' '));
        html = String(html).split(RE).join('');
    }
    return html;
}

// 从文章 HTML 取首图 URL（{{POST_THUMBNAIL}} 的回退来源）
function cfseFirstImage(html) {
    const m = String(html || '').match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
    return m ? m[1] : '';
}

/** 条件块处理：{{#IF_FLAG}}...{{/IF_FLAG}}，cond=false 时整块删除（与 templates.js cfseIfBlock 同语义） */
function cfseIfBlock(tpl, flag, cond) {
    const open = '{{#IF_' + flag + '}}';
    const close = '{{/IF_' + flag + '}}';
    while (tpl.includes(open)) {
        const s = tpl.indexOf(open);
        const e = tpl.indexOf(close, s);
        if (e < 0) break;
        tpl = tpl.slice(0, s) + (cond ? tpl.slice(s + open.length, e) : '') + tpl.slice(e + close.length);
    }
    return tpl;
}

/** 正文哨兵：单页渲染时先把 {{POST_CONTENT}} 换成它，等所有模板替换与残留清理跑完再注入正文 */
const CFSE_BODY_SENTINEL = '@@CFSE_BODY_7F3A@@';

function renderSingleHtml(row, site, tplOverride, opts) {
    opts = opts || {};
    const sidebar = opts.sidebar;
    const sidebarTpl = opts.sidebarTpl;
    const nav = opts.nav || {};
    let h = tplOverride || CFSE_SINGLE_TPL || '';
    if (!h) return '';
    const rep = function (t, v) { h = h.split(t).join(String(v == null ? '' : v)); };
    rep('{{SITE_URL}}', cfseEscUrl(site.url || ''));
    rep('{{SITE_NAME}}', escHtml(site.name));
    rep('{{SITE_DESC}}', escHtml(site.description || ''));
    rep('{{SITE_FOOTER}}', site.footerHtml || '');
    // 站点级「可配」占位符（值来自 site:ctx，WP 侧 / Worker 后台上次算一次写入）
    const siteLogoHtml = cfseSiteLogoHtml(site);
    const siteSocialHtml = cfseSocialLinks(site);
    h = cfseIfBlock(h, 'LOGO', siteLogoHtml !== '');
    h = cfseIfBlock(h, 'SOCIAL', siteSocialHtml !== '');
    rep('{{SITE_LOGO}}', siteLogoHtml);
    const siteBannerHtml = cfseSiteBannerHtml(site);
    h = cfseIfBlock(h, 'BANNER', siteBannerHtml !== '');
    rep('{{SITE_BANNER}}', siteBannerHtml);
    rep('{{SEARCH_ACTION}}', cfseEscUrl(((site && site.url) || '') + '/'));
    rep('{{SOCIAL_LINKS}}', siteSocialHtml);
    const siteMenuHtml = cfseMenuHtml(site);
    h = cfseIfBlock(h, 'MENU', siteMenuHtml !== '');
    rep('{{MENU}}', siteMenuHtml);
    rep('{{POST_TITLE}}', escHtml(row.title));
    rep('{{CFSE_POST_ID}}', Number(row.wp_id) || 0);   // ② 半动态评论注入的定位标记用
    rep('{{POST_DATE}}', escHtml(String(row.date || '').slice(0, 10)));
    rep('{{POST_EXCERPT}}', escHtml(row.excerpt || ''));
    const bodyHtml = (row.content_format || 'html') === 'md' ? mdToHtml(row.content) : String(row.content || '');
    // 正文用哨兵占位，最后再注入：文章正文里可能出现 {{POST_URL}} / {{SIDEBAR_CATEGORIES}} 这类
    // 「示例文本」（风格文档、REST 示例），若此刻直接替换，后面的 rep() 与 cfseStripLeftovers()
    // 会把它们替换成真实值或整段清空。
    rep('{{POST_CONTENT}}', CFSE_BODY_SENTINEL);
    rep('{{POST_URL}}', cfseEscUrl(postPublicUrl(row, site)));
    // 分类/标签区（与列表条目模板同形态；无则整块隐藏）
    const cats = parseTaxoList(row.categories);
    const tags = parseTaxoList(row.tags);
    h = cfseIfBlock(h, 'CATEGORIES', cats.length > 0);
    h = cfseIfBlock(h, 'TAGS', tags.length > 0);
    const baseUrl = site.url || '';
    rep('{{POST_CATEGORIES}}', cats.map(function (c) { return '<a href="' + baseUrl + '/category/' + (c.slug || '') + '/">' + escHtml(c.name) + '</a>'; }).join(', '));
    rep('{{POST_TAGS}}', tags.map(function (t) { return '<a href="' + baseUrl + '/tag/' + (t.slug || '') + '/">' + escHtml(t.name) + '</a>'; }).join(', '));
    // 作者（per-post 优先，回退站点默认作者）/ 缩略图（特色图或正文首图）/ 评论（占位，等评论系统）
    const defAuthor = (site && site.defaultAuthor) || {};
    const authorName = row.author_name || defAuthor.name || '';
    const authorSlug = row.author_slug || defAuthor.slug || '';
    const thumb = row.thumbnail || cfseFirstImage(bodyHtml || row.content);
    h = cfseIfBlock(h, 'AUTHOR', !!authorName);
    h = cfseIfBlock(h, 'THUMBNAIL', !!thumb);
    // 评论：mode=embed → 注入管理员填写的第三方片段（Disqus/giscus/Utterances…）；
    //       mode=native → 用「主题评论骨架 + D1 评论数据」再生；off / 无数据 → 整块隐藏。
    const commentsCfg = (site && site.comments) || {};
    const commentsMode = commentsCfg.mode || 'off';
    const commentsEmbed = (commentsMode === 'embed') ? String(commentsCfg.embed || '').trim() : '';
    let commentsHtml = commentsEmbed;
    // 文章级关闭评论（WP 的 comment_status = 'closed'）⇒ 评论区与提交表单都不输出
    const commentsClosed = String((row && row.comment_status) || 'open') === 'closed';
    if (!commentsClosed && !commentsHtml && commentsMode === 'native') {
        commentsHtml = cfseCommentItems(opts.comments || [], opts.commentsTpl || {}, site, row.title, postPublicUrl(row, site), row.wp_id);
        // 包上评论标记再回填 R2：这样按需渲染的单页在**后续请求**里也能走 injectComments()
        // 现场注入 —— 新评论/审核结果立即可见，不必重建单页（与 WP 导出快照同一协议）。
        // 不包标记的话，R2 回填的是「当时那一刻」的评论，之后永远冻结。
        if (commentsHtml !== '') {
            commentsHtml = '<!--CFSE-COMMENTS-START id=' + (Number(row.wp_id) || 0) + '-->' + commentsHtml + '<!--CFSE-COMMENTS-END-->';
        }
    }
    h = cfseIfBlock(h, 'COMMENTS', commentsHtml !== '');
    rep('{{POST_AUTHOR}}', escHtml(authorName));
    rep('{{POST_AUTHOR_URL}}', cfseEscUrl(authorSlug ? (baseUrl + '/author/' + authorSlug + '/') : ''));
    rep('{{POST_THUMBNAIL}}', cfseEscUrl(thumb));
    rep('{{COMMENTS}}', commentsHtml);
    // 上下篇（探针提取的结构占位；数据填充留待「上下篇关联查询」落地）
    // 上下篇（真实数据：上一篇=更早发布、下一篇=更新发布；每次渲染只查一次，之后写 R2 静态）
    const prev = nav.prev, next = nav.next;
    h = cfseIfBlock(h, 'PREV', !!prev);
    h = cfseIfBlock(h, 'NEXT', !!next);
    rep('{{PREV_URL}}', prev ? postPublicUrl(prev, site) : '');
    rep('{{PREV_TITLE}}', prev ? escHtml(prev.title) : '');
    rep('{{NEXT_URL}}', next ? postPublicUrl(next, site) : '');
    rep('{{NEXT_TITLE}}', next ? escHtml(next.title) : '');
    // 侧边栏三块（单页也有；与列表页共用 cfseSidebar* 函数）
    const sb = sidebar || {};
    const sbtpl = sidebarTpl || {};
    rep('{{SIDEBAR_CATEGORIES}}', cfseSidebarCategoryItems(sb.categories, site, sbtpl));
    rep('{{SIDEBAR_ARCHIVES}}', cfseSidebarArchiveItems(sb.archives, site, sbtpl));
    rep('{{SIDEBAR_TAGS}}', cfseSidebarTagItems(sb.tags, site, sbtpl));
    h = cfseStripLeftovers(h, 'single');
    // 正文最后注入：正文里的 {{...}} 是内容，不是模板占位符，不能再被替换或清理
    h = h.split(CFSE_BODY_SENTINEL).join(bodyHtml);
    h = injectCodeAssets(h, bodyHtml);
    h = cfseNoReferrerImgs(h);
    return cfseInjectHead(h, site.headExtra);
}

/** 单页上下篇：按 date 查 D1 的上一篇（更早）/ 下一篇（更新）。每次渲染查一次（之后单页写 R2 静态）。 */
async function singlePageNav(env, row) {
    const out = { prev: null, next: null };
    try {
        const db = env.D1_DATABASE;
        const d = String((row && row.date) || '');
        if (!d) return out;
        // 窄列：上下篇只用于 {{PREV_URL}}/{{PREV_TITLE}}/{{NEXT_URL}}/{{NEXT_TITLE}}
        // （postPublicUrl 需要 date+categories+slug；renderSingleHtml 用 title+slug）。
        // 之前 SELECT * 会把 content 全文也拉出来（按行计费，浪费）。
        const cols = 'wp_id, title, slug, date, categories';
        out.prev = await db.prepare("SELECT " + cols + " FROM posts WHERE status='published' AND date < ? ORDER BY date DESC LIMIT 1").bind(d).first();
        out.next = await db.prepare("SELECT " + cols + " FROM posts WHERE status='published' AND date > ? ORDER BY date ASC LIMIT 1").bind(d).first();
    } catch (e) { /* 查不到就返回空（导航自动隐藏） */ }
    return out;
}

/** 发布（published）文章 → 渲染单页写 R2（单页直读 R2，无 KV 缓存层） */
async function writeSinglePage(env, row, shared) {
    if (!row || row.status !== 'published') return false;
    // shared：批量任务预取的「站点上下文 / 侧边栏数据 / 三个模板」—— 同一批里所有单页共用，
    // 避免每篇都重查 3 次 D1（侧边栏）+ 3 次 KV（模板）。缺省时各自现查（单篇发布路径）。
    const sh = shared || {};
    const site = sh.site || await getSiteContext(env);
    const path = postStoragePath(row, site.storagePattern);
    const nav = await singlePageNav(env, row);
    const sbData = (sh.sidebar !== undefined) ? sh.sidebar : await getSidebarData(env.D1_DATABASE);
    const tplSingle = (sh.tplSingle !== undefined) ? sh.tplSingle : await getActiveTplContent(env, 'single');
    const sbTpl = (sh.sidebarTpl !== undefined) ? sh.sidebarTpl : await getActiveSidebarTpl(env);
    const cmTpl = (sh.commentsTpl !== undefined) ? sh.commentsTpl : await getActiveCommentsTpl(env);
    let html = renderSingleHtml(row, site, tplSingle, { sidebar: sbData, sidebarTpl: sbTpl, nav: nav, comments: await getPostComments(env.D1_DATABASE, row.wp_id), commentsTpl: cmTpl });
    if (!html) return false;
    // 单页布局开关（site:ctx.layout.singleSidebar === 'hide'）：与 renderSinglePageOnDemand 同一处理 ——
    // **渲染时**注入单列 CSS，随后写进 R2 ⇒ 缓存里的就是最终形态，与运行时/缓存策略无关。
    if (site && site.layout && String(site.layout.singleSidebar) === 'hide') {
        const lg = await getActiveLayout(env);
        if (lg) {
            const li = html.indexOf('</head>');
            if (li >= 0) {
                html = html.slice(0, li) + '<style id="cfse-layout">' + lg.sidebar + '{display:none !important}'
                    + lg.main + '{width:auto !important;float:none !important;max-width:none !important}</style>'
                    + '\n' + html.slice(li);
            }
        }
    }
    try {
        await env.R2_BUCKET.put(path, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    } catch (e) { console.error('writeSinglePage put failed:', e); return false; }
    return true;
}


/**
 * 按需渲染单页（R2 未命中时由路由调用）：
 *   D1 取该篇（status='published'）→ 用当前风格模板渲染（md 走 marked）→ 写回 R2 → 返回 HTML。
 * 用途：让「WP 只同步 D1、不上传 R2」的站点也能自愈（不需要每次改模板就全量重建单页才能访问）。
 * 返回 { html, path } 或 null（该 slug 不存在 / 非已发布 / 渲染失败）。
 */
export async function renderSinglePageOnDemand(env, slug) {
    const key = String(slug || '').toLowerCase();
    if (!key) return null;
    const db = env.D1_DATABASE;
    let row = await db.prepare("SELECT * FROM posts WHERE slug = ? AND status = 'published' LIMIT 1").bind(key).first();
    if (!row) {
        // 兜底：大小写不敏感匹配（历史数据里可能有带大写的 slug）
        row = await db.prepare("SELECT * FROM posts WHERE lower(slug) = ? AND status = 'published' LIMIT 1").bind(key).first();
    }
    const diag = { slug: key, step: 'lookup', found: 0 };
    if (!row) {
        // 再查一次不带 status 条件，看看是不是状态不符
        const any = await db.prepare("SELECT slug, status FROM posts WHERE lower(slug) = ? LIMIT 3").bind(key).all();
        diag.step = 'not-found';
        diag.candidates = JSON.stringify((any && any.results) || []);
        console.error('[ondemand] miss: ' + JSON.stringify(diag));
        return { html: null, path: null, diag: diag };
    }
    diag.found = 1;
    diag.status = row.status;
    diag.fmt = row.content_format || 'html';
    const site = await getSiteContext(env);
    let html = '';
    try {
        const nav = await singlePageNav(env, row);
        html = renderSingleHtml(row, site, await getActiveTplContent(env, 'single'), { sidebar: await getSidebarData(env.D1_DATABASE), sidebarTpl: await getActiveSidebarTpl(env), nav: nav, comments: await getPostComments(env.D1_DATABASE, row.wp_id), commentsTpl: await getActiveCommentsTpl(env) });
    } catch (e) {
        diag.step = 'render-error';
        diag.err = String((e && e.message) || e);
        console.error('[ondemand] render failed: ' + JSON.stringify(diag));
        return { html: null, path: null, diag: diag };
    }
    diag.htmlLen = html ? html.length : 0;
    if (!html) {
        diag.step = 'empty-html';
        console.error('[ondemand] empty: ' + JSON.stringify(diag));
        return { html: null, path: null, diag: diag };
    }
    // 单页布局开关（site:ctx.layout.singleSidebar === 'hide'）：**渲染时**注入单列 CSS。
    // 产出的 HTML 就是最终形态（随后一并写回 R2）⇒ 不牵扯任何运行时改写或缓存策略。
    // 选择器从产物 layout 段读（worker 不认识主题）。
    if (site && site.layout && String(site.layout.singleSidebar) === 'hide') {
        const lg = await getActiveLayout(env);
        if (lg) {
            const i = html.indexOf('</head>');
            if (i >= 0) {
                const styleTag = '<style id="cfse-layout">' + lg.sidebar + '{display:none !important}'
                    + lg.main + '{width:auto !important;float:none !important;max-width:none !important}</style>';
                html = html.slice(0, i) + styleTag + '\n' + html.slice(i);
                diag.layout = 'one-column';
            }
        }
    }
    const path = postStoragePath(row, site.storagePattern);
    diag.path = path;
    try {
        await env.R2_BUCKET.put(path, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
    } catch (e) {
        console.error('renderSinglePageOnDemand put failed:', e);   // 写回失败也照常返回给用户
    }
    diag.step = 'ok';
    console.log('[ondemand] rendered ' + path + ' (slug=' + row.slug + ', fmt=' + (row.content_format || 'html') + ')');
    return { html: html, path: path, diag: diag };
}

/** 删除文章静态单页（R2） */
async function deleteSinglePage(env, row, shared) {
    if (!row) return;
    const site = (shared && shared.site) || await getSiteContext(env);
    const path = postStoragePath(row, site.storagePattern);
    try { await env.R2_BUCKET.delete(path); } catch (e) {}
    try { await env.R2_BUCKET.delete(path + '.gz'); } catch (e) {}
}

/** 规范化并 upsert 分类/标签，返回 [{name,slug}]（同时写 post_taxonomy） */
async function syncTaxonomy(db, postId, type, terms) {
    const out = [];
    for (const raw of (terms || [])) {
        if (!raw) continue;
        const name = typeof raw === 'string' ? raw : String(raw.name || '');
        if (!name.trim()) continue;
        let slug = (raw && raw.slug) ? String(raw.slug) : slugify(name);
        if (!slug) slug = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
        await db.prepare('INSERT INTO taxonomies (type, slug, name) VALUES (?, ?, ?) ON CONFLICT(type, slug) DO UPDATE SET name = excluded.name')
            .bind(type, slug, name.trim()).run();
        await db.prepare('INSERT OR IGNORE INTO post_taxonomy (post_id, taxonomy_type, taxonomy_slug) VALUES (?, ?, ?)')
            .bind(postId, type, slug).run();
        out.push({ name: name.trim(), slug: slug });
    }
    return out;
}

function buildPostPayload(body, offsetSec) {
    const title = String(body.title || '').trim();
    if (!title) return { error: '标题不能为空' };
    const fmt = body.content_format === 'md' ? 'md' : 'html';
    // md 原稿原样保存（渲染层再转）；html 入库前净化
    const content = fmt === 'md' ? String(body.content || '') : scrubHtml(String(body.content || ''));
    const slug = (body.slug ? String(body.slug) : slugify(title) || ('p' + Date.now().toString(36))).toLowerCase();
    const status = body.status === 'draft' ? 'draft' : 'published';
    return {
        slug: slug,
        title: title,
        content: content,
        content_format: fmt,
        excerpt: (body.excerpt !== undefined && String(body.excerpt).trim() !== '') ? String(body.excerpt).trim()
            : (fmt === 'md' ? mdToText(content, 200) : excerptOf(content)),
        status: status,
        featured_image: body.featured_image ? String(body.featured_image) : '',
        categories: body.categories,
        tags: body.tags,
        date: body.date || localDateTime(offsetSec),
        modified: localDateTime(offsetSec),
    };
}

/** 主入口：request.path 以 /api/ 开头时由 routes 调用 */
export async function handleAdminRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const secret = env.AUTH_KEY_SECRET || 'cfse-dev-secret';

    // ---- 登录 ----
    if (path === '/api/login' && method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (await loginRateLimit(env, ip)) return json({ error: '尝试过于频繁，请稍后再试' }, 429);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        // 账号级失败锁定：连续 10 次错误锁 15 分钟（与 IP 限速叠加；内存滑窗，0 KV 写入）
        const uName = String(body.username || '').trim();
        if (accountLocked(uName)) return json({ error: '该账号已临时锁定，请 15 分钟后再试' }, 429);
        const user = await authenticate(env.D1_DATABASE, body.username, body.password);
        if (!user) {
            const n = accountFail(uName);
            return json({ error: n >= 10 ? '该账号已临时锁定，请 15 分钟后再试' : '用户名或密码错误' }, 401);
        }
        accountClear(uName);
        const access = await signJwt({ sub: user.id, username: user.username, role: user.role, typ: 'access' }, secret, ACCESS_TTL);
        const refresh = await signJwt({ sub: user.id, typ: 'refresh' }, secret, REFRESH_TTL);
        return json({ access, refresh, user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName, email: user.email } });
    }

    // ---- 刷新 ----
    if (path === '/api/refresh' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const payload = await verifyJwt(body.refresh, secret, 'refresh');
        if (!payload) return json({ error: 'refresh 无效或已过期' }, 401);
        const row = await env.D1_DATABASE.prepare('SELECT * FROM users WHERE id = ?').bind(payload.sub).first();
        if (!row || parseInt(row.user_status, 10) !== 1) return json({ error: '账号不可用' }, 401);
        const access = await signJwt({ sub: row.id, username: row.user_login, role: row.role, typ: 'access' }, secret, ACCESS_TTL);
        return json({ access, user: { id: row.id, username: row.user_login, role: row.role, displayName: row.display_name, email: row.user_email } });
    }

    // ============================================
    // 一键初始化（首次部署引导）
    //   未初始化（users 表为空）时开放；建好第一个管理员后**永久关闭**，避免成为后门。
    // ============================================
    if (path === '/api/setup/status' && method === 'GET') {
        let hasUsers = false; let siteName = '';
        try {
            await ensureCoreSchema(env);
            const c = await env.D1_DATABASE.prepare('SELECT COUNT(*) AS c FROM users').first();
            hasUsers = parseInt((c && c.c) || 0, 10) > 0;
            const row = await env.D1_DATABASE.prepare("SELECT v FROM settings WHERE k = 'site'").first();
            if (row && row.v) { try { siteName = (JSON.parse(row.v) || {}).name || ''; } catch (e) {} }
        } catch (e) {
            console.error('setup status:', e);
        }
        return json({ initialized: hasUsers, hasUsers: hasUsers, siteName: siteName });
    }
    if (path === '/api/setup' && method === 'POST') {
        const setupIp = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (await loginRateLimit(env, setupIp)) return json({ error: '尝试过于频繁，请稍后再试' }, 429);
        await ensureCoreSchema(env);
        const cnt = await env.D1_DATABASE.prepare('SELECT COUNT(*) AS c FROM users').first();
        if (parseInt((cnt && cnt.c) || 0, 10) > 0) {
            return json({ error: '本站已完成初始化（已存在用户），该接口已关闭。请用已有账号登录，或直接改 D1 的 users 表。' }, 403);
        }
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) return json({ error: '用户名需 3-40 位字母/数字/_.-' }, 400);
        if (password.length < 8) return json({ error: '密码至少 8 位' }, 400);
        const siteName = String(body.siteName || '').trim() || 'My Static Site';
        const siteUrl = String(body.siteUrl || '').trim().replace(/\/+$/, '');
        const hash = await hashPassword(password);
        try {
            await env.D1_DATABASE.prepare("INSERT INTO users (user_login, user_pass, user_nicename, user_email, display_name, role, user_status) VALUES (?, ?, ?, ?, ?, 'admin', 1)")
                .bind(username, hash, username, String(body.email || ''), String(body.displayName || username)).run();
        } catch (e) {
            console.error('setup create admin:', e);
            return json({ error: '创建管理员失败：' + String((e && e.message) || e) }, 500);
        }
        const site = JSON.stringify({
            name: siteName,
            description: String(body.description || ''),
            url: siteUrl,
            storagePattern: '{slug}/index.html',
            timezoneOffset: 0,
        });
        await env.D1_DATABASE.prepare("INSERT INTO settings (k, v) VALUES ('site', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(site).run();
        await env.D1_DATABASE.prepare("INSERT INTO settings (k, v) VALUES ('cache', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(defaultCacheConfig())).run();
        clearSiteCtxMemo();
        try { await env.KV_CACHE.delete('site:ctx'); } catch (e) {}
        const u = await env.D1_DATABASE.prepare('SELECT id, user_login FROM users WHERE user_login = ?').bind(username).first();
        console.log('[setup] initialized with admin=' + username + ' site=' + siteName);
        return json({
            ok: true,
            user: { id: u ? u.id : 0, username: username, role: 'admin' },
            site: { name: siteName, url: siteUrl },
            next: ['登录 /admin/ 后台', '到「设置」补站点名/URL', '到「模板」选风格', '在 WP 插件或第三方编辑器中配置端点与 X-Auth-Key'],
        }, 201);
    }

    // ---- 其余需 access 鉴权 ----
    const token = bearerToken(request);
    const authPayload = token ? await verifyJwt(token, secret, 'access') : null;
    if (!authPayload) return json({ error: '未授权或登录已过期' }, 401);

    // ---- 角色权限门禁 ----
    // admin：全部；editor/author：内容管理；subscriber：仅个人资料
    const role = authPayload.role || 'subscriber';
    const isWrite = request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE';
    // 应用密码允许「本人」管理自己的（下面端点内部再做归属校验）
    const isAppPwRoute = /^\/api\/users\/(\d+)\/app-passwords$/.test(path) || /^\/api\/app-passwords\/(\d+)$/.test(path);
    const adminOnly = (path.startsWith('/api/users') && !isAppPwRoute)
        || (isWrite && (path === '/api/settings' || path.startsWith('/api/import')
            || path === '/api/cache/purge' || path.startsWith('/api/posts/rebuild-single')
            || path.startsWith('/api/posts/batch') || path.startsWith('/api/comments')));
    if (adminOnly && role !== 'admin') return json({ error: '无权限' }, 403);
    if (role === 'subscriber' && path !== '/api/me' && path !== '/api/me/password') {
        return json({ error: '无权限' }, 403);
    }

    // ---- 写操作限速（每用户 90 次/分钟，防脚本风暴；内存滑窗，0 KV 成本） ----
    if (role !== 'subscriber' && (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE')) {
        if (!wrateAllowed(authPayload.sub)) return json({ error: '操作过于频繁，请稍后再试' }, 429);
    }

    const db = env.D1_DATABASE;

    // ---- 应用密码（Application Passwords；第三方 md 编辑器认证用）----
    const apm = path.match(/^\/api\/users\/(\d+)\/app-passwords$/);
    if (apm) {
        const uidApp = parseInt(apm[1], 10);
        if (authPayload.role !== 'admin' && authPayload.sub !== uidApp) return json({ error: '无权限' }, 403);
        await ensureAppPasswordsTable(env);
        if (method === 'GET') {
            const rows = await db.prepare('SELECT id, user_id, name, created_at, last_used_at, revoked FROM app_passwords WHERE user_id = ? ORDER BY id DESC').bind(uidApp).all();
            return json({ items: rows.results || [] });
        }
        if (method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) { body = {}; }
            const apName = String(body.name || '').trim() || '未命名';
            const plain = genAppPasswordPlain();
            const hash = await hashAppPassword(plain);
            await db.prepare('INSERT INTO app_passwords (user_id, name, pass_hash, created_at, last_used_at, revoked) VALUES (?, ?, ?, ?, ?, 0)')
                .bind(uidApp, apName, hash, nowDateTime(), '').run();
            const last = await db.prepare('SELECT id FROM app_passwords WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(uidApp).first();
            return json({ ok: true, id: last ? last.id : 0, name: apName, password: plain, warning: '明文只显示这一次，请立即保存' });
        }
    }
    const apd = path.match(/^\/api\/app-passwords\/(\d+)$/);
    if (apd && method === 'DELETE') {
        const aid = parseInt(apd[1], 10);
        const apRow = await db.prepare('SELECT * FROM app_passwords WHERE id = ?').bind(aid).first();
        if (!apRow) return json({ error: 'not found' }, 404);
        if (authPayload.role !== 'admin' && authPayload.sub !== apRow.user_id) return json({ error: '无权限' }, 403);
        await db.prepare('UPDATE app_passwords SET revoked = 1 WHERE id = ?').bind(aid).run();
        return json({ ok: true });
    }

    // GET /api/me
    if (path === '/api/me' && method === 'GET') {
        const row = await db.prepare('SELECT id, user_login, user_email, display_name, role FROM users WHERE id = ?').bind(authPayload.sub).first();
        return json(row ? { id: row.id, username: row.user_login, email: row.user_email, displayName: row.display_name, role: row.role } : { error: 'not found' }, row ? 200 : 404);
    }

    // PUT /api/me（更新昵称 / 邮箱）
    if (path === '/api/me' && method === 'PUT') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const displayName = String(body.display_name || '').trim();
        const email = String(body.email || '').trim();
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
        if (!displayName) return json({ error: '昵称不能为空' }, 400);
        await db.prepare('UPDATE users SET display_name = ?, user_email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .bind(displayName, email, authPayload.sub).run();
        return json({ ok: true });
    }

    // POST /api/me/password（修改自己的密码）
    if (path === '/api/me/password' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(authPayload.sub).first();
        if (!row) return json({ error: '用户不存在' }, 404);
        const oldOk = await verifyPassword(body.old_password, row.user_pass);
        if (!oldOk) return json({ error: '原密码错误' }, 401);
        const np = String(body.new_password || '');
        if (np.length < 8) return json({ error: '新密码至少 8 位' }, 400);
        const store = await hashPassword(np);
        await db.prepare('UPDATE users SET user_pass = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(store, authPayload.sub).run();
        return json({ ok: true, message: '密码已修改，请重新登录' });
    }

/** 菜单树净化：只留 {title,type,target,children}，限深度与条数（防注入 / 防爆） */
function sanitizeMenu(list, depth) {
    depth = depth || 0;
    if (depth > 4 || !Array.isArray(list)) return [];
    return list.slice(0, 60).map(function (it) {
        const type = ['custom', 'category', 'tag', 'post'].indexOf(String((it && it.type) || 'custom')) >= 0
            ? String(it.type) : 'custom';
        const out = {
            title: String((it && it.title) || '').slice(0, 200),
            type: type,
            target: String((it && it.target) || '').slice(0, 500),
        };
        const kids = sanitizeMenu((it && it.children) || [], depth + 1);
        if (kids.length) out.children = kids;
        return out;
    }).filter(function (it) { return it.title !== '' && it.target !== ''; });
}

    // GET /api/settings（站点信息 + 缓存策略）
    if (path === '/api/settings' && method === 'GET') {
        const site = await getSiteContext(env);
        return json({
            site: {
                name: site.name,
                url: site.url,
                description: site.description || '',
                // 站点级可配项（{{SITE_LOGO}} / {{SOCIAL_LINKS}} / {{MENU}} 的数据源）
                logo: site.logo || '',
                banner: site.banner || '',
                social: Array.isArray(site.social) ? site.social : [],
                menu: Array.isArray(site.menu) ? site.menu : [],
                docRoutes: Array.isArray(site.docRoutes) ? site.docRoutes : [],
                headExtra: String(site.headExtra || ''),
            },
            cache: site.cache,
            comments: site.comments || { mode: 'off', embed: '', accept: 'off' },
        });
    }

    // PUT /api/settings（仅 admin；支持站点名/描述 与/或 缓存策略 → settings 落库 + 清缓存即时生效）
    if (path === '/api/settings' && method === 'PUT') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const hasSite = body.site && typeof body.site === 'object';
        const hasCache = body.cache && typeof body.cache === 'object';
        const hasComments = body.comments && typeof body.comments === 'object';
        if (!hasSite && !hasCache && !hasComments) return json({ error: '没有要更新的设置' }, 400);
        const site = await getSiteContext(env);
        const result = {};
        const purged = [];   // 本次保存里被清理的文档库成品（仅 docRoutes 变更时非空）
        if (hasSite) {
            const row = await db.prepare("SELECT v FROM settings WHERE k = 'site'").first();
            let prev = {};
            try { prev = JSON.parse((row && row.v) || '{}'); } catch (e) {}
            // 站点名 / 描述：只有显式传入才更新；未传则保留原值
            // （允许只更新 docRoutes / menu / logo 等子字段，不必每次都带站点名）
            let newName;
            if (body.site.name !== undefined) {
                newName = String(body.site.name || '').trim();
                if (!newName) return json({ error: '站点名不能为空' }, 400);
            } else {
                newName = String(prev.name || site.name || '');
            }
            const newDesc = body.site.description !== undefined
                ? String(body.site.description || '').trim()
                : String(prev.description || site.description || '');
            // 合并 prev：避免"只改站点名"把 footerHtml / defaultAuthor / comments 等字段丢掉
            const sitePatch = {
                name: newName,
                description: newDesc,
                url: prev.url || site.url || '',
                storagePattern: prev.storagePattern || site.storagePattern || '{slug}/index.html',
                timezoneOffset: prev.timezoneOffset || 0,
            };
            // 站点级可配项：只有请求里带了这个键才更新（不带 = 保持原值，避免"只改站点名"把菜单清空）
            if (body.site.logo !== undefined) sitePatch.logo = String(body.site.logo || '').slice(0, 2000).trim();
            if (body.site.banner !== undefined) sitePatch.banner = String(body.site.banner || '').slice(0, 2000).trim();
            if (Array.isArray(body.site.social)) {
                sitePatch.social = body.site.social.slice(0, 30).map(function (sv) {
                    return {
                        service: String((sv && sv.service) || '').slice(0, 40).trim(),
                        url: String((sv && sv.url) || '').slice(0, 500).trim(),
                    };
                }).filter(function (sv) { return sv.url !== ''; });
            }
            if (Array.isArray(body.site.menu)) sitePatch.menu = sanitizeMenu(body.site.menu);
            // 单页布局开关：singleSidebar = 'show'（默认，双列）| 'hide'（单列：隐藏侧边栏 + 主内容占满）
            // 影响的是**渲染期注入**（按需渲染单页时写进 HTML）⇒ 改完需让相关单页重新渲染（重建或删 R2 对象）。
            if (body.site.layout && typeof body.site.layout === 'object') {
                sitePatch.layout = {
                    singleSidebar: (String(body.site.layout.singleSidebar) === 'hide') ? 'hide' : 'show',
                };
            }
            // head 自定义 HTML：只有显式传入才更新（截断到 8KB，防误贴超大内容）
            if (body.site.headExtra !== undefined) {
                sitePatch.headExtra = String(body.site.headExtra || '').slice(0, 8192);
            }
            // 文档库映射（docRoutes）：权威存 D1 site 行；带则整体替换（后台全量编辑）
            if (body.site.docRoutes !== undefined) {
                if (!Array.isArray(body.site.docRoutes)) return json({ error: 'docRoutes 必须是数组' }, 400);
                const cleaned = [];
                for (const dr of body.site.docRoutes) {
                    if (!dr || typeof dr !== 'object') continue;
                    const abc = String(dr.abc || '').replace(/^\/+|\/+$/g, '');
                    const vxyz = validateRoutePrefix(dr.xyz);
                    if (!vxyz.ok) return json({ error: 'docRoutes: ' + vxyz.error }, 400);
                    if (!abc) return json({ error: 'docRoutes: abc 不能为空' }, 400);
                    // xyz 全局唯一
                    if (cleaned.some(function (x) { return x.xyz === vxyz.value; })) {
                        return json({ error: 'docRoutes: xyz 前缀 "' + vxyz.value + '" 重复' }, 400);
                    }
                    cleaned.push({
                        abc: abc,
                        xyz: vxyz.value,
                        styleId: String(dr.styleId || '').slice(0, 60),
                        docNav: ['none', 'sidebar', 'prevnext'].includes(String(dr.docNav)) ? String(dr.docNav) : 'sidebar',
                        docIndex: !!dr.docIndex,
                    });
                }
                sitePatch.docRoutes = cleaned;
            }
            const payload = JSON.stringify(Object.assign({}, prev, sitePatch));
            await db.prepare("INSERT INTO settings (k, v) VALUES ('site', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(payload).run();
            result.site = { name: newName, description: newDesc };
            // 路由被移除 / xyz 改名 / abc 换了 ⇒ 清理旧前缀下的**成品**（R2 静态页不会因删配置而消失，
            // 否则旧页面继续被直出，标题还是当时的站名，内容也下不了线）。原稿与 DB 行不动。
            if (sitePatch.docRoutes !== undefined) {
                const prevRoutes = Array.isArray(prev.docRoutes) ? prev.docRoutes : [];
                const nextRoutes = sitePatch.docRoutes;
                const alive = {};
                nextRoutes.forEach(function (r) { alive[r.xyz + '\u0000' + r.abc] = true; });
                for (const pr of prevRoutes) {
                    const px = String((pr && pr.xyz) || '').replace(/^\/+|\/+$/g, '');
                    const pa = String((pr && pr.abc) || '').replace(/^\/+|\/+$/g, '');
                    if (!px || alive[px + '\u0000' + pa]) continue;
                    const n = await purgeDocArtifacts(env, px);
                    purged.push({ xyz: px, abc: pa, deleted: n });
                }
                // 同一 xyz 仍在、但壳/导航/目录页开关变了 ⇒ 只让目录页成品失效（正文成品需「整库重建」）
                for (const nr of nextRoutes) {
                    const old = prevRoutes.find(function (r) {
                        return r && String(r.xyz).replace(/^\/+|\/+$/g, '') === nr.xyz;
                    });
                    if (!old) continue;
                    const changed = String(old.styleId || '') !== String(nr.styleId || '')
                        || String(old.docNav || 'sidebar') !== String(nr.docNav || 'sidebar')
                        || !!old.docIndex !== !!nr.docIndex;
                    if (!changed) continue;
                    try { await env.R2_BUCKET.delete(r2KeyFromPath('/' + nr.xyz + '/index.html')); } catch (e) {}
                }
            }
        }
        if (hasCache) {
            const c = body.cache;
            const ttlNum = function (v, dflt) {
                const n = parseInt(v, 10);
                if (isNaN(n) || n < 0) return dflt;
                return Math.min(n, 31536000); // 上限 1 年
            };
            const cacheCfg = {
                ttl_list: ttlNum(c.ttl_list, 0),
                ttl_sidebar: ttlNum(c.ttl_sidebar, 0),
                ttl_site: ttlNum(c.ttl_site, 604800),
                ttl_feed: ttlNum(c.ttl_feed, 14400),
                feed_count: (function () { const n = parseInt(c.feed_count, 10); return (!isNaN(n) && n >= 1) ? Math.min(n, 100) : 20; })(),
                per_page: (function () { const n = parseInt(c.per_page, 10); return (!isNaN(n) && n >= 1) ? Math.min(n, 100) : 10; })(),
                purge_on_publish: !!c.purge_on_publish,
                // 未传则保留原值（避免"只改缓存策略"的旧请求把批量任务配置重置）
                task_batch: (function () {
                    const n = parseInt(c.task_batch, 10);
                    if (!isNaN(n) && n >= 1) return Math.min(n, 100);
                    const pv = parseInt((site.cache || {}).task_batch, 10);
                    return (!isNaN(pv) && pv >= 1) ? Math.min(pv, 100) : 20;
                })(),
                task_concurrency: (function () {
                    const n = parseInt(c.task_concurrency, 10);
                    if (!isNaN(n) && n >= 1) return Math.min(n, 16);
                    const pv = parseInt((site.cache || {}).task_concurrency, 10);
                    return (!isNaN(pv) && pv >= 1) ? Math.min(pv, 16) : 4;
                })(),
            };
            await db.prepare("INSERT INTO settings (k, v) VALUES ('cache', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(cacheCfg)).run();
            result.cache = cacheCfg;
        }
        if (hasComments) {
            // 评论配置（与 WP 设置页同名同义；LWW：谁后保存谁生效）
            const cm = body.comments;
            const mode = ['off', 'embed', 'native'].indexOf(String(cm.mode)) >= 0 ? String(cm.mode) : 'off';
            const accept = ['off', 'pending', 'auto'].indexOf(String(cm.accept)) >= 0 ? String(cm.accept) : 'off';
            const embed = String(cm.embed == null ? '' : cm.embed).slice(0, 20000).trim();
            const rowC = await db.prepare("SELECT v FROM settings WHERE k = 'site'").first();
            let prevC = {};
            try { prevC = JSON.parse((rowC && rowC.v) || '{}'); } catch (e) {}
            const comments = { mode: mode, embed: embed, accept: accept };
            const payloadC = JSON.stringify(Object.assign({}, prevC, { comments: comments }));
            await db.prepare("INSERT INTO settings (k, v) VALUES ('site', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(payloadC).run();
            result.comments = comments;
        }
        // 配置与站点信息打包在同一个 KV 值 site:ctx → 清一次即全面生效；旧的独立配置键顺手清理
        clearSiteCtxMemo();
        try { await env.KV_CACHE.delete('site:ctx'); } catch (e) {}       // 站点设置：仍走 KV
        try { await env.KV_CACHE.delete('cache:config'); } catch (e) {}   // 旧版独立键（已废弃），顺手清
        // 站名/描述/缓存策略变化影响 RSS（以下都在边缘缓存，不消耗 KV）
        try { await edgePurge('rss:'); } catch (e) {}
        // 列表/侧边栏缓存精确失效（首屏；其余分页靠 TTL 过期）
        try { await edgeDelete('home:page:1'); } catch (e) {}
        try { await edgeDelete('sidebar:data'); } catch (e) {}
        await purgeLists(env);
        return json(Object.assign({ ok: true }, result, purged.length ? { purgedArtifacts: purged } : {}));
    }

    // ---- 文档库（documents）----
    // 首次访问时确保 documents 表存在（幂等；线上库不重跑 setup 也能用）
    try {
        await env.D1_DATABASE.prepare(
            "CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY AUTOINCREMENT, source_prefix TEXT NOT NULL, path TEXT NOT NULL, format TEXT DEFAULT 'md', title TEXT DEFAULT '', excerpt TEXT DEFAULT '', status TEXT DEFAULT 'published', date TEXT DEFAULT '', updated_at TEXT DEFAULT '', UNIQUE(source_prefix, path))"
        ).run();
        await env.D1_DATABASE.prepare("CREATE INDEX IF NOT EXISTS idx_documents_prefix ON documents(source_prefix)").run();
    } catch (e) { console.error('ensure documents table:', e); }
    // GET /api/documents?abc=<前缀>&page=&per=  列出某库文档（或全部）
    if (path === '/api/documents' && method === 'GET') {
        const abc = String(url.searchParams.get('abc') || '').replace(/^\/+|\/+$/g, '');
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
        const per = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per') || '50', 10) || 50));
        const conds = [];
        const params = [];
        if (abc) { conds.push('source_prefix = ?'); params.push(abc); }
        const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
        const countRow = await db.prepare('SELECT COUNT(*) AS c FROM documents' + where).bind(...params).first();
        const total = countRow ? (countRow.c || 0) : 0;
        const rows = await db.prepare('SELECT * FROM documents' + where + ' ORDER BY path ASC LIMIT ? OFFSET ?')
            .bind(...params, per, (page - 1) * per).all();
        return json({ ok: true, total: total, page: page, per: per, documents: (rows && rows.results) || [] });
    }

    // POST /api/documents/upsert  单篇上传/更新（原稿 body.base64 + path + title + status；原稿写 R2 + 元数据写 D1）
    //   body: { abc, path, title?, status?, content_base64? }
    if (path === '/api/documents/upsert' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const abc = String(body.abc || '').replace(/^\/+|\/+$/g, '');
        if (!abc) return json({ error: '缺少 abc（原稿目录）' }, 400);
        const vp = validateDocPath(body.path);
        if (!vp.ok) return json({ error: vp.error }, 400);
        const docPath = vp.value;
        const format = vp.format;
        // 同库内去扩展名同名冲突（x.md 与 x.html 并存 → 成品 key 冲突）
        const base = docPath.replace(/\.(md|html?)$/i, '');
        const dup = await db.prepare("SELECT id FROM documents WHERE source_prefix = ? AND path != ? AND replace(replace(path, '.md', ''), '.html', '') = ?")
            .bind(abc, docPath, base).first();
        if (dup) return json({ error: '同库内 "' + base + '" 已存在（.md/.html 不能并存，成品 key 冲突）' }, 400);

        // 原稿内容（base64 或 text）
        let content = '';
        if (body.content_base64) {
            try { content = b64ToUtf8(String(body.content_base64)); } catch (e) { return json({ error: 'content_base64 解码失败' }, 400); }
        } else if (typeof body.content === 'string') {
            content = body.content;
        } else {
            return json({ error: '缺少原稿内容（content 或 content_base64）' }, 400);
        }
        // 写 R2 原稿
        const sk = sourceKey(abc, docPath);
        await env.R2_BUCKET.put(sk, content, { httpMetadata: { contentType: format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8' } });
        // 写 D1 元数据（title/excerpt：未显式传则从原稿提取 —— frontmatter / <title> / 文件名）
        const title = (String(body.title || '').trim().slice(0, 200)) || extractDocTitle(content, format, docPath);
        const excerpt = extractDocExcerpt(content, format).slice(0, 500);
        const status = String(body.status || 'published') === 'draft' ? 'draft' : 'published';
        const now = new Date().toISOString();
        await db.prepare(
            "INSERT INTO documents (source_prefix, path, format, title, excerpt, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
            + "ON CONFLICT(source_prefix, path) DO UPDATE SET format = excluded.format, title = excluded.title, excerpt = excluded.excerpt, status = excluded.status, updated_at = excluded.updated_at"
        ).bind(abc, docPath, format, title, excerpt, status, now).run();
        // 单篇失效：删成品 key（下次访问 miss → 重渲染）
        const siteCtx = await getSiteContext(env);
        const route = (siteCtx.docRoutes || []).find(function (r) { return r.abc === abc; });
        if (route) {
            try { await env.R2_BUCKET.delete(outKey(route.xyz, docPath)); } catch (e) {}
        }
        return json({ ok: true, path: docPath, format: format, title: title });
    }

    // POST /api/documents/import  批量导入（一次多篇；复用 upsert 逻辑）
    //   body: { abc, files: [{path, title?, status?, content_base64?|content?}], rebuild? }
    //   返回：{ok, total, success, fail, errors:[{path, error}]}；rebuild=true 时导入后自动整库重建
    if (path === '/api/documents/import' && method === 'POST') {
        // 请求体保护：单次批量导入上限 25MB（base64 会膨胀约 33%），超出请分批
        const clen = parseInt(request.headers.get('content-length') || '0', 10);
        if (clen > 25 * 1024 * 1024) {
            return json({ error: '批量请求体过大（>25MB），请分批导入' }, 413);
        }
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const abc = String(body.abc || '').replace(/^\/+|\/+$/g, '');
        if (!abc) return json({ error: '缺少 abc（原稿目录）' }, 400);
        const files = Array.isArray(body.files) ? body.files.slice(0, 500) : [];
        if (!files.length) return json({ error: 'files 不能为空' }, 400);
        const siteCtx = await getSiteContext(env);
        const route = (siteCtx.docRoutes || []).find(function (r) { return r.abc === abc; });
        const now = new Date().toISOString();
        let success = 0, fail = 0;
        const errors = [];
        for (const f of files) {
            if (!f || typeof f !== 'object') { fail++; errors.push({ path: String((f && f.path) || ''), error: '无效条目' }); continue; }
            const vp = validateDocPath(f.path);
            if (!vp.ok) { fail++; errors.push({ path: String(f.path || ''), error: vp.error }); continue; }
            const docPath = vp.value;
            const format = vp.format;
            // 同库内去扩展名同名冲突
            const base = docPath.replace(/\.(md|html?)$/i, '');
            const dup = await db.prepare("SELECT id FROM documents WHERE source_prefix = ? AND path != ? AND replace(replace(path, '.md', ''), '.html', '') = ?")
                .bind(abc, docPath, base).first();
            if (dup) { fail++; errors.push({ path: docPath, error: '同库内 "' + base + '" 已存在（.md/.html 不能并存）' }); continue; }
            // 原稿内容
            let content = '';
            if (f.content_base64) {
                try { content = b64ToUtf8(String(f.content_base64)); } catch (e) { fail++; errors.push({ path: docPath, error: 'content_base64 解码失败' }); continue; }
            } else if (typeof f.content === 'string') {
                content = f.content;
            } else {
                fail++; errors.push({ path: docPath, error: '缺少原稿内容' }); continue;
            }
            try {
                await env.R2_BUCKET.put(sourceKey(abc, docPath), content, { httpMetadata: { contentType: format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8' } });
                const title = (String(f.title || '').trim().slice(0, 200)) || extractDocTitle(content, format, docPath);
                const excerpt = extractDocExcerpt(content, format).slice(0, 500);
                const status = String(f.status || 'published') === 'draft' ? 'draft' : 'published';
                await db.prepare(
                    "INSERT INTO documents (source_prefix, path, format, title, excerpt, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                    + "ON CONFLICT(source_prefix, path) DO UPDATE SET format = excluded.format, title = excluded.title, excerpt = excluded.excerpt, status = excluded.status, updated_at = excluded.updated_at"
                ).bind(abc, docPath, format, title, excerpt, status, now).run();
                // 单篇失效成品
                if (route) { try { await env.R2_BUCKET.delete(outKey(route.xyz, docPath)); } catch (e) {} }
                success++;
            } catch (e) {
                console.error('doc import item failed:', docPath, e);
                fail++;
                errors.push({ path: docPath, error: (e && e.message) ? String(e.message) : String(e) });
            }
        }
        // 可选：整库重建
        let rebuildResult = null;
        if (body.rebuild && route && success > 0) {
            try {
                const rows = await db.prepare("SELECT * FROM documents WHERE source_prefix = ? AND status = 'published' ORDER BY path").bind(abc).all();
                const docs = (rows && rows.results) || [];
                let shell = null;
                if (route.styleId) { shell = await readStyleTpl(env, String(route.styleId)); }
                const shared = { docs: docs, shell: shell };
                let okC = 0, failC = 0;
                for (const doc of docs) {
                    try {
                        const html = await renderDocument(env, route, doc, shared);
                        if (!html) { failC++; continue; }
                        await env.R2_BUCKET.put(outKey(route.xyz, doc.path), html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
                        okC++;
                    } catch (e) { console.error('doc import rebuild item failed:', doc.path, e); failC++; }
                }
                if (route.docIndex) {
                    try {
                        const idxHtml = await renderDocIndex(env, route);
                        await env.R2_BUCKET.put(String(route.xyz).replace(/^\/+|\/+$/g, '') + '/index.html', idxHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
                    } catch (e) { console.error('doc import index failed:', e); }
                }
                rebuildResult = { total: docs.length, success: okC, fail: failC };
            } catch (e) { console.error('doc import rebuild failed:', e); rebuildResult = { error: String((e && e.message) || e) }; }
        }
        return json({ ok: true, total: files.length, success: success, fail: fail, errors: errors, rebuild: rebuildResult });
    }

    // POST /api/documents/delete  删除文档（原稿 + 元数据 + 成品）；支持批量
    //   body: { abc, path } 或 { abc, paths: [...] }
    if (path === '/api/documents/delete' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const abc = String(body.abc || '').replace(/^\/+|\/+$/g, '');
        if (!abc) return json({ error: '缺少 abc' }, 400);
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : (body.path ? [String(body.path)] : []);
        if (!paths.length) return json({ error: '缺少 path / paths' }, 400);
        const siteCtx = await getSiteContext(env);
        const route = (siteCtx.docRoutes || []).find(function (r) { return r.abc === abc; });
        let done = 0;
        for (const docPath of paths.slice(0, 500)) {
            if (!docPath) continue;
            if (route) { try { await env.R2_BUCKET.delete(outKey(route.xyz, docPath)); } catch (e) {} }
            try { await env.R2_BUCKET.delete(sourceKey(abc, docPath)); } catch (e) {}
            try { await db.prepare("DELETE FROM documents WHERE source_prefix = ? AND path = ?").bind(abc, docPath).run(); done++; }
            catch (e) { console.error('doc delete failed:', docPath, e); }
        }
        // 目录页成品一并失效：否则列表里还挂着已删除的条目（下次访问 miss 会自动重渲染）
        let indexPurged = false;
        if (route && route.docIndex && done > 0) {
            try {
                await env.R2_BUCKET.delete(String(route.xyz).replace(/^\/+|\/+$/g, '') + '/index.html');
                indexPurged = true;
            } catch (e) { /* ignore */ }
        }
        return json({ ok: true, deleted: done, indexPurged: indexPurged });
    }

    // POST /api/documents/rebuild  整库重建（复用批量任务执行器）
    //   body: { abc }
    if (path === '/api/documents/rebuild' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const abc = String(body.abc || '').replace(/^\/+|\/+$/g, '');
        if (!abc) return json({ error: '缺少 abc' }, 400);
        const siteCtx = await getSiteContext(env);
        const route = (siteCtx.docRoutes || []).find(function (r) { return r.abc === abc; });
        if (!route) return json({ error: '未找到该 abc 对应的文档库映射，请先在站点信息里配置 docRoutes' }, 400);
        const rows = await db.prepare("SELECT * FROM documents WHERE source_prefix = ? AND status = 'published' ORDER BY path")
            .bind(abc).all();
        const docs = (rows && rows.results) || [];
        // 预取壳
        let shell = null;
        if (route.styleId) { shell = await readStyleTpl(env, String(route.styleId)); }
        const shared = { docs: docs, shell: shell };
        let okCount = 0, failCount = 0;
        for (const doc of docs) {
            try {
                const html = await renderDocument(env, route, doc, shared);
                if (!html) { failCount++; continue; }
                await env.R2_BUCKET.put(outKey(route.xyz, doc.path), html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
                okCount++;
            } catch (e) { console.error('doc rebuild failed:', doc.path, e); failCount++; }
        }
        // 目录页
        if (route.docIndex) {
            try {
                const idxHtml = await renderDocIndex(env, route);
                await env.R2_BUCKET.put(String(route.xyz).replace(/^\/+|\/+$/g, '') + '/index.html', idxHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
            } catch (e) { console.error('doc index rebuild failed:', e); }
        }
        return json({ ok: true, total: docs.length, success: okCount, fail: failCount });
    }

    // GET /api/documents/shell?id=<styleId>  读文档壳（无 id / 无 docShell → 返回内置默认）
    if (path === '/api/documents/shell' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        if (!id) return json({ id: '', name: '（默认文档壳）', docShell: DEFAULT_DOC_SHELL });
        let docShell = '', name = id;
        try {
            const j = await readStyleTpl(env, id);
            if (j) { name = String(j.name || id); docShell = String(j.docShell || ''); }
        } catch (e) { /* ignore */ }
        return json({ id: id, name: name, docShell: docShell || DEFAULT_DOC_SHELL });
    }

    // GET /api/documents/shells  列出所有「文档壳」（tpl.json 含 docShell 字段的风格）
    if (path === '/api/documents/shells' && method === 'GET') {
        const out = [];
        try {
            const idx = await styleIndex(env);
            for (const s of idx) {
                if (!s || !s.id) continue;
                const j = await readStyleTpl(env, s.id);
                if (j && j.docShell) out.push({ id: s.id, name: s.name || s.id, source: s.source || 'user' });
            }
        } catch (e) { /* ignore */ }
        return json({ ok: true, shells: out });
    }

    // POST /api/documents/shell/save  保存文档壳（写 D1 styles 的 tpl_json.docShell）
    //   body: { id?, name?, docShell, applyTo? }   applyTo=abc 时顺带把该库 styleId 指向此壳
    if (path === '/api/documents/shell/save' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const docShell = String(body.docShell || '').trim();
        if (!docShell) return json({ error: '壳内容为空' }, 400);
        if (docShell.length > 300 * 1024) return json({ error: '壳内容过大（>300KB）' }, 400);
        let id = String(body.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
        const name = String(body.name || '').trim().slice(0, 40) || ('文档壳 ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
        if (!id) id = 'docshell' + Date.now().toString(36);
        // 写 R2 wp-content/themes/<id>/tpl.json（保留该风格已有 6 类模板等，仅更新 docShell）→ 备份 .bak
        const key = 'wp-content/themes/' + id + '/tpl.json';
        let cur = null;
        try { const o = await env.R2_BUCKET.get(key); if (o) cur = JSON.parse(await o.text()); } catch (e) { cur = null; }
        if (cur && typeof cur === 'object') {
            try { await env.R2_BUCKET.put('wp-content/themes/' + id + '/tpl.json.bak', JSON.stringify(cur), { httpMetadata: { contentType: 'application/json; charset=utf-8' } }); } catch (e) { /* ignore */ }
        }
        const next = (cur && typeof cur === 'object') ? cur : {};
        next.name = (cur && cur.name) || name;
        next.docShell = docShell;
        try {
            await env.R2_BUCKET.put(key, JSON.stringify(next), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
        } catch (e) { return json({ error: '写入失败：' + ((e && e.message) || e) }, 500); }
        // 记入用户风格索引（首次上传）
        const st = await getStyleSetting(db);
        if (!st.user.some(function (x) { return x && x.id === id; })) {
            st.user.push({ id: id, name: next.name || id });
            await setStyleSetting(db, st);
        }
        await touchSiteCtx(env);
        // 可选：把该壳应用到指定库（更新 docRoutes.styleId）——否则「保存」只写壳、库不会变
        let applied = false;
        const applyTo = String(body.applyTo || '').replace(/^\/+|\/+$/g, '');
        if (applyTo) {
            const srow = await db.prepare("SELECT v FROM settings WHERE k = 'site'").first();
            let site = {};
            try { site = JSON.parse((srow && srow.v) || '{}'); } catch (e) { site = {}; }
            const routes = Array.isArray(site.docRoutes) ? site.docRoutes : [];
            let hit = false;
            for (const r of routes) { if (r && r.abc === applyTo) { r.styleId = id; hit = true; } }
            if (hit) {
                site.docRoutes = routes;
                await db.prepare("INSERT INTO settings (k, v) VALUES ('site', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(site)).run();
                await touchSiteCtx(env);
                applied = true;
            }
        }
        return json({ ok: true, id: id, name: next.name || name, applied: applied });
    }

    // ---- 文章 ----
    if (path === '/api/posts' && method === 'GET') {
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
        const per = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per') || '20', 10) || 20));
        const q = url.searchParams.get('q');
        const status = url.searchParams.get('status');
        const taxType = url.searchParams.get('type');
        const taxSlug = url.searchParams.get('tax');
        const sortCol = url.searchParams.get('sort') === 'title' ? 'title COLLATE NOCASE' : 'date';
        const sortDir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
        const offset = (page - 1) * per;
        const conds = [];
        const like = [];
        if (q) { conds.push('(title LIKE ? OR content LIKE ?)'); like.push('%' + q + '%', '%' + q + '%'); }
        if (status === 'published' || status === 'draft') { conds.push('status = ?'); like.push(status); }
        // tax 过滤：兼容单复数（categories/tags 是后台 tax 页历史形态）
        // ⚠️ 不要 decodeURIComponent(taxSlug)：searchParams.get 已自动解码一层，
        // 拿到的就是 DB 里的 slug 原文本（中文 slug 是 %xx 形态的「自由文本」）——
        // 再解一层会把它变成中文字面量、查 post_taxonomy 恒 0。
        const taxTypeNorm = (taxType === 'categories') ? 'category' : ((taxType === 'tags') ? 'tag' : taxType);
        if ((taxTypeNorm === 'category' || taxTypeNorm === 'tag') && taxSlug) {
            conds.push("wp_id IN (SELECT post_id FROM post_taxonomy WHERE taxonomy_type = ? AND taxonomy_slug = ?)");
            like.push(taxTypeNorm, String(taxSlug));
        }
        const where = conds.length ? (' WHERE ' + conds.join(' AND ')) : '';
        const rows = await db.prepare('SELECT wp_id, slug, title, excerpt, date, modified, status, categories, tags, featured_image FROM posts' + where + ' ORDER BY ' + sortCol + ' ' + sortDir + ' LIMIT ? OFFSET ?').bind(...like, per, offset).all();
        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM posts' + where).bind(...like).first();
        return json({ posts: rows.results || [], total: parseInt((cnt && cnt.c) || 0, 10), page, pages: Math.ceil(parseInt((cnt && cnt.c) || 0, 10) / per) });
    }

    // POST /api/posts/{id}/duplicate（复制为草稿）
    let sd = path.match(/^\/api\/posts\/(\d+)\/duplicate$/);
    if (sd && method === 'POST') {
        const id = parseInt(sd[1], 10);
        const row = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404);
        const siteCtx = await getSiteContext(env);
        const off = siteCtx.timezoneOffset || 0;
        let slug = String(row.slug) + '-2';
        for (let tries = 1; tries <= 20; tries++) {
            const hit = await db.prepare('SELECT wp_id FROM posts WHERE slug = ?').bind(slug).first();
            if (!hit) break;
            slug = String(row.slug) + '-' + (tries + 1);
        }
        const wpId = Date.now() * 100 + Math.floor(Math.random() * 100);
        const cats = withDefaultCategory(parseTaxoList(row.categories));
        const tags = parseTaxoList(row.tags);
        await db.prepare('INSERT INTO posts (wp_id, slug, title, content, content_format, excerpt, date, modified, status, categories, tags, featured_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(wpId, slug, String(row.title) + '（副本）', String(row.content || ''), (row.content_format || 'html'), String(row.excerpt || ''), localDateTime(off), localDateTime(off), 'draft', JSON.stringify(cats), JSON.stringify(tags), String(row.featured_image || '')).run();
        await syncTaxonomy(db, wpId, 'category', cats);
        await syncTaxonomy(db, wpId, 'tag', tags);
        return json({ ok: true, id: wpId, slug: slug, status: 'draft' });
    }

    // POST /api/posts/{id}/rebuild（单篇重建静态单页）
    let sr = path.match(/^\/api\/posts\/(\d+)\/rebuild$/);
    if (sr && method === 'POST') {
        const id = parseInt(sr[1], 10);
        const row = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404);
        if (row.status === 'published') {
            await writeSinglePage(env, row);
            await purgeLists(env);
        }
        return json({ ok: true, rebuilt: row.status === 'published' ? 1 : 0 });
    }

    // GET /api/posts/{id}
    let m = path.match(/^\/api\/posts\/(\d+)$/);
    if (m && method === 'GET') {
        const row = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(parseInt(m[1], 10)).first();
        if (!row) return json({ error: 'not found' }, 404);
        // 邻篇（按 date desc 管理列表顺序）
        const all = await db.prepare('SELECT wp_id, slug, title FROM posts ORDER BY date DESC, wp_id DESC').all();
        const list = all.results || [];
        const ix = list.findIndex(function (x) { return x.wp_id === row.wp_id; });
        const prev = ix > 0 ? list[ix - 1] : null;
        const next = (ix >= 0 && ix < list.length - 1) ? list[ix + 1] : null;
        return json(Object.assign({}, row, { prev: prev, next: next }));
    }

    // POST /api/posts（新建）
    if (path === '/api/posts' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const siteCtx = await getSiteContext(env);
        const p = buildPostPayload(body, siteCtx.timezoneOffset || 0);
        if (p.error) return json({ error: p.error }, 400);
        const dt = localDateTime(siteCtx.timezoneOffset || 0);
        // slug 冲突时自动追加 -2/-3…（WP 风格），最多尝试 20 次
        let finalSlug = p.slug;
        for (let tries = 1; tries <= 20; tries++) {
            const hit = await db.prepare('SELECT wp_id FROM posts WHERE slug = ?').bind(finalSlug).first();
            if (!hit) break;
            finalSlug = p.slug + '-' + (tries + 1);
        }
        const wpId = Date.now() * 100 + Math.floor(Math.random() * 100); // 无自增可用唯一 id（时间戳毫秒）
        const catJson = JSON.stringify(withDefaultCategory(p.categories));
        const tagJson = JSON.stringify(p.tags || []);
        await db.prepare("INSERT INTO posts (wp_id, slug, title, content, content_format, excerpt, date, modified, status, categories, tags, featured_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(wpId, finalSlug, p.title, p.content, p.content_format, p.excerpt, p.date, dt, p.status, catJson, tagJson, p.featured_image).run();
        await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(wpId).run();
        const cats = await syncTaxonomy(db, wpId, 'category', withDefaultCategory(p.categories));
        const tags = await syncTaxonomy(db, wpId, 'tag', p.tags);
        if (cats.length || tags.length) {
            await db.prepare('UPDATE posts SET categories = ?, tags = ? WHERE wp_id = ?')
                .bind(JSON.stringify(cats), JSON.stringify(tags), wpId).run();
        }
        if (p.status === 'published') {
            const row2 = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(wpId).first();
            if (row2) await writeSinglePage(env, row2);
            await purgeLists(env);
        }
        return json({ ok: true, id: wpId, slug: finalSlug, date: p.date, single: p.status === 'published' ? 1 : 0 });
    }

    // PUT /api/posts/{id}（更新；正文为纯净 HTML）
    if (m && method === 'PUT') {
        const id = parseInt(m[1], 10);
        const row = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const siteCtx = await getSiteContext(env);
        const p = buildPostPayload(Object.assign({}, row, body), siteCtx.timezoneOffset || 0);
        if (p.error) return json({ error: p.error }, 400);
        // 改 slug 时的唯一性检查（其它文章已占用 → 409）
        if (p.slug !== row.slug) {
            const clash = await db.prepare('SELECT wp_id FROM posts WHERE slug = ? AND wp_id != ?').bind(p.slug, id).first();
            if (clash) return json({ error: 'slug 已被其它文章占用：' + p.slug }, 409);
        }
        await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(id).run();
        const catsIn = withDefaultCategory(body.categories !== undefined ? body.categories : parseTaxoList(row.categories));
        const tagsIn = body.tags !== undefined ? body.tags : parseTaxoList(row.tags);
        const cats = await syncTaxonomy(db, id, 'category', catsIn);
        const tags = await syncTaxonomy(db, id, 'tag', tagsIn);
        await db.prepare('UPDATE posts SET slug = ?, title = ?, content = ?, content_format = ?, excerpt = ?, modified = ?, status = ?, categories = ?, tags = ?, featured_image = ? WHERE wp_id = ?')
            .bind(p.slug, p.title, p.content, p.content_format, p.excerpt, localDateTime(siteCtx.timezoneOffset || 0), p.status, JSON.stringify(cats), JSON.stringify(tags), p.featured_image, id).run();
        // 单页同步：slug 变化先删旧；published 重建/生成单页；转草稿删除单页
        const newRow = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
        if (row && row.status === 'published' && row.slug !== p.slug) await deleteSinglePage(env, row);
        if (p.status === 'published' && newRow) await writeSinglePage(env, newRow);
        if (p.status === 'draft') await deleteSinglePage(env, newRow || row);
        await purgeLists(env);
        return json({ ok: true, id: id, slug: p.slug, single: p.status === 'published' ? 1 : 0 });
    }

    // DELETE /api/posts/{id}
    if (m && method === 'DELETE') {
        const id = parseInt(m[1], 10);
        const row = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
        await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(id).run();
        await db.prepare('DELETE FROM posts WHERE wp_id = ?').bind(id).run();
        await db.prepare('DELETE FROM taxonomies WHERE slug NOT IN (SELECT DISTINCT taxonomy_slug FROM post_taxonomy)').run();
        if (row) await deleteSinglePage(env, row);
        await purgeLists(env);
        return json({ ok: true });
    }

    // POST /api/posts/batch（批量：delete / draft / publish）
    if (path === '/api/posts/batch' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(function (n) { return n > 0; }) : [];
        if (!ids.length) return json({ error: '没有选中文章' }, 400);
        const action = body.action;
        if (action !== 'delete' && action !== 'draft' && action !== 'publish' && action !== 'setcats') return json({ error: 'action 无效' }, 400);
        const siteCtx = await getSiteContext(env);
        const off = siteCtx.timezoneOffset || 0;
        let done = 0;
        // 2026-10 性能改造：原来逐篇「查一次 + 删/改两次 + R2 一次」全程串行，
        // 批量 100 篇 = 几百次串行往返（后台看起来像"卡死"）。现在：
        // 一次性取数 → D1 batch 提交 → R2 用并发池；渲染上下文只预取一次（不再每篇重查模板/侧边栏）。
        const phIds = ids.map(function () { return '?'; }).join(',');
        const rowsRes = await db.prepare('SELECT * FROM posts WHERE wp_id IN (' + phIds + ')').bind(...ids).all();
        const rowsAll = rowsRes.results || [];
        if (action === 'delete') {
            const delStmts = [];
            for (const row of rowsAll) {
                delStmts.push(db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(row.wp_id));
                delStmts.push(db.prepare('DELETE FROM posts WHERE wp_id = ?').bind(row.wp_id));
            }
            if (delStmts.length) await runD1Batch(db, delStmts);
            await db.prepare('DELETE FROM taxonomies WHERE slug NOT IN (SELECT DISTINCT taxonomy_slug FROM post_taxonomy)').run();
            done = rowsAll.length;
            const sharedDel = { site: siteCtx };
            await runBatchChunk(rowsAll, 8, async function (row) {
                await deleteSinglePage(env, row, sharedDel);
                return true;
            });
        } else if (action === 'setcats') {
            // body.categories 可为 [{name}] 数组或字符串/JSON；数组直通（parseTaxoList 只吃 JSON 字符串）
            const catNames = Array.isArray(body.categories) ? body.categories : parseTaxoList(body.categories || []);
            if (!catNames.length) return json({ error: '没有提供分类' }, 400);
            for (const row of rowsAll) {
                // 只替换分类：清旧 category 关联后重建
                await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ? AND taxonomy_type = \'category\'').bind(row.wp_id).run();
                const cats = await syncTaxonomy(db, row.wp_id, 'category', catNames);
                await db.prepare('UPDATE posts SET categories = ?, modified = ? WHERE wp_id = ?').bind(JSON.stringify(cats), localDateTime(off), row.wp_id).run();
                done++;
            }
        } else {
            const want = action === 'publish' ? 'published' : action; // 库内状态值为 published/draft
            const upStmts = [];
            const toRender = [];
            const toDrop = [];
            for (const row of rowsAll) {
                if (row.status === want) { done++; continue; }
                upStmts.push(db.prepare('UPDATE posts SET status = ?, modified = ? WHERE wp_id = ?').bind(want, localDateTime(off), row.wp_id));
                row.status = want;
                if (action === 'publish') toRender.push(row); else toDrop.push(row);
                done++;
            }
            if (upStmts.length) await runD1Batch(db, upStmts);
            if (toRender.length) {
                // 共享上下文（站点/侧边栏/3 个模板）只取一次，整批复用
                const sharedPub = {
                    site: siteCtx,
                    sidebar: await getSidebarData(db),
                    tplSingle: await getActiveTplContent(env, 'single'),
                    sidebarTpl: await getActiveSidebarTpl(env),
                    commentsTpl: await getActiveCommentsTpl(env),
                };
                await runBatchChunk(toRender, 8, async function (row) {
                    return await writeSinglePage(env, row, sharedPub);
                });
            }
            if (toDrop.length) {
                const sharedDrop = { site: siteCtx };
                await runBatchChunk(toDrop, 8, async function (row) {
                    await deleteSinglePage(env, row, sharedDrop);
                    return true;
                });
            }
        }
        if (done) await purgeLists(env);
        return json({ ok: true, done: done });
    }

    // 批量重建静态单页（admin）
    //   GET  → 查进度（用于"是否从断点继续"）；POST → 跑一批（批内并发；进度持久化，可中断续做）
    //   POST 带 ?reset=1 → 丢弃旧进度、从头开始
    //   批量大小 = settings.cache.task_batch；并发数 = settings.cache.task_concurrency
    if (path === '/api/posts/rebuild-single') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const siteCtx = await getSiteContext(env);
        const tcfg = (siteCtx && siteCtx.cache) || {};
        const batch = Math.min(100, Math.max(1, parseInt(tcfg.task_batch, 10) || 20));
        const concurrency = Math.min(16, Math.max(1, parseInt(tcfg.task_concurrency, 10) || 4));
        const JOB = 'rebuild';

        if (method === 'GET') {
            const progress = await getBatchProgress(env, JOB);
            return json({ ok: true, progress: progress, batch: batch, concurrency: concurrency });
        }

        if (method === 'POST') {
            if (url.searchParams.get('reset') === '1') {
                await clearBatchProgress(env, JOB);
            }
            const totalRows = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'").first();
            const total = parseInt((totalRows && totalRows.c) || 0, 10);
            let prog = await getBatchProgress(env, JOB);
            // 进度缺失或总篇数变了 → 重新开始
            if (!prog || parseInt(prog.total, 10) !== total) {
                prog = { cursor: 0, ok: 0, failed: 0, total: total, startedAt: new Date().toISOString() };
            }
            const cursor = Math.max(0, parseInt(prog.cursor, 10) || 0);
            if (cursor >= total) {
                await clearBatchProgress(env, JOB);
                return json({ ok: true, rebuilt: 0, failed: 0, total: total, cursor: total, done: true, batch: batch, concurrency: concurrency });
            }
            const rows = await db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY wp_id ASC LIMIT ? OFFSET ?").bind(batch, cursor).all();
            const list = rows.results || [];
            if (!list.length) {
                await clearBatchProgress(env, JOB);
                return json({ ok: true, rebuilt: 0, failed: 0, total: total, cursor: total, done: true, batch: batch, concurrency: concurrency });
            }
            // 本批共享上下文：查一次给这一批用（原先是每篇各查一遍）
            const shared = {
                site: await getSiteContext(env),
                sidebar: await getSidebarData(env.D1_DATABASE),
                tplSingle: await getActiveTplContent(env, 'single'),
                sidebarTpl: await getActiveSidebarTpl(env),
                commentsTpl: await getActiveCommentsTpl(env),
            };
            const res = await runBatchChunk(list, concurrency, async function (r) {
                return await writeSinglePage(env, r, shared);
            });
            prog.cursor = cursor + list.length;
            prog.ok = (parseInt(prog.ok, 10) || 0) + res.ok;
            prog.failed = (parseInt(prog.failed, 10) || 0) + res.failed;
            prog.updatedAt = new Date().toISOString();
            const done = prog.cursor >= total;
            try {
                if (done) {
                    await clearBatchProgress(env, JOB);
                    await purgeLists(env);
                } else {
                    await setBatchProgress(env, JOB, prog);
                }
            } catch (e) { /* 进度写入失败不影响本批结果 */ }
            return json({
                ok: true, rebuilt: res.ok, failed: res.failed, total: total,
                cursor: prog.cursor, done: done, batch: batch, concurrency: concurrency,
            });
        }
    }

    // ---- 评论管理（Worker 端审核/删除"Worker 端诞生、还没回拉 WP"的评论）----
    //   GET  /api/comments?filter=unpulled|pending|all&page=1&per_page=20&post_id=0
    //   POST /api/comments/<id>  body: {action:'approve'|'unapprove'|'delete'}
    //   已回拉（wp_comment_id > 0 / origin='wp'）的评论：WP 是权威 ⇒ 这里只读（返回 409 提示去 WP 改）
    if (path === '/api/comments' && method === 'GET') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const per = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '20', 10) || 20));
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
        const filter = String(url.searchParams.get('filter') || 'unpulled');
        const postId = parseInt(url.searchParams.get('post_id') || '0', 10) || 0;
        const conds = [];
        const params = [];
        if (filter === 'unpulled') { conds.push("origin = 'worker'"); conds.push('wp_comment_id = 0'); }
        else if (filter === 'pending') { conds.push('approved = 0'); }
        if (postId > 0) { conds.push('post_id = ?'); params.push(postId); }
        const where = conds.length ? (' WHERE ' + conds.join(' AND ')) : '';
        const cnt = await db.prepare('SELECT COUNT(*) AS n FROM comments' + where).bind(...params).first();
        const total = parseInt((cnt && cnt.n) || 0, 10);
        const rows = await db.prepare(
            'SELECT comment_id, wp_comment_id, post_id, parent_id, author, author_email, author_url, date, date_text, content, approved, type, origin, updated_at' +
            ' FROM comments' + where + ' ORDER BY comment_id DESC LIMIT ? OFFSET ?'
        ).bind(...params, per, (page - 1) * per).all();
        const list = (rows && rows.results) || [];
        const ids = Array.from(new Set(list.map(function (c) { return Number(c.post_id) || 0; }))).filter(function (x) { return x > 0; });
        const titles = {};
        if (ids.length) {
            const ph = ids.map(function () { return '?'; }).join(',');
            const pr = await db.prepare('SELECT wp_id, title, slug FROM posts WHERE wp_id IN (' + ph + ')').bind(...ids).all();
            ((pr && pr.results) || []).forEach(function (p) { titles[p.wp_id] = { title: p.title, slug: p.slug }; });
        }
        list.forEach(function (c) {
            const t = titles[c.post_id] || {};
            c.post_title = t.title || '';
            c.post_slug = t.slug || '';
            c.managed_by_wp = (String(c.origin) !== 'worker' || parseInt(c.wp_comment_id, 10) > 0);
        });
        const pend = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE origin = 'worker' AND wp_comment_id = 0 AND approved = 0").first();
        return json({
            ok: true, total: total, page: page, per_page: per, filter: filter,
            pending: parseInt((pend && pend.n) || 0, 10), comments: list,
        });
    }
    const cmAct = path.match(/^\/api\/comments\/(\d+)$/);
    if (cmAct && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const id = parseInt(cmAct[1], 10) || 0;
        const rowC = await db.prepare('SELECT comment_id, origin, wp_comment_id, approved FROM comments WHERE comment_id = ?').bind(id).first();
        if (!rowC) return json({ error: '评论不存在' }, 404);
        if (String(rowC.origin) !== 'worker' || parseInt(rowC.wp_comment_id, 10) > 0) {
            return json({ error: '该评论已由 WordPress 接管，请在 WP 后台审核/删除' }, 409);
        }
        let bodyC = {};
        try { bodyC = await request.json(); } catch (e) { bodyC = {}; }
        const action = String(bodyC.action || '');
        const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (action === 'approve' || action === 'unapprove') {
            const ap = action === 'approve' ? 1 : 0;
            await db.prepare('UPDATE comments SET approved = ?, updated_at = ? WHERE comment_id = ?').bind(ap, nowStr, id).run();
            return json({ ok: true, comment_id: id, approved: ap });
        }
        if (action === 'delete') {
            await db.prepare('DELETE FROM comments WHERE comment_id = ?').bind(id).run();
            return json({ ok: true, comment_id: id, deleted: true });
        }
        return json({ error: '未知操作' }, 400);
    }

    // ---- permalink（URL 形态）：查询 / 预览 / 迁移 / 清理旧文件 ----
    if (path === '/api/permalink' && method === 'GET') {
        const siteP = await getSiteContext(env);
        const pat = siteP.storagePattern || '{slug}/index.html';
        return json({ ok: true, storagePattern: pat, structure: patternToPermalink(pat) });
    }

    if (path === '/api/permalink/preview' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const conv = permalinkToPattern(body.structure);
        if (!conv.pattern) return json({ error: 'URL 结构不能为空' }, 400);
        const siteP = await getSiteContext(env);
        const oldPat = siteP.storagePattern || '{slug}/index.html';
        const rows = await db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY wp_id ASC LIMIT 3").all();
        const samples = (rows.results || []).map(function (r) {
            const siteNew = Object.assign({}, siteP, { storagePattern: conv.pattern });
            return {
                title: String(r.title || '').slice(0, 40),
                oldUrl: urlPathOf(postPublicUrl(r, siteP)),
                newUrl: urlPathOf(postPublicUrl(r, siteNew)),
                oldKey: postStoragePath(r, oldPat),
                newKey: postStoragePath(r, conv.pattern),
            };
        });
        return json({ ok: true, pattern: conv.pattern, oldPattern: oldPat, unsupported: conv.unsupported, samples: samples });
    }

    // 迁移：把已发布单页的 R2 对象按新结构逐篇 copy（旧对象保留！）；全部完成后自动切 storagePattern。
    //   设计成"先 copy 全量 → 再切 pattern"，所以中途任何一步失败都不会影响旧 URL。
    if (path === '/api/permalink/migrate') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const siteP = await getSiteContext(env);
        const tcfg = (siteP && siteP.cache) || {};
        const batch = Math.min(100, Math.max(1, parseInt(tcfg.task_batch, 10) || 20));
        const concurrency = Math.min(16, Math.max(1, parseInt(tcfg.task_concurrency, 10) || 4));
        const JOB = 'permalink';

        if (method === 'GET') {
            const progress = await getBatchProgress(env, JOB);
            return json({ ok: true, progress: progress, batch: batch, concurrency: concurrency, currentPattern: siteP.storagePattern || '' });
        }

        if (method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
            const conv = permalinkToPattern(body.structure);
            if (!conv.pattern) return json({ error: 'URL 结构不能为空' }, 400);
            if (url.searchParams.get('reset') === '1') {
                await clearBatchProgress(env, JOB);
            }
            const totalRows = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'").first();
            const total = parseInt((totalRows && totalRows.c) || 0, 10);
            let prog = await getBatchProgress(env, JOB);
            if (!prog || parseInt(prog.total, 10) !== total || prog.pattern !== conv.pattern) {
                prog = {
                    cursor: 0, ok: 0, failed: 0, skipped: 0, total: total,
                    pattern: conv.pattern, oldPattern: siteP.storagePattern || '',
                    startedAt: new Date().toISOString(),
                };
            }
            const cursor = Math.max(0, parseInt(prog.cursor, 10) || 0);
            if (cursor >= total) {
                await setStoragePattern(env, db, conv.pattern, siteP);
                await clearBatchProgress(env, JOB);
                await purgeLists(env);
                return json({ ok: true, copied: 0, failed: 0, skipped: 0, total: total, cursor: total, done: true, batch: batch, concurrency: concurrency });
            }
            const rows = await db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY wp_id ASC LIMIT ? OFFSET ?").bind(batch, cursor).all();
            const list = rows.results || [];
            const oldKeys = [];
            const oldPat = prog.oldPattern || siteP.storagePattern || '{slug}/index.html';
            const res = await runBatchChunk(list, concurrency, async function (r) {
                const oldKey = postStoragePath(r, oldPat);
                const newKey = postStoragePath(r, conv.pattern);
                if (oldKey === newKey) return true;
                const obj = await env.R2_BUCKET.get(oldKey);
                if (!obj) return false;                      // 旧对象不在（未导出过）→ 记为失败，稍后人工看
                await env.R2_BUCKET.put(newKey, obj.body, { httpMetadata: obj.httpMetadata });
                oldKeys.push(oldKey);
                return true;
            });
            if (oldKeys.length) {
                await appendPermalinkOldKeys(env, oldKeys);
            }
            prog.skipped = list.length - res.ok - res.failed;
            prog.cursor = cursor + list.length;
            prog.ok = (parseInt(prog.ok, 10) || 0) + res.ok;
            prog.failed = (parseInt(prog.failed, 10) || 0) + res.failed;
            prog.updatedAt = new Date().toISOString();
            const done = prog.cursor >= total;
            if (done) {
                await setStoragePattern(env, db, conv.pattern, siteP);
                await clearBatchProgress(env, JOB);
                await purgeLists(env);
            } else {
                await setBatchProgress(env, JOB, prog);
            }
            return json({
                ok: true, copied: res.ok, failed: res.failed, skipped: prog.skipped,
                total: total, cursor: prog.cursor, done: done, batch: batch, concurrency: concurrency,
                switchedTo: done ? conv.pattern : null,
            });
        }
    }

    // 清理旧文件：删掉迁移时记录下来的旧 key（分批键 task:permalink:oldkeys:<cursor>）
    if (path === '/api/permalink/cleanup' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        // 2026-10：旧 key 清单改存 D1 settings 一行（原来散在 KV 的 task:permalink:oldkeys:<cursor>，
        // 清理时要 KV.list + 逐键 get/delete —— 正是把 KV 额度打满的那类操作）。
        const rowOld = await db.prepare('SELECT v FROM settings WHERE k = ?').bind(PERMALINK_OLDKEYS).first();
        let arrOld = [];
        try { arrOld = JSON.parse((rowOld && rowOld.v) || '[]'); } catch (e) {}
        if (!Array.isArray(arrOld)) arrOld = [];
        let deleted = 0;
        for (const key of arrOld) { try { await env.R2_BUCKET.delete(key); deleted++; } catch (e) {} }
        await db.prepare('DELETE FROM settings WHERE k = ?').bind(PERMALINK_OLDKEYS).run();
        return json({ ok: true, deleted: deleted, batches: 1 });
    }

    // 仅切换 URL 结构（不搬文件）：适合"改结构 → 重建全部单页"的省事路线。
    // ⚠️ 切换后到重建完成之前，所有单页地址都会 404（列表页不受影响）。
    if (path === '/api/permalink/switch' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const conv = permalinkToPattern(body.structure);
        if (!conv.pattern) return json({ error: 'URL 结构不能为空' }, 400);
        if (conv.unsupported.length) return json({ error: '含不支持的记号: ' + conv.unsupported.join(' ') }, 400);
        const siteP = await getSiteContext(env);
        const oldPat = siteP.storagePattern || '{slug}/index.html';
        if (oldPat === conv.pattern) return json({ ok: true, pattern: conv.pattern, oldPattern: oldPat, changed: false });
        await setStoragePattern(env, db, conv.pattern, siteP);
        await purgeLists(env);
        return json({ ok: true, pattern: conv.pattern, oldPattern: oldPat, changed: true });
    }

    // 孤儿单页文件：R2 里形如 <path>/index.html、但不属于「当前结构下任何文章」的对象。
    //   body {delete:false}（默认）→ 只扫描并返回列表；{delete:true} → 删除全部孤儿。
    if (path === '/api/permalink/orphans' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { body = {}; }
        const siteP = await getSiteContext(env);
        const pat = siteP.storagePattern || '{slug}/index.html';
        // 1) 当前结构下的「应有」key 集合
        const rows = await db.prepare("SELECT * FROM posts WHERE status = 'published'").all();
        const want = {};
        (rows.results || []).forEach(function (r) { want[postStoragePath(r, pat)] = true; });
        // 2) 扫描 R2 全部对象（分页），挑出「单页形状」且不在应有集合里的
        const found = [];
        let cursor = undefined;
        do {
            const page = await env.R2_BUCKET.list({ limit: 1000, cursor: cursor });
            (page.objects || []).forEach(function (o) {
                const k = String(o.key || '');
                if (!/\/index\.html$/.test(k) && k !== 'index.html') return;   // 非单页形状
                if (/^wp-content\//.test(k) || /^style\//.test(k) || /^hl\//.test(k)) return; // 资源线排除
                if (!want[k]) found.push({ key: k, size: o.size || 0 });
            });
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        // 3) 可选删除
        const doDelete = !!body.delete;
        let deleted = 0;
        if (doDelete) {
            for (const o of found) {
                try { await env.R2_BUCKET.delete(o.key); deleted++; } catch (e) { /* 单个失败继续 */ }
            }
        }
        return json({
            ok: true, pattern: pat,
            expected: Object.keys(want).length,
            orphanCount: found.length,
            orphans: doDelete ? [] : found.slice(0, 50),
            truncated: (!doDelete && found.length > 50),
            deleted: deleted,
        });
    }

    // ---- 模板管理（单页壳 / 列表条目；KV 存储，多套切换） ----
    // ============================================================
    // 风格（docs/style-refactor.md）：废除 tpl:* KV + D1 styles 表
    //   清单 = getStyleIndex()（内置 assets index.json + 用户 D1 k='style'.user）
    //   内容 = wp-content/themes/<id>/tpl.json（assets → R2）
    //   应用 = D1 k='style'.active；上传/删除 = R2 目录 + 索引
    // ============================================================

    // 分类 / 标签清单（文章编辑页的分类/标签下拉建议用；前端 taxItems 期望 { items:[{name,slug}] }）
    if ((path === '/api/categories' || path === '/api/tags') && method === 'GET') {
        const taxType = (path === '/api/tags') ? 'tag' : 'category';
        try {
            // 带「已发布文章数」：LEFT JOIN 保证 0 篇文章的分类/标签也列出（后台管理语义）；
            // 侧边栏的 getSidebar* 是 INNER JOIN（只列有文章的），两者语义不同不能互换。
            const rows = await env.D1_DATABASE.prepare(
                "SELECT t.slug, t.name, COUNT(p.wp_id) AS cnt FROM taxonomies t " +
                "LEFT JOIN post_taxonomy pt ON pt.taxonomy_type = t.type AND pt.taxonomy_slug = t.slug " +
                "LEFT JOIN posts p ON p.wp_id = pt.post_id AND p.status = 'published' " +
                "WHERE t.type = ? GROUP BY t.slug, t.name ORDER BY t.name COLLATE NOCASE ASC"
            ).bind(taxType).all();
            const items = ((rows && rows.results) || []).map(function (r) {
                return { slug: String(r.slug || ''), name: String(r.name || ''), cnt: parseInt(r.cnt, 10) || 0 };
            });
            return json({ ok: true, items: items });
        } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, 500);
        }
    }

    // 菜单编辑器可选项：分类（全部）+ 标签（按文章数取前 5）—— 供设置页「🧭 导航菜单」的下拉使用
    if (path === '/api/menu/options' && method === 'GET') {
        try {
            const sb = await getSidebarData(env.D1_DATABASE);
            const cats = (sb.categories || []).map(function (c) {
                return { slug: String(c.slug || ''), name: String(c.name || ''), cnt: parseInt(c.cnt, 10) || 0 };
            });
            const tags = (sb.tags || []).slice()
                .sort(function (a, b) { return (parseInt(b.cnt, 10) || 0) - (parseInt(a.cnt, 10) || 0); })
                .slice(0, 5)
                .map(function (t) { return { slug: String(t.slug || ''), name: String(t.name || ''), cnt: parseInt(t.cnt, 10) || 0 }; });
            return json({ ok: true, categories: cats, tags: tags });
        } catch (e) {
            return json({ ok: false, error: String((e && e.message) || e) }, 500);
        }
    }

    // GET /api/templates/styles  清单（内置+用户）+ 当前生效
    if (path === '/api/templates/styles' && method === 'GET') {
        const ctx = await getSiteContext(env);
        return json({ styles: await styleIndex(env), active: ctx.activeStyleId || '' });
    }

    // GET /api/templates/style/get?id=  取某风格（tpl.json）；无 id → 当前生效组合
    if (path === '/api/templates/style/get' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        if (id === '__default__') {
            const tplEmpty = {};
            for (const k of TPL_KINDS) tplEmpty[k] = '';
            return json({ id: '__default__', name: '默认风格（内置模板）', tpl: tplEmpty });
        }
        if (!id) {
            const active = (await getActiveTpl(env)) || {};
            const tpl = {};
            for (const k of TPL_KINDS) tpl[k] = (active[k] && active[k].content) || '';
            return json({ id: '', name: '当前生效模板', tpl: tpl });
        }
        const j = await readStyleTpl(env, id);
        if (!j) return json({ error: 'style not found' }, 404);
        const t = (j.tpl && typeof j.tpl === 'object') ? j.tpl : j;
        const tpl = {};
        for (const k of TPL_KINDS) tpl[k] = String(t[k] || '');
        const out = { id: id, name: String(j.name || id), tpl: tpl };
        if (j.sidebar && typeof j.sidebar === 'object') out.sidebar = j.sidebar;
        if (j.comments && typeof j.comments === 'object') out.comments = j.comments;
        return json(out);
    }

    // POST /api/templates/style/preview  预览（{id} 取该风格；{tpl} 直接渲染传入组合）
    if (path === '/api/templates/style/preview' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        let tpl = (body.tpl && typeof body.tpl === 'object') ? body.tpl : null;
        const id = String(body.id || '').trim();
        if (!tpl && id === '__default__') tpl = {};
        if (!tpl && id) {
            const j = await readStyleTpl(env, id);
            if (j) {
                const t = (j.tpl && typeof j.tpl === 'object') ? j.tpl : j;
                tpl = Object.assign({}, t, { sidebar: (j && j.sidebar) || null, comments: (j && j.comments) || null });
            } else return json({ error: 'style not found' }, 404);
        }
        if (!tpl) {
            const active = (await getActiveTpl(env)) || {};
            tpl = {};
            for (const k of TPL_KINDS) tpl[k] = (active[k] && active[k].content) || '';
        }
        const pages = [];
        for (const t of ['single', 'pageHome', 'pageCategory', 'pageTag', 'pageArchive', 'item']) {
            pages.push({ kind: t, html: await tplPreviewHtml(env, t, String(tpl[t] || ''), tpl) });
        }
        return json({ pages: pages });
    }

    // POST /api/templates/style/apply  {id}  应用（写 D1 k='style'.active；__default__/空 = 内置默认模板）
    if (path === '/api/templates/style/apply' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        let id = String(body.id || '').trim();
        if (id === '__default__') id = '';
        if (id) {
            const j = await readStyleTpl(env, id);
            if (!j) return json({ error: 'style not found（风格不存在或未上传）' }, 404);
        }
        const st = await getStyleSetting(db);
        st.active = id;
        await setStyleSetting(db, st);
        await touchSiteCtx(env);
        return json({ ok: true, active: id });
    }

    // GET /api/templates/style/tpl?id=  取某风格 tpl.json 原文（导出 / 三方编辑器用）
    if (path === '/api/templates/style/tpl' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        const j = await readStyleTpl(env, id);
        if (!j) return json({ error: 'style not found' }, 404);
        return json({ ok: true, id: id, tpl: j });
    }

    // POST /api/templates/style/upload  上传单个文件到风格目录
    //   body: { id, path, content | content_base64 }
    //   写 R2 wp-content/themes/<id>/<path>；path 以 tpl.json 结尾时：
    //   先把旧文件备份为 tpl.json.bak（唯一回退底牌）+ 记入用户风格索引
    if (path === '/api/templates/style/upload' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const id = String(body.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
        if (!id) return json({ error: '缺少风格 id（小写字母/数字/-）' }, 400);
        const rel = String(body.path || '').replace(/^\/+/, '').split('/').filter(function (s) { return s && s !== '.' && s !== '..'; }).join('/');
        if (!rel) return json({ error: '缺少文件路径' }, 400);
        let content = '';
        if (typeof body.content_base64 === 'string') {
            try { content = b64ToUtf8(body.content_base64); } catch (e) { return json({ error: 'base64 解码失败' }, 400); }
        } else if (typeof body.content === 'string') {
            content = body.content;
        } else return json({ error: '缺少文件内容（content | content_base64）' }, 400);

        const key = 'wp-content/themes/' + id + '/' + rel;
        const isTpl = /(^|\/)tpl\.json$/i.test(rel);
        const ct = (function (r) {
            const s = String(r).toLowerCase();
            if (/\.json$/.test(s)) return 'application/json; charset=utf-8';
            if (/\.html?$/.test(s)) return 'text/html; charset=utf-8';
            if (/\.css$/.test(s)) return 'text/css; charset=utf-8';
            if (/\.js$/.test(s)) return 'application/javascript; charset=utf-8';
            if (/\.svg$/.test(s)) return 'image/svg+xml';
            if (/\.png$/.test(s)) return 'image/png';
            if (/\.jpe?g$/.test(s)) return 'image/jpeg';
            if (/\.webp$/.test(s)) return 'image/webp';
            if (/\.gif$/.test(s)) return 'image/gif';
            if (/\.woff2$/.test(s)) return 'font/woff2';
            if (/\.woff$/.test(s)) return 'font/woff';
            if (/\.ttf$/.test(s)) return 'font/ttf';
            return 'application/octet-stream';
        })(rel);
        try {
            if (isTpl) {
                const old = await env.R2_BUCKET.get(key);
                if (old) await env.R2_BUCKET.put('wp-content/themes/' + id + '/tpl.json.bak', await old.text(), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
            }
            await env.R2_BUCKET.put(key, content, { httpMetadata: { contentType: ct } });
        } catch (e) { return json({ error: '写入失败：' + ((e && e.message) || e) }, 500); }

        if (isTpl) {
            const st = await getStyleSetting(db);
            if (!st.user.some(function (x) { return x && x.id === id; })) {
                let nm = id;
                try { const p = JSON.parse(content); if (p && typeof p.name === 'string' && p.name.trim()) nm = p.name.trim().slice(0, 40); } catch (e) {}
                st.user.push({ id: id, name: nm });
                await setStyleSetting(db, st);
            }
            await touchSiteCtx(env);
        }
        return json({ ok: true, id: id, path: rel, isTpl: isTpl });
    }

    // POST /api/templates/style/delete  {id}  删除用户风格（R2 整前缀 + 索引）
    if (path === '/api/templates/style/delete' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const id = String(body.id || '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        const bi = await builtinIndex(env);
        if (bi.some(function (x) { return x.id === id; })) return json({ error: '内置风格不可删除' }, 400);
        try {
            const list = await env.R2_BUCKET.list({ prefix: 'wp-content/themes/' + id + '/' });
            for (const o of (list.objects || [])) { try { await env.R2_BUCKET.delete(o.key); } catch (e) {} }
        } catch (e) { /* ignore */ }
        const st = await getStyleSetting(db);
        st.user = st.user.filter(function (x) { return x && x.id !== id; });
        if (st.active === id) st.active = '';
        await setStyleSetting(db, st);
        await touchSiteCtx(env);
        return json({ ok: true });
    }

    // POST /api/templates/style/revert  {id}  用 tpl.json.bak 覆盖回 tpl.json（唯一回退底牌）
    if (path === '/api/templates/style/revert' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const id = String(body.id || '').trim();
        if (!id) return json({ error: '缺少 id' }, 400);
        const obj = await env.R2_BUCKET.get('wp-content/themes/' + id + '/tpl.json.bak');
        if (!obj) return json({ error: '没有可回退的备份（tpl.json.bak）' }, 404);
        await env.R2_BUCKET.put('wp-content/themes/' + id + '/tpl.json', await obj.text(), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
        return json({ ok: true, id: id });
    }

    // POST /api/templates/style/migrate  一次性迁移（style-refactor）：D1 styles 表 → R2 tpl.json + D1 k='style'
    //   幂等；styles 表不存在时视为空。迁移不删原表（确认无误后自行 DROP）。
    if (path === '/api/templates/style/migrate' && method === 'POST') {
        let rows = [];
        try {
            const r = await env.D1_DATABASE.prepare("SELECT id, name, tpl_json FROM styles ORDER BY id ASC, version DESC").all();
            rows = (r && r.results) || [];
        } catch (e) { rows = []; /* 表不存在 */ }
        const seen = new Set();
        const moved = [];
        for (const row of rows) {
            if (!row || !row.id || seen.has(row.id)) continue;
            seen.add(row.id);
            let body = row.tpl_json || '{}';
            try { const p = JSON.parse(body); if (row.name && !p.name) p.name = row.name; body = JSON.stringify(p); } catch (e) { /* 原样 */ }
            try {
                await env.R2_BUCKET.put('wp-content/themes/' + row.id + '/tpl.json', body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
                moved.push(row.id);
            } catch (e) { /* ignore */ }
        }
        const st = await getStyleSetting(db);
        const user = st.user.slice();
        for (const id of moved) {
            if (!user.some(function (x) { return x && x.id === id; })) {
                const row = rows.find(function (x) { return x.id === id; });
                user.push({ id: id, name: (row && row.name) || id });
            }
        }
        await setStyleSetting(db, { active: st.active, user: user });
        await touchSiteCtx(env);
        return json({ ok: true, moved: moved, total: seen.size });
    }
    if (path === '/api/style-assets' && method === 'POST') {
        let form;
        try { form = await request.formData(); } catch (e) { return json({ error: '无效表单' }, 400); }
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ error: '缺少文件' }, 400);
        if (file.size > 5 * 1024 * 1024) return json({ error: '单个资源不能超过 5MB' }, 413);
        const styleSlug = String(form.get('style') || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!styleSlug) return json({ error: '缺少风格名（小写字母/数字/-）' }, 400);
        const rawName = String(file.name || 'file');
        const ext = rawName.includes('.') ? rawName.split('.').pop().toLowerCase() : '';
        const allowed = ['css', 'js', 'mjs', 'json', 'map', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'txt'];
        if (!allowed.includes(ext)) return json({ error: '不支持的类型：.' + ext }, 400);
        const safeBase = rawName.split('.').slice(0, -1).join('.').replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '-').slice(0, 80) || 'asset';
        const relPath = String(form.get('path') || '');
        let relSafe = '';
        if (relPath) {
            relSafe = relPath.split('/').map(function (seg) { return seg.replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '-'); }).filter(function (seg) { return seg && seg !== '.' && seg !== '..'; }).join('/').slice(0, 160);
        }
        if (!relSafe) relSafe = safeBase + '.' + ext;
        // 私人风格资源与内置风格同形：都走 /wp-content/themes/<slug>/（请求链 assets 命中 → 未命中落 R2 同路径）
        const key = 'wp-content/themes/' + styleSlug + '/' + relSafe;
        const buf = await file.arrayBuffer();
        const ct = file.type || (ext === 'css' ? 'text/css' : ext === 'js' ? 'application/javascript' : ext === 'svg' ? 'image/svg+xml' : ext === 'json' ? 'application/json' : 'application/octet-stream');
        await env.R2_BUCKET.put(key, buf, { httpMetadata: { contentType: ct, cacheControl: 'public, max-age=3600' } });
        return json({ ok: true, key: key, url: '/' + key });
    }
    if (path === '/api/style-assets' && method === 'GET') {
        const styleSlug = String(url.searchParams.get('style') || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
        if (!styleSlug) return json({ items: [] });
        const list = await env.R2_BUCKET.list({ prefix: 'wp-content/themes/' + styleSlug + '/' });
        const items = (list.objects || []).map(function (o) { return { key: o.key, size: o.size, url: '/' + o.key }; });
        return json({ items: items });
    }
    if (path === '/api/style-assets/delete' && method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const key = String(body.key || '');
        if (!key.startsWith('wp-content/themes/') && !key.startsWith('style/')) return json({ error: '无效 key' }, 400);
        await env.R2_BUCKET.delete(key);
        return json({ ok: true });
    }

    // ---- 分类 / 标签 ----
    const taxRoute = path.match(/^\/api\/(categories|tags)$/);
    const taxType = taxRoute ? (taxRoute[1] === 'tags' ? 'tag' : 'category') : null;
    if (taxType) {
        if (method === 'GET') {
            const rows = await db.prepare('SELECT t.slug, t.name, COUNT(ps.wp_id) AS cnt FROM taxonomies t LEFT JOIN post_taxonomy pt ON pt.taxonomy_type = t.type AND pt.taxonomy_slug = t.slug LEFT JOIN posts ps ON ps.wp_id = pt.post_id AND ps.status = \'published\' WHERE t.type = ? GROUP BY t.slug ORDER BY t.name COLLATE NOCASE ASC').bind(taxType).all();
            return json({ items: rows.results || [] });
        }
        if (method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
            const name = String(body.name || '').trim();
            if (!name) return json({ error: '名称不能为空' }, 400);
            const slug = body.slug ? String(body.slug) : slugify(name) || ('c' + Date.now().toString(36));
            await db.prepare('INSERT INTO taxonomies (type, slug, name) VALUES (?, ?, ?) ON CONFLICT(type, slug) DO UPDATE SET name = excluded.name').bind(taxType, slug, name).run();
            return json({ ok: true, slug, name });
        }
    }
    const taxTerm = path.match(/^\/api\/(categories|tags)\/([^/]+)$/);
    const termType = taxTerm ? (taxTerm[1] === 'tags' ? 'tag' : 'category') : null;
    if (termType) {
        const termSlug = decodeURIComponent(taxTerm[2]);
        if (method === 'PUT') {
            let body = {};
            try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
            const name = String(body.name || '').trim();
            const newSlug = body.slug ? String(body.slug) : termSlug;
            await db.prepare('UPDATE taxonomies SET name = ?, slug = ? WHERE type = ? AND slug = ?').bind(name || termSlug, newSlug, termType, termSlug).run();
            await db.prepare('UPDATE post_taxonomy SET taxonomy_slug = ? WHERE taxonomy_type = ? AND taxonomy_slug = ?').bind(newSlug, termType, termSlug).run();
            // 同步存量文章 categories/tags JSON 里的 {name,slug}，保证前台列表/单页不残留旧名
            const rel = await db.prepare('SELECT wp_id, categories, tags FROM posts WHERE wp_id IN (SELECT post_id FROM post_taxonomy WHERE taxonomy_type = ? AND taxonomy_slug = ?)').bind(termType, newSlug).all();
            for (const r of (rel.results || [])) {
                for (const col of ['categories', 'tags']) {
                    let arr = parseTaxoList(r[col]);
                    let changed = false;
                    arr = arr.map(function (el) {
                        if (el && String(el.slug) === termSlug) {
                            changed = true;
                            el.name = name || el.name;
                            el.slug = newSlug;
                        }
                        return el;
                    });
                    if (changed) await db.prepare('UPDATE posts SET ' + col + ' = ? WHERE wp_id = ?').bind(JSON.stringify(arr), r.wp_id).run();
                }
            }
            await purgeLists(env);
            return json({ ok: true });
        }
        if (method === 'DELETE') {
            const cnt = await db.prepare('SELECT COUNT(*) AS c FROM post_taxonomy WHERE taxonomy_type = ? AND taxonomy_slug = ?').bind(termType, termSlug).first();
            const n = parseInt((cnt && cnt.c) || 0, 10);
            if (n > 0) {
                return json({ error: '该' + (termType === 'tag' ? '标签' : '分类') + '下仍有 ' + n + ' 篇文章，无法删除' }, 409);
            }
            await db.prepare('DELETE FROM taxonomies WHERE type = ? AND slug = ?').bind(termType, termSlug).run();
            await db.prepare('DELETE FROM post_taxonomy WHERE taxonomy_type = ? AND taxonomy_slug = ?').bind(termType, termSlug).run();
            await purgeLists(env);
            return json({ ok: true });
        }
    }

    // ---- 媒体（R2 wp-content/uploads）----
    if (path === '/api/media' && method === 'POST') {
        let form;
        try { form = await request.formData(); } catch (e) { return json({ error: '无效表单' }, 400); }
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ error: '缺少文件' }, 400);
        if (file.size > 10 * 1024 * 1024) return json({ error: '文件不能超过 10MB' }, 413);
        const name = String(file.name || '').toLowerCase();
        const ext = name.includes('.') ? name.split('.').pop() : '';
        const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        if (!allowed.includes(ext)) return json({ error: '仅支持 jpg/png/gif/webp' }, 400);
        const contentType = file.type || ('image/' + (ext === 'jpg' ? 'jpeg' : ext));
        const now = new Date();
        const y = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
        const rand = Math.random().toString(36).slice(2, 10);
        const safeBase = name.split('.').slice(0, -1).join('.').replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '-').slice(0, 60) || 'img';
        // 存储 key 用中文原文（与 R2/S3 的解码语义一致）；返回给客户端的 URL 再逐段编码
        const asciiBase = safeBase;
        const path = 'wp-content/uploads/' + y + '/' + mm + '/' + rand + '-' + asciiBase + '.' + ext;
        const buf = await file.arrayBuffer();
        // 魔数嗅探：防止伪装扩展名上传非图片（sniff 前若干字节）
        const head = new Uint8Array(buf, 0, 12);
        const sig = function () { let s = ''; for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]); return s; }();
        const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
        const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
        const isGif = sig.slice(0, 4) === 'GIF8';
        const isWebp = sig.slice(0, 4) === 'RIFF' && sig.slice(8, 12) === 'WEBP';
        if (!isPng && !isJpeg && !isGif && !isWebp) return json({ error: '文件内容不是有效图片' }, 400);
        try {
            await env.R2_BUCKET.put(path, buf, { httpMetadata: { contentType: contentType } });
        } catch (e) { console.error('media put failed:', e); return json({ error: '上传失败' }, 500); }
        const site = await getSiteContext(env);
        return json({ ok: true, path: path, url: (site.url || '') + '/' + r2UrlPath(path) });
    }

    // PUT /api/media?key=...（同 key 覆盖替换；正文引用 URL 不变即自动生效）
    if (path === '/api/media' && method === 'PUT') {
        const key = r2KeyFromPath(url.searchParams.get('key') || '');
        if (!key || !key.startsWith('wp-content/uploads/')) return json({ error: '参数错误' }, 400);
        const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
        if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return json({ error: '仅支持 jpg/png/gif/webp' }, 400);
        let form;
        try { form = await request.formData(); } catch (e) { return json({ error: '无效表单' }, 400); }
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ error: '缺少文件' }, 400);
        if (file.size > 10 * 1024 * 1024) return json({ error: '文件不能超过 10MB' }, 413);
        const buf = await file.arrayBuffer();
        const head = new Uint8Array(buf, 0, 12);
        const sig = function () { let s = ''; for (let i = 0; i < head.length; i++) s += String.fromCharCode(head[i]); return s; }();
        const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
        const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
        const isGif = sig.slice(0, 4) === 'GIF8';
        const isWebp = sig.slice(0, 4) === 'RIFF' && sig.slice(8, 12) === 'WEBP';
        if (!isPng && !isJpeg && !isGif && !isWebp) return json({ error: '文件内容不是有效图片' }, 400);
        const contentType = file.type || ('image/' + (ext === 'jpg' ? 'jpeg' : ext));
        try {
            await env.R2_BUCKET.put(key, buf, { httpMetadata: { contentType: contentType } });
        } catch (e) { console.error('media replace failed:', e); return json({ error: '替换失败' }, 500); }
        const site = await getSiteContext(env);
        return json({ ok: true, path: key, url: (site.url || '') + '/' + key });
    }
    if (path === '/api/media' && method === 'GET') {
        const cursor = url.searchParams.get('cursor') || undefined;
        const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
        const list = await env.R2_BUCKET.list({ prefix: 'wp-content/uploads/', limit: limit, cursor: cursor });
        const site = await getSiteContext(env);
        const items = (list.objects || []).map(function (o) {
            return { key: o.key, size: o.size, uploaded: o.uploaded, url: (site.url || '') + '/' + o.key };
        });
        return json({ items: items, truncated: !!list.truncated, cursor: list.truncated ? list.cursor : null });
    }

    // DELETE /api/media?key=wp-content/uploads/...（删除媒体对象）
    if (path === '/api/media' && method === 'DELETE') {
        const key = url.searchParams.get('key') || '';
        if (!key || !key.startsWith('wp-content/uploads/')) return json({ error: '参数错误' }, 400);
        try {
            await env.R2_BUCKET.delete(key);
        } catch (e) { console.error('media delete failed:', e); return json({ error: '删除失败' }, 500); }
        return json({ ok: true, key: key });
    }

    // ---- 用户管理（仅 admin）----
    if (path === '/api/users' && method === 'GET') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const rows = await db.prepare("SELECT id, user_login, user_email, display_name, role, user_status, user_registered FROM users ORDER BY id ASC").all();
        return json({ users: rows.results || [] });
    }
    if (path === '/api/users' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const login = String(body.username || '').trim();
        const pass = String(body.password || '');
        const email = String(body.email || '').trim();
        const role = ['admin', 'editor', 'author', 'subscriber'].includes(body.role) ? body.role : 'editor';
        if (!/^[a-zA-Z0-9_.-]{3,}$/.test(login)) return json({ error: '用户名需 3 位以上字母数字' }, 400);
        if (pass.length < 8) return json({ error: '密码至少 8 位' }, 400);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
        const dup = await db.prepare('SELECT id FROM users WHERE user_login = ?').bind(login).first();
        if (dup) return json({ error: '用户名已存在' }, 409);
        const store = await hashPassword(pass);
        const res = await db.prepare("INSERT INTO users (user_login, user_pass, user_nicename, user_email, display_name, role, user_status) VALUES (?, ?, ?, ?, ?, ?, 1)")
            .bind(login, store, login, email, String(body.display_name || '').trim() || login, role).run();
        return json({ ok: true, id: res && res.meta && res.meta.last_row_id ? res.meta.last_row_id : 0 });
    }
    const um = path.match(/^\/api\/users\/(\d+)$/);
    if (um && method === 'PUT') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const id = parseInt(um[1], 10);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const sets = [];
        const params = [];
        if (body.password !== undefined && String(body.password) !== '') {
            const pw = String(body.password);
            if (pw.length < 8) return json({ error: '密码至少 8 位' }, 400);
            sets.push('user_pass = ?'); params.push(await hashPassword(pw));
        }
        if (body.display_name !== undefined) { sets.push('display_name = ?'); params.push(String(body.display_name).trim()); }
        if (body.email !== undefined) {
            const em = String(body.email).trim();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: '邮箱格式不正确' }, 400);
            sets.push('user_email = ?'); params.push(em);
        }
        if (body.role !== undefined) {
            if (!['admin', 'editor', 'author', 'subscriber'].includes(body.role)) return json({ error: '角色无效' }, 400);
            sets.push('role = ?'); params.push(body.role);
        }
        if (body.user_status !== undefined) {
            const st = body.user_status === 1 ? 1 : 0;
            if (id === authPayload.sub && st === 0) return json({ error: '不能禁用当前登录账号' }, 400);
            sets.push('user_status = ?'); params.push(st);
        }
        if (!sets.length) return json({ error: '没有要更新的字段' }, 400);
        sets.push('updated_at = CURRENT_TIMESTAMP');
        params.push(id);
        await db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').bind(...params).run();
        return json({ ok: true });
    }
    if (um && method === 'DELETE') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const id = parseInt(um[1], 10);
        if (id === authPayload.sub) return json({ error: '不能删除当前登录账号' }, 400);
        await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
        return json({ ok: true });
    }

    // ---- 导出 / 导入（备份恢复）----
    if (path === '/api/export' && method === 'GET') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        const rows = await db.prepare('SELECT wp_id, slug, title, content, content_format, excerpt, date, modified, status, categories, tags, featured_image FROM posts ORDER BY date ASC').all();
        return json({ exportedAt: nowDateTime(), total: (rows.results || []).length, posts: rows.results || [] });
    }
    if (path === '/api/import' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        const siteCtx = await getSiteContext(env);
        const off = siteCtx.timezoneOffset || 0;
        const items = Array.isArray(body.posts) ? body.posts
            : (body.posts && Array.isArray(body.posts.posts) ? body.posts.posts : []);
        if (!items.length) return json({ error: '没有可导入的文章' }, 400);
        const baseId = Math.floor(Date.now()) * 1000000;
        let imported = 0;
        const skipped = [];
        for (let i = 0; i < items.length; i++) {
            const it = items[i] || {};
            const slug = String((it.slug || it.title || '').trim()).toLowerCase();
            if (!slug || !String(it.title || '').trim()) { skipped.push({ slug: slug || '?', reason: '缺少标题或 slug' }); continue; }
            const exists = await db.prepare('SELECT wp_id FROM posts WHERE slug = ?').bind(slug).first();
            if (exists) { skipped.push({ slug: slug, reason: '已存在' }); continue; }
            const itFmt = it.content_format === 'md' ? 'md' : 'html';
            const content = itFmt === 'md' ? String(it.content || '') : scrubHtml(String(it.content || ''));
            const excerpt = (it.excerpt !== undefined && String(it.excerpt).trim() !== '') ? String(it.excerpt).trim()
                : (itFmt === 'md' ? mdToText(content, 200) : excerptOf(content));
            const status = it.status === 'draft' ? 'draft' : 'published';
            const wpId = baseId + i;
            const cats = withDefaultCategory(parseTaxoList(it.categories));
            const tags = parseTaxoList(it.tags);
            await db.prepare('INSERT INTO posts (wp_id, slug, title, content, content_format, excerpt, date, modified, status, categories, tags, featured_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(wpId, slug, String(it.title), content, itFmt, excerpt, String(it.date || '').trim() || localDateTime(off), localDateTime(off), status, JSON.stringify(cats), JSON.stringify(tags), String(it.featured_image || '')).run();
            await syncTaxonomy(db, wpId, 'category', cats);
            await syncTaxonomy(db, wpId, 'tag', tags);
            const nrow = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(wpId).first();
            if (status === 'published' && nrow) await writeSinglePage(env, nrow);
            imported++;
        }
        if (imported) await purgeLists(env);
        return json({ ok: true, imported: imported, skipped: skipped });
    }

    // POST /api/cache/purge（admin：按前缀批量清 KV 缓存）
    if (path === '/api/cache/purge' && method === 'POST') {
        if (authPayload.role !== 'admin') return json({ error: '无权限' }, 403);
        let body = {};
        try { body = await request.json(); } catch (e) { return json({ error: '无效请求体' }, 400); }
        // 默认清：列表首页 + 侧边栏 + RSS（都在边缘缓存）+ site:ctx（KV 里的站点设置快照）
        const all = ['home:page:', 'sidebar:data', 'rss:', 'site:ctx'];
        const prefixes = Array.isArray(body.prefixes) && body.prefixes.length ? body.prefixes : all;
        let cleared = 0;
        for (const p of prefixes) {
            try {
                if (String(p) === 'site:ctx') {
                    await env.KV_CACHE.delete('site:ctx');
                    clearSiteCtxMemo();
                    cleared++;
                } else {
                    const n = await edgePurge(String(p));
                    if (n) cleared += n;
                }
            } catch (e) { console.error('purge failed:', p, e); }
        }
        return json({ ok: true, cleared: cleared });
    }

    // GET /api/audit（内容质检：无分类 / 缺封面 / 超长标题 的已发布文章）
    if (path === '/api/audit' && method === 'GET') {
        const rows = await db.prepare("SELECT wp_id, title, slug, featured_image, categories FROM posts WHERE status = 'published' ORDER BY date DESC").all();
        const noCat = [], noFeature = [], longTitle = [];
        for (const r of (rows.results || [])) {
            const arr = parseTaxoList(r.categories);
            const item = { wp_id: r.wp_id, slug: r.slug, title: String(r.title || '') };
            if (!arr.length) noCat.push(item);
            if (!String(r.featured_image || '').trim()) noFeature.push(item);
            if (item.title.length > 80) longTitle.push(item);
        }
        return json({
            total: (rows.results || []).length,
            noCat: noCat.length, noCatItems: noCat.slice(0, 100),
            noFeature: noFeature.length, noFeatureItems: noFeature.slice(0, 100),
            longTitle: longTitle.length, longTitleItems: longTitle.slice(0, 100),
        });
    }

    // GET /api/export-media（媒体对象清单 JSON，供备份归档）
    if (path === '/api/export-media' && method === 'GET') {
        const out = [];
        let cur = '';
        try {
            for (let i = 0; i < 50; i++) {
                const page = await env.R2_BUCKET.list({ prefix: 'wp-content/uploads/', limit: 1000, cursor: cur || undefined });
                for (const o of (page.objects || [])) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
                if (!page.truncated) break;
                cur = page.cursor || '';
            }
        } catch (e) { console.error('export-media failed:', e); return json({ error: '读取媒体失败' }, 500); }
        return json({ exportedAt: nowDateTime(), total: out.length, items: out });
    }

    // ---- 统计（管理首页概览）----
    if (path === '/api/stats' && method === 'GET') {
        const q1 = await db.prepare('SELECT COUNT(*) AS c FROM posts').first();
        const q2 = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'").first();
        const q3 = await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE status = 'draft'").first();
        const q4 = await db.prepare("SELECT COUNT(*) AS c FROM taxonomies WHERE type = 'category'").first();
        const q5 = await db.prepare("SELECT COUNT(*) AS c FROM taxonomies WHERE type = 'tag'").first();
        let mediaCount = 0;
        let mediaBytes = 0;
        let mcursor = '';
        try {
            for (let i = 0; i < 10; i++) {
                const page = await env.R2_BUCKET.list({ prefix: 'wp-content/uploads/', limit: 1000, cursor: mcursor || undefined });
                for (const o of (page.objects || [])) { mediaCount++; mediaBytes += o.size || 0; }
                if (!page.truncated) break;
                mcursor = page.cursor || '';
            }
        } catch (e) { mediaCount = -1; }
        return json({
            posts: parseInt((q1 && q1.c) || 0, 10),
            published: parseInt((q2 && q2.c) || 0, 10),
            draft: parseInt((q3 && q3.c) || 0, 10),
            categories: parseInt((q4 && q4.c) || 0, 10),
            tags: parseInt((q5 && q5.c) || 0, 10),
            media: mediaCount,
            mediaBytes: mediaBytes,
        });
    }

    return json({ error: '接口不存在' }, 404);
}


// ============================================================
// WP REST 兼容写入口（第三方 md 编辑器：Obsidian / Ulysses / 脚本）
//   路径：/wp-json/wp/v2/* 与 /wp/v2/*
//   认证：Basic Auth（用户名 + 应用密码；也接受账号密码，与 WP Application Passwords 一致）
//   归属：新建文章 wp_id = Date.now()*100+rand（时间戳量级，即 CFSE_WORKER_ID_MIN 之上 ⇒ Worker 端诞生）
//         格式：新建默认 content_format='md'（第三方为 md 编辑器）；若请求体看起来是 HTML 则按 html 存
// ============================================================

const AP_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const wpv2Buckets = new Map();

function apBytesHex(bytes) { let out = ''; for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0'); return out; }
function apHexBytes(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}
function apConstEq(a, b) {
    const x = String(a).toLowerCase(), y = String(b).toLowerCase();
    if (x.length !== y.length) return false;
    let d = 0;
    for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return d === 0;
}

/** 生成应用密码明文：20 位 base32（去掉易混的 l/o/0/1），按 4 位分组便于抄写 */
function genAppPasswordPlain() {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += AP_CHARS[bytes[i] % AP_CHARS.length];
    return str.match(/.{1,4}/g).join('-');
}

/** 应用密码哈希：高熵随机串 ⇒ SHA-256+盐足够（PBKDF2 100k 每请求 20-40ms 会撞免费档 CPU 上限） */
async function hashAppPassword(plain) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const input = new Uint8Array(salt.length + plain.length);
    input.set(salt, 0);
    input.set(new TextEncoder().encode(plain), salt.length);
    const bits = await crypto.subtle.digest('SHA-256', input);
    return 'sha256$' + apBytesHex(salt) + '$' + apBytesHex(new Uint8Array(bits));
}

async function verifyAppPassword(plain, stored) {
    stored = String(stored || '');
    if (!stored) return false;
    if (stored.indexOf('pbkdf2_sha256$') === 0) return verifyPassword(plain, stored);
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'sha256') return false;
    const salt = apHexBytes(parts[1]);
    const input = new Uint8Array(salt.length + plain.length);
    input.set(salt, 0);
    input.set(new TextEncoder().encode(plain), salt.length);
    const bits = await crypto.subtle.digest('SHA-256', input);
    return apConstEq(apBytesHex(new Uint8Array(bits)), parts[2]);
}

async function ensureAppPasswordsTable(env) {
    try {
        await env.D1_DATABASE.prepare("CREATE TABLE IF NOT EXISTS app_passwords (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', pass_hash TEXT NOT NULL, last_used_at TEXT DEFAULT '', created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)").run();
        await env.D1_DATABASE.prepare('CREATE INDEX IF NOT EXISTS idx_apppw_user ON app_passwords(user_id)').run();
    } catch (e) {
        console.error('ensureAppPasswordsTable:', e);
    }
}

/** Basic Auth → {id, username, role, displayName, email, apId}；失败返回 null */
async function authenticateAppPassword(db, request) {
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Basic\s+(.+)$/i);
    if (!m) return null;
    let decoded = '';
    try { decoded = atob(m[1].trim()); } catch (e) { return null; }
    const ix = decoded.indexOf(':');
    if (ix <= 0) return null;
    const username = decoded.slice(0, ix).trim();
    const password = decoded.slice(ix + 1).replace(/\s+/g, '');
    if (!username || !password) return null;
    const u = await db.prepare('SELECT * FROM users WHERE user_login = ?').bind(username).first();
    if (!u || parseInt(u.user_status, 10) !== 1) return null;
    let rows = { results: [] };
    try {
        rows = await db.prepare('SELECT id, pass_hash FROM app_passwords WHERE user_id = ? AND revoked = 0').bind(u.id).all();
    } catch (e) { /* 表未建：忽略，走账号密码兜底 */ }
    for (const r of (rows.results || [])) {
        if (await verifyAppPassword(password, r.pass_hash)) {
            try { await db.prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ?').bind(nowDateTime(), r.id).run(); } catch (e) {}
            return { id: u.id, username: u.user_login, role: u.role, displayName: u.display_name, email: u.user_email, apId: r.id };
        }
    }
    if (await verifyPassword(password, u.user_pass)) {
        return { id: u.id, username: u.user_login, role: u.role, displayName: u.display_name, email: u.user_email, apId: 0 };
    }
    return null;
}

/** 写入口限速：内存滑窗（isolate 级，0 KV）；读 600/分、写 90/分 */
function wpv2RateAllowed(key, isWrite) {
    const limit = isWrite ? 90 : 600;
    const now = Date.now();
    const k = String(key);
    let arr = wpv2Buckets.get(k);
    if (!arr) { arr = []; wpv2Buckets.set(k, arr); }
    while (arr.length && now - arr[0] > 60000) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    return true;
}

function wpErr(code, message, status) {
    return new Response(JSON.stringify({ code: code, message: message, data: { status: status } }), {
        status: status,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
}

function wpJson(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
}

function wpIso(dt) { return String(dt || '').replace(' ', 'T'); }
function wpInternalStatus(st) {
    const v = String(st || '').toLowerCase();
    return (v === 'publish' || v === 'published') ? 'published' : 'draft';
}
function wpRoleNames(role) {
    const r = String(role || '');
    if (r === 'admin') return ['administrator'];
    if (r === 'editor') return ['editor'];
    if (r === 'author') return ['author'];
    return ['subscriber'];
}

/** 取 WP REST 字段文本：支持字符串 / {raw} / {rendered} */
function wpFieldText(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'object') {
        if (typeof v.raw === 'string') return v.raw;
        if (typeof v.rendered === 'string') return v.rendered;
        return undefined;
    }
    return String(v);
}

/** 把分类/标签 slug 列表映射成 term id（WP 客户端认 id） */
async function wpTermIds(db, type, listJson) {
    const items = parseTaxoList(listJson);
    if (!items.length) return [];
    const rows = await db.prepare('SELECT rowid AS id, slug FROM taxonomies WHERE type = ?').bind(type).all();
    const map = {};
    for (const r of (rows.results || [])) map[r.slug] = r.id;
    const out = [];
    for (const t of items) {
        if (t && map[t.slug] !== undefined) out.push(map[t.slug]);
    }
    return out;
}

/** 入参 terms（id 或 slug 或对象）→ [{name, slug}]；返回 null 表示"未提供" */
async function wpResolveTerms(db, type, input) {
    if (input === undefined || input === null) return null;
    const list = Array.isArray(input) ? input : (typeof input === 'string' ? String(input).split(',') : [input]);
    const rows = await db.prepare('SELECT rowid AS id, slug, name FROM taxonomies WHERE type = ?').bind(type).all();
    const byId = {}, bySlug = {};
    for (const t of (rows.results || [])) { byId[String(t.id)] = t; bySlug[t.slug] = t; }
    const out = [];
    for (const el of list) {
        if (el === undefined || el === null || el === '') continue;
        let hit = null;
        if (typeof el === 'object') {
            if (el.id !== undefined) hit = byId[String(el.id)];
            else if (el.slug) hit = bySlug[String(el.slug)];
        } else {
            const key = String(el).trim();
            hit = byId[key] || bySlug[key];
        }
        if (hit) out.push({ name: hit.name, slug: hit.slug });
    }
    return out;
}

/** WP REST 请求体 → 内部 payload（categories/tags 由调用方解析后填入） */
function wpPayloadFromRest(body, row) {
    const prevFmt = row ? ((row.content_format === 'md') ? 'md' : 'html') : 'md';
    let fmt = prevFmt;
    const fmtIn = (body.content_format !== undefined) ? body.content_format
        : (body.meta && typeof body.meta === 'object' ? body.meta.content_format : undefined);
    const titleIn = wpFieldText(body.title);
    const title = (titleIn !== undefined ? String(titleIn) : (row ? String(row.title) : '')).trim();
    if (!title) return { error: '标题不能为空' };
    const contentIn = wpFieldText(body.content);
    const rawContent = contentIn !== undefined ? String(contentIn) : (row ? String(row.content || '') : '');
    const looksHtml = /<(p|div|h[1-6]|ul|ol|li|blockquote|pre|img|figure|br)\b/i.test(rawContent);
    if (fmtIn === 'md' || fmtIn === 'html') fmt = fmtIn;
    else if (fmtIn === undefined && looksHtml) fmt = 'html';
    const content = fmt === 'md' ? rawContent : scrubHtml(rawContent);
    const slugIn = body.slug !== undefined ? String(body.slug) : (row ? String(row.slug || '') : '');
    const slug = (slugIn ? slugIn : (slugify(title) || ('p' + Date.now().toString(36)))).toLowerCase();
    const status = body.status !== undefined ? wpInternalStatus(body.status) : (row ? (row.status === 'published' ? 'published' : 'draft') : 'draft');
    const excerptIn = wpFieldText(body.excerpt);
    const excerpt = (excerptIn !== undefined && String(excerptIn).trim() !== '')
        ? String(excerptIn).trim()
        : (row ? String(row.excerpt || '') : (fmt === 'md' ? mdToText(content, 200) : excerptOf(content)));
    const dateIn = body.date !== undefined ? String(body.date).replace('T', ' ').replace(/\..*$/, '').slice(0, 19) : '';
    return {
        title: title,
        content: content,
        content_format: fmt,
        slug: slug,
        status: status,
        excerpt: excerpt,
        featured_image: body.featured_image !== undefined ? String(body.featured_image) : (row ? String(row.featured_image || '') : ''),
        date: dateIn || (row ? String(row.date || '') : localDateTime(0)),
    };
}

/** 组装 WP REST 的 post 形状（含 content.rendered：md 由 marked 渲染） */
async function wpPostShape(db, row, site) {
    const fmt = (row.content_format === 'md') ? 'md' : 'html';
    const raw = String(row.content || '');
    return {
        id: row.wp_id,
        date: wpIso(row.date),
        date_gmt: wpIso(row.date),
        modified: wpIso(row.modified),
        modified_gmt: wpIso(row.modified),
        slug: row.slug,
        status: row.status === 'published' ? 'publish' : 'draft',
        type: 'post',
        link: postPublicUrl(row, site),
        title: { rendered: row.title, raw: row.title },
        content: { rendered: fmt === 'md' ? mdToHtml(raw) : raw, raw: raw, protected: false },
        excerpt: { rendered: String(row.excerpt || ''), raw: String(row.excerpt || ''), protected: false },
        author: 0,
        featured_media: 0,
        comment_status: 'closed',
        ping_status: 'closed',
        sticky: false,
        format: 'standard',
        categories: await wpTermIds(db, 'category', row.categories),
        tags: await wpTermIds(db, 'tag', row.tags),
        meta: { content_format: fmt, cfse_wp_id: row.wp_id },
        cfse: { content_format: fmt, categories: parseTaxoList(row.categories), tags: parseTaxoList(row.tags) },
    };
}

/**
 * 入口：命中 /wp-json/wp/v2/* 或 /wp/v2/* 时由 routes 调用
 */
export async function handleWpV2(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const raw = url.pathname.replace(/^\/wp-json/, '');
    if (!(raw === '/wp/v2' || raw.indexOf('/wp/v2/') === 0)) return wpErr('rest_no_route', '未找到路由', 404);
    const route = raw.slice('/wp/v2'.length) || '/';
    const db = env.D1_DATABASE;

    const user = await authenticateAppPassword(db, request);
    if (!user) {
        return new Response(JSON.stringify({ code: 'rest_forbidden', message: '认证失败：请用「用户名 + 应用密码」的 Basic Auth（或账号密码）', data: { status: 401 } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'WWW-Authenticate': 'Basic realm="cf-static-export-pro"' },
        });
    }
    if (user.role === 'subscriber') return wpErr('rest_forbidden', '该用户无权访问写入口', 403);
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    if (!wpv2RateAllowed(user.apId || user.id, isWrite)) return wpErr('too_many_requests', '请求过于频繁，请稍后再试', 429);

    const site = await getSiteContext(env);
    console.log('[wpv2] ' + method + ' ' + raw + ' user=' + user.username + ' ip=' + (request.headers.get('CF-Connecting-IP') || '-'));

    // 当前用户
    if (route === '/users/me' && method === 'GET') {
        return wpJson({
            id: user.id,
            name: user.displayName || user.username,
            slug: user.username,
            url: '', description: '',
            link: (site.url || '') + '/author/' + user.username + '/',
            roles: wpRoleNames(user.role),
            capabilities: {}, extra_capabilities: {}, avatar_urls: {},
            cfse: { role: user.role, content_format: 'md' },
        });
    }
    // 类型 / 分类法探测（部分客户端启动时会请求）
    if (route === '/types' && method === 'GET') {
        return wpJson({ post: { slug: 'post', name: '文章', rest_base: 'posts', hierarchical: false, supports: { title: true, editor: true, excerpt: true, thumbnail: false, custom_fields: true } } });
    }
    if (route === '/taxonomies' && method === 'GET') {
        return wpJson({
            category: { slug: 'category', types: ['post'], rest_base: 'categories', name: '分类' },
            post_tag: { slug: 'post_tag', types: ['post'], rest_base: 'tags', name: '标签' },
        });
    }

    // 评论（B2）：读者提交 → 写 D1（origin='worker'）→ 由 WP 侧主动拉取落地。
    // 是否接受由站点设置 `cf_comments_accept`（off|pending|auto，默认 off）决定；IP 级限速。
    const cmtM = route.match(/^\/comments(?:\/)?$/);
    if (cmtM && method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!wpv2RateAllowed('comment:' + ip, true)) return wpErr('too_many_requests', '提交过于频繁，请稍后再试', 429);
        let body = {};
        try { body = await request.json(); } catch (e) { body = {}; }
        const r = await createComment(env, body, site);
        if (!r || !r.ok) {
            return wpErr((r && r.code) || 'comment_failed', (r && r.message) || '提交失败', (r && r.status) || 400);
        }
        return wpJson(r.comment, 201);
    }
    if (cmtM && method === 'GET') {
        // 列表接口不在此实现（WP 侧回拉走 X-Auth-Key 的 /sync/comments）
        return wpJson([]);
    }

    // 分类 / 标签
    const termM = route.match(/^\/(categories|tags)(?:\/([^/]+))?$/);
    if (termM) {
        const type = termM[1] === 'tags' ? 'tag' : 'category';
        if (!termM[2] && method === 'GET') {
            const per = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '100', 10) || 100));
            const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
            const rows = await db.prepare('SELECT rowid AS id, slug, name FROM taxonomies WHERE type = ? ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?').bind(type, per, (page - 1) * per).all();
            const out = [];
            for (const t of (rows.results || [])) {
                const c = await db.prepare("SELECT COUNT(*) AS n FROM post_taxonomy pt JOIN posts p ON p.wp_id = pt.post_id AND p.status = 'published' WHERE pt.taxonomy_type = ? AND pt.taxonomy_slug = ?").bind(type, t.slug).first();
                out.push({ id: t.id, count: parseInt((c && c.n) || 0, 10), description: '', link: '', name: t.name, slug: t.slug, taxonomy: type === 'tag' ? 'post_tag' : 'category', parent: 0 });
            }
            return wpJson(out);
        }
        if (!termM[2] && method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) { return wpErr('rest_invalid_json', '无效 JSON', 400); }
            const tName = String(body.name || '').trim();
            if (!tName) return wpErr('rest_invalid_param', '名称不能为空', 400);
            const tSlug = body.slug ? String(body.slug) : (slugify(tName) || ('c' + Date.now().toString(36)));
            await db.prepare('INSERT INTO taxonomies (type, slug, name) VALUES (?, ?, ?) ON CONFLICT(type, slug) DO UPDATE SET name = excluded.name').bind(type, tSlug, tName).run();
            const tRow = await db.prepare('SELECT rowid AS id, slug, name FROM taxonomies WHERE type = ? AND slug = ?').bind(type, tSlug).first();
            return wpJson({ id: tRow ? tRow.id : 0, count: 0, description: '', name: tName, slug: tSlug, taxonomy: type === 'tag' ? 'post_tag' : 'category', parent: 0 }, 201);
        }
        return wpErr('rest_no_route', '方法不支持', 405);
    }

    // 媒体上传：POST /wp/v2/media
    //   ① 标准 WP 形状：multipart/form-data（字段 file；title 可选）
    //   ② 简化形状：原始二进制 body（Content-Type: image/*；文件名走 X-Filename 头或 ?name=）
    // 存储沿用 /api/media 的规则（wp-content/uploads/YYYY/MM/…），只接受 jpg/png/gif/webp。
    if (route === '/media' && method === 'POST') {
        const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
        let buf = null;
        let origName = '';
        let declared = '';
        if (ctype.indexOf('multipart/form-data') === 0) {
            let form;
            try { form = await request.formData(); } catch (e) { return wpErr('rest_invalid_param', '无效的 multipart 表单', 400); }
            const file = form.get('file');
            if (!file || typeof file === 'string') return wpErr('rest_invalid_param', '缺少 file 字段', 400);
            declared = String(file.type || '');
            origName = String(form.get('title') || file.name || 'upload');
            buf = await file.arrayBuffer();
        } else {
            declared = ctype;
            let nm = request.headers.get('X-Filename') || url.searchParams.get('name') || '';
            try { nm = decodeURIComponent(nm); } catch (e) { /* 原样 */ }
            origName = nm || 'upload';
            try { buf = await request.arrayBuffer(); } catch (e) { return wpErr('rest_invalid_param', '读取请求体失败', 400); }
        }
        if (!buf || buf.byteLength === 0) return wpErr('rest_invalid_param', '文件为空', 400);
        if (buf.byteLength > 10 * 1024 * 1024) return wpErr('rest_upload_file_too_big', '文件不能超过 10MB', 413);
        const head = new Uint8Array(buf.slice(0, 12));
        const sig = (function () { let t = ''; for (let i = 0; i < head.length; i++) t += String.fromCharCode(head[i]); return t; })();
        const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
        const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
        const isGif = sig.slice(0, 4) === 'GIF8';
        const isWebp = sig.slice(0, 4) === 'RIFF' && sig.slice(8, 12) === 'WEBP';
        if (!isPng && !isJpeg && !isGif && !isWebp) return wpErr('rest_invalid_media', '只接受 jpg / png / gif / webp 图片', 400);
        const ext = isPng ? 'png' : (isGif ? 'gif' : (isWebp ? 'webp' : 'jpg'));
        const mediaType = isPng ? 'image/png' : (isGif ? 'image/gif' : (isWebp ? 'image/webp' : 'image/jpeg'));
        const base = String(origName).replace(/\.[^.]*$/, '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
        // key 用「内容 SHA-256 前 8 位 + 原名」：同一张图永远落同一个 key ⇒ 重复发布是幂等覆盖，不会堆积副本。
        // （旧规则是 <时间戳>-<名字>，每次发布都会产生新对象。）
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
        let hashHex = '';
        for (let i = 0; i < digest.length; i++) hashHex += digest[i].toString(16).padStart(2, '0');
        // 存储 key 用中文原文（与 R2/S3 解码语义一致）；source_url 再逐段编码返回
        const asciiBase = base;
        const key = 'wp-content/uploads/' + hashHex.slice(0, 8) + '-' + asciiBase + '.' + ext;
        try {
            await env.R2_BUCKET.put(key, buf, { httpMetadata: { contentType: mediaType } });
        } catch (e) {
            console.error('wpv2 media put failed:', e);
            return wpErr('rest_upload_error', '上传失败', 500);
        }
        const mediaUrl = (site.url || '') + '/' + r2UrlPath(key);
        console.log('[wpv2] media uploaded ' + key + ' (' + buf.byteLength + 'B) by ' + user.username);
        return wpJson({
            id: Date.now(),
            date: new Date().toISOString().replace('Z', ''),
            slug: base,
            type: 'attachment',
            link: mediaUrl,
            title: { rendered: origName },
            media_type: 'image',
            mime_type: mediaType,
            source_url: mediaUrl,
            media_details: { file: key, width: 0, height: 0 },
        }, 201);
    }

    // 文章集合
    if (route === '/posts') {
        if (method === 'GET') {
            const per = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') || '10', 10) || 10));
            const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
            const search = url.searchParams.get('search') || '';
            const statusQ = url.searchParams.get('status') || 'publish';
            const conds = [], vals = [];
            if (statusQ && statusQ !== 'any') { conds.push('status = ?'); vals.push(wpInternalStatus(statusQ)); }
            if (search) { conds.push('(title LIKE ? OR content LIKE ?)'); vals.push('%' + search + '%', '%' + search + '%'); }
            const where = conds.length ? (' WHERE ' + conds.join(' AND ')) : '';
            const rows = await db.prepare('SELECT * FROM posts' + where + ' ORDER BY date DESC, wp_id DESC LIMIT ? OFFSET ?').bind(...vals, per, (page - 1) * per).all();
            const cnt = await db.prepare('SELECT COUNT(*) AS c FROM posts' + where).bind(...vals).first();
            const total = parseInt((cnt && cnt.c) || 0, 10);
            const out = [];
            for (const r of (rows.results || [])) out.push(await wpPostShape(db, r, site));
            return new Response(JSON.stringify(out), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'X-WP-Total': String(total),
                    'X-WP-TotalPages': String(Math.ceil(total / per) || 1),
                },
            });
        }
        if (method === 'POST') {
            let body = {};
            try { body = await request.json(); } catch (e) { return wpErr('rest_invalid_json', '无效 JSON', 400); }
            const p = wpPayloadFromRest(body);
            if (p.error) return wpErr('rest_invalid_param', p.error, 400);
            const catsIn = await wpResolveTerms(db, 'category', body.categories);
            const tagsIn = await wpResolveTerms(db, 'tag', body.tags);
            p.categories = catsIn === null ? [] : catsIn;
            p.tags = tagsIn === null ? [] : tagsIn;
            let finalSlug = p.slug;
            for (let tries = 1; tries <= 20; tries++) {
                const hit = await db.prepare('SELECT wp_id FROM posts WHERE slug = ?').bind(finalSlug).first();
                if (!hit) break;
                finalSlug = p.slug + '-' + (tries + 1);
            }
            const wpId = Date.now() * 100 + Math.floor(Math.random() * 100);
            const dt = localDateTime(site.timezoneOffset || 0);
            const catJson = JSON.stringify(withDefaultCategory(p.categories));
            const tagJson = JSON.stringify(p.tags || []);
            await db.prepare('INSERT INTO posts (wp_id, slug, title, content, content_format, excerpt, date, modified, status, categories, tags, featured_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(wpId, finalSlug, p.title, p.content, p.content_format, p.excerpt, p.date || dt, dt, p.status, catJson, tagJson, p.featured_image).run();
            await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(wpId).run();
            const cats = await syncTaxonomy(db, wpId, 'category', withDefaultCategory(p.categories));
            const tags = await syncTaxonomy(db, wpId, 'tag', p.tags);
            if (cats.length || tags.length) {
                await db.prepare('UPDATE posts SET categories = ?, tags = ? WHERE wp_id = ?').bind(JSON.stringify(cats), JSON.stringify(tags), wpId).run();
            }
            if (p.status === 'published') {
                const rowPub = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(wpId).first();
                if (rowPub) await writeSinglePage(env, rowPub);
                await purgeLists(env);
            }
            const created = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(wpId).first();
            return wpJson(await wpPostShape(db, created, site), 201);
        }
        return wpErr('rest_no_route', '方法不支持', 405);
    }

    // 文章单项
    const pm = route.match(/^\/posts\/(\d+)$/);
    if (pm) {
        const id = parseInt(pm[1], 10);
        const row = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
        if (!row) return wpErr('rest_post_invalid_id', '文章不存在：' + id, 404);
        if (method === 'GET') return wpJson(await wpPostShape(db, row, site));
        // 宽容：POST /wp/v2/posts/<id> 也视为更新。
        // WP 官方 REST 用 PUT/PATCH，但不少客户端（含自建 Obsidian 插件）习惯对带 id 的 URL 直接 POST。
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            let body = {};
            try { body = await request.json(); } catch (e) { return wpErr('rest_invalid_json', '无效 JSON', 400); }
            const p = wpPayloadFromRest(body, row);
            if (p.error) return wpErr('rest_invalid_param', p.error, 400);
            const catsIn = await wpResolveTerms(db, 'category', body.categories);
            const tagsIn = await wpResolveTerms(db, 'tag', body.tags);
            if (p.slug !== row.slug) {
                const clash = await db.prepare('SELECT wp_id FROM posts WHERE slug = ? AND wp_id != ?').bind(p.slug, id).first();
                if (clash) return wpErr('rest_slug_conflict', 'slug 已被其它文章占用：' + p.slug, 409);
            }
            await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(id).run();
            const cats = await syncTaxonomy(db, id, 'category', withDefaultCategory(catsIn === null ? parseTaxoList(row.categories) : catsIn));
            const tags = await syncTaxonomy(db, id, 'tag', tagsIn === null ? parseTaxoList(row.tags) : tagsIn);
            await db.prepare('UPDATE posts SET slug = ?, title = ?, content = ?, content_format = ?, excerpt = ?, modified = ?, status = ?, categories = ?, tags = ?, featured_image = ? WHERE wp_id = ?')
                .bind(p.slug, p.title, p.content, p.content_format, p.excerpt, localDateTime(site.timezoneOffset || 0), p.status, JSON.stringify(cats), JSON.stringify(tags), p.featured_image, id).run();
            const newRow = await db.prepare('SELECT * FROM posts WHERE wp_id = ?').bind(id).first();
            if (row.status === 'published' && row.slug !== p.slug) await deleteSinglePage(env, row);
            if (p.status === 'published' && newRow) await writeSinglePage(env, newRow);
            if (p.status === 'draft') await deleteSinglePage(env, newRow || row);
            await purgeLists(env);
            return wpJson(await wpPostShape(db, newRow, site));
        }
        if (method === 'DELETE') {
            await db.prepare('DELETE FROM post_taxonomy WHERE post_id = ?').bind(id).run();
            await db.prepare('DELETE FROM posts WHERE wp_id = ?').bind(id).run();
            await db.prepare('DELETE FROM taxonomies WHERE slug NOT IN (SELECT DISTINCT taxonomy_slug FROM post_taxonomy)').run();
            await deleteSinglePage(env, row);
            await purgeLists(env);
            return wpJson({ deleted: true, previous: { id: row.wp_id, slug: row.slug, title: { rendered: row.title } } });
        }
        return wpErr('rest_no_route', '方法不支持', 405);
    }

    return wpErr('rest_no_route', '未找到路由：' + raw, 404);
}

