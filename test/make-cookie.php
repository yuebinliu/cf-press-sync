<?php
/**
 * 生成一个管理员登录 cookie（只读验证用，不改用户密码）。
 *
 * 用 WP 自己的 wp_generate_auth_cookie，cookie 有效期 1 小时。
 * 输出格式：COOKIE_NAME=COOKIE_VALUE，便于 curl -b 使用。
 */
define('WP_USE_THEMES', false);
$_SERVER['HTTP_HOST'] = '192.168.2.2';
$_SERVER['REQUEST_URI'] = '/wp-admin/options-general.php?page=cfse-sync';
$_SERVER['REQUEST_METHOD'] = 'GET';

require_once '/var/www/html/wp-load.php';

$user = get_user_by('login', 'admin');
if (!$user) { echo "ERR: 找不到 admin 用户\n"; exit(1); }

$expiration = time() + 3600;
$cookie = wp_generate_auth_cookie($user->ID, $expiration, 'logged_in');

echo (LOGGED_IN_COOKIE . '=' . $cookie) . "\n";
echo '# 用户: ' . $user->user_login . ' (ID ' . $user->ID . ')\n";
echo '# 有效期至: ' . date('Y-m-d H:i:s', $expiration) . "\n";
