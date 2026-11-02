<?php
/**
 * CF Press Sync for WordPress - uninstall
 *
 * 卸载时仅清理 WordPress 本地的 option / 文章 meta / cron。
 * ⚠️ 不会删除 Cloudflare R2 / D1 / Worker —— 那些是你的线上站点数据，
 *    如需删除请在 Cloudflare 控制台手动操作。
 * 提示：卸载后再重装插件会丢失此前的连接配置，请先记下 Worker 地址与 Auth Key。
 */
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

$cfse_options = array(
    'cf_account_id',
    'cf_api_token',
    'cf_r2_bucket',
    'cf_d1_database',
    'cf_site_url',
    'cf_auth_key',
    'cf_hosting_targets',
    'cf_batch_size',
    'cf_max_retries',
    'cf_enable_logging',
    'cf_debug_mode',
    'cf_posts_per_page',
    'cf_sync_d1',
    'cf_worker_auto_check',
    'cf_comments_mode',
    'cf_comments_embed',
    'cf_comments_sync',
    'cf_comments_accept',
    'cf_comments_pull_cron',
    'cf_banner_url',
    'cf_logo_url',
    'cf_exported_count',
    'cf_last_export_time',
    'cfse_db_version',
    'cfse_active_style',
    'cfse_media_index',
);

foreach ($cfse_options as $opt) {
    delete_option($opt);
}

// 清理文章上的同步标记 meta
delete_metadata('post', 0, '_cfse_synced_d1', '', true);
delete_metadata('post', 0, '_cf_exported', '', true);
delete_metadata('post', 0, '_cfse_hash', '', true);
delete_metadata('post', 0, '_cfse_tax_sig', '', true);

// 清理定时任务
wp_clear_scheduled_hook('cf_auto_export_cron');
wp_clear_scheduled_hook('cfse_pull_comments_cron');
