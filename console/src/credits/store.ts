// 学分的数据库读写。
//
// 两条不变量,所有写操作都围着它们转:
//   1. 余额 = 流水 delta 之和。不另存余额,所以永远对得上账;
//   2. 流水只追加不修改。撤销是追加一条等额反向的流水,并在原流水上记 reverted_by。
// 凡是「改作业状态 + 写流水」的都放在同一个事务里(tx 不可重入,事务里别再调别的 tx)。

import type { Db } from '../db.ts';
import { all, one, run, tx } from '../db.ts';
import { formatBeijing } from '../agent/reminders/time.ts';
import { scoreMissed, scoreResult, type Quality, type ScoreParams, type ScoreResult } from './score.ts';

/** 带 HTTP 状态的业务错误,路由层原样转成 {error} */
export class CreditError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

/** 规则上可以调的数值,也是布置作业时要抄进快照的那一组 */
export const PARAM_KEYS = [
  'target_minutes', 'ontime_points', 'overtime_step', 'overtime_penalty', 'overtime_cap',
  'q_excellent', 'q_good', 'q_fair', 'q_poor', 'missed_penalty',
] as const satisfies readonly (keyof ScoreParams)[];

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
  created_at: string;
  /** 这一笔之后的余额(查询时现算) */
  balance_after?: number;
}

export type RuleInput = Partial<ScoreParams> & { name?: string };

const plain = <T>(row: T | undefined): T | undefined => (row ? ({ ...row } as T) : undefined);
const lastId = (conn: Db) => one<{ id: number }>(conn, 'SELECT last_insert_rowid() AS id')!.id;

/** 北京时间的今天,YYYY-MM-DD */
export function today(now: Date = new Date()): string {
  return formatBeijing(now).slice(0, 10);
}

// ---------------------------------------------------------------- 余额

export function balance(conn: Db, mac: string): number {
  return one<{ n: number | null }>(conn, 'SELECT SUM(delta) AS n FROM credit_ledger WHERE mac = ?', mac)?.n ?? 0;
}

function addLedger(
  conn: Db, mac: string, delta: number, kind: LedgerKind, refId: number | null, title: string, note = '',
): number {
  run(conn,
    'INSERT INTO credit_ledger (mac, delta, kind, ref_id, title, note) VALUES (?, ?, ?, ?, ?, ?)',
    mac, delta, kind, refId, title.slice(0, 80), note.slice(0, 200));
  return lastId(conn);
}

// ---------------------------------------------------------------- 规则

export function listRules(conn: Db, mac: string, includeArchived = false): RuleRow[] {
  return all<RuleRow>(conn,
    `SELECT * FROM credit_rules WHERE mac = ?${includeArchived ? '' : ' AND archived = 0'} ORDER BY sort, id`, mac)
    .map((row) => ({ ...row }));
}

