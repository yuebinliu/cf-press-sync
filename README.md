# CFSE Sync for WordPress

把 WordPress 变成**自托管 CMS 的内容后台**：文章数据同步到 Cloudflare D1，单页 HTML 由 Worker 现场渲染。

> 独立插件，无外部依赖。整个目录可直接复制到 `wp-content/plugins/` 使用。

## 状态

**v1.0.0（2026-10-21）** —— 从 `cf-static-export-pro` 2.5.0 拆出的「CMS 同步」那一半。
渲染链路、本地落盘、R2 单页上传、模板编辑器、主题资源同步、第三方托管 transport 全部移除。

## 它到底做什么

| 时机 | 动作 |
|---|---|
| 发布 / 更新文章 | 写 D1（标题、正文、摘要、分类、标签、md 标记、评论开关） |
| 正文含图片 | 把图片上传到 R2，静态站不依赖 WP 在线 |
| 数据变了 | **删掉** R2 里该篇的旧单页（含 `.gz`） |
| 读者访问 | Worker 发现 R2 未命中 → 从 D1 取数据 → 用当前风格渲染 → 回填 R2 → 返回 |

也就是说：**插件不生成 HTML**。渲染永远发生在 Worker 侧，所以后台换风格、改模板立刻全站生效，不需要重建。

## 为什么要删旧单页

Worker 命中 R2 就直接返回，不会回查 D1。如果不删，改完文章后线上永远是上一次的旧页面。
删掉之后 `routes.js` 会落到 `renderSinglePageOnDemand()`，用最新 D1 内容重新渲染并回填 —— 这是整套设计里最关键的一步。

## 目录

```
cfse-sync/
├── cfse-sync.php               # 插件入口（常量、钩子、同步链路、Worker 部署）
├── uninstall.php
├── includes/
│   ├── class-admin-ui.php      # 设置页 / 文章面板 / 托管目标表格
│   ├── class-worker-cms.php    # D1 / R2 读写、拉取、评论同步
│   ├── class-transports.php    # cloudflare（Worker API）+ s3
│   └── class-compat.php        # 兼容函数（cfse_storage_pattern）
├── assets/                     # 后台 css / js
├── vendor/parsedown/           # Markdown 渲染（WP 前台预览用）
└── worker/                     # Worker 运行时（随插件分发）
    ├── src/                    # index / routes / template-engine / admin / database …
    ├── static/                 # 后台 UI、highlight.js、内置风格 cfse-demo
    ├── migrations/
    ├── scripts/                # setup.mjs（建 D1/KV/R2）、sync-themes-index.mjs
    ├── wrangler.toml.example   # 首次部署时自动生成 wrangler.toml
    └── package.json
```

## 安装

1. 整个 `cfse-sync` 目录复制到 `wp-content/plugins/`
2. 启用 **CFSE Sync for WordPress**
3. **设置 → CFSE 同步**：
   - 🎯 托管目标 → 添加一条 `Cloudflare` 模板的目标，填 Worker 地址 + Auth Key
   - 该目标「⚙️ 配置」→ 填 Account ID、API Token、R2 Bucket、D1 Database ID
   - 🔄 同步路由规则 → 🚀 部署 Worker
   - 📤 全量同步到 D1

`worker/` 需要 `npm install`（wrangler 部署时会打包 `marked`）。首次点「🚀 部署 Worker」会自动从 `wrangler.toml.example` 生成 `wrangler.toml`，并把插件里已填的 D1 / R2 名字代进去；**KV namespace id 仍需手工补**（`npx wrangler kv namespace create cfse-cache`）。

## 与另两个插件的关系

| 插件 | 定位 |
|---|---|
| **CFSE Sync for WordPress**（本仓库） | WordPress → D1 数据同步 + Worker 部署。产出**数据** |
| **WP Static Deploy** | 抓取 WP 前台 HTML，发布到 Cloudflare Pages / S3 / FTP / WebDAV / GitHub / Netlify / Vercel。产出**文件** |

两者都 hook `save_post`，**同一站点不要同时启用**。

## 与旧版的差异（2.5.0 → 1.0.0）

删掉的：

- `generate_post_html` / `render_with_template` / `fetch_from_frontend` / `post_process_html` / `normalize_source_hosts` / `generate_fallback_html`
- `build_post_artifact` / `write_artifact_local` / `publish_artifact` / `export_post_by_switches` / `do_export_post`
- `generate_post_local` / `publish_post_local` / `export_post_manual` / `run_export_mode`
- 发布行为三开关（同步 D1 / 生成静态文件 / 上传 R2）与手动导出参数
- 模板编辑器（`views/template-editor.php` 2032 行）、皮肤构建器、主题资源同步、风格资源同步
- GitHub / GitLab / Netlify / Vercel / FTP / WebDAV / 本地目录 七种 transport（约 800 行）
- `exec` 并发导出（子进程脚本 `tools/bulk-export-worker.php` 本就不在包里）

改动的：

- `export_post()` 只写 D1 + 同步媒体 + 删旧单页；`sync_d1` 开关仍然生效（关掉后只能手动全量同步）
- 全量同步改为串行（每篇一次 D1 批量请求，不需要并发）
- 列表状态列 / 状态面板文案：已导出 → 已同步
- 设置页 slug：`cf-static-export-pro` → `cfse-sync`
- 插件主文件：`cf-static-export-pro.php` → `cfse-sync.php`

保留的（代码前缀 `CFSE_` / `cfse_` 共 754 处，不改名）：

- 所有 option 名（`cf_*`）、post meta（`cfse_site` / `_cfse_synced_d1` / `content_format`）
- D1 表结构与 SQL、Worker 端代码、评论双向同步、拉取、站点信息合并写入
