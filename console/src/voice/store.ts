// 音色的数据库读写:系统音色同步、智能体实际用哪个音色与合成模型。
//
// 音色挂在具体的千问合成模型下:百炼的 flash 与 plus 各有一套系统音色,不能混用;
// 复刻与设计出的音色也只能用于创建时的那个合成模型(target_model)。

import type { Db } from '../db.ts';
import { all, one, run } from '../db.ts';
import {
  defaultSystemVoice, familyOf, QWEN_TTS_SYSTEM_VOICES, systemVoiceDescription, systemVoiceOf, voiceKey, type VoiceFamily,
} from './system-voices.ts';

export const QWEN_TTS = 'qwen_audio_tts';
/** 走 OpenAI 兼容网关的同一批模型:音色名与百炼直连完全一致,所以共用音色体系 */
export const GATEWAY_TTS = 'gateway_tts';

/** 这个合成供应商的音色是不是千问那一套(系统音色、flash/plus 分族都按同一套规则) */
export function supportsVoices(provider: unknown): boolean {
  return provider === QWEN_TTS || provider === GATEWAY_TTS;
}

/**
 * 剥掉网关给模型名加的供应商前缀(bailian/qwen-audio-3.0-tts-flash → qwen-audio-3.0-tts-flash)。
 * 百炼返回的 target_model 不带前缀,不剥就会把同一个模型判成两个,复刻出来的音色全部显示为不兼容。
 */
