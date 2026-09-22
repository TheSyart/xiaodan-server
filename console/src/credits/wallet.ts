// 时间与零花钱的余额账户:用掉 / 花掉、调整、撤销、翻页。
//
// 一个时间 / 零花钱奖励就是一个账户(游戏的分钟和电视的分钟分开算),余额 = 账户流水 qty 之和,永远不小于 0:
//   - 兑换进账在 store.ts 的 redeem 里和扣分同一个事务写入;撤销那次兑换(学分流水)时一起退回;
//   - 用掉 / 花掉(use):不能超过余额,和「分不够不能兑换」同一个道理;
//   - 调整(adjust):可加可减(奶奶给了 20 元、记错了要改),调完不能小于 0;
//   - 撤销:追加一笔反向记录,原记录保留;兑换进账不在这里撤,要去学分流水里撤销那次兑换,分和余额才对得上。
// 数额进出都是自然单位(分钟 / 元),库里是基本单位(分钟 / 分),换算见 units.ts。

import type { Db } from '../db.ts';
import { run, tx } from '../db.ts';
import {
  ADMIN, CreditError, addWallet, requireReward, walletBalance, walletById, walletRows,
  type Actor, type RewardRow, type WalletKind, type WalletRow,
} from './store.ts';
import { formatQty, fromBase, toBase, UNIT, type RewardKind } from './units.ts';

/** 接口与页面看到的一笔:数额与当时余额换成自然单位 */
export interface WalletEntry {
  id: number;
  mac: string;
  reward_id: number;
  reward_name: string;
  reward_emoji: string;
  reward_kind: RewardKind;
  unit: string;
  kind: WalletKind;
  amount: number;
  balance_after: number;
  ledger_id: number | null;
  ref_id: number | null;
  title: string;
  note: string;
  reverted_by: number | null;
  source: Actor['source'];
  actor: string;
  created_at: string;
}

export function walletOut(row: WalletRow): WalletEntry {
  return {
    id: row.id, mac: row.mac, reward_id: row.reward_id, reward_name: row.reward_name, reward_emoji: row.reward_emoji,
    reward_kind: row.reward_kind, unit: UNIT[row.reward_kind], kind: row.kind,
    amount: fromBase(row.reward_kind, row.qty), balance_after: fromBase(row.reward_kind, row.balance_after),
    ledger_id: row.ledger_id, ref_id: row.ref_id, title: row.title, note: row.note, reverted_by: row.reverted_by,
    source: row.source, actor: row.actor, created_at: row.created_at,
  };
}

export interface WalletResult {
  entry: WalletEntry;
  /** 这个账户现在的余额,自然单位 */
  balance: number;
  unit: string;
}

function result(conn: Db, entryId: number, reward: RewardRow): WalletResult {
  return {
    entry: walletOut(walletById(conn, entryId)!),
    balance: fromBase(reward.kind, walletBalance(conn, reward.id)),
    unit: UNIT[reward.kind],
  };
}

/** 这个孩子的时间 / 零花钱奖励;物品没有余额 */
export function requireWalletReward(conn: Db, mac: string, rewardId: number): RewardRow {
  const reward = requireReward(conn, rewardId);
  if (reward.mac !== mac) throw new CreditError('奖励不存在', 404, 'not_found');
  if (reward.kind === 'item') {
    throw new CreditError(`「${reward.name}」是物品奖励,兑换就完事,没有余额`, 400, 'invalid');
  }
  return reward;
}

function short(conn: Db, reward: RewardRow, need: number): CreditError {
  const left = walletBalance(conn, reward.id);
  return new CreditError(
    `「${reward.name}」只剩 ${formatQty(reward.kind, left)},不够 ${formatQty(reward.kind, need)}`, 409, 'insufficient_wallet');
}

/** 用掉时间 / 花掉零花钱。amount 是自然单位、大于 0 */
export function walletUse(
  conn: Db, mac: string, rewardId: number, amount: number, reason: string, note = '', by: Actor = ADMIN,
): WalletResult {
  return tx(conn, () => {
    const reward = requireWalletReward(conn, mac, rewardId);
    const qty = toBase(reward.kind, amount, reward.kind === 'money' ? '花掉的钱' : '用掉的时间');
    if (walletBalance(conn, reward.id) < qty) throw short(conn, reward, qty);
    const id = addWallet(conn, mac, reward.id, -qty, 'use', {}, reason, note, by);
    return result(conn, id, reward);
  });
}

/** 调整:可加可减、不为 0;调完余额不能小于 0 */
export function walletAdjust(
  conn: Db, mac: string, rewardId: number, amount: number, reason: string, by: Actor = ADMIN,
): WalletResult {
  return tx(conn, () => {
    const reward = requireWalletReward(conn, mac, rewardId);
    const qty = toBase(reward.kind, amount, '调整的数额', true);
    if (qty < 0 && walletBalance(conn, reward.id) < -qty) throw short(conn, reward, -qty);
    const id = addWallet(conn, mac, reward.id, qty, 'adjust', {}, reason, '', by);
    return result(conn, id, reward);
  });
}

/** 撤销一笔用掉 / 调整;兑换进账要去学分流水里撤销那次兑换 */
export function walletRevert(conn: Db, entryId: number, by: Actor = ADMIN): WalletResult {
  return tx(conn, () => {
    const row = walletById(conn, entryId);
    if (!row) throw new CreditError('这笔记录不存在', 404, 'not_found');
    if (row.kind === 'revert') throw new CreditError('撤销记录本身不能再撤销', 409, 'not_revertible');
    if (row.reverted_by) throw new CreditError('这一笔已经撤销过了', 409, 'already_reverted');
    if (row.kind === 'redeem') {
      throw new CreditError(`兑换进来的要在学分流水里撤销那次兑换(流水 ${row.ledger_id}),分和余额一起退`, 409, 'not_revertible');
    }
    const reward = requireReward(conn, row.reward_id);
    if (row.qty > 0 && walletBalance(conn, reward.id) < row.qty) throw short(conn, reward, row.qty);
    const id = addWallet(conn, row.mac, reward.id, -row.qty, 'revert', { refId: row.id }, `撤销:${row.title}`, '', by);
    run(conn, 'UPDATE credit_wallet SET reverted_by = ? WHERE id = ?', id, row.id);
    return result(conn, id, reward);
  });
}

export function walletEntry(conn: Db, id: number): WalletEntry {
  const row = walletById(conn, id);
  if (!row) throw new CreditError('这笔记录不存在', 404, 'not_found');
  return walletOut(row);
}

/** 按 id 倒序翻页;可按账户、类型、北京时间的日期段筛选 */
export function walletPage(
  conn: Db, mac: string, before: number | null, limit: number,
  filter: { reward_id?: number | undefined; kind?: WalletKind | undefined; from?: string | undefined; to?: string | undefined } = {},
): { items: WalletEntry[]; next: number | null } {
  const where = ['w.mac = ?'];
  const params: unknown[] = [mac];
  if (before) { where.push('w.id < ?'); params.push(before); }
  if (filter.reward_id) { where.push('w.reward_id = ?'); params.push(filter.reward_id); }
  if (filter.kind) { where.push('w.kind = ?'); params.push(filter.kind); }
  if (filter.from) { where.push("date(w.created_at, '+8 hours') >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("date(w.created_at, '+8 hours') <= ?"); params.push(filter.to); }
  const rows = walletRows(conn, where.join(' AND '), params, limit + 1);
  const more = rows.length > limit;
  const items = (more ? rows.slice(0, limit) : rows).map(walletOut);
  return { items, next: more ? items.at(-1)!.id : null };
}
