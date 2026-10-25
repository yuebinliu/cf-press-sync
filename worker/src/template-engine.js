/**
 * template-engine.js —— 模板渲染引擎（**手写常驻，不再由 PHP 生成**）
 *
 * 历史：本文件原为 worker/src/templates.js，是「templates.base.js 壳 + views/template-editor.php
 * 注入」的**生成产物**，里面内嵌了 140KB 的兜底模板（4 个 pageTpl + CFSE_SINGLE_TPL）。
 * 现在模板内容一律来自风格包 tpl.json（D1 settings k='style' 的 active 指针 + R2/assets 的 tpl.json），
 * 内嵌那份只剩「连风格包都读不到」时的最后兜底 ⇒ 已收敛为 ./fallback-tpl.js 的极小骨架。
 *
 * 职责：拿到「模板字符串 + 数据」渲染 HTML（纯引擎，不读 D1/KV/R2）。
 *   · 页面壳：renderHomepage / renderCategoryPage / renderTagPage / renderArchivePage
 *   · 单页壳：CFSE_SINGLE_TPL（常量兜底；实际模板由 admin.js 传入 tplOverride）
 *   · 条目：cfseRenderItem / cfseRenderItems
 *   · 侧边栏：cfseSidebarCategoryItems / cfseSidebarArchiveItems / cfseSidebarTagItems
 *   · 站点级：cfseSiteLogoHtml / cfseSiteBannerHtml / cfseSocialLinks / cfseMenuHtml
 *   · 工具：escapeHtml / cfseEscUrl / cfseReplace / cfseIfBlock / cfseStripLeftovers / cfseParseTaxo / cfsePostUrl / cfseFirstImage
 *
 * 契约：占位符集合必须与 docs/skin-contract.json 一致（改渲染器后跑 tools/contract-check.mjs）。
 */

import { CFSE_FALLBACK_PAGE, CFSE_FALLBACK_ITEM, CFSE_FALLBACK_SINGLE } from './fallback-tpl';
/**
 * 模板基础源文件 templates.base.js
 * 路径：worker/templates.base.js
 * ⚠️ 【源文件，不直接部署】
 * 插件PHP读取此文件，在下方“注入点标记”处注入以下内容，生成 worker/src/templates.js：
 *   1) SITE 常量（站点名/站点URL，来自 WP blogname / cf_site_url）
 *   2) 渲染公共 helper（buildPostUrl / parseTaxonomy / renderItems / applyIfBlock …）
 *   3) 4 个渲染函数 renderHomepage/renderCategoryPage/renderTagPage/renderArchivePage
 * 部署Worker请使用生成产物 templates.js
 *
 * ⚠️ 本文件只作为“纯壳”：
 *   - 仅保留公共工具函数（escapeHtml）与注入标记；
 *   - 不要在此处再定义 SITE/helper/renderXxx，否则 PHP 注入的同名声明会造成重复声明，templates.js 语法损坏、部署失败。
 */

// ============================================
// HTML转义公共工具【全局，所有渲染函数依赖，不可删除】
// ============================================
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ==========【PHP自动注入标记，不要删除、不要修改这行！】==========

