// 单管理员的登录与会话。
//
// 刻意不做注册、找回密码、多用户、图形验证码、短信 —— 这是一个只有机主一个人
// 会打开的内网风格页面,那些东西只会增加攻击面。密码用 scrypt 派生,
// 会话只存 token 的 SHA-256,数据库泄露也无法反推出可用的 Cookie。

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Db } from './db.ts';
import { one, run } from './db.ts';

const COOKIE = 'xiaodan_session';
const SESSION_HOURS = 12;
const SCRYPT_KEYLEN = 64;

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

/** 管理接口的守卫。未登录返回 401(这里用真的 HTTP 状态码,前端据此跳登录页)。 */
export function requireAuth(conn: Db) {
  return async (c: Context, next: Next) => {
    if (!validSession(conn, sessionToken(c))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}
