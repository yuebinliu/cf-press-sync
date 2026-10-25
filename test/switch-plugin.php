<?php
/**
 * 通过 WP 自己的 API 切换激活插件（正确做法：清 alloptions 缓存）。
 *
 * 直接 UPDATE wp_options 会被 WP 的 alloptions 缓存挡住 ——
 * get_option('active_plugins') 拿到旧值，插件实际不加载。
 * 这就是刚才 `wp_get_active_and_valid_plugins()` 返回空的原因。
 */
define('WP_USE_THEMES', false);
$_SERVER['HTTP_HOST'] = '192.168.2.2';
$_SERVER['REQUEST_URI'] = '/wp-admin/options-general.php?page=cfse-sync';
$_SERVER['REQUEST_METHOD'] = 'GET';

require_once '/var/www/html/wp-load.php';

global $wpdb;

$want = array('cfse-sync/cfse-sync.php');

// 其他插件从数据库原始值里捞回来（get_option 可能被 alloptions 缓存挡成 false）
$raw = $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'active_plugins'");
$cur = array();
if ($raw) {
    $decoded = maybe_unserialize($raw);
    if (is_array($decoded)) $cur = $decoded;
}
echo '切换前: ' . (empty($cur) ? '(空)' : implode(', ', $cur)) . "\n";

// 保留其他插件，去掉 cf/
$next = array();
foreach ($cur as $p) {
    if (strpos($p, 'cf/') === 0) continue;   // 停用 cf
    $next[] = $p;
}
foreach ($want as $p) {
    if (!in_array($p, $next, true)) $next[] = $p;
}

// 用 WP API 写（会触发 update_option 钩子 + 清缓存）
update_option('active_plugins', $next);

// 保险：手动清一次 alloptions 缓存
wp_cache_delete('alloptions', 'options');
wp_cache_delete('active_plugins', 'options');
wp_cache_delete('notoptions', 'options');

echo '切换后: ' . implode(', ', get_option('active_plugins', array())) . "\n";
echo "\n【WP 认得的激活插件】\n";
$valid = wp_get_active_and_valid_plugins();
foreach ($valid as $p) echo "  - $p\n";
if (empty($valid)) echo "  （空）\n";

echo "\n【类是否加载】\n";
foreach (array('CFSE_Sync_Plugin', 'CFSE_Sync_Onboarding', 'CFSE_Sync_Release', 'CFSE_Sync_Admin_UI') as $c) {
    echo sprintf("  %-24s %s\n", $c, class_exists($c) ? '有' : '无');
}
