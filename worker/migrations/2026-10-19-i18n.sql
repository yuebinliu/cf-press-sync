-- 多语言站点迁移（阶段 A：中文占根，英文进 /en/）
-- 配套方案：docs/i18n-plan.md
-- 执行：wrangler d1 execute wordpress --remote --file=worker/migrations/2026-10-19-i18n.sql
--
-- 顺序要求：先跑本文件，再部署带 lang 逻辑的 Worker，最后导入英文文章。
-- 本文件**幂等**：重复执行时 ALTER 会报 duplicate column，可忽略（或用 --force）。
--
-- 注意：本文件**不改** posts.slug 的唯一约束。
-- 若要让两语言共用同一 slug，需另行重建表成 UNIQUE(slug, lang)（见 i18n-plan §3.1）。
-- 过渡期建议英文 slug 独立，UNIQUE(slug) 继续成立。

-- ── 1. posts：语言 + 对译分组 ────────────────────────────────────────────────
ALTER TABLE posts ADD COLUMN lang TEXT NOT NULL DEFAULT 'zh';
ALTER TABLE posts ADD COLUMN translation_key TEXT NOT NULL DEFAULT '';

-- 存量文章全部视为中文；translation_key 用自身 slug 作为分组键，
-- 英文版导入时填同一个 translation_key 即可配对（切换开关靠它找对译页）。
UPDATE posts SET lang = 'zh' WHERE lang IS NULL OR lang = '';
UPDATE posts SET translation_key = slug WHERE translation_key IS NULL OR translation_key = '';

-- 列表页 / 归档页的核心查询是 (lang, status, date DESC)，没有这个索引会全表扫。
CREATE INDEX IF NOT EXISTS idx_posts_lang_status_date ON posts(lang, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_posts_translation ON posts(translation_key);

-- ── 2. taxonomies：分类/标签也要分语言 ──────────────────────────────────────
ALTER TABLE taxonomies ADD COLUMN lang TEXT NOT NULL DEFAULT 'zh';
UPDATE taxonomies SET lang = 'zh' WHERE lang IS NULL OR lang = '';

-- ── 3. 站点设置：英文补丁行 ────────────────────────────────────────────────
-- settings.k = 'site'      → 主语言（阶段 A = 中文，现有配置不动）
-- settings.k = 'site:en'   → 英文（补丁语义：只写与主语言不同的字段，其余继承 'site'）
--
-- 两条原则：
--   ① 不存 url —— 由 siteUrlFor(base.url, lang) 派生，存了会和 base 打架
--   ② 不存 logo/social/comments/layout/activeStyleId —— 与语言无关，继承主语言
--
-- 下面这行**不会自动执行**，取消注释后按实际英文站名/副标题填写再跑。
--
-- INSERT INTO settings (k, v) VALUES ('site:en', json('{
--   "name": "CF Static Export Pro",
--   "description": "Static WordPress export plus a standalone Cloudflare CMS",
--   "menu": []
-- }'))
-- ON CONFLICT(k) DO UPDATE SET v = excluded.v;
--
-- ── 4. 语言模块配置（写进主语言行 'site' 的 i18n 子对象）────────────────────
-- 阶段 A 先不启用切换开关，只登记语言清单；阶段 B 翻转时把 default 改成 'en'。
--
-- UPDATE settings
--    SET v = json_set(v, '$.i18n', json('{"default":"zh","enabled":["zh","en"],"labels":{"zh":"中文","en":"English"},"detect":"path"}'))
--  WHERE k = 'site';