// 解析 WP 写库的 categories/tags 列（结构化 JSON [{name,slug}]；兼容旧版纯 names 数组）
function cfseParseTaxo(raw) {
    if (!raw) return [];
    let arr = null;
    try { arr = JSON.parse(raw); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr.map(x => {
        if (typeof x === 'string') return { name: x, slug: x };
        if (x && typeof x === 'object') return { name: String(x.name || ''), slug: String(x.slug || x.name || '') };
        return null;
    }).filter(x => x !== null && x.name !== '');
}

// 文章绝对 URL（站点上下文 site.url + site.storagePattern）
function cfsePostUrl(post, site) {
    let p = (site && site.storagePattern) || '';
    const d = String(post.date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    // {category}：取该文章第一个分类的 slug（posts.categories 是 JSON [{name,slug}]）
    let catSlug = '';
    try {
        const cats = JSON.parse(post.categories || '[]');
        if (Array.isArray(cats) && cats.length) {
            const c0 = cats[0];
            catSlug = String((c0 && (c0.slug || c0.name)) || '');
        }
    } catch (e) { /* 忽略解析失败 */ }
    const vals = { year: d ? d[1] : '', month: d ? d[2] : '', day: d ? d[3] : '', hour: '', minute: '', second: '', id: String(post.wp_id || ''), slug: String(post.slug || ''), category: catSlug, author: '' };
    p = p.replace(/\{(year|month|day|hour|minute|second|id|slug|category|author)\}/g, (m, k) => vals[k] || '');
    p = p.replace(/\/?index\.html$/, '');
    return ((site && site.url) || '') + '/' + p.split('/').filter(Boolean).join('/') + '/';
}

// 条件块处理：{{#IF_FLAG}}...{{/IF_FLAG}}，cond 为 false 时整块删除
function cfseIfBlock(tpl, flag, cond) {
    const open = '{{#IF_' + flag + '}}';
    const close = '{{/IF_' + flag + '}}';
    while (tpl.includes(open)) {
        const s = tpl.indexOf(open);
        const e = tpl.indexOf(close, s);
        if (e < 0) break;
        const inner = tpl.slice(s + open.length, e);
        const rep = cond ? inner : '';
        tpl = tpl.slice(0, s) + rep + tpl.slice(e + close.length);
    }
    return tpl;
}

/** 属性值转义（href/src 用；比 escapeHtml 多覆盖单引号） */
function cfseEscUrl(u) {
    return String(u == null ? '' : u)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * 站点横幅横条图（{{SITE_BANNER}}）。
 * 与 {{SITE_LOGO}} 一样回吐结构（模板只放占位符即可）；空 ⇒ 返回空串（配合 {{#IF_BANNER}}）。
 */
function cfseSiteBannerHtml(site) {
    const b = String((site && site.banner) || '');
    if (!b) return '';
    return '<img src="' + cfseEscUrl(b) + '" alt="' + escapeHtml((site && site.name) || '') + '" class="site-banner-img" />';
}
/**
 * 站点 logo 块 HTML（{{SITE_LOGO}}）
 * 提取器替换掉的是整个 wp:site-logo 块（含外层 div），所以这里回吐完整结构，不能只给裸 URL。
 * 空 logo 返回空串（配合模板里的 {{#IF_LOGO}}）。
 */
function cfseSiteLogoHtml(site) {
    const logo = String((site && site.logo) || '');
    if (!logo) return '';
    const href = ((site && site.url) || '') + '/';
    const name = escapeHtml((site && site.name) || '');
    return '<div class="wp-block-site-logo"><a href="' + cfseEscUrl(href) + '" class="custom-logo-link" rel="home">'
        + '<img src="' + cfseEscUrl(logo) + '" class="custom-logo" alt="' + name + '" /></a></div>';
}

/** 社交链接 <li> 列表（{{SOCIAL_LINKS}}；数据来自 site:ctx.social —— 后台可配。外层 <ul> 留在模板里） */
function cfseSocialLinks(site) {
    const list = (site && Array.isArray(site.social)) ? site.social : [];
    if (!list.length) return '';
    return list.map(function (s) {
        const url = String((s && s.url) || '');
        if (!url) return '';
        const svc = String((s && s.service) || '');
        const label = svc ? (svc.charAt(0).toUpperCase() + svc.slice(1)) : url;
        return '<li class="wp-block-social-link"><a href="' + cfseEscUrl(url) + '" class="wp-block-social-link-anchor" rel="me noopener">' + escapeHtml(label) + '</a></li>';
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
export function cfseMenuHtml(site) {
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
                + '<a href="' + cfseEscUrl(url) + '">' + escapeHtml(String((it && it.title) || '')) + '</a>';
            if (kids.length) out += '<ul class="sub-menu">' + render(kids) + '</ul>';
            out += '</li>';
        }
        return out;
    };
    return '<ul class="menu">' + render(menu) + '</ul>';
}

/** 残留占位符兜底：未替换的 {{XXX}} 记日志 + 清空（绝不原样输出到线上） */
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

// 给所有「缺少 referrerpolicy」的 <img> 补 referrerpolicy="no-referrer"。
// 背景：CSDN 等图床会按 Referer 返回 403；正文图已由抓取端（csdn-publisher）的 Turndown 规则加过，
// 但主题的缩略图/头图（{{POST_THUMBNAIL}}）与列表卡缩略图在此统一兜底，覆盖所有主题，且对同源图无副作用。
export function cfseNoReferrerImgs(html) {
    return String(html || '').replace(/<img(?![^>]*\breferrerpolicy=)/gi, '<img referrerpolicy="no-referrer"');
}

// 文本替换（split/join 避免正则特殊字符）
function cfseReplace(tpl, token, value) {
    return tpl.split(token).join(String(value == null ? '' : value));
}

/**
 * head 自定义 HTML 注入：把 headExtra 插到 </head> 之前（大小写不敏感、只注一次）。
 * 无 headExtra 或找不到 </head> 时原样返回（插件式增量，绝不破坏页面）。
 * 渲染出口统一在收尾调用 ⇒ 后台保存（清 site:ctx）后全站即时生效。
 */
export function cfseInjectHead(html, headExtra) {
    const extra = String(headExtra || '').trim();
    if (!extra) return html;
    const s = String(html);
    const m = s.match(/<\/head\s*>/i);
    if (!m) return s;
    return s.slice(0, m.index) + extra + '\n' + s.slice(m.index);
}

// 渲染单篇文章条目
function cfseRenderItem(itemTpl, post, site) {
    const cats = cfseParseTaxo(post.categories);
    const tags = cfseParseTaxo(post.tags);
    const baseUrl = (site && site.url) || '';
    const catBase = baseUrl + '/category/';
    const tagBase = baseUrl + '/tag/';
    // slug 为 WP 库内已编码形态（含 %xx 小写编码），直接拼接，勿再 encodeURIComponent / rawurlencode
    const catLinks = cats.map(c => '<a href="' + catBase + (c.slug || '') + '/">' + escapeHtml(c.name) + '</a>').join(', ');
    const tagLinks = tags.map(t => '<a href="' + tagBase + (t.slug || '') + '/">' + escapeHtml(t.name) + '</a>').join(', ');

    let h = itemTpl;
    h = cfseIfBlock(h, 'CATEGORIES', cats.length > 0);
    h = cfseIfBlock(h, 'TAGS', tags.length > 0);
    h = cfseReplace(h, '{{POST_TITLE}}', escapeHtml(post.title));
    h = cfseReplace(h, '{{POST_URL}}', cfseEscUrl(cfsePostUrl(post, site)));
    h = cfseReplace(h, '{{POST_DATE}}', escapeHtml(String(post.date || '').slice(0, 10)));
    h = cfseReplace(h, '{{POST_EXCERPT}}', escapeHtml(post.excerpt || ''));
    h = cfseReplace(h, '{{POST_CATEGORIES}}', catLinks);
    h = cfseReplace(h, '{{POST_TAGS}}', tagLinks);
    // 作者（per-post 优先，回退站点默认作者） / 缩略图（特色图或正文首图）；均带条件块防空
    const defAuthor = (site && site.defaultAuthor) || {};
    const authorName = post.author_name || defAuthor.name || '';
    const authorSlug = post.author_slug || defAuthor.slug || '';
    const thumb = post.thumbnail || cfseFirstImage(post.content);
    h = cfseIfBlock(h, 'AUTHOR', !!authorName);
    h = cfseIfBlock(h, 'THUMBNAIL', !!thumb);
    h = cfseReplace(h, '{{POST_AUTHOR}}', escapeHtml(authorName));
    h = cfseReplace(h, '{{POST_AUTHOR_URL}}', cfseEscUrl(authorSlug ? (baseUrl + '/author/' + authorSlug + '/') : ''));
    h = cfseReplace(h, '{{POST_THUMBNAIL}}', cfseEscUrl(thumb));
    // 站点级占位符：条目模板里同样会出现站点链接（如作者归档 /author/<slug>/、站点首页）
    h = cfseReplace(h, '{{SITE_URL}}', cfseEscUrl((site && site.url) || ''));
    h = cfseReplace(h, '{{SITE_NAME}}', escapeHtml((site && site.name) || ''));
    h = cfseReplace(h, '{{SITE_DESC}}', escapeHtml((site && site.description) || ''));
    // 评论数：条目骨架是从"抓取那一刻的列表页"扒下来的，里面会夹带**探针文章**的评论数
    // （实测主题包写成 "3 Comments"）⇒ 这里按本篇真实评论数改写，避免列表里每篇都显示同一个数字。
    // 同时支持 {{COMMENT_COUNT}} / {{COMMENT_COUNT_TEXT}}（抓取端已占位化的新骨架）。
    const cc = Number(post.comment_count || 0);
    const ccText = cc > 0 ? (cc + (cc === 1 ? ' Comment' : ' Comments')) : 'No Comments';
    h = cfseReplace(h, '{{COMMENT_COUNT}}', String(cc));
    h = cfseReplace(h, '{{COMMENT_COUNT_TEXT}}', ccText);
    h = h.replace(/(#comments["'][^>]*>)(?:\d+\s*Comments?|No Comments)/g, '$1' + ccText);
    return cfseNoReferrerImgs(h);
}

// 拼接文章列表（不触发条目内分页逻辑）
function cfseRenderItems(itemTpl, posts, site) {
    return (posts || []).map(p => cfseRenderItem(itemTpl, p, site)).join('\n');
}

// ============================================
// 动态侧边栏三块（数据由 routes.js 传入 options.sidebar）
// ============================================
const CFSE_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// 分类列表 <li>（class 与 WP categories widget 一致，不含数字 term_id）
export function cfseSidebarCategoryItems(categories, site, sidebarTpl) {
    if (!Array.isArray(categories)) return '';
    const baseUrl = (site && site.url) || '';
    const skel = (sidebarTpl && sidebarTpl.categories) || '';
    if (skel) {
        return categories.map((c, i) => {
            const name = escapeHtml(c.name);
            const slug = String(c.slug || '');
            const cnt = String(parseInt(c.cnt, 10) || 0);
            return skel
                .split('{{ITEM_URL}}').join(cfseEscUrl(baseUrl + '/category/' + slug + '/'))
                .split('{{ITEM_NAME}}').join(name)
                .split('{{ITEM_COUNT}}').join(cnt)
                .split('{{ITEM_SIZE}}').join('')
                .split('{{ITEM_POSITION}}').join(String(i + 1));
        }).join('\n');
    }
    return categories.map(c => {
        const name = escapeHtml(c.name);
        const slug = String(c.slug || '');
        return '<li class="cat-item"><a href="' + baseUrl + '/category/' + slug + '/">' + name + '</a></li>';
    }).join('\n');
}

// 归档月份 <li>（格式同 WP archives widget：March 2006 → /2006/03/）
export function cfseSidebarArchiveItems(archives, site, sidebarTpl) {
    if (!Array.isArray(archives)) return '';
    const baseUrl = (site && site.url) || '';
    const skel = (sidebarTpl && sidebarTpl.archives) || '';
    const renderOne = (a, idx) => {
        const ym = String(a.ym || '');
        const m = ym.match(/^(\d{4})-(\d{2})$/);
        if (!m) return '';
        const year = m[1];
        const month = parseInt(m[2], 10);
        const label = CFSE_MONTH_NAMES[month - 1] + ' ' + year;
        const url = baseUrl + '/' + year + '/' + (month < 10 ? '0' + month : month) + '/';
        if (skel) {
            const cnt = String(parseInt(a.cnt, 10) || 0);
            return skel
                .split('{{ITEM_URL}}').join(cfseEscUrl(url))
                .split('{{ITEM_NAME}}').join(label)
                .split('{{ITEM_COUNT}}').join(cnt)
                .split('{{ITEM_SIZE}}').join('')
                .split('{{ITEM_POSITION}}').join(String(idx + 1));
        }
        return '<li><a href="' + url + '">' + label + '</a></li>';
    };
    return archives.map(renderOne).filter(Boolean).join('\n');
}

// 标签云 <li>（字号按 WP 算法：round(log10(count+1)*100) 后线性映射 8~22pt；
// tag-link-position-N 为排序序号，aria-label 与 WP 一致）
export function cfseSidebarTagItems(tags, site, sidebarTpl) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    const baseUrl = (site && site.url) || '';
    const skel = (sidebarTpl && sidebarTpl.tags) || '';
    const scaled = (tags || []).map(t => {
        const count = parseInt(t.cnt, 10) || 0;
        return { tag: t, s: Math.round(Math.log10(count + 1) * 100) };
    });
    const minS = Math.min.apply(null, scaled.map(x => x.s));
    const maxS = Math.max.apply(null, scaled.map(x => x.s));
    const spread = (maxS - minS) > 0 ? (maxS - minS) : 1;
    return scaled.map((x, i) => {
        const count = parseInt(x.tag.cnt, 10) || 0;
        const size = 8 + (x.s - minS) * 14 / spread;
        const name = escapeHtml(x.tag.name);
        const aria = name + ' (' + count + (count === 1 ? ' item' : ' items') + ')';
        const url = baseUrl + '/tag/' + String(x.tag.slug || '') + '/';
        if (skel) {
            return skel
                .split('{{ITEM_URL}}').join(cfseEscUrl(url))
                .split('{{ITEM_NAME}}').join(name)
                .split('{{ITEM_SIZE}}').join(String(size))
                .split('{{ITEM_POSITION}}').join(String(i + 1))
                .split('{{ITEM_COUNT}}').join(String(count));
        }
        return '<li><a href="' + url + '" class="tag-cloud-link tag-link-position-' + (i + 1) + '" style="font-size: ' + size + 'pt;" aria-label="' + aria + '">' + name + '</a></li>';
    }).join('\n');
}
export function renderHomepage(data, page, totalPosts, options = {}) {
    const posts = data.posts || [];
    const totalPages = data.totalPages || 1;
    const currentPage = data.currentPage || 1;
    const baseUrl = options.baseUrl || "/";
    const site = (options && options.site) || {};
    const titleName = options.name || options.slug || site.name || "";
    const pageVar = "";

    const pageTpl = (options && options.pageTpl) || CFSE_FALLBACK_PAGE;
    const itemTpl = (options && options.itemTpl) || CFSE_FALLBACK_ITEM;

    const postListHtml = posts.length > 0
        ? cfseRenderItems(itemTpl, posts, site)
        : ((options && options.emptyHtml) ? options.emptyHtml : '');
    const pagPrefix = (options && options.paginationBase) ? options.paginationBase : (baseUrl + 'page/');
    const pagSuffix = (options && options.paginationBase) ? '' : '/';
    const prevHtml = currentPage > 1 ? `<a class="wp-block-query-pagination-previous" href="${pagPrefix}${currentPage - 1}${pagSuffix}">← Older posts</a>` : '';
    const nextHtml = currentPage < totalPages ? `<a class="wp-block-query-pagination-next" href="${pagPrefix}${currentPage + 1}${pagSuffix}">Newer posts →</a>` : '';

    let html = pageTpl;
    html = cfseReplace(html, '{{SITE_NAME}}', escapeHtml(site.name || ''));
    html = cfseReplace(html, '{{SITE_DESC}}', escapeHtml(site.description || ''));
    html = cfseReplace(html, '{{SITE_URL}}', cfseEscUrl(site.url || ''));
    html = cfseReplace(html, '{{CONTENT}}', postListHtml);
    html = cfseReplace(html, '{{PAGINATION_PREV}}', prevHtml);
    html = cfseReplace(html, '{{PAGINATION_NEXT}}', nextHtml);
    html = cfseReplace(html, '{{TOTAL_POSTS}}', String(totalPosts));
    html = cfseIfBlock(html, 'hasPage', page > 1);
    html = cfseReplace(html, '{{PAGE_NUMBER}}', String(page));
    html = cfseReplace(html, '{{SITE_FOOTER}}', site.footerHtml || '');
    // 站点级「可配」占位符（值来自 site:ctx；WP 侧 / Worker 后台算一次写入）
    const siteLogoHtml = cfseSiteLogoHtml(site);
    const siteSocialHtml = cfseSocialLinks(site);
    html = cfseIfBlock(html, 'LOGO', siteLogoHtml !== '');
    html = cfseIfBlock(html, 'SOCIAL', siteSocialHtml !== '');
    html = cfseReplace(html, '{{SITE_LOGO}}', siteLogoHtml);
    const siteBannerHtml = cfseSiteBannerHtml(site);
    html = cfseIfBlock(html, 'BANNER', siteBannerHtml !== '');
    html = cfseReplace(html, '{{SITE_BANNER}}', siteBannerHtml);
    html = cfseReplace(html, '{{SEARCH_ACTION}}', cfseEscUrl((site.url || '') + '/'));
    html = cfseReplace(html, '{{SOCIAL_LINKS}}', siteSocialHtml);
    const siteMenuHtml = cfseMenuHtml(site);
    html = cfseIfBlock(html, 'MENU', siteMenuHtml !== '');
    html = cfseReplace(html, '{{MENU}}', siteMenuHtml);

    // TITLE / 归档年月
    if (typeof year !== 'undefined' && year !== null) {
        html = cfseReplace(html, '{{YEAR}}', year);
        html = cfseReplace(html, '{{MONTH}}', month);
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(pageTitle));
    } else {
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(titleName));
    }

    // 动态侧边栏三块（模板里没有 {{SIDEBAR_*}} 占位符时自动跳过，兼容旧模板）
    const sb = (options && options.sidebar) || {};
    const sbtpl = (options && options.sidebarTpl) || {};
    html = cfseReplace(html, '{{SIDEBAR_CATEGORIES}}', cfseSidebarCategoryItems(sb.categories, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_ARCHIVES}}', cfseSidebarArchiveItems(sb.archives, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_TAGS}}', cfseSidebarTagItems(sb.tags, site, sbtpl));

    return cfseInjectHead(cfseStripLeftovers(html, 'list-page'), site.headExtra);
}
export function renderCategoryPage(data, page, totalPosts, options = {}) {
    const posts = data.posts || [];
    const totalPages = data.totalPages || 1;
    const currentPage = data.currentPage || 1;
    const baseUrl = options.baseUrl || "/";
    const site = (options && options.site) || {};
    const titleName = options.name || options.slug || site.name || "";
    const pageVar = "";

    const pageTpl = (options && options.pageTpl) || CFSE_FALLBACK_PAGE;
    const itemTpl = (options && options.itemTpl) || CFSE_FALLBACK_ITEM;

    const postListHtml = posts.length > 0
        ? cfseRenderItems(itemTpl, posts, site)
        : ((options && options.emptyHtml) ? options.emptyHtml : '');
    const pagPrefix = (options && options.paginationBase) ? options.paginationBase : (baseUrl + 'page/');
    const pagSuffix = (options && options.paginationBase) ? '' : '/';
    const prevHtml = currentPage > 1 ? `<a class="wp-block-query-pagination-previous" href="${pagPrefix}${currentPage - 1}${pagSuffix}">← Older posts</a>` : '';
    const nextHtml = currentPage < totalPages ? `<a class="wp-block-query-pagination-next" href="${pagPrefix}${currentPage + 1}${pagSuffix}">Newer posts →</a>` : '';

    let html = pageTpl;
    html = cfseReplace(html, '{{SITE_NAME}}', escapeHtml(site.name || ''));
    html = cfseReplace(html, '{{SITE_DESC}}', escapeHtml(site.description || ''));
    html = cfseReplace(html, '{{SITE_URL}}', cfseEscUrl(site.url || ''));
    html = cfseReplace(html, '{{CONTENT}}', postListHtml);
    html = cfseReplace(html, '{{PAGINATION_PREV}}', prevHtml);
    html = cfseReplace(html, '{{PAGINATION_NEXT}}', nextHtml);
    html = cfseReplace(html, '{{TOTAL_POSTS}}', String(totalPosts));
    html = cfseIfBlock(html, 'hasPage', page > 1);
    html = cfseReplace(html, '{{PAGE_NUMBER}}', String(page));
    html = cfseReplace(html, '{{SITE_FOOTER}}', site.footerHtml || '');
    // 站点级「可配」占位符（值来自 site:ctx；WP 侧 / Worker 后台算一次写入）
    const siteLogoHtml = cfseSiteLogoHtml(site);
    const siteSocialHtml = cfseSocialLinks(site);
    html = cfseIfBlock(html, 'LOGO', siteLogoHtml !== '');
    html = cfseIfBlock(html, 'SOCIAL', siteSocialHtml !== '');
    html = cfseReplace(html, '{{SITE_LOGO}}', siteLogoHtml);
    const siteBannerHtml = cfseSiteBannerHtml(site);
    html = cfseIfBlock(html, 'BANNER', siteBannerHtml !== '');
    html = cfseReplace(html, '{{SITE_BANNER}}', siteBannerHtml);
    html = cfseReplace(html, '{{SEARCH_ACTION}}', cfseEscUrl((site.url || '') + '/'));
    html = cfseReplace(html, '{{SOCIAL_LINKS}}', siteSocialHtml);
    const siteMenuHtml = cfseMenuHtml(site);
    html = cfseIfBlock(html, 'MENU', siteMenuHtml !== '');
    html = cfseReplace(html, '{{MENU}}', siteMenuHtml);

    // TITLE / 归档年月
    if (typeof year !== 'undefined' && year !== null) {
        html = cfseReplace(html, '{{YEAR}}', year);
        html = cfseReplace(html, '{{MONTH}}', month);
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(pageTitle));
    } else {
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(titleName));
    }

    // 动态侧边栏三块（模板里没有 {{SIDEBAR_*}} 占位符时自动跳过，兼容旧模板）
    const sb = (options && options.sidebar) || {};
    const sbtpl = (options && options.sidebarTpl) || {};
    html = cfseReplace(html, '{{SIDEBAR_CATEGORIES}}', cfseSidebarCategoryItems(sb.categories, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_ARCHIVES}}', cfseSidebarArchiveItems(sb.archives, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_TAGS}}', cfseSidebarTagItems(sb.tags, site, sbtpl));

    return cfseInjectHead(cfseStripLeftovers(html, 'list-page'), site.headExtra);
}
export function renderTagPage(data, page, totalPosts, options = {}) {
    const posts = data.posts || [];
    const totalPages = data.totalPages || 1;
    const currentPage = data.currentPage || 1;
    const baseUrl = options.baseUrl || "/";
    const site = (options && options.site) || {};
    const titleName = options.name || options.slug || site.name || "";
    const pageVar = "";

    const pageTpl = (options && options.pageTpl) || CFSE_FALLBACK_PAGE;
    const itemTpl = (options && options.itemTpl) || CFSE_FALLBACK_ITEM;

    const postListHtml = posts.length > 0
        ? cfseRenderItems(itemTpl, posts, site)
        : ((options && options.emptyHtml) ? options.emptyHtml : '');
    const pagPrefix = (options && options.paginationBase) ? options.paginationBase : (baseUrl + 'page/');
    const pagSuffix = (options && options.paginationBase) ? '' : '/';
    const prevHtml = currentPage > 1 ? `<a class="wp-block-query-pagination-previous" href="${pagPrefix}${currentPage - 1}${pagSuffix}">← Older posts</a>` : '';
    const nextHtml = currentPage < totalPages ? `<a class="wp-block-query-pagination-next" href="${pagPrefix}${currentPage + 1}${pagSuffix}">Newer posts →</a>` : '';

    let html = pageTpl;
    html = cfseReplace(html, '{{SITE_NAME}}', escapeHtml(site.name || ''));
    html = cfseReplace(html, '{{SITE_DESC}}', escapeHtml(site.description || ''));
    html = cfseReplace(html, '{{SITE_URL}}', cfseEscUrl(site.url || ''));
    html = cfseReplace(html, '{{CONTENT}}', postListHtml);
    html = cfseReplace(html, '{{PAGINATION_PREV}}', prevHtml);
    html = cfseReplace(html, '{{PAGINATION_NEXT}}', nextHtml);
    html = cfseReplace(html, '{{TOTAL_POSTS}}', String(totalPosts));
    html = cfseIfBlock(html, 'hasPage', page > 1);
    html = cfseReplace(html, '{{PAGE_NUMBER}}', String(page));
    html = cfseReplace(html, '{{SITE_FOOTER}}', site.footerHtml || '');
    // 站点级「可配」占位符（值来自 site:ctx；WP 侧 / Worker 后台算一次写入）
    const siteLogoHtml = cfseSiteLogoHtml(site);
    const siteSocialHtml = cfseSocialLinks(site);
    html = cfseIfBlock(html, 'LOGO', siteLogoHtml !== '');
    html = cfseIfBlock(html, 'SOCIAL', siteSocialHtml !== '');
    html = cfseReplace(html, '{{SITE_LOGO}}', siteLogoHtml);
    const siteBannerHtml = cfseSiteBannerHtml(site);
    html = cfseIfBlock(html, 'BANNER', siteBannerHtml !== '');
    html = cfseReplace(html, '{{SITE_BANNER}}', siteBannerHtml);
    html = cfseReplace(html, '{{SEARCH_ACTION}}', cfseEscUrl((site.url || '') + '/'));
    html = cfseReplace(html, '{{SOCIAL_LINKS}}', siteSocialHtml);
    const siteMenuHtml = cfseMenuHtml(site);
    html = cfseIfBlock(html, 'MENU', siteMenuHtml !== '');
    html = cfseReplace(html, '{{MENU}}', siteMenuHtml);

    // TITLE / 归档年月
    if (typeof year !== 'undefined' && year !== null) {
        html = cfseReplace(html, '{{YEAR}}', year);
        html = cfseReplace(html, '{{MONTH}}', month);
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(pageTitle));
    } else {
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(titleName));
    }

    // 动态侧边栏三块（模板里没有 {{SIDEBAR_*}} 占位符时自动跳过，兼容旧模板）
    const sb = (options && options.sidebar) || {};
    const sbtpl = (options && options.sidebarTpl) || {};
    html = cfseReplace(html, '{{SIDEBAR_CATEGORIES}}', cfseSidebarCategoryItems(sb.categories, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_ARCHIVES}}', cfseSidebarArchiveItems(sb.archives, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_TAGS}}', cfseSidebarTagItems(sb.tags, site, sbtpl));

    return cfseInjectHead(cfseStripLeftovers(html, 'list-page'), site.headExtra);
}
export function renderArchivePage(data, page, totalPosts, options = {}) {
    const posts = data.posts || [];
    const totalPages = data.totalPages || 1;
    const currentPage = data.currentPage || 1;
    const baseUrl = options.baseUrl || "/";
    const site = (options && options.site) || {};
    const titleName = options.name || options.slug || site.name || "";
    const year = options.year || "";
    const month = options.month || "";
    const pageTitle = (year ? year + (month ? " 年 " + month + " 月" : " 年") : "归档");
    const pageVar = pageTitle;

    const pageTpl = (options && options.pageTpl) || CFSE_FALLBACK_PAGE;
    const itemTpl = (options && options.itemTpl) || CFSE_FALLBACK_ITEM;

    const postListHtml = posts.length > 0
        ? cfseRenderItems(itemTpl, posts, site)
        : ((options && options.emptyHtml) ? options.emptyHtml : '');
    const pagPrefix = (options && options.paginationBase) ? options.paginationBase : (baseUrl + 'page/');
    const pagSuffix = (options && options.paginationBase) ? '' : '/';
    const prevHtml = currentPage > 1 ? `<a class="wp-block-query-pagination-previous" href="${pagPrefix}${currentPage - 1}${pagSuffix}">← Older posts</a>` : '';
    const nextHtml = currentPage < totalPages ? `<a class="wp-block-query-pagination-next" href="${pagPrefix}${currentPage + 1}${pagSuffix}">Newer posts →</a>` : '';

    let html = pageTpl;
    html = cfseReplace(html, '{{SITE_NAME}}', escapeHtml(site.name || ''));
    html = cfseReplace(html, '{{SITE_DESC}}', escapeHtml(site.description || ''));
    html = cfseReplace(html, '{{SITE_URL}}', cfseEscUrl(site.url || ''));
    html = cfseReplace(html, '{{CONTENT}}', postListHtml);
    html = cfseReplace(html, '{{PAGINATION_PREV}}', prevHtml);
    html = cfseReplace(html, '{{PAGINATION_NEXT}}', nextHtml);
    html = cfseReplace(html, '{{TOTAL_POSTS}}', String(totalPosts));
    html = cfseIfBlock(html, 'hasPage', page > 1);
    html = cfseReplace(html, '{{PAGE_NUMBER}}', String(page));
    html = cfseReplace(html, '{{SITE_FOOTER}}', site.footerHtml || '');
    // 站点级「可配」占位符（值来自 site:ctx；WP 侧 / Worker 后台算一次写入）
    const siteLogoHtml = cfseSiteLogoHtml(site);
    const siteSocialHtml = cfseSocialLinks(site);
    html = cfseIfBlock(html, 'LOGO', siteLogoHtml !== '');
    html = cfseIfBlock(html, 'SOCIAL', siteSocialHtml !== '');
    html = cfseReplace(html, '{{SITE_LOGO}}', siteLogoHtml);
    const siteBannerHtml = cfseSiteBannerHtml(site);
    html = cfseIfBlock(html, 'BANNER', siteBannerHtml !== '');
    html = cfseReplace(html, '{{SITE_BANNER}}', siteBannerHtml);
    html = cfseReplace(html, '{{SEARCH_ACTION}}', cfseEscUrl((site.url || '') + '/'));
    html = cfseReplace(html, '{{SOCIAL_LINKS}}', siteSocialHtml);
    const siteMenuHtml = cfseMenuHtml(site);
    html = cfseIfBlock(html, 'MENU', siteMenuHtml !== '');
    html = cfseReplace(html, '{{MENU}}', siteMenuHtml);

    // TITLE / 归档年月
    if (typeof year !== 'undefined' && year !== null) {
        html = cfseReplace(html, '{{YEAR}}', year);
        html = cfseReplace(html, '{{MONTH}}', month);
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(pageTitle));
    } else {
        html = cfseReplace(html, '{{TITLE}}', escapeHtml(titleName));
    }

    // 动态侧边栏三块（模板里没有 {{SIDEBAR_*}} 占位符时自动跳过，兼容旧模板）
    const sb = (options && options.sidebar) || {};
    const sbtpl = (options && options.sidebarTpl) || {};
    html = cfseReplace(html, '{{SIDEBAR_CATEGORIES}}', cfseSidebarCategoryItems(sb.categories, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_ARCHIVES}}', cfseSidebarArchiveItems(sb.archives, site, sbtpl));
    html = cfseReplace(html, '{{SIDEBAR_TAGS}}', cfseSidebarTagItems(sb.tags, site, sbtpl));

    return cfseInjectHead(cfseStripLeftovers(html, 'list-page'), site.headExtra);
}

// 单页壳模板（Worker 发布文章时渲染静态单页；占位符：POST_TITLE/POST_CONTENT/POST_DATE/POST_URL/POST_EXCERPT/SITE_URL/SITE_NAME/SITE_FOOTER）
export const CFSE_SINGLE_TPL = CFSE_FALLBACK_SINGLE;

// ==========【PHP自动注入标记结束】==========
