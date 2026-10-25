/**
 * site.js —— 站点上下文 + 缓存策略，供 routes 渲染与 admin 单页生成共用
 *
 * 数据来源：D1 settings 表两行（k='site' 站点信息 / k='cache' 缓存策略），
 * 一次查询读回后打包成同一个 KV 值（site:ctx），动态页每请求仅 1 次 KV 读。
 * 任一侧变更（WP 设置同步 / Worker 后台保存）都会清 site:ctx，下个请求即生效。
 *
 * 缓存策略为"纯 TTL"语义（由 cacheconfig/管理后台消费）：
 *   ttl_list=0    → 列表页直查 D1 不缓存（>0 才走 KV）
 *   ttl_sidebar=0 → 侧边栏直查 D1 不缓存
 *   ttl_site=0    → 站点上下文本身也不缓存（每请求直查 D1）
 *   ttl_feed=0    → RSS feed 不缓存（>0 走 KV，默认 4 小时；发布不主动清）
 *   feed_count    → RSS 输出条数（默认 20，1-100）
 *   purge_on_publish → 发布文章时是否清列表/侧边栏 KV（默认 false，省 KV 写）
 */
import { normLang, DEFAULT_LANG, siteUrlFor } from './lang.js';

const DEFAULT_CACHE = {
    ttl_list: 0,        // 列表页：0=直查 D1（默认，最省 KV 写）
    ttl_sidebar: 0,     // 侧边栏：0=直查 D1
    ttl_site: 604800,   // 站点上下文 KV TTL：默认 7 天（读极频繁、写极少，值得缓存）
    ttl_feed: 14400,    // RSS feed KV TTL：默认 4 小时（低频发现通道；发布文章不主动清）
    feed_count: 20,     // RSS 输出条数（1-100）
    per_page: 10,       // 列表页每页文章数（1-100；首页/分类/标签/归档/搜索共用）
    purge_on_publish: false,
    task_batch: 20,       // 批量任务：每次请求处理条数（重建单页 / permalink 迁移共用）
    task_concurrency: 4,  // 批量任务：一批内同时处理几条
};

