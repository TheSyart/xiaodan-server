// 音色管理接口(挂在 /api/voices 下,沿用管理接口的登录鉴权)。
//
// 音色挂在某个语音合成模型下。千问合成(qwen_audio_tts)支持三种来源:
//   system  百炼自带的音色,可一键导入有名字的那 12 个,也可按 ID 手动加;
//   design  声音设计:一段文字描述生成音色;
//   clone   声音复刻:一段 10-20 秒的录音生成音色,必须勾选已获授权。
// 设计与复刻在百炼侧要审核,状态 pending → ok 后才会被下发给设备;选了未通过的音色,设备回落到模型默认音色。

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { all, one, run } from '../db.ts';
import {
  cloneVoice, DashscopeError, deleteVoice, designVoice, queryVoice, synthesize, targetModel, uploadTemporary,
  type DashscopeConfig, type FetchLike,
} from './dashscope.ts';
import { issueSampleToken, revokeSampleToken, sampleUrl } from './samples.ts';
import { QWEN_AUDIO_TTS_FLASH_VOICES } from './system-voices.ts';

export interface VoiceDeps {
  fetch: FetchLike;
  dataDir: () => string;
}

const QWEN_TTS = 'qwen_audio_tts';
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

interface TtsModel {
  id: string;
  provider: string;
  config: DashscopeConfig & Record<string, unknown>;
}

interface VoiceRow {
  id: string;
  tts_model_id: string;
  name: string;
  voice: string;
  kind: 'system' | 'design' | 'clone';
  status: 'ok' | 'pending' | 'failed';
  sample_file: string;
}

function loadTtsModel(conn: Db, id: string): TtsModel | undefined {
  const row = one<{ id: string; provider: string; config_json: string }>(
    conn, "SELECT id, provider, config_json FROM models WHERE id = ? AND model_type = 'TTS'", id,
  );
  if (!row) return undefined;
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (typeof parsed === 'object' && parsed !== null) config = parsed as Record<string, unknown>;
  } catch {
    /* 坏配置按空处理,后面会报缺密钥 */
  }
  return { id: row.id, provider: row.provider, config };
}

/** 音色表的主键:模型 id + 音色值,换掉不允许的字符。 */
export function voiceKey(modelId: string, voice: string): string {
  return `${modelId}__${voice}`.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 128);
}

function errorResponse(error: unknown): { message: string; status: 400 | 502 } {
  if (error instanceof DashscopeError) return { message: error.message, status: error.status >= 500 ? 502 : 400 };
  return { message: (error as Error).message ?? String(error), status: 502 };
}

/** 至多每 400 毫秒一次合成试听:百炼 qwen-audio-3.0-tts-flash 限 3 RPS,还要给设备对话留余量。 */
let lastPreviewAt = 0;

