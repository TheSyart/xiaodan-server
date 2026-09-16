// 单词书管理接口(挂在 /api/vocab):查看、导入 CSV/JSON、删除、查看各设备进度。

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run, tx } from '../../db.ts';
import type { AgentDeps } from '../types.ts';
import { progress } from './store.ts';

export function vocabRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  app.get('/books', (c) => c.json({
    items: all(conn, `SELECT b.*, (SELECT COUNT(*) FROM vocab_words w WHERE w.book_id = b.id) AS word_count FROM vocab_books b ORDER BY builtin DESC, created_at`),
  }));

  app.get('/books/:id/words', (c) => c.json({
    items: all(conn, 'SELECT id, word, meaning, example, example_cn, topic, level FROM vocab_words WHERE book_id = ? ORDER BY sort, id', c.req.param('id')),
  }));

  /** 导入:{title, description, text} 其中 text 是每行「单词,释义,例句,例句翻译」的 CSV,或 JSON 数组 */
  app.post('/books', async (c) => {
    const parsed = z.object({ title: z.string().min(1).max(64), description: z.string().max(200).default(''), text: z.string().min(1).max(500_000) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    let words: { word: string; meaning: string; example?: string; example_cn?: string; topic?: string; level?: number }[] = [];
    const text = parsed.data.text.trim();
    try {
      if (text.startsWith('[') || text.startsWith('{')) {
        const json = JSON.parse(text) as unknown;
        const list = Array.isArray(json) ? json : (json as { words?: unknown[] }).words ?? [];
        words = (list as Record<string, unknown>[]).map((w) => ({
          word: String(w['word'] ?? ''), meaning: String(w['meaning'] ?? ''), example: String(w['example'] ?? ''),
          example_cn: String(w['example_cn'] ?? ''), topic: String(w['topic'] ?? ''), level: Number(w['level']) || 1,
        }));
      } else {
        words = text.split(/\r?\n/u).map((line) => line.split(/[,\t]/u).map((cell) => cell.trim()))
          .filter((cells) => cells[0] && cells[1] && cells[0].toLowerCase() !== 'word')
          .map((cells) => ({ word: cells[0]!, meaning: cells[1]!, example: cells[2] ?? '', example_cn: cells[3] ?? '' }));
      }
    } catch {
      return c.json({ error: '内容解析失败:请用每行「单词,释义,例句,例句翻译」或 JSON 数组' }, 400);
    }
    words = words.filter((w) => /^[A-Za-z][A-Za-z '\-]{0,31}$/u.test(w.word) && w.meaning);
    if (words.length === 0) return c.json({ error: '没有解析出有效的单词' }, 400);
    const id = `book-${randomBytes(3).toString('hex')}`;
    tx(conn, () => {
      run(conn, 'INSERT INTO vocab_books (id, title, description) VALUES (?, ?, ?)', id, parsed.data.title, parsed.data.description);
      words.forEach((w, i) => run(conn,
        'INSERT OR IGNORE INTO vocab_words (book_id, word, meaning, example, example_cn, topic, level, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, w.word.toLowerCase(), w.meaning.slice(0, 32), (w.example ?? '').slice(0, 80), (w.example_cn ?? '').slice(0, 40), w.topic ?? '', w.level ?? 1, i));
    });
    return c.json({ ok: true, id, count: words.length });
  });

  app.delete('/books/:id', (c) => {
    run(conn, 'DELETE FROM vocab_books WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/progress', (c) => {
    const learners = all<{ learner: string; alias: string | null; book_id: string }>(conn,
      `SELECT DISTINCT p.learner, d.alias, w.book_id FROM vocab_progress p JOIN vocab_words w ON w.id = p.word_id
       LEFT JOIN devices d ON d.mac = p.learner`);
    const now = new Date();
    return c.json({
      items: learners.map((row) => ({
        learner: row.learner, alias: row.alias, book_id: row.book_id,
        book_title: one<{ title: string }>(conn, 'SELECT title FROM vocab_books WHERE id = ?', row.book_id)?.title ?? row.book_id,
        ...progress(conn, row.learner, row.book_id, now),
      })),
    });
  });

  return app;
}
