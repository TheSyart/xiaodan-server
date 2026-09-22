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
import { scoreMissed, scoreResult, type Quality, type ScoreParams, type ScoreResult } from './score.ts';

export type CreditErrorCode =
  | 'invalid' | 'not_found' | 'device_not_found' | 'already_scored' | 'archived'
  | 'insufficient_balance' | 'already_reverted' | 'not_revertible' | 'read_only_key' | 'idempotency_key_reused';

/** 带 HTTP 状态与机器可读代码的业务错误,路由层原样转成 {error, code} */
export class CreditError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422;
  readonly code: CreditErrorCode;

  constructor(message: string, status: 400 | 403 | 404 | 409 | 422, code: CreditErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 这一笔是谁动的 */
export interface Actor {
  source: 'admin' | 'api' | 'agent';
  actor: string;
}
export const ADMIN: Actor = { source: 'admin', actor: '' };

/** 规则上可以调的数值,也是布置作业时要抄进快照的那一组 */
export const PARAM_KEYS = [
  'target_minutes', 'ontime_points', 'overtime_step', 'overtime_penalty', 'overtime_cap',
  'q_excellent', 'q_good', 'q_fair', 'q_poor', 'missed_penalty',
] as const satisfies readonly (keyof ScoreParams)[];

export const DEFAULT_PARAMS: Omit<ScoreParams, 'target_minutes'> = {
  ontime_points: 5, overtime_step: 10, overtime_penalty: 1, overtime_cap: 5,
  q_excellent: 5, q_good: 3, q_fair: 0, q_poor: -2, missed_penalty: 5,
};

export interface RuleRow extends ScoreParams {
  id: number;
  mac: string;
  name: string;
  sort: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow extends ScoreParams {
  id: number;
  mac: string;
  day: string;
  rule_id: number | null;
  name: string;
  status: 'pending' | 'done' | 'missed';
  actual_minutes: number | null;
  quality: Quality | null;
  note: string;
  time_points: number | null;
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
  cost: number;
  emoji: string;
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
  created_at: string;
  /** 这一笔之后的余额(查询时现算) */
  balance_after?: number;
}

export type RuleInput = Partial<ScoreParams> & { name?: string };
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
): number {
  run(conn,
    'INSERT INTO credit_ledger (mac, delta, kind, ref_id, title, note, source, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    mac, delta, kind, refId, title.slice(0, 80), note.slice(0, 200), by.source, by.actor.slice(0, 40));
  return lastId(conn);
}

// ---------------------------------------------------------------- 孩子(= 设备)

export interface ChildView {
  mac: string;
  alias: string;
  balance: number;
  today: { total: number; done: number; points: number };
  pending_claims: number;
}

export function childView(conn: Db, device: { mac: string; alias: string }, day: string): ChildView {
  return {
    mac: device.mac,
    alias: device.alias,
    balance: balance(conn, device.mac),
    today: daySummary(conn, device.mac, day),
    pending_claims: pendingClaims(conn, device.mac),
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
  if (!rule) throw new CreditError('规则不存在', 404, 'not_found');
  return rule;
}

export function createRule(conn: Db, mac: string, input: RuleInput & { name: string; target_minutes: number }): RuleRow {
  const sort = (one<{ n: number | null }>(conn, 'SELECT MAX(sort) AS n FROM credit_rules WHERE mac = ?', mac)?.n ?? 0) + 1;
  const keys = PARAM_KEYS.filter((key) => input[key] !== undefined);
  run(conn,
    `INSERT INTO credit_rules (mac, name, sort${keys.map((k) => `, ${k}`).join('')})
     VALUES (?, ?, ?${keys.map(() => ', ?').join('')})`,
    mac, input.name, sort, ...keys.map((key) => input[key]));
  return ruleById(conn, lastId(conn))!;
}

export function updateRule(conn: Db, id: number, input: RuleInput): RuleRow {
  requireRule(conn, id);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  for (const key of PARAM_KEYS) {
    if (input[key] !== undefined) { sets.push(`${key} = ?`); values.push(input[key]); }
  }
  if (sets.length) {
    // 只改规则本身。已经布置出去的作业各自带着快照,改这里不会动它们的分数
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

function insertTask(conn: Db, mac: string, day: string, ruleId: number | null, name: string, params: ScoreParams): number {
  run(conn,
    `INSERT INTO credit_tasks (mac, day, rule_id, name, ${PARAM_KEYS.join(', ')})
     VALUES (?, ?, ?, ?, ${PARAM_KEYS.map(() => '?').join(', ')})`,
    mac, day, ruleId, name, ...PARAM_KEYS.map((key) => params[key]));
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
      ids.push(insertTask(conn, mac, day, rule.id, rule.name, { ...pick(rule), target_minutes: item.target_minutes ?? rule.target_minutes }));
    }
    return ids.map((id) => taskById(conn, id)!);
  });
}

/** 不挂规则的临时作业:参数现填,没填的用默认值 */
export function createCustomTask(
  conn: Db, mac: string, day: string, input: Partial<ScoreParams> & { name: string; target_minutes: number },
): TaskRow {
  const params: ScoreParams = { ...DEFAULT_PARAMS, ...definedOnly(input) } as ScoreParams;
  return taskById(conn, insertTask(conn, mac, day, null, input.name, params))!;
}

function definedOnly<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function pick(row: ScoreParams): ScoreParams {
  return Object.fromEntries(PARAM_KEYS.map((key) => [key, row[key]])) as unknown as ScoreParams;
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
export function previewTask(conn: Db, id: number, actualMinutes: number, quality: Quality): ScoreResult {
  return scoreResult(pendingTask(conn, id), actualMinutes, quality);
}

export function scoreTask(
  conn: Db, id: number, actualMinutes: number, quality: Quality, note = '', by: Actor = ADMIN,
): { task: TaskRow; score: ScoreResult; balance: number } {
  return tx(conn, () => {
    const task = pendingTask(conn, id);
    const score = scoreResult(task, actualMinutes, quality);
    const ledgerId = addLedger(conn, task.mac, score.total, 'task', task.id, `${task.day} ${task.name}`, score.explain, by);
    run(conn,
      `UPDATE credit_tasks SET status = 'done', actual_minutes = ?, quality = ?, note = ?,
         time_points = ?, quality_points = ?, total_points = ?, scored_at = datetime('now'), ledger_id = ?
       WHERE id = ?`,
      actualMinutes, quality, note.slice(0, 200), score.time_points, score.quality_points, score.total, ledgerId, id);
    return { task: taskById(conn, id)!, score, balance: balance(conn, task.mac) };
  });
}

export function missTask(conn: Db, id: number, note = '', by: Actor = ADMIN): { task: TaskRow; score: ScoreResult; balance: number } {
  return tx(conn, () => {
    const task = pendingTask(conn, id);
    const score = scoreMissed(task);
    const ledgerId = addLedger(conn, task.mac, score.total, 'missed', task.id, `${task.day} ${task.name}`, score.explain, by);
    run(conn,
      `UPDATE credit_tasks SET status = 'missed', note = ?, time_points = 0, quality_points = 0,
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

export function createReward(conn: Db, mac: string, input: { name: string; cost: number; emoji?: string | undefined }): RewardRow {
  const sort = (one<{ n: number | null }>(conn, 'SELECT MAX(sort) AS n FROM credit_rewards WHERE mac = ?', mac)?.n ?? 0) + 1;
  run(conn, 'INSERT INTO credit_rewards (mac, name, cost, emoji, sort) VALUES (?, ?, ?, ?, ?)',
    mac, input.name, input.cost, input.emoji ?? '', sort);
  return rewardById(conn, lastId(conn))!;
}

export function updateReward(
  conn: Db, id: number, input: { name?: string | undefined; cost?: number | undefined; emoji?: string | undefined },
): RewardRow {
  requireReward(conn, id);
  if (input.name !== undefined) run(conn, 'UPDATE credit_rewards SET name = ? WHERE id = ?', input.name, id);
  if (input.cost !== undefined) run(conn, 'UPDATE credit_rewards SET cost = ? WHERE id = ?', input.cost, id);
  if (input.emoji !== undefined) run(conn, 'UPDATE credit_rewards SET emoji = ? WHERE id = ?', input.emoji, id);
  run(conn, "UPDATE credit_rewards SET updated_at = datetime('now') WHERE id = ?", id);
  return rewardById(conn, id)!;
}

/** 兑换过的归档(流水里还要能对上是哪个奖励),没兑换过的直接删 */
export function deleteReward(conn: Db, id: number): 'deleted' | 'archived' {
  requireReward(conn, id);
  if (one(conn, "SELECT 1 FROM credit_ledger WHERE kind = 'redeem' AND ref_id = ? LIMIT 1", id)) {
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

/** 兑换:余额可以因为惩罚是负的,但兑换必须够分 */
export function redeem(
  conn: Db, mac: string, rewardId: number, note = '', by: Actor = ADMIN,
): { ledger: LedgerRow; balance: number } {
  return tx(conn, () => {
    const reward = rewardById(conn, rewardId);
    if (!reward || reward.mac !== mac) throw new CreditError('奖励不存在', 404, 'not_found');
    if (reward.archived) throw new CreditError(`「${reward.name}」已停用`, 409, 'archived');
    const current = balance(conn, mac);
    if (current < reward.cost) {
      throw new CreditError(`分数不够,还差 ${reward.cost - current} 分`, 409, 'insufficient_balance');
    }
    const id = addLedger(conn, mac, -reward.cost, 'redeem', reward.id,
      `${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}`, note, by);
    return { ledger: ledgerById(conn, id)!, balance: balance(conn, mac) };
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
export function revert(conn: Db, ledgerId: number, by: Actor = ADMIN): { ledger: LedgerRow; balance: number; task?: TaskRow } {
  return tx(conn, () => {
    const row = ledgerById(conn, ledgerId);
    if (!row) throw new CreditError('流水不存在', 404, 'not_found');
    if (row.kind === 'revert') throw new CreditError('撤销记录本身不能再撤销', 409, 'not_revertible');
    if (row.reverted_by) throw new CreditError('这一笔已经撤销过了', 409, 'already_reverted');
    const id = addLedger(conn, row.mac, -row.delta, 'revert', row.id, `撤销:${row.title}`, '', by);
    run(conn, 'UPDATE credit_ledger SET reverted_by = ? WHERE id = ?', id, row.id);
    let task: TaskRow | undefined;
    if (row.kind === 'task' || row.kind === 'missed') {
      const found = one<{ id: number }>(conn, 'SELECT id FROM credit_tasks WHERE ledger_id = ?', row.id);
      if (found) {
        run(conn,
          `UPDATE credit_tasks SET status = 'pending', actual_minutes = NULL, quality = NULL, note = '',
             time_points = NULL, quality_points = NULL, total_points = NULL, scored_at = NULL, ledger_id = NULL
           WHERE id = ?`, found.id);
        task = taskById(conn, found.id);
      }
    }
    return { ledger: ledgerById(conn, id)!, balance: balance(conn, row.mac), ...(task ? { task } : {}) };
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
  /** 每天:挣的(作业与手动加分)、扣的(超时、差评、没完成、手动扣分)、花掉的(兑换)。撤销过的与撤销记录本身不计 */
  days: { day: string; earned: number; penalty: number; spent: number; net: number }[];
  totals: { earned: number; penalty: number; spent: number; net: number };
  /** 各项作业:布置几次、完成几次、没完成几次、按时几次、平均用时与平均得分 */
  tasks: { name: string; assigned: number; done: number; missed: number; ontime: number; avg_minutes: number | null; avg_points: number | null }[];
  completion_rate: number | null;
  ontime_rate: number | null;
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
  return {
    from, to, balance: balance(conn, mac), days, totals, tasks,
    completion_rate: finished ? Math.round((done / finished) * 1000) / 1000 : null,
    ontime_rate: done ? Math.round((ontime / done) * 1000) / 1000 : (assigned ? 0 : null),
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
      for (const [name, cost, emoji] of [['看电视 30 分钟', 20, '📺'], ['玩手机 15 分钟', 15, '📱'], ['买个小玩具', 200, '🧸']] as const) {
        createReward(conn, mac, { name, cost, emoji });
        rewards += 1;
      }
    }
    return { rules, rewards };
  });
}
