<?php
/**
 * Plugin Name: CF Press Sync
 * Plugin URI: https://github.com/yuebinliu/cfpress
 * Description: 把 WordPress 变成自托管 CMS 的内容后台 —— 文章、分类、标签、评论、媒体同步到 Cloudflare D1 + R2，单页 HTML 由 Worker 现场渲染。
 * Version: 2.2.0
 * Author: CF Press
 * License: GPL v2 or later
 * Requires at least: 5.5
 * Requires PHP: 7.0
 * Text Domain: cf-press-sync
 *
 * 本插件只负责「数据同步 + Worker 部署」，不做静态文件生成：
 *   · 发布/更新文章 → 写 D1（分类、标签、md 标记、评论开关一并写入）
 *   · 正文图片 → 上传 R2（让静态站不依赖 WP 在线）
 *   · 删掉 R2 里的旧单页 → 下次访问由 Worker 用最新 D1 内容渲染并回填
 *   · Worker 后台账号、路由规则、Worker 代码部署
 *
 * 第三方静态托管（GitHub Pages / Netlify / Vercel / FTP / WebDAV / S3 等）
 * 是另一个插件 WP Static Deploy 的职责。
 */
if (!defined('ABSPATH')) {
    exit;
}

// ============================================
// 重复安装保护（必须放在最前面）
//
// 同一个站点可能同时存在多份同源插件：
//   · 旧版「CF Static Export Pro」（类名 CF_Static_Export_Pro / CFSE_Transports …）
//   · 本插件 CF Press Sync（类名已独立为 CFSE_Sync_* ，互不冲突）
//   · 后续的 CMS 同步插件
// 但它们的**常量前缀相同**（CFSE_VERSION / CFSE_PLUGIN_DIR …）。若旧插件先加载，
// 我们的 `if (!defined(...))` 会让 CFSE_PLUGIN_DIR 指向**旧插件目录**，后面的
// require 就会加载旧文件 → Class not found / 白屏。所以先检测常量：已存在就
// 直接退出并给出明确提示，比让 WordPress 只显示一句「触发了致命错误」有用得多。
//
// 注意：判据必须是常量，不能只看 class_exists()。类名虽然已独立，常量仍然共用，
// 常量冲突同样致命，而且用户完全看不出原因。
// ============================================
if (defined('CFSE_VERSION')) {
    add_action('admin_notices', function () {
        echo '<div class="notice notice-error"><p><strong>CF Press Sync</strong> 未生效：'
            . '检测到另一份 CF Static Export Pro / CF Press Sync 已经启用（常量 <code>CFSE_VERSION</code> 已定义，当前值 '
            . esc_html(defined('CFSE_VERSION') ? CFSE_VERSION : '?') . '）。'
            . '两个插件共用同一套常量前缀，<b>不能同时启用</b> —— 请先到「插件」页停用旧的那个，再启用本插件。</p></div>';
    });
    return;
}

// ============================================
// 常量定义
// ============================================
if (!defined('CFSE_VERSION')) define('CFSE_VERSION', '1.0.0');
if (!defined('CFSE_PLUGIN_DIR')) define('CFSE_PLUGIN_DIR', plugin_dir_path(__FILE__));
if (!defined('CFSE_PLUGIN_URL')) define('CFSE_PLUGIN_URL', plugin_dir_url(__FILE__));
if (!defined('CFSE_LOG_FILE')) {
    // 剥离前的插件叫 cf-static-export，日志沿用它；升级用户继续写原文件（历史日志不丢），
    // 全新安装才用新名字。
    $cfse_new_log = WP_CONTENT_DIR . '/cfse-sync.log';
    $cfse_old_log = WP_CONTENT_DIR . '/cf-static-export.log';
    define('CFSE_LOG_FILE', (!file_exists($cfse_new_log) && file_exists($cfse_old_log)) ? $cfse_old_log : $cfse_new_log);
}
// 历史遗留：本插件不再生成静态文件，常量仅为兼容旧代码路径（本地目录 target / 清理残留）而保留
if (!defined('CFSE_LOCAL_DIR')) define('CFSE_LOCAL_DIR', WP_CONTENT_DIR . '/cfse-static');
// 「Worker 端诞生」的 wp_id 判据（见 ROADMAP I.1）：WP 侧自增 ID 远小于它，
// Worker 侧为 Date.now()*100+rand（≈1.7e14）⇒ 用于生成「待拉取清单」/标识来源。
if (!defined('CFSE_WORKER_ID_MIN')) define('CFSE_WORKER_ID_MIN', 100000000000);

// ============================================
// 模块完整性检测
//
// 本插件有 20+ 个文件，FTP 上传很容易漏几个。
// require 缺文件是 E_COMPILE_ERROR（编译期致命错误，try/catch 捕不到），
// 用户只会看到「触发了致命错误」。所以先逐个 file_exists 检查，
// 缺了就明确列出缺哪几个再退出。
// ============================================
$cfse_required_modules = array(
    'includes/class-transports.php',
    'includes/class-admin-ui.php',
    'includes/class-worker-cms.php',
    'includes/class-release.php',
    'includes/class-onboarding.php',
    'includes/class-compat.php',
);
$cfse_missing_modules = array();
foreach ($cfse_required_modules as $cfse_mod) {
    if (!file_exists(CFSE_PLUGIN_DIR . $cfse_mod)) $cfse_missing_modules[] = $cfse_mod;
}
if (!empty($cfse_missing_modules)) {
    add_action('admin_notices', function () use ($cfse_missing_modules) {
        echo '<div class="notice notice-error"><p><strong>CF Press Sync</strong> 未生效：插件文件不完整，'
            . '缺少以下模块 —— 请重新上传完整插件包（尤其 <code>includes/</code> 目录）。</p><ul style="margin-left:20px;list-style:disc;">';
        foreach ($cfse_missing_modules as $m) {
            echo '<li><code>' . esc_html($m) . '</code></li>';
        }
        echo '</ul><p>插件目录：<code>' . esc_html(CFSE_PLUGIN_DIR) . '</code></p></div>';
    });
    return;
}

// 拆分出的模块（详见 docs/roadmap-current.md Step 1）
require_once CFSE_PLUGIN_DIR . 'includes/class-transports.php';
require_once CFSE_PLUGIN_DIR . 'includes/class-admin-ui.php';
require_once CFSE_PLUGIN_DIR . 'includes/class-worker-cms.php';
require_once CFSE_PLUGIN_DIR . 'includes/class-release.php';
require_once CFSE_PLUGIN_DIR . 'includes/class-onboarding.php';
require_once CFSE_PLUGIN_DIR . 'includes/class-compat.php';
// 上面几个临时变量会落到全局作用域，用完清掉
unset($cfse_required_modules, $cfse_missing_modules, $cfse_mod);

// ============================================
// PHP版本检测
// ============================================
if (version_compare(PHP_VERSION, '7.0.0', '<')) {
    add_action('admin_notices', function () {
        echo '<div class="notice notice-error"><p><strong>CF Press Sync</strong> 需要 PHP 7.0 或更高版本，当前版本：' . esc_html(PHP_VERSION) . '，请升级PHP后再启用此插件。</p></div>';
    });
}

// ============================================
// 环境检测
// ============================================
if (!extension_loaded('curl')) {
    add_action('admin_notices', function () {
        echo '<div class="notice notice-error"><p><strong>CF Press Sync</strong> 需要 PHP cURL 扩展，请开启cURL后再启用此插件。</p></div>';
    });
}

// ============================================
// 主类
// ============================================
class CFSE_Sync_Plugin {
    /** 文章所属站点的 meta 键（可见字段，便于后台「自定义字段」手动改；多值 = 多个站点） */
    const META_SITE = 'cfse_site';

    /**
     * 批量同步：一次 /d1-batch 最多合并多少条 SQL。
     *
     * Worker 侧 `/d1-batch` 用 `statements.slice(0, 50)` 硬截断，**超出的会被静默丢弃**
     * （不报错，只是没执行）。所以这里必须自己控住，留 5 条余量。
     * 一篇现在固定 2~4 条语句（多行 VALUES）⇒ 一批约 11 篇。
     */
    const BATCH_MAX_STMTS = 45;

    /** save_post 触发的待同步队列（同一请求内多次保存只同步一次，且推迟到 shutdown 时再读数据） */
    private static $pending_export_ids = array();
    private static $export_flush_registered = false;

    /** 一次 /delete 最多带多少个路径（单页 + .gz 各算一个，一篇贡献 2 个） */
    const BATCH_MAX_PATHS = 100;
    /** 托管目标「⚙️ 配置」弹窗的 HTML（渲染表格行时收集，表格之后统一输出为 modal） */
    private $target_modals = array();
    private $reported_dir_failure = false;

    private static $instance = null;
    private static $deleted_post_ids = array();
    // 默认值：内部抓取请求会在 load_config() 之前早退，而 log() 会读这两个键，
    // 先给上默认值可避免 PHP8 的 undefined array key warning（行为仍是"不写日志"）。
    private $config = array('enable_logging' => false);


    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    /**
     * 注意：`self::$instance` 必须在**构造体第一行**就赋值。
     *
     * 构造过程中会调到别的模块，而 transports / admin-ui / worker-cms 里的 log() 都是
     * `CFSE_Sync_Plugin::get_instance()->log(...)` 这种反查写法。若等到 `new self()` 返回
     * 之后才赋值，那些反查看到的 $instance 仍是 null ⇒ 再 new 一次 ⇒ 再次进入本构造体
     * ⇒ 无限递归，直到 memory_limit 耗尽，WordPress 只报一句「触发了致命错误」。
     * （真机踩过：cf_hosting_targets 里留着已删除的模板 id 时必现。）
     *
     * 提前赋值后，递归中的反查会拿到「正在构造的自己」，此时 $config 还是下面的默认值
     * （enable_logging = false），log() 直接返回，不会写日志也不会炸。
     */
    private function __construct() {
        self::$instance = $this;
        $this->init_hooks();
        $this->load_config();
        $this->register_cron_jobs();
    }

