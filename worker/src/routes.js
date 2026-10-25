/**
 * 路由规则 - 插件自动生成源模板 routes.template.js
 * 文件位置: worker/routes.template.js
 * 编辑此文件后，点击"初始化部署"即可生效
 *
 * 占位符说明：
 * /^\/([^/]+)\/$/    - WordPress固定链接路由正则
 * {slug}/index.html  - R2存储路径模板
 * https://doc.yuebin.uk         - 静态站点URL
 * 10    - 列表每页文章数（WP 设置页配置）
 */
import { getFromR2 } from './storage';
import { r2KeyFromPath } from './r2key';
import { getPostsByTaxonomy, getTaxonomyInfo, getRecentPosts, getPostsByArchive, getSidebarData, searchPosts } from './database';
import { renderCategoryPage, renderTagPage, renderHomepage, renderArchivePage, cfseInjectHead } from './template-engine';
import { deleteCache, edgeGet, edgeSet, edgeDelete, edgePurge } from './cache';
import { getActiveTplContent, getActiveSidebarTpl } from './tplstore';
import { handleStylePreview } from './preview';
import { handleAdminRequest, handleWpV2, renderSinglePageOnDemand } from './admin';
import { createComment, commentRateAllowed, injectComments } from './comments';
import { getSiteContext, clearSiteCtxMemo } from './site';
import { matchDocRoute, renderDocument, renderDocIndex, outKey } from './documents';
import { getCacheConfig } from './cacheconfig';
import { mdToHtml } from './md';

const CFSE_PER_PAGE = 10;
/** 列表每页文章数：CMS 后台缓存策略卡可配（site.cache.per_page，默认 10） */
function perPageOf(site) {
    const n = parseInt((site && site.cache && site.cache.per_page), 10);
    return (!isNaN(n) && n >= 1) ? Math.min(n, 100) : CFSE_PER_PAGE;
}

/* ---------- X-Auth-Key 写通道：共享限速 ----------
 * /purge-cache /style-list /builtin-sync /d1-batch /upload /delete 这些接口不走登录，
 * 只靠单一 X-Auth-Key。这里加一层「按来源 IP」的内存滑窗限速（isolate 级，0 KV 成本），
 * 避免 key 泄漏后被无限刷。
 * 额度 600 次/分钟：批量导出（默认 4 并发、每篇数个请求）峰值约 2~8 次/秒，留足余量。
 * 注：校验仍分散在各接口处（此处只做限速，不改动它们的鉴权逻辑）。
 */
const XAUTH_RATE_LIMIT = 600;
const xauthRateMap = new Map();

function xauthRateAllowed(ip) {
    const now = Date.now();
    const k = String(ip || 'unknown');
    let e = xauthRateMap.get(k);
    if (!e || now >= e.resetAt) {
        if (xauthRateMap.size > 256) {
            xauthRateMap.forEach(function (v, kk) { if (now >= v.resetAt) xauthRateMap.delete(kk); });
        }
        e = { n: 0, resetAt: now + 60000 };
        xauthRateMap.set(k, e);
    }
    e.n += 1;
    return e.n <= XAUTH_RATE_LIMIT;
}

const CACHE_TTL = {
    STATIC: 31536000,
    HTML: 3600,
    DYNAMIC: 300,
    ERROR: 60,
};

/**
 * 列表页统一缓存入口（纯 TTL 语义）。
 * ttl_list=0：直接渲染返回（不写 KV，最省配额）；ttl_list>0：KV 命中返回，未命中渲染并按 TTL 写 KV。
 */
// 给列表行补上真实评论数（一次 GROUP BY，避免"每篇各查一次"的 N+1）
async function attachCommentCounts(env, data) {
    const posts = (data && data.posts) || [];
    const ids = posts.map(function (p) { return Number(p.wp_id) || 0; }).filter(function (x) { return x > 0; });
    if (!ids.length) return data;
    try {
        const ph = ids.map(function () { return '?'; }).join(',');
        const res = await env.D1_DATABASE.prepare(
            'SELECT post_id, COUNT(*) AS n FROM comments WHERE approved = 1 AND post_id IN (' + ph + ') GROUP BY post_id'
        ).bind(...ids).all();
        const m = {};
        ((res && res.results) || []).forEach(function (r) { m[r.post_id] = Number(r.n) || 0; });
        posts.forEach(function (p) { p.comment_count = m[p.wp_id] || 0; });
    } catch (e) {
        posts.forEach(function (p) { if (p.comment_count === undefined) p.comment_count = 0; });
    }
    return data;
}

async function listCached(env, cacheKey, buildFn) {
    const cfg = await getCacheConfig(env);
    if (!(cfg.ttl_list > 0)) return { hit: false, html: await buildFn() };
    const cached = await edgeGet(cacheKey);
    if (cached) return { hit: true, html: cached };
    const html = await buildFn();
    await edgeSet(cacheKey, html, cfg.ttl_list);
    return { hit: false, html: html };
}

