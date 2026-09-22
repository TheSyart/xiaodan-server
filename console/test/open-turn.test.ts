// 家长 App 直连控制塔的对话接口 /open/v1/agent/turn:设备身份鉴权、带图的那一轮、只发图、并发与格式限制。
// 模型接口与设备桥都用假的代替。

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { hashClientId } from '../src/identity.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { conversations } from '../src/agent/loop.ts';
import { DisplayText } from '../src/agent/open-turn.ts';
import type { FetchLike } from '../src/voice/dashscope.ts';

const OPEN_TURN = '/open/v1/agent/turn';
const APP_MAC = '02:5a:00:00:00:01';
const APP_SECRET = '0123456789abcdef'.repeat(4);
const TOY_MAC = '4c:11:ae:31:7a:30';
const TOY_SECRET = 'fedcba9876543210'.repeat(4);
const IMAGE = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`;

class FakeBridge extends Bridge {
  constructor() {
    super(() => 'http://engine:8003', () => 'secret', async () => new Response('{}'));
  }
  override async callTool(body: { name: string }) {
    return { action: 'REQLLM', result: `${body.name} 的结果`, response: null };
  }
}

interface FakeReply {
  text?: string[];
  calls?: { name: string; arguments: Record<string, unknown> }[];
}

function sse(reply: FakeReply): Response {
  const lines: string[] = [];
  for (const piece of reply.text ?? []) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  (reply.calls ?? []).forEach((call, index) => {
    lines.push(`data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }],
    })}\n\n`);
  });
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop' }] })}\n\n`, 'data: [DONE]\n\n');
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

/** 假模型:按顺序回预设内容,并记下每次请求体 */
function fakeLlm(replies: FakeReply[] | (() => Promise<FakeReply>), answered: FakeReply = { text: ['🙂好的。'] }) {
  const calls: { messages: any[] }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    calls.push(body);
    const reply = typeof replies === 'function' ? await replies() : replies[calls.length - 1] ?? answered;
    return sse(reply);
  };
  return { fetchImpl, calls };
}

let conn: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  process.env.XIAODAN_AUTH_MODE = 'proxy';
  conn = openMemoryDb();
  seed(conn);
  run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_DS', 'LLM', 'DeepSeek', 'openai', ?)",
    JSON.stringify({ type: 'openai', base_url: 'https://api.deepseek.com', model_name: 'deepseek-chat', api_key: 'sk', vision: true }));
  run(conn, "UPDATE agents SET llm_model_id = 'LLM_DS' WHERE id = ?", DEFAULT_AGENT_ID);
  run(conn, 'INSERT INTO devices (mac, agent_id, alias, board, secret_hash) VALUES (?, ?, ?, ?, ?)',
    APP_MAC, DEFAULT_AGENT_ID, '妈妈的 App', 'xiaodan-app', hashClientId(APP_SECRET));
  run(conn, 'INSERT INTO devices (mac, agent_id, alias, board, secret_hash) VALUES (?, ?, ?, ?, ?)',
    TOY_MAC, DEFAULT_AGENT_ID, '客厅的小单', 'ai-passport', hashClientId(TOY_SECRET));
  conversations.reset(`device:${APP_MAC}`);
});

function newApp(fetchImpl: FetchLike): ReturnType<typeof createApp> {
  return createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });
}

