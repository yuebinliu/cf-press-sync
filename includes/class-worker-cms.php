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
        if (!$d1_wp_id) $d1_wp_id = $post_id;
        self::$pending_delete_ids[] = $d1_wp_id;
        if (!self::$pending_deletes_registered) {
            self::$pending_deletes_registered = true;
            add_action('shutdown', array($this, 'flush_pending_deletes'), 5);
        }

        $this->log("文章 {$post_id} 已删除（本地产物已清；远端清理将在本次请求结束时批量执行）", 'INFO');
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
    public function worker_d1_batch($target, $statements) {
        $statements = array_values($statements);
        if (empty($statements)) return array();

        $site_url = rtrim(isset($target['endpoint']) ? (string) $target['endpoint'] : '', '/');
        $auth = isset($target['auth_key']) ? (string) $target['auth_key'] : '';
        if ($site_url !== '' && $auth !== '') {
            $resp = wp_remote_post($site_url . '/d1-batch', array(
                'timeout'    => 60,
                'sslverify'  => false,
                'headers'    => array('X-Auth-Key' => $auth, 'Content-Type' => 'application/json'),
                'body'       => wp_json_encode(array('statements' => $statements)),
            ));
            if (!is_wp_error($resp)) {
                $code = wp_remote_retrieve_response_code($resp);
                $body = json_decode(wp_remote_retrieve_body($resp), true);
                if ($code === 200 && !empty($body['success'])) {
                    $this->log('D1 批量执行 ' . count($statements) . ' 条（Worker）', 'DEBUG');
                    if (isset($body['results']) && is_array($body['results'])) {
                        return $body['results'];
                    }
                    return array_fill(0, count($statements), null);
                }
                $this->log('D1 批量执行失败（HTTP ' . $code . '），降级为直连 API: ' . ($body['error'] ?? '未知'), 'WARNING');
            }
        }

        // 降级：逐句直连 Cloudflare D1 API（保留原有行为作为兜底）
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
        foreach ($urls as $image_url) {
            $image_url = trim(str_replace(array('"', "'"), '', $image_url));
            if (strpos($image_url, home_url()) === false) continue;
            $path = ltrim(parse_url($image_url, PHP_URL_PATH), '/');
            if (empty($path)) continue;
            $this->upload_media_to_r2($image_url, $path);
        }
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
            return true;
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
    public function find_post_by_remote_id($remote_wp_id) {
        global $wpdb;
        $found = $wpdb->get_var($wpdb->prepare(
            "SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_cfse_remote_wp_id' AND meta_value = %d LIMIT 1",
            (int) $remote_wp_id
        ));
        return $found ? (int) $found : 0;
    }


    /**
     * 该篇在 Worker 端（D1）的 wp_id：有 meta `_cfse_remote_wp_id` 时返回它，否则 0（= WP 本地诞生）。
     * 为什么不拿「WP 文章 ID」当远端 ID：拉取时若用 import_id 对齐 ID，会把 wp_posts 的 AUTO_INCREMENT
     * 顶到时间戳量级，之后 WP 新建的文章 ID 也变成那样（会误判成「Worker 端诞生」，见 AGENTS.md 批L）。
     */
    public function get_remote_wp_id($post_id) {
        $v = (int) get_post_meta((int) $post_id, '_cfse_remote_wp_id', true);
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
    public function d1_batch($statements, $only_ids = null) {
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
                $out = $this->worker_d1_batch($t, $statements);
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
        $statements = array();

        // 1. 写入 posts
        $statements[] = array(
            // 真 upsert：wp_id 冲突时更新，但「Worker 端诞生」的行（wp_id ≥ CFSE_WORKER_ID_MIN）不覆盖
            // —— 归属判据用 wp_id 形态（WP 文章 = WP post ID；Worker 文章 = 时间戳量级）
            'sql' => "INSERT INTO posts (wp_id, slug, title, content, content_format, excerpt, date, modified, status, comment_status, categories, tags, featured_image)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(wp_id) DO UPDATE SET
                        slug = excluded.slug, title = excluded.title, content = excluded.content,
                        content_format = excluded.content_format, excerpt = excluded.excerpt,
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

        // 2. 删除旧的分类/标签关联
        $statements[] = array('sql' => 'DELETE FROM post_taxonomy WHERE post_id = ?', 'params' => array($post_data['wp_id']));

        // 3+4. 分类 / 标签关联（v2 复合主键 (type,slug)；name 写真名；幂等 upsert + 关联）
        $tax_map = array('category' => $categories, 'tag' => $tags);
        foreach ($tax_map as $type => $terms) {
            foreach ($terms as $term) {
                $slug = is_array($term) ? ($term['slug'] ?? '') : (is_object($term) ? $term->slug : '');
                $name = is_array($term) ? ($term['name'] ?? $slug) : (is_object($term) ? ($term->name ?? '') : $slug);
                if ($slug === '') continue;
                $statements[] = array(
                    'sql' => 'INSERT INTO taxonomies (type, slug, name) VALUES (?, ?, ?) ON CONFLICT(type, slug) DO UPDATE SET name=excluded.name',
                    'params' => array($type, $slug, $name),
                );
                $statements[] = array(
                    'sql' => 'INSERT OR IGNORE INTO post_taxonomy (post_id, taxonomy_type, taxonomy_slug) VALUES (?, ?, ?)',
                    'params' => array($post_data['wp_id'], $type, $slug),
                );
            }
        }

        $results = $this->d1_batch($statements);
        if ($results === false) return false;
        foreach ((array) $results as $r) {
            if ($r === false) return false; // 降级路径某句失败
        }
        return true;
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
        $content = str_replace(array('[...]', '&nbsp;', "\r", "\n"), '', $content);
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
