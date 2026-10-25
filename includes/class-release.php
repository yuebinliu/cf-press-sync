<?php
/**
 * CFSE_Sync_Release —— CMS 发行包的下载 / 解压 / 部署。
 *
 * ## 为什么插件要「下载发行包」而不是内嵌一份 Worker 源码
 *
 * 以前插件内嵌 worker/ 源码副本（19 个文件），部署时整份推上去。问题：
 *   ① 副本必然漂移 —— CMS 仓删了 documents.js / routes.template.js，插件里的
 *      副本还在，部署一次就把已砍掉的功能推回线上（2026-10-25 真的发生过）。
 *   ② 版本对不上 —— 插件版本与 CMS 版本各自演进，没有单一真源。
 *   ③ 插件臃肿 —— 2.2MB，其中 1.7MB 是主题资源。
 *
 * 改成「从 GitHub Releases / 官网下载发行包」后：
 *   · CMS 仓是唯一真源，发版即产出发行包
 *   · 插件永远拿到与 CMS 官方一致的代码
 *   · 插件体积回落到 300KB 级别
 *
 * ## 双源下载（方案 B）
 *
 *   ① GitHub Releases —— https://github.com/<owner>/<repo>/releases/latest
 *      API 拿最新版本号与资产列表
 *   ② 官网 —— 可配置的站点地址，CMS 官方把 tar.gz 挂在自己的站上
 *
 * 两个源都试，先成功的算赢。官网地址可在设置页改，初始值填 https://yuebin.uk
 * （大魔王定的临时值；将来换正式域名不影响 —— 因为下载地址是配置项，不是写死的）。
 *
 * ## 格式：tar.gz（不是 zip）
 *
 * PHP 侧的解压能力差异：
 *   ZipArchive —— 很多服务器没装这个扩展（本机测试服务器就没有）
 *   PharData  —— PHP 自带，普遍可用
 * ⇒ 用 tar.gz，PharData 可解，不依赖任何可选扩展。
 *
 * @package CFSE
 */

if (!defined('ABSPATH')) {
    exit;
}

if (class_exists('CFSE_Sync_Release')) {
    return;
}

class CFSE_Sync_Release {

    private static $instance = null;

    /** 发行包在插件目录里的存放位置 */
    const PACKAGE_DIR = 'cms-package';

    /** 默认下载源（可配置） */
    const DEFAULT_SITE_URL = 'https://yuebin.uk';
    const DEFAULT_GITHUB_REPO = 'cfse/cf-cms';

    /** 官方固定生产地址（作为第三备源；workers.dev 在国内可能被 DNS 污染，
     *  但作为「下载地址字符串」不影响插件逻辑） */
    const DEFAULT_WORKERS_URL = 'https://wp-static-pro.yuebinliu.workers.dev';

    /** 发行包下载后的最大体积（防恶意/异常包） */
    const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

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
    // 下载源配置
    // ============================================

    /**
     * 下载源列表（按优先级）。
     *
     * 每个源返回 array('name' => 可读名, 'url' => 下载地址)。
     * 第一个是 GitHub Releases（需查 API 拿资产 URL），
     * 后两个是直链型（官网 / 固定 workers.dev 地址）。
     *
     * @return array
     */
    public function get_sources() {
        $site = rtrim((string) get_option('cf_cms_package_url', self::DEFAULT_SITE_URL), '/');
        $repo = trim((string) get_option('cf_cms_github_repo', self::DEFAULT_GITHUB_REPO));
        $sources = array();

        if ($repo !== '') {
            $sources[] = array(
                'name' => 'GitHub Releases',
                'type' => 'github',
                'repo' => $repo,
                'url'  => 'https://api.github.com/repos/' . $repo . '/releases/latest',
            );
        }
        if ($site !== '') {
            $sources[] = array(
                'name' => '官网（' . $site . '）',
                'type' => 'direct',
                'url'  => $site . '/downloads/cf-cms-latest.tar.gz',
            );
        }
        $sources[] = array(
            'name' => '固定生产地址',
            'type' => 'direct',
            'url'  => self::DEFAULT_WORKERS_URL . '/downloads/cf-cms-latest.tar.gz',
        );

        return $sources;
    }

    // ============================================
    // 下载
    // ============================================

