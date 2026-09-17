// 智能体运行时:令牌、开头表情、正文里的工具调用、流式解析、多步循环、对话延续,以及引擎调用的对话接口与配置下发。
// 模型接口与设备桥全部用假的代替。

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, SECRET_KEY, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { hashClientId } from '../src/identity.ts';
import { agentToken, verifyAgentToken } from '../src/agent/token.ts';
import { LeadingEmoji, normalizeEmoji } from '../src/agent/emoji.ts';
import { parseCallText, parseDsmlBlock, parseTagBlock, ToolTextFilter } from '../src/agent/tool-text.ts';
import { chatUrl, streamChat } from '../src/agent/llm.ts';
import { conversations, runTurn } from '../src/agent/loop.ts';
import { loadAgent } from '../src/agent/routes.ts';
import { buildSystemPrompt, beijingNow } from '../src/agent/prompt.ts';
import { sanitize } from '../src/agent/context.ts';
import { Bridge } from '../src/agent/bridge.ts';
import type { AgentDeps, DeviceContext, TurnSink } from '../src/agent/types.ts';

// ---------------------------------------------------------------- 假模型

interface FakeReply {
  text?: string[];
  calls?: { name: string; arguments: Record<string, unknown> }[];
}

function sse(reply: FakeReply): Response {
  const lines: string[] = [];
  for (const piece of reply.text ?? []) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  (reply.calls ?? []).forEach((call, index) => {
    const args = JSON.stringify(call.arguments);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] } }] })}\n\n`);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, 3) } }] } }] })}\n\n`);
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(3) } }] } }] })}\n\n`);
  });
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop' }] })}\n\n`, 'data: [DONE]\n\n');
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

interface LlmCall {
  body: { messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[]; thinking?: unknown };
  headers: Record<string, string>;
}

function fakeLlm(replies: FakeReply[] | ((call: LlmCall, index: number) => FakeReply)) {
  const calls: LlmCall[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    assert.match(url, /\/chat\/completions$/u);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call = { body: JSON.parse(String(init.body)), headers };
    calls.push(call);
    const index = calls.length - 1;
    const reply = typeof replies === 'function' ? replies(call, index) : replies[index] ?? { text: ['🙂好的。'] };
    return sse(reply);
  };
  return { fetchImpl, calls };
}

class FakeBridge extends Bridge {
  toolCalls: { name: string; arguments: Record<string, unknown>; session_id: string; plugin_config: Record<string, unknown> }[] = [];
  results: Record<string, { action: string; result: string | null; response: string | null }> = {};
  sent: Record<string, unknown>[] = [];
  constructor() {
    super(() => 'http://engine:8003', () => 'secret', async () => new Response('{}'));
  }
  override async tools() {
    return null;
  }
  override async callTool(body: { session_id: string; turn_id: string | null; name: string; arguments: Record<string, unknown>; plugin_config: Record<string, unknown> }) {
    this.toolCalls.push(body);
    return this.results[body.name] ?? { action: 'REQLLM', result: `${body.name} 的结果`, response: null };
  }
  override async health() {
    return { ok: true, connections: 1 };
  }
  override async send(_mac: string, messages: Record<string, unknown>[]) {
    this.sent.push(...messages);
    return { status: 200, data: {} };
  }
}

// ---------------------------------------------------------------- 纯函数

describe('令牌', () => {
  test('签发与校验,MAC 统一小写冒号', () => {
    const token = agentToken('s3cret', '4C-11-AE-31-7A-30');
    assert.match(token, /^4c:11:ae:31:7a:30\.[A-Za-z0-9_-]{43}$/u);
    assert.equal(verifyAgentToken('s3cret', token), '4c:11:ae:31:7a:30');
    assert.equal(verifyAgentToken('other', token), null);
    assert.equal(verifyAgentToken('s3cret', token.replace('4c:11', '4c:12')), null, '换 MAC 签名就对不上');
    assert.equal(verifyAgentToken('s3cret', 'garbage'), null);
    assert.equal(verifyAgentToken('', token), null);
  });
});

