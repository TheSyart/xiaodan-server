// 哪些设备是「孩子」,哪些是家长 App。
//
// 家长 App 和玩具走同一套绑定流程(OTA 拿绑定码、控制台输码绑定),区别只在 OTA 请求体里报的
// board.type:App 报 xiaodan-app,绑定时原样落进 devices.board。所以不用加表加列,按这一列分就行。
// 学分只记在孩子身上:孩子列表、学分接口按 MAC 找孩子时,都把 App 设备排除在外。

import type { Db } from '../db.ts';
import { all, one } from '../db.ts';

export const APP_BOARD = 'xiaodan-app';

export function isAppDevice(device: { board?: string | null } | undefined | null): boolean {
  return device?.board === APP_BOARD;
}

/** 所有孩子(= 玩具设备),最近连过的在前 */
export function childDevices(conn: Db): { mac: string; alias: string }[] {
  return all<{ mac: string; alias: string }>(conn,
    'SELECT mac, alias FROM devices WHERE board != ? ORDER BY last_connected_at DESC', APP_BOARD)
    .map((row) => ({ ...row }));
}

/** 按规范化后的 MAC 找孩子;App 设备不算 */
export function childDevice(conn: Db, mac: string): { mac: string; alias: string } | undefined {
  const row = one<{ mac: string; alias: string }>(conn,
    'SELECT mac, alias FROM devices WHERE mac = ? AND board != ?', mac, APP_BOARD);
  return row ? { ...row } : undefined;
}
