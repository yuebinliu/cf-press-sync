<?php
/**
 * 只读渲染设置页（不登录、不改数据）。
 *
 * 目的：在真实 WP 环境里验证三屏状态机的渲染结果，
 *       确认没有 fatal error、没有未定义变量、HTML 结构完整。
 *
 * 用法：docker exec web-php php .../test/render-settings.php
 */

define('WP_USE_THEMES', false);
$_SERVER['HTTP_HOST'] = '192.168.2.2';
$_SERVER['REQUEST_URI'] = '/wp-admin/options-general.php?page=cfse-sync';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SERVER_NAME'] = '192.168.2.2';
$_SERVER['SCRIPT_NAME'] = '/wp-admin/options-general.php';

require_once '/var/www/html/wp-load.php';

echo "WP 已加载\n";

// 状态机判定
$onb = CFSE_Sync_Onboarding::get_instance();
$state = $onb->get_state();
$p = $onb->get_primary();

echo "\n【连接状态】" . $state . "\n";
echo '  endpoint: ' . ($p['endpoint'] !== '' ? $p['endpoint'] : '(空)') . "\n";
echo '  auth_key: ' . ($p['auth_key'] !== '' ? '(已设置)' : '(空)') . "\n";

echo "\n【生效目标】\n";
foreach (CFSE_Sync_Transports::get_instance()->get_hosting_targets() as $t) {
    echo sprintf("    id=%s template=%s endpoint=%s auth_key=%s enabled=%s\n",
        $t['id'] ?? '?', $t['template'] ?? '?',
        $t['endpoint'] ?? '(空)',
        !empty($t['auth_key']) ? '(有)' : '(无)',
        !empty($t['enabled']) ? '是' : '否');
}

echo "\n【跳过的旧目标（本插件不支持的 provider）】\n";
$unsup = CFSE_Sync_Transports::get_instance()->get_unsupported_targets();
if (empty($unsup)) {
    echo "    （无）\n";
} else {
    foreach ($unsup as $u) {
        echo sprintf("    id=%s name=%s template=%s\n", $u['id'], $u['name'], $u['template']);
    }
}

echo "\n【渲染设置页】\n";
// 造一个管理员上下文，让 settings_page 能正常跑
$admin = get_user_by('login', 'admin');
if ($admin) {
    wp_set_current_user($admin->ID);
    echo '  当前用户: ' . $admin->user_login . ' (ID ' . $admin->ID . ")\n";
}

// 捕获输出
$ui = CFSE_Sync_Admin_UI::get_instance();
ob_start();
try {
    $ui->settings_page();
    $html = ob_get_clean();
    echo "  渲染成功，HTML " . strlen($html) . " 字节\n";

    // 关键结构断言
    $checks = array(
        '状态机横幅'      => 'cfse-hero',
        '连接 CMS 卡片'   => '连接 CMS',
        '折叠块 details'  => '<details class="cfse-adv"',
        '同步内容区块'    => '同步设置',
        '测试连接按钮'    => 'cfse-test-conn',
        '发行包下载按钮'  => 'cf_download_release',
        '部署按钮'        => 'cf_deploy_worker',
    );
    echo "\n【结构断言】\n";
    foreach ($checks as $label => $needle) {
        echo sprintf("    %-18s %s\n", $label, strpos($html, $needle) !== false ? '存在' : '缺失');
    }

    // 状态机三屏的文案
    echo "\n【状态机文案】\n";
    foreach (array('连接你的自托管 CMS', '还差一步', '已连接') as $needle) {
        echo sprintf("    %-24s %s\n", $needle, strpos($html, $needle) !== false ? '出现' : '未出现');
    }

    // 有没有 PHP 报错混进 HTML
    $errs = array('Fatal error', 'Warning:', 'Notice:', 'Undefined variable', 'Deprecated:');
    echo "\n【错误扫描】\n";
    $found = false;
    foreach ($errs as $e) {
        if (strpos($html, $e) !== false) {
            echo "    发现: $e\n";
            $found = true;
        }
    }
    if (!$found) echo "    无错误\n";

    // 存一份 HTML 出来给人工看
    file_put_contents('/tmp/cfse-settings.html', $html);
    echo "\n  HTML 已存到 /tmp/cfse-settings.html\n";
} catch (Throwable $e) {
    ob_end_clean();
    echo '  渲染异常: ' . get_class($e) . ': ' . $e->getMessage() . "\n";
    echo '  位置: ' . $e->getFile() . ':' . $e->getLine() . "\n";
}
