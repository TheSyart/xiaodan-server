// 迁移 v10:能力分成工具、技能、MCP 三类,各自在自己的页面上设置,智能体页只决定开不开。
//
//   1. 工具设置从「每个智能体一份」收拢成全局一份(新表 tool_settings):
//      以默认智能体填的为准,它没填就取第一个填了的智能体;画画工具的文生图模型也从 agents.image_model_id 收进来。
//      agent_plugins.params_json 与 agents.image_model_id 清空,之后不再读写。
//   2. MCP「对外提供哪些工具」从智能体级挪到服务器级(mcp_servers.tool_allowlist_json,NULL 表示全部):
//      同样以默认智能体的为准。agent_mcp_servers.tool_allowlist_json 清空,之后不再读写。
//   3. 技能与 MCP 服务器不再有全局启用开关:原来停用的,先从所有智能体取消勾选(效果不变),再恢复成启用。
//
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。

import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

const list = <T = Row>(conn: DatabaseSync, sql: string, ...params: unknown[]) =>
  conn.prepare(sql).all(...(params as never[])) as T[];
const exec = (conn: DatabaseSync, sql: string, ...params: unknown[]) => {
  conn.prepare(sql).run(...(params as never[]));
};

function parsedObject(json: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(json ?? '{}')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 去掉空值后还有内容的设置才算「填了」 */
function filled(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

export function migrateCapabilityPages(conn: DatabaseSync): void {
  conn.exec(`
    -- 工具的设置,所有智能体共用。code 与 agent_plugins.plugin_code 一致
    CREATE TABLE tool_settings (
      code        TEXT PRIMARY KEY,
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- MCP 服务器对外提供哪些工具;NULL 表示全部
    ALTER TABLE mcp_servers ADD COLUMN tool_allowlist_json TEXT;
  `);

  // 默认智能体排第一,其余按创建先后
  const agentOrder = `(SELECT is_default FROM agents WHERE agents.id = x.agent_id) DESC,
                      (SELECT created_at FROM agents WHERE agents.id = x.agent_id)`;

  // 1. 工具设置
  const settings = new Map<string, Record<string, unknown>>();
  for (const row of list<{ plugin_code: string; params_json: string }>(conn,
    `SELECT x.plugin_code, x.params_json FROM agent_plugins x ORDER BY ${agentOrder}`)) {
    const config = filled(parsedObject(row.params_json));
    if (!settings.has(row.plugin_code) && Object.keys(config).length) settings.set(row.plugin_code, config);
  }
  const image = list<{ image_model_id: string }>(conn,
    `SELECT image_model_id FROM agents WHERE image_model_id IS NOT NULL ORDER BY is_default DESC, created_at LIMIT 1`)[0];
  if (image) settings.set('image', { ...(settings.get('image') ?? {}), model_id: image.image_model_id });
  for (const [code, config] of settings) {
    exec(conn, 'INSERT INTO tool_settings (code, config_json) VALUES (?, ?)', code, JSON.stringify(config));
  }
  exec(conn, "UPDATE agent_plugins SET params_json = '{}'");
  exec(conn, 'UPDATE agents SET image_model_id = NULL');

  // 2. MCP 对外提供的工具
  const allowlists = new Map<string, string>();
  for (const row of list<{ server_id: string; tool_allowlist_json: string }>(conn,
    `SELECT x.server_id, x.tool_allowlist_json FROM agent_mcp_servers x WHERE x.tool_allowlist_json IS NOT NULL ORDER BY ${agentOrder}`)) {
    if (!allowlists.has(row.server_id)) allowlists.set(row.server_id, row.tool_allowlist_json);
  }
  for (const [serverId, allowlist] of allowlists) {
    exec(conn, 'UPDATE mcp_servers SET tool_allowlist_json = ? WHERE id = ?', allowlist, serverId);
  }
  exec(conn, 'UPDATE agent_mcp_servers SET tool_allowlist_json = NULL');

  // 3. 全局停用的技能与 MCP 服务器
  exec(conn, 'DELETE FROM agent_skills WHERE skill_name IN (SELECT name FROM skills WHERE enabled = 0)');
  exec(conn, 'UPDATE skills SET enabled = 1');
  exec(conn, 'DELETE FROM agent_mcp_servers WHERE server_id IN (SELECT id FROM mcp_servers WHERE enabled = 0)');
  exec(conn, 'UPDATE mcp_servers SET enabled = 1');
}
