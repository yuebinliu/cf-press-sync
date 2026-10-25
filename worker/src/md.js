import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown → HTML（渲染出口统一走这里；失败原样返回） */
export function mdToHtml(src) {
    try {
        const out = marked.parse(String(src || ''));
        return typeof out === 'string' ? out : String(out || '');
    } catch (e) {
        return String(src || '');
    }
}

/** Markdown → 纯文本（用于摘要 excerpt；剥标签与图片链接） */
export function mdToText(src, maxLen = 200) {
    try {
        const html = mdToHtml(src);
        const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
    } catch (e) {
        return '';
    }
}
