/**
 * 数据库操作 - 关联表版本 v2
 * taxonomies: PRIMARY KEY (type, slug)；post_taxonomy 含 taxonomy_type —— 修复同名 category/tag slug 串扰
 * 所有列表查询支持 perPage 参数（WP 设置页「列表每页文章数」经 routes.js 的 CFSE_PER_PAGE 常量传入）
 *
 * ── 多语言（2026-10-19）────────────────────────────────────────────────────
 * 每个前台查询都接受一个**可选的最后一个参数 `lang`**：
 *   lang 为空 / null / undefined  ⇒ 不加语言条件（= 改造前的行为，向后兼容）
 *   lang = 'zh' | 'en' | …        ⇒ 追加 `AND lang = ?`
 *
 * 为什么要「空 = 不过滤」而不是「空 = 主语言」：
 *   改造前所有调用点都不传 lang，若默认成主语言，任何遗漏都会静默改变行为；
 *   默认不过滤则相反 —— 漏传只是「没启用语言筛选」，不会出错。
 *   调用点由 routes.js 统一传 lang（见 §渲染入口）。
 */

// 安全获取计数的辅助函数
function safeCount(result) {
    if (result === null || result === undefined) return 0;
    // 如果 result 是对象（如 { count: '5' }）
    if (typeof result === 'object' && result.count !== undefined) {
        return parseInt(result.count) || 0;
    }
    // 如果 result 是字符串或数字
    return parseInt(result) || 0;
}

/** 归一化语言参数：返回去空白的字符串，或 '' 表示不筛选 */
function langOf(lang) {
    return String(lang == null ? '' : lang).trim();
}

export async function getTaxonomyInfo(db, type, slug) {
    try {
        const row = await db.prepare(
            "SELECT type, slug, name FROM taxonomies WHERE type = ? AND slug = ?"
        ).bind(type, slug).first();
        return row || null;
    } catch (error) {
        console.error('getTaxonomyInfo error:', error);
        return null;
    }
}

export async function getPostsByTaxonomy(db, type, slug, page = 1, perPage = 10, lang = null) {
    const offset = (page - 1) * perPage;
    const L = langOf(lang);
    const langSql = L ? ' AND p.lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        const posts = await db.prepare(
            `SELECT p.* FROM posts p
             INNER JOIN post_taxonomy pt ON p.wp_id = pt.post_id AND pt.taxonomy_type = ?
             INNER JOIN taxonomies t ON pt.taxonomy_slug = t.slug AND pt.taxonomy_type = t.type
             WHERE t.slug = ? AND t.type = ? AND p.status = 'published'${langSql}
             ORDER BY p.date DESC LIMIT ? OFFSET ?`
        ).bind(type, slug, type, ...langArg, perPage, offset).all();

        const totalResult = await db.prepare(
            `SELECT COUNT(*) as count FROM posts p
             INNER JOIN post_taxonomy pt ON p.wp_id = pt.post_id AND pt.taxonomy_type = ?
             INNER JOIN taxonomies t ON pt.taxonomy_slug = t.slug AND pt.taxonomy_type = t.type
             WHERE t.slug = ? AND t.type = ? AND p.status = 'published'${langSql}`
        ).bind(type, slug, type, ...langArg).first();

        const total = safeCount(totalResult);

        return {
            posts: posts.results || [],
            total: total,
            currentPage: page,
            totalPages: Math.ceil(total / perPage)
        };
    } catch (error) {
        console.error('getPostsByTaxonomy error:', error);
        return { posts: [], total: 0, currentPage: page, totalPages: 0 };
    }
}

export async function getRecentPosts(db, page = 1, perPage = 10, lang = null) {
    const offset = (page - 1) * perPage;
    const L = langOf(lang);
    const langSql = L ? ' AND lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        const posts = await db.prepare(
            "SELECT * FROM posts WHERE status = 'published'" + langSql + " ORDER BY date DESC LIMIT ? OFFSET ?"
        ).bind(...langArg, perPage, offset).all();

        const totalResult = await db.prepare(
            "SELECT COUNT(*) as count FROM posts WHERE status = 'published'" + langSql
        ).bind(...langArg).first();

        const total = safeCount(totalResult);

        return {
            posts: posts.results || [],
            total: total,
            currentPage: page,
            totalPages: Math.ceil(total / perPage)
        };
    } catch (error) {
        console.error('getRecentPosts error:', error);
        return { posts: [], total: 0, currentPage: page, totalPages: 0 };
    }
}

