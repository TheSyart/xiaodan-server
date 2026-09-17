// 学单词的工具。配合内置技能 word-coach 使用:取词 → 教 → 考 → 记对错 → 看进度。
// 屏幕上的单词卡只发给认得它的固件(features.xiaodan ≥ 2);卡片消息限 192 字节,超长的例句不带。
// 3 级固件另有单词卡组(vocab_deck):一次把几个词发到设备,小朋友自己用按键翻看、点确定键听「单词。意思。例句」。

import { CONSOLE_TOOLS } from '../registry.ts';
import { xiaodanVersion, type AgentTool, type ToolContext } from '../types.ts';
import { defaultBook, findWord, markSeen, pickWords, progress, recordAnswer, type WordRow } from './store.ts';

export const VOCAB_PLUGIN = 'vocab';

function learner(ctx: ToolContext): string {
  return ctx.device.mac ?? 'playground';
}

function now(ctx: ToolContext): Date {
  return (ctx.deps.now ?? (() => new Date()))();
}

function clip(text: string, bytes: number): string {
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

/** 单词卡:{"cmd":"word","w":"apple","m":"苹果","e":"I eat an apple."} */
export function wordCard(word: WordRow): Record<string, unknown> {
  const card: Record<string, unknown> = { type: 'xiaodan', cmd: 'word', w: clip(word.word, 24), m: clip(word.meaning, 30), hold_s: 60 };
  if (word.example && Buffer.byteLength(word.example) <= 48) card['e'] = word.example;
  return card;
}

function showCard(ctx: ToolContext, word: WordRow): boolean {
  if (xiaodanVersion(ctx.device) < 2) return false;
  ctx.sink.device(wordCard(word));
  return true;
}

const describe = (word: WordRow) => `${word.word}:${word.meaning}${word.example ? `;例句 ${word.example}${word.example_cn ? `(${word.example_cn})` : ''}` : ''}`;

/**
 * 卡组里的一个词:{"type":"xiaodan_deck","id","i","n","w","m","e","say"}。
 * say 是点「读」时要念的文字,引擎存下后从发给设备的消息里去掉;w/m/e 的字节上限与固件的卡组槽位一致。
 */
export function deckMessage(id: number, index: number, count: number, word: WordRow): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: 'xiaodan_deck', id, i: index, n: count, w: clip(word.word, 31), m: clip(word.meaning, 39),
    say: [word.word, word.meaning, word.example].map((part) => part?.trim()).filter(Boolean).join('。'),
  };
  if (word.example && Buffer.byteLength(word.example) <= 55) message['e'] = word.example;
  return message;
}

