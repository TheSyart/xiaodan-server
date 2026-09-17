// 外部服务商配置(service_providers 表):联网搜索。可以配多家,默认那家生效。
// 配置里的密钥可以直接填,也可以引用「模型」页里某个模型的密钥(例如用 DeepSeek 对话模型的 Key 做搜索),免得填两遍。

import type { Db } from '../db.ts';
import { one } from '../db.ts';

export type ServiceKind = 'search';

export interface ServiceRow {
  id: string;
  kind: ServiceKind;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  is_default: number;
  enabled: number;
}

function parse(json: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(json ?? '{}') as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 取某类的默认服务商(没有标默认就取第一个启用的)。 */
export function defaultService(conn: Db, kind: ServiceKind): ServiceRow | undefined {
  const row = one<{ id: string; kind: ServiceKind; name: string; provider: string; config_json: string; is_default: number; enabled: number }>(
    conn,
    'SELECT * FROM service_providers WHERE kind = ? AND enabled = 1 ORDER BY is_default DESC, created_at LIMIT 1',
    kind,
  );
  return row ? { ...row, config: resolveKeys(conn, parse(row.config_json)) } : undefined;
}

export function serviceById(conn: Db, id: string): ServiceRow | undefined {
  const row = one<{ id: string; kind: ServiceKind; name: string; provider: string; config_json: string; is_default: number; enabled: number }>(
    conn, 'SELECT * FROM service_providers WHERE id = ?', id,
  );
  return row ? { ...row, config: resolveKeys(conn, parse(row.config_json)) } : undefined;
}

/** config.key_from_model = 模型 id 时,把那个模型的 api_key(与 base_url、workspace_id)补进来。 */
export function resolveKeys(conn: Db, config: Record<string, unknown>): Record<string, unknown> {
  const modelId = typeof config['key_from_model'] === 'string' ? config['key_from_model'] : '';
  if (!modelId) return config;
  const model = one<{ config_json: string }>(conn, 'SELECT config_json FROM models WHERE id = ?', modelId);
  if (!model) return config;
  const source = parse(model.config_json);
  const merged = { ...config };
  for (const key of ['api_key', 'workspace_id']) {
    if (!merged[key] && source[key]) merged[key] = source[key];
  }
  if (!merged['model_base_url'] && source['base_url']) merged['model_base_url'] = source['base_url'];
  return merged;
}

/** 接口返回配置时把密钥打码 */
export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = /key|secret|token|password/iu.test(key) && typeof value === 'string' && value
      ? `${value.slice(0, 3)}…${value.slice(-2)}`
      : value;
  }
  return out;
}