describe('开头表情', () => {
  const feedAll = (leading: LeadingEmoji, parts: string[]) => parts.map((p) => leading.feed(p)).join('') + leading.finish();

  test('第一段:保留表内表情,表外换成相近的,没有就补 🙂', () => {
    assert.equal(feedAll(new LeadingEmoji(true), ['😆哈哈', '好呀']), '😆哈哈好呀');
    assert.equal(feedAll(new LeadingEmoji(true), ['😊', '你好']), '🙂你好');
    assert.equal(feedAll(new LeadingEmoji(true), ['  ', '你好😄呀']), '🙂你好呀', '正文中间的表情去掉');
    const leading = new LeadingEmoji(true);
    feedAll(leading, ['🤔嗯']);
    assert.equal(leading.emotion, 'thinking');
  });

  test('之后几段:开头表情去掉,另报情绪', () => {
    const leading = new LeadingEmoji(false);
    assert.equal(feedAll(leading, ['😍', '太棒了']), '太棒了');
    assert.equal(leading.emotion, 'loving');
    const plain = new LeadingEmoji(false);
    assert.equal(feedAll(plain, ['还有一点']), '还有一点');
    assert.equal(plain.emotion, null);
  });

  test('别名', () => {
    assert.equal(normalizeEmoji('😢'), '😭');
    assert.equal(normalizeEmoji('🐱'), '🙂');
  });

  test('句首的情感标签:写在表情前后都认,表情挪到最前;标签没写完先扣住', () => {
    const tagFirst = new LeadingEmoji(true);
    assert.equal(tagFirst.feed('[exc'), '', '标签没写完');
    assert.equal(tagFirst.feed('ited]'), '', '只有标签,表情可能在下一块');
    assert.equal(tagFirst.feed('😆哇,') + tagFirst.feed('你做到啦!') + tagFirst.finish(), '😆[excited]哇,你做到啦!');
    assert.equal(tagFirst.emotion, 'laughing');
    assert.equal(feedAll(new LeadingEmoji(true), ['😆[laughing]', '哈哈']), '😆[laughing]哈哈');
    const later = new LeadingEmoji(false);
    assert.equal(feedAll(later, ['[sad]😭', '好难过']), '[sad]好难过');
    assert.equal(later.emotion, 'crying');
    assert.equal(feedAll(new LeadingEmoji(true), ['[1] 第一步']), '🙂[1] 第一步', '不是标签的方括号不扣');
  });
});

describe('正文里的工具调用', () => {
  test('解析各种写法', () => {
    assert.deepEqual(parseCallText('{"name":"get_weather","arguments":{"location":"北京"}}'), { name: 'get_weather', arguments: { location: '北京' } });
    assert.deepEqual(parseCallText('get_weather(location="上海")'), { name: 'get_weather', arguments: { location: '上海' } });
    assert.deepEqual(parseTagBlock('<tool_calls><tool_calls><tool_name>show_calendar</tool_name></tool_calls></tool_calls>'), [{ name: 'show_calendar', arguments: {} }]);
    assert.deepEqual(parseTagBlock('<tool_call>get_weather</tool_call>'), [{ name: 'get_weather', arguments: {} }]);
    assert.deepEqual(
      parseDsmlBlock('<｜DSML｜function_calls><｜DSML｜invoke name="set_volume"><｜DSML｜parameter name="level" string="false">30</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>'),
      [{ name: 'set_volume', arguments: { level: 30 } }],
    );
  });

  test('流式:块被截下来,前后文字照常放行,残段先扣住', () => {
    const filter = new ToolTextFilter(['get_weather']);
    const chunks = ['🙂好的<', 'tool_c', 'all>{"name":"get_weather","argu', 'ments":{"location":"北京"}}</tool_', 'call>后面'];
    let text = '';
    const calls = [];
    for (const chunk of chunks) {
      const out = filter.feed(chunk);
      text += out.text;
      calls.push(...out.calls);
    }
    const last = filter.finish();
    text += last.text;
    calls.push(...last.calls);
    assert.equal(text, '🙂好的后面');
    assert.deepEqual(calls, [{ name: 'get_weather', arguments: { location: '北京' } }]);
  });

  test('DSML 流式,且不放行本轮没有提供的工具', () => {
    const warnings: string[] = [];
    const filter = new ToolTextFilter(['get_weather'], (m) => warnings.push(m));
    const block = '<｜DSML｜function_calls><｜DSML｜invoke name="hack"></｜DSML｜invoke></｜DSML｜function_calls>';
    const out = filter.feed(block.slice(0, 7));
    const rest = filter.feed(block.slice(7));
    const end = filter.finish();
    assert.equal(out.text + rest.text + end.text, '');
    assert.equal(out.calls.length + rest.calls.length + end.calls.length, 0);
    assert.ok(warnings.length > 0);
  });

  test('像 a < b 这样的文字不会被长期扣住', () => {
    const filter = new ToolTextFilter(null);
    assert.equal(filter.feed('三 < 五,').text + filter.feed('所以对').text + filter.finish().text, '三 < 五,所以对');
  });
});

