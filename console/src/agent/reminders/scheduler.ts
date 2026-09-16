// 提醒的投递。
//
// 每 5 秒扫一遍到期的提醒,经设备桥让设备主动播报(提示音 + "提醒你:…" + 屏幕上的提醒卡片):
//   - 202 送达:不重复的记为 delivered;重复的滚到下一次;
//   - 409 设备正忙(正在说话、正在听):5 秒后再试;
//   - 404 或连不上:设备不在线,15 秒后再试(设备空闲 150 秒会重连一次,空档约 6 秒);3 分钟都没送达就记为 missed。
// 设备重新连上时(它会来 agent-models 取配置),把 12 小时内错过的提醒补报一次。

import type { AgentDeps } from '../types.ts';
import { DEVICE_ONLINE_HOOKS } from '../hooks.ts';
import { all, one, run } from '../../db.ts';
import type { ReminderRow } from './store.ts';
import { dueReminders } from './store.ts';
import { hhmm, nextOccurrence } from './time.ts';

const SCAN_MS = 5000;
const BUSY_RETRY_MS = 5000;
const OFFLINE_RETRY_MS = 15_000;
const MISSED_AFTER_MS = 3 * 60_000;
const CATCH_UP_WINDOW_MS = 12 * 3600_000;

const nextTry = new Map<number, number>();
let running = false;

function xiaodanVersion(features: Record<string, unknown> | undefined): number {
  const value = features?.['xiaodan'];
  return value === true ? 1 : typeof value === 'number' ? value : 0;
}

/** 屏幕上的提醒卡片,只发给认得它的固件(features.xiaodan ≥ 2) */
export function reminderCard(text: string, due: Date): Record<string, unknown> {
  let clipped = '';
  for (const ch of text) {
    if (Buffer.byteLength(clipped + ch) > 60) break;
    clipped += ch;
  }
  return { type: 'xiaodan', cmd: 'reminder', text: clipped, time: hhmm(due), hold_s: 60 };
}

export async function deliver(deps: AgentDeps, rows: ReminderRow[], mac: string, speech: string): Promise<'delivered' | 'busy' | 'offline'> {
  let features: Record<string, unknown> | undefined;
  try {
    const status = await deps.bridge.device(mac);
    if (!status.online) return 'offline';
    features = status.features;
  } catch {
    return 'offline';
  }
  const cards = xiaodanVersion(features) >= 2 ? rows.slice(0, 1).map((r) => reminderCard(r.text, new Date(r.due_at))) : [];
  let result: { status: number };
  try {
    result = await deps.bridge.announce(mac, { text: speech, chime: true, title: '提醒', device_msgs: cards });
  } catch {
    return 'offline';
  }
  if (result.status === 202) return 'delivered';
  if (result.status === 409) return 'busy';
  return 'offline';
}

function markDelivered(deps: AgentDeps, row: ReminderRow, now: Date): void {
  const next = nextOccurrence(new Date(row.due_at), row.repeat, now);
  if (next) {
    run(deps.conn, "UPDATE reminders SET due_at = ?, attempts = 0, first_attempt_at = NULL, last_attempt_at = NULL, delivered_at = ? WHERE id = ?",
      next.toISOString(), now.toISOString(), row.id);
  } else {
    run(deps.conn, "UPDATE reminders SET status = 'delivered', delivered_at = ? WHERE id = ?", now.toISOString(), row.id);
  }
}

export async function scanOnce(deps: AgentDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const due = dueReminders(deps.conn, now).filter((row) => (nextTry.get(row.id) ?? 0) <= now.getTime());
  // 同一台设备同一时刻到期的多个提醒合成一次播报
  const byMac = new Map<string, ReminderRow[]>();
  for (const row of due) byMac.set(row.mac, [...(byMac.get(row.mac) ?? []), row]);
  for (const [mac, rows] of byMac) {
    const speech = rows.length === 1 ? `提醒你:${rows[0]!.text}。` : `提醒你:${rows.map((r) => r.text).join(';')}。`;
    const outcome = await deliver(deps, rows, mac, speech);
    for (const row of rows) {
      const first = row.first_attempt_at ? Date.parse(row.first_attempt_at) : now.getTime();
      if (outcome === 'delivered') {
        markDelivered(deps, row, now);
        nextTry.delete(row.id);
        deps.log?.(`[reminder] ${mac} 已播报 #${row.id} ${row.text}`);
        continue;
      }
      run(deps.conn, 'UPDATE reminders SET attempts = attempts + 1, first_attempt_at = COALESCE(first_attempt_at, ?), last_attempt_at = ? WHERE id = ?',
        new Date(first).toISOString(), now.toISOString(), row.id);
      if (now.getTime() - first > MISSED_AFTER_MS) {
        if (row.repeat === 'none') {
          run(deps.conn, "UPDATE reminders SET status = 'missed' WHERE id = ?", row.id);
        } else {
          // 重复提醒:这一次记作错过,滚到下一次;在 missed 表里留一行供补报
          run(deps.conn, "INSERT INTO reminders (mac, agent_id, text, due_at, repeat, status, attempts) VALUES (?, ?, ?, ?, 'none', 'missed', ?)",
            row.mac, row.agent_id, row.text, row.due_at, row.attempts + 1);
          markDelivered(deps, { ...row, repeat: row.repeat }, now);
        }
        nextTry.delete(row.id);
        deps.log?.(`[reminder] ${mac} 设备一直不在线,#${row.id} 记为错过`);
      } else {
        nextTry.set(row.id, now.getTime() + (outcome === 'busy' ? BUSY_RETRY_MS : OFFLINE_RETRY_MS));
      }
    }
  }
}

/** 设备重连后补报错过的提醒。设备刚连上还在握手,等几秒、最多试几次。 */
export async function catchUp(deps: AgentDeps, mac: string, delaysMs: readonly number[] = [4000, 6000, 10_000]): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - CATCH_UP_WINDOW_MS).toISOString();
  const rows = all<ReminderRow>(deps.conn,
    "SELECT * FROM reminders WHERE mac = ? AND status = 'missed' AND due_at >= ? ORDER BY due_at LIMIT 5", mac, since);
  if (rows.length === 0) return;
  const speech = `刚才没联系上你,之前让我提醒你:${rows.map((r) => `${hhmm(new Date(r.due_at))} ${r.text}`).join(';')}。`;
  for (const delay of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    // 这期间可能已经补报过(设备连得很频繁)
    if (!one(deps.conn, "SELECT 1 FROM reminders WHERE id = ? AND status = 'missed'", rows[0]!.id)) return;
    const outcome = await deliver(deps, rows, mac, speech);
    if (outcome === 'delivered') {
      for (const row of rows) run(deps.conn, "UPDATE reminders SET status = 'delivered', delivered_at = ? WHERE id = ?", new Date().toISOString(), row.id);
      deps.log?.(`[reminder] ${mac} 补报了 ${rows.length} 个错过的提醒`);
      return;
    }
  }
}

export function startReminderScheduler(deps: AgentDeps): () => void {
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    scanOnce(deps)
      .catch((error: unknown) => deps.log?.(`[reminder] 扫描出错:${(error as Error).message}`))
      .finally(() => {
        running = false;
      });
  }, SCAN_MS);
  timer.unref();
  const hook = (mac: string) => catchUp(deps, mac);
  DEVICE_ONLINE_HOOKS.push(hook);
  return () => {
    clearInterval(timer);
    const index = DEVICE_ONLINE_HOOKS.indexOf(hook);
    if (index >= 0) DEVICE_ONLINE_HOOKS.splice(index, 1);
  };
}
