// 把聊过的内容整理成档案(冷记忆),顺带更正与补录热记忆。
//
// 怎么切段:同一台设备的消息按时间排,相邻两条间隔超过 IDLE_MS(30 分钟)就切一刀 ——
// 与模型当时的工作记忆边界严格重合。**不按 session_id**:设备空闲 150 秒就重连一次,
// 一次晚饭时间的陪聊会被切成十几个 session,按 session 归档全是碎片,还要为每片调一次模型。
//
// 什么时候整理:引擎每次连接结束会调 chat-summary/save,那里只往内存里记一个 nudge;
// 真正的活由后台定时器做,并且每 5 分钟做一次全表兜底扫描(引擎崩了、nudge 丢了也不会漏)。
// 只整理「最后一条消息距今超过 SETTLE_MS」的段,还在聊的留到下次。
//
// 防重复:认领与产出分两段事务。认领时先插一条 pending 档案,再把这批消息的 arc_id 指过去;
// 提交后这批消息不会被第二次认领。产出失败也**不把 arc_id 还原成 NULL** ——
// 否则扫描器会无限重试同一段,把 token 烧光;原文仍在、页面仍能逐轮看,只是没有摘要。

import { all, one, run, tx, type Db } from '../../db.ts';
import { IDLE_MS } from '../context.ts';
import { completeChat, type ChatMessage, type LlmConfig } from '../llm.ts';
import type { AgentDeps } from '../types.ts';
import { arcById, type ArcRow } from './arcs.ts';
import { memorySettings } from './settings.ts';
import { deleteFact, factById, kindLabel, listMemory, remember } from './store.ts';

/** 一段对话结束多久之后才整理 */
export const SETTLE_MS = 10 * 60_000;
/** 一轮最多整理几段:一次唤醒不该打十几个模型请求 */
export const MAX_PER_TICK = 3;
const SCAN_MS = 60_000;
const FULL_SCAN_MS = 5 * 60_000;
/** 认领后多久没产出就当作进程中途挂了,重新入队 */
const ZOMBIE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_OPS = 3;
const MAX_MESSAGES = 80;
const HEAD_MESSAGES = 20;
const MAX_LINE_CHARS = 400;
const MAX_INPUT_CHARS = 12_000;

export interface RawRow {
  id: number;
  session_id: string;
  chat_type: number;
  content: string;
  created_at: string;
  agent_id: string | null;
}

const ms = (value: string) => new Date(`${value.replace(' ', 'T')}Z`).getTime();

/** 按时间缺口切段。rows 要按时间升序。 */
export function splitSegments(rows: readonly RawRow[], gapMs = IDLE_MS): RawRow[][] {
  const out: RawRow[][] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (!last || ms(row.created_at) - ms(last.at(-1)!.created_at) > gapMs) out.push([row]);
    else last.push(row);
  }
  return out;
}