    // ============================================
    // 钩子初始化
    // ============================================
	private function init_hooks() {
		add_action('admin_menu', array($this, 'add_admin_menu'));
		add_action('admin_init', array($this, 'register_settings'));
		add_action('save_post', array($this, 'queue_export'), 10, 3);
		add_action('add_meta_boxes', array($this, 'add_doc_format_metabox'), 10, 2);
		add_action('add_meta_boxes', array($this, 'add_site_metabox'), 10, 2);
		add_action('admin_post_cfse_align_worker', array($this, 'handle_align_worker'));
		add_action('wp_ajax_cfse_worker_status', array($this, 'ajax_worker_status'));
		add_action('wp_ajax_cfse_test_targets', array($this, 'ajax_test_targets'));
		add_action('wp_ajax_cfse_test_connection', array($this, 'ajax_test_connection'));
		// 优先级 5：必须早于导出钩子（save_post 优先级 10），否则本次导出读到的是旧标记
		add_action('save_post', array($this, 'save_doc_format_meta'), 5, 3);
		add_action('save_post', array($this, 'save_site_meta'), 5, 3);
		// 文章列表批量设置站点（每个站点一项，避免复杂弹窗）
		add_filter('bulk_actions-edit-post', array($this, 'add_site_bulk_actions'));
		add_filter('handle_bulk_actions-edit-post', array($this, 'handle_site_bulk_actions'), 10, 3);
		add_filter('the_content', array($this, 'render_md_content'), 9);
		add_action('before_delete_post', array($this, 'delete_post'));
		add_action('trash_post', array($this, 'delete_post'));
		add_action('untrash_post', array($this, 'export_post'));
		// 评论 → D1 单向同步（B1；总开关 cf_comments_sync，默认关）
		add_action('wp_insert_comment', array($this, 'on_comment_changed'), 10, 2);
		add_action('edit_comment', array($this, 'on_comment_changed'), 10, 1);
		add_action('transition_comment_status', array($this, 'on_comment_status_changed'), 10, 3);
		add_action('delete_comment', array($this, 'on_comment_deleting'), 10, 2);
		add_action('deleted_comment', array($this, 'on_comment_deleted'), 10, 1);
		add_action('admin_post_cfse_sync_comments', array($this, 'handle_sync_comments'));
		add_action('admin_post_cfse_pull_comments', array($this, 'handle_pull_comments'));
		// 「重新同步到 D1」不再挂在发布框（post_submitbox_misc_actions）：
		// 那个位置的按钮对所有已发布文章都显示，而「CMS 掌管」的篇点了必然 0 写入
		// （write_to_d1 第一步就因归属保护返回 skipped）。现在统一放进侧边栏
		// 「☁️ CMS 同步」面板，按归属显示对应动作 —— 见 render_worker_sync_metabox()。
		add_action('admin_post_cf_manual_export', array($this, 'handle_manual_export'));
		add_action('admin_post_cf_sync_site_info', array($this, 'handle_sync_site_info'));
		add_action('admin_post_cf_bulk_export', array($this, 'handle_bulk_export'));
		add_action('admin_post_cf_pull_worker', array($this, 'handle_pull_worker'));
		add_action('admin_post_cf_clear_cache', array($this, 'handle_clear_cache'));
		add_action('admin_post_cf_seed_admin', array($this, 'handle_seed_admin'));
		add_action('admin_post_cf_deploy_worker', array($this, 'handle_deploy_worker'));
		add_action('admin_post_cf_download_release', array($this, 'handle_download_release'));
		add_filter('manage_posts_columns', array($this, 'add_export_column'));
		add_action('manage_posts_custom_column', array($this, 'render_export_column'), 10, 2);
		register_deactivation_hook(__FILE__, array($this, 'deactivate'));

		// 【FIX】已移除旧 wp_ajax_cf_analyze_theme / wp_ajax_cf_load_theme_template 钩子
	}
    // ============================================
    // 配置加载
    // ============================================
    private function load_config() {
        // 多托管配置：先算出目标列表，再由「首个 cfse-worker 目标」派生 site_url / auth_key。
        // 这样 d1_batch / purge 等仍只读 site_url/auth_key 的代码无需改动，行为与之前一致。
        //
        // 2026-10-25：设置页改成了「连接 CMS」单表单（endpoint + auth_key 两个框），
        // 存在 option cf_site_url / cf_auth_key 里。这两个是**主目标的真源** ——
        // 用户在单表单里改的就是它们，多目标表格里的第一行会被同步过来（见下）。
        $targets = $this->get_hosting_targets();
        $primary = array();
        foreach ($targets as $t) {
            if (isset($t['type']) && $t['type'] === 'cfse-worker') { $primary = $t; break; }
        }
        // 主目标优先；但若单表单里填了值，以单表单为准（它是用户直接面对的入口）
        $single_url = trim((string) get_option('cf_site_url', ''));
        $single_key = (string) get_option('cf_auth_key', '');
        $primary_url = $single_url !== '' ? $single_url
            : (!empty($primary['endpoint']) ? $primary['endpoint'] : get_site_url());
        $primary_key = $single_key !== '' ? $single_key
            : (isset($primary['auth_key']) ? $primary['auth_key'] : '');
        $this->config = array(
            'account_id' => get_option('cf_account_id', ''),
            'api_token' => get_option('cf_api_token', ''),
            'r2_bucket' => get_option('cf_r2_bucket', ''),
            'd1_database' => get_option('cf_d1_database', ''),
            'site_url' => rtrim($primary_url, '/'),
            'hosting_targets' => $targets,
            'batch_size' => max(1, (int) get_option('cf_batch_size', 50)),
            'max_retries' => max(1, (int) get_option('cf_max_retries', 3)),
            'enable_logging' => (bool) get_option('cf_enable_logging', true),
            // debug_mode 已移除（2026-10-26）：CMS 懒生成、不落 HTML，调试落盘已无意义。
            // 缓存策略（TTL / feed 条数 / 发布后清缓存）已全部归 CMS 后台维护
            // （D1 settings k='cache' 行）；WP 侧不再读写这些 option，也不再清 KV 缓存。
            'auth_key' => $primary_key,
            // posts_per_page 已废弃（2026-10-26）：没有消费方，前台分页归 CMS 后台。
            // 编辑页是否自动比对 Worker 版本（默认关；打开后打开编辑页即查询，关则用面板里的「🔍 检查」按钮）
            'worker_auto_check' => (bool) get_option('cf_worker_auto_check', true),
            // 发布文章时自动把数据同步到 D1（旧键 cf_sync_drafts 作为默认值兼容迁移）。
            // 单页 HTML 由 Worker 渲染，插件侧没有「生成静态文件 / 上传 R2」这两个开关了。
            'sync_d1' => (bool) get_option('cf_sync_d1', get_option('cf_sync_drafts', true)),
            // 评论：off=隐藏评论区 / embed=注入管理员填写的第三方片段 / native=主题原生骨架 + 自有数据（B 阶段）
            'comments_mode' => (string) get_option('cf_comments_mode', 'off'),
            'comments_embed' => (string) get_option('cf_comments_embed', ''),
        'banner_url' => (string) get_option('cf_banner_url', ''),
        'logo_url'   => (string) get_option('cf_logo_url', ''),
            'comments_sync' => (bool) get_option('cf_comments_sync', false),
            'comments_accept' => (string) get_option('cf_comments_accept', 'off'),
            'comments_pull_cron' => (bool) get_option('cf_comments_pull_cron', true),
        );
    }
    /**
     * 通用私有方法代理：供拆分出去的新类（CFSE_Sync_Admin_UI 等）回调主类 private 方法。
     * 拆分纪律要求「只搬不改」=> 不改原方法可见性，用反射转发。
     *
     * @param string $name 方法名
     * @param array  $args 参数
     * @return mixed
     */
    public function cfse_proxy($name, $args = array()) {
        if (!method_exists($this, $name)) {
            return null;
        }
        $r = new ReflectionMethod($this, $name);
        $r->setAccessible(true);
        return $r->invokeArgs($this, $args);
    }

public function get_config() {
    return $this->config;
}

    // ============================================
    // 定时任务
    // ============================================
    private function register_cron_jobs() {
        add_action('cf_auto_export_cron', array($this, 'handle_auto_export'));
        if (!wp_next_scheduled('cf_auto_export_cron')) {
            wp_schedule_event(time(), 'daily', 'cf_auto_export_cron');
        }
        // 评论回拉（B3）：定时把「Worker 端诞生、还没落地」的评论拉回来 —— 否则 WP 后台永远看不到读者评论
        add_action('cfse_pull_comments_cron', array($this, 'handle_pull_comments_cron'));
        if (!wp_next_scheduled('cfse_pull_comments_cron')) {
            wp_schedule_event(time() + 300, 'hourly', 'cfse_pull_comments_cron');
        }
    }
    public function sanitize_hosting_targets($value) {
        return CFSE_Sync_Transports::get_instance()->sanitize_hosting_targets($value);
    }
    public function render_hosting_targets_table() {
        return CFSE_Sync_Admin_UI::get_instance()->render_hosting_targets_table();
    }
    private function is_first_cloudflare_target($t) {
        return CFSE_Sync_Admin_UI::get_instance()->is_first_cloudflare_target($t);
    }
    private function render_cf_platform_fields($render = true) {
        return CFSE_Sync_Admin_UI::get_instance()->render_cf_platform_fields($render);
    }
    private function render_hosting_target_row($i, $t, $warns = array()) {
        return CFSE_Sync_Admin_UI::get_instance()->render_hosting_target_row($i, $t, $warns);
    }
    public function add_admin_menu() {
        return CFSE_Sync_Admin_UI::get_instance()->add_admin_menu();
    }
    public function register_settings() {
        return CFSE_Sync_Admin_UI::get_instance()->register_settings();
    }

    /** 评论注入代码（第三方服务片段）：管理员填写 ⇒ 原样保存（不做 kses，否则 <script> 会被剥掉） */
    public function sanitize_embed_code($value) {
        $v = is_string($value) ? trim($value) : '';
        if (strlen($v) > 20000) { $v = substr($v, 0, 20000); }
        return $v;
    }
    public function enqueue_admin_assets() {
        return CFSE_Sync_Admin_UI::get_instance()->enqueue_admin_assets();
    }
    public function settings_page() {
        return CFSE_Sync_Admin_UI::get_instance()->settings_page();
    }
    private function get_export_stats() {
        return CFSE_Sync_Admin_UI::get_instance()->get_export_stats();
    }
    private function get_recent_logs($lines = 10) {
        return CFSE_Sync_Admin_UI::get_instance()->get_recent_logs($lines);
    }

    public function log($message, $level = 'INFO') {
        if (!$this->config['enable_logging']) return;
        $timestamp = current_time('Y-m-d H:i:s');
        @file_put_contents(CFSE_LOG_FILE, "[{$timestamp}] [{$level}] {$message}\n", FILE_APPEND | LOCK_EX);
    }
    private function get_post_storage_path($post) {
        return CFSE_Sync_Worker_CMS::get_instance()->get_post_storage_path($post);
    }

    // ============================================
    // 核心同步逻辑：WP 文章 → D1（只写数据，不渲染、不落盘）
    //
    // 拆分后本插件的唯一职责是把文章数据搬进 D1。单页 HTML 由 Worker 现场生成：
    // R2 里没有该路径时 routes.js 会走 renderSinglePageOnDemand()（D1 → 当前风格模板
    // → 回填 R2），所以插件侧既不渲染也不上传。数据一变就删掉 R2 里的旧单页，让
    // Worker 下次访问时用最新内容重新渲染 —— 否则会一直读到上一次的旧页面。
    // ============================================
    /**
     * save_post 回调：**只入队**，真正的同步推迟到 shutdown。
     *
     * 为什么不能直接在 save_post 里同步：
     *   WordPress 的写入顺序是 wp_insert_post()（触发 save_post）→ 紧接着 wp_set_object_terms()
     *   设分类/标签、set_post_thumbnail() 设特色图。在 save_post 里读，拿到的是「改之前」的状态，
     *   于是分类、标签、特色图全部丢失 —— 实测通过 REST 发文 100% 落 Uncategorized。
     *   挪到 shutdown：那时 term 和缩略图都已就位。顺带把同一请求里的多次保存合并成一次。
     */
    public function queue_export($post_id, $post = null, $update = null) {
        if (!empty($GLOBALS['cfse_skip_export'])) return;
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
        if (wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) return;
        $p = get_post($post_id);
        if (!$p || $p->post_type !== 'post') return;
        if (!in_array($p->post_status, array('publish', 'draft'), true)) return;
        if (get_post_meta($post_id, '_cfse_probe', true) === '1') return;
        self::$pending_export_ids[(int) $post_id] = true;
        if (!self::$export_flush_registered) {
            self::$export_flush_registered = true;
            add_action('shutdown', array($this, 'flush_pending_exports'), 9);
        }
    }

    /** shutdown：把队列里的文章逐篇同步（此时分类/标签/特色图都已写入） */
    public function flush_pending_exports() {
        if (empty(self::$pending_export_ids)) return;
        $ids = array_keys(self::$pending_export_ids);
        self::$pending_export_ids = array();
        foreach ($ids as $id) {
            $this->export_post($id, null, null, false);
        }
    }

    public function export_post($post_id, $post = null, $update = null, $force = false) {
        // 拉取 Worker 文章期间跳过回写（内容本就取自 Worker，回写是无谓开销）
        if (!empty($GLOBALS['cfse_skip_export'])) return;
        if (!empty($GLOBALS['cfse_in_export'])) {
            $this->log("文章 {$post_id} 跳过：已在同步流程中", 'DEBUG');
            return;
        }
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
        if (wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) return;

        $post = get_post($post_id);
        if (!$post || $post->post_type !== 'post') return;
        // 已发布 + 草稿都同步（草稿进 D1 后可在 CMS 后台看到，前台列表不显示）
        if (!in_array($post->post_status, array('publish', 'draft'), true)) return;
        if (get_post_meta($post_id, '_cfse_probe', true) === '1') {
            $this->log("文章 {$post_id} 为外观探针文章，跳过同步", 'DEBUG');
            return;
        }
        // 「自动同步到 D1」开关（设置页「其他自动设置」）：关掉后 save_post 不再自动同步，
        // 需要手动点「📤 全量同步到 D1」。手动路径（run_sync_mode）传 $force=true 绕过此开关。
        if (!$force && empty($this->config['sync_d1'])) {
            $this->log("文章 {$post_id} 未开启「自动同步到 D1」，跳过（可用全量同步）", 'DEBUG');
            return;
        }
        if (!extension_loaded('curl')) {
            $this->log('cURL 扩展未安装', 'ERROR');
            return false;
        }
        $lock_key = "cf_export_lock_{$post_id}";
        if (get_transient($lock_key)) {
            $this->log("文章 {$post_id} 正在同步中，跳过", 'WARNING');
            return;
        }
        set_transient($lock_key, true, 60);
        $GLOBALS['cfse_in_export'] = true;
        try {
            $this->log("开始同步文章 {$post_id}: {$post->post_title}");
            $start_time = microtime(true);
            $result = $this->sync_post_to_d1($post);
            $duration = round(microtime(true) - $start_time, 2);
            if ($result === 'skipped') {
                // 无需写入（例如分类保护）。不能报「已同步」—— 以前就是这么报的，
                // 于是后台点「重新同步」看起来一切正常，实际 D1 毫无变化，排查全靠猜。
                $this->log("文章 {$post_id} 本次未写入（无实质变化或受保护），未改动远端", 'INFO');
            } elseif ($result === 'remote_newer') {
                $this->log("文章 {$post_id} 未写入：CMS 侧版本更新，先「拉取文章」对齐，或接受覆盖后再推", 'WARNING');
            } elseif ($result) {
                update_option('cf_last_export_time', current_time('mysql'));
                update_post_meta($post_id, '_cfse_synced_d1', time());
                delete_post_meta($post_id, '_cf_exported');   // 旧版「已导出」标记，本插件不再产生
                $this->increment_exported_count();
                $this->log("文章 {$post_id} 已同步到 D1，耗时 {$duration}s", 'INFO');
            } else {
                $this->log("文章 {$post_id} 同步失败", 'ERROR');
            }
            return $result;
        } catch (Throwable $e) {
            $this->log("文章 {$post_id} 同步异常: " . $e->getMessage(), 'ERROR');
            return false;
        } finally {
            delete_transient($lock_key);
            $GLOBALS['cfse_in_export'] = false;
        }
    }

