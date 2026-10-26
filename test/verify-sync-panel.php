<?php
/**
 * 验证「☁️ CMS 同步」面板按归属切换 + 同步结果不再谎报成功。
 *
 * 核对四件事：
 *   ① 发布框里不再有「重新同步」按钮（钩子已摘）
 *   ② CMS 掌管的篇 → 面板只有「检查 Worker 端版本」，没有「重新同步」
 *   ③ WP 掌管的篇   → 面板只有「重新同步到 CMS」，没有版本检查
 *   ④ 对 CMS 掌管的篇跑一次同步，返回值必须是 'skipped'（不是 true），且不写 _cfse_synced_d1
 */
define('WP_USE_THEMES', false);
$root = dirname(__DIR__, 4);
if (!file_exists($root . '/wp-load.php')) $root = dirname(__DIR__, 3);
require $root . '/wp-load.php';

$ui   = CFSE_Sync_Admin_UI::get_instance();
$plug = CFSE_Sync_Plugin::get_instance();
$fail = 0;

function chk($cond, $label) {
    global $fail;
    printf("  %s %s\n", $cond ? '✓' : '✗', $label);
    if (!$cond) $fail++;
}

// ① 钩子
echo "=== ① 发布框钩子 ===\n";
global $wp_filter;
$hooks = isset($wp_filter['post_submitbox_misc_actions']) ? $wp_filter['post_submitbox_misc_actions'] : null;
$still = false;
if ($hooks) {
    foreach ($hooks->callbacks as $cbs) {
        foreach ($cbs as $cb) {
            if (is_array($cb['function']) && is_object($cb['function'][0])
                && $cb['function'][0] instanceof CFSE_Sync_Plugin
                && $cb['function'][1] === 'add_manual_export_button') $still = true;
        }
    }
}
chk(!$still, 'post_submitbox_misc_actions 上不再挂 add_manual_export_button');
chk(!method_exists($plug, 'add_manual_export_button'), '旧方法 add_manual_export_button 已移除');

// ② / ③ 面板内容
echo "\n=== ② CMS 掌管的篇（2089）===\n";
$p = get_post(2089);
if (!$p) { echo "  文章 2089 不存在\n"; exit(1); }
ob_start(); $ui->render_worker_sync_metabox($p); $h = ob_get_clean();
chk(strpos($h, '检查 Worker 端版本') !== false, '有「检查 Worker 端版本」');
chk(strpos($h, '重新同步到 CMS') === false, '没有「重新同步到 CMS」');
chk(strpos($h, '归 <b>CMS</b> 所有') !== false, '说明文字标明归 CMS 所有');

echo "\n=== ③ WP 掌管的篇（12）===\n";
$p2 = get_post(12);
if (!$p2) { echo "  文章 12 不存在\n"; exit(1); }
ob_start(); $ui->render_worker_sync_metabox($p2); $h2 = ob_get_clean();
chk(strpos($h2, '重新同步到 CMS') !== false, '有「重新同步到 CMS」');
chk(strpos($h2, '检查 Worker 端版本') === false, '没有「检查 Worker 端版本」');
chk(strpos($h2, '归 <b>WordPress</b> 所有') !== false, '说明文字标明归 WordPress 所有');

// ④ skipped 不再伪装成功
echo "\n=== ④ 同步返回值（CMS 掌管篇应 skipped）===\n";
$rm = new ReflectionMethod($plug, 'run_sync_mode');
$rm->setAccessible(true);
$before = get_post_meta(2089, '_cfse_synced_d1', true);
$r = $rm->invoke($plug, 2089);
$after = get_post_meta(2089, '_cfse_synced_d1', true);
chk($r === 'skipped', "run_sync_mode 返回 'skipped'（实际：" . var_export($r, true) . "）");
chk($before === $after, '_cfse_synced_d1 未被刷成新时间戳');

echo "\n" . ($fail === 0 ? "全部通过" : "失败 {$fail} 项") . "\n";
exit($fail === 0 ? 0 : 1);
