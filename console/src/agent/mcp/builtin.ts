// 内置的 MCP 服务器与标准 JSON 配置导入。
//
// AIHOT(AI 热点资讯)的 MCP 是匿名只读的公开接口,不需要令牌(https://aihot.news/agent?tab=mcp),
// 所以直接内置:控制塔启动时写进 mcp_servers,并给当时已有的智能体都启用。只在第一次写入,
// 之后用户删掉、改地址、取消勾选都不会被改回来(settings 里记一个内部标记)。
// 个人非商业使用免费;面向外部的商业产品须先取得 AIHOT 的书面授权。

import { randomBytes } from 'node:crypto';
import type { Db } from '../../db.ts';
import { all, one, run, tx } from '../../db.ts';

export interface BuiltinMcpServer {
  id: string;
  name: string;
  url: string;
  timeout_ms: number;
  /** 使用说明:角色开着这个服务器时写进提示词,在 MCP 页可以改 */
  instructions: string;
}

export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  {
    id: 'aihot',
    name: 'AI热点资讯',
    url: 'https://aihot.news/api/mcp',
    timeout_ms: 20_000,
    instructions: [
      '用它查最新的 AI 资讯(人工智能领域的新闻、热点、某个 AI 公司或模型的最新消息)。',
      '- 问「今天 / 最近有什么 AI 新闻」:先用 aihot_get_daily 取最新一期日报;没有日报时用 aihot_get_latest(window 取 24h,mode 取 selected)。',
      '- 问「现在最火的是什么」:用 aihot_get_hot_topics。',
      '- 问某个公司、模型、产品或人物:用 aihot_search,q 填那个名字。',
      '播报时挑最重要的三条,每条一两句口语,先说是谁做了什么,再说为什么值得关注;不念网址和英文长串,型号、版本号用口语说(比如「GPT 五」);'
        + '用户想听某一条的细节时再展开;结尾可以说一句「以上来自 AIHOT」。',
    ].join('\n'),
  },
];

const hasTable = (conn: Db, name: string) => !!one(conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);

function sameEndpoint(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/u, '') === y.pathname.replace(/\/+$/u, '');
  } catch {
    return a === b;
  }
}

/** 返回这次新写入的服务器 id。 */
export function seedBuiltinMcp(conn: Db): string[] {
  if (!hasTable(conn, 'mcp_servers') || !hasTable(conn, 'agent_mcp_servers')) return [];
  const added: string[] = [];
  for (const server of BUILTIN_MCP_SERVERS) {
    // 使用说明(迁移 v11 之后才有这一列):已有的内置服务器说明还是空的就补上一次,之后用户改了、清空了都不再动
    const noteFlag = `mcp.builtin.${server.id}.instructions`;
    if (!one(conn, 'SELECT 1 FROM settings WHERE key = ?', noteFlag)) {
      tx(conn, () => {
        const target = all<{ id: string; url: string; instructions: string }>(conn, 'SELECT id, url, instructions FROM mcp_servers')
          .find((row) => row.id === server.id || sameEndpoint(row.url, server.url));
        if (target && !target.instructions) run(conn, 'UPDATE mcp_servers SET instructions = ? WHERE id = ?', server.instructions, target.id);
        run(conn, "INSERT INTO settings (key, value, label, internal) VALUES (?, 'seeded', '内置 MCP 服务器的使用说明已写入', 1)", noteFlag);
      });
    }
    const flag = `mcp.builtin.${server.id}`;
    if (one(conn, 'SELECT 1 FROM settings WHERE key = ?', flag)) continue;
    tx(conn, () => {
      // 以前手动加过同一个接口(比如带 aihot_actor 参数的地址)就不重复加,也不动它的勾选
      const existing = all<{ id: string; url: string }>(conn, 'SELECT id, url FROM mcp_servers')
        .find((row) => row.id === server.id || sameEndpoint(row.url, server.url));
      if (!existing) {
        run(conn, 'INSERT INTO mcp_servers (id, name, url, timeout_ms, instructions) VALUES (?, ?, ?, ?, ?)',
          server.id, server.name, server.url, server.timeout_ms, server.instructions);
        for (const agent of all<{ id: string }>(conn, 'SELECT id FROM agents')) {
          run(conn, 'INSERT OR IGNORE INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES (?, ?, NULL)', agent.id, server.id);
        }
        added.push(server.id);
      }
      run(conn, "INSERT INTO settings (key, value, label, internal) VALUES (?, 'seeded', '内置 MCP 服务器已写入', 1)", flag);
    });
  }
  return added;
}

// ---------------------------------------------------------------- 标准 JSON 导入

export interface ImportedServer {
  key: string;
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface ImportPlan {
  servers: ImportedServer[];
  skipped: { name: string; reason: string }[];
}

/**
 * 解析 Claude、Cursor、Codex 等客户端通用的配置:
 *   {"mcpServers": {"aihot": {"type": "http", "url": "https://…", "headers": {…}}}}
 * 也接受省掉外层 mcpServers 的写法。只收远程 HTTP(Streamable HTTP);本地命令(command)与旧的 SSE 传输跳过并说明原因。
 */
export function parseMcpConfig(input: unknown): ImportPlan {
  const plan: ImportPlan = { servers: [], skipped: [] };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    plan.skipped.push({ name: '(整段)', reason: '不是 JSON 对象' });
    return plan;
  }
  const root = input as Record<string, unknown>;
  const map = (typeof root['mcpServers'] === 'object' && root['mcpServers'] !== null ? root['mcpServers'] : root) as Record<string, unknown>;
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'object' || value === null) {
      plan.skipped.push({ name: key, reason: '配置不是对象' });
      continue;
    }
    const entry = value as Record<string, unknown>;
    const type = String(entry['type'] ?? entry['transport'] ?? '').toLowerCase().replace(/[-_]/gu, '');
    if (typeof entry['command'] === 'string') {
      plan.skipped.push({ name: key, reason: '本地命令型(stdio)服务器,控制塔不在服务器上跑本地命令' });
      continue;
    }
    if (type === 'sse') {
      plan.skipped.push({ name: key, reason: '旧的 SSE 传输暂不支持,换成它的 Streamable HTTP 地址' });
      continue;
    }
    const url = typeof entry['url'] === 'string' ? entry['url'].trim() : '';
    if (!url) {
      plan.skipped.push({ name: key, reason: '没有 url' });
      continue;
    }
    const headers: Record<string, string> = {};
    if (typeof entry['headers'] === 'object' && entry['headers'] !== null) {
      for (const [name, v] of Object.entries(entry['headers'] as Record<string, unknown>)) {
        if (typeof v === 'string') headers[name] = v;
      }
    }
    plan.servers.push({ key, name: typeof entry['name'] === 'string' && entry['name'] ? entry['name'] : key, url, headers });
  }
  return plan;
}

/** 配置里的名字直接当 id(工具名 mcp_<id>__<工具> 更好认);不合规或已被占用时随机生成 */
export function serverIdFor(conn: Db, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32);
  if (slug && !one(conn, 'SELECT 1 FROM mcp_servers WHERE id = ?', slug)) return slug;
  return `mcp_${randomBytes(4).toString('hex')}`;
}

export function findSameEndpoint(conn: Db, url: string): { id: string; name: string } | undefined {
  return all<{ id: string; name: string; url: string }>(conn, 'SELECT id, name, url FROM mcp_servers').find((row) => sameEndpoint(row.url, url));
}
