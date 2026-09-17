// 小单协议 3 级:工具提示带活动动画、故事/音乐卡片与正文进度、单词卡组、内置技能升级。

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { collectTools } from '../src/agent/registry.ts';
import { loadAgent } from '../src/agent/routes.ts';
import { hintMessage } from '../src/agent/loop.ts';
import { seedMedia } from '../src/agent/media/seed.ts';
import { buildCues, cps10, displayUnits, splitDisplay, CUE_BYTES, CUE_UNITS } from '../src/agent/media/cues.ts';
import { mp3DurationMs } from '../src/agent/media/mp3.ts';
import { mediaCard } from '../src/agent/media/tools.ts';
import { mediaById } from '../src/agent/media/store.ts';
import { storyChunks } from '../src/agent/media/synth.ts';
import { deckMessage } from '../src/agent/vocab/tools.ts';
import { LEGACY_BUILTIN_SKILLS, seedBuiltinSkills } from '../src/agent/skills/builtin.ts';
import { parseSkillMarkdown } from '../src/agent/skills/parse.ts';
import type { AgentDeps, AgentTool, DeviceContext, ToolContext, TurnSink } from '../src/agent/types.ts';

const SEED_DIR = new URL('../../media', import.meta.url).pathname;
const MAC = '4c:11:ae:31:7a:30';
let conn: Db;
let dataDir: string;

class QuietBridge extends Bridge {
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
}

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
  dataDir = mkdtempSync(join(tmpdir(), 'xiaodan-ux-'));
  run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', DEFAULT_AGENT_ID);
  for (const code of ['stories', 'music', 'vocab']) run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, '{}')", DEFAULT_AGENT_ID, code);
  seedMedia(conn, dataDir, SEED_DIR);
});

function ctx(events: { media: any[]; device: Record<string, unknown>[] }, xiaodan: unknown): ToolContext {
  const deps: AgentDeps = { conn, fetch: async () => new Response('{}'), bridge: new QuietBridge(), dataDir: () => dataDir };
  const device: DeviceContext = { mac: MAC, sessionId: 's', turnId: null, clientIp: null, features: { xiaodan } };
  const sink: TurnSink = { text() {}, device: (m) => events.device.push(m), media: (m) => events.media.push(m), closeAfterTurn() {} };
  return { deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device, sink, signal: new AbortController().signal, conversationKey: 'c' };
}

/** MPEG-2 Layer III、24 kHz、48 kbps 的空帧:每帧 144 字节、576 个采样 = 24 ms */
function fakeMp3(frames: number, id3 = true): Buffer {
  const frame = Buffer.alloc(144);
  frame.set([0xff, 0xf3, 0x64, 0x00]);
  const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...Array(10).fill(0)]);
  return Buffer.concat([...(id3 ? [tag] : []), ...Array.from({ length: frames }, () => frame)]);
}

describe('工具提示带活动动画', () => {
  const tool = { name: 'generate_image', label: '画画', hint: '正在画画', act: 'paint' } as AgentTool;
  const device = (xiaodan: unknown): DeviceContext => ({ mac: MAC, sessionId: 's', turnId: null, clientIp: null, features: { xiaodan } });

  test('3 级固件才带 act,2 级只有文字,老固件用 stt', () => {
    assert.deepEqual(hintMessage(device(3), tool), { type: 'xiaodan', cmd: 'hint', text: '正在画画', act: 'paint' });
    assert.deepEqual(hintMessage(device(2), tool), { type: 'xiaodan', cmd: 'hint', text: '正在画画' });
    assert.deepEqual(hintMessage(device(true), tool), { type: 'stt', text: '% generate_image' });
    assert.deepEqual(hintMessage(device(3), { ...tool, act: undefined }), { type: 'xiaodan', cmd: 'hint', text: '正在画画' });
  });

  test('各类工具都标了对应的活动', async () => {
    for (const code of ['image', 'search', 'reminders', 'memory', 'roles']) {
      run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, '{}') ON CONFLICT DO NOTHING", DEFAULT_AGENT_ID, code);
    }
    const tools = await collectTools(ctx({ media: [], device: [] }, 3));
    const act = (name: string) => tools.find((t) => t.name === name)?.act;
    assert.deepEqual(
      ['generate_image', 'play_story', 'list_stories', 'play_music', 'vocab_deck', 'vocab_answer', 'web_search', 'create_reminder', 'remember', 'switch_role'].map(act),
      ['paint', 'story', 'story', 'music', 'learn', 'learn', 'search', 'remind', 'memory', 'role'],
    );
    // 3 级固件学词只出卡组:单个单词卡片不接管按键,不提供
    assert.ok(!tools.some((t) => t.name === 'vocab_next' || t.name === 'vocab_show'));
  });
});

