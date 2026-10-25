<?php
/**
 * CFSE_Sync_Onboarding —— 后台设置页的「连接状态机」。
 *
 * ## 为什么要有状态机
 *
 * 插件有两种用户：
 *   ① 已经部署好 CMS 的 —— 打开设置页就想「连上，开始搬内容」
 *   ② 从插件市场装来的 —— 连 CMS 都没有，得先部署一份
 *
 * 以前这两种人看到的是**同一屏**：一堆托管目标表格 + 六个配置区块，
 * 谁都找不到「我现在该点哪个按钮」。
 *
 * 改成按连接状态分屏：
 *   状态 A「未连接」  → 引导部署（主路径：一键下载发行包 + 部署）
 *   状态 B「已配置」  → 填地址 + 同步密钥 + 测试连接
 *   状态 C「已连接」  → 直接是同步操作（内容永远可见）
 *
 * 基础层（连接 + 同步）永远可见，高级层（部署 / 外观 / 日志）默认折叠。
 *
 * ## 状态怎么判定
 *
 *   A 未连接 —— 没有配置任何 endpoint（或 endpoint 是空串）
 *   B 已配置 —— 配了 endpoint，但**从未成功测通过**
 *   C 已连接 —— 测通过（option cfse_conn_state = 'connected'），或已经成功同步过
 *
 * 判定刻意保守：宁可显示 B（多一步测试）也不误报 C（用户以为连上了但其实没连上）。
 *
 * @package CFSE
 */

if (!defined('ABSPATH')) {
    exit;
}

if (class_exists('CFSE_Sync_Onboarding')) {
    return;
}

class CFSE_Sync_Onboarding {

    private static $instance = null;

