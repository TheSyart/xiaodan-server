// 记忆的设置:记录范围、整理用的模型、原文保留期。全局一份,存在 tool_settings 的 'memory' 行(记忆页里改)。
//
// 记录范围这段文字有两个去处:拼进 remember 工具的说明,以及归档整理时的提示词 ——
// 实时记与事后补录用同一套口径,改一处两边都跟着变。

import type { Db } from '../../db.ts';
import { run } from '../../db.ts';
import { toolConfig } from '../tool-settings.ts';

export const MEMORY_CODE = 'memory';

export const DEFAULT_SCOPE = [
  '可以记:称呼与小名、年龄生日、喜好与讨厌、家人宠物老师同学的称呼、正在学的东西、作息与习惯、健康注意事项(过敏、忌口)。',
  '用户明确要求记住时也可以记:家人的联系方式、家庭住址与常去的地方。这类会单独标出来,平时不主动提起。',
  '不要记:一次性的小事、你自己说过的话、别人的隐私、密码与支付信息、证件号。',
].join('\n');

export interface MemorySettings {
  /** 记录范围说明 */
  scope: string;
  /** 整理对话档案用的模型;空表示用这段对话所属角色的对话模型 */
  summaryModelId: string;
  /** 归档后原文保留多少天;0 = 永久 */
  rawKeepDays: number;
  /** 少于几轮的对话不整理 */
  minTurns: number;
}

export function memorySettings(conn: Db): MemorySettings {
  const config = toolConfig(conn, MEMORY_CODE);
  const text = (key: string, fallback: string) => (typeof config[key] === 'string' && config[key] ? String(config[key]) : fallback);
  const number = (key: string, fallback: number) => {
    const value = Number(config[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    scope: text('scope', DEFAULT_SCOPE),
    summaryModelId: text('summary_model_id', ''),
    rawKeepDays: number('raw_keep_days', 0),
    minTurns: number('min_turns', 2),
  };
}

export function saveMemorySettings(conn: Db, input: Partial<MemorySettings>): MemorySettings {
  const current = memorySettings(conn);
  const next = { ...current, ...input };
  const config: Record<string, unknown> = {};
  // 与默认值相同的不存,这样以后改默认值老库也跟着变
  if (next.scope.trim() && next.scope.trim() !== DEFAULT_SCOPE) config['scope'] = next.scope.trim();
  if (next.summaryModelId) config['summary_model_id'] = next.summaryModelId;
  if (next.rawKeepDays) config['raw_keep_days'] = next.rawKeepDays;
  if (next.minTurns !== 2) config['min_turns'] = next.minTurns;
  run(
    conn,
    `INSERT INTO tool_settings (code, config_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (code) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
    MEMORY_CODE, JSON.stringify(config),
  );
  return memorySettings(conn);
}
