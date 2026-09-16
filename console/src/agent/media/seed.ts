// 把仓库里的内容素材(media/)装进内容库。每次启动执行,缺了才补,用户改过的不覆盖。
//   media/stories/*.md       原创故事(音频之后由控制塔合成)
//   media/music/catalog.json 许可核实过的曲目,文件复制进数据目录
//   media/vocab/*.json       单词书
// 素材目录:容器里是 /app/media,开发时是仓库根目录的 media/;也可以用 XIAODAN_MEDIA_SEED_DIR 指定。

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../db.ts';
import { one, run, tx } from '../../db.ts';
import { mediaDir } from './store.ts';

const here = dirname(fileURLToPath(import.meta.url));

export function seedDir(): string {
  // console/src/agent/media 与 console/dist/agent/media 往上四层都是仓库根(容器里是 /app)
  return process.env.XIAODAN_MEDIA_SEED_DIR ?? join(here, '..', '..', '..', '..', 'media');
}

interface StoryFront {
  id: string;
  title: string;
  summary: string;
  age: string;
  tags: string[];
  minutes: number;
  voice_instruction: string;
}

export function parseStory(markdown: string): { front: StoryFront; body: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(markdown.replace(/\r\n/gu, '\n'));
  if (!match) return null;
  const front: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = /^([a-z_]+)\s*:\s*(.*)$/u.exec(line.trim());
    if (kv) front[kv[1]!] = kv[2]!.trim();
  }
  const tags = (front['tags'] ?? '').replace(/^\[|\]$/gu, '').split(/[,,]/u).map((t) => t.trim()).filter(Boolean);
  if (!front['id'] || !front['title']) return null;
  return {
    front: {
      id: front['id'], title: front['title'], summary: front['summary'] ?? '', age: front['age'] ?? '', tags,
      minutes: Number(front['minutes']) || 0, voice_instruction: front['voice_instruction'] ?? '',
    },
    body: match[2]!.trim(),
  };
}

export function seedMedia(conn: Db, dataDir: string, dir = seedDir()): { stories: number; music: number; words: number } {
  const counts = { stories: 0, music: 0, words: 0 };
  if (!existsSync(dir) || !one(conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_items'")) return counts;

  const storiesDir = join(dir, 'stories');
  if (existsSync(storiesDir)) {
    for (const name of readdirSync(storiesDir).filter((n) => n.endsWith('.md')).sort()) {
      const parsed = parseStory(readFileSync(join(storiesDir, name), 'utf8'));
      if (!parsed || one(conn, 'SELECT 1 FROM media_items WHERE id = ?', parsed.front.id)) continue;
      run(conn,
        `INSERT INTO media_items (id, kind, title, tags_json, summary, body, voice_instruction, duration_s, age, license, builtin)
         VALUES (?, 'story', ?, ?, ?, ?, ?, ?, ?, '原创(MIT)', 1)`,
        parsed.front.id, parsed.front.title, JSON.stringify(parsed.front.tags), parsed.front.summary, parsed.body,
        parsed.front.voice_instruction, parsed.front.minutes * 60, parsed.front.age);
      counts.stories += 1;
    }
  }

  const catalogPath = join(dir, 'music', 'catalog.json');
  if (existsSync(catalogPath)) {
    const target = join(mediaDir(dataDir), 'music');
    const tracks = JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, unknown>[];
    for (const track of tracks) {
      const id = String(track['id'] ?? '');
      const file = String(track['file'] ?? '');
      if (!id || !file || one(conn, 'SELECT 1 FROM media_items WHERE id = ?', id)) continue;
      const source = join(dir, 'music', file);
      if (!existsSync(source)) continue;
      mkdirSync(target, { recursive: true });
      if (!existsSync(join(target, file))) copyFileSync(source, join(target, file));
      run(conn,
        `INSERT INTO media_items (id, kind, title, aliases_json, tags_json, summary, file, audio_status, duration_s, license, source_url, attribution, builtin)
         VALUES (?, 'music', ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, 1)`,
        id, String(track['title'] ?? id), JSON.stringify(track['aliases'] ?? []), JSON.stringify(track['tags'] ?? []),
        [track['composer'], track['performer']].filter(Boolean).join(' · '), `music/${file}`,
        Number(track['duration_s']) || 0, String(track['license'] ?? ''), String(track['source_url'] ?? ''), String(track['attribution'] ?? ''));
      counts.music += 1;
    }
  }

  const vocabDir = join(dir, 'vocab');
  if (existsSync(vocabDir)) {
    for (const name of readdirSync(vocabDir).filter((n) => n.endsWith('.json')).sort()) {
      const book = JSON.parse(readFileSync(join(vocabDir, name), 'utf8')) as {
        id: string; title: string; description?: string; words: Record<string, unknown>[];
      };
      if (!book.id || one(conn, 'SELECT 1 FROM vocab_books WHERE id = ?', book.id)) continue;
      tx(conn, () => {
        run(conn, 'INSERT INTO vocab_books (id, title, description, builtin) VALUES (?, ?, ?, 1)', book.id, book.title, book.description ?? '');
        book.words.forEach((word, index) => {
          run(conn,
            'INSERT OR IGNORE INTO vocab_words (book_id, word, meaning, example, example_cn, topic, level, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            book.id, String(word['word']), String(word['meaning']), String(word['example'] ?? ''), String(word['example_cn'] ?? ''),
            String(word['topic'] ?? ''), Number(word['level']) || 1, index);
          counts.words += 1;
        });
      });
    }
  }
  return counts;
}