    /**
     * 单篇同步（草稿 / 已发布共用一条链路）：
     *   ① 元数据打包（含分类/标签、md 标记、评论开关）
     *   ② 判断两端谁更新（CMS 更晚就停手，避免盖掉 CMS 的改动）
     *   ③ 写 D1
     *   ④ 同步正文里的图片到 R2（让静态站不依赖 WP 在线）
     *   ⑤ 删掉 R2 里的旧单页，交给 Worker 重新渲染
     *
     * @return bool|string true = 写入成功；'skipped' = 无需写（分类保护等）；
     *                     'remote_newer' = CMS 侧更晚，本次不写
     */
    private function sync_post_to_d1($post) {
        if ($post->post_status === 'draft') {
            return $this->sync_draft_to_d1($post);
        }
        $meta = $this->build_post_meta($post);

        // ② 谁更新谁生效（单篇路径：一次 SELECT 换一次往返，可接受）
        $worker = CFSE_Sync_Worker_CMS::get_instance();
        $wid = (int) $meta['post_data']['wp_id'];
        $map = $worker->remote_modified_map(array($wid));
        $remote_ts = $worker->remote_modified_ts(isset($map[$wid]) ? $map[$wid] : '');
        $local_ts = (int) get_post_modified_time('U', true, $post);
        if ($remote_ts > 0 && $remote_ts > $local_ts + 1) {
            $this->log("文章 {$post->ID} 未推送：CMS 侧更晚（远端 {$map[$wid]} / 本地 {$post->post_modified}），先拉取再改", 'WARNING');
            return 'remote_newer';
        }

        $sites = $this->get_post_sites($post->ID);
        if (empty($sites)) {
            $this->log("文章 {$post->ID} 未指定站点且未设默认站点，跳过同步（内容只留在本地 WP）", 'WARNING');
            return false;
        }
        $only_ids = array();
        foreach ($sites as $st) $only_ids[] = $st['id'];

        $written = false;
        for ($i = 0; $i < $this->config['max_retries']; $i++) {
            $res = $this->write_to_d1($meta['post_data'], $meta['categories'], $meta['tags']);
            // 'skipped' = 本次什么都没写。**必须原样返回**，不能往下走去删 R2 单页 ——
            // 删了就成了「D1 没数据 + R2 没文件」= 页面 404（2026-10-21 真机踩坑）。
            // 也不能折成 true：界面上点一次「同步」、日志写「已同步到 D1，耗时 0.01s」，
            // 实际一个字都没进库（2026-10-27 大魔王实测三次才发现）。
            if ($res === 'skipped') {
                $this->log("文章 {$post->ID} 本次未写入（内容无需改动），跳过单页清理", 'INFO');
                return 'skipped';
            }
            if ($res) {
                $written = true;
                break;
            }
            $this->log('D1 写入重试 ' . ($i + 1) . "/{$this->config['max_retries']}", 'WARNING');
            usleep(500000);
        }
        if (!$written) return false;

        $this->sync_media_files($post->post_content);
        $this->invalidate_single_page($post, $only_ids);
        return true;
    }

    /**
     * 删掉 R2 里的旧单页（含 .gz 变体）。
     *
     * Worker 命中 R2 就直接返回，不会回查 D1 —— 数据更新后旧页面会一直留着。
     * 删掉后 routes.js 落到 renderSinglePageOnDemand()，用最新 D1 内容现场渲染并回填。
     */
    private function invalidate_single_page($post, $only_ids = null) {
        $path = $this->get_post_storage_path($post);
        if ($path === '') return;
        $this->delete_from_r2(array($path, $path . '.gz'), $only_ids);
        $this->log("文章 {$post->ID} 旧单页已清除，下次访问由 Worker 按需渲染", 'DEBUG');
    }

    private function sync_draft_to_d1($post) {
        return CFSE_Sync_Worker_CMS::get_instance()->sync_draft_to_d1($post);
    }

    /** 批量同步的单篇入口（全量同步 / 自动同步都走这里） */
    private function run_sync_mode($post_id) {
        // 不要 (bool)：skipped（= 该篇归 CMS 端所有，什么都没写）必须原样透出，
        // 否则调用方只能看到「成功」，界面就无法区分「写了」和「跳过了」。
        return $this->export_post($post_id, null, null, true);
    }

    private function build_post_meta($post) {
        return CFSE_Sync_Worker_CMS::get_instance()->build_post_meta($post);
    }

    private function get_post_site_ids_raw($post_id) {
        return CFSE_Sync_Admin_UI::get_instance()->get_post_site_ids_raw($post_id);
    }

    public function add_site_metabox($post_type = '', $post = null) {
        if ($post_type !== 'post') return;
        add_meta_box('cfse_site', '🌐 站点', array($this, 'render_site_metabox'), 'post', 'side', 'default');
    }
    public function render_site_metabox($post) {
        return CFSE_Sync_Admin_UI::get_instance()->render_site_metabox($post);
    }

    /** 保存「站点」面板（无本面板 nonce ⇒ 不动作，避免其它写入路径被误清） */
    public function save_site_meta($post_id, $post = null, $update = null) {
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
        if (!isset($_POST['cfse_site_nonce'])) return;
        if (!wp_verify_nonce($_POST['cfse_site_nonce'], 'cfse_site_' . $post_id)) return;
        if (!current_user_can('edit_post', $post_id)) return;
        delete_post_meta($post_id, self::META_SITE);
        $vals = isset($_POST['cfse_site']) ? (array) $_POST['cfse_site'] : array();
        $added = 0;
        foreach ($vals as $v) {
            $v = preg_replace('/[^0-9]/', '', (string) $v);
            if ($v === '' ) continue;
            add_post_meta($post_id, self::META_SITE, $v);
            $added++;
        }
        $this->log("文章 {$post_id} 站点已更新为 " . ($added ? ($added . ' 个') : '（空 → 走默认站点）'), 'INFO');
    }

    // ---------- 文章列表：批量设置站点 ----------

    public function add_site_bulk_actions($actions) {
        $targets = $this->get_hosting_targets();
        foreach ($targets as $t) {
            $actions['cfse_site_' . (int) $t['id']] = '设置站点：' . $t['name'];
        }
        $actions['cfse_site_clear'] = '清除站点（走默认站点）';
        return $actions;
    }

    public function handle_site_bulk_actions($redirect, $action, $post_ids) {
        if (strpos($action, 'cfse_site_') !== 0) return $redirect;
        $done = 0;
        if ($action === 'cfse_site_clear') {
            foreach ($post_ids as $pid) {
                delete_post_meta($pid, self::META_SITE);
                $done++;
            }
            $this->log("批量：已清除 {$done} 篇文章的站点标记", 'INFO');
        } else {
            $sid = preg_replace('/[^0-9]/', '', substr($action, strlen('cfse_site_')));
            if ($sid !== '' && $this->site_by_id($sid)) {
                foreach ($post_ids as $pid) {
                    delete_post_meta($pid, self::META_SITE);
                    add_post_meta($pid, self::META_SITE, $sid);
                    $done++;
                }
                $this->log("批量：{$done} 篇文章已设为站点 id={$sid}", 'INFO');
            }
        }
        return add_query_arg('cfse_site_bulk', $done, $redirect);
    }

    public function add_doc_format_metabox($post_type = '', $post = null) {
        add_meta_box('cfse_doc_format', '📝 文档格式', array($this, 'render_doc_format_metabox'), 'post', 'side', 'high');
        // 「☁️ CMS 同步」面板：把单篇同步动作集中到侧边栏一处。
        // 以前分成两处 —— 发布框里「重新同步到 D1」只看 post_status，对所有已发布文章都显示；
        // 侧边栏「检查 Worker 端版本」只在 CMS 掌管的篇显示。结果 CMS 掌管的篇同时出现两个
        // 方向相反的按钮，而「重新同步」那个点下去必然 0 写入（归属保护直接 skipped）。
        // 现在一个面板按归属显示：CMS 掌管 → 查版本 / 对齐；WP 掌管 → 重新同步。
        $is_publish = ($post && isset($post->post_status) && $post->post_status === 'publish');
        if ($is_publish) {
            add_meta_box('cfse_worker_sync', '☁️ CMS 同步', array($this, 'render_worker_sync_metabox'), 'post', 'side', 'default');
        }
    }
    public function render_doc_format_metabox($post) {
        return CFSE_Sync_Admin_UI::get_instance()->render_doc_format_metabox($post);
    }
    public function render_worker_sync_metabox($post) {
        return CFSE_Sync_Admin_UI::get_instance()->render_worker_sync_metabox($post);
    }

    /**
     * 保存「文档格式」标记。
     * 优先级 5：必须早于导出钩子（save_post 优先级 10），否则本次自动导出读到的还是旧标记。
     * 无本面板 nonce / 无权限时直接返回 —— tool/index.php 发布、快速编辑、REST 保存都不带这个 nonce，
     * 因此不会误删由其它途径写入的 content_format 标记。
     */
    public function save_doc_format_meta($post_id, $post = null, $update = null) {
        if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
        if (wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) return;
        if (!isset($_POST['cfse_doc_format_nonce']) || !wp_verify_nonce($_POST['cfse_doc_format_nonce'], 'cfse_doc_format_save')) return;
        if (!$post) $post = get_post($post_id);
        if (!$post || $post->post_type !== 'post') return;
        if (!current_user_can('edit_post', $post_id)) return;
        if (!empty($_POST['cfse_content_format_md'])) {
            update_post_meta($post_id, 'content_format', 'md');
        } else {
            delete_post_meta($post_id, 'content_format');
        }
    }
    private function get_content_format($post_id) {
        return CFSE_Sync_Admin_UI::get_instance()->get_content_format($post_id);
    }
    private function render_markdown($md) {
        return CFSE_Sync_Worker_CMS::get_instance()->render_markdown($md);
    }
    private function md_to_plain($md) {
        return CFSE_Sync_Worker_CMS::get_instance()->md_to_plain($md);
    }

    /**
     * the_content 过滤器：content_format=md 的文章在 WP 前台渲染时转成 HTML。
     * 静态站的单页由 Worker 用 marked 渲染，两边规则一致 —— 这里只保证
     * 「在 WP 里预览 / 后台看」和线上看到的是同一份内容。
     */
    public function render_md_content($content) {
        $id = get_the_ID();
        if (!$id || $this->get_content_format($id) !== 'md') return $content;
        return $this->render_markdown($content);
    }

    // purge_page_caches() / purge_sites_caches() 已移除（2026-09）：
    // 缓存策略与缓存清理由 CMS 后台负责（D1 settings k='cache'），WP 侧不再产生 /purge-cache 请求。

    private function sync_media_files($content) {
        return CFSE_Sync_Worker_CMS::get_instance()->sync_media_files($content);
    }
    private function upload_media_to_r2($url, $path) {
        return CFSE_Sync_Worker_CMS::get_instance()->upload_media_to_r2($url, $path);
    }
    private function get_hosting_templates() {
        return CFSE_Sync_Transports::get_instance()->get_hosting_templates();
    }
    private function normalize_intent($raw) {
        return CFSE_Sync_Transports::get_instance()->normalize_intent($raw);
    }
    private function intent_requires($intent) {
        return CFSE_Sync_Transports::get_instance()->intent_requires($intent);
    }
    private function validate_hosting_targets($is_save = false, $list_override = null) {
        return CFSE_Sync_Transports::get_instance()->validate_hosting_targets($is_save, $list_override);
    }
    private function render_adjustments_notice($adjustments) {
        return CFSE_Sync_Transports::get_instance()->render_adjustments_notice($adjustments);
    }
    private function default_worker_target() {
        return CFSE_Sync_Transports::get_instance()->default_worker_target();
    }
    private function get_hosting_targets($include_disabled = false) {
        return CFSE_Sync_Transports::get_instance()->get_hosting_targets($include_disabled);
    }
    private function site_dir_of($target) {
        return CFSE_Sync_Admin_UI::get_instance()->site_dir_of($target);
    }
    private function default_site() {
        return CFSE_Sync_Admin_UI::get_instance()->default_site();
    }

    /** 按 id 取站点（启用中的） */
    private function site_by_id($id) {
        $id = (string) $id;
        $targets = isset($this->config['hosting_targets']) ? $this->config['hosting_targets'] : array();
        foreach ($targets as $t) {
            if ((string) (isset($t['id']) ? $t['id'] : '') === $id) return $t;
        }
        return null;
    }

