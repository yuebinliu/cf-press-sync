/* CFSE 管理后台 - 原生 JS（无框架） */
(function () {
  'use strict';

  var LS_A = 'cfse_access';
  var LS_R = 'cfse_refresh';

  function getA() { return localStorage.getItem(LS_A) || ''; }
  function setA(t) { localStorage.setItem(LS_A, t); }
  function getR() { return localStorage.getItem(LS_R) || ''; }
  function setR(t) { localStorage.setItem(LS_R, t); }
  function clearTokens() { localStorage.removeItem(LS_A); localStorage.removeItem(LS_R); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var flashTimer = null;
  function flash(el, msg, type) {
    var box = document.getElementById(el);
    if (!box) return;
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    if (!msg) { box.innerHTML = ''; box.className = 'flash'; return; }
    box.innerHTML = (type === 'ok' ? '✅ ' : '⚠️ ') + esc(msg);
    box.className = 'flash ' + (type === 'ok' ? 'ok' : 'err');
    // 自动消失：成功 3.5s、错误 6s
    flashTimer = setTimeout(function () { box.innerHTML = ''; box.className = 'flash'; flashTimer = null; }, type === 'ok' ? 3500 : 6000);
  }

  function refreshToken() {
    var r = getR();
    if (!r) return Promise.reject(new Error('no-refresh'));
    return fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: r }),
    }).then(function (res) { return res.json(); }).then(function (d) {
      if (d.access) { setA(d.access); return d.access; }
      throw new Error('refresh-fail');
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var access = getA();
    if (access) headers['Authorization'] = 'Bearer ' + access;
    if (opts.body && typeof opts.body !== 'string' && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    var attempt = function (retried) {
      return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
        if (res.status === 401 && !retried) {
          return refreshToken().then(function () {
            headers['Authorization'] = 'Bearer ' + getA();
            return attempt(true);
          }).catch(function () { clearTokens(); return Promise.reject(new Error('auth')); });
        }
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status >= 400) { var e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
          return data;
        });
      });
    };
    return attempt(false);
  }

  function needAuth() {
    var has = getA();
    document.getElementById('login-card').classList.toggle('hidden', !!has);
    document.getElementById('view').style.display = has ? 'block' : 'none';
    document.getElementById('topbar').classList.toggle('hidden', !has);
    return !!has;
  }

  /* ---------- 登录 / 退出 ---------- */
  // 顶部导航点击：即使 hash 未变化（如在编辑器内点「文章」）也强制重载对应视图
  document.querySelectorAll('header nav a').forEach(function (a) {
    a.addEventListener('click', function () { setTimeout(goNav, 0); });
  });

  function bindLogin() {
    document.getElementById('login-user').value = localStorage.getItem('cfse_last_user') || '';
    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      flash('flash-login', '', null);
      var u = document.getElementById('login-user').value.trim();
      var p = document.getElementById('login-pass').value;
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      }).then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
        .then(function (r) {
          if (r.status === 200 && r.d.access) {
            setA(r.d.access); setR(r.d.refresh);
            localStorage.setItem('cfse_last_user', u);
            document.getElementById('login-pass').value = '';
            boot();
          } else {
            flash('flash-login', r.d.error || '登录失败', 'err');
          }
        }).catch(function () { flash('flash-login', '网络错误', 'err'); });
    });
  }

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'btn-logout') {
      clearTokens();
      location.hash = '';
      boot();
    }
  });

  /* ---------- 文章列表 ---------- */
  var postsState = { page: 1, q: '', status: '', sort: 'date_desc', taxType: '', taxSlug: '', taxName: '' };
  var editorDirty = false;
  window.addEventListener('beforeunload', function (e) {
    if (editorDirty) {
      try {
        var t = document.getElementById('f-title');
        var eb = document.getElementById('ed-body');
        if (t) localStorage.setItem('cfse_draft', JSON.stringify({ title: t.value, content: eb ? eb.innerHTML : '', ts: Date.now() }));
      } catch (e2) {}
      e.preventDefault(); e.returnValue = '';
    }
  });
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details[data-menu][open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
    var t = e.target;
    if (t && t.closest) {
      var it = t.closest('details[data-menu] [data-copylink], details[data-menu] [data-dup], details[data-menu] [data-rebuild]');
      if (it) { var dd = it.closest('details'); if (dd) dd.removeAttribute('open'); }
    }
  });

  /* ---------- 最近编辑 ---------- */
  function rememberRecent(wpId, title) {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem('cfse_recent') || '[]') || []; } catch (e) {}
    arr = arr.filter(function (x) { return x.wp_id !== wpId; });
    arr.unshift({ wp_id: wpId, title: String(title || '').slice(0, 60) });
    arr = arr.slice(0, 8);
    try { localStorage.setItem('cfse_recent', JSON.stringify(arr)); } catch (e) {}
  }
  function renderRecentChips() {
    var row = document.getElementById('recent-row');
    if (!row) return;
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem('cfse_recent') || '[]') || []; } catch (e) {}
    if (!arr.length) { row.style.display = 'none'; return; }
    row.style.display = '';
    row.innerHTML = '<span class="muted">最近编辑：</span>' + arr.map(function (x) {
      return '<button class="btn btn-sm" data-open="' + x.wp_id + '" title="' + esc(x.title) + '">' + esc(x.title.slice(0, 18)) + (x.title.length > 18 ? '…' : '') + '</button>';
    }).join(' ');
    row.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        api('/api/posts/' + b.getAttribute('data-open')).then(function (row2) { renderEditor(row2); }).catch(function () {
          var arr2 = [];
          try { arr2 = JSON.parse(localStorage.getItem('cfse_recent') || '[]') || []; } catch (e) {}
          localStorage.setItem('cfse_recent', JSON.stringify(arr2.filter(function (x) { return x.wp_id !== Number(b.getAttribute('data-open')); })));
          renderRecentChips();
          flash('flash-main', '文章不存在或已删除', 'err');
        });
      });
    });
  }

  function renderPosts() {
    var sec = document.getElementById('view-posts');
    sec.innerHTML =
      '<div id="recent-row" class="toolbar" style="flex-wrap:wrap;display:none;margin:0 0 8px;"></div>' +
      '<div class="muted" id="posts-stats" style="margin:2px 0 10px;"></div>' +
      '<div class="toolbar" style="flex-wrap:wrap;">' +
      '<button class="btn btn-primary" id="btn-new-post">＋ 新建文章</button>' +
      '<button class="btn" id="btn-audit">🔍 质检报告</button>' +
      '<input type="text" id="post-search" placeholder="搜索标题/正文…" value="' + esc(postsState.q) + '">' +
      '<select id="post-status"><option value="">全部状态</option><option value="published"' + (postsState.status === 'published' ? ' selected' : '') + '>已发布</option><option value="draft"' + (postsState.status === 'draft' ? ' selected' : '') + '>草稿</option></select>' +
      '<select id="post-sort"><option value="date_desc"' + (postsState.sort === 'date_desc' ? ' selected' : '') + '>日期最新</option><option value="date_asc"' + (postsState.sort === 'date_asc' ? ' selected' : '') + '>日期最早</option><option value="title_asc"' + (postsState.sort === 'title_asc' ? ' selected' : '') + '>标题 A-Z</option></select>' +
      '<span class="muted" style="margin-left:8px;">批量：</span>' +
      '<button class="btn btn-sm" id="btn-batch-pub" disabled>发布</button> ' +
      '<button class="btn btn-sm" id="btn-batch-draft" disabled>转草稿</button> ' +
      '<button class="btn btn-sm" id="btn-batch-cats" disabled>设分类</button> ' +
      '<button class="btn btn-sm btn-danger" id="btn-batch-del" disabled>删除</button>' +
      '<span class="muted" id="batch-count" style="margin-left:6px;"></span>' +
      '</div>' +
      (postsState.taxType && postsState.taxSlug ? '<div class="toolbar" style="margin-top:8px;"><span class="muted">筛选：' + (postsState.taxType === 'tag' ? '标签' : '分类') + '「' + esc(postsState.taxName || postsState.taxSlug) + '」</span> <button class="btn btn-sm" id="tax-clear">✕ 清除筛选</button></div>' : '') +
      '<div class="card grid" id="audit-panel" style="display:none;"></div>' +
      '<div class="card grid" id="posts-box">加载中…</div>';

    document.getElementById('btn-new-post').addEventListener('click', function () { renderEditor(null); });
    document.getElementById('btn-audit').addEventListener('click', function () {
      var panel = document.getElementById('audit-panel');
      var show = panel.style.display === 'none';
      panel.style.display = show ? '' : 'none';
      if (show) renderAudit();
    });
    renderRecentChips();
    ['pub', 'draft', 'cats', 'del'].forEach(function (a) {
      document.getElementById('btn-batch-' + a).addEventListener('click', function () {
        var ids = [];
        document.querySelectorAll('[data-chk]:checked').forEach(function (c) { ids.push(Number(c.value)); });
        if (!ids.length) return;
        var action = { pub: 'publish', cats: 'setcats', del: 'delete' }[a] || a;
        if (action === 'delete' && !confirm('删除选中的 ' + ids.length + ' 篇文章？')) return;
        var extra = {};
        if (action === 'setcats') {
          var v = prompt('把选中的 ' + ids.length + ' 篇文章设为以下分类（逗号分隔，会替换原分类）：');
          if (v === null) return;
          v = v.trim();
          if (!v) return;
          extra.categories = splitNames(v);
        }
        api('/api/posts/batch', { method: 'POST', body: Object.assign({ ids: ids, action: action }, extra) }).then(function (d) {
          flash('flash-main', (action === 'del' ? '已删除 ' : '已处理 ') + d.done + ' 篇', 'ok');
          loadPosts();
        }).catch(function (e) { flash('flash-main', e.message, 'err'); });
      });
    });
    document.getElementById('view-posts').addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute) return;
      var pbox = document.getElementById('posts-box');
      if (t.id === 'chk-all') {
        // 表头全选：勾/取消本页所有行
        if (pbox) pbox.querySelectorAll('[data-chk]').forEach(function (c) { c.checked = t.checked; });
      } else if (t.hasAttribute('data-chk')) {
        // 单行勾选 → 同步表头全选的「全选/半选」态
        var allck = document.getElementById('chk-all');
        if (allck && pbox) {
          var alln = pbox.querySelectorAll('[data-chk]').length;
          var seln = pbox.querySelectorAll('[data-chk]:checked').length;
          allck.checked = alln > 0 && seln === alln;
          allck.indeterminate = seln > 0 && seln < alln;
        }
      } else {
        return;
      }
      var cnt = document.querySelectorAll('[data-chk]:checked').length;
      ['pub', 'draft', 'cats', 'del'].forEach(function (a) {
        var b = document.getElementById('btn-batch-' + a);
        if (b) b.disabled = cnt === 0;
      });
      var bc = document.getElementById('batch-count');
      if (bc) bc.textContent = cnt ? ('已选 ' + cnt + ' 篇') : '';
    });
    api('/api/stats').then(function (s) {
      var el = document.getElementById('posts-stats');
      if (el) {
        var mb = s.mediaBytes || 0;
        var sizeTxt = (mb >= 1048576 ? (mb / 1048576).toFixed(1) + 'MB' : Math.round(mb / 1024) + 'KB');
        el.textContent = '共 ' + s.posts + ' 篇（已发布 ' + s.published + ' · 草稿 ' + s.draft + '） · 分类 ' + s.categories + ' · 标签 ' + s.tags + ' · 媒体 ' + (s.media >= 0 ? s.media + ' 个 (' + sizeTxt + ')' : '?');
      }
    }).catch(function () {});
    document.getElementById('post-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { postsState.q = this.value.trim(); postsState.page = 1; loadPosts(); }
    });
    document.getElementById('post-status').addEventListener('change', function () {
      postsState.status = this.value; postsState.page = 1; loadPosts();
    });
    document.getElementById('post-sort').addEventListener('change', function () {
      postsState.sort = this.value; postsState.page = 1; loadPosts();
    });
    var taxClear = document.getElementById('tax-clear');
    if (taxClear) taxClear.addEventListener('click', function () {
      postsState.taxType = ''; postsState.taxSlug = ''; postsState.taxName = ''; postsState.page = 1;
      // renderPosts()（而非 loadPosts）——整视图重建才会把「筛选：…」条移除
      renderPosts();
    });
    loadPosts();
  }

  function loadPosts() {
    var box = document.getElementById('posts-box');
    var qs = 'page=' + postsState.page + '&per=20' +
      (postsState.q ? '&q=' + encodeURIComponent(postsState.q) : '') +
      (postsState.status ? '&status=' + postsState.status : '') +
      (postsState.taxType && postsState.taxSlug ? '&type=' + postsState.taxType + '&tax=' + encodeURIComponent(postsState.taxSlug) : '');
    var so = { date_desc: ['date', 'desc'], date_asc: ['date', 'asc'], title_asc: ['title', 'asc'] }[postsState.sort] || ['date', 'desc'];
    qs += '&sort=' + so[0] + '&dir=' + so[1];
    api('/api/posts?' + qs).then(function (d) {
      var rows = (d.posts || []).map(function (p) {
        var cats = '';
        try { cats = (JSON.parse(p.categories || '[]') || []).map(function (c) { return c.name; }).join(', '); } catch (e) {}
        var tags = '';
        try { tags = (JSON.parse(p.tags || '[]') || []).map(function (t) { return t.name; }).join(', '); } catch (e) {}
        var link = '<a href="/' + esc(p.slug) + '/" target="_blank" data-inedit="' + p.wp_id + '">' + esc(p.title) + '</a>';
        var thumb = p.featured_image ? '<img src="' + esc(p.featured_image) + '" onerror="this.style.display=\'none\'" style="height:34px;max-width:52px;object-fit:cover;border-radius:3px;vertical-align:middle;margin-right:8px;" alt="">' : '';
        return '<tr><td><input type="checkbox" data-chk="' + p.wp_id + '" value="' + p.wp_id + '"></td><td>' + thumb + link +
          (p.status === 'draft' ? ' <span style="color:#b32d2e;font-size:12px;">草稿</span>' : '') + '</td>' +
          '<td>' + esc(String(p.date || '').slice(0, 10)) + '</td>' +
          '<td>' + esc(cats) + '</td><td>' + esc(tags) + '</td>' +
          '<td style="white-space:nowrap;position:relative;">' +
          '<button class="btn btn-sm" data-edit="' + p.wp_id + '">编辑</button> ' +
          '<button class="btn btn-sm btn-danger" data-del="' + p.wp_id + '">删除</button> ' +
          '<details style="display:inline-block;position:relative;vertical-align:middle;" data-menu>' +
          '<summary class="btn btn-sm" style="list-style:none;cursor:pointer;display:inline-block;">⋯</summary>' +
          '<div style="position:absolute;right:0;top:calc(100% + 4px);background:#fff;border:1px solid #ddd;border-radius:6px;z-index:6;box-shadow:0 2px 8px rgba(0,0,0,.15);min-width:140px;padding:6px;">' +
          '<div style="padding:2px 0;"><button class="btn btn-sm" data-copylink="' + esc(p.slug) + '" style="width:100%;text-align:left;">复制链接</button></div>' +
          '<div style="padding:2px 0;"><button class="btn btn-sm" data-dup="' + p.wp_id + '" style="width:100%;text-align:left;">复制为草稿</button></div>' +
          '<div style="padding:2px 0;"><button class="btn btn-sm" data-rebuild="' + p.wp_id + '" style="width:100%;text-align:left;">重建单页</button></div>' +
          '</div></details></td></tr>';
      }).join('');
      var empty = rows ? '' : '<tr><td colspan="6" class="muted">暂无文章</td></tr>';
      box.innerHTML = '<table><thead><tr><th style="width:26px;"><input type="checkbox" id="chk-all" title="全选本页"></th><th>标题</th><th>日期</th><th>分类</th><th>标签</th><th>操作</th></tr></thead><tbody>' + rows + empty + '</tbody></table>' +
        '<div class="pager">' +
        (postsState.page > 1 ? '<button class="btn btn-sm" data-pg="' + (postsState.page - 1) + '">← 上一页</button>' : '') +
        '<span class="muted">第 ' + d.page + ' / ' + (d.pages || 1) + ' 页 · 共 ' + d.total + ' 篇</span>' +
        (postsState.page < (d.pages || 1) ? '<button class="btn btn-sm" data-pg="' + (postsState.page + 1) + '">下一页 →</button>' : '') +
        '</div>';
      var bc0 = document.getElementById('batch-count');
      if (bc0) bc0.textContent = '';
      var allck0 = document.getElementById('chk-all');
      if (allck0) { allck0.checked = false; allck0.indeterminate = false; }

      box.querySelectorAll('[data-inedit]').forEach(function (a) {
        a.addEventListener('dblclick', function (e) {
          e.preventDefault();
          var cur = a.textContent;
          var td = a.parentNode;
          var inp = document.createElement('input');
          inp.value = cur;
          inp.style.width = '70%';
          td.replaceChild(inp, a);
          inp.focus();
          var finish = function (save) {
            var v = inp.value.trim();
            if (save && v && v !== cur) {
              api('/api/posts/' + a.getAttribute('data-inedit'), { method: 'PUT', body: { title: v } }).then(function () {
                flash('flash-main', '标题已更新', 'ok'); loadPosts();
              }).catch(function (err) { loadPosts(); flash('flash-main', err.message, 'err'); });
            } else { loadPosts(); }
          };
          inp.addEventListener('blur', function () { finish(false); });
          inp.addEventListener('keydown', function (e2) {
            if (e2.key === 'Enter') { e2.preventDefault(); finish(true); }
            else if (e2.key === 'Escape') { loadPosts(); }
          });
        });
      });
      box.querySelectorAll('[data-copylink]').forEach(function (b) {
        b.addEventListener('click', function () {
          var url = location.origin + '/' + b.getAttribute('data-copylink') + '/';
          copyText(url, function () { flash('flash-main', '链接已复制', 'ok'); }, function () { flash('flash-main', url, 'ok'); });
        });
      });
      box.querySelectorAll('[data-dup]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/posts/' + b.getAttribute('data-dup') + '/duplicate', { method: 'POST' }).then(function () {
            flash('flash-main', '已复制为草稿', 'ok');
            loadPosts();
          }).catch(function (e) { flash('flash-main', e.message, 'err'); });
        });
      });
      box.querySelectorAll('[data-rebuild]').forEach(function (b) {
        b.addEventListener('click', function () {
          api('/api/posts/' + b.getAttribute('data-rebuild') + '/rebuild', { method: 'POST' }).then(function (d) {
            flash('flash-main', d.rebuilt ? '单页已重建' : '草稿无需重建', 'ok');
          }).catch(function (e) { flash('flash-main', e.message, 'err'); });
        });
      });
      box.querySelectorAll('[data-edit]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-edit');
          api('/api/posts/' + id).then(function (p) { renderEditor(p); });
        });
      });
      box.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-del');
          if (!confirm('确认删除该文章？（D1 数据与 R2 静态文件将一并删除）')) return;
          api('/api/posts/' + id, { method: 'DELETE' }).then(function () {
            flash('flash-main', '已删除', 'ok');
            loadPosts();
          }).catch(function (err) { flash('flash-main', err.message, 'err'); });
        });
      });
      box.querySelectorAll('[data-pg]').forEach(function (b) {
        b.addEventListener('click', function () { postsState.page = parseInt(b.getAttribute('data-pg'), 10); loadPosts(); });
      });
    }).catch(function (err) {
      box.innerHTML = '';
      flash('flash-main', err.message, 'err');
      if (err.message === 'auth') location.hash = '';
    });
  }

  /* ---------- 文章编辑 ---------- */
  function renderEditor(post) {
    var p = post || {};
    editorDirty = false;
    if (p.wp_id) rememberRecent(p.wp_id, p.title);
    var sec = document.getElementById('view-posts');
    sec.addEventListener('input', function () { editorDirty = true; });
    var curCats = [];
    try { curCats = (JSON.parse(p.categories || '[]') || []).map(function (c) { return c.name; }); } catch (e) {}
    var curTags = [];
    try { curTags = (JSON.parse(p.tags || '[]') || []).map(function (t) { return t.name; }); } catch (e) {}
    var dateVal = (String(p.date || '').length >= 16) ? String(p.date).slice(0, 16).replace(' ', 'T') : '';
    sec.innerHTML = '<h1>' + (p.wp_id ? '编辑文章' : '新建文章') + '</h1>' +
      '<div class="card">' +
      '<label>标题 *</label><input type="text" id="f-title" value="' + esc(p.title || '') + '">' +
      '<div class="row"><div><label>固定链接 (slug，留空自动)</label><input type="text" id="f-slug" value="' + esc(p.slug || '') + '"></div>' +
      '<div><label>状态</label><select id="f-status"><option value="published"' + (p.status === 'published' || !p.status ? ' selected' : '') + '>发布</option><option value="draft"' + (p.status === 'draft' ? ' selected' : '') + '>草稿</option></select></div>' +
      '<div><label>发布日期（留空=现在）</label><input type="datetime-local" id="f-date" value="' + dateVal + '"></div></div>' +
      '<div class="row"><div><label>分类</label>' +
      '<div style="position:relative;"><input type="text" id="f-cats" autocomplete="off" placeholder="点击选择，或直接输入新分类" value="' + esc(curCats.join(', ')) + '">' +
      '<div id="pop-cats" style="display:none;position:absolute;z-index:30;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.14);width:100%;max-height:220px;overflow:auto;margin-top:2px;"></div></div></div>' +
      '<div><label>标签</label>' +
      '<div style="position:relative;"><input type="text" id="f-tags" autocomplete="off" placeholder="点击选择，或直接输入新标签" value="' + esc(curTags.join(', ')) + '">' +
      '<div id="pop-tags" style="display:none;position:absolute;z-index:30;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.14);width:100%;max-height:220px;overflow:auto;margin-top:2px;"></div></div></div></div>' +
      '<label>封面图 URL（可选）</label><div style="display:flex;gap:6px;"><input type="url" id="f-image" placeholder="https://..." value="' + esc(p.featured_image || '') + '">' +
      '<button type="button" class="btn btn-sm" id="btn-first-img" title="从正文第一张图片取为封面">取正文首图</button></div>' +
      '<div style="margin-top:12px; display:flex; gap:8px; align-items:center;"><button class="btn" type="button" id="btn-upload">🖼 上传图片并插入正文</button>' +
      '<button class="btn" type="button" id="btn-lib">📁 从媒体库选择</button><input type="file" id="f-file" accept="image/*" multiple hidden></div>' +
      '<div id="lib-mask" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99;">' +
      '<div style="max-width:780px;margin:7vh auto;background:#fff;border-radius:8px;padding:16px 18px;max-height:80vh;overflow:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;"><h1 style="font-size:17px;margin:0;">媒体库</h1><button class="btn btn-sm" id="lib-close">✕ 关闭</button></div>' +
      '<div id="lib-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:12px;"></div>' +
      '<div style="margin-top:12px;"><button class="btn btn-sm" id="lib-more" style="display:none;">加载更多</button></div></div></div>' +
      '<div id="draft-banner" style="display:none;background:#fff4e5;border:1px solid #ffcf8a;border-radius:6px;padding:8px 12px;margin-bottom:12px;">检测到未保存的草稿 <button class="btn btn-sm" id="draft-restore">恢复</button> <button class="btn btn-sm" id="draft-discard">丢弃</button></div>' +
      '<label style="margin-top:14px;">正文</label>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">' +
      '<button type="button" class="btn btn-sm btn-primary" data-ed-mode="wysiwyg">✍ 富文本</button>' +
      '<button type="button" class="btn btn-sm" data-ed-mode="md">Markdown</button>' +
      '<button type="button" class="btn btn-sm" id="btn-ed-full" title="全屏编辑">⛶</button>' +
      '<span class="muted" style="font-size:12px;" id="ed-stat"></span></div>' +
      '<div id="ed-wysiwyg">' +
      '<div id="ed-tb" style="border:1px solid #ccc;border-radius:6px 6px 0 0;background:#f6f7f7;padding:4px 6px;display:flex;flex-wrap:wrap;gap:2px;">' +
      '<button type="button" class="btn btn-sm" data-cmd="bold" title="加粗"><b>B</b></button>' +
      '<button type="button" class="btn btn-sm" data-cmd="italic" title="斜体"><i>I</i></button>' +
      '<button type="button" class="btn btn-sm" data-cmd="underline" title="下划线"><u>U</u></button>' +
      '<button type="button" class="btn btn-sm" data-cmd="strikeThrough" title="删除线"><s>S</s></button>' +
      '<button type="button" class="btn btn-sm" data-cmd="undo" title="撤销">↶</button>' +
      '<button type="button" class="btn btn-sm" data-cmd="redo" title="重做">↷</button>' +
      '<button type="button" class="btn btn-sm" data-blk="h2">H2</button>' +
      '<button type="button" class="btn btn-sm" data-blk="h3">H3</button>' +
      '<button type="button" class="btn btn-sm" data-blk="blockquote">引用</button>' +
      '<button type="button" class="btn btn-sm" data-cmd="insertUnorderedList">• 列表</button>' +
      '<button type="button" class="btn btn-sm" data-cmd="insertOrderedList">1.列表</button>' +
      '<button type="button" class="btn btn-sm" data-blk="pre" title="代码块">代码</button>' +
      '<button type="button" class="btn btn-sm" data-link>链接</button>' +
      '<button type="button" class="btn btn-sm" data-cmd="insertHorizontalRule">—</button>' +
      '<button type="button" class="btn btn-sm" data-cmd="removeFormat">清除格式</button>' +
      '</div>' +
      '<div id="ed-body" contenteditable="true" style="border:1px solid #ccc;border-top:0;border-radius:0 0 6px 6px;min-height:320px;padding:12px 14px;line-height:1.7;overflow:auto;"></div></div>' +
      '<div id="ed-md" style="display:none;">' +
      '<div style="display:flex;gap:10px;">' +
      '<textarea id="f-content-md" style="flex:1;min-height:320px;font-family:ui-monospace,Consolas,monospace;font-size:13px;padding:8px;"></textarea>' +
      '<div id="ed-md-prev" style="flex:1;border:1px solid #eee;border-radius:6px;padding:10px 14px;min-height:320px;overflow:auto;line-height:1.7;"></div></div>' +
      '<p class="muted" style="font-size:12px;margin:6px 0 0;">Markdown 模式：左侧书写、右侧实时预览；保存时自动转换为 HTML 入库。</p></div>' +
      '<textarea id="f-content" style="display:none;"></textarea>' +
      '<label style="margin-top:14px;">摘要（可选，留空自动截取正文前 200 字）</label><textarea id="f-excerpt" style="min-height:60px;">' + esc(p.excerpt || '') + '</textarea>' +
      '<div style="margin-top:14px; display:flex; gap:8px;">' +
      '<button class="btn btn-primary" id="btn-save">💾 保存</button>' +
      '<button class="btn" id="btn-cancel">返回列表</button>' +
      '</div></div>';

    document.getElementById('btn-first-img').addEventListener('click', function () {
      var src = '';
      if (edMode === 'md') {
        var pv = document.getElementById('ed-md-prev');
        var im = pv && pv.querySelector('img');
        if (im) src = im.getAttribute('src') || '';
      } else {
        var im2 = edBody.querySelector('img');
        if (im2) src = im2.getAttribute('src') || '';
      }
      if (!src) { flash('flash-main', '正文中没有图片', 'err'); return; }
      document.getElementById('f-image').value = src;
      flash('flash-main', '已取正文首图为封面', 'ok');
    });
    // ===== 富文本 / Markdown 双模式编辑器 =====
    // docFormat = 本文档的格式（编辑已有文档时取其 content_format；新建默认 html）。
    // 只有"本文档格式"对应的页签可编辑，另一个页签是**只读预览** ——
    // 绝不能把一边的内容塞进另一边（那会把 md 原稿污染成 HTML，且保存后 format 与内容不符）。
    var docFormat = ((p.content_format === 'md') && p.content) ? 'md' : 'html';
    var edMode = docFormat === 'md' ? 'md' : 'wysiwyg';
    var edBody = document.getElementById('ed-body');
    var mdArea = document.getElementById('f-content-md');
    if (docFormat === 'md') {
      mdArea.value = p.content;
      edBody.innerHTML = mdToHtml(p.content);
    } else {
      edBody.innerHTML = p.content || '';
      mdArea.value = p.content || '';
    }
    function mdToHtml(src) {
      try { return (window.marked && marked.parse) ? marked.parse(src) : String(src || ''); } catch (e) { return String(src || ''); }
    }
    function renderMdPrev() {
      var pv = document.getElementById('ed-md-prev');
      if (pv) pv.innerHTML = mdToHtml(mdArea.value);
    }
    function edSync() {
      document.getElementById('f-content').value = edBody.innerHTML;
      var t = (edBody.textContent || '').trim();
      var el = document.getElementById('ed-stat');
      if (el) el.textContent = t ? ('约 ' + t.length + ' 字') : '';
    }
    edBody.addEventListener('input', function () { edSync(); });
    mdArea.addEventListener('input', function () { editorDirty = true; renderMdPrev(); });
    edSync(); renderMdPrev();
    function setEdMode(m) {
      edMode = m;
      document.getElementById('ed-wysiwyg').style.display = m === 'wysiwyg' ? '' : 'none';
      document.getElementById('ed-md').style.display = m === 'md' ? '' : 'none';
      var bodyEditable = (docFormat === 'html' && m === 'wysiwyg');
      edBody.setAttribute('contenteditable', bodyEditable ? 'true' : 'false');
      edBody.style.background = bodyEditable ? '' : '#f6f7f7';
      var mdEditable = (docFormat === 'md' && m === 'md');
      mdArea.readOnly = !mdEditable;
      mdArea.style.background = mdEditable ? '' : '#f6f7f7';
      document.querySelectorAll('[data-ed-mode]').forEach(function (b) {
        b.classList.toggle('btn-primary', b.getAttribute('data-ed-mode') === m);
      });
    }
    document.querySelectorAll('[data-ed-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = b.getAttribute('data-ed-mode');
        var isEmptyNew = !p.wp_id && !String(edBody.textContent || '').trim() && !String(mdArea.value || '').trim();
        if (isEmptyNew) {
          // 新建且还没内容时，点页签 = 选择本文档格式（一旦有内容就只能靠"格式"栏切换）
          docFormat = (m === 'md') ? 'md' : 'html';
        }
        if (docFormat === 'md') {
          // 富文本区 = md 的只读渲染预览
          edBody.innerHTML = mdToHtml(mdArea.value);
        } else {
          // md 页签 = HTML 源码的只读预览
          mdArea.value = edBody.innerHTML;
          renderMdPrev();
        }
        setEdMode(m);
        if ((m === 'wysiwyg' && docFormat === 'md') || (m === 'md' && docFormat === 'html')) {
          flash('flash-main', '该页签是只读预览（本文档格式：' + (docFormat === 'md' ? 'Markdown' : 'HTML') + '）', 'ok');
        }
      });
    });
    setEdMode(edMode);
    function editorContent() {
      // 永远返回"本文档格式"的内容（md 文档返回 md 原稿，而非渲染后的 HTML）
      return (docFormat === 'md') ? mdArea.value : edBody.innerHTML;
    }
    document.getElementById('btn-ed-full').addEventListener('click', function () {
      document.body.classList.toggle('ed-full');
      var b = document.getElementById('btn-ed-full');
      if (b) b.textContent = document.body.classList.contains('ed-full') ? '⛶ 退出全屏' : '⛶';
      window.scrollTo(0, 0);
    });
    // 富文本工具栏
    document.getElementById('ed-tb').querySelectorAll('[data-cmd]').forEach(function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        edBody.focus();
        var cmd = b.getAttribute('data-cmd');
        if (cmd === 'formatBlock') { document.execCommand('formatBlock', false, '<' + (b.getAttribute('data-val') || 'p') + '>'); }
        else { document.execCommand(cmd); }
        edSync();
      });
    });
    document.getElementById('ed-tb').querySelectorAll('[data-blk]').forEach(function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        edBody.focus();
        document.execCommand('formatBlock', false, '<' + b.getAttribute('data-blk') + '>');
        edSync();
      });
    });
    var linkBtn = document.querySelector('#ed-tb [data-link]');
    if (linkBtn) linkBtn.addEventListener('click', function () {
      var u = prompt('链接 URL：');
      if (u) { edBody.focus(); document.execCommand('createLink', false, u); edSync(); }
    });
    // 自动草稿（新建页提示恢复；刷新/离开时同步保存）
    if (!p.wp_id) {
      var dbtn = document.getElementById('draft-banner');
      var draftSaved = null;
      try { draftSaved = JSON.parse(localStorage.getItem('cfse_draft') || 'null'); } catch (e) {}
      if (dbtn && draftSaved && draftSaved.content) {
        dbtn.style.display = '';
        document.getElementById('draft-restore').addEventListener('click', function () {
          document.getElementById('f-title').value = draftSaved.title || '';
          edBody.innerHTML = draftSaved.content || '';
          edSync();
          dbtn.style.display = 'none';
        });
        document.getElementById('draft-discard').addEventListener('click', function () {
          localStorage.removeItem('cfse_draft');
          dbtn.style.display = 'none';
        });
      }
    }

    document.getElementById('btn-cancel').addEventListener('click', function () { renderPosts(); });
    // 分类/标签：一个可输入框 + 点击弹出的选择列表（已选高亮可切换；也可直接输入新名称）
    var renderEditorCache = {};
    function taxTokens(id) {
      return String(document.getElementById(id).value).split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    function taxItems(type, cb) {
      var k = type === 'tag' ? 'tagCache' : 'catCache';
      if (renderEditorCache[k]) { cb(renderEditorCache[k]); return; }
      api(type === 'tag' ? '/api/tags' : '/api/categories').then(function (d) {
        renderEditorCache[k] = d.items || [];
        cb(renderEditorCache[k]);
      }).catch(function () {});
    }
    function drawTaxPop(type, items) {
      var pop = document.getElementById(type === 'tag' ? 'pop-tags' : 'pop-cats');
      var tokens = taxTokens(type === 'tag' ? 'f-tags' : 'f-cats');
      // 不做输入过滤：点开永远显示全部，已选排最前且高亮（可点击取消）；输入仅用于直接新增
      var sorted = (items || []).slice().sort(function (a, b) {
        var ai = tokens.indexOf(a.name) >= 0 ? 0 : 1;
        var bi = tokens.indexOf(b.name) >= 0 ? 0 : 1;
        return ai - bi || String(a.name).localeCompare(String(b.name), 'zh');
      });
      var html = sorted.map(function (x) {
        var on = tokens.indexOf(x.name) >= 0;
        return '<div data-taxi="' + type + '" data-tn="' + esc(x.name) + '" style="padding:7px 10px;cursor:pointer;border-bottom:1px solid #f2f2f2;' + (on ? 'background:#e8f0fe;' : '') + '">' +
          (on ? '✓ ' : '') + esc(x.name) + ' <span class="muted" style="font-size:12px;">(' + (x.cnt || 0) + ')</span></div>';
      }).join('');
      pop.innerHTML = html || '<div class="muted" style="padding:8px 10px;">（暂无，可直接在上方输入新' + (type === 'tag' ? '标签' : '分类') + '）</div>';
      pop.querySelectorAll('[data-taxi]').forEach(function (el) {
        el.addEventListener('mousedown', function (e) { e.preventDefault(); toggleTaxItem(el.getAttribute('data-taxi'), el.getAttribute('data-tn')); });
      });
    }
    function toggleTaxItem(type, name) {
      var id = type === 'tag' ? 'f-tags' : 'f-cats';
      var tokens = taxTokens(id);
      var i = tokens.indexOf(name);
      if (i >= 0) { tokens.splice(i, 1); } else { tokens.push(name); }
      document.getElementById(id).value = tokens.join(', ');
      editorDirty = true;
      drawTaxPop(type, renderEditorCache[type === 'tag' ? 'tagCache' : 'catCache'] || []);
    }
    function bindTaxCombo(type) {
      var id = type === 'tag' ? 'f-tags' : 'f-cats';
      var popId = type === 'tag' ? 'pop-tags' : 'pop-cats';
      var inp = document.getElementById(id);
      inp.addEventListener('focus', function () {
        taxItems(type, function (items) {
          drawTaxPop(type, items);
          var pop = document.getElementById(popId);
          if (pop) pop.style.display = '';
        });
      });
      inp.addEventListener('input', function () {
        editorDirty = true;
        taxItems(type, function (items) { drawTaxPop(type, items); });
      });
      inp.addEventListener('blur', function () {
        setTimeout(function () { var pop = document.getElementById(popId); if (pop) pop.style.display = 'none'; }, 180);
      });
    }
    bindTaxCombo('category');
    bindTaxCombo('tag');

    document.getElementById('btn-upload').addEventListener('click', function () {
      document.getElementById('f-file').click();
    });
    // ---- 媒体库选择器 ----
    var libCursor = null;
    function insertImgTag(url, alt) {
      var tag = '<img src="' + esc(url) + '" alt="' + esc(alt || '') + '" />';
      if (edMode === 'md') {
        mdArea.value += (mdArea.value ? '\n\n' : '') + '![' + esc(alt || '') + '](' + url + ')';
        renderMdPrev();
      } else {
        edBody.focus();
        document.execCommand('insertHTML', false, tag);
        edSync();
      }
      flash('flash-main', '已插入图片', 'ok');
    }
    function loadLib(cursor) {
      var list = document.getElementById('lib-list');
      api('/api/media' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (d) {
        var html = (d.items || []).map(function (it) {
          var alt = it.key.split('/').pop().replace(/\.[a-z0-9]+$/, '');
          return '<div style="border:1px solid #eee;border-radius:6px;padding:6px;">' +
            '<img src="' + esc(it.url) + '" style="width:100%;height:90px;object-fit:cover;border-radius:4px;" alt="">' +
            '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">' +
            '<button class="btn btn-sm" data-lib-ins="' + esc(it.url) + '" data-alt="' + esc(alt) + '">插入</button>' +
            '<button class="btn btn-sm" data-lib-cov="' + esc(it.url) + '">作封面</button></div></div>';
        }).join('');
        if (cursor) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html;
        var more = document.getElementById('lib-more');
        if (more) more.style.display = d.truncated ? '' : 'none';
        libCursor = d.cursor || null;
        list.querySelectorAll('[data-lib-ins]').forEach(function (b) {
          b.addEventListener('click', function () {
            insertImgTag(b.getAttribute('data-lib-ins'), b.getAttribute('data-alt'));
          });
        });
        list.querySelectorAll('[data-lib-cov]').forEach(function (b) {
          b.addEventListener('click', function () {
            var f = document.getElementById('f-image');
            if (f) f.value = b.getAttribute('data-lib-cov');
            flash('flash-main', '已设为封面图', 'ok');
          });
        });
      }).catch(function (e) { flash('flash-main', e.message, 'err'); });
    }
    document.getElementById('btn-lib').addEventListener('click', function () {
      libCursor = null;
      document.getElementById('lib-mask').style.display = '';
      loadLib();
    });
    document.getElementById('lib-close').addEventListener('click', function () { document.getElementById('lib-mask').style.display = 'none'; });
    document.getElementById('lib-mask').addEventListener('click', function (e) { if (e.target.id === 'lib-mask') this.style.display = 'none'; });
    document.getElementById('lib-more').addEventListener('click', function () { loadLib(libCursor); });
    document.getElementById('f-file').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (files.length) uploadManyIntoEditor(files);
    });
    // 富文本主体支持拖拽/粘贴图片直接上传（md 模式请用上传按钮）
    var edEvt = edBody;
    edEvt.addEventListener('dragover', function (e) { e.preventDefault(); });
    edEvt.addEventListener('drop', function (e) {
      e.preventDefault();
      var fs = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []).filter(function (f) { return /^image\//.test(f.type); });
      if (fs.length) uploadManyIntoEditor(fs);
    });
    edEvt.addEventListener('paste', function (e) {
      var it = e.clipboardData && e.clipboardData.items;
      if (!it) return;
      for (var i = 0; i < it.length; i++) {
        if (it[i].kind === 'file' && /^image\//.test(it[i].type)) {
          e.preventDefault();
          uploadIntoEditor(it[i].getAsFile());
          break;
        }
      }
    });
    function uploadIntoEditor(file) { return uploadManyIntoEditor([file]); }
    function uploadManyIntoEditor(files) {
      var btn = document.getElementById('btn-upload');
      var old = btn.innerHTML;
      var done = 0;
      var total = files.length;
      btn.textContent = '上传中 0/' + total + '…';
      btn.disabled = true;
      return files.reduce(function (p, f) {
        return p.then(function () {
          return uploadOneToEditor(f).then(function () {
            done++;
            btn.textContent = '上传中 ' + done + '/' + total + '…';
          });
        });
      }, Promise.resolve()).then(function () {
        btn.innerHTML = old; btn.disabled = false;
        flash('flash-main', total > 1 ? ('已上传 ' + done + ' 张图片并插入正文') : '图片已上传并插入正文', 'ok');
      }).catch(function (err) {
        btn.innerHTML = old; btn.disabled = false;
        flash('flash-main', '上传中断（成功 ' + done + '/' + total + '）：' + err.message, 'err');
      });
    }
    function uploadOneToEditor(file) {
      var fd = new FormData();
      fd.append('file', file);
      return api('/api/media', { method: 'POST', body: fd }).then(function (d) {
        if (!d || !d.url) throw new Error('上传失败');
        var alt = String(file.name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, ' ').trim().slice(0, 60);
        if (edMode === 'md') {
          mdArea.value += (mdArea.value ? '\n\n' : '') + '![' + esc(alt) + '](' + d.url + ')';
          renderMdPrev();
        } else {
          edBody.focus();
          document.execCommand('insertHTML', false, '<img src="' + esc(d.url) + '" alt="' + esc(alt) + '" />');
          edSync();
        }
        return d;
      });
    }
    document.getElementById('btn-save').addEventListener('click', function () {
      var payload = {
        title: document.getElementById('f-title').value.trim(),
        slug: document.getElementById('f-slug').value.trim(),
        status: document.getElementById('f-status').value,
        content: (docFormat === 'md') ? mdArea.value : edBody.innerHTML,
        content_format: docFormat,
        excerpt: document.getElementById('f-excerpt') ? document.getElementById('f-excerpt').value.trim() : '',
        featured_image: document.getElementById('f-image').value.trim(),
        categories: splitNames(document.getElementById('f-cats').value),
        tags: splitNames(document.getElementById('f-tags').value),
      };
      var dv = document.getElementById('f-date') ? document.getElementById('f-date').value : '';
      if (dv) payload.date = dv.replace('T', ' ') + ':00';
      if (!payload.title) { flash('flash-main', '标题不能为空', 'err'); return; }
      var path = p.wp_id ? '/api/posts/' + p.wp_id : '/api/posts';
      var method = p.wp_id ? 'PUT' : 'POST';
      api(path, { method: method, body: payload }).then(function () {
        try { localStorage.removeItem('cfse_draft'); } catch (e) {}
        flash('flash-main', '已保存' + (payload.status === 'published' ? '（前台列表已刷新）' : '（草稿，前台不显示）'), 'ok');
        renderPosts();
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });
  }

  function splitNames(s) {
    return String(s || '').split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) { return { name: x }; });
  }

  /* ---------- 分类 / 标签 ---------- */
  function taxPanel(type, label) {
    var el = document.createElement('div');
    el.className = 'card grid';
    el.innerHTML = '<h1>' + label + '</h1>' +
      '<div class="toolbar"><input type="text" placeholder="新增' + label + '名称" data-add="' + type + '"><button class="btn btn-primary" data-addbtn="' + type + '">新增</button></div>' +
      '<table><thead><tr><th>名称</th><th>slug</th><th>文章数</th><th>操作</th></tr></thead><tbody data-tbody="' + type + '"><tr><td colspan="4" class="muted">加载中…</td></tr></tbody></table>';
    var host = document.getElementById(type === 'categories' ? 'cats-wrap' : 'tags-wrap');
    if (!host) return el;
    host.innerHTML = '';
    host.appendChild(el);

    el.querySelector('[data-addbtn="' + type + '"]').addEventListener('click', function () {
      var name = el.querySelector('[data-add="' + type + '"]').value.trim();
      if (!name) return;
      api('/api/' + type, { method: 'POST', body: { name: name } }).then(function () {
        loadTax(type);
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });
    loadTax(type);
    return el;
  }

  function loadTax(type) {
    var tbody = document.querySelector('[data-tbody="' + type + '"]');
    if (!tbody) return;
    api('/api/' + type).then(function (d) {
      var rows = (d.items || []).map(function (it) {
        return '<tr><td>' + esc(it.name) + '</td><td class="muted">' + esc(it.slug) + '</td><td>' + (it.cnt || 0) + '</td>' +
          '<td style="white-space:nowrap;">' +
          '<button class="btn btn-sm" data-taxlist="' + (type === 'categories' ? 'category' : 'tag') + '" data-slug="' + esc(it.slug) + '" data-name="' + esc(it.name) + '">文章</button> ' +
          '<button class="btn btn-sm" data-renameterm="' + type + '" data-slug="' + esc(it.slug) + '">改名</button> ' +
          '<button class="btn btn-sm btn-danger" data-delterm="' + type + '" data-slug="' + esc(it.slug) + '">删除</button></td></tr>';
      }).join('');
      tbody.innerHTML = rows || '<tr><td colspan="4" class="muted">空</td></tr>';
      tbody.querySelectorAll('[data-taxlist]').forEach(function (b) {
        b.addEventListener('click', function () {
          postsState.taxType = b.getAttribute('data-taxlist');
          postsState.taxSlug = b.getAttribute('data-slug');
          postsState.taxName = b.getAttribute('data-name') || '';
          postsState.q = ''; postsState.status = ''; postsState.sort = 'date_desc'; postsState.page = 1;
          location.hash = 'posts';
        });
      });
      tbody.querySelectorAll('[data-renameterm]').forEach(function (b) {
        b.addEventListener('click', function () {
          var slug = b.getAttribute('data-slug');
          var t = b.getAttribute('data-renameterm');
          var name = prompt('输入新名称：', slug);
          if (name === null) return;
          name = name.trim();
          if (!name) { flash('flash-main', '名称不能为空', 'err'); return; }
          api('/api/' + t + '/' + encodeURIComponent(slug), { method: 'PUT', body: { name: name } }).then(function () {
            flash('flash-main', '已改名', 'ok');
            loadTax(t);
          }).catch(function (err) { flash('flash-main', err.message, 'err'); });
        });
      });
      tbody.querySelectorAll('[data-delterm]').forEach(function (b) {
        b.addEventListener('click', function () {
          var slug = b.getAttribute('data-slug');
          var t = b.getAttribute('data-delterm');
          if (!confirm('删除该' + (t === 'categories' ? '分类' : '标签') + '？相关文章的关联会被移除。')) return;
          api('/api/' + t + '/' + encodeURIComponent(slug), { method: 'DELETE' }).then(function () {
            flash('flash-main', '已删除', 'ok');
            loadTax(t);
          }).catch(function (err) { flash('flash-main', err.message, 'err'); });
        });
      });
    }).catch(function (err) { tbody.innerHTML = '<tr><td colspan="4">' + esc(err.message) + '</td></tr>'; });
  }

  function renderTax() {
    var sec = document.getElementById('view-tax');
    sec.innerHTML = '<div id="cats-wrap"></div><div id="tags-wrap"></div>';
    taxPanel('categories', '分类');
    taxPanel('tags', '标签');
  }

  /* ---------- 媒体库 ---------- */
  /* ---------- 媒体库（增强版） ---------- */
  var mstate = { items: [], cursor: null, truncated: false, q: '', sort: 'time', view: 'grid', loaded: false };

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function fmtTime(t) {
    var s = String(t || '');
    if (!s) return '—';
    try { return new Date(s).toISOString().slice(0, 16).replace('T', ' '); } catch (e) { return s.slice(0, 16); }
  }
  function mediaFiltered() {
    var q = mstate.q.toLowerCase();
    var arr = mstate.items.filter(function (it) {
      if (!q) return true;
      return String(it.key).toLowerCase().indexOf(q) >= 0;
    });
    var by = mstate.sort;
    arr.sort(function (a, b) {
      if (by === 'size') return (b.size || 0) - (a.size || 0);
      if (by === 'name') return String(a.key).localeCompare(String(b.key));
      if (by === 'time-asc') return String(a.uploaded || '').localeCompare(String(b.uploaded || ''));
      return String(b.uploaded || '').localeCompare(String(a.uploaded || ''));
    });
    return arr;
  }
  function mediaSelKeys() {
    var keys = [];
    document.querySelectorAll('[data-mdel]:checked').forEach(function (c) { keys.push(c.value); });
    return keys;
  }
  function mediaSyncBar() {
    var keys = mediaSelKeys();
    var btn = document.getElementById('media-del-sel');
    if (btn) { btn.style.display = keys.length ? '' : 'none'; btn.textContent = '删除选中（' + keys.length + '）'; }
    var info = document.getElementById('media-info');
    if (info) {
      var f = mediaFiltered();
      info.textContent = '已加载 ' + mstate.items.length + ' 个' + (mstate.q ? ('，匹配 ' + f.length + ' 个') : '') + (mstate.truncated ? '（还有更多）' : '');
    }
  }

  function renderMedia() {
    var sec = document.getElementById('view-media');
    sec.innerHTML = '<h1>媒体库</h1>' + '<style>' + "/* 控件一行；窄屏把后半段折进「更多」 */.mbar{display:flex;gap:8px;align-items:center;flex-wrap:nowrap;margin:0 0 12px;}.mbar .mbar-main{display:flex;gap:8px;align-items:center;min-width:0;flex:1 1 auto;}.mbar .mbar-extra{display:flex;gap:8px;align-items:center;flex:0 0 auto;}.mbar .mbar-info{flex:0 0 auto;}#mbar-more{display:none;}@media (max-width:1000px){  .mbar{flex-wrap:wrap;}  .mbar .mbar-extra{display:none;}  #mbar-more{display:inline-block;margin-left:auto;}  .mbar.open .mbar-extra{display:flex;flex-wrap:wrap;flex:1 1 100%;margin-top:8px;}  .mbar.open #mbar-more{margin-left:auto;}}.mbar input[type=text]{padding:7px 11px;border:1px solid #d5d9de;border-radius:6px;font-size:13px;outline:none;}.mbar select{padding:7px 9px;border:1px solid #d5d9de;border-radius:6px;font-size:13px;background:#fff;}.mgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;}.mcard{position:relative;border:1px solid #e3e5e8;border-radius:10px;overflow:hidden;background:#fff;}.mcard img{display:block;width:100%;height:130px;object-fit:cover;background:#f6f7f9;cursor:zoom-in;}.mcard .mname{font-size:12px;color:#555;padding:7px 9px 2px;word-break:break-all;line-height:1.35;}.mcard .mmeta{font-size:11px;color:#98a1ab;padding:0 9px 8px;display:flex;justify-content:space-between;gap:6px;}.mcard .mops{display:flex;gap:4px;padding:0 8px 9px;}.mcard .mops .btn{padding:3px 7px;font-size:11.5px;}.mcard .mchk{position:absolute;left:8px;top:8px;width:18px;height:18px;z-index:2;cursor:pointer;}.mcard.on{outline:2px solid #1d4ed8;outline-offset:-2px;}.mlight{position:fixed;inset:0;background:rgba(12,16,22,.82);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:24px;}.mlight img{max-width:92vw;max-height:80vh;border-radius:6px;background:#fff;}.mlight .mcap{color:#e8ecf1;font-size:13px;word-break:break-all;text-align:center;max-width:90vw;}.mlight .mclose{color:#fff;border:1px solid rgba(255,255,255,.5);background:transparent;border-radius:6px;padding:6px 16px;cursor:pointer;}.mbox{transition:background .15s;}.mbox.drag{background:#eef4ff;outline:2px dashed #9db8e8;}" + '</style>' +
      '<div class="mbar" id="media-bar">' +
      '<div class="mbar-main">' +
      '<button class="btn btn-sm btn-primary" id="media-up">📤 上传图片</button>' +
      '<input type="file" id="media-up-file" accept="image/*" multiple hidden>' +
      '<input type="text" id="media-q" placeholder="筛选文件名…" style="min-width:120px;max-width:220px;">' +
      '</div>' +
      '<div class="mbar-extra">' +
      '<select id="media-sort">' +
      '<option value="time">时间：新→旧</option><option value="time-asc">时间：旧→新</option>' +
      '<option value="size">大小：大→小</option><option value="name">名称 A→Z</option></select>' +
      '<select id="media-view"><option value="grid">网格</option><option value="table">列表</option></select>' +
      '<button class="btn btn-sm btn-danger" id="media-del-sel" style="display:none;">删除选中</button>' +
      '</div>' +
      '<span class="muted mbar-info" id="media-info"></span>' +
      '<button class="btn btn-sm" id="mbar-more">⋯ 更多</button>' +
      '</div>' +
      '<div class="card grid mbox" id="media-box">加载中…</div>' +
      '<div id="media-more-wrap" style="margin-top:12px;"></div>';

    var box = document.getElementById('media-box');
    var fileEl = document.getElementById('media-up-file');

    document.getElementById('media-up').addEventListener('click', function () { fileEl.click(); });
    fileEl.addEventListener('change', function () {
      var files = [].slice.call(fileEl.files || []);
      if (files.length) mediaUpload(files);
      fileEl.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      box.addEventListener(ev, function (e) { e.preventDefault(); box.classList.remove('drag'); });
    });
    box.addEventListener('drop', function (e) {
      var files = [].slice.call((e.dataTransfer && e.dataTransfer.files) || []).filter(function (f) { return /^image\//.test(f.type); });
      if (files.length) mediaUpload(files);
    });

    document.getElementById('mbar-more').addEventListener('click', function () {
      document.getElementById('media-bar').classList.toggle('open');
    });
    document.getElementById('media-q').addEventListener('input', function () { mstate.q = this.value.trim(); renderMediaList(); });
    document.getElementById('media-sort').addEventListener('change', function () { mstate.sort = this.value; renderMediaList(); });
    document.getElementById('media-view').addEventListener('change', function () { mstate.view = this.value; renderMediaList(); });
    document.getElementById('media-del-sel').addEventListener('click', function () {
      var keys = mediaSelKeys();
      if (!keys.length) return;
      if (!confirm('删除选中的 ' + keys.length + ' 个媒体文件？引用它们的文章将显示为缺失。')) return;
      Promise.all(keys.map(function (k) { return api('/api/media?key=' + encodeURIComponent(k), { method: 'DELETE' }); }))
        .then(function () { flash('flash-main', '已删除 ' + keys.length + ' 个文件', 'ok'); loadMedia(true); })
        .catch(function (e) { flash('flash-main', e.message, 'err'); loadMedia(true); });
    });
    box.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-mdel')) {
        var card = t.closest ? t.closest('.mcard') : null;
        if (card) card.classList.toggle('on', t.checked);
        mediaSyncBar();
      }
    });

    loadMedia(true);
  }

  function mediaUpload(files) {
    var info = document.getElementById('media-info');
    var ok = 0, bad = [];
    function next(i) {
      if (i >= files.length) {
        if (info) info.textContent = '上传完成：成功 ' + ok + ' 个' + (bad.length ? ('，失败 ' + bad.length + ' 个（' + bad.join('、') + '）') : '');
        loadMedia(true);
        return;
      }
      var f = files[i];
      if (info) info.textContent = '上传中 ' + (i + 1) + '/' + files.length + '：' + f.name;
      var fd = new FormData();
      fd.append('file', f);
      api('/api/media', { method: 'POST', body: fd }).then(function () { ok++; })
        .catch(function () { bad.push(f.name); })
        .then(function () { next(i + 1); });
    }
    next(0);
  }

  function renderMediaList() {
    var box = document.getElementById('media-box');
    var arr = mediaFiltered();
    if (!arr.length) {
      box.innerHTML = '<p class="muted" style="margin:8px 0;">' + (mstate.items.length ? '没有匹配的文件' : '暂无媒体（可点「📤 上传图片」或把图片拖进来）') + '</p>';
      mediaSyncBar();
      return;
    }
    if (mstate.view === 'table') {
      var rows = arr.map(function (it) {
        return '<tr><td><input type="checkbox" data-mdel="' + esc(it.key) + '" value="' + esc(it.key) + '"></td>' +
          '<td><img src="' + esc(it.url) + '" loading="lazy" data-zoom="' + esc(it.url) + '" style="height:42px;max-width:80px;object-fit:cover;border-radius:3px;cursor:zoom-in;" alt=""></td>' +
          '<td class="muted">' + esc(it.key.split('/').pop()) + '</td>' +
          '<td class="muted">' + fmtSize(it.size) + '</td>' +
          '<td class="muted">' + fmtTime(it.uploaded) + '</td>' +
          '<td style="white-space:nowrap;"><button class="btn btn-sm" data-copy="' + esc(it.url) + '">复制URL</button> ' +
          '<button class="btn btn-sm" data-replkey="' + esc(it.key) + '">替换</button> ' +
          '<button class="btn btn-sm btn-danger" data-delkey="' + esc(it.key) + '">删除</button></td></tr>';
      }).join('');
      box.innerHTML = '<table><thead><tr><th style="width:26px;"></th><th>预览</th><th>文件名</th><th>大小</th><th>上传时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    } else {
      box.innerHTML = '<div class="mgrid">' + arr.map(function (it) {
        var name = it.key.split('/').pop();
        return '<div class="mcard">' +
          '<input type="checkbox" class="mchk" data-mdel="' + esc(it.key) + '" value="' + esc(it.key) + '" title="选中">' +
          '<img src="' + esc(it.url) + '" loading="lazy" data-zoom="' + esc(it.url) + '" alt="' + esc(name) + '">' +
          '<div class="mname" title="' + esc(it.key) + '">' + esc(name) + '</div>' +
          '<div class="mmeta"><span>' + fmtSize(it.size) + '</span><span>' + fmtTime(it.uploaded).slice(0, 10) + '</span></div>' +
          '<div class="mops"><button class="btn btn-sm" data-copy="' + esc(it.url) + '">复制URL</button>' +
          '<button class="btn btn-sm" data-replkey="' + esc(it.key) + '">替换</button>' +
          '<button class="btn btn-sm btn-danger" data-delkey="' + esc(it.key) + '">删除</button></div></div>';
      }).join('') + '</div>';
    }

    box.querySelectorAll('[data-zoom]').forEach(function (img) {
      img.addEventListener('click', function () { mediaLightbox(img.getAttribute('data-zoom'), img.getAttribute('alt') || ''); });
    });
    box.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-copy');
        copyText(t, function () { flash('flash-main', 'URL 已复制', 'ok'); }, function () { flash('flash-main', t, 'ok'); });
      });
    });
    box.querySelectorAll('[data-delkey]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-delkey');
        if (!confirm('删除该媒体文件？引用它的页面将显示为缺失。')) return;
        api('/api/media?key=' + encodeURIComponent(key), { method: 'DELETE' })
          .then(function () { flash('flash-main', '已删除', 'ok'); loadMedia(true); })
          .catch(function (e) { flash('flash-main', e.message, 'err'); });
      });
    });
    box.querySelectorAll('[data-replkey]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-replkey');
        var inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.addEventListener('change', function () {
          var f = inp.files && inp.files[0];
          document.body.removeChild(inp);
          if (!f) return;
          if (!confirm('用该文件替换当前图片？（引用此图的文章 URL 不变，自动生效）')) return;
          var fd = new FormData();
          fd.append('file', f);
          b.disabled = true;
          api('/api/media?key=' + encodeURIComponent(key), { method: 'PUT', body: fd })
            .then(function () { flash('flash-main', '图片已替换', 'ok'); loadMedia(true); })
            .catch(function (e) { b.disabled = false; flash('flash-main', e.message, 'err'); });
        });
        inp.click();
      });
    });
    mediaSyncBar();
  }

  function mediaLightbox(url, name) {
    var d = document.createElement('div');
    d.className = 'mlight';
    d.innerHTML = '<img src="' + esc(url) + '" alt=""><div class="mcap">' + esc(name || '') + '<br>' + esc(url) + '</div>' +
      '<div><button class="mclose">关闭</button> <button class="mcopy btn btn-sm">复制 URL</button></div>';
    d.addEventListener('click', function (e) { if (e.target === d) document.body.removeChild(d); });
    d.querySelector('.mclose').addEventListener('click', function () { document.body.removeChild(d); });
    d.querySelector('.mcopy').addEventListener('click', function () { copyText(url, function () { flash('flash-main', 'URL 已复制', 'ok'); }, function () {}); });
    document.body.appendChild(d);
  }

  function loadMedia(reset) {
    var box = document.getElementById('media-box');
    if (reset) { mstate.items = []; mstate.cursor = null; mstate.truncated = false; }
    if (!mstate.loaded && box) box.textContent = '加载中…';
    var qs = mstate.cursor ? ('?cursor=' + encodeURIComponent(mstate.cursor)) : '?limit=100';
    api('/api/media' + qs).then(function (d) {
      mstate.loaded = true;
      mstate.items = mstate.items.concat(d.items || []);
      mstate.cursor = d.cursor || null;
      mstate.truncated = !!d.truncated;
      renderMediaList();
      var wrap = document.getElementById('media-more-wrap');
      if (wrap) {
        wrap.innerHTML = mstate.truncated ? '<button class="btn btn-sm" id="media-more">加载更多</button>' : '';
        var more = document.getElementById('media-more');
        if (more) more.addEventListener('click', function () { loadMedia(false); });
      }
    }).catch(function (e) {
      mstate.loaded = true;
      if (box) box.innerHTML = '';
      flash('flash-main', e.message, 'err');
    });
  }
  /* ---------- 用户管理（仅管理员可见有效操作） ---------- */
  function renderUsers() {
    var sec = document.getElementById('view-users');
    sec.innerHTML = '<h1>用户</h1><div class="card grid" id="users-load">加载中…</div>';
    api('/api/users').then(function (d) {
      var rows = (d.users || []).map(function (u) {
        return '<tr><td><strong>' + esc(u.user_login) + '</strong>' + (u.user_status === 0 ? ' <span style="color:#b32d2e;">已禁用</span>' : '') + '</td>' +
          '<td>' + esc(u.display_name || '') + '</td><td>' + esc(u.user_email || '') + '</td><td>' + esc(u.role || '') + '</td>' +
          '<td class="muted">' + esc(String(u.user_registered || '').slice(0, 10)) + '</td>' +
          '<td style="white-space:nowrap;"><button class="btn btn-sm" data-tgl="' + u.id + '" data-status="' + u.user_status + '">' + (u.user_status === 1 ? '禁用' : '启用') + '</button> ' +
          '<button class="btn btn-sm" data-pw="' + u.id + '">重置密码</button> ' +
          '<button class="btn btn-sm" data-ap="' + u.id + '" data-apname="' + esc(u.user_login) + '">🔑 应用密码</button> ' +
          '<button class="btn btn-sm btn-danger" data-deluser="' + u.id + '">删除</button></td></tr>';
      }).join('');
      var add = '<div class="toolbar" style="margin-top:12px;border-top:1px solid #eee;padding-top:12px;">' +
        '<input placeholder="用户名" id="u-name" style="max-width:130px;">' +
        '<input placeholder="密码(≥8)" type="password" id="u-pass" style="max-width:130px;">' +
        '<input placeholder="邮箱" id="u-email" style="max-width:170px;">' +
        '<input placeholder="昵称" id="u-disp" style="max-width:110px;">' +
        '<select id="u-role" style="max-width:100px;"><option value="editor">编辑</option><option value="author">作者</option><option value="admin">管理员</option><option value="subscriber">订阅者</option></select>' +
        '<button class="btn btn-primary" id="u-add">新增用户</button></div>';
      sec.innerHTML = '<h1>用户</h1><div class="card grid"><table><thead><tr><th>用户名</th><th>昵称</th><th>邮箱</th><th>角色</th><th>注册</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' + add + '</div>' +
        '<div class="card" id="ap-panel" style="margin-top:12px;display:none;"></div>';
      bindUserActions();
    }).catch(function (e) {
      sec.innerHTML = '<h1>用户</h1><div class="card"><p>' + (e.status === 403 ? '（仅管理员可管理用户）' : esc(e.message)) + '</p></div>';
    });
  }

  function bindUserActions() {
    var add = document.getElementById('u-add');
    if (add) add.addEventListener('click', function () {
      var body = {
        username: document.getElementById('u-name').value.trim(),
        password: document.getElementById('u-pass').value,
        email: document.getElementById('u-email').value.trim(),
        display_name: document.getElementById('u-disp').value.trim(),
        role: document.getElementById('u-role').value,
      };
      api('/api/users', { method: 'POST', body: body }).then(function () {
        flash('flash-main', '已新增用户', 'ok');
        renderUsers();
      }).catch(function (e) { flash('flash-main', e.message, 'err'); });
    });
    document.querySelectorAll('[data-tgl]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-tgl');
        var st = parseInt(b.getAttribute('data-status'), 10);
        api('/api/users/' + id, { method: 'PUT', body: { user_status: st === 1 ? 0 : 1 } }).then(function () {
          flash('flash-main', '已更新', 'ok');
          renderUsers();
        }).catch(function (e) { flash('flash-main', e.message, 'err'); });
      });
    });
    document.querySelectorAll('[data-pw]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-pw');
        var pw = prompt('输入该用户的新密码（至少 8 位）：');
        if (pw === null) return;
        api('/api/users/' + id, { method: 'PUT', body: { password: pw } }).then(function () {
          flash('flash-main', '密码已重置', 'ok');
        }).catch(function (e) { flash('flash-main', e.message, 'err'); });
      });
    });
    document.querySelectorAll('[data-deluser]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-deluser');
        if (!confirm('删除该用户？')) return;
        api('/api/users/' + id, { method: 'DELETE' }).then(function () {
          flash('flash-main', '已删除', 'ok');
          renderUsers();
        }).catch(function (e) { flash('flash-main', e.message, 'err'); });
      });
    });
    document.querySelectorAll('[data-ap]').forEach(function (b) {
      b.addEventListener('click', function () {
        renderAppPasswords(b.getAttribute('data-ap'), b.getAttribute('data-apname') || '');
      });
    });
  }

  /* ---------- 应用密码（第三方 md 编辑器认证用）---------- */
  function renderAppPasswords(uid, uname) {
    var host = document.getElementById('ap-panel');
    if (!host) return;
    host.style.display = 'block';
    host.innerHTML = '<h2 style="margin:6px 0;">🔑 ' + esc(uname) + ' 的应用密码</h2>' +
      '<p class="muted" style="margin:4px 0 10px;">给第三方 md 编辑器（Obsidian / Ulysses / 脚本）用：认证 <b>Basic Auth</b>，用户名 = <b>' + esc(uname) +
      '</b>，密码 = 下面生成的应用密码；接口路径 <code>/wp-json/wp/v2/</code>（文章写入默认按 Markdown 保存）。</p>' +
      '<table><thead><tr><th>名称</th><th>创建</th><th>最后使用</th><th>操作</th></tr></thead><tbody id="ap-tbody"><tr><td colspan="4" class="muted">加载中…</td></tr></tbody></table>' +
      '<div class="toolbar" style="margin-top:10px;"><button class="btn btn-primary" id="ap-new">＋ 生成新密码</button>' +
      '<button class="btn btn-sm" id="ap-close">收起</button></div>' +
      '<div id="ap-plain"></div>';

    function loadList() {
      api('/api/users/' + uid + '/app-passwords').then(function (d) {
        var rows = (d.items || []).map(function (x) {
          return '<tr><td>' + esc(x.name || '') + '</td>' +
            '<td class="muted">' + esc(String(x.created_at || '').slice(0, 16)) + '</td>' +
            '<td class="muted">' + esc(String(x.last_used_at || '').slice(0, 16) || '—') + '</td>' +
            '<td>' + (x.revoked ? '<span class="muted">已撤销</span>' : '<button class="btn btn-sm btn-danger" data-apdel="' + x.id + '">撤销</button>') + '</td></tr>';
        }).join('');
        var tb = document.getElementById('ap-tbody');
        if (tb) tb.innerHTML = rows || '<tr><td colspan="4" class="muted">还没有应用密码</td></tr>';
        host.querySelectorAll('[data-apdel]').forEach(function (d2) {
          d2.addEventListener('click', function () {
            if (!confirm('撤销这个应用密码？正在使用它的客户端会立即失效。')) return;
            api('/api/app-passwords/' + d2.getAttribute('data-apdel'), { method: 'DELETE' }).then(function () {
              flash('flash-main', '已撤销', 'ok');
              loadList();
            }).catch(function (e) { flash('flash-main', e.message, 'err'); });
          });
        });
      }).catch(function (e) {
        var tb = document.getElementById('ap-tbody');
        if (tb) tb.innerHTML = '<tr><td colspan="4" class="muted">读取失败：' + esc(e.message) + '</td></tr>';
      });
    }
    loadList();

    var nb = document.getElementById('ap-new');
    if (nb) nb.addEventListener('click', function () {
      var nm = prompt('给这个应用密码起个名字（便于日后辨认，如：Obsidian）：', 'Obsidian');
      if (nm === null) return;
      api('/api/users/' + uid + '/app-passwords', { method: 'POST', body: { name: nm } }).then(function (r) {
        document.getElementById('ap-plain').innerHTML = '<div style="margin:10px 0;padding:10px;background:#f0f6fc;border-left:4px solid #2271b1;">' +
          '<b>请立即保存（只显示这一次）：</b>' +
          '<p style="margin:6px 0;font-family:monospace;font-size:15px;user-select:all;">' + esc(r.password) + '</p>' +
          '<button class="btn btn-sm" id="ap-copy">复制</button></div>';
        var cb = document.getElementById('ap-copy');
        if (cb) cb.addEventListener('click', function () {
          if (navigator.clipboard) navigator.clipboard.writeText(r.password);
          flash('flash-main', '已复制到剪贴板', 'ok');
        });
        flash('flash-main', '已生成应用密码', 'ok');
        loadList();
      }).catch(function (e) { flash('flash-main', e.message, 'err'); });
    });
    var cl = document.getElementById('ap-close');
    if (cl) cl.addEventListener('click', function () { host.style.display = 'none'; });
  }

  /* ---------- 质检报告 ---------- */
  function renderAudit() {
    var panel = document.getElementById('audit-panel');
    panel.innerHTML = '加载中…';
    api('/api/audit').then(function (d) {
      function seg(title, n, items) {
        var rows = (items || []).map(function (it) {
          return '<div style="padding:5px 0;border-bottom:1px solid #f3f3f3;"><a href="#" data-open="' + it.wp_id + '">' + esc(it.title) + '</a> <span class="muted">/' + esc(it.slug) + '/</span></div>';
        }).join('');
        return '<div style="margin-bottom:16px;"><strong>' + title + '（' + n + '）</strong>' + (rows || '<div class="muted" style="padding:4px 0;">无</div>') + '</div>';
      }
      panel.innerHTML = seg('未设置分类', d.noCat, d.noCatItems) +
        seg('缺封面图', d.noFeature, d.noFeatureItems) +
        seg('标题超 80 字', d.longTitle, d.longTitleItems);
      panel.querySelectorAll('[data-open]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          api('/api/posts/' + a.getAttribute('data-open')).then(function (row) { renderEditor(row); }).catch(function (err) { flash('flash-main', err.message, 'err'); });
        });
      });
    }).catch(function (e) { panel.innerHTML = ''; flash('flash-main', e.message, 'err'); });
  }

  /* ---------- 设置（站点名 / 改密 / 内容维护） ---------- */
  function renderSettings() {
    var sec = document.getElementById('view-settings');
    var curCache = null;   // 设置页加载回来的 cache 全量（保存「批量任务」时合并用）
    sec.innerHTML = '<h1>设置</h1>' +
      '<div class="card"><h1 style="font-size:16px;">账号资料</h1>' +
      '<p class="muted" id="who-line">加载中…</p>' +
      '<div class="row"><div><label>昵称</label><input type="text" id="m-name"></div>' +
      '<div><label>邮箱</label><input type="email" id="m-email"></div></div>' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="m-save">保存资料</button></div></div>' +
      '<div class="card"><h1 style="font-size:16px;">站点信息</h1>' +
      '<p class="muted">站名用于标题/页脚/侧边栏（保存即清缓存生效，历史静态单页需重建或全量导出）。站点描述用于 RSS 频道描述。</p>' +
      '<label>站点名</label><input type="text" id="s-name">' +
      '<label>站点描述（用于 RSS 频道，可选）</label><textarea id="s-desc" style="min-height:54px;"></textarea>' +
      '<label>站点 logo URL（渲染 <code>{{SITE_LOGO}}</code>，留空则不显示该块）</label>' +
      '<div style="display:flex;gap:6px;align-items:center;"><input type="text" id="s-logo" placeholder="https://…/logo.png" style="flex:1;"><button class="btn btn-sm" data-pick="s-logo">📁 上传</button></div>' +
      '<label style="margin-top:8px;">站点横幅 URL（渲染 <code>{{SITE_BANNER}}</code>，页头横条图；留空则不显示）</label>' +
      '<div style="display:flex;gap:6px;align-items:center;"><input type="text" id="s-banner" placeholder="https://…/banner.jpg" style="flex:1;"><button class="btn btn-sm" data-pick="s-banner">📁 上传</button></div>' +
      '<p class="muted" style="margin:6px 0 0;">「上传」会存进媒体库/R2 并自动填地址（也可直接粘外链）。<b>注意</b>：WP 侧「同步站点信息」会用 WP 的值覆盖这两项。</p>' +
      '<label style="margin-top:10px;">文章单页布局</label>' +
      '<select id="s-layout"><option value="show">双列（显示侧边栏，默认）</option><option value="hide">单列（隐藏侧边栏，主内容占满）</option></select>' +
      '<p class="muted" style="margin:6px 0 0;">单列由 Worker 在<b>渲染单页时</b>注入一段 CSS（写进产出的 HTML，即最终形态）。已生成的静态单页需重建才会改变；切换配置不影响其它页面。</p>' +
      '<label style="margin-top:10px;">head 自定义 HTML（注入每个页面 <code>&lt;/head&gt;</code> 前）</label>' +
      '<textarea id="s-head-extra" style="min-height:64px;font-family:monospace;" placeholder=\'&lt;meta name="google-adsense-account" content="ca-pub-…"&gt;\'></textarea>' +
      '<p class="muted" style="margin:6px 0 0;">放 AdSense 验证 meta、统计代码等任意片段（原样输出，约 8KB 上限）。列表页保存即时生效；<b>已生成的静态单页</b>在访问时自动注入，无需重建。</p>' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="s-save">保存站点信息</button> <span class="muted" id="img-note"></span>' +
      '<input type="file" id="img-file" accept="image/*" hidden></div></div>' +
'<div class="card"><h1 style="font-size:16px;">🔗 社交账号</h1>' +
      '<p class="muted">渲染模板里的 <code>{{SOCIAL_LINKS}}</code>。每行一条：<code>平台|链接</code>（如 <code>facebook|https://facebook.com/xxx</code>）。平台名随意（facebook / twitter / instagram / github…）。</p>' +
      '<textarea id="soc-input" style="min-height:72px;font-family:monospace;" placeholder="facebook|https://facebook.com/xxx"></textarea>' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="soc-save">保存社交账号</button> <span class="muted" id="soc-note"></span></div></div>' +
      '<div class="card"><h1 style="font-size:16px;">🧭 导航菜单</h1>' +
      '<p class="muted">静态站的主导航，渲染模板里的 <code>{{MENU}}</code>。<b>与 WP 后台菜单不联动</b>（这里独立维护）。类型选「分类 / 标签」时第三列变成<b>下拉选择</b>（分类列出全部、标签只列最常用的 5 个），选完「显示文字」留空会自动填成它的名称；选「自定义链接 / 文章」沿用文本框（填 URL / slug）。「层级」用于二级菜单（层级比上一项深时自动挂到它下面）。</p>' +
      '<div id="menu-rows" style="display:flex;flex-direction:column;gap:6px;margin-top:8px;"></div>' +
      '<div style="margin-top:10px;"><button class="btn btn-sm" id="menu-add">＋ 添加菜单项</button> ' +
      '<button class="btn btn-primary" id="menu-save">保存菜单</button> <span class="muted" id="menu-note"></span></div></div>' +
            '<div class="card"><h1 style="font-size:16px;">缓存策略</h1>' +
      '<p class="muted">控制动态页（列表页 / 侧边栏 / RSS）的缓存方式；文章单页始终直读 R2。<b>这些缓存都放在 Cloudflare 边缘缓存（Cache API）里，不消耗 KV 额度</b>（KV 现在只存站点设置）；数值 <b>0 = 直查 D1 不缓存</b>。保存后即时生效（会自动清一次相关缓存）。</p>' +
      '<div style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap;">' +
      '<button class="btn btn-sm" id="cp-preset-d1">预设：全 D1（最省资源）</button>' +
      '<button class="btn btn-sm" id="cp-preset-mix">预设：混合（侧边栏缓存）</button>' +
      '<button class="btn btn-sm" id="cp-preset-kv">预设：全缓存（高流量）</button></div>' +
      '<div class="row"><div><label>列表页 TTL（秒，0=直查 D1）</label><input type="number" id="c-ttl-list" min="0"></div>' +
      '<div><label>侧边栏 TTL（秒，0=直查 D1）</label><input type="number" id="c-ttl-sidebar" min="0"></div>' +
      '<div><label>站点信息 TTL（秒，0=不缓存；唯一仍用 KV 的项）</label><input type="number" id="c-ttl-site" min="0"></div>' +
      '<div><label>Feed TTL（秒，0=不缓存；默认 4 小时）</label><input type="number" id="c-ttl-feed" min="0"></div>' +
      '<div><label>Feed 输出条数（1-100）</label><input type="number" id="c-feed-count" min="1" max="100"></div>' +
      '<div><label>列表每页文章数（1-100）</label><input type="number" id="c-per-page" min="1" max="100"></div></div>' +
      '<label style="margin-top:8px;display:block;"><input type="checkbox" id="c-purge"> 发布文章时清列表第一页/侧边栏缓存（走边缘缓存，<b>不消耗 KV</b>；想让「发布后立即刷新」就打开）</label>' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="c-save">保存缓存策略</button> <span class="muted" id="c-note"></span></div></div>' +
      '<div class="card"><h1 style="font-size:16px;">批量任务</h1>' +
      '<p class="muted">「重建全部单页」「permalink 迁移」等批量任务共用。<b>批量大小</b> = 每次请求处理多少篇；<b>并发数</b> = 一批里同时处理几篇。</p>' +
      '<div class="row"><div><label>批量大小（1-100）</label><input type="number" id="c-task-batch" min="1" max="100"></div>' +
      '<div><label>并发数（1-16）</label><input type="number" id="c-task-conc" min="1" max="16"></div></div>' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="c-task-save">保存批量任务设置</button> <span class="muted" id="c-task-note"></span></div></div>' +
      '<div class="card"><h1 style="font-size:16px;">URL 结构（permalink）</h1>' +
      '<p class="muted">决定文章单页的<b>地址形态</b>，同时也是它在 R2 里的<b>存储路径</b>（两者始终一致）。支持 <code>%postname%</code> <code>%year%</code> <code>%monthnum%</code> <code>%day%</code> <code>%post_id%</code> <code>%category%</code>（不支持 %author%）。<b>改结构后必须点「开始迁移」</b>，否则旧地址会 404（迁移会先把新结构复制一份、旧文件保留，全部完成才切换）。</p>' +
      '<label>当前</label><input type="text" id="pm-current" readonly>' +
      '<label>新结构（WP 风格，如 /%year%/%postname%/）</label><input type="text" id="pm-input" placeholder="/%postname%/">' +
      '<div style="margin-top:10px;">' +
      '<button class="btn" id="pm-preview">预览</button> ' +
      '<button class="btn" id="pm-switch">仅切换结构（不迁移）</button> ' +
      '<button class="btn btn-primary" id="pm-migrate">开始迁移</button> ' +
      '<button class="btn" id="pm-cleanup">清理旧文件</button> ' +
      '<button class="btn" id="pm-orphans">清理孤儿文件</button> ' +
      '<span class="muted" id="pm-note"></span></div>' +
      '<pre id="pm-out" class="muted" style="margin-top:10px;white-space:pre-wrap;font-size:12px;"></pre></div>' +
      '<div class="card"><h1 style="font-size:16px;">修改密码</h1>' +
      '<label>原密码</label><input type="password" id="p-old" autocomplete="current-password">' +
      '<label>新密码（至少 8 位）</label><input type="password" id="p-new" autocomplete="new-password">' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="p-save">修改密码</button></div></div>' +
      '<div class="card"><h1 style="font-size:16px;">内容维护</h1>' +
      '<p class="muted">用当前单页壳重建全部文章的静态单页（用于改名 / 换模板后统一旧单页外观与站点信息）。分批执行，页数多时请稍候。</p>' +
      '<div style="margin-top:10px;"><button class="btn btn-primary" id="rb-btn">重建全部单页</button> ' +
      '<button class="btn" id="purge-btn">清空全站缓存</button> <span class="muted" id="rb-prog"></span></div></div>' +
      '<div class="card"><h1 style="font-size:16px;">数据备份 / 恢复</h1>' +
      '<p class="muted">导出全部文章为 JSON；导入时按 slug 跳过已存在的文章，其余新增。</p>' +
      '<div style="margin-top:10px;"><button class="btn" id="exp-btn">导出备份</button> ' +
      '<button class="btn" id="imp-btn">导入备份</button> ' +
      '<input type="file" id="imp-file" accept=".json,application/json" hidden>' +
      '<span class="muted" id="bk-prog"></span></div></div>';

    api('/api/me').then(function (u) {
      document.getElementById('who-line').textContent = '登录用户：' + (u.username || '') + '（' + (u.role || '') + '）';
      document.getElementById('m-name').value = u.displayName || '';
      document.getElementById('m-email').value = u.email || '';
    }).catch(function (err) { flash('flash-main', err.message, 'err'); });

    document.getElementById('m-save').addEventListener('click', function () {
      api('/api/me', {
        method: 'PUT',
        body: { display_name: document.getElementById('m-name').value.trim(), email: document.getElementById('m-email').value.trim() },
      }).then(function () {
        flash('flash-main', '资料已保存', 'ok');
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    // ---- 社交账号（{{SOCIAL_LINKS}}；每行 service|url）----
    var socInput = document.getElementById('soc-input');
    function socParse(text) {
      return String(text || '').split(/\r?\n/).map(function (line) {
        var p = String(line).split('|');
        if (p.length < 2) return null;
        var url = p.slice(1).join('|').trim();
        if (!url) return null;
        return { service: String(p[0] || '').trim(), url: url };
      }).filter(function (x) { return x !== null; });
    }
    function socText(list) {
      return (list || []).map(function (x) { return (x.service || '') + '|' + (x.url || ''); }).join('\n');
    }
    document.getElementById('soc-save').addEventListener('click', function () {
      api('/api/settings', {
        method: 'PUT',
        body: {
          site: {
            name: document.getElementById('s-name').value.trim(),
            description: document.getElementById('s-desc').value.trim(),
            social: socParse(socInput.value),
          },
        },
      }).then(function () { flash('flash-main', '社交账号已保存', 'ok'); })
        .catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    // ---- 站点 logo / banner 上传（复用 /api/media，填进对应输入框）----
    (function () {
      var fileEl = document.getElementById('img-file');
      var noteEl = document.getElementById('img-note');
      var pickTarget = null;
      Array.prototype.forEach.call(document.querySelectorAll('[data-pick]'), function (b) {
        b.addEventListener('click', function () { pickTarget = b.getAttribute('data-pick'); fileEl.click(); });
      });
      fileEl.addEventListener('change', function () {
        var f = fileEl.files && fileEl.files[0];
        if (!f || !pickTarget) return;
        var fd = new FormData();
        fd.append('file', f);
        noteEl.textContent = '上传中…';
        api('/api/media', { method: 'POST', body: fd }).then(function (d) {
          if (!d || !d.url) throw new Error('上传失败');
          document.getElementById(pickTarget).value = d.url;
          noteEl.textContent = '已上传 —— 记得点「保存站点信息」';
        }).catch(function (err) { noteEl.textContent = err.message; })
          .then(function () { fileEl.value = ''; });
      });
    })();
    // ---- 导航菜单编辑（{{MENU}}；CMS 独立维护，与 WP 后台菜单不联动）----
    var menuRowsEl = document.getElementById('menu-rows');
    var MENU_TYPES = [['custom', '自定义链接'], ['category', '分类'], ['tag', '标签'], ['post', '文章']];
    var menuOptions = { categories: [], tags: [] };   // GET /api/menu/options：分类=全部，标签=最常用 5 个
    function menuTargetHtml(r) {
      if (r.type === 'category' || r.type === 'tag') {
        var list = (r.type === 'category') ? menuOptions.categories : menuOptions.tags;
        var o = list.map(function (it) {
          return '<option value="' + menuEsc(it.slug) + '"' + ((it.slug === r.target) ? ' selected' : '') + '>' +
            menuEsc(it.name || it.slug) + '</option>';
        }).join('');
        if (!list.length) o = '<option value="">（暂无' + (r.type === 'category' ? '分类' : '标签') + '）</option>';
        return '<select data-f="target" style="flex:1;min-width:90px;">' + o + '</select>';
      }
      return '<input type="text" data-f="target" placeholder="链接 / slug" value="' + menuEsc(r.target) + '" style="flex:1;min-width:90px;">';
    }
    function menuEsc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function menuRowHtml(r) {
      var opts = MENU_TYPES.map(function (t) {
        return '<option value="' + t[0] + '"' + ((r.type === t[0]) ? ' selected' : '') + '>' + t[1] + '</option>';
      }).join('');
      var dopts = [0, 1, 2].map(function (d) {
        return '<option value="' + d + '"' + ((Number(r.depth) === d) ? ' selected' : '') + '>' + (d === 0 ? '顶级' : '第' + (d + 1) + '级') + '</option>';
      }).join('');
      return '<div class="menu-row" style="display:flex;gap:6px;align-items:center;">' +
        '<select data-f="type" style="width:108px;">' + opts + '</select>' +
        '<input type="text" data-f="title" placeholder="显示文字" value="' + menuEsc(r.title) + '" style="flex:1;min-width:90px;">' +
        menuTargetHtml(r) +
        '<select data-f="depth" style="width:88px;">' + dopts + '</select>' +
        '<button class="btn btn-sm" data-act="up" title="上移">↑</button>' +
        '<button class="btn btn-sm" data-act="down" title="下移">↓</button>' +
        '<button class="btn btn-sm" data-act="del" title="删除">✕</button></div>';
    }
    function menuRead() {
      return [].map.call(menuRowsEl.querySelectorAll('.menu-row'), function (el) {
        return {
          type: el.querySelector('[data-f="type"]').value,
          title: el.querySelector('[data-f="title"]').value.trim(),
          target: el.querySelector('[data-f="target"]').value.trim(),
          depth: parseInt(el.querySelector('[data-f="depth"]').value, 10) || 0,
        };
      });
    }
    function menuRender(rows) {
      menuRowsEl.innerHTML = (rows || []).length
        ? rows.map(menuRowHtml).join('')
        : '<p class="muted">（暂无菜单项 —— 点「＋ 添加菜单项」）</p>';
    }
    function menuTreeToRows(list, depth, out) {
      out = out || [];
      (list || []).forEach(function (it) {
        out.push({ type: it.type || 'custom', title: it.title || '', target: it.target || '', depth: depth || 0 });
        if (Array.isArray(it.children) && it.children.length) { menuTreeToRows(it.children, (depth || 0) + 1, out); }
      });
      return out;
    }
    function menuRowsToTree(rows) {
      var root = [], stack = [];
      rows.forEach(function (r) {
        var d = Math.max(0, Math.min(2, r.depth));
        var node = { title: r.title, type: r.type, target: r.target };
        if (d === 0 || !stack[d - 1]) { root.push(node); stack[0] = node; stack.length = 1; }
        else { var p = stack[d - 1]; (p.children = p.children || []).push(node); stack[d] = node; stack.length = d + 1; }
      });
      return root;
    }
    // 类型切换 ⇒ 重渲染该行（第三列在 输入框/下拉 之间切换）；选中分类/标签 ⇒ 显示文字留空则自动带入名称
    var lastMenuTree = [];   // /api/settings 返回的菜单树；options 晚到重渲染时用它（menuRead 读占位 DOM 会把 target 磨成空串 ⇒ select 全落第一项）
    menuRowsEl.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var f = t.getAttribute('data-f');
      if (f === 'type') {
        var row = t.closest('.menu-row');
        var rows = menuRead();
        var i = [].indexOf.call(menuRowsEl.querySelectorAll('.menu-row'), row);
        if (i < 0) return;
        rows[i].type = t.value;
        rows[i].target = '';
        if (t.value === 'category' || t.value === 'tag') {
          var list = (t.value === 'category') ? menuOptions.categories : menuOptions.tags;
          if (list.length) { rows[i].target = list[0].slug; if (!rows[i].title) rows[i].title = list[0].name || list[0].slug; }
        }
        menuRender(rows);
        return;
      }
      if (f === 'target' && t.tagName === 'SELECT') {
        var titleInput = t.closest('.menu-row').querySelector('[data-f="title"]');
        if (titleInput && !titleInput.value.trim() && t.selectedIndex >= 0) titleInput.value = t.options[t.selectedIndex].text;
      }
    });
    // 载入可选项（失败静默：下拉为空时提示"暂无分类/标签"）
    api('/api/menu/options').then(function (d) {
      if (d && d.ok !== false) {
        menuOptions.categories = (d && d.categories) || [];
        menuOptions.tags = (d && d.tags) || [];
        // 重渲染数据源：优先用 settings 返回的树（若已到）；否则保留当前 DOM（用户可能已在编辑）
        // 不能无条件 menuRead()——settings 先渲染时若 options 未到，占位 option value="" 会被读成
        // target='' ⇒ 重渲染后 it.slug === '' 恒假 ⇒ 所有分类/标签下拉停在第一项（历史上"target 全变 hosting"即此因）。
        if (lastMenuTree.length) { menuRender(menuTreeToRows(lastMenuTree, 0)); }
      }
    }).catch(function () {});
    menuRowsEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!btn) return;
      var row = btn.closest('.menu-row');
      var rows = menuRead();
      var i = [].indexOf.call(menuRowsEl.querySelectorAll('.menu-row'), row);
      var act = btn.getAttribute('data-act');
      if (act === 'del') { rows.splice(i, 1); }
      else if (act === 'up' && i > 0) { var a = rows[i - 1]; rows[i - 1] = rows[i]; rows[i] = a; }
      else if (act === 'down' && i < rows.length - 1) { var b = rows[i + 1]; rows[i + 1] = rows[i]; rows[i] = b; }
      menuRender(rows);
    });
    document.getElementById('menu-add').addEventListener('click', function () {
      menuRender(menuRead().concat([{ type: 'custom', title: '', target: '', depth: 0 }]));
    });
    document.getElementById('menu-save').addEventListener('click', function () {
      var rows = menuRead();
      if (rows.some(function (r) { return !r.title || !r.target; })) {
        flash('flash-main', '有菜单项缺「显示文字」或「链接/slug」', 'err');
        return;
      }
      api('/api/settings', {
        method: 'PUT',
        body: {
          site: {
            name: document.getElementById('s-name').value.trim(),
            description: document.getElementById('s-desc').value.trim(),
            menu: menuRowsToTree(rows),
          },
        },
      }).then(function () {
        flash('flash-main', '菜单已保存（列表页即时生效；静态单页需重建）', 'ok');
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    api('/api/settings').then(function (d) {
      document.getElementById('s-name').value = (d.site && d.site.name) || '';
      document.getElementById('s-desc').value = (d.site && d.site.description) || '';
      document.getElementById('s-logo').value = (d.site && d.site.logo) || '';
      document.getElementById('s-banner').value = (d.site && d.site.banner) || '';
      document.getElementById('s-head-extra').value = (d.site && d.site.headExtra) || '';
      document.getElementById('s-layout').value = (d.site && d.site.layout && d.site.layout.singleSidebar) || 'show';
      socInput.value = socText((d.site && d.site.social) || []);
      var c = d.cache || {};
      document.getElementById('c-ttl-list').value = (c.ttl_list !== undefined ? c.ttl_list : 0);
      document.getElementById('c-ttl-sidebar').value = (c.ttl_sidebar !== undefined ? c.ttl_sidebar : 0);
      document.getElementById('c-ttl-site').value = (c.ttl_site !== undefined ? c.ttl_site : 604800);
      document.getElementById('c-ttl-feed').value = (c.ttl_feed !== undefined ? c.ttl_feed : 14400);
      document.getElementById('c-feed-count').value = (c.feed_count !== undefined ? c.feed_count : 20);
      document.getElementById('c-per-page').value = (c.per_page !== undefined ? c.per_page : 10);
      document.getElementById('c-purge').checked = !!c.purge_on_publish;
      document.getElementById('c-task-batch').value = (c.task_batch !== undefined ? c.task_batch : 20);
      document.getElementById('c-task-conc').value = (c.task_concurrency !== undefined ? c.task_concurrency : 4);
      curCache = c;
      lastMenuTree = (d.site && d.site.menu) || [];
      menuRender(menuTreeToRows(lastMenuTree, 0));
    }).catch(function (err) { flash('flash-main', err.message, 'err'); });

    // 缓存策略：三档预设 + 保存
    function fillCacheTtls(list, sidebar, site) {
      document.getElementById('c-ttl-list').value = list;
      document.getElementById('c-ttl-sidebar').value = sidebar;
      document.getElementById('c-ttl-site').value = site;
    }
    document.getElementById('cp-preset-d1').addEventListener('click', function () { fillCacheTtls(0, 0, 604800); flash('flash-main', '已填入「全 D1」预设，记得点保存', 'ok'); });
    document.getElementById('cp-preset-mix').addEventListener('click', function () { fillCacheTtls(0, 86400, 604800); flash('flash-main', '已填入「混合」预设，记得点保存', 'ok'); });
    document.getElementById('cp-preset-kv').addEventListener('click', function () { fillCacheTtls(3600, 86400, 604800); flash('flash-main', '已填入「全缓存」预设，记得点保存', 'ok'); });
    document.getElementById('c-save').addEventListener('click', function () {
      var body = {
        cache: {
          ttl_list: parseInt(document.getElementById('c-ttl-list').value, 10) || 0,
          ttl_sidebar: parseInt(document.getElementById('c-ttl-sidebar').value, 10) || 0,
          ttl_site: parseInt(document.getElementById('c-ttl-site').value, 10) || 0,
          ttl_feed: parseInt(document.getElementById('c-ttl-feed').value, 10) || 0,
          feed_count: Math.min(100, Math.max(1, parseInt(document.getElementById('c-feed-count').value, 10) || 20)),
          per_page: Math.min(100, Math.max(1, parseInt(document.getElementById('c-per-page').value, 10) || 10)),
          purge_on_publish: document.getElementById('c-purge').checked,
        },
      };
      api('/api/settings', { method: 'PUT', body: body }).then(function (r) {
        flash('flash-main', '缓存策略已保存并即时生效', 'ok');
        var n = document.getElementById('c-note');
        if (n && r.cache) n.textContent = '列表 ' + r.cache.ttl_list + 's · 每页 ' + (r.cache.per_page || 10) + ' 篇 · 侧边栏 ' + r.cache.ttl_sidebar + 's · 站点 ' + r.cache.ttl_site + 's · Feed ' + (r.cache.ttl_feed || 0) + 's/' + (r.cache.feed_count || 20) + '篇';
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    document.getElementById('c-task-save').addEventListener('click', function () {
      var base = curCache || {};
      var body = { cache: {
        ttl_list: parseInt(base.ttl_list, 10) || 0,
        ttl_sidebar: parseInt(base.ttl_sidebar, 10) || 0,
        ttl_site: (base.ttl_site !== undefined ? base.ttl_site : 604800),
        ttl_feed: (base.ttl_feed !== undefined ? base.ttl_feed : 14400),
        feed_count: (base.feed_count !== undefined ? base.feed_count : 20),
        purge_on_publish: !!base.purge_on_publish,
        task_batch: Math.min(100, Math.max(1, parseInt(document.getElementById('c-task-batch').value, 10) || 20)),
        task_concurrency: Math.min(16, Math.max(1, parseInt(document.getElementById('c-task-conc').value, 10) || 4)),
      } };
      api('/api/settings', { method: 'PUT', body: body }).then(function (r) {
        curCache = r.cache || curCache;
        flash('flash-main', '批量任务设置已保存', 'ok');
        var n = document.getElementById('c-task-note');
        if (n && r.cache) n.textContent = '批量 ' + r.cache.task_batch + ' 篇/批 · 并发 ' + r.cache.task_concurrency;
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    // ---- URL 结构（permalink）----
    api('/api/permalink').then(function (d) {
      var el = document.getElementById('pm-current');
      if (el) el.value = d.structure + '   →   ' + d.storagePattern;
      var inp = document.getElementById('pm-input');
      if (inp && !inp.value) inp.value = d.structure;
    }).catch(function () {});

    document.getElementById('pm-preview').addEventListener('click', function () {
      var out = document.getElementById('pm-out');
      out.textContent = '预览中…';
      api('/api/permalink/preview', { method: 'POST', body: { structure: document.getElementById('pm-input').value } }).then(function (d) {
        var lines = ['解析结果: ' + d.pattern + '   （当前 ' + d.oldPattern + '）'];
        if (d.unsupported && d.unsupported.length) lines.push('⚠️ 不支持的记号（会被原样保留）: ' + d.unsupported.join(' '));
        lines.push('');
        (d.samples || []).forEach(function (x) {
          lines.push('· ' + x.title);
          lines.push('    ' + x.oldUrl + '  →  ' + x.newUrl);
          lines.push('    R2: ' + x.oldKey + '  →  ' + x.newKey);
        });
        out.textContent = lines.join('\n');
      }).catch(function (e) { out.textContent = '预览失败: ' + e.message; });
    });

    document.getElementById('pm-migrate').addEventListener('click', function () {
      var out = document.getElementById('pm-out');
      var structure = document.getElementById('pm-input').value;
      if (!structure) { flash('flash-main', '请先填新结构', 'err'); return; }
      if (!confirm('将把全部已发布单页在 R2 里按新结构重新复制一份（旧文件保留），全部完成后自动切换到新结构。\n\n开始？')) return;
      var first = true;
      (function run() {
        out.textContent = '迁移中…';
        api('/api/permalink/migrate' + (first ? '?reset=1' : ''), { method: 'POST', body: { structure: structure } }).then(function (d) {
          first = false;
          out.textContent = '已复制 ' + d.cursor + ' / ' + d.total + '（批量 ' + d.batch + ' · 并发 ' + d.concurrency +
            ' · 跳过 ' + (d.skipped || 0) + ' · 旧文件缺失 ' + (d.failed || 0) + '）';
          if (!d.done) { run(); }
          else {
            out.textContent += '\n\n✅ 迁移完成，已切换到新结构：' + d.switchedTo +
              '\n（旧文件仍保留在 R2，确认新地址正常后可点「清理旧文件」）';
            flash('flash-main', '迁移完成，URL 结构已切换', 'ok');
          }
        }).catch(function (e) { out.textContent = '迁移中断: ' + e.message + '（可再点一次继续）'; });
      })();
    });

    document.getElementById('pm-cleanup').addEventListener('click', function () {
      if (!confirm('删除迁移时保留的旧单页文件？（旧地址会彻底 404）')) return;
      api('/api/permalink/cleanup', { method: 'POST' }).then(function (d) {
        document.getElementById('pm-out').textContent = '已删除旧文件 ' + d.deleted + ' 个（' + d.batches + ' 批）';
        flash('flash-main', '已删除旧文件 ' + d.deleted + ' 个', 'ok');
      }).catch(function (e) { flash('flash-main', e.message, 'err'); });
    });

    // 仅切换结构（不迁移）：走"改结构 → 重建全部单页 → 清理孤儿"的省事路线
    document.getElementById('pm-switch').addEventListener('click', function () {
      var structure = document.getElementById('pm-input').value;
      if (!structure) { flash('flash-main', '请先填新结构', 'err'); return; }
      if (!confirm('只切换 URL 结构、不搬文件？\n\n切换后：列表页立刻用新结构；但**所有单页会 404**，直到你点「重建全部单页」；旧文件会变成孤儿（之后可点「清理孤儿文件」）。\n\n继续？')) return;
      api('/api/permalink/switch', { method: 'POST', body: { structure: structure } }).then(function (d) {
        document.getElementById('pm-out').textContent = d.changed
          ? ('已切换到 ' + d.pattern + '（原 ' + d.oldPattern + '）\n\n👉 下一步：去「内容维护」点「重建全部单页」，完成后再回来点「清理孤儿文件」。')
          : ('结构未变化（' + d.pattern + '）');
        flash('flash-main', d.changed ? '已切换 URL 结构，请紧接着重建全部单页' : '结构未变化', 'ok');
        api('/api/permalink').then(function (x) {
          var el = document.getElementById('pm-current');
          if (el) el.value = x.structure + '   →   ' + x.storagePattern;
        }).catch(function () {});
      }).catch(function (e) { flash('flash-main', e.message, 'err'); });
    });

    // 清理孤儿文件：扫描 R2 里不属于当前结构的单页对象，确认后删除
    document.getElementById('pm-orphans').addEventListener('click', function () {
      var out = document.getElementById('pm-out');
      out.textContent = '扫描 R2 中…（对象多时需要几秒）';
      api('/api/permalink/orphans', { method: 'POST', body: {} }).then(function (d) {
        var lines = ['当前结构: ' + d.pattern, '应有的单页: ' + d.expected + ' 个', '发现孤儿: ' + d.orphanCount + ' 个'];
        (d.orphans || []).forEach(function (o) { lines.push('  · ' + o.key + '  (' + o.size + ' B)'); });
        if (d.truncated) lines.push('  …（仅显示前 50 个）');
        out.textContent = lines.join('\n');
        if (!d.orphanCount) { flash('flash-main', '没有孤儿文件', 'ok'); return; }
        if (!confirm('发现 ' + d.orphanCount + ' 个孤儿文件（见列表）。\n\n确认删除？删除后旧地址彻底 404，不可恢复。')) return;
        api('/api/permalink/orphans', { method: 'POST', body: { delete: true } }).then(function (dd) {
          out.textContent += '\n\n✅ 已删除 ' + dd.deleted + ' 个孤儿文件';
          flash('flash-main', '已清理孤儿 ' + dd.deleted + ' 个', 'ok');
        }).catch(function (e) { flash('flash-main', '删除失败: ' + e.message, 'err'); });
      }).catch(function (e) { out.textContent = '扫描失败: ' + e.message; });
    });

    document.getElementById('s-save').addEventListener('click', function () {
      var name = document.getElementById('s-name').value.trim();
      var desc = document.getElementById('s-desc').value.trim();
      if (!name) { flash('flash-main', '站点名不能为空', 'err'); return; }
      api('/api/settings', { method: 'PUT', body: { site: { name: name, description: desc, logo: document.getElementById('s-logo').value.trim(), banner: document.getElementById('s-banner').value.trim(), headExtra: document.getElementById('s-head-extra').value, layout: { singleSidebar: (document.getElementById('s-layout') || {}).value || 'show' } } } }).then(function () {
        flash('flash-main', '站点信息已更新并清空缓存，列表页立即生效', 'ok');
        setWho();
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    document.getElementById('p-save').addEventListener('click', function () {
      var oldp = document.getElementById('p-old').value;
      var newp = document.getElementById('p-new').value;
      if (newp.length < 8) { flash('flash-main', '新密码至少 8 位', 'err'); return; }
      api('/api/me/password', { method: 'POST', body: { old_password: oldp, new_password: newp } }).then(function () {
        clearTokens();
        flash('flash-login', '密码已修改，请用新密码重新登录', 'ok');
        boot();
      }).catch(function (err) { flash('flash-main', err.message, 'err'); });
    });

    document.getElementById('rb-btn').addEventListener('click', function () {
      var btn = document.getElementById('rb-btn');
      var prog = document.getElementById('rb-prog');
      btn.disabled = true;
      prog.textContent = '检查进度…';
      api('/api/posts/rebuild-single', { method: 'GET' }).then(function (g) {
        var p = (g && g.progress) || null;
        var resume = !!(p && (parseInt(p.cursor, 10) || 0) < (parseInt(p.total, 10) || 0));
        if (resume && !confirm('上次重建到 ' + p.cursor + '/' + p.total + ' 篇未完成。\n确定 = 从断点继续；取消 = 从头开始。')) resume = false;
        prog.textContent = resume ? ('从 ' + p.cursor + '/' + p.total + ' 继续…') : '从头开始…';
        var first = true;
        function run() {
          var qs = (first && !resume) ? '?reset=1' : '';
          first = false;
          api('/api/posts/rebuild-single' + qs, { method: 'POST' }).then(function (d) {
            prog.textContent = '已重建 ' + d.cursor + ' / 共 ' + d.total + (d.done ? '' : '…') +
              '（批量 ' + d.batch + ' · 并发 ' + d.concurrency + (d.failed ? ' · 失败 ' + d.failed : '') + '）';
            if (!d.done) { run(); }
            else {
              btn.disabled = false;
              prog.textContent = '全部完成：' + d.total + ' 篇';
              flash('flash-main', '全部单页已重建', 'ok');
            }
          }).catch(function (err) {
            btn.disabled = false;
            flash('flash-main', '重建中断：' + err.message + '（可再次点击，从断点继续）', 'err');
          });
        }
        run();
      }).catch(function (err) { btn.disabled = false; prog.textContent = ''; flash('flash-main', err.message, 'err'); });
    });

    document.getElementById('purge-btn').addEventListener('click', function () {
      var prog = document.getElementById('rb-prog');
      if (!confirm('清空全站缓存（首页列表 / 侧栏 / RSS / 站点设置快照）？')) return;
      prog.textContent = '清理中…';
      api('/api/cache/purge', { method: 'POST', body: {} }).then(function (d) {
        prog.textContent = '已清空 ' + d.cleared + ' 项缓存';
        flash('flash-main', '缓存已清空', 'ok');
      }).catch(function (e) { prog.textContent = ''; flash('flash-main', e.message, 'err'); });
    });

    document.getElementById('exp-btn').addEventListener('click', function () {
      var prog = document.getElementById('bk-prog');
      prog.textContent = '导出中…';
      api('/api/export').then(function (d) {
        var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'cfse-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        prog.textContent = '已导出 ' + d.total + ' 篇';
      }).catch(function (e) { prog.textContent = ''; flash('flash-main', e.message, 'err'); });
    });
    document.getElementById('imp-btn').addEventListener('click', function () {
      document.getElementById('imp-file').click();
    });
    document.getElementById('imp-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      var prog = document.getElementById('bk-prog');
      var rd = new FileReader();
      rd.onload = function () {
        var obj;
        try { obj = JSON.parse(rd.result); } catch (e) { prog.textContent = ''; flash('flash-main', '文件不是有效 JSON', 'err'); return; }
        prog.textContent = '导入中…';
        api('/api/import', { method: 'POST', body: obj }).then(function (d) {
          var sk = (d.skipped || []).length ? '，跳过 ' + d.skipped.length + ' 篇' : '';
          prog.textContent = '已导入 ' + d.imported + ' 篇' + sk;
          flash('flash-main', '导入完成', 'ok');
        }).catch(function (e) { prog.textContent = ''; flash('flash-main', e.message, 'err'); });
      };
      rd.readAsText(file);
    });
  }

  /* ---------- 风格（docs/style-refactor.md：按 wp-content/themes/<id>/tpl.json 直读） ---------- */
  function openStylePreview(pages) {
    var w = window.open('', '_blank');
    if (!w) { flash('flash-main', '浏览器拦截了新窗口，请允许弹窗', 'err'); return; }
    var labels = { single: '文章单页', pageHome: '首页', pageCategory: '分类页', pageTag: '标签页', pageArchive: '归档页', item: '列表条目' };
    var tabs = pages.map(function (p, i) { return '<button data-i="' + i + '"' + (i === 0 ? ' class="on"' : '') + '>' + (labels[p.kind] || p.kind) + '</button>'; }).join('');
    var frames = pages.map(function (p, i) { return '<iframe data-i="' + i + '"' + (i === 0 ? '' : ' style="display:none"') + '></iframe>'; }).join('');
    w.document.open();
    w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>风格预览</title><style>' +
      'body{margin:0;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f0f0f1}' +
      '#tabs{position:fixed;top:0;left:0;right:0;height:44px;display:flex;gap:4px;align-items:center;background:#1d2327;padding:0 10px;z-index:9}' +
      '#tabs button{background:none;border:1px solid #3c434a;color:#c7c9cc;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:13px}' +
      '#tabs button.on{background:#2271d1;border-color:#2271d1;color:#fff}' +
      'iframe{border:0;width:100%;height:calc(100vh - 44px);margin-top:44px;display:block;background:#fff}' +
      '</style></head><body><div id="tabs">' + tabs + '<span style="color:#8a8f94;margin-left:auto;font-size:12px;">仅本地预览，不影响线上</span></div>' + frames + '</body></html>');
    w.document.close();
    pages.forEach(function (p, i) {
      var f = w.document.querySelector('iframe[data-i="' + i + '"]');
      if (f) f.setAttribute('srcdoc', p.html || '');
    });
    w.document.getElementById('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-i]');
      if (!b) return;
      var i = b.getAttribute('data-i');
      w.document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      w.document.querySelectorAll('iframe').forEach(function (f) { f.style.display = (f.getAttribute('data-i') === i) ? '' : 'none'; });
    });
  }

  function renderTpl() {
    var sec = document.getElementById('view-tpl');
    if (!sec) return;
    var VIS_KINDS = [['pageHome', '首页'], ['pageCategory', '分类页'], ['pageTag', '标签页'], ['pageArchive', '归档页'], ['single', '文章单页'], ['item', '列表条目']];
    var VIS_HINT = {
      pageHome: '整页外壳。{{CONTENT}}=文章列表；{{TITLE}} {{TOTAL_POSTS}} {{PAGINATION_PREV}} {{PAGINATION_NEXT}} {{SITE_NAME}} {{SITE_URL}} {{SITE_DESC}} {{SITE_FOOTER}} {{SITE_LOGO}} {{MENU}} {{SIDEBAR_CATEGORIES}} {{SIDEBAR_ARCHIVES}} {{SIDEBAR_TAGS}}',
      pageCategory: '分类归档整页外壳（同首页；{{TITLE}}=分类名）',
      pageTag: '标签归档整页外壳（同首页；{{TITLE}}=标签名）',
      pageArchive: '日期归档整页外壳（另有 {{YEAR}} {{MONTH}}）',
      single: '文章单页整页。{{POST_TITLE}} {{POST_DATE}} {{POST_CONTENT}} {{POST_URL}} {{POST_CATEGORIES}} {{POST_TAGS}} {{POST_AUTHOR}} {{POST_THUMBNAIL}} {{PREV_URL}} {{PREV_TITLE}} {{NEXT_URL}} {{NEXT_TITLE}} {{COMMENTS}} + 条件块 {{#IF_CATEGORIES}}/{{#IF_TAGS}}/{{#IF_AUTHOR}}/{{#IF_THUMBNAIL}}/{{#IF_PREV}}/{{#IF_NEXT}}/{{#IF_COMMENTS}}',
      item: '列表里每篇的卡片。{{POST_TITLE}} {{POST_URL}} {{POST_DATE}} {{POST_EXCERPT}} {{POST_CATEGORIES}} {{POST_TAGS}} {{POST_AUTHOR}} {{POST_THUMBNAIL}} {{COMMENT_COUNT_TEXT}} + {{#IF_CATEGORIES}}/{{#IF_TAGS}}/{{#IF_AUTHOR}}/{{#IF_THUMBNAIL}}'
    };
    sec.innerHTML = '<h1>模板 / 风格</h1>'
      + '<p class="muted">风格 = <code>wp-content/themes/&lt;id&gt;/</code> 一个目录（<code>tpl.json</code> + 资源）；内置（static）与用户（R2）同形。'
      + '<b>内置风格只读</b>（编辑保存时自动另存为 <code>&lt;id&gt;-custom</code>）。</p>'
      + '<div class="card"><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<button class="btn" data-stm="preview" style="font-size:15px;padding:8px 20px;">👁 预览</button>'
      + '<button class="btn" data-stm="upload" style="font-size:15px;padding:8px 20px;">📦 上传</button>'
      + '<button class="btn" data-stm="edit" style="font-size:15px;padding:8px 20px;">✏️ 编辑</button>'
      + '<span style="flex:1"></span>'
      + '<select id="st-pick" style="min-width:260px;"></select></div></div>'
      + '<div class="card" id="stm-preview">'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<span id="st-kinds">' + VIS_KINDS.map(function (k) { return '<button class="btn btn-sm" data-kind="' + k[0] + '">' + k[1] + '</button>'; }).join(' ') + '</span>'
      + '<span style="flex:1"></span>'
      + '<button class="btn btn-primary" id="st-apply">✅ 应用</button>'
      + '<button class="btn btn-sm" id="st-open">👁 预览</button>'
      + '<button class="btn btn-sm" id="st-download">📥 下载 json</button>'
      + '<button class="btn btn-sm" id="st-delete">🗑 删除</button></div>'
      + '<div class="muted" id="st-note" style="margin-top:4px;font-size:12px;"></div>'
      + '<iframe id="st-frame" style="width:100%;height:560px;border:1px solid #e5e7eb;border-radius:8px;margin-top:8px;background:#fff;"></iframe></div>'
      + '<div class="card hidden" id="stm-upload">'
      + '<h1 style="font-size:15px;">上传风格（选目录）</h1>'
      + '<p class="muted">选一个目录（含 <code>tpl.json</code> 及资源）→ 逐文件写入 <code>wp-content/themes/&lt;id&gt;/</code>（R2）。目录名或下方 id 即风格 id；写 <code>tpl.json</code> 会自动备份旧版为 <code>.bak</code>。</p>'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<input type="file" id="st-dir" webkitdirectory multiple>'
      + '<input type="text" id="st-id" placeholder="风格 id（留空用目录名）" style="width:220px;">'
      + '<button class="btn btn-primary" id="st-upload">上传</button> <span class="muted" id="st-up-note"></span></div></div>'
      + '<div class="card hidden" id="stm-edit">'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<label>名称</label><input type="text" id="st-edit-name" placeholder="（可选）" style="width:200px;">'
      + '<span style="flex:1"></span>'
      + '<button class="btn btn-sm" id="st-edit-mode">{ } JSON 源码</button>'
      + '<button class="btn btn-primary" id="st-edit-save">💾 保存到 R2</button>'
      + '<button class="btn btn-sm" id="st-edit-revert">↩ 回退（.bak）</button>'
      + '<span class="muted" id="st-edit-note" style="font-size:12px;"></span></div>'
      + '<div id="st-edit-vis" style="margin-top:8px;">'
      + '<div id="st-vis-tabs" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;"></div>'
      + '<p class="muted" id="st-vis-hint" style="font-size:12px;margin:0 0 6px;"></p>'
      + '<textarea id="st-vis-ta" spellcheck="false" style="min-height:320px;width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;box-sizing:border-box;"></textarea>'
      + '<details style="margin-top:8px;"><summary class="muted" style="cursor:pointer;">骨架：sidebar / comments（进阶，可留空）</summary>'
      + '<label style="font-size:12px;margin-top:6px;display:block;">sidebar（侧边栏条目骨架 JSON）</label>'
      + '<textarea id="st-vis-sidebar" spellcheck="false" style="min-height:100px;width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;box-sizing:border-box;"></textarea>'
      + '<label style="font-size:12px;margin-top:6px;display:block;">comments（评论骨架 JSON = {list,entry,children}）</label>'
      + '<textarea id="st-vis-comments" spellcheck="false" style="min-height:100px;width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;box-sizing:border-box;"></textarea></details></div>'
      + '<div id="st-edit-json" class="hidden" style="margin-top:8px;">'
      + '<p class="muted" style="font-size:12px;margin:0 0 6px;">整份 <code>tpl.json</code> 原始编辑（{ name, tpl:{…}, sidebar, comments, docShell }）。适合三方编辑器粘回。</p>'
      + '<textarea id="st-edit-ta" spellcheck="false" style="min-height:440px;width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;box-sizing:border-box;"></textarea></div></div>';

    var note = document.getElementById('st-note'), editNote = document.getElementById('st-edit-note');
    var st = { styles: [], active: '', cur: '', orig: null, contents: {}, visKind: 'pageHome', curKind: 'pageHome', jsonMode: false };
    function curStyle() { return st.styles.filter(function (s) { return s.id === st.cur; })[0] || null; }
    function frameSrc(id, kind) { return id ? ('/preview/' + encodeURIComponent(id) + '/?kind=' + encodeURIComponent(kind || 'pageHome')) : 'about:blank'; }
    function paintPick() {
      var sel = document.getElementById('st-pick');
      sel.innerHTML = '<option value="">（内置默认模板）</option>';
      st.styles.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = (s.name || s.id) + (s.source === 'builtin' ? ' 📦内置' : ' 👤用户') + (s.id === st.active ? ' ✓当前' : '');
        sel.appendChild(o);
      });
      sel.value = st.cur || '';
    }
    function loadFrame() {
      var kind = st.curKind || 'pageHome';
      document.getElementById('st-frame').src = frameSrc(st.cur, kind);
      document.querySelectorAll('#st-kinds [data-kind]').forEach(function (b) {
        b.classList.toggle('btn-primary', b.getAttribute('data-kind') === kind);
      });
      var cs = curStyle();
      note.textContent = st.cur ? ('预览：' + (cs ? (cs.name || cs.id) : st.cur) + (cs && cs.source === 'builtin' ? '（内置）' : '') + (st.cur === st.active ? ' · ✓当前生效' : '')) : '预览：内置默认模板（未选风格）';
      if (st.cur && document.getElementById('st-edit-vis')) loadEdit();
    }
    // ---- 可视化编辑 ----
    function paintVisTabs() {
      document.getElementById('st-vis-tabs').innerHTML = VIS_KINDS.map(function (k) {
        return '<button class="btn btn-sm' + (k[0] === st.visKind ? ' btn-primary' : '') + '" data-vis="' + k[0] + '">' + k[1] + '</button>';
      }).join('');
      document.querySelectorAll('[data-vis]').forEach(function (b) {
        b.onclick = function () { saveVisCur(); st.visKind = b.getAttribute('data-vis'); paintVis(); };
      });
    }
    function saveVisCur() {
      var ta = document.getElementById('st-vis-ta');
      if (ta) st.contents[st.visKind] = ta.value;
    }
    function paintVis() {
      paintVisTabs();
      document.getElementById('st-vis-ta').value = st.contents[st.visKind] || '';
      document.getElementById('st-vis-hint').textContent = '占位符：' + (VIS_HINT[st.visKind] || '');
    }
    function loadEdit() {
      if (!st.cur) { editNote.textContent = '请先在上方选择风格'; return; }
      editNote.textContent = '载入中…';
      api('/api/templates/style/tpl?id=' + encodeURIComponent(st.cur)).then(function (r) {
        st.orig = r.tpl || {};
        var tp = (st.orig.tpl && typeof st.orig.tpl === 'object') ? st.orig.tpl : st.orig;
        st.contents = {};
        VIS_KINDS.forEach(function (k) { st.contents[k[0]] = String(tp[k[0]] || ''); });
        st.visKind = 'pageHome';
        document.getElementById('st-edit-name').value = st.orig.name || '';
        document.getElementById('st-vis-sidebar').value = st.orig.sidebar ? JSON.stringify(st.orig.sidebar, null, 2) : '';
        document.getElementById('st-vis-comments').value = st.orig.comments ? JSON.stringify(st.orig.comments, null, 2) : '';
        document.getElementById('st-edit-ta').value = JSON.stringify(st.orig, null, 2);
        paintVis();
        var cs = curStyle();
        editNote.textContent = '已载入 ' + st.cur + '（' + (cs && cs.source === 'builtin' ? '内置 → 保存将另存为 -custom' : '用户') + (st.cur === st.active ? '，✓当前生效' : '') + '）';
      }).catch(function (e) { editNote.textContent = '载入失败：' + (e && e.message || e); });
    }
    function buildFromVis() {
      var base = (st.orig && typeof st.orig === 'object') ? st.orig : {};
      saveVisCur();
      var tpl = {};
      VIS_KINDS.forEach(function (k) { tpl[k[0]] = String(st.contents[k[0]] || ''); });
      var obj = Object.assign({}, base, { tpl: tpl });
      var nm = document.getElementById('st-edit-name').value.trim();
      if (nm) obj.name = nm;
      var sbRaw = document.getElementById('st-vis-sidebar').value.trim();
      if (sbRaw) { try { obj.sidebar = JSON.parse(sbRaw); } catch (e) { throw new Error('sidebar JSON 错误：' + e.message); } }
      var cmRaw = document.getElementById('st-vis-comments').value.trim();
      if (cmRaw) { try { obj.comments = JSON.parse(cmRaw); } catch (e) { throw new Error('comments JSON 错误：' + e.message); } }
      return obj;
    }
    function load() {
      api('/api/templates/styles').then(function (r) {
        st.styles = (r && r.styles) || [];
        st.active = (r && r.active) || '';
        if (!st.cur || !st.styles.some(function (s) { return s.id === st.cur; })) st.cur = st.active || (st.styles[0] && st.styles[0].id) || '';
        paintPick(); loadFrame();
      }).catch(function (e) { note.textContent = '读取失败：' + (e && e.message || e); });
    }
    function setMode(m) {
      ['preview', 'upload', 'edit'].forEach(function (k) { var el = document.getElementById('stm-' + k); if (el) el.classList.toggle('hidden', k !== m); });
      document.querySelectorAll('[data-stm]').forEach(function (b) { b.classList.toggle('btn-primary', b.getAttribute('data-stm') === m); });
      if (m === 'edit') loadEdit();
    }
    document.querySelectorAll('[data-stm]').forEach(function (b) { b.onclick = function () { setMode(b.getAttribute('data-stm')); }; });
    document.getElementById('st-pick').onchange = function () { st.cur = this.value; loadFrame(); };
    document.querySelectorAll('#st-kinds [data-kind]').forEach(function (b) {
      b.onclick = function () { st.curKind = b.getAttribute('data-kind'); loadFrame(); };
    });
    document.getElementById('st-open').onclick = function () {
      if (!st.cur) { note.textContent = '请先选一个风格'; return; }
      window.open('/preview/' + encodeURIComponent(st.cur) + '/', '_blank');
    };
    document.getElementById('st-apply').onclick = function () {
      note.textContent = '应用中…';
      api('/api/templates/style/apply', { method: 'POST', body: { id: st.cur || '__default__' } }).then(function () {
        note.textContent = '已应用：' + (st.cur || '（内置默认模板）') + '（清 site:ctx，约 60s 生效）'; load();
      }).catch(function (e) { note.textContent = '应用失败：' + (e && e.message || e); });
    };
    document.getElementById('st-download').onclick = function () {
      if (!st.cur) { note.textContent = '请先选一个风格'; return; }
      api('/api/templates/style/tpl?id=' + encodeURIComponent(st.cur)).then(function (r) {
        var blob = new Blob([JSON.stringify(r.tpl, null, 2)], { type: 'application/json' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = st.cur + '-tpl.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        note.textContent = '已下载 ' + st.cur + '-tpl.json';
      }).catch(function (e) { note.textContent = '下载失败：' + (e && e.message || e); });
    };
    document.getElementById('st-delete').onclick = function () {
      if (!st.cur) { note.textContent = '请先选一个风格'; return; }
      var cs = curStyle();
      if (cs && cs.source === 'builtin') { note.textContent = '内置风格不可删除'; return; }
      if (!confirm('删除用户风格 ' + st.cur + '（R2 整个目录，不可撤销）？')) return;
      api('/api/templates/style/delete', { method: 'POST', body: { id: st.cur } })
        .then(function () { note.textContent = '已删除'; st.cur = ''; load(); })
        .catch(function (e) { note.textContent = '删除失败：' + (e && e.message || e); });
    };
    document.getElementById('st-dir').onchange = function () {
      var f0 = this.files && this.files[0];
      if (f0 && f0.webkitRelativePath) {
        var top = f0.webkitRelativePath.split('/')[0] || '';
        var el = document.getElementById('st-id');
        if (!el.value.trim()) el.value = top.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      }
    };
    document.getElementById('st-upload').onclick = function () {
      var fl = document.getElementById('st-dir').files;
      if (!fl || !fl.length) { alert('请先选择目录'); return; }
      var upNote = document.getElementById('st-up-note');
      var explicit = document.getElementById('st-id').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      var items = [];
      for (var i = 0; i < fl.length; i++) {
        var segs = (fl[i].webkitRelativePath || fl[i].name).split('/');
        var top = segs.length > 1 ? segs.shift() : '';
        var id = explicit || String(top).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        var path = segs.join('/');
        if (id && path) items.push({ file: fl[i], id: id, path: path });
      }
      if (!items.length) { upNote.textContent = '未解析到可上传的文件（目录里应有 tpl.json 及资源）'; return; }
      upNote.textContent = '上传 ' + items.length + ' 个文件…';
      var done = 0, ok = 0, fail = 0;
      (function next() {
        if (done >= items.length) { upNote.textContent = '完成：' + ok + ' 成功 / ' + fail + ' 失败'; load(); return; }
        var it = items[done++];
        var rd = new FileReader();
        rd.onload = function () {
          api('/api/templates/style/upload', { method: 'POST', body: { id: it.id, path: it.path, content_base64: String(rd.result).split(',')[1] || '' } })
            .then(function () { ok++; next(); }).catch(function () { fail++; next(); });
        };
        rd.onerror = function () { fail++; next(); };
        rd.readAsDataURL(it.file);
      })();
    };
    document.getElementById('st-edit-mode').onclick = function () {
      st.jsonMode = !st.jsonMode;
      document.getElementById('st-edit-vis').classList.toggle('hidden', st.jsonMode);
      document.getElementById('st-edit-json').classList.toggle('hidden', !st.jsonMode);
      this.textContent = st.jsonMode ? '🧩 可视化编辑' : '{ } JSON 源码';
      if (st.jsonMode) { try { document.getElementById('st-edit-ta').value = JSON.stringify(buildFromVis(), null, 2); } catch (e) { editNote.textContent = String(e.message || e); } }
      else { loadEdit(); }
    };
    document.getElementById('st-edit-save').onclick = function () {
      var obj;
      if (st.jsonMode) {
        var ta = document.getElementById('st-edit-ta').value;
        if (!ta.trim()) { editNote.textContent = '内容为空'; return; }
        try { obj = JSON.parse(ta); } catch (e) { editNote.textContent = 'JSON 格式错误：' + e.message; return; }
        var nmj = document.getElementById('st-edit-name').value.trim(); if (nmj) obj.name = nmj;
      } else {
        try { obj = buildFromVis(); } catch (e) { editNote.textContent = String(e.message || e); return; }
      }
      var cs = curStyle();
      var saveId = st.cur;
      if (cs && cs.source === 'builtin') saveId = st.cur + '-custom';
      editNote.textContent = '保存中…';
      api('/api/templates/style/upload', { method: 'POST', body: { id: saveId, path: 'tpl.json', content: JSON.stringify(obj, null, 2) } })
        .then(function () {
          editNote.textContent = '已保存到 ' + saveId + '/tpl.json' + (saveId !== st.cur ? '（内置不可覆盖 → 另存为 ' + saveId + '，请选它并「应用」）' : '');
          st.cur = saveId; load();
        })
        .catch(function (e) { editNote.textContent = '保存失败：' + (e && e.message || e); });
    };
    document.getElementById('st-edit-revert').onclick = function () {
      if (!st.cur) { editNote.textContent = '请先选风格'; return; }
      if (!confirm('用 ' + st.cur + '/tpl.json.bak 覆盖回 tpl.json ？')) return;
      api('/api/templates/style/revert', { method: 'POST', body: { id: st.cur } })
        .then(function () { editNote.textContent = '已回退'; loadEdit(); })
        .catch(function (e) { editNote.textContent = '回退失败：' + (e && e.message || e); });
    };
    setMode('preview');
    load();
  }

  function fallbackCopy(t, done, fail) {
    var inp = document.createElement('textarea');
    inp.value = t; document.body.appendChild(inp); inp.select();
    try { document.execCommand('copy'); done(); } catch (e) { fail(); }
    document.body.removeChild(inp);
  }
  function copyText(t, done, fail) {
    if (navigator.clipboard) { navigator.clipboard.writeText(t).then(done, function () { fallbackCopy(t, done, fail); }); }
    else { fallbackCopy(t, done, fail); }
  }

  /* ---------- 路由 / 启动 ---------- */
  // ---------------- 评论（Worker 端：设置 + 审核/删除"未回拉"的评论） ----------------
  function renderComments() {
    var sec = document.getElementById('view-comments');
    if (!sec) return;
    sec.innerHTML = '<h1>评论</h1>'
      + '<div class="card"><h1 style="font-size:16px;">评论设置</h1>'
      + '<p class="muted">静态站的评论呈现方式（与 WP 后台同名同义，谁后保存谁生效）。保存后<b>刷新页面即生效</b>：<code>native</code> = 主题骨架 + D1 自有数据；<code>embed</code> = 注入第三方片段；<code>off</code> = 隐藏评论区与提交表单。</p>'
      + '<label>模式</label><select id="cm-mode"><option value="off">off —— 隐藏评论区</option><option value="native">native —— 主题骨架 + 自有数据</option><option value="embed">embed —— 注入第三方片段</option></select>'
      + '<label>第三方注入片段（embed 模式用，原样输出到评论区）</label><textarea id="cm-embed" style="min-height:70px;font-family:monospace;font-size:12px;"></textarea>'
      + '<label>站外提交</label><select id="cm-accept"><option value="off">off —— 拒收（静态站前台不能提交）</option><option value="pending">pending —— 收下待审核（推荐）</option><option value="auto">auto —— 直接通过</option></select>'
      + '<div style="margin-top:10px;"><button class="btn btn-primary" id="cm-save">保存评论设置</button> <span class="muted" id="cm-note"></span></div></div>'
      + '<div class="card"><h1 style="font-size:16px;">评论列表</h1>'
      + '<p class="muted">这里管的是<b>读者从静态站提交、还没回拉到 WordPress</b> 的评论（审核状态会在 WP 拉取时生效）。已由 WP 接管的评论是只读的 —— 那边才是权威。</p>'
      + '<div style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">'
      + '<button class="btn btn-sm" data-cmf="unpulled">未回拉</button>'
      + '<button class="btn btn-sm" data-cmf="pending">待审核（全部）</button>'
      + '<button class="btn btn-sm" data-cmf="all">全部</button>'
      + '<span class="muted" id="cm-count"></span>'
      + '<button class="btn btn-sm" id="cm-reload" style="margin-left:auto;">刷新</button></div>'
      + '<div id="cm-list">加载中…</div><div id="cm-pager" style="margin-top:10px;"></div></div>';

    var note = document.getElementById('cm-note');
    var st = { filter: 'unpulled', page: 1 };

    function loadSettings() {
      api('/api/settings').then(function (r) {
        var c = (r && r.comments) || {};
        document.getElementById('cm-mode').value = c.mode || 'off';
        document.getElementById('cm-embed').value = c.embed || '';
        document.getElementById('cm-accept').value = c.accept || 'off';
      }).catch(function (e) { note.textContent = '读取失败：' + (e && e.message || e); });
    }
    function paintFilters() {
      document.querySelectorAll('[data-cmf]').forEach(function (b) {
        b.classList.toggle('btn-primary', b.getAttribute('data-cmf') === st.filter);
      });
    }
    function load() {
      var el = document.getElementById('cm-list');
      el.textContent = '加载中…';
      api('/api/comments?filter=' + st.filter + '&page=' + st.page + '&per_page=20').then(function (r) {
        var list = (r && r.comments) || [];
        document.getElementById('cm-count').textContent = '共 ' + (r.total || 0) + ' 条'
          + ((r.pending || 0) > 0 ? '（其中未回拉待审 ' + r.pending + ' 条）' : '');
        if (!list.length) { el.innerHTML = '<p class="muted">（没有符合条件的评论）</p>'; document.getElementById('cm-pager').innerHTML = ''; return; }
        var html = '<table class="table" style="width:100%;"><thead><tr><th>作者</th><th>文章</th><th>内容</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>';
        list.forEach(function (c) {
          var approved = Number(c.approved) === 1;
          var managed = !!c.managed_by_wp;
          var text = String(c.content || '').replace(/<[^>]*>/g, '').slice(0, 90);
          html += '<tr>'
            + '<td>' + esc(c.author || '') + (c.author_email ? '<br><span class="muted" style="font-size:11px;">' + esc(c.author_email) + '</span>' : '') + '</td>'
            + '<td style="max-width:170px;">' + esc(c.post_title || ('#' + c.post_id)) + '</td>'
            + '<td style="max-width:300px;">' + esc(text) + '</td>'
            + '<td>' + (approved ? '<span style="color:#1e7b34;">已通过</span>' : '<span style="color:#b26a00;">待审核</span>')
            + (managed ? '<br><span class="muted" style="font-size:11px;">由 WP 管理</span>' : '<br><span class="muted" style="font-size:11px;">未回拉</span>') + '</td>'
            + '<td class="muted" style="font-size:12px;">' + esc(c.date_text || c.date || '') + '</td>'
            + '<td>' + (managed
              ? '<span class="muted" style="font-size:12px;">只读</span>'
              : '<button class="btn btn-sm" data-act="' + (approved ? 'unapprove' : 'approve') + '" data-id="' + c.comment_id + '">' + (approved ? '转待审' : '通过') + '</button> '
                + '<button class="btn btn-sm" data-act="delete" data-id="' + c.comment_id + '">删除</button>')
            + '</td></tr>';
        });
        el.innerHTML = html + '</tbody></table>';
        var pages = Math.max(1, Math.ceil((r.total || 0) / (r.per_page || 20)));
        document.getElementById('cm-pager').innerHTML = pages > 1
          ? ('<button class="btn btn-sm" id="cm-prev"' + (st.page <= 1 ? ' disabled' : '') + '>上一页</button> '
            + '<span class="muted">第 ' + st.page + ' / ' + pages + ' 页</span> '
            + '<button class="btn btn-sm" id="cm-next"' + (st.page >= pages ? ' disabled' : '') + '>下一页</button>')
          : '';
        var prevB = document.getElementById('cm-prev'), nextB = document.getElementById('cm-next');
        if (prevB) prevB.onclick = function () { if (st.page > 1) { st.page--; load(); } };
        if (nextB) nextB.onclick = function () { if (st.page < pages) { st.page++; load(); } };
        el.querySelectorAll('button[data-act]').forEach(function (b) {
          b.onclick = function () {
            var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
            if (act === 'delete' && !confirm('删除这条评论？（只删静态站这边的待审评论）')) return;
            b.disabled = true;
            api('/api/comments/' + id, { method: 'POST', body: { action: act } }).then(function () {
              note.textContent = '已处理';
              load();
            }).catch(function (e) { b.disabled = false; alert('操作失败：' + (e && e.message || e)); });
          };
        });
      }).catch(function (e) { el.innerHTML = '<p class="muted">读取失败：' + esc(e && e.message || e) + '</p>'; });
    }

    document.querySelectorAll('[data-cmf]').forEach(function (b) {
      b.onclick = function () { st.filter = b.getAttribute('data-cmf'); st.page = 1; paintFilters(); load(); };
    });
    document.getElementById('cm-reload').onclick = function () { load(); };
    document.getElementById('cm-save').onclick = function () {
      note.textContent = '保存中…';
      api('/api/settings', {
        method: 'PUT',
        body: {
          comments: {
            mode: document.getElementById('cm-mode').value,
            embed: document.getElementById('cm-embed').value,
            accept: document.getElementById('cm-accept').value,
          },
        },
      }).then(function () { note.textContent = '已保存（刷新页面即生效）'; })
        .catch(function (e) { note.textContent = '保存失败：' + (e && e.message || e); });
    };
    paintFilters();
    loadSettings();
    load();
  }

  // ========== 文档库 ==========
  function renderDocuments() {
    var sec = document.getElementById('view-documents');
    if (!sec) return;
    sec.innerHTML = '<h1>📚 文档库</h1>'
      + '<p class="muted">独立于博客文章的内容来源：本地 md/html 原稿上传到 R2，元数据存 D1，访问时套「目录级壳」渲染成品。'
      + '配置见 <code>docs/document-library.md</code>。<b>abc</b> = 原稿目录（R2），<b>xyz</b> = 可访问前缀（全局唯一、避开保留前缀）。</p>'
      + '<div class="card">'
      + '<div style="display:flex;gap:6px;border-bottom:1px solid #eee;padding-bottom:8px;margin-bottom:14px;">'
      + '<button class="btn btn-sm" data-dltab="routes">📚 文档库映射</button>'
      + '<button class="btn btn-sm" data-dltab="docs">📄 文档管理</button>'
      + '<button class="btn btn-sm" data-dltab="shell">🎨 文档壳</button></div>'
      + '<section id="dltab-routes">'
      + '<p class="muted">每条 = 一个文档库：<code>abc</code> 原稿目录 → <code>xyz</code> 访问前缀 → 壳（风格）→ 导航 → 目录页。保存后清 site:ctx 即时生效（KV/边缘缓存最终一致约 60s）。</p>'
      + '<div id="doc-route-rows" style="display:flex;flex-direction:column;gap:8px;"></div>'
      + '<div style="margin-top:10px;"><button class="btn btn-sm" id="doc-route-add">＋ 添加文档库</button> '
      + '<button class="btn btn-primary" id="doc-route-save">保存映射</button> <span class="muted" id="doc-route-note"></span></div></section>'
      + '<section id="dltab-docs" class="hidden">'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<select id="doc-pick-abc" title="选择文档库（abc）" style="min-width:170px;"></select>'
      + '<button class="btn btn-sm" id="doc-refresh">刷新</button>'
      + '<button class="btn btn-sm" id="doc-rebuild" title="整库重建：重新渲染所有成品">整库重建</button>'
      + '<button class="btn btn-sm" id="doc-selall">全选 / 取消</button>'
      + '<button class="btn btn-sm" id="doc-batch-del">🗑 批量删除</button>'
      + '<span class="muted" id="doc-count"></span>'
      + '<span class="muted" id="doc-selcount"></span></div>'
      + '<div id="doc-list" style="margin-top:10px;">先选库</div>'
      + '<hr style="border:0;border-top:1px solid #eee;margin:16px 0;">'
      + '<h1 style="font-size:15px;">上传 / 更新单篇</h1>'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<input type="file" id="doc-file" accept=".md,.markdown,.html,.htm">'
      + '<input type="text" id="doc-path" placeholder="相对路径，如 guide/readme.md" style="flex:1;min-width:200px;">'
      + '<input type="text" id="doc-title" placeholder="标题（可选，留空用文件名）" style="width:200px;">'
      + '<button class="btn btn-primary" id="doc-upload">上传</button> <span class="muted" id="doc-up-note"></span></div>'
      + '<h1 style="font-size:15px;margin-top:18px;">批量导入（选目录）</h1>'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">'
      + '<input type="file" id="doc-bulk" multiple webkitdirectory>'
      + '<label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="doc-bulk-strip" checked> 去掉顶层目录名</label>'
      + '<input type="text" id="doc-bulk-prefix" placeholder="路径前缀（可选）" style="width:180px;">'
      + '<button class="btn btn-primary" id="doc-bulk-go">批量导入</button> <span class="muted" id="doc-bulk-note"></span></div>'
      + '<p class="muted" style="margin-top:6px;">大目录（几百篇/含大文件）建议用本地脚本 <code>tools/import-documents.mjs</code>；单次请求体上限 25MB。</p>'
      + '</section>'
      + '<section id="dltab-shell" class="hidden">'
      + '<p class="muted">文档页的 HTML 模板。可用占位符：<code>{{DOC_TITLE}}</code> <code>{{CONTENT}}</code> <code>{{DOC_SIDEBAR}}</code> <code>{{SITE_NAME}}</code> <code>{{SITE_URL}}</code> <code>{{SITE_DESC}}</code>。'
      + '库的「风格下拉」选「（默认壳）」或某个<i>没有文档壳</i>的风格时，一律回退到<b>内置默认文档壳</b>。</p>'
      + '<p class="muted"><b>推荐流程</b>：先选好库 → 「载入当前库的文档壳」→ 改 → <b>💾 保存并应用到当前库</b> → 去「文档管理」点<b>整库重建</b>即可。</p>'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0;">'
      + '<button class="btn btn-sm" id="doc-shell-default">载入内置默认壳</button>'
      + '<button class="btn btn-sm" id="doc-shell-load">载入当前库的文档壳</button>'
      + '<label>名称</label><input type="text" id="doc-shell-name" placeholder="我的文档壳" style="width:200px;">'
      + '<span class="muted" id="doc-shell-cur"></span></div>'
      + '<textarea id="doc-shell-ta" style="min-height:240px;width:100%;font-family:monospace;font-size:12px;"></textarea>'
      + '<div style="margin-top:8px;"><button class="btn btn-primary" id="doc-shell-apply">💾 保存并应用到当前库</button> '
      + '<button class="btn btn-sm" id="doc-shell-save">📄 另存为新壳</button> '
      + '<span class="muted" id="doc-shell-note"></span></div></section>'
      + '</div>';

    var note = document.getElementById('doc-route-note');
    var st = { routes: [], abc: '', tab: 'routes', shellId: '' };

    // ---- 大类 tab 切换 ----
    function setDlTab(name) {
      st.tab = name;
      ['routes', 'docs', 'shell'].forEach(function (k) {
        var el = document.getElementById('dltab-' + k);
        if (el) el.classList.toggle('hidden', k !== name);
      });
      document.querySelectorAll('[data-dltab]').forEach(function (b) {
        b.classList.toggle('btn-primary', b.getAttribute('data-dltab') === name);
      });
      if (name === 'docs') refreshAbc();
    }
    document.querySelectorAll('[data-dltab]').forEach(function (b) {
      b.onclick = function () { setDlTab(b.getAttribute('data-dltab')); };
    });

    // ---- 映射编辑 ----
    function routeRow(dr, idx) {
      var d = dr || {};
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:nowrap;border:1px solid #eee;padding:8px;border-radius:6px;';
      row.innerHTML =
        '<input type="text" data-f="abc" placeholder="abc（原稿目录）" value="' + esc(d.abc || '') + '" style="width:140px;flex:0 0 auto;">'
        + '<input type="text" data-f="xyz" placeholder="xyz（访问前缀）" value="' + esc(d.xyz || '') + '" style="width:140px;flex:0 0 auto;">'
        + '<select data-f="styleId" style="flex:1 1 auto;min-width:110px;"></select>'
        + '<select data-f="docNav" style="flex:0 0 auto;width:132px;" title="导航"><option value="sidebar">侧边栏目录树</option><option value="none">无导航</option><option value="prevnext">上一篇/下一篇</option></select>'
        + '<label style="display:flex;align-items:center;gap:3px;white-space:nowrap;flex:0 0 auto;"><input type="checkbox" data-f="docIndex"> 目录页</label>'
        + '<button class="btn btn-sm" data-act="del" style="flex:0 0 auto;">✕</button>';
      var styleSel = row.querySelector('[data-f="styleId"]');
      styleSel.innerHTML = '<option value="">（默认文档壳）</option>';
      api('/api/documents/shells').then(function (r) {
        ((r && r.shells) || []).forEach(function (s) {
          var o = document.createElement('option');
          o.value = s.id; o.textContent = s.name || s.id;
          styleSel.appendChild(o);
        });
        styleSel.value = d.styleId || '';
      }).catch(function () {});
      row.querySelector('[data-f="docNav"]').value = d.docNav || 'sidebar';
      row.querySelector('[data-f="docIndex"]').checked = !!d.docIndex;
      row.querySelector('[data-act="del"]').onclick = function () { row.remove(); };
      return row;
    }
    function paintRoutes() {
      var box = document.getElementById('doc-route-rows');
      box.innerHTML = '';
      st.routes.forEach(function (r, i) { box.appendChild(routeRow(r, i)); });
    }
    document.getElementById('doc-route-add').onclick = function () {
      st.routes.push({ abc: '', xyz: '', styleId: '', docNav: 'sidebar', docIndex: true });
      paintRoutes();
    };
    document.getElementById('doc-route-save').onclick = function () {
      var rows = document.querySelectorAll('#doc-route-rows > div');
      var routes = [];
      rows.forEach(function (row) {
        var abc = row.querySelector('[data-f="abc"]').value.trim();
        var xyz = row.querySelector('[data-f="xyz"]').value.trim();
        if (!abc && !xyz) return;
        routes.push({
          abc: abc,
          xyz: xyz,
          styleId: row.querySelector('[data-f="styleId"]').value,
          docNav: row.querySelector('[data-f="docNav"]').value,
          docIndex: row.querySelector('[data-f="docIndex"]').checked,
        });
      });
      note.textContent = '保存中…';
      api('/api/settings', { method: 'PUT', body: { site: { docRoutes: routes } } })
        .then(function () { note.textContent = '已保存（清 site:ctx，约 60s 生效）'; refreshAbc(); })
        .catch(function (e) { note.textContent = '保存失败：' + (e && e.message || e); });
    };

    // ---- 文档列表 / 上传 / 重建 ----
    function refreshAbc() {
      api('/api/settings').then(function (r) {
        var routes = ((r && r.site && r.site.docRoutes) || []);
        st.routes = routes;
        paintRoutes();
        var sel = document.getElementById('doc-pick-abc');
        var prev = sel.value;
        sel.innerHTML = '<option value="">（选择库）</option>';
        routes.forEach(function (rt) {
          var o = document.createElement('option');
          o.value = rt.abc; o.textContent = rt.abc + ' → ' + rt.xyz;
          sel.appendChild(o);
        });
        if (prev) sel.value = prev;
        st.abc = sel.value || '';
        if (st.abc) loadDocs(); else document.getElementById('doc-list').innerHTML = '<p class="muted">请先配置文档库映射并选择库。</p>';
      }).catch(function (e) { note.textContent = '读取失败：' + (e && e.message || e); });
    }
    function docViewHref(d) {
      var rt = st.routes.filter(function (x) { return x.abc === st.abc; })[0];
      if (!rt) return '#';
      var rel = String(d.path).replace(/\.(md|html?)$/i, '.html').split('/').map(encodeURIComponent).join('/');
      return '/' + encodeURIComponent(rt.xyz) + '/' + rel;
    }
    function updateSelCount() {
      var n = document.querySelectorAll('#doc-list input.doc-sel:checked').length;
      var sc = document.getElementById('doc-selcount');
      if (sc) sc.textContent = n ? ('已选 ' + n + ' 篇') : '';
    }
    function loadDocs() {
      var el = document.getElementById('doc-list');
      el.textContent = '加载中…';
      api('/api/documents?abc=' + encodeURIComponent(st.abc)).then(function (r) {
        var docs = (r && r.documents) || [];
        document.getElementById('doc-count').textContent = '共 ' + (r.total || 0) + ' 篇';
        if (!docs.length) { el.innerHTML = '<p class="muted">（该库还没有文档，用下方「上传/批量导入」添加）</p>'; return; }
        var html = '<table class="table" style="width:100%;"><thead><tr><th style="width:30px;"><input type="checkbox" id="doc-selall-cb"></th><th>路径</th><th>标题</th><th>格式</th><th>状态</th><th>操作</th></tr></thead><tbody>';
        docs.forEach(function (d) {
          html += '<tr>'
            + '<td><input type="checkbox" class="doc-sel" value="' + esc(d.path) + '"></td>'
            + '<td>' + esc(d.path) + '</td>'
            + '<td>' + esc(d.title || '') + '</td>'
            + '<td>' + esc(d.format || '') + '</td>'
            + '<td>' + (d.status === 'published' ? '发布' : '草稿') + '</td>'
            + '<td><a class="btn btn-sm" href="' + docViewHref(d) + '" target="_blank">查看</a> '
            + '<button class="btn btn-sm" data-del="' + esc(d.path) + '">删除</button></td></tr>';
        });
        el.innerHTML = html + '</tbody></table>';
        el.querySelectorAll('input.doc-sel').forEach(function (c) {
          c.addEventListener('change', updateSelCount);
        });
        var selAllCb = document.getElementById('doc-selall-cb');
        if (selAllCb) selAllCb.onclick = function () {
          var on = this.checked;
          el.querySelectorAll('input.doc-sel').forEach(function (c) { c.checked = on; });
          updateSelCount();
        };
        el.querySelectorAll('button[data-del]').forEach(function (b) {
          b.onclick = function () {
            if (!confirm('删除 ' + b.getAttribute('data-del') + '？（原稿+成品+元数据）')) return;
            api('/api/documents/delete', { method: 'POST', body: { abc: st.abc, path: b.getAttribute('data-del') } })
              .then(function () { loadDocs(); }).catch(function (e) { alert('删除失败：' + (e && e.message || e)); });
          };
        });
      }).catch(function (e) { el.innerHTML = '<p class="muted">读取失败：' + esc(e && e.message || e) + '</p>'; });
    }
    document.getElementById('doc-selall').onclick = function () {
      var cbs = document.querySelectorAll('#doc-list input.doc-sel');
      if (!cbs.length) return;
      var allChecked = Array.prototype.every.call(cbs, function (c) { return c.checked; });
      Array.prototype.forEach.call(cbs, function (c) { c.checked = !allChecked; });
      updateSelCount();
    };
    document.getElementById('doc-batch-del').onclick = function () {
      var sel = Array.prototype.slice.call(document.querySelectorAll('#doc-list input.doc-sel:checked')).map(function (c) { return c.value; });
      if (!sel.length) { alert('请先勾选要删除的文档'); return; }
      if (!confirm('删除选中的 ' + sel.length + ' 篇？（原稿+成品+元数据，不可撤销）')) return;
      api('/api/documents/delete', { method: 'POST', body: { abc: st.abc, paths: sel } })
        .then(function () { loadDocs(); }).catch(function (e) { alert('批量删除失败：' + (e && e.message || e)); });
    };
    document.getElementById('doc-pick-abc').onchange = function () {
      st.abc = this.value;
      if (st.abc) loadDocs();
    };
    document.getElementById('doc-refresh').onclick = function () { if (st.abc) loadDocs(); };
    document.getElementById('doc-rebuild').onclick = function () {
      if (!st.abc) return;
      if (!confirm('整库重建 ' + st.abc + '？（重新渲染所有成品）')) return;
      var b = document.getElementById('doc-rebuild');
      b.disabled = true;
      api('/api/documents/rebuild', { method: 'POST', body: { abc: st.abc } })
        .then(function (r) { b.disabled = false; alert('重建完成：' + (r.success || 0) + ' 成功 / ' + (r.fail || 0) + ' 失败'); loadDocs(); })
        .catch(function (e) { b.disabled = false; alert('重建失败：' + (e && e.message || e)); });
    };
    document.getElementById('doc-file').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      // 自动填路径（文件名）
      var p = document.getElementById('doc-path');
      if (!p.value) p.value = f.name;
    };
    document.getElementById('doc-upload').onclick = function () {
      if (!st.abc) { alert('请先在上方选择文档库'); return; }
      var f = document.getElementById('doc-file').files && document.getElementById('doc-file').files[0];
      if (!f) { alert('请先选择文件'); return; }
      var path = document.getElementById('doc-path').value.trim();
      if (!path) { alert('请填相对路径'); return; }
      var upNote = document.getElementById('doc-up-note');
      upNote.textContent = '上传中…';
      var rd = new FileReader();
      rd.onload = function () {
        var b64 = rd.result.split(',')[1];
        api('/api/documents/upsert', {
          method: 'POST',
          body: { abc: st.abc, path: path, title: document.getElementById('doc-title').value.trim(), content_base64: b64 },
        }).then(function () {
          upNote.textContent = '已上传（成品已失效，访问时自动重渲染）';
          loadDocs();
        }).catch(function (e) { upNote.textContent = '上传失败：' + (e && e.message || e); });
      };
      rd.readAsDataURL(f);
    };
    // 批量导入（选目录 → 一次性 POST /api/documents/import）
    document.getElementById('doc-bulk-go').onclick = function () {
      if (!st.abc) { alert('请先在上方选择文档库'); return; }
      var input = document.getElementById('doc-bulk');
      var fl = input.files;
      if (!fl || !fl.length) { alert('请先选择目录'); return; }
      var strip = document.getElementById('doc-bulk-strip').checked;
      var prefix = document.getElementById('doc-bulk-prefix').value.trim().replace(/^\/+|\/+$/g, '');
      var bkNote = document.getElementById('doc-bulk-note');
      var sel = [];
      for (var i = 0; i < fl.length; i++) {
        var f = fl[i];
        var rel = f.webkitRelativePath || f.name;
        if (strip) { var parts = rel.split('/'); if (parts.length > 1) parts.shift(); rel = parts.join('/'); }
        if (prefix) rel = prefix + '/' + rel;
        if (/\.(md|markdown|html?)$/i.test(rel)) sel.push({ file: f, path: rel });
      }
      if (!sel.length) { bkNote.textContent = '目录里没有 md/html 文件'; return; }
      bkNote.textContent = '读取 ' + sel.length + ' 个文件…';
      var payload = [];
      var pending = sel.length;
      sel.forEach(function (item) {
        var rd = new FileReader();
        rd.onload = function () { payload.push({ path: item.path, content_base64: rd.result.split(',')[1] }); if (--pending === 0) send(); };
        rd.onerror = function () { if (--pending === 0) send(); };
        rd.readAsDataURL(item.file);
      });
      function send() {
        if (!payload.length) { bkNote.textContent = '没有可导入的文件'; return; }
        bkNote.textContent = '导入 ' + payload.length + ' 篇（含整库重建）…';
        api('/api/documents/import', { method: 'POST', body: { abc: st.abc, files: payload, rebuild: true } })
          .then(function (r) {
            var rb = r.rebuild || {};
            bkNote.textContent = '完成：' + (r.success || 0) + ' 成功 / ' + (r.fail || 0) + ' 失败'
              + (rb.total != null ? '（重建 ' + (rb.success || 0) + '/' + rb.total + '）' : '');
            if (r.errors && r.errors.length) {
              bkNote.textContent += ' ｜失败：' + r.errors.slice(0, 6).map(function (e) { return e.path + '（' + (e.error || '') + '）'; }).join('；');
            }
            loadDocs();
          })
          .catch(function (e) { bkNote.textContent = '导入失败：' + (e && e.message || e); });
      }
    };
    // 文档壳编辑器
    function setShellCur() {
      var el = document.getElementById('doc-shell-cur');
      if (el) el.textContent = st.shellId ? ('当前壳 id：' + st.shellId) : '当前：内置默认壳（未绑定具名壳）';
    }
    document.getElementById('doc-shell-default').onclick = function () {
      api('/api/documents/shell').then(function (r) {
        document.getElementById('doc-shell-ta').value = r.docShell || '';
        document.getElementById('doc-shell-name').value = '';
        st.shellId = ''; setShellCur();
      }).catch(function () {});
    };
    document.getElementById('doc-shell-load').onclick = function () {
      var rt = st.routes.filter(function (x) { return x.abc === st.abc; })[0];
      var sid = rt ? rt.styleId : '';
      api('/api/documents/shell' + (sid ? '?id=' + encodeURIComponent(sid) : '')).then(function (r) {
        document.getElementById('doc-shell-ta').value = r.docShell || '';
        document.getElementById('doc-shell-name').value = (r.name && r.name !== '（默认文档壳）') ? r.name : '';
        st.shellId = sid || ''; setShellCur();
      }).catch(function () {});
    };
    function saveShell(applyTo) {
      var noteEl = document.getElementById('doc-shell-note');
      var ta = document.getElementById('doc-shell-ta').value;
      if (!ta.trim()) { noteEl.textContent = '壳内容为空'; return; }
      if (applyTo && !st.abc) { noteEl.textContent = '请先在「文档管理」选一个库'; return; }
      noteEl.textContent = '保存中…';
      var body = { name: document.getElementById('doc-shell-name').value.trim(), docShell: ta };
      if (applyTo) { body.applyTo = st.abc; if (st.shellId) body.id = st.shellId; }
      api('/api/documents/shell/save', { method: 'POST', body: body }).then(function (r) {
        if (applyTo && r.applied) {
          st.shellId = r.id; setShellCur();
          noteEl.textContent = '已保存并应用到库「' + st.abc + '」→ 去「文档管理」点「整库重建」即生效';
        } else {
          noteEl.textContent = '已保存为新壳（id=' + r.id + '）→ 到「文档库映射」把它选为该库的壳并保存';
        }
      }).catch(function (e) { noteEl.textContent = '保存失败：' + (e && e.message || e); });
    }
    document.getElementById('doc-shell-apply').onclick = function () { saveShell(true); };
    document.getElementById('doc-shell-save').onclick = function () { saveShell(false); };
    // 初始载入内置默认壳
    api('/api/documents/shell').then(function (r) { document.getElementById('doc-shell-ta').value = r.docShell || ''; setShellCur(); }).catch(function () {});
    setDlTab('routes');
    refreshAbc();
  }

  var NAVS = { posts: renderPosts, tax: renderTax, media: renderMedia, users: renderUsers, settings: renderSettings, tpl: renderTpl, comments: renderComments, documents: renderDocuments };

  function goNav() {
    var nav = location.hash.replace('#', '') || 'posts';
    // 深链：#edit/<id>、#new
    var editM = nav.match(/^edit\/(\d+)$/);
    if (editM || nav === 'new') {
      document.querySelectorAll('header nav a').forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('data-nav') === 'posts');
      });
      ['posts', 'tax', 'media', 'users', 'settings', 'tpl', 'comments', 'documents'].forEach(function (k) {
        var el = document.getElementById('view-' + (k === 'tax' ? 'tax' : k));
        if (el) el.classList.toggle('hidden', k !== 'posts');
      });
      if (nav === 'new') { renderEditor(null); return; }
      api('/api/posts/' + editM[1]).then(function (row) { renderEditor(row); }).catch(function () { renderPosts(); });
      return;
    }
    var ALIAS = { taxonomies: 'tax', categories: 'tax', templates: 'tpl' };
    if (ALIAS[nav]) nav = ALIAS[nav];
    if (!NAVS[nav]) nav = 'posts';
    document.querySelectorAll('header nav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === nav);
    });
    ['posts', 'tax', 'media', 'users', 'settings', 'tpl', 'comments', 'documents'].forEach(function (k) {
      var el = document.getElementById('view-' + (k === 'tax' ? 'tax' : k));
      if (el) el.classList.toggle('hidden', nav !== k);
    });
    NAVS[nav]();
  }

  window.addEventListener('hashchange', function () {
    if (getA()) goNav();
  });

  function setWho() {
    var el = document.getElementById('who');
    if (!el) return;
    el.textContent = '';
    if (!getA()) return;
    api('/api/me').then(function (u) {
      el.textContent = u.username ? (u.username + (u.role ? ' · ' + u.role : '')) : '';
    }).catch(function () { el.textContent = ''; });
    api('/api/settings').then(function (s) {
      var sn = document.getElementById('site-name');
      if (sn && s.site && s.site.name) sn.textContent = '☁️ ' + String(s.site.name).slice(0, 24);
    }).catch(function () {});
  }

  /* ---------- 首次初始化向导（空库时自动进入；也可手动 #setup） ---------- */
  function renderSetupWizard(note) {
    var card = document.getElementById('login-card');
    if (!card) return;
    card.classList.remove('hidden');
    document.getElementById('view').style.display = 'none';
    document.getElementById('topbar').classList.add('hidden');
    card.innerHTML =
      '<h1>🚀 初始化站点</h1>' +
      '<p class="muted" style="margin:4px 0 12px;">本站还没有任何账号。填好下面几项：会建好数据库表并创建第一个管理员。</p>' +
      '<div class="grid" style="max-width:440px;">' +
      '<label>站点名<input id="su-name" placeholder="我的站"></label>' +
      '<label>站点 URL<input id="su-url" placeholder="https://example.com"></label>' +
      '<label>管理员用户名<input id="su-user" placeholder="admin"></label>' +
      '<label>管理员密码（至少 8 位）<input id="su-pass" type="password"></label>' +
      '<label>再次输入密码<input id="su-pass2" type="password"></label>' +
      '<label>邮箱（可选）<input id="su-email"></label>' +
      '<div><button class="btn btn-primary" id="su-go">创建并完成初始化</button></div>' +
      '<div id="su-msg" class="muted" style="white-space:pre-wrap;"></div>' +
      '</div>';
    var msg = document.getElementById('su-msg');
    if (note) msg.textContent = note;
    document.getElementById('su-go').addEventListener('click', function () {
      var name = document.getElementById('su-name').value.trim() || 'My Static Site';
      var siteUrl = document.getElementById('su-url').value.trim();
      var u = document.getElementById('su-user').value.trim();
      var p = document.getElementById('su-pass').value;
      var p2 = document.getElementById('su-pass2').value;
      if (!/^[A-Za-z0-9_.-]{3,40}$/.test(u)) { msg.textContent = '用户名需 3-40 位字母 / 数字 / _ . -'; return; }
      if (p.length < 8) { msg.textContent = '密码至少 8 位'; return; }
      if (p !== p2) { msg.textContent = '两次输入的密码不一致'; return; }
      msg.textContent = '正在初始化…';
      fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: u, password: p, siteName: name, siteUrl: siteUrl,
          email: document.getElementById('su-email').value.trim(),
        }),
      }).then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
        .then(function (r) {
          if (r.s === 201 && r.d && r.d.ok) {
            msg.textContent = '✅ 初始化完成，正在跳转登录…\n（账号：' + u + '）';
            setTimeout(function () { location.hash = ''; location.reload(); }, 1000);
          } else {
            msg.textContent = '❌ ' + ((r.d && r.d.error) || '初始化失败');
          }
        }).catch(function () { msg.textContent = '网络错误'; });
    });
  }

  /** 检查是否需要初始化；老版本 Worker 没有该端点时静默跳过 */
  function checkSetup() {
    var force = String(location.hash || '').replace(/^#\/?/, '') === 'setup';
    return fetch('/api/setup/status').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.initialized === false) {
        renderSetupWizard('');
      } else if (force) {
        renderSetupWizard('⚠️ 本站已完成初始化（已有账号）。这里仅作查看；若要重建请直接改 D1 的 users 表。');
      }
    }).catch(function () { /* 忽略：按老流程走登录 */ });
  }

  function boot() {
    flash('flash-main', '', null);
    flash('flash-login', '', null);
    if (!needAuth()) { setWho(); checkSetup(); return; }
    setWho();
    goNav();
  }

  bindLogin();
  boot();
})();
