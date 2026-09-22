// 学分的数据库读写。
//
// 两条不变量,所有写操作都围着它们转:
//   1. 余额 = 流水 delta 之和。不另存余额,所以永远对得上账;
//   2. 流水只追加不修改。撤销是追加一条等额反向的流水,并在原流水上记 reverted_by。
// 凡是「改作业状态 + 写流水」的都放在同一个事务里(tx 不可重入,事务里别再调别的 tx)。
// 每一笔流水都记下是谁动的(source:页面 / 外部密钥 / 智能体,actor:密钥名或角色名)。

import type { Db } from '../db.ts';
import { all, one, run, tx } from '../db.ts';
import { formatBeijing } from '../agent/reminders/time.ts';
import { CreditError } from './errors.ts';
import { gradeResult, missedResult, type Quality, type ScoreResult, type StoredQuality } from './score.ts';
import { formatQty, fromBase, UNIT, type RewardKind } from './units.ts';

export { CreditError, type CreditErrorCode } from './errors.ts';

/** 这一笔是谁动的 */
export interface Actor {
  source: 'admin' | 'api' | 'agent';
  actor: string;
}
export const ADMIN: Actor = { source: 'admin', actor: '' };

/** 作业模板(原来叫「规则」):只有名字与参考用时,不再有任何分值 */
export interface RuleRow {
  id: number;
  mac: string;
  name: string;
  sort: number;
  archived: number;
  /** 参考用时(分钟):布置时抄进作业,界面上与实际用时对照,不参与算分 */
  target_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  mac: string;
  day: string;
  rule_id: number | null;
  name: string;
  /** 布置时抄下的参考用时 */
  target_minutes: number;
  status: 'pending' | 'done' | 'missed';
  actual_minutes: number | null;
  quality: StoredQuality | null;
  note: string;
  /** 家长给的分(0–5) */
  base_points: number | null;
  /** 质量加成(好 1 / 不好 0) */
  quality_points: number | null;
  total_points: number | null;
  scored_at: string | null;
  ledger_id: number | null;
  claimed_at: string | null;
  claim_note: string;
  claimed_minutes: number | null;
  created_at: string;
}

