/**
 * R2 key 规范：存储 key 一律是「解码后的原文」。
 *
 * 为什么：Worker 的 `url.pathname` 保留 percent-encoding（`%xx`），而对象存储里的名字是
 * **解码后**的字符串 —— 浏览器请求 `/中文名/` 时发的是 `%xx`，R2/S3 会解码后匹配。
 * 所以「存储 key = 原文」这一侧才与访问行为一致（插件侧的 s3 直连也用同一规范）。
 *
 * 用法约束（很重要）：
 *   - 只用于「URL 形态」的输入：`url.pathname`、插件上传时传来的 storagePath、D1 里 `%xx` 形态的 slug。
 *   - **不要**用于「已经是存储 key」的输入（例如 `list()` 返回的 `o.key`、KV 里记录的旧 key）——
 *     那些已经是原文，再解码会破坏含 `%` 的名字。
 */

/** URL 形态 → R2 存储 key（原文）。非法输入返回 null。 */
export function r2KeyFromPath(p) {
    let s = (p == null) ? '' : String(p);
    s = s.replace(/^\/+/, '');                       // R2 key 不带前导斜杠
    if (s === '') return null;

    let decoded;
    try {
        decoded = decodeURIComponent(s);              // 非法转义（如 %zz）会抛 URIError
    } catch (e) {
        decoded = s;                                  // 回退：保留原样（与 PHP rawurldecode 的语义一致）
    }

    // 防穿越：解码后不得出现 `.` / `..` / NUL 段（同时挡住 %2E%2E、%2F 组合绕过）
    const segs = decoded.split('/');
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (seg === '.' || seg === '..') return null;
        if (seg.indexOf('\0') !== -1) return null;
    }
    return decoded;
}

/** R2 存储 key → URL 路径（逐段 percent-encoding，用于返回给客户端的 URL）。 */
export function r2UrlPath(key) {
    return String(key == null ? '' : key)
        .split('/')
        .map(function (seg) { return encodeURIComponent(seg); })
        .join('/');
}
