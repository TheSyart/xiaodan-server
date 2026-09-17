// 音色管理接口(挂在 /api/voices 下,沿用管理接口的登录鉴权)。
//
// 音色是智能体「怎么说话」的全部:用百炼里哪个音色(系统音色、声音复刻、声音设计),再加上语种、方言、
// 音量、语速、固定语气与允许的情感标签。智能体只选一个音色。
//
// 音色挂在某个千问合成模型下:
//   system  百炼自带,这一套(flash / plus)的有名音色自动列出;五百多个基础音色可以按 ID 添加;
//   design  声音设计:一段文字描述生成音色;
//   clone   声音复刻:一段 10-20 秒的录音生成音色,必须勾选已获授权。
// 设计与复刻在百炼侧要审核,状态 pending → ok 后才会被下发给设备;选了未通过的音色,设备先用默认音色。
// 「复制为新音色」得到的变体与原音色共用百炼里的同一个音色,只是说话设置不同。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { all, one, run } from '../db.ts';
import {
  cloneVoice, DashscopeError, deleteVoice, designVoice, queryVoice, synthesize, targetModel, uploadTemporary,
  type FetchLike,
} from './dashscope.ts';
import {
  composeInstruction, DEFAULT_PROFILE, filterInlineTags, LANGUAGES, languagesOf, profileColumns, profileSummary, readProfile,
  validateProfile, type VoiceProfile,
} from './profile.ts';
import { issueSampleToken, revokeSampleToken, sampleUrl } from './samples.ts';
import { loadTtsModel, QWEN_TTS, syncSystemVoices, voiceFits, type TtsModelRow, type VoiceRow } from './store.ts';
import { familyOf, voiceKey } from './system-voices.ts';

export { voiceKey };

export interface VoiceDeps {
  fetch: FetchLike;
  dataDir: () => string;
}

const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const MIN_SAMPLE_BYTES = 16_000;
const SAMPLE_TYPES: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
};
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/u, 'id 只能包含字母、数字、点、下划线与连字符');
const languageCodes = LANGUAGES.map((item) => item.code) as [string, ...string[]];
/** 复刻与设计出的音色能说的语种:百炼的复刻支持这些 */
const ALL_LANGUAGES = LANGUAGES.map((item) => item.label).join('、');

const profileSchema = z.object({
  language: z.string().max(16),
  dialect: z.string().max(16).default(''),
  volume: z.number().min(0).max(100),
  rate: z.number().min(0.5).max(2),
  pitch: z.number().min(0.5).max(2).default(1),
  tone_tags: z.array(z.string().max(32)).max(10).default([]),
  tone_text: z.string().max(200).default(''),
  emotion_tags: z.array(z.string().max(32)).max(30).default([]),
});

function errorResponse(error: unknown): { message: string; status: 400 | 502 } {
  if (error instanceof DashscopeError) return { message: error.message, status: error.status >= 500 ? 502 : 400 };
  return { message: (error as Error).message ?? String(error), status: 502 };
}

/** 至多每 400 毫秒一次合成试听:百炼 qwen-audio-3.0-tts 限 3 RPS,还要给设备对话留余量。 */
let lastPreviewAt = 0;

/** 试听文字:语种对应的问候;允许情感标签时带上一个,听得出效果 */
export function previewText(profile: VoiceProfile, name: string): string {
  const language = LANGUAGES.find((item) => item.label === profile.language) ?? LANGUAGES[0]!;
  const base = language.label === '中文' ? `你好呀,我是${name},很高兴认识你,今天过得怎么样?` : language.sample;
  const tag = profile.emotion_tags.find((item) => ['excited', 'curious', 'mischievously'].includes(item)) ?? profile.emotion_tags[0];
  const rich = profile.emotion_tags.find((item) => ['giggles', 'laughing'].includes(item));
  return `${tag ? `[${tag}]` : ''}${base}${rich ? `[${rich}]` : ''}`;
}