export interface RewardRow {
  id: number;
  mac: string;
  name: string;
  /** 一份要多少分 */
  cost: number;
  emoji: string;
  kind: RewardKind;
  /** 一份换多少,基本单位(时间:分钟;钱:分;物品恒为 1) */
  amount: number;
  sort: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export type LedgerKind = 'task' | 'missed' | 'redeem' | 'adjust' | 'revert';

export interface LedgerRow {
  id: number;
  mac: string;
  delta: number;
  kind: LedgerKind;
  ref_id: number | null;
  title: string;
  note: string;
  reverted_by: number | null;
  source: Actor['source'];
  actor: string;
  /** 兑换:这次换了几份 */
  times: number | null;
  created_at: string;
  /** 这一笔之后的余额(查询时现算) */
  balance_after?: number;
}

export type WalletKind = 'redeem' | 'use' | 'adjust' | 'revert';

/** 时间 / 零花钱余额账户的一笔流水。qty 是基本单位 */
export interface WalletRow {
  id: number;
  mac: string;
  reward_id: number;
  qty: number;
  kind: WalletKind;
  /** 兑换进账对应的那笔学分流水 */
  ledger_id: number | null;
  /** 撤销记录指向被撤销的那一笔 */
  ref_id: number | null;
  title: string;
  note: string;
  reverted_by: number | null;
  source: Actor['source'];
  actor: string;
  created_at: string;
  /** 以下为查询时带出来的 */
  reward_kind: RewardKind;
  reward_name: string;
  reward_emoji: string;
  balance_after: number;
}

/** 一个余额账户的汇总,自然单位 */
export interface WalletSummary {
  reward_id: number;
  name: string;
  emoji: string;
  kind: RewardKind;
  unit: string;
  archived: number;
  balance: number;
  /** 累计兑换进来的(撤销过的不算) */
  redeemed: number;
  /** 累计用掉 / 花掉的(撤销过的不算) */
  used: number;
}

export type TaskStatusFilter = 'pending' | 'done' | 'missed' | 'claimed';

const plain = <T>(row: T | undefined): T | undefined => (row ? ({ ...row } as T) : undefined);
const lastId = (conn: Db) => one<{ id: number }>(conn, 'SELECT last_insert_rowid() AS id')!.id;
/** 流水的 created_at 是 UTC,按北京时间的日期分组/筛选用这个表达式 */
const BEIJING_DAY = "date(created_at, '+8 hours')";

/** 北京时间的今天,YYYY-MM-DD */
export function today(now: Date = new Date()): string {
  return formatBeijing(now).slice(0, 10);
}

/** YYYY-MM-DD 往前/后挪几天 */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 余额

export function balance(conn: Db, mac: string): number {
  return one<{ n: number | null }>(conn, 'SELECT SUM(delta) AS n FROM credit_ledger WHERE mac = ?', mac)?.n ?? 0;
}

function addLedger(
  conn: Db, mac: string, delta: number, kind: LedgerKind, refId: number | null, title: string, note: string, by: Actor,
  times: number | null = null,
): number {
  run(conn,
    'INSERT INTO credit_ledger (mac, delta, kind, ref_id, title, note, source, actor, times) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    mac, delta, kind, refId, title.slice(0, 80), note.slice(0, 200), by.source, by.actor.slice(0, 40), times);
  return lastId(conn);
}

// ---------------------------------------------------------------- 时间与零花钱的余额账户(底层)
// 高层操作(用掉、调整、撤销、翻页)在 wallet.ts;兑换进账与撤销兑换要和学分流水同一个事务,所以底层放这里。

const WALLET_SELECT = `SELECT w.*, r.kind AS reward_kind, r.name AS reward_name, r.emoji AS reward_emoji,
    (SELECT SUM(qty) FROM credit_wallet x WHERE x.reward_id = w.reward_id AND x.id <= w.id) AS balance_after
  FROM credit_wallet w JOIN credit_rewards r ON r.id = w.reward_id`;

export function walletBalance(conn: Db, rewardId: number): number {
  return one<{ n: number | null }>(conn, 'SELECT SUM(qty) AS n FROM credit_wallet WHERE reward_id = ?', rewardId)?.n ?? 0;
}

export function walletById(conn: Db, id: number): WalletRow | undefined {
  return plain(one<WalletRow>(conn, `${WALLET_SELECT} WHERE w.id = ?`, id));
}

export function walletRows(conn: Db, where: string, params: unknown[], limit: number): WalletRow[] {
  return all<WalletRow>(conn, `${WALLET_SELECT} WHERE ${where} ORDER BY w.id DESC LIMIT ?`, ...params, limit)
    .map((row) => ({ ...row }));
}

export function addWallet(
  conn: Db, mac: string, rewardId: number, qty: number, kind: WalletKind,
  refs: { ledgerId?: number | null; refId?: number | null }, title: string, note: string, by: Actor,
): number {
  run(conn,
    `INSERT INTO credit_wallet (mac, reward_id, qty, kind, ledger_id, ref_id, title, note, source, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mac, rewardId, qty, kind, refs.ledgerId ?? null, refs.refId ?? null, title.slice(0, 80), note.slice(0, 200),
    by.source, by.actor.slice(0, 40));
  return lastId(conn);
}

/** 每个时间 / 零花钱奖励一个账户;停用的奖励只要还有余额也列出来 */
export function walletSummary(conn: Db, mac: string): WalletSummary[] {
  return all<{ id: number; name: string; emoji: string; kind: RewardKind; archived: number; balance: number | null; redeemed: number | null; used: number | null }>(conn,
    `SELECT r.id, r.name, r.emoji, r.kind, r.archived,
       (SELECT SUM(qty) FROM credit_wallet w WHERE w.reward_id = r.id) AS balance,
       (SELECT SUM(qty) FROM credit_wallet w WHERE w.reward_id = r.id AND w.kind = 'redeem' AND w.reverted_by IS NULL) AS redeemed,
       (SELECT -SUM(qty) FROM credit_wallet w WHERE w.reward_id = r.id AND w.kind = 'use' AND w.reverted_by IS NULL) AS used
     FROM credit_rewards r
     WHERE r.mac = ? AND r.kind != 'item'
     ORDER BY r.archived, r.sort, r.id`, mac)
    .filter((row) => !row.archived || (row.balance ?? 0) !== 0)
    .map((row) => ({
      reward_id: row.id, name: row.name, emoji: row.emoji, kind: row.kind, unit: UNIT[row.kind], archived: row.archived,
      balance: fromBase(row.kind, row.balance ?? 0),
      redeemed: fromBase(row.kind, row.redeemed ?? 0),
      used: fromBase(row.kind, row.used ?? 0),
    }));
}

// ---------------------------------------------------------------- 孩子(= 设备)

export interface ChildView {
  mac: string;
  alias: string;
  balance: number;
  today: { total: number; done: number; points: number };
  pending_claims: number;
  /** 时间与零花钱余额,自然单位 */
  wallets: { reward_id: number; name: string; emoji: string; kind: RewardKind; unit: string; balance: number }[];
}

export function childView(conn: Db, device: { mac: string; alias: string }, day: string): ChildView {
  return {
    mac: device.mac,
    alias: device.alias,
    balance: balance(conn, device.mac),
    today: daySummary(conn, device.mac, day),
    pending_claims: pendingClaims(conn, device.mac),
    wallets: walletSummary(conn, device.mac)
      .map(({ reward_id, name, emoji, kind, unit, balance: left }) => ({ reward_id, name, emoji, kind, unit, balance: left })),
  };
}

export function pendingClaims(conn: Db, mac: string): number {
  return one<{ n: number }>(conn,
    "SELECT COUNT(*) AS n FROM credit_tasks WHERE mac = ? AND status = 'pending' AND claimed_at IS NOT NULL", mac)?.n ?? 0;
}

// ---------------------------------------------------------------- 规则

export function listRules(conn: Db, mac: string, includeArchived = false): RuleRow[] {
  return all<RuleRow>(conn,
    `SELECT * FROM credit_rules WHERE mac = ?${includeArchived ? '' : ' AND archived = 0'} ORDER BY archived, sort, id`, mac)
    .map((row) => ({ ...row }));
}

export function ruleById(conn: Db, id: number): RuleRow | undefined {
  return plain(one<RuleRow>(conn, 'SELECT * FROM credit_rules WHERE id = ?', id));
}

export function requireRule(conn: Db, id: number): RuleRow {
  const rule = ruleById(conn, id);
  if (!rule) throw new CreditError('作业模板不存在', 404, 'not_found');
  return rule;
}

export function createRule(conn: Db, mac: string, input: { name: string; target_minutes: number }): RuleRow {
  const sort = (one<{ n: number | null }>(conn, 'SELECT MAX(sort) AS n FROM credit_rules WHERE mac = ?', mac)?.n ?? 0) + 1;
  run(conn,
    'INSERT INTO credit_rules (mac, name, sort, target_minutes) VALUES (?, ?, ?, ?)',
    mac, input.name, sort, input.target_minutes);
  return ruleById(conn, lastId(conn))!;
}

export function updateRule(conn: Db, id: number, input: { name?: string; target_minutes?: number }): RuleRow {
  requireRule(conn, id);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.target_minutes !== undefined) { sets.push('target_minutes = ?'); values.push(input.target_minutes); }
  if (sets.length) {
    // 只改模板本身。已经布置出去的作业各自带着当时抄下的参考用时,改这里不会动它们
    run(conn, `UPDATE credit_rules SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...values, id);
  }
  return ruleById(conn, id)!;
}

/** 用过的规则归档(历史作业还要显示它的名字),没用过的直接删 */
export function deleteRule(conn: Db, id: number): 'deleted' | 'archived' {
  requireRule(conn, id);
  if (one(conn, 'SELECT 1 FROM credit_tasks WHERE rule_id = ? LIMIT 1', id)) {
    run(conn, "UPDATE credit_rules SET archived = 1, updated_at = datetime('now') WHERE id = ?", id);
    return 'archived';
  }
  run(conn, 'DELETE FROM credit_rules WHERE id = ?', id);
  return 'deleted';
}

export function restoreRule(conn: Db, id: number): RuleRow {
  requireRule(conn, id);
  run(conn, "UPDATE credit_rules SET archived = 0, updated_at = datetime('now') WHERE id = ?", id);
  return ruleById(conn, id)!;
}

/** 按给定顺序重排;不属于这台设备的 id 忽略 */
export function reorder(conn: Db, table: 'credit_rules' | 'credit_rewards', mac: string, ids: readonly number[]): void {
  tx(conn, () => {
    ids.forEach((id, index) => run(conn, `UPDATE ${table} SET sort = ? WHERE id = ? AND mac = ?`, index + 1, id, mac));
  });
}

// ---------------------------------------------------------------- 作业

export function taskById(conn: Db, id: number): TaskRow | undefined {
  return plain(one<TaskRow>(conn, 'SELECT * FROM credit_tasks WHERE id = ?', id));
}

export function requireTask(conn: Db, id: number): TaskRow {
  const task = taskById(conn, id);
  if (!task) throw new CreditError('作业不存在', 404, 'not_found');
  return task;
}

export function listTasks(conn: Db, mac: string, day: string): TaskRow[] {
  return all<TaskRow>(conn, 'SELECT * FROM credit_tasks WHERE mac = ? AND day = ? ORDER BY id', mac, day)
    .map((row) => ({ ...row }));
}

/** 按日期段、状态筛选,按日期倒序翻页。游标是「日期_id」 */
export function queryTasks(
  conn: Db, mac: string,
  filter: { from?: string | undefined; to?: string | undefined; status?: TaskStatusFilter | undefined; before?: string | undefined },
  limit: number,
): { items: TaskRow[]; next: string | null } {
  const where = ['mac = ?'];
  const params: unknown[] = [mac];
  if (filter.from) { where.push('day >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('day <= ?'); params.push(filter.to); }
  if (filter.status === 'claimed') where.push("status = 'pending' AND claimed_at IS NOT NULL");
  else if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  const cursor = /^(\d{4}-\d{2}-\d{2})_(\d+)$/u.exec(filter.before ?? '');
  if (cursor) { where.push('(day < ? OR (day = ? AND id < ?))'); params.push(cursor[1], cursor[1], Number(cursor[2])); }
  const rows = all<TaskRow>(conn,
    `SELECT * FROM credit_tasks WHERE ${where.join(' AND ')} ORDER BY day DESC, id DESC LIMIT ?`, ...params, limit + 1)
    .map((row) => ({ ...row }));
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, next: more && last ? `${last.day}_${last.id}` : null };
}

/** 布置一项作业:把模板的参考用时抄进来,以后改模板不影响已经布置的 */
function insertTask(conn: Db, mac: string, day: string, ruleId: number | null, name: string, targetMinutes: number): number {
  run(conn,
    'INSERT INTO credit_tasks (mac, day, rule_id, name, target_minutes) VALUES (?, ?, ?, ?, ?)',
    mac, day, ruleId, name, targetMinutes);
  return lastId(conn);
}

/** 按规则布置作业。规则参数整份抄进快照;target_minutes 可以为这一次临时改 */
export function assignTasks(
  conn: Db, mac: string, day: string, items: readonly { rule_id: number; target_minutes?: number | undefined }[],
): TaskRow[] {
  return tx(conn, () => {
    const ids: number[] = [];
    for (const item of items) {
      const rule = ruleById(conn, item.rule_id);
      if (!rule || rule.mac !== mac) throw new CreditError(`规则 ${item.rule_id} 不存在`, 404, 'not_found');
      if (rule.archived) throw new CreditError(`「${rule.name}」已停用,不能再布置`, 409, 'archived');
      ids.push(insertTask(conn, mac, day, rule.id, rule.name, item.target_minutes ?? rule.target_minutes));
    }
    return ids.map((id) => taskById(conn, id)!);
  });
}

/** 不挂模板的临时作业:只用这一次的名字与参考用时 */
export function createCustomTask(
  conn: Db, mac: string, day: string, input: { name: string; target_minutes: number },
): TaskRow {
  return taskById(conn, insertTask(conn, mac, day, null, input.name, input.target_minutes))!;
}

function pendingTask(conn: Db, id: number): TaskRow {
  const task = requireTask(conn, id);
  if (task.status !== 'pending') throw new CreditError('这项作业已经打过分了,要改先在流水里撤销', 409, 'already_scored');
  return task;
}

export function updateTask(conn: Db, id: number, input: { name?: string | undefined; target_minutes?: number | undefined; day?: string | undefined }): TaskRow {
  pendingTask(conn, id);
  if (input.name !== undefined) run(conn, 'UPDATE credit_tasks SET name = ? WHERE id = ?', input.name, id);
  if (input.target_minutes !== undefined) run(conn, 'UPDATE credit_tasks SET target_minutes = ? WHERE id = ?', input.target_minutes, id);
  if (input.day !== undefined) run(conn, 'UPDATE credit_tasks SET day = ? WHERE id = ?', input.day, id);
  return taskById(conn, id)!;
}

export function deleteTask(conn: Db, id: number): void {
  pendingTask(conn, id);
  run(conn, 'DELETE FROM credit_tasks WHERE id = ?', id);
}

/** 孩子说「做完了」:只记申报,不加分;等家长检查后录入结果 */
export function claimTask(conn: Db, id: number, input: { minutes?: number | undefined; note?: string | undefined }): TaskRow {
  pendingTask(conn, id);
  run(conn, "UPDATE credit_tasks SET claimed_at = datetime('now'), claimed_minutes = ?, claim_note = ? WHERE id = ?",
    input.minutes ?? null, (input.note ?? '').slice(0, 200), id);
  return taskById(conn, id)!;
}

/** 驳回申报:家长检查发现没做完 */
export function unclaimTask(conn: Db, id: number): TaskRow {
  pendingTask(conn, id);
  run(conn, "UPDATE credit_tasks SET claimed_at = NULL, claimed_minutes = NULL, claim_note = '' WHERE id = ?", id);
  return taskById(conn, id)!;
}

/** 只算不存:页面录入时实时预览 */
export function previewTask(conn: Db, id: number, points: number, quality: Quality): ScoreResult {
  pendingTask(conn, id);
  return gradeResult(points, quality);
}

/**
 * 打一项作业:家长给的分 + 质量加成。分数记进流水(给 0 分也记,不然撤不了),
 * 实际用时只填在作业行上,供界面上与参考用时对照。
 */
export function scoreTask(
  conn: Db, id: number,
  input: { points: number; quality: Quality; actual_minutes: number | null; note?: string },
  by: Actor = ADMIN,
): { task: TaskRow; score: ScoreResult; balance: number } {
  return tx(conn, () => {
    const task = pendingTask(conn, id);
    const score = gradeResult(input.points, input.quality);
    const note = (input.note ?? '').slice(0, 200);
    const ledgerId = addLedger(conn, task.mac, score.total, 'task', task.id, `${task.day} ${task.name}`, score.explain, by);
    run(conn,
      `UPDATE credit_tasks SET status = 'done', actual_minutes = ?, quality = ?, note = ?,
         base_points = ?, quality_points = ?, total_points = ?, scored_at = datetime('now'), ledger_id = ?
       WHERE id = ?`,
      input.actual_minutes, input.quality, note, score.base_points, score.quality_points, score.total, ledgerId, id);
    return { task: taskById(conn, id)!, score, balance: balance(conn, task.mac) };
  });
}

/**
 * 记「没完成」:记 0 分,不扣分。
 * 流水里仍留一条 0 分的记录 —— 台账上说明这件事发生过,也让撤销(流水撤销)这条路继续可用,
 * 撤销后作业回到待完成。余额不受影响。
 */
export function missTask(conn: Db, id: number, note = '', by: Actor = ADMIN): { task: TaskRow; score: ScoreResult; balance: number } {
  return tx(conn, () => {
    const task = pendingTask(conn, id);
    const score = missedResult();
    const ledgerId = addLedger(conn, task.mac, score.total, 'missed', task.id, `${task.day} ${task.name}`, score.explain, by);
    run(conn,
      `UPDATE credit_tasks SET status = 'missed', note = ?, base_points = 0, quality_points = 0,
         total_points = ?, scored_at = datetime('now'), ledger_id = ?
       WHERE id = ?`,
      note.slice(0, 200), score.total, ledgerId, id);
    return { task: taskById(conn, id)!, score, balance: balance(conn, task.mac) };
  });
}

// ---------------------------------------------------------------- 奖励

export function rewardById(conn: Db, id: number): RewardRow | undefined {
  return plain(one<RewardRow>(conn, 'SELECT * FROM credit_rewards WHERE id = ?', id));
}

export function requireReward(conn: Db, id: number): RewardRow {
  const reward = rewardById(conn, id);
  if (!reward) throw new CreditError('奖励不存在', 404, 'not_found');
  return reward;
}

export function listRewards(conn: Db, mac: string, includeArchived = false): RewardRow[] {
  return all<RewardRow>(conn,
    `SELECT * FROM credit_rewards WHERE mac = ?${includeArchived ? '' : ' AND archived = 0'} ORDER BY archived, sort, cost, id`, mac)
    .map((row) => ({ ...row }));
}

/** 奖励的输入:amount 已换成基本单位(见 units.ts toBase);物品不看 amount,恒为 1 */
export interface RewardInput {
  name?: string | undefined;
  cost?: number | undefined;
  emoji?: string | undefined;
  kind?: RewardKind | undefined;
  amount?: number | undefined;
}

function checkRewardAmount(kind: RewardKind, amount: number | undefined): number {
  if (kind === 'item') return 1;
  if (amount === undefined) {
    throw new CreditError(kind === 'time' ? '时间奖励要填一份换多少分钟' : '零花钱奖励要填一份换多少元', 400, 'invalid');
  }
  const max = kind === 'time' ? 1440 : 10000000;
  if (!Number.isInteger(amount) || amount < 1 || amount > max) {
    throw new CreditError(kind === 'time' ? '一份换的分钟数要在 1~1440 之间' : '一份换的钱要在 0.01~100000 元之间', 400, 'invalid');
  }
  return amount;
}

/** 这个奖励换过、或者账户里有过流水:种类就不能再改,否则余额的单位会乱 */
function rewardUsed(conn: Db, id: number): boolean {
  return !!one(conn, "SELECT 1 FROM credit_ledger WHERE kind = 'redeem' AND ref_id = ? LIMIT 1", id)
    || !!one(conn, 'SELECT 1 FROM credit_wallet WHERE reward_id = ? LIMIT 1', id);
}

export function createReward(conn: Db, mac: string, input: RewardInput & { name: string; cost: number }): RewardRow {
  const kind = input.kind ?? 'item';
  const amount = checkRewardAmount(kind, input.amount);
  const sort = (one<{ n: number | null }>(conn, 'SELECT MAX(sort) AS n FROM credit_rewards WHERE mac = ?', mac)?.n ?? 0) + 1;
  run(conn, 'INSERT INTO credit_rewards (mac, name, cost, emoji, sort, kind, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
    mac, input.name, input.cost, input.emoji ?? '', sort, kind, amount);
  return rewardById(conn, lastId(conn))!;
}

/** 份价与一份换多少随时能改,只影响以后的兑换;种类只有没用过时才能改 */
export function updateReward(conn: Db, id: number, input: RewardInput): RewardRow {
  const current = requireReward(conn, id);
  const kind = input.kind ?? current.kind;
  if (kind !== current.kind && rewardUsed(conn, id)) {
    throw new CreditError(`「${current.name}」已经兑换或记过账,不能再改种类;要换种类就新建一个奖励`, 409, 'invalid');
  }
  const amount = kind === current.kind && input.amount === undefined ? current.amount : checkRewardAmount(kind, input.amount);
  if (input.name !== undefined) run(conn, 'UPDATE credit_rewards SET name = ? WHERE id = ?', input.name, id);
  if (input.cost !== undefined) run(conn, 'UPDATE credit_rewards SET cost = ? WHERE id = ?', input.cost, id);
  if (input.emoji !== undefined) run(conn, 'UPDATE credit_rewards SET emoji = ? WHERE id = ?', input.emoji, id);
  run(conn, "UPDATE credit_rewards SET kind = ?, amount = ?, updated_at = datetime('now') WHERE id = ?", kind, amount, id);
  return rewardById(conn, id)!;
}

/** 兑换过或记过账的归档(流水里还要能对上是哪个奖励),没用过的直接删 */
export function deleteReward(conn: Db, id: number): 'deleted' | 'archived' {
  requireReward(conn, id);
  if (rewardUsed(conn, id)) {
    run(conn, "UPDATE credit_rewards SET archived = 1, updated_at = datetime('now') WHERE id = ?", id);
    return 'archived';
  }
  run(conn, 'DELETE FROM credit_rewards WHERE id = ?', id);
  return 'deleted';
}

export function restoreReward(conn: Db, id: number): RewardRow {
  requireReward(conn, id);
  run(conn, "UPDATE credit_rewards SET archived = 0, updated_at = datetime('now') WHERE id = ?", id);
  return rewardById(conn, id)!;
}

/** 兑换的流水标题:「🎮 玩游戏 ×3(15 分钟)」;物品只换一份时就是名字本身 */
export function redeemTitle(reward: RewardRow, times: number): string {
  const label = `${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}`;
  const count = times > 1 ? ` ×${times}` : '';
  return reward.kind === 'item' ? `${label}${count}` : `${label}${count}(${formatQty(reward.kind, reward.amount * times)})`;
}

export interface RedeemResult {
  ledger: LedgerRow;
  balance: number;
  /** 时间 / 零花钱:进账那一笔与账户余额(基本单位) */
  wallet?: { entry: WalletRow; balance: number };
}

/**
 * 兑换 times 份:扣 cost × times 分。余额可以因为惩罚是负的,但兑换必须够分。
 * 时间与零花钱同一个事务里往这个奖励的账户记一笔进账 amount × times。
 */
export function redeem(
  conn: Db, mac: string, rewardId: number, times = 1, note = '', by: Actor = ADMIN,
): RedeemResult {
  if (!Number.isInteger(times) || times < 1 || times > 100) throw new CreditError('一次兑换 1~100 份', 400, 'invalid');
  return tx(conn, () => {
    const reward = rewardById(conn, rewardId);
    if (!reward || reward.mac !== mac) throw new CreditError('奖励不存在', 404, 'not_found');
    if (reward.archived) throw new CreditError(`「${reward.name}」已停用`, 409, 'archived');
    const cost = reward.cost * times;
    const current = balance(conn, mac);
    if (current < cost) {
      throw new CreditError(`分数不够,${times > 1 ? `换 ${times} 份要 ${cost} 分,` : ''}还差 ${cost - current} 分`, 409, 'insufficient_balance');
    }
    const title = redeemTitle(reward, times);
    const id = addLedger(conn, mac, -cost, 'redeem', reward.id, title, note, by, times);
    const result: RedeemResult = { ledger: ledgerById(conn, id)!, balance: balance(conn, mac) };
    if (reward.kind !== 'item') {
      const entry = addWallet(conn, mac, reward.id, reward.amount * times, 'redeem', { ledgerId: id }, title, note, by);
      result.wallet = { entry: walletById(conn, entry)!, balance: walletBalance(conn, reward.id) };
    }
    return result;
  });
}

/** 家长手动奖惩,比如「主动帮忙做家务 +5」 */
export function adjust(conn: Db, mac: string, delta: number, reason: string, by: Actor = ADMIN): { ledger: LedgerRow; balance: number } {
  return tx(conn, () => {
    const id = addLedger(conn, mac, delta, 'adjust', null, reason, '', by);
    return { ledger: ledgerById(conn, id)!, balance: balance(conn, mac) };
  });
}

// ---------------------------------------------------------------- 流水

export function ledgerById(conn: Db, id: number): LedgerRow | undefined {
  return plain(one<LedgerRow>(conn,
    `SELECT l.*, (SELECT SUM(delta) FROM credit_ledger x WHERE x.mac = l.mac AND x.id <= l.id) AS balance_after
     FROM credit_ledger l WHERE l.id = ?`, id));
}

/** 按 id 倒序翻页;可按类型与北京时间的日期段筛选;每条带上它之后的余额 */
export function ledgerPage(
  conn: Db, mac: string, before: number | null, limit: number,
  filter: { kind?: LedgerKind | undefined; from?: string | undefined; to?: string | undefined } = {},
): { items: LedgerRow[]; next: number | null } {
  const where = ['l.mac = ?'];
  const params: unknown[] = [mac];
  if (before) { where.push('l.id < ?'); params.push(before); }
  if (filter.kind) { where.push('l.kind = ?'); params.push(filter.kind); }
  if (filter.from) { where.push(`date(l.created_at, '+8 hours') >= ?`); params.push(filter.from); }
  if (filter.to) { where.push(`date(l.created_at, '+8 hours') <= ?`); params.push(filter.to); }
  const rows = all<LedgerRow>(conn,
    `SELECT l.*, (SELECT SUM(delta) FROM credit_ledger x WHERE x.mac = l.mac AND x.id <= l.id) AS balance_after
     FROM credit_ledger l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`, ...params, limit + 1)
    .map((row) => ({ ...row }));
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next: more ? items.at(-1)!.id : null };
}

/**
 * 撤销一笔流水:追加一条等额反向的,原流水记下是被谁撤销的。
 * 撤销的是作业打分时,作业回到「待完成」,可以重新录入。撤销流水本身不能再撤。
 */
export function revert(
  conn: Db, ledgerId: number, by: Actor = ADMIN,
): { ledger: LedgerRow; balance: number; task?: TaskRow; wallet?: { entry: WalletRow; balance: number } } {
  return tx(conn, () => {
    const row = ledgerById(conn, ledgerId);
    if (!row) throw new CreditError('流水不存在', 404, 'not_found');
    if (row.kind === 'revert') throw new CreditError('撤销记录本身不能再撤销', 409, 'not_revertible');
    if (row.reverted_by) throw new CreditError('这一笔已经撤销过了', 409, 'already_reverted');
    // 撤销时间 / 零花钱的兑换:账户里那笔进账一起退回;已经用掉了就退不回,余额不能变负
    const income = row.kind === 'redeem'
      ? one<{ id: number; reward_id: number; qty: number }>(conn,
        "SELECT id, reward_id, qty FROM credit_wallet WHERE ledger_id = ? AND kind = 'redeem' AND reverted_by IS NULL", row.id)
      : undefined;
    if (income) {
      const left = walletBalance(conn, income.reward_id);
      if (left < income.qty) {
        const reward = rewardById(conn, income.reward_id)!;
        throw new CreditError(
          `这次兑换的 ${formatQty(reward.kind, income.qty)}已经用掉了一部分(账户只剩 ${formatQty(reward.kind, left)}),`
          + '要撤销得先撤销用掉的记录', 409, 'insufficient_wallet');
      }
    }
    const id = addLedger(conn, row.mac, -row.delta, 'revert', row.id, `撤销:${row.title}`, '', by);
    let wallet: { entry: WalletRow; balance: number } | undefined;
    if (income) {
      const back = addWallet(conn, row.mac, income.reward_id, -income.qty, 'revert', { ledgerId: id, refId: income.id },
        `撤销:${row.title}`, '', by);
      run(conn, 'UPDATE credit_wallet SET reverted_by = ? WHERE id = ?', back, income.id);
      wallet = { entry: walletById(conn, back)!, balance: walletBalance(conn, income.reward_id) };
    }
    run(conn, 'UPDATE credit_ledger SET reverted_by = ? WHERE id = ?', id, row.id);
    let task: TaskRow | undefined;
    if (row.kind === 'task' || row.kind === 'missed') {
      const found = one<{ id: number }>(conn, 'SELECT id FROM credit_tasks WHERE ledger_id = ?', row.id);
      if (found) {
        run(conn,
          `UPDATE credit_tasks SET status = 'pending', actual_minutes = NULL, quality = NULL, note = '',
             base_points = NULL, quality_points = NULL, total_points = NULL, scored_at = NULL, ledger_id = NULL
           WHERE id = ?`, found.id);
        task = taskById(conn, found.id);
      }
    }
    return { ledger: ledgerById(conn, id)!, balance: balance(conn, row.mac), ...(task ? { task } : {}), ...(wallet ? { wallet } : {}) };
  });
}

// ---------------------------------------------------------------- 概览与统计

export function daySummary(conn: Db, mac: string, day: string): { total: number; done: number; points: number } {
  const row = one<{ total: number; done: number | null; points: number | null }>(conn,
    `SELECT COUNT(*) AS total, SUM(status != 'pending') AS done, SUM(COALESCE(total_points, 0)) AS points
     FROM credit_tasks WHERE mac = ? AND day = ?`, mac, day);
  return { total: row?.total ?? 0, done: row?.done ?? 0, points: row?.points ?? 0 };
}

export interface CreditStats {
  from: string;
  to: string;
  balance: number;
  /** 每天:挣的(作业与手动加分)、扣的(手动扣分,以及历史里旧公式算出的扣分)、花掉的(兑换)。撤销过的与撤销记录本身不计 */
  days: { day: string; earned: number; penalty: number; spent: number; net: number }[];
  totals: { earned: number; penalty: number; spent: number; net: number };
  /** 各项作业:布置几次、完成几次、没完成几次、参考用时内完成几次、平均用时与平均得分 */
  tasks: { name: string; assigned: number; done: number; missed: number; ontime: number; avg_minutes: number | null; avg_points: number | null }[];
  completion_rate: number | null;
  /** 参考用时内完成的比例:参考用时只是对照,这个数也就只是个软指标 */
  ontime_rate: number | null;
  /** 已打完分的作业平均得几分(给分 + 质量加成) */
  avg_points: number | null;
  /** 各奖励兑换了几次、几份、多少(自然单位)、花了多少分。撤销过的不计 */
  redeemed: { reward_id: number; name: string; emoji: string; kind: RewardKind; unit: string; count: number; times: number; quantity: number; points: number }[];
  /** 各时间 / 零花钱账户这段时间进了多少、用了多少(自然单位)。撤销过的不计 */
  wallets: { reward_id: number; name: string; emoji: string; kind: RewardKind; unit: string; redeemed: number; used: number }[];
}

export function stats(conn: Db, mac: string, from: string, to: string): CreditStats {
  const rows = all<{ day: string; earned: number; penalty: number; spent: number }>(conn,
    `SELECT ${BEIJING_DAY} AS day,
       SUM(CASE WHEN kind IN ('task', 'adjust') AND delta > 0 THEN delta ELSE 0 END) AS earned,
       SUM(CASE WHEN kind IN ('task', 'missed', 'adjust') AND delta < 0 THEN -delta ELSE 0 END) AS penalty,
       SUM(CASE WHEN kind = 'redeem' THEN -delta ELSE 0 END) AS spent
     FROM credit_ledger
     WHERE mac = ? AND kind != 'revert' AND reverted_by IS NULL AND ${BEIJING_DAY} BETWEEN ? AND ?
     GROUP BY day`, mac, from, to);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days: CreditStats['days'] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    const row = byDay.get(day);
    const earned = row?.earned ?? 0;
    const penalty = row?.penalty ?? 0;
    const spent = row?.spent ?? 0;
    days.push({ day, earned, penalty, spent, net: earned - penalty - spent });
    if (days.length > 400) break;
  }
  const totals = days.reduce((acc, d) => ({
    earned: acc.earned + d.earned, penalty: acc.penalty + d.penalty, spent: acc.spent + d.spent, net: acc.net + d.net,
  }), { earned: 0, penalty: 0, spent: 0, net: 0 });

