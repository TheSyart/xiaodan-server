// 内容库与学单词:素材导入、检索、讲故事与放音乐的工具、引擎取音频、故事音频合成、记忆曲线与单词卡。

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, SECRET_KEY, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { collectTools } from '../src/agent/registry.ts';
import { loadAgent } from '../src/agent/routes.ts';
import { runTurn } from '../src/agent/loop.ts';
import { conversations } from '../src/agent/context.ts';
import { seedMedia, parseStory } from '../src/agent/media/seed.ts';
import { itemsOfKind, search } from '../src/agent/media/store.ts';
import { storyChunks, synthesizeStory } from '../src/agent/media/synth.ts';
import { wordCard } from '../src/agent/vocab/tools.ts';
import { BOX_INTERVALS_MS } from '../src/agent/vocab/srs.ts';
import type { AgentDeps, DeviceContext, ToolContext, TurnSink } from '../src/agent/types.ts';

const SEED_DIR = new URL('../../media', import.meta.url).pathname;
let conn: Db;
let dataDir: string;
const MAC = '4c:11:ae:31:7a:30';

class QuietBridge extends Bridge {
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
}

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
  dataDir = mkdtempSync(join(tmpdir(), 'xiaodan-media-'));
  run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', DEFAULT_AGENT_ID);
  for (const code of ['stories', 'music', 'vocab']) run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, '{}')", DEFAULT_AGENT_ID, code);
});

function ctx(events: { media: unknown[]; device: Record<string, unknown>[] }, features: Record<string, unknown> = { xiaodan: 2 }, fetchImpl?: AgentDeps['fetch']): ToolContext {
  const deps: AgentDeps = { conn, fetch: fetchImpl ?? (async () => new Response('{}')), bridge: new QuietBridge(), dataDir: () => dataDir };
  const device: DeviceContext = { mac: MAC, sessionId: 's', turnId: null, clientIp: null, features };
  const sink: TurnSink = { text() {}, device: (m) => events.device.push(m), media: (m) => events.media.push(m), closeAfterTurn() {} };
  return { deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device, sink, signal: new AbortController().signal, conversationKey: 'c' };
}

describe('素材导入', () => {
  test('仓库里的原创故事、曲库与单词书都装进来,重复执行不重复', () => {
    const first = seedMedia(conn, dataDir, SEED_DIR);
    assert.deepEqual({ stories: first.stories, music: first.music }, { stories: 6, music: 10 });
    assert.equal(first.words, 300);
    const again = seedMedia(conn, dataDir, SEED_DIR);
    assert.deepEqual(again, { stories: 0, music: 0, words: 0 });
    const music = itemsOfKind(conn, 'music');
    assert.ok(music.every((m) => m.audio_status === 'ready' && existsSync(join(dataDir, 'media', m.file))), '曲目文件复制进数据目录');
    const ccby = music.filter((m) => m.license.startsWith('CC BY'));
    assert.ok(ccby.length > 0 && ccby.every((m) => m.attribution.length > 20), 'CC BY 的曲目必须带署名');
    const stories = itemsOfKind(conn, 'story');
    assert.ok(stories.every((s) => s.audio_status === 'none' && s.body.length > 500));
  });

  test('故事 frontmatter 解析', () => {
    const parsed = parseStory(readFileSync(join(SEED_DIR, 'stories', 'moon-postman.md'), 'utf8'))!;
    assert.equal(parsed.front.title, '月亮上的小邮差');
    assert.ok(parsed.front.tags.includes('睡前'));
    assert.ok(parsed.front.voice_instruction.length > 0);
  });

  test('故事正文不含设备字库显示不出的表情与符号', () => {
    // 逐字的 GB2312 校验在素材生成时用 Python 做过(Node 没有 GB2312 编码器);这里守住最容易混进来的几类
    seedMedia(conn, dataDir, SEED_DIR);
    for (const story of itemsOfKind(conn, 'story')) {
      assert.doesNotMatch(story.body, /\p{Extended_Pictographic}|[～~「」]/u, story.id);
    }
  });
});