export async function searchPosts(db, query, page = 1, perPage = 20, lang = null) {
    const offset = (page - 1) * perPage;
    const L = langOf(lang);
    const langSql = L ? ' AND lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        const posts = await db.prepare(
            `SELECT * FROM posts WHERE status = 'published'${langSql}
             AND (title LIKE ? OR content LIKE ? OR excerpt LIKE ?)
             ORDER BY date DESC LIMIT ? OFFSET ?`
        ).bind(...langArg, `%${query}%`, `%${query}%`, `%${query}%`, perPage, offset).all();

        const totalResult = await db.prepare(
            `SELECT COUNT(*) as count FROM posts WHERE status = 'published'${langSql}
             AND (title LIKE ? OR content LIKE ? OR excerpt LIKE ?)`
        ).bind(...langArg, `%${query}%`, `%${query}%`, `%${query}%`).first();

        const total = safeCount(totalResult);

        return {
            posts: posts.results || [],
            total: total,
            currentPage: page,
            totalPages: Math.ceil(total / perPage)
        };
    } catch (error) {
        console.error('searchPosts error:', error);
        return { posts: [], total: 0, currentPage: page, totalPages: 0 };
    }
}

export async function getPostsByArchive(db, year, month = null, page = 1, perPage = 10, lang = null) {
    const offset = (page - 1) * perPage;
    const L = langOf(lang);
    const langSql = L ? ' AND lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        let startDate = `${year}-01-01`;
        let endDate = `${parseInt(year) + 1}-01-01`;
        if (month) {
            const paddedMonth = String(month).padStart(2, '0');
            startDate = `${year}-${paddedMonth}-01`;
            const nextMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1;
            const nextYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year);
            endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
        }
        const sql = `SELECT * FROM posts WHERE status = 'published'${langSql} AND date >= ? AND date < ? ORDER BY date DESC LIMIT ? OFFSET ?`;
        const posts = await db.prepare(sql).bind(...langArg, startDate, endDate, perPage, offset).all();

        const countSql = `SELECT COUNT(*) as count FROM posts WHERE status = 'published'${langSql} AND date >= ? AND date < ?`;
        const totalResult = await db.prepare(countSql).bind(...langArg, startDate, endDate).first();
        const total = safeCount(totalResult);

        return {
            posts: posts.results || [],
            total: total,
            currentPage: page,
            totalPages: Math.ceil(total / perPage)
        };
    } catch (error) {
        console.error('getPostsByArchive error:', error);
        return { posts: [], total: 0, currentPage: page, totalPages: 0 };
    }
}

/**
 * 侧边栏 - 分类列表（按 name 排序，与 WP categories widget 顺序一致）
 * 仅含有已发布文章的 taxonomy（D1 只在文章导出时 upsert taxonomies，天然非空）
 * lang 有值时只统计该语言的文章 —— 否则英文站侧栏会显示中文分类的空壳。
 */
export async function getSidebarCategories(db, lang = null) {
    const L = langOf(lang);
    const langSql = L ? ' AND p.lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        const result = await db.prepare(
            `SELECT t.slug, t.name, COUNT(p.wp_id) AS cnt
             FROM taxonomies t
             JOIN post_taxonomy pt ON pt.taxonomy_type = t.type AND pt.taxonomy_slug = t.slug
             JOIN posts p ON p.wp_id = pt.post_id AND p.status = 'published'${langSql}
             WHERE t.type = 'category'
             GROUP BY t.slug, t.name
             ORDER BY t.name COLLATE NOCASE ASC`
        ).bind(...langArg).all();
        return result.results || [];
    } catch (error) {
        console.error('getSidebarCategories error:', error);
        return [];
    }
}

/**
 * 侧边栏 - 标签列表（仅含有文章的标签；顺序与 WP tag cloud 一致：name ASC）
 */
export async function getSidebarTags(db, lang = null) {
    const L = langOf(lang);
    const langSql = L ? ' AND p.lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        const result = await db.prepare(
            `SELECT t.slug, t.name, COUNT(p.wp_id) AS cnt
             FROM taxonomies t
             JOIN post_taxonomy pt ON pt.taxonomy_type = t.type AND pt.taxonomy_slug = t.slug
             JOIN posts p ON p.wp_id = pt.post_id AND p.status = 'published'${langSql}
             WHERE t.type = 'tag'
             GROUP BY t.slug, t.name
             ORDER BY t.name COLLATE NOCASE ASC`
        ).bind(...langArg).all();
        return result.results || [];
    } catch (error) {
        console.error('getSidebarTags error:', error);
        return [];
    }
}

/**
 * 侧边栏 - 归档月份（date 前 7 位 YYYY-MM，按时间倒序）
 */
export async function getArchiveMonths(db, lang = null) {
    const L = langOf(lang);
    const langSql = L ? ' AND lang = ?' : '';
    const langArg = L ? [L] : [];
    try {
        const result = await db.prepare(
            `SELECT substr(date, 1, 7) AS ym, COUNT(*) AS cnt
             FROM posts
             WHERE status = 'published'${langSql}
             GROUP BY ym
             ORDER BY ym DESC`
        ).bind(...langArg).all();
        return result.results || [];
    } catch (error) {
        console.error('getArchiveMonths error:', error);
        return [];
    }
}

/**
 * 侧边栏完整数据（一次调用取齐三段，供列表页渲染时并行查询后合并缓存）
 */
export async function getSidebarData(db, lang = null) {
    const [categories, tags, archives] = await Promise.all([
        getSidebarCategories(db, lang),
        getSidebarTags(db, lang),
        getArchiveMonths(db, lang),
    ]);
    return { categories, tags, archives };
}
