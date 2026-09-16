// 单词书与学习进度。learner 是设备 MAC(网页试聊用 playground)。

import type { Db } from '../../db.ts';
import { all, one, run } from '../../db.ts';
import { dueAfter, nextBox } from './srs.ts';

export interface WordRow {
  id: number;
  book_id: string;
  word: string;
  meaning: string;
  example: string;
  example_cn: string;
  topic: string;
  level: number;
}

export interface Pick {
  word: WordRow;
  reason: 'review' | 'new';
  box: number;
}

export function defaultBook(conn: Db, preferred?: string): string | undefined {
  if (preferred && one(conn, 'SELECT 1 FROM vocab_books WHERE id = ?', preferred)) return preferred;
  return one<{ id: string }>(conn, 'SELECT id FROM vocab_books ORDER BY builtin DESC, created_at LIMIT 1')?.id;
}

/** 先复习到期的,再补新词(按难度、原顺序) */
export function pickWords(conn: Db, learner: string, bookId: string, count: number, mode: 'auto' | 'new' | 'review', now: Date): Pick[] {
  const picks: Pick[] = [];
  if (mode !== 'new') {
    const due = all<WordRow & { box: number }>(conn,
      `SELECT w.*, p.box FROM vocab_progress p JOIN vocab_words w ON w.id = p.word_id
       WHERE p.learner = ? AND w.book_id = ? AND p.due_at <= ? ORDER BY p.due_at LIMIT ?`,
      learner, bookId, now.toISOString(), count);
    for (const row of due) picks.push({ word: row, reason: 'review', box: row.box });
  }
  if (mode !== 'review' && picks.length < count) {
    const fresh = all<WordRow>(conn,
      `SELECT w.* FROM vocab_words w WHERE w.book_id = ?
         AND NOT EXISTS (SELECT 1 FROM vocab_progress p WHERE p.learner = ? AND p.word_id = w.id)
       ORDER BY w.level, w.sort LIMIT ?`,
      bookId, learner, count - picks.length);
    for (const row of fresh) picks.push({ word: row, reason: 'new', box: 0 });
  }
  return picks;
}

/** 新词第一次拿出来学时建一条进度(0 盒,稍后就考) */
export function markSeen(conn: Db, learner: string, words: WordRow[], now: Date): void {
  for (const word of words) {
    run(conn,
      `INSERT INTO vocab_progress (learner, word_id, box, due_at, last_seen_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (learner, word_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      learner, word.id, dueAfter(0, now).toISOString(), now.toISOString());
  }
}

export function findWord(conn: Db, bookId: string | undefined, text: string): WordRow | undefined {
  const word = text.trim().toLowerCase();
  return bookId
    ? one<WordRow>(conn, 'SELECT * FROM vocab_words WHERE book_id = ? AND lower(word) = ?', bookId, word)
    : one<WordRow>(conn, 'SELECT * FROM vocab_words WHERE lower(word) = ? ORDER BY id LIMIT 1', word);
}

export function recordAnswer(conn: Db, learner: string, word: WordRow, correct: boolean, now: Date): { box: number; due: Date } {
  const current = one<{ box: number }>(conn, 'SELECT box FROM vocab_progress WHERE learner = ? AND word_id = ?', learner, word.id);
  const box = nextBox(current?.box ?? 0, correct);
  const due = dueAfter(box, now);
  run(conn,
    `INSERT INTO vocab_progress (learner, word_id, box, due_at, right_count, wrong_count, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (learner, word_id) DO UPDATE SET box = excluded.box, due_at = excluded.due_at,
       right_count = right_count + excluded.right_count, wrong_count = wrong_count + excluded.wrong_count, last_seen_at = excluded.last_seen_at`,
    learner, word.id, box, due.toISOString(), correct ? 1 : 0, correct ? 0 : 1, now.toISOString());
  return { box, due };
}

export function progress(conn: Db, learner: string, bookId: string, now: Date) {
  const total = one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM vocab_words WHERE book_id = ?', bookId)!.n;
  const stats = one<{ learned: number; mastered: number; due: number; right: number; wrong: number }>(conn,
    `SELECT COUNT(*) AS learned, SUM(CASE WHEN p.box >= 4 THEN 1 ELSE 0 END) AS mastered,
            SUM(CASE WHEN p.due_at <= ? THEN 1 ELSE 0 END) AS due,
            COALESCE(SUM(p.right_count), 0) AS right, COALESCE(SUM(p.wrong_count), 0) AS wrong
     FROM vocab_progress p JOIN vocab_words w ON w.id = p.word_id WHERE p.learner = ? AND w.book_id = ?`,
    now.toISOString(), learner, bookId)!;
  return { total, learned: stats.learned ?? 0, mastered: stats.mastered ?? 0, due: stats.due ?? 0, right: stats.right ?? 0, wrong: stats.wrong ?? 0 };
}
