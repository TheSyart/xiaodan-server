// 提醒管理接口(挂在 /api/reminders):页面上查看、手动添加、取消。

import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run } from '../../db.ts';
import { canonicalMac } from '../../identity.ts';
import type { AgentDeps } from '../types.ts';
import { createReminder } from './store.ts';
import { formatBeijing, parseBeijing } from './time.ts';

export function reminderRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  app.get('/', (c) => {
    const status = c.req.query('status');
    const rows = all<Record<string, unknown>>(conn,
      `SELECT r.*, d.alias FROM reminders r LEFT JOIN devices d ON d.mac = r.mac
       ${status ? 'WHERE r.status = ?' : "WHERE r.status IN ('pending', 'missed') OR r.created_at >= datetime('now', '-7 days')"}
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'missed' THEN 1 ELSE 2 END, r.due_at LIMIT 300`,
      ...(status ? [status] : []));
    return c.json({ items: rows.map((row) => ({ ...row, due_local: formatBeijing(new Date(String(row['due_at']))) })) });
  });

  app.post('/', async (c) => {
    const parsed = z.object({
      mac: z.string().min(1).max(32),
      text: z.string().min(1).max(100),
      at: z.string().min(1).max(32),
      repeat: z.enum(['none', 'daily', 'weekdays', 'weekly']).default('none'),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const mac = canonicalMac(parsed.data.mac);
    const device = mac ? one<{ agent_id: string }>(conn, 'SELECT agent_id FROM devices WHERE mac = ?', mac) : undefined;
    if (!mac || !device) return c.json({ error: '设备不存在' }, 400);
    const due = parseBeijing(parsed.data.at);
    if (!due) return c.json({ error: '时间格式应为 YYYY-MM-DD HH:mm(北京时间)' }, 400);
    if (due.getTime() < Date.now() - 60_000) return c.json({ error: '这个时间已经过去了' }, 400);
    const row = createReminder(conn, { mac, agentId: device.agent_id, text: parsed.data.text, due, repeat: parsed.data.repeat });
    return c.json({ ok: true, id: row.id });
  });

  app.delete('/:id', (c) => {
    run(conn, "UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'missed')", Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  return app;
}
