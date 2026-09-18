// 长期记忆:按设备记关于用户的事实。记的是「用户」,所以换了角色也共用。
//
// 分两层:这里是热记忆(每次对话都带给模型的事实),对话档案(冷记忆)在 arcs.ts。
// 一条一句话,由模型在聊到时调用 remember 写入、归档时统一更正与补录,也可以在记忆页手动增删改。
// 刻意不做静默的自动摘要:每次变更都往 memory_changes 留一条痕,记忆页上看得见、撤得掉。
//
// 住址、联系方式这类记得下但标成敏感:页面上默认打码,提示词里不带原文,模型要用时调回忆函数取。
// 真正一条都不记的只有密码、支付信息与证件号 —— 它们对一个陪伴玩具没有任何用途,只有风险。

import type { Db } from '../../db.ts';
import { all, one, run } from '../../db.ts';

export const MAX_FACTS_PER_DEVICE = 60;
export const MAX_FACT_CHARS = 90;
/** 注入提示词的上限:条数与字数,超了按最近更新排先后 */
export const PROMPT_MAX_FACTS = 40;
export const PROMPT_MAX_CHARS = 1200;

export type MemoryKind =
  | 'profile' | 'relation' | 'contact' | 'place' | 'preference' | 'learning' | 'health' | 'routine' | 'other';

/** 记录范围:模型只在这些类里记。sensitive 的两类不进常驻提示词。 */
export const MEMORY_KINDS: readonly { kind: MemoryKind; label: string; sensitive: boolean }[] = [
  { kind: 'profile', label: '称呼与身份', sensitive: false },
  { kind: 'relation', label: '家人、宠物与老师同学', sensitive: false },
  { kind: 'contact', label: '联系方式', sensitive: true },
  { kind: 'place', label: '住址与常去的地方', sensitive: true },
  { kind: 'preference', label: '喜好与讨厌', sensitive: false },
  { kind: 'learning', label: '正在学的东西', sensitive: false },
  { kind: 'health', label: '健康与忌口', sensitive: false },
  { kind: 'routine', label: '作息与日程', sensitive: false },
  { kind: 'other', label: '其他', sensitive: false },
];

export function kindLabel(kind: string): string {
  return MEMORY_KINDS.find((item) => item.kind === kind)?.label ?? '其他';
}

export function isSensitiveKind(kind: string): boolean {
  return MEMORY_KINDS.find((item) => item.kind === kind)?.sensitive ?? false;
}