export function voiceRoutes(conn: Db, deps: VoiceDeps): Hono {
  const app = new Hono({ strict: false });

  const requireQwen = (modelId: string): TtsModel => {
    const model = loadTtsModel(conn, modelId);
    if (!model) throw new DashscopeError('指定的语音合成模型不存在', 400);
    if (model.provider !== QWEN_TTS) throw new DashscopeError('只有千问语音合成模型支持这个操作', 400);
    return model;
  };

  const refreshStatus = async (model: TtsModel, voiceId: string): Promise<{ status: 'ok' | 'pending' | 'failed'; detail: string }> => {
    try {
      const result = await queryVoice(deps.fetch, model.config, voiceId);
      return { status: result.status, detail: result.raw };
    } catch (error) {
      // 刚创建完偶尔查不到,不算失败,稍后在页面上点刷新
      return { status: 'pending', detail: errorResponse(error).message };
    }
  };

  app.get('/', (c) =>
    c.json({
      items: all(
        conn,
        `SELECT id, tts_model_id, name, voice, languages, kind, status, description, tags, prompt,
                status_detail, created_at,
                (SELECT COUNT(*) FROM agents a WHERE a.tts_voice_id = voices.id) AS agent_count
         FROM voices ORDER BY tts_model_id, CASE kind WHEN 'system' THEN 1 ELSE 0 END, sort, created_at DESC, id`,
      ),
    }),
  );

  // 手动添加一个系统音色(任何合成模型都可以)
  app.post('/', async (c) => {
    const parsed = z
      .object({
        id: idSchema,
        tts_model_id: idSchema,
        name: z.string().min(1).max(64),
        voice: z.string().min(1).max(128),
        languages: z.string().max(64).default('中文'),
        description: z.string().max(200).default(''),
        tags: z.string().max(64).default(''),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    if (!loadTtsModel(conn, d.tts_model_id)) return c.json({ error: '指定的 TTS 模型不存在' }, 400);
    const existing = one<{ kind: string }>(conn, 'SELECT kind FROM voices WHERE id = ?', d.id);
    if (existing && existing.kind !== 'system') return c.json({ error: '这个 id 已被设计或复刻的音色占用' }, 409);
    run(
      conn,
      `INSERT INTO voices (id, tts_model_id, name, voice, languages, description, tags, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'system', 'ok', datetime('now'))
       ON CONFLICT (id) DO UPDATE SET tts_model_id = excluded.tts_model_id, name = excluded.name,
         voice = excluded.voice, languages = excluded.languages, description = excluded.description, tags = excluded.tags`,
      d.id, d.tts_model_id, d.name, d.voice, d.languages, d.description, d.tags,
    );
    return c.json({ ok: true });
  });

  // 改显示名、说明、标签。音色值不能改:设计与复刻的音色值是百炼给的。
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    if (!one(conn, 'SELECT 1 FROM voices WHERE id = ?', id)) return c.json({ error: '音色不存在' }, 404);
    const parsed = z
      .object({
        name: z.string().min(1).max(64),
        description: z.string().max(200).default(''),
        tags: z.string().max(64).default(''),
        languages: z.string().max(64).default('中文'),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    run(conn, 'UPDATE voices SET name = ?, description = ?, tags = ?, languages = ? WHERE id = ?',
      d.name, d.description, d.tags, d.languages, id);
    return c.json({ ok: true });
  });

  app.post('/import-system', async (c) => {
    const parsed = z.object({ tts_model_id: idSchema }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '请指定语音合成模型' }, 400);
    let model: TtsModel;
    try {
      model = requireQwen(parsed.data.tts_model_id);
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
    let added = 0;
    QWEN_AUDIO_TTS_FLASH_VOICES.forEach((voice, index) => {
      const id = voiceKey(model.id, voice.voice);
      if (one(conn, 'SELECT 1 FROM voices WHERE id = ? OR (tts_model_id = ? AND voice = ?)', id, model.id, voice.voice)) {
        return;
      }
      run(
        conn,
        `INSERT INTO voices (id, tts_model_id, name, voice, languages, description, tags, kind, status, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'system', 'ok', ?, datetime('now'))`,
        id, model.id, voice.name, voice.voice, voice.languages, voice.description, voice.tags, 100 + index,
      );
      added += 1;
    });
    return c.json({ ok: true, added });
  });

  app.post('/preview', async (c) => {
    const parsed = z
      .object({
        tts_model_id: idSchema,
        voice: z.string().min(1).max(128),
        text: z.string().min(1).max(200).default('你好呀,我是小单,很高兴认识你。'),
        rate: z.number().min(0.5).max(2).optional(),
        pitch: z.number().min(0.5).max(2).optional(),
        volume: z.number().int().min(0).max(100).optional(),
        instruction: z.string().max(100).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const now = Date.now();
    if (now - lastPreviewAt < 400) return c.json({ error: '试听太频繁,请稍后再点' }, 429);
    lastPreviewAt = now;
    try {
      const model = requireQwen(parsed.data.tts_model_id);
      const { audio, mime } = await synthesize(deps.fetch, model.config, parsed.data);
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
        language: z.enum(['zh', 'en']).default('zh'),
        tags: z.string().max(64).default(''),
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
      run(
        conn,
        `INSERT INTO voices (id, tts_model_id, name, voice, languages, description, tags, kind, status, status_detail,
                             prompt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'design', ?, ?, ?, datetime('now'))`,
        id, model.id, d.name, result.voiceId, d.language === 'en' ? '英文' : '中文',
        `声音设计 · ${targetModel(model.config)}`, d.tags, status.status, status.detail, d.prompt,
      );
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
        language: z.enum(['zh', 'en']).default('zh'),
        consent: z.literal('1', { message: '请先确认你有权使用这段声音' }),
        tags: z.string().max(64).default(''),
      })
      .safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.issues[0]?.message ?? '参数不正确' }, 400);
    const q = query.data;
    const mime = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extension = SAMPLE_TYPES[mime];
    if (!extension) return c.json({ error: '样本请用 WAV、MP3 或 M4A 格式' }, 415);
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_SAMPLE_BYTES) return c.json({ error: '样本不能超过 10 MB' }, 413);

    let model: TtsModel;
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
    run(
      conn,
      `INSERT INTO voices (id, tts_model_id, name, voice, languages, description, tags, kind, status, status_detail,
                           sample_file, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'clone', ?, ?, ?, datetime('now'))`,
      id, model.id, q.name, voiceId, q.language === 'en' ? '英文' : '中文',
      `声音复刻 · ${targetModel(model.config)}`, q.tags, status.status, status.detail, fileName,
    );
    return c.json({ ok: true, id, voice: voiceId, status: status.status, via });
  });

  app.post('/:id/refresh', async (c) => {
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '音色不存在' }, 404);
    if (row.kind === 'system') return c.json({ ok: true, status: row.status });
    try {
      const model = requireQwen(row.tts_model_id);
      const result = await queryVoice(deps.fetch, model.config, row.voice);
      run(conn, 'UPDATE voices SET status = ?, status_detail = ? WHERE id = ?', result.status, result.raw, row.id);
      return c.json({ ok: true, status: result.status });
    } catch (error) {
      const { message, status } = errorResponse(error);
      return c.json({ error: message }, status);
    }
  });

  app.delete('/:id', async (c) => {
    const row = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ ok: true });
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