describe('检索与工具', () => {
  beforeEach(() => {
    seedMedia(conn, dataDir, SEED_DIR);
  });

  test('按名字、别名、标签找', () => {
    const music = itemsOfKind(conn, 'music');
    assert.equal(search(music, '小星星')[0]!.id, 'mozart-twinkle-variations');
    assert.equal(search(music, '一闪一闪亮晶晶')[0]!.id, 'mozart-twinkle-variations');
    assert.equal(search(music, '《摇篮曲》')[0]!.id, 'brahms-lullaby');
    assert.equal(search(music, '不存在的歌').length, 0);
  });

  test('放音乐:发音频事件(控制塔内网地址)并结束本轮', async () => {
    run(conn, "UPDATE settings SET value = 'http://console:8002/xiaodan/agent/turn' WHERE key = 'agent.turn_url'");
    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events);
    const tools = await collectTools(context);
    const result = await tools.find((t) => t.name === 'play_music')!.run(context, { query: '小星星' });
    assert.equal(result.endTurn, true);
    assert.match(events.media[0].url, /^http:\/\/console:8002\/xiaodan\/media\/mozart-twinkle-variations\/audio\?v=/u);
    assert.equal(events.media[0].ext, 'ogg');
    const random = await tools.find((t) => t.name === 'play_music')!.run(context, { query: 'random' });
    assert.equal(random.endTurn, true);
    const missing = await tools.find((t) => t.name === 'play_music')!.run(context, { query: '周杰伦' });
    assert.equal(missing.ok, false);
    assert.match(missing.content, /曲库有/u);
  });

  test('讲故事:没有音频时把正文交给模型讲,有音频时直接播', async () => {
    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events);
    const tools = await collectTools(context);
    const play = tools.find((t) => t.name === 'play_story')!;
    const text = await play.run(context, { story: '小熊' });
    assert.equal(text.longAnswer, true);
    assert.match(text.content, /会数星星的小熊/u);
    run(conn, "UPDATE media_items SET file = 'stories/counting-stars-bear.mp3', audio_status = 'ready' WHERE id = 'counting-stars-bear'");
    const audio = await play.run(context, { story: 'counting-stars-bear' });
    assert.equal(audio.endTurn, true);
    assert.equal(events.media[0].ext, 'mp3');
    const listed = await tools.find((t) => t.name === 'list_stories')!.run(context, { keyword: '科普' });
    assert.match(listed.content, /迷路的小水滴/u);
  });

  test('需要长回答时放宽模型输出上限', async () => {
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_X', 'LLM', 'x', 'openai', ?)",
      JSON.stringify({ base_url: 'https://llm.example/v1', model_name: 'm', max_tokens: 1200 }));
    run(conn, "UPDATE agents SET llm_model_id = 'LLM_X' WHERE id = ?", DEFAULT_AGENT_ID);
    const bodies: any[] = [];
    const fetchImpl = async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const payload = bodies.length === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'play_story', arguments: '{"story":"小熊"}' } }] } }] }
        : { choices: [{ delta: { content: '🙂从前…' } }] };
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const deps: AgentDeps = { conn, fetch: fetchImpl, bridge: new QuietBridge(), dataDir: () => dataDir };
    conversations.reset('long');
    await runTurn(deps, {
      agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: { mac: MAC, sessionId: 's', turnId: null, clientIp: null, features: {} },
      query: '讲小熊的故事', engineMessages: [], conversationKey: 'long', record: null, signal: new AbortController().signal,
      sink: { text() {}, device() {}, media() {}, closeAfterTurn() {} },
    });
    assert.equal(bodies[0].max_tokens, 1200);
    assert.equal(bodies[1].max_tokens, 4096);
  });

  test('引擎取音频要密钥;管理页可以试听', async () => {
    const app = createApp(conn, { admin: { dataDir: () => dataDir }, agent: { bridge: new QuietBridge(), dataDir: () => dataDir, log: () => {} } });
    const secret = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)!.value;
    assert.equal((await app.request('http://localhost/xiaodan/media/brahms-lullaby/audio')).status, 401);
    const ok = await app.request('http://localhost/xiaodan/media/brahms-lullaby/audio', { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'audio/ogg');
    assert.ok((await ok.arrayBuffer()).byteLength > 100_000);
    assert.equal((await app.request('http://localhost/xiaodan/media/moon-postman/audio', { headers: { authorization: `Bearer ${secret}` } })).status, 404, '还没合成');
    const list = await (await app.request('http://localhost/api/media')).json() as { items: { id: string }[]; tts_ready: boolean };
    assert.equal(list.items.length, 16);
    assert.equal(list.tts_ready, false);
  });
});