    /** 连接状态缓存（一次请求内只算一次） */
    private $state = null;

    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
    }

    /** 桥接：日志转发主类 */
    public function log($message, $level = 'INFO') {
        return CFSE_Sync_Plugin::get_instance()->log($message, $level);
    }

    // ============================================
    // 状态判定
    // ============================================

    /**
     * 当前连接状态：'none' | 'configured' | 'connected'
     */
    public function get_state() {
        if ($this->state !== null) return $this->state;

        $endpoint = '';
        $hasKey = false;
        $targets = CFSE_Sync_Transports::get_instance()->get_hosting_targets();
        foreach ($targets as $t) {
            $ep = isset($t['endpoint']) ? trim((string) $t['endpoint']) : '';
            if ($ep !== '') {
                $endpoint = $ep;
                $hasKey = !empty($t['auth_key']);
                break;
            }
        }

        if ($endpoint === '') {
            $this->state = 'none';
        } elseif ((string) get_option('cfse_conn_state', '') === 'connected') {
            $this->state = 'connected';
        } else {
            $this->state = 'configured';
        }

        return $this->state;
    }

    /** 主目标（第一个有 endpoint 的）的 endpoint 与 auth_key */
    public function get_primary() {
        $ep = '';
        $key = '';
        $name = '';
        $targets = CFSE_Sync_Transports::get_instance()->get_hosting_targets();
        foreach ($targets as $t) {
            $e = isset($t['endpoint']) ? trim((string) $t['endpoint']) : '';
            if ($e !== '') {
                $ep = $e;
                $key = isset($t['auth_key']) ? (string) $t['auth_key'] : '';
                $name = isset($t['name']) ? (string) $t['name'] : '';
                break;
            }
        }
        if ($ep === '') {
            $ep = (string) get_option('cf_site_url', '');
            $key = (string) get_option('cf_auth_key', '');
        }
        return array('endpoint' => $ep, 'auth_key' => $key, 'name' => $name);
    }

    /** 记录一次成功测试 ⇒ 进入「已连接」状态 */
    public function mark_connected() {
        update_option('cfse_conn_state', 'connected');
        $this->state = 'connected';
    }

    /** 测试失败 ⇒ 退回「已配置」 */
    public function mark_unconnected() {
        if (get_option('cfse_conn_state', '') !== '') {
            update_option('cfse_conn_state', 'configured');
        }
        $this->state = null;
    }

    // ============================================
    // 状态 A：未连接 —— 引导部署
    // ============================================

    /**
     * 「还没连上」这一屏。
     *
     * 主路径是「一键部署 CMS」—— 部署能力从「藏在角落的高级功能」变成 onboarding 的一部分。
     * 教程是次要按钮，不是主路径。
     */
    public function render_screen_none() {
        $rel = CFSE_Sync_Release::get_instance();
        $src = $rel->resolve_source_dir();
        ?>
        <div class="cfse-card cfse-hero">
            <h2 style="margin-top:0;">📡 连接你的自托管 CMS</h2>
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;">
                这个插件负责<b>把 WordPress 的内容同步到你的 Cloudflare Worker CMS</b>。
                你需要先有一份 CMS —— 还没部署的话，跟着下面三步走，五分钟就能跑起来。
            </p>

            <ol class="cfse-steps">
                <li>
                    <b>准备 Cloudflare 账号</b><br/>
                    <span class="cfse-dim">需要一个免费的 Cloudflare 账号（用于部署 Worker、创建 D1 / R2 / KV）。</span>
                </li>
                <li>
                    <b>下载并部署 CMS</b><br/>
                    <span class="cfse-dim">点下面的按钮，插件会从 CMS 官方拉取最新发行包，再用本机 wrangler 推上去。</span>
                </li>
                <li>
                    <b>填连接信息</b><br/>
                    <span class="cfse-dim">把部署好的 Worker 地址和同步密钥填进来，就能开始搬内容了。</span>
                </li>
            </ol>

            <div class="cfse-hero-actions">
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php?action=cf_download_release')); ?>">
                    <?php wp_nonce_field('cf_download_release'); ?>
                    <button type="submit" class="button button-primary button-hero">⬇️ 下载 CMS 发行包</button>
                </form>
                <a class="button" href="<?php echo esc_url(admin_url('options-general.php?page=cfse-sync&cfse_expand=deploy')); ?>">🚀 我要一步步部署（高级）</a>
                <a class="button" href="<?php echo esc_url($rel::DEFAULT_SITE_URL . '/docs/cms-deploy/'); ?>" target="_blank" rel="noopener">📖 看图文教程</a>
            </div>

            <div class="cfse-note">
                💡 <b>已经部署好了？</b> 不用点上面的按钮 —— 直接往下填连接信息就行。
                往下滚动到「② 填连接信息」。
            </div>

            <?php if (isset($_GET['release_dl'])): ?>
                <?php if ($_GET['release_dl'] === '1'): ?>
                    <div class="notice notice-success" style="margin:12px 0 0;"><p>✅ 发行包已下载。接着点「🚀 部署到 Cloudflare」。</p></div>
                <?php else: ?>
                    <div class="notice notice-error" style="margin:12px 0 0;">
                        <p>❌ 下载失败<?php if (!empty($_GET['release_error'])): ?>：<?php echo esc_html(wp_unslash($_GET['release_error'])); ?><?php endif; ?></p>
                    </div>
                <?php endif; ?>
            <?php endif; ?>
        </div>
        <?php
    }

    // ============================================
    // 状态 B：已配置 —— 填连接信息
    // ============================================

    /**
     * 「填了地址但没测过」这一屏。
     */
    public function render_screen_configured() {
        $p = $this->get_primary();
        ?>
        <div class="cfse-card cfse-hero">
            <h2 style="margin-top:0;">🔌 还差一步：确认能连上</h2>
            <p style="font-size:14px;line-height:1.7;margin:0 0 14px;">
                已经填了 CMS 地址，但<b>还没验证过能不能连上</b>。
                点下面的「测试连接」，通过之后就能开始同步内容了。
            </p>

            <table class="cfse-conn-table">
                <tr>
                    <th style="width:110px;">CMS 地址</th>
                    <td><code style="font-size:13px;"><?php echo esc_html($p['endpoint'] !== '' ? $p['endpoint'] : '(还没填)'); ?></code></td>
                </tr>
                <tr>
                    <th>同步密钥</th>
                    <td>
                        <?php if ($p['auth_key'] !== ''): ?>
                            ✅ 已设置
                        <?php else: ?>
                            <span style="color:#a32d2d;">❌ 还没设置</span> —— 密钥在 CMS 后台「⚙️ 设置 → 同步密钥」里看
                        <?php endif; ?>
                    </td>
                </tr>
            </table>

            <div class="cfse-hero-actions">
                <button type="button" class="button button-primary" id="cfse-test-conn">🔌 测试连接</button>
                <span id="cfse-test-conn-result" class="cfse-dim"></span>
            </div>
            <p class="cfse-dim" style="margin:10px 0 0;font-size:12px;">
                地址或密钥要改？到下面的「② 填连接信息」改完保存，再回来测试。
            </p>
        </div>
        <?php
    }

    // ============================================
    // 状态 C：已连接 —— 同步操作
    // ============================================

    /**
     * 「已连上」这一屏 —— 直接是同步操作。
     */
    public function render_screen_connected() {
        $p = $this->get_primary();
        ?>
        <div class="cfse-card cfse-hero cfse-hero-ok">
            <h2 style="margin-top:0;">✅ 已连接<?php echo $p['name'] !== '' ? ' · ' . esc_html($p['name']) : ''; ?></h2>
            <p style="font-size:14px;line-height:1.7;margin:0 0 4px;">
                CMS 在 <code style="font-size:13px;"><?php echo esc_html($p['endpoint']); ?></code>
            </p>
            <p class="cfse-dim" style="margin:0;font-size:12px;">
                内容同步在下面「⚡ 同步内容」里操作。改 URL 结构、模板、外观都在 <b>CMS 后台</b>，不在这里。
            </p>
        </div>
        <?php
    }

    /**
     * 按当前状态渲染对应的那一屏。
     */
    public function render_current_screen() {
        $st = $this->get_state();
        if ($st === 'connected') {
            $this->render_screen_connected();
        } elseif ($st === 'configured') {
            $this->render_screen_configured();
        } else {
            $this->render_screen_none();
        }
    }
}