CONSOLE_TOOLS.set(VOCAB_PLUGIN, (ctx, params) => {
  const preferredBook = typeof params['book'] === 'string' ? params['book'] : undefined;
  const next: AgentTool = {
    name: 'vocab_next',
    act: 'learn',
    label: '取单词',
    description: '取这一轮要学的英语单词:先复习到期的,再补新词。第一个单词的卡片会显示在屏幕上。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '取几个,默认 5,最多 10' },
        mode: { type: 'string', enum: ['auto', 'new', 'review'], description: 'auto 复习加新词;new 只学新词;review 只复习' },
      },
      required: [],
    },
    hint: '正在准备单词',
    async run(ctx, args) {
      const book = defaultBook(ctx.deps.conn, preferredBook);
      if (!book) return { ok: false, content: '还没有单词书。' };
      const count = Math.min(10, Math.max(1, Number(args['count']) || 5));
      const mode = (['auto', 'new', 'review'] as const).find((m) => m === args['mode']) ?? 'auto';
      const picks = pickWords(ctx.deps.conn, learner(ctx), book, count, mode, now(ctx));
      if (picks.length === 0) return { ok: true, content: mode === 'review' ? '现在没有要复习的单词。' : '这本单词书已经全部学过了,可以复习。' };
      markSeen(ctx.deps.conn, learner(ctx), picks.filter((p) => p.reason === 'new').map((p) => p.word), now(ctx));
      const shown = showCard(ctx, picks[0]!.word);
      return {
        ok: true,
        content: `这一轮的单词(${picks.length} 个)${shown ? ',第一个已经显示在屏幕上' : ''}:\n${picks.map((p, i) =>
          `${i + 1}. ${describe(p.word)}${p.reason === 'review' ? '(复习)' : '(新词)'}`).join('\n')}\n讲到下一个单词时调用 vocab_show 把它显示出来。`,
      };
    },
  };
  const show: AgentTool = {
    name: 'vocab_show',
    act: 'learn',
    label: '显示单词',
    description: '把一个单词的卡片显示在设备屏幕上。教到或考到某个单词时调用。',
    parameters: { type: 'object', properties: { word: { type: 'string', description: '英文单词' } }, required: ['word'] },
    async run(ctx, args) {
      const word = findWord(ctx.deps.conn, defaultBook(ctx.deps.conn, preferredBook), String(args['word'] ?? ''));
      if (!word) return { ok: false, content: '单词书里没有这个词。' };
      return { ok: true, content: showCard(ctx, word) ? `已显示 ${word.word}。` : '这台设备的屏幕显示不了单词卡,直接说就好。' };
    },
  };
  const answer: AgentTool = {
    name: 'vocab_answer',
    act: 'learn',
    label: '记录答题',
    description: '记录小朋友对一个单词的回答是否正确,用来安排复习。每考完一个单词调用一次。',
    parameters: {
      type: 'object',
      properties: { word: { type: 'string', description: '英文单词' }, correct: { type: 'boolean', description: '答对了吗' } },
      required: ['word', 'correct'],
    },
    async run(ctx, args) {
      const word = findWord(ctx.deps.conn, defaultBook(ctx.deps.conn, preferredBook), String(args['word'] ?? ''));
      if (!word) return { ok: false, content: '单词书里没有这个词。' };
      const result = recordAnswer(ctx.deps.conn, learner(ctx), word, args['correct'] === true, now(ctx));
      return { ok: true, content: `已记录。${word.word} 现在在第 ${result.box} 盒${result.box >= 4 ? ',基本掌握了' : ''}。` };
    },
  };
  const stats: AgentTool = {
    name: 'vocab_progress',
    act: 'learn',
    label: '学习进度',
    description: '查看单词学习进度:学过多少、掌握多少、今天要复习几个。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run(ctx) {
      const book = defaultBook(ctx.deps.conn, preferredBook);
      if (!book) return { ok: false, content: '还没有单词书。' };
      const p = progress(ctx.deps.conn, learner(ctx), book, now(ctx));
      return { ok: true, content: `单词书共 ${p.total} 个词;学过 ${p.learned} 个,基本掌握 ${p.mastered} 个,现在该复习 ${p.due} 个;累计答对 ${p.right} 次、答错 ${p.wrong} 次。` };
    },
  };
  const deck: AgentTool = {
    name: 'vocab_deck',
    act: 'learn',
    label: '单词卡',
    description: '把这一轮要学的单词做成卡片显示在设备上,小朋友自己用按键翻看、听读音。' +
      '调用前必须先问小朋友这次想学几个单词(1 到 10 个),听到回答后再调用;小朋友说随便或没想好就用 5。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 10, description: '小朋友说想学几个' },
        mode: { type: 'string', enum: ['auto', 'new', 'review'], description: 'auto 复习加新词;new 只学新词;review 只复习' },
      },
      required: ['count'],
    },
    progress: '好呀,单词卡马上来。',
    hint: '正在准备单词卡',
    async run(toolCtx, args) {
      const book = defaultBook(toolCtx.deps.conn, preferredBook);
      if (!book) return { ok: false, content: '还没有单词书。' };
      const count = Math.min(10, Math.max(1, Math.round(Number(args['count'])) || 5));
      const mode = (['auto', 'new', 'review'] as const).find((m) => m === args['mode']) ?? 'auto';
      const picks = pickWords(toolCtx.deps.conn, learner(toolCtx), book, count, mode, now(toolCtx));
      if (picks.length === 0) return { ok: true, content: mode === 'review' ? '现在没有要复习的单词。' : '这本单词书已经全部学过了,可以复习。' };
      markSeen(toolCtx.deps.conn, learner(toolCtx), picks.filter((p) => p.reason === 'new').map((p) => p.word), now(toolCtx));
      const id = 1 + Math.floor(Math.random() * 65535);
      picks.forEach((pick, index) => toolCtx.sink.device(deckMessage(id, index, picks.length, pick.word)));
      return {
        ok: true,
        content: `单词卡已经显示在设备上(${picks.length} 个):\n${picks.map((p, i) => `${i + 1}. ${describe(p.word)}`).join('\n')}\n` +
          '用一句话告诉小朋友:按上键、下键翻看单词,按一下确定键听读音,长按确定键结束。不要逐个讲解这些词。' +
          '小朋友结束卡片再来说话时,问问要不要做个小测验,考完每个词用 vocab_answer 记录。',
        screen: '单词卡片',
      };
    },
  };
  // 单词卡组只给认得它的固件
  return xiaodanVersion(ctx.device) >= 3 ? [deck, next, show, answer, stats] : [next, show, answer, stats];
});
