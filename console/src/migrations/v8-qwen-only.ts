// 迁移 v8:语音全走千问、音色自带说话设置、大脑只剩控制塔、文生图成为模型类型。
//
// 在关闭外键的事务里执行(见 Migration.disableForeignKeys):要重建 models 表改它的 CHECK,
// 开着外键时 DROP TABLE models 会把音色整张删掉。所以这里删行之前都手动处理引用。
//
// 顺序有讲究:
//   1. 插件    要先读意图模型(旧路径下没开工具的智能体,插件本来就没生效,不能因为换大脑而突然生效)
//   2. 对话模型 ollama / gemini 改写成 OpenAI 兼容写法(控制塔大脑只会说 OpenAI 协议)
//   3. 音色加列与回填(官方名、目标模型)
//   4. 语音识别 智能体统一指向千问识别,清掉没人用的旧识别模型
//   5. 语音合成 智能体的合成参数搬到音色上(设置不一致时拆出变体),清掉没人用的旧合成模型
//   6. 重建 models:类型只剩 VAD/ASR/LLM/TTS/Image,视觉、意图、记忆模型随之删除
//   7. 文生图   「工具与服务」里的千问画图服务转成 Image 模型
//   8. 智能体   加 image_model_id,删掉不再使用的列
//   9. 设置     讲故事的音色改存音色 id
//
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。system-voices.ts 是纯数据,可以用。

import type { DatabaseSync } from 'node:sqlite';
import {
  defaultSystemVoice, familyOf, LEGACY_SYSTEM_VOICE_TEXT, systemVoiceDescription, systemVoiceOf, voiceKey,
} from '../voice/system-voices.ts';

type Row = Record<string, unknown>;

const get = <T = Row>(conn: DatabaseSync, sql: string, ...params: unknown[]) =>
  conn.prepare(sql).get(...(params as never[])) as T | undefined;
const list = <T = Row>(conn: DatabaseSync, sql: string, ...params: unknown[]) =>
  conn.prepare(sql).all(...(params as never[])) as T[];
const exec = (conn: DatabaseSync, sql: string, ...params: unknown[]) => {
  conn.prepare(sql).run(...(params as never[]));
};