/** 归一化缓存配置（纯 TTL；兼容旧版 {mode:'d1'|'kv'} 数据） */
export function normalizeCache(raw) {
    const out = Object.assign({}, DEFAULT_CACHE);
    if (raw && typeof raw === 'object') {
        if (raw.mode === 'd1') { out.ttl_list = 0; out.ttl_sidebar = 0; }
        else if (raw.mode === 'kv') { out.ttl_list = 3600; out.ttl_sidebar = 86400; }
        ['ttl_list', 'ttl_sidebar', 'ttl_site', 'ttl_feed'].forEach(function (k) {
            if (raw[k] !== undefined) {
                const n = parseInt(raw[k], 10);
                if (!isNaN(n) && n >= 0) out[k] = n;
            }
        });
        if (raw.feed_count !== undefined) {
            const n = parseInt(raw.feed_count, 10);
            if (!isNaN(n) && n >= 1) out.feed_count = Math.min(n, 100);
        }
        if (raw.per_page !== undefined) {
            const n = parseInt(raw.per_page, 10);
            if (!isNaN(n) && n >= 1) out.per_page = Math.min(n, 100);
        }
        if (raw.purge_on_publish !== undefined) out.purge_on_publish = !!raw.purge_on_publish;
        if (raw.task_batch !== undefined) {
            const n = parseInt(raw.task_batch, 10);
            if (!isNaN(n) && n >= 1) out.task_batch = Math.min(n, 100);
        }
        if (raw.task_concurrency !== undefined) {
            const n = parseInt(raw.task_concurrency, 10);
            if (!isNaN(n) && n >= 1) out.task_concurrency = Math.min(n, 16);
        }
    }
    return out;
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 请求级 / 短 TTL 内存缓存（D9：KV 读只在 miss 后，且一次渲染只读 1 次）──────────────────
// site:ctx 是**全局站点上下文**（站点信息 + 缓存策略 + 风格指针一次打包），
// 渲染流里 getSiteContext / getCacheConfig / tplstore 的 4 个 getter 都会调它。
// 之前每次调用都独立 KV.get('site:ctx') → 一个请求重复读 4~6 次同一键（纯浪费读配额）。
// 现在：同一个 isolate 内、TTL 内所有调用只发 1 次 KV.get，其余命中内存。
// 语义不变：site:ctx 本就有 KV 最终一致性 ~60s，加几秒内存延迟无感；
// 配置/风格变更路径会调 clearSiteCtxMemo()（见 cacheconfig.resetCacheConfig）保证即时生效。
const SITE_MEMO_TTL = 30000; // 30s：site:ctx 是「站点设置」快照（唯一仍用 KV 的项）。
                            // 拉长内存命中窗口 ⇒ KV 读量降一个数量级；配置变更路径都会调
                            // clearSiteCtxMemo()（本 isolate 立即生效），跨 isolate 最迟 30s（KV 本身传播也要 ~60s）。
// 双语（2026-10-19）：按语言分开缓存，en 用 site:ctx，zh 用 site:ctx:zh
const siteCtxMemo = new Map();   // lang -> { ctx, exp }
export function clearSiteCtxMemo() {
    siteCtxMemo.clear();
}

/** JSON 安全解析：坏数据/空值一律回 null，不抛 */
function safeParse(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
}

/**
 * 把 settings 的一行站点配置归一化成对象。
 * **只收录「该行里出现过的字段」** —— 这样 `site:zh` 可以只写与英文不同的部分（补丁语义），
 * 没写的字段交给 base 继承，不会把英文的值覆盖成空。
 */
function siteFromRow(parsed) {
    const o = {};
    if (!parsed || typeof parsed !== 'object') return o;
    if (parsed.name !== undefined) o.name = String(parsed.name || '');
    if (parsed.url !== undefined) o.url = String(parsed.url || '').replace(/\/+$/, '');
    if (parsed.description !== undefined) o.description = String(parsed.description);
    if (parsed.storagePattern) o.storagePattern = String(parsed.storagePattern);
    if (parsed.timezoneOffset !== undefined) o.timezoneOffset = parseInt(parsed.timezoneOffset, 10) || 0;
    if (parsed.comments && typeof parsed.comments === 'object') {
        o.comments = {
            mode:   String(parsed.comments.mode || 'off'),
            embed:  String(parsed.comments.embed || ''),
            accept: String(parsed.comments.accept || 'off'),
        };
    }
    if (parsed.defaultAuthor && typeof parsed.defaultAuthor === 'object') {
        o.defaultAuthor = { name: String(parsed.defaultAuthor.name || ''), slug: String(parsed.defaultAuthor.slug || '') };
    }
    if (parsed.logo !== undefined) o.logo = String(parsed.logo || '');
    if (parsed.banner !== undefined) o.banner = String(parsed.banner || '');
    if (Array.isArray(parsed.social)) {
        o.social = parsed.social.map(function (s) {
            return { service: String((s && s.service) || ''), url: String((s && s.url) || '') };
        }).filter(function (s) { return s.url !== ''; });
    }
    if (Array.isArray(parsed.menu)) o.menu = parsed.menu;
    if (parsed.layout && typeof parsed.layout === 'object') {
        o.layout = { singleSidebar: String(parsed.layout.singleSidebar || 'show') };
    }
    if (parsed.headExtra !== undefined) o.headExtra = String(parsed.headExtra || '');
    if (Array.isArray(parsed.docRoutes)) o.docRoutes = parsed.docRoutes;
    // 多语言配置（站点级开关，见 docs/i18n-plan.md §3.3）
    //   default : 当前对外语言（无 URL 前缀时，整站按它出内容与模板）
    //   enabled : 启用的语言；长度 1 = 单语站，切换开关自动隐藏
    //   labels  : 切换开关显示名
    if (parsed.i18n && typeof parsed.i18n === 'object') {
        const raw = parsed.i18n;
        const enabled = Array.isArray(raw.enabled)
            ? raw.enabled.map(function (x) { return normLang(x); }).filter(function (v, i, a) { return a.indexOf(v) === i; })
            : [];
        const labels = {};
        if (raw.labels && typeof raw.labels === 'object') {
            for (const k of Object.keys(raw.labels)) labels[normLang(k)] = String(raw.labels[k] || '');
        }
        o.i18n = {
            default: normLang(raw.default),
            enabled: enabled.length ? enabled : [normLang(raw.default)],
            labels: labels,
            detect: String(raw.detect || 'path'),
        };
    }
    return o;
}

export async function getSiteContext(env, lang) {
    const L = normLang(lang);
    const now = Date.now();
    const memo = siteCtxMemo.get(L);
    if (memo && memo.exp > now) return memo.ctx;

    const cacheKey = L === DEFAULT_LANG ? 'site:ctx' : 'site:ctx:' + L;
    try {
        const cached = await env.KV_CACHE.get(cacheKey).then(function (v) {
            if (!v) return null;
            try { return JSON.parse(v); } catch (e) { return null; }
        });
        if (cached) {
            if (!cached.cache) cached.cache = normalizeCache(null); // 旧缓存值防御
            siteCtxMemo.set(L, { ctx: cached, exp: now + SITE_MEMO_TTL });
            return cached;
        }
    } catch (e) { /* 忽略缓存读取失败 */ }
    let ctx = { name: '', url: '', logo: '', footerHtml: '', storagePattern: '{slug}/index.html' };
    let cacheRaw = null;
    let styleRaw = null;
    try {
        // 默认语言只读 'site'；其他语言额外读 'site:<lang>' 作为补丁（只覆盖出现过的字段）
        const keys = L === DEFAULT_LANG
            ? "'site','cache','style'"
            : "'site','site:" + L + "','cache','style'";
        const rows = await env.D1_DATABASE.prepare("SELECT k, v FROM settings WHERE k IN (" + keys + ")").all();
        const byKey = {};
        for (const r of (rows.results || [])) byKey[r.k] = r.v;
        const base = siteFromRow(safeParse(byKey['site']));
        Object.assign(ctx, base);
        if (L !== DEFAULT_LANG) {
            const patch = siteFromRow(safeParse(byKey['site:' + L]));
            Object.assign(ctx, patch);
            // 兜底：补丁行没给 url 时，由 base.url **派生**该语言的站点根。
            // （统一走 siteUrlFor，避免这里和模板层各拼一次前缀，迟早分叉）
            // 注意：补丁行不该存 url —— 存了会和 base 打架，见 docs/i18n-plan.md §3.3
            if (!patch.url && base.url) ctx.url = siteUrlFor(base.url, L);
        }
        cacheRaw = safeParse(byKey['cache']);
        styleRaw = safeParse(byKey['style']);
    } catch (e) { console.error('getSiteContext error:', e); }
    ctx.lang = L;
    ctx.cache = normalizeCache(cacheRaw);
    // 风格**生效指针**（属「站点设置」：D1 settings k='style'.active）
    // 见 docs/style-refactor.md（废除 tpl:index / tpl:sindex / tpl:active）
    ctx.activeStyleId = (styleRaw && typeof styleRaw.active === 'string') ? styleRaw.active : '';
    // 注：风格**清单**（内置 assets index.json + 用户 k='style'.user 合并）**不进 site:ctx** ——
    //     它由 assets / D1 派生，改用下面的 getStyleIndex()（独立 isolate 短缓存 60s）。
    //     好处：① site:ctx 是纯「站点设置」；② 部署新增/删除内置风格后**无需清 KV**（≤60s 自动跟上）。
    if (ctx.url) {
        ctx.footerHtml = '<div style="text-align:center;color:#666;font-size:12px;padding:20px 0;border-top:1px solid #eee;margin-top:30px;"><a href="' + esc(ctx.url) + '/">' + esc(ctx.name) + '</a> · CF Static Export Pro</div>';
    }
    // ttl_site=0 → 不缓存（每请求直查 D1）；>0 按配置 TTL 写 KV
    if (ctx.cache.ttl_site > 0) {
        try { await env.KV_CACHE.put(cacheKey, JSON.stringify(ctx), { expirationTtl: ctx.cache.ttl_site }); } catch (e) {}
    }
    // KV miss 重建出的 ctx 同样进内存缓存（同请求后续调用不再查 KV/D1）
    siteCtxMemo.set(L, { ctx: ctx, exp: now + SITE_MEMO_TTL });
    return ctx;
}

// ── 风格清单（内置 = assets index.json；用户 = D1 k='style'.user）────────────────
// 与 site:ctx 解耦：60s isolate 短缓存（部署换风格包后无需清 KV 即自动跟上）。
const STYLE_IDX_TTL = 60000;
let styleIdxMemo = null;   // { list, exp }
export function clearStyleIndexMemo() { styleIdxMemo = null; }

export async function getStyleIndex(env) {
    const now = Date.now();
    if (styleIdxMemo && styleIdxMemo.exp > now) return styleIdxMemo.list;
    let userStyles = [];
    try {
        const row = await env.D1_DATABASE.prepare("SELECT v FROM settings WHERE k = 'style'").first();
        if (row && row.v) {
            const o = JSON.parse(row.v);
            if (o && Array.isArray(o.user)) {
                userStyles = o.user.map(function (x) {
                    return { id: String((x && x.id) || ''), name: String((x && x.name) || ''), source: 'user' };
                }).filter(function (x) { return x.id; });
            }
        }
    } catch (e) { /* 无 style 行（新库） */ }
    let builtinStyles = [];
    try {
        if (env.ASSETS) {
            const bres = await env.ASSETS.fetch(new Request('https://assets.local/wp-content/themes/index.json'));
            if (bres && bres.ok) {
                const arr = await bres.json();
                if (Array.isArray(arr)) builtinStyles = arr.map(function (x) {
                    return { id: String((x && x.id) || ''), name: String((x && x.name) || ''), updated: String((x && x.updated) || ''), source: 'builtin' };
                }).filter(function (x) { return x.id; });
            }
        }
    } catch (e) { /* 无内置清单（新库 / 未部署） */ }
    const uids = new Set(userStyles.map(function (x) { return x.id; }));
    const list = builtinStyles.filter(function (x) { return !uids.has(x.id); }).concat(userStyles);
    styleIdxMemo = { list: list, exp: now + STYLE_IDX_TTL };
    return list;
}

/** 站点级 HTML 转义（供 site 上下文内拼 footer 等） */
export function siteEsc(s) {
    return esc(s);
}
