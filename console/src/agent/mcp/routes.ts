// MCP 服务器管理接口(挂在 /api/mcp-servers)。只收远程 https 地址(本机调试可用 http://localhost)。

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run, tx } from '../../db.ts';
import type { AgentDeps } from '../types.ts';
import { resetMcpSession } from './client.ts';
import { agentServerRows, mcpToolName, serverTools, toServer, type McpServerRow } from './tools.ts';

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function maskHeaders(json: string): Record<string, string> {
  try {
    const headers = JSON.parse(json) as Record<string, string>;
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v).length > 6 ? `${String(v).slice(0, 3)}…${String(v).slice(-2)}` : '***']));
  } catch {
    return {};
  }
}

/** 地址里常带 token 之类的参数(比如 aihot 的 actor):列表里只露出域名与路径,编辑时才返回完整地址 */
function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.search ? `${url.origin}${url.pathname}?…` : `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

const serverSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().min(1).max(2000).refine(validUrl, '地址必须是 https(本机调试可用 http://localhost)'),
  headers: z.record(z.string().max(64), z.string().max(2000)).optional(),
  enabled: z.boolean().default(true),
  timeout_ms: z.number().int().min(1000).max(120000).default(20000),
});

export function mcpRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  const view = (row: McpServerRow) => {
    let tools: { name: string; description: string }[] = [];
    try {
      tools = (JSON.parse(row.tools_json) as { name: string; description: string }[]).map((t) => ({ name: t.name, description: t.description }));
    } catch {
      tools = [];
    }
    return {
      id: row.id, name: row.name, url_masked: maskUrl(row.url), headers: maskHeaders(row.headers_json), enabled: row.enabled,
      timeout_ms: row.timeout_ms, tools, tools_updated_at: row.tools_updated_at, last_error: row.last_error,
      agents: all<{ agent_id: string; tool_allowlist_json: string | null }>(conn,
        'SELECT agent_id, tool_allowlist_json FROM agent_mcp_servers WHERE server_id = ?', row.id),
    };
  };

  app.get('/', (c) => c.json({ items: all<McpServerRow>(conn, 'SELECT * FROM mcp_servers ORDER BY created_at').map(view) }));

  app.get('/:id', (c) => {
    const row = one<McpServerRow>(conn, 'SELECT * FROM mcp_servers WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    // 编辑时需要完整地址;请求头的值仍不返回,留空表示不修改
    return c.json({ ...view(row), url: row.url });
  });

  app.post('/', async (c) => {
    const parsed = serverSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    const id = `mcp_${randomBytes(4).toString('hex')}`;
    run(conn, 'INSERT INTO mcp_servers (id, name, url, headers_json, enabled, timeout_ms) VALUES (?, ?, ?, ?, ?, ?)',
      id, d.name, d.url, JSON.stringify(d.headers ?? {}), d.enabled ? 1 : 0, d.timeout_ms);
    return c.json({ ok: true, id });
  });

  app.put('/:id', async (c) => {
    const row = one<McpServerRow>(conn, 'SELECT * FROM mcp_servers WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    const parsed = serverSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    // 请求头:没提交就保留;提交了空串的键视为删除
    let headers = JSON.parse(row.headers_json) as Record<string, string>;
    if (d.headers) {
      headers = { ...headers };
      for (const [key, value] of Object.entries(d.headers)) {
        if (value === '') delete headers[key];
        else if (!value.includes('…') && value !== '***') headers[key] = value;   // 打码值原样提交回来表示不修改
      }
    }
    resetMcpSession(toServer(row));
    run(conn, "UPDATE mcp_servers SET name = ?, url = ?, headers_json = ?, enabled = ?, timeout_ms = ?, tools_updated_at = NULL WHERE id = ?",
      d.name, d.url, JSON.stringify(headers), d.enabled ? 1 : 0, d.timeout_ms, row.id);
    return c.json({ ok: true });
  });

  app.delete('/:id', (c) => {
    run(conn, 'DELETE FROM mcp_servers WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 测试连接:初始化并拉一次工具列表,写回缓存 */
  app.post('/:id/test', async (c) => {
    const row = one<McpServerRow>(conn, 'SELECT * FROM mcp_servers WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    resetMcpSession(toServer(row));
    try {
      const started = Date.now();
      const tools = await serverTools(deps, row, true);
      return c.json({ ok: true, ms: Date.now() - started, tools: tools.map((t) => ({ name: t.name, description: t.description, exposed_as: mcpToolName(row.id, t.name) })) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  return app;
}

/** 智能体启用哪些 MCP 服务器(挂在 /api/agents/:id/mcp) */
export function agentMcpRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  app.get('/:id/mcp', (c) => c.json({ items: agentServerRows(deps.conn, c.req.param('id')).map((row) => ({ server_id: row.id, tool_allowlist: row.tool_allowlist_json ? JSON.parse(row.tool_allowlist_json) : null })) }));
  app.put('/:id/mcp', async (c) => {
    const id = c.req.param('id');
    if (!one(deps.conn, 'SELECT 1 FROM agents WHERE id = ?', id)) return c.json({ error: '智能体不存在' }, 404);
    const parsed = z.array(z.object({ server_id: z.string().min(1).max(64), tool_allowlist: z.array(z.string().max(128)).max(200).nullable().default(null) }))
      .safeParse(await c.req.json().catch(() => []));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);
    for (const item of parsed.data) {
      if (!one(deps.conn, 'SELECT 1 FROM mcp_servers WHERE id = ?', item.server_id)) return c.json({ error: `没有 MCP 服务器 ${item.server_id}` }, 400);
    }
    tx(deps.conn, () => {
      run(deps.conn, 'DELETE FROM agent_mcp_servers WHERE agent_id = ?', id);
      for (const item of parsed.data) {
        run(deps.conn, 'INSERT INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES (?, ?, ?)',
          id, item.server_id, item.tool_allowlist ? JSON.stringify(item.tool_allowlist) : null);
      }
    });
    return c.json({ ok: true });
  });
  return app;
}