function config(json: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(json ?? '{}')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** 控制塔大脑认得的插件代号(迁移时的快照) */
const AGENT_PLUGIN_CODES = [
  'show_calendar', 'get_weather', 'set_volume', 'search', 'reminders', 'stories', 'music', 'vocab', 'image', 'memory', 'roles',
];

const QWEN_TTS = 'qwen_audio_tts';
const QWEN_ASR = 'qwen_audio_asr';

export function migrateQwenOnly(conn: DatabaseSync): void {
  migratePlugins(conn);
  migrateLlmProviders(conn);
  addVoiceColumns(conn);
  migrateAsr(conn);
  migrateTts(conn);
  rebuildModels(conn);
  migrateImageServices(conn);
  migrateAgents(conn);
  migrateSettings(conn);
}

// ---------------------------------------------------------------- 1. 插件

function migratePlugins(conn: DatabaseSync): void {
  // 旧路径下意图模型不是函数调用的智能体:勾着的插件从来没下发过,换到控制塔大脑后不该突然生效
  const engineAgents = list<{ id: string; intent_model_id: string | null }>(conn,
    "SELECT id, intent_model_id FROM agents WHERE runtime = 'engine'");
  for (const agent of engineAgents) {
    const intent = agent.intent_model_id
      ? get<{ provider: string }>(conn, 'SELECT provider FROM models WHERE id = ? AND enabled = 1', agent.intent_model_id)
      : undefined;
    if (!intent || intent.provider === 'nointent') exec(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', agent.id);
  }
  const placeholders = AGENT_PLUGIN_CODES.map(() => '?').join(', ');
  exec(conn, `DELETE FROM agent_plugins WHERE plugin_code NOT IN (${placeholders})`, ...AGENT_PLUGIN_CODES);
}

// ---------------------------------------------------------------- 2. 对话模型

function migrateLlmProviders(conn: DatabaseSync): void {
  const rows = list<{ id: string; provider: string; config_json: string }>(conn,
    "SELECT id, provider, config_json FROM models WHERE model_type = 'LLM' AND provider IN ('ollama', 'gemini')");
  for (const row of rows) {
    const old = config(row.config_json);
    const next: Record<string, unknown> = { type: 'openai', model_name: old['model_name'] ?? '' };
    if (row.provider === 'ollama') {
      next['base_url'] = `${(str(old['base_url']) || 'http://localhost:11434').replace(/\/+$/u, '')}/v1`;
      next['api_key'] = 'ollama';
    } else {
      next['base_url'] = 'https://generativelanguage.googleapis.com/v1beta/openai';
      next['api_key'] = old['api_key'] ?? '';
    }
    exec(conn, "UPDATE models SET provider = 'openai', config_json = ?, updated_at = datetime('now') WHERE id = ?",
      JSON.stringify(next), row.id);
  }
}

// ---------------------------------------------------------------- 3. 音色加列

function addVoiceColumns(conn: DatabaseSync): void {
  conn.exec(`
    -- 语种:这个音色用什么语言说话(决定模型用什么语言回复)。languages 是它能说的全部语种
    ALTER TABLE voices ADD COLUMN language TEXT NOT NULL DEFAULT '中文';
    -- 方言:空为普通话;合成时写进语气指令「请用四川话表达」
    ALTER TABLE voices ADD COLUMN dialect TEXT NOT NULL DEFAULT '';
    ALTER TABLE voices ADD COLUMN volume INTEGER NOT NULL DEFAULT 50 CHECK (volume BETWEEN 0 AND 100);
    ALTER TABLE voices ADD COLUMN rate REAL NOT NULL DEFAULT 1 CHECK (rate BETWEEN 0.5 AND 2);
    ALTER TABLE voices ADD COLUMN pitch REAL NOT NULL DEFAULT 1 CHECK (pitch BETWEEN 0.5 AND 2);
    -- 固定语气:["gentle","slow"],与补充说明一起合成语气指令
    ALTER TABLE voices ADD COLUMN tone_tags TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE voices ADD COLUMN tone_text TEXT NOT NULL DEFAULT '';
    -- 允许模型在句子里插的情感标签:["excited","laughing"]
    ALTER TABLE voices ADD COLUMN emotion_tags TEXT NOT NULL DEFAULT '[]';
    -- 复刻与设计的音色只能用于创建时的合成模型;系统音色留空,按模型系列判断
    ALTER TABLE voices ADD COLUMN target_model TEXT NOT NULL DEFAULT '';
    -- 「复制为新音色」得到的变体指回原音色;变体与原音色共用百炼里的同一个音色
    ALTER TABLE voices ADD COLUMN parent_id TEXT;
    ALTER TABLE voices ADD COLUMN gender TEXT NOT NULL DEFAULT '';
    ALTER TABLE voices ADD COLUMN age INTEGER;
    ALTER TABLE voices ADD COLUMN updated_at TEXT;
  `);

  const rows = list<{ id: string; tts_model_id: string; voice: string; name: string; description: string; kind: string; languages: string }>(
    conn, 'SELECT id, tts_model_id, voice, name, description, kind, languages FROM voices');
  for (const row of rows) {
    const languages = (row.languages || '中文').split(/[、,,]/u).map((item) => item.trim()).filter(Boolean)
      .map((item) => (item === '英文' ? '英语' : item));
    exec(conn, 'UPDATE voices SET languages = ?, language = ? WHERE id = ?', languages.join('、') || '中文', languages[0] ?? '中文', row.id);

    if (row.kind === 'system') {
      const system = systemVoiceOf(row.voice);
      if (!system) continue;
      const legacy = LEGACY_SYSTEM_VOICE_TEXT[row.voice];
      const name = legacy && row.name === legacy.name ? system.name : row.name;
      const description = !row.description || (legacy && row.description === legacy.description)
        ? systemVoiceDescription(system) : row.description;
      exec(conn, 'UPDATE voices SET name = ?, description = ?, gender = ?, age = ?, tags = ?, languages = ?, language = ? WHERE id = ?',
        name, description, system.gender, system.age, system.tags, system.languages, system.languages.split('、')[0], row.id);
    } else {
      const model = get<{ config_json: string }>(conn, 'SELECT config_json FROM models WHERE id = ?', row.tts_model_id);
      const target = str(config(model?.config_json)['model_name']) || 'qwen-audio-3.0-tts-flash';
      exec(conn, 'UPDATE voices SET target_model = ? WHERE id = ?', target, row.id);
    }
  }
}

// ---------------------------------------------------------------- 4. 语音识别

function migrateAsr(conn: DatabaseSync): void {
  const qwen = get<{ id: string }>(conn,
    `SELECT id FROM models WHERE model_type = 'ASR' AND provider = ? AND enabled = 1 ORDER BY is_default DESC, id LIMIT 1`, QWEN_ASR);
  if (!qwen) return;   // 还没配千问识别:旧的留着,页面上标「已不支持」
  exec(conn, `UPDATE agents SET asr_model_id = ?
              WHERE asr_model_id IS NULL OR asr_model_id NOT IN (SELECT id FROM models WHERE model_type = 'ASR' AND provider = ?)`,
  qwen.id, QWEN_ASR);
  exec(conn, `DELETE FROM models WHERE model_type = 'ASR' AND provider != ?
              AND id NOT IN (SELECT asr_model_id FROM agents WHERE asr_model_id IS NOT NULL)`, QWEN_ASR);
}

// ---------------------------------------------------------------- 5. 语音合成

interface Settings {
  language: string | null;
  volume: number;
  rate: number;
  pitch: number;
  tone_text: string;
}

function parseAgentSettings(json: unknown, language: unknown): Settings {
  const source = config(json);
  const number = (key: string, low: number, high: number, fallback: number) => {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : fallback;
  };
  const lang = str(language);
  return {
    language: lang ? (lang === '英文' ? '英语' : lang) : null,
    volume: Math.round(number('volume', 0, 100, 50)),
    rate: number('rate', 0.5, 2, 1),
    pitch: number('pitch', 0.5, 2, 1),
    // 旧的语气指令没有长度上限以外的约束,原样当作补充说明;超过 50 字的截断(新页面的上限)
    tone_text: str(source['instruction']).slice(0, 50),
  };
}

const settingsKey = (settings: Settings) => JSON.stringify(settings);

/** 在某个千问合成模型下找到(没有就建)一个系统音色,返回音色 id */
function ensureSystemVoice(conn: DatabaseSync, modelId: string, voice: string): string {
  const existing = get<{ id: string }>(conn, 'SELECT id FROM voices WHERE tts_model_id = ? AND voice = ? ORDER BY parent_id IS NOT NULL, id LIMIT 1', modelId, voice);
  if (existing) return existing.id;
  const system = systemVoiceOf(voice);
  const id = voiceKey(modelId, voice);
  exec(conn,
    `INSERT INTO voices (id, tts_model_id, name, voice, languages, language, description, tags, kind, status, gender, age, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', 'ok', ?, ?, datetime('now'))`,
    id, modelId, system?.name ?? voice, voice, system?.languages ?? '中文', system?.languages.split('、')[0] ?? '中文',
    system ? systemVoiceDescription(system) : '', system?.tags ?? '', system?.gender ?? '', system?.age ?? null);
  return id;
}

function migrateTts(conn: DatabaseSync): void {
  const qwenModels = list<{ id: string; config_json: string }>(conn,
    `SELECT id, config_json FROM models WHERE model_type = 'TTS' AND provider = ? ORDER BY enabled DESC, is_default DESC, id`, QWEN_TTS);
  const qwenIds = new Set(qwenModels.map((model) => model.id));
  const modelVoice = (model: { id: string; config_json: string }) => {
    const cfg = config(model.config_json);
    const family = familyOf(cfg['model_name']);
    const wanted = str(cfg['voice']);
    // 模型上配的默认音色属于另一套(比如 plus 模型配了 flash 的音色)时用这一套的默认音色
    const fits = wanted && (!systemVoiceOf(wanted) || systemVoiceOf(wanted)!.family === family);
    return ensureSystemVoice(conn, model.id, fits ? wanted : defaultSystemVoice(family).voice);
  };

  const agents = list<{ id: string; name: string; is_default: number; tts_model_id: string | null; tts_voice_id: string | null; tts_params_json: string; tts_language: string | null }>(
    conn, 'SELECT id, name, is_default, tts_model_id, tts_voice_id, tts_params_json, tts_language FROM agents ORDER BY is_default DESC, created_at, id');

  // 每个智能体定下音色与设置
  const choices: { agent: (typeof agents)[number]; voiceId: string; settings: Settings }[] = [];
  for (const agent of agents) {
    let voiceId: string | null = null;
    if (agent.tts_voice_id) {
      const voice = get<{ id: string; tts_model_id: string }>(conn, 'SELECT id, tts_model_id FROM voices WHERE id = ?', agent.tts_voice_id);
      if (voice && qwenIds.has(voice.tts_model_id)) voiceId = voice.id;
    }
    if (!voiceId && agent.tts_model_id && qwenIds.has(agent.tts_model_id)) {
      voiceId = modelVoice(qwenModels.find((model) => model.id === agent.tts_model_id)!);
    }
    if (!voiceId && qwenModels.length) voiceId = modelVoice(qwenModels[0]!);
    if (!voiceId) continue;   // 一个千问合成模型都没有:保持原样,等用户配好
    choices.push({ agent, voiceId, settings: parseAgentSettings(agent.tts_params_json, agent.tts_language) });
  }

  // 按音色分组:同一个音色上设置一致就直接写到音色上;不一致时人多的那组留在原音色,其余各拆一个变体
  const byVoice = new Map<string, typeof choices>();
  for (const choice of choices) {
    const group = byVoice.get(choice.voiceId) ?? [];
    group.push(choice);
    byVoice.set(choice.voiceId, group);
  }
  for (const [voiceId, group] of byVoice) {
    const counts = new Map<string, number>();
    for (const choice of group) counts.set(settingsKey(choice.settings), (counts.get(settingsKey(choice.settings)) ?? 0) + 1);
    // 票数相同时默认智能体那组优先(group 已按默认智能体在前排序)
    let mainKey = settingsKey(group[0]!.settings);
    for (const [key, count] of counts) if (count > (counts.get(mainKey) ?? 0)) mainKey = key;

    const original = get<Row>(conn, 'SELECT * FROM voices WHERE id = ?', voiceId)!;
    const variants = new Map<string, string>([[mainKey, voiceId]]);
    let suffix = 2;
    for (const choice of group) {
      const key = settingsKey(choice.settings);
      let target = variants.get(key);
      if (!target) {
        while (get(conn, 'SELECT 1 FROM voices WHERE id = ?', `${voiceId}__${suffix}`.slice(0, 128))) suffix += 1;
        target = `${voiceId}__${suffix}`.slice(0, 128);
        suffix += 1;
        exec(conn,
          `INSERT INTO voices (id, tts_model_id, name, voice, languages, sort, kind, status, description, tags, prompt, sample_file,
                               status_detail, created_at, target_model, parent_id, gender, age)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, datetime('now'), ?, ?, ?, ?)`,
          target, original['tts_model_id'], `${String(original['name'])}(${choice.agent.name})`.slice(0, 64), original['voice'],
          original['languages'], original['sort'] ?? 0, original['kind'], original['status'], original['description'], original['tags'],
          original['prompt'], original['status_detail'], original['target_model'], voiceId, original['gender'], original['age']);
        variants.set(key, target);
      }
      exec(conn, 'UPDATE agents SET tts_voice_id = ? WHERE id = ?', target, choice.agent.id);
    }
    for (const [key, id] of variants) {
      const settings = JSON.parse(key) as Settings;
      const voice = get<{ languages: string }>(conn, 'SELECT languages FROM voices WHERE id = ?', id)!;
      const speakable = voice.languages.split('、');
      const language = settings.language && speakable.includes(settings.language) ? settings.language : speakable[0] ?? '中文';
      exec(conn, `UPDATE voices SET language = ?, volume = ?, rate = ?, pitch = ?, tone_text = ?, updated_at = datetime('now') WHERE id = ?`,
        language, settings.volume, settings.rate, settings.pitch, settings.tone_text, id);
    }
  }

  // 清理旧合成:只在有千问合成模型时做,删之前手动断开引用(外键此时不会替我们处理)
  if (qwenModels.length) {
    const staleVoices = list<{ id: string }>(conn,
      `SELECT id FROM voices WHERE tts_model_id NOT IN (SELECT id FROM models WHERE model_type = 'TTS' AND provider = ?)`, QWEN_TTS);
    for (const voice of staleVoices) {
      exec(conn, 'UPDATE agents SET tts_voice_id = NULL WHERE tts_voice_id = ?', voice.id);
      exec(conn, 'DELETE FROM voices WHERE id = ?', voice.id);
    }
    exec(conn, `DELETE FROM models WHERE model_type = 'TTS' AND provider != ?`, QWEN_TTS);
  }
}

// ---------------------------------------------------------------- 6. 重建 models

function rebuildModels(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE models_new (
      id          TEXT PRIMARY KEY,
      -- VAD 只在引擎内部用;ASR/TTS 千问语音;LLM 对话模型(可标记支持看图);Image 文生图(只在控制塔里用,不下发引擎)
      model_type  TEXT NOT NULL CHECK (model_type IN ('VAD', 'ASR', 'LLM', 'TTS', 'Image')),
      name        TEXT NOT NULL,
      provider    TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      remark      TEXT NOT NULL DEFAULT '',
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO models_new (id, model_type, name, provider, config_json, is_default, enabled, remark, sort, created_at, updated_at)
      SELECT id, model_type, name, provider, config_json, is_default, enabled, remark, sort, created_at, updated_at
      FROM models WHERE model_type IN ('VAD', 'ASR', 'LLM', 'TTS');
    DROP TABLE models;
    ALTER TABLE models_new RENAME TO models;
    -- 与 schema.sql 里的索引同名,让基线里那句 CREATE INDEX IF NOT EXISTS 继续是空操作
    CREATE INDEX idx_models_type ON models (model_type, sort);
  `);
}

// ---------------------------------------------------------------- 7. 文生图

function migrateImageServices(conn: DatabaseSync): void {
  if (!get(conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'service_providers'")) return;
  const rows = list<{ id: string; name: string; provider: string; config_json: string; is_default: number; enabled: number }>(conn,
    "SELECT * FROM service_providers WHERE kind = 'image' ORDER BY is_default DESC, created_at, id");
  let first = true;
  let index = 1;
  for (const row of rows) {
    if (row.provider !== 'qwen-image' && row.provider !== 'dashscope') continue;   // 别家的画图接口不再支持
    const own = config(row.config_json);
    const borrowedFrom = str(own['key_from_model']);
    const borrowed = borrowedFrom
      ? get<{ provider: string; config_json: string }>(conn, 'SELECT provider, config_json FROM models WHERE id = ?', borrowedFrom)
      : undefined;
    const lent = borrowed ? config(borrowed.config_json) : {};
    const next: Record<string, unknown> = { type: 'qwen_image' };
    next['api_key'] = str(own['api_key']) || str(lent['api_key']);
    const workspace = str(own['workspace_id']) || str(lent['workspace_id']);
    if (workspace) next['workspace_id'] = workspace;
    const lentIsQwen = borrowed?.provider === QWEN_ASR || borrowed?.provider === QWEN_TTS;
    const baseUrl = str(own['base_url']) || (lentIsQwen && !workspace ? str(lent['base_url']) : '');
    if (baseUrl) next['base_url'] = baseUrl;
    let model = str(own['model']);
    if (!model || model === 'qwen-image-3.0') model = row.provider === 'dashscope' && !model ? 'z-image-turbo' : 'qwen-image-3.0-pro';
    next['model_name'] = model;
    next['size'] = (str(own['size']) || '1024*1024').replace(/x/giu, '*');
    next['prompt_extend'] = false;

    let id = index === 1 ? 'Image_Qwen' : `Image_Qwen${index}`;
    while (get(conn, 'SELECT 1 FROM models WHERE id = ?', id)) id = `Image_Qwen${++index}`;
    index += 1;
    exec(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
       VALUES (?, 'Image', ?, 'qwen_image', ?, ?, ?)`,
      id, row.name || '千问文生图', JSON.stringify(next), first ? 1 : 0, row.enabled);
    first = false;
  }
  exec(conn, "DELETE FROM service_providers WHERE kind = 'image'");
}

// ---------------------------------------------------------------- 8. 智能体

function migrateAgents(conn: DatabaseSync): void {
  conn.exec(`
    -- 画画工具用哪个文生图模型;空为默认的那个
    ALTER TABLE agents ADD COLUMN image_model_id TEXT REFERENCES models (id) ON DELETE SET NULL;
  `);
  const image = get<{ id: string }>(conn, "SELECT id FROM models WHERE model_type = 'Image' AND enabled = 1 ORDER BY is_default DESC, id LIMIT 1");
  if (image) {
    exec(conn, "UPDATE agents SET image_model_id = ? WHERE id IN (SELECT agent_id FROM agent_plugins WHERE plugin_code = 'image')", image.id);
  }
  // 对话记录只分记与不记:控制塔不存音频
  exec(conn, 'UPDATE agents SET chat_history_conf = 1 WHERE chat_history_conf = 2');
  // 视觉、意图、记忆模型没有了;大脑只有控制塔;合成模型由音色决定;合成参数搬到了音色上
  conn.exec(`
    ALTER TABLE agents DROP COLUMN vllm_model_id;
    ALTER TABLE agents DROP COLUMN memory_model_id;
    ALTER TABLE agents DROP COLUMN intent_model_id;
    ALTER TABLE agents DROP COLUMN runtime;
    ALTER TABLE agents DROP COLUMN tts_params_json;
    ALTER TABLE agents DROP COLUMN tts_language;
    ALTER TABLE agents DROP COLUMN tts_model_id;
  `);
}

// ---------------------------------------------------------------- 9. 设置

function migrateSettings(conn: DatabaseSync): void {
  const storyVoice = get<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'media.story_voice'");
  if (storyVoice) {
    const preferred = get<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'media.story_tts_model'")?.value ?? '';
    const model = get<{ id: string }>(conn, "SELECT id FROM models WHERE id = ? AND model_type = 'TTS' AND provider = ?", preferred, QWEN_TTS)
      ?? get<{ id: string }>(conn, "SELECT id FROM models WHERE model_type = 'TTS' AND provider = ? ORDER BY enabled DESC, is_default DESC, id LIMIT 1", QWEN_TTS);
    let value = '';
    if (model && storyVoice.value) {
      const found = get<{ id: string }>(conn, 'SELECT id FROM voices WHERE tts_model_id = ? AND (voice = ? OR id = ?) ORDER BY parent_id IS NOT NULL, id LIMIT 1',
        model.id, storyVoice.value, storyVoice.value);
      value = found?.id ?? (systemVoiceOf(storyVoice.value) ? ensureSystemVoice(conn, model.id, storyVoice.value) : '');
    }
    exec(conn, "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'media.story_voice'", value);
  }
  exec(conn, "DELETE FROM settings WHERE key = 'media.story_tts_model'");
}
