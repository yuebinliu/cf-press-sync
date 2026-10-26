<?php
/**
 * 回归门禁：重复副本（同一远端 wp_id 被多篇 WP 文章指向）必须安全。
 *
 * 背景（2026-10-27 真机事故链）：
 *   旧插件写 `_cfsh_remote_wp_id`、新插件写 `_cfse_remote_wp_id`，两套判重键不兼容
 *   ⇒ 每次「拉取文章」都多建一份 slug 带 `-2` 的副本，一对副本指向同一个 D1 wp_id。
 *   清理时把副本沉进回收站后，暴露出两个会静默毁数据的路径：
 *     ① 拉取（覆盖）可能挑中回收站那份 → 活文章永远不更新、后台看不到变化
 *     ② 后台「清空回收站」→ delete_post() → DELETE FROM posts WHERE wp_id=?
 *        → 把保留篇的线上数据一起删掉，页面 404
 *
 * 本脚本只读，断言：
 *   A. 同一远端 wp_id 的所有文章里，find_post_by_remote_id() 必须命中「活着的」那篇
 *   B. 对回收站里的副本，count_live_siblings() > 0（= 删除时会被保护）
 *   C. 对活着的保留篇，count_live_siblings() == 0（= 删除时正常清远端）
 *
 * 用法：docker exec web-php php wp-content/plugins/cfse-sync/test/verify-dup-safety.php
 * 库里没有重复副本时输出 SKIP（不算失败）。
 */
define('WP_USE_THEMES', false);
$root = dirname(__DIR__, 4);           // wp-content/plugins/cfse-sync/test → ABSPATH
if (!file_exists($root . '/wp-load.php')) $root = dirname(__DIR__, 3);
require $root . '/wp-load.php';

global $wpdb;
$cms = CFSE_Sync_Worker_CMS::get_instance();

$m = new ReflectionMethod($cms, 'count_live_siblings');
$m->setAccessible(true);

// 找出「同一远端 id 被 ≥2 篇文章指向」的组（含回收站里的）
$groups = $wpdb->get_results(
    "SELECT pm.meta_value AS rid, COUNT(DISTINCT pm.post_id) AS n
       FROM {$wpdb->postmeta} pm
       INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
      WHERE pm.meta_key IN ('_cfse_remote_wp_id', '_cfsh_remote_wp_id')
        AND p.post_type = 'post'
      GROUP BY pm.meta_value
     HAVING n > 1"
);

echo "重复副本分组：" . count($groups) . " 组\n";
if (!$groups) {
    echo "SKIP 当前库里没有重复副本，跳过断言\n";
    exit(0);
}

$fail = 0;
foreach ($groups as $g) {
    $rid = (string) $g->rid;
    $hits = $cms->find_post_by_remote_id($rid);

    // 该组里活着的文章（非 trash）
    $live = $wpdb->get_col($wpdb->prepare(
        "SELECT DISTINCT pm.post_id FROM {$wpdb->postmeta} pm
           INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
          WHERE pm.meta_key IN ('_cfse_remote_wp_id', '_cfsh_remote_wp_id')
            AND pm.meta_value = %s AND p.post_status <> 'trash'",
        $rid
    ));
    $trash = $wpdb->get_col($wpdb->prepare(
        "SELECT DISTINCT pm.post_id FROM {$wpdb->postmeta} pm
           INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
          WHERE pm.meta_key IN ('_cfse_remote_wp_id', '_cfsh_remote_wp_id')
            AND pm.meta_value = %s AND p.post_status = 'trash'",
        $rid
    ));

    // A：只能命中活着的
    if (!$live) {
        echo "  ⚠ {$rid} 该组没有活文章（全部在回收站），find={$hits}\n";
        continue;
    }
    if (!in_array((int) $hits, array_map('intval', $live), true)) {
        echo "  ✗ {$rid} find_post_by_remote_id 命中 #{$hits}，不是活着的 [" . implode(',', $live) . "]\n";
        $fail++;
        continue;
    }

    // B：回收站副本必须被保护
    foreach ($trash as $tid) {
        $s = $m->invoke($cms, $rid, (int) $tid);
        if ($s < 1) { echo "  ✗ {$rid} 副本 #{$tid} count_live_siblings={$s}，清空回收站会删掉线上数据\n"; $fail++; }
    }

    // C：活文章删除时不该被「保护」拦住（除非同组还有第二篇活文章）
    if (count($live) === 1) {
        $s = $m->invoke($cms, $rid, (int) $live[0]);
        if ($s !== 0) { echo "  ✗ {$rid} 保留篇 #{$live[0]} count_live_siblings={$s}，应为其自身以外 0 篇\n"; $fail++; }
    }
}

if ($fail === 0) {
    echo "✓ 重复副本保护全部通过（" . count($groups) . " 组）\n";
    exit(0);
}
echo "✗ 失败 {$fail} 项\n";
exit(1);
