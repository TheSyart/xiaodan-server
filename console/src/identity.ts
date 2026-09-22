// 设备身份。
//
// 一台设备的身份由两部分组成:
//   Device-Id —— MAC。公开且可伪造:它在 Wi-Fi 无线帧里明文出现,附近的人抓包就能看到。
//   Client-Id —— 设备第一次开机时用硬件随机数生成、存在自己闪存里的 32 字节密钥(64 位十六进制)。
//                原版小智固件在这里放它自己生成并保存的 UUID,同样接受。
//
// 控制塔只存 Client-Id 的哈希。绑定时要求输入【设备屏幕上】的六位码,证明"设备在我手上";
// 之后每次 OTA 与引擎取配置都核对哈希,证明"还是那台设备"。
//
// 这里的函数都是同步的:调用方先读完请求体,再把它们包进 tx。

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { one, run } from './db.ts';
import { APP_BOARD } from './credits/devices.ts';

/** 待绑定行的空闲有效期。同一身份每轮询一次就顺延一次,所以设备一直开着码就一直有效。 */
export const PENDING_IDLE_TTL_MINUTES = 10;
export const OTA_POLL_INTERVAL_S = 5;
export const MISMATCH_RETRY_S = 30;
export const RATE_LIMIT_RETRY_S = 60;
export const INVALID_RETRY_S = 60;
export const UNAVAILABLE_RETRY_S = 60;

// 待绑定表不需要登录就能往里写,必须设上限,否则可以被灌满。
export const MAX_PENDING_PER_MAC = 3;
export const MAX_PENDING_TOTAL = 50;
export const MAX_NEW_PENDING_PER_MINUTE = 10;

export const MAX_EVENT_FPS_PER_MAC = 5;
export const MAX_EVENT_ROWS = 200;
export const EVENT_RETENTION_DAYS = 30;

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** 哈希加一段固定前缀,使这里存下的值不能被挪作他用的哈希直接比对。 */
const HASH_DOMAIN = 'xiaodan/client-id/v1\n';

/** 统一成小写冒号形式。连字符分隔、大写、12 位紧凑形式都接受;全零地址拒绝。 */
export function canonicalMac(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let mac = raw.trim().toLowerCase().replaceAll('-', ':');
  // 紧凑形式(4c11ae317a30):前端把 MAC 拼进 URL 时用这种写法 —— 冒号会被编码成 %3A,
  // 而运维面板的 URI 规范化把「%3A 后面跟小写十六进制字母」误判成小写的百分号编码而拒掉。
  if (/^[0-9a-f]{12}$/u.test(mac)) mac = mac.replace(/(..)(?=..)/gu, '$1:');
  if (!MAC_RE.test(mac) || mac === '00:00:00:00:00:00') return null;
  return mac;
}

/**
 * 解析设备出示的 Client-Id。
 *
 * 旧固件的 "xiaodan-aabbcc" 由 MAC 推出,不是秘密,必须拒绝;引擎在设备缺这个头时会拿
 * Device-Id 兜底,那也是 MAC,同样拒绝。全是同一个字符的值(全零、擦除后的全 f)视为坏数据。
 */
export function parseClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  if (!HEX64_RE.test(id) && !UUID_RE.test(id)) return null;
  if (/^(.)\1*$/u.test(id.replaceAll('-', ''))) return null;
  return id;
}

export function hashClientId(clientId: string): string {
  return createHash('sha256').update(HASH_DOMAIN + clientId).digest('hex');
}

/** 常数时间比较两个 64 位十六进制哈希;任一不合形状都视为不相等。 */
export function sameHash(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!HEX64_RE.test(a) || !HEX64_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** 事件里只留哈希前 12 位:足够区分"是不是同一个冒充者",又不保存完整哈希。 */
export function clientFingerprint(hash: string): string {
  return hash.slice(0, 12);
}

export type RandomInt = (min: number, max: number) => number;

/** 六位数字绑定码,用密码学安全的随机数,避开已被占用的值。 */
export function newBindCode(conn: Db, rand: RandomInt = randomInt): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = String(rand(0, 1_000_000)).padStart(6, '0');
    if (!one(conn, 'SELECT 1 FROM pending_devices WHERE code = ?', code)) return code;
  }
  throw new Error('无法生成未被占用的绑定码');
}

/** 删除过期的待绑定行与超期事件,并把事件表裁剪到上限。 */
export function cleanupIdentityTables(conn: Db): void {
  run(conn, "DELETE FROM pending_devices WHERE expires_at <= datetime('now')");
  run(conn, "DELETE FROM identity_events WHERE last_seen_at < datetime('now', ?)", `-${EVENT_RETENTION_DAYS} days`);
  run(
    conn,
    `DELETE FROM identity_events WHERE id NOT IN (
       SELECT id FROM identity_events ORDER BY last_seen_at DESC, id DESC LIMIT ?)`,
    MAX_EVENT_ROWS,
  );
}

