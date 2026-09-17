// 内容库接口。
//   GET  /xiaodan/media/:id/audio    引擎下载音频(manager-api secret 鉴权,内网)
//   /api/media/*                     控制塔页面:列表、编辑、上传、合成、试听

import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run } from '../../db.ts';
import { SECRET_KEY } from '../../seed.ts';
import type { AgentDeps } from '../types.ts';
import { extensionOf, list, mediaById, mediaDir, mediaPath, type MediaRow } from './store.ts';
import { storyVoice, synthesizeMissing, synthesizeStory } from './synth.ts';

const MIME: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4' };
const MAX_UPLOAD = 40 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest();

function sendFile(path: string, ext: string): Response {
  const size = statSync(path).size;
  const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
  return new Response(stream, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'no-store' } });
}

/** 挂在 /xiaodan 下:引擎取音频 */
export function engineMediaRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  app.get('/media/:id/audio', (c) => {
    const secret = one<{ value: string }>(deps.conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)?.value ?? '';
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!secret || !token || !timingSafeEqual(digest(token), digest(secret))) return c.json({ error: 'unauthorized' }, 401);
    const row = mediaById(deps.conn, c.req.param('id'));
    if (!row || !row.file || row.audio_status !== 'ready') return c.json({ error: 'not found' }, 404);
    const path = mediaPath(deps.dataDir(), row);
    if (!existsSync(path)) return c.json({ error: 'file missing' }, 404);
    return sendFile(path, extensionOf(row.file));
  });
  return app;
}

const view = (row: MediaRow) => ({
  ...row, aliases: list(row.aliases_json), tags: list(row.tags_json), aliases_json: undefined, tags_json: undefined,
  body_chars: row.body.replace(/\s/gu, '').length, body: undefined,
});