export interface MemoryRow {
  id: number;
  mac: string;
  text: string;
  kind: MemoryKind;
  sensitive: number;
  source: 'agent' | 'admin' | 'archive';
  agent_id: string | null;
  arc_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChangeRow {
  id: number;
  mac: string;
  op: 'add' | 'update' | 'delete';
  fact_id: number | null;
  before_text: string;
  after_text: string;
  kind: string;
  sensitive: number;
  reason: string;
  source: 'agent' | 'admin' | 'archive';
  arc_id: number | null;
  agent_id: string | null;
  undone: number;
  created_at: string;
}

/**
 * 一条都不记的:密码、支付信息、证件号。命中返回原因,放行返回 null。
 * 与 classify 分开:那里判的是「敏感但有用」,这里判的是「没有任何用途,只有风险」。
 */
export function hardBlock(text: string): string | null {
  if (/(密码|口令|验证码|支付宝|微信支付|银行卡|信用卡|卡号|CVV|身份证号|护照号|社保卡)/u.test(text)) {
    return '密码、支付信息、证件号这类不记';
  }
  // 15 位以上的连续数字:银行卡与证件号的长度。手机号(11 位)不会命中
  if (/\d[\d\s-]{13,}\d/u.test(text)) return '像是银行卡或证件号码';
  return null;
}

const PATTERNS: readonly { kind: MemoryKind; re: RegExp }[] = [
  { kind: 'contact', re: /(电话|手机号|微信号|QQ号|联系方式|打给|号码是)/u },
  { kind: 'contact', re: /\d[\d\s-]{6,}\d/u },
  { kind: 'place', re: /(住址|地址|住在|门牌|家在|小区|几栋|单元|号楼|学校(在|叫|是)|幼儿园(在|叫|是))/u },
  { kind: 'place', re: /(?<=[^\s上读念在是去])(小学|中学|初中|高中|幼儿园)/u },
  { kind: 'health', re: /(过敏|忌口|不能吃|哮喘|近视|吃药|生病|病史|体质)/u },
  { kind: 'relation', re: /(妈妈|爸爸|爷爷|奶奶|外公|外婆|姥姥|姥爷|哥哥|姐姐|弟弟|妹妹|叔叔|阿姨|老师|同学|养的|宠物)/u },
  { kind: 'learning', re: /(在学|正在学|学习|练(琴|字|球)|单词|英语|钢琴|舞蹈|围棋|画画课|兴趣班)/u },
  { kind: 'routine', re: /(每天|每周|周末|几点|睡觉|起床|午睡|放学|上学时间|作息)/u },
  { kind: 'preference', re: /(喜欢|最爱|讨厌|不爱|害怕|最想|爱吃)/u },
  { kind: 'profile', re: /(名字叫|小名|昵称|今年.{0,4}岁|生日|属(鼠|牛|虎|兔|龙|蛇|马|羊|猴|鸡|狗|猪)|男孩|女孩)/u },
];

/**
 * 判这条记忆属于哪一类、算不算敏感。分类以这里为准,模型给的只作参考。
 * 「在上幼儿园大班」这种年龄段说法要放行(不是学校名字),所以 place 的第二条用了后行断言。
 */
export function classify(text: string): { sensitive: boolean; kind: MemoryKind } {
  for (const { kind, re } of PATTERNS) {
    if (re.test(text)) return { kind, sensitive: isSensitiveKind(kind) };
  }
  return { kind: 'other', sensitive: false };
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().replace(/[。!！]+$/u, '');
}

export function listMemory(conn: Db, mac: string): MemoryRow[] {
  return all<MemoryRow>(conn, 'SELECT * FROM device_memory WHERE mac = ? ORDER BY created_at, id', mac);
}

export function factById(conn: Db, id: number): MemoryRow | undefined {
  return one<MemoryRow>(conn, 'SELECT * FROM device_memory WHERE id = ?', id);
}

export interface ChangeInput {
  mac: string;
  op: 'add' | 'update' | 'delete';
  factId?: number | null;
  before?: string;
  after?: string;
  kind?: string;
  sensitive?: boolean;
  reason?: string;
  source: 'agent' | 'admin' | 'archive';
  arcId?: number | null;
  agentId?: string | null;
}

/** 每次变更留一条痕,记忆页据此回溯与撤销 */
export function recordChange(conn: Db, input: ChangeInput): void {
  run(
    conn,
    `INSERT INTO memory_changes (mac, op, fact_id, before_text, after_text, kind, sensitive, reason, source, arc_id, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.mac, input.op, input.factId ?? null, input.before ?? '', input.after ?? '',
    input.kind ?? 'other', input.sensitive ? 1 : 0, input.reason ?? '', input.source,
    input.arcId ?? null, input.agentId ?? null,
  );
}

export function listChanges(conn: Db, mac: string, limit = 20): ChangeRow[] {
  return all<ChangeRow>(conn, 'SELECT * FROM memory_changes WHERE mac = ? ORDER BY id DESC LIMIT ?', mac, limit);
}

export type RememberOutcome =
  | { status: 'added' | 'updated' | 'unchanged'; row: MemoryRow }
  | { status: 'rejected'; reason: string };

export interface RememberInput {
  mac: string;
  text: string;
  source: 'agent' | 'admin' | 'archive';
  agentId?: string | null;
  arcId?: number | null;
  replaces?: string;
  reason?: string;
}

/**
 * 写入一条。与已有某条互相包含(比如「喜欢恐龙」与「最喜欢霸王龙恐龙」)时更新那条,不重复堆积。
 * 满了就挤掉最早的一条模型写入的记忆;手动添加的不会被挤掉。
 */
export function remember(conn: Db, input: RememberInput): RememberOutcome {
  const text = normalize(input.text);
  if (!text) return { status: 'rejected', reason: '内容是空的' };
  if ([...text].length > MAX_FACT_CHARS) return { status: 'rejected', reason: `超过 ${MAX_FACT_CHARS} 个字,拆短一点` };
  const blocked = hardBlock(text);
  if (blocked) return { status: 'rejected', reason: blocked };

  const { kind, sensitive } = classify(text);
  const rows = listMemory(conn, input.mac);
  const target = input.replaces ? normalize(input.replaces) : '';
  const similar = rows.find((row) => row.text === text)
    ?? (target ? rows.find((row) => row.text.includes(target) || target.includes(row.text)) : undefined)
    ?? rows.find((row) => row.text.includes(text) || text.includes(row.text));
  if (similar) {
    if (similar.text === text) return { status: 'unchanged', row: similar };
    run(
      conn,
      "UPDATE device_memory SET text = ?, kind = ?, sensitive = ?, agent_id = ?, arc_id = ?, updated_at = datetime('now') WHERE id = ?",
      text, kind, sensitive ? 1 : 0, input.agentId ?? null, input.arcId ?? null, similar.id,
    );
    recordChange(conn, {
      mac: input.mac, op: 'update', factId: similar.id, before: similar.text, after: text,
      kind, sensitive, reason: input.reason ?? '', source: input.source, arcId: input.arcId, agentId: input.agentId,
    });
    return { status: 'updated', row: factById(conn, similar.id)! };
  }

  if (rows.length >= MAX_FACTS_PER_DEVICE) {
    const oldest = rows.find((row) => row.source !== 'admin');
    if (!oldest) return { status: 'rejected', reason: `这台设备的记忆已经有 ${MAX_FACTS_PER_DEVICE} 条了` };
    deleteFact(conn, oldest, input.source, '记忆满了,挤掉最早的一条');
  }
  run(
    conn,
    'INSERT INTO device_memory (mac, text, kind, sensitive, source, agent_id, arc_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    input.mac, text, kind, sensitive ? 1 : 0, input.source, input.agentId ?? null, input.arcId ?? null,
  );
  const row = one<MemoryRow>(conn, 'SELECT * FROM device_memory WHERE mac = ? ORDER BY id DESC LIMIT 1', input.mac)!;
  recordChange(conn, {
    mac: input.mac, op: 'add', factId: row.id, after: text, kind, sensitive,
    reason: input.reason ?? '', source: input.source, arcId: input.arcId, agentId: input.agentId,
  });
  return { status: 'added', row };
}

/** 改写一条(记忆页手动编辑) */
export function editFact(conn: Db, row: MemoryRow, text: string): { ok: true; row: MemoryRow } | { ok: false; reason: string } {
  const next = normalize(text);
  if (!next) return { ok: false, reason: '内容是空的' };
  if ([...next].length > MAX_FACT_CHARS) return { ok: false, reason: `超过 ${MAX_FACT_CHARS} 个字` };
  const blocked = hardBlock(next);
  if (blocked) return { ok: false, reason: blocked };
  const { kind, sensitive } = classify(next);
  run(
    conn,
    "UPDATE device_memory SET text = ?, kind = ?, sensitive = ?, source = 'admin', updated_at = datetime('now') WHERE id = ?",
    next, kind, sensitive ? 1 : 0, row.id,
  );
  recordChange(conn, {
    mac: row.mac, op: 'update', factId: row.id, before: row.text, after: next, kind, sensitive, source: 'admin',
  });
  return { ok: true, row: factById(conn, row.id)! };
}

/** 按 id 删掉一条,留痕 */
export function deleteFact(
  conn: Db, row: MemoryRow, source: 'agent' | 'admin' | 'archive', reason = '', arcId?: number | null,
): void {
  run(conn, 'DELETE FROM device_memory WHERE id = ?', row.id);
  recordChange(conn, {
    mac: row.mac, op: 'delete', factId: row.id, before: row.text, kind: row.kind,
    sensitive: !!row.sensitive, reason, source, arcId,
  });
}

/** 按内容删除:删掉包含这段话的记忆(或被这段话包含的),返回删掉的条目。 */
export function forget(
  conn: Db, mac: string, text: string, source: 'agent' | 'admin' | 'archive' = 'agent', reason = '',
): MemoryRow[] {
  const needle = normalize(text);
  if (!needle) return [];
  const matched = listMemory(conn, mac).filter((row) => row.text.includes(needle) || needle.includes(row.text));
  for (const row of matched) deleteFact(conn, row, source, reason);
  return matched;
}

/**
 * 撤销一次变更:加的删掉、改的还原、删的补回来。已撤销过或对不上目标时返回 false。
 * 是否已撤销以库里为准,不信调用方手上那份(可能是撤销前读的)。
 */
export function undoChange(conn: Db, change: ChangeRow): boolean {
  const current = one<{ undone: number }>(conn, 'SELECT undone FROM memory_changes WHERE id = ?', change.id);
  if (!current || current.undone) return false;
  if (change.op === 'add') {
    if (!change.fact_id) return false;
    const row = factById(conn, change.fact_id);
    if (row) run(conn, 'DELETE FROM device_memory WHERE id = ?', row.id);
  } else if (change.op === 'update') {
    if (!change.fact_id || !factById(conn, change.fact_id)) return false;
    const { kind, sensitive } = classify(change.before_text);
    run(
      conn,
      "UPDATE device_memory SET text = ?, kind = ?, sensitive = ?, updated_at = datetime('now') WHERE id = ?",
      change.before_text, kind, sensitive ? 1 : 0, change.fact_id,
    );
  } else {
    if (!change.before_text) return false;
    const { kind, sensitive } = classify(change.before_text);
    run(
      conn,
      "INSERT INTO device_memory (mac, text, kind, sensitive, source, agent_id) VALUES (?, ?, ?, ?, 'admin', ?)",
      change.mac, change.before_text, kind, sensitive ? 1 : 0, change.agent_id,
    );
  }
  run(conn, 'UPDATE memory_changes SET undone = 1 WHERE id = ?', change.id);
  return true;
}

export interface MemoryPrompt {
  /** 按分类分组的非敏感记忆 */
  facts: string;
  /** 敏感条目的提示:只说有什么,不说内容 */
  sensitiveNote: string;
}

/** 注入提示词的内容;没有记忆时返回 undefined。 */
export function memoryPrompt(conn: Db, mac: string): MemoryPrompt | undefined {
  const rows = listMemory(conn, mac);
  if (rows.length === 0) return undefined;

  const plain = rows.filter((row) => !row.sensitive)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, PROMPT_MAX_FACTS);
  const groups = new Map<string, string[]>();
  let chars = 0;
  for (const row of plain) {
    chars += row.text.length;
    if (chars > PROMPT_MAX_CHARS) break;
    const label = kindLabel(row.kind);
    groups.set(label, [...(groups.get(label) ?? []), row.text]);
  }
  const facts = [...groups.entries()].map(([label, items]) => `${label}:${items.join(';')}`).join('\n');

  const sensitive = rows.filter((row) => row.sensitive);
  const kinds = [...new Set(sensitive.map((row) => kindLabel(row.kind)))];
  const sensitiveNote = sensitive.length
    ? `你还知道他的${kinds.join('与')}(共 ${sensitive.length} 条),内容没有写在这里。真的需要用到时调用 recall_memory 取,平时不要提起。`
    : '';
  if (!facts && !sensitiveNote) return undefined;
  return { facts, sensitiveNote };
}