export type DeviceIdentity =
  | { kind: 'unknown' }
  /** 身份机制上线前就已绑定的设备,库里没有哈希,必须重新配对。 */
  | { kind: 'legacy'; agentId: string }
  /** 已绑定且有哈希,但对方没有出示有效的 Client-Id。 */
  | { kind: 'missing'; agentId: string }
  | { kind: 'verified'; agentId: string }
  | { kind: 'mismatch'; agentId: string };

export function resolveDevice(conn: Db, mac: string, hash: string | null): DeviceIdentity {
  const row = one<{ agent_id: string; secret_hash: string | null }>(
    conn,
    'SELECT agent_id, secret_hash FROM devices WHERE mac = ?',
    mac,
  );
  if (!row) return { kind: 'unknown' };
  if (row.secret_hash === null) return { kind: 'legacy', agentId: row.agent_id };
  if (hash === null) return { kind: 'missing', agentId: row.agent_id };
  return sameHash(row.secret_hash, hash)
    ? { kind: 'verified', agentId: row.agent_id }
    : { kind: 'mismatch', agentId: row.agent_id };
}

export type PendingResult =
  | { ok: true; code: string; expiresInS: number }
  | { ok: false; retryAfterS: number };

/**
 * 取(或创建)某个身份的绑定码。
 *
 * 码对应的是 (MAC, 密钥哈希) 这一对,而不只是 MAC:冒充者即使抢先用同一个 MAC 来要码,
 * 拿到的也是另一个码;用户输入的是自己手上设备屏幕显示的码,绑定的就是自己那把密钥。
 *
 * 已经有待绑定行的身份永远拿回原码,不受上限影响 —— 有人刷同一个 MAC 时,
 * 真设备不会被挡在外面,被挡住的只是新出现的身份。
 */
