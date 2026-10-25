<?php
/**
 * 兼容函数层。
 *
 * 这些函数原本定义在 views/template-editor.php 里，但被核心链路依赖。
 * 插件拆分后 views/（模板编辑器 2032 行 + 皮肤构建器）整体退役 —— 模板改由
 * Worker 后台的模板编辑器管理 —— 这里只留下真正被调用的那一个。
 *
 * @package CFSE
 */

if (!defined('ABSPATH')) {
    exit;
}

if (function_exists('cfse_storage_pattern')) {
    return;
}

/**
 * 由 permalink 推导 R2 存储路径模板（与 worker/src/routes.js 同源）。
 *
 * 例：/%postname%/            → {slug}/index.html
 *     /%year%/%monthnum%/%postname%/ → {year}/{month}/{slug}/index.html
 *
 * @return string 含 {slug} 等占位符的路径模板
 */
function cfse_storage_pattern() {
    $permalink = get_option('permalink_structure');
    if (empty($permalink) || $permalink === '/%postname%/') {
        return '{slug}/index.html';
    }
    $pattern = trim($permalink, '/');
    $tags = array(
        '%year%'     => '{year}',
        '%monthnum%' => '{month}',
        '%day%'      => '{day}',
        '%hour%'     => '{hour}',
        '%minute%'   => '{minute}',
        '%second%'   => '{second}',
        '%postname%' => '{slug}',
        '%post_id%'  => '{id}',
        '%category%' => '{category}',
        '%author%'   => '{author}',
    );
    foreach ($tags as $k => $v) {
        $pattern = str_replace($k, $v, $pattern);
    }
    return $pattern . '/index.html';
}
