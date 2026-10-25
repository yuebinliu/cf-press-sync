/**
 * tplstore.js —— 当前生效风格（按 id 直读 wp-content/themes/<id>/tpl.json）
 *
 * 设计依据：docs/style-refactor.md（废除 tpl:* KV）
 *   · 生效风格 = site:ctx.activeStyleId（来自 D1 settings k='style'.active）
 *   · 内容    = wp-content/themes/<id>/tpl.json（assets 优先 → R2 兜底；内置与用户同形）
 *   · 4 个 getter **签名与返回结构保持不变** ⇒ 渲染路径（routes/admin/comments/preview）零改动
 *        getActiveTpl → { single:{id,name,content}, ..., sidebar:{...}, comments:{...} } | null
 *   · isolate 级短缓存（TTL ~15s，键=id）⇒ 一次请求内多次 getter 只读 1 次
 *
 * tpl.json 结构（与内置风格包一致）：
 *   { name, tpl: { single, item, pageHome, pageCategory, pageTag, pageArchive }, sidebar, comments }
 * 也兼容「直接扁平」形态（顶层就是 6 类模板）。
 */

import { getSiteContext } from './site';

const TPL_TTL = 15000;
/**
 * 「默认风格」（D1 k='style'.active 为空 / 'default' / '__default__'）时使用的内置风格包 id。
 * 背景：templates.js 里的 140KB 内嵌兜底模板已删除 ⇒ 默认风格改为读内置风格包的 tpl.json
 *（assets 免费直出，无需部署即可用）。读不到时调用方回退 ./fallback-tpl 的极小骨架。
 */
const DEFAULT_STYLE_ID = 'minimal-reading';
const tplCache = new Map(); // '<id>@<lang>' -> { tpl, exp }
const TPL_KINDS = ['single', 'item', 'pageHome', 'pageCategory', 'pageTag', 'pageArchive'];

/** 读单个 tpl 文件（assets → R2）；不存在/解析失败返回 null */
async function readTplFile(env, key) {
    try {
        if (env.ASSETS) {
            const res = await env.ASSETS.fetch(new Request('https://assets.local/' + key));
            if (res && res.ok) {
                try { return await res.json(); } catch (e) { /* 落 R2 */ }
            }
        }
    } catch (e) { /* 落 R2 */ }
    if (env.R2_BUCKET) {
        try {
            const obj = await env.R2_BUCKET.get(key);
            if (obj) return JSON.parse(await obj.text());
        } catch (e) { /* 视为缺失 */ }
    }
    return null;
}

/**
 * 读某风格 id 的模板（assets → R2）；失败返回 null。
 *
 * 语言回退顺序（关键设计）：
 *   ① tpl.<lang>.json   —— 该风格的**语言覆盖层**（可只写部分类型，如只有 pageHome）
 *   ② tpl.json          —— 风格基础版（通常是主语言）
 *   ③ 合并：覆盖层里存在的类型用覆盖层，其余用基础版
 *
 * 这样「一套风格包自带多语言」是自然形态：新增语言 = 往目录里加一个 tpl.en.json，
 * 不必复制整个风格包，也不必在 D1 里存第二个 styleId。
 * lang 为空 ⇒ 只读 tpl.json，行为和改造前完全一致。
 */
async function readStyleTpl(env, id, lang) {
    const now = Date.now();
    const cacheKey = id + '@' + (lang || '');
    const hit = tplCache.get(cacheKey);
    if (hit && hit.exp > now) return hit.tpl;

    const baseKey = 'wp-content/themes/' + id + '/tpl.json';
    let tpl = null;

    if (lang) {
        const langTpl = await readTplFile(env, 'wp-content/themes/' + id + '/tpl.' + lang + '.json');
        if (langTpl && typeof langTpl === 'object') {
            const base = await readTplFile(env, baseKey);
            tpl = mergeTpl(base, langTpl);
        }
    }
    if (!tpl) tpl = await readTplFile(env, baseKey);

    tplCache.set(cacheKey, { tpl: tpl, exp: now + TPL_TTL });
    return tpl;
}

/**
 * 基础模板 + 语言覆盖层。覆盖层可只写部分类型（缺的继承基础版）。
 * 也支持覆盖层用 tplI18n: { en: {...} } 的内嵌形态（一个文件装多语言）。
 */