describe('故事进度', () => {
  test('MP3 时长按帧数算,跳过 ID3 标签与杂字节', () => {
    assert.equal(mp3DurationMs(fakeMp3(125)), 3000);
    assert.equal(mp3DurationMs(Buffer.concat([Buffer.from('junk'), fakeMp3(50, false)])), 1200);
    assert.equal(mp3DurationMs(Buffer.from('not an mp3 at all')), 0);
  });

  test('切片:不超过 40 单位与 150 字节,句末标点优先,拼回原文不丢字', () => {
    const text = '从前有一只小熊,它最喜欢在夜里数星星。一颗、两颗、三颗,数着数着就睡着了,梦里它变成了一颗会发光的小星星,挂在妈妈的窗前。';
    const parts = splitDisplay(text);
    assert.equal(parts.join(''), text);
    assert.equal(parts[0], '从前有一只小熊,它最喜欢在夜里数星星。');
    for (const part of parts) {
      assert.ok(displayUnits(part) <= CUE_UNITS + 1, part);   // 句末标点可以跟在满额的一条后面
      assert.ok(Buffer.byteLength(part) <= CUE_BYTES + 8, part);
      assert.ok(!/^[，。！？、]/u.test(part), part);
    }
    assert.deepEqual(splitDisplay('I like apples and bananas very much, and my sister likes oranges and grapes a lot too.').every((p) => !/^[a-z]/u.test(p) || p.includes(' ')), true);
  });

  test('片段按块的实测时长插值,单调递增,段落开头带 p', () => {
    const body = '第一段第一句话。第一段第二句话。\n\n第二段只有一句话。';
    const chunks = storyChunks(body);
    assert.equal(chunks.length, 1);
    const cues = buildCues(body, [{ chars: chunks[0]!.replace(/\n/gu, '').length, ms: 10_000 }]);
    assert.deepEqual(cues.map((c) => c.x), ['第一段第一句话。第一段第二句话。', '第二段只有一句话。']);
    assert.deepEqual(cues.map((c) => c.p), [true, true]);
    assert.equal(cues[0]!.ms, 0);
    assert.equal(cues[1]!.ms, Math.round((10_000 * 16) / 25));

    // 块数对不上:按整体比例估
    const fallback = buildCues(body, [{ chars: 1, ms: 4000 }, { chars: 1, ms: 1000 }]);
    assert.equal(fallback.length, 2);
    assert.equal(fallback[1]!.ms, Math.round((5000 * 16) / 25));
    assert.deepEqual(buildCues(body, []), []);
    assert.equal(cps10(body, [{ chars: 25, ms: 5000 }]), 50);
    assert.equal(cps10(body, [{ chars: 25, ms: 100 }]), 90, '限制在 9 字/秒以内');
  });

  test('3 级固件播故事:先发故事卡片,音频事件带正文进度;没测过时长时读文件现算并存下', async () => {
    const id = 'counting-stars-bear';
    mkdirSync(join(dataDir, 'media', 'stories'), { recursive: true });
    writeFileSync(join(dataDir, 'media', 'stories', `${id}.mp3`), fakeMp3(5000));
    run(conn, "UPDATE media_items SET file = ?, audio_status = 'ready', timing_json = '' WHERE id = ?", `stories/${id}.mp3`, id);
    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events, 3);
    const tools = await collectTools(context);
    const result = await tools.find((t) => t.name === 'play_story')!.run(context, { story: id });
    assert.equal(result.endTurn, true);
    const card = events.device[0]!;
    assert.equal(card['cmd'], 'media');
    assert.equal(card['k'], 'story');
    assert.equal(card['t'], '会数星星的小熊');
    assert.ok(Number(card['cps']) >= 20 && Number(card['cps']) <= 90);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...card, session_id: 'x'.repeat(32) })) < 1024);
    const cues = events.media[0].cues as { ms: number; x: string }[];
    assert.ok(cues.length > 5);
    assert.ok(cues.every((c, i) => i === 0 || c.ms >= cues[i - 1]!.ms));
    assert.ok(cues[cues.length - 1]!.ms < 120_000 && cues[cues.length - 1]!.ms > 60_000, String(cues[cues.length - 1]!.ms));
    assert.ok(cues.every((c) => Buffer.byteLength(c.x) <= CUE_BYTES + 8 && !/[ -]/u.test(c.x)));
    assert.deepEqual(JSON.parse(mediaById(conn, id)!.timing_json), [{ chars: mediaById(conn, id)!.body.replace(/\s/gu, '').length, ms: 120_000 }]);

    // 2 级固件:照旧只发音频事件
    const old = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const oldCtx = ctx(old, 2);
    await (await collectTools(oldCtx)).find((t) => t.name === 'play_story')!.run(oldCtx, { story: id });
    assert.equal(old.device.length, 0);
    assert.equal(old.media[0].cues, undefined);
  });

  test('音乐卡片带作曲与许可署名,不带正文进度', async () => {
    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events, 3);
    await (await collectTools(context)).find((t) => t.name === 'play_music')!.run(context, { query: '小星星' });
    const card = events.device[0]!;
    assert.equal(card['k'], 'music');
    assert.ok(typeof card['a'] === 'string' && (card['a'] as string).length > 0, JSON.stringify(card));
    assert.equal(card['cps'], undefined);
    assert.equal(events.media[0].cues, undefined);
    const long = mediaCard({ ...mediaById(conn, 'mozart-twinkle-variations')!, title: '长'.repeat(40), summary: '简'.repeat(40) }, []);
    assert.ok(Buffer.byteLength(String(long['t'])) <= 48 && Buffer.byteLength(String(long['s'])) <= 60);
  });
});