describe('故事音频合成', () => {
  test('按段落切块,每块不超过上限,拼起来不丢字', () => {
    const body = ['第一段。', '第二段'.repeat(30), '短', '长'.repeat(900) + '。结尾'].join('\n\n');
    const chunks = storyChunks(body, 400);
    assert.ok(chunks.every((c) => c.length <= 400));
    assert.equal(chunks.join('').replace(/\n/gu, ''), body.replace(/\s/gu, ''));
  });

  test('用千问合成逐块生成 mp3 并拼接,记为就绪', async () => {
    seedMedia(conn, dataDir, SEED_DIR);
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Q', 'TTS', 'q', 'qwen_audio_tts', ?)",
      JSON.stringify({ type: 'qwen_audio_tts', api_key: 'sk', workspace_id: 'ws' }));
    const requests: any[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/SpeechSynthesizer')) {
        const body = JSON.parse(String(init.body));
        requests.push(body);
        return new Response(JSON.stringify({ output: { audio: { data: Buffer.from(`MP3-${requests.length}|`).toString('base64') } } }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('no', { status: 404 });
    };
    const deps: AgentDeps = { conn, fetch: fetchImpl, bridge: new QuietBridge(), dataDir: () => dataDir, log: () => {} };
    await synthesizeStory(deps, 'moon-postman');
    const row = one<{ audio_status: string; file: string }>(conn, "SELECT audio_status, file FROM media_items WHERE id = 'moon-postman'")!;
    assert.deepEqual({ ...row }, { audio_status: 'ready', file: 'stories/moon-postman.mp3' });
    const content = readFileSync(join(dataDir, 'media', row.file), 'utf8');
    assert.equal(content, requests.map((_, i) => `MP3-${i + 1}|`).join(''));
    assert.ok(requests.length >= 2);
    assert.equal(requests[0].input.format, 'mp3');
    assert.equal(requests[0].input.voice, 'longanhuan_v3.6');
    assert.match(requests[0].input.instruction, /温柔/u);
  });

  test('讲故事用选定的音色和它的说话设置,故事自带的语气接在后面', async () => {
    seedMedia(conn, dataDir, SEED_DIR);
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Q', 'TTS', 'q', 'qwen_audio_tts', ?)",
      JSON.stringify({ type: 'qwen_audio_tts', api_key: 'sk' }));
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status, dialect, rate, volume, tone_tags)
               VALUES ('v_mom', 'TTS_Q', '妈妈', 'qwen-audio-3.0-tts-flash-mom-001', 'clone', 'ok', '四川话', 0.9, 60, '["soft"]')`);
    const app = createApp(conn, { agent: { bridge: new QuietBridge(), dataDir: () => dataDir, log: () => {} } });
    const put = (voiceId: string) => app.request('http://localhost/api/media/story-voice', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice_id: voiceId }),
    });
    assert.equal((await put('nope')).status, 400);
    assert.equal((await put('v_mom')).status, 200);
    const list = await (await app.request('http://localhost/api/media')).json() as { story_voice: string; story_voice_effective: string };
    assert.deepEqual([list.story_voice, list.story_voice_effective], ['v_mom', 'v_mom']);

    const requests: any[] = [];
    const fetchImpl = async (_url: string, init: RequestInit = {}) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ output: { audio: { data: Buffer.from('MP3|').toString('base64') } } }));
    };
    await synthesizeStory({ conn, fetch: fetchImpl, bridge: new QuietBridge(), dataDir: () => dataDir, log: () => {} }, 'moon-postman');
    const input = requests[0].input;
    assert.deepEqual([input.voice, input.rate, input.volume], ['qwen-audio-3.0-tts-flash-mom-001', 0.9, 60]);
    assert.match(input.instruction, /^请用四川话表达,轻声细语,./u);

    // 选的音色还在审核:退回默认音色,不至于合成失败
    run(conn, "UPDATE voices SET status = 'pending' WHERE id = 'v_mom'");
    const fallback = await (await app.request('http://localhost/api/media')).json() as { story_voice_effective: string };
    assert.equal(fallback.story_voice_effective, 'TTS_Q__longanhuan_v3.6');
  });

  test('没有千问合成模型时报错并记为失败', async () => {
    seedMedia(conn, dataDir, SEED_DIR);
    const deps: AgentDeps = { conn, fetch: async () => new Response('{}'), bridge: new QuietBridge(), dataDir: () => dataDir };
    await assert.rejects(synthesizeStory(deps, 'moon-postman'), /千问语音合成模型/u);
  });
});

describe('学单词', () => {
  beforeEach(() => {
    seedMedia(conn, dataDir, SEED_DIR);
  });

  test('取词、单词卡、答题、复习与进度', async () => {
    let now = new Date('2026-09-17T00:00:00Z');
    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events);
    context.deps.now = () => now;
    const tools = await collectTools(context);
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    const first = await tool('vocab_next').run(context, { count: 3 });
    assert.match(first.content, /1\. cat:猫/u);
    assert.deepEqual(events.device[0], { type: 'xiaodan', cmd: 'word', w: 'cat', m: '猫', hold_s: 60, e: 'My cat likes milk.' });
    assert.equal(all(conn, 'SELECT 1 FROM vocab_progress WHERE learner = ?', MAC).length, 3);

    await tool('vocab_answer').run(context, { word: 'cat', correct: true });
    await tool('vocab_answer').run(context, { word: 'dog', correct: false });
    // 5 分钟后:答错的 dog 与没考的 bird 到期复习,答对的 cat 要明天
    now = new Date(now.getTime() + BOX_INTERVALS_MS[0]! + 1000);
    const review = await tool('vocab_next').run(context, { mode: 'review' });
    assert.match(review.content, /dog/u);
    assert.doesNotMatch(review.content, /cat:猫/u);

    const stats = await tool('vocab_progress').run(context, {});
    assert.match(stats.content, /共 300 个词;学过 3 个/u);

    const shown = await tool('vocab_show').run(context, { word: 'Bird' });
    assert.match(shown.content, /已显示 bird/u);
  });

  test('老固件不发单词卡;卡片不超过设备 192 字节的限制', async () => {
    const events = { media: [] as any[], device: [] as Record<string, unknown>[] };
    const context = ctx(events, { xiaodan: true });
    const tools = await collectTools(context);
    await tools.find((t) => t.name === 'vocab_next')!.run(context, {});
    assert.equal(events.device.length, 0);
    const card = wordCard({ id: 1, book_id: 'b', word: 'extraordinarily-long-word-here', meaning: '一个非常非常非常非常非常长的中文释义', example: 'This example sentence is definitely far too long for the card.', example_cn: '', topic: '', level: 1 });
    assert.ok(Buffer.byteLength(JSON.stringify({ ...card, type: undefined })) <= 192);
    assert.equal(card['e'], undefined);
  });

  test('导入 CSV 单词书', async () => {
    const app = createApp(conn, { agent: { bridge: new QuietBridge(), dataDir: () => dataDir, log: () => {} } });
    const response = await app.request('http://localhost/api/vocab/books', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '水果', text: 'word,meaning\napple,苹果,I like apples.,我喜欢苹果。\nbanana,香蕉\n123,坏行' }),
    });
    const result = await response.json() as { count: number };
    assert.equal(result.count, 2);
  });
});
