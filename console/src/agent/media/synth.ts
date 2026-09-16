// 给故事合成有声音频。用「模型」页里的千问语音合成模型,按段落切块逐块合成(百炼限 3 RPS,串行正好),
// 拼成一个 mp3 存进数据目录。MP3 由一帧帧独立的数据组成,同参数的几段直接首尾相接就是一个能正常解码的文件。
// 有千问合成模型时,后台自动把还没有音频的故事合成一遍;失败的留在「失败」状态,等在内容库页手动重试。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run } from '../../db.ts';
import { synthesize, type DashscopeConfig } from '../../voice/dashscope.ts';
import type { AgentDeps } from '../types.ts';
import { mediaById, mediaDir } from './store.ts';

const CHUNK_CHARS = 400;
const DEFAULT_VOICE = 'longanhuan_v3.6';

export function storyChunks(body: string, limit = CHUNK_CHARS): string[] {
  const paragraphs = body.split(/\n\s*\n/u).map((p) => p.replace(/\s+/gu, '')).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) chunks.push(current);
      current = '';
      // 超长段落按句号切
      let rest = paragraph;
      while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('!'), window.lastIndexOf('?'), window.lastIndexOf('”'));
        const at = cut > limit / 2 ? cut + 1 : limit;
        chunks.push(rest.slice(0, at));
        rest = rest.slice(at);
      }
      current = rest;
      continue;
    }
    if (current && current.length + paragraph.length + 1 > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 找一个能用的千问合成模型:设置里指定的优先,其次默认的,再其次任意一个 */
export function storyTtsModel(deps: Pick<AgentDeps, 'conn'>): { id: string; config: DashscopeConfig & Record<string, unknown> } | null {
  const preferred = one<{ value: string }>(deps.conn, "SELECT value FROM settings WHERE key = 'media.story_tts_model'")?.value ?? '';
  const rows = all<{ id: string; config_json: string; is_default: number }>(deps.conn,
    "SELECT id, config_json, is_default FROM models WHERE model_type = 'TTS' AND provider = 'qwen_audio_tts' AND enabled = 1 ORDER BY is_default DESC, id");
  const row = rows.find((r) => r.id === preferred) ?? rows[0];
  if (!row) return null;
  const config = JSON.parse(row.config_json) as DashscopeConfig & Record<string, unknown>;
  return typeof config.api_key === 'string' && config.api_key ? { id: row.id, config } : null;
}

export async function synthesizeStory(deps: AgentDeps, id: string): Promise<void> {
  const story = mediaById(deps.conn, id);
  if (!story || story.kind !== 'story') throw new Error('故事不存在');
  const model = storyTtsModel(deps);
  if (!model) throw new Error('还没有配置带 API Key 的千问语音合成模型');
  const voice = one<{ value: string }>(deps.conn, "SELECT value FROM settings WHERE key = 'media.story_voice'")?.value || DEFAULT_VOICE;
  run(deps.conn, "UPDATE media_items SET audio_status = 'pending', audio_error = '' WHERE id = ?", id);
  try {
    const parts: Buffer[] = [];
    for (const chunk of storyChunks(story.body)) {
      const { audio } = await synthesize(deps.fetch, model.config, {
        text: chunk, voice, format: 'mp3', sampleRate: 24000, rate: 0.95, instruction: story.voice_instruction || '用温柔舒缓的语气讲故事',
      });
      parts.push(audio);
    }
    const dir = join(mediaDir(deps.dataDir()), 'stories');
    mkdirSync(dir, { recursive: true });
    const file = `stories/${id}.mp3`;
    writeFileSync(join(mediaDir(deps.dataDir()), file), Buffer.concat(parts));
    // 按每秒约 4 个字估一个时长(mp3 未必带时长信息,这里只作展示)
    const seconds = Math.round(story.body.replace(/\s/gu, '').length / 4);
    run(deps.conn, "UPDATE media_items SET file = ?, audio_status = 'ready', audio_error = '', duration_s = ?, updated_at = datetime('now') WHERE id = ?",
      file, seconds, id);
    deps.log?.(`[media] 故事「${story.title}」音频已生成(${parts.length} 段)`);
  } catch (error) {
    run(deps.conn, "UPDATE media_items SET audio_status = 'failed', audio_error = ? WHERE id = ?", (error as Error).message.slice(0, 300), id);
    throw error;
  }
}

let busy = false;

/** 合成所有还没有音频的故事(一次一个) */
export async function synthesizeMissing(deps: AgentDeps): Promise<number> {
  if (busy || !storyTtsModel(deps)) return 0;
  busy = true;
  let done = 0;
  try {
    const rows = all<{ id: string }>(deps.conn, "SELECT id FROM media_items WHERE kind = 'story' AND enabled = 1 AND audio_status = 'none' ORDER BY builtin DESC, id");
    for (const row of rows) {
      try {
        await synthesizeStory(deps, row.id);
        done += 1;
      } catch (error) {
        deps.log?.(`[media] 故事 ${row.id} 合成失败:${(error as Error).message}`);
      }
    }
  } finally {
    busy = false;
  }
  return done;
}

export function startStorySynthesis(deps: AgentDeps): () => void {
  const kick = () => void synthesizeMissing(deps).catch(() => {});
  const first = setTimeout(kick, 30_000);
  const timer = setInterval(kick, 10 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
