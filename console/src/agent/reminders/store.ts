// 提醒的读写。

import type { Db } from '../../db.ts';
import { all, one, run } from '../../db.ts';
import type { Repeat } from './time.ts';

export interface ReminderRow {
  id: number;
  mac: string;
  agent_id: string | null;
  text: string;
  due_at: string;
  repeat: Repeat;
  status: 'pending' | 'delivered' | 'missed' | 'cancelled';
  attempts: number;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export const MAX_PENDING_PER_DEVICE = 50;

export function createReminder(conn: Db, input: { mac: string; agentId: string | null; text: string; due: Date; repeat: Repeat }): ReminderRow {
  run(conn, 'INSERT INTO reminders (mac, agent_id, text, due_at, repeat) VALUES (?, ?, ?, ?, ?)',
    input.mac, input.agentId, input.text, input.due.toISOString(), input.repeat);
  return one<ReminderRow>(conn, 'SELECT * FROM reminders WHERE id = last_insert_rowid()')!;
}

export function pendingForDevice(conn: Db, mac: string): ReminderRow[] {
  return all<ReminderRow>(conn, "SELECT * FROM reminders WHERE mac = ? AND status = 'pending' ORDER BY due_at", mac);
}

export function dueReminders(conn: Db, now: Date): ReminderRow[] {
  return all<ReminderRow>(conn, "SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 50", now.toISOString());
}