export function voiceRoutes(conn: Db, deps: VoiceDeps): Hono {
  const app = new Hono({ strict: false });

  const requireQwen = (modelId: string): TtsModelRow => {
    const model = loadTtsModel(conn, modelId);
    if (!model) throw new DashscopeError('指定的语音合成模型不存在', 400);
    if (model.provider !== QWEN_TTS) throw new DashscopeError('只有千问语音合成模型支持这个操作', 400);
    return model;
  };

  const refreshStatus = async (model: TtsModelRow, voiceId: string): Promise<{ status: 'ok' | 'pending' | 'failed'; detail: string }> => {
    try {
      const result = await queryVoice(deps.fetch, model.config, voiceId);
      return { status: result.status, detail: result.raw };
    } catch (error) {
      // 刚创建完偶尔查不到,不算失败,稍后在页面上点刷新
      return { status: 'pending', detail: errorResponse(error).message };
    }
  };

  const view = (row: VoiceRow & { agent_count: number }, models: Map<string, TtsModelRow>) => {
    const model = models.get(row.tts_model_id);
    const profile = readProfile(row);
    return {
      ...row,
      tone_tags: profile.tone_tags,
      emotion_tags: profile.emotion_tags,
      languages: languagesOf(row.languages),
      model_name: model ? (typeof model.config['model_name'] === 'string' && model.config['model_name']) || 'qwen-audio-3.0-tts-flash' : '',
      model_label: model?.name ?? row.tts_model_id,
      family: model ? familyOf(model.config['model_name']) : 'flash',
      compatible: model ? model.provider === QWEN_TTS && voiceFits(row, model) : false,
      instruction: composeInstruction(profile),
      summary: profileSummary(profile),
      agents: all<{ id: string; name: string }>(conn, 'SELECT id, name FROM agents WHERE tts_voice_id = ? ORDER BY name', row.id),
    };
  };

  app.get('/', (c) => {
    syncSystemVoices(conn);
    const models = new Map<string, TtsModelRow>();
    for (const row of all<{ id: string }>(conn, "SELECT id FROM models WHERE model_type = 'TTS'")) {
      models.set(row.id, loadTtsModel(conn, row.id)!);
    }
    const rows = all<VoiceRow & { agent_count: number }>(conn,
      `SELECT voices.*, (SELECT COUNT(*) FROM agents a WHERE a.tts_voice_id = voices.id) AS agent_count
       FROM voices ORDER BY tts_model_id, CASE kind WHEN 'system' THEN 1 ELSE 0 END, sort, COALESCE(parent_id, id), parent_id IS NOT NULL, created_at DESC, id`);
    return c.json({ items: rows.map((row) => view(row, models)) });
  });

  // 按 ID 添加一个基础音色(百炼那五百多个)
  app.post('/', async (c) => {
    const parsed = z
      .object({
        tts_model_id: idSchema,
        name: z.string().min(1).max(64),
        voice: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/u, '音色 ID 只能包含字母、数字、点、下划线与连字符'),
        description: z.string().max(200).default(''),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    let model: TtsModelRow;
    try {
      model = requireQwen(d.tts_model_id);
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
    const id = voiceKey(model.id, d.voice);
    if (one(conn, 'SELECT 1 FROM voices WHERE id = ?', id)) return c.json({ error: '这个音色已经在列表里了' }, 409);
    run(conn,
      `INSERT INTO voices (id, tts_model_id, name, voice, languages, language, description, tags, kind, status, created_at)
       VALUES (?, ?, ?, ?, '中文、英语', '中文', ?, '', 'system', 'ok', datetime('now'))`,
      id, model.id, d.name, d.voice, d.description);
    return c.json({ ok: true, id });
  });

  // 改名称、说明与说话设置
  app.put('/:id', async (c) => {
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '音色不存在' }, 404);
    const parsed = z
      .object({ name: z.string().min(1).max(64), description: z.string().max(200).default(''), profile: profileSchema })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const profile = readProfile(parsed.data.profile);
    const problem = validateProfile(profile, languagesOf(row.languages));
    if (problem) return c.json({ error: problem }, 400);
    const cols = profileColumns(profile);
    run(conn,
      `UPDATE voices SET name = ?, description = ?, language = ?, dialect = ?, volume = ?, rate = ?, pitch = ?,
                         tone_tags = ?, tone_text = ?, emotion_tags = ?, updated_at = datetime('now')
       WHERE id = ?`,
      parsed.data.name, parsed.data.description, cols['language'], cols['dialect'], cols['volume'], cols['rate'], cols['pitch'],
      cols['tone_tags'], cols['tone_text'], cols['emotion_tags'], row.id);
    return c.json({ ok: true });
  });

  // 复制为新音色:同一个百炼音色,另一套说话设置(可以带上页面里还没保存的设置)
  app.post('/:id/duplicate', async (c) => {
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '音色不存在' }, 404);
    const parsed = z
      .object({ name: z.string().min(1).max(64).optional(), profile: profileSchema.optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const profile = parsed.data.profile ? readProfile(parsed.data.profile) : readProfile(row);
    const problem = validateProfile(profile, languagesOf(row.languages));
    if (problem) return c.json({ error: problem }, 400);
    const root = row.parent_id ?? row.id;
    let n = 2;
    while (one(conn, 'SELECT 1 FROM voices WHERE id = ?', `${root}__${n}`.slice(0, 128))) n += 1;
    const id = `${root}__${n}`.slice(0, 128);
    const cols = profileColumns(profile);
    run(conn,
      `INSERT INTO voices (id, tts_model_id, name, voice, languages, sort, kind, status, description, tags, prompt, sample_file,
                           status_detail, created_at, language, dialect, volume, rate, pitch, tone_tags, tone_text, emotion_tags,
                           target_model, parent_id, gender, age, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      id, row.tts_model_id, parsed.data.name ?? `${row.name}(副本)`.slice(0, 64), row.voice, row.languages, row.sort, row.kind, row.status,
      row.description, row.tags, row.prompt, row.status_detail, cols['language'], cols['dialect'], cols['volume'], cols['rate'],
      cols['pitch'], cols['tone_tags'], cols['tone_text'], cols['emotion_tags'], row.target_model, root, row.gender, row.age);
    return c.json({ ok: true, id });
  });

  // 试听:用已保存的设置,或设置弹窗里还没保存的草稿
  app.post('/preview', async (c) => {
    const parsed = z
      .object({ voice_id: idSchema, text: z.string().min(1).max(300).optional(), draft: profileSchema.optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', parsed.data.voice_id);
    if (!row) return c.json({ error: '音色不存在' }, 404);
    if (row.status !== 'ok') return c.json({ error: '这个音色还没审核通过,暂时不能试听' }, 409);
    const profile = parsed.data.draft ? readProfile(parsed.data.draft) : readProfile(row);
    const problem = validateProfile(profile, languagesOf(row.languages));
    if (problem) return c.json({ error: problem }, 400);
    const now = Date.now();
    if (now - lastPreviewAt < 400) return c.json({ error: '试听太频繁,请稍后再点' }, 429);
    lastPreviewAt = now;
    try {
      const model = requireQwen(row.tts_model_id);
      // 不在允许名单里的情感标签去掉,试听与设备上听到的一致
      const text = filterInlineTags(parsed.data.text ?? previewText(profile, row.name), profile.emotion_tags);
      const instruction = composeInstruction(profile);
      const { audio, mime } = await synthesize(deps.fetch, model.config, {
        text, voice: row.voice, volume: profile.volume, rate: profile.rate, pitch: profile.pitch,
        ...(instruction ? { instruction } : {}),
      });
      return c.body(new Uint8Array(audio), 200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
  });

  app.post('/design', async (c) => {
    const parsed = z
      .object({
        tts_model_id: idSchema,
        name: z.string().min(1).max(64),
        prompt: z.string().min(4).max(500),
        preview_text: z.string().min(15).max(200),
        prefix: z.string().max(32).optional(),
        language: z.enum(languageCodes).default('zh'),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    try {
      const model = requireQwen(d.tts_model_id);
      const result = await designVoice(deps.fetch, model.config, {
        prompt: d.prompt, previewText: d.preview_text, prefix: d.prefix ?? 'design', language: d.language,
      });
      const status = await refreshStatus(model, result.voiceId);
      const id = voiceKey(model.id, result.voiceId);
      const language = LANGUAGES.find((item) => item.code === d.language)?.label ?? DEFAULT_PROFILE.language;
      run(conn,
        `INSERT INTO voices (id, tts_model_id, name, voice, languages, language, description, tags, kind, status, status_detail,
                             prompt, target_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', 'design', ?, ?, ?, ?, datetime('now'))`,
        id, model.id, d.name, result.voiceId, ALL_LANGUAGES, language, '声音设计', status.status, status.detail, d.prompt,
        targetModel(model.config));
      return c.json({
        ok: true, id, voice: result.voiceId, status: status.status,
        preview: result.previewAudio ? result.previewAudio.toString('base64') : null,
      });
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
  });

  // 上传或录制的样本以原始字节提交,元信息放在查询参数里,免得 multipart 解析把 10MB 读进内存两遍。
  app.post('/clone', async (c) => {
    const query = z
      .object({
        tts_model_id: idSchema,
        name: z.string().min(1).max(64),
        prefix: z.string().max(32).optional(),
        language: z.enum(languageCodes).default('zh'),
        consent: z.literal('1', { message: '请先确认你有权使用这段声音' }),
      })
      .safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.issues[0]?.message ?? '参数不正确' }, 400);
    const q = query.data;
    const mime = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extension = SAMPLE_TYPES[mime];
    if (!extension) return c.json({ error: '样本请用 WAV、MP3 或 M4A 格式' }, 415);
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_SAMPLE_BYTES) return c.json({ error: '样本不能超过 10 MB' }, 413);

    let model: TtsModelRow;
    try {
      model = requireQwen(q.tts_model_id);
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length > MAX_SAMPLE_BYTES) return c.json({ error: '样本不能超过 10 MB' }, 413);
    if (bytes.length < MIN_SAMPLE_BYTES) return c.json({ error: '样本太短,请录 10 到 20 秒清晰的说话声' }, 400);

    const dir = join(deps.dataDir(), 'voice-samples');
    mkdirSync(dir, { recursive: true });
    const fileName = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${extension}`;
    const path = join(dir, fileName);
    writeFileSync(path, bytes, { mode: 0o600 });

    const failures: string[] = [];
    let voiceId: string | undefined;
    let via: 'oss' | 'link' | undefined;
    // 1. 百炼临时上传
    try {
      const ossUrl = await uploadTemporary(deps.fetch, model.config, { model: 'voice-enrollment', fileName, bytes, mime });
      voiceId = await cloneVoice(deps.fetch, model.config, { url: ossUrl, prefix: q.prefix ?? 'clone', language: q.language });
      via = 'oss';
    } catch (error) {
      failures.push(`临时上传:${errorResponse(error).message}`);
    }
    // 2. 控制塔的一次性公网链接
    if (!voiceId) {
      const ota = one<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'server.ota'")?.value ?? '';
      const token = issueSampleToken(path, mime);
      const url = sampleUrl(ota, token, extension);
      try {
        if (!url) throw new Error('设置页的 OTA 地址不是 https,百炼访问不到样本');
        voiceId = await cloneVoice(deps.fetch, model.config, { url, prefix: q.prefix ?? 'clone', language: q.language });
        via = 'link';
      } catch (error) {
        failures.push(`公网链接:${errorResponse(error).message}`);
      } finally {
        // 百炼在创建请求里就把样本取走了,链接没有继续留着的必要
        revokeSampleToken(token);
      }
    }
    if (!voiceId) {
      unlinkSync(path);
      return c.json({ error: `复刻失败。${failures.join(';')}` }, 502);
    }
    const status = await refreshStatus(model, voiceId);
    const id = voiceKey(model.id, voiceId);
    const language = LANGUAGES.find((item) => item.code === q.language)?.label ?? DEFAULT_PROFILE.language;
    run(conn,
      `INSERT INTO voices (id, tts_model_id, name, voice, languages, language, description, tags, kind, status, status_detail,
                           sample_file, target_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 'clone', ?, ?, ?, ?, datetime('now'))`,
      id, model.id, q.name, voiceId, ALL_LANGUAGES, language, '声音复刻', status.status, status.detail, fileName, targetModel(model.config));
    return c.json({ ok: true, id, voice: voiceId, status: status.status, via });
  });

  app.post('/:id/refresh', async (c) => {
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '音色不存在' }, 404);
    if (row.kind === 'system') return c.json({ ok: true, status: row.status });
    try {
      const model = requireQwen(row.tts_model_id);
      const result = await queryVoice(deps.fetch, model.config, row.voice);
      // 变体与原音色是百炼里的同一个音色,状态一起更新
      run(conn, 'UPDATE voices SET status = ?, status_detail = ? WHERE tts_model_id = ? AND voice = ?',
        result.status, result.raw, row.tts_model_id, row.voice);
      return c.json({ ok: true, status: result.status });
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
  });

  app.delete('/:id', async (c) => {
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ ok: true });
    const siblings = all<{ id: string }>(conn, 'SELECT id FROM voices WHERE tts_model_id = ? AND voice = ? AND id != ? ORDER BY parent_id IS NOT NULL, id',
      row.tts_model_id, row.voice, row.id);
    if (siblings.length) {
      // 还有变体(或原音色)共用百炼里的这个音色:只删这一条本地设置,云端与样本都留给剩下的
      const heir = siblings[0]!.id;
      run(conn, 'UPDATE voices SET parent_id = ? WHERE parent_id = ? AND id != ?', heir, row.id, heir);
      if (!row.parent_id) run(conn, 'UPDATE voices SET parent_id = NULL WHERE id = ?', heir);
      if (row.sample_file) run(conn, "UPDATE voices SET sample_file = ? WHERE id = ? AND sample_file = ''", row.sample_file, heir);
      run(conn, 'DELETE FROM voices WHERE id = ?', row.id);
      return c.json({ ok: true, local_only: true });
    }
    // 设计与复刻的音色在百炼占配额(每个账号 1000 个),先删云端;删不掉时除非强制,否则不删本地记录
    if (row.kind !== 'system' && c.req.query('local_only') !== '1') {
      try {
        const model = requireQwen(row.tts_model_id);
        await deleteVoice(deps.fetch, model.config, row.voice);
      } catch (error) {
        const { message, status } = errorResponse(error);
        return c.json({ error: `百炼侧删除失败:${message}`, cloud_error: true }, status);
      }
    }
    if (row.sample_file) {
      const path = join(deps.dataDir(), 'voice-samples', row.sample_file);
      if (existsSync(path)) unlinkSync(path);
    }
    run(conn, 'DELETE FROM voices WHERE id = ?', row.id);
    return c.json({ ok: true });
  });

  return app;
}
