// 提醒的时间规则。时区固定北京时间(UTC+8,无夏令时),数据库里存 UTC 的 ISO 时间。

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly';

const OFFSET_MS = 8 * 3600_000;
const LOCAL = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/u;

/** "2026-09-17 08:00"(北京时间)→ Date;格式不对返回 null */
export function parseBeijing(text: string): Date | null {
  const match = LOCAL.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59) return null;
  const utc = Date.UTC(y!, mo! - 1, d!, h!, mi!) - OFFSET_MS;
  const date = new Date(utc);
  // 2 月 30 日之类会被 Date 顺延,顺延了就当不合法
  const back = new Date(utc + OFFSET_MS);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo! - 1) return null;
  return date;
}

export function formatBeijing(date: Date): string {
  const local = new Date(date.getTime() + OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** 口语化:"今天 08:00"、"明天 19:30"、"9月20日 07:00" */
export function speakBeijing(date: Date, now: Date): string {
  const local = new Date(date.getTime() + OFFSET_MS);
  const today = new Date(now.getTime() + OFFSET_MS);
  const dayIndex = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
  const diff = dayIndex(local) - dayIndex(today);
  const hm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  if (diff === 2) return `后天 ${hm}`;
  return `${local.getUTCMonth() + 1}月${local.getUTCDate()}日 ${hm}`;
}

export function hhmm(date: Date): string {
  return formatBeijing(date).slice(11);
}

/** 重复提醒的下一次(严格晚于 after) */
export function nextOccurrence(due: Date, repeat: Repeat, after: Date): Date | null {
  if (repeat === 'none') return null;
  let next = new Date(due.getTime());
  for (let guard = 0; guard < 800; guard += 1) {
    next = new Date(next.getTime() + (repeat === 'weekly' ? 7 : 1) * 86_400_000);
    if (repeat === 'weekdays') {
      const weekday = new Date(next.getTime() + OFFSET_MS).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
    }
    if (next.getTime() > after.getTime()) return next;
  }
  return null;
}

export const REPEAT_LABEL: Record<Repeat, string> = { none: '', daily: '每天', weekdays: '每个工作日', weekly: '每周' };
