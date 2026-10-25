<?php
/**
 * CFSE_Sync_Transports -- 传输 / 托管目标实现
 *
 * 本插件只面向「自托管 CMS（Cloudflare Worker + R2 + D1）」这一条链路：
 *   · cloudflare —— 写 D1（/d1-batch）、写 R2（/upload、/delete）、读站点配置
 *   · （其余 provider 归 WP Static Deploy 插件，本插件只对接 CMS）
 * 第三方静态托管（GitHub Pages / GitLab / Netlify / Vercel / FTP / WebDAV / 本地目录）
 * 全部归另一个插件 WP Static Deploy，这里不再实现。
 *
 * @package CFSE
 */

if (!defined('ABSPATH')) {
    exit;
}

if (class_exists('CFSE_Sync_Transports')) {
    return;
}

class CFSE_Sync_Transports {

    private static $instance = null;

    /** 与原主类同名属性：sanitize_hosting_targets 用它标记「目录写入失败已提示过」 */
    private $reported_dir_failure = false;

    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
    }

    
    
    
    
    
    
    
    
    
    /** 目标类型（默认 cfse-worker） */
    public function target_type($target) {
        return isset($target['type']) ? (string) $target['type'] : 'cfse-worker';
    }

    /** 桥接：新类里 $this->config 读取主类配置（transports 方法大量使用） */
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

    /** 桥接：新类里的日志调用转发给主类 */
    public function log($message, $level = 'INFO') {
        return CFSE_Sync_Plugin::get_instance()->log($message, $level);
    }


    /**
     * 目标上某个 key 的**公开访问地址**（public_url 的正确用法）：
     *   worker  ⇒ 优先 public_url（用户配了就用）；未配置返回空串
     *              （公开地址由 Worker 侧决定，不在这里猜）
     * 会带上该目标的 path_prefix。
     */
    public function target_public_url($target, $key) {
        $type = $this->target_type($target);
        if ($type === 'cfse-worker') return '';
        $prefix = isset($target['path_prefix']) ? trim((string) $target['path_prefix'], '/') : '';
        $p = ($prefix !== '' ? $prefix . '/' : '') . ltrim((string) $key, '/');
        $pub = rtrim(isset($target['public_url']) ? (string) $target['public_url'] : '', '/');
        if ($pub !== '') return $pub . '/' . $p;
        return '';
    }


    /** 按类型分派「删除静态文件」；返回 bool */
    public function target_delete($target, $paths) {
        if ($target['type'] === 'cfse-worker') {
            $resp = $this->worker_request($target, '/delete', 'DELETE', array('paths' => array_values($paths)), 30);
            if ($resp === null) return false;
            $code = wp_remote_retrieve_response_code($resp);
            if ($code >= 400) {
                $this->log('托管目标 ' . $target['id'] . ' 删除失败，HTTP ' . $code . '：' . wp_remote_retrieve_body($resp), 'ERROR');
                return false;
            }
            return true;
        }
        $this->log('托管目标 ' . (isset($target['id']) ? $target['id'] : '?') . ' 的类型 ' . $this->target_type($target) . ' 尚未实现删除', 'WARNING');
        return false;
    }


    /** 按类型分派「上传静态文件」；返回 bool */
    public function target_upload($target, $path, $content, $content_type, $content_encoding) {
        if ($target['type'] === 'cfse-worker') {
            $body = array('path' => $path, 'content' => base64_encode($content), 'contentType' => $content_type, 'md5' => md5($content));
            if (!empty($content_encoding)) $body['contentEncoding'] = $content_encoding;
            $resp = $this->worker_request($target, '/upload', 'POST', $body, 30);
            if ($resp === null) return false;
            $code = wp_remote_retrieve_response_code($resp);
            if ($code !== 200) {
                $this->log('托管目标 ' . $target['id'] . ' 上传失败，HTTP ' . $code . '：' . wp_remote_retrieve_body($resp), 'ERROR');
                return false;
            }
            return true;
        }
        $this->log('托管目标 ' . (isset($target['id']) ? $target['id'] : '?') . ' 的类型 ' . $this->target_type($target) . ' 尚未实现上传', 'WARNING');
        return false;
    }


    /** 对某个 cfse-worker 目标发一次带 X-Auth-Key 的 JSON 请求（失败返回 null） */
    public function worker_request($target, $route, $method, $body = null, $timeout = 30) {
        $base = rtrim(isset($target['endpoint']) ? (string) $target['endpoint'] : '', '/');
        $key = isset($target['auth_key']) ? (string) $target['auth_key'] : '';
        $id = isset($target['id']) ? $target['id'] : '?';
        if ($base === '') {
            $this->log('托管目标 ' . $id . ' 未配置 endpoint', 'ERROR');
            return null;
        }
        $args = array(
            'timeout' => $timeout,
            'sslverify' => false,
            'method' => $method,
            'headers' => array('Content-Type' => 'application/json'),
        );
        if ($key !== '') $args['headers']['X-Auth-Key'] = $key;
        if ($body !== null) $args['body'] = wp_json_encode($body);
        $resp = wp_remote_request($base . $route, $args);
        if (is_wp_error($resp)) {
            $this->log('托管目标 ' . $id . ' 请求失败(' . $route . ')：' . $resp->get_error_message(), 'ERROR');
            return null;
        }
        return $resp;
    }


    /**
     * 对「支持 $capability 能力」的目标逐个执行 $send($target)。
     * @param array|null $only_ids 只对这些站点 id 生效（null = 全部目标，保持原有行为）
     * @return array{tried:int, results:array, ok:bool}
     *   tried=0 ⇒ 没有目标具备该能力（例如纯静态档没有 d1）：ok 视为 true（无需执行，不算失败）
     */
    public function for_each_target($capability, $send, $only_ids = null) {
        $targets = isset($this->config['hosting_targets']) ? $this->config['hosting_targets'] : array();
        $results = array();
        $allow = ($only_ids === null) ? null : array_map('strval', (array) $only_ids);
        foreach ($targets as $t) {
            if (empty($t['capabilities'][$capability])) continue;
            if ($allow !== null && !in_array((string) (isset($t['id']) ? $t['id'] : ''), $allow, true)) continue;
            $id = isset($t['id']) ? $t['id'] : ('t' . count($results));
            try {
                $results[$id] = (bool) call_user_func($send, $t);
            } catch (Throwable $e) {
                $this->log('托管目标 ' . $id . ' 调用异常：' . $e->getMessage(), 'ERROR');
                $results[$id] = false;
            }
        }
        return array(
            'tried' => count($results),
            'results' => $results,
            'ok' => empty($results) ? true : in_array(true, $results, true),
        );
    }


    /**
     * 解析托管目标 —— 【热路径】，见 docs/hosting-templates.md §12.1。
     * 热路径只做静默归一化（模板解析 / type 归一 / 能力裁剪），不记"每请求都会重复"的诊断；
     * 但"配置严重错误导致目标被整条跳过"仍记日志（静默跳过比日志噪声更危险）。
     * 返回结构保持与改造前一致（type / capabilities / endpoint / auth_key / path_prefix），下游零改动。
     */
    public function get_hosting_targets($include_disabled = false) {
        $list = array();
        $saved = get_option('cf_hosting_targets', '');
        // 兼容：旧版本因 sanitize 未注册，保存会把表单数组直接序列化进 option（PHP array）。
        // 读到数组时直接采用，避免目标列表被误判为空而退回兜底默认目标。
        if (is_array($saved)) {
            $list = $saved;
        } elseif (is_string($saved) && $saved !== '') {
            $decoded = json_decode($saved, true);
            if (is_array($decoded)) $list = $decoded;
        }
        // A3 兜底优先级：显式默认目标 > 非空列表 > 内置兜底
        if (empty($list)) {
            return array($this->default_worker_target());
        }
        $templates = $this->get_hosting_templates();
        $out = array();
        $usedNumIds = array(); $usedNumDirs = array(); $seenDefaultRt = false;
        foreach ($list as $t) {
            if (!is_array($t)) continue;
            // 运行期只取「已启用」的目标；设置页渲染传 $include_disabled = true ——
            // 否则取消勾选的目标会从界面上消失，用户再保存一次就被真正删除（数据丢失）。
            if (!$include_disabled && isset($t['enabled']) && !$t['enabled']) continue;

            $tid = isset($t['id']) ? $t['id'] : '?';
            // ① 模板解析：新结构 template 优先；仅有旧 type 时按 legacy_type 反查
            $tplId = isset($t['template']) ? (string) $t['template'] : '';
            if ($tplId === '') {
                $legacy = isset($t['type']) ? (string) $t['type'] : '';
                foreach ($templates as $cand => $tp) {
                    if (isset($tp['legacy_type']) && $tp['legacy_type'] === $legacy) { $tplId = $cand; break; }
                }
            }
            // 模板不在本插件的能力表里 ⇒ 跳过（不参与运行期）。
            // 典型来源：从旧版「CF Static Export Pro」带过来的 github / netlify / vercel /
            // ftp / webdav / local 目标 —— 那些能力已归 WP Static Deploy 插件。
            //
            // 这里**故意不写日志**：本方法每个请求都会跑一次，写日志等于每请求追加一行。
            // 需要在后台提示用户时走 get_unsupported_targets()，由设置页一次性展示。
            if ($tplId === '' || !isset($templates[$tplId])) {
                continue;
            }
            $tpl = $templates[$tplId];
            // ② 归一化：以模板为准写回 template / type（保存路径同样重算，并回显给用户 —— §12.4）
            $t['template'] = $tplId;
            $t['type'] = $tpl['legacy_type'];
            // ③ 能力归一化（§12.7）：模板不支持 ⇒ false；支持但未声明 ⇒ 跟随模板默认；已声明 ⇒ 取值
            $caps = (isset($t['capabilities']) && is_array($t['capabilities'])) ? $t['capabilities'] : array();
            $defCaps = isset($tpl['defaults']['capabilities']) ? $tpl['defaults']['capabilities'] : array();
            $norm = array();
            foreach ($tpl['capabilities'] as $k => $limit) {
                if (!$limit) { $norm[$k] = false; continue; }
                $norm[$k] = array_key_exists($k, $caps) ? !empty($caps[$k]) : !empty($defCaps[$k]);
            }
            $t['capabilities'] = $norm;
            // ④ 意图：阶段一只解析（供冷路径校验），热路径不消费
            if (!isset($t['intent']) || !is_array($t['intent'])) {
                $t['intent'] = isset($tpl['defaults']['intent']) ? $tpl['defaults']['intent'] : array();
            }
            if (!isset($t['path_prefix'])) $t['path_prefix'] = '';
            // 站点字段归一化（旧数据无这些字段 ⇒ 就地补齐，幂等）：
            //   id       = 数字（旧字符串 id 依次映射为 1,2,3…）
            //   site_dir = 目录名（旧字符串 id 优先，保持既有产物路径不变）
            //   is_default = 站点级默认（未标记文章走它）
            $legacyId = isset($t['id']) ? (string) $t['id'] : '';
            $numId = (string) max(0, (int) $legacyId);
            if ($numId === '0') $numId = (string) (count($out) + 1);
            while (in_array($numId, $usedNumIds, true)) { $numId = (string) ((int) $numId + 1); }
            $usedNumIds[] = $numId;
            $t['id'] = $numId;
            if (!isset($t['site_dir']) || trim((string) $t['site_dir']) === '') {
                $t['site_dir'] = ($legacyId !== '' && !ctype_digit($legacyId)) ? sanitize_key($legacyId) : $numId;
            }
            $t['site_dir'] = preg_replace('/[^0-9a-zA-Z_-]/', '', (string) $t['site_dir']);
            if ($t['site_dir'] === '') $t['site_dir'] = $numId;
            if (isset($usedNumDirs[$t['site_dir']]) && $usedNumDirs[$t['site_dir']] !== $numId) {
                $t['site_dir'] = $numId;   // 运行期兜底：目录冲突时退回数字 id
            }
            $usedNumDirs[$t['site_dir']] = $numId;
            $t['is_default'] = empty($t['is_default']) ? false : true;
            if (!$seenDefaultRt && $t['is_default']) { $seenDefaultRt = true; } elseif ($t['is_default']) { $t['is_default'] = false; }
            $out[] = $t;
        }
        return $out;
    }


    /**
     * 【冷路径】列出「模板不在本插件能力表里」的目标 —— 仅用于设置页提示。
     *
     * 这些目标不会参与运行期，但**也不会被删除**（sanitize_hosting_targets 会原样保留），
     * 所以需要在界面上明确告诉用户「它们还在，只是本插件不管」。否则用户会以为配置丢了。
     *
     * @return array 每项 array('id','name','template','enabled')
     */
    public function get_unsupported_targets() {
        $saved = get_option('cf_hosting_targets', '');
        if (is_string($saved) && $saved !== '') {
            $decoded = json_decode($saved, true);
            $saved = is_array($decoded) ? $decoded : array();
        }
        if (!is_array($saved)) return array();
        $templates = $this->get_hosting_templates();
        $out = array();
        foreach ($saved as $t) {
            if (!is_array($t)) continue;
            $tpl = isset($t['template']) ? (string) $t['template'] : '';
            if ($tpl !== '' && isset($templates[$tpl])) continue;
            $out[] = array(
                'id'       => isset($t['id']) ? (string) $t['id'] : '',
                'name'     => isset($t['name']) ? (string) $t['name'] : '',
                'template' => $tpl !== '' ? $tpl : (isset($t['type']) ? (string) $t['type'] : '(未指定)'),
                'enabled'  => !empty($t['enabled']),
            );
        }
        return $out;
    }


    /**
     * 内置兜底目标：目标列表为空时使用（A3：显式默认 > 列表 > 兜底）。
     * 能力取 cloudflare 模板的默认值（全开，含 render），保持与改造前一致。
     */
    public function default_worker_target() {
        $tpl = $this->get_hosting_templates();
        $cf = isset($tpl['cloudflare']) ? $tpl['cloudflare'] : null;
        $caps = $cf ? $cf['defaults']['capabilities'] : array('r2' => true, 'd1' => true, 'render' => true, 'cache' => true);
        return array(
            'id' => 'default',
            'name' => '默认（Cloudflare Worker）',
            'template' => 'cloudflare',
            'type' => 'cfse-worker',
            'enabled' => true,
            'endpoint' => rtrim(get_option('cf_site_url', get_site_url()), '/'),
            'auth_key' => get_option('cf_auth_key', ''),
            'path_prefix' => '',
            'capabilities' => $caps,
        );
    }


    /** 【冷路径】把自动修正回显给用户（§12.4：自动修正必须可见）。无变化返回空串。 */
    public function render_adjustments_notice($adjustments) {
        if (empty($adjustments)) return '';
        $parts = array();
        foreach ($adjustments as $a) {
            $from = is_bool($a['from']) ? ($a['from'] ? '开' : '关') : $a['from'];
            $to = is_bool($a['to']) ? ($a['to'] ? '开' : '关') : $a['to'];
            $parts[] = $a['id'] . ' 的 ' . $a['field'] . '：' . $from . ' → ' . $to;
        }
        return '已自动修正 ' . count($adjustments) . ' 处 —— ' . implode('；', $parts) . '。';
    }


    /**
     * 【冷路径】托管目标校验（§6 三层 / §12）—— 只在设置页渲染与保存时调用，热路径不调用。
     * 返回 array(
     *   'warnings'    => array(array('id','key','message','fix')),   // fix: null | array('template','type')
     *   'adjustments' => array(array('id','field','from','to')),     // 仅 $is_save=true 时收集（§12.4 回显）
     * )
     * 日志按 (key, 目标 id) 限流：同一键一次调用只记一条（§12.2）。
     */
    public function validate_hosting_targets($is_save = false, $list_override = null) {
        $templates = $this->get_hosting_templates();
        if (is_array($list_override)) {
            $list = $list_override;
        } else {
            $saved = get_option('cf_hosting_targets', '');
            if (is_array($saved)) {
                $list = $saved;   // 兼容旧数据（见 get_hosting_targets 的同名处理）
            } else {
                $list = is_string($saved) ? json_decode($saved, true) : array();
            }
        }
        if (!is_array($list) || empty($list)) {
            return array('warnings' => array(), 'adjustments' => array());
        }
        $warnings = array(); $adjustments = array(); $logged = array();
        $logOnce = function ($key, $msg) use (&$logged) {
            if (isset($logged[$key])) return;
            $logged[$key] = true;
            $this->log($msg, 'WARNING');
        };
        $union = array('r2' => false, 'd1' => false, 'render' => false, 'cache' => false);
        // 本插件的动作固定为「写 D1 + 写 R2（媒体 / 清旧单页）」，两个能力都是硬需求：
        //   d1 —— 文章数据进云端库，Worker 后台与列表页都读它
        //   r2 —— 正文图片上传 + 更新后删掉旧单页（否则 Worker 一直返回旧页面）
        $wantD1 = true;
        $wantR2 = true;

        foreach ($list as $t) {
            if (!is_array($t)) continue;
            if (isset($t['enabled']) && !$t['enabled']) continue;
            $tid = isset($t['id']) ? $t['id'] : '?';

            // 1) 模板解析（与热路径同规则）：template 优先；仅旧 type 时按 legacy_type 反查
            $tplId = isset($t['template']) ? (string) $t['template'] : '';
            $legacy = isset($t['type']) ? (string) $t['type'] : '';
            if ($tplId === '' && $legacy !== '') {
                foreach ($templates as $cand => $tp) {
                    if (isset($tp['legacy_type']) && $tp['legacy_type'] === $legacy) { $tplId = $cand; break; }
                }
            }
            if ($tplId === '' || !isset($templates[$tplId])) {
                $warnings[] = array('id' => $tid, 'key' => 'unknown_template',
                    'message' => '模板「' . ($tplId !== '' ? $tplId : '未指定') . '」不存在，该目标会被跳过。', 'fix' => null);
                $logOnce('unknown_template:' . $tid, '托管目标 ' . $tid . ' 的模板 ' . ($tplId !== '' ? $tplId : '(未指定)') . ' 不存在');
                continue;
            }
            $tpl = $templates[$tplId];

            // 2) 一致性（C3/C6）：type 与 template 必须匹配
            if ($legacy !== '' && $legacy !== $tpl['legacy_type']) {
                $warnings[] = array('id' => $tid, 'key' => 'mismatch',
                    'message' => 'type=' . $legacy . ' 与 template=' . $tplId . ' 不匹配（预期 type=' . $tpl['legacy_type'] . '）；若刚从旧版本回滚，请确认哪个才是当前意图。',
                    'fix' => array('template', 'type'));
                $logOnce('mismatch:' . $tid, '托管目标 ' . $tid . ' 的 type(' . $legacy . ') 与 template(' . $tplId . ') 不匹配');
            }
            // 3) 保存时重算 type（§12.4）：仅当用户「显式填了不同值」才计入 adjustments
            //    （新结构只写 template、不写 type 属正常 ⇒ 空值静默补全，不提示"已修正"）
            if ($is_save && $legacy !== '' && $legacy !== $tpl['legacy_type']) {
                $adjustments[] = array('id' => $tid, 'field' => 'type', 'from' => $legacy, 'to' => $tpl['legacy_type']);
            }

            // 4) 能力归一（§12.7）+ 超限可见（B6 / B7④）
            $caps = (isset($t['capabilities']) && is_array($t['capabilities'])) ? $t['capabilities'] : array();
            $defCaps = isset($tpl['defaults']['capabilities']) ? $tpl['defaults']['capabilities'] : array();
            $effCaps = array();
            foreach ($tpl['capabilities'] as $k => $limit) {
                if (!$limit) {
                    $effCaps[$k] = false;
                    if (!empty($caps[$k])) {
                        $warnings[] = array('id' => $tid, 'key' => 'over_limit',
                            'message' => '模板「' . $tplId . '」不支持能力「' . $k . '」，保存后将被关闭。', 'fix' => null);
                        $logOnce('over_limit:' . $tid . ':' . $k, '托管目标 ' . $tid . ' 声明了模板不支持的 ' . $k . '，已裁剪');
                        if ($is_save) $adjustments[] = array('id' => $tid, 'field' => 'capabilities.' . $k, 'from' => true, 'to' => false);
                    }
                    continue;
                }
                $effCaps[$k] = array_key_exists($k, $caps) ? !empty($caps[$k]) : !empty($defCaps[$k]);
            }

            // 5) 意图自洽（§6 第二层）
            $intent = $this->normalize_intent((isset($t['intent']) && is_array($t['intent'])) ? $t['intent'] : (isset($tpl['defaults']['intent']) ? $tpl['defaults']['intent'] : array()));
            foreach ($intent as $it) {
                // 集合级检查的"需求"由意图决定（纯静态不需要 d1 ⇒ 不该警告 —— §6）
                foreach ($this->intent_requires($it) as $need) {
                    if (empty($effCaps[$need])) {
                        $msg = '已选意图「' . $it . '」但未启用能力「' . $need . '」' . ($need === 'render' ? '：md 文章不会有静态产出' : '') . '。';
                        $warnings[] = array('id' => $tid, 'key' => 'intent_' . $it . '_' . $need, 'message' => $msg, 'fix' => null);
                        $logOnce('intent:' . $tid . ':' . $it . ':' . $need, '托管目标 ' . $tid . '：' . $msg);
                    }
                }
            }
            foreach ($effCaps as $k => $v) if ($v) $union[$k] = true;
        }

        // 6) 集合级：只能按「意图声明的需求」检查 —— 不能一刀切
        //    （§6：纯静态用户只勾 r2、不勾 d1 是正常状态，不警告）
        if ($wantD1 && !$union['d1']) {
            $warnings[] = array('id' => '(全部目标)', 'key' => 'union_d1',
                'message' => '有目标声明了需要 D1 的意图（服务 md / 动态列表），但没有任何目标具备「文章数据(d1)」能力：'
                           . '文章不会进 D1，Worker 后台与列表页看不到。若本站就是纯静态，请把意图改为「服务静态 HTML」。', 'fix' => null);
            $logOnce('union:d1', '有 d1 意图但无目标具备 d1 能力：文章不会进 D1');
        }
        if ($wantR2 && !$union['r2']) {
            $warnings[] = array('id' => '(全部目标)', 'key' => 'union_r2',
                'message' => '有目标声明了需要文件落点的意图（服务静态 HTML / 备份），但没有任何目标具备「静态文件(r2)」能力：'
                           . '什么都写不出去。', 'fix' => null);
            $logOnce('union:r2', '有 r2 意图但无目标具备 r2 能力：写不出去');
        }

        return array('warnings' => $warnings, 'adjustments' => $adjustments);
    }


    /**
     * 意图归一：兼容两种输入格式 ——
     *   ① 表单键映射：["md" => "1", "static-only" => "1"]
     *   ② 列表（模板 defaults / 已存储）：["md", "static-list"]
     * 返回规范化后的意图名列表。两处（sanitize / validate）共用，避免格式混用漏检。
     */
    public function normalize_intent($raw) {
        $out = array();
        if (!is_array($raw)) return $out;
        foreach ($raw as $k => $v) {
            if (is_int($k)) {
                if (is_string($v) && $v !== '') $out[] = $v;   // 列表格式：值是意图名
            } else {
                if (!empty($v)) $out[] = (string) $k;          // 键映射格式：键是意图名
            }
        }
        return array_values(array_unique($out));
    }


    /**
     * 托管目标列表（多托管配置）。
     *   type：'cfse-worker'（当前唯一实现，走 Worker 的 X-Auth-Key 接口）
     *         —— 本插件只支持 CMS（Cloudflare Worker）一种 provider
     *   capabilities：{ r2: 能存静态文件, d1: 能存文章数据, cache: 支持清缓存 }
     *   enabled=false 忽略。
     * 未配置时用旧设置（cf_site_url + cf_auth_key）自动迁移成一条默认 target ⇒ 行为不变。
     */
    /**
     * 内置托管模板（provider 级）—— 只读，不接受用户写入。
     * 定义 provider 的「能力上限 / 写入机制 / 回滚兼容 type / 需要填的站点字段」。
     * 详见 docs/hosting-templates.md（决策与验收标准）。
     */
    public function get_hosting_templates() {
        return array(
            'cloudflare' => array(
                'id' => 'cloudflare',
                'name' => 'Cloudflare（Worker + R2 + D1）',
                'transport' => 'worker-api',
                'legacy_type' => 'cfse-worker',
                'capabilities' => array('r2' => true, 'd1' => true, 'render' => true, 'cache' => true),
                'intents' => array('md', 'static-list'),
                'defaults' => array(
                    'capabilities' => array('r2' => true, 'd1' => true, 'render' => true, 'cache' => true),
                    'intent' => array('md', 'static-list'),
                ),
                'fields' => array('endpoint', 'auth_key', 'path_prefix', 'public_url'),
            ),
        );
    }


    // ============================================
    // 管理菜单
    // ============================================
    /**
     * 校验并序列化「托管目标」表单：cf_hosting_targets[N][field] → JSON 字符串。
     * 只接受已实现的类型（cfse-worker / local）；旧的 site_url + auth_key 仍作为兜底。
     */
    public function sanitize_hosting_targets($value) {
        if (is_string($value) && $value !== '') {
            $decoded = json_decode($value, true);
            if (is_array($decoded)) $value = $decoded;
        }
        if (!is_array($value)) return '';
        $templates = $this->get_hosting_templates();
        $raw = $value;   // 归一化前的输入：一致性校验与"自动修正回显"要靠它发现用户显式填的冲突（§12.4）
        $out = array();
        // 站点 id / 目录名的分配与查重（见 §2：id 数字自增、site_dir 默认 = id、目录独占）
        $usedIds = array(); $usedDirs = array(); $dirDup = false;
        $nextId = function () use (&$usedIds) {
            $max = 0;
            foreach ($usedIds as $u) { $max = max($max, (int) $u); }
            return (string) ($max + 1);
        };
        $seenDefault = false;
        foreach ($value as $t) {
            if (!is_array($t)) continue;
            // 1) 模板解析（§C1）：template 优先；仅有旧 type 时按 legacy_type 反查
            //    未知模板：不进 $out（运行期同样跳过），由下面的「保留旧数据」步骤兜底。
            $tplId = isset($t['template']) ? (string) $t['template'] : '';
            $legacy = isset($t['type']) ? (string) $t['type'] : '';
            if ($tplId === '' && $legacy !== '') {
                foreach ($templates as $cand => $tp) {
                    if (isset($tp['legacy_type']) && $tp['legacy_type'] === $legacy) { $tplId = $cand; break; }
                }
            }
            if ($tplId === '' || !isset($templates[$tplId])) continue;
            $tpl = $templates[$tplId];
            $name = isset($t['name']) ? sanitize_text_field($t['name']) : '';
            // id：**数字自增**（不可变，文章 meta 用它）；旧数据里的字符串 id 迁移为数字，
            // 原字符串存进 site_dir（目录名保持可读，产物路径不变）。
            $oldIdRaw = isset($t['id']) ? (string) $t['id'] : '';
            $oldId = sanitize_key($oldIdRaw);
            $id = (string) max(0, (int) (isset($t['id']) ? $t['id'] : 0));
            if ($id === '0') {
                $id = $nextId();
            } else {
                while (in_array($id, $usedIds, true)) { $id = (string) max((int) $id, (int) $nextId()); }
            }
            $usedIds[] = $id;
            // site_dir：目录名（仅英文/数字/_/-），留空默认 = 旧字符串 id（若有）否则数字 id
            $dirIn = isset($t['site_dir']) ? trim((string) $t['site_dir']) : '';
            if ($dirIn === '') $dirIn = ($oldId !== '' && !ctype_digit($oldId)) ? $oldId : $id;
            $siteDir = preg_replace('/[^0-9a-zA-Z_-]/', '', $dirIn);
            if ($siteDir === '') $siteDir = $id;
            // 目录查重：重复则自动改为 <数字id>（并记入 adjustments 供回显）
            if (isset($usedDirs[$siteDir])) {
                $siteDir = $id;
                $dirDup = true;
            }
            $usedDirs[$siteDir] = $id;
            // 保存时就把目录建出来（用户填了目录名却看不到目录，会以为没生效）
            if (defined('CFSE_LOCAL_DIR')) {
                $dirPath = CFSE_LOCAL_DIR . '/' . $siteDir;
                if (!is_dir($dirPath)) {
                    if (@mkdir($dirPath, 0755, true)) {
                        // 放置 index.php 防止目录被直接列出（与 CFSE_LOCAL_DIR 自身同策略）
                        @file_put_contents($dirPath . '/index.php', "<?php // Silence is golden.\n");
                    } elseif (!$this->reported_dir_failure) {
                        $this->reported_dir_failure = true;
                        $this->log('创建站点目录失败（请检查 wp-content 可写）：' . $dirPath, 'WARNING');
                    }
                }
            }
            // 2) 能力归一化（§12.7）：模板不支持 ⇒ false；未声明 ⇒ 模板默认；已声明 ⇒ 取值（受上限约束）
            $capsIn = (isset($t['capabilities']) && is_array($t['capabilities'])) ? $t['capabilities'] : array();
            $defCaps = isset($tpl['defaults']['capabilities']) ? $tpl['defaults']['capabilities'] : array();
            $caps = array();
            foreach ($tpl['capabilities'] as $ck => $limit) {
                $caps[$ck] = $limit
                    ? (array_key_exists($ck, $capsIn) ? !empty($capsIn[$ck]) : !empty($defCaps[$ck]))
                    : false;
            }
            // 3) 意图归一化：白名单 ∩ 模板可承接（模板不支持的路线不保存）
            $onIntent = $this->normalize_intent((isset($t['intent']) && is_array($t['intent'])) ? $t['intent'] : $tpl['defaults']['intent']);
            $intent = array();
            foreach (array('md', 'static-list', 'static-only', 'backup') as $ik) {
                if (in_array($ik, $onIntent, true) && in_array($ik, $tpl['intents'], true)) $intent[] = $ik;
            }
            $isDefault = $seenDefault ? false : !empty($t['is_default']);
            if ($isDefault) $seenDefault = true;
            $entry = array(
                'id' => $id,
                'site_dir' => $siteDir,
                'is_default' => $isDefault,
                'name' => $name,
                'template' => $tplId,
                'type' => $tpl['legacy_type'],   // C3 双写：以模板为准重算 ⇒ 正常保存不可能产生不一致
                'enabled' => !empty($t['enabled']),
                'intent' => $intent,
                'path_prefix' => isset($t['path_prefix']) ? sanitize_text_field($t['path_prefix']) : '',
                'capabilities' => $caps,
            );
            if ($tplId === 'cloudflare') {
                $entry['endpoint'] = isset($t['endpoint']) ? esc_url_raw(trim($t['endpoint'])) : '';
                $entry['auth_key'] = isset($t['auth_key']) ? sanitize_text_field($t['auth_key']) : '';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'github') {
                $entry['repo'] = isset($t['repo']) ? sanitize_text_field(trim($t['repo'])) : '';
                $entry['token'] = isset($t['token']) ? sanitize_text_field(trim($t['token'])) : '';
                $br = isset($t['branch']) ? sanitize_text_field(trim($t['branch'])) : '';
                $entry['branch'] = $br !== '' ? $br : 'gh-pages';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'netlify') {
                $entry['site'] = isset($t['site']) ? sanitize_text_field(trim($t['site'])) : '';
                $entry['token'] = isset($t['token']) ? sanitize_text_field(trim($t['token'])) : '';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'vercel') {
                $entry['project'] = isset($t['project']) ? sanitize_text_field(trim($t['project'])) : '';
                $entry['token'] = isset($t['token']) ? sanitize_text_field(trim($t['token'])) : '';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'git') {
                $ab = isset($t['api_base']) && trim($t['api_base']) !== '' ? esc_url_raw(trim($t['api_base'])) : 'https://api.github.com';
                $entry['api_base'] = rtrim($ab, '/');
                $entry['repo'] = isset($t['repo']) ? sanitize_text_field(trim($t['repo'])) : '';
                $entry['token'] = isset($t['token']) ? sanitize_text_field(trim($t['token'])) : '';
                $br = isset($t['branch']) ? sanitize_text_field(trim($t['branch'])) : '';
                $entry['branch'] = $br !== '' ? $br : 'gh-pages';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'gitlab') {
                $entry['project'] = isset($t['project']) ? sanitize_text_field(trim($t['project'])) : '';
                $entry['token'] = isset($t['token']) ? sanitize_text_field(trim($t['token'])) : '';
                $br = isset($t['branch']) ? sanitize_text_field(trim($t['branch'])) : '';
                $entry['branch'] = $br !== '' ? $br : 'gh-pages';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'ftp') {
                $entry['host'] = isset($t['host']) ? sanitize_text_field(trim($t['host'])) : '';
                $entry['port'] = isset($t['port']) && intval($t['port']) > 0 ? intval($t['port']) : 21;
                $entry['user'] = isset($t['user']) ? sanitize_text_field(trim($t['user'])) : '';
                $entry['pass'] = isset($t['pass']) ? (string) $t['pass'] : '';
                $entry['dir'] = isset($t['dir']) ? trim((string) $t['dir']) : '';
                $entry['ftps'] = !empty($t['ftps']);
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } elseif ($tplId === 'webdav') {
                $entry['endpoint'] = isset($t['endpoint']) ? esc_url_raw(trim($t['endpoint'])) : '';
                $entry['user'] = isset($t['user']) ? sanitize_text_field(trim($t['user'])) : '';
                $entry['pass'] = isset($t['pass']) ? (string) $t['pass'] : '';
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            } else { // local
                $entry['dir'] = isset($t['dir']) ? sanitize_text_field(trim($t['dir'])) : '';
                // local 也可配 public_url（本地目录被 web 服务托管时，日志里就能给出可访问地址）
                $entry['public_url'] = isset($t['public_url']) ? esc_url_raw(trim($t['public_url'])) : '';
            }
            $out[] = $entry;
        }
        // 3.5) 保留「本插件不支持的模板」的旧目标 —— 绝不静默删除用户数据。
        //
        // 场景：用户从旧版 CF Static Export Pro 升级过来，库里还有 github / netlify /
        // ftp / webdav / local 的目标。设置页不渲染它们，表单也就不会提交它们；
        // 若这里不做合并，用户随便点一次「保存」这些配置就永久消失了。
        // 处理：从库里读出、原样塞回 $out。运行期 get_hosting_targets() 会跳过它们，
        // 设置页则用 get_unsupported_targets() 明确提示「它们还在，只是本插件不管」。
        $stored = get_option('cf_hosting_targets', '');
        if (is_string($stored) && $stored !== '') {
            $decoded = json_decode($stored, true);
            $stored = is_array($decoded) ? $decoded : array();
        }
        if (is_array($stored)) {
            $keptIds = array();
            foreach ($out as $e) { if (isset($e['id'])) $keptIds[] = (string) $e['id']; }
            foreach ($stored as $st) {
                if (!is_array($st)) continue;
                $stTpl = isset($st['template']) ? (string) $st['template'] : '';
                if ($stTpl !== '' && isset($templates[$stTpl])) continue;   // 支持的模板由表单负责
                if (isset($st['id']) && in_array((string) $st['id'], $keptIds, true)) continue;
                $out[] = $st;
                if (isset($st['id'])) $keptIds[] = (string) $st['id'];
            }
        }
        // 4) 冷路径校验 + 回显（§12.4：自动修正必须可见；警告就地提示）
        $vr = $this->validate_hosting_targets(true, $raw);
        $notice = $this->render_adjustments_notice($vr['adjustments']);
        if ($notice !== '') {
            add_settings_error('cf_hosting_targets', 'cfse_adjusted', $notice, 'warning');
        }
        foreach ($vr['warnings'] as $w) {
            add_settings_error('cf_hosting_targets', 'cfse_warn_' . md5($w['key'] . $w['id']), '⚠ ' . $w['message'], 'warning');
        }
        // 站点地址同步：以「第一个带 endpoint 的 cloudflare 目标」为准，写回全局 cf_site_url
        //   （cf_site_url 还用于 HTML 源站重写 / 站点信息同步 / {{SITE_URL}} / 兜底目标，不能删）
        foreach ($out as $e) {
            if (isset($e['template']) && $e['template'] === 'cloudflare' && !empty($e['endpoint'])) {
                update_option('cf_site_url', rtrim($e['endpoint'], '/'));
                break;
            }
        }
        return wp_json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }


    /** 意图 → 必需能力（docs/hosting-templates.md §5） */
    public function intent_requires($intent) {
        switch ($intent) {
            case 'md':          return array('d1', 'render');
            case 'static-list': return array('d1');
            case 'static-only': return array('r2');
            case 'backup':      return array('r2');
            default:            return array();
        }
    }


}
