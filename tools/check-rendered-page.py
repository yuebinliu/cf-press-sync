#!/usr/bin/env python3
"""
渲染产物深度体检：表单归属 + 栅格布局归属。

为什么需要它（2026-10-25 「设置页冲破」事故）：
  ① 嵌套 <form> —— HTML5 规定 form 起始标签不能嵌套。浏览器会丢弃内层起始标签，
     但内层的 </form> 会把**外层主表单关掉**，于是主表单从第一个操作按钮处就断了，
     后面「基础配置」的 cf_batch_size 等字段全部落在表单外，点「保存配置」一个都存不进去。
  ② </details> 缺失 —— 折叠块会把后面的兄弟节点（整个右栏）吞进去，折叠状态下直接不显示。

标签配平由 check-html-structure.mjs 负责；本脚本负责「语义归属」这一层：
  · 每个按钮实际提交到哪个 form（HTML5 form owner 规则：form 属性 > 最近祖先 form）
  · 主表单是否真的包含了所有设置字段
  · .cfse-grid 下是否正好两栏、右栏没有被塞进折叠块
  · 每个 <details> 是否都有 <summary>、有没有吞掉整栏

用法：python tools/check-rendered-page.py <rendered.html>
依赖：html5lib
"""

import sys

try:
    import html5lib
except ImportError:
    print("  ⚠ 跳过：当前 python 没装 html5lib（pip install html5lib）")
    sys.exit(0)


def cls(el):
    return (el.get('class') or '').split()


def main(path):
    src = open(path, encoding='utf-8').read()
    doc = html5lib.parse(src, namespaceHTMLElements=False)
    ok = True

    forms = {}
    for f in doc.findall('.//form'):
        if f.get('id'):
            forms[f.get('id')] = f

    # ---------- 1) 表单归属 ----------
    print(f"<form> 元素共 {len(forms)} 个")
    print("\n=== 按钮 → 表单（HTML5 form owner 规则）===")

    owners = {}

    def walk(node, cur):
        for c in list(node):
            nxt = cur
            if c.tag == 'form':
                nxt = c.get('id') or ''
            if c.tag == 'button' and c.get('type') in (None, 'submit'):
                label = (c.text or '').strip()[:26]
                if label:
                    fid = c.get('form')
                    if fid:
                        owners[label] = fid if fid in forms else f'!!{fid}(不存在)'
                    else:
                        owners[label] = cur or '(无表单)'
            walk(c, nxt)

    walk(doc, None)

    for label, owner in owners.items():
        good = owner in forms
        if not good:
            ok = False
        print(f"  {'✓' if good else '✗'} 「{label}」 → {owner}")

    # ---------- 2) 主表单是否含设置字段 ----------
    main = forms.get('cfse-options')
    print("\n=== 主表单 cfse-options 是否包含设置字段 ===")
    if main is None:
        print("  ✗ 找不到 #cfse-options")
        ok = False
    else:
        names = set()
        for i in main.findall('.//input') + main.findall('.//select') + main.findall('.//textarea'):
            if i.get('name'):
                names.add(i.get('name'))
        need = [
            'cf_site_url', 'cf_auth_key',
            'cf_batch_size', 'cf_max_retries',
            'cf_cms_package_url', 'cf_cms_github_repo',
            'cf_enable_logging', 'cf_debug_mode',
        ]
        for n in need:
            hit = n in names
            if not hit:
                ok = False
            print(f"  {'✓' if hit else '✗'} {n}")

    # ---------- 3) 栅格布局 ----------
    print("\n=== 栅格布局 ===")

    def find(node, pred):
        for c in list(node):
            if pred(c):
                return c
            r = find(c, pred)
            if r is not None:
                return r
        return None

    grid = find(doc, lambda e: 'cfse-grid' in cls(e))
    if grid is None:
        print("  ✗ 找不到 .cfse-grid")
        ok = False
    else:
        cols = [c for c in list(grid) if 'cfse-col' in cls(c)]
        two = len(cols) == 2
        if not two:
            ok = False
        print(f"  {'✓' if two else '✗'} .cfse-grid 直属 .cfse-col = {len(cols)} 个（应为 2）")
        for i, col in enumerate(cols):
            side = '左' if i == 0 else '右'
            titles = [(c.text or '').strip()[:18] for c in col.iter() if c.tag == 'h2']
            print(f"    {side}栏 h2: {titles}")

    # ---------- 4) details 完整性 ----------
    print("\n=== 折叠块 details ===")
    details = doc.findall('.//details')
    for d in details:
        s = d.find('summary')
        label = (s.text or '').strip()[:30] if s is not None else '(缺 summary!)'
        swallowed = any('cfse-col' in cls(x) for x in d.iter())
        if s is None or swallowed:
            ok = False
        note = '✗ 吞掉了整栏！' if swallowed else ('✗ 缺 summary' if s is None else '✓')
        print(f"  {note} {label}")

    print()
    if not ok:
        print("❌ 渲染产物存在归属/布局问题")
        return 1
    print("✅ 表单归属与栅格布局全部正常")
    return 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python tools/check-rendered-page.py <rendered.html>")
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