function mergeTpl(base, overlay) {
    if (!base || typeof base !== 'object') return overlay;
    if (!overlay || typeof overlay !== 'object') return base;
    const out = Object.assign({}, base);
    const baseTpl = (base.tpl && typeof base.tpl === 'object') ? base.tpl : {};
    const ovTpl = (overlay.tpl && typeof overlay.tpl === 'object') ? overlay.tpl : overlay;
    out.tpl = Object.assign({}, baseTpl);
    for (const k of Object.keys(ovTpl)) {
        if (typeof ovTpl[k] === 'string' && ovTpl[k]) out.tpl[k] = ovTpl[k];
    }
    for (const s of ['sidebar', 'comments', 'layout']) {
        if (overlay[s] && typeof overlay[s] === 'object') out[s] = overlay[s];
        else if (base[s] && typeof base[s] === 'object') out[s] = base[s];
    }
    if (typeof overlay.name === 'string' && overlay.name) out.name = overlay.name;
    return out;
}

/**
 * 取当前生效风格；未配置（activeStyleId 空）→ 回退内置风格包 DEFAULT_STYLE_ID；仍读不到 → null
 *（调用方回退 ./fallback-tpl 的极小骨架）。
 * 返回结构与旧 tpl:active 一致：{ single:{id,name,content}, item:{...}, ..., sidebar, comments }
 */
export async function getActiveTpl(env, lang) {
    try {
        const ctx = await getSiteContext(env, lang);
        let id = String((ctx && ctx.activeStyleId) || '').trim();
        // 默认风格 → 回退到内置风格包（不再是 templates.js 的内嵌兜底模板）
        if (!id || id === 'default' || id === '__default__') id = DEFAULT_STYLE_ID;
        const j = await readStyleTpl(env, id, lang);
        if (!j || typeof j !== 'object') return null;
        const t = (j.tpl && typeof j.tpl === 'object') ? j.tpl : j;
        const name = (typeof j.name === 'string' && j.name) ? j.name : id;
        const out = {};
        for (const k of TPL_KINDS) {
            if (typeof t[k] === 'string' && t[k]) out[k] = { id: id, name: name, content: t[k] };
        }
        const sb = (j.sidebar && typeof j.sidebar === 'object') ? j.sidebar : (t.sidebar && typeof t.sidebar === 'object' ? t.sidebar : null);
        if (sb) out.sidebar = sb;
        const cm = (j.comments && typeof j.comments === 'object') ? j.comments : (t.comments && typeof t.comments === 'object' ? t.comments : null);
        if (cm) out.comments = cm;
        // 双列布局选择器（由 tools/skin-layout-probe.mjs 推导写入）：渲染单页时据此生成单列 CSS
        const ly = (j.layout && typeof j.layout === 'object') ? j.layout : null;
        if (ly && ly.sidebar && ly.main) out.layout = { sidebar: String(ly.sidebar), main: String(ly.main) };
        return Object.keys(out).length ? out : null;
    } catch (e) { return null; }
}

/** 取当前生效风格某类模板正文；未配置/默认 → 返回空串（调用方回退内置模板） */
export async function getActiveTplContent(env, type, lang) {
    const o = await getActiveTpl(env, lang);
    const e = o && o[type];
    if (!e || !e.content) return '';
    return String(e.content);
}

/** 取当前生效风格的侧边栏骨架（sidebar 段）；无 → {}（调用方回退硬编码 <li>） */
export async function getActiveSidebarTpl(env, lang) {
    const o = await getActiveTpl(env, lang);
    const sb = o && o.sidebar;
    return (sb && typeof sb === 'object') ? sb : {};
}

/** 取当前生效风格的评论骨架（comments 段 = {list, entry, children}）；无 → {} */
export async function getActiveCommentsTpl(env, lang) {
    const o = await getActiveTpl(env, lang);
    const c = o && o.comments;
    return (c && typeof c === 'object') ? c : {};
}

/** 取当前生效风格的双列布局选择器（{sidebar, main}，由 skin-layout-probe 推导）；无 → null */
export async function getActiveLayout(env, lang) {
    const o = await getActiveTpl(env, lang);
    const lg = o && o.layout;
    return (lg && lg.sidebar && lg.main) ? lg : null;
}