export async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查（JSON + D1 探活）
    if (path === '/health') {
        let dbOk = true;
        try { await env.D1_DATABASE.prepare('SELECT 1 AS ok').first(); } catch (e) { dbOk = false; }
        const body = JSON.stringify({ ok: dbOk, db: dbOk ? 'up' : 'down', ts: new Date().toISOString() });
        return new Response(body, {
            status: dbOk ? 200 : 503,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    }

    // X-Auth-Key 写通道统一限速（在各接口各自鉴权之前；防 key 泄漏后被无限刷）
    if (request.headers.get('X-Auth-Key')) {
        const xauthIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
        if (!xauthRateAllowed(xauthIp)) {
            return new Response(JSON.stringify({ error: 'too many requests' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
            });
        }
    }

    // favicon：无站点图标，静默 204 避免 404 噪音
    if (path === '/favicon.ico' || path === '/favicon.png') {
        return new Response(null, { status: 204 });
    }

    // 清除缓存（导出文章后由插件调用）：body 传 { keys: [...], prefixes: [...] }
    // 开关在 WP 设置页：cf_purge_sidebar（sidebar 即时清）/ cf_purge_lists（列表页第一页即时清）
    if (path === '/purge-cache' && request.method === 'POST') {
        const providedKey = request.headers.get('X-Auth-Key');
        const validKey = env.AUTH_KEY_SECRET;
        if (!providedKey || !validKey || providedKey !== validKey) {
            return new Response('Unauthorized', { status: 401 });
        }
        let payload = {};
        try { payload = await request.json(); } catch (e) { payload = {}; }
        const keys = Array.isArray(payload.keys) ? payload.keys : [];
        const prefixes = Array.isArray(payload.prefixes) ? payload.prefixes : [];
        let removed = 0;
        // site:ctx / cache:config 仍走 KV（站点设置缓存）；其余缓存键都在边缘缓存里
        for (const k of keys) {
            const name = String(k);
            if (name === 'site:ctx' || name === 'cache:config') {
                try { await env.KV_CACHE.delete(name); removed++; } catch (e) {}
            } else if (await edgeDelete(name)) { removed++; }
        }
        for (const p of prefixes) { if (await edgePurge(String(p))) removed++; }
        return new Response(JSON.stringify({ success: true, removed: removed }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 风格资源清单（WP 端「同步风格资源到 static」用；Auth 校验同 /purge-cache）
    if (path === '/style-list' && request.method === 'GET') {
        const providedKey = request.headers.get('X-Auth-Key');
        const validKey = env.AUTH_KEY_SECRET;
        if (!providedKey || !validKey || providedKey !== validKey) {
            return new Response('Unauthorized', { status: 401 });
        }
        const list = await env.R2_BUCKET.list({ prefix: 'style/' });
        const items = (list.objects || []).map(function (o) { return { key: o.key, size: o.size }; });
        return new Response(JSON.stringify({ items: items }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }


    // 风格预览（只读）：直接读 tpl.json 渲染 —— 不写 KV、不改 tpl:active（看风格不必先「应用」）
    //   GET /preview/ · GET /preview/<slug>/ · GET /preview/<slug>/?kind=<kind>
    if (path === '/preview' || path === '/preview/' || /^\/preview\/[^/]+\/?$/.test(path)) {
        return await handleStylePreview(request, env, path, url);
    }

    // 文章清单（WP 端「从 Worker 拉取文章」用；X-Auth-Key 鉴权，不走登录）
    //   GET /sync/posts?limit=200&since=YYYY-MM-DD HH:MM:SS&min_wp_id=0&wp_id=0
    //   - since：增量拉取（modified > since）
    //   - min_wp_id：只取 wp_id >= 该值的文章（WP 端用 1e11 过滤「Worker 端诞生」的篇，见 ROADMAP I.1）
    //   返回按 wp_id 升序；WP 端用 get_post(wp_id) 判断是否已存在 ⇒ 天然幂等，不会重复建文。
    if (path === '/sync/posts' && request.method === 'GET') {
        const providedKey = request.headers.get('X-Auth-Key');
        const validKey = env.AUTH_KEY_SECRET;
        if (!providedKey || !validKey || providedKey !== validKey) {
            return new Response('Unauthorized', { status: 401 });
        }
        const url = new URL(request.url);
        const limitRaw = parseInt(url.searchParams.get('limit') || '200', 10);
        const limit = Math.max(1, Math.min(1000, isNaN(limitRaw) ? 200 : limitRaw));
        const since = (url.searchParams.get('since') || '').trim();
        const minIdRaw = parseInt(url.searchParams.get('min_wp_id') || '0', 10);
        const minId = isNaN(minIdRaw) || minIdRaw < 0 ? 0 : minIdRaw;

        const cols = 'wp_id, slug, title, content, content_format, excerpt, date, modified, status, categories, tags, featured_image';
        const wpIdRaw = parseInt(url.searchParams.get('wp_id') || '0', 10);
        const wpId = isNaN(wpIdRaw) || wpIdRaw <= 0 ? 0 : wpIdRaw;

        const conds = [];
        const params = [];
        if (wpId > 0) { conds.push('wp_id = ?'); params.push(wpId); }
        if (since) { conds.push('modified > ?'); params.push(since); }
        if (minId > 0) { conds.push('wp_id >= ?'); params.push(minId); }
        let sql = 'SELECT ' + cols + ' FROM posts';
        if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
        sql += ' ORDER BY wp_id ASC LIMIT ?';
        params.push(limit);

        let rows = [];
        try {
            const res = await env.D1_DATABASE.prepare(sql).bind(...params).all();
            rows = (res && res.results) || [];
        } catch (e) {
            return new Response(JSON.stringify({ error: 'D1 查询失败: ' + (e && e.message ? e.message : String(e)) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ ok: true, total: rows.length, limit: limit, since: since, min_wp_id: minId, posts: rows }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 站点信息合并同步（WP 端「同步站点信息到 D1」用；X-Auth-Key 鉴权，不走登录）
    //   POST /sync/site-info  body: { fields: { name?, url?, description?, storagePattern?, timezoneOffset?, defaultAuthor? } }
    // 语义：**只覆盖传入且有值的字段**；menu / layout / docRoutes 及未知字段原样保留（服务端 merge）。
    //   只接受上面 6 个基础字段 —— logo / 横幅 / 社交 / 评论 一律由 CMS 后台维护，本端点不触碰。
    // （历史坑：WP 侧原先直接发 SQL 整行覆盖 settings 的 site 行 ⇒ 抹掉 CMS 后台独有配置：导航菜单 / 单页布局 / 文档库映射。）
    if (path === '/sync/site-info' && request.method === 'POST') {
        const providedKey = request.headers.get('X-Auth-Key');
        const validKey = env.AUTH_KEY_SECRET;
        if (!providedKey || !validKey || providedKey !== validKey) {
            return new Response('Unauthorized', { status: 401 });
        }
        let body = {};
        try { body = await request.json(); } catch (e) {
            return new Response(JSON.stringify({ error: '无效请求体' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const fields = (body && typeof body.fields === 'object' && body.fields) ? body.fields : null;
        if (!fields) {
            return new Response(JSON.stringify({ error: '缺少 fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const row = await env.D1_DATABASE.prepare("SELECT v FROM settings WHERE k = 'site'").first();
        let prev = {};
        try { prev = JSON.parse((row && row.v) || '{}'); } catch (e) { prev = {}; }
        const patch = {};
        const putStr = function (k, max) {
            if (fields[k] === undefined) return;
            const s = String(fields[k] == null ? '' : fields[k]).trim();
            if (s === '') return;                 // 空值不写：避免清掉 CMS 后台设置的内容
            patch[k] = s.slice(0, max || 2000);
        };
        putStr('name', 200);
        putStr('url', 500);
        putStr('description', 2000);
        putStr('storagePattern', 200);
        if (fields.timezoneOffset !== undefined) {
            const n = parseInt(fields.timezoneOffset, 10);
            if (!isNaN(n)) patch.timezoneOffset = n;
        }
        if (fields.defaultAuthor && typeof fields.defaultAuthor === 'object' && String(fields.defaultAuthor.name || '').trim() !== '') {
            patch.defaultAuthor = {
                name: String(fields.defaultAuthor.name).trim().slice(0, 200),
                slug: String(fields.defaultAuthor.slug || '').trim().slice(0, 200),
            };
        }
        const updated = Object.keys(patch);
        if (updated.length) {
            await env.D1_DATABASE.prepare("INSERT INTO settings (k, v) VALUES ('site', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
                .bind(JSON.stringify(Object.assign({}, prev, patch))).run();
            clearSiteCtxMemo();
            try { await deleteCache(env.KV_CACHE, 'site:ctx'); } catch (e) {}
            try { await edgeDelete('rss:feed'); } catch (e) {}   // 站点名/URL 变化 ⇒ feed 里的站点信息也要刷新
        }
        return new Response(JSON.stringify({ ok: true, updated: updated, preserved: ['menu', 'layout', 'docRoutes'] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 读者提交评论（**公开**端点：静态站前台没有 Basic Auth；站点需开启 → site.comments.accept，默认 off 拒收）
    //   POST /comments  body: {post, author_name, author_email, author_url, content, parent}
    //   写 D1（origin='worker'、待审）→ 由 WP 侧「⬇️ 从 Worker 拉取评论」落地
    if (path === '/comments' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!commentRateAllowed('comment:' + ip, true)) {
            return new Response(JSON.stringify({ ok: false, code: 'too_many_requests', message: '提交过于频繁，请稍后再试' }), {
                status: 429, headers: { 'Content-Type': 'application/json; charset=utf-8' },
            });
        }
        let body = {};
        try { body = await request.json(); } catch (e) { body = {}; }
        const siteCtx = await getSiteContext(env);
        const r = await createComment(env, body, siteCtx);
        if (!r || !r.ok) {
            return new Response(JSON.stringify({ ok: false, code: (r && r.code) || 'comment_failed', message: (r && r.message) || '提交失败' }), {
                status: (r && r.status) || 400, headers: { 'Content-Type': 'application/json; charset=utf-8' },
            });
        }
        return new Response(JSON.stringify({ ok: true, comment: r.comment }), {
            status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
    }

    // 评论清单（WP 端「回拉评论」用；X-Auth-Key 鉴权，不走登录）
    //   GET /sync/comments?limit=200&post_id=0&unpulled=1
    //   - unpulled=1：只取 origin='worker' 且 wp_comment_id=0 的评论（= Worker 端诞生、还没落地 WP）
    //   - 回拉落地后 WP 侧会把 wp_comment_id 写回 D1 ⇒ 下次不再被拉（不回环）
    if (path === '/sync/comments' && request.method === 'GET') {
        const providedKey = request.headers.get('X-Auth-Key');
        const validKey = env.AUTH_KEY_SECRET;
        if (!providedKey || !validKey || providedKey !== validKey) {
            return new Response('Unauthorized', { status: 401 });
        }
        const url = new URL(request.url);
        const limitRaw = parseInt(url.searchParams.get('limit') || '200', 10);
        const limit = Math.max(1, Math.min(1000, isNaN(limitRaw) ? 200 : limitRaw));
        const postIdRaw = parseInt(url.searchParams.get('post_id') || '0', 10);
        const postId = isNaN(postIdRaw) || postIdRaw <= 0 ? 0 : postIdRaw;
        const unpulled = (url.searchParams.get('unpulled') || '') === '1';

        const cols = 'comment_id, wp_comment_id, post_id, parent_id, author, author_email, author_url, date, content, approved, type, origin';
        const conds = [];
        const params = [];
        if (postId > 0) { conds.push('post_id = ?'); params.push(postId); }
        if (unpulled) { conds.push("origin = 'worker'"); conds.push('wp_comment_id = 0'); }
        let sql = 'SELECT ' + cols + ' FROM comments';
        if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
        sql += ' ORDER BY comment_id ASC LIMIT ?';
        params.push(limit);

        let rows = [];
        try {
            const res = await env.D1_DATABASE.prepare(sql).bind(...params).all();
            rows = (res && res.results) || [];
        } catch (e) {
            return new Response(JSON.stringify({ error: 'D1 查询失败: ' + (e && e.message ? e.message : String(e)) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ ok: true, total: rows.length, limit: limit, post_id: postId, unpulled: unpulled, comments: rows }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 内置风格索引同步（WP 端「快照为新风格」后调用）——
    // 已废弃（docs/style-refactor.md）：内置清单改由 assets /wp-content/themes/index.json + site:ctx 提供，
    // 不再写 KV（原 tpl:index 已废除）。该端点移除，请求落到后面分支（404）。

    // 批量执行 D1（插件导出时把整篇文章的 SQL 打包成一次请求；Auth 校验同上传接口）
    if (path === '/d1-batch' && request.method === 'POST') {
        const providedKey = request.headers.get('X-Auth-Key');
        const validKey = env.AUTH_KEY_SECRET;
        if (!providedKey || !validKey || providedKey !== validKey) {
            return new Response('Unauthorized', { status: 401 });
        }
        let payload = {};
        try { payload = await request.json(); } catch (e) { payload = {}; }
        const statements = Array.isArray(payload.statements) ? payload.statements.slice(0, 200) : [];
        const results = [];
        for (let i = 0; i < statements.length; i++) {
            const st = statements[i] || {};
            const sql = typeof st.sql === 'string' ? st.sql : '';
            const params = Array.isArray(st.params) ? st.params : [];
            if (!sql) { results.push(null); continue; }
            try {
                const stmt = env.D1_DATABASE.prepare(sql);
                const r = params.length ? await stmt.bind(...params).all() : await stmt.all();
                results.push(r.results || null);
            } catch (e) {
                console.error('d1-batch stmt #' + i + ' failed:', e);
                return new Response(JSON.stringify({ success: false, error: String((e && e.message) || e), index: i }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }
        return new Response(JSON.stringify({ success: true, results: results }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 上传/删除管理接口
    if (path === '/upload' && request.method === 'POST') {
        return await handleUpload(request, env);
    }
    if (path === '/delete' && (request.method === 'POST' || request.method === 'DELETE')) {
        return await handleDelete(request, env);
    }

    // 静态资源（图片/css/js/字体/文档等）
    //   注意：未命中时**不直接 404**，而是继续往下匹配（可能是 slug 正好带后缀，或显式 index.html）
    if (path.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|ttf|eot|html?|xml|txt|json|map|webmanifest|pdf)$/)) {
        const file = await getFromR2(env.R2_BUCKET, r2KeyFromPath(path));
        if (file) {
            const isDoc = /\.html?$/i.test(path);
            const isJson = /\.json$/i.test(path);   // tpl.json 等会被改写（风格），不能 immutable 长缓存
            // HTML（文档成品等固化在 R2 的页面）：head 自定义注入（AdSense meta 等）——改配置访问即生效
            if (isDoc && file.contentEncoding !== 'gzip') {
                const text0 = (typeof file.body === 'string') ? file.body : new TextDecoder().decode(file.body);
                const withHead = await injectHeadInto(env, text0);
                if (withHead !== null) {
                    return new Response(withHead, {
                        headers: {
                            'Content-Type': file.contentType || getContentType(path),
                            'Cache-Control': 'public, max-age=60',
                            'X-CFSE-Head': 'injected',
                        }
                    });
                }
            }
            return new Response(file.body, {
                headers: {
                    'Content-Type': file.contentType || getContentType(path),
                    // HTML 会被重新生成（模板/标题变化）、JSON（tpl.json）会被风格编辑改写 ⇒ 不适合 immutable
                    'Cache-Control': (isDoc || isJson) ? 'public, max-age=60' : `public, max-age=${CACHE_TTL.STATIC}, immutable`,
                }
            });
        }
        if (env.WORDPRESS_URL) {
            const response = await fetch(env.WORDPRESS_URL + path);
            if (response.ok) return response;
        }
        // 落到后面的分支（单页 / 归档 / 兜底 404）
    }

    // 目录省略尾斜杠：/foo → 301 /foo/（仅当 R2 里确实有 foo/index.html，避免无谓跳转）
    if (path !== '/' && !path.endsWith('/') && !/\.[a-zA-Z0-9]+$/.test(path)) {
        try {
            const probe = await env.R2_BUCKET.head(r2KeyFromPath(path + '/index.html'));
            if (probe) {
                return new Response(null, { status: 301, headers: { 'Location': url.origin + path + '/' + (url.search || '') } });
            }
        } catch (e) { /* 忽略，继续正常匹配 */ }
    }

    // ============================================
    // 管理后台 API（/api/*）：JWT 登录 / 文章与分类标签管理
    // ============================================
    // ============================================
    // WP REST 兼容写入口（第三方 md 编辑器：Obsidian / Ulysses / 脚本）
    //   路径：/wp-json/wp/v2/* 与 /wp/v2/*
    //   认证：Basic Auth（用户名 + 应用密码），不走 /api/* 的 JWT 中间件
    // ============================================
    if (path.startsWith('/wp-json/') || path.startsWith('/wp/v2/')) {
        return await handleWpV2(request, env);
    }

    if (path.startsWith('/api/')) {
        return await handleAdminRequest(request, env);
    }

    // ============================================
    // 文档库路由（documents）：/xyz/<多级路径>.html 与 /xyz/
    //   成品 .html 已被上方静态分支拦（命中直出）；这里兜底：
    //     - 成品 miss → 读原稿渲染 → 写回成品 → 返回
    //     - 目录页 /xyz/ → 渲染文档列表（docIndex=true）
    //   仅当命中 docRoutes 里的 xyz 前缀才处理（site:ctx 读取，D9：仅在 miss 后）
    // ============================================
    {
        // 先做廉价路径预判（多级 .html 或 /xxx/ 目录形态），避免每个请求都读 site:ctx（D9：KV 只在 miss 后）
        const looksDoc = (path.indexOf('/', 1) > 0 && /\.html?$/i.test(path)) || (/^\/[^/]+\/$/.test(path) && path !== '/');
        if (looksDoc) {
            const siteCtx0 = await getSiteContext(env);
            const docRoutes = Array.isArray(siteCtx0.docRoutes) ? siteCtx0.docRoutes : [];
            if (docRoutes.length) {
                const dm = matchDocRoute(path, docRoutes);
            if (dm) {
                if (dm.kind === 'index' && dm.route.docIndex) {
                    // 目录页 /xyz/：**先读 R2 成品**（重建时写入），命中即直出；miss 才渲染并回写。
                    // ⚠️ 上面的静态分支只匹配「带扩展名」的路径，`/xyz/` 永远到不了那里 ⇒
                    //    这里不自己读一次成品的话，每次访问都会重渲染 + 重写 R2（实测每次多 ~0.8s + 1 次 R2 写）。
                    const idxKey = r2KeyFromPath('/' + String(dm.route.xyz).replace(/^\/+|\/+$/g, '') + '/index.html')
                        || (String(dm.route.xyz).replace(/^\/+|\/+$/g, '') + '/index.html');
                    let idxFile = null;
                    try { idxFile = await getFromR2(env.R2_BUCKET, idxKey); } catch (e) { idxFile = null; }
                    if (idxFile && idxFile.contentEncoding !== 'gzip') {
                        const text0 = (typeof idxFile.body === 'string') ? idxFile.body : new TextDecoder().decode(idxFile.body);
                        const withHead = (await injectHeadInto(env, text0)) || text0;
                        return new Response(withHead, {
                            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-CFSE-Doc': 'index-static' },
                        });
                    }
                    const idxHtml = await renderDocIndex(env, dm.route);
                    if (idxHtml) {
                        try {
                            await env.R2_BUCKET.put(idxKey, idxHtml, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
                        } catch (e) { /* 回写失败不影响返回 */ }
                        return new Response(idxHtml, {
                            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-CFSE-Doc': 'index-render' },
                        });
                    }
                    return buildNotFound('文档目录不存在');
                }
                if (dm.kind === 'doc') {
                    // 成品 miss：按 base 匹配原稿（.md/.html/.htm）→ 渲染 → 写回成品 → 返回
                    const doc = await env.D1_DATABASE.prepare(
                        "SELECT * FROM documents WHERE source_prefix = ? AND status = 'published' AND (path = ? OR path = ? OR path = ?) LIMIT 1"
                    ).bind(dm.route.abc, dm.base + '.md', dm.base + '.html', dm.base + '.htm').first();
                    if (doc) {
                        const html = await renderDocument(env, dm.route, doc, null);
                        if (html) {
                            try {
                                await env.R2_BUCKET.put(outKey(dm.route.xyz, doc.path), html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
                            } catch (e) { /* 回写失败不影响返回 */ }
                            return new Response(html, {
                                headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-CFSE-Doc': 'render' },
                            });
                        }
                    }
                    return buildNotFound('文档不存在');
                }
            }
            }
        }
    }

    // ============================================
    // ============================================
    // robots.txt：静态常量（不查库、不缓存；顺带挡爬虫抓后台与 API）
    // /sitemap.xml 已废弃：原先是「按需全量生成 + KV 缓存」，文章量大时单个请求要吃下
    // 全表查询 + 全量拼接（可能撞免费档 CPU 上限），对「有 RSS + 内链完整」的站点边际
    // 价值也很低 —— 现在不拦它，让它走后面的分支自然落到 404。
    // ============================================
    if (path === '/robots.txt') {
        return new Response('User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n', {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=86400',
            }
        });
    }

    // ============================================
    // RSS Feed：/feed 或 /feed/（由 D1 生成；KV TTL = ttl_feed，默认 4 小时）
    if (path === '/feed' || path === '/feed/') {
        const cacheKey = 'rss:feed';
        const site = await getSiteContext(env);
        const ttlFeed = site.cache.ttl_feed;
        const ccFeed = ttlFeed > 0 ? ('public, max-age=' + ttlFeed) : 'no-store';
        if (ttlFeed > 0) {
            const cached = await edgeGet(cacheKey);
            if (cached) { return new Response(cached, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': ccFeed, 'X-Cache': 'HIT' } }); }
        }
        const data = await getRecentPosts(env.D1_DATABASE, 1, site.cache.feed_count);
        const xml = cseRssXml(site, data.posts || [], '/feed/');
        if (ttlFeed > 0) { await edgeSet(cacheKey, xml, ttlFeed); }
        return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': ccFeed, 'X-Cache': 'MISS' } });
    }

    // ============================================
    // 搜索：/?s=关键词（页面搜索框 action="{{SITE_URL}}/" method=get）
    // 分页：/?s=关键词&paged=N（复用首页壳渲染，sidebar 动态）
    // ============================================
    const searchQuery = url.searchParams.get('s');
    if (searchQuery && String(searchQuery).trim() !== '') {
        const q = String(searchQuery).trim().slice(0, 100);
        const searchPage = parseInt(url.searchParams.get('paged') || '1', 10) || 1;
        if (searchPage < 1) return buildNotFound('页面不存在');
        const cacheKey = 'search:' + q.toLowerCase() + ':page:' + searchPage;

        const site = await getSiteContext(env);
        const perPage = perPageOf(site);
        const data = await searchPosts(env.D1_DATABASE, q, searchPage, perPage);
        await attachCommentCounts(env, data);
        const sidebar = await getSidebar(env);
        const emptyHtml = data.total === 0
            ? '<div class="entry-content" style="padding:20px 0;"><p>没有找到与 “' + htmlEsc(q) + '” 相关的文章，试试其它关键词。</p></div>'
            : '';
        const html = renderHomepage(data, searchPage, data.total, {
            baseUrl: '/',
            sidebar: sidebar,
            sidebarTpl: await getActiveSidebarTpl(env),
            site: site,
            pageTpl: await getActiveTplContent(env, 'pageHome'),
            itemTpl: await getActiveTplContent(env, 'item'),
            emptyHtml: emptyHtml,
            paginationBase: '/?s=' + encodeURIComponent(q) + '&paged=',
        });
        const lc = await listCached(env, cacheKey, async function () { return html; });
        return new Response(lc.html, {
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
                'X-Cache': lc.hit ? 'HIT' : 'MISS',
            }
        });
    }

    // ============================================
    // 归档页：/2024/ 或 /2024/09/
    // ============================================
    const archiveMatch = path.match(/^\/(\d{4})(?:\/(\d{1,2})(?:\/page\/(\d+))?)?\/?$/);
    if (archiveMatch && archiveMatch[1].length === 4) {
        const year = archiveMatch[1];
        const month = archiveMatch[2] ? String(archiveMatch[2]).padStart(2, '0') : null;
        const page = archiveMatch[3] ? parseInt(archiveMatch[3], 10) : 1;
        const cacheKey = `archive:${year}:${month || 'all'}:page:${page}`;

        const site = await getSiteContext(env);
        const perPage = perPageOf(site);
        const data = await getPostsByArchive(env.D1_DATABASE, year, month, page, perPage);
        await attachCommentCounts(env, data);
        const baseUrl = `/${year}/${month ? month + '/' : ''}`;
        const sidebar = await getSidebar(env);

        if (data && (data.posts.length > 0 || page === 1)) {
            const html = renderArchivePage(data, page, data.total, {
                year: year,
                month: month,
                baseUrl: baseUrl,
                sidebar: sidebar,
            sidebarTpl: await getActiveSidebarTpl(env),
                site: site,
                pageTpl: await getActiveTplContent(env, 'pageArchive'),
                itemTpl: await getActiveTplContent(env, 'item')
            });
            const lc = await listCached(env, cacheKey, async function () { return html; });
            return new Response(lc.html, {
                headers: {
                    'Content-Type': 'text/html',
                    'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
                    'X-Cache': lc.hit ? 'HIT' : 'MISS',
                }
            });
        }

        const emptyArchiveData = {
            posts: [],
            total: 0,
            currentPage: page,
            totalPages: 0
        };
        const htmlEmpty = renderArchivePage(emptyArchiveData, page, 0, {
            year: year,
            month: month,
            baseUrl: baseUrl,
            site: site,
            pageTpl: await getActiveTplContent(env, 'pageArchive'),
            itemTpl: await getActiveTplContent(env, 'item')
        });
        return new Response(htmlEmpty, {
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
            }
        });
    }

    // ============================================
    // 作者归档页：/author/<slug>/（模板里 entry-meta 的作者链接指向这里）
    // 单作者站（site.defaultAuthor）：slug 匹配默认作者时列出全部已发布文章；不匹配 → 404
    // ============================================
    if (path.startsWith('/author/')) {
        const match = path.replace(/\/$/, '').match(/^\/author\/([^/]+)(?:\/page\/(\d+))?$/);
        if (match) {
            let wantSlug = match[1];
            try { wantSlug = decodeURIComponent(wantSlug); } catch (e) { /* 保持原样 */ }
            wantSlug = wantSlug.toLowerCase();
            const page = match[2] ? parseInt(match[2], 10) : 1;

            const site = await getSiteContext(env);
            const author = site.defaultAuthor || {};
            const authorSlug = String(author.slug || '').toLowerCase();
            if (authorSlug && wantSlug === authorSlug) {
                const perPage = perPageOf(site);
                const data = await getRecentPosts(env.D1_DATABASE, page, perPage);
                await attachCommentCounts(env, data);
                const baseUrl = `/author/${encodeURIComponent(author.slug)}/`;
                const sidebar = await getSidebar(env);

                if (data && (data.posts.length > 0 || page === 1)) {
                    const html = renderCategoryPage(data, page, data.total, {
                        slug: wantSlug,
                        name: author.name || wantSlug,
                        baseUrl: baseUrl,
                        sidebar: sidebar,
                        sidebarTpl: await getActiveSidebarTpl(env),
                        site: site,
                        pageTpl: await getActiveTplContent(env, 'pageCategory'),
                        itemTpl: await getActiveTplContent(env, 'item')
                    });
                    const cacheKey = `author:${wantSlug}:page:${page}`;
                    const lc = await listCached(env, cacheKey, async function () { return html; });
                    return new Response(lc.html, {
                        headers: {
                            'Content-Type': 'text/html',
                            'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
                            'X-Cache': lc.hit ? 'HIT' : 'MISS',
                        }
                    });
                }
            }
            return buildNotFound('作者不存在');
        }
    }

    // ============================================
    // 分类页
    // ============================================
    if (path.startsWith('/category/')) {
        const match = path.replace(/\/$/, '').match(/^\/category\/([^/]+)(?:\/page\/(\d+))?$/);
        // 无 slug 段时不进归档分支，落到下方文章单页查找（支持 slug 为 tag/category 的文章）
        if (match) {
        const slug = match ? match[1].toLowerCase() : '';
        const page = match && match[2] ? parseInt(match[2], 10) : 1;
        const cacheKey = `category:${slug}:page:${page}`;

        const site = await getSiteContext(env);
        const perPage = perPageOf(site);
        const data = await getPostsByTaxonomy(env.D1_DATABASE, 'category', slug, page, perPage);
        await attachCommentCounts(env, data);
        const taxInfo = await getTaxonomyInfo(env.D1_DATABASE, 'category', slug);
        const baseUrl = `/category/${slug}/`;
        const sidebar = await getSidebar(env);

        if (data && (data.posts.length > 0 || page === 1)) {
            const html = renderCategoryPage(data, page, data.total, {
                slug: slug,
                name: taxInfo ? taxInfo.name : slug,
                baseUrl: baseUrl,
                sidebar: sidebar,
            sidebarTpl: await getActiveSidebarTpl(env),
                site: site,
                pageTpl: await getActiveTplContent(env, 'pageCategory'),
                itemTpl: await getActiveTplContent(env, 'item')
            });
            const lc = await listCached(env, cacheKey, async function () { return html; });
            return new Response(lc.html, {
                headers: {
                    'Content-Type': 'text/html',
                    'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
                    'X-Cache': lc.hit ? 'HIT' : 'MISS',
                }
            });
        }
        return buildNotFound('分类不存在');
        }
    }

    // ============================================
    // 标签页
    // ============================================
    if (path.startsWith('/tag/')) {
        const match = path.replace(/\/$/, '').match(/^\/tag\/([^/]+)(?:\/page\/(\d+))?$/);
        // 无 slug 段时不进归档分支，落到下方文章单页查找（支持 slug 为 tag/category 的文章）
        if (match) {
        const slug = match ? match[1].toLowerCase() : '';
        const page = match && match[2] ? parseInt(match[2], 10) : 1;
        const cacheKey = `tag:${slug}:page:${page}`;

        const site = await getSiteContext(env);
        const perPage = perPageOf(site);
        const data = await getPostsByTaxonomy(env.D1_DATABASE, 'tag', slug, page, perPage);
        await attachCommentCounts(env, data);
        const taxInfo = await getTaxonomyInfo(env.D1_DATABASE, 'tag', slug);
        const baseUrl = `/tag/${slug}/`;
        const sidebar = await getSidebar(env);

        if (data && (data.posts.length > 0 || page === 1)) {
            const html = renderTagPage(data, page, data.total, {
                slug: slug,
                name: taxInfo ? taxInfo.name : slug,
                baseUrl: baseUrl,
                sidebar: sidebar,
            sidebarTpl: await getActiveSidebarTpl(env),
                site: site,
                pageTpl: await getActiveTplContent(env, 'pageTag'),
                itemTpl: await getActiveTplContent(env, 'item')
            });
            const lc = await listCached(env, cacheKey, async function () { return html; });
            return new Response(lc.html, {
                headers: {
                    'Content-Type': 'text/html',
                    'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
                    'X-Cache': lc.hit ? 'HIT' : 'MISS',
                }
            });
        }
        return buildNotFound('标签不存在');
        }
    }

    // ============================================
    // 首页 + 分页
    // ============================================
    if (path === '/' || path.startsWith('/page/')) {
        const page = path === '/' ? 1 : parseInt(path.replace('/page/', '').replace(/\/$/, '') || '1', 10);

        if (!page || page < 1) return buildNotFound('页面不存在');

        const cacheKey = `home:page:${page}`;

        const site = await getSiteContext(env);
        const perPage = perPageOf(site);
        const data = await getRecentPosts(env.D1_DATABASE, page, perPage);
        await attachCommentCounts(env, data);
        const totalPosts = data.total;
        const sidebar = await getSidebar(env);
        const html = renderHomepage(data, page, totalPosts, {
            baseUrl: '/',
            sidebar: sidebar,
            sidebarTpl: await getActiveSidebarTpl(env),
            site: site,
            pageTpl: await getActiveTplContent(env, 'pageHome'),
            itemTpl: await getActiveTplContent(env, 'item')
        });
        const lc = await listCached(env, cacheKey, async function () { return html; });
        return new Response(lc.html, {
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': `public, max-age=${CACHE_TTL.DYNAMIC}`,
                'X-Cache': lc.hit ? 'HIT' : 'MISS',
            }
        });
    }

    // ============================================
    // 文章单页 - 自动适配 WordPress Permalink
    // 插件会根据你的 Permalink 设置替换下面两个占位符
    // 当前模板：/^\/([^/]+)\/$/ → {slug}/index.html
    // ============================================
    const postMatch = path.match(/^\/([^/]+)\/$/);
    if (postMatch) {
        // slug 统一小写（WP 存储为小写；%xx 十六进制也小写），避免 URL 大写编码命中不了 R2/D1
        const slug = postMatch[postMatch.length - 1].toLowerCase();
        const basePath = `{slug}/index.html`;
        let storagePath = basePath;

        if (postMatch.length >= 4) {
            storagePath = storagePath.replace('{year}', postMatch[1] || '');
            storagePath = storagePath.replace('{month}', postMatch[2] || '');
            storagePath = storagePath.replace('{day}', postMatch[3] || '');
        }
        storagePath = storagePath.replace('{slug}', slug);

        // 单页为 R2 静态文件，直接读 R2，不套 KV 缓存（省 KV 读写且避免旧缓存不同步）
        const r2StorageKey = r2KeyFromPath(storagePath);
        let file = r2StorageKey ? await getFromR2(env.R2_BUCKET, r2StorageKey) : null;
        if (!file && env.ENABLE_COMPRESSION && r2StorageKey) {
            file = await getFromR2(env.R2_BUCKET, r2StorageKey + '.gz');
            if (file && !file.contentEncoding) file.contentEncoding = 'gzip';
        }

        if (file) {
            // ② 半动态评论区：R2 里是静态快照，但评论区改为**响应时**从 D1 现场注入
            //    （页面带 <!--CFSE-COMMENTS-START id=N--> 标记时生效）⇒ 新评论/审核结果立即可见，不必重建单页。
            const injected = await injectComments(env, file);
            if (injected !== null) {
                // 叠加 head 自定义注入（评论注入后的文本也要带 AdSense meta 等）
                const withHead = (await injectHeadInto(env, injected)) || injected;
                return new Response(withHead, {
                    status: 200,
                    headers: {
                        'Content-Type': file.contentType || 'text/html; charset=utf-8',
                        'Cache-Control': 'public, max-age=60',
                        'X-CFSE-Comments': 'injected',
                    },
                });
            }
            // ③ head 自定义注入（无评论标记的老单页也覆盖）：保存后访问即时生效，无需重建全部单页
            if (file.contentEncoding !== 'gzip' && (!file.contentType || String(file.contentType).indexOf('html') !== -1)) {
                const text0 = (typeof file.body === 'string') ? file.body : new TextDecoder().decode(file.body);
                const withHead = await injectHeadInto(env, text0);
                if (withHead !== null) {
                    return new Response(withHead, {
                        status: 200,
                        headers: {
                            'Content-Type': file.contentType || 'text/html; charset=utf-8',
                            'Cache-Control': 'public, max-age=60',
                            'X-CFSE-Head': 'injected',
                        },
                    });
                }
            }
            const payload = {
                body: bytesToBase64(file.body),
                contentType: file.contentType || 'text/html',
                contentEncoding: file.contentEncoding || null,
            };
            return buildBinaryResponse(payload, 'MISS');
        }

        // R2 未命中 → 按需渲染（D1 → 当前风格模板 → 写回 R2）。
        // 场景：WP 侧文章「只同步 D1 不上传 R2」时，单页由 Worker 现场渲染并回填 R2，站点自愈。
        const onDemand = await renderSinglePageOnDemand(env, slug);
        if (onDemand && onDemand.html) {
            return new Response(onDemand.html, {
                status: 200,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'public, max-age=300',
                    'X-CFSE-Render': 'on-demand',
                },
            });
        }
        if (env.WORDPRESS_URL) {
            const response = await fetch(`${env.WORDPRESS_URL}${path}`);
            if (response.ok) return response;
        }
        return buildNotFound('文章不存在');
    }

    return buildNotFound('页面不存在');
}

// ============================================
// 404 响应与 HTML 转义工具
// ============================================
function htmlEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function cseRssXml(site, posts, selfPath) {
    const siteName = String(site.name || '').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const itemsXml = (posts || []).map(function (p) {
        const u = (site.url || '') + '/' + String(p.slug || '') + '/';
        const dateStr = String(p.date || '').slice(0, 10);
        const pubDate = dateStr ? new Date(dateStr + 'T00:00:00Z').toUTCString() : new Date().toUTCString();
        const cdata = function (s) { return String(s || '').split(']]>').join(']]]]><![CDATA[>'); };
        const bodyHtml = (p.content_format || 'html') === 'md' ? mdToHtml(p.content) : String(p.content || '');
        return '<item><title>' + htmlEsc(p.title) + '</title><link>' + htmlEsc(u) + '</link><guid isPermaLink="true">' + htmlEsc(u) + '</guid><pubDate>' + pubDate + '</pubDate><description>' + htmlEsc(p.excerpt || '') + '</description><content:encoded><![CDATA[' + cdata(bodyHtml) + ']]></content:encoded></item>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>' + htmlEsc(siteName) + '</title><link>' + htmlEsc(site.url) + '</link><atom:link href="' + htmlEsc((site.url || '') + selfPath) + '" rel="self" type="application/rss+xml" /><description>' + htmlEsc(site.description || siteName) + '</description><language>zh-CN</language><lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>' + itemsXml + '</channel></rss>';
}

function buildNotFound(msg) {
    const m = htmlEsc(msg || '页面不存在');
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>404 - 页面不存在</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f5f6f7;color:#333;margin:0;display:flex;min-height:90vh;align-items:center;justify-content:center;padding:20px}.box{background:#fff;border-radius:12px;box-shadow:0 2px 14px rgba(0,0,0,.06);padding:40px 46px;text-align:center;max-width:560px;width:100%}h1{font-size:34px;margin:0 0 6px;color:#222}p{color:#666;margin:10px 0;line-height:1.6}a{color:#007bff;text-decoration:none;font-weight:600}form{margin:18px 0 6px}input[type=text]{padding:10px 14px;border:1px solid #ddd;border-radius:8px 0 0 8px;font-size:15px;width:62%;max-width:280px;box-sizing:border-box}button{padding:10px 18px;border:0;background:#007bff;color:#fff;border-radius:0 8px 8px 0;font-size:15px;cursor:pointer}.links{display:flex;gap:22px;justify-content:center;margin-top:14px}</style></head><body><div class="box"><h1>404</h1><p>' + m + '</p><p style="color:#aaa;">你访问的页面不存在或已移动。</p><form action="/" method="get"><input type="text" name="s" placeholder="试试搜索站内内容…"><button type="submit">搜索</button></form><div class="links"><a href="/">← 返回首页</a></div></div></body></html>';
    return new Response(html, {
        status: 404,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
        },
    });
}

// ============================================
// 侧边栏数据（纯 TTL 语义：ttl_sidebar=0 直查 D1，不读写 KV）
// ============================================
async function getSidebar(env) {
    const cacheKey = 'sidebar:data';
    const cfg = await getCacheConfig(env);
    const useCache = cfg.ttl_sidebar > 0;
    if (useCache) {
        try {
            const cached = await edgeGet(cacheKey);
            if (cached) return cached;
        } catch (e) { /* 忽略缓存读取失败 */ }
    }
    const data = await getSidebarData(env.D1_DATABASE);
    if (data && useCache) {
        await edgeSet(cacheKey, data, cfg.ttl_sidebar);
    }
    return data;
}

// ============================================
// head 自定义注入（AdSense 验证 meta 等，site:ctx.headExtra）
// 静态单页固化在 R2 里 ⇒ 在**响应时**把 headExtra 插到 </head> 前；改配置后访问即生效，无需重建。
// 幂等：文本里已含相同片段（重建过的新单页自带）返回 null（调用方照旧直出）。
// ============================================
async function injectHeadInto(env, text) {
    try {
        if (!text) return null;
        const site = await getSiteContext(env);
        const extra = String((site && site.headExtra) || '').trim();
        if (!extra) return null;
        if (!/<\/head\s*>/i.test(text)) return null;
        if (text.indexOf(extra) !== -1) return null;
        return cfseInjectHead(text, extra);
    } catch (e) { console.error('injectHeadInto error:', e); return null; }
}

// ============================================
// 上传处理
// ============================================
async function handleUpload(request, env) {
    const providedKey = request.headers.get('X-Auth-Key');
    const validKey = env.AUTH_KEY_SECRET;
    if (!providedKey || !validKey || providedKey !== validKey) {
        console.warn('上传请求认证失败');
        return new Response('Unauthorized', { status: 401 });
    }
    try {
        const uploadData = await request.json();
        // 存储 key = 解码后的原文（URL 形态 → key）；null = 非法（含穿越段），下方校验会拒掉
        const filePath = (typeof uploadData.path === 'string') ? r2KeyFromPath(uploadData.path) : null;
        const fileContent = uploadData.content;
        const contentType = uploadData.contentType || 'text/html; charset=utf-8';
        const contentEncoding = uploadData.contentEncoding || null;

        if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid path' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        if (!fileContent) {
            return new Response(
                JSON.stringify({ success: false, error: 'Missing content' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        let bytes;
        try {
            const binary = atob(fileContent);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
        } catch (decodeError) {
            console.warn('Base64解码失败，使用原始内容', decodeError);
            bytes = new TextEncoder().encode(String(fileContent));
        }

        const httpMetadata = { contentType };
        if (contentEncoding) {
            httpMetadata.contentEncoding = contentEncoding;
        }
        // —— 图片/文件去重：PHP 端带 body.md5；R2 已有同 path 对象且 size+etag 一致则跳过（不重复 put）——
        const md5Hex = typeof uploadData.md5 === 'string' ? uploadData.md5.toLowerCase() : '';
        if (md5Hex) {
            try {
                const existing = await env.R2_BUCKET.head(filePath);
                if (existing) {
                    const etag = String(existing.httpEtag || '').replace(/^"|"$/g, '').toLowerCase();
                    if (existing.size === bytes.byteLength && etag === md5Hex) {
                        console.log(`♻️ 内容一致，跳过上传: ${filePath}`);
                        return new Response(
                            JSON.stringify({ success: true, skipped: true, path: filePath }),
                            { status: 200, headers: { 'Content-Type': 'application/json' } }
                        );
                    }
                }
            } catch (headError) {
                console.warn('head 检查失败，继续上传:', headError);
            }
        }
        // 显式写 checksums（md5），使 R2 etag 稳定等于该 md5，后续可复判跳过
        const putOptions = { httpMetadata };
        if (md5Hex) {
            putOptions.checksums = { md5: hexToBytes(md5Hex) };
        }
        await env.R2_BUCKET.put(filePath, bytes, putOptions);
        console.log(`✅ 文件上传成功: ${filePath}`);
        return new Response(
            JSON.stringify({ success: true, skipped: false, path: filePath }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('上传错误:', error);
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

// ============================================
// 删除处理
// ============================================
async function handleDelete(request, env) {
    const providedKey = request.headers.get('X-Auth-Key');
    const validKey = env.AUTH_KEY_SECRET;
    if (!providedKey || !validKey || providedKey !== validKey) {
        console.warn('删除请求认证失败');
        return new Response('Unauthorized', { status: 401 });
    }
    try {
        const data = await request.json();
        const paths = Array.isArray(data.paths) ? data.paths : (typeof data.path === 'string' && data.path.trim() !== '' ? [data.path] : []);
        if (!paths.length) {
            return new Response(
                JSON.stringify({ success: false, error: 'Invalid path' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        let deleted = 0;
        for (const p of paths) {
            if (typeof p === 'string' && p.trim() !== '') {
                const r2DelKey = r2KeyFromPath(p);
                if (r2DelKey) {
                    await env.R2_BUCKET.delete(r2DelKey);
                    deleted++;
                }
            }
        }
        console.log(`✅ 文件删除成功 ${deleted} 个: ${paths.join(', ')}`);
        return new Response(
            JSON.stringify({ success: true, deleted: deleted, paths: paths }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('删除错误:', error);
        return new Response(
            JSON.stringify({ success: false, error: error.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

// ============================================
// 二进制缓存辅助
// ============================================
function buildBinaryResponse(payload, cacheStatus = 'MISS') {
    if (!payload || typeof payload.body !== 'string') return null;
    let body;
    try {
        body = base64ToBytes(payload.body);
    } catch (e) {
        console.error('缓存内容解码失败', e);
        return null;
    }
    const headers = {
        'Content-Type': payload.contentType || 'text/html',
        'Cache-Control': `public, max-age=${CACHE_TTL.HTML}`,
        'X-Cache': cacheStatus,
    };
    if (payload.contentEncoding) {
        headers['Content-Encoding'] = payload.contentEncoding;
    }
    return new Response(body, { headers });
}

function hexToBytes(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

function bytesToBase64(arrayBuffer) {
    const arr = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
        binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function getContentType(path) {
    const ext = path.split('.').pop();
    const types = {
        'css': 'text/css',
        'js': 'application/javascript',
        'html': 'text/html; charset=utf-8',
        'htm': 'text/html; charset=utf-8',
        'xml': 'application/xml; charset=utf-8',
        'txt': 'text/plain; charset=utf-8',
        'json': 'application/json; charset=utf-8',
        'map': 'application/json; charset=utf-8',
        'webmanifest': 'application/manifest+json; charset=utf-8',
        'avif': 'image/avif',
        'pdf': 'application/pdf',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
        'ico': 'image/x-icon',
        'woff2': 'font/woff2',
        'woff': 'font/woff',
        'ttf': 'font/ttf',
        'eot': 'application/vnd.ms-fontobject',
    };
    return types[ext] || 'application/octet-stream';
}