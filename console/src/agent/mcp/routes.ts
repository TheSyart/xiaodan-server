// MCP 服务器管理接口(挂在 /api/mcp-servers)。只收远程 https 地址(本机调试可用 http://localhost)。
// 服务器对外提供哪些工具在这里设置;哪个智能体用哪些服务器在智能体页(/api/agents/:id/mcp)只做开关。

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run, tx } from '../../db.ts';
import type { AgentDeps } from '../types.ts';
import { findSameEndpoint, parseMcpConfig, serverIdFor } from './builtin.ts';
import { resetMcpSession } from './client.ts';
import { agentServerRows, allowlistOf, mcpToolName, serverTools, toServer, type McpServerRow } from './tools.ts';

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

/** 地址里可能带 token 之类的参数:列表里只露出域名与路径,编辑时才返回完整地址 */
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
      id: row.id, name: row.name, url_masked: maskUrl(row.url), headers: maskHeaders(row.headers_json),
      timeout_ms: row.timeout_ms, tools, tool_allowlist: allowlistOf(row), tools_updated_at: row.tools_updated_at, last_error: row.last_error,
      agents: all<{ id: string; name: string }>(conn,
        'SELECT g.id, g.name FROM agent_mcp_servers a JOIN agents g ON g.id = a.agent_id WHERE a.server_id = ? ORDER BY g.is_default DESC, g.created_at', row.id),
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
    run(conn, 'INSERT INTO mcp_servers (id, name, url, headers_json, timeout_ms) VALUES (?, ?, ?, ?, ?)',
      id, d.name, d.url, JSON.stringify(d.headers ?? {}), d.timeout_ms);
    return c.json({ ok: true, id });
  });

  /**
   * 粘贴客户端通用的 JSON 配置导入({"mcpServers": {...}})。同一个接口已经有了就跳过;
   * 导入后立刻测一次连接,enable_for_all_agents 为真时给所有智能体启用。
   */
  app.post('/import', async (c) => {
    const parsed = z.object({ config: z.unknown(), enable_for_all_agents: z.boolean().default(false) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    let config = parsed.data.config;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config) as unknown;
      } catch {
        return c.json({ error: '不是合法的 JSON' }, 400);
      }
    }
    const plan = parseMcpConfig(config);
    const skipped = [...plan.skipped];
    const created: { id: string; name: string; tools: number | null; error: string | null }[] = [];
    for (const server of plan.servers) {
      const url = serverSchema.shape.url.safeParse(server.url);
      if (!url.success) {
        skipped.push({ name: server.name, reason: url.error.issues[0]?.message ?? '地址不正确' });
        continue;
      }
      const same = findSameEndpoint(conn, server.url);
      if (same) {
        skipped.push({ name: server.name, reason: `已经有了(「${same.name}」)` });
        continue;
      }
      const id = serverIdFor(conn, server.key);
      tx(conn, () => {
        run(conn, 'INSERT INTO mcp_servers (id, name, url, headers_json) VALUES (?, ?, ?, ?)', id, server.name.slice(0, 64), server.url, JSON.stringify(server.headers));
        if (parsed.data.enable_for_all_agents) {
          for (const agent of all<{ id: string }>(conn, 'SELECT id FROM agents')) {
            run(conn, 'INSERT OR IGNORE INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES (?, ?, NULL)', agent.id, id);
          }
        }
      });
      const row = one<McpServerRow>(conn, 'SELECT * FROM mcp_servers WHERE id = ?', id)!;
      try {
        created.push({ id, name: row.name, tools: (await serverTools(deps, row, true)).length, error: null });
      } catch (error) {
        created.push({ id, name: row.name, tools: null, error: (error as Error).message });
      }
    }
    return c.json({ ok: true, created, skipped });
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
    run(conn, "UPDATE mcp_servers SET name = ?, url = ?, headers_json = ?, timeout_ms = ?, tools_updated_at = NULL WHERE id = ?",
      d.name, d.url, JSON.stringify(headers), d.timeout_ms, row.id);
    return c.json({ ok: true });
  });

  /** 对外提供哪些工具:工具名列表,null 表示全部(以后服务器新增的工具也算) */
  app.put('/:id/tools', async (c) => {
    const row = one<McpServerRow>(conn, 'SELECT * FROM mcp_servers WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    const parsed = z.object({ allowlist: z.array(z.string().min(1).max(128)).max(500).nullable() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);
    const allowlist = parsed.data.allowlist ? [...new Set(parsed.data.allowlist)] : null;
    run(conn, 'UPDATE mcp_servers SET tool_allowlist_json = ? WHERE id = ?', allowlist ? JSON.stringify(allowlist) : null, row.id);
    return c.json({ ok: true, tool_allowlist: allowlist });
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

/** 智能体开着哪些 MCP 服务器(挂在 /api/agents/:id/mcp):服务器 id 列表 */
export function agentMcpRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  app.get('/:id/mcp', (c) => c.json({ items: agentServerRows(deps.conn, c.req.param('id')).map((row) => row.id) }));
  app.put('/:id/mcp', async (c) => {
    const id = c.req.param('id');
    if (!one(deps.conn, 'SELECT 1 FROM agents WHERE id = ?', id)) return c.json({ error: '智能体不存在' }, 404);
    const parsed = z.array(z.string().min(1).max(64)).max(100).safeParse(await c.req.json().catch(() => []));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);
    for (const serverId of parsed.data) {
      if (!one(deps.conn, 'SELECT 1 FROM mcp_servers WHERE id = ?', serverId)) return c.json({ error: `没有 MCP 服务器 ${serverId}` }, 400);
    }
    tx(deps.conn, () => {
      run(deps.conn, 'DELETE FROM agent_mcp_servers WHERE agent_id = ?', id);
      for (const serverId of new Set(parsed.data)) {
        run(deps.conn, 'INSERT INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES (?, ?, NULL)', id, serverId);
      }
    });
    return c.json({ ok: true });
  });
  return app;
}
