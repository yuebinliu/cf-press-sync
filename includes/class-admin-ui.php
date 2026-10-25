<?php
/**
 * CFSE_Sync_Admin_UI -- 后台设置页 / 文章面板 / 托管目标表格。
 *
 * 拆分纪律「只搬不改」：方法体逐字节照搬（含缩进）。
 * 唯一改动：private function -> public function（原为类内自调用，现由主类同名转发方法调用）。
 *
 * @package CFSE
 */

if (!defined('ABSPATH')) {
    exit;
}

if (class_exists('CFSE_Sync_Admin_UI')) {
    return;
}

class CFSE_Sync_Admin_UI {

    private static $instance = null;

    /** 与原主类同名常量（原类内写作 self::META_SITE，拆出后需要本类自带） */
    const META_SITE = 'cfse_site';

    /** 与原主类同名属性：PHP 8.2+ 不允许动态属性，显式声明 */
    private $reported_dir_failure = false;

    /** 托管目标配置弹窗的 HTML 片段（原主类属性；本类内读写，见 render_hosting_target_row/table） */
    private $target_modals = array();

    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
    }

    /** 桥接：$this->config -> 主类配置 */
    public function __get($name) {
        $p = CFSE_Sync_Plugin::get_instance();
        if ($name === 'config') {
            return $p->get_config();
        }
        // 其余属性：反射读主类（public/private 都能读），避免拆出去的新类「看不见」主类状态
        if (property_exists($p, $name)) {
            $r = new ReflectionProperty($p, $name);
            $r->setAccessible(true);
            return $r->getValue($p);
        }
        return null;
    }

    /**
     * 桥接：新类里调用未搬来的方法时转发
     *  1) 先查 CFSE_Sync_Transports（托管目标/传输相关已在那里）
     *  2) 再回主类（cfse_proxy 可访问 private）
     */
    public function __call($name, $args) {
        if (class_exists('CFSE_Sync_Transports')) {
            $t = CFSE_Sync_Transports::get_instance();
            if (method_exists($t, $name)) {
                return call_user_func_array(array($t, $name), $args);
            }
        }
        return CFSE_Sync_Plugin::get_instance()->cfse_proxy($name, $args);
    }

    /** 桥接：日志转发主类 */
    public function log($message, $level = 'INFO') {
        return CFSE_Sync_Plugin::get_instance()->log($message, $level);
    }


    // ============================================
    // 设置页面
    // ============================================
    public function settings_page() {
        wp_enqueue_media();   // 「选择 / 上传」按钮用 WP 媒体库
        $stats = $this->get_export_stats();
        ?>
        <div class="wrap cfse-settings">
            <h1>🔗 CFSE Sync <span class="version">v<?php echo esc_html(CFSE_VERSION); ?></span></h1>

            <?php if (isset($_GET['exported']) && isset($_GET['total'])): ?>
                <div class="notice notice-success is-dismissible">
                    <p>✅ 全量同步完成！成功 <strong><?php echo intval($_GET['exported']); ?></strong> / <?php echo intval($_GET['total']); ?> 篇文章</p>
                </div>
            <?php endif; ?>
            <?php if (isset($_GET['deployed']) && $_GET['deployed']): ?>
                <div class="notice notice-success is-dismissible"><p>✅ Worker 部署成功！</p></div>
            <?php endif; ?>

            <?php CFSE_Sync_Onboarding::get_instance()->render_current_screen(); ?>

            <form method="post" action="options.php" id="cfse-options">
                <div class="cfse-grid">
                    <div class="cfse-col cfse-col-main">

                        <!-- ① 连接 CMS -->
                        <div class="cfse-card">
                            <h2>📡 连接 CMS</h2>
                            <?php $this->render_connection_form(); ?>
                        </div>

                        <!-- ② 同步设置 -->
                        <div class="cfse-card">
                            <h2>🔄 同步设置</h2>
                            <?php settings_fields('cf_static_export_pro'); ?>

                            <div class="cfse-sec">
                                <h4>自动</h4>
                                <label class="cfse-check"><input type="checkbox" form="cfse-options" name="cf_sync_d1" value="1" <?php checked(!empty($this->config['sync_d1'])); ?> /> 发布文章时同步到 CMS</label>
                                <label class="cfse-check"><input type="checkbox" form="cfse-options" name="cf_worker_auto_check" value="1" <?php checked(!empty($this->config['worker_auto_check'])); ?> /> 编辑页自动比对 CMS 版本</label>
                                <label class="cfse-check"><input type="checkbox" form="cfse-options" name="cf_comments_sync" value="1" <?php checked(!empty($this->config['comments_sync'])); ?> /> WP 评论同步到 CMS</label>
                                <label class="cfse-check"><input type="checkbox" form="cfse-options" name="cf_comments_pull_cron" value="1" <?php checked(!empty($this->config['comments_pull_cron'])); ?> /> 每小时从 CMS 拉取评论</label>
                            </div>

                            <div class="cfse-sec">
                                <h4>同步参数</h4>
                                <div class="cfse-inline">
                                    <label>定时每批 <input type="number" id="cf_batch_size" name="cf_batch_size" value="<?php echo esc_attr($this->config['batch_size']); ?>" class="small-text" min="1" /> 篇</label>
                                    <label>失败重试 <input type="number" id="cf_max_retries" name="cf_max_retries" value="<?php echo esc_attr($this->config['max_retries']); ?>" class="small-text" min="1" /> 次</label>
                                    <label class="cfse-check"><input type="checkbox" name="cf_enable_logging" value="1" <?php checked($this->config['enable_logging']); ?> /> 记录日志</label>
                                </div>
                                <p class="description">「定时每批」只影响每日定时任务，手动同步不受此限。</p>
                            </div>

                            <div class="cfse-sec">
                                <h4>手动操作</h4>
                                <div class="cfse-ops">
                                    <div class="cfse-op">
                                        <span class="cfse-op-label">文章</span>
                                        <button type="submit" form="cfse-act-bulk" class="button button-primary" onclick="return confirm('把全部已发布文章同步到 CMS？确认继续。')">同步文章到 CMS</button>
                                        <button type="submit" form="cfse-pull-form" class="button" onclick="return confirm('从 CMS 拉取「CMS 端诞生」的文章到 WordPress？确认继续。')">拉取文章</button>
                                        <label class="cfse-check cfse-op-note"><input type="checkbox" name="cfse_pull_overwrite" value="1" form="cfse-pull-form" /> 拉取时覆盖已有文章</label>
                                    </div>
                                    <div class="cfse-op">
                                        <span class="cfse-op-label">评论</span>
                                        <a class="button" href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=cfse_sync_comments'), 'cfse_sync_comments')); ?>">同步评论到 CMS</a>
                                        <a class="button" href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=cfse_pull_comments'), 'cfse_pull_comments')); ?>">拉取评论</a>
                                    </div>
                                    <div class="cfse-op">
                                        <span class="cfse-op-label">站点</span>
                                        <button type="submit" form="cfse-act-siteinfo" class="button">同步站点信息到 CMS</button>
                                    </div>
                                    <div class="cfse-op">
                                        <span class="cfse-op-label">其它</span>
                                        <button type="submit" form="cfse-act-clear" class="button" onclick="return confirm('重置同步标记？只清 WP 侧记账，不碰 CMS 数据与缓存。')">重置同步标记</button>
                                    </div>
                                </div>
                                <p class="description">「同步站点信息」只写 4 项：<b>站点名 / 描述 / 时区 / 默认作者</b>。菜单、布局、logo、横幅、社交、评论、URL 结构都不会动。</p>
                                <?php if (isset($_GET['site_info_synced'])): ?>
                                    <?php if ($_GET['site_info_synced'] === '1'): ?>
                                        <div class="notice notice-success is-dismissible" style="margin:10px 0 0;"><p>✅ 已合并写入（菜单 / 布局 / URL 结构未改动）。</p></div>
                                    <?php else: ?>
                                        <div class="notice notice-error is-dismissible" style="margin:10px 0 0;"><p>❌ 同步失败：没有可用的「D1 数据」目标，或请求被拒（详见日志）。</p></div>
                                    <?php endif; ?>
                                <?php endif; ?>
                            </div>
                        </div>

                        <!-- ③ 高级设置 -->
                        <div class="cfse-card">
                            <h2>🔧 高级设置</h2>

                            <details class="cfse-adv">
                                <summary>🔑 密码重置（CMS 后台账号）</summary>
                                <p class="description">写入 CMS 的 D1 <code>users</code> 表，密码不落 WordPress。忘了后台密码时用它重置。</p>
                                <?php $seed_admin = get_users(array('role' => 'administrator', 'number' => 1)); $seed_u = !empty($seed_admin) ? $seed_admin[0] : null; ?>
                                <div class="cfse-fields">
                                    <label>用户名 <input type="text" form="cfse-act-seed" name="cf_admin_username" value="<?php echo esc_attr($seed_u ? $seed_u->user_login : 'admin'); ?>" /></label>
                                    <label>新密码 <input type="password" form="cfse-act-seed" name="cf_admin_password" autocomplete="new-password" required /></label>
                                    <label>邮箱 <input type="email" form="cfse-act-seed" name="cf_admin_email" value="<?php echo esc_attr($seed_u ? $seed_u->user_email : ''); ?>" /></label>
                                </div>
                                <div class="cfse-actions">
                                    <button type="submit" form="cfse-act-seed" class="button">写入 / 重置密码</button>
                                </div>
                                <?php if (isset($_GET['seeded']) && $_GET['seeded'] === '1'): ?>
                                    <div class="notice notice-success is-dismissible" style="margin:8px 0 0;"><p>✅ 已写入。</p></div>
                                <?php elseif (isset($_GET['seeded']) && $_GET['seeded'] === '0'): ?>
                                    <div class="notice notice-error is-dismissible" style="margin:8px 0 0;"><p>❌ 失败：用户名无效或密码少于 8 位。</p></div>
                                <?php endif; ?>
                            </details>

                            <details class="cfse-adv"<?php echo (isset($_GET['cfse_expand']) && $_GET['cfse_expand'] === 'deploy') ? ' open' : ''; ?>>
                                <summary>🚀 部署 / 升级 CMS</summary>
                                <?php
                                $rel_ver = (string) get_option('cf_cms_release_version', '');
                                $rel_src = (string) get_option('cf_cms_release_source', '');
                                $rel_src_info = CFSE_Sync_Release::get_instance()->resolve_source_dir();
                                ?>
                                <p class="description">
                                    <?php if (!empty($rel_src_info['ready'])): ?>
                                        ✅ 发行包 <strong><?php echo esc_html($rel_ver !== '' ? $rel_ver : '已下载'); ?></strong>
                                        <?php if ($rel_src !== ''): ?><span style="color:#999;">（来自 <?php echo esc_html($rel_src); ?>）</span><?php endif; ?>
                                    <?php else: ?>
                                        ⚠️ 还没下载发行包
                                    <?php endif; ?>
                                </p>
                                <div class="cfse-actions">
                                    <button type="submit" form="cfse-act-download" class="button">⬇️ 下载发行包</button>
                                    <button type="submit" form="cfse-act-deploy" class="button button-primary" onclick="return confirm('把 CMS 发行包部署到 Cloudflare？需本机已登录 wrangler。')">🚀 部署到 Cloudflare</button>
                                </div>
                                <?php if (isset($_GET['release_dl'])): ?>
                                    <?php if ($_GET['release_dl'] === '1'): ?>
                                        <div class="notice notice-success is-dismissible" style="margin:8px 0;"><p>✅ 已下载并解压。</p></div>
                                    <?php else: ?>
                                        <div class="notice notice-error is-dismissible" style="margin:8px 0;">
                                            <p>❌ 下载失败<?php if (!empty($_GET['release_error'])): ?>：<?php echo esc_html(wp_unslash($_GET['release_error'])); ?><?php endif; ?></p>
                                        </div>
                                    <?php endif; ?>
                                <?php endif; ?>
                                <table class="form-table cfse-table">
                                    <tr><th><label for="cf_cms_github_repo">GitHub 仓库</label></th>
                                        <td><input type="text" id="cf_cms_github_repo" name="cf_cms_github_repo" value="<?php echo esc_attr(get_option('cf_cms_github_repo', CFSE_Sync_Release::DEFAULT_GITHUB_REPO)); ?>" style="width:100%;max-width:320px;" placeholder="owner/repo" />
                                            <p class="description">首选下载源（Releases 最新版）</p></td></tr>
                                    <tr><th><label for="cf_cms_package_url">官网地址</label></th>
                                        <td><input type="url" id="cf_cms_package_url" name="cf_cms_package_url" value="<?php echo esc_attr(get_option('cf_cms_package_url', CFSE_Sync_Release::DEFAULT_SITE_URL)); ?>" style="width:100%;max-width:320px;" />
                                            <p class="description">备选下载源</p></td></tr>
                                </table>
                            </details>
                        </div>

                        <div class="cfse-savebar">
                            <button type="submit" class="button button-primary button-hero">保存设置</button>
                        </div>
                    </div><!-- /.cfse-col-main -->

                    <aside class="cfse-col cfse-col-side">
                        <div class="cfse-card">
                            <h2>📊 状态面板</h2>
                            <div class="cfse-stats">
                                <div class="stat-item"><span class="stat-label">总文章</span><span class="stat-value"><?php echo esc_html($stats['total_posts']); ?></span></div>
                                <div class="stat-item"><span class="stat-label">已同步</span><span class="stat-value"><?php echo esc_html($stats['exported_posts']); ?></span></div>
                                <div class="stat-item"><span class="stat-label">待同步</span><span class="stat-value"><?php echo esc_html($stats['pending_posts']); ?></span></div>
                                <div class="stat-item"><span class="stat-label">最后同步</span><span class="stat-value"><?php echo esc_html($stats['last_export']); ?></span></div>
                            </div>
                            <div class="cfse-progress">
                                <div class="progress-bar" style="width: <?php echo esc_attr($stats['progress']); ?>%;"><?php echo esc_html(round($stats['progress'], 1)); ?>%</div>
                            </div>
                        </div>

                        <div class="cfse-card">
                            <h2>📋 最近日志</h2>
                            <pre class="cfse-log"><?php echo esc_html($this->get_recent_logs(10)); ?></pre>
                        </div>
                    </aside>
                </div><!-- /.cfse-grid -->
            </form>
        </div><!-- /.wrap.cfse-settings -->

<?php
/*
 * 操作类表单集中放在这里 —— 必须在主表单 #cfse-options 之外。
 *
 * 为什么：HTML5 不允许 form 嵌套。浏览器解析到内层 <form> 起始标签会**丢弃**它，
 * 但内层的 </form> 结束标签会把**外层主表单关掉** —— 结果主表单从第一个操作按钮处
 * 就断了，后面「基础配置」里的 cf_batch_size 等字段全部落在表单外，点「保存配置」
 * 一个字段都存不进去（实测：9 个字段丢失）。所以内层一律不用 form，改用
 * <button form="id"> 关联到这里的独立表单。改这里时别把它们挪回网格里。
 */
?>
<div id="cfse-action-forms" style="display:none;">
    <form id="cfse-act-bulk" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_bulk_export')); ?>">
        <?php wp_nonce_field('cf_bulk_export'); ?>
    </form>
    <form id="cfse-pull-form" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_pull_worker')); ?>">
        <?php wp_nonce_field('cf_pull_worker'); ?>
    </form>
    <form id="cfse-act-clear" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_clear_cache')); ?>">
        <?php wp_nonce_field('cf_clear_cache'); ?>
    </form>
    <form id="cfse-act-siteinfo" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_sync_site_info')); ?>">
        <?php wp_nonce_field('cf_sync_site_info'); ?>
    </form>
    <form id="cfse-act-seed" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_seed_admin')); ?>">
        <?php wp_nonce_field('cf_seed_admin'); ?>
    </form>
    <form id="cfse-act-download" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_download_release')); ?>">
        <?php wp_nonce_field('cf_download_release'); ?>
    </form>
    <form id="cfse-act-deploy" method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_deploy_worker')); ?>">
        <?php wp_nonce_field('cf_deploy_worker'); ?>
    </form>
</div>

<style>
        /* ── 布局：左设置 / 右状态窗 ───────────────────────────── */
        .cfse-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); gap: 20px; align-items: start; margin-top: 16px; }
        .cfse-grid > .cfse-col { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
        .cfse-grid .cfse-card code, .cfse-grid .stat-value { overflow-wrap: anywhere; word-break: break-word; }

        /* 卡片：去阴影、留细边框，减少视觉噪音 */
        .cfse-card { background: #fff; border: 1px solid #e2e4e7; border-radius: 8px; padding: 18px 20px; box-shadow: none; }
        .cfse-card > h2 { margin: 0 0 12px; padding-bottom: 10px; border-bottom: 1px solid #f0f0f1; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
        .cfse-side .cfse-card > h2 { font-size: 14px; }

        /* 卡片内的分组 */
        .cfse-sec + .cfse-sec { margin-top: 14px; padding-top: 14px; border-top: 1px dashed #f0f0f1; }
        .cfse-sec > h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #787c82; text-transform: none; letter-spacing: .02em; }

        /* 复选行：整行可点，行距一致 */
        .cfse-check { display: block; margin: 0 0 6px; font-size: 13px; line-height: 1.7; }
        .cfse-check:last-child { margin-bottom: 0; }
        .cfse-check input { margin-right: 6px; }

        .cfse-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0; }
        .cfse-sec > .cfse-actions { margin-top: 2px; }
        .cfse-actions .button { margin: 0; }
        .cfse-fields { display: flex; flex-wrap: wrap; gap: 10px 14px; margin: 10px 0; font-size: 13px; }
        .cfse-fields label { display: flex; align-items: center; gap: 6px; margin: 0; }

        /* 同步参数：一行内联，别做成表格 */
        .cfse-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; font-size: 13px; }
        .cfse-inline > label { display: flex; align-items: center; gap: 6px; margin: 0; }

        /* 手动操作：每行 = 分类标签 + 按钮组 */
        .cfse-ops { display: flex; flex-direction: column; gap: 8px; margin: 2px 0 10px; }
        .cfse-op { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .cfse-op-label { flex: 0 0 32px; font-size: 12px; color: #646970; }
        .cfse-op .button { margin: 0; }
        .cfse-op-note { margin: 0 0 0 2px; font-size: 12px; color: #646970; }

        /* 参数表：紧凑，去掉 WP 默认的大行高 */
        .cfse-table { margin: 0; }
        .cfse-table tr > th { width: 120px; padding: 8px 10px 8px 0; font-weight: 500; font-size: 13px; color: #1d2327; }
        .cfse-table tr > td { padding: 8px 0; font-size: 13px; }
        .cfse-table .description { margin: 4px 0 0; font-size: 12px; }

        /* 状态窗 */
        .cfse-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .stat-item { background: #f6f7f7; border-radius: 6px; padding: 12px 10px; text-align: center; }
        .stat-label { display: block; color: #646970; font-size: 11px; }
        .stat-value { display: block; font-size: 20px; font-weight: 600; margin-top: 4px; }
        .cfse-progress { margin: 12px 0 0; height: 8px; background: #f0f0f1; border-radius: 99px; overflow: hidden; }
        .cfse-progress .progress-bar { height: 100%; background: #00a32a; border-radius: 99px; font-size: 0; padding: 0; }

        .cfse-log { margin: 0; background: #f6f7f7; border-radius: 6px; padding: 12px; max-height: 260px; overflow: auto; font-size: 11.5px; line-height: 1.65; color: #3c434a; white-space: pre-wrap; word-break: break-word; }

        .cfse-savebar { display: flex; justify-content: flex-end; }

        .cfse-adv { margin: 0; border: 1px solid #e2e4e7; border-radius: 6px; background: #fafafa; }
        .cfse-adv + .cfse-adv { margin-top: 10px; }
        .cfse-adv > summary { cursor: pointer; padding: 10px 14px; font-size: 13px; font-weight: 500; list-style: none; }
        .cfse-adv > summary::-webkit-details-marker { display: none; }
        .cfse-adv > summary::before { content: '▸'; display: inline-block; width: 16px; color: #787c82; transition: transform .15s; }
        .cfse-adv[open] > summary::before { transform: rotate(90deg); }
        .cfse-adv[open] > summary { border-bottom: 1px solid #e2e4e7; }
        .cfse-adv > *:not(summary) { margin-left: 14px; margin-right: 14px; }
        .cfse-adv > *:not(summary):first-of-type { margin-top: 12px; }
        .cfse-adv > *:not(summary):last-child { margin-bottom: 14px; }

        .version { font-size: 13px; color: #646970; font-weight: normal; }

        @media (max-width: 1100px) { .cfse-grid { grid-template-columns: 1fr; } }
        </style>
        <script>
        // 测试连接（状态机第二屏 + 连接卡片共用）
        (function () {
            function bind(btnId, outId) {
                var btn = document.getElementById(btnId);
                var out = document.getElementById(outId);
                if (!btn || !out) return;
                btn.addEventListener('click', function () {
                    out.textContent = '测试中…';
                    out.style.color = '';
                    // 表单里的值优先（还没保存时也能测）
                    var ep = document.getElementById('cfse_conn_endpoint');
                    var key = document.getElementById('cfse_conn_auth_key');
                    jQuery.post(ajaxurl, {
                        action: 'cfse_test_connection',
                        _ajax_nonce: '<?php echo esc_js(wp_create_nonce('cfse_test_connection')); ?>',
                        endpoint: ep ? ep.value : '',
                        auth_key: key ? key.value : ''
                    }, function (r) {
                        if (r && r.success) {
                            var extra = r.data && r.data.siteName ? ('（' + r.data.siteName + '）') : '';
                            out.textContent = '✓ 连接成功' + extra;
                            out.style.color = '#00a32a';
                            // 时区不一致：单独一行标黄，否则用户只会看到「连接成功」而忽略
                            if (r.data && r.data.tzWarning) {
                                out.textContent += '　' + r.data.tzWarning;
                                out.style.color = '#996800';
                            }
                        } else {
                            out.textContent = '✗ ' + ((r && r.data && r.data.error) ? r.data.error : '测试失败');
                            out.style.color = '#d63638';
                        }
                    }).fail(function () { out.textContent = '✗ 请求失败'; out.style.color = '#d63638'; });
                });
            }
            bind('cfse-test-conn', 'cfse-test-conn-result');
            bind('cfse-test-conn-2', 'cfse-test-conn-result-2');
        })();
        </script>
        <?php
    }


    public function enqueue_admin_assets() {
        wp_enqueue_style('cfse-admin', CFSE_PLUGIN_URL . 'assets/admin.css', array(), CFSE_VERSION);
        // 三屏状态机的样式（折叠块 / hero 卡片 / 连接表）
        wp_enqueue_style('cfse-onboarding', CFSE_PLUGIN_URL . 'assets/cfse-onboarding.css', array('cfse-admin'), CFSE_VERSION);
        // 页面里的内联脚本直接用 WP 的全局 ajaxurl + 服务端生成的 nonce，不需要额外的 admin.js
        wp_enqueue_script('jquery');
    }


    public function register_settings() {
        $fields = array(
            'cf_account_id' => array('sanitize' => 'sanitize_text_field'),
            'cf_api_token' => array('sanitize' => 'sanitize_text_field'),
            'cf_r2_bucket' => array('sanitize' => 'sanitize_text_field'),
            'cf_d1_database' => array('sanitize' => 'sanitize_text_field'),
            'cf_site_url' => array('sanitize' => 'esc_url_raw'),
            'cf_batch_size' => array('sanitize' => 'intval', 'default' => 50),
            'cf_max_retries' => array('sanitize' => 'intval', 'default' => 3),
            'cf_enable_logging' => array('sanitize' => 'boolval', 'default' => true),
            // cf_debug_mode 已移除（2026-10-26）：CMS 懒生成、不落 HTML，调试落盘无意义。
            'cf_auth_key' => array('sanitize' => 'sanitize_text_field', 'default' => ''),
            // 列表每页文章数已在 2026-10-26 移除：该 option 只被设置页自己的输入框读过，
            // 前台列表分页由 CMS 后台（D1 settings k='cache'.per_page）控制，WP 侧这个值不产生任何效果。
            // 保留 uninstall.php 里的清理项，只是为了让老用户卸载时能把这个孤儿 option 清掉。
            'cf_worker_auto_check' => array('sanitize' => 'boolval', 'default' => true),
            'cf_sync_d1' => array('sanitize' => 'boolval', 'default' => 0),
            // 多托管目标（JSON 字符串；sanitize 负责把表单数组转成 JSON）
            'cf_hosting_targets' => array('sanitize' => array($this, 'sanitize_hosting_targets'), 'default' => ''),
            // 评论：off=隐藏评论区 / embed=注入第三方片段（Disqus·giscus·Utterances…）/ native=用骨架+自有数据（B 阶段）
            'cf_comments_mode' => array('sanitize' => 'sanitize_text_field', 'default' => 'off'),
            'cf_comments_embed' => array('sanitize' => array($this, 'sanitize_embed_code'), 'default' => ''),
            'cf_comments_sync' => array('sanitize' => 'boolval', 'default' => 1),
            // 是否接受站外（静态站前台）提交的评论：off=拒收（默认）| pending=收下待审 | auto=直接通过
            'cf_comments_accept' => array('sanitize' => 'sanitize_text_field', 'default' => 'off'),
            // 定时把 Worker 端评论拉回 WP（默认开；否则 WP 后台看不到读者评论）
            'cf_comments_pull_cron' => array('sanitize' => 'boolval', 'default' => 1),
            // CMS 发行包的下载源（方案 B 双源）
            //   cf_cms_package_url —— 官网地址（CMS 官方把 tar.gz 挂在自己站上）
            //   cf_cms_github_repo —— GitHub 仓库 owner/name，用于查 Releases 的最新资产
            'cf_cms_package_url' => array('sanitize' => 'esc_url_raw', 'default' => CFSE_Sync_Release::DEFAULT_SITE_URL),
            'cf_cms_github_repo' => array('sanitize' => 'sanitize_text_field', 'default' => CFSE_Sync_Release::DEFAULT_GITHUB_REPO),
            'cf_banner_url' => array('sanitize' => 'esc_url_raw', 'default' => ''),
            'cf_logo_url'   => array('sanitize' => 'esc_url_raw', 'default' => ''),
        );
        foreach ($fields as $key => $args) {
            // WP 的 register_setting() 第三个参数认的是 sanitize_callback —— 此前误写成 'sanitize'
            // （未知键被忽略），导致所有 cf_* 的 sanitize 从未生效：cf_hosting_targets 的表单数组
            // 被直接 maybe_serialize() 存成 PHP 序列化，而读取端只认 JSON 字符串 ⇒ 解析为空 ⇒
            // 目标列表退回兜底默认值（表现为「保存后消失」）。
            if (isset($args['sanitize'])) {
                $args['sanitize_callback'] = $args['sanitize'];
                unset($args['sanitize']);
            }
            register_setting('cf_static_export_pro', $key, $args);
        }
        // ⚠️ 2026-09 定稿：WP 侧**不再自动写 D1**。
        // 历史坑：旧实现用整行覆盖写 settings 的 site 行 ⇒ 抹掉过 CMS 后台独有配置
        //   （导航菜单 / 单页布局 / 文档库映射），也覆盖过 cache 行（列表每页数 / 批量任务参数）。
        // 现在：站点基础信息只在设置页点「🔄 同步站点设置到 D1」时**合并写入**；
        //       缓存策略（TTL / feed 条数 / 发布后清缓存）完全由 CMS 后台维护，WP 侧不再读写。
    }


    public function add_admin_menu() {
        $hook = add_options_page(
            'CFSE Sync',
            'CFSE 同步',
            'manage_options',
            'cfse-sync',
            array($this, 'settings_page')
        );
        add_action("load-{$hook}", array($this, 'enqueue_admin_assets'));
    }


    /** 单行（字段名 cf_hosting_targets[N][xxx]，与 sanitize 对应） */
    public function render_hosting_target_row($i, $t, $warns = array()) {
        $templates = $this->get_hosting_templates();
        $tplId = isset($t['template']) ? $t['template'] : (isset($t['type']) ? $t['type'] : 'cloudflare');
        if (!isset($templates[$tplId])) $tplId = 'cloudflare';
        $tpl = $templates[$tplId];
        $caps = isset($t['capabilities']) && is_array($t['capabilities']) ? $t['capabilities'] : $tpl['defaults']['capabilities'];
        $intent = isset($t['intent']) && is_array($t['intent']) ? $t['intent'] : $tpl['defaults']['intent'];
        $n = 'cf_hosting_targets[' . (int) $i . ']';
        ?>
        <tr class="cfse-target-row">
            <td><input type="checkbox" name="<?php echo esc_attr($n); ?>[enabled]" value="1" <?php checked(!empty($t['enabled'])); ?> /></td>
            <td>
                <input type="text" name="<?php echo esc_attr($n); ?>[name]" value="<?php echo esc_attr(isset($t['name']) ? $t['name'] : ''); ?>" style="width:100%;" placeholder="例如：主站" />
            </td>
            <td>
                <select name="<?php echo esc_attr($n); ?>[template]" class="cfse-target-template" style="width:100%;">
                    <?php foreach ($templates as $tid => $tp) { ?>
                        <option value="<?php echo esc_attr($tid); ?>" <?php selected($tplId, $tid); ?>><?php echo esc_html($tp['name']); ?></option>
                    <?php } ?>
                </select>
            </td>
            <td class="cfse-sum">
                <?php
                $sumDir = $this->site_dir_of($t);
                $sumMod = 'cfse-static/' . $sumDir . '/';
                $sumEnd = isset($t['endpoint']) && $t['endpoint'] !== '' ? $t['endpoint'] : (isset($t['dir']) && $t['dir'] !== '' ? $t['dir'] : '');
                ?>
                <div><b><?php echo esc_html($sumDir); ?></b></div>
                <div style="font-size:12px;color:#646970;overflow-wrap:anywhere;">产物 <code><?php echo esc_html($sumMod); ?></code><?php if ($sumEnd !== '') { ?><br/><?php echo esc_html($sumEnd); ?><?php } ?></div>
            </td>
            <td style="white-space:nowrap;font-size:11px;">
                <?php foreach (array('r2' => '静态文件', 'd1' => '文章数据', 'render' => '渲染', 'cache' => '清缓存') as $ck => $clabel) { ?>
                    <label<?php if (empty($tpl['capabilities'][$ck])) echo ' style="opacity:.45;" title="该模板不支持此能力"'; ?>>
                        <input type="checkbox" name="<?php echo esc_attr($n); ?>[capabilities][<?php echo esc_attr($ck); ?>]" value="1" <?php checked(!empty($caps[$ck])); ?><?php disabled(empty($tpl['capabilities'][$ck])); ?> /> <?php echo esc_html($clabel); ?>
                    </label><br/>
                <?php } ?>
            </td>
            <td style="text-align:center;"><input type="checkbox" name="<?php echo esc_attr($n); ?>[is_default]" value="1" <?php checked(!empty($t['is_default'])); ?> /></td>
            <td style="white-space:nowrap;">
                <button type="button" class="button cfse-toggle-detail" data-modal="cfse-modal-<?php echo (int) $i; ?>">⚙️ 配置</button>
                <button type="button" class="button cfse-del-target" title="删除该目标">✕</button>
            </td>
        </tr>
        <?php ob_start(); ?>
                <div style="padding-bottom:10px;border-bottom:1px solid #f0f0f1;margin-bottom:10px;">
                    <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;">
                    <span style="font-size:12px;color:#646970;"><code><?php echo esc_html(isset($t['id']) ? $t['id'] : ''); ?></code></span>
                    <label style="font-size:12px;">名称 <input type="text" name="<?php echo esc_attr($n); ?>[name]" value="<?php echo esc_attr(isset($t['name']) ? $t['name'] : ''); ?>" style="width:150px;" /></label>
                    <label style="font-size:12px;">模板 <select name="<?php echo esc_attr($n); ?>[template]" class="cfse-target-template" style="width:auto;">
                        <?php foreach ($templates as $tid => $tp) { ?>
                            <option value="<?php echo esc_attr($tid); ?>" <?php selected($tplId, $tid); ?>><?php echo esc_html($tp['name']); ?></option>
                        <?php } ?>
                    </select></label>
                    <input type="hidden" name="<?php echo esc_attr($n); ?>[id]" value="<?php echo esc_attr(isset($t['id']) ? $t['id'] : ''); ?>" />
                    </div>
                    <div style="margin-top:8px;">
                        <label>本地保存目录 <code>wp-content/cfse-static/</code><input type="text" name="<?php echo esc_attr($n); ?>[site_dir]" value="<?php echo esc_attr(isset($t['site_dir']) ? $t['site_dir'] : ''); ?>" style="width:140px;" placeholder="留空 = 站点 id" /></label>
                        <span class="description" style="font-size:12px;">（英文/数字/下划线/连字符；保存时会自动创建该目录。改名只影响今后的产物，已生成的文件不会跟着移动）</span>
                    </div>
                </div>
                <div style="margin-top:8px;">
                    <label>站点地址（Worker 域名）<br/><input type="text" class="cfse-f-endpoint" name="<?php echo esc_attr($n); ?>[endpoint]" value="<?php echo esc_attr(isset($t['endpoint']) ? $t['endpoint'] : ''); ?>" style="width:100%;" placeholder="https://你的站点" /></label>
                    <span class="description" style="font-size:12px;">Cloudflare 目标填 Worker 域名；保存时会同步为本站的「静态站点 URL」</span>
                </div>
                <?php $this->render_cf_platform_fields($this->is_first_cloudflare_target($t)); ?>
                <div class="cfse-f-s3" style="margin-top:8px;display:none;font-size:12px;">
                    <b>对象存储（S3 兼容）</b>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">
                        <label>Bucket<br/><input type="text" name="<?php echo esc_attr($n); ?>[bucket]" value="<?php echo esc_attr(isset($t['bucket']) ? $t['bucket'] : ''); ?>" style="width:100%;" /></label>
                        <label>Region（R2 填 auto）<br/><input type="text" name="<?php echo esc_attr($n); ?>[region]" value="<?php echo esc_attr(isset($t['region']) ? $t['region'] : 'auto'); ?>" style="width:100%;" /></label>
                        <label>Access Key<br/><input type="text" name="<?php echo esc_attr($n); ?>[access_key]" value="<?php echo esc_attr(isset($t['access_key']) ? $t['access_key'] : ''); ?>" style="width:100%;" /></label>
                        <label>Secret Key<br/><input type="password" autocomplete="new-password" spellcheck="false" name="<?php echo esc_attr($n); ?>[secret_key]" value="<?php echo esc_attr(isset($t['secret_key']) ? $t['secret_key'] : ''); ?>" style="width:100%;" /></label>
                        <label>公开访问地址 public_url<br/><input type="text" name="<?php echo esc_attr($n); ?>[public_url]" value="<?php echo esc_attr(isset($t['public_url']) ? $t['public_url'] : ''); ?>" style="width:100%;" placeholder="https://cdn.example.com" /></label>
                        <label>寻址方式<br/><select name="<?php echo esc_attr($n); ?>[path_style]" style="width:100%;"><option value="auto" <?php selected(isset($t['path_style']) ? $t['path_style'] : 'auto', 'auto'); ?>>自动</option><option value="path" <?php selected(isset($t['path_style']) ? $t['path_style'] : 'auto', 'path'); ?>>path-style</option><option value="virtual" <?php selected(isset($t['path_style']) ? $t['path_style'] : 'auto', 'virtual'); ?>>virtual-host</option></select></label>
                    </div>
                </div>
                <div class="cfse-f-workerkey" style="margin-top:8px;font-size:12px;display:none;">
                    <label>Auth Key<br/><input type="text" class="cfse-f-key" name="<?php echo esc_attr($n); ?>[auth_key]" value="<?php echo esc_attr(isset($t['auth_key']) ? $t['auth_key'] : ''); ?>" style="width:100%;" /></label>
                    <span class="description" style="font-size:12px;">Worker 的 X-Auth-Key（与 Worker 的 AUTH_KEY_SECRET 相同）—— 只有 cloudflare 模板用得到</span>
                </div>
                <div style="margin-top:8px;font-size:12px;">
                    <label>路径前缀<br/><input type="text" name="<?php echo esc_attr($n); ?>[path_prefix]" value="<?php echo esc_attr(isset($t['path_prefix']) ? $t['path_prefix'] : ''); ?>" style="width:100%;" placeholder="留空 = 目标根目录" /></label>
                    <span class="description" style="font-size:12px;">产物写到该目标的哪个子目录（对象存储=对象名前缀；git 型=仓库子目录，且部署只清理该前缀之下）。所有模板都适用</span>
                </div>
                <div style="text-align:right;margin-top:12px;">
                <button type="submit" class="button button-primary">保存</button>
            </div>
        <?php $this->target_modals[$i] = ob_get_clean(); ?>
        <?php if (!empty($warns)) { ?>
        <tr class="cfse-row-warn"><td colspan="7" style="background:#fff8e5;border-left:3px solid #dba617;padding:8px 12px;">
            <?php foreach ($warns as $w) { ?>
                <div style="margin:2px 0;">⚠ <?php echo esc_html($w['message']); ?>
                <?php if (!empty($w['fix']) && is_array($w['fix'])) { ?>
                    <button type="button" class="button button-small cfse-fix-btn" data-fix="<?php echo esc_attr(implode(',', $w['fix'])); ?>" style="margin-left:6px;">以模板为准修正 type</button>
                <?php } ?></div>
            <?php } ?>
        </td></tr>
        <?php } ?>
        <?php
    }


    public function render_cf_platform_fields($render = true) {
        if (!$render) {
            // 平台凭证 / 自托管运行时 / 缓存策略都是「全局 option」，只在一个目标弹窗里渲染一次，
            // 否则页面上会出现多份同名 input，提交时 PHP 只取最后一个（其它目标的旧值）⇒ 本地改了存不上。
            ?>
            <div style="margin-top:10px;font-size:12px;color:#646970;">
                平台凭证与缓存策略是<b>全局设置</b>，只在站点列表中的<b>第一个 Cloudflare 目标</b>（或默认目标）的配置里填写一次，所有目标共用。
            </div>
            <?php
            return;
        }
        $c = $this->config;
        ?>
        <div class="cfse-f-cloudflare" style="margin-top:10px;display:none;font-size:12px;">
            <b>☁️ Cloudflare 平台</b>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">
                <label>Account ID<br/><input type="text" name="cf_account_id" value="<?php echo esc_attr($c['account_id']); ?>" style="width:100%;" /></label>
                <label>API Token<br/><input type="password" autocomplete="new-password" spellcheck="false" name="cf_api_token" value="<?php echo esc_attr($c['api_token']); ?>" style="width:100%;" placeholder="D1:Edit / R2:Edit / Account:Read" /></label>
                <label>R2 Bucket<br/><input type="text" name="cf_r2_bucket" value="<?php echo esc_attr($c['r2_bucket']); ?>" style="width:100%;" /></label>
                <label>D1 Database ID<br/><input type="text" name="cf_d1_database" value="<?php echo esc_attr($c['d1_database']); ?>" style="width:100%;" /></label>
                <input type="hidden" name="cf_site_url" value="<?php echo esc_attr($c['site_url']); ?>" />
                <input type="hidden" name="cf_auth_key" value="<?php echo esc_attr($c['auth_key']); ?>" />
                <span class="description" style="grid-column:1 / -1;font-size:12px;">站点地址取自上面的「站点地址（Worker 域名）」，保存时自动同步为本站的静态站点 URL。Auth Key 请填在下面的「Auth Key」里（每个站点各自独立）。</span>
            </div>
            <?php /* 缓存策略（TTL / feed 条数）已移至 CMS 后台维护：D1 settings k='cache' */ ?>
        </details>
        <?php
    }


    /**
     * 「连接 CMS」表单（基础层，永远可见）。
     *
     * 只有一个 CMS 时就是两个输入框；多个 CMS 时，主目标用这两个框，
     * 其余的到「站点列表」里加（高级层）。
     */
    public function render_connection_form() {
        $p = CFSE_Sync_Onboarding::get_instance()->get_primary();
        $targets = $this->get_hosting_targets();
        $multi = count($targets) > 1;
        ?>
        <table class="form-table cfse-table">
            <tr>
                <th><label for="cfse_conn_endpoint">CMS 地址</label></th>
                <td>
                    <input type="url" id="cfse_conn_endpoint" name="cf_site_url"
                        value="<?php echo esc_attr($p['endpoint']); ?>"
                        style="width:100%;max-width:460px;" placeholder="https://你的站点.workers.dev" />
                    <p class="description">wrangler 部署后给的地址，或你绑定的域名。</p>
                </td>
            </tr>
            <tr>
                <th><label for="cfse_conn_auth_key">同步密钥</label></th>
                <td>
                    <input type="password" id="cfse_conn_auth_key" name="cf_auth_key"
                        value="<?php echo esc_attr($p['auth_key']); ?>"
                        style="width:100%;max-width:460px;" autocomplete="off" placeholder="CMS 的同步密钥" />
                    <p class="description">在 CMS 后台「⚙️ 设置」里查看。</p>
                </td>
            </tr>
        </table>
        <div class="cfse-actions" style="margin-top:4px;">
            <button type="button" class="button" id="cfse-test-conn-2">🔌 测试连接</button>
            <span id="cfse-test-conn-result-2" class="cfse-dim"></span>
        </div>
        <?php if ($multi): ?>
            <p class="description" style="margin-top:10px;">
                ⚠️ 检测到 <b><?php echo count($targets); ?></b> 个站点。修改只会作用于第一个（主站点）；
                其余的在下方「站点列表」里管理。
            </p>
        <?php endif; ?>
        <?php
    }

    /** 设置页：托管目标表格（已有目标逐行渲染；新增行由页面内 JS 生成） */
    public function render_hosting_targets_table() {
        // 渲染必须包含「未启用」的目标：否则取消勾选后它就从界面上消失，再保存即被删除。
        $targets = $this->get_hosting_targets(true);
        // 冷路径校验（§12）：行内警告 + 集合级提示
        $vr = $this->validate_hosting_targets(false);
        $byId = array(); $global = array();
        foreach ($vr['warnings'] as $w) {
            if ($w['id'] === '(全部目标)') $global[] = $w; else $byId[$w['id']][] = $w;
        }
        ?>
        <?php $unsupported = $this->get_unsupported_targets(); ?>
        <?php if (!empty($unsupported)) { ?>
            <div style="margin:0 0 10px;background:#fcf3f3;border-left:3px solid #d63638;padding:9px 12px;font-size:12.5px;line-height:1.6;">
                <b>⚠ 有 <?php echo count($unsupported); ?> 个目标使用了本插件不支持的模板</b>
                <div style="color:#646970;margin:2px 0 4px;">
                    这些目标由旧版插件创建（GitHub Pages / Netlify / FTP / WebDAV / 本地目录等），
                    现在归 <b>WP Static Deploy</b> 插件管理。本插件<b>不会使用它们，也不会删除它们</b> ——
                    配置原样保留在数据库里，装上那个插件后即可继续使用。
                </div>
                <ul style="margin:4px 0 0 18px;list-style:disc;">
                    <?php foreach ($unsupported as $u) { ?>
                        <li>
                            <code><?php echo esc_html($u['id']); ?></code>
                            <?php echo esc_html($u['name'] !== '' ? $u['name'] : '(未命名)'); ?>
                            — 模板 <code><?php echo esc_html($u['template']); ?></code>
                            <?php echo $u['enabled'] ? '（启用中）' : '（已停用）'; ?>
                        </li>
                    <?php } ?>
                </ul>
            </div>
        <?php } ?>
        <details class="cfse-adv" <?php echo (isset($_GET['cfse_expand']) && $_GET['cfse_expand'] === 'targets') ? 'open' : ''; ?>>
        <summary>🏗 站点列表（高级）—— 一个 WP 同步到多个 CMS 实例时才需要</summary>
        <div style="overflow-x:auto;">
        <table class="widefat striped" id="cfse-targets" style="max-width:100%;font-size:12.5px;line-height:1.5;">
            <thead><tr>
                <th style="width:46px;">启用</th>
                <th style="width:140px;">名称</th>
                <th style="width:150px;">模板</th>
                <th>站点 / 目录</th>
                <th style="width:160px;">能力</th>
                <th style="width:56px;">默认</th>
                <th style="width:120px;">操作</th>
            </tr></thead>
            <tbody id="cfse-targets-body">
            <?php foreach ($targets as $i => $t) {
                $tid = isset($t['id']) ? $t['id'] : '';
                $this->render_hosting_target_row($i, $t, isset($byId[$tid]) ? $byId[$tid] : array());
            } ?>
            </tbody>
        </table>
        </div>
        <!-- 站点列表的操作按钮与脚本（表格专属；「站点列表」折叠时才可见） -->
                            <p style="margin-top:8px;">
                                <button type="button" class="button" id="cfse-add-target">＋ 添加目标</button>
                                <button type="button" class="button" id="cfse-test-targets">🔌 测试连通性</button>
                                <span id="cfse-test-result" class="description" style="margin-left:8px;"></span>
                                <span class="description" style="margin-left:8px;">（测试用的是<b>已保存</b>的配置，改动后请先保存）</span>
                            </p>
                            <script>
                            (function(){
                              var body = document.getElementById('cfse-targets-body');
                              if (!body) return;
                              var idx = body.querySelectorAll('tr.cfse-target-row').length;
                              // 字段联动：按「模板」显隐字段组（B7②）
                              //   cloudflare ⇒ endpoint + auth_key
                              //   s3         ⇒ endpoint + s3 组（隐藏 auth_key）
                              //   local      ⇒ dir（隐藏 endpoint / auth_key / s3）
                              // 「⚙️ 配置」打开对应弹窗（弹窗互斥天然成立）
                              function bindDetail(tr){
                                var btn = tr.querySelector('.cfse-toggle-detail');
                                if (!btn) return;
                                btn.addEventListener('click', function(){
                                  var m = document.getElementById(btn.getAttribute('data-modal'));
                                  if (m) m.style.display = 'block';
                                });
                              }
                              // 关闭弹窗（按钮或点遮罩）
                              document.addEventListener('click', function(e){
                                var t = e.target;
                                if (t && t.classList && t.classList.contains('cfse-modal-close')) {
                                  var box = t.closest ? t.closest('.cfse-target-modal') : null;
                                  if (box) box.style.display = 'none';
                                  return;
                                }
                                if (t && t.classList && t.classList.contains('cfse-target-modal')) {
                                  t.style.display = 'none';
                                }
                              });
                              // 模板 → 支持的能力（与 PHP get_hosting_templates() 一致；只有 cloudflare 支持 d1/render/cache）
                              var TPL_CAPS = {
                                'cloudflare': ['r2', 'd1', 'render', 'cache'],
                                's3': ['r2']
                              };
                              var TPL_BLOCKS = {
                                'cloudflare': '.cfse-f-cloudflare', 's3': '.cfse-f-s3'
                              };
                              function rowIdx(tr){
                                var el = tr.querySelector('input[name^="cf_hosting_targets["]');
                                var m = el ? String(el.name).match(/^cf_hosting_targets\[(\d+)\]/) : null;
                                return m ? m[1] : null;
                              }
                              // 模板块内字段启停：隐藏块若仍可提交，其旧值会以同名键后写覆盖
                              // 用户在可见块里的输入（PHP $_POST 同名键后写胜）⇒ 「保存不上」。
                              // disabled 字段不随表单提交 ⇒ 每个目标只有当前模板块的字段会提交。
                              function setBlockEnabled(block, on){
                                if (!block) return;
                                var fs = block.querySelectorAll('input,select,textarea');
                                for (var i = 0; i < fs.length; i++) fs[i].disabled = !on;
                              }
                              function applyTemplate(tr, v, modal){
                                // ① 弹窗里的「模板相关块」显隐 + 启停（弹窗在 #cfse-modals，不在 tr 内）
                                Object.keys(TPL_BLOCKS).forEach(function(k){
                                  var el = modal ? modal.querySelector(TPL_BLOCKS[k]) : null;
                                  if (el) { el.style.display = (v === k) ? '' : 'none'; setBlockEnabled(el, v === k); }
                                });
                                // ② endpoint / Auth Key 的显示规则（这些字段都在弹窗里，必须从 modal 找）
                                var ep = modal ? modal.querySelector('.cfse-f-endpoint') : null;
                                var isCf = (v === 'cloudflare');
                                if (ep) { ep.style.display = isCf ? '' : 'none'; ep.disabled = !isCf; }
                                var wk = modal ? modal.querySelector('.cfse-f-workerkey') : null;
                                if (wk) { wk.style.display = (v === 'cloudflare') ? '' : 'none'; setBlockEnabled(wk, v === 'cloudflare'); }
                                // ③ 能力按模板可选范围置灰 / 启用（这一步就是「选模型 ⇒ 能力跟着变」）
                                var idx = rowIdx(tr);
                                if (idx !== null) {
                                  var allow = TPL_CAPS[v] || ['r2'];
                                  ['r2', 'd1', 'render', 'cache'].forEach(function(ck){
                                    var box = tr.querySelector('input[name="cf_hosting_targets[' + idx + '][capabilities][' + ck + ']"]');
                                    if (!box) return;
                                    var ok = allow.indexOf(ck) !== -1;
                                    box.disabled = !ok;
                                    var lab = box.parentNode;
                                    if (lab) {
                                      lab.style.opacity = ok ? '' : '.45';
                                      if (ok) lab.removeAttribute('title'); else lab.setAttribute('title', '该模板不支持此能力');
                                    }
                                    if (!ok) box.checked = false;
                                  });
                                }
                              }
                              // 表格行与弹窗里的 名称/模板 双向同步（改一处另一处跟着变 ⇒ 提交值一致）
                              function bindSync(tr, modal){
                                var idx = rowIdx(tr);
                                if (idx === null) return;
                                var q = 'cf_hosting_targets[' + idx + ']';
                                var pairs = [
                                  [tr.querySelector('input[name="' + q + '[name]"]'), modal ? modal.querySelector('input[name="' + q + '[name]"]') : null],
                                  [tr.querySelector('select[name="' + q + '[template]"]'), modal ? modal.querySelector('select[name="' + q + '[template]"]') : null]
                                ];
                                pairs.forEach(function (p) {
                                  var a = p[0], b = p[1];
                                  if (!a || !b) return;
                                  function mirror(src, dst) {
                                    ['input', 'change'].forEach(function (ev) {
                                      src.addEventListener(ev, function () {
                                        if (dst.value !== src.value) dst.value = src.value;
                                        if (src.tagName === 'SELECT') syncRow(tr);
                                      });
                                    });
                                  }
                                  mirror(a, b); mirror(b, a);
                                });
                              }
                              function syncRow(tr){
                                var tpl = tr.querySelector('.cfse-target-template');
                                var v = tpl ? tpl.value : 'cloudflare';
                                var openBtn = tr.querySelector('.cfse-toggle-detail');
                                var modal = openBtn ? document.getElementById(openBtn.getAttribute('data-modal')) : null;
                                applyTemplate(tr, v, modal);
                              }
                              function bind(tr){
                                var tpl = tr.querySelector('.cfse-target-template');
                                if (tpl) tpl.addEventListener('change', function(){ syncRow(tr); });
                                var del = tr.querySelector('.cfse-del-target');
                                if (del) del.addEventListener('click', function(){
                                  // 关键：弹窗在 #cfse-modals 里、独立于表格行；不一起删掉的话，
                                  // 弹窗里的 cf_hosting_targets[N][...] 仍会随表单提交 ⇒ 目标「删不掉」。
                                  var ob = tr.querySelector('.cfse-toggle-detail');
                                  if (ob) {
                                    var mdl = document.getElementById(ob.getAttribute('data-modal'));
                                    if (mdl && mdl.parentNode) mdl.parentNode.removeChild(mdl);
                                  }
                                  tr.parentNode.removeChild(tr);
                                });
                                bindSync(tr, tr.querySelector('.cfse-toggle-detail') ? document.getElementById(tr.querySelector('.cfse-toggle-detail').getAttribute('data-modal')) : null);
                                syncRow(tr);
                              }
                              Array.prototype.forEach.call(body.querySelectorAll('tr.cfse-target-row'), function(tr){ bind(tr); bindDetail(tr); });
                              var addBtn = document.getElementById('cfse-add-target');
                              if (addBtn) addBtn.addEventListener('click', function(){
                                var tmp = document.createElement('tbody');
                                tmp.innerHTML = '<tr class="cfse-target-row">' +
                                  '<td><input type="checkbox" name="cf_hosting_targets[' + idx + '][enabled]" value="1" checked /></td>' +
                                  '<td><input type="text" name="cf_hosting_targets[' + idx + '][name]" style="width:100%;" placeholder="例如：备份站" /></td>' +
                                  '<td><select name="cf_hosting_targets[' + idx + '][template]" class="cfse-target-template" style="width:100%;"><option value="cloudflare">Cloudflare（Worker + R2 + D1）</option><option value="s3">S3 兼容对象存储</option></select></td>' +
                                  '<td class="cfse-sum"><div><b class="cfse-sum-dir">（保存后显示）</b></div><div style="font-size:11px;color:#646970;">目录与站点 id 将在保存后生成</div></td>' +
                                  '<td style="white-space:nowrap;font-size:11px;">' +
                                    '<label><input type="checkbox" name="cf_hosting_targets[' + idx + '][capabilities][r2]" value="1" checked /> 静态文件</label><br/>' +
                                    '<label><input type="checkbox" name="cf_hosting_targets[' + idx + '][capabilities][d1]" value="1" checked /> 文章数据</label><br/>' +
                                    '<label><input type="checkbox" name="cf_hosting_targets[' + idx + '][capabilities][render]" value="1" checked /> 渲染</label><br/>' +
                                    '<label><input type="checkbox" name="cf_hosting_targets[' + idx + '][capabilities][cache]" value="1" checked /> 清缓存</label>' +
                                  '</td>' +
                                  '<td style="text-align:center;"><input type="checkbox" name="cf_hosting_targets[' + idx + '][is_default]" value="1" /></td>' +
                                  '<td style="white-space:nowrap;"><button type="button" class="button cfse-toggle-detail" data-modal="cfse-modal-' + idx + '">⚙️ 配置</button> <button type="button" class="button cfse-del-target" title="删除该目标">✕</button></td>' +
                                '</tr>';
                                var modalHtml = '<div class="cfse-target-modal" id="cfse-modal-' + idx + '" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;font-size:13px;">' +
                                  '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;padding:18px 22px;font-size:13px;line-height:1.6;border-radius:6px;width:min(92vw,780px);max-height:86vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3);">' +
                                  '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><b style="font-size:15px;">⚙️ 站点配置</b><button type="button" class="button cfse-modal-close">关闭</button></div>' +
                                  '<div style="padding-bottom:10px;border-bottom:1px solid #f0f0f1;margin-bottom:10px;">' +
                                    '<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;">' +
                                      '<span style="color:#646970;"><code>（保存后生成）</code></span>' +
                                      '<label>名称 <input type="text" name="cf_hosting_targets[' + idx + '][name]" style="width:150px;" placeholder="例如：备份站" /></label>' +
                                      '<label>模板 <select name="cf_hosting_targets[' + idx + '][template]" class="cfse-target-template" style="width:auto;"><option value="cloudflare">Cloudflare（Worker + R2 + D1）</option><option value="s3">S3 兼容对象存储</option></select></label>' +
                                      '<input type="hidden" name="cf_hosting_targets[' + idx + '][id]" value="" />' +
                                    '</div>' +
                                    '<div style="margin-top:8px;">' +
                                      '<label>本地保存目录 <code>wp-content/cfse-static/</code><input type="text" name="cf_hosting_targets[' + idx + '][site_dir]" style="width:140px;" placeholder="留空 = 站点 id" /></label>' +
                                      '<span class="description" style="font-size:12px;">（英文/数字/下划线/连字符；保存时会自动创建目录）</span>' +
                                    '</div>' +
                                  '</div>' +
                                  '<div style="margin-top:8px;">' +
                                    '<label>站点地址（Worker 域名）<br/><input type="text" class="cfse-f-endpoint" name="cf_hosting_targets[' + idx + '][endpoint]" style="width:100%;" placeholder="https://你的站点" /></label>' +
                                    '<span class="description" style="font-size:12px;">Cloudflare 目标填 Worker 域名；保存时会同步为本站的「静态站点 URL」</span>' +
                                  '</div>' +
                                    '<div class="cfse-f-s3" style="margin-top:8px;display:none;font-size:12px;">' +
                                    '<b>对象存储（S3 兼容）</b>' +
                                    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;">' +
                                      '<label>Bucket<br/><input type="text" name="cf_hosting_targets[' + idx + '][bucket]" style="width:100%;" /></label>' +
                                      '<label>Region（R2 填 auto）<br/><input type="text" name="cf_hosting_targets[' + idx + '][region]" style="width:100%;" value="auto" /></label>' +
                                      '<label>Access Key<br/><input type="text" name="cf_hosting_targets[' + idx + '][access_key]" style="width:100%;" /></label>' +
                                      '<label>Secret Key<br/><input type="password" autocomplete="new-password" name="cf_hosting_targets[' + idx + '][secret_key]" style="width:100%;" /></label>' +
                                      '<label>公开访问地址 public_url<br/><input type="text" name="cf_hosting_targets[' + idx + '][public_url]" style="width:100%;" placeholder="https://cdn.example.com" /></label>' +
                                      '<label>寻址方式<br/><select name="cf_hosting_targets[' + idx + '][path_style]" style="width:100%;"><option value="auto">自动</option><option value="path">path-style</option><option value="virtual">virtual-host</option></select></label>' +
                                    '</div>' +
                                  '</div>' +
                                  '<div class="cfse-f-workerkey" style="margin-top:8px;font-size:12px;display:none;">' +
                                    '<label>Auth Key<br/><input type="text" class="cfse-f-key" name="cf_hosting_targets[' + idx + '][auth_key]" style="width:100%;" /></label>' +
                                    '<span class="description" style="font-size:12px;">Worker 的 X-Auth-Key —— 只有 cloudflare 模板用得到</span>' +
                                  '</div>' +
                                  '<div style="margin-top:8px;font-size:12px;">' +
                                    '<label>路径前缀<br/><input type="text" name="cf_hosting_targets[' + idx + '][path_prefix]" style="width:100%;" placeholder="留空 = 目标根目录" /></label>' +
                                  '</div>' +
                                  '</div></div>';
                                var host = document.getElementById('cfse-modals');
                                if (host) host.insertAdjacentHTML('beforeend', modalHtml);
                                var tr = tmp.firstElementChild;
                                body.appendChild(tr);
                                bind(tr);
                                bindDetail(tr);
                                syncRow(tr);   // 弹窗已建好，同步一次「模板相关块」的显隐
                                idx++;
                              });
                              var testBtn = document.getElementById('cfse-test-targets');
                              if (testBtn) testBtn.addEventListener('click', function(){
                                var out = document.getElementById('cfse-test-result');
                                out.textContent = '测试中…';
                                jQuery.post(ajaxurl, { action: 'cfse_test_targets', _ajax_nonce: '<?php echo esc_js(wp_create_nonce('cfse_test_targets')); ?>' }, function(r){
                                  if (!r || !r.success) { out.textContent = '测试失败'; return; }
                                  out.innerHTML = (r.data.results || []).map(function(x){
                                    return (x.ok ? '✅ ' : '❌ ') + x.name + '：' + x.detail;
                                  }).join('　|　');
                                }).fail(function(){ out.textContent = '请求失败'; });
                              });
                            })();
                            </script>
        <div id="cfse-modals">
        <?php foreach ($this->target_modals as $mi => $mhtml) { ?>
            <div class="cfse-target-modal" id="cfse-modal-<?php echo (int) $mi; ?>" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;font-size:13px;">
                <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;padding:18px 22px;font-size:13px;line-height:1.6;border-radius:6px;width:min(92vw,780px);max-height:86vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                        <b style="font-size:14px;">⚙️ 站点配置</b>
                        <button type="button" class="button cfse-modal-close">关闭</button>
                    </div>
                    <?php echo $mhtml; ?>
                </div>
            </div>
        <?php } ?>
        </div>
        <script>
        </script>
        <?php if (!empty($global)) { ?>
            <div style="margin-top:8px;background:#fff8e5;border-left:3px solid #dba617;padding:8px 12px;">
                <?php foreach ($global as $w) { ?>
                    <div style="margin:2px 0;">⚠ <?php echo esc_html($w['message']); ?></div>
                <?php } ?>
            </div>
        <?php } ?>
        </details>
    <?php
    }

    // ============================================
    // 站点（= 托管目标）辅助
    // ============================================

    /** 目标的目录名（site_dir 优先，缺省回退到 id） */
    public function site_dir_of($target) {
        $d = isset($target['site_dir']) ? preg_replace('/[^0-9a-zA-Z_-]/', '', (string) $target['site_dir']) : '';
        if ($d !== '') return $d;
        return isset($target['id']) ? (string) $target['id'] : 'default';
    }


    public function get_recent_logs($lines = 10) {
        if (!file_exists(CFSE_LOG_FILE)) return '暂无日志';
        $logs = @file(CFSE_LOG_FILE, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($logs === false) return '无法读取日志文件';
        $recent = array_slice($logs, -$lines);
        return implode("\n", $recent);
    }


    // ============================================
    // 统计和日志
    // ============================================
    public function get_export_stats() {
        $post_counts = wp_count_posts('post');
        $total_posts = isset($post_counts->publish) ? (int) $post_counts->publish : 0;
        $exported = (int) get_option('cf_exported_count', 0);
        $last_export = get_option('cf_last_export_time', '从未');
        return array(
            'total_posts' => $total_posts,
            'exported_posts' => min($exported, $total_posts),
            'pending_posts' => max(0, $total_posts - $exported),
            'last_export' => $last_export === '从未' ? '从未' : human_time_diff(strtotime($last_export)) . '前',
            'progress' => $total_posts > 0 ? ($exported / $total_posts * 100) : 0,
        );
    }


    /** Cloudflare 目标「⚙️ 配置」弹窗里的平台与运行时块（字段是全局 option：平台级的一份配置） */
    /** 是否是「第一个 Cloudflare 目标」（全局字段只在这里渲染一次）；带缓存，渲染一页只算一次 */
    public function is_first_cloudflare_target($t) {
        static $firstId = null;
        if ($firstId === null) {
            $firstId = '';
            foreach ($this->get_hosting_targets() as $x) {
                $tpl = isset($x['template']) ? $x['template'] : (isset($x['type']) && $x['type'] === 'cfse-worker' ? 'cloudflare' : '');
                if ($tpl === 'cloudflare') { $firstId = (string) (isset($x['id']) ? $x['id'] : ''); break; }
            }
        }
        $id = (string) (isset($t['id']) ? $t['id'] : '');
        return ($firstId !== '' && $id === $firstId);
    }

    public function render_export_column($column, $post_id) {
        if ($column !== 'cf_exported') return;
        if (get_post_meta($post_id, '_cfse_synced_d1', true)) {
            echo '<span title="文章数据已写入 D1；单页由 Worker 按需渲染">☁️ 已同步 D1</span>';
        } else {
            echo '<span title="还没有同步到 D1">⏳ 待同步</span>';
        }
    }


    /**
     * 「☁️ Worker 同步」面板（只对 Worker 端诞生的篇显示）：
     * 异步查两端版本时间（不拖慢编辑页）+ 一键对齐本篇。
     */
    public function render_worker_sync_metabox($post) {
        $pid = (int) $post->ID;
        $auto = !empty($this->config['worker_auto_check']);
        // 用链接而不是 <form>：WP 编辑页的主表单包裹整个编辑区，内层 <form> 会被浏览器忽略
        $align_url = wp_nonce_url(admin_url('admin-post.php?action=cfse_align_worker&post_id=' . $pid), 'cfse_align_worker_' . $pid);
        echo '<p class="description">本篇由 <b>Worker 端诞生</b>，可把 Worker 的最新版本对齐过来。</p>';
        echo '<p style="margin:8px 0;"><button type="button" class="button" id="cfse-check-btn">🔍 检查 Worker 端版本</button></p>';
        echo '<div id="cfse-worker-status" style="margin:8px 0;padding:8px;background:#f6f7f7;border-radius:3px;font-size:12px;line-height:1.7;color:#646970;">'
            . ($auto ? '正在查询…' : '点上面的按钮查询两端版本时间。') . '</div>';
        echo '<p id="cfse-align-wrap" style="margin:8px 0;display:none;">'
            . '<a href="' . esc_url($align_url) . '" class="button button-primary" id="cfse-align-btn">对齐本篇</a>'
            . ' <span class="dashicons dashicons-editor-help" style="color:#787c82;vertical-align:text-bottom;" title="用 Worker 端的标题 / 正文 / 别名 / 分类标签覆盖本篇（会覆盖 WP 侧对该篇的修改）"></span>'
            . '</p>';
        if (isset($_GET['cfse_aligned'])) {
            echo $_GET['cfse_aligned'] === '1'
                ? '<p style="margin:8px 0 0;color:#2271b1;"><b>✅ 已对齐到 Worker 版本</b></p>'
                : '<p style="margin:8px 0 0;color:#b32d2e;"><b>❌ 对齐失败</b>（未能从 Worker 取到该篇，见日志）</p>';
        }
        $ajax_nonce = wp_create_nonce('cfse_worker_status');
        // 按钮只在「远端更新」时出现；本地较新 / 一致 都不给覆盖入口（避免误覆盖）
        echo '<script>jQuery(function($){'
            . 'var $s=$("#cfse-worker-status"),$w=$("#cfse-align-wrap");'
            . 'function cfseCheck(){'
            . '$w.hide();$s.html("查询中…");'
            . '$.post(ajaxurl,{action:"cfse_worker_status",post_id:' . $pid . ',_ajax_nonce:"' . esc_js($ajax_nonce) . '"},function(r){'
            . 'if(!r||!r.ok){$s.html("（查询不到 Worker 版本：该篇可能尚未同步到 Worker，或接口不可用）");return;}'
            . 'var h="Worker 版本：" + r.worker_modified + "<br/>本篇版本：" + r.local_modified;'
            . 'if(r.need_sync){h += "<br/><b style=\'color:#b32d2e;\'>⚠︎ 远端更新，建议对齐</b>";$w.show();}'
            . 'else if(r.local_newer){h += "<br/><b style=\'color:#996800;\'>本地较新</b> —— 若以 Worker 版本覆盖，会丢失本地修改。";}'
            . 'else{h += "<br/><span style=\'color:#1d6f42;\'>✔ 两端一致</span>";}'
            . '$s.html(h);});}'
            . '$("#cfse-check-btn").on("click",cfseCheck);'
            . 'if(' . ($auto ? 'true' : 'false') . '){cfseCheck();}'
            . '});</script>';
    }


    public function render_doc_format_metabox($post) {
        $is_md = ($this->get_content_format($post->ID) === 'md');
        wp_nonce_field('cfse_doc_format_save', 'cfse_doc_format_nonce');
        echo '<label style="display:inline-flex;align-items:center;gap:6px;"><input type="checkbox" name="cfse_content_format_md" value="1" ' . checked($is_md, true, false) . ' /> <span>存为 MD 格式</span></label>';
        echo '<details style="margin-top:8px;">'
            . '<summary style="cursor:pointer;color:#2271b1;font-size:12px;">'
            . '<span class="dashicons dashicons-editor-help" style="font-size:15px;width:15px;height:15px;vertical-align:text-bottom;"></span> 这是什么？</summary>'
            . '<div class="description" style="margin:6px 0 0;padding-left:8px;border-left:3px solid #c3c4c7;font-size:12px;line-height:1.7;">'
            . '本文正文是 <b>Markdown 原稿</b>时勾选。勾选后，静态站的列表 / 订阅 / 单页都会按 Markdown 排版渲染。<br/>'
            . '<b>建议</b>：md 原稿请用编辑器右上角的「文本」标签页粘贴 —— 「可视」模式保存会重排正文。'
            . '</div></details>';
    }


    public function render_site_metabox($post) {
        if (!$post || $post->post_type !== 'post') return;
        $targets = $this->get_hosting_targets(true);          // 含停用（显示但禁用）
        $checked = $this->get_post_site_ids_raw($post->ID);
        $def = $this->default_site();
        $defName = '';
        foreach ($targets as $t) {
            if ($def && (string) $t['id'] === (string) $def['id']) $defName = (string) $t['name'];
        }
        // 摘要
        $names = array();
        foreach ($targets as $t) {
            if (in_array((string) $t['id'], $checked, true)) $names[] = $t['name'];
        }
        $summary = empty($names)
            ? ($def ? ('未选择 → 使用默认站点「' . $defName . '」') : '未选择（且无默认站点 → 本篇不生成、不发布）')
            : implode('、', $names);
        ?>
        <?php wp_nonce_field('cfse_site_' . $post->ID, 'cfse_site_nonce'); ?>
        <div id="cfse-site-box">
            <p style="margin:4px 0;"><b>当前：</b><span id="cfse-site-summary"><?php echo esc_html($summary); ?></span></p>
            <button type="button" class="button" id="cfse-site-open">⚙️ 设置</button>
            <p class="description" style="font-size:11px;margin-top:6px;">
                选中的站点都会**生成并发布**（同一篇可多站点）；不选则走默认站点。
                默认站点：<code><?php echo $def ? esc_html($defName . ' / ' . $this->site_dir_of($def)) : '（未设置）'; ?></code>
            </p>
        </div>
        <div id="cfse-site-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;">
            <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;padding:18px 22px;font-size:13px;line-height:1.6;border-radius:6px;min-width:340px;max-width:min(90vw,520px);max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.3);">
                <h3 style="margin-top:0;">🌐 选择站点</h3>
                <p class="description" style="margin:2px 0 10px;">勾选的站点都会生成产物并发布；一个都不勾 = 走默认站点。</p>
                <?php foreach ($targets as $t) {
                    $tid = (string) $t['id'];
                    $dis = empty($t['enabled']);
                    ?>
                    <label style="display:block;margin:5px 0;<?php echo $dis ? 'opacity:.5;' : ''; ?>">
                        <input type="checkbox" name="cfse_site[]" value="<?php echo esc_attr($tid); ?>"
                            <?php checked(in_array($tid, $checked, true)); ?><?php disabled($dis); ?> />
                        <?php echo esc_html($t['name']); ?>
                        <code style="font-size:11px;"><?php echo esc_html($this->site_dir_of($t)); ?></code>
                        <?php if (!empty($t['is_default'])) { ?><span style="color:#2271b1;">（默认）</span><?php } ?>
                        <?php if ($dis) { ?><span style="color:#999;">（已停用）</span><?php } ?>
                    </label>
                <?php } ?>
                <?php if (empty($targets)) { ?>
                    <p>还没有站点。请到「设置 → CFSE 同步 → 🎯 托管目标」添加。</p>
                <?php } ?>
                <p style="text-align:right;margin-bottom:0;">
                    <button type="button" class="button button-primary" id="cfse-site-close">完成</button>
                </p>
            </div>
        </div>
        <script>
        (function () {
            var open = document.getElementById('cfse-site-open');
            var modal = document.getElementById('cfse-site-modal');
            var close = document.getElementById('cfse-site-close');
            if (!open || !modal) return;
            open.addEventListener('click', function () { modal.style.display = 'block'; });
            if (close) close.addEventListener('click', function () { modal.style.display = 'none'; });
            modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });
            // 勾选变化时即时更新摘要（不必等保存）
            var boxes = modal.querySelectorAll('input[name="cfse_site[]"]');
            function refresh() {
                var picked = [];
                for (var i = 0; i < boxes.length; i++) {
                    if (boxes[i].checked) {
                        var lab = boxes[i].parentNode;
                        picked.push((lab.textContent || '').replace(/（默认）|（已停用）/g, '').trim());
                    }
                }
                var el = document.getElementById('cfse-site-summary');
                if (el) el.textContent = picked.length ? picked.join('、') : '未选择（走默认站点；若无默认站点则本篇不生成、不发布）';
            }
            for (var i = 0; i < boxes.length; i++) boxes[i].addEventListener('change', refresh);
        })();
        </script>
        <?php
    }


    /** 全站默认站点（托管目标里勾了「默认站点」且启用的第一个；没有则 null） */
    public function default_site() {
        $targets = isset($this->config['hosting_targets']) ? $this->config['hosting_targets'] : array();
        foreach ($targets as $t) {
            if (!empty($t['is_default']) && !empty($t['enabled'])) return $t;
        }
        return null;
    }


    /**
     * 读取文章内容格式，返回值只有 'md' / 'html'。
     * 优先可见字段 content_format（与 D1 posts.content_format 同名；WP 后台编辑页的「自定义字段」
     * 面板里可手动添加/修改），兼容批2 初版写过的隐藏字段 _cfse_content_format。
     */
    public function get_content_format($post_id) {
        $value = get_post_meta($post_id, 'content_format', true);
        if ($value === '' || $value === null || $value === false) {
            $value = get_post_meta($post_id, '_cfse_content_format', true); // 兼容旧标记
        }
        return (strtolower(trim((string) $value)) === 'md') ? 'md' : 'html';
    }


    // ============================================
    // Markdown 渲染（md 文章；与 Worker 端 marked 对齐）
    // ============================================
    // ============================================
    // 文章编辑页「📝 文档格式」面板（Markdown 原稿标记）
    // ============================================
    // ============================================
    // 文章编辑页「🌐 站点」面板（多站点归属）
    // ============================================

    /** 文章显式标记的站点 id（**不回落默认站点** —— 面板要如实显示"未选"） */
    public function get_post_site_ids_raw($post_id) {
        $raw = get_post_meta($post_id, self::META_SITE, false);
        $ids = array();
        foreach ((array) $raw as $v) {
            if (is_array($v)) { foreach ($v as $x) $ids[] = (string) $x; }
            elseif (is_string($v) && strpos($v, ',') !== false) { foreach (explode(',', $v) as $x) $ids[] = trim($x); }
            elseif ($v !== '' && $v !== null) { $ids[] = (string) $v; }
        }
        return array_values(array_unique(array_filter($ids, 'strlen')));
    }
}