export function bareModel(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  const slash = value.lastIndexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export interface TtsModelRow {
  id: string;
  name: string;
  provider: string;
  config: Record<string, unknown>;
  enabled: number;
  is_default: number;
}

export interface VoiceRow {
  id: string;
  tts_model_id: string;
  name: string;
  voice: string;
  languages: string;
  kind: 'system' | 'design' | 'clone';
  status: 'ok' | 'pending' | 'failed';
  description: string;
  tags: string;
  prompt: string;
  sample_file: string;
  status_detail: string;
  created_at: string | null;
  language: string;
  dialect: string;
  volume: number;
  rate: number;
  pitch: number;
  tone_tags: string;
  tone_text: string;
  emotion_tags: string;
  target_model: string;
  parent_id: string | null;
  gender: string;
  age: number | null;
  updated_at: string | null;
  sort: number;
}

export function parseConfig(json: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(json ?? '{}')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toModel(row: { id: string; name: string; provider: string; config_json: string; enabled: number; is_default: number }): TtsModelRow {
  return { id: row.id, name: row.name, provider: row.provider, config: parseConfig(row.config_json), enabled: row.enabled, is_default: row.is_default };
}

export function loadTtsModel(conn: Db, id: string): TtsModelRow | undefined {
  const row = one<{ id: string; name: string; provider: string; config_json: string; enabled: number; is_default: number }>(
    conn, "SELECT id, name, provider, config_json, enabled, is_default FROM models WHERE id = ? AND model_type = 'TTS'", id);
  return row ? toModel(row) : undefined;
}

/** 启用中的千问合成模型,默认的在前 */
export function qwenTtsModels(conn: Db): TtsModelRow[] {
  return all<{ id: string; name: string; provider: string; config_json: string; enabled: number; is_default: number }>(conn,
    "SELECT id, name, provider, config_json, enabled, is_default FROM models WHERE model_type = 'TTS' AND provider = ? AND enabled = 1 ORDER BY is_default DESC, id",
    QWEN_TTS).map(toModel);
}

export const modelFamily = (model: TtsModelRow): VoiceFamily => familyOf(model.config['model_name']);

/** 兼容性:系统音色要属于模型那一套;复刻与设计的音色要是给这个合成模型建的 */
export function voiceFits(voice: Pick<VoiceRow, 'kind' | 'voice' | 'target_model'>, model: TtsModelRow): boolean {
  const modelName = bareModel(model.config['model_name']) || 'qwen-audio-3.0-tts-flash';
  if (voice.kind !== 'system') return !voice.target_model || bareModel(voice.target_model) === modelName;
  const system = systemVoiceOf(voice.voice);
  if (system) return system.family === familyOf(modelName);
  // 按 ID 加的基础音色名字里带着模型名
  return !voice.voice.startsWith('qwen-audio-') || voice.voice.startsWith(`${modelName}-`);
}

/** 音色表是否已经是 v8 的形状(旧版本的迁移测试会在老库上调 seed) */
export function voicesReady(conn: Db): boolean {
  return !!one(conn, "SELECT 1 FROM pragma_table_info('voices') WHERE name = 'emotion_tags'");
}

/**
 * 给千问合成模型补齐它那一套系统音色。已有的(包括用户改过名字与设置的)不动。
 * 返回新加的条数。modelId 为空时处理全部千问合成模型。
 */
export function syncSystemVoices(conn: Db, modelId?: string): number {
  if (!voicesReady(conn)) return 0;
  const models = all<{ id: string; config_json: string }>(conn,
    `SELECT id, config_json FROM models WHERE model_type = 'TTS' AND provider IN (?, ?)${modelId ? ' AND id = ?' : ''}`,
    ...(modelId ? [QWEN_TTS, GATEWAY_TTS, modelId] : [QWEN_TTS, GATEWAY_TTS]));
  let added = 0;
  for (const model of models) {
    const family = familyOf(parseConfig(model.config_json)['model_name']);
    QWEN_TTS_SYSTEM_VOICES.forEach((voice, index) => {
      if (voice.family !== family) return;
      const id = voiceKey(model.id, voice.voice);
      if (one(conn, 'SELECT 1 FROM voices WHERE id = ? OR (tts_model_id = ? AND voice = ? AND parent_id IS NULL)', id, model.id, voice.voice)) return;
      run(conn,
        `INSERT INTO voices (id, tts_model_id, name, voice, languages, language, description, tags, kind, status, gender, age, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', 'ok', ?, ?, ?, datetime('now'))`,
        id, model.id, voice.name, voice.voice, voice.languages, voice.languages.split('、')[0], systemVoiceDescription(voice), voice.tags,
        voice.gender, voice.age, 100 + index);
      added += 1;
    });
  }
  return added;
}

/** 某个千问合成模型的默认音色(那一套里的第一个系统音色),没有就补上 */
export function defaultVoiceOf(conn: Db, model: TtsModelRow): VoiceRow | undefined {
  const system = defaultSystemVoice(modelFamily(model));
  syncSystemVoices(conn, model.id);
  return one<VoiceRow>(conn, 'SELECT * FROM voices WHERE tts_model_id = ? AND voice = ? AND parent_id IS NULL ORDER BY id LIMIT 1', model.id, system.voice);
}

export interface ResolvedVoice {
  model: TtsModelRow;
  voice?: VoiceRow;
}

/**
 * 智能体实际用的合成模型与音色。选的音色能用(审核通过、模型启用、与模型相符)就用它;
 * 否则退到默认千问合成模型的默认音色,让设备至少有声音。一个千问合成模型都没有时返回 undefined。
 */
export function resolveVoice(conn: Db, voiceId: string | null | undefined): ResolvedVoice | undefined {
  if (voiceId) {
    const voice = one<VoiceRow>(conn, "SELECT * FROM voices WHERE id = ? AND status = 'ok'", voiceId);
    const model = voice ? loadTtsModel(conn, voice.tts_model_id) : undefined;
    if (voice && model && model.enabled === 1 && model.provider === QWEN_TTS && voiceFits(voice, model)) return { model, voice };
  }
  const model = qwenTtsModels(conn)[0];
  if (!model) return undefined;
  return { model, voice: defaultVoiceOf(conn, model) };
}

/** 新建智能体、模板建角色时用的默认音色 id */
export function defaultVoiceId(conn: Db): string | null {
  const model = qwenTtsModels(conn)[0];
  return model ? defaultVoiceOf(conn, model)?.id ?? null : null;
}