/** 挂在 /api/media 下 */
export function mediaAdminRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  app.get('/', (c) => c.json({
    items: all<MediaRow>(conn, 'SELECT * FROM media_items ORDER BY kind, builtin DESC, title').map(view),
    tts_ready: storyVoice(deps) !== null,
    story_voice: one<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'media.story_voice'")?.value ?? '',
    /** 实际会用的音色(没选或选的用不了时是默认音色) */
    story_voice_effective: storyVoice(deps)?.voice?.id ?? null,
  }));

  /** 讲故事用哪个音色;空串为默认。换了音色要重新合成才生效 */
  app.put('/story-voice', async (c) => {
    const parsed = z.object({ voice_id: z.string().max(128) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    const id = parsed.data.voice_id;
    if (id && !one(conn, 'SELECT 1 FROM voices WHERE id = ?', id)) return c.json({ error: '音色不存在' }, 400);
    run(conn,
      `INSERT INTO settings (key, value, value_type, label, internal) VALUES ('media.story_voice', ?, 'string', '讲有声故事用的音色', 1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, id);
    return c.json({ ok: true });
  });

  app.get('/:id', (c) => {
    const row = mediaById(conn, c.req.param('id'));
    return row ? c.json({ ...view(row), body: row.body }) : c.json({ error: '不存在' }, 404);
  });

  app.get('/:id/audio', (c) => {
    const row = mediaById(conn, c.req.param('id'));
    if (!row || !row.file) return c.json({ error: '没有音频' }, 404);
    const path = mediaPath(deps.dataDir(), row);
    return existsSync(path) ? sendFile(path, extensionOf(row.file)) : c.json({ error: '音频文件不见了' }, 404);
  });

  app.put('/:id', async (c) => {
    const row = mediaById(conn, c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    const parsed = z.object({
      title: z.string().min(1).max(64),
      aliases: z.array(z.string().max(64)).max(30).default([]),
      tags: z.array(z.string().max(16)).max(10).default([]),
      summary: z.string().max(200).default(''),
      body: z.string().max(20_000).optional(),
      voice_instruction: z.string().max(100).default(''),
      enabled: z.boolean().default(true),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    const bodyChanged = row.kind === 'story' && d.body !== undefined && d.body !== row.body;
    run(conn,
      `UPDATE media_items SET title = ?, aliases_json = ?, tags_json = ?, summary = ?, body = ?, voice_instruction = ?, enabled = ?,
         audio_status = CASE WHEN ? THEN 'none' ELSE audio_status END, updated_at = datetime('now') WHERE id = ?`,
      d.title, JSON.stringify(d.aliases), JSON.stringify(d.tags), d.summary, d.body ?? row.body, d.voice_instruction, d.enabled ? 1 : 0,
      bodyChanged && row.file.startsWith('stories/') ? 1 : 0, row.id);
    return c.json({ ok: true, needs_audio: bodyChanged });
  });

  /** 新建故事(文字) */
  app.post('/stories', async (c) => {
    const parsed = z.object({
      id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/u, 'id 只能用小写字母、数字与连字符'),
      title: z.string().min(1).max(64),
      summary: z.string().max(200).default(''),
      body: z.string().min(20).max(20_000),
      tags: z.array(z.string().max(16)).max(10).default([]),
      voice_instruction: z.string().max(100).default('用温柔、舒缓的语气讲睡前故事,语速稍慢'),
    }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    if (mediaById(conn, d.id)) return c.json({ error: '这个 id 已经存在' }, 409);
    run(conn, "INSERT INTO media_items (id, kind, title, tags_json, summary, body, voice_instruction, license) VALUES (?, 'story', ?, ?, ?, ?, ?, '自建')",
      d.id, d.title, JSON.stringify(d.tags), d.summary, d.body, d.voice_instruction);
    return c.json({ ok: true });
  });

  /** 上传音频(音乐,或替换故事的音频):原始字节 + 查询参数 */
  app.post('/upload', async (c) => {
    const query = z.object({
      id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/u, 'id 只能用小写字母、数字与连字符'),
      kind: z.enum(['story', 'music']),
      title: z.string().min(1).max(64),
      license: z.string().max(64).default(''),
      attribution: z.string().max(500).default(''),
    }).safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.issues[0]?.message ?? '参数不正确' }, 400);
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
    const ext = Object.entries(MIME).find(([, mime]) => mime === type)?.[0] ?? (type === 'audio/mp3' ? 'mp3' : '');
    if (!ext) return c.json({ error: '音频请用 mp3、ogg、wav 或 m4a' }, 415);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD) return c.json({ error: '文件为空或超过 40 MB' }, 413);
    const q = query.data;
    const existing = mediaById(conn, q.id);
    if (existing && existing.kind !== q.kind) return c.json({ error: '这个 id 已被另一类内容占用' }, 409);
    const file = `${q.kind === 'story' ? 'stories' : 'music'}/${q.id}.${ext}`;
    mkdirSync(join(mediaDir(deps.dataDir()), q.kind === 'story' ? 'stories' : 'music'), { recursive: true });
    if (existing?.file && existing.file !== file && existsSync(mediaPath(deps.dataDir(), existing))) unlinkSync(mediaPath(deps.dataDir(), existing));
    writeFileSync(join(mediaDir(deps.dataDir()), file), bytes);
    if (existing) {
      run(conn, "UPDATE media_items SET file = ?, audio_status = 'ready', audio_error = '', timing_json = '', license = CASE WHEN ? = '' THEN license ELSE ? END, attribution = CASE WHEN ? = '' THEN attribution ELSE ? END, updated_at = datetime('now') WHERE id = ?",
        file, q.license, q.license, q.attribution, q.attribution, q.id);
    } else {
      run(conn, "INSERT INTO media_items (id, kind, title, file, audio_status, license, attribution) VALUES (?, ?, ?, ?, 'ready', ?, ?)",
        q.id, q.kind, q.title, file, q.license, q.attribution);
    }
    return c.json({ ok: true, file });
  });

  app.post('/:id/synthesize', async (c) => {
    try {
      await synthesizeStory(deps, c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post('/synthesize-missing', (c) => {
    if (!storyVoice(deps)) return c.json({ error: '还没有配置带 API Key 的千问语音合成模型' }, 400);
    void synthesizeMissing(deps);
    return c.json({ ok: true, started: true });
  });

  app.delete('/:id', (c) => {
    const row = mediaById(conn, c.req.param('id'));
    if (!row) return c.json({ ok: true });
    if (row.file && existsSync(mediaPath(deps.dataDir(), row))) unlinkSync(mediaPath(deps.dataDir(), row));
    run(conn, 'DELETE FROM media_items WHERE id = ?', row.id);
    return c.json({ ok: true });
  });

  return app;
}