/** 这一段里出现最多的角色 */
function mainAgent(segment: readonly RawRow[]): string | null {
  const count = new Map<string, number>();
  for (const row of segment) {
    if (row.agent_id) count.set(row.agent_id, (count.get(row.agent_id) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** 兜底标题:第一句用户说的话 */
function fallbackTitle(segment: readonly { chat_type: number; content: string }[]): string {
  const first = segment.find((row) => row.chat_type === 1)?.content ?? '';
  return [...first.trim()].slice(0, 12).join('');
}

// ---------------------------------------------------------------- 待办

/** 引擎报来「这次连接结束了」:只记一下,真正的活交给定时器 */
const nudged = new Set<string>();

export function nudgeArchive(sessionId: string): void {
  if (sessionId) nudged.add(sessionId);
  // 兜底扫描会处理所有设备,这里不让集合无限涨
  if (nudged.size > 500) nudged.clear();
}

export function takeNudged(): string[] {
  const out = [...nudged];
  nudged.clear();
  return out;
}

// ---------------------------------------------------------------- 认领

function archiveFrom(conn: Db): string {
  return one<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'memory.archive_from'")?.value ?? '1970-01-01 00:00:00';
}

/** 这台设备有哪些还没归档、且已经过了静置期的段;一次最多认领 limit 段 */
export function claimSegments(conn: Db, mac: string, now: number, limit: number): ArcRow[] {
  const rows = all<RawRow>(
    conn,
    `SELECT id, session_id, chat_type, content, created_at, agent_id FROM chat_messages
     WHERE mac = ? AND arc_id IS NULL AND created_at >= ? ORDER BY created_at, id LIMIT 800`,
    mac, archiveFrom(conn),
  );
  const claimed: ArcRow[] = [];
  for (const segment of splitSegments(rows)) {
    if (claimed.length >= limit) break;
    const started = segment[0]!.created_at;
    const ended = segment.at(-1)!.created_at;
    if (now - ms(ended) < SETTLE_MS) continue;   // 还在聊,留到下次
    const id = tx(conn, () => {
      run(
        conn,
        `INSERT INTO memory_arcs (mac, agent_id, started_at, ended_at, duration_s, turns, messages, sessions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        mac, mainAgent(segment), started, ended,
        Math.max(0, Math.round((ms(ended) - ms(started)) / 1000)),
        segment.filter((row) => row.chat_type === 1).length,
        segment.length,
        new Set(segment.map((row) => row.session_id)).size,
      );
      const arcId = one<{ id: number }>(conn, 'SELECT last_insert_rowid() AS id')!.id;
      const holes = segment.map(() => '?').join(', ');
      run(conn, `UPDATE chat_messages SET arc_id = ? WHERE arc_id IS NULL AND id IN (${holes})`, arcId, ...segment.map((row) => row.id));
      return arcId;
    });
    const arc = arcById(conn, id);
    if (arc) claimed.push(arc);
  }
  return claimed;
}

/** 认领过但没产出的:进程中途挂了,或上次失败等到了重试时间 */
export function dueArcs(conn: Db, limit: number): ArcRow[] {
  return all<ArcRow>(
    conn,
    `SELECT * FROM memory_arcs WHERE
       (status = 'pending' AND updated_at <= datetime('now', ?))
       OR (status = 'failed' AND attempts < ? AND updated_at <= datetime('now',
             CASE attempts WHEN 1 THEN '-5 minutes' WHEN 2 THEN '-20 minutes' ELSE '-60 minutes' END))
     ORDER BY updated_at LIMIT ?`,
    `-${Math.round(ZOMBIE_MS / 60_000)} minutes`, MAX_ATTEMPTS, limit,
  );
}

// ---------------------------------------------------------------- 整理

export interface ArchiveOutput {
  title: string;
  summary: string;
  bullets: string[];
  topics: string[];
  memory_ops: { op: 'add' | 'update' | 'delete'; id?: number; text?: string; kind?: string; reason?: string }[];
}

const clip = (value: unknown, max: number) => [...String(value ?? '').replace(/\s+/gu, ' ').trim()].slice(0, max).join('');

/** 模型回的 JSON:允许带 ```json 围栏,字段缺了就当空,超长就截断,不整体拒绝 */
export function parseOutput(text: string): ArchiveOutput | null {
  const body = text.replace(/^\s*```(?:json)?/u, '').replace(/```\s*$/u, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const list = (value: unknown, max: number, chars: number) =>
    (Array.isArray(value) ? value : []).map((item) => clip(item, chars)).filter(Boolean).slice(0, max);
  const ops = (Array.isArray(parsed['memory_ops']) ? parsed['memory_ops'] : [])
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item && (item['op'] === 'add' || item['op'] === 'update' || item['op'] === 'delete'))
    .slice(0, MAX_OPS)
    .map((item) => ({
      op: item['op'] as 'add' | 'update' | 'delete',
      ...(Number.isFinite(Number(item['id'])) ? { id: Number(item['id']) } : {}),
      ...(item['text'] ? { text: clip(item['text'], 90) } : {}),
      ...(item['kind'] ? { kind: String(item['kind']) } : {}),
      ...(item['reason'] ? { reason: clip(item['reason'], 40) } : {}),
    }));
  return {
    title: clip(parsed['title'], 24),
    summary: clip(parsed['summary'], 60),
    bullets: list(parsed['bullets'], 5, 40),
    topics: list(parsed['topics'], 6, 12),
    memory_ops: ops,
  };
}

/** 交给模型看的对话:丢掉工具记录,太长时留头留尾 */
export function transcript(rows: readonly { chat_type: number; content: string }[], speaker: string): string {
  const talk = rows.filter((row) => row.chat_type === 1 || row.chat_type === 2);
  const shown = talk.length > MAX_MESSAGES
    ? [...talk.slice(0, HEAD_MESSAGES), { chat_type: 0, content: `…(省略 ${talk.length - MAX_MESSAGES} 条)…` }, ...talk.slice(-(MAX_MESSAGES - HEAD_MESSAGES))]
    : talk;
  let out = '';
  for (const row of shown) {
    const who = row.chat_type === 1 ? '用户' : row.chat_type === 2 ? speaker : '';
    const line = `${who ? `${who}:` : ''}${clip(row.content, MAX_LINE_CHARS)}\n`;
    if (out.length + line.length > MAX_INPUT_CHARS) break;
    out += line;
  }
  return out.trimEnd();
}

const SYSTEM = [
  '你在帮一台儿童陪伴设备整理聊天记录。读完这段对话,给出标题、一句话摘要、几条要点,',
  '并判断有没有关于用户的信息需要记住、更正或忘掉。',
  '只输出一个 JSON 对象,不要 Markdown 围栏,不要任何解释。字段:',
  '{"title":"不超过 24 字","summary":"一句话,不超过 60 字","bullets":["要点,最多 5 条"],',
  '"topics":["关键词,最多 6 个"],"memory_ops":[{"op":"add|update|delete","id":要改或要删的记忆编号,"text":"新的内容","reason":"为什么"}]}',
  'memory_ops 最多 3 条,没有就给空数组。add 不用填 id;update 与 delete 必须填已有记忆的编号。',
].join('\n');

function userPrompt(conn: Db, arc: ArcRow, rows: readonly { chat_type: number; content: string }[], speaker: string): string {
  const facts = listMemory(conn, arc.mac).map((row) => `[${row.id}] (${kindLabel(row.kind)})${row.text}`);
  return [
    `<已有记忆>\n${facts.join('\n') || '(还没有)'}\n</已有记忆>`,
    `<记录范围>\n${memorySettings(conn).scope}\n</记录范围>`,
    `<对话 开始="${arc.started_at}" 时长="${Math.round(arc.duration_s / 60)} 分钟" 角色="${speaker}">\n${transcript(rows, speaker)}\n</对话>`,
  ].join('\n\n');
}

/** 摘要用哪个模型:记忆页指定的 → 这段对话的角色的 → 默认那个 */
function summaryModel(conn: Db, arc: ArcRow): { id: string; config: LlmConfig } | undefined {
  const pick = (id: string | null | undefined) => (id
    ? one<{ id: string; config_json: string }>(conn, "SELECT id, config_json FROM models WHERE id = ? AND model_type = 'LLM' AND enabled = 1", id)
    : undefined);
  const agentModel = arc.agent_id
    ? one<{ llm_model_id: string | null }>(conn, 'SELECT llm_model_id FROM agents WHERE id = ?', arc.agent_id)?.llm_model_id
    : null;
  const row = pick(memorySettings(conn).summaryModelId) ?? pick(agentModel)
    ?? one<{ id: string; config_json: string }>(conn, "SELECT id, config_json FROM models WHERE model_type = 'LLM' AND enabled = 1 ORDER BY is_default DESC, id LIMIT 1");
  if (!row) return undefined;
  try {
    return { id: row.id, config: JSON.parse(row.config_json) as LlmConfig };
  } catch {
    return undefined;
  }
}

/** 更正与补录:分类以服务端为准,全部直接生效并留痕(记忆页可撤销) */
export function applyOps(conn: Db, arc: ArcRow, ops: ArchiveOutput['memory_ops']): number {
  let applied = 0;
  for (const op of ops.slice(0, MAX_OPS)) {
    const existing = op.id ? factById(conn, op.id) : undefined;
    if (op.op === 'delete') {
      if (existing && existing.mac === arc.mac) {
        deleteFact(conn, existing, 'archive', op.reason ?? '整理对话时判断这条不对了', arc.id);
        applied += 1;
      }
      continue;
    }
    if (!op.text) continue;
    const outcome = remember(conn, {
      mac: arc.mac,
      text: op.text,
      source: 'archive',
      agentId: arc.agent_id,
      arcId: arc.id,
      ...(existing && existing.mac === arc.mac ? { replaces: existing.text } : {}),
      ...(op.reason ? { reason: op.reason } : {}),
    });
    if (outcome.status === 'added' || outcome.status === 'updated') applied += 1;
  }
  return applied;
}

function finish(conn: Db, arc: ArcRow, output: ArchiveOutput, modelId: string): void {
  const searchText = [output.title, output.summary, ...output.bullets, ...output.topics].join(' ').toLowerCase();
  run(
    conn,
    `UPDATE memory_arcs SET title = ?, summary = ?, bullets_json = ?, topics_json = ?, search_text = ?,
       status = 'ready', error = '', model_id = ?, updated_at = datetime('now') WHERE id = ?`,
    output.title, output.summary, JSON.stringify(output.bullets), JSON.stringify(output.topics),
    searchText, modelId, arc.id,
  );
}

function giveUp(conn: Db, arc: ArcRow, rows: readonly { chat_type: number; content: string }[], error: string): void {
  const attempts = arc.attempts + 1;
  const done = attempts >= MAX_ATTEMPTS;
  run(
    conn,
    `UPDATE memory_arcs SET status = ?, error = ?, attempts = ?, title = CASE WHEN title = '' THEN ? ELSE title END,
       updated_at = datetime('now') WHERE id = ?`,
    done ? 'skipped' : 'failed', error.slice(0, 200), attempts, fallbackTitle(rows), arc.id,
  );
}

/**
 * 整理一段:调一次模型,同时拿到档案与记忆的增改删。
 * force 是页面上点「重新整理」:太短的段平时不值得调模型,人点了就照办。
 */
export async function summarizeArc(deps: AgentDeps, arc: ArcRow, force = false): Promise<'ready' | 'skipped' | 'failed'> {
  const { conn } = deps;
  const rows = all<{ chat_type: number; content: string }>(
    conn, 'SELECT chat_type, content FROM chat_messages WHERE arc_id = ? ORDER BY id', arc.id,
  );
  const { minTurns } = memorySettings(conn);
  if ((!force && arc.turns < minTurns) || rows.length === 0) {
    run(
      conn,
      "UPDATE memory_arcs SET status = 'skipped', title = ?, updated_at = datetime('now') WHERE id = ?",
      fallbackTitle(rows), arc.id,
    );
    return 'skipped';
  }
  const model = summaryModel(conn, arc);
  if (!model) {
    run(
      conn,
      "UPDATE memory_arcs SET status = 'skipped', error = '还没有可用的对话模型', title = ?, updated_at = datetime('now') WHERE id = ?",
      fallbackTitle(rows), arc.id,
    );
    return 'skipped';
  }
  const speaker = (arc.agent_id ? one<{ name: string }>(conn, 'SELECT name FROM agents WHERE id = ?', arc.agent_id)?.name : '') || '小单';
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(conn, arc, rows, speaker) },
  ];
  try {
    const text = await completeChat(deps.fetch, model.config, { messages, thinking: false, temperature: 0.2, maxTokens: 700, timeoutMs: 60_000 });
    const output = parseOutput(text);
    if (!output || !output.title) {
      giveUp(conn, arc, rows, '模型没有返回可用的 JSON');
      return 'failed';
    }
    finish(conn, arc, output, model.id);
    const applied = applyOps(conn, arc, output.memory_ops);
    deps.log?.(`[记忆] 整理好一段对话「${output.title}」(${arc.mac}),记忆改动 ${applied} 条`);
    return 'ready';
  } catch (error) {
    giveUp(conn, arc, rows, (error as Error).message);
    deps.log?.(`[记忆] 整理对话失败(${arc.mac}):${(error as Error).message}`);
    return 'failed';
  }
}

// ---------------------------------------------------------------- 清理

/** 按保留策略清掉已整理对话的原文;另外清掉早已解绑设备留下的孤儿消息 */
export function cleanup(conn: Db): { rawGone: number; orphans: number } {
  const { rawKeepDays } = memorySettings(conn);
  let rawGone = 0;
  if (rawKeepDays > 0) {
    const stale = all<{ id: number }>(
      conn,
      `SELECT id FROM memory_arcs WHERE status IN ('ready', 'skipped') AND ended_at < datetime('now', ?) LIMIT 50`,
      `-${rawKeepDays} days`,
    );
    for (const arc of stale) {
      run(conn, 'DELETE FROM chat_messages WHERE arc_id = ?', arc.id);
      run(conn, "UPDATE memory_arcs SET status = 'raw_gone', updated_at = datetime('now') WHERE id = ?", arc.id);
      rawGone += 1;
    }
  }
  const orphans = all<{ id: number }>(
    conn,
    `SELECT id FROM chat_messages WHERE created_at < datetime('now', '-90 days')
       AND mac NOT IN (SELECT mac FROM devices) LIMIT 500`,
  );
  for (const row of orphans) run(conn, 'DELETE FROM chat_messages WHERE id = ?', row.id);
  return { rawGone, orphans: orphans.length };
}

// ---------------------------------------------------------------- 定时器

let running = false;
let lastFullScan = 0;

/** 跑一轮:认领到期的段、整理它们、顺带做僵尸回收与清理。测试直接调它,不等定时器。 */
export async function archiveTick(deps: AgentDeps, now = Date.now()): Promise<number> {
  const { conn } = deps;
  const sessions = takeNudged();
  const macs = new Set<string>();
  for (const sessionId of sessions) {
    const row = one<{ mac: string }>(conn, 'SELECT mac FROM chat_messages WHERE session_id = ? LIMIT 1', sessionId);
    if (row) macs.add(row.mac);
  }
  if (now - lastFullScan >= FULL_SCAN_MS) {
    lastFullScan = now;
    for (const row of all<{ mac: string }>(conn, 'SELECT DISTINCT mac FROM chat_messages WHERE arc_id IS NULL')) macs.add(row.mac);
    cleanup(conn);
  }

  const todo: ArcRow[] = [...dueArcs(conn, MAX_PER_TICK)];
  for (const mac of macs) {
    if (todo.length >= MAX_PER_TICK) break;
    todo.push(...claimSegments(conn, mac, now, MAX_PER_TICK - todo.length));
  }
  for (const arc of todo) await summarizeArc(deps, arc);
  return todo.length;
}

/** 在 server.ts 的 onAgentDeps 里启动;测试环境不启动 */
export function startMemoryArchiver(deps: AgentDeps): () => void {
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    archiveTick(deps)
      .catch((error: unknown) => deps.log?.(`[记忆] 归档出错:${(error as Error).message}`))
      .finally(() => { running = false; });
  }, SCAN_MS);
  timer.unref();
  return () => clearInterval(timer);
}