    /**
     * 从第一个可用源下载发行包。
     *
     * @return array{ok:bool, path?:string, version?:string, source?:string, error?:string}
     */
    public function download() {
        $dir = $this->package_dir();
        if (!wp_mkdir_p($dir)) {
            return array('ok' => false, 'error' => '无法创建发行包目录：' . $dir);
        }

        $errors = array();
        foreach ($this->get_sources() as $src) {
            $this->log('尝试从「' . $src['name'] . '」下载 CMS 发行包…', 'INFO');
            $res = $this->download_from($src);
            if (!empty($res['ok'])) {
                $this->log('✓ 发行包下载完成（来源：' . $src['name'] . '，' . $res['version'] . '，'
                    . round($res['size'] / 1024) . ' KB）', 'INFO');
                return $res;
            }
            $this->log('✗ ' . $src['name'] . ' 下载失败：' . $res['error'], 'WARNING');
            $errors[] = $src['name'] . '：' . $res['error'];
        }
        return array('ok' => false, 'error' => '所有下载源都失败了 —— ' . implode('；', $errors));
    }

    /**
     * 从单个源下载。
     *
     * @param array $src 源描述
     * @return array
     */
    private function download_from($src) {
        $url = $src['url'];
        $version = '';

        if ($src['type'] === 'github') {
            $asset = $this->resolve_github_asset($src['repo']);
            if (empty($asset['ok'])) {
                return array('ok' => false, 'error' => $asset['error']);
            }
            $url = $asset['url'];
            $version = $asset['version'];
        }

        $resp = wp_remote_get($url, array(
            'timeout' => 120,
            'redirection' => 5,
            'headers' => array(
                'User-Agent' => 'CFSE-Sync/' . CFSE_VERSION . ' (WordPress plugin)',
                'Accept'     => 'application/octet-stream, application/gzip, */*',
            ),
        ));
        if (is_wp_error($resp)) {
            return array('ok' => false, 'error' => $resp->get_error_message());
        }
        $code = (int) wp_remote_retrieve_response_code($resp);
        if ($code !== 200) {
            return array('ok' => false, 'error' => 'HTTP ' . $code);
        }
        $body = wp_remote_retrieve_body($resp);
        if (!is_string($body) || $body === '') {
            return array('ok' => false, 'error' => '响应为空');
        }
        if (strlen($body) > self::MAX_PACKAGE_BYTES) {
            return array('ok' => false, 'error' => '包体积异常（' . round(strlen($body) / 1024) . ' KB）');
        }
        // gzip 魔数校验（1f 8b）—— 避免把一个 404 HTML 页当成发行包存下来
        if (substr($body, 0, 2) !== "\x1f\x8b") {
            return array('ok' => false, 'error' => '返回的不是 gzip 包（可能地址不对）');
        }

        $path = $dir . '/cf-cms-' . ($version !== '' ? $version : 'latest') . '.tar.gz';
        if (@file_put_contents($path, $body) === false) {
            return array('ok' => false, 'error' => '写入文件失败：' . $path);
        }
        if ($version === '') {
            $version = $this->guess_version_from_package($path);
        }

        return array(
            'ok' => true,
            'path' => $path,
            'version' => $version,
            'size' => strlen($body),
            'source' => $src['name'],
        );
    }

    /**
     * 查 GitHub Releases 的最新资产（找 .tar.gz）。
     *
     * @param string $repo owner/name
     * @return array{ok:bool, url?:string, version?:string, error?:string}
     */
    private function resolve_github_asset($repo) {
        $api = 'https://api.github.com/repos/' . $repo . '/releases/latest';
        $resp = wp_remote_get($api, array(
            'timeout' => 20,
            'headers' => array(
                'User-Agent' => 'CFSE-Sync/' . CFSE_VERSION,
                'Accept'     => 'application/vnd.github+json',
            ),
        ));
        if (is_wp_error($resp)) {
            return array('ok' => false, 'error' => $resp->get_error_message());
        }
        if ((int) wp_remote_retrieve_response_code($resp) !== 200) {
            return array('ok' => false, 'error' => 'GitHub API 返回 HTTP ' . wp_remote_retrieve_response_code($resp)
                . '（仓库可能还没发布 Release，或仓库名配错了）');
        }
        $json = json_decode((string) wp_remote_retrieve_body($resp), true);
        if (!is_array($json) || empty($json['tag_name'])) {
            return array('ok' => false, 'error' => 'GitHub API 返回格式异常');
        }
        $version = ltrim((string) $json['tag_name'], 'v');
        $assets = isset($json['assets']) && is_array($json['assets']) ? $json['assets'] : array();
        // 优先 .tar.gz，退而求其次 .tgz / .zip
        $pick = null;
        $fallback = null;
        foreach ($assets as $a) {
            if (!isset($a['name'], $a['browser_download_url'])) continue;
            $name = strtolower((string) $a['name']);
            if (substr($name, -7) === '.tar.gz' || substr($name, -4) === '.tgz') {
                $pick = $a['browser_download_url'];
                break;
            }
            if ($fallback === null && substr($name, -4) === '.zip') {
                $fallback = $a['browser_download_url'];
            }
        }
        if ($pick === null) $pick = $fallback;
        if ($pick === null) {
            return array('ok' => false, 'error' => 'Release ' . $json['tag_name'] . ' 里没有发行包资产（.tar.gz）');
        }
        return array('ok' => true, 'url' => $pick, 'version' => $version);
    }

