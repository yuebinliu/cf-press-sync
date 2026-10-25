# CFSE 站点运行时 —— 从零部署

一个跑在 Cloudflare 上的**静态站 + 轻 CMS**：文章存 D1、单页存 R2（未命中时按需渲染并回填）、
列表页/分类/标签/归档由 Worker 从 D1 实时渲染，后台管理面在 `/admin/`。
静态资源（主题 css/js）走 assets 免费直出。

> 免费档足够用：Worker 10 万请求/天、D1 5GB、R2 10GB、KV 1GB。

---

## 0. 前置

- Node ≥ 18，`npx wrangler` 可用并已登录：`npx wrangler login`
- 一个 Cloudflare 账号（D1 / R2 / KV 都开在它下面）

## 1. 创建资源 + 生成配置

```bash
cd worker

# 先看看会做什么（不创建任何东西）
node scripts/setup.mjs --dry-run

# 实际创建 D1 / KV / R2，并生成 wrangler.toml
node scripts/setup.mjs                 # 可用 --name=my-site 自定义命名前缀
```

**已有资源**的话不用它，直接手工填：

```bash
cp wrangler.toml.example wrangler.toml
# 然后照着文件里的注释，把 3 个 REPLACE_* 换成你自己的 ID
```

## 2. 部署

```bash
npm run deploy        # = 扫描内置风格索引 + wrangler deploy
```

## 3. 初始化站点（创建第一个管理员）

打开 `https://<你的域名>/admin/`：

- **空库时**会直接进入「初始化向导」→ 填站点名 / 站点 URL / 管理员账号密码 → 完成，随即可以登录；
- 也可以用 curl 直接初始化：

```bash
curl -X POST https://<你的域名>/api/setup -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"至少8位","siteName":"我的站","siteUrl":"https://<你的域名>"}'

# 查状态：
curl https://<你的域名>/api/setup/status
```

⚠️ **安全**：`POST /api/setup` 只在**没有任何用户**时可用；建好第一个管理员后**永久返回 403**。
所以部署完请**尽快**完成初始化，别让陌生人抢先建号。

## 4. 内容从哪来（三选一，可混用）

| 来源 | 怎么做 |
|---|---|
| **WP 插件推送** | WP 后台装插件 → 填站点 URL 与 X-Auth-Key（与 Worker 的 `auth_key` 一致）→ 在「发布行为」勾选要自动做的事（同步 D1 / 生成静态文件 / 上传远端） |
| **第三方 md 编辑器** | 用 `/wp-json/wp/v2/*` + **应用密码**（后台「用户 → 🔑 应用密码」生成）。现成插件见 `../tools/obsidian-md-publisher/` |
| **后台直接写** | `/admin/` → 文章 → 新建（支持 Markdown / 富文本） |

## 5. 常用配置

| 想改什么 | 去哪 |
|---|---|
| 站点名 / 描述 / URL 结构（permalink） | `/admin/` → 设置 |
| 缓存策略（TTL）、批量任务并发 | `/admin/` → 设置 |
| 模板 / 风格包（6 类模板） | `/admin/` → 模板 |
| 主题静态资源（css/js/图片） | 放进 `worker/static/...` 后 `npm run deploy`（assets 命中即免费直出） |
| 单页在 R2 未命中时的回源 | `wrangler.toml` 的 `WORDPRESS_URL`（一般留空） |

## 6. 排障

- **看日志**：`npm run logs`（= `wrangler tail`）。本机若连不上 Cloudflare 的 tail 端点，改用 Dashboard → Workers → Logs。
- **某个单页 404**：R2 里没有该对象时，Worker 会用 D1 的内容**按需渲染并回填**；若仍 404，说明该 slug 不在 D1（或状态不是 published）。
- **改了 md 文章但页面没变**：md 单页由 Worker 渲染，WP 侧导出时会清除旧单页；若是用第三方编辑器/PUT 更新，Worker 会直接重建。
- **图片 404**：媒体文件必须真在 R2 的 `wp-content/uploads/` 下；文件名会统一成小写 `%xx`（中文也行）。
- **数据结构**：见 `../schema.sql`（文件头写了「Worker `ensureCoreSchema` / WP 插件 `ensure_d1_schema` / 本文件**三处同步**」——改表结构时别只改一处）。

## 7. 目录速查

```
worker/
├── src/                 Worker 源码（routes 前台路由 / admin 后台 API / wpv2 第三方入口 / database 查询…）
├── static/              assets：主题资源 + /admin/ 后台 SPA（随部署打包，命中免费直出）
├── scripts/
│   ├── setup.mjs        本文件第 1 步用的引导脚本
│   └── sync-themes-index.mjs  部署前扫描内置风格
├── wrangler.toml.example  配置模板（含 3 个 ID 占位）
└── wrangler.toml          你自己的配置（**不要提交到公开仓库**）
```
