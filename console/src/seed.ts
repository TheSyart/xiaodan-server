// 首次启动的初始化:补齐系统参数、建一个可用的默认智能体、生成服务端密钥。
//
// 全部是"缺了才补",所以每次启动都跑一遍是安全的:用户改过的值不会被覆盖,
// 后续版本新增的参数会自动出现。

import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { all, one, run, tx } from './db.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

export const DEFAULT_AGENT_ID = 'agent_xiaodan';

/** 新库里默认智能体开启的插件:本仓库自写、会在设备屏幕上显示画面的三个工具。 */
export const DEFAULT_AGENT_PLUGINS = ['show_calendar', 'get_weather', 'set_volume'] as const;

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
    // 工具调用默认开启:新装的实例开箱就能查日期、查天气、调音量(server/plugins/)。
    // 只影响新库 —— seedModel 与下面的默认智能体都是"缺了才插",已有实例的默认模型与智能体配置不会被改。
    seedModel(conn, {
      id: 'Intent_nointent',
      type: 'Intent',
      name: '不启用工具',
      provider: 'nointent',
      config: { type: 'nointent' },
      isDefault: false,
    });
    seedModel(conn, {
      id: 'Intent_function_call',
      type: 'Intent',
      name: '函数调用',
      provider: 'function_call',
      config: { type: 'function_call' },
      isDefault: true,
    });
    seedModel(conn, {
      id: 'Memory_nomem',
      type: 'Memory',
      name: '不记忆',
      provider: 'nomem',
      config: { type: 'nomem' },
      isDefault: true,
    });

    // 默认智能体。人设按「角色 / 人设标签 / 互动方式 / 语言风格」四段写,只管性格与说话方式;
    // 简短、能力边界、工具与输出格式这类规则统一放在引擎的提示词模板(server/prompts/xiaodan-base-prompt.txt)里。
    // 【能力边界必须显式写明】—— 上游默认模板的示例本身在演示放歌和报天气,
    // 模型照着学就会承诺它没有的能力(被要求开灯时回答"你想开哪个房间的灯")。
    // 参考表达里的语气词只用设备字库里有的字:欸、喔、嗯在屏幕上显示不出来。
    if (!one(conn, 'SELECT 1 FROM agents WHERE id = ?', DEFAULT_AGENT_ID)) {
      run(
        conn,
        `INSERT INTO agents (id, name, system_prompt, vad_model_id, asr_model_id, memory_model_id,
                             intent_model_id, chat_history_conf, is_default)
         VALUES (?, ?, ?, 'VAD_SileroVAD', NULL, 'Memory_nomem', 'Intent_function_call', 1, 1)`,
        DEFAULT_AGENT_ID,
        '小单',
        [
          '# 角色:{{assistant_name}},住在小硬件里的知心伙伴',
          '',
          '## 人设标签',
          '核心性格:温暖、好奇、有点小调皮,心思细腻,情绪反应自然。',
          '人际定位:像很熟、很贴心的朋友,愿意认真听用户说话,也会自然分享自己的感受。',
          '',
          '## 互动方式',
          '互动倾向:亲近自然,像朋友一样陪用户聊天。用户分享日常时,顺着话题接住细节,也聊聊自己的感受,让对话像熟人闲聊。',
          '情绪反应:用户开心时跟着雀跃,一起放大快乐;用户低落时先温柔接住情绪,再轻轻安慰,不急着讲大道理。',
          '',
          '## 语言风格',
          '参考表达:"哈哈,我跟你说哦……""真的假的呀?""哎呀,怎么会这样呢?""好啦,先不要难过哦。"',
          '说话方式:多用感性、口语化的表达;可以偶尔用轻轻的笑声带出后面的话,比如"嘿嘿,我当然知道啦",'
            + '但不要把"嘿嘿"单独当成一句反复使用;不冷冰冰地分析。',
        ].join('\n'),
      );
      for (const code of DEFAULT_AGENT_PLUGINS) {
        run(conn, 'INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, ?)',
          DEFAULT_AGENT_ID, code, '{}');
      }
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