    /**
     * 一篇文章所属的站点列表（数组 of target）。
     * 规则：meta cfse_site 有值 ⇒ 取其中「存在且启用」的站点；无值/全失效 ⇒ 走默认站点；仍无 ⇒ 空数组（该篇不生成、不发布）。
     */
    private function get_post_sites($post_id) {
        $raw = get_post_meta($post_id, self::META_SITE, false);
        $ids = array();
        foreach ((array) $raw as $v) {
            if (is_array($v)) { foreach ($v as $x) $ids[] = (string) $x; }
            elseif (is_string($v) && strpos($v, ',') !== false) { foreach (explode(',', $v) as $x) $ids[] = trim($x); }
            elseif ($v !== '' && $v !== null) { $ids[] = (string) $v; }
        }
        $sites = array(); $seen = array();
        foreach ($ids as $id) {
            if ($id === '' || isset($seen[$id])) continue;
            $t = $this->site_by_id($id);
            if ($t) { $sites[] = $t; $seen[$id] = true; }
        }
        if (empty($sites)) {
            $def = $this->default_site();
            if ($def) $sites[] = $def;
        }
        return $sites;
    }
    private function for_each_target($capability, $send, $only_ids = null) {
        return CFSE_Sync_Transports::get_instance()->for_each_target($capability, $send, $only_ids);
    }
    private function worker_request($target, $route, $method, $body = null, $timeout = 30) {
        return CFSE_Sync_Transports::get_instance()->worker_request($target, $route, $method, $body, $timeout);
    }
    private function target_upload($target, $path, $content, $content_type, $content_encoding) {
        return CFSE_Sync_Transports::get_instance()->target_upload($target, $path, $content, $content_type, $content_encoding);
    }
    private function target_delete($target, $paths) {
        return CFSE_Sync_Transports::get_instance()->target_delete($target, $paths);
    }
    private function target_public_url($target, $key) {
        return CFSE_Sync_Transports::get_instance()->target_public_url($target, $key);
    }

    /** 清缓存：只有 CMS（Cloudflare Worker）有缓存层；其它类型视为无需清理（返回 true） */
    private function target_purge($target, $keys) {
        $type = isset($target['type']) ? (string) $target['type'] : 'cfse-worker';
        if ($type === 'cfse-worker') {
            $resp = $this->worker_request($target, '/purge-cache', 'POST', array('keys' => array_values($keys)), 5);
            if ($resp === null) return false;
            return wp_remote_retrieve_response_code($resp) < 400;
        }
        return true;
    }
    private function upload_to_r2_via_worker($path, $content, $content_type = 'text/html', $content_encoding = null, $only_ids = null) {
        return CFSE_Sync_Worker_CMS::get_instance()->upload_to_r2_via_worker($path, $content, $content_type, $content_encoding, $only_ids);
    }
    private function ensure_d1_schema() {
        return CFSE_Sync_Worker_CMS::get_instance()->ensure_d1_schema();
    }
    private function migrate_d1_schema($rebuild_links = false) {
        return CFSE_Sync_Worker_CMS::get_instance()->migrate_d1_schema($rebuild_links);
    }
    private function write_to_d1($post_data, $categories, $tags, $only_ids = null) {
        return CFSE_Sync_Worker_CMS::get_instance()->write_to_d1($post_data, $categories, $tags, $only_ids);
    }
    private function get_post_terms($post_id, $taxonomy) {
        return CFSE_Sync_Worker_CMS::get_instance()->get_post_terms($post_id, $taxonomy);
    }
    private function d1_execute($sql, $params = array()) {
        return CFSE_Sync_Worker_CMS::get_instance()->d1_execute($sql, $params);
    }
    private function d1_query($sql, $params = array()) {
        return CFSE_Sync_Worker_CMS::get_instance()->d1_query($sql, $params);
    }

