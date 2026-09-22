// 家长 App 绑哪台硬件(=哪个孩子)。
//
// 一台 App 一行、一台硬件只被一台 App 绑(child_bindings 上的两个 UNIQUE 管着)。这条关系目前只有学分用,
// 但表名不带 credits —— 将来推送这类功能也能复用。
//
// 「现在只支持一个孩子」也在这里拦:服务端已经有另一台硬件时,不让 App 再绑到新的硬件上,
// 而是让它先去控制台把多余的解绑。已经绑着的那台照旧能读,不影响历史。

import type { Db } from '../db.ts';
import { all, one, run } from '../db.ts';
import { childDevice, childDevices, isAppDevice } from './devices.ts';
import { CreditError } from './errors.ts';

export interface BoundChild {
  mac: string;
  alias: string;
}

/** 这台 App 绑的孩子;没绑返回 null */
export function boundChild(conn: Db, appMac: string): BoundChild | null {
  const row = one<{ mac: string; alias: string }>(conn,
    `SELECT d.mac, d.alias FROM child_bindings b JOIN devices d ON d.mac = b.child_mac WHERE b.app_mac = ?`,
    appMac);
  return row ? { ...row } : null;
}

/**
 * 把 App 绑到一台硬件上(已经绑过的就是换绑)。
 * 三种拒绝:绑的是家长 App 自己、没有这台设备、已经有了别的硬件 / 这台硬件被别的手机绑着。
 */
export function bindAppToChild(conn: Db, appMac: string, childMac: string): BoundChild {
  const target = childDevice(conn, childMac);
  if (!target) {
    const device = one<{ board: string | null }>(conn, 'SELECT board FROM devices WHERE mac = ?', childMac);
    if (!device) throw new CreditError('没有这台设备', 404, 'device_not_found');
    throw new CreditError('家长 App 不能当孩子:要绑的是一台硬件设备(比如孩子的小单)', 400, 'app_device_cannot_be_child');
  }
  const current = boundChild(conn, appMac);
  if (current?.mac === target.mac) return current;
  if (childDevices(conn).length > 1) {
    throw new CreditError('现在只支持一个孩子:服务端上不止一台硬件,先去控制台设备页把多余的解绑', 409, 'second_hardware_not_supported');
  }
  const held = one<{ app_mac: string }>(conn, 'SELECT app_mac FROM child_bindings WHERE child_mac = ?', target.mac);
  if (held && held.app_mac !== appMac) {
    throw new CreditError('这台硬件已经绑在另一台手机上了,要换绑得先在那台 App 里解绑', 409, 'child_already_bound');
  }
  run(conn,
    `INSERT INTO child_bindings (app_mac, child_mac) VALUES (?, ?)
     ON CONFLICT (app_mac) DO UPDATE SET child_mac = excluded.child_mac, created_at = datetime('now')`,
    appMac, target.mac);
  return { mac: target.mac, alias: target.alias };
}

/** 解绑。返回之前有没有绑过(App 重试无痛)。 */
export function unbindApp(conn: Db, appMac: string): boolean {
  const existed = one(conn, 'SELECT 1 FROM child_bindings WHERE app_mac = ?', appMac) !== undefined;
  run(conn, 'DELETE FROM child_bindings WHERE app_mac = ?', appMac);
  return existed;
}

/** 全部绑定关系。控制台设备页用它显示「这台 App 绑的是谁」。 */
export function childBindings(conn: Db): { app_mac: string; child_mac: string }[] {
  return all<{ app_mac: string; child_mac: string }>(conn, 'SELECT app_mac, child_mac FROM child_bindings')
    .map((row) => ({ ...row }));
}
