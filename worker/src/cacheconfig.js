/**
 * cacheconfig.js —— 缓存策略读取（薄封装）
 *
 * 配置已随站点上下文一起读取（site.js 的 getSiteContext 把 D1 settings 的
 * k='site' 与 k='cache' 两行打包进同一个 KV 值 site:ctx），本模块只做归一化。
 *
 * 纯 TTL 语义：
 *   ttl_list / ttl_sidebar / ttl_site = 0 → 该部分直查 D1，不读写 KV
 *   purge_on_publish=false（默认）→ 发布文章时不清列表/侧边栏缓存，靠 TTL 过期
 */
import { getSiteContext, normalizeCache, clearSiteCtxMemo } from './site';

export async function getCacheConfig(env) {
    try {
        const ctx = await getSiteContext(env);
        if (ctx && ctx.cache) return ctx.cache;
    } catch (e) { /* 读取失败用默认 */ }
    return normalizeCache(null);
}

/** 清配置缓存（删除 site:ctx + 清内存 memo；兼容清理旧版独立键 cache:config），保存后立即生效 */
export async function resetCacheConfig(env) {
    clearSiteCtxMemo();                              // 先清内存，防止命中旧 memo
    try { await env.KV_CACHE.delete('site:ctx'); } catch (e) {}
    try { await env.KV_CACHE.delete('cache:config'); } catch (e) {}
}
