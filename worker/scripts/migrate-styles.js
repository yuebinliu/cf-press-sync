// 一次性迁移：把 KV tpl:style:* 的用户风格写入 D1 styles 表（version=1），然后删旧 KV 键
// 用法：临时加进 Worker 的 fetch 入口（如 /__migrate_styles），跑一次后移除；或直接 wrangler tail + fetch 触发
// 也可由管理员手动触发：POST /api/migrate-styles（X-Auth-Key）——见下方注释代码
export async function migrateStyles(env) {
  const idxRaw = await env.KV_CACHE.get('tpl:sindex');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  let moved = 0;
  for (const it of idx) {
    if (it.source === 'builtin') continue; // 内置不迁移
    const raw = await env.KV_CACHE.get('tpl:style:' + it.id);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    const now = new Date().toISOString().slice(0, 19);
    await env.D1_DATABASE.prepare(
      'INSERT INTO styles (id, version, name, tpl_json, updated_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(id, version) DO UPDATE SET name = excluded.name, tpl_json = excluded.tpl_json, updated_at = excluded.updated_at'
    ).bind(it.id, rec.name || it.id, JSON.stringify(rec.tpl || {}), now).run();
    await env.KV_CACHE.delete('tpl:style:' + it.id);
    moved++;
  }
  // 重建用户索引（去掉 tpl:style 相关残留，保留 source）
  const newIdx = idx.filter(function (x) { return x.source !== 'builtin'; }).map(function (x) { return { id: x.id, name: x.name, updated: x.updated, source: 'user' }; });
  await env.KV_CACHE.put('tpl:sindex', JSON.stringify(newIdx));
  return { moved: moved };
}