  const tasks = all<CreditStats['tasks'][number]>(conn,
    `SELECT name,
       COUNT(*) AS assigned,
       SUM(status = 'done') AS done,
       SUM(status = 'missed') AS missed,
       SUM(status = 'done' AND actual_minutes <= target_minutes) AS ontime,
       ROUND(AVG(CASE WHEN status = 'done' THEN actual_minutes END), 1) AS avg_minutes,
       ROUND(AVG(CASE WHEN status != 'pending' THEN total_points END), 1) AS avg_points
     FROM credit_tasks WHERE mac = ? AND day BETWEEN ? AND ?
     GROUP BY name ORDER BY assigned DESC, name`, mac, from, to).map((row) => ({ ...row }));
  const assigned = tasks.reduce((n, t) => n + t.assigned, 0);
  const done = tasks.reduce((n, t) => n + t.done, 0);
  const finished = tasks.reduce((n, t) => n + t.done + t.missed, 0);
  const ontime = tasks.reduce((n, t) => n + t.ontime, 0);
  const redeemed = all<{ reward_id: number; name: string; emoji: string; kind: RewardKind; amount: number; count: number; times: number; points: number }>(conn,
    `SELECT r.id AS reward_id, r.name, r.emoji, r.kind, r.amount,
       COUNT(*) AS count, SUM(COALESCE(l.times, 1)) AS times, -SUM(l.delta) AS points
     FROM credit_ledger l JOIN credit_rewards r ON r.id = l.ref_id
     WHERE l.mac = ? AND l.kind = 'redeem' AND l.reverted_by IS NULL AND date(l.created_at, '+8 hours') BETWEEN ? AND ?
     GROUP BY r.id ORDER BY points DESC, r.id`, mac, from, to)
    .map((row) => {
      const quantity = row.kind === 'item'
        ? row.times
        : fromBase(row.kind, one<{ n: number | null }>(conn,
          `SELECT SUM(w.qty) AS n FROM credit_wallet w JOIN credit_ledger l ON l.id = w.ledger_id
           WHERE w.reward_id = ? AND w.kind = 'redeem' AND w.reverted_by IS NULL AND date(l.created_at, '+8 hours') BETWEEN ? AND ?`,
          row.reward_id, from, to)?.n ?? 0);
      return {
        reward_id: row.reward_id, name: row.name, emoji: row.emoji, kind: row.kind, unit: UNIT[row.kind],
        count: row.count, times: row.times, quantity, points: row.points,
      };
    });
  const wallets = all<{ reward_id: number; name: string; emoji: string; kind: RewardKind; redeemed: number | null; used: number | null }>(conn,
    `SELECT r.id AS reward_id, r.name, r.emoji, r.kind,
       SUM(CASE WHEN w.kind = 'redeem' THEN w.qty ELSE 0 END) AS redeemed,
       -SUM(CASE WHEN w.kind = 'use' THEN w.qty ELSE 0 END) AS used
     FROM credit_wallet w JOIN credit_rewards r ON r.id = w.reward_id
     WHERE w.mac = ? AND w.kind IN ('redeem', 'use') AND w.reverted_by IS NULL AND date(w.created_at, '+8 hours') BETWEEN ? AND ?
     GROUP BY r.id ORDER BY r.sort, r.id`, mac, from, to)
    .map((row) => ({
      reward_id: row.reward_id, name: row.name, emoji: row.emoji, kind: row.kind, unit: UNIT[row.kind],
      redeemed: fromBase(row.kind, row.redeemed ?? 0), used: fromBase(row.kind, row.used ?? 0),
    }));
  return {
    from, to, balance: balance(conn, mac), days, totals, tasks,
    completion_rate: finished ? Math.round((done / finished) * 1000) / 1000 : null,
    // 「参考用时内完成」的比例:参考用时只作对照,这个数也只是个软指标
    ontime_rate: done ? Math.round((ontime / done) * 1000) / 1000 : (assigned ? 0 : null),
    // 已打完分的作业平均得几分(给分 + 质量加成)
    avg_points: one<{ n: number | null }>(conn,
      "SELECT ROUND(AVG(total_points), 1) AS n FROM credit_tasks WHERE mac = ? AND status = 'done' AND day BETWEEN ? AND ?",
      mac, from, to)?.n ?? null,
    redeemed, wallets,
  };
}