describe('单词卡组', () => {
  test('只提供给 3 级固件;count 必填;逐词发卡组消息', async () => {
    const oldTools = await collectTools(ctx({ media: [], device: [] }, 2));
    assert.equal(oldTools.some((t) => t.name === 'vocab_deck'), false);

    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events, 3);
    const tools = await collectTools(context);
    const deck = tools.find((t) => t.name === 'vocab_deck')!;
    assert.deepEqual((deck.parameters as { required: string[] }).required, ['count']);
    assert.doesNotMatch(deck.description, /先问/u, '做法写在技能 word-coach 里,工具说明不重复');
    const result = await deck.run(context, { count: 3 });
    assert.match(result.content, /设备上的操作:按上键、下键翻看单词,按一下确定键听读音,长按确定键结束卡片/u);
    assert.doesNotMatch(result.content, /小测验|逐个讲解/u, '做法只在技能里');
    assert.equal(events.device.length, 3);
    const ids = new Set(events.device.map((m) => m['id']));
    assert.equal(ids.size, 1);
    events.device.forEach((m, i) => {
      assert.equal(m['type'], 'xiaodan_deck');
      assert.equal(m['i'], i);
      assert.equal(m['n'], 3);
      assert.match(String(m['say']), /^\w+。.+/u);
    });
    assert.equal(all(conn, 'SELECT 1 FROM vocab_progress WHERE learner = ?', MAC).length, 3);
  });

  test('卡组消息的字节上限:去掉 say、加上 session_id 后小于 1024', () => {
    const message = deckMessage(65535, 9, 10, {
      id: 1, book_id: 'b', word: 'extraordinarily-long-word-here-and-more', meaning: '一个非常非常非常非常非常长的中文释义还要更长一些',
      example: 'This example sentence is definitely far too long for the card slot.', example_cn: '', topic: '', level: 1,
    });
    assert.ok(Buffer.byteLength(String(message['w'])) <= 31);
    assert.ok(Buffer.byteLength(String(message['m'])) <= 39);
    assert.equal(message['e'], undefined, '超长例句不上屏,但读音里仍有');
    assert.match(String(message['say']), /far too long/u);
    const { say: _say, ...forDevice } = message;
    assert.ok(Buffer.byteLength(JSON.stringify({ ...forDevice, session_id: 'x'.repeat(64) })) < 1024);
  });
});

describe('内置技能升级', () => {
  test('没改过的旧版 word-coach 升级成先问学几个;改过的不动', () => {
    const LEGACY_BODY = parseSkillMarkdown(LEGACY_BUILTIN_SKILLS[0]!).body;
    const current = one<{ body: string }>(conn, "SELECT body FROM skills WHERE name = 'word-coach'")!.body;
    assert.match(current, /想学几个单词/u);

    run(conn, "UPDATE skills SET body = ?, allowed_tools = 'vocab_next, vocab_answer, vocab_progress' WHERE name = 'word-coach'", LEGACY_BODY);
    seedBuiltinSkills(conn);
    const upgraded = one<{ body: string; allowed_tools: string }>(conn, "SELECT body, allowed_tools FROM skills WHERE name = 'word-coach'")!;
    assert.match(upgraded.body, /vocab_deck/u);
    assert.match(upgraded.allowed_tools, /vocab_deck/u);

    run(conn, "UPDATE skills SET body = ? WHERE name = 'word-coach'", `${LEGACY_BODY}\n我自己加的一句。`);
    seedBuiltinSkills(conn);
    assert.match(one<{ body: string }>(conn, "SELECT body FROM skills WHERE name = 'word-coach'")!.body, /我自己加的一句/u);
  });
});
