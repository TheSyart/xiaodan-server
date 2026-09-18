// 管理接口:角色模板、设备可切换的角色。设备的长期记忆搬去了「记忆」页(agent/memory/routes.ts)。

import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run, tx } from '../../db.ts';
import { canonicalMac } from '../../identity.ts';
import type { AgentDeps } from '../types.ts';
import { applyTemplate, ROLE_TEMPLATES, templateById } from './templates.ts';
import { systemVoiceOf } from '../../voice/system-voices.ts';

const idSchema = z.string().min(1).max(128);

export function roleTemplateRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });

  app.get('/', (c) => {
    const created = all<{ role_template: string; n: number }>(
      deps.conn, "SELECT role_template, COUNT(*) AS n FROM agents WHERE role_template != '' GROUP BY role_template",
    );
    return c.json({
      items: ROLE_TEMPLATES.map((template) => ({
        ...template,
        voice_name: systemVoiceOf(template.voice)?.name ?? template.voice,
        created: created.find((row) => row.role_template === template.id)?.n ?? 0,
      })),
    });
  });

  app.post('/:id/apply', async (c) => {
    const template = templateById(c.req.param('id'));
    if (!template) return c.json({ error: '没有这个模板' }, 404);
    const parsed = z.object({
      name: z.string().max(64).optional(),
      llm_model_id: idSchema.nullish(),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    if (parsed.data.llm_model_id && !one(deps.conn, "SELECT 1 FROM models WHERE id = ? AND model_type = 'LLM'", parsed.data.llm_model_id)) {
      return c.json({ error: '所选模型不存在' }, 400);
    }
    const result = applyTemplate(deps.conn, template, parsed.data);
    return c.json({ ok: true, ...result });
  });

  return app;
}

/** 挂在 /devices 下:/:mac/roles */
export function deviceRoleRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });

  const device = (raw: string) => {
    const mac = canonicalMac(raw);
    return mac && one<{ mac: string; agent_id: string }>(deps.conn, 'SELECT mac, agent_id FROM devices WHERE mac = ?', mac);
  };

  app.get('/:mac/roles', (c) => {
    const found = device(c.req.param('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const allowed = all<{ agent_id: string }>(deps.conn, 'SELECT agent_id FROM device_roles WHERE mac = ?', found.mac).map((row) => row.agent_id);
    return c.json({ agent_id: found.agent_id, allowlist: allowed.length ? allowed : null });
  });

  /** allowlist 为 null 表示不限制(所有由控制塔驱动的角色都能切);空数组表示不能切换 */
  app.put('/:mac/roles', async (c) => {
    const found = device(c.req.param('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const parsed = z.object({ allowlist: z.array(idSchema).max(50).nullable() }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    const ids = parsed.data.allowlist;
    if (ids) {
      const unknown = ids.find((id) => !one(deps.conn, 'SELECT 1 FROM agents WHERE id = ?', id));
      if (unknown) return c.json({ error: `智能体 ${unknown} 不存在` }, 400);
    }
    tx(deps.conn, () => {
      run(deps.conn, 'DELETE FROM device_roles WHERE mac = ?', found.mac);
      // 空数组也要落一行才能区别于「不限制」:只放当前角色,切换时它会被排除,效果就是不能切
      const rows = ids === null ? [] : ids.length ? [...new Set(ids)] : [found.agent_id];
      for (const id of rows) run(deps.conn, 'INSERT INTO device_roles (mac, agent_id) VALUES (?, ?)', found.mac, id);
    });
    return c.json({ ok: true });
  });

  return app;
}
