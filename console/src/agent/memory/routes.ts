// 记忆页的接口(挂在 /api/memory)。
//
// 热记忆按设备存;冷记忆是每段对话的档案,原文仍在 chat_messages 里,按 arc_id 关联。
// 「哪个角色开着记忆」仍在智能体页改,这里只读地显示,避免两处双写。

import { Hono } from 'hono';
import { z } from 'zod';
import { all, one } from '../../db.ts';
import { arcById, arcMessages, arcStats, deleteArc, listArcs, toView } from './arcs.ts';
import { summarizeArc } from './archive.ts';
import { canonicalMac } from '../../identity.ts';
import type { AgentDeps } from '../types.ts';
import { MEMORY_PLUGIN } from './tools.ts';
import { DEFAULT_SCOPE, memorySettings, saveMemorySettings } from './settings.ts';
import {
  factById, kindLabel, listChanges, listMemory, MAX_FACT_CHARS, MAX_FACTS_PER_DEVICE, MEMORY_KINDS,
  deleteFact, editFact, remember, undoChange, type ChangeRow,
} from './store.ts';

export function memoryRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  /** 路径或查询里的 MAC → 已绑定的设备 */
  const device = (raw: string | undefined) => {
    const mac = raw ? canonicalMac(raw) : null;
    return mac ? one<{ mac: string; agent_id: string; alias: string }>(
      conn, 'SELECT mac, agent_id, alias FROM devices WHERE mac = ?', mac,
    ) : undefined;
  };

  const view = (row: { id: number; text: string; kind: string; sensitive: number; source: string; agent_id: string | null; created_at: string; updated_at: string }) => ({
    ...row,
    kind_label: kindLabel(row.kind),
  });

  // ---- 概览:设备清单与这台设备的统计 ----

  app.get('/overview', (c) => {
    const devices = all<{ mac: string; alias: string; agent_id: string; agent_name: string }>(conn,
      `SELECT d.mac, d.alias, d.agent_id, a.name AS agent_name FROM devices d
       LEFT JOIN agents a ON a.id = d.agent_id ORDER BY d.last_connected_at DESC`);
    const found = device(c.req.query('mac')) ?? (devices[0] ? device(devices[0].mac) : undefined);
    if (!found) return c.json({ devices, device: null });
    const facts = listMemory(conn, found.mac);
    const arcs = arcStats(conn, found.mac);
    const enabledAgents = all<{ id: string; name: string }>(conn,
      `SELECT a.id, a.name FROM agent_plugins p JOIN agents a ON a.id = p.agent_id
       WHERE p.plugin_code = ? ORDER BY a.is_default DESC, a.created_at`, MEMORY_PLUGIN);
    return c.json({
      devices,
      device: {
        mac: found.mac,
        alias: found.alias,
        agent_id: found.agent_id,
        // 这台设备当前的角色开没开记忆:关着的话模型既不会记,也读不到
        enabled: enabledAgents.some((agent) => agent.id === found.agent_id),
        facts: facts.length,
        sensitive: facts.filter((row) => row.sensitive).length,
        max_facts: MAX_FACTS_PER_DEVICE,
        max_chars: MAX_FACT_CHARS,
        arcs: arcs.count,
        arc_from: arcs.from,
        arc_to: arcs.to,
        arcs_this_month: arcs.thisMonth,
        /** 还没整理的原文条数:上线后攒的老对话在这儿 */
        unarchived: one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM chat_messages WHERE mac = ? AND arc_id IS NULL', found.mac)?.n ?? 0,
      },
      kinds: MEMORY_KINDS,
      agents_with_memory: enabledAgents,
    });
  });

  // ---- 设置 ----

  app.get('/settings', (c) => c.json({
    ...memorySettings(conn),
    default_scope: DEFAULT_SCOPE,
    models: all<{ id: string; name: string }>(conn,
      "SELECT id, name FROM models WHERE model_type = 'LLM' AND enabled = 1 ORDER BY is_default DESC, id"),
  }));

  app.put('/settings', async (c) => {
    const parsed = z.object({
      scope: z.string().max(2000).optional(),
      summaryModelId: z.string().max(64).optional(),
      rawKeepDays: z.number().int().min(0).max(3650).optional(),
      minTurns: z.number().int().min(0).max(20).optional(),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    if (parsed.data.summaryModelId && !one(conn, "SELECT 1 FROM models WHERE id = ? AND model_type = 'LLM'", parsed.data.summaryModelId)) {
      return c.json({ error: '所选的模型不存在' }, 400);
    }
    return c.json({ ok: true, ...saveMemorySettings(conn, parsed.data) });
  });

  // ---- 热记忆 ----

  app.get('/facts', (c) => {
    const found = device(c.req.query('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const kind = c.req.query('kind');
    const rows = listMemory(conn, found.mac).filter((row) => !kind || row.kind === kind);
    const names = new Map(all<{ id: string; name: string }>(conn, 'SELECT id, name FROM agents').map((row) => [row.id, row.name]));
    return c.json({
      items: rows.map((row) => ({ ...view(row), agent_name: row.agent_id ? names.get(row.agent_id) ?? null : null })),
      max_chars: MAX_FACT_CHARS,
    });
  });

  app.post('/facts', async (c) => {
    const parsed = z.object({ mac: z.string().min(1).max(32), text: z.string().min(1).max(200) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '请填写要记住的内容' }, 400);
    const found = device(parsed.data.mac);
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const outcome = remember(conn, { mac: found.mac, text: parsed.data.text, source: 'admin' });
    if (outcome.status === 'rejected') return c.json({ error: `没有保存:${outcome.reason}` }, 400);
    return c.json({ ok: true, status: outcome.status, item: view(outcome.row) });
  });

  app.put('/facts/:id', async (c) => {
    const row = factById(conn, Number(c.req.param('id')));
    if (!row) return c.json({ error: '这条记忆不存在' }, 404);
    const parsed = z.object({ text: z.string().min(1).max(200) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '请填写内容' }, 400);
    const result = editFact(conn, row, parsed.data.text);
    if (!result.ok) return c.json({ error: `没有保存:${result.reason}` }, 400);
    return c.json({ ok: true, item: view(result.row) });
  });

  app.delete('/facts/:id', (c) => {
    const row = factById(conn, Number(c.req.param('id')));
    if (row) deleteFact(conn, row, 'admin', '在记忆页删掉');
    return c.json({ ok: true });
  });

  app.delete('/facts', (c) => {
    const found = device(c.req.query('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    for (const row of listMemory(conn, found.mac)) deleteFact(conn, row, 'admin', '在记忆页清空');
    return c.json({ ok: true });
  });

  // ---- 冷记忆:对话档案 ----

  app.get('/arcs', (c) => {
    const found = device(c.req.query('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const names = new Map(all<{ id: string; name: string }>(conn, 'SELECT id, name FROM agents').map((row) => [row.id, row.name]));
    const { items, next } = listArcs(conn, {
      mac: found.mac,
      ...(c.req.query('q') ? { q: c.req.query('q')! } : {}),
      ...(c.req.query('before') ? { before: c.req.query('before')! } : {}),
      ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
    });
    return c.json({
      items: items.map((row) => ({ ...toView(row), agent_name: row.agent_id ? names.get(row.agent_id) ?? null : null })),
      next,
    });
  });

  app.get('/arcs/:id', (c) => {
    const arc = arcById(conn, Number(c.req.param('id')));
    if (!arc) return c.json({ error: '没有这段对话' }, 404);
    return c.json({ arc: toView(arc), messages: arcMessages(conn, arc.id) });
  });

  /** 重新整理:没能自动整理好的(模型出错、返回的东西看不懂)在页面上点一下重来 */
  app.post('/arcs/:id/retry', async (c) => {
    const arc = arcById(conn, Number(c.req.param('id')));
    if (!arc) return c.json({ error: '没有这段对话' }, 404);
    if (arc.status === 'raw_gone') return c.json({ error: '这段对话的原文已经按保留策略清掉了,没法重新整理' }, 409);
    const status = await summarizeArc(deps, { ...arc, attempts: 0 }, true);
    return c.json({ ok: true, status, arc: toView(arcById(conn, arc.id)!) });
  });

  app.delete('/arcs/:id', (c) => {
    const arc = arcById(conn, Number(c.req.param('id')));
    if (arc) deleteArc(conn, arc, c.req.query('keep_raw') === '1');
    return c.json({ ok: true });
  });

  // ---- 变更留痕与撤销 ----

  app.get('/changes', (c) => {
    const found = device(c.req.query('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const names = new Map(all<{ id: string; name: string }>(conn, 'SELECT id, name FROM agents').map((row) => [row.id, row.name]));
    return c.json({
      items: listChanges(conn, found.mac, Math.min(Number(c.req.query('limit')) || 20, 100))
        .map((row) => ({ ...row, kind_label: kindLabel(row.kind), agent_name: row.agent_id ? names.get(row.agent_id) ?? null : null })),
    });
  });

  app.post('/changes/:id/undo', (c) => {
    const change = one<ChangeRow>(conn, 'SELECT * FROM memory_changes WHERE id = ?', Number(c.req.param('id')));
    if (!change) return c.json({ error: '没有这条变更记录' }, 404);
    if (!undoChange(conn, change)) return c.json({ error: '这条已经撤销过了,或者对应的记忆又变过' }, 409);
    return c.json({ ok: true });
  });

  return app;
}
