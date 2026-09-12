// 首次启动的初始化:补齐系统参数、建一个可用的默认智能体、生成服务端密钥。
//
// 全部是"缺了才补",所以每次启动都跑一遍是安全的:用户改过的值不会被覆盖,
// 后续版本新增的参数会自动出现。

import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { all, one, run, tx } from './db.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

export const DEFAULT_AGENT_ID = 'agent_xiaodan';

/** 服务端用它做 Bearer 鉴权。首次启动随机生成,之后可在设置页轮换。 */
export const SECRET_KEY = 'server.secret';

function ensureSetting(conn: Db, key: string, value: string, type: string, label: string, internal: boolean): void {
  run(
    conn,
    `INSERT INTO settings (key, value, value_type, label, internal) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET label = excluded.label, value_type = excluded.value_type,
                                     internal = excluded.internal`,
    key,
    value,
    type,
    label,
    internal ? 1 : 0,
  );
}

export function seed(conn: Db): void {
  tx(conn, () => {
    // 参数:值只在首次插入时写,之后仅同步标签与类型,不动用户改过的值。
    for (const def of DEFAULT_SETTINGS) {
      ensureSetting(conn, def.key, def.value, def.type, def.label, def.internal === true);
    }

    // 服务端密钥。它不在 DEFAULT_SETTINGS 里,因为默认值必须是随机的。
    if (!one(conn, 'SELECT 1 FROM settings WHERE key = ?', SECRET_KEY)) {
      run(
        conn,
        'INSERT INTO settings (key, value, value_type, label, internal) VALUES (?, ?, ?, ?, 0)',
        SECRET_KEY,
        randomBytes(24).toString('base64url'),
        'string',
        '服务端接入密钥',
      );
    }

    // 三个"不需要配置就能用"的模块。没有它们服务端起不来:
    // VAD 是本地模型,Intent/Memory 的 nointent/nomem 是空实现。
    seedModel(conn, {
      id: 'VAD_SileroVAD',
      type: 'VAD',
      name: '本地语音活动检测',
      provider: 'silero',
      config: {
        type: 'silero',
        model_dir: 'models/snakers4_silero-vad',
        threshold: 0.5,
        min_silence_duration_ms: 700,
      },
      isDefault: true,
    });
    seedModel(conn, {
      id: 'Intent_nointent',
      type: 'Intent',
      name: '不启用工具',
      provider: 'nointent',
      config: { type: 'nointent' },
      isDefault: true,
    });
    seedModel(conn, {
      id: 'Intent_function_call',
      type: 'Intent',
      name: '函数调用',
      provider: 'function_call',
      config: { type: 'function_call' },
      isDefault: false,
    });
    seedModel(conn, {
      id: 'Memory_nomem',
      type: 'Memory',
      name: '不记忆',
      provider: 'nomem',
      config: { type: 'nomem' },
      isDefault: true,
    });

    // 默认智能体。人设刻意写短:提示词每轮都随对话上送,长了会推高延迟与成本。
    // 并且【显式写明能力边界】—— 上游默认模板的示例本身在演示放歌和报天气,
    // 模型照着学就会承诺它没有的能力(被要求开灯时回答"你想开哪个房间的灯")。
    if (!one(conn, 'SELECT 1 FROM agents WHERE id = ?', DEFAULT_AGENT_ID)) {
      run(
        conn,
        `INSERT INTO agents (id, name, system_prompt, vad_model_id, asr_model_id, memory_model_id,
                             intent_model_id, chat_history_conf, is_default)
         VALUES (?, ?, ?, 'VAD_SileroVAD', NULL, 'Memory_nomem', 'Intent_nointent', 1, 1)`,
        DEFAULT_AGENT_ID,
        '小单',
        [
          '你叫小单,是一个随身的 AI 伴侣,住在一块小小的硬件里。',
          '你的回答必须简短口语化,通常一到两句话,因为用户是在听你说话而不是读文字。',
          '不要使用 Markdown、列表或任何排版符号。不要念出表情符号。',
          '遇到不确定的事就说不知道,不要编造。',
        ].join('\n'),
      );
    }
  });
}

interface SeedModel {
  id: string;
  type: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  isDefault: boolean;
}

function seedModel(conn: Db, model: SeedModel): void {
  if (one(conn, 'SELECT 1 FROM models WHERE id = ?', model.id)) return;
  run(
    conn,
    `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    model.id,
    model.type,
    model.name,
    model.provider,
    JSON.stringify(model.config),
    model.isDefault ? 1 : 0,
  );
}

/** 某类型下当前的默认模型 id。 */
export function defaultModelId(conn: Db, type: string): string | undefined {
  const row = all<{ id: string }>(
    conn,
    'SELECT id FROM models WHERE model_type = ? AND is_default = 1 AND enabled = 1 LIMIT 1',
    type,
  )[0];
  return row?.id;
}
