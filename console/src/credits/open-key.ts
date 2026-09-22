// 学分外部接口(/open/credits)的密钥。
//
// 全家一把,在学分页生成、轮换、关闭。库里只存 SHA-256,明文只在生成那一刻返回一次——
// 与控制台会话令牌同一个做法:库被拷走也拿不到能用的密钥。
// 存在 settings 表的内部行里(internal = 1,设置页不显示),设置页的批量保存接口也跳过它,
// 免得有人借那个接口把哈希改成自己算好的值。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import { one, run } from '../db.ts';

export const OPEN_KEY_SETTING = 'credits.open_key';
const PREFIX = 'xdc_';
/** 最后使用时间最多一分钟写一次,别让每个外部请求都写库 */
const TOUCH_MS = 60_000;

interface Stored {
  hash: string;
  created_at: string;
  last_used_at: string | null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest();

function load(conn: Db): Stored | null {
  const raw = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', OPEN_KEY_SETTING)?.value;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    return typeof value.hash === 'string' && /^[0-9a-f]{64}$/u.test(value.hash)
      ? { hash: value.hash, created_at: String(value.created_at ?? ''), last_used_at: value.last_used_at ?? null }
      : null;
  } catch {
    return null;
  }
}

function save(conn: Db, value: Stored | null): void {
  run(conn,
    `INSERT INTO settings (key, value, value_type, label, internal) VALUES (?, ?, 'json', '学分外部接口密钥(哈希)', 1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    OPEN_KEY_SETTING, value ? JSON.stringify(value) : '');
}

export function keyStatus(conn: Db): { enabled: boolean; created_at: string | null; last_used_at: string | null } {
  const stored = load(conn);
  return { enabled: !!stored, created_at: stored?.created_at ?? null, last_used_at: stored?.last_used_at ?? null };
}

/** 生成一把新密钥(旧的立即失效),返回明文——只有这一次能看到 */
export function rotateKey(conn: Db, now: Date = new Date()): string {
  const key = PREFIX + randomBytes(32).toString('base64url');
  save(conn, { hash: sha256(key).toString('hex'), created_at: now.toISOString(), last_used_at: null });
  return key;
}

export function disableKey(conn: Db): void {
  save(conn, null);
}

export function keyEnabled(conn: Db): boolean {
  return !!load(conn);
}

/** 核对外部请求带来的密钥;对上了顺手记一下最后使用时间 */
export function verifyKey(conn: Db, presented: string, now: Date = new Date()): boolean {
  const stored = load(conn);
  if (!stored || !presented) return false;
  const ok = timingSafeEqual(sha256(presented), Buffer.from(stored.hash, 'hex'));
  if (ok) {
    const last = stored.last_used_at ? Date.parse(stored.last_used_at) : 0;
    if (!last || now.getTime() - last > TOUCH_MS) save(conn, { ...stored, last_used_at: now.toISOString() });
  }
  return ok;
}
