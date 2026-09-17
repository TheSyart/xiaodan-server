// 给故事合成有声音频。用内容库页选的音色(不选就用默认千问合成模型的默认音色),按段落切块逐块合成(百炼限 3 RPS,串行正好),
// 拼成一个 mp3 存进数据目录。MP3 由一帧帧独立的数据组成,同参数的几段直接首尾相接就是一个能正常解码的文件。
// 有千问合成模型时,后台自动把还没有音频的故事合成一遍;失败的留在「失败」状态,等在内容库页手动重试。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run } from '../../db.ts';
import { synthesize } from '../../voice/dashscope.ts';
import { composeInstruction, readProfile } from '../../voice/profile.ts';
import { resolveVoice, type ResolvedVoice } from '../../voice/store.ts';
import type { AgentDeps } from '../types.ts';
import { mediaById, mediaDir } from './store.ts';

const CHUNK_CHARS = 400;

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

/** 讲故事用的音色与合成模型:内容库页选的音色能用就用,否则默认千问合成模型的默认音色;模型要填了密钥 */
export function storyVoice(deps: Pick<AgentDeps, 'conn'>): ResolvedVoice | null {
  const chosen = one<{ value: string }>(deps.conn, "SELECT value FROM settings WHERE key = 'media.story_voice'")?.value ?? '';
  const resolved = resolveVoice(deps.conn, chosen || null);
  if (!resolved?.voice) return null;
  const key = resolved.model.config['api_key'];
  return typeof key === 'string' && key ? resolved : null;
}

export async function synthesizeStory(deps: AgentDeps, id: string): Promise<void> {
  const story = mediaById(deps.conn, id);
  if (!story || story.kind !== 'story') throw new Error('故事不存在');
  const resolved = storyVoice(deps);
  if (!resolved?.voice) throw new Error('还没有配置带 API Key 的千问语音合成模型');
  const { model, voice } = resolved;
  const profile = readProfile(voice);
  // 故事自带的语气(比如「用温柔舒缓的语气讲故事」)跟在音色自己的方言与语气后面
  const instruction = composeInstruction(profile, story.voice_instruction || '用温柔舒缓的语气讲故事');
  run(deps.conn, "UPDATE media_items SET audio_status = 'pending', audio_error = '' WHERE id = ?", id);
  try {
    const parts: Buffer[] = [];
    for (const chunk of storyChunks(story.body)) {
      const { audio } = await synthesize(deps.fetch, model.config, {
        text: chunk, voice: voice.voice, format: 'mp3', sampleRate: 24000, volume: profile.volume,
        rate: profile.rate === 1 ? 0.95 : profile.rate, pitch: profile.pitch, instruction,
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
  if (busy || !storyVoice(deps)) return 0;
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