// ---------------------------------------------------------------- 示例

/** 一台设备还什么都没有时,一键建好几条示例规则与奖励,家长再按自家情况改 */
export function seedExamples(conn: Db, mac: string): { rules: number; rewards: number } {
  return tx(conn, () => {
    let rules = 0;
    let rewards = 0;
    if (!one(conn, 'SELECT 1 FROM credit_rules WHERE mac = ? LIMIT 1', mac)) {
      for (const [name, minutes] of [['语文作业', 40], ['数学作业', 40], ['英语作业', 30]] as const) {
        createRule(conn, mac, { name, target_minutes: minutes });
        rules += 1;
      }
    }
    if (!one(conn, 'SELECT 1 FROM credit_rewards WHERE mac = ? LIMIT 1', mac)) {
      // 10 分 = 5 分钟游戏 / 5 元零花钱 / 10 分钟电视;amount 是基本单位(钱按分)
      const examples = [
        ['玩游戏', 10, '🎮', 'time', 5], ['零花钱', 10, '💰', 'money', 500], ['看电视', 10, '📺', 'time', 10],
      ] as const;
      for (const [name, cost, emoji, kind, amount] of examples) {
        createReward(conn, mac, { name, cost, emoji, kind, amount });
        rewards += 1;
      }
    }
    return { rules, rewards };
  });
}
