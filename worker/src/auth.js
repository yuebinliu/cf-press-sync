/**
 * auth.js —— Worker 管理后台认证
 * - 密码：D1 users.user_pass 存 pbkdf2_sha256$<iter>$<salt_hex>$<hash_hex>（WP 端用 PHP hash_pbkdf2 生成）
 * - 令牌：无状态 JWT（HS256，WebCrypto HMAC），Access 15min / Refresh 7d
 * - 密钥：复用 env.AUTH_KEY_SECRET（站点级秘密；生产建议独立 Secret）
 */

const encoder = new TextEncoder();

function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
}

function hexToBytes(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

function timingSafeEqualStr(a, b) {
    const ba = String(a).toLowerCase();
    const bb = String(b).toLowerCase();
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba.charCodeAt(i) ^ bb.charCodeAt(i);
    return diff === 0;
}

/** 校验用户密码（PBKDF2-SHA256），constant-time 比较 */
export async function verifyPassword(password, stored) {
    if (!password || !stored) return false;
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
    const iterations = parseInt(parts[1], 10);
    if (!(iterations > 0 && iterations <= 1000000)) return false;
    const salt = hexToBytes(parts[2]);
    const expected = String(parts[3]).toLowerCase();
    try {
        const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, key, 256);
        const computed = bytesToHex(new Uint8Array(bits));
        return timingSafeEqualStr(computed, expected);
    } catch (e) {
        return false;
    }
}

/** 由种子/改密使用：生成 pbkdf2 存储串（后续管理端改密用） */
export async function hashPassword(password, iterations = 100000) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations }, key, 256);
    return 'pbkdf2_sha256$' + iterations + '$' + bytesToHex(salt) + '$' + bytesToHex(new Uint8Array(bits));
}

/** 登录：校验用户名密码 + 账号状态；成功返回用户行（不含 user_pass） */
export async function authenticate(db, username, password) {
    const row = await db.prepare('SELECT * FROM users WHERE user_login = ?').bind(String(username || '').trim()).first();
    if (!row) return null;
    if (parseInt(row.user_status, 10) !== 1) return null;
    const ok = await verifyPassword(password, row.user_pass);
    if (!ok) return null;
    return { id: row.id, username: row.user_login, role: row.role, displayName: row.display_name, email: row.user_email };
}

async function jwtKey(secret) {
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(input) {
    const bytes = typeof input === 'string' ? encoder.encode(input) : input;
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** 签发 JWT：payload 中 exp 秒级 */
export async function signJwt(payload, secret, ttlSeconds) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = Object.assign({}, payload, { iat: now, exp: now + ttlSeconds });
    const headB64 = b64url(JSON.stringify(header));
    const bodyB64 = b64url(JSON.stringify(body));
    const key = await jwtKey(secret);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(headB64 + '.' + bodyB64));
    return headB64 + '.' + bodyB64 + '.' + b64url(new Uint8Array(sig));
}

/** 验证 JWT：返回 payload；签名/过期/结构错误返回 null */
export async function verifyJwt(token, secret, expectType) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const key = await jwtKey(secret);
        const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]), encoder.encode(parts[0] + '.' + parts[1]));
        if (!valid) return null;
        const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
        const now = Math.floor(Date.now() / 1000);
        if (!payload.exp || payload.exp < now) return null;
        if (expectType && payload.typ !== expectType) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

/** 取请求头 Bearer token */
export function bearerToken(request) {
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
}

/** 登录限速：IP 每 60s 最多 10 次（isolate 级内存滑窗，0 KV 写入）
 *
 *  2026-10 从「KV 计数」改为内存：原来每次登录都会 `KV.put`（并额外 delete 账号锁键），
 *  属于「站点设置」之外的 KV 用途 —— 与既有的写限速 / 评论限速口径一致。
 *  代价：多 isolate 时各自计数（仍是有效的脚本风暴/撞库防护）。
 */
const LOGIN_RL_MAX = 10;
const LOGIN_RL_WINDOW = 60 * 1000;
const loginRateMap = new Map();

export function loginRateLimit(env, ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    if (loginRateMap.size > 512) {
        loginRateMap.forEach(function (v, k) { if (now >= v.resetAt) loginRateMap.delete(k); });
    }
    const e = loginRateMap.get(key);
    if (!e || now >= e.resetAt) {
        loginRateMap.set(key, { n: 1, resetAt: now + LOGIN_RL_WINDOW });
        return false;
    }
    e.n += 1;
    return e.n > LOGIN_RL_MAX;
}

/* 账号级失败锁定（isolate 级内存，0 KV 写入）：连续 10 次错误锁 15 分钟 */
const FAIL_MAX = 10;
const FAIL_WINDOW = 15 * 60 * 1000;
const failMap = new Map();

export function accountLocked(name) {
    const e = failMap.get(String(name || ''));
    if (!e) return false;
    if (Date.now() >= e.until) { failMap.delete(String(name || '')); return false; }
    return e.n >= FAIL_MAX;
}

/** 记一次失败，返回累计失败次数 */
export function accountFail(name) {
    const key = String(name || '');
    const now = Date.now();
    const e = failMap.get(key);
    if (!e || now >= e.until) {
        failMap.set(key, { n: 1, until: now + FAIL_WINDOW });
        return 1;
    }
    e.n += 1;
    e.until = now + FAIL_WINDOW;   // 持续失败则顺延窗口
    return e.n;
}

export function accountClear(name) {
    failMap.delete(String(name || ''));
}