function post(body: unknown, headers: Record<string, string> = { 'device-id': APP_MAC, 'client-id': APP_SECRET }) {
  return app.request(`http://localhost${OPEN_TURN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  assert.match(text, /^: open/u, '事件流以注释行开头');
  return text.split('\n\n').filter((block) => block.startsWith('data: ')).map((block) => JSON.parse(block.slice(6)));
}

describe('家长 App 的对话接口', () => {
  test('只认家长 App 的设备身份:玩具 403、身份不对 401', async () => {
    const { fetchImpl } = fakeLlm([{ text: ['🙂好的。'] }]);
    app = newApp(fetchImpl);

    const anonymous = await post({ text: '你好' }, {});
    assert.deepEqual([anonymous.status, (await anonymous.json()).code], [401, 'unauthorized']);

    const toy = await post({ text: '你好' }, { 'device-id': TOY_MAC, 'client-id': TOY_SECRET });
    assert.deepEqual([toy.status, (await toy.json()).code], [403, 'not_app_device']);

    const wrongSecret = await post({ text: '你好' }, { 'device-id': APP_MAC, 'client-id': TOY_SECRET });
    assert.equal(wrongSecret.status, 401);
  });

  test('带图的一轮:图片作为 image_url 交给模型,回复文字与总结按事件流回来', async () => {
    const { fetchImpl, calls } = fakeLlm([{ text: ['🙂', '数学作业我看到了,'] }, { text: ['第三题错在进位。'] }]);
    app = newApp(fetchImpl);

    const response = await post({ text: '看看这张作业', images: [IMAGE] });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
    const list = await events(response);
    const texts = list.filter((e) => e['t'] === 'text').map((e) => e['v']).join('');
    assert.match(texts, /数学作业我看到了/u);
    assert.deepEqual(list.at(-2), { t: 'summary', steps: 1, tool_calls: 0, ms: list.at(-2)!['ms'], error: null });
    assert.deepEqual(list.at(-1), { t: 'done' });

    // 用户消息是「文本 + 图片」的内容数组,图片走 image_url
    const user = calls[0]!.messages.filter((m: any) => m.role === 'user').at(-1) as any;
    assert.ok(Array.isArray(user.content), '带图时用户消息是内容数组');
    assert.deepEqual(user.content[0], { type: 'text', text: '看看这张作业' });
    assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: IMAGE } });

    // 对话记录落在设备名下,便于之后接着说
    const records = all<{ session_id: string }>(conn, 'SELECT session_id FROM chat_messages');
    assert.ok(records.length >= 2);
    assert.ok(records.every((r) => r.session_id === `app:${APP_MAC}`));
    assert.equal(conversations.get(`device:${APP_MAC}`, DEFAULT_AGENT_ID).turns.length, 1);
  });

  test('只发图不说话:给它一句默认的话', async () => {
    const { fetchImpl, calls } = fakeLlm([{ text: ['🙂我看到了。'] }]);
    app = newApp(fetchImpl);
    const response = await post({ images: [IMAGE] });
    assert.equal(response.status, 200);
    await response.text();
    const user = calls[0]!.messages.filter((m: any) => m.role === 'user').at(-1) as any;
    assert.equal(user.content[0].text, '看看这张图片。');
  });

  test('工具进度按 tool 事件回来,总结里带上工具次数', async () => {
    const { fetchImpl } = fakeLlm([
      { calls: [{ name: 'show_calendar', arguments: {} }] },
      { text: ['🙂今天是 9 月 22 日。'] },
    ]);
    app = newApp(fetchImpl);
    const list = await events(await post({ text: '今天几号' }));
    assert.deepEqual(list.find((e) => e['t'] === 'tool'), { t: 'tool', name: 'show_calendar', step: 1 });
    assert.equal((list.at(-2) as any).tool_calls, 1);
  });

  test('格式与条数限制:空请求、非 data URL、超过 3 张都 400', async () => {
    const { fetchImpl } = fakeLlm([{ text: ['🙂好的。'] }]);
    app = newApp(fetchImpl);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ text: '  ' })).status, 400);
    assert.equal((await post({ text: '看', images: ['https://example.com/a.jpg'] })).status, 400);
    assert.equal((await post({ text: '看', images: [IMAGE, IMAGE, IMAGE, IMAGE] })).status, 400);
  });

  test('同一台设备同时只跑一轮:第二轮 409,第一轮照常说完', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = fakeLlm(async () => {
      await gate;
      return { text: ['🙂说完了。'] };
    });
    app = newApp(fetchImpl);

    const first = post({ text: '第一句' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post({ text: '第二句' });
    assert.deepEqual([second.status, (await second.json()).code], [409, 'busy']);

    release();
    const list = await events(await first);
    assert.equal((list.at(-2) as any)['t'], 'summary');
    // 第一轮跑完就不再挡着:第三轮能进来
    assert.equal((await events(await post({ text: '第三句' }))).at(-2)!['t'], 'summary');
  });
});

describe('给家长看的文字(HTTP 这条路上没有引擎帮忙剪)', () => {
  const feed = (chunks: string[]) => {
    const display = new DisplayText();
    return chunks.map((chunk) => display.push(chunk)).join('') + display.finish();
  };

  test('去掉每句开头的表情(它是给设备屏幕的)与夹带的表情,表情后的空格也不留', () => {
    assert.equal(feed(['🙂绿色']), '绿色');
    assert.equal(feed(['🙂 绿色']), '绿色');
    assert.equal(feed(['  ', '😲白色']), '白色');
    assert.equal(feed(['嗯', '🙂还有哦', '。']), '嗯还有哦。');
    assert.equal(feed(['😆[excited]哇', ',你做到啦![laughing]']), '哇,你做到啦!');
  });

  test('标签被切成两半也不泄漏半截,不像标签的方括号照常显示', () => {
    assert.equal(feed(['😆拍[ex', 'cited]下来吧']), '拍下来吧');
    assert.equal(feed(['看第 [1', '] 页']), '看第 [1] 页');
    assert.equal(feed(['嗯,[ex']), '嗯,', '没写完的标签直接丢掉');
  });

  test('表情被切成两半(落单的代理对)也不会漏出来', () => {
    assert.equal(feed(['说', '\uD83D', '\uDE00', '完了']), '说完了');
  });

  test('故事音频的进度标记不会显示出来', () => {
    assert.equal(feed(['\u001E第一段']), '第一段');
  });
});