    // ===== 以下方法已拆分到 includes/class-transports.php（同名转发，调用点无需改动）=====

    
    
    
    
    
    
    
    
    
        private function d1_batch($statements, $only_ids = null) {
        return CFSE_Sync_Worker_CMS::get_instance()->d1_batch($statements, $only_ids);
    }
    private function worker_d1_batch($target, $statements) {
        return CFSE_Sync_Worker_CMS::get_instance()->worker_d1_batch($target, $statements);
    }
    public function purge_site_ctx_option() {
        return CFSE_Sync_Worker_CMS::get_instance()->purge_site_ctx_option();
    }
    /**
     * 设置页「🔄 同步站点设置到 D1」：WP 侧**唯一**会写 D1 site 行的入口（服务端合并写入）。
     * 自动写入已全部下线（改站点标题/描述/URL、同步模板、初始化部署 都不再写 D1）。
     */
    public function handle_sync_site_info() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_sync_site_info');
        $ok = $this->sync_site_info();
        wp_redirect(add_query_arg('site_info_synced', $ok ? '1' : '0', admin_url('options-general.php?page=cfse-sync')));
        exit;
    }
    public function sync_site_info() {
        return CFSE_Sync_Worker_CMS::get_instance()->sync_site_info();
    }

    // ============================================
    // 评论 → D1 同步（B1：单向；WP 始终是权威）
    // ============================================
    /** 评论同步总开关（默认关：不动远端） */
    private function comments_sync_enabled() {
        return (bool) get_option('cf_comments_sync', false);
    }

    /** 抓取风格时临时创建的探针文章 ⇒ 它的评论不同步 */
    private function is_probe_comment($comment) {
        if (!$comment) return false;
        $pid = (int) $comment->comment_post_ID;
        if ($pid <= 0) return false;
        return (bool) get_post_meta($pid, '_cfse_probe', true);
    }

    /** 单条评论的 D1 行（顺序与 SQL 占位符一一对应） */
    private function comment_d1_row($comment) {
        $appr = ($comment->comment_approved === '1' || $comment->comment_approved === 1) ? 1 : 0;
        // 显示用日期文本：与抓取端 cfse_skin_comment_entry_skeleton() 的候选顺序保持一致（date_format + ' at ' + time_format）
        $date_text = '';
        $ts = strtotime((string) $comment->comment_date);
        if ($ts) {
            $df = (string) get_option('date_format');
            $tf = (string) get_option('time_format');
            if ($df !== '' && $tf !== '') { $date_text = date_i18n($df, $ts) . ' at ' . date_i18n($tf, $ts); }
            else { $date_text = date_i18n($df !== '' ? $df : 'F j, Y', $ts); }
        }
        // 头像 URL：在 WP 侧算好（gravatar 需要 md5，Worker 端没有可靠的同步 md5）
        $avatar = '';
        if (function_exists('get_avatar_url')) {
            $avatar = (string) get_avatar_url($comment, array('size' => 40));
        }
        return array(
            (int) $comment->comment_ID,
            (int) $comment->comment_ID,   // wp_comment_id（B1 阶段就是它自己）
            (int) $comment->comment_post_ID,
            (int) $comment->comment_parent,
            (string) $comment->comment_author,
            (string) $comment->comment_author_email,
            (string) $comment->comment_author_url,
            $avatar,
            $date_text,
            (string) $comment->comment_date,
            (string) $comment->comment_content,
            $appr,
            (string) ($comment->comment_type !== '' ? $comment->comment_type : 'comment'),
            'wp',
            current_time('mysql'),
        );
    }

    private function comment_upsert_sql() {
        return "INSERT INTO comments (comment_id, wp_comment_id, post_id, parent_id, author, author_email, author_url, avatar, date_text, date, content, approved, type, origin, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(comment_id) DO UPDATE SET wp_comment_id=excluded.wp_comment_id, post_id=excluded.post_id,
                parent_id=excluded.parent_id, author=excluded.author, author_email=excluded.author_email,
                author_url=excluded.author_url, avatar=excluded.avatar, date_text=excluded.date_text,
                date=excluded.date, content=excluded.content,
                approved=excluded.approved, type=excluded.type, origin=excluded.origin, updated_at=excluded.updated_at";
    }

    /** 新增/编辑一条评论 → D1（wp_insert_comment / edit_comment 共用） */
    public function on_comment_changed($comment_id, $comment = null) {
        if (!empty($GLOBALS['cfse_skip_comment_sync'])) return;   // 回拉期间短路（见 pull_comments_from_worker）
        if (!$this->comments_sync_enabled()) return;
        if (!$comment) $comment = get_comment($comment_id);
        if (!$comment || $this->is_probe_comment($comment)) return;
        // 回拉来的评论（带 _cfse_remote_comment_id）：它对应 D1 里**已存在**的那一行，
        // 只能更新那一行（wp_comment_id / origin / approved），绝不能按 WP 新 ID 再插一行。
        $remote_id = (int) get_comment_meta((int) $comment->comment_ID, '_cfse_remote_comment_id', true);
        if ($remote_id > 0) {
            $this->comment_map_back($remote_id, (int) $comment->comment_ID);
            return;
        }
        $this->d1_batch(array(array('sql' => $this->comment_upsert_sql(), 'params' => $this->comment_d1_row($comment))));
        $this->log('评论 #' . (int) $comment_id . ' 已同步到 D1（approved=' . $comment->comment_approved . '）', 'DEBUG');
    }

    /** 审核状态变化（wp_set_comment_status / 后台批量审核都会触发）
     *  ⚠️ `wp_delete_comment()` 末尾也会触发一次 `transition_comment_status('…->delete')`——
     *  这里若无脑 upsert，就会把刚删掉的行又写回 D1（实测踩过）⇒ 删除类状态走删除。 */
    public function on_comment_status_changed($new_status, $old_status, $comment) {
        if (!$comment) return;
        $id = (int) $comment->comment_ID;
        if (in_array($new_status, array('delete', 'trash', 'spam'), true)) {
            $this->on_comment_deleted($id);
            return;
        }
        $this->on_comment_changed($id, $comment);
    }

    /** 评论**删除前** → 从 D1 删除
     *  回拉来的评论在 D1 里的主键是**远端 ID**（时间戳形态），所以必须用 meta `_cfse_remote_comment_id` 定位；
     *  而到 `deleted_comment` 时该 meta 已被 WP 删掉 ⇒ 只能挂在更早的 `delete_comment` 上。 */
    public function on_comment_deleting($comment_id, $comment = null) {
        if (!$this->comments_sync_enabled()) return;
        $remote_id = (int) get_comment_meta((int) $comment_id, '_cfse_remote_comment_id', true);
        $target = $remote_id > 0 ? $remote_id : (int) $comment_id;
        $this->d1_batch(array(array('sql' => 'DELETE FROM comments WHERE comment_id = ?', 'params' => array($target))));
        $this->log('评论 #' . (int) $comment_id . ' 已从 D1 删除（D1 id=' . $target . '）', 'DEBUG');
    }

    /** 评论删除 → 从 D1 删除（兜底，按 WP comment_ID；回拉来的评论由上面的 delete_comment 钩子处理） */
    public function on_comment_deleted($comment_id) {
        if (!$this->comments_sync_enabled()) return;
        $this->d1_batch(array(array(
            'sql' => 'DELETE FROM comments WHERE comment_id = ?',
            'params' => array((int) $comment_id),
        )));
        $this->log('评论 #' . (int) $comment_id . ' 已从 D1 删除', 'DEBUG');
    }

    /** 全量补同步（分批；返回 array(已处理条数, WP 侧评论总数)） */
    public function sync_all_comments($batch = 200) {
        if (!$this->comments_sync_enabled()) return array(0, 0);
        $batch = max(1, min(1000, (int) $batch));
        $offset = 0;
        $done = 0;
        $total = 0;
        $counts = wp_count_comments();
        if (is_object($counts) && isset($counts->total_comments)) { $total = (int) $counts->total_comments; }
        while (true) {
            $rows = get_comments(array('status' => 'any', 'number' => $batch, 'offset' => $offset, 'orderby' => 'comment_ID', 'order' => 'ASC'));
            if (empty($rows)) break;
            $statements = array();
            foreach ($rows as $c) {
                if ($this->is_probe_comment($c)) continue;
                $statements[] = array('sql' => $this->comment_upsert_sql(), 'params' => $this->comment_d1_row($c));
            }
            if (!empty($statements)) { $this->d1_batch($statements); $done += count($statements); }
            if (count($rows) < $batch) break;
            $offset += $batch;
            if ($offset > 50000) break;
        }
        $this->log('评论全量补同步：' . $done . ' / ' . $total, 'INFO');
        return array($done, $total);
    }

    // ============================================
    // B2：把 Worker 端收到的评论拉回 WP（WP 主动拉；落地后 WP 成为权威）
    //   线上 Worker 无法访问内网源站 ⇒ 方向只能是 WP 拉（与 /sync/posts 同构）。
    // ============================================
    /** 把「已落地」的结果写回 D1：wp_comment_id + origin='wp' + approved（外加头像与格式化日期 —— 只有 WP 算得出），
     *  ⇒ 下次不再被拉（不回环），且「Worker 端提交」的评论也能拿到头像与主题日期文本。 */
    private function comment_map_back($remote_id, $wp_comment_id) {
        $c = get_comment($wp_comment_id);
        if (!$c) return;
        // 行顺序见 comment_d1_row()：[4]author [5]email [6]url [7]avatar [8]date_text [10]content [11]approved
        $row = $this->comment_d1_row($c);
        $this->d1_batch(array(array(
            'sql' => "UPDATE comments SET wp_comment_id = ?, origin = 'wp', approved = ?, avatar = ?, date_text = ?,
                      author = ?, author_email = ?, author_url = ?, content = ?, updated_at = ? WHERE comment_id = ?",
            'params' => array(
                (int) $wp_comment_id,
                (int) $row[11],
                (string) $row[7],
                (string) $row[8],
                (string) $row[4],
                (string) $row[5],
                (string) $row[6],
                (string) $row[10],
                current_time('mysql'),
                (int) $remote_id,
            ),
        )));
    }

    /** 回拉 Worker 端评论（origin='worker' 且未落地）。返回 array(新增, 跳过, 错误) */
    public function pull_comments_from_worker() {
        $site = isset($this->config['site_url']) ? rtrim($this->config['site_url'], '/') : '';
        $key = isset($this->config['auth_key']) ? $this->config['auth_key'] : '';
        if ($site === '' || $key === '') {
            $this->log('评论回拉失败：静态站点 URL 或 Worker Auth Key 未配置', 'ERROR');
            return array(0, 0, 1);
        }
        $resp = wp_remote_get($site . '/sync/comments?limit=500&unpulled=1', array('timeout' => 60, 'headers' => array('X-Auth-Key' => $key)));
        if (is_wp_error($resp)) {
            $this->log('评论回拉失败：' . $resp->get_error_message(), 'ERROR');
            return array(0, 0, 1);
        }
        $code = wp_remote_retrieve_response_code($resp);
        if ($code !== 200) {
            $this->log("评论回拉失败：HTTP {$code} " . substr((string) wp_remote_retrieve_body($resp), 0, 200), 'ERROR');
            return array(0, 0, 1);
        }
        $data = json_decode(wp_remote_retrieve_body($resp), true);
        $items = (is_array($data) && isset($data['comments']) && is_array($data['comments'])) ? $data['comments'] : array();

        $added = 0; $skipped = 0; $errors = 0;
        $map = array();   // 远端 comment_id => WP comment_ID（父评论先到 ⇒ 能正确挂 children）
        // 回拉期间**短路同步钩子**：此刻 WP 侧评论还没写 _cfse_remote_comment_id（要等插入后才能写），
        // 不短路的话钩子会按 WP 新 ID 另插一行（实测踩过）⇒ 用「保存-恢复」写法；落地后由 comment_map_back 回写。
        $prev_skip = isset($GLOBALS['cfse_skip_comment_sync']) ? $GLOBALS['cfse_skip_comment_sync'] : null;
        $GLOBALS['cfse_skip_comment_sync'] = true;
        foreach ($items as $c) {
            $rid = isset($c['comment_id']) ? (int) $c['comment_id'] : 0;
            $pid = isset($c['post_id']) ? (int) $c['post_id'] : 0;
            if ($rid <= 0 || $pid <= 0) { $errors++; continue; }

            // 已落地过？（meta 兜底：万一 D1 的 wp_comment_id 没写回）
            $exists = get_comments(array(
                'meta_key' => '_cfse_remote_comment_id', 'meta_value' => $rid,
                'number' => 1, 'status' => 'any', 'fields' => 'ids',
            ));
            if (!empty($exists)) {
                $map[$rid] = (int) $exists[0];
                $this->comment_map_back($rid, (int) $exists[0]);
                $skipped++;
                continue;
            }
            if (!get_post($pid)) { $skipped++; continue; }   // 目标文章不在 WP（例如 Worker 侧诞生的文章）
            $rparent = isset($c['parent_id']) ? (int) $c['parent_id'] : 0;
            // 父评论映射：① 本批已处理过的（$map：远端 comment_id → WP comment_ID）；② 或者它本来就活在 WP 里。
            // 回拉只取 unpulled（origin='worker'），而**父评论常常早已是 WP 原生评论** —— D1 里原生评论的
            // comment_id 就等于 WP comment_ID，但它不在本批里、$map 里自然也没有 ⇒ 子回复会掉成顶层。
            // 实测踩过：回复落进 WP 后 comment_parent=0（层级丢失）。
            $parent_wp = 0;
            if ($rparent > 0) {
                if (isset($map[$rparent])) {
                    $parent_wp = (int) $map[$rparent];
                } else {
                    $pobj = get_comment($rparent);
                    if ($pobj && (int) $pobj->comment_post_ID === $pid) {
                        $parent_wp = (int) $rparent;
                    }
                }
            }

            // 刻意**不指定** comment_ID：那会把 wp_comments 的 AUTO_INCREMENT 顶到时间戳量级（批L 的教训）。
            // 远端 comment_id 记在 meta `_cfse_remote_comment_id`，回写 D1 时用它定位那一行。
            $args = array(
                'comment_post_ID'      => $pid,
                'comment_author'       => isset($c['author']) ? (string) $c['author'] : '',
                'comment_author_email' => isset($c['author_email']) ? (string) $c['author_email'] : '',
                'comment_author_url'   => isset($c['author_url']) ? (string) $c['author_url'] : '',
                'comment_content'      => isset($c['content']) ? (string) $c['content'] : '',
                'comment_approved'     => (isset($c['approved']) && (int) $c['approved'] === 1) ? 1 : 0,
                'comment_parent'       => $parent_wp,
                'comment_type'         => 'comment',
            );
            if (!empty($c['date'])) { $args['comment_date'] = (string) $c['date']; $args['comment_date_gmt'] = (string) $c['date']; }
            $cid = wp_insert_comment($args);
            if (!$cid) { $errors++; continue; }
            add_comment_meta($cid, '_cfse_remote_comment_id', $rid, true);
            $map[$rid] = (int) $cid;
            $this->comment_map_back($rid, (int) $cid);   // 落地后立刻回写 D1（wp_comment_id / origin / approved）
            $added++;
        }
        // 恢复原值（不要直接 unset：可能与外层调用嵌套）
        if ($prev_skip === null) { unset($GLOBALS['cfse_skip_comment_sync']); }
        else { $GLOBALS['cfse_skip_comment_sync'] = $prev_skip; }
        $this->log('评论回拉完成：新增 ' . $added . ' / 跳过 ' . $skipped . ' / 错误 ' . $errors . '（返回 ' . count($items) . ' 条）', 'INFO');
        return array($added, $skipped, $errors);
    }

    /** cron：定时评论回拉（默认开；需评论同步也开着 —— 不同步就没必要拉） */
    public function handle_pull_comments_cron() {
        if (!get_option('cf_comments_pull_cron', true)) return;
        if (!$this->comments_sync_enabled()) return;
        list($added, $skipped, $errors) = $this->pull_comments_from_worker();
        if ($added > 0 || $errors > 0) {
            $this->log('定时评论回拉：新增 ' . $added . ' / 跳过 ' . $skipped . ' / 错误 ' . $errors, 'INFO');
        }
    }

    /** 设置页按钮：手动触发评论回拉 */
    public function handle_pull_comments() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cfse_pull_comments');
        list($added, $skipped, $errors) = $this->pull_comments_from_worker();
        $back = wp_get_referer();
        wp_safe_redirect(add_query_arg(array('cfse_comments_pulled' => $added, 'cfse_comments_pull_err' => $errors), $back ? $back : admin_url()));
        exit;
    }

    /** 设置页按钮：手动触发评论全量补同步 */
    public function handle_sync_comments() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cfse_sync_comments');
        list($done, $total) = $this->sync_all_comments(200);
        $this->log('手动评论全量补同步完成：' . $done . ' / ' . $total, 'INFO');
        $back = wp_get_referer();
        wp_safe_redirect(add_query_arg(array('cfse_comments_synced' => $done), $back ? $back : admin_url()));
        exit;
    }
    public function delete_post($post_input) {
        return CFSE_Sync_Worker_CMS::get_instance()->delete_post($post_input);
    }
    /**
     * 删除 R2 文件（支持单 path 或多个 paths，一次请求；不存在/多余路径无害）
     *
     * @param string|array $paths
     * @return bool
     */
    private function delete_from_r2($paths, $only_ids = null) {
        try {
            $paths = array_values(array_filter((array) $paths, 'strlen'));
            if (empty($paths)) return true;
            // 多托管：对所有「具备静态文件能力」的目标删除（可按站点过滤）
            $res = $this->for_each_target('r2', function ($t) use ($paths) {
                return $this->target_delete($t, $paths);
            }, $only_ids);
            if ($res['tried'] === 0) {
                $this->log('没有启用「静态文件」能力的托管目标，跳过删除：' . implode(', ', $paths), 'DEBUG');
            } elseif (!$res['ok']) {
                return false;
            } else {
                $this->log('文件已删除（' . $res['tried'] . ' 个目标）：' . implode(', ', $paths) . ' → ' . wp_json_encode($res['results']), 'INFO');
            }
            return true;
        } catch (Throwable $e) {
            $this->log("delete_from_r2 内部异常：" . $e->getMessage(), 'ERROR');
            return false;
        }
    }

    // ============================================
    // Worker 代码管理
    // ============================================


/**
 * 修复 Permalink 转路由模式 - 支持更多标签
 */
    private function permalink_to_storage_pattern($permalink) {
        return CFSE_Sync_Worker_CMS::get_instance()->permalink_to_storage_pattern($permalink);
    }
	/**
	 * 部署 Worker：把 CMS 发行包推上去（调用 wrangler）。
	 *
	 * 2026-10-25：不再重新生成 routes.js —— CMS 侧已运行时化
	 * （URL 结构从 D1 settings k='site' 的 storagePattern 读，改完即生效），
	 * 路由规则不再是编译期常量，插件侧没有生成它的必要。
	 */