describe('对话接口地址', () => {
  test('百炼业务空间的原生地址或裸域名换成兼容模式,其余原样', () => {
    const ws = 'https://llm-abc123.cn-beijing.maas.aliyuncs.com';
    assert.equal(chatUrl({ base_url: `${ws}/api/v1` }), `${ws}/compatible-mode/v1/chat/completions`);
    assert.equal(chatUrl({ base_url: `${ws}/api/v1/` }), `${ws}/compatible-mode/v1/chat/completions`);
    assert.equal(chatUrl({ base_url: ws }), `${ws}/compatible-mode/v1/chat/completions`);
    assert.equal(chatUrl({ base_url: `${ws}/compatible-mode/v1` }), `${ws}/compatible-mode/v1/chat/completions`);
    assert.equal(chatUrl({ base_url: 'https://dashscope.aliyuncs.com/api/v1' }), 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(chatUrl({ base_url: 'https://api.deepseek.com' }), 'https://api.deepseek.com/chat/completions');
    assert.equal(chatUrl({ base_url: 'https://model.example/v1/chat/completions' }), 'https://model.example/v1/chat/completions');
    assert.equal(chatUrl({ base_url: 'https://evil.aliyuncs.com.example/api/v1' }), 'https://evil.aliyuncs.com.example/api/v1/chat/completions');
  });
});

describe('流式解析', () => {
  test('文字增量与分片的工具调用合并', async () => {
    const { fetchImpl, calls } = fakeLlm([{ text: ['🙂', '好'], calls: [{ name: 'get_weather', arguments: { location: '北京' } }] }]);
    const events = [];
    for await (const event of streamChat(fetchImpl, { base_url: 'https://api.deepseek.com', model_name: 'deepseek-chat', api_key: 'sk-1' }, { messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    assert.deepEqual(events.slice(0, 2), [{ type: 'text', text: '🙂' }, { type: 'text', text: '好' }]);
    const done = events[2] as { type: 'done'; toolCalls: { function: { name: string; arguments: string } }[] };
    assert.equal(done.toolCalls[0]!.function.name, 'get_weather');
    assert.deepEqual(JSON.parse(done.toolCalls[0]!.function.arguments), { location: '北京' });
    assert.equal(calls[0]!.headers['authorization'], 'Bearer sk-1');
    assert.deepEqual(calls[0]!.body.thinking, { type: 'disabled' }, 'DeepSeek 默认关思考');
  });
});

describe('提示词', () => {
  test('能力按工具生成,儿童安全按角色加', () => {
    const agent = {
      id: 'a', name: '童童', system_prompt: '# 角色:{{assistant_name}}', llm_model_id: null, image_model_id: null, tts_voice_id: null,
      chat_history_conf: 1, description: '', role_template: '', safety_level: 'child' as const, max_steps: 6, llm_params_json: '{}', greeting: '',
    };
    const tool = { name: 'get_weather', label: '天气', description: '', parameters: {}, run: async () => ({ content: '' }) };
    const prompt = buildSystemPrompt({ agent, tools: [tool], now: new Date('2026-09-17T00:05:00Z'), hasScreen: true });
    assert.match(prompt, /# 角色:童童/u);
    assert.match(prompt, /你能做的:[^\n]*查天气/u);
    assert.match(prompt, /你做不到的:[^\n]*播放音乐/u);
    assert.match(prompt, /<儿童安全>/u);
    assert.match(prompt, /2026年9月17日 星期四 08:05/u);
    assert.deepEqual(beijingNow(new Date('2026-12-31T16:30:00Z')), { date: '2027年1月1日', weekday: '星期五', time: '00:30' });
  });

  const plainAgent = {
    id: 'a', name: '小单', system_prompt: '', llm_model_id: null, image_model_id: null, tts_voice_id: null,
    chat_history_conf: 1, description: '', role_template: '', safety_level: 'standard' as const, max_steps: 6, llm_params_json: '{}', greeting: '',
  };
  const promptFor = (extra: Partial<Parameters<typeof buildSystemPrompt>[0]>) =>
    buildSystemPrompt({ agent: plainAgent, tools: [], now: new Date('2026-09-17T00:05:00Z'), hasScreen: true, ...extra });

  test('看图:模型支持才列进能做的,否则明说做不到', () => {
    assert.match(promptFor({ vision: true }), /你能做的:[^\n]*看懂用户发来的图片/u);
    assert.match(promptFor({ vision: false }), /你做不到的:[^\n]*看图片/u);
  });

  test('声音表现只在音色允许情感标签时出现;非中文语种与方言另有说话要求', () => {
    const zh = { language: '中文', dialect: '', controlTags: [], richTags: [] };
    const plain = promptFor({ voice: zh });
    assert.doesNotMatch(plain, /<声音表现>/u);
    assert.doesNotMatch(plain, /<说话语言>/u);
    assert.match(plain, /括号或方括号里的动作描写/u);

    const tagged = promptFor({ voice: { ...zh, controlTags: [{ tag: 'excited', label: '兴奋' }], richTags: [{ tag: 'laughing', label: '笑出声' }] } });
    assert.match(tagged, /<声音表现>/u);
    assert.match(tagged, /情绪标签[^\n]*\[excited\]\(兴奋\)/u);
    assert.match(tagged, /声音标签[^\n]*\[laughing\]\(笑出声\)/u);
    assert.match(tagged, /方括号标签除外/u);
    const onlyRich = promptFor({ voice: { ...zh, richTags: [{ tag: 'giggles', label: '咯咯笑' }] } });
    assert.doesNotMatch(onlyRich, /情绪标签,放在/u);

    assert.match(promptFor({ voice: { ...zh, language: '英语' } }), /<说话语言>\n你的声音说英语。[^\n]*所有回复都用英语/u);
    const sichuan = promptFor({ voice: { ...zh, dialect: '四川话' } });
    assert.match(sichuan, /带四川话的味道/u);
    assert.doesNotMatch(sichuan, /所有回复都用/u);
  });
});

describe('历史消息整理', () => {
  test('缺了工具结果的调用降级为纯文字,孤立的工具结果丢掉', () => {
    const cleaned = sanitize([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '先查', tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'user', content: 'b' },
      { role: 'tool', tool_call_id: 'y', content: 'orphan' },
    ]);
    assert.deepEqual(cleaned, [{ role: 'user', content: 'a' }, { role: 'assistant', content: '先查' }, { role: 'user', content: 'b' }]);
  });
});

// ---------------------------------------------------------------- 循环

describe('多步循环', () => {
  let conn: Db;
  let bridge: FakeBridge;
  let texts: string[];
  let deviceMessages: Record<string, unknown>[];
  let sink: TurnSink;
  const MAC = '4c:11:ae:31:7a:30';

  const device = (features: Record<string, unknown> = { xiaodan: true }): DeviceContext => ({
    mac: MAC, sessionId: 'sess-1', turnId: 'turn-1', clientIp: '1.2.3.4', features,
  });

  beforeEach(() => {
    conn = openMemoryDb();
    seed(conn);
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_DS', 'LLM', 'DeepSeek', 'openai', ?)",
      JSON.stringify({ type: 'openai', base_url: 'https://api.deepseek.com', model_name: 'deepseek-chat', api_key: 'sk' }));
    run(conn, "UPDATE agents SET llm_model_id = 'LLM_DS', max_steps = 3 WHERE id = ?", DEFAULT_AGENT_ID);
    bridge = new FakeBridge();
    texts = [];
    deviceMessages = [];
    sink = { text: (t) => texts.push(t), device: (m) => deviceMessages.push(m), media: () => {}, closeAfterTurn: () => {} };
    conversations.reset(`device:${MAC}`);
  });

  const deps = (fetchImpl: AgentDeps['fetch']): AgentDeps => ({ conn, fetch: fetchImpl, bridge, dataDir: () => '/tmp' });

  test('查天气再回答:过渡语、工具提示、结果回灌、记录与情绪', async () => {
    const { fetchImpl, calls } = fakeLlm([
      { calls: [{ name: 'get_weather', arguments: { location: '北京' } }] },
      { text: ['😎北京晴,', '二十六度。'] },
    ]);
    bridge.results['get_weather'] = { action: 'REQLLM', result: '北京 晴 26°C', response: null };
    const summary = await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), query: '北京天气怎么样',
      engineMessages: [], conversationKey: `device:${MAC}`, record: { mac: MAC, sessionId: 'sess-1' },
      signal: new AbortController().signal, sink,
    });
    assert.equal(summary.steps, 2);
    assert.equal(summary.toolCalls, 1);
    assert.deepEqual(texts, ['🙂我看看天气哦。', '北京晴,', '二十六度。']);
    assert.deepEqual(bridge.toolCalls[0], { session_id: 'sess-1', turn_id: 'turn-1', name: 'get_weather', arguments: { location: '北京' }, plugin_config: {} });
    assert.deepEqual(deviceMessages[0], { type: 'stt', text: '% get_weather' }, '老固件用 stt 提示');
    assert.deepEqual(deviceMessages[1], { type: 'llm', text: '😎', emotion: 'cool' }, '过渡语之后换了情绪要另发');
    const second = calls[1]!.body.messages;
    assert.equal(second.at(-1)!.role, 'tool');
    assert.equal(second.at(-1)!.content, '北京 晴 26°C');
    assert.equal(second.at(-2)!.tool_calls!.length, 1);
    assert.deepEqual(calls[0]!.body.tools!.map((t) => t.function.name), ['show_calendar', 'get_weather', 'set_volume']);
    const records = all<{ chat_type: number; content: string; agent_id: string }>(conn, 'SELECT chat_type, content, agent_id FROM chat_messages ORDER BY id');
    assert.deepEqual(records.map((r) => r.chat_type), [1, 3, 2]);
    assert.equal(records[2]!.content, '🙂我看看天气哦。北京晴,二十六度。');
    assert.ok(records.every((r) => r.agent_id === DEFAULT_AGENT_ID));
  });

  const withVoice = (emotionTags: string[], extra = '') => {
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Qwen', 'TTS', '千问', 'qwen_audio_tts', ?)",
      JSON.stringify({ type: 'qwen_audio_tts', api_key: 'sk', model_name: 'qwen-audio-3.0-tts-flash' }));
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status, emotion_tags${extra ? ', dialect' : ''})
               VALUES ('v_kid', 'TTS_Qwen', '泡泡', 'longpaopao_v3.6', 'system', 'ok', ?${extra ? ', ?' : ''})`,
    JSON.stringify(emotionTags), ...(extra ? [extra] : []));
    run(conn, "UPDATE agents SET tts_voice_id = 'v_kid' WHERE id = ?", DEFAULT_AGENT_ID);
  };

  test('情感标签:照原样发给引擎,对话记录里去掉;下一轮的上下文保留原文', async () => {
    withVoice(['excited', 'laughing'], '四川话');
    const { fetchImpl, calls } = fakeLlm([{ text: ['[excited]😆哇,', '你做到啦![laughing]'] }, { text: ['🙂嗯嗯。'] }]);
    const base = {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), engineMessages: [], conversationKey: `device:${MAC}`,
      record: { mac: MAC, sessionId: 'sess-1' }, signal: new AbortController().signal, sink,
    };
    await runTurn(deps(fetchImpl), { ...base, query: '我拼好积木了' });
    assert.deepEqual(texts, ['😆[excited]哇,', '你做到啦![laughing]']);
    const system = calls[0]!.body.messages[0]!.content!;
    assert.match(system, /<声音表现>[\s\S]*\[excited\]\(兴奋\)/u);
    assert.match(system, /带四川话的味道/u);
    const reply = one<{ content: string }>(conn, 'SELECT content FROM chat_messages WHERE chat_type = 2')!;
    assert.equal(reply.content, '😆哇,你做到啦!');

    await runTurn(deps(fetchImpl), { ...base, query: '厉害吧' });
    const previous = calls[1]!.body.messages.filter((m) => m.role === 'assistant').at(-1)!;
    assert.match(String(previous.content), /\[excited\].*\[laughing\]/u);
  });

  test('音色不允许标签时提示词里没有声音表现', async () => {
    withVoice([]);
    const { fetchImpl, calls } = fakeLlm([{ text: ['🙂好的。'] }]);
    await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.doesNotMatch(calls[0]!.body.messages[0]!.content!, /<声音表现>/u);
  });

  test('对话记录关掉(chat_history_conf=0)时一条也不写', async () => {
    run(conn, 'UPDATE agents SET chat_history_conf = 0 WHERE id = ?', DEFAULT_AGENT_ID);
    const { fetchImpl } = fakeLlm([{ calls: [{ name: 'get_weather', arguments: {} }] }, { text: ['🙂晴天。'] }]);
    await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), query: '天气', engineMessages: [],
      conversationKey: `device:${MAC}`, record: { mac: MAC, sessionId: 'sess-1' }, signal: new AbortController().signal, sink,
    });
    assert.equal(all(conn, 'SELECT 1 FROM chat_messages').length, 0);
  });

  test('看图:支持看图的模型收到图片分片;不支持时只附一句说明', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const ask = async () => {
      const { fetchImpl, calls } = fakeLlm([{ text: ['🙂是一只猫。'] }]);
      conversations.reset(`device:${MAC}`);
      await runTurn(deps(fetchImpl), {
        agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), query: '这是什么', images: [image], engineMessages: [],
        conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
      });
      return calls[0]!.body.messages;
    };
    run(conn, "UPDATE models SET config_json = json_set(config_json, '$.vision', json('true')) WHERE id = 'LLM_DS'");
    let messages = await ask();
    assert.deepEqual(messages.at(-1)!.content, [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: image } }]);
    assert.match(messages[0]!.content!, /你能做的:[^\n]*看懂用户发来的图片/u);

    run(conn, "UPDATE models SET config_json = json_set(config_json, '$.vision', json('false')) WHERE id = 'LLM_DS'");
    messages = await ask();
    assert.equal(messages.at(-1)!.content, '这是什么\n[系统提示] 用户发了 1 张图片,但你现在用的对话模型看不了图。');
    assert.match(messages[0]!.content!, /你做不到的:[^\n]*看图片/u);
  });

  test('下一轮带上上一轮的工具往来(跨重连延续)', async () => {
    const { fetchImpl, calls } = fakeLlm([
      { calls: [{ name: 'get_weather', arguments: {} }] },
      { text: ['🙂晴天。'] },
      { text: ['🙂明天也不错。'] },
    ]);
    const base = { agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink };
    await runTurn(deps(fetchImpl), { ...base, device: device(), query: '天气', engineMessages: [] });
    await runTurn(deps(fetchImpl), { ...base, device: { ...device(), sessionId: 'sess-2' }, query: '那明天呢', engineMessages: [{ role: 'user', content: '那明天呢' }] });
    const roles = calls[2]!.body.messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  });

  test('步数到上限后不再给工具,强制回答', async () => {
    const { fetchImpl, calls } = fakeLlm((call) => (call.body.tools ? { calls: [{ name: 'set_volume', arguments: { change: 'up' } }] } : { text: ['🙂好啦。'] }));
    const summary = await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device({ xiaodan: 2 }), query: '一直调大', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.equal(calls.length, 4, 'max_steps=3:三次带工具,最后一次不带');
    assert.equal(calls[3]!.body.tools, undefined);
    assert.match(String(calls[3]!.body.messages.at(-1)!.content), /上限/u);
    assert.equal(summary.toolCalls, 3);
    assert.ok(deviceMessages.some((m) => m['cmd'] === 'hint' && m['text']), '新固件用 hint 命令');
    const hints = deviceMessages.filter((m) => m['cmd'] === 'hint');
    assert.equal(hints.at(-1)!['text'], '', '工具做完发空提示收起');
  });

  test('正文里的 DSML 调用也会执行', async () => {
    const dsml = '<｜DSML｜function_calls><｜DSML｜invoke name="show_calendar"></｜DSML｜invoke></｜DSML｜function_calls>';
    const { fetchImpl } = fakeLlm([{ text: [dsml.slice(0, 10), dsml.slice(10)] }, { text: ['🙂今天九月十七号。'] }]);
    bridge.results['show_calendar'] = { action: 'RESPONSE', result: null, response: '今天是9月17日' };
    await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), query: '今天几号', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.equal(bridge.toolCalls[0]!.name, 'show_calendar');
    assert.ok(!texts.join('').includes('DSML'));
  });

  test('没有设备会话时引擎工具如实失败,不抛异常', async () => {
    const { fetchImpl, calls } = fakeLlm([{ calls: [{ name: 'get_weather', arguments: {} }] }, { text: ['😔现在查不了。'] }]);
    await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: { ...device(), sessionId: null }, query: '天气', engineMessages: [],
      conversationKey: 'web:x', record: null, signal: new AbortController().signal, sink,
    });
    assert.match(String(calls[1]!.body.messages.at(-1)!.content), /没有连着设备/u);
    assert.equal(bridge.toolCalls.length, 0);
  });

  test('模型出错或未配置时说一句兜底', async () => {
    const failing = async () => new Response('bad gateway', { status: 502 });
    await runTurn(deps(failing), {
      agent: loadAgent(deps(failing), DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.match(texts.join(''), /连不上大脑/u);
    run(conn, 'UPDATE agents SET llm_model_id = NULL WHERE id = ?', DEFAULT_AGENT_ID);
    texts.length = 0;
    await runTurn(deps(failing), {
      agent: loadAgent(deps(failing), DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.match(texts.join(''), /还没有配置对话模型/u);
  });

  test('打断:已中止的信号不再请求模型,也不说兜底话', async () => {
    const { fetchImpl, calls } = fakeLlm([{ text: ['🙂好'] }]);
    const controller = new AbortController();
    controller.abort();
    await runTurn(deps(fetchImpl), {
      agent: loadAgent(deps(fetchImpl), DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: controller.signal, sink,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(texts, []);
  });
});

// ---------------------------------------------------------------- 接口与配置下发

describe('对话接口与配置下发', () => {
  let conn: Db;
  let app: ReturnType<typeof createApp>;
  let secret: string;
  const MAC = '4c:11:ae:31:7a:30';
  const CLIENT_ID = randomBytes(32).toString('hex');

  beforeEach(() => {
    process.env.XIAODAN_AUTH_MODE = 'proxy';
    conn = openMemoryDb();
    seed(conn);
    secret = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)!.value;
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_DS', 'LLM', 'DeepSeek', 'openai', ?)",
      JSON.stringify({ type: 'openai', base_url: 'https://api.deepseek.com', model_name: 'deepseek-chat', api_key: 'sk' }));
    run(conn, "UPDATE agents SET llm_model_id = 'LLM_DS' WHERE id = ?", DEFAULT_AGENT_ID);
    run(conn, 'INSERT INTO devices (mac, agent_id, secret_hash) VALUES (?, ?, ?)', MAC, DEFAULT_AGENT_ID, hashClientId(CLIENT_ID));
    const { fetchImpl } = fakeLlm([{ text: ['🙂你好呀。'] }]);
    app = createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });
    conversations.reset(`device:${MAC}`);
  });

  const turn = (token: string, body: unknown) => app.request('http://localhost/xiaodan/agent/turn', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  test('令牌不对 401,设备对不上 403', async () => {
    assert.equal((await turn('nope', { query: 'hi' })).status, 401);
    const token = agentToken(secret, MAC);
    assert.equal((await turn(token, { query: 'hi', device_id: 'aa:bb:cc:dd:ee:ff' })).status, 403);
  });

  test('事件流:文字、心跳、done', async () => {
    const response = await turn(agentToken(secret, MAC), {
      session_id: 'sess-9', turn_id: 't', device_id: MAC, features: { xiaodan: true }, query: '你好', messages: [{ role: 'user', content: '你好' }],
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
    const text = await response.text();
    assert.match(text, /^: open/u);
    const events = text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    assert.deepEqual(events, [{ t: 'text', v: '🙂你好呀。' }, { t: 'done' }]);
    const records = all<{ chat_type: number; session_id: string }>(conn, 'SELECT chat_type, session_id FROM chat_messages');
    assert.deepEqual(records.map((r) => r.chat_type), [1, 2]);
    assert.ok(records.every((r) => r.session_id === 'sess-9'));
  });

  test('没绑定的设备:说一句提示并结束', async () => {
    run(conn, 'DELETE FROM devices');
    const text = await (await turn(agentToken(secret, MAC), { query: '你好' })).text();
    assert.match(text, /还没有绑定智能体/u);
    assert.match(text, /"t":"done"/u);
  });

  test('agent-models:大脑一律在控制塔,换成 xiaodan_agent,关掉引擎侧工具、记忆与记录', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'get_weather', '{}') ON CONFLICT DO NOTHING", DEFAULT_AGENT_ID);
    const response = await app.request('http://localhost/xiaozhi/config/agent-models', {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ macAddress: MAC, clientId: CLIENT_ID, selectedModule: {} }),
    });
    const data = ((await response.json()) as { data: Record<string, any> }).data;
    assert.equal(data['selected_module'].LLM, 'LLM_XiaodanAgent');
    const llm = data['LLM'].LLM_XiaodanAgent;
    assert.equal(llm.type, 'xiaodan_agent');
    assert.equal(llm.url, 'http://console:8002/xiaodan/agent/turn');
    assert.equal(verifyAgentToken(secret, llm.api_key), MAC);
    assert.equal(llm.media_secret, secret);
    assert.deepEqual(data['Intent'], { Intent_nointent: { type: 'nointent' } });
    assert.equal(data['selected_module'].Memory, 'Memory_nomem');
    assert.equal(data['plugins'], undefined);
    assert.equal(data['chat_history_conf'], 0);
  });

  test('网页试聊:图片只收 png / jpeg / webp 的 data URL,最多 3 张', async () => {
    const tryChat = (images: string[]) => app.request('http://localhost/api/agent-runtime/try', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: DEFAULT_AGENT_ID, message: '看看', conversation_id: 'c-img', images }),
    });
    assert.equal((await tryChat(['https://evil.example/a.png'])).status, 400);
    assert.equal((await tryChat(['data:image/svg+xml;base64,PHN2Zz4='])).status, 400);
    assert.equal((await tryChat(Array(4).fill('data:image/png;base64,AA=='))).status, 400);
    assert.equal((await tryChat(['data:image/jpeg;base64,/9j/'])).status, 200);
  });

  test('网页试聊:回传工具步骤与汇总', async () => {
    const response = await app.request('http://localhost/api/agent-runtime/try', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: DEFAULT_AGENT_ID, message: '你好', conversation_id: 'c1' }),
    });
    const text = await response.text();
    const events = text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    assert.deepEqual(events.map((e) => e.t), ['meta', 'trace', 'text', 'summary', 'done']);
    assert.equal(all(conn, 'SELECT 1 FROM chat_messages').length, 0, '试聊不写对话记录');
  });
});
