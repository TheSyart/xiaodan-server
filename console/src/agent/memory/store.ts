// 长期记忆:按设备记关于用户的事实。记的是「用户」,所以换了角色也共用。
//
// 一条一句话,由模型在用户主动说起时调用 remember 写入,也可以在设备页手动增删。
// 刻意不做自动摘要:摘要会把孩子随口一提的隐私也记下来,而且错了没人知道;逐条可见、可删更可控。

import type { Db } from '../../db.ts';
import { all, one, run } from '../../db.ts';

export const MAX_FACTS_PER_DEVICE = 40;
export const MAX_FACT_CHARS = 60;

export interface MemoryRow {
  id: number;
  mac: string;
  text: string;
  source: 'agent' | 'admin';
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 不记的隐私:住址、电话、证件、学校班级、密码。命中返回原因,放行返回 null。
 * 这是兜底:提示词与工具说明已经要求模型不记,这里防它没听话。
 */
export function privacyReason(text: string): string | null {
  if (/\d[\d\s-]{6,}\d/u.test(text)) return '像是电话、证件号之类的号码';
  if (/(住址|地址|住在.{0,12}(路|街|号|小区|栋|单元|室)|门牌|电话|手机号|身份证|密码|银行卡|班级|年级.{0,3}班)/u.test(text)) {
    return '住址、电话、学校这类隐私';
  }
  // 学校的名字才是隐私:「实验小学」「学校叫…」要拦,「在上小学」「上幼儿园大班」只是年龄段,放行
  if (/学校(在|叫|是)|(?<=[^\s上读念在是去])(小学|中学|初中|高中|幼儿园)/u.test(text)) return '住址、电话、学校这类隐私';
  return null;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().replace(/[。!！]+$/u, '');
}

export function listMemory(conn: Db, mac: string): MemoryRow[] {
  return all<MemoryRow>(conn, 'SELECT * FROM device_memory WHERE mac = ? ORDER BY created_at, id', mac);
}

export type RememberOutcome =
  | { status: 'added' | 'updated' | 'unchanged'; row: MemoryRow }
  | { status: 'rejected'; reason: string };

/**
 * 写入一条。与已有某条互相包含(比如「喜欢恐龙」与「最喜欢霸王龙恐龙」)时更新那条,不重复堆积。
 * 满了就挤掉最早的一条 agent 写入的记忆;手动添加的不会被挤掉。
 */
export function remember(conn: Db, input: { mac: string; text: string; source: 'agent' | 'admin'; agentId?: string | null; replaces?: string }): RememberOutcome {
  const text = normalize(input.text);
  if (!text) return { status: 'rejected', reason: '内容是空的' };
  if ([...text].length > MAX_FACT_CHARS) return { status: 'rejected', reason: `超过 ${MAX_FACT_CHARS} 个字,拆短一点` };
  const privacy = privacyReason(text);
  if (privacy) return { status: 'rejected', reason: privacy };

  const rows = listMemory(conn, input.mac);
  const target = input.replaces ? normalize(input.replaces) : '';
  const similar = rows.find((row) => row.text === text)
    ?? (target ? rows.find((row) => row.text.includes(target) || target.includes(row.text)) : undefined)
    ?? rows.find((row) => row.text.includes(text) || text.includes(row.text));
  if (similar) {
    if (similar.text === text) return { status: 'unchanged', row: similar };
    run(conn, "UPDATE device_memory SET text = ?, agent_id = ?, updated_at = datetime('now') WHERE id = ?", text, input.agentId ?? null, similar.id);
    return { status: 'updated', row: one<MemoryRow>(conn, 'SELECT * FROM device_memory WHERE id = ?', similar.id)! };
  }

  if (rows.length >= MAX_FACTS_PER_DEVICE) {
    const oldest = rows.find((row) => row.source === 'agent');
    if (!oldest) return { status: 'rejected', reason: `这台设备的记忆已经有 ${MAX_FACTS_PER_DEVICE} 条了` };
    run(conn, 'DELETE FROM device_memory WHERE id = ?', oldest.id);
  }
  run(conn, 'INSERT INTO device_memory (mac, text, source, agent_id) VALUES (?, ?, ?, ?)', input.mac, text, input.source, input.agentId ?? null);
  const row = one<MemoryRow>(conn, 'SELECT * FROM device_memory WHERE mac = ? ORDER BY id DESC LIMIT 1', input.mac)!;
  return { status: 'added', row };
}

/** 按内容删除:删掉包含这段话的记忆(或被这段话包含的),返回删掉的条目。 */
export function forget(conn: Db, mac: string, text: string): MemoryRow[] {
  const needle = normalize(text);
  if (!needle) return [];
  const matched = listMemory(conn, mac).filter((row) => row.text.includes(needle) || needle.includes(row.text));
  for (const row of matched) run(conn, 'DELETE FROM device_memory WHERE id = ?', row.id);
  return matched;
}

/** 注入提示词的文字;没有记忆时返回 undefined。 */
export function memoryPrompt(conn: Db, mac: string): string | undefined {
  const rows = listMemory(conn, mac);
  if (rows.length === 0) return undefined;
  return rows.map((row) => `- ${row.text}`).join('\n');
}
