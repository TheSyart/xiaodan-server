// 设备位置:每台设备只留最新一条。**BSSID 一个字节都不落库** —— 扫到的热点只在内存里活到解析完。
//
// 位置是这个项目里第一份会落库的隐私数据,所以默认关闭、按设备开启,日志里的 IP 与 BSSID 都打码。

import type { Db } from '../../db.ts';
import { one, run } from '../../db.ts';
import type { Bss, LocateResult } from './providers.ts';

export interface LocationRow {
  mac: string;
  source: 'wifi' | 'ip';
  lng: number | null;
  lat: number | null;
  radius: number;
  province: string;
  city: string;
  district: string;
  address: string;
  ap_count: number;
  provider: string;
  last_error: string;
  located_at: string;
  updated_at: string;
}

export function deviceLocation(conn: Db, mac: string): LocationRow | undefined {
  return one<LocationRow>(conn, 'SELECT * FROM device_locations WHERE mac = ?', mac);
}

export function locateEnabled(conn: Db, mac: string): boolean {
  return one<{ locate: number }>(conn, 'SELECT locate FROM devices WHERE mac = ?', mac)?.locate === 1;
}

export function saveLocation(conn: Db, mac: string, result: LocateResult, apCount = 0): void {
  run(
    conn,
    `INSERT INTO device_locations (mac, source, lng, lat, radius, province, city, district, address, ap_count, provider, last_error, located_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', datetime('now'), datetime('now'))
     ON CONFLICT (mac) DO UPDATE SET source = excluded.source, lng = excluded.lng, lat = excluded.lat, radius = excluded.radius,
       province = excluded.province, city = excluded.city, district = excluded.district, address = excluded.address,
       ap_count = excluded.ap_count, provider = excluded.provider, last_error = '',
       located_at = excluded.located_at, updated_at = excluded.updated_at`,
    mac, result.source, result.lng, result.lat, result.radius,
    result.province, result.city, result.district, result.address, apCount, result.provider,
  );
}

/** 定位失败只记原因,不覆盖上一次定到的位置 */
export function noteLocateError(conn: Db, mac: string, error: string): void {
  const existing = deviceLocation(conn, mac);
  if (existing) {
    run(conn, "UPDATE device_locations SET last_error = ?, updated_at = datetime('now') WHERE mac = ?", error.slice(0, 200), mac);
    return;
  }
  run(
    conn,
    `INSERT INTO device_locations (mac, source, last_error, located_at) VALUES (?, 'ip', ?, datetime('now'))
     ON CONFLICT (mac) DO UPDATE SET last_error = excluded.last_error`,
    mac, error.slice(0, 200),
  );
}

/** 上次定位是不是已经旧到该再定一次了 */
export function locationStale(conn: Db, mac: string, hours: number): boolean {
  const row = one<{ n: number }>(
    conn,
    `SELECT COUNT(*) AS n FROM device_locations WHERE mac = ? AND source = 'wifi' AND located_at >= datetime('now', ?)`,
    mac, `-${hours} hours`,
  );
  if (row?.n) return false;
  const fresh = one<{ n: number }>(
    conn,
    `SELECT COUNT(*) AS n FROM device_locations WHERE mac = ? AND located_at >= datetime('now', '-24 hours')`,
    mac,
  );
  return !fresh?.n;
}

// ---------------------------------------------------------------- 待解析的队列(只在内存里)

interface Pending {
  mac: string;
  ip?: string;
  self?: Bss | null;
  aps?: Bss[];
  at: number;
}

const pending = new Map<string, Pending>();

/** 引擎报来设备扫到的热点。**只在内存里**,解析完就没了 */
export function noteScan(mac: string, payload: { self?: Bss | null; aps: Bss[] }): void {
  pending.set(mac, { ...(pending.get(mac) ?? { mac, at: Date.now() }), mac, self: payload.self ?? null, aps: payload.aps, at: Date.now() });
}

/** 对话里带上来的客户端 IP:留作兜底,同样只在内存里 */
export function noteClientIp(mac: string, ip: string | null | undefined): void {
  if (!ip) return;
  const current = pending.get(mac);
  pending.set(mac, { ...(current ?? { mac, at: Date.now() }), mac, ip, at: Date.now() });
}

export function takePending(): Pending[] {
  const out = [...pending.values()];
  pending.clear();
  return out;
}

export function pendingCount(): number {
  return pending.size;
}
