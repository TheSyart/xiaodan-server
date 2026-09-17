// 讲故事与放音乐的工具。
//
// 有音频的条目:发 media 事件,引擎把文件排进合成队列,跟在已经说出口的引导语后面播;这一轮到此结束
// (再说话会排到整段音频之后)。故事还没有音频时,把正文交给模型,让它自己用语音讲出来。

import { existsSync, readFileSync } from 'node:fs';
import { one, run } from '../../db.ts';
import { CONSOLE_TOOLS } from '../registry.ts';
import { xiaodanVersion, type AgentTool, type MediaCue, type ToolContext, type ToolResult } from '../types.ts';
import { buildCues, cps10, parseTiming, type ChunkTiming } from './cues.ts';
import { mp3DurationMs } from './mp3.ts';
import { audioUrl, extensionOf, itemsOfKind, list, mediaPath, search, type MediaRow } from './store.ts';

export const STORY_PLUGIN = 'stories';
export const MUSIC_PLUGIN = 'music';

function turnUrl(ctx: ToolContext): string {
  return one<{ value: string }>(ctx.deps.conn, "SELECT value FROM settings WHERE key = 'agent.turn_url'")?.value || 'http://console:8002/xiaodan/agent/turn';
}

/** 按 UTF-8 字节截断,不切坏字符 */
export function clipBytes(text: string, bytes: number): string {
  let out = '';
  for (const ch of text.replace(/[\u0000-\u001f]+/gu, ' ').trim()) {
    if (Buffer.byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

/** 故事音频的时长记录;还没测过(老音频、手动上传)时读文件数帧现算整段时长并存起来 */
function storyTiming(ctx: ToolContext, row: MediaRow): ChunkTiming[] {
  const saved = parseTiming(row.timing_json);
  if (saved.length) return saved;
  const path = mediaPath(ctx.deps.dataDir(), row);
  if (extensionOf(row.file) !== 'mp3' || !existsSync(path)) return [];
  const ms = mp3DurationMs(readFileSync(path));
  if (ms <= 0) return [];
  const timing = [{ chars: row.body.replace(/\s/gu, '').length, ms }];
  run(ctx.deps.conn, 'UPDATE media_items SET timing_json = ? WHERE id = ?', JSON.stringify(timing), row.id);
  return timing;
}

/**
 * 故事/音乐卡片(小单协议 3 级):{"cmd":"media","k":"story|music","t":标题,"s":简介,"a":许可·署名,"cps":打字速度,"hold_s":10}。
 * 故事的正文不在这条消息里,由引擎按朗读进度逐条发(cues)。
 */
export function mediaCard(row: MediaRow, timing: readonly ChunkTiming[]): Record<string, unknown> {
  const card: Record<string, unknown> = { type: 'xiaodan', cmd: 'media', k: row.kind, t: clipBytes(row.title, 48), hold_s: 10 };
  const summary = clipBytes(row.summary, 60);
  if (summary) card['s'] = summary;
  if (row.kind === 'music') {
    const credit = clipBytes([row.license, row.attribution].filter(Boolean).join(' · '), 60);
    if (credit) card['a'] = credit;
  } else {
    card['cps'] = cps10(row.body, timing);
  }
  return card;
}

function play(ctx: ToolContext, row: MediaRow): ToolResult {
  let cues: MediaCue[] = [];
  if (xiaodanVersion(ctx.device) >= 3) {
    const timing = row.kind === 'story' ? storyTiming(ctx, row) : [];
    if (row.kind === 'story') cues = buildCues(row.body, timing);
    ctx.sink.device(mediaCard(row, timing));
  }
  ctx.sink.media({
    url: audioUrl(turnUrl(ctx), row), ext: extensionOf(row.file) || 'mp3', title: row.title.slice(0, 20),
    ...(cues.length ? { cues } : {}),
  });
  return { ok: true, endTurn: true, content: `开始播放《${row.title}》。` };
}

const minutes = (seconds: number) => (seconds ? `约 ${Math.max(1, Math.round(seconds / 60))} 分钟` : '');

CONSOLE_TOOLS.set(STORY_PLUGIN, () => {
  const listStories: AgentTool = {
    name: 'list_stories',
    act: 'story',
    label: '故事库',
    description: '查看故事库里有哪些故事,可以按关键词(主题、角色、标签)筛选。用户想听故事但没说哪个时先调用。',
    parameters: { type: 'object', properties: { keyword: { type: 'string', description: '关键词,例如 小熊、睡前、勇气;不传列出全部' } }, required: [] },
    hint: '正在翻故事书',
    async run(ctx, args) {
      const all = itemsOfKind(ctx.deps.conn, 'story');
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'] : '';
      const rows = keyword ? search(all, keyword) : all;
      if (rows.length === 0) return { ok: true, content: keyword ? `故事库里没有和「${keyword}」相关的故事。` : '故事库是空的。' };
      return {
        ok: true,
        content: `故事库(${rows.length} 个):\n${rows.slice(0, 20).map((r) => `- ${r.id}《${r.title}》${r.summary ? `:${r.summary}` : ''}(${[minutes(r.duration_s), list(r.tags_json).join('、')].filter(Boolean).join(',')})`).join('\n')}`,
      };
    },
  };
  const playStory: AgentTool = {
    name: 'play_story',
    act: 'story',
    label: '讲故事',
    description: '播放故事库里的一个故事。开始播放后这一轮就结束了,故事播完设备会自己停下。',
    parameters: {
      type: 'object',
      properties: { story: { type: 'string', description: '故事的 id 或名字,例如 moon-postman 或 月亮上的小邮差' } },
      required: ['story'],
    },
    progress: '好呀,给你讲个故事。',
    hint: '准备讲故事',
    async run(ctx, args) {
      const query = String(args['story'] ?? '');
      const row = search(itemsOfKind(ctx.deps.conn, 'story'), query)[0];
      if (!row) return { ok: false, content: `故事库里没有「${query}」。可以先调用 list_stories 看看有哪些。` };
      if (row.audio_status === 'ready' && row.file) return play(ctx, row);
      return {
        ok: true,
        longAnswer: true,
        content: `《${row.title}》还没有录好的音频。请你直接用温柔、舒缓的语气,把下面的故事完整地讲出来(可以稍作口语化,不要省略情节,不要加标题):\n\n${row.body}`,
      };
    },
  };
  return [listStories, playStory];
});

CONSOLE_TOOLS.set(MUSIC_PLUGIN, () => {
  const listMusic: AgentTool = {
    name: 'list_music',
    act: 'music',
    label: '曲库',
    description: '查看曲库里有哪些音乐,可以按关键词(曲名、作曲家、摇篮曲、钢琴、欢快等)筛选。',
    parameters: { type: 'object', properties: { keyword: { type: 'string', description: '关键词;不传列出全部' } }, required: [] },
    hint: '正在翻曲库',
    async run(ctx, args) {
      const all = itemsOfKind(ctx.deps.conn, 'music');
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'] : '';
      const rows = keyword ? search(all, keyword) : all;
      if (rows.length === 0) return { ok: true, content: keyword ? `曲库里没有和「${keyword}」相关的音乐。` : '曲库是空的。' };
      return {
        ok: true,
        content: `曲库(${rows.length} 首):\n${rows.slice(0, 30).map((r) => `- ${r.id}《${r.title}》${r.summary ? ` ${r.summary}` : ''}(${[minutes(r.duration_s), list(r.tags_json).join('、')].filter(Boolean).join(',')})`).join('\n')}`,
      };
    },
  };
  const playMusic: AgentTool = {
    name: 'play_music',
    act: 'music',
    label: '放音乐',
    description: '播放曲库里的音乐。用户说放首歌、来点音乐、放《小星星》、放点安静的音乐时调用;没指定就挑合适的或传 random。' +
      '曲库只有纯音乐(古典与童谣旋律),没有流行歌曲。调用前先用一句话告诉用户要放什么;开始播放后这一轮不要再说话。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '曲名、别名、作曲家或风格(摇篮曲、钢琴、欢快);随便放一首时填 random' } },
      required: ['query'],
    },
    progress: '好呀,马上放。',
    hint: '准备放音乐',
    async run(ctx, args) {
      const rows = itemsOfKind(ctx.deps.conn, 'music').filter((r) => r.audio_status === 'ready' && r.file);
      if (rows.length === 0) return { ok: false, content: '曲库是空的,告诉用户现在没有音乐可放。' };
      const query = String(args['query'] ?? '').trim();
      const row = !query || query === 'random'
        ? rows[Math.floor(Math.random() * rows.length)]!
        : search(rows, query)[0];
      if (!row) {
        return { ok: false, content: `曲库里没有「${query}」。曲库有:${rows.map((r) => `《${r.title}》`).join('、')}。问问用户要不要听其中一首。` };
      }
      return play(ctx, row);
    },
  };
  return [listMusic, playMusic];
});
