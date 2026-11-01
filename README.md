# CFSE Sync for WordPress

把 WordPress 变成**自托管 CMS 的内容后台**：文章数据同步到 Cloudflare D1，单页 HTML 由 Worker 现场渲染。

> 独立插件，无外部依赖。整个目录可直接复制到 `wp-content/plugins/` 使用。

## 状态

**v2.1.1（2026-11-02）** —— 附件同步修好。

| 变化 | 说明 |
|---|---|
| **正文附件不再漏传** | 之前只扫 `<img>`，正文里 `<a href>` 指向的 zip/pdf/mp3 一个都不上传 —— 文章能打开、点下载 404。现在任何 `src`/`href` 里的本站 uploads 地址都会同步 |
| 大文件保护 | 单个文件超过 20MB 只记日志、不自动上传（`/upload` 是 base64 JSON，硬传必超时） |
| 上传超时 30s → 90s | 附件体积比图片大，base64 后还要再涨 1/3 |

**v2.1.0（2026-11-01）** —— 收尾与归位。

| 变化 | 说明 |
|---|---|
| 删文章不再扫全库清分类 | 由 472 行降为 20 行（只动本篇涉及的分类/标签） |
| 补齐三条件索引 DDL | `posts(status, date)` / `post_taxonomy` 的复合索引 |
| **版本号归位** | 文件头长期停在 `1.0.0`，与本文档的 `2.0.0` 不一致；现统一为 `2.1.0` |
| 日志改名 | 新装写 `cfse-sync.log`；从 `cf-static-export` 升级的用户自动沿用旧文件，历史日志不丢 |

**v2.0.0（2026-10-25）** —— 收敛为「CMS 的 WordPress 客户端」。

这一版砍掉了一批与「同步内容」无关的东西：

| 变化 | 说明 |
|---|---|
| **不再内嵌 Worker 源码** | 部署改用从 CMS 官方下载的**发行包**。以前内嵌一份副本，必然漂移 —— 2026-10-25 真的漂了：CMS 仓删掉的 `documents.js` 还在插件副本里，部署一次就把已砍掉的文档库推回线上 |
| **不再生成路由规则** | `routes.js` 的 URL 结构改成运行时从 D1 读（CMS 侧已运行时化）。改 URL 结构在 **CMS 后台**改完即生效，不用部署、不用插件参与 |
| **砍掉 S3 / local provider** | 静态托管由 `wp-static-deploy` 插件承接。本插件只跟 CMS 打交道 |
| **后台 UI 重排为三屏状态机** | 按「未连接 / 已配置 / 已连接」显示不同内容。基础层永远可见，高级层折叠 |

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

## 三屏状态机

设置页按「你跟 CMS 连到什么程度」显示不同的内容：

| 状态 | 判定 | 你看到什么 |
|---|---|---|
| **未连接** | 没填 CMS 地址 | 三步引导：准备 Cloudflare 账号 → 下载并部署 CMS → 填连接信息。主路径是「⬇️ 下载 CMS 发行包」按钮，图文教程是次要按钮 |
| **已配置** | 填了地址但没测过 | 显示已填的地址与密钥 + 「🔌 测试连接」 |
| **已连接** | 测通过 | 直接显示 CMS 地址，引导去「⚡ 同步内容」 |

高级区块（部署 CMS / Worker 后台账号 / 站点列表）默认折叠 —— 基础层永远可见。

## 部署 CMS：发行包机制

插件不内嵌源码，部署时从两个源按顺序拉取发行包（`.tar.gz`）：

1. **GitHub Releases** —— 查 API 拿最新版的 `.tar.gz` 资产
2. **官网** —— 可配置的站点地址，默认 `https://yuebin.uk`，路径 `/downloads/cf-cms-latest.tar.gz`
3. **固定生产地址** —— `https://wp-static-pro.yuebinliu.workers.dev`（第三备源）

下载后解压到 `cms-package/cf-cms/`，「部署」时用 `wrangler` 把它推上去。

**为什么是 tar.gz 不是 zip**：`ZipArchive` 是 PHP 的可选扩展，很多服务器没装；`PharData` 是 PHP 自带的，普遍可用。

**为什么官网地址是配置项**：将来换正式域名只改设置，不用改代码。

## 目录

```
cfse-sync/
├── cfse-sync.php              主类（转发层）
├── includes/
│   ├── class-admin-ui.php     后台设置页 / 文章面板
│   ├── class-worker-cms.php   D1 / R2 同步
│   ├── class-transports.php   多目标抽象（只对接 CMS）
│   ├── class-release.php      发行包下载 / 解压 / 部署
│   ├── class-onboarding.php   连接状态机（三屏）
│   └── class-compat.php       兼容层
├── assets/
│   ├── admin.css
│   └── cfse-onboarding.css    状态机样式
├── test/
│   └── verify-onboarding.php  离线验证（14 项断言）
└── vendor/parsedown/
```

## 目录约定

- **`cms-package/`** —— 下载的发行包解压在这里（运行时生成，不入库）
- **`worker/`** —— **已删除**。以前内嵌源码副本，2026-10-25 被发行包机制取代

## 离线验证

不激活插件、不碰数据库，用 WP 函数桩跑逻辑：

```bash
# 在服务器上
docker exec web-php php /var/www/html/wp-content/plugins/cfse-sync/test/verify-onboarding.php
```

覆盖：三屏状态判定 · 状态迁移 · get_primary 回落 · 目标列表与单表单对齐 · 发行包三源 · 源码目录解析。

## 与 CMS 的边界

| 归 CMS 后台管 | 归本插件管 |
|---|---|
| URL 结构（permalink） | 文章 / 评论数据同步 |
| 模板、风格、外观 | 图片上传到 R2 |
| 缓存策略、每页文章数 | 旧单页清理 |
| 站点信息（名称、描述、时区、默认作者） | 连接与部署 |

**唯一例外**：插件会读 CMS 的 `storagePattern` 来算 R2 存储路径 —— 两边必须一致，否则删不到旧单页（Worker 命中 R2 直接返回，不回查 D1）。

## 相关

- **CMS 仓库**：`cf-cms` —— Worker 端源码，本插件的部署对象
- **静态托管**：`wp-static-deploy` —— 通用静态托管（9 种 transport），与本插件无关
