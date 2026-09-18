// 冷记忆:一段对话的档案(标题、摘要、要点、关键词)。原文仍在 chat_messages 里,靠 arc_id 关联。
//
// 页面按时间倒序翻,模型用 recall_memory 按关键词找。检索是 search_text LIKE:
// 单台设备的档案是「每天几段 × 几年」= 几千行,全扫在 SQLite 里是毫秒级。
// 涨到十万行再考虑 FTS5(node 自带的 SQLite 有 fts5 与 trigram)。

import type { Db } from '../../db.ts';
import { all, one, run } from '../../db.ts';

export type ArcStatus = 'pending' | 'ready' | 'failed' | 'skipped' | 'raw_gone';

export interface ArcRow {
  id: number;
  mac: string;
  agent_id: string | null;
  title: string;
  summary: string;
  bullets_json: string;
  topics_json: string;
  search_text: string;
  started_at: string;
  ended_at: string;
  duration_s: number;
  turns: number;
  messages: number;
  sessions: number;
  status: ArcStatus;
  error: string;
  attempts: number;
  model_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArcView {
  id: number;
  mac: string;
  agent_id: string | null;
  agent_name?: string | null;
  title: string;
  summary: string;
  bullets: string[];
  topics: string[];
  started_at: string;
  ended_at: string;
  duration_s: number;
  turns: number;
  messages: number;
  sessions: number;
  status: ArcStatus;
  error: string;
  /** 原文还在不在(按保留策略清过的档案只剩摘要) */
  has_raw: boolean;
}

function parseList(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function toView(row: ArcRow): ArcView {
  return {
    id: row.id,
    mac: row.mac,
    agent_id: row.agent_id,
    title: row.title,
    summary: row.summary,
    bullets: parseList(row.bullets_json),
    topics: parseList(row.topics_json),
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_s: row.duration_s,
    turns: row.turns,
    messages: row.messages,
    sessions: row.sessions,
    status: row.status,
    error: row.error,
    has_raw: row.status !== 'raw_gone',
  };
}

export function arcById(conn: Db, id: number): ArcRow | undefined {
  return one<ArcRow>(conn, 'SELECT * FROM memory_arcs WHERE id = ?', id);
}

export interface ArcMessage {
  id: number;
  chat_type: number;
  content: string;
  created_at: string;
}

export function arcMessages(conn: Db, arcId: number, withTools = true): ArcMessage[] {
  return all<ArcMessage>(
    conn,
    `SELECT id, chat_type, content, created_at FROM chat_messages
     WHERE arc_id = ?${withTools ? '' : ' AND chat_type IN (1, 2)'} ORDER BY id`,
    arcId,
  );
}

export interface ArcQuery {
  mac: string;
  /** 关键词:在标题、摘要、要点、关键词里找 */
  q?: string;
  /** 游标:只要这个时间之前结束的(配合 limit 做「加载更多」) */
  before?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/** 按结束时间倒序翻页。next 是下一页的 before;没有下一页时是 null。 */
export function listArcs(conn: Db, query: ArcQuery): { items: ArcRow[]; next: string | null } {
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
  const where = ['mac = ?'];
  const params: unknown[] = [query.mac];
  if (query.q?.trim()) {
    where.push('search_text LIKE ?');
    params.push(`%${query.q.trim().toLowerCase()}%`);
  }
  if (query.before) {
    where.push('ended_at < ?');
    params.push(query.before);
  }
  if (query.since) {
    where.push('ended_at >= ?');
    params.push(query.since);
  }
  if (query.until) {
    where.push('ended_at <= ?');
    params.push(query.until);
  }
  const rows = all<ArcRow>(
    conn,
    `SELECT * FROM memory_arcs WHERE ${where.join(' AND ')} ORDER BY ended_at DESC, id DESC LIMIT ?`,
    ...params, limit + 1,
  );
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? (items.at(-1)?.ended_at ?? null) : null };
}

export function arcStats(conn: Db, mac: string): { count: number; from: string | null; to: string | null; thisMonth: number } {
  const row = one<{ n: number; from: string | null; to: string | null }>(
    conn, 'SELECT COUNT(*) AS n, MIN(started_at) AS "from", MAX(ended_at) AS "to" FROM memory_arcs WHERE mac = ?', mac,
  );
  const month = one<{ n: number }>(
    conn, "SELECT COUNT(*) AS n FROM memory_arcs WHERE mac = ? AND created_at >= datetime('now', 'start of month')", mac,
  );
  return { count: row?.n ?? 0, from: row?.from ?? null, to: row?.to ?? null, thisMonth: month?.n ?? 0 };
}

/** 删档案。keepRaw 为 true 时只删档案,原文留着(会被重新归档) */
export function deleteArc(conn: Db, arc: ArcRow, keepRaw: boolean): void {
  if (keepRaw) run(conn, 'UPDATE chat_messages SET arc_id = NULL WHERE arc_id = ?', arc.id);
  else run(conn, 'DELETE FROM chat_messages WHERE arc_id = ?', arc.id);
  run(conn, 'DELETE FROM memory_arcs WHERE id = ?', arc.id);
}

const DATE = (value: string) => value.slice(5, 10).replace('-', '月') + '日';

/**
 * 提示词里的「以前聊过什么」:只列最近几段的日期与标题。
 * 模型得先知道有东西可查,才会去调 recall_memory —— 这一段就是为此而存在的。
 */
export function arcsNote(conn: Db, mac: string, recent = 5): string {
  const stats = arcStats(conn, mac);
  if (!stats.count || !stats.from) return '';
  const rows = all<{ title: string; ended_at: string }>(
    conn,
    "SELECT title, ended_at FROM memory_arcs WHERE mac = ? AND status = 'ready' AND title != '' ORDER BY ended_at DESC LIMIT ?",
    mac, recent,
  );
  if (!rows.length) return '';
  const lines = rows.map((row) => `- ${DATE(row.ended_at)} ${row.title}`);
  return [
    `你和他一共聊过 ${stats.count} 段,最早是 ${DATE(stats.from)}。最近几段:`,
    ...lines,
    '想不起细节时调用 recall_memory,按关键词或日期把以前聊过的找回来;不要凭空编造以前的事。',
  ].join('\n');
}
