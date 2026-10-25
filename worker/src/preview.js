/**
 * 风格预览（只读）
 *
 *   GET /preview/                     → 画廊索引（列 KV tpl:index 里的内置风格）
 *   GET /preview/<slug>/              → 外壳：6 页签 + iframe
 *   GET /preview/<slug>/?kind=<kind>  → 单类渲染（干净 HTML，供 iframe / 新窗口）
 *
 * 设计要点：
 *  - **直接读 tpl.json 渲染**，不写 KV、不改 tpl:active ⇒ 看风格不必先"应用"（不动线上）
 *  - tpl.json 读取顺序与请求链一致：static assets → R2 同路径（wp-content/themes/<slug>/tpl.json）
 *  - 渲染复用 admin.js 的 tplPreviewHtml()（与后台预览、线上渲染同一套函数）⇒ 预览即所得
 *  - 6 类模板**必须用 iframe 承载**：它们各自的 <style> 会互相污染
 */
import { tplPreviewHtml } from './admin';
import { getFromR2 } from './storage';
import { r2KeyFromPath } from './r2key';

const KINDS = ['pageHome', 'pageCategory', 'pageTag', 'pageArchive', 'single', 'item'];
const LABELS = {
    pageHome: '首页', pageCategory: '分类', pageTag: '标签',
    pageArchive: '归档', single: '单页', item: '列表条目',
};

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const html = (body, status = 200) => new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** 读 /wp-content/themes/<slug>/tpl.json：static assets → R2 同路径 */
async function loadTplJson(env, slug) {
    const key = 'wp-content/themes/' + slug + '/tpl.json';
    if (env.ASSETS) {
        try {
            const r = await env.ASSETS.fetch(new Request('https://assets.local/' + key));
            if (r && r.ok) { const j = await r.json(); if (j && j.tpl) return j; }
        } catch (e) { /* 落到 R2 */ }
    }
    try {
        const f = await getFromR2(env.R2_BUCKET, r2KeyFromPath('/' + key));
        if (f && f.body) {
            const j = JSON.parse(new TextDecoder().decode(f.body));
            if (j && j.tpl) return j;
        }
    } catch (e) { /* fallthrough */ }
    return null;
}

const SHELL_CSS = `
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 system-ui,"Segoe UI",sans-serif;display:flex;flex-direction:column;height:100vh;background:#f6f7f9}
  header{padding:10px 14px;border-bottom:1px solid #e3e5e8;background:#fff;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header a{color:#1d4ed8;text-decoration:none}
  h1{font-size:15px;margin:0;font-weight:600}
  .tabs{display:flex;gap:6px;flex-wrap:wrap}
  .tabs a{padding:4px 10px;border:1px solid #d0d3d7;border-radius:6px;color:#333;background:#fff}
  .tabs a.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
  .muted{color:#888}
  .grow{flex:1}
  iframe{flex:1;border:0;width:100%;background:#fff}
  .wrap{padding:18px;max-width:1000px;margin:0 auto}
  ul.cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
  ul.cards li{border:1px solid #e3e5e8;border-radius:8px;background:#fff;padding:10px 12px}
  ul.cards a{font-weight:600}
  code{background:#f0f1f3;padding:1px 5px;border-radius:4px}
`;

/** 画廊索引页 */
async function galleryIndex(env) {
    // 来源 1：getStyleIndex()（内置 + 用户；标 current）
    let fromKv = [];
    try {
        const { getSiteContext, getStyleIndex } = await import('./site');
        const ctx = await getSiteContext(env);
        const arr = await getStyleIndex(env);
        fromKv = arr.filter((x) => x && x.id).map((x) => Object.assign({}, x, { current: (x.id === ctx.activeStyleId) }));
    } catch (e) { /* ignore */ }
    // 来源 2：R2 里 wp-content/themes/<slug>/ 的目录（不依赖 KV —— deploy 覆盖 tpl:index 后依然在）
    let fromR2 = [];
    try {
        const list = await env.R2_BUCKET.list({ prefix: 'wp-content/themes/', delimiter: '/' });
        for (const p of (list.delimitedPrefixes || [])) {
            const m = String(p).match(/^wp-content\/themes\/([^/]+)\/$/);
            if (m) { try { fromR2.push(decodeURIComponent(m[1])); } catch (e) { fromR2.push(m[1]); } }
        }
    } catch (e) { /* ignore */ }

    const byId = new Map(fromKv.map((x) => [x.id, x]));
    for (const id of fromR2) if (!byId.has(id)) byId.set(id, { id: id, name: id, source: 'r2' });
    const items = [...byId.values()];

    const cards = items.map((x) => `<li>
      <a href="/preview/${encodeURIComponent(x.id)}/">${esc(x.name || x.id)}</a>
      <div class="muted" style="font-size:12px">${esc(x.id)}${x.current ? ' · 当前生效' : ''}</div>
    </li>`).join('\n');
    return html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>风格预览 · 画廊</title>
<style>${SHELL_CSS}</style></head><body>
<div class="wrap">
  <h1>风格预览（${items.length} 个）</h1>
  <p class="muted">点任意风格进入全屏预览（6 个页签）。预览是<strong>只读</strong>的：直接读 <code>tpl.json</code> 渲染，不会改动线上。</p>
  ${items.length ? `<ul class="cards">${cards}</ul>` : '<p class="muted">没读到任何风格 —— 也可以直接用下面的输入框打开某个 slug。</p>'}
  <form onsubmit="location.href='/preview/'+encodeURIComponent(document.getElementById('s').value.trim())+'/';return false;" style="margin-top:18px">
    <input id="s" placeholder="输入风格 slug（如 neve-fse）" style="padding:6px 10px;border:1px solid #ccc;border-radius:6px;width:280px">
    <button type="submit" style="padding:6px 12px">打开预览</button>
  </form>
</div></body></html>`);
}

/** 外壳页：6 页签 + iframe */
async function previewShell(env, slug) {
    const j = await loadTplJson(env, slug);
    if (!j) {
        return html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>未找到</title>
<style>${SHELL_CSS}</style></head><body><div class="wrap">
<h1>未找到风格 <code>${esc(slug)}</code></h1>
<p class="muted">读不到 <code>/wp-content/themes/${esc(slug)}/tpl.json</code>（static 与 R2 都没命中）。</p>
<p><a href="/preview/">← 回到画廊</a></p></div></body></html>`, 404);
    }
    const tabs = KINDS.map((k) => `<a href="#" data-kind="${k}"${k === 'pageHome' ? ' class="on"' : ''}>${LABELS[k]}</a>`).join('');
    const base = '/preview/' + encodeURIComponent(slug) + '/?kind=';
    return html(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>预览 · ${esc(j.name || slug)}</title>
<style>${SHELL_CSS}</style></head><body>
<header>
  <h1>${esc(j.name || slug)}</h1>
  <nav class="tabs">${tabs}</nav>
  <span class="grow"></span>
  <a id="open" href="${base}pageHome" target="_blank">↗ 新窗口</a>
  <a href="/preview/">← 画廊</a>
</header>
<iframe id="f" src="${base}pageHome"></iframe>
<script>
  var f = document.getElementById('f'), open = document.getElementById('open'), base = ${JSON.stringify(base)};
  document.querySelectorAll('.tabs a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      document.querySelectorAll('.tabs a').forEach(function (x) { x.classList.remove('on'); });
      a.classList.add('on');
      var k = a.getAttribute('data-kind');
      f.src = base + k; open.href = base + k;
    });
  });
</script>
</body></html>`);
}

/** 单类渲染（干净 HTML，供 iframe / 新窗口） */
async function previewKind(env, slug, kind) {
    if (KINDS.indexOf(kind) === -1) return html('未知 kind: ' + esc(kind), 400);
    const j = await loadTplJson(env, slug);
    if (!j) return html('未找到风格: ' + esc(slug), 404);
    const tpl = j.tpl || {};
    const tplAll = Object.assign({}, tpl, { sidebar: j.sidebar || null });   // 骨架随包，供 cfseSidebar* 用
    const out = await tplPreviewHtml(env, kind, String(tpl[kind] || ''), tplAll);
    return html(out);
}

/** 入口：routes.js / routes.template.js 转发（非登录区） */
export async function handleStylePreview(request, env, path, url) {
    if (path === '/preview' || path === '/preview/') return await galleryIndex(env);
    const m = path.match(/^\/preview\/([^/]+)\/?$/);
    if (!m) return html('Not found', 404);
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch (e) { /* 原样 */ }
    if (!/^[A-Za-z0-9._%-]+$/.test(slug)) return html('非法 slug', 400);
    const kind = url.searchParams.get('kind');
    if (kind) return await previewKind(env, slug, kind);
    return await previewShell(env, slug);
}
