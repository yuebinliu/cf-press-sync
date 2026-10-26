<?php
/**
 * CFSE_Sync_Worker_CMS -- D1 / R2 读写、拉取、评论同步等与 Worker 通信的实现。
 *
 * 拆分纪律「只搬不改」：方法体逐字节照搬（含缩进）。
 * 唯一改动：private function -> public function（原为类内自调用，现由主类同名转发方法调用）。
 *
 * @package CFSE
 */

if (!defined('ABSPATH')) {
    exit;
}

if (class_exists('CFSE_Sync_Worker_CMS')) {
    return;
}

class CFSE_Sync_Worker_CMS {

    private static $instance = null;

    /** 与原主类同名属性（PHP 8.2+ 不允许动态属性，显式声明） */
    private $reported_dir_failure = false;
    private $target_modals = array();
    /** 原作于主类；拆出后本类自持（PHP 8.2+ 不允许未声明的静态属性） */
    private static $deleted_post_ids = array();

    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
    }

    /** 桥接：依次查其它拆分包，再回主类（可访问 private） */
    public function __call($name, $args) {
        foreach (array('CFSE_Sync_Transports', 'CFSE_Sync_Admin_UI', 'CFSE_Sync_Worker_CMS') as $cls) {
            if (class_exists($cls)) {
                $o = call_user_func(array($cls, 'get_instance'));
                if (method_exists($o, $name)) {
                    return call_user_func_array(array($o, $name), $args);
                }
            }
        }
        return CFSE_Sync_Plugin::get_instance()->cfse_proxy($name, $args);
    }

    /** 桥接：$this->config -> 主类配置；其余属性反射读主类 */
    public function __get($name) {
        $p = CFSE_Sync_Plugin::get_instance();
        if ($name === 'config') {
            return $p->get_config();
        }
        if (property_exists($p, $name)) {
            $r = new ReflectionProperty($p, $name);
            $r->setAccessible(true);
            return $r->getValue($p);
        }
        return null;
    }

    /** 桥接：日志转发主类 */
    public function log($message, $level = 'INFO') {
        return CFSE_Sync_Plugin::get_instance()->log($message, $level);
    }


    // ============================================
    // 从 Worker 拉取文章（WP 主动拉；Worker → WP 不可达，见 ROADMAP I）
    // ============================================
    /**
     * 拉取 Worker 端诞生的文章（wp_id >= CFSE_WORKER_ID_MIN）。
     * @param bool $overwrite true 时对 WP 中已存在同 ID 的篇用 Worker 版本覆盖（对齐），否则跳过（幂等保护）。
     * @return array [新增数, 更新数, 跳过数, 失败数, Worker 返回总数]
     */
    public function pull_posts_from_worker($overwrite = false) {
        $site = isset($this->config['site_url']) ? rtrim($this->config['site_url'], '/') : '';
        $key = isset($this->config['auth_key']) ? $this->config['auth_key'] : '';
        if ($site === '' || $key === '') {
            $this->log('拉取失败：静态站点 URL 或 Worker Auth Key 未配置', 'ERROR');
            return array(0, 0, 0, 1, 0);
        }
        $url = $site . '/sync/posts?limit=1000&min_wp_id=' . CFSE_WORKER_ID_MIN;
        $resp = wp_remote_get($url, array('timeout' => 60, 'headers' => array('X-Auth-Key' => $key)));
        if (is_wp_error($resp)) {
            $this->log('拉取失败：' . $resp->get_error_message(), 'ERROR');
            return array(0, 0, 0, 1, 0);
        }
        $code = wp_remote_retrieve_response_code($resp);
        if ($code !== 200) {
            $this->log("拉取失败：HTTP {$code} " . substr((string) wp_remote_retrieve_body($resp), 0, 200), 'ERROR');
            return array(0, 0, 0, 1, 0);
        }
        $data = json_decode(wp_remote_retrieve_body($resp), true);
        $items = (is_array($data) && isset($data['posts']) && is_array($data['posts'])) ? $data['posts'] : array();
        $total = count($items);
        $imported = 0;
        $updated = 0;
        $skipped = 0;
        $errors = 0;

        $prev_skip = isset($GLOBALS['cfse_skip_export']) ? $GLOBALS['cfse_skip_export'] : null;
        $GLOBALS['cfse_skip_export'] = true; // 期间不回写 Worker
        foreach ($items as $p) {
            $wid = isset($p['wp_id']) ? (int) $p['wp_id'] : 0;
            if ($wid <= 0) { $errors++; continue; }
            $existing_id = $this->find_post_by_remote_id($wid);
            if ($existing_id) {
                if (!$overwrite) { $skipped++; continue; }
                if ($this->overwrite_post_from_remote($existing_id, $p)) { $updated++; } else { $errors++; }
                continue;
            }
            $fmt = (isset($p['content_format']) && $p['content_format'] === 'md') ? 'md' : 'html';
            // 刻意不用 import_id：那会把 wp_posts 的 AUTO_INCREMENT 顶到时间戳量级（见 AGENTS.md 批L）。
            // 远端 ID 记在 meta `_cfse_remote_wp_id`，导出/删除 D1 时用它 —— 两端数据依然对得上。
            $args = array(
                'post_title' => isset($p['title']) ? (string) $p['title'] : '',
                'post_content' => isset($p['content']) ? (string) $p['content'] : '',
                'post_status' => (isset($p['status']) && $p['status'] === 'published') ? 'publish' : 'draft',
                'post_type' => 'post',
                'post_author' => get_current_user_id() ? get_current_user_id() : 1,
                'meta_input' => array('content_format' => $fmt),
            );
            if (!empty($p['slug'])) $args['post_name'] = (string) $p['slug'];
            if (!empty($p['date'])) $args['post_date'] = (string) $p['date'];
            $new_id = wp_insert_post($args, true);
            if (is_wp_error($new_id)) {
                $errors++;
                $this->log("拉取入库失败 wp_id={$wid}: " . $new_id->get_error_message(), 'ERROR');
                continue;
            }
            update_post_meta($new_id, '_cfse_remote_wp_id', $wid); // 记录远端 wp_id（D1 主键）
            $this->apply_worker_terms($new_id, isset($p['categories']) ? $p['categories'] : '', 'category');
            $this->apply_worker_terms($new_id, isset($p['tags']) ? $p['tags'] : '', 'post_tag');
            $imported++;
        }
        if ($prev_skip === null) unset($GLOBALS['cfse_skip_export']); else $GLOBALS['cfse_skip_export'] = $prev_skip;
        return array($imported, $updated, $skipped, $errors, $total);
    }


    // ============================================
    // Worker 单篇对齐（编辑页「☁️ Worker 同步」面板）
    // ============================================
    /** 拉取 Worker 单篇（/sync/posts?wp_id=），成功返回该篇数组，否则 null */
    public function fetch_worker_post($wp_id) {
        $site = isset($this->config['site_url']) ? rtrim($this->config['site_url'], '/') : '';
        $key = isset($this->config['auth_key']) ? $this->config['auth_key'] : '';
        if ($site === '' || $key === '') return null;
        $resp = wp_remote_get($site . '/sync/posts?wp_id=' . (int) $wp_id, array(
            'timeout' => 30,
            'headers' => array('X-Auth-Key' => $key),
        ));
        if (is_wp_error($resp) || wp_remote_retrieve_response_code($resp) !== 200) return null;
        $data = json_decode(wp_remote_retrieve_body($resp), true);
        if (!is_array($data) || empty($data['posts'][0])) return null;
        return $data['posts'][0];
    }


    // ============================================
    // 删除文章
    // ============================================
    public function delete_post($post_input) {
        if (is_object($post_input)) $post = $post_input;
        else $post = get_post($post_input);
        if (!$post || !isset($post->ID)) return;
        $post_id = $post->ID;
        if (get_post_meta($post_id, '_cfse_probe', true) === '1') {
            $this->log("文章 {$post_id} 为外观探针文章，跳过删除清理", 'DEBUG');
            return;
        }
        if (isset(self::$deleted_post_ids[$post_id])) return;
        self::$deleted_post_ids[$post_id] = true;
        // get_post_storage_path() 已返回含 index.html 的完整文件路径
        $r2_path = $this->get_post_storage_path($post);

        // auto-draft 连 D1 都没有 ⇒ 整段跳过
        if ($post->post_status === 'auto-draft') {
            $this->log("文章 {$post_id} 为 auto-draft，跳过远端清理", 'DEBUG');
            return;
        }
        // 草稿等尚无固定链接的文章路径会退化成 ?p=<ID> ⇒ 没有 R2 单页，但 D1 行是真实存在的（草稿也会入库）
        $has_single = (strpos($r2_path, '?') === false);
        if (!$has_single) {
            $this->log("文章 {$post_id}（{$post->post_status}）无固定链接/无单页，仅清理 D1", 'DEBUG');
        }

        // ① 本地产物：立即删除（无网络，快）—— 之前漏了这一步，导致 cfse-static/ 里残留
        $this->delete_local_artifact($r2_path);

        // ② 远端清理（R2 + D1）：攒到请求结束一次性批量执行。
        //    批量删除 20 篇时，逐篇同步会变成 40 次公网请求（这就是后台删除卡顿的原因）；聚合后只需 2 次。
        if ($has_single) {
            self::$pending_delete_paths[] = $r2_path;
            self::$pending_delete_paths[] = $r2_path . '.gz';
        }
        // D1 里存的是「远端 wp_id」（Worker 端诞生的篇在 WP 侧是自增 ID，映射记在 meta）
        $d1_wp_id = $this->get_remote_wp_id($post_id);
        if (!$d1_wp_id) {
            $d1_wp_id = $post_id;
        } elseif ($this->count_live_siblings($d1_wp_id, $post_id) > 0) {
            // 同一远端 wp_id 还有别的「活着的」WP 文章 ⇒ 本篇是重复副本。
            // 副本沉回收站/被永久删除都不该把线上数据带走 —— 否则清空一次回收站，
            // 保留的那篇就会从 D1 里消失（页面 404），而且不会有任何报错。
            $this->log("文章 {$post_id} 与远端 wp_id={$d1_wp_id} 的其它文章同源（重复副本），只清本地产物、跳过 D1 删除", 'INFO');
            return;
        }
        self::$pending_delete_ids[] = $d1_wp_id;
        if (!self::$pending_deletes_registered) {
            self::$pending_deletes_registered = true;
            add_action('shutdown', array($this, 'flush_pending_deletes'), 5);
        }

        $this->log("文章 {$post_id} 已删除（本地产物已清；远端清理将在本次请求结束时批量执行）", 'INFO');
    }

    /**
     * 还有几篇「活着的」WP 文章指向同一个远端 wp_id（排除 $except_id 自己）。
     *
     * 用途：重复副本保护。同一远端 wp_id 被多份 WP 副本指向时（历史拉取重复），
     * 删掉其中任意一份都不能碰 D1 —— 数据属于仍在的那一份。
     * 两个 meta 键都算（旧插件写 `_cfsh_…`）。
     */
    private function count_live_siblings($remote_wp_id, $except_id) {
        global $wpdb;
        return (int) $wpdb->get_var($wpdb->prepare(
            "SELECT COUNT(DISTINCT pm.post_id) FROM {$wpdb->postmeta} pm
               INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
              WHERE pm.meta_key IN ('_cfse_remote_wp_id', '_cfsh_remote_wp_id')
                AND pm.meta_value = %s
                AND pm.post_id <> %d
                AND p.post_type = 'post' AND p.post_status <> 'trash'",
            (string) $remote_wp_id, (int) $except_id
        ));
    }

    /** 待清理的远端条目（请求结束时一次性批量提交，避免批量删除时逐篇等待 Worker） */
    private static $pending_delete_paths = array();
    private static $pending_delete_ids = array();
    private static $pending_deletes_registered = false;


    /**
     * 请求结束时统一执行「删除文章」的远端清理（R2 单页 + D1 行）。
     *
     * 为什么要攒到 shutdown：批量删 20 篇时逐篇同步 = 40 次公网请求，后台会卡住；
     * 聚合后 R2 一次、D1 一次。
     *
     * ⚠ 本方法曾被模块化重构误删（只留下 add_action 注册、方法体丢失），而
     * cfse_proxy() 找不到方法时**静默返回 null**，于是删除文章后远端永远不清：
     * WP 后台删了、站点上还能访问，D1 里也留着。2026-10-21 真机踩到，此处补回。
     */
    public function flush_pending_deletes() {
        if (empty(self::$pending_delete_paths) && empty(self::$pending_delete_ids)) return;
        $paths = array_values(array_unique(array_filter(self::$pending_delete_paths)));
        $ids   = array_values(array_unique(array_filter(self::$pending_delete_ids)));
        self::$pending_delete_paths = array();
        self::$pending_delete_ids   = array();
        try {
            if (!empty($paths)) $this->delete_from_r2($paths);
            if (!empty($ids)) {
                $this->ensure_d1_schema();
                $stmts = array();
                foreach ($ids as $id) {
                    $stmts[] = array('sql' => 'DELETE FROM post_taxonomy WHERE post_id = ?', 'params' => array($id));
                    $stmts[] = array('sql' => 'DELETE FROM posts WHERE wp_id = ?', 'params' => array($id));
                }
                // 清掉已经没有文章引用的分类/标签，避免站点上留下空分类
                $stmts[] = array('sql' => 'DELETE FROM taxonomies WHERE slug NOT IN (SELECT DISTINCT taxonomy_slug FROM post_taxonomy)', 'params' => array());
                $this->d1_batch($stmts);
            }
            $this->log('批量删除远端清理完成：R2 ' . count($paths) . ' 个路径、D1 ' . count($ids) . ' 篇', 'INFO');
        } catch (\Throwable $e) {
            $this->log('批量删除远端清理异常：' . $e->getMessage(), 'ERROR');
        }
    }


    /**
     * 同步站点**基础信息**到 D1 的 site 行 —— 合并写入（**仅手动触发**）。
     *
     * 2026-09 定稿：
     *   · WP 侧不再自动写 D1（update_option_* 钩子已全部下线），只有设置页点
     *     「🔄 同步站点设置到 D1」才会调用本方法；
     *   · 写入走 Worker `POST /sync/site-info`（X-Auth-Key）—— **服务端合并**：
     *     只更新下面这 6 个基础字段，CMS 后台维护的 menu / layout / docRoutes /
     *     logo / banner / social / comments **永远不会被触碰**。
     *   · 历史坑：旧实现直接发 `INSERT ... ON CONFLICT DO UPDATE SET v = excluded.v`
     *     （整行覆盖），把 CMS 侧独有配置（导航菜单 / 单页布局 / 文档库映射）抹掉过。
     *
     * @return bool 是否有目标写入成功（无具备 d1 能力的目标 ⇒ false）
     */
    public function sync_site_info() {
        $name = function_exists('wp_specialchars_decode')
            ? wp_specialchars_decode((string) get_option('blogname', ''), ENT_QUOTES)
            : (string) get_option('blogname', '');
        $desc = function_exists('wp_specialchars_decode')
            ? wp_specialchars_decode((string) get_option('blogdescription', ''), ENT_QUOTES)
            : (string) get_option('blogdescription', '');
        $gmt_offset = (float) get_option('gmt_offset', 0);
        if ($name === '' && $desc === '') {
            $this->log('站点名与描述均为空，跳过站点信息同步', 'WARNING');
            return false;
        }
        $defAuthor = array('name' => '', 'slug' => '');
        $admins = get_users(array('role' => 'administrator', 'number' => 1, 'orderby' => 'ID', 'order' => 'ASC'));
        if (!empty($admins) && isset($admins[0])) {
            $defAuthor['name'] = (string) $admins[0]->display_name;
            $defAuthor['slug'] = (string) $admins[0]->user_nicename;
        }
        // 2026-10-25 收窄：只推「站点基础信息」。
        //   · 不推 storagePattern —— URL 结构归 CMS 后台管（CMS 侧已拒收该字段）。
        //     以前 WP 每次同步站点信息都把 WP 的 permalink 推上去，
        //     把用户在 CMS 后台改好的 URL 结构覆盖回去。
        //   · 不推 url —— 那是「站点对外地址」（模板里 {{SITE_URL}} 的值），
        //     而 WP 侧的 cf_site_url 其实是「Worker endpoint」（连接地址），语义不同。
        //     连接地址由插件自己存，不走这里。
        $fields = array(
            'name'           => $name,
            'description'    => $desc,
            'timezoneOffset' => (int) round($gmt_offset * 3600),
            'defaultAuthor'  => $defAuthor,
        );
        $res = $this->for_each_target('d1', function ($t) use ($fields) {
            return $this->push_site_info($t, $fields);
        });
        if ($res['tried'] === 0) {
            $this->log('没有启用「D1 数据」能力的托管目标，跳过站点信息同步（纯静态档无需写库）', 'WARNING');
            return false;
        }
        if ($res['ok']) {
            $this->log('已同步站点基础信息到 D1（合并写入）：' . implode(', ', array_keys($fields)), 'INFO');
        } else {
            $this->log('站点基础信息同步失败：' . wp_json_encode($res['results']), 'ERROR');
        }
        return (bool) $res['ok'];
    }


    /** 对单个 cfse-worker 目标推一次 /sync/site-info（服务端合并写入；失败返回 false） */
    private function push_site_info($target, $fields) {
        $type = $this->target_type($target);
        if ($type !== 'cfse-worker') {
            $this->log('托管目标 ' . (isset($target['id']) ? $target['id'] : '?') . ' 的类型 ' . $type . ' 不支持站点信息写入', 'WARNING');
            return false;
        }
        $resp = $this->worker_request($target, '/sync/site-info', 'POST', array('fields' => $fields), 20);
        if ($resp === null) return false;
        $code = (int) wp_remote_retrieve_response_code($resp);
        if ($code < 200 || $code >= 300) {
            $this->log('站点信息写入被拒（HTTP ' . $code . '）：' . wp_remote_retrieve_body($resp), 'ERROR');
            return false;
        }
        return true;
    }


    /** 单个 cfse-worker 目标写库（原 d1_batch 实现，含 CF API 降级兜底） */
    public function worker_d1_batch($target, $statements, $allow_fallback = true) {
        $statements = array_values($statements);
        if (empty($statements)) return array();

        $site_url = rtrim(isset($target['endpoint']) ? (string) $target['endpoint'] : '', '/');
        $auth = isset($target['auth_key']) ? (string) $target['auth_key'] : '';
        if ($site_url !== '' && $auth !== '') {
            // 走进程内复用的 cURL 句柄（keep-alive）：批量同步时单次往返 0.95s → 0.43s。
            // body 仍按原样 JSON，Worker 侧契约未变。
            $r = $this->http_request(
                'POST',
                $site_url . '/d1-batch',
                wp_json_encode(array('statements' => $statements)),
                array('X-Auth-Key: ' . $auth, 'Content-Type: application/json'),
                60
            );
            if ($r !== null) {
                $body = json_decode($r['body'], true);
                if ($r['code'] === 200 && !empty($body['success'])) {
                    $this->log('D1 批量执行 ' . count($statements) . ' 条（Worker）', 'DEBUG');
                    if (isset($body['results']) && is_array($body['results'])) {
                        return $body['results'];
                    }
                    return array_fill(0, count($statements), null);
                }
                $this->log('D1 批量执行失败（HTTP ' . $r['code'] . '），降级为直连 API: ' . (isset($body['error']) ? $body['error'] : '未知'), 'WARNING');
            }
        }

        // 降级：逐句直连 Cloudflare D1 API（保留原有行为作为兜底）
        //
        // ⚠️ 批量上下文（$allow_fallback = false）必须关掉这段：
        //    一条坏语句会让整批 500，若再逐句重放，45 条语句 = 45 次公网往返（~45 秒），
        //    而且调用方随后还会按篇重试 —— 实测 13 篇拖了 154 秒。
        //    批量路径改为「快速失败 → 二分定位 → 单篇才用带降级的 write_to_d1」。
        if (!$allow_fallback) return array();
        $out = array();
        foreach ($statements as $st) {
            $sql = isset($st['sql']) ? (string) $st['sql'] : '';
            $params = isset($st['params']) && is_array($st['params']) ? $st['params'] : array();
            if (preg_match('/^\s*(select|pragma)\b/is', $sql)) {
                $out[] = $this->d1_query($sql, $params);
            } else {
                $out[] = $this->d1_execute($sql, $params) ? null : false;
            }
        }
        return $out;
    }


    /**
     * 迁移 D1 schema 到最新版本（当前 7）。
     * 建表均 IF NOT EXISTS 幂等；迁移前会探测 posts / taxonomies 的实际列，
     * 缺 lang / translation_key / content_format 时幂等 ALTER 补齐。
     * $rebuild_links 为 true 时先重建关联表（旧 v1 → v2：分类/标签关联数据随之清空，提示全量导出）。
     * 迁移完成在 _cfse_meta 记录 schema_version，之后每进程仅一次 meta 读。
     *
     * v7（2026-10-26）：建表语句与 cf-cms 对齐 —— posts/taxonomies 补 lang、translation_key、
     *   去掉 4 个从不被查询计划选中的冗余索引、去掉已下线的 styles 表。
     *   目的不是「升级老站」，而是**别再让新站由插件先建出缺列的库**：CMS 侧
     *   ensureCoreSchema() 也全是 CREATE TABLE IF NOT EXISTS，两边都没有补列逻辑，
     *   插件先建表就永久缺 lang ⇒ CMS 任何带 lang 的读写都 500。
     */
    public function migrate_d1_schema($rebuild_links = false) {
        // 探测 posts / taxonomies 的实际列，缺则幂等 ALTER 补齐。
        //
        // 为什么不能只靠下面的 CREATE TABLE IF NOT EXISTS：
        //   表已存在时那条会被**整条跳过**，而 CMS 侧的 ensureCoreSchema() 也全是
        //   CREATE TABLE IF NOT EXISTS —— 两边都没有补列逻辑。于是「插件先建库、
        //   CMS 后接手」的老站会永远缺 lang / translation_key，之后任何带 lang 的
        //   读写都报 `no such column: lang`，首页直接 500。宁可每次迁移探测一次。
        $probe = $this->d1_batch(array(array(
            'sql' => "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('posts','taxonomies')",
            'params' => array(),
        )));
        $schema_map = array();
        if (is_array($probe) && isset($probe[0]) && is_array($probe[0])) {
            foreach ($probe[0] as $row) {
                if (isset($row['name'])) {
                    $schema_map[(string) $row['name']] = (string) (isset($row['sql']) ? $row['sql'] : '');
                }
            }
        }
        $posts_sql = isset($schema_map['posts']) ? $schema_map['posts'] : '';
        $tax_sql = isset($schema_map['taxonomies']) ? $schema_map['taxonomies'] : '';
        // 表不存在（全新库）→ 不 ALTER，交给下面的 CREATE 建出完整结构
        $col_missing = function ($sql, $col) {
            return $sql !== '' && !preg_match('/\b' . preg_quote($col, '/') . '\b/', $sql);
        };

        $statements = array();
        if ($col_missing($posts_sql, 'content_format')) {
            // 老表（v4 及更早）补列
            $statements[] = array('sql' => "ALTER TABLE posts ADD COLUMN content_format TEXT DEFAULT 'html'", 'params' => array());
        }
        if ($col_missing($posts_sql, 'lang')) {
            // 2026-10-19 i18n 加的两列，老站当时是手工迁移补的
            $statements[] = array('sql' => "ALTER TABLE posts ADD COLUMN lang TEXT NOT NULL DEFAULT 'zh'", 'params' => array());
        }
        if ($col_missing($posts_sql, 'translation_key')) {
            $statements[] = array('sql' => "ALTER TABLE posts ADD COLUMN translation_key TEXT NOT NULL DEFAULT ''", 'params' => array());
        }
        if ($col_missing($tax_sql, 'lang')) {
            $statements[] = array('sql' => "ALTER TABLE taxonomies ADD COLUMN lang TEXT NOT NULL DEFAULT 'zh'", 'params' => array());
        }
        if ($rebuild_links) {
            $statements[] = array('sql' => 'DROP TABLE IF EXISTS taxonomies', 'params' => array());
            $statements[] = array('sql' => 'DROP TABLE IF EXISTS post_taxonomy', 'params' => array());
        }
        $ddl = array(
            "CREATE TABLE IF NOT EXISTS posts (wp_id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, content TEXT, content_format TEXT DEFAULT 'html', excerpt TEXT, date DATETIME NOT NULL, modified DATETIME, status TEXT DEFAULT 'published', comment_status TEXT DEFAULT 'open', categories TEXT, tags TEXT, featured_image TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, lang TEXT NOT NULL DEFAULT 'zh', translation_key TEXT NOT NULL DEFAULT '')",
            "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)",
            "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_login TEXT UNIQUE NOT NULL, user_pass TEXT NOT NULL, user_nicename TEXT, user_email TEXT, user_url TEXT, user_registered DATETIME DEFAULT CURRENT_TIMESTAMP, display_name TEXT, role TEXT DEFAULT 'admin', avatar_url TEXT, user_status INTEGER DEFAULT 1, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, settings TEXT)",
            "CREATE TABLE IF NOT EXISTS taxonomies (type TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, lang TEXT NOT NULL DEFAULT 'zh', PRIMARY KEY (type, slug))",
            "CREATE TABLE IF NOT EXISTS post_taxonomy (post_id INTEGER NOT NULL, taxonomy_type TEXT NOT NULL, taxonomy_slug TEXT NOT NULL, PRIMARY KEY (post_id, taxonomy_type, taxonomy_slug))",
            // 索引只建「查询计划真的会选」的（与 cf-cms 的 schema.sql / ensureCoreSchema 一致）。
            // 下面 4 个已于 2026-10-26 在线上删掉，**别再建回来** —— 索引不是免费的，
            // 每次 INSERT/UPDATE/DELETE 都要同步维护对应 B-Tree，批量同步时是纯写放大
            // （实测单行 UPDATE：posts 7 索引 0.41~0.56ms，5 索引 0.28ms）：
            //   idx_posts_status      与 idx_posts_status_date 前缀重复
            //   idx_posts_slug        与 slug TEXT UNIQUE 的自动索引重复
            //   idx_pt_post            与 post_taxonomy 主键前缀重复
            //   idx_comments_parent    代码只按 comment_id 查父，评论树在 JS 里组装
            "CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date DESC)",
            // 列表页「WHERE status=? ORDER BY date DESC LIMIT n」：缺它会先扫全部已发布
            // 文章再临时排序（取 8 条读 606 行，有它只读 8 行）
            "CREATE INDEX IF NOT EXISTS idx_posts_status_date ON posts(status, date DESC)",
            "CREATE INDEX IF NOT EXISTS idx_posts_lang_status_date ON posts(lang, status, date DESC)",
            "CREATE INDEX IF NOT EXISTS idx_posts_translation ON posts(translation_key)",
            "CREATE INDEX IF NOT EXISTS idx_pt_slug ON post_taxonomy(taxonomy_slug)",
            // styles 表已随「文档库/风格库→R2」重构下线（docs/style-refactor.md）：
            // 模板存 R2 的 tpl.json，线上这张表早已不存在，不再建。
            "CREATE TABLE IF NOT EXISTS app_passwords (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '', pass_hash TEXT NOT NULL, last_used_at TEXT DEFAULT '', created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)",
            "CREATE INDEX IF NOT EXISTS idx_apppw_user ON app_passwords(user_id)",
            "CREATE TABLE IF NOT EXISTS comments (comment_id INTEGER PRIMARY KEY, wp_comment_id INTEGER DEFAULT 0, post_id INTEGER NOT NULL, parent_id INTEGER NOT NULL DEFAULT 0, author TEXT DEFAULT '', author_email TEXT DEFAULT '', author_url TEXT DEFAULT '', avatar TEXT DEFAULT '', date_text TEXT DEFAULT '', date TEXT DEFAULT '', content TEXT DEFAULT '', approved INTEGER NOT NULL DEFAULT 0, type TEXT DEFAULT 'comment', origin TEXT DEFAULT 'wp', updated_at TEXT DEFAULT '')",
            "CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)",
            "INSERT INTO _cfse_meta (k, v) VALUES ('schema_version', '" . (int) self::D1_SCHEMA_VERSION . "') ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        );
        foreach ($ddl as $sql) {
            $statements[] = array('sql' => $sql, 'params' => array());
        }
        $this->d1_batch($statements);

        if ($rebuild_links) {
            $this->log('D1 schema 由 v1 迁移到 v2（复合主键 type+slug），关联表已重建。请做一次“全量导出”重建分类/标签数据。', 'WARNING');
        } else {
            $this->log('D1 schema 已就绪（v' . (int) self::D1_SCHEMA_VERSION . '）', 'DEBUG');
        }
    }


    public function upload_to_r2_via_worker($path, $content, $content_type = 'text/html', $content_encoding = null, $only_ids = null) {
        try {
            // 2026-10-26 移除「调试模式」落盘：CMS 走懒生成（单页现场渲染，不落 HTML 文件），
            // 这条路径现在只剩媒体上传会走，dump 出来的是图片而不是 HTML，留着只会误导。
            // 多托管：对所有「具备静态文件能力」的目标上传
            $res = $this->for_each_target('r2', function ($t) use ($path, $content, $content_type, $content_encoding) {
                return $this->target_upload($t, $path, $content, $content_type, $content_encoding);
            });
            if ($res['tried'] === 0) {
                $this->log('没有启用「静态文件」能力的托管目标，跳过上传：' . $path, 'DEBUG');
            } elseif (!$res['ok']) {
                return false;
            } else {
                $this->log('文件已上传（' . $res['tried'] . ' 个目标）：' . $path . ' → ' . wp_json_encode($res['results']), 'INFO');
            }
            return true;
        } catch (Throwable $e) {
            $this->log("upload_to_r2_via_worker 内部异常：" . $e->getMessage() . " | " . $e->getFile() . ":" . $e->getLine(), "ERROR");
            return false;
        }
    }

    // ============================================
    // D1数据库操作（关联表版本）
    // ============================================
    private static $d1_schema_checked = false;

    /**
     * 确保 D1 表结构为 v2（幂等；每进程只执行一次）。
     * v2：taxonomies 复合主键 (type, slug)；post_taxonomy 增加 taxonomy_type 列 ——
     *     修复同名 category/tag slug（如 'hosting'）互相覆盖、关联数据串扰。
     * 检测到旧结构时自动重建这两张表（posts 数据不动），并在日志提示做一次全量导出重建分类/标签数据。
     */
    /** 当前 D1 schema 版本（迁移链见 ensure_d1_schema / migrate_d1_schema） */
    const D1_SCHEMA_VERSION = 7;


    // ============================================
    // R2上传和媒体同步
    // ============================================
    public function sync_media_files($content) {
        $urls = array();
        preg_match_all('/<img[^>]+(?:src|data-src|data-lazy-src|data-original)=[\'"]?([^\'"\s>]+)/i', $content, $matches);
        if (!empty($matches[1])) $urls = array_merge($urls, $matches[1]);
        if (preg_match_all('/srcset=[\'"]([^\'"]+)[\'"]/i', $content, $sets)) {
            foreach ($sets[1] as $set) {
                foreach (explode(',', $set) as $candidate) {
                    $parts = preg_split('/\s+/', trim($candidate));
                    if (!empty($parts[0])) $urls[] = $parts[0];
                }
            }
        }
        $urls = array_unique($urls);
        if (self::$media_index === null) {
            $m = get_option('cfse_media_index', array());
            self::$media_index = is_array($m) ? $m : array();
        }
        foreach ($urls as $image_url) {
            $image_url = trim(str_replace(array('"', "'"), '', $image_url));
            if (strpos($image_url, home_url()) === false) continue;
            $path = ltrim(parse_url($image_url, PHP_URL_PATH), '/');
            if (empty($path)) continue;

            // 去重：同一张图以前传过、且本地文件「大小+mtime」没变 ⇒ 直接跳过。
            // 旧实现每篇同步都把正文图片重新下载 + 重新上传一遍（无任何存在性检查），
            // 图片多的站会因此慢到不可用。指纹取不到（文件不在本地）时按老行为重传。
            $fp = $this->media_fingerprint($path);
            if ($fp !== '' && isset(self::$media_index[$path]) && self::$media_index[$path] === $fp) continue;

            if ($this->upload_media_to_r2($image_url, $path)) {
                if ($fp !== '') {
                    self::$media_index[$path] = $fp;
                    self::$media_dirty = true;
                }
            }
        }
    }

    /** 已同步图片的指纹表（懒加载；path => "size:mtime"） */
    private static $media_index = null;
    private static $media_dirty = false;

    /** 一次批量跑完后落盘（每篇都写 option 会把 options 表打爆） */
    public function flush_media_index() {
        if (!self::$media_dirty || self::$media_index === null) return;
        if (count(self::$media_index) > 5000) {
            self::$media_index = array_slice(self::$media_index, -5000, null, true);
        }
        update_option('cfse_media_index', self::$media_index, false);
        self::$media_dirty = false;
    }

    /**
     * 本地文件指纹。URL path（wp-content/uploads/...）→ 磁盘文件 → size:mtime。
     * 拿不到文件（外链/被删/CDN 路径）返回空串 ⇒ 调用方按老行为重传，不会漏图。
     */
    private function media_fingerprint($path) {
        $pos = strpos($path, 'wp-content/');
        if ($pos === false) return '';
        $file = WP_CONTENT_DIR . '/' . substr($path, $pos + strlen('wp-content/'));
        if (!is_file($file)) return '';
        $sz = @filesize($file);
        $mt = @filemtime($file);
        if ($sz === false || $mt === false) return '';
        return $sz . ':' . $mt;
    }


    /**
     * 草稿同步：只写 D1（status=draft），不生成单页、不上传 R2。
     * 用途：让 WP 侧的草稿在 Worker 后台也能看到/管理（前台列表只显示 published，不受影响）。
     */
    public function sync_draft_to_d1($post) {
        $meta = $this->build_post_meta($post);
        $meta['post_data']['status'] = 'draft';
        if (empty($meta['post_data']['slug'])) {
            $meta['post_data']['slug'] = 'draft-' . $post->ID;
            $this->log("草稿 {$post->ID} 尚无 slug，使用占位 slug '{$meta['post_data']['slug']}'", 'DEBUG');
        }
        $ok = $this->write_to_d1($meta['post_data'], $meta['categories'], $meta['tags']);
        if ($ok === 'skipped') {
            $this->log("草稿 {$post->ID} 由 Worker 端托管，跳过 D1 写入", 'INFO');
            return 'skipped';
        }
        $this->log("草稿 {$post->ID} 同步到 D1（status=draft）：" . ($ok ? '成功' : '失败'), $ok ? 'INFO' : 'ERROR');
        return (bool) $ok;
    }


    /**
     * 该篇的「家」是否在 Worker 端（归属判据 = wp_id 形态，见 CFSE_WORKER_ID_MIN）。
     * 这类文章由 Worker 侧 writeSinglePage() 渲染单页并维护 D1，WP 导出不得覆盖。
     */
    public function is_worker_owned_post($post) {
        $remote = $this->get_remote_wp_id($post->ID);
        return ($remote && $remote >= CFSE_WORKER_ID_MIN);
    }


    /** 把 Worker 的 JSON 分类/标签（[{name,slug}] 或字符串数组）映射到 WP：按 slug/name 找，缺则创建 */
    public function apply_worker_terms($post_id, $json, $taxonomy) {
        $terms = json_decode((string) $json, true);
        if (!is_array($terms)) $terms = array();
        $ids = array();
        foreach ($terms as $t) {
            if (is_array($t)) {
                $slug = isset($t['slug']) ? (string) $t['slug'] : '';
                $name = isset($t['name']) ? (string) $t['name'] : $slug;
            } else {
                $slug = (string) $t;
                $name = (string) $t;
            }
            if ($slug === '' && $name === '') continue;
            $term = $slug !== '' ? get_term_by('slug', $slug, $taxonomy) : false;
            if (!$term && $name !== '') $term = get_term_by('name', $name, $taxonomy);
            if ($term && !is_wp_error($term)) {
                $ids[] = (int) $term->term_id;
                continue;
            }
            $ins = wp_insert_term($name !== '' ? $name : $slug, $taxonomy, $slug !== '' ? array('slug' => $slug) : array());
            if (is_wp_error($ins)) continue;
            $ids[] = (int) $ins['term_id'];
        }
        if (!empty($ids)) wp_set_object_terms($post_id, $ids, $taxonomy, false);
    }


    /** 按远端 wp_id 找 WP 侧文章 ID（0 = 未找到）—— 拉取幂等判断用 */
    /**
     * 按「远端 wp_id（D1 主键）」找本地 WP 文章。
     *
     * ⚠️ 必须同时认旧键 `_cfsh_remote_wp_id`：
     *   旧插件（cf-static-hosting）拉取时写的是 `_cfsh_…`，新插件是 `_cfse_…`。
     *   只认新键时，老副本查不到 ⇒ 拉取又建一份，slug 被 WP 自动加 `-2`
     *   ⇒ 站上同一个 CMS 文章出现两份（2026-10-27 排查出的 16 对重复正是这个原因）。
     *   命中旧键时顺手补写新键，之后就走快路径。
     *
     * ⚠️ 必须排除回收站里的篇：
     *   重复副本沉进回收站后，meta 仍指向同一个远端 wp_id。若这里把 trash 当成
     *   「本地已有」，`拉取（覆盖）」会把内容写进回收站里那份，活着的正文永远不更新；
     *   反过来按 ID 顺序取也可能挑到 trash ⇒ 每次拉取都白跑一遍。同理 `delete_post()`
     *   靠它判断「是否还有同源活文章」，也必须只认非 trash。
     */
    public function find_post_by_remote_id($remote_wp_id) {
        global $wpdb;
        $id = (int) $remote_wp_id;
        if ($id <= 0) return 0;
        foreach (array('_cfse_remote_wp_id', '_cfsh_remote_wp_id') as $meta_key) {
            $found = $wpdb->get_var($wpdb->prepare(
                "SELECT pm.post_id FROM {$wpdb->postmeta} pm
                   INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id
                  WHERE pm.meta_key = %s AND pm.meta_value = %d
                    AND p.post_type = 'post' AND p.post_status <> 'trash'
                  ORDER BY (p.post_status = 'publish') DESC, p.ID ASC
                  LIMIT 1",
                $meta_key, $id
            ));
            if ($found) {
                if ($meta_key === '_cfsh_remote_wp_id'
                    && (int) get_post_meta((int) $found, '_cfse_remote_wp_id', true) !== $id) {
                    update_post_meta((int) $found, '_cfse_remote_wp_id', $id);
                    $this->log("按旧键 _cfsh_remote_wp_id 命中本地 #{$found}（远端 wp_id={$id}），已补写新键", 'DEBUG');
                }
                return (int) $found;
            }
        }
        return 0;
    }


    /**
     * 该篇在 Worker 端（D1）的 wp_id：有 meta `_cfse_remote_wp_id` 时返回它，否则 0（= WP 本地诞生）。
     * 为什么不拿「WP 文章 ID」当远端 ID：拉取时若用 import_id 对齐 ID，会把 wp_posts 的 AUTO_INCREMENT
     * 顶到时间戳量级，之后 WP 新建的文章 ID 也变成那样（会误判成「Worker 端诞生」，见 AGENTS.md 批L）。
     *
     * 兼容旧键 `_cfsh_remote_wp_id`（旧插件写的），否则老副本会被当成 WP 原生文章
     * ⇒ 导出时拿自己的 ID 去写 D1 ⇒ 撞 `posts.slug` 的 UNIQUE。
     */
    public function get_remote_wp_id($post_id) {
        $v = (int) get_post_meta((int) $post_id, '_cfse_remote_wp_id', true);
        if ($v > 0) return $v;
        $v = (int) get_post_meta((int) $post_id, '_cfsh_remote_wp_id', true);
        return $v > 0 ? $v : 0;
    }


    /**
     * 用 Worker 版本覆盖 WP 现有篇（对齐）。不触发回写导出（内容本就来自 Worker）。
     * 返回 true/false。注意 cfse_skip_export 用「保存-恢复」写法，避免与拉取的短路互相干扰。
     */
    public function overwrite_post_from_remote($post_id, $remote) {
        $fmt = (isset($remote['content_format']) && $remote['content_format'] === 'md') ? 'md' : 'html';
        $args = array(
            'ID' => (int) $post_id,
            'post_title' => isset($remote['title']) ? (string) $remote['title'] : '',
            'post_content' => isset($remote['content']) ? (string) $remote['content'] : '',
        );
        if (!empty($remote['slug'])) $args['post_name'] = (string) $remote['slug'];
        $prev_skip = isset($GLOBALS['cfse_skip_export']) ? $GLOBALS['cfse_skip_export'] : null;
        $GLOBALS['cfse_skip_export'] = true;
        $res = wp_update_post($args, true);
        if (is_wp_error($res)) {
            if ($prev_skip === null) unset($GLOBALS['cfse_skip_export']); else $GLOBALS['cfse_skip_export'] = $prev_skip;
            $this->log('对齐失败 wp_id=' . (int) $post_id . ': ' . $res->get_error_message(), 'ERROR');
            return false;
        }
        update_post_meta($post_id, 'content_format', $fmt);
        if (!empty($remote['wp_id'])) update_post_meta($post_id, '_cfse_remote_wp_id', (int) $remote['wp_id']);
        // wp_update_post() 总是把 post_modified 设成当前时间（参数会被忽略），这里按远端值直接修正：
        // 两端时间一致，「检查」才会显示「✔ 两端一致」而不是一直「本地较新」
        if (!empty($remote['modified'])) {
            global $wpdb;
            $mod = (string) $remote['modified'];
            $wpdb->update(
                $wpdb->posts,
                array('post_modified' => $mod, 'post_modified_gmt' => get_gmt_from_date($mod)),
                array('ID' => (int) $post_id)
            );
            clean_post_cache((int) $post_id);
        }
        $this->apply_worker_terms($post_id, isset($remote['categories']) ? $remote['categories'] : '', 'category');
        $this->apply_worker_terms($post_id, isset($remote['tags']) ? $remote['tags'] : '', 'post_tag');
        if ($prev_skip === null) unset($GLOBALS['cfse_skip_export']); else $GLOBALS['cfse_skip_export'] = $prev_skip;
        return true;
    }


    /**
     * 删除本地产物（CFSE_LOCAL_DIR 下与 R2 key 同构的路径）并顺带清掉产生的空目录。
     */
    public function delete_local_artifact($r2_path) {
        $local = CFSE_LOCAL_DIR . '/' . ltrim($r2_path, '/');
        if (file_exists($local)) {
            if (@unlink($local)) {
                $this->log("本地产物已删除: {$local}", 'DEBUG');
            } else {
                $this->log("本地产物删除失败: {$local}", 'WARNING');
            }
        }
        // 向上清空目录（最多 4 层：年月/slug 等），非空即停
        $dir = dirname($local);
        for ($i = 0; $i < 4; $i++) {
            if (rtrim($dir, '/\\') === rtrim(CFSE_LOCAL_DIR, '/\\') || !is_dir($dir)) break;
            $items = @scandir($dir);
            if ($entries = is_array($items) ? array_diff($items, array('.', '..')) : array()) break;
            if (!@rmdir($dir)) break;
            $dir = dirname($dir);
        }
    }


    /**
     * 同步站点基础信息到 D1 settings（key='site'，JSON：{name,url}）。
     * 站点信息运行时由 Worker 读取（渲染 {{SITE_NAME}}/{{SITE_URL}}），本方法在同步模板/部署时调用。
     */
    /** 清 Worker 端 site:ctx（打包值；site 行与 cache 行任一变化都要清）+ 旧版独立键 */
    public function purge_site_ctx_option() {
        $site_url = isset($this->config['site_url']) ? rtrim($this->config['site_url'], '/') : '';
        $auth = isset($this->config['auth_key']) ? $this->config['auth_key'] : '';
        if ($site_url === '' || $auth === '') return;
        try {
            wp_remote_post($site_url . '/purge-cache', array(
                'timeout'    => 5,
                'sslverify'  => false,
                'headers'    => array('X-Auth-Key' => $auth, 'Content-Type' => 'application/json'),
                'body'       => wp_json_encode(array('keys' => array('site:ctx', 'cache:config', 'rss:feed'))),
            ));
        } catch (Throwable $e) { /* 清理失败不阻断 */ }
    }


    /**
     * 写文章数据：只对「具备 d1 能力」的目标执行。
     * 没有这样的目标（如纯静态档只有 local）⇒ **不联网**，返回等长 null 数组（不算失败）。
     */
    public function d1_batch($statements, $only_ids = null, $allow_fallback = true) {
        $statements = array_values($statements);
        if (empty($statements)) return array();

        $targets = isset($this->config['hosting_targets']) ? $this->config['hosting_targets'] : array();
        $allow = ($only_ids === null) ? null : array_map('strval', (array) $only_ids);
        $usable = array();
        foreach ($targets as $t) {
            if (empty($t['capabilities']['d1'])) continue;
            if ($allow !== null && !in_array((string) (isset($t['id']) ? $t['id'] : ''), $allow, true)) continue;
            $usable[] = $t;
        }
        if (empty($usable)) {
            $this->log('没有启用「D1 数据」能力的托管目标，跳过 ' . count($statements) . ' 条 SQL（纯静态档无需写库）', 'DEBUG');
            return array_fill(0, count($statements), null);
        }
        foreach ($usable as $t) {
            if ($this->target_type($t) === 'cfse-worker') {
                $out = $this->worker_d1_batch($t, $statements, $allow_fallback);
                if (is_array($out) && !empty($out)) return $out;
            } else {
                $this->log('托管目标 ' . (isset($t['id']) ? $t['id'] : '?') . ' 的类型 ' . $this->target_type($t) . ' 尚未实现写库', 'WARNING');
            }
        }
        return array();
    }


    /**
     * 批量执行 SQL（整篇文章一次提交）：
     *   优先走 Worker /d1-batch（D1 binding 近端，一次 HTTP，约几十 ms/批）；
     *   Worker 不可达/未部署时降级为逐句直连 Cloudflare D1 API（慢，仅兜底）。
     *
     * @param array $statements 形如 [ ['sql'=>..., 'params'=>[...]], ... ]
     * @return array|false 每句的查询结果（SELECT 为行数组，写语句为 null）；全部不可用时 false
     */
    public function d1_query($sql, $params = array()) {
        $account_id = $this->config['account_id'];
        $api_token = $this->config['api_token'];
        $database_id = $this->config['d1_database'];
        if (empty($account_id) || empty($api_token) || empty($database_id)) return null;
        $url = "https://api.cloudflare.com/client/v4/accounts/{$account_id}/d1/database/{$database_id}/query";
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(array('sql' => $sql, 'params' => $params)));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, array('Authorization: Bearer ' . $api_token, 'Content-Type: application/json'));
        $response = curl_exec($ch);
        curl_close($ch);
        $resp_data = json_decode($response, true);
        if (empty($resp_data['success']) || empty($resp_data['result'][0]['results'])) return null;
        return $resp_data['result'][0]['results'];
    }


    public function d1_execute($sql, $params = array()) {
        $account_id = $this->config['account_id'];
        $api_token = $this->config['api_token'];
        $database_id = $this->config['d1_database'];
        if (empty($account_id) || empty($api_token) || empty($database_id)) {
            $this->log("D1配置不完整", 'ERROR');
            return false;
        }
        $url = "https://api.cloudflare.com/client/v4/accounts/{$account_id}/d1/database/{$database_id}/query";
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(array('sql' => $sql, 'params' => $params)));
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, array('Authorization: Bearer ' . $api_token, 'Content-Type: application/json'));
        curl_setopt($ch, CURLOPT_TIMEOUT, 30);
        $response = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($http_code >= 400) {
            $this->log("D1查询失败 HTTP {$http_code}: {$sql}", 'ERROR');
            return false;
        }
        $resp_data = json_decode($response, true);
        if (json_last_error() !== JSON_ERROR_NONE || empty($resp_data['success'])) {
            $this->log("D1 API业务错误: " . ($resp_data['errors'][0]['message'] ?? '未知'), 'ERROR');
            return false;
        }
        return true;
    }

    /**
     * 写一篇文章的全部数据到 D1。
     *
     * @return bool|string true = 写入成功；false = 失败（调用方应重试）；
     *                     'skipped' = 该篇由 Worker 端托管，本次**什么都没写**。
     *
     * 为什么要把 'skipped' 和 true 分开（2026-10-21 真机踩坑）：
     *   原来这里 return true，调用方 sync_post_to_d1() 当成「写成功了」，
     *   接着就去 invalidate_single_page() 删 R2 里的单页。可这篇压根没写进 D1，
     *   删掉 R2 之后 Worker 既没有旧页面、D1 里也没有数据 ⇒ 页面直接 404。
     *   真机表现：WP 2121 带着 _cfse_remote_wp_id（历史上「从 Worker 拉取」留下的），
     *   被判定 Worker 托管 → 跳过写入 → 单页被删 → /what-is-cfse-2/ 变 404。
     */
    public function write_to_d1($post_data, $categories, $tags, $only_ids = null) {
        // 归属保护（必须先于任何语句执行）：Worker 端诞生的行整篇不写，连分类/标签关联一起跳过。
        // 只靠下面 posts upsert 的 WHERE 护栏是不够的 —— 那只挡 posts 行，
        // 而 post_taxonomy 的 DELETE 是无条件的，结果会变成「文章行没动、分类关联被删掉再按
        // WP 侧分类重建」。WP 侧若没对上分类（WP 默认分类 slug 就是 uncategorized），
        // 这些文章就全变「未分类」。2026-10-20 演示站 15 篇全变未分类正是这个洞。
        if ((int) $post_data['wp_id'] >= (int) CFSE_WORKER_ID_MIN) {
            $this->log('文章 wp_id=' . (int) $post_data['wp_id'] . ' 由 Worker 端托管，跳过 D1 写入（含分类关联）', 'INFO');
            return 'skipped';
        }

        // 0. 确保表结构存在（幂等）
        $this->ensure_d1_schema();

        // 整篇文章的全部 SQL 打包成一次批量提交（优先 Worker /d1-batch，替代逐句公网 D1 API）
        $statements = $this->build_write_statements($post_data, $categories, $tags);

        $results = $this->d1_batch($statements);
        // 空数组 = 一个可用目标都没写成功（d1_batch 在「无可用目标」时返回等长 null 数组，
        // 只有全部失败才是空）—— 不能当成功，否则会白记 _cfse_synced_d1。
        if (!is_array($results) || !$results) return false;
        foreach ((array) $results as $r) {
            if ($r === false) return false; // 降级路径某句失败
        }
        return true;
    }


    /**
     * 把「一篇文章」要写的全部 SQL 组装成语句数组（不执行）。
     *
     * 相比旧版「每个分类/标签各 2 条 INSERT」：分类与标签改用**多行 VALUES**，
     * 一篇固定 2~4 条语句（不论有几个分类标签）。
     *
     * 为什么这件事很重要：每篇的语句数直接决定一次 /d1-batch 能装几篇，而
     * 公网单次往返实测 0.9~1.3s（TCP 0.21s + TLS 0.24s + 回程），
     * 请求数就是总耗时。10 条/篇 → 4 篇/批；4 条/篇 → 11 篇/批。
     */
    public function build_write_statements($post_data, $categories, $tags, $with_tax = true) {
        $st = array();

        // 1. posts upsert（Worker 端诞生的行不覆盖：WHERE posts.wp_id < CFSE_WORKER_ID_MIN）
        $st[] = array(
            'sql' => "INSERT INTO posts (wp_id, slug, title, content, content_format, excerpt, date, modified, status, comment_status, categories, tags, featured_image)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(wp_id) DO UPDATE SET
                        slug = excluded.slug, title = excluded.title, content = excluded.content,
                        content_format = excluded.content_format,
                        -- excerpt 是派生字段（从正文截 200 字）。正文一字未变时保留 D1 里的旧摘要：
                        -- 否则每次「强制全量」都会按当前算法重算一遍，把上线以来的摘要
                        -- （有的是早期算法/导入时生成的）全部改写 —— 列表页文字会静默变化。
                        -- 正文变了才重算，语义和旧实现一致。
                        excerpt = CASE WHEN posts.content = excluded.content THEN posts.excerpt ELSE excluded.excerpt END,
                        date = excluded.date, modified = excluded.modified, status = excluded.status,
                        comment_status = excluded.comment_status,
                        categories = excluded.categories, tags = excluded.tags, featured_image = excluded.featured_image
                      WHERE posts.wp_id < " . (int) CFSE_WORKER_ID_MIN,
            'params' => array(
                $post_data['wp_id'],
                $post_data['slug'],
                $post_data['title'],
                $post_data['content'],
                isset($post_data['content_format']) ? $post_data['content_format'] : 'html',
                $post_data['excerpt'],
                $post_data['date'],
                $post_data['modified'],
                isset($post_data['status']) ? $post_data['status'] : 'published',
                isset($post_data['comment_status']) ? $post_data['comment_status'] : 'open',
                $post_data['categories'],
                $post_data['tags'],
                $post_data['featured_image'],
            ),
        );

        // 2. 先清旧关联（后续多行 INSERT OR IGNORE 重建，语义与原实现一致）
        //
        // $with_tax = false 时整段跳过：分类/标签没变就没必要「删了再插」。
        // 这一步很值钱 —— D1 每条语句内部约 0.1s，一篇 4 条 → 1 条，全量 318 篇
        // 的语句数从 1272 降到 318（实测整轮从 ~340s 降到 ~40s）。
        if (!$with_tax) {
            return $st;
        }
        $st[] = array('sql' => 'DELETE FROM post_taxonomy WHERE post_id = ?', 'params' => array($post_data['wp_id']));

        // 3. 分类 / 标签：两段多行 VALUES 搞定（v2 复合主键 (type,slug)）
        $tax_rows = array();   // [type, slug, name]
        $pt_rows = array();    // [post_id, type, slug]
        foreach (array('category' => $categories, 'tag' => $tags) as $type => $terms) {
            foreach ((array) $terms as $term) {
                $slug = is_array($term) ? (isset($term['slug']) ? $term['slug'] : '') : (is_object($term) ? $term->slug : '');
                $name = is_array($term) ? (isset($term['name']) ? $term['name'] : $slug) : (is_object($term) ? $term->name : $slug);
                if ($slug === '') continue;
                $tax_rows[] = array($type, $slug, $name);
                $pt_rows[] = array($post_data['wp_id'], $type, $slug);
            }
        }
        if ($tax_rows) {
            $ph = implode(', ', array_fill(0, count($tax_rows), '(?, ?, ?)'));
            $params = array();
            foreach ($tax_rows as $r) { $params[] = $r[0]; $params[] = $r[1]; $params[] = $r[2]; }
            $st[] = array(
                'sql' => 'INSERT INTO taxonomies (type, slug, name) VALUES ' . $ph . ' ON CONFLICT(type, slug) DO UPDATE SET name = CASE WHEN taxonomies.name <> \'\' THEN taxonomies.name ELSE excluded.name END',
                'params' => $params,
            );
        }
        if ($pt_rows) {
            $ph = implode(', ', array_fill(0, count($pt_rows), '(?, ?, ?)'));
            $params = array();
            foreach ($pt_rows as $r) { $params[] = $r[0]; $params[] = $r[1]; $params[] = $r[2]; }
            $st[] = array(
                'sql' => 'INSERT OR IGNORE INTO post_taxonomy (post_id, taxonomy_type, taxonomy_slug) VALUES ' . $ph,
                'params' => $params,
            );
        }

        return $st;
    }

    /**
     * 一批文章一次提交：把所有语句合并进同一条 /d1-batch。
     *
     * ⚠️ 上限：Worker 侧 /d1-batch 用 `statements.slice(0, 50)` 硬截断，
     * 超出的语句会被**静默丢弃**（不报错）。调用方必须自己控住总量
     * （CFSE_Sync_Plugin::BATCH_MAX_STMTS = 45，留 5 条余量）。
     */
    public function write_batch($items) {
        $this->ensure_d1_schema();
        $st = array();
        foreach ($items as $it) {
            if (!empty($it['statements'])) $st = array_merge($st, $it['statements']);
        }
        if (!$st) return true;
        // 第三个参数 false：批量上下文不走「逐句直连 API」的降级。
        // 一条坏语句让整批失败时，由调用方二分定位到单篇，再用带降级的 write_to_d1 兜。
        $res = $this->d1_batch($st, null, false);
        // 同 write_to_d1：空数组代表全部失败，不能当成功
        if (!is_array($res) || !$res) return false;
        foreach ($res as $r) {
            if ($r === false) return false;
        }
        return true;
    }

    /**
     * slug → wp_id 的索引（一次查询，整轮复用）。
     *
     * 为什么需要：`posts.slug` 是 UNIQUE，而 ON CONFLICT 只处理 wp_id 冲突。
     * 如果某篇 WP 文章的 slug 已被 D1 里**另一行**占用（典型：从 CMS 拉下来的同名副本），
     * INSERT 会直接撞 UNIQUE → 整批 500。
     * 提前用一张本地映射判掉，既不会覆盖别人，也不会拖垮整批。
     */
    private static $slug_index = null;

    public function load_slug_index() {
        if (self::$slug_index !== null) return self::$slug_index;
        self::$slug_index = array();
        try {
            $r = $this->d1_batch(array(array('sql' => 'SELECT wp_id, slug FROM posts', 'params' => array())));
            if (is_array($r) && !empty($r[0])) {
                foreach ($r[0] as $row) {
                    self::$slug_index[(string) $row['slug']] = (int) $row['wp_id'];
                }
            }
        } catch (Throwable $e) {
            $this->log('读取 slug 索引失败：' . $e->getMessage(), 'WARNING');
        }
        return self::$slug_index;
    }

    /** 该 slug 当前被哪个 wp_id 占用（0 = 空闲） */
    public function slug_owner($slug) {
        $idx = $this->load_slug_index();
        $k = (string) $slug;
        return isset($idx[$k]) ? (int) $idx[$k] : 0;
    }

    /** 写成功后同步内存映射，避免同一轮里后续文章误判 */
    public function note_slug($slug, $wp_id) {
        if (self::$slug_index === null) return;
        self::$slug_index[(string) $slug] = (int) $wp_id;
    }

    /**
     * 进程内复用的 cURL 句柄（keep-alive）。
     *
     * 实测同一条 /d1-batch：新建连接 0.95~1.32s，复用连接 0.43s。
     * WordPress 的 wp_remote_post() 每次 curl_init() 新句柄，连接不复用 ——
     * 批量同步几十次请求，光握手就多花半分钟。
     */
    private static $http_ch = null;
    private static $http_share = null;

    public function http_request($method, $url, $body = null, $headers = array(), $timeout = 30) {
        if (!function_exists('curl_init')) return null;
        $method = strtoupper($method);
        if (self::$http_ch === null) {
            self::$http_ch = curl_init();
            if (function_exists('curl_share_init')) {
                self::$http_share = @curl_share_init();
                if (self::$http_share) {
                    @curl_share_setopt(self::$http_share, CURLSHOPT_SHARE, CURL_LOCK_DATA_CONNECT);
                    @curl_setopt(self::$http_ch, CURLOPT_SHARE, self::$http_share);
                }
            }
            curl_setopt(self::$http_ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt(self::$http_ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt(self::$http_ch, CURLOPT_SSL_VERIFYHOST, 0);
            curl_setopt(self::$http_ch, CURLOPT_FOLLOWLOCATION, true);
            curl_setopt(self::$http_ch, CURLOPT_ENCODING, '');
        }
        $ch = self::$http_ch;
        // cURL 要的是 ["Name: value"] 列表；调用方给的是关联数组（wp_remote_* 的习惯），
        // 直接塞关联数组会变成「0: Content-Type」这种无效头 ⇒ 认证头丢失 ⇒ 401。
        $header_lines = array();
        foreach ((array) $headers as $k => $v) {
            $header_lines[] = is_int($k) ? (string) $v : ($k . ': ' . $v);
        }
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_TIMEOUT, max(1, (int) $timeout));
        curl_setopt($ch, CURLOPT_HTTPHEADER, $header_lines);
        if ($body === null) {
            curl_setopt($ch, CURLOPT_HTTPGET, true);          // 复位为 GET（清掉上一轮的 body/POST 状态）
            if ($method !== 'GET') curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        } else {
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $resp = curl_exec($ch);
        if ($resp === false) {
            $this->log("HTTP {$method} {$url} 失败：" . curl_error($ch), 'WARNING');
            curl_setopt($ch, CURLOPT_HTTPGET, true);
            return null;
        }
        return array('code' => (int) curl_getinfo($ch, CURLINFO_HTTP_CODE), 'body' => (string) $resp);
    }


    public function upload_media_to_r2($url, $path) {
        $response = wp_remote_get($url, array('timeout' => 60));
        if (is_wp_error($response)) {
            $this->log("媒体下载失败: {$url} - " . $response->get_error_message(), 'WARNING');
            return false;
        }
        $http_code = wp_remote_retrieve_response_code($response);
        if ($http_code >= 400) {
            $this->log("媒体下载失败 HTTP {$http_code}: {$url}", 'WARNING');
            return false;
        }
        $content = wp_remote_retrieve_body($response);
        $content_type = wp_remote_retrieve_header($response, 'content-type');
        if (is_array($content_type)) $content_type = $content_type[0];
        if (empty($content_type)) $content_type = 'application/octet-stream';
        return $this->upload_to_r2_via_worker($path, $content, $content_type, null);
    }




    /**
     * 阶段 1：组装文章元数据（分类/标签 + D1 行数据），不生成 HTML、不联网。
     */
    public function build_post_meta($post) {
        // 分类/标签取结构化数据：name + slug（供条目模板渲染分类/标签行）
        $categories = $this->get_post_terms($post->ID, 'category');
        $tags = $this->get_post_terms($post->ID, 'post_tag');

        // 内容格式：由文章 meta 决定（WP 后台「自定义字段」手填，或 tool/index.php 的「MD」模式写入
        // content_format=md）；字段名与 D1 posts.content_format 同名。缺失即 html —— 零误判，历史文章行为不变。
        $content_format = $this->get_content_format($post->ID);

        // 摘要：md 原稿先渲染成 HTML 再取纯文本，避免摘要里出现 ## 之类的标记
        $excerpt = $post->post_excerpt
            ? ($content_format === 'md' ? $this->md_to_plain($post->post_excerpt) : $post->post_excerpt)
            : $this->extract_excerpt($content_format === 'md' ? $this->md_to_plain($post->post_content) : $post->post_content, 200);

        $post_data = array(
            // D1 的主键 wp_id：Worker 端诞生的篇用它原来的远端 ID（记在 meta），否则用 WP 自身 ID
            'wp_id' => ($this->get_remote_wp_id($post->ID) ?: $post->ID),
            'slug' => $post->post_name,
            'title' => $post->post_title,
            'content' => $post->post_content,
            'content_format' => $content_format,
            'excerpt' => $excerpt,
            'date' => $post->post_date,
            'modified' => $post->post_modified,
            'categories' => wp_json_encode($categories, JSON_UNESCAPED_UNICODE),
            'tags' => wp_json_encode($tags, JSON_UNESCAPED_UNICODE),
            'featured_image' => get_the_post_thumbnail_url($post->ID, 'full') ?: '',
            'status' => ($post->post_status === 'draft' ? 'draft' : 'published'),
            // 文章级评论开关（'open'/'closed'）⇒ 静态站据此决定是否显示评论区与提交表单
            'comment_status' => ($post->comment_status === 'open' ? 'open' : 'closed'),
        );

        return array(
            'post' => $post,
            'post_data' => $post_data,
            'categories' => $categories,
            'tags' => $tags,
        );
    }


    // ============================================
    // 核心：获取文章的实际存储路径
    // ============================================
/**
 * 修复文章存储路径生成
 */
public function get_post_storage_path($post) {
    $permalink = get_permalink($post);
    $home_url = home_url('/');
    $relative = str_replace($home_url, '/', $permalink);
    $relative = trim($relative, '/');
    
    if (empty($relative)) {
        return 'index';
    }
    
    // 提取slug
    $parts = explode('/', $relative);
    $slug = end($parts);
    
    // 2026-10-25：**优先用 CMS 侧的 storagePattern**
    //
    // URL 结构归 CMS 后台管（D1 settings k='site'）。如果这里还用 WP 自己的
    // permalink 推导，用户在 CMS 后台改了结构后，两边算出的 R2 路径就不同：
    //   · WP 去删「WP 算的路径」→ 真实单页（在 CMS 算的路径上）删不掉
    //   · Worker 命中 R2 直接返回、不回查 D1 ⇒ **文章更新不生效**
    //
    // 所以这里从 CMS 拉一次 storagePattern（本地缓存 5 分钟），
    // 拉不到（未连接 / 网络失败）才退回本地 permalink 推导（老行为）。
    $pattern = $this->get_remote_storage_pattern();
    if ($pattern === '') {
        $structure = get_option('permalink_structure');
        $pattern = $this->permalink_to_storage_pattern($structure);
    }
    
    // 提取日期信息
    $year = get_the_date('Y', $post);
    $month = get_the_date('m', $post);
    $day = get_the_date('d', $post);
    
    $path = $pattern;
    $path = str_replace('{year}', $year, $path);
    $path = str_replace('{month}', $month, $path);
    $path = str_replace('{day}', $day, $path);
    $path = str_replace('{slug}', $slug, $path);
    $path = str_replace('{id}', $post->ID, $path);
    
    return $path;
}


/**
 * 从 CMS 拉当前的 storagePattern（URL 结构）。
 *
 * 走 GET /sync/site-info（X-Auth-Key 鉴权，只读）。本地缓存 5 分钟 ——
 * storagePattern 改动极少，但每次同步都拉一次会给 Worker 增加无谓请求。
 *
 * @return string 形如 '{year}/{slug}/index.html'；拉不到返回空串（调用方退回本地推导）
 */
public function get_remote_storage_pattern() {
    $cached = get_transient('cfse_remote_storage_pattern');
    if (is_string($cached) && $cached !== '') return $cached;

    $pattern = '';
    try {
        $res = $this->for_each_target('d1', function ($t) {
            $resp = $this->worker_request($t, '/sync/site-info', 'GET', null, 10);
            if ($resp === null) return '';
            if (wp_remote_retrieve_response_code($resp) !== 200) return '';
            $json = json_decode((string) wp_remote_retrieve_body($resp), true);
            return (is_array($json) && !empty($json['storagePattern'])) ? (string) $json['storagePattern'] : '';
        });
        if (!empty($res['results'])) {
            foreach ($res['results'] as $v) {
                if (is_string($v) && $v !== '') { $pattern = $v; break; }
            }
        }
    } catch (Throwable $e) {
        $this->log('拉取 CMS 的 storagePattern 失败（退回本地推导）：' . $e->getMessage(), 'DEBUG');
    }

    if ($pattern !== '') {
        set_transient('cfse_remote_storage_pattern', $pattern, 300);
    }
    return $pattern;
}


    

/**
 * 修复 Permalink 转存储模式
 */
public function permalink_to_storage_pattern($permalink) {
    if (empty($permalink) || $permalink === '/%postname%/') {
        return '{slug}/index.html';
    }
    
    $pattern = $permalink;
    
    $tags = array(
        '%year%' => '{year}',
        '%monthnum%' => '{month}',
        '%day%' => '{day}',
        '%hour%' => '{hour}',
        '%minute%' => '{minute}',
        '%second%' => '{second}',
        '%postname%' => '{slug}',
        '%post_id%' => '{id}',
        '%category%' => '{category}',
        '%author%' => '{author}',
    );
    
    foreach ($tags as $tag => $replacement) {
        $pattern = str_replace($tag, $replacement, $pattern);
    }
    
    $pattern = trim($pattern, '/');
    return $pattern . '/index.html';
}


    /**
     * 取文章的分类/标签结构化列表：[{name, slug}]
     * ⚠️ WP 数据库中 term slug 对非 ASCII 本身就是小写 URL 编码形态（如中文分类存 %e8%83%a1...），
     *    直接原样入库即可与 Worker 路由/URL 对齐，切勿再 rawurlencode（会二次编码成 %25e8...）。
     */
    public function get_post_terms($post_id, $taxonomy) {
        $out = array();
        $terms = wp_get_post_terms($post_id, $taxonomy, array('fields' => 'all'));
        if (is_wp_error($terms) || empty($terms)) return $out;
        foreach ($terms as $t) {
            $out[] = array('name' => $t->name, 'slug' => $t->slug);
        }
        return $out;
    }


    public function ensure_d1_schema() {
        if (self::$d1_schema_checked) return true;
        self::$d1_schema_checked = true;

        // 1) 确保 meta 表存在并读取 schema 版本（一条批量请求）
        $boot = $this->d1_batch(array(
            array('sql' => 'CREATE TABLE IF NOT EXISTS _cfse_meta (k TEXT PRIMARY KEY, v TEXT)', 'params' => array()),
            array('sql' => "SELECT v FROM _cfse_meta WHERE k = 'schema_version'", 'params' => array()),
        ));
        $version = null;
        if (is_array($boot) && isset($boot[1]) && is_array($boot[1]) && isset($boot[1][0]['v'])) {
            $version = (int) $boot[1][0]['v'];
        }

        // 2) 无版本记录：区分「全新库 / 已是最新结构 / 旧 v1（需重建关联表）」
        $rebuild_links = false;
        if ($version === null) {
            $probe = $this->d1_batch(array(array(
                'sql' => "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('posts','taxonomies','post_taxonomy')",
                'params' => array(),
            )));
            $schema_map = array();
            if (is_array($probe) && isset($probe[0]) && is_array($probe[0])) {
                foreach ($probe[0] as $row) {
                    if (isset($row['name'])) $schema_map[$row['name']] = (string) ($row['sql'] ?? '');
                }
            }
            $has_any = isset($schema_map['posts']) || isset($schema_map['taxonomies']) || isset($schema_map['post_taxonomy']);
            $tax_v2 = isset($schema_map['taxonomies']) && strpos($schema_map['taxonomies'], 'PRIMARY KEY (type, slug)') !== false;
            $pt_v2 = isset($schema_map['post_taxonomy']) && strpos($schema_map['post_taxonomy'], 'taxonomy_type') !== false;

            if ($has_any && $tax_v2 && $pt_v2) {
                // 旧库已具备 v2 基础表（无 meta 记录）：视为 v2，走一次迁移补齐 settings 等新表并记版本
                $version = 2;
            } else {
                $version = 0;
                // 已有表但非 v2 结构（旧 v1）：迁移需重建关联表（posts 数据保留）
                $rebuild_links = $has_any;
            }
        }

        // 3) 版本落后 → 迁移到最新
        if ($version < self::D1_SCHEMA_VERSION) {
            $this->migrate_d1_schema($rebuild_links);
        }
        return true;
    }


    public function extract_excerpt($content, $length = 200) {
        $content = strip_tags($content);
        // 换行换成**空格**再折叠空白，而不是直接删掉 ——
        // 直接删会让相邻段落粘在一起（「开始了。做本本人」），中文尤其明显；
        // 线上既有摘要都是「空格分隔」的形态，这里保持一致。
        $content = str_replace(array('[...]', '&nbsp;'), '', $content);
        $content = preg_replace('/\s+/u', ' ', $content);
        $content = trim($content);
        if (function_exists('mb_strlen')) {
            if (mb_strlen($content) > $length) $content = mb_substr($content, 0, $length) . '...';
        } elseif (strlen($content) > $length) {
            $content = substr($content, 0, $length) . '...';
        }
        return trim($content);
    }


    /** md → 纯文本（渲染后去标签，供摘要/列表用） */
    public function md_to_plain($md) {
        $text = strip_tags($this->render_markdown($md));
        $text = preg_replace('/\s+/u', ' ', $text);
        return trim($text);
    }


    /**
     * 用 vendored Parsedown 渲染 markdown（safe mode 防 XSS）。
     * 类名冲突保护：站点其它插件/主题若已加载 Parsedown，则复用其实现（API 相同）。
     */
    public function render_markdown($md) {
        if (!class_exists('Parsedown')) {
            $file = CFSE_PLUGIN_DIR . 'vendor/parsedown/Parsedown.php';
            if (file_exists($file)) require_once $file;
        }
        if (!class_exists('Parsedown')) {
            $this->log('未找到 Parsedown，md 内容按原文输出', 'WARNING');
            return $md;
        }
        try {
            $parsedown = new Parsedown();
            $parsedown->setSafeMode(true);
            return $parsedown->text($md);
        } catch (Throwable $e) {
            $this->log('Parsedown 渲染失败: ' . $e->getMessage(), 'ERROR');
            return $md;
        }
    }
}
