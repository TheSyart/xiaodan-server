// 工具的设置:所有智能体共用一份,存在 tool_settings(工具页里改)。智能体页只决定开不开。

import type { Db } from '../db.ts';
import { all, one, run } from '../db.ts';
import type { PluginDef, ProviderField } from '../catalog.ts';

export function toolConfig(conn: Db, code: string): Record<string, unknown> {
  const row = one<{ config_json: string }>(conn, 'SELECT config_json FROM tool_settings WHERE code = ?', code);
  try {
    const value = JSON.parse(row?.config_json ?? '{}') as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 由库里的数据现填的下拉选项 */
export function fieldOptions(conn: Db, field: ProviderField): { value: string; label: string }[] {
  if (field.optionsFrom === 'image_models') {
    return all<{ id: string; name: string }>(conn, "SELECT id, name FROM models WHERE model_type = 'Image' AND enabled = 1 ORDER BY is_default DESC, name")
      .map((row) => ({ value: row.id, label: row.name }));
  }
  if (field.optionsFrom === 'vocab_books') {
    return all<{ id: string; title: string }>(conn, 'SELECT id, title FROM vocab_books ORDER BY builtin DESC, created_at')
      .map((row) => ({ value: row.id, label: row.title }));
  }
  return field.options ?? [];
}

/**
 * 按工具声明的字段校验提交的设置:认识的字段才收,空值当作「用默认」不存。返回整理后的设置或错误说明。
 */
export function validateToolConfig(conn: Db, def: PluginDef, input: Record<string, unknown>): { config: Record<string, unknown> } | { error: string } {
  const config: Record<string, unknown> = {};
  for (const field of def.fields) {
    const raw = input[field.key];
    if (raw === undefined || raw === null || raw === '') continue;
    switch (field.type) {
      case 'number': {
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(value)) return { error: `「${field.label}」要填数字` };
        if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          return { error: `「${field.label}」要在 ${field.min ?? '-∞'} 到 ${field.max ?? '∞'} 之间` };
        }
        config[field.key] = value;
        break;
      }
      case 'boolean':
        if (typeof raw !== 'boolean') return { error: `「${field.label}」取值不对` };
        config[field.key] = raw;
        break;
      case 'select': {
        const value = String(raw);
        if (!fieldOptions(conn, field).some((option) => option.value === value)) return { error: `「${field.label}」选的项不存在` };
        config[field.key] = value;
        break;
      }
      default: {
        if (typeof raw !== 'string') return { error: `「${field.label}」要填文字` };
        const value = raw.trim();
        const limit = field.maxLength ?? 200;
        if (value.length > limit) return { error: `「${field.label}」最多 ${limit} 字` };
        if (value) config[field.key] = value;
      }
    }
  }
  return { config };
}

export function saveToolConfig(conn: Db, code: string, config: Record<string, unknown>): void {
  run(conn,
    `INSERT INTO tool_settings (code, config_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (code) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
    code, JSON.stringify(config));
}