public function handle_deploy_worker() {
    if (!current_user_can('manage_options')) wp_die('权限不足');
    check_admin_referer('cf_deploy_worker');
    @set_time_limit(0);

    // 模板由 Worker 后台的模板编辑器管理（存 R2 wp-content/themes/<id>/tpl.json），
    // 插件侧不再生成 tpl.json，也不再搬主题静态资源。

    $deployed = $this->deploy_worker();
    wp_redirect(add_query_arg('deployed', $deployed ? '1' : '0', admin_url('options-general.php?page=cfse-sync')));
    exit;
}

    /**
     * 部署 Worker：把 CMS 发行包推上去（调用 wrangler）。
     *
     * 2026-10-25 改造：源码目录从「插件内嵌的 worker/ 副本」改为「已下载的发行包」。
     *   理由：内嵌副本必然漂移（CMS 仓删了 documents.js / routes.template.js，
     *   插件里的副本还在，部署一次就把已砍掉的功能推回线上 —— 2026-10-25 真发生过）。
     *   发行包由 CMS 官方发布，版本永远与官方一致。
     *
     * 兼容：没有发行包时回落到内嵌副本，但会明确警告（见 resolve_source_dir）。
     */
    private function deploy_worker() {
        $rel = CFSE_Sync_Release::get_instance();
        $src = $rel->resolve_source_dir();
        $worker_dir = $src['dir'];

        if (empty($src['ready'])) {
            $this->log($src['note'], 'ERROR');
            return false;
        }
        if (!is_dir($worker_dir)) {
            $this->log('Worker 源码目录不存在: ' . $worker_dir, 'ERROR');
            return false;
        }
        $this->log('使用发行包源码：' . $worker_dir, 'INFO');

        // 确保 assets 目录存在（wrangler [assets] directory 缺失会部署失败）
        $static_dir = $worker_dir . '/static';
        if (!is_dir($static_dir)) {
            wp_mkdir_p($static_dir);
        }

        $required = array('src/index.js', 'src/routes.js', 'src/template-engine.js', 'src/fallback-tpl.js', 'src/database.js', 'src/storage.js', 'src/cache.js', 'src/auth.js', 'src/admin.js', 'src/site.js');
        foreach ($required as $file) {
            if (!file_exists($worker_dir . '/' . $file)) {
                $this->log("缺少必要文件: {$file}", 'ERROR');
                return false;
            }
        }

        // wrangler.toml 不进发行包（里面有账号级 ID）：首次部署时从 .example 生成一份，
        // 把插件设置里已经填好的 D1 / R2 名字代进去，剩下的（KV id / D1 库名）由用户补。
        // ⚠️ toml 必须放在**发行包目录**里 —— wrangler 从工作目录读配置。
        $toml = $worker_dir . '/wrangler.toml';
        if (!file_exists($toml)) {
            $this->scaffold_wrangler_toml($toml);
        }
        $toml_text = file_exists($toml) ? (string) @file_get_contents($toml) : '';
        if (strpos($toml_text, 'REPLACE_WITH_YOUR_') !== false) {
            $this->log('wrangler.toml 还有 REPLACE_WITH_YOUR_* 未替换，部署已中止。请按文件顶部注释创建 D1 / KV / R2 并填入 ID。', 'ERROR');
            return false;
        }

        if (function_exists('exec')) {
            $command = 'cd ' . escapeshellarg($worker_dir) . ' && npx wrangler deploy 2>&1';
            $output = array();
            $return_code = 0;
            exec($command, $output, $return_code);
            if ($return_code === 0) {
                $this->log('Worker 部署成功', 'INFO');
                return true;
            } else {
                $this->log('Worker 部署失败: ' . implode("\n", $output), 'ERROR');
                return false;
            }
        }

        $this->log('exec 函数不可用，请手动部署: cd ' . $worker_dir . ' && npx wrangler deploy', 'WARNING');
        return false;
    }


    /**
     * 下载 CMS 发行包（双源：GitHub Releases → 官网 → 固定 workers.dev 地址）。
     *
     * WP 后台「高级 → 部署 CMS」里的第一步。下载完解压到 cms-package/cf-cms/，
     * 之后的「部署」会用它推上去。
     */
    public function handle_download_release() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_download_release');
        @set_time_limit(300);

        $rel = CFSE_Sync_Release::get_instance();
        $res = $rel->download();

        if (empty($res['ok'])) {
            wp_redirect(add_query_arg('release_dl', '0', admin_url('options-general.php?page=cfse-sync&release_error=' . rawurlencode($res['error']))));
            exit;
        }

        // 解压到 cms-package/cf-cms/
        $ex = $rel->extract($res['path'], $rel->source_dir());
        if (empty($ex['ok'])) {
            wp_redirect(add_query_arg('release_dl', '0', admin_url('options-general.php?page=cfse-sync&release_error=' . rawurlencode($ex['error']))));
            exit;
        }

        // 记下版本，UI 上显示
        update_option('cf_cms_release_version', $res['version']);
        update_option('cf_cms_release_source', $res['source']);
        update_option('cf_cms_release_time', time());

        $this->log('CMS 发行包就绪：版本 ' . $res['version'] . '（来源：' . $res['source'] . '，' . $ex['files'] . ' 个文件）', 'INFO');
        wp_redirect(add_query_arg('release_dl', '1', admin_url('options-general.php?page=cfse-sync')));
        exit;
    }

    /**
     * 从 wrangler.toml.example 生成 worker/wrangler.toml，并把插件设置里已知的
     * D1 database_id / R2 bucket_name 代进去（KV namespace id 无从得知，留给用户填）。
     */
    private function scaffold_wrangler_toml($toml) {
        // wrangler.toml.example 在发行包目录里（源码目录的同级）
        $example = dirname($toml) . '/wrangler.toml.example';
        if (!file_exists($example)) {
            $this->log('缺少 wrangler.toml.example，无法生成部署配置', 'ERROR');
            return false;
        }
        $text = (string) @file_get_contents($example);
        $d1 = isset($this->config['d1_database']) ? trim((string) $this->config['d1_database']) : '';
        $r2 = isset($this->config['r2_bucket']) ? trim((string) $this->config['r2_bucket']) : '';
        if ($d1 !== '') $text = str_replace('REPLACE_WITH_YOUR_D1_ID', $d1, $text);
        if ($r2 !== '') $text = str_replace('REPLACE_WITH_YOUR_R2_BUCKET', $r2, $text);
        if (@file_put_contents($toml, $text) === false) {
            $this->log('写入 worker/wrangler.toml 失败（目录不可写）：' . $toml, 'ERROR');
            return false;
        }
        $this->log('已生成 worker/wrangler.toml（D1 / R2 按插件设置预填，KV namespace id 需手工补）', 'WARNING');
        return true;
    }

    // ============================================
    // 各种操作处理器
    // ============================================
    private function increment_exported_count() {
        $count = (int) get_option('cf_exported_count', 0);
        update_option('cf_exported_count', $count + 1);
    }

    public function handle_clear_cache() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_clear_cache');
        update_option('cf_exported_count', 0);
        delete_option('cf_last_export_time');
        global $wpdb;
        // 两个「已处理」标记都要清：列表状态列与「自动同步」的筛选条件都看它们。
        // 只动 WP 侧记账 —— 不碰 D1 / R2 / site:ctx（那些归 CMS 自己管）。
        $wpdb->delete($wpdb->postmeta, array('meta_key' => '_cf_exported'));
        $wpdb->delete($wpdb->postmeta, array('meta_key' => '_cfse_synced_d1'));
        // 内容 hash 与图片指纹也要清，否则「强制重写全部」仍会跳过单页失效、图片也不重传
        $wpdb->delete($wpdb->postmeta, array('meta_key' => '_cfse_hash'));
        $wpdb->delete($wpdb->postmeta, array('meta_key' => '_cfse_tax_sig'));
        delete_option('cfse_media_index');
        $this->log('已重置同步标记（_cf_exported / _cfse_synced_d1 / 内容 hash / 图片指纹 已清空）', 'INFO');
        wp_redirect(admin_url('options-general.php?page=cfse-sync&cache_cleared=1'));
        exit;
    }


    public function deactivate() {
        wp_clear_scheduled_hook('cf_auto_export_cron');
        $this->log('插件已停用', 'INFO');
    }

    public function handle_auto_export() {
        if (empty($this->config['sync_d1'])) {
            $this->log('自动同步未开启（设置页「自动同步到 D1」），本次定时任务跳过', 'INFO');
            return;
        }
        @set_time_limit(0);
        @ignore_user_abort(true);
        $posts = get_posts(array('post_type' => 'post', 'post_status' => 'publish', 'meta_query' => array(
            'relation' => 'AND',
            array('key' => '_cf_exported', 'compare' => 'NOT EXISTS'),
            array('key' => '_cfse_synced_d1', 'compare' => 'NOT EXISTS'),
        ), 'posts_per_page' => $this->config['batch_size']));
        $ids = array();
        foreach ($posts as $post) $ids[] = (int) $post->ID;
        // 走批量通道：这些篇本来就从没同步过，force=false 的「跳过未变更」不会误跳
        list($ok, $total) = $this->sync_posts($ids, false);
        $this->log("自动同步完成，处理了 {$total} 篇（成功 {$ok}）", 'INFO');
    }

    public function add_export_column($columns) { $columns['cf_exported'] = '☁️ 同步状态'; return $columns; }
    public function render_export_column($column, $post_id) {
        return CFSE_Sync_Admin_UI::get_instance()->render_export_column($column, $post_id);
    }


    /** 收集全部已发布文章的 ID（分批 200，避免大站一次性载入） */
    private function collect_published_ids() {
        $all = array();
        $offset = 0;
        $chunk = 200;
        do {
            $ids = get_posts(array('post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => $chunk, 'offset' => $offset, 'fields' => 'ids'));
            if (empty($ids)) break;
            $all = array_merge($all, $ids);
            $offset += $chunk;
        } while (count($ids) === $chunk);
        return $all;
    }
    private function fetch_worker_post($wp_id) {
        return CFSE_Sync_Worker_CMS::get_instance()->fetch_worker_post($wp_id);
    }
    private function overwrite_post_from_remote($post_id, $remote) {
        return CFSE_Sync_Worker_CMS::get_instance()->overwrite_post_from_remote($post_id, $remote);
    }

    /** 「↻ 从 Worker 对齐本篇」 */
    public function handle_align_worker() {
        // 面板里的「对齐本篇」是链接（GET），所以读 $_REQUEST
        $post_id = isset($_REQUEST['post_id']) ? (int) $_REQUEST['post_id'] : 0;
        $this->log("收到「对齐本篇」请求：post_id={$post_id}", 'INFO');
        if (!$post_id || !current_user_can('edit_post', $post_id)) wp_die('权限不足');
        check_admin_referer('cfse_align_worker_' . $post_id);
        $post = get_post($post_id);
        if (!$post) {
            $this->log("对齐失败：WP 侧文章不存在 post_id={$post_id}", 'ERROR');
            wp_safe_redirect(add_query_arg('cfse_aligned', '0', admin_url('edit.php')));
            exit;
        }
        $remote_id = $this->get_remote_wp_id($post_id);
        $remote = $remote_id ? $this->fetch_worker_post($remote_id) : null;
        $ok = false;
        if ($remote) {
            $ok = $this->overwrite_post_from_remote($post_id, $remote);
        } else {
            $this->log("对齐失败：未能从 Worker 取到远端 wp_id={$remote_id}（WP post_id={$post_id}）", 'ERROR');
        }
        $this->log("从 Worker 对齐 wp_id={$post_id}（远端 {$remote_id}）：" . ($ok ? '成功' : '失败'), $ok ? 'INFO' : 'ERROR');
        // 跳回当前文章；拿不到编辑链接（如已删除）才退回列表页
        $back = get_edit_post_link($post_id, 'raw');
        if (!$back) $back = admin_url('edit.php');
        wp_safe_redirect(add_query_arg('cfse_aligned', $ok ? '1' : '0', $back));
        exit;
    }

    /** AJAX：查询该篇在 Worker 端与本地的版本时间（编辑页异步调用，不阻塞页面渲染） */
    /** AJAX：测试各托管目标的连通性（用已保存的配置） */
    /**
     * 测试与 CMS 的连接（状态机用的那个）。
     *
     * 与 ajax_test_targets 的区别：这里只测**主目标**，并且在测通时把状态记成
     * 「已连接」—— 状态机据此决定显示哪一屏。
     */
    public function ajax_test_connection() {
        if (!current_user_can('manage_options')) wp_send_json_error(array('error' => '无权限'), 403);
        check_ajax_referer('cfse_test_connection');

        $onb = CFSE_Sync_Onboarding::get_instance();
        $p = $onb->get_primary();

        // 表单里传的值优先 —— 用户可能还没保存就想先测一下。
        // （传入为空时才回落到已保存的 option）
        $req_endpoint = isset($_POST['endpoint']) ? trim((string) wp_unslash($_POST['endpoint'])) : '';
        $req_key     = isset($_POST['auth_key']) ? trim((string) wp_unslash($_POST['auth_key'])) : '';
        if ($req_endpoint !== '') $p['endpoint'] = rtrim($req_endpoint, '/');
        if ($req_key !== '') $p['auth_key'] = $req_key;

        if ($p['endpoint'] === '') {
            wp_send_json_error(array('error' => '还没填 CMS 地址'));
        }
        if ($p['auth_key'] === '') {
            wp_send_json_error(array('error' => '还没填同步密钥'));
        }

        $target = array(
            'id' => 'primary',
            'name' => $p['name'] !== '' ? $p['name'] : 'CMS',
            'type' => 'cfse-worker',
            'endpoint' => $p['endpoint'],
            'auth_key' => $p['auth_key'],
        );

        // 用受保护接口测：401 能明确指向「密钥不对」（/health 不需要认证，证明不了 key）
        $resp = $this->worker_request($target, '/style-list', 'GET', null, 15);
        if ($resp === null) {
            $onb->mark_unconnected();
            wp_send_json_error(array('error' => '网络不可达或连接失败（检查地址是否可以访问）'));
        }
        $code = (int) wp_remote_retrieve_response_code($resp);
        if ($code === 200) {
            $onb->mark_connected();
            // 顺带报一下 CMS 的站点名，让用户确认连对了
            $info = array();
            try {
                $r2 = $this->worker_request($target, '/sync/site-info', 'GET', null, 10);
                if ($r2 !== null && (int) wp_remote_retrieve_response_code($r2) === 200) {
                    $j = json_decode((string) wp_remote_retrieve_body($r2), true);
                    if (is_array($j)) $info = $j;
                }
            } catch (Throwable $e) { /* 拿不到就算了，不影响连接判定 */ }
            // 时区一致性守卫：CMS 的 timezoneOffset 必须与本站 gmt_offset 一致。
            // 不一致 ⇒ CMS 后台写入的时间戳会和 WP 差一个时区，「检查 Worker 版本」
            // 会成批误判成「远端更新」。2026-10-26 实际踩到（CMS 是 0，本站是 +8）。
            $tz_warn = '';
            $wp_tz_sec = (int) round(((float) get_option('gmt_offset', 0)) * 3600);
            if (isset($info['timezoneOffset']) && (int) $info['timezoneOffset'] !== $wp_tz_sec) {
                $cms_tz_sec = (int) $info['timezoneOffset'];
                $fmt = function ($sec) { return ($sec === 0) ? 'UTC+0' : sprintf('UTC%+g', $sec / 3600); };
                $tz_warn = sprintf(
                    '⚠ 时区不一致：CMS 是 %s，本站是 %s。在 CMS 后台改文章时，时间戳会差 %g 小时，导致「检查 Worker 版本」误判。点「🔄 同步站点设置到 D1」修正。',
                    $fmt($cms_tz_sec), $fmt($wp_tz_sec), abs($cms_tz_sec - $wp_tz_sec) / 3600
                );
            }
            wp_send_json_success(array(
                'message' => '连接成功',
                'siteName' => isset($info['name']) ? $info['name'] : '',
                'storagePattern' => isset($info['storagePattern']) ? $info['storagePattern'] : '',
                'tzWarning' => $tz_warn,
            ));
        }
        $onb->mark_unconnected();
        if ($code === 401 || $code === 403) {
            wp_send_json_error(array('error' => '同步密钥不对（HTTP ' . $code . '）'));
        }
        wp_send_json_error(array('error' => 'HTTP ' . $code));
    }


    public function ajax_test_targets() {
        if (!current_user_can('manage_options')) wp_send_json_error(array('error' => '无权限'), 403);
        check_ajax_referer('cfse_test_targets');
        $out = array();
        foreach ($this->get_hosting_targets() as $t) {
            $name = (isset($t['name']) && $t['name'] !== '') ? $t['name'] : (isset($t['id']) ? $t['id'] : '?');
            $type = isset($t['type']) ? $t['type'] : 'cfse-worker';
            if ($type === 'cfse-worker') {
                // 用受保护接口（/style-list）测：这样 401 能明确指向「X-Auth-Key 不对」——
                // /health 不需要认证，只能证明「能连通」，证明不了 Key。
                $base = rtrim(isset($t['endpoint']) ? (string) $t['endpoint'] : '', '/');
                if ($base === '') {
                    $out[] = array('name' => $name, 'ok' => false, 'code' => 'config', 'detail' => '未配置端点', 'http' => 0);
                    continue;
                }
                $resp = $this->worker_request($t, '/style-list', 'GET', null, 10);
                if ($resp === null) {
                    $out[] = array('name' => $name, 'ok' => false, 'code' => 'network', 'detail' => '网络不可达或连接失败（检查端点是否可以访问）', 'http' => 0);
                    continue;
                }
                $code = (int) wp_remote_retrieve_response_code($resp);
                if ($code === 200) {
                    $out[] = array('name' => $name, 'ok' => true, 'code' => 'ok', 'detail' => '连通且 X-Auth-Key 通过', 'http' => $code);
                } elseif ($code === 401 || $code === 403) {
                    $out[] = array('name' => $name, 'ok' => false, 'code' => 'auth', 'detail' => 'X-Auth-Key 不对（HTTP ' . $code . '）', 'http' => $code);
                } else {
                    $out[] = array('name' => $name, 'ok' => false, 'code' => 'http_' . $code, 'detail' => 'HTTP ' . $code, 'http' => $code);
                }
            } else {
                $out[] = array('name' => $name, 'ok' => false, 'code' => 'unimplemented', 'detail' => '类型 ' . $type . ' 尚未实现', 'http' => 0);
            }
        }
        wp_send_json_success(array('ok' => true, 'results' => $out));
    }

    public function ajax_worker_status() {
        check_ajax_referer('cfse_worker_status');
        $post_id = isset($_POST['post_id']) ? (int) $_POST['post_id'] : 0;
        if (!$post_id || !current_user_can('edit_post', $post_id)) wp_send_json(array('ok' => false));
        $post = get_post($post_id);
        if (!$post) wp_send_json(array('ok' => false));
        $remote_id = $this->get_remote_wp_id($post_id);
        // WP 原生的篇在 D1 里的主键就是 WP 文章 ID —— 以前这里只查 remote_id，
        // 于是「刚推送过的原生文章」查不到版本，面板一直显示"CMS 上还没有这一篇"。
        $wid = $remote_id ? (int) $remote_id : (int) $post_id;
        $remote = $this->fetch_worker_post($wid);
        if (!$remote) wp_send_json(array('ok' => false));
        $worker_mod = isset($remote['modified']) ? (string) $remote['modified'] : '';
        $local_mod = (string) $post->post_modified;
        // 两端都是「站点本地时间」字符串，同一基准的相对比较是安全的
        $need = ($worker_mod !== '' && strtotime($worker_mod) > strtotime($local_mod));
        $local_newer = ($worker_mod !== '' && strtotime($local_mod) > strtotime($worker_mod));
        wp_send_json(array(
            'ok' => true,
            'remote_wp_id' => $wid,
            'worker_modified' => $worker_mod,
            'local_modified' => $local_mod,
            'need_sync' => $need,
            'local_newer' => $local_newer,
        ));
    }
    private function pull_posts_from_worker($overwrite = false) {
        return CFSE_Sync_Worker_CMS::get_instance()->pull_posts_from_worker($overwrite);
    }
    private function get_remote_wp_id($post_id) {
        return CFSE_Sync_Worker_CMS::get_instance()->get_remote_wp_id($post_id);
    }
    private function find_post_by_remote_id($remote_wp_id) {
        return CFSE_Sync_Worker_CMS::get_instance()->find_post_by_remote_id($remote_wp_id);
    }
    private function apply_worker_terms($post_id, $json, $taxonomy) {
        return CFSE_Sync_Worker_CMS::get_instance()->apply_worker_terms($post_id, $json, $taxonomy);
    }

    /** 设置页「📥 从 Worker 拉取文章」 */
    public function handle_pull_worker() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_pull_worker');
        @set_time_limit(0);
        @ignore_user_abort(true);
        $overwrite = !empty($_POST['cfse_pull_overwrite']);
        list($imported, $updated, $skipped, $errors, $total) = $this->pull_posts_from_worker($overwrite);
        $this->log('从 Worker 拉取完成（overwrite=' . ($overwrite ? '1' : '0') . "）：共 {$total} 篇，新增 {$imported}，对齐更新 {$updated}，跳过 {$skipped}，失败 {$errors}", 'INFO');
        wp_redirect(admin_url('options-general.php?page=cfse-sync&pulled=' . $imported . '&pull_updated=' . $updated . '&pull_skipped=' . $skipped . '&pull_total=' . $total));
        exit;
    }

    /** 单篇「☁️ 重新同步到 CMS」（文章编辑页侧边栏面板里的按钮，只对 WP 掌管的篇出现） */
    public function handle_manual_export() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_manual_export');
        $post_id = intval($_GET['post_id']);
        $state = 'fail';
        if ($post_id > 0) {
            $r = $this->run_sync_mode($post_id);
            if ($r === 'skipped') $state = 'skipped';
            elseif ($r === 'remote_newer') $state = 'remote_newer';
            elseif ($r) $state = 'ok';
        }
        wp_redirect(admin_url('post.php?post=' . $post_id . '&action=edit&cfse_resync=' . $state));
        exit;
    }

    public function handle_bulk_export() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_bulk_export');
        @set_time_limit(0);
        @ignore_user_abort(true);
        // 「强制重写全部」勾选框（默认不勾 = 跳过已同步且未变更的，见 prepare_sync_item）
        $force = !empty($_POST['cfse_force_all']);
        // 先确保 D1 表结构为 v2（旧结构自动重建），随后全量重导会重写结构化 categories/tags
        $this->ensure_d1_schema();
        $all = $this->collect_published_ids();

        $this->log('全量同步开始，共 ' . count($all) . ' 篇（只写 D1，单页由 Worker 渲染）' . ($force ? '，强制重写全部' : '，跳过未变更'), 'INFO');
        list($success, $total) = $this->sync_posts($all, $force);
        $this->log("全量同步完成：成功 {$success} / {$total}", 'INFO');
        update_option('cf_exported_count', $success);
        wp_redirect(admin_url('options-general.php?page=cfse-sync&exported=' . $success . '&total=' . $total));
        exit;
    }

    /**
     * 批量同步（串行）。每篇只发一次 D1 批量请求，不渲染、不上传，所以不需要并发。
     *
     * @param array $post_ids 文章 ID 列表
     * @return array [成功数, 总数]
     */
    private function sync_posts($post_ids, $force = false) {
        $post_ids = array_values(array_unique(array_map('intval', (array) $post_ids)));
        $post_ids = array_values(array_filter($post_ids, function ($id) { return $id > 0; }));
        $total = count($post_ids);
        if ($total === 0) return array(0, 0);
        @set_time_limit(0);
        @ignore_user_abort(true);

        $ok = 0;
        $skipped = 0;
        $failed = 0;
        $remote_new = 0;
        $buf = array();          // 待写条目
        $stmts = 0;              // 已累计语句数（/d1-batch 硬上限 50）
        $only_ids = array();     // 本批涉及的托管目标 id
        $del_buf = array();      // 攒起来的待删单页路径（path => true）
        $del_ids = array();      // 这些路径涉及的托管目标

        // 一次性取回 D1 侧所有相关篇的 modified（一条 IN 查询 = 一次往返）。
        // 逐篇查会多 300 次公网请求，把 1 秒的增量同步拖回几分钟。
        //
        // ⚠️ 键要转成**远端 wp_id**：D1 的主键是 CMS 端的时间戳 ID，
        //    而 $post_ids 是 WP 文章 ID。CMS 篇的映射在 meta 里，WP 原生篇就是它自己。
        //    （传错的话 map 全是空，所有篇都被当成「远端没这行」—— 测试里就是这么被抓出来的。）
        // 先做一次**纯本地**的快筛，只对「可能需要写」的篇查远端：
        // 增量场景 300 篇全被「已同步且未变更」挡掉时，这一步能省掉整体一次查询。
        $need_remote = array();
        foreach ($post_ids as $pid) {
            $p = get_post($pid);
            if (!$p || $p->post_type !== 'post' || !in_array($p->post_status, array('publish', 'draft'), true)) continue;
            if (!$force) {
                $synced = (int) get_post_meta($pid, '_cfse_synced_d1', true);
                if ($synced > 0 && (int) get_post_modified_time('U', true, $p) <= $synced) continue;
            }
            $r = (int) get_post_meta($pid, '_cfse_remote_wp_id', true);
            if (!$r) $r = (int) get_post_meta($pid, '_cfsh_remote_wp_id', true);
            $need_remote[$pid] = $r ?: (int) $pid;
        }
        $remote_mod = $need_remote
            ? CFSE_Sync_Worker_CMS::get_instance()->remote_modified_map(array_values($need_remote))
            : array();

        foreach ($post_ids as $id) {
            $item = $this->prepare_sync_item($id, $force, $remote_mod);
            if ($item === 'unchanged') { $skipped++; continue; }
            if ($item === 'remote_newer') { $remote_new++; continue; }
            if ($item === null) { $failed++; continue; }

            $buf[] = $item;
            $stmts += count($item['statements']);
            foreach ($item['only_ids'] as $sid) $only_ids[$sid] = true;

            if ($stmts >= self::BATCH_MAX_STMTS) {
                list($ok, $failed, $d) = $this->flush_sync_buffer($buf, array(), $ok, $failed);
                foreach ($d as $p) $del_buf[$p] = true;
                foreach ($only_ids as $sid => $t) $del_ids[$sid] = true;
                $buf = array(); $stmts = 0; $only_ids = array();
                // 攒够 4 条请求的量再删：606 个路径从 27 次请求降到 4 次
                if (count($del_buf) >= self::BATCH_MAX_PATHS) $this->flush_delete_buffer($del_buf, $del_ids);
            }
        }
        if ($buf) {
            list($ok, $failed, $d) = $this->flush_sync_buffer($buf, array(), $ok, $failed);
            foreach ($d as $p) $del_buf[$p] = true;
            foreach ($only_ids as $sid => $t) $del_ids[$sid] = true;
        }
        $this->flush_delete_buffer($del_buf, $del_ids);

        CFSE_Sync_Worker_CMS::get_instance()->flush_media_index();
        if ($ok > 0) update_option('cf_last_export_time', current_time('mysql'));
        if ($skipped > 0) $this->log("跳过未变更的文章 {$skipped} 篇（已同步且 post_modified 之后没再改）", 'INFO');
        if ($remote_new > 0) $this->log("跳过 {$remote_new} 篇：CMS 侧比本地更新，先在「拉取文章」里对齐再改（否则会用旧内容盖掉 CMS 的改动）", 'WARNING');
        if ($failed > 0) $this->log("同步失败 {$failed} 篇", 'ERROR');
        return array($ok, $total);
    }

    /** 把攒起来的单页路径一次删掉（/delete 支持 paths 数组，一次请求删多个） */
    private function flush_delete_buffer(&$buf, &$ids) {
        if (empty($buf)) return;
        $paths = array_keys($buf);
        $buf = array();
        $this->delete_from_r2($paths, $ids ? array_keys($ids) : null);
    }

    /**
     * 为单篇准备「待写入条目」：组装 SQL、判断要不要清单页、算内容 hash。
     *
     * @param int   $id
     * @param bool  $force       true = 忽略「已同步且未变更」，强制重写
     * @param array $remote_mod  `[wp_id => modified]`（D1 侧，站点本地时间）。
     *                           由调用方一次批量查好传进来 —— 逐篇查会多 300 次往返。
     * @return array|string|null 数组 = 待写；'unchanged' = 已同步且未变更；
     *                           'remote_newer' = CMS 侧更晚（跳过，先拉取）；null = 无法同步
     */
    private function prepare_sync_item($id, $force, $remote_mod = array()) {
        $post = get_post($id);
        if (!$post || $post->post_type !== 'post') return null;
        if (!in_array($post->post_status, array('publish', 'draft'), true)) return null;
        if (get_post_meta($id, '_cfse_probe', true) === '1') return null;

        // ① 已同步且文章在那之后没改过 → 整篇跳过（这是最大的一笔省：325 篇里 292 篇属此类）
        //    ⚠️ 必须用「GMT 时间戳」比，不能 strtotime(post_modified)：
        //    post_modified 存的是**站点本地时间**（本站 UTC+8），而 WP 的默认时区是 UTC，
        //    strtotime() 会把它当成 UTC ⇒ 比真实时间早 8 小时 ⇒ 最近 8 小时内改过的文章
        //    永远被判成「未来修改」，每轮都重写一遍（实测 13 篇反复重推就是这么来的）。
        $synced = (int) get_post_meta($id, '_cfse_synced_d1', true);
        if (!$force && $synced > 0 && (int) get_post_modified_time('U', true, $post) <= $synced) return 'unchanged';

        $meta = $this->build_post_meta($post);
        $pd = $meta['post_data'];
        $worker = CFSE_Sync_Worker_CMS::get_instance();

        /*
         * ② 谁更新谁生效（取代旧的「Worker 端诞生的篇一律不写」）
         *
         * 2026-10-27 改：产品定位是「WP 后台和 CMS 后台都能编辑」，一刀切按 ID 段
         * 拦死归属，等于宣布 WP 侧对那批文章只能看不能改 —— 而且点了没反应、日志还说成功。
         * 现在改成按时间戳判断：只有「CMS 侧更晚」才拒绝，因为那才是真正会丢改动的场景。
         *
         * ⚠️ 基准换算：D1 的 modified 是**站点本地时间**，post_modified 也是本地时间，
         * 但 get_post_modified_time('U', true) 返回的是 **GMT 时间戳** ⇒
         * 必须经 remote_modified_ts() 换算，否则整体差一个时区（本站 8 小时），
         * 「刚在 CMS 改过的篇」会被判成本地更新，反手把 CMS 的改动盖掉。
         */
        $wid = (int) $pd['wp_id'];
        $remote_mod = isset($remote_mod[$wid]) ? $remote_mod[$wid] : '';
        $local_ts = (int) get_post_modified_time('U', true, $post);
        $remote_ts = $worker->remote_modified_ts($remote_mod);
        if ($remote_ts > 0 && $remote_ts > $local_ts + 1) {   // +1s：同秒抖动不算远端更新
            $this->log("文章 {$id} 跳过：CMS 侧更晚（远端 {$remote_mod} / 本地 {$post->post_modified}），先拉取再改", 'WARNING');
            return 'remote_newer';
        }
        if ($wid >= (int) CFSE_WORKER_ID_MIN && $remote_ts === 0) {
            // 归 CMS 所有却查不到远端行（被删了）：可以写回去（等价于重建），记一笔便于排查
            $this->log("文章 {$id} 归 CMS 所有但 D1 里暂无该行，将整篇写入", 'INFO');
        }

        if ($post->post_status === 'draft') {
            $pd['status'] = 'draft';
            if (empty($pd['slug'])) $pd['slug'] = 'draft-' . $post->ID;
        }

        $sites = $this->get_post_sites($post->ID);
        if (empty($sites)) {
            $this->log("文章 {$id} 未指定站点且未设默认站点，跳过同步（内容只留在本地 WP）", 'WARNING');
            return null;
        }
        $only_ids = array();
        foreach ($sites as $st) $only_ids[] = (string) $st['id'];

        // ④ slug 归属检查（`posts.slug` 是 UNIQUE，而 upsert 只处理 wp_id 冲突）
        //    典型场景：这篇是「从 CMS 拉下来的同名副本」——它的 slug 已被 D1 里
        //    wp_id=1792… 那行占用，直接 INSERT 会撞 UNIQUE 让整批 500。
        $owner = $worker->slug_owner($pd['slug']);
        if ($owner && $owner !== (int) $pd['wp_id']) {
            if ($owner >= (int) CFSE_WORKER_ID_MIN) {
                $this->log("文章 {$id} 的 slug「{$pd['slug']}」已被 CMS 端同篇占用（wp_id={$owner}），跳过：内容已在 CMS", 'WARNING');
                // 记为已同步，免得它永远挂在「待同步」里每轮重试
                update_post_meta($id, '_cfse_synced_d1', time());
                return 'unchanged';
            }
            $this->log("文章 {$id} 的 slug「{$pd['slug']}」与 D1 中另一篇（wp_id={$owner}）冲突，跳过不覆盖", 'ERROR');
            return null;
        }

        // 分类/标签签名：没变就不重建关联。
        // D1 每条语句内部约 0.1s，一篇 4 条 → 1 条，全量语句数直接降到 1/4。
        $tax_sig = md5((string) wp_json_encode(array($meta['categories'], $meta['tags'])));
        $with_tax = ((string) get_post_meta($id, '_cfse_tax_sig', true) !== $tax_sig);
        $statements = $worker->build_write_statements($pd, $meta['categories'], $meta['tags'], $with_tax);

        // ③ 内容 hash：没变就不清 R2 单页。
        //    旧实现每篇都删单页 ⇒ 点一次全量同步 = 清空整站页面缓存，
        //    之后每个页面首访都要现场渲染（4 次 D1 + 模板渲染）。
        $hash = md5(implode("\x1f", array(
            (string) $pd['slug'], (string) $pd['title'], (string) $pd['content'],
            (string) $pd['excerpt'], (string) $pd['status'],
            (string) $pd['categories'], (string) $pd['tags'], (string) $pd['featured_image'],
        )));
        $prev = (string) get_post_meta($id, '_cfse_hash', true);
        $delete_paths = array();
        if ($prev !== $hash) {
            $path = $this->get_post_storage_path($post);
            if ($path !== '') {
                $delete_paths[] = $path;
                $delete_paths[] = $path . '.gz';
            }
        }

        return array(
            'id' => $id,
            'post_data' => $pd,
            'categories' => $meta['categories'],
            'tags' => $meta['tags'],
            'only_ids' => $only_ids,
            'statements' => $statements,
            'delete_paths' => $delete_paths,
            'hash' => $hash,
            'tax_sig' => $tax_sig,
            'content' => $post->post_content,
        );
    }

    /**
     * 冲刷一个批次：一次 /d1-batch 写完 → 记账 → 一次 /delete 清掉失效单页。
     * 整批失败时回退为逐篇写入（幂等 upsert，重放无副作用）。
     */
    private function flush_sync_buffer($items, $only_ids, $ok, $failed) {
        if (empty($items)) return array($ok, $failed, array());
        $worker = CFSE_Sync_Worker_CMS::get_instance();
        $ok_ids = array();
        $this->write_items_resilient($items, $ok_ids);

        $del = array();
        foreach ($items as $it) {
            if (isset($ok_ids[$it['id']])) {
                $ok++;
                update_post_meta($it['id'], '_cfse_synced_d1', time());
                update_post_meta($it['id'], '_cfse_hash', $it['hash']);
                update_post_meta($it['id'], '_cfse_tax_sig', $it['tax_sig']);
                delete_post_meta($it['id'], '_cf_exported');
                $worker->note_slug($it['post_data']['slug'], $it['post_data']['wp_id']);
                $this->sync_media_files($it['content']);
                foreach ($it['delete_paths'] as $p) $del[] = $p;
            } else {
                $failed++;
            }
        }
        $this->log('批量写入 ' . count($items) . ' 篇（单批 ' . array_sum(array_map(function ($x) { return count($x['statements']); }, $items)) . ' 条 SQL）', 'DEBUG');
        // 单页失效路径交给调用方攒批（见 sync_posts），别每批都发一次 /delete
        return array($ok, $failed, $del);
    }

    /**
     * 批量写入 + 失败二分定位。
     *
     * 一条坏语句会让整批 /d1-batch 500。如果这时逐篇重试 12 篇，最坏 12 × 3 次 × 2 请求
     * ≈ 一分钟；二分则只要 log2(12) ≈ 4 次就能定位到那一篇，剩下的一次性写完。
     * 真正的单篇（切到只剩 1 篇）才走带降级/重试的 write_to_d1 ——
     * 那条路径保留「Worker 不可达则直连 D1 API」的兜底。
     */
    private function write_items_resilient($items, &$ok_ids) {
        if (empty($items)) return;

        if (count($items) === 1) {
            $it = $items[0];
            if ($this->write_to_d1_with_retry($it['post_data'], $it['categories'], $it['tags'], $it['only_ids'])) {
                $ok_ids[$it['id']] = true;
            }
            return;
        }

        $worker = CFSE_Sync_Worker_CMS::get_instance();
        if ($worker->write_batch($items)) {
            foreach ($items as $it) $ok_ids[$it['id']] = true;
            return;
        }

        $half = (int) floor(count($items) / 2);
        $this->log('批量写入失败，二分排查（' . count($items) . ' 篇 → ' . $half . ' + ' . (count($items) - $half) . '）', 'WARNING');
        $this->write_items_resilient(array_slice($items, 0, $half), $ok_ids);
        $this->write_items_resilient(array_slice($items, $half), $ok_ids);
    }

    /** 逐篇写入 + 重试（批量失败后的兜底路径） */
    private function write_to_d1_with_retry($post_data, $categories, $tags, $only_ids = null) {
        $tries = max(1, (int) $this->config['max_retries']);
        for ($i = 0; $i < $tries; $i++) {
            $res = $this->write_to_d1($post_data, $categories, $tags, $only_ids);
            if ($res === 'skipped' || $res) return true;
            usleep(300000);
        }
        return false;
    }

    /**
     * 设置页「👤 Worker 后台账号」：把管理员写入 D1 users（PBKDF2-SHA256 密码哈希）
     */
    public function handle_seed_admin() {
        if (!current_user_can('manage_options')) wp_die('权限不足');
        check_admin_referer('cf_seed_admin');
        $login = isset($_POST['cf_admin_username']) ? sanitize_user(wp_unslash($_POST['cf_admin_username']), true) : '';
        $pass = isset($_POST['cf_admin_password']) ? (string) wp_unslash($_POST['cf_admin_password']) : '';
        $email = isset($_POST['cf_admin_email']) ? sanitize_email(wp_unslash($_POST['cf_admin_email'])) : '';
        if ($login === '' || strlen($pass) < 8) {
            wp_redirect(add_query_arg(array('seeded' => '0'), admin_url('options-general.php?page=cfse-sync')));
            exit;
        }
        $this->ensure_d1_schema();
        $iter = 100000;
        $salt = random_bytes(16);
        // hash_pbkdf2 的 length 参数为返回 hex 长度：传 64 得到 32 字节派生（64 hex），与 Worker 端 256bit 派生一致
        $hash = hash_pbkdf2('sha256', $pass, $salt, $iter, 64);
        $store = 'pbkdf2_sha256$' . $iter . '$' . bin2hex($salt) . '$' . $hash;
        $display = $login;
        $existing = get_user_by('login', $login);
        if ($existing) $display = $existing->display_name ? $existing->display_name : $existing->user_login;
        $this->d1_batch(array(array(
            'sql' => "INSERT INTO users (user_login, user_pass, user_nicename, user_email, display_name, role, user_status)
                      VALUES (?, ?, ?, ?, ?, 'admin', 1)
                      ON CONFLICT(user_login) DO UPDATE SET user_pass = excluded.user_pass, user_email = excluded.user_email, display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP",
            'params' => array($login, $store, $login, $email, $display),
        )));
        $this->log('Worker 后台用户已写入: ' . $login, 'INFO');
        wp_redirect(add_query_arg(array('seeded' => '1'), admin_url('options-general.php?page=cfse-sync')));
        exit;
    }

}

// ============================================
// 初始化
//
// 用 try/catch 包一层：PHP 7+ 的 Error（Class not found / TypeError /
// 访问未声明属性等）都是可捕获的 Throwable。捕获后转成后台可见的红条提示 +
// error_log，而不是让 WordPress 只回一句
// 「Plugin could not be activated because it triggered a fatal error.」。
// （语法错误 / require 文件缺失属于编译期问题，捕不到，那种仍需看 debug.log。）
// ============================================
try {
    CFSE_Sync_Plugin::get_instance();
} catch (\Throwable $e) {
    $cfse_boot_error = $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine();
    @error_log('[CF Press Sync] 启动失败: ' . $cfse_boot_error);
    if (function_exists('add_action')) {
        add_action('admin_notices', function () use ($cfse_boot_error) {
            echo '<div class="notice notice-error"><p><strong>CF Press Sync 启动失败</strong>：'
                . esc_html($cfse_boot_error) . '</p>'
                . '<p>请把这段信息（以及 <code>wp-content/debug.log</code> 里的对应记录）一并反馈。</p></div>';
        });
    }
}