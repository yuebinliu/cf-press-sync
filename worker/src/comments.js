/**
 * comments.js —— 评论渲染（B1）
 *
 * 数据：D1 `comments`（WP 端钩子单向同步写入；只有 `approved = 1` 上屏）
 * 骨架：`tpl:active.comments` = { list, entry, children } —— 抓取风格时按**主题真实结构**提取：
 *   list      外壳（标题 + `<ol class="commentlist">{{COMMENTS}}</ol>`）
 *   entry     顶层单条骨架（`<li …>…</li>`）
 *   children  子条骨架（同结构；主题对子层可能用不同类名）
 * 渲染：按 parent_id 建树递归再生；交替类 / 深度类 / 头像 / 日期都在这里生成，主题结构原样保留。
 */

import { getSiteContext } from './site';
import { getActiveCommentsTpl } from './tplstore';

function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
    return escHtml(s).replace(/"/g, '&quot;');
}
/**
 * 评论正文：转义后把换行变成 <br>。
 *
 * 为什么必须转义：评论是**未受信输入**，而 `{{COMMENT_CONTENT}}` 是插进 innerHTML 的。
 * 不转义就是存储型 XSS —— 攻击者提交 `<img src=x onerror=...>`，管理员在后台只看到
 * 剥过标签的纯文本（app.js:2192），审核通过后所有访客中招。
 *
 * 为什么只做转义、不做富文本白名单：线上 66 条已审核评论里只有 1 条含 HTML，
 * 且是 WordPress 自带的示例评论（`<br />`），其余全是纯文本 ⇒ 评论的真实形态就是纯文本，
 * 不需要富文本能力。若将来要放开，应在**入库前**做白名单消毒，而不是在渲染时放行。
 */
function escCommentText(s) {
    return escHtml(s).replace(/\r\n|\r|\n/g, '<br>');
}

/** 最大嵌套层数（1 = 只有顶层）。超过后不再缩进，后代平铺到当前层。 */
const MAX_DEPTH = 6;

/**
 * 算某条评论的嵌套层数（顶层 = 1）。
 * 用循环而非递归，且最多走 MAX_DEPTH+2 步 —— 即使历史数据里存在环，也不会死循环。
 */
async function ancestorDepth(db, id) {
    let cur = Number(id) || 0;
    let depth = 1;
    let guard = 0;
    while (cur && guard++ < MAX_DEPTH + 2) {
        const row = await db.prepare('SELECT parent_id FROM comments WHERE comment_id = ?').bind(cur).first();
        if (!row || !Number(row.parent_id)) break;
        cur = Number(row.parent_id);
        depth++;
    }
    return depth;
}
/** {{#IF_FLAG}}…{{/IF_FLAG}}：cond=false 整块删除（与 admin.js/templates.js 同语义） */
function ifBlock(tpl, flag, cond) {
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
function rep(tpl, token, value) {
    return tpl.split(token).join(String(value == null ? '' : value));
}

/** 取某篇文章的已审核评论（时间升序；上限 500 条，避免单页被撑爆） */
export async function getPostComments(db, postId) {
    try {
        const r = await db.prepare(
            "SELECT comment_id, parent_id, author, author_url, avatar, date, date_text, content FROM comments " +
            "WHERE post_id = ? AND approved = 1 ORDER BY date ASC, comment_id ASC LIMIT 500"
        ).bind(Number(postId) || 0).all();
        return (r && r.results) || [];
    } catch (e) {
        console.error('getPostComments:', e);
        return [];
    }
}

/** 头像 2x：gravatar URL 里的 s=NN 换成 80；其它形式原样返回 */
function avatar2x(url) {
    const u = String(url || '');
    if (!u) return '';
    return /[?&]s=\d+/.test(u) ? u.replace(/([?&]s=)\d+/, '$180') : u;
}

/**
 * ② 半动态评论区：把 R2 里那张**静态单页**的快照评论区，替换成"响应时从 D1 现场生成"的版本。
 * 只在页面带抓取端写入的标记（`<!--CFSE-COMMENTS-START id=N-->` … `<!--CFSE-COMMENTS-END-->`）
 * 且站点评论可用时生效；否则返回 null（调用方照旧直出静态内容）。
 * 收益：新评论 / 审核结果**立即可见**，不必重建单页；代价是每个单页请求多 1-2 次 D1 查询。
 */
export async function injectComments(env, file) {
    try {
        if (!file || !file.body) return null;
        if (file.contentEncoding === 'gzip') return null;   // 压缩流里做替换不划算，跳过
        const text = (typeof file.body === 'string') ? file.body : new TextDecoder().decode(file.body);
        const m = text.match(/<!--CFSE-COMMENTS-START\s+id=(\d+)\s*-->/);
        if (!m) return null;
        const postId = parseInt(m[1], 10) || 0;
        if (!postId) return null;

        const site = await getSiteContext(env);
        const cfg = (site && site.comments) || {};
        const mode = String(cfg.mode || 'off');
        const stationOn = (mode === 'native' || mode === 'embed');

        // 站点级 off（第一层短路）：配置在 KV（site:ctx），不依赖 D1 ⇒ 在这里直接清空标记区间并返回，
        // 省掉下面那次 posts 行查询（文章级 closed 的信息在 D1 里，省不掉，所以那部分仍在 D1 判断）。
        // ⚠️ 必须是"替换成空"，不能 return null —— return null 会让路由直出 R2 快照（可能带旧评论+表单，
        // 就是"评论框关不掉"的 bug）。标记本身保留，将来改回 native 还能继续注入。
        if (!stationOn) {
            return text.replace(
                /(<!--CFSE-COMMENTS-START\s+id=\d+\s*-->)[\s\S]*?(<!--CFSE-COMMENTS-END-->)/,
                '$1$2'
            );
        }

        const row = await env.D1_DATABASE.prepare('SELECT title, slug, comment_status FROM posts WHERE wp_id = ? LIMIT 1').bind(postId).first();
        const title = row ? String(row.title || '') : '';
        const slug = row ? String(row.slug || '') : '';
        const pattern = String(site.storagePattern || '{slug}/index.html');
        const url = (site.url || '') + '/' + pattern.replace('{slug}', slug).replace('/index.html', '/');

        // 文章级关闭评论（comment_status='closed'）⇒ 注入空内容（把静态快照里可能存在的旧评论也一并清掉）
        let html = '';
        if (String((row && row.comment_status) || 'open') !== 'closed') {
            const items = await getPostComments(env.D1_DATABASE, postId);
            const tpl = await getActiveCommentsTpl(env);
            html = cfseCommentItems(items, tpl, site, title, url, postId);
        }
        return text.replace(
            /(<!--CFSE-COMMENTS-START\s+id=\d+\s*-->)[\s\S]*?(<!--CFSE-COMMENTS-END-->)/,
            '$1' + html + '$2'
        );
    } catch (e) {
        console.error('injectComments:', e);
        return null;
    }
}

/** 用骨架再生评论区；无评论 / 无骨架 ⇒ 返回 ''（调用方据此隐藏整块） */
export function cfseCommentItems(comments, tpl, site, postTitle, postUrl, postId) {
    const shell = (tpl && tpl.list) || '';
    const entry = (tpl && tpl.entry) || '';
    const childTpl = (tpl && tpl.children) || entry;
    const formTpl = (tpl && tpl.form) || '';
    const list = (comments || []).slice();
    if (!shell || !entry) return formTpl ? commentFormBlock(formTpl, postId) : '';
    if (!list.length) {
        // 无评论：仍然给出提交表单 —— 否则「还没有人评论的文章」读者也无处可评
        return commentFormBlock(formTpl, postId);
    }

    const kids = {};
    list.forEach(function (c) {
        const p = Number(c.parent_id) || 0;
        if (!kids[p]) kids[p] = [];
        kids[p].push(c);
    });

    let seq = -1;

    /** 只做占位符替换，**不处理子评论**。正常递归与「超深平铺」共用这一段，避免两套逻辑分叉。 */
    function renderFields(c, depth, tplStr) {
        seq++;
        const n = seq;
        const id = Number(c.comment_id) || 0;
        const author = String(c.author || '');
        const url = String(c.author_url || '');
        // 头像兜底：补 gravatar 的「无 hash + 默认图」形式（不需要 md5），避免渲染出空 src
        const av = String(c.avatar || '') || 'https://secure.gravatar.com/avatar/?d=mm&s=40';
        let h = tplStr;
        h = ifBlock(h, 'COMMENT_AUTHOR_URL', !!url);
        h = rep(h, '{{COMMENT_AUTHOR_URL}}', escAttr(url));
        h = rep(h, '{{COMMENT_AUTHOR}}', escHtml(author));
        h = rep(h, '{{COMMENT_AUTHOR_PLAIN}}', url ? '' : escHtml(author));
        h = rep(h, '{{COMMENT_ID}}', id);
        h = rep(h, '{{COMMENT_AVATAR}}', escAttr(av));
        h = rep(h, '{{COMMENT_AVATAR_2X}}', escAttr(avatar2x(av)));
        h = rep(h, '{{COMMENT_DATE}}', escHtml(String(c.date_text || c.date || '')));
        h = rep(h, '{{COMMENT_DATETIME}}', escAttr(String(c.date || '')));
        h = rep(h, '{{COMMENT_DEPTH}}', depth);
        h = rep(h, '{{COMMENT_ODD_EVEN}}', (n % 2 === 0) ? 'even' : 'odd');
        h = rep(h, '{{COMMENT_ALT}}', (n % 2 === 1) ? 'alt' : '');
        h = rep(h, '{{COMMENT_THREAD_CLASS}}', (depth % 2 === 0) ? 'thread-even' : 'thread-odd');
        h = rep(h, '{{COMMENT_CONTENT}}', escCommentText(c.content));
        return h;
    }

    /**
     * 把一棵子树按 BFS **摊平**渲染（每个节点都当作「无子节点」）。
     * 用途：嵌套深度到达 MAX_DEPTH 后，后代不再缩进，但仍然要显示 —— 不丢评论。
     * 用迭代而不是递归：即使数据里存在上千层的历史脏数据，也不会爆栈。
     */
    function flattenDescendants(items, depth) {
        let out = '';
        const queue = items.slice();
        let guard = 0;
        while (queue.length && guard++ < 500) {
            const c = queue.shift();
            let x = renderFields(c, depth, childTpl);
            x = ifBlock(x, 'COMMENT_CHILDREN', false);
            x = rep(x, '{{COMMENT_CHILDREN}}', '');
            out += x;
            const cid = Number(c.comment_id) || 0;
            const sub = kids[cid] || [];
            for (let i = 0; i < sub.length; i++) queue.push(sub[i]);
        }
        return out;
    }

    function renderOne(c, depth, tplStr) {
        let h = renderFields(c, depth, tplStr);
        const id = Number(c.comment_id) || 0;
        const mine = kids[id] || [];
        // 先处理本层的 IF 块（此刻 h 里只有自己这一处），再把子树插进来
        h = ifBlock(h, 'COMMENT_CHILDREN', mine.length > 0 && depth < MAX_DEPTH);
        if (mine.length) {
            if (depth < MAX_DEPTH) {
                // ⚠️ 只能替换**本层的那一处**占位符：子树里还有同名占位符（更深层），
                // 若用全局替换（split/join）会把自己的子树无限复制进去 ⇒ 全站重建 500（实测踩过）。
                const kidsHtml = renderTree(mine, depth + 1, childTpl);
                const tok = '{{COMMENT_CHILDREN}}';
                const at = h.indexOf(tok);
                if (at >= 0) h = h.slice(0, at) + kidsHtml + h.slice(at + tok.length);
            } else {
                // 深度到顶：后代平铺到当前层（视觉上不再缩进），避免无限嵌套把版面挤扁
                h = rep(h, '{{COMMENT_CHILDREN}}', '');
                h += flattenDescendants(mine, depth);
            }
        } else {
            h = rep(h, '{{COMMENT_CHILDREN}}', '');
        }
        return h;
    }
    function renderTree(items, depth, tplStr) {
        let out = '';
        for (let i = 0; i < items.length; i++) { out += renderOne(items[i], depth, tplStr); }
        return out;
    }

    let html = shell;
    html = rep(html, '{{COMMENT_COUNT}}', list.length);
    html = rep(html, '{{POST_TITLE}}', escHtml(String(postTitle || '')));
    html = rep(html, '{{COMMENTS}}', renderTree(kids[0] || [], 1, entry));
    // 评论锚链接里的 {{POST_URL}}：评论区是在 renderSingleHtml 的 rep() 之后才注入的，
    // 那时 {{POST_URL}} 已经错过替换 ⇒ 这里自己补一遍。
    html = rep(html, '{{POST_URL}}', escAttr(String(postUrl || '')));
    // 提交表单（comments.form = 主题自己的 #respond）：填 post id，并接上对我们的 /comments 端点的提交
    html += commentFormBlock(tpl && tpl.form, postId);
    return html;
}

/** 评论提交表单：替换 {{COMMENT_POST_ID}} 并注入一段脚本，把提交接到公开端点 POST /comments（就地提示） */
function commentFormBlock(form, postId) {
    const tplStr = String(form || '');
    if (!tplStr) return '';
    const pid = Number(postId) || 0;
    // 反垃圾蜜罐：人看不见、也不会填；脚本会把它一起发出去，Worker 端看到非空就静默丢弃
    const body = tplStr.split('{{COMMENT_POST_ID}}').join(String(pid));
    const hp = '<input type="text" name="cfse_hp" value="" tabindex="-1" autocomplete="off" aria-hidden="true" ' +
        'style="position:absolute;left:-99999px;top:auto;width:1px;height:1px;overflow:hidden;" />';
    const bodyWithHp = tplStr.indexOf('<form') >= 0
        ? body.replace(/(<form\b[^>]*>)/i, '$1' + hp)
        : body;
    const js =
        '(function(){var f=document.getElementById("commentform");if(!f)return;' +
        'var pid=' + pid + ',t0=Date.now(),parent=0;' +
        // 回复按钮：静态站里"回复"由 JS 接管 —— 点它记住父评论 id 并聚焦表单
        'var rl=document.querySelectorAll(".reply a[data-cfse-parent]");' +
        'for(var i=0;i<rl.length;i++){(function(el){el.addEventListener("click",function(ev){ev.preventDefault();' +
        'parent=parseInt(el.getAttribute("data-cfse-parent"),10)||0;' +
        'var m0=document.getElementById("cfse-comment-msg");' +
        'if(m0){m0.style.cssText="padding:8px 10px;margin:8px 0;border-radius:4px;font-size:14px;background:#eef6ff;color:#1b4b8f;";m0.textContent="正在回复该条评论（提交后会挂在它下面）。";}' +
        'try{f.scrollIntoView({behavior:"smooth",block:"center"});}catch(e2){}' +
        'var ta=f.elements["comment"];if(ta){ta.focus();}' +
        '});})(rl[i]);}' +
        'f.addEventListener("submit",function(e){e.preventDefault();' +
        'var g=function(n){var el=f.elements[n];return el&&el.value?el.value:"";};' +
        'var d={post:pid,author_name:g("author"),author_email:g("email"),author_url:g("url"),content:g("comment"),parent:parent,' +
        'cfse_hp:g("cfse_hp"),elapsed:Math.round((Date.now()-t0)/1000)};' +
        'var m=document.getElementById("cfse-comment-msg");' +
        'if(!m){m=document.createElement("div");m.id="cfse-comment-msg";f.parentNode.insertBefore(m,f);}' +
        'm.style.cssText="padding:8px 10px;margin:8px 0;border-radius:4px;font-size:14px;";' +
        'fetch("/comments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)})' +
        '.then(function(r){return r.json();}).then(function(j){' +
        'if(j&&j.ok){m.style.background="#e6f4ea";m.style.color="#1e7b34";m.textContent="评论已提交，待审核通过后显示。";f.reset();parent=0;}' +
        'else{m.style.background="#fdecea";m.style.color="#b3261e";m.textContent="提交失败："+((j&&j.message)||"未知错误");}' +
        '})' +
        '.catch(function(){m.style.background="#fdecea";m.style.color="#b3261e";m.textContent="提交失败，请稍后再试。";});' +
        '});})();';
    return bodyWithHp + '\n<script>' + js + '</script>\n';
}

/** 公开提交限流（isolate 级内存滑窗；与 wpv2RateAllowed 同思路，0 KV 成本） */
const commentRateBuckets = new Map();
export function commentRateAllowed(key, isWrite) {
    const limit = isWrite ? 90 : 600;
    const now = Date.now();
    let b = commentRateBuckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + 60000 }; commentRateBuckets.set(key, b); }
    b.n++;
    if (commentRateBuckets.size > 2000) commentRateBuckets.clear();
    return b.n <= limit;
}

/**
 * B2：接收读者提交的评论 → 写 D1（origin='worker'、wp_comment_id=0）。
 * 之后由 WP 侧**主动拉取**（GET /sync/comments?unpulled=1）落地到 WP —— 线上 Worker 到不了内网源站，
 * 所以方向只能是 WP 拉，而不是 Worker 推。审核策略取 site.comments.accept：off（默认，拒收）| pending | auto。
 */
export async function createComment(env, body, site) {
    const cfg = (site && site.comments) || {};
    const accept = String(cfg.accept || 'off');
    if (accept !== 'pending' && accept !== 'auto') {
        return { ok: false, code: 'comment_closed', message: '本站未开启评论', status: 403 };
    }
    const postId = parseInt((body && (body.post !== undefined ? body.post : body.post_id)) || 0, 10) || 0;
    if (!postId) return { ok: false, code: 'comment_invalid', message: '缺少 post', status: 400 };

    // ---- 反垃圾（低成本三重）----
    // ① 蜜罐：机器人常会填隐藏字段 ⇒ 静默"成功"（不写库、也不告诉它被拦了，避免重试）
    const hp = String((body && body.cfse_hp) || '').trim();
    if (hp !== '') return { ok: true, comment: { id: 0, post: postId, status: 'hold', origin: 'worker', spam: 1 } };
    // ② 最小停留：真人填表不会在 3 秒内完成
    const elapsed = parseInt((body && body.elapsed) || 0, 10) || 0;
    if (elapsed > 0 && elapsed < 3) {
        return { ok: false, code: 'comment_too_fast', message: '提交得有点快，请确认内容后再试', status: 429 };
    }

    const content = String((body && (body.content || body.comment_content)) || '').trim();
    if (!content) return { ok: false, code: 'comment_invalid', message: '评论内容不能为空', status: 400 };
    if (content.length > 5000) return { ok: false, code: 'comment_invalid', message: '评论过长（上限 5000 字）', status: 400 };
    // ③ 正文校验：最少几个字 + 链接数量上限（纯链接/广告常见）
    if (content.replace(/\s+/g, '').length < 2) return { ok: false, code: 'comment_invalid', message: '内容太短', status: 400 };
    const links = (content.match(/https?:\/\//gi) || []).length;
    if (links > 2) return { ok: false, code: 'comment_invalid', message: '正文里的链接过多（最多 2 个）', status: 400 };
    const author = String((body && (body.author_name || body.author)) || '').trim().slice(0, 100);
    if (!author) return { ok: false, code: 'comment_invalid', message: '请填写昵称', status: 400 };
    const email = String((body && body.author_email) || '').trim().slice(0, 200);
    const aurl = String((body && body.author_url) || '').trim().slice(0, 300);
    let parent = parseInt((body && body.parent) || 0, 10) || 0;

    const post = await env.D1_DATABASE.prepare("SELECT wp_id FROM posts WHERE wp_id = ? AND status = 'published' LIMIT 1").bind(postId).first();
    if (!post) return { ok: false, code: 'comment_invalid', message: '文章不存在', status: 404 };

    // 父评论校验（两件事，都退化处理而不是报错 —— 用户不该因为层级问题被拒）：
    //   ① 必须存在，且属于**同一篇文章**（否则可以把评论挂到别的文章下面，造成跨文章串树）
    //   ② 挂上去后不能超过 MAX_DEPTH 层，否则退化为顶层（渲染层还有一道平铺兜底）
    if (parent) {
        const okParent = await env.D1_DATABASE.prepare(
            'SELECT comment_id FROM comments WHERE comment_id = ? AND post_id = ?'
        ).bind(parent, postId).first();
        if (!okParent) {
            parent = 0;
        } else if (await ancestorDepth(env.D1_DATABASE, parent) >= MAX_DEPTH) {
            parent = 0;
        }
    }

    // D1 主键：Worker 端诞生的评论用时间戳形态（与 posts 的 wp_id 规则一致；回拉后由 wp_comment_id 映射）
    const id = Date.now() * 100 + Math.floor(Math.random() * 100);
    const approved = (accept === 'auto') ? 1 : 0;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    try {
        await env.D1_DATABASE.prepare(
            "INSERT INTO comments (comment_id, wp_comment_id, post_id, parent_id, author, author_email, author_url, avatar, date_text, date, content, approved, type, origin, updated_at) " +
            "VALUES (?, 0, ?, ?, ?, ?, ?, '', '', ?, ?, ?, 'comment', 'worker', ?)"
        ).bind(id, postId, parent, author, email, aurl, now, content, approved, now).run();
    } catch (e) {
        console.error('createComment:', e);
        return { ok: false, code: 'comment_failed', message: '写入失败', status: 500 };
    }
    return {
        ok: true,
        comment: {
            id: id, post: postId, parent: parent, author_name: author, author_url: aurl,
            date: now, status: approved ? 'approved' : 'hold',
            content: { rendered: content, raw: content },
            origin: 'worker',
        },
    };
}