export function ensurePendingCode(
  conn: Db,
  pending: { mac: string; hash: string; board: string; version: string },
): PendingResult {
  const ttl = `+${PENDING_IDLE_TTL_MINUTES} minutes`;
  const expiresInS = PENDING_IDLE_TTL_MINUTES * 60;

  const existing = one<{ id: number; code: string }>(
    conn,
    "SELECT id, code FROM pending_devices WHERE mac = ? AND secret_hash = ? AND expires_at > datetime('now')",
    pending.mac,
    pending.hash,
  );
  if (existing) {
    run(
      conn,
      `UPDATE pending_devices SET last_seen_at = datetime('now'), expires_at = datetime('now', ?),
              board = CASE WHEN ? <> '' THEN ? ELSE board END,
              app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END
       WHERE id = ?`,
      ttl, pending.board, pending.board, pending.version, pending.version, existing.id,
    );
    return { ok: true, code: existing.code, expiresInS };
  }

  const count = (sql: string, ...params: unknown[]) => one<{ n: number }>(conn, sql, ...params)?.n ?? 0;
  const limited =
    count('SELECT COUNT(*) AS n FROM pending_devices WHERE mac = ?', pending.mac) >= MAX_PENDING_PER_MAC
    || count('SELECT COUNT(*) AS n FROM pending_devices') >= MAX_PENDING_TOTAL
    || count("SELECT COUNT(*) AS n FROM pending_devices WHERE created_at > datetime('now', '-1 minute')")
      >= MAX_NEW_PENDING_PER_MINUTE;
  if (limited) return { ok: false, retryAfterS: RATE_LIMIT_RETRY_S };

  // 同一身份若残留一条已过期的行,唯一约束会让插入失败;调用方通常已清理过,这里再兜一次。
  run(conn, 'DELETE FROM pending_devices WHERE mac = ? AND secret_hash = ?', pending.mac, pending.hash);
  const code = newBindCode(conn);
  run(
    conn,
    `INSERT INTO pending_devices (mac, secret_hash, code, board, app_version, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    pending.mac, pending.hash, code, pending.board, pending.version, ttl,
  );
  return { ok: true, code, expiresInS };
}

/** 只读地查某个身份当前的绑定码,不新建也不顺延。 */
export function findPendingCode(conn: Db, mac: string, hash: string): string | undefined {
  return one<{ code: string }>(
    conn,
    "SELECT code FROM pending_devices WHERE mac = ? AND secret_hash = ? AND expires_at > datetime('now')",
    mac,
    hash,
  )?.code;
}

export type IdentityEventKind = 'mismatch' | 'missing_identity' | 'legacy_unverified';
export type IdentityEventSource = 'ota' | 'engine';

/**
 * 记一条身份异常。同一冒充者(同一指纹)重复出现只累加次数。
 * 同一 MAC 的不同指纹超过上限后合并成 '*',防止有人换着密钥把事件表刷满。
 */
export function recordIdentityEvent(
  conn: Db,
  event: { mac: string; kind: IdentityEventKind; source: IdentityEventSource; hash: string | null },
): void {
  let fingerprint = event.hash ? clientFingerprint(event.hash) : '';
  if (fingerprint) {
    // 这个指纹在该 MAC 下出现过(不论类别与来源)就不算新指纹,不占上限名额。
    const known = one(conn, 'SELECT 1 FROM identity_events WHERE mac = ? AND client_fp = ?', event.mac, fingerprint);
    if (!known) {
      const distinct = one<{ n: number }>(
        conn,
        "SELECT COUNT(DISTINCT client_fp) AS n FROM identity_events WHERE mac = ? AND client_fp NOT IN ('', '*')",
        event.mac,
      )?.n ?? 0;
      if (distinct >= MAX_EVENT_FPS_PER_MAC) fingerprint = '*';
    }
  }
  run(
    conn,
    `INSERT INTO identity_events (mac, kind, source, client_fp) VALUES (?, ?, ?, ?)
     ON CONFLICT (mac, kind, source, client_fp)
     DO UPDATE SET count = count + 1, last_seen_at = datetime('now')`,
    event.mac, event.kind, event.source, fingerprint,
  );
}

export type BindResult = { ok: true; mac: string } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * 家长 App 该用哪个智能体:先认角色模板建出来的「家长」(role_template = 'parent'),
 * 再退到名字里带「家长」的智能体(手工建的也算),都没有就返回 undefined。
 */
export function parentAgentId(conn: Db): string | undefined {
  const pick = (sql: string, ...params: unknown[]) => one<{ id: string }>(conn, sql, ...params)?.id;
  return pick("SELECT id FROM agents WHERE role_template = 'parent' ORDER BY created_at LIMIT 1")
    ?? pick("SELECT id FROM agents WHERE name LIKE '%家长%' ORDER BY is_default DESC, created_at LIMIT 1");
}

/**
 * 新设备没指定智能体时的落点。家长 App(OTA 里报 board.type = xiaodan-app)默认绑到家长智能体——
 * 它要办的是学分那摊事,落到孩子的角色上会答不出「给妹妹留作业」这种话。
 */
export function defaultAgentForBoard(conn: Db, board: string): string | undefined {
  if (board === APP_BOARD) {
    const parent = parentAgentId(conn);
    if (parent) return parent;
  }
  return one<{ id: string }>(conn, 'SELECT id FROM agents ORDER BY is_default DESC, created_at LIMIT 1')?.id;
}

/**
 * 按设备屏幕上的六位码绑定。
 *
 * 身份机制上线前就已绑定的旧行没有哈希,这里原地写入哈希;别名为空、未指定智能体时保留原值,
 * 用户不必先解绑再绑。新设备未指定智能体时绑到默认智能体(家长 App 绑到家长智能体)。
 * 已经带哈希的设备行不允许被覆盖,必须先解绑。
 */
export function bindByCode(conn: Db, bind: { code: string; agentId: string | null; alias: string }): BindResult {
  const pending = one<{ mac: string; secret_hash: string; board: string; app_version: string }>(
    conn,
    "SELECT mac, secret_hash, board, app_version FROM pending_devices WHERE code = ? AND expires_at > datetime('now')",
    bind.code,
  );
  if (!pending) return { ok: false, status: 404, error: '绑定码无效或已过期' };

  const device = one<{ secret_hash: string | null }>(conn, 'SELECT secret_hash FROM devices WHERE mac = ?', pending.mac);
  if (device && device.secret_hash !== null) {
    return { ok: false, status: 409, error: '这台设备已经绑定过了,请先解绑' };
  }

  if (device) {
    run(
      conn,
      `UPDATE devices SET secret_hash = ?, agent_id = COALESCE(?, agent_id),
              alias = CASE WHEN ? <> '' THEN ? ELSE alias END,
              board = CASE WHEN ? <> '' THEN ? ELSE board END,
              app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END
       WHERE mac = ?`,
      pending.secret_hash, bind.agentId, bind.alias, bind.alias,
      pending.board, pending.board, pending.app_version, pending.app_version, pending.mac,
    );
  } else {
    const agentId = bind.agentId ?? defaultAgentForBoard(conn, pending.board);
    if (!agentId) return { ok: false, status: 400, error: '还没有任何智能体,请先创建一个' };
    run(
      conn,
      'INSERT INTO devices (mac, agent_id, alias, board, app_version, secret_hash) VALUES (?, ?, ?, ?, ?, ?)',
      pending.mac, agentId, bind.alias, pending.board, pending.app_version, pending.secret_hash,
    );
  }
  run(conn, 'DELETE FROM pending_devices WHERE mac = ?', pending.mac);
  run(conn, 'DELETE FROM identity_events WHERE mac = ?', pending.mac);
  return { ok: true, mac: pending.mac };
}

/**
 * 解绑:设备行(连同哈希)、该 MAC 的待绑定行、身份事件与对话档案一并清除。返回设备是否存在。
 * 长期记忆、角色白名单、定位随外键级联删;memory_arcs 与 chat_messages 一样没有外键,要显式删
 * (原文照旧保留,与现在解绑不删对话记录的行为一致)。
 */
export function unbindDevice(conn: Db, mac: string): boolean {
  if (one(conn, 'SELECT 1 FROM devices WHERE mac = ?', mac) === undefined) return false;
  run(conn, 'DELETE FROM devices WHERE mac = ?', mac);
  run(conn, 'DELETE FROM pending_devices WHERE mac = ?', mac);
  run(conn, 'DELETE FROM identity_events WHERE mac = ?', mac);
  run(conn, 'DELETE FROM memory_arcs WHERE mac = ?', mac);
  return true;
}
