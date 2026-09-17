// 内容库的读写与检索。

import { join } from 'node:path';
import type { Db } from '../../db.ts';
import { all, one } from '../../db.ts';

export interface MediaRow {
  id: string;
  kind: 'story' | 'music';
  title: string;
  aliases_json: string;
  tags_json: string;
  summary: string;
  body: string;
  voice_instruction: string;
  file: string;
  audio_status: 'none' | 'pending' | 'ready' | 'failed';
  audio_error: string;
  duration_s: number;
  age: string;
  license: string;
  source_url: string;
  attribution: string;
  builtin: number;
  enabled: number;
  updated_at: string;
  /** 故事音频每块的字数与毫秒数(JSON);空串表示还没测过,播放时按整段时长现算 */
  timing_json: string;
}

export function list(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function mediaDir(dataDir: string): string {
  return join(dataDir, 'media');
}

export function mediaPath(dataDir: string, row: Pick<MediaRow, 'file'>): string {
  return join(mediaDir(dataDir), row.file);
}

export function itemsOfKind(conn: Db, kind: 'story' | 'music'): MediaRow[] {
  return all<MediaRow>(conn, 'SELECT * FROM media_items WHERE kind = ? AND enabled = 1 ORDER BY builtin DESC, title', kind);
}

export function mediaById(conn: Db, id: string): MediaRow | undefined {
  return one<MediaRow>(conn, 'SELECT * FROM media_items WHERE id = ?', id);
}

const normalize = (text: string) => text.toLowerCase().replace(/[\s《》「」“”"'.,,。!!??·\-—_()()]/gu, '');

/** 按标题、别名、标签打分找最匹配的条目;都不沾边返回空。 */
export function search(rows: MediaRow[], query: string): MediaRow[] {
  const q = normalize(query);
  if (!q) return rows;
  const scored = rows.map((row) => {
    const names = [row.title, ...list(row.aliases_json)].map(normalize).filter(Boolean);
    const tags = list(row.tags_json).map(normalize);
    let score = 0;
    if (names.includes(q) || row.id === query) score = 100;
    else if (names.some((name) => name.includes(q))) score = 60;
    else if (names.some((name) => q.includes(name) && name.length >= 2)) score = 50;
    else if (tags.some((tag) => tag === q || q.includes(tag))) score = 30;
    else if (normalize(row.summary).includes(q)) score = 20;
    return { row, score };
  });
  return scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.row);
}

/** 音频地址:引擎从控制塔的内网地址下载,带上 updated_at 让重新合成后缓存失效 */
export function audioUrl(turnUrl: string, row: Pick<MediaRow, 'id' | 'updated_at'>): string {
  const origin = new URL(turnUrl).origin;
  return `${origin}/xiaodan/media/${encodeURIComponent(row.id)}/audio?v=${encodeURIComponent(row.updated_at)}`;
}

export function extensionOf(file: string): string {
  const match = /\.([a-z0-9]+)$/iu.exec(file);
  return match ? match[1]!.toLowerCase() : '';
}
