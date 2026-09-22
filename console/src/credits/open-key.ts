// 学分外部接口(/open/v1/credits)的密钥:多把,各自命名、只读或可写、单独吊销。
//
// 每个 App、每台手机、每个快捷指令各一把,丢了哪台只吊销那一把。库里只存 SHA-256 与明文前 8 位
// (列表里用来认是哪把),明文只在创建时返回一次——库被拷走也拿不到能用的密钥。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import { all, one, run } from '../db.ts';

const PREFIX = 'xdc_';
/** 最后使用时间最多一分钟写一次,别让每个外部请求都写库 */
const TOUCH_MS = 60_000;

export type KeyScope = 'read' | 'write';

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scope: KeyScope;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface KeyRow extends ApiKey {
  hash: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest();
const view = ({ hash: _hash, ...rest }: KeyRow): ApiKey => ({ ...rest });

export function listKeys(conn: Db): ApiKey[] {
  return all<KeyRow>(conn, 'SELECT * FROM credit_api_keys ORDER BY revoked_at IS NOT NULL, id DESC').map((row) => view({ ...row }));
}

export function keyById(conn: Db, id: number): ApiKey | undefined {
  const row = one<KeyRow>(conn, 'SELECT * FROM credit_api_keys WHERE id = ?', id);
  return row ? view({ ...row }) : undefined;
}

/** 新建一把;返回的 key 是明文,只有这一次 */
export function createKey(conn: Db, name: string, scope: KeyScope): { key: string; item: ApiKey } {
  const key = PREFIX + randomBytes(32).toString('base64url');
  run(conn, 'INSERT INTO credit_api_keys (name, prefix, hash, scope) VALUES (?, ?, ?, ?)',
    name, key.slice(0, 8), sha256(key).toString('hex'), scope);
  const id = one<{ id: number }>(conn, 'SELECT last_insert_rowid() AS id')!.id;
  return { key, item: keyById(conn, id)! };
}

export function renameKey(conn: Db, id: number, name: string): ApiKey | undefined {
  run(conn, 'UPDATE credit_api_keys SET name = ? WHERE id = ?', name, id);
  return keyById(conn, id);
}

/** 吊销:行留着(流水里的 actor 还要对得上),只是再也认不出来 */
export function revokeKey(conn: Db, id: number): ApiKey | undefined {
  run(conn, "UPDATE credit_api_keys SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?", id);
  return keyById(conn, id);
}

/** 有没有至少一把能用的密钥;一把都没有时外部接口整组当作没开 */
export function anyActiveKey(conn: Db): boolean {
  return !!one(conn, 'SELECT 1 FROM credit_api_keys WHERE revoked_at IS NULL LIMIT 1');
}

/** 核对外部请求带来的密钥;对上了顺手记一下最后使用时间 */
export function findKey(conn: Db, presented: string, now: Date = new Date()): ApiKey | null {
  if (!presented) return null;
  const digest = sha256(presented);
  const row = one<KeyRow>(conn, 'SELECT * FROM credit_api_keys WHERE hash = ? AND revoked_at IS NULL', digest.toString('hex'));
  if (!row || !timingSafeEqual(digest, Buffer.from(row.hash, 'hex'))) return null;
  const last = row.last_used_at ? Date.parse(`${row.last_used_at.replace(' ', 'T')}Z`) : 0;
  if (!last || now.getTime() - last > TOUCH_MS) {
    run(conn, 'UPDATE credit_api_keys SET last_used_at = ? WHERE id = ?', now.toISOString().slice(0, 19).replace('T', ' '), row.id);
  }
  return view({ ...row });
}

// ---- 请求上挂的是哪把密钥:守卫写入,路由写流水时读出来记成 actor ----

const requestKeys = new WeakMap<Request, ApiKey>();

export function setRequestKey(request: Request, key: ApiKey): void {
  requestKeys.set(request, key);
}

export function requestKey(request: Request): ApiKey | undefined {
  return requestKeys.get(request);
}
