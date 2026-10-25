/**
 * lang.js —— 多语言站点的语言解析与 URL 前缀
 *
 * ⚠️ 这个文件里只有两处常量需要改，就能整体翻转「谁占根」：
 *      DEFAULT_LANG（无前缀的主语言）
 *      PREFIX     （各语言的前缀，主语言必须是空串）
 *
 * 当前阶段（2026-10-19，迁移前）：
 *      /        中文（主语言，现有 15 篇都在这儿）
 *      /en/…    英文（新增，内容待补）
 *   ⇒ 对线上零影响：不传 lang 的调用方拿到的还是中文，行为和改造前完全一致。
 *
 * 迁移完成、英文内容补齐后（翻转）：
 *      export const DEFAULT_LANG = 'en';
 *      const PREFIX = { en: '', zh: '/zh' };
 *   ⇒ 英文占根，中文进 /zh/。此时需要给旧的 /foo/ 加 301 → /zh/foo/（见 docs/i18n-plan.md）。
 *
 * 为什么用「主语言常量」而不是直接写死 en：默认语言决定的是**数据行的语义**
 * （settings.k='site' 属于主语言，其它语言读 'site:<lang>' 补丁）。
 * 内容和语言对不上，会导致主语言站点读到空配置。
 */

/** 站点主语言（= 无前缀的那个）。翻转见文件头。 */
export const DEFAULT_LANG = 'zh';
/** 支持的语言；顺序即切换开关里的显示顺序 */
export const LANGS = ['zh', 'en'];
/** 语言前缀（主语言必须为空串） */
const PREFIX = { zh: '', en: '/en' };
/** <html lang="…"> 用的 BCP-47 标记 */
const HTML_LANG = { zh: 'zh-Hans', en: 'en' };

export function isLang(x) {
    return LANGS.indexOf(String(x || '')) !== -1;
}

/** 归一化：非法值一律回落到主语言 */
export function normLang(x) {
    const v = String(x || '').toLowerCase();
    return isLang(v) ? v : DEFAULT_LANG;
}

export function htmlLang(lang) {
    return HTML_LANG[normLang(lang)] || 'en';
}

/** 语言前缀字符串：主语言 → ''，其它 → '/en'（无尾斜杠，可直接拼） */
export function langPrefix(lang) {
    return PREFIX[normLang(lang)] || '';
}

/**
 * 从请求路径里解析语言。
 *   '/en'        → { lang:'en', path:'/' }
 *   '/en/'       → { lang:'en', path:'/' }
 *   '/en/foo/'   → { lang:'en', path:'/foo/' }
 *   '/enfoo/'    → { lang:'zh', path:'/enfoo/' }   ← 必须按「段」判断，不能 startsWith
 *   '/'          → { lang:'zh', path:'/' }
 * @returns {{lang:string, path:string, prefixed:boolean}}
 */
export function parseLang(pathname) {
    const p = String(pathname == null ? '/' : pathname) || '/';
    for (const lang of LANGS) {
        const pfx = PREFIX[lang];
        if (!pfx) continue;
        if (p === pfx) return { lang: lang, path: '/', prefixed: true };
        if (p.indexOf(pfx + '/') === 0) {
            return { lang: lang, path: p.slice(pfx.length) || '/', prefixed: true };
        }
    }
    return { lang: DEFAULT_LANG, path: p, prefixed: false };
}

/**
 * 给内部路径加上语言前缀（构造对外 URL 用）。
 *   withLang('en', '/foo/') → '/en/foo/'
 *   withLang('zh', '/foo/') → '/foo/'
 */
export function withLang(lang, path) {
    const pfx = langPrefix(lang);
    const p = String(path == null ? '/' : path);
    if (!pfx) return p;
    return pfx + (p === '/' ? '/' : (p.charAt(0) === '/' ? p : '/' + p));
}

/**
 * 把某个语言下的路径翻译成另一种语言下的同一路径（切换开关用）。
 *   switchLang('/foo/', 'en') → '/en/foo/'
 *   switchLang('/en/foo/', 'zh') → '/foo/'
 * 注意：这**只换前缀**，不负责找「对译文章」——配对由 posts.translation_key 决定，
 * 找不到对译时调用方应回落到该语言的首页。
 */
export function switchLang(pathname, targetLang) {
    const r = parseLang(pathname);
    return withLang(targetLang, r.path);
}

/**
 * 由站点 base URL 派生某语言的站点 URL（**派生，不存储**）。
 *
 * 为什么不把带前缀的 url 存进 settings：
 *   site.url 被 canonical / sitemap / RSS / og:url 共用，是「站点身份」；
 *   把语言掺进去等于让站点身份随语言变化，加第三种语言就要再存一份。
 *   而它本来就是 base + prefix 的纯函数 ⇒ 存 base，用时派生。
 *
 * @param {string} baseUrl 站点根（如 https://yuebin.uk，不带尾斜杠）
 * @param {string} lang    目标语言
 */
export function siteUrlFor(baseUrl, lang) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    return base + langPrefix(lang);
}

/**
 * 取站点**当前对外语言**（站点级开关）。
 *
 * 阶段 A（无 URL 前缀）靠它决定「整站现在用哪种语言」：
 *   settings.k='site' 里的 i18n.default 就是当前语言。
 * 阶段 B（有 URL 前缀）则由请求路径解析，本函数退居为「未指定语言时的兜底」。
 *
 * 配置缺失或非法 ⇒ 回落到 DEFAULT_LANG，不会因为配错就变成空语言。
 */
export function currentLangOf(site) {
    const i18n = site && site.i18n;
    const d = i18n && i18n.default;
    return isLang(d) ? String(d) : DEFAULT_LANG;
}

/**
 * 某语言是否在站点启用的语言列表里。
 * 未配置 i18n ⇒ 视为只启用主语言（单语站）。
 */
export function isEnabledLang(site, lang) {
    const i18n = site && site.i18n;
    const list = i18n && Array.isArray(i18n.enabled) ? i18n.enabled : null;
    if (!list || !list.length) return normLang(lang) === DEFAULT_LANG;
    return list.map(normLang).indexOf(normLang(lang)) !== -1;
}