    /** 从包文件名里猜版本号（直链源没有版本信息时用） */
    private function guess_version_from_package($path) {
        $base = basename($path, '.tar.gz');
        if (preg_match('/(\d+\.\d+\.\d+)/', $base, $m)) {
            return $m[1];
        }
        return 'unknown';
    }

    // ============================================
    // 解压
    // ============================================

    /**
     * 解压发行包到目标目录（先清空旧内容，保证与发行包完全一致）。
     *
     * @param string $pkg  包路径
     * @param string $dest 目标目录
     * @return array{ok:bool, error?:string, files?:int}
     */
    public function extract($pkg, $dest) {
        if (!file_exists($pkg)) {
            return array('ok' => false, 'error' => '发行包不存在：' . $pkg);
        }
        if (!class_exists('PharData')) {
            return array('ok' => false, 'error' => '服务器缺少 PharData 扩展，无法解压（请改用手动部署）');
        }

        // 清空目标目录
        $this->rrmdir($dest);
        if (!wp_mkdir_p($dest)) {
            return array('ok' => false, 'error' => '无法创建目标目录：' . $dest);
        }

        try {
            $phar = new PharData($pkg);
            $phar->extractTo($dest, null, true);
            unset($phar);
        } catch (Exception $e) {
            return array('ok' => false, 'error' => '解压失败：' . $e->getMessage());
        } catch (Throwable $e) {
            return array('ok' => false, 'error' => '解压失败：' . $e->getMessage());
        }

        // 校验关键文件在不在
        foreach (array('src/index.js', 'src/routes.js', 'package.json') as $must) {
            if (!file_exists($dest . '/' . $must)) {
                return array('ok' => false, 'error' => '发行包不完整（缺 ' . $must . '）');
            }
        }

        $files = 0;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dest, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            if ($f->isFile()) $files++;
        }
        return array('ok' => true, 'files' => $files);
    }

    /** 递归删除目录（只用于插件自己的 cms-package/ 目录） */
    private function rrmdir($dir) {
        if (!is_dir($dir)) return;
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $f) {
            if ($f->isDir()) {
                @rmdir($f->getPathname());
            } else {
                @unlink($f->getPathname());
            }
        }
        @rmdir($dir);
    }

    // ============================================
    // 路径
    // ============================================

    /** 发行包存放目录 */
    public function package_dir() {
        return CFSE_PLUGIN_DIR . self::PACKAGE_DIR;
    }

    /** 解压后的 Worker 源码目录（部署时用这个） */
    public function source_dir() {
        return $this->package_dir() . '/cf-cms';
    }

    /**
     * 当前可用的 Worker 源码目录。
     *
     * 优先用已下载的发行包；没有则回落到插件内嵌的 worker/ 目录
     * （向后兼容 —— 老版本插件的 worker/ 副本还能部署，但会漂移）。
     *
     * @return array{dir:string, source:string, note:string}
     */
    public function resolve_source_dir() {
        $pkg_src = $this->source_dir();
        if (file_exists($pkg_src . '/src/index.js')) {
            return array(
                'dir'    => $pkg_src,
                'source' => '发行包',
                'note'   => '使用已下载的 CMS 发行包（版本与官方一致）',
            );
        }
        return array(
            'dir'    => CFSE_PLUGIN_DIR . 'worker',
            'source' => '内嵌副本',
            'note'   => '⚠️ 尚未下载发行包，正在用插件内嵌的旧副本 —— 它可能与官方 CMS 不一致，建议先下载发行包',
        );
    }
}
