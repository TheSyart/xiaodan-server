// 访问控制。
//
// 有两种模式,由 XIAODAN_AUTH_MODE 决定:
//
//   proxy(默认)——【本部署实际使用的】把鉴权完全交给前面的运维面板。
//     面板在 nginx 层用 auth_request 拦截,未登录的请求根本到不了这里;
//     通过的请求里不带任何身份信息,应用只需知道"它已经被放行"。
//     所以控制台自己不再有账号、密码、会话、登录页 —— 一套凭据总比两套好记,
//     也少一处可以被撞库的入口。
//
//   local —— 控制台自己管一个管理员账号。给"还没接进面板"或本地开发用。
//     密码 scrypt 派生,会话只存 token 的 SHA-256。
//
// proxy 模式的安全前提有两条,缺一不可:
//   1. 容器只发布回环端口(compose 里是 127.0.0.1:8002);
//   2. nginx 是唯一公网入口,且该站点已被面板接管并启用统一 Auth。
// 这两条也正是运维面板对所有受管应用的假设。

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Db } from './db.ts';
import { one, run } from './db.ts';

const COOKIE = 'xiaodan_session';
const SESSION_HOURS = 12;
const SCRYPT_KEYLEN = 64;

export type AuthMode = 'proxy' | 'local';

export function authMode(): AuthMode {
  return process.env.XIAODAN_AUTH_MODE === 'local' ? 'local' : 'proxy';
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  // 定长比较,避免用比较耗时泄露信息
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function isInitialized(conn: Db): boolean {
  return one(conn, 'SELECT 1 FROM admin WHERE id = 1') !== undefined;
}

export function setAdmin(conn: Db, username: string, password: string): void {
  run(
    conn,
    `INSERT INTO admin (id, username, password_hash) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET username = excluded.username,
                                    password_hash = excluded.password_hash,
                                    updated_at = datetime('now')`,
    username,
    hashPassword(password),
  );
  // 改密码即注销所有会话:否则旧 Cookie 还能继续用,改密码就失去了意义。
  run(conn, 'DELETE FROM sessions');
}

/** 清除本地账号与全部会话。切到 proxy 模式后用它把残留凭据擦掉。 */
export function clearLocalAdmin(conn: Db): void {
  run(conn, 'DELETE FROM admin');
  run(conn, 'DELETE FROM sessions');
}

export function login(conn: Db, username: string, password: string): string | undefined {
  const admin = one<{ username: string; password_hash: string }>(
    conn,
    'SELECT username, password_hash FROM admin WHERE id = 1',
  );
  if (!admin || admin.username !== username) return undefined;
  if (!verifyPassword(password, admin.password_hash)) return undefined;

  const token = randomBytes(32).toString('base64url');
  run(
    conn,
    `INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', '+' || ? || ' hours'))`,
    tokenHash(token),
    SESSION_HOURS,
  );
  return token;
}

export function logout(conn: Db, token: string | undefined): void {
  if (!token) return;
  run(conn, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
}

export function validSession(conn: Db, token: string | undefined): boolean {
  if (!token) return false;
  run(conn, "DELETE FROM sessions WHERE expires_at <= datetime('now')");
  return one(conn, "SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')", tokenHash(token))
    !== undefined;
}

export function issueCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    // 生产是 HTTPS(nginx 终结),开发时走 http 不能带 Secure,否则浏览器直接丢弃
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 3600,
  });
}

export function clearCookie(c: Context): void {
  setCookie(c, COOKIE, '', { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 0 });
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, COOKIE);
}

/** 当前请求是否已获授权。proxy 模式下恒为真 —— 判断发生在 nginx 那一层。 */
export function authorized(conn: Db, c: Context): boolean {
  if (authMode() === 'proxy') return true;
  return validSession(conn, sessionToken(c));
}

/** 管理接口的守卫。未授权返回 401(真的 HTTP 状态码,前端据此跳登录页)。 */
export function requireAuth(conn: Db) {
  return async (c: Context, next: Next) => {
    if (!authorized(conn, c)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