export function ruleById(conn: Db, id: number): RuleRow | undefined {
  return plain(one<RuleRow>(conn, 'SELECT * FROM credit_rules WHERE id = ?', id));
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

export function updateRule(conn: Db, id: number, input: RuleInput): RuleRow | undefined {
  const rule = ruleById(conn, id);
  if (!rule) return undefined;
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
  return ruleById(conn, id);
}

/** 用过的规则归档(历史作业还要显示它的名字),没用过的直接删 */
export function deleteRule(conn: Db, id: number): 'deleted' | 'archived' | undefined {
  if (!ruleById(conn, id)) return undefined;
  if (one(conn, 'SELECT 1 FROM credit_tasks WHERE rule_id = ? LIMIT 1', id)) {
    run(conn, "UPDATE credit_rules SET archived = 1, updated_at = datetime('now') WHERE id = ?", id);
    return 'archived';
  }
  run(conn, 'DELETE FROM credit_rules WHERE id = ?', id);
  return 'deleted';
}

// ---------------------------------------------------------------- 作业

export function taskById(conn: Db, id: number): TaskRow | undefined {
  return plain(one<TaskRow>(conn, 'SELECT * FROM credit_tasks WHERE id = ?', id));
}

export function listTasks(conn: Db, mac: string, day: string): TaskRow[] {
  return all<TaskRow>(conn, 'SELECT * FROM credit_tasks WHERE mac = ? AND day = ? ORDER BY id', mac, day)
    .map((row) => ({ ...row }));
}

/** 按规则布置作业。规则参数整份抄进快照;target_minutes 可以为这一次临时改 */
export function assignTasks(
  conn: Db, mac: string, day: string, items: readonly { rule_id: number; target_minutes?: number | undefined }[],
): TaskRow[] {
  return tx(conn, () => {
    const ids: number[] = [];
    for (const item of items) {
      const rule = ruleById(conn, item.rule_id);
      if (!rule || rule.mac !== mac) throw new CreditError(`规则 ${item.rule_id} 不存在`, 404);
      if (rule.archived) throw new CreditError(`「${rule.name}」已停用,不能再布置`, 409);
      const params: ScoreParams = { ...pick(rule), target_minutes: item.target_minutes ?? rule.target_minutes };
      run(conn,
        `INSERT INTO credit_tasks (mac, day, rule_id, name, ${PARAM_KEYS.join(', ')})
         VALUES (?, ?, ?, ?, ${PARAM_KEYS.map(() => '?').join(', ')})`,
        mac, day, rule.id, rule.name, ...PARAM_KEYS.map((key) => params[key]));
      ids.push(lastId(conn));
    }
    return ids.map((id) => taskById(conn, id)!);
  });
}

function pick(row: ScoreParams): ScoreParams {
  return Object.fromEntries(PARAM_KEYS.map((key) => [key, row[key]])) as unknown as ScoreParams;
}

function pendingTask(conn: Db, id: number): TaskRow {
  const task = taskById(conn, id);
  if (!task) throw new CreditError('作业不存在', 404);
  if (task.status !== 'pending') throw new CreditError('这项作业已经打过分了,要改先在流水里撤销', 409);
  return task;
}

export function updateTask(conn: Db, id: number, input: { name?: string; target_minutes?: number }): TaskRow {
  pendingTask(conn, id);
  if (input.name !== undefined) run(conn, 'UPDATE credit_tasks SET name = ? WHERE id = ?', input.name, id);
  if (input.target_minutes !== undefined) {
    run(conn, 'UPDATE credit_tasks SET target_minutes = ? WHERE id = ?', input.target_minutes, id);
  }
  return taskById(conn, id)!;
}

export function deleteTask(conn: Db, id: number): void {
  pendingTask(conn, id);
  run(conn, 'DELETE FROM credit_tasks WHERE id = ?', id);
}

/** 只算不存:页面录入时实时预览 */
export function previewTask(conn: Db, id: number, actualMinutes: number, quality: Quality): ScoreResult {
  return scoreResult(pendingTask(conn, id), actualMinutes, quality);
}

export function scoreTask(
  conn: Db, id: number, actualMinutes: number, quality: Quality, note = '',
): { task: TaskRow; score: ScoreResult; balance: number } {
  return tx(conn, () => {
    const task = pendingTask(conn, id);
    const score = scoreResult(task, actualMinutes, quality);
    const ledgerId = addLedger(conn, task.mac, score.total, 'task', task.id, `${task.day} ${task.name}`, score.explain);
    run(conn,
      `UPDATE credit_tasks SET status = 'done', actual_minutes = ?, quality = ?, note = ?,
         time_points = ?, quality_points = ?, total_points = ?, scored_at = datetime('now'), ledger_id = ?
       WHERE id = ?`,
      actualMinutes, quality, note.slice(0, 200), score.time_points, score.quality_points, score.total, ledgerId, id);
    return { task: taskById(conn, id)!, score, balance: balance(conn, task.mac) };
  });
}

export function missTask(conn: Db, id: number, note = ''): { task: TaskRow; score: ScoreResult; balance: number } {
  return tx(conn, () => {
    const task = pendingTask(conn, id);
    const score = scoreMissed(task);
    const ledgerId = addLedger(conn, task.mac, score.total, 'missed', task.id, `${task.day} ${task.name}`, score.explain);
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

export function listRewards(conn: Db, mac: string): RewardRow[] {
  return all<RewardRow>(conn, 'SELECT * FROM credit_rewards WHERE mac = ? AND archived = 0 ORDER BY sort, cost, id', mac)
    .map((row) => ({ ...row }));
}

export function createReward(conn: Db, mac: string, input: { name: string; cost: number; emoji?: string }): RewardRow {
  const sort = (one<{ n: number | null }>(conn, 'SELECT MAX(sort) AS n FROM credit_rewards WHERE mac = ?', mac)?.n ?? 0) + 1;
  run(conn, 'INSERT INTO credit_rewards (mac, name, cost, emoji, sort) VALUES (?, ?, ?, ?, ?)',
    mac, input.name, input.cost, input.emoji ?? '', sort);
  return rewardById(conn, lastId(conn))!;
}

export function updateReward(
  conn: Db, id: number, input: { name?: string; cost?: number; emoji?: string },
): RewardRow | undefined {
  if (!rewardById(conn, id)) return undefined;
  if (input.name !== undefined) run(conn, 'UPDATE credit_rewards SET name = ? WHERE id = ?', input.name, id);
  if (input.cost !== undefined) run(conn, 'UPDATE credit_rewards SET cost = ? WHERE id = ?', input.cost, id);
  if (input.emoji !== undefined) run(conn, 'UPDATE credit_rewards SET emoji = ? WHERE id = ?', input.emoji, id);
  run(conn, "UPDATE credit_rewards SET updated_at = datetime('now') WHERE id = ?", id);
  return rewardById(conn, id);
}

/** 兑换过的归档(流水里还要能对上是哪个奖励),没兑换过的直接删 */
export function deleteReward(conn: Db, id: number): 'deleted' | 'archived' | undefined {
  if (!rewardById(conn, id)) return undefined;
  if (one(conn, "SELECT 1 FROM credit_ledger WHERE kind = 'redeem' AND ref_id = ? LIMIT 1", id)) {
    run(conn, "UPDATE credit_rewards SET archived = 1, updated_at = datetime('now') WHERE id = ?", id);
    return 'archived';
  }
  run(conn, 'DELETE FROM credit_rewards WHERE id = ?', id);
  return 'deleted';
}

/** 兑换:余额可以因为惩罚是负的,但兑换必须够分 */
export function redeem(conn: Db, mac: string, rewardId: number, note = ''): { ledger: LedgerRow; balance: number } {
  return tx(conn, () => {
    const reward = rewardById(conn, rewardId);
    if (!reward || reward.mac !== mac || reward.archived) throw new CreditError('奖励不存在', 404);
    const current = balance(conn, mac);
    if (current < reward.cost) throw new CreditError(`分数不够,还差 ${reward.cost - current} 分`, 409);
    const id = addLedger(conn, mac, -reward.cost, 'redeem', reward.id, `${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}`, note);
    return { ledger: ledgerById(conn, id)!, balance: balance(conn, mac) };
  });
}

/** 家长手动奖惩,比如「主动帮忙做家务 +5」 */
export function adjust(conn: Db, mac: string, delta: number, reason: string): { ledger: LedgerRow; balance: number } {
  return tx(conn, () => {
    const id = addLedger(conn, mac, delta, 'adjust', null, reason);
    return { ledger: ledgerById(conn, id)!, balance: balance(conn, mac) };
  });
}

// ---------------------------------------------------------------- 流水

export function ledgerById(conn: Db, id: number): LedgerRow | undefined {
  return plain(one<LedgerRow>(conn, 'SELECT * FROM credit_ledger WHERE id = ?', id));
}

/** 按 id 倒序翻页;每条带上它之后的余额 */
export function ledgerPage(conn: Db, mac: string, before: number | null, limit: number): { items: LedgerRow[]; next: number | null } {
  const rows = all<LedgerRow>(conn,
    `SELECT l.*, (SELECT SUM(delta) FROM credit_ledger x WHERE x.mac = l.mac AND x.id <= l.id) AS balance_after
     FROM credit_ledger l WHERE l.mac = ?${before ? ' AND l.id < ?' : ''} ORDER BY l.id DESC LIMIT ?`,
    ...(before ? [mac, before, limit + 1] : [mac, limit + 1])).map((row) => ({ ...row }));
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, next: more ? items.at(-1)!.id : null };
}

/**
 * 撤销一笔流水:追加一条等额反向的,原流水记下是被谁撤销的。
 * 撤销的是作业打分时,作业回到「待完成」,可以重新录入。撤销流水本身不能再撤。
 */
export function revert(conn: Db, ledgerId: number): { ledger: LedgerRow; balance: number; task?: TaskRow } {
  return tx(conn, () => {
    const row = ledgerById(conn, ledgerId);
    if (!row) throw new CreditError('流水不存在', 404);
    if (row.kind === 'revert') throw new CreditError('撤销记录本身不能再撤销', 409);
    if (row.reverted_by) throw new CreditError('这一笔已经撤销过了', 409);
    const id = addLedger(conn, row.mac, -row.delta, 'revert', row.id, `撤销:${row.title}`);
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

// ---------------------------------------------------------------- 概览

export function daySummary(conn: Db, mac: string, day: string): { total: number; done: number; points: number } {
  const row = one<{ total: number; done: number; points: number | null }>(conn,
    `SELECT COUNT(*) AS total, SUM(status != 'pending') AS done, SUM(COALESCE(total_points, 0)) AS points
     FROM credit_tasks WHERE mac = ? AND day = ?`, mac, day);
  return { total: row?.total ?? 0, done: row?.done ?? 0, points: row?.points ?? 0 };
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
