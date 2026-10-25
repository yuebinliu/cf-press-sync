<?php
/**
 * 状态机逻辑的离线验证（不激活插件、不碰数据库）。
 *
 * 在服务器上跑：docker exec web-php php /var/www/html/.../cfse-sync/_verify-onboarding.php
 *
 * 用最小的 WP 函数桩来加载插件类，验证：
 *   ① 三屏状态判定（none / configured / connected）
 *   ② get_primary 的回落逻辑
 *   ③ mark_connected / mark_unconnected 的状态迁移
 *   ④ 发行包源列表的三个源
 */

$FAIL = 0;
function ok($cond, $label) {
    global $FAIL;
    if ($cond) { echo "  ✓ $label\n"; }
    else { echo "  ✗ $label\n"; $FAIL++; }
}

// ---------- WP 函数桩 ----------
$GLOBALS['__opts'] = array();
function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['__opts']) ? $GLOBALS['__opts'][$k] : $d; }
function update_option($k, $v) { $GLOBALS['__opts'][$k] = $v; return true; }
function delete_option($k) { unset($GLOBALS['__opts'][$k]); return true; }
function add_action() {}
function add_filter() {}
function wp_die($m) { echo "wp_die: $m\n"; exit; }
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
function esc_url($s) { return (string) $s; }
function esc_url_raw($s) { return (string) $s; }
function esc_js($s) { return (string) $s; }
function sanitize_text_field($s) { return trim(strip_tags((string) $s)); }
function wp_unslash($s) { return $s; }
function wp_json_encode($d, $f = 0) { return json_encode($d, $f); }
function wp_remote_retrieve_response_code($r) { return 200; }
function wp_remote_retrieve_body($r) { return ''; }
function is_wp_error($r) { return false; }
function wp_create_nonce($a) { return 'testnonce'; }
function wp_nonce_field($a) {}
function admin_url($p = '') { return '/wp-admin/' . $p; }
function get_site_url() { return 'https://example.test'; }
function home_url($p = '') { return 'https://example.test'; }
function wp_mkdir_p($d) { return is_dir($d) || mkdir($d, 0777, true); }
function wp_unslash_or($v) { return $v; }
function add_query_arg($k, $v, $u = '') { return $u . '?' . $k . '=' . $v; }
function wp_send_json_success($d) { echo json_encode(array('success' => true, 'data' => $d)) . "\n"; exit; }
function wp_send_json_error($d, $c = 400) { echo json_encode(array('success' => false, 'data' => $d)) . "\n"; exit; }
function check_ajax_referer($a) {}
function current_user_can($c) { return true; }
function wp_remote_get($u, $a = array()) { return array('code' => 200, 'body' => ''); }
function wp_remote_request($u, $a = array()) { return array('code' => 200, 'body' => ''); }

// ---------- 常量 ----------
define('ABSPATH', '/tmp/');
define('WP_CONTENT_DIR', '/tmp/wp-content');
define('CFSE_VERSION', '1.0.0');
define('CFSE_PLUGIN_DIR', '/var/www/html/wp-content/plugins/cfse-sync/');
define('CFSE_PLUGIN_URL', 'https://example.test/wp-content/plugins/cfse-sync/');
define('CFSE_WORKER_DIR', CFSE_PLUGIN_DIR . 'worker/');
define('CFSE_LOCAL_DIR', WP_CONTENT_DIR . '/cfse-static');
define('CFSE_WORKER_ID_MIN', 100000000000);

// ---------- 载入类 ----------
$dir = CFSE_PLUGIN_DIR . 'includes/';
require_once $dir . 'class-transports.php';
require_once $dir . 'class-release.php';
require_once $dir . 'class-onboarding.php';

// 主类桩（CFSE_Sync_Plugin / CFSE_Sync_Worker_CMS 只提供 log 与 get_instance）
class CFSE_Sync_Plugin {
    private static $i = null;
    public static function get_instance() { if (self::$i === null) self::$i = new self(); return self::$i; }
    public function log($m, $l = 'INFO') { return true; }
    public function get_config() { return array(); }
}
class CFSE_Sync_Worker_CMS {}

// ---------- 跑测试 ----------
echo "\n【① 状态判定】\n";

$GLOBALS['__opts'] = array();
$onb = CFSE_Sync_Onboarding::get_instance();
$r = new ReflectionClass($onb);
$sp = $r->getProperty('state'); $sp->setAccessible(true);

$sp->setValue($onb, null);
ok($onb->get_state() === 'none', '无 endpoint → none');

$GLOBALS['__opts']['cf_hosting_targets'] = json_encode(array(
    array('id' => '1', 'template' => 'cloudflare', 'type' => 'cfse-worker',
          'endpoint' => 'https://cms.example.com', 'auth_key' => 'k1', 'enabled' => true),
));
$sp->setValue($onb, null);
ok($onb->get_state() === 'configured', '有 endpoint 但没测过 → configured');

$GLOBALS['__opts']['cfse_conn_state'] = 'connected';
$sp->setValue($onb, null);
ok($onb->get_state() === 'connected', '标记过 connected → connected');

echo "\n【② 状态迁移】\n";
$GLOBALS['__opts']['cfse_conn_state'] = '';
$sp->setValue($onb, null);
$onb->mark_connected();
ok(get_option('cfse_conn_state') === 'connected', 'mark_connected 写入 option');
$onb->mark_unconnected();
ok(get_option('cfse_conn_state') === 'configured', 'mark_unconnected 退回 configured');

echo "\n【③ get_primary】\n";
$GLOBALS['__opts'] = array(
    'cf_hosting_targets' => json_encode(array(
        array('id' => '1', 'template' => 'cloudflare', 'type' => 'cfse-worker',
              'endpoint' => 'https://cms.example.com', 'auth_key' => 'k1', 'enabled' => true),
    )),
    'cf_site_url' => 'https://primary.example.com',
    'cf_auth_key' => 'primarykey',
);
$sp->setValue($onb, null);
$p = $onb->get_primary();
ok($p['endpoint'] === 'https://primary.example.com', '单表单 cf_site_url 优先于目标列表');
ok($p['auth_key'] === 'primarykey', '单表单 cf_auth_key 优先于目标列表');

echo "\n【④ 目标列表与单表单对齐】\n";
$t = CFSE_Sync_Transports::get_instance()->get_hosting_targets();
ok(!empty($t) && $t[0]['endpoint'] === 'https://primary.example.com',
    'get_hosting_targets 的第一个目标已与单表单对齐');
ok(!empty($t) && $t[0]['auth_key'] === 'primarykey',
    '第一个目标的 auth_key 已与单表单对齐');

echo "\n【⑤ 发行包下载源】\n";
$rel = CFSE_Sync_Release::get_instance();
$srcs = $rel->get_sources();
ok(count($srcs) >= 2, '至少有 2 个下载源（实际 ' . count($srcs) . '）');
$types = array_column($srcs, 'type');
ok(in_array('github', $types, true), '包含 GitHub Releases 源');
ok(in_array('direct', $types, true), '包含直链源（官网 / 固定地址）');
ok(strpos($srcs[0]['url'], 'api.github.com') !== false, '第一个源是 GitHub API');

echo "\n【⑥ 源码目录解析】\n";
$sd = $rel->resolve_source_dir();
ok(!empty($sd['dir']), 'resolve_source_dir 返回了目录：' . $sd['dir']);

echo "\n";
if ($FAIL === 0) { echo "✅ 全部通过\n"; exit(0); }
else { echo "❌ $FAIL 项失败\n"; exit(1); }
