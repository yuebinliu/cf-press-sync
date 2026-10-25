/**
 * 缓存层：KV（只剩站点设置快照 site:ctx 的删除）+ 边缘缓存（Cache API，见文件末尾 edgeXxx）
 *
 * 2026-10：除 `site:ctx` 外所有缓存都搬到了 Cache API（免费、不计 KV 配额）——
 * 原先的 KV 版 getCache/setCache/purgeCache 已无调用者，故删除
 * （其中 purgeCache 的 `kv.list()` 曾是 KV「列举」额度 1000/天 的唯一消耗点）。
 */

export async function deleteCache(kv, key) {
    try {
        await kv.delete(key);
        return true;
    } catch (error) {
        console.error('Cache delete error:', error);
        return false;
    }
}

/* ============================================================
 * 边缘缓存（Cloudflare Cache API）—— 2026-10
 * ------------------------------------------------------------
 * 背景：KV 免费额度只有「读 10 万 / 写 1000 / 删 1000 / 列举 1000 次·天」，
 * 而「列表页 / 侧边栏 / RSS」这类**可重建的渲染缓存**一旦放进 KV，就会被
 * 文章增删、后台翻页、清缓存等高频动作带到上限（2026-10-11 实测 list 561 +
 * delete 562，正是这类路径打出来的）。
 *
 * 现改为 Cache API（caches.default）：
 *   · 完全免费、不计 KV 配额；
 *   · 按数据中心缓存（边缘），过期自动回收；
 *   · 键是内部 URL，与页面请求无关，不会污染 CDN 缓存。
 * ⇒ **KV 从此只保留 `site:ctx`（站点设置缓存，见 site.js）**。
 *
 * 注意：Cache API **没有列举能力** ⇒ edgePurge 只能删已知的固定键；
 * 动态键（列表分页等）靠 TTL 自然过期（本来就是 ttl_list/ttl_sidebar 的语义）。
 * ============================================================ */
const EDGE_ORIGIN = 'https://cfse-cache.internal/';
/** 会写进边缘缓存的固定键（供 edgePurge 使用） */
const EDGE_FIXED_KEYS = ['sidebar:data', 'rss:feed', 'home:page:1', 'cache:config'];

function edgeReq(key) {
    return new Request(EDGE_ORIGIN + encodeURIComponent(String(key)));
}

export async function edgeGet(key) {
    try {
        const res = await caches.default.match(edgeReq(key));
        if (!res) return null;
        return await res.json();
    } catch (error) {
        console.error('Edge cache get error:', error);
        return null;
    }
}

export async function edgeSet(key, value, ttl = 300) {
    try {
        const age = Math.max(60, parseInt(ttl, 10) || 300);   // Cache-Control 必须 > 0 才会被缓存
        await caches.default.put(edgeReq(key), new Response(JSON.stringify(value), {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'public, max-age=' + age,
            },
        }));
        return true;
    } catch (error) {
        console.error('Edge cache set error:', error);
        return false;
    }
}

export async function edgeDelete(key) {
    try {
        return await caches.default.delete(edgeReq(key));
    } catch (error) {
        console.error('Edge cache delete error:', error);
        return false;
    }
}

/** 按前缀清「固定键」（Cache API 无列举 ⇒ 动态键靠 TTL 过期） */
export async function edgePurge(prefix) {
    try {
        let n = 0;
        for (const k of EDGE_FIXED_KEYS) {
            if (k.includes(String(prefix))) { if (await edgeDelete(k)) n++; }
        }
        return n;
    } catch (error) {
        console.error('Edge cache purge error:', error);
        return false;
    }
}