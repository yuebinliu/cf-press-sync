<?php
/**
 * 验证「☁️ CMS 同步」面板 + 双向同步的时间基准。
 *
 * 断言（全部只读，不写 D1）：
 *   ① 发布框里不再挂「重新同步」按钮（入口只剩侧边栏一处）
 *   ② 面板对两类文章都给「推送到 CMS」；「拉取 CMS 版本」只在有远端 ID 时出现
 *   ③ remote_modified_ts() 把 D1 的本地时间正确换算成 UTC（不能差一个时区）
 *   ④ remote_modified_map() 能一次取回远端 modified
 *   ⑤ 远端比本地新时，prepare_sync_item 会给出 remote_newer（不写）
 */
define('WP_USE_THEMES', false);
$root = dirname(__DIR__, 4);
if (!file_exists($root . '/wp-load.php')) $root = dirname(__DIR__, 3);
require $root . '/wp-load.php';

$ui   = CFSE_Sync_Admin_UI::get_instance();
$plug = CFSE_Sync_Plugin::get_instance();
$cms  = CFSE_Sync_Worker_CMS::get_instance();
$fail = 0;

function chk($cond, $label) {
    global $fail;
    printf("  %s %s\n", $cond ? '✓' : '✗', $label);
    if (!$cond) $fail++;
}

// ① 钩子
echo "=== ① 发布框钩子 ===\n";
global $wp_filter;
$still = false;
if (isset($wp_filter['post_submitbox_misc_actions'])) {
    foreach ($wp_filter['post_submitbox_misc_actions']->callbacks as $cbs) {
        foreach ($cbs as $cb) {
            if (is_array($cb['function']) && is_object($cb['function'][0])
                && $cb['function'][0] instanceof CFSE_Sync_Plugin
                && $cb['function'][1] === 'add_manual_export_button') $still = true;
        }
    }
}
chk(!$still, 'post_submitbox_misc_actions 上不再挂同步按钮');

// ② 面板
echo "\n=== ② 面板按钮（2089 = CMS 篇，12 = WP 原生篇）===\n";
$p = get_post(2089);
ob_start(); $ui->render_worker_sync_metabox($p); $h = ob_get_clean();
chk(strpos($h, '推送到 CMS') !== false, 'CMS 篇 有「推送到 CMS」');
chk(strpos($h, '拉取 CMS 版本') !== false, 'CMS 篇 有「拉取 CMS 版本」');

$p2 = get_post(12);
ob_start(); $ui->render_worker_sync_metabox($p2); $h2 = ob_get_clean();
chk(strpos($h2, '推送到 CMS') !== false, '原生篇 有「推送到 CMS」');
chk(strpos($h2, '拉取 CMS 版本') === false, '原生篇 没有「拉取 CMS 版本」（无远端 ID）');

// ③ 时间换算
echo "\n=== ③ 本地时间 → UTC 换算 ===\n";
$off = (float) get_option('gmt_offset');
$local = '2026-10-19 09:00:00';
$expect = strtotime($local . ' UTC') - (int) round($off * 3600);
$got = $cms->remote_modified_ts($local);
printf("  站点偏移 %+g，本地 %s ⇒ 期望 %s / 实际 %s\n", $off, $local,
    gmdate('Y-m-d H:i:s', $expect), $got ? gmdate('Y-m-d H:i:s', $got) : '0');
chk($got === $expect, 'remote_modified_ts 换算正确（不是把本地时间当 UTC）');

// ④ 批量取远端 modified（入参是**远端 wp_id**，不是 WP 文章 ID）
echo "\n=== ④ remote_modified_map ===\n";
$map = $cms->remote_modified_map(array(179234174624543, 12, 999999));
chk(isset($map[179234174624543]), '拿到 2089 对应远端行（1779…）');
chk(isset($map[12]), '拿到原生篇 12 的远端行');
chk(!isset($map[999999]), '不存在的行不返回');
if (isset($map[179234174624543])) echo "  远端 modified = {$map[179234174624543]}\n";

// ⑤ 远端更新时给出 remote_newer
echo "\n=== ⑤ 远端更新 ⇒ remote_newer ===\n";
$rm = new ReflectionMethod($plug, 'prepare_sync_item');
$rm->setAccessible(true);
// 伪造一个「远端比本地新很多」的 map
$fake = array(179234174624543 => '2030-01-01 00:00:00');
$res = $rm->invoke($plug, 2089, true, $fake);
chk($res === 'remote_newer', "远端 2030-01-01 > 本地 ⇒ remote_newer（实际：" . var_export($res, true) . "）");

// 远端很旧 ⇒ 应进入待写（数组）而不是 remote_newer
$fake2 = array(179234174624543 => '2000-01-01 00:00:00');
$res2 = $rm->invoke($plug, 2089, true, $fake2);
chk(is_array($res2), "远端 2000-01-01 < 本地 ⇒ 允许写入（实际：" . (is_array($res2) ? '待写条目' : var_export($res2, true)) . "）");

echo "\n" . ($fail === 0 ? "全部通过" : "失败 {$fail} 项") . "\n";
exit($fail === 0 ? 0 : 1);
