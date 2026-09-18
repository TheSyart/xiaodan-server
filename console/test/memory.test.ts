// 长期记忆:分类与敏感判定、写入与去重、变更留痕与撤销、注入提示词的形状,以及记忆页的接口。
// 模型与设备桥用假的代替。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { conversations } from '../src/agent/context.ts';
import { runTurn } from '../src/agent/loop.ts';
import { loadAgent } from '../src/agent/routes.ts';
import {
  classify, forget, hardBlock, listChanges, listMemory, MAX_FACTS_PER_DEVICE, memoryPrompt, remember, undoChange,
} from '../src/agent/memory/store.ts';
import { applyOps, archiveTick, claimSegments, cleanup, nudgeArchive, splitSegments, summarizeArc } from '../src/agent/memory/archive.ts';
import { arcById, arcMessages } from '../src/agent/memory/arcs.ts';
import { saveMemorySettings } from '../src/agent/memory/settings.ts';
import { collectTools } from '../src/agent/registry.ts';
import { syncSystemVoices } from '../src/voice/store.ts';
import type { AgentDeps, DeviceContext, ToolContext, TurnSink } from '../src/agent/types.ts';

let conn: Db;
const MAC = '4c:11:ae:31:7a:30';

class FakeBridge extends Bridge {
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
}

type Reply = { text?: string; calls?: { name: string; arguments: unknown }[] };

function fakeLlm(replies: Reply[]) {
  const calls: { messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] }[] = [];
  const fetchImpl = async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const reply = replies[calls.length - 1] ?? { text: '🙂好的。' };
    const lines: string[] = [];
    if (reply.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`);
    (reply.calls ?? []).forEach((call, index) => {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `c${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] })}\n\n`);
    });
    lines.push('data: [DONE]\n\n');
    return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetchImpl, calls };
}

function deps(fetchImpl: AgentDeps['fetch']): AgentDeps {
  return { conn, fetch: fetchImpl, bridge: new FakeBridge(), dataDir: () => '/tmp', log: () => {} };
}

function device(mac: string | null = MAC): DeviceContext {
  return { mac, sessionId: 'sess', turnId: null, clientIp: null, features: { xiaodan: 3 } };
}

const silentSink: TurnSink = { text: () => {}, device: () => {}, media: () => {}, closeAfterTurn: () => {} };

beforeEach(() => {
  process.env['XIAODAN_AUTH_MODE'] = 'proxy';
  conn = openMemoryDb();
  seed(conn);
  run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_DS', 'LLM', 'DeepSeek', 'openai', ?)",
    JSON.stringify({ type: 'openai', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: 'sk-ds' }));
  run(conn, "INSERT INTO models (id, model_type, name, provider, config_json, is_default) VALUES ('TTS_QWEN', 'TTS', '千问合成', 'qwen_audio_tts', '{\"model_name\":\"qwen-audio-3.0-tts-flash\"}', 1)");
  syncSystemVoices(conn);
  run(conn, 'UPDATE agents SET llm_model_id = ? WHERE id = ?', 'LLM_DS', DEFAULT_AGENT_ID);
  run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', DEFAULT_AGENT_ID);
  run(conn, 'INSERT INTO devices (mac, agent_id) VALUES (?, ?)', MAC, DEFAULT_AGENT_ID);
  conversations.reset(`device:${MAC}`);
});

describe('分类与红线', () => {
  test('住址、联系方式记得下但标成敏感;年龄段说法不算住址', () => {
    assert.deepEqual(classify('妈妈的电话是 13800138000'), { kind: 'contact', sensitive: true });
    assert.deepEqual(classify('家住在幸福路 12 号'), { kind: 'place', sensitive: true });
    assert.deepEqual(classify('在阳光实验小学上学'), { kind: 'place', sensitive: true });
    assert.equal(classify('在上小学').sensitive, false, '年龄段不是住址');
    assert.equal(classify('上幼儿园大班了').sensitive, false);
    assert.deepEqual(classify('最喜欢霸王龙'), { kind: 'preference', sensitive: false });
    assert.deepEqual(classify('花生过敏'), { kind: 'health', sensitive: false });
    assert.deepEqual(classify('名字叫乐乐'), { kind: 'profile', sensitive: false });
    assert.equal(classify('今天很开心').kind, 'other');
  });

  test('红线只剩密码、支付与证件号', () => {
    assert.equal(hardBlock('生日是三月十七日'), null);
    assert.equal(hardBlock('妈妈电话 13800138000'), null, '手机号是敏感但可记');
    assert.notEqual(hardBlock('家里 WiFi 密码是 abc12345'), null);
    assert.notEqual(hardBlock('银行卡 6222020000000000000'), null);
    assert.notEqual(hardBlock('身份证号 330102…'), null);
    assert.notEqual(hardBlock('卡号是 6222 0200 0000 0000 000'), null, '十五位以上连续数字当成卡号');
  });
});

describe('写入与撤销', () => {
  test('写入、去重更新、敏感落库、挤掉最早的自动记忆', () => {
    assert.equal(remember(conn, { mac: MAC, text: '名字叫乐乐。', source: 'agent' }).status, 'added');
    assert.equal(remember(conn, { mac: MAC, text: '名字叫乐乐', source: 'agent' }).status, 'unchanged', '句号不算不同');
    assert.equal(remember(conn, { mac: MAC, text: '喜欢恐龙', source: 'agent' }).status, 'added');
    const updated = remember(conn, { mac: MAC, text: '最喜欢霸王龙', source: 'agent', replaces: '喜欢恐龙' });
    assert.equal(updated.status, 'updated');
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['名字叫乐乐', '最喜欢霸王龙']);

    const phone = remember(conn, { mac: MAC, text: '妈妈的电话是 13800138000', source: 'agent' });
    assert.equal(phone.status, 'added', '联系方式现在记得下');
    assert.equal(phone.status === 'added' && phone.row.sensitive, 1);
    assert.equal(phone.status === 'added' && phone.row.kind, 'contact');
    assert.equal(remember(conn, { mac: MAC, text: '家里密码是 abc12345', source: 'agent' }).status, 'rejected');
    assert.equal(remember(conn, { mac: MAC, text: '字'.repeat(91), source: 'agent' }).status, 'rejected');

    run(conn, 'DELETE FROM device_memory');
    remember(conn, { mac: MAC, text: '手动加的', source: 'admin' });
    for (let i = 0; i < MAX_FACTS_PER_DEVICE; i += 1) remember(conn, { mac: MAC, text: `第${i}件事是${'甲乙丙丁'[i % 4]}${i}`, source: 'agent' });
    const rows = listMemory(conn, MAC);
    assert.equal(rows.length, MAX_FACTS_PER_DEVICE);
    assert.equal(rows[0]!.text, '手动加的', '手动添加的不会被挤掉');
    assert.ok(!rows.some((r) => r.text === '第0件事是甲0'), '挤掉最早一条自动记的');
    assert.deepEqual(forget(conn, MAC, '手动').map((r) => r.text), ['手动加的']);
  });

  test('每次变更都留痕,加的能删回去、改的能还原、删的能补回来', () => {
    const added = remember(conn, { mac: MAC, text: '喜欢画画', source: 'agent' });
    remember(conn, { mac: MAC, text: '最喜欢画恐龙', source: 'agent', replaces: '喜欢画画' });
    forget(conn, MAC, '恐龙');
    const changes = listChanges(conn, MAC);
    assert.deepEqual(changes.map((c) => c.op), ['delete', 'update', 'add']);
    assert.equal(listMemory(conn, MAC).length, 0);

    assert.equal(undoChange(conn, changes[0]!), true, '撤销删除');
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['最喜欢画恐龙']);
    assert.equal(undoChange(conn, changes[0]!), false, '撤销过的不能再撤');
    assert.equal(added.status, 'added');
  });
});

describe('注入提示词', () => {
  test('按分类分组;敏感条目只说有什么,不写内容', () => {
    remember(conn, { mac: MAC, text: '名字叫乐乐', source: 'admin' });
    remember(conn, { mac: MAC, text: '最喜欢霸王龙', source: 'admin' });
    remember(conn, { mac: MAC, text: '妈妈的电话是 13800138000', source: 'admin' });
    const prompt = memoryPrompt(conn, MAC)!;
    assert.match(prompt.facts, /称呼与身份:名字叫乐乐/u);
    assert.match(prompt.facts, /喜好与讨厌:最喜欢霸王龙/u);
    assert.doesNotMatch(prompt.facts, /13800138000/u, '敏感内容不进常驻提示词');
    assert.match(prompt.sensitiveNote, /联系方式/u);
    assert.match(prompt.sensitiveNote, /recall_memory/u);
    assert.equal(memoryPrompt(conn, 'aa:bb:cc:dd:ee:ff'), undefined);
  });
});

describe('对话里的记忆', () => {
  test('开了记忆的角色能记能忘、记忆进提示词;没开的角色连函数都看不到', async () => {
    remember(conn, { mac: MAC, text: '名字叫乐乐', source: 'admin' });
    const plain = fakeLlm([{ text: '🙂你好。' }]);
    let d = deps(plain.fetchImpl);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: silentSink,
    });
    assert.doesNotMatch(String(plain.calls[0]!.messages[0]!.content), /乐乐/u, '没开记忆');
    assert.ok(!(plain.calls[0]!.tools ?? []).some((t) => t.function.name === 'remember'));

    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'memory', '{}')", DEFAULT_AGENT_ID);
    const llm = fakeLlm([
      { calls: [{ name: 'remember', arguments: { fact: '最喜欢霸王龙' } }] },
      { text: '🙂霸王龙超酷的!' },
      { calls: [{ name: 'forget', arguments: { fact: '霸王龙' } }] },
      { text: '🙂好,忘掉啦。' },
    ]);
    d = deps(llm.fetchImpl);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '我最喜欢霸王龙', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: silentSink,
    });
    const system = String(llm.calls[0]!.messages[0]!.content);
    assert.match(system, /<关于用户的记忆>\n称呼与身份:名字叫乐乐/u);
    assert.ok(llm.calls[0]!.tools!.some((t) => t.function.name === 'remember'));
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['名字叫乐乐', '最喜欢霸王龙']);
    assert.equal(listMemory(conn, MAC)[1]!.agent_id, DEFAULT_AGENT_ID);

    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '忘掉霸王龙吧', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: silentSink,
    });
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['名字叫乐乐']);
  });

  test('记忆不再是工具页上的一张卡片,但智能体页的开关还在', async () => {
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const tools = await (await app.request('http://localhost/api/tools')).json() as { items: { code: string; page?: { path: string } }[] };
    const memory = tools.items.find((t) => t.code === 'memory')!;
    assert.deepEqual(memory.page, { path: '/memory', label: '记忆' }, '工具页据此只指路、不列卡片');
    assert.ok(tools.items.some((t) => t.code === 'vocab' && !t.page), '别的工具照常');
  });
});

describe('记忆页接口', () => {
  const api = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
    app.request(`http://localhost/api/memory${path}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('概览、增改删清空,住址电话能存下来并标敏感', async () => {
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const overview = await (await api(app, 'GET', '/overview')).json() as { devices: unknown[]; device: { mac: string; enabled: boolean; facts: number } };
    assert.equal(overview.devices.length, 1);
    assert.equal(overview.device.mac, MAC);
    assert.equal(overview.device.enabled, false, '这个角色还没开记忆');

    const added = await (await api(app, 'POST', '/facts', { mac: MAC, text: '生日是三月十七日' })).json() as { item: { id: number; kind: string } };
    assert.equal(added.item.kind, 'profile');
    const phone = await api(app, 'POST', '/facts', { mac: MAC, text: '妈妈电话 13800138000' });
    assert.equal(phone.status, 200, '联系方式记得下');
    assert.equal(((await phone.json()) as { item: { sensitive: number } }).item.sensitive, 1);
    assert.equal((await api(app, 'POST', '/facts', { mac: MAC, text: 'wifi 密码是 abc12345' })).status, 400);

    assert.equal((await api(app, 'PUT', `/facts/${added.item.id}`, { text: '生日是三月十八日' })).status, 200);
    const list = await (await api(app, 'GET', `/facts?mac=${MAC}`)).json() as { items: { text: string; kind_label: string }[] };
    assert.deepEqual(list.items.map((r) => r.text), ['生日是三月十八日', '妈妈电话 13800138000']);
    assert.equal(list.items[1]!.kind_label, '联系方式');

    assert.equal((await api(app, 'DELETE', `/facts/${added.item.id}`)).status, 200);
    assert.equal((await api(app, 'DELETE', `/facts?mac=${MAC}`)).status, 200);
    assert.equal(listMemory(conn, MAC).length, 0);
    assert.equal((await api(app, 'GET', '/facts?mac=aa:bb:cc:dd:ee:ff')).status, 404);
  });

  test('变更能回溯,也能一键撤销', async () => {
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    await api(app, 'POST', '/facts', { mac: MAC, text: '喜欢画画' });
    const fact = listMemory(conn, MAC)[0]!;
    await api(app, 'DELETE', `/facts/${fact.id}`);
    const changes = await (await api(app, 'GET', `/changes?mac=${MAC}`)).json() as { items: { id: number; op: string }[] };
    assert.deepEqual(changes.items.map((c) => c.op), ['delete', 'add']);
    assert.equal((await api(app, 'POST', `/changes/${changes.items[0]!.id}/undo`)).status, 200);
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['喜欢画画']);
    assert.equal((await api(app, 'POST', `/changes/${changes.items[0]!.id}/undo`)).status, 409, '撤销过的不能再撤');
    assert.equal((await api(app, 'POST', '/changes/9999/undo')).status, 404);
  });

  test('设置:记录范围写进工具说明,模型选的要存在', async () => {
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const before = await (await api(app, 'GET', '/settings')).json() as { scope: string; default_scope: string; models: { id: string }[] };
    assert.equal(before.scope, before.default_scope);
    assert.deepEqual(before.models.map((m) => m.id), ['LLM_DS']);
    assert.equal((await api(app, 'PUT', '/settings', { summaryModelId: 'nope' })).status, 400);
    assert.equal((await api(app, 'PUT', '/settings', { scope: '只记喜好', summaryModelId: 'LLM_DS', rawKeepDays: 30 })).status, 200);

    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'memory', '{}')", DEFAULT_AGENT_ID);
    const llm = fakeLlm([{ text: '🙂好。' }]);
    const d = deps(llm.fetchImpl);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: silentSink,
    });
    const remember = llm.calls[0]!.tools!.find((t) => t.function.name === 'remember') as { function: { description: string } };
    assert.match(remember.function.description, /只记喜好/u, '记录范围与实时记的口径是同一份');
  });
});

describe('解绑设备', () => {
  test('记忆、白名单与对话档案一起清掉', () => {
    remember(conn, { mac: MAC, text: '喜欢画画', source: 'agent' });
    run(conn, 'INSERT INTO device_roles (mac, agent_id) VALUES (?, ?)', MAC, DEFAULT_AGENT_ID);
    run(conn, `INSERT INTO memory_arcs (mac, started_at, ended_at) VALUES (?, datetime('now'), datetime('now'))`, MAC);
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    return app.request(`http://localhost/api/devices/${MAC}`, { method: 'DELETE' }).then(() => {
      assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM device_memory')!.n, 0);
      assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM device_roles')!.n, 0);
      assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM memory_arcs')!.n, 0);
      assert.equal(all(conn, 'SELECT * FROM memory_changes').length, 0, '变更留痕跟着设备一起走');
    });
  });
});

// ---------------------------------------------------------------- 冷记忆:对话档案

/** 造一条聊天记录,时间用「几分钟前」 */
function say(minutesAgo: number, type: 1 | 2 | 3, content: string, session = 's1') {
  run(conn,
    "INSERT INTO chat_messages (mac, session_id, chat_type, content, agent_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))",
    MAC, session, type, content, DEFAULT_AGENT_ID, `-${minutesAgo} minutes`);
}

/** 模型一次性返回整理结果(走的是同一条 SSE 通道) */
function fakeSummary(replies: string[]) {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const fetchImpl = async (_url: string, init: RequestInit = {}) => {
    calls.push(JSON.parse(String(init.body)));
    const text = replies[calls.length - 1] ?? replies.at(-1) ?? '{}';
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  return { fetchImpl, calls };
}

const GOOD = JSON.stringify({
  title: '恐龙和幼儿园的小饼干',
  summary: '聊了霸王龙,还说幼儿园发了小饼干很好吃。',
  bullets: ['改口说现在最喜欢三角龙', '幼儿园老师姓王'],
  topics: ['恐龙', '幼儿园'],
  memory_ops: [{ op: 'add', text: '幼儿园老师姓王', reason: '这次说的' }],
});

describe('对话归档', () => {
  // 迁移把归档水位线设在「升级那一刻」,不回溯历史对话;测试里的消息是往前推的,所以把水位线调早
  beforeEach(() => {
    run(conn, "UPDATE settings SET value = datetime('now', '-1 day') WHERE key = 'memory.archive_from'");
  });

  test('按半小时的缺口切段,不按连接:29 分钟不切、31 分钟切', () => {
    const rows = [
      { id: 1, session_id: 'a', chat_type: 1, content: '', created_at: '2026-09-18 19:00:00', agent_id: null },
      { id: 2, session_id: 'b', chat_type: 2, content: '', created_at: '2026-09-18 19:29:00', agent_id: null },
      { id: 3, session_id: 'c', chat_type: 1, content: '', created_at: '2026-09-18 20:00:01', agent_id: null },
    ];
    const segments = splitSegments(rows);
    assert.deepEqual(segments.map((seg) => seg.map((row) => row.id)), [[1, 2], [3]]);
  });

  test('聊完静置十分钟才整理;整理好的档案带摘要要点,并把补录写进热记忆', async () => {
    say(40, 1, '你好呀');
    say(40, 2, '🙂你好,今天想聊什么?');
    say(39, 1, '我现在最喜欢三角龙了');
    say(39, 3, '[{"type":"tool","text":"remember({})"}]');
    say(39, 2, '🙂三角龙也很酷!');
    say(2, 1, '我回来啦');          // 还在聊的一段:这次不整理

    const llm = fakeSummary([GOOD]);
    const d = deps(llm.fetchImpl);
    const claimed = claimSegments(conn, MAC, Date.now(), 5);
    assert.equal(claimed.length, 1, '只认领静置够久的那一段');
    assert.equal(claimed[0]!.turns, 2);
    assert.equal(claimed[0]!.sessions, 1);
    assert.equal(await summarizeArc(d, claimed[0]!), 'ready');

    const arc = arcById(conn, claimed[0]!.id)!;
    assert.equal(arc.status, 'ready');
    assert.equal(arc.title, '恐龙和幼儿园的小饼干');
    assert.deepEqual(JSON.parse(arc.topics_json), ['恐龙', '幼儿园']);
    assert.match(arc.search_text, /幼儿园/u);
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['幼儿园老师姓王'], '补录直接生效');
    assert.equal(listMemory(conn, MAC)[0]!.source, 'archive');
    assert.equal(listChanges(conn, MAC)[0]!.arc_id, arc.id, '留痕能追到是哪段对话改的');

    // 交给模型的输入:丢掉工具记录,带上已有记忆与记录范围
    const sent = String(llm.calls[0]!.messages[1]!.content);
    assert.doesNotMatch(sent, /remember\(/u, '工具记录不占字数');
    assert.match(sent, /<记录范围>/u);
    assert.match(sent, /用户:我现在最喜欢三角龙了/u);
  });

  test('同一批消息整理两次只会产生一个档案', async () => {
    say(40, 1, '你好呀');
    say(39, 2, '🙂你好');
    const d = deps(fakeSummary([GOOD]).fetchImpl);
    nudgeArchive('s1');
    await archiveTick(d);
    nudgeArchive('s1');
    await archiveTick(d);
    assert.equal(all(conn, 'SELECT * FROM memory_arcs').length, 1);
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM chat_messages WHERE arc_id IS NULL')!.n, 0);
  });

  test('模型返回看不懂的东西:退避重试,三次之后降级,原文与 arc_id 都不动', async () => {
    say(40, 1, '你好呀');
    say(39, 1, '再见');
    const d = deps(fakeSummary(['我觉得这段对话很温馨。']).fetchImpl);
    const [arc] = claimSegments(conn, MAC, Date.now(), 1);
    for (let i = 0; i < 3; i += 1) {
      const current = arcById(conn, arc!.id)!;
      await summarizeArc(d, current);
    }
    const failed = arcById(conn, arc!.id)!;
    assert.equal(failed.status, 'skipped', '三次之后不再重试');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.title, '你好呀', '兜底用第一句话当标题');
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM chat_messages WHERE arc_id IS NULL')!.n, 0, 'arc_id 不回退,免得无限重试');
    assert.equal(arcMessages(conn, arc!.id).length, 2, '原文还在,页面仍能逐轮看');
  });

  test('太短的段不调模型;记录范围里没有的红线内容一律不记', async () => {
    say(40, 1, '你好');
    const llm = fakeSummary([GOOD]);
    const d = deps(llm.fetchImpl);
    const [arc] = claimSegments(conn, MAC, Date.now(), 1);
    assert.equal(await summarizeArc(d, arc!), 'skipped');
    assert.equal(llm.calls.length, 0, '一句话的对话不值得一次模型调用');
    assert.equal(arcById(conn, arc!.id)!.title, '你好');
  });

  test('更正与补录:最多三条,delete 按编号删且能撤销,红线内容丢掉', () => {
    const kept = remember(conn, { mac: MAC, text: '最喜欢霸王龙', source: 'admin' });
    const gone = remember(conn, { mac: MAC, text: '名字叫豆豆', source: 'admin' });
    run(conn, `INSERT INTO memory_arcs (mac, agent_id, started_at, ended_at) VALUES (?, ?, datetime('now'), datetime('now'))`, MAC, DEFAULT_AGENT_ID);
    const arc = arcById(conn, one<{ id: number }>(conn, 'SELECT id FROM memory_arcs ORDER BY id DESC LIMIT 1')!.id)!;

    const applied = applyOps(conn, arc, [
      { op: 'update', id: kept.status === 'added' ? kept.row.id : 0, text: '最喜欢三角龙', reason: '改口了' },
      { op: 'delete', id: gone.status === 'added' ? gone.row.id : 0, reason: '记错了' },
      { op: 'add', text: '家里 wifi 密码是 abc12345' },
      { op: 'add', text: '第四条不该被采纳' },
    ]);
    assert.equal(applied, 2, '改一条、删一条;密码被红线挡掉,第四条超出上限没轮到');
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['最喜欢三角龙']);

    const del = listChanges(conn, MAC).find((c) => c.op === 'delete')!;
    assert.equal(undoChange(conn, del), true);
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text).sort(), ['名字叫豆豆', '最喜欢三角龙']);
  });

  test('保留策略:整理过的原文到期清掉,摘要还在', () => {
    say(40, 1, '你好呀');
    say(39, 2, '🙂你好');
    const [arc] = claimSegments(conn, MAC, Date.now(), 1);
    run(conn, "UPDATE memory_arcs SET status = 'ready', title = '闲聊', ended_at = datetime('now', '-40 days') WHERE id = ?", arc!.id);
    assert.deepEqual(cleanup(conn), { rawGone: 0, orphans: 0 }, '默认永久保留,不删任何原文');

    saveMemorySettings(conn, { rawKeepDays: 30 });
    assert.equal(cleanup(conn).rawGone, 1);
    assert.equal(arcMessages(conn, arc!.id).length, 0);
    const after = arcById(conn, arc!.id)!;
    assert.equal(after.status, 'raw_gone');
    assert.equal(after.title, '闲聊', '摘要与标题永久保留');
  });
});

describe('回想以前聊过的', () => {
  function readyArc(title: string, summary: string, topics: string[], daysAgo = 1) {
    run(conn,
      `INSERT INTO memory_arcs (mac, agent_id, title, summary, bullets_json, topics_json, search_text, started_at, ended_at, status, turns, messages)
       VALUES (?, ?, ?, ?, '[]', ?, ?, datetime('now', ?), datetime('now', ?), 'ready', 4, 8)`,
      MAC, DEFAULT_AGENT_ID, title, summary, JSON.stringify(topics),
      `${title} ${summary} ${topics.join(' ')}`.toLowerCase(), `-${daysAgo} days`, `-${daysAgo} days`);
    return one<{ id: number }>(conn, 'SELECT id FROM memory_arcs ORDER BY id DESC LIMIT 1')!.id;
  }

  test('提示词里列出最近几段的标题,模型据此才会去翻', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'memory', '{}')", DEFAULT_AGENT_ID);
    readyArc('恐龙和小饼干', '聊了霸王龙。', ['恐龙']);
    const llm = fakeLlm([{ text: '🙂好呀。' }]);
    const d = deps(llm.fetchImpl);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: silentSink,
    });
    const system = String(llm.calls[0]!.messages[0]!.content);
    assert.match(system, /<以前聊过什么>/u);
    assert.match(system, /恐龙和小饼干/u);
    assert.match(system, /recall_memory/u);
    assert.ok(llm.calls[0]!.tools!.some((t) => t.function.name === 'recall_memory'));
  });

  test('按关键词找得到,按编号能调出原话;原文清掉后如实说只剩摘要', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'memory', '{}')", DEFAULT_AGENT_ID);
    const dino = readyArc('恐龙和小饼干', '聊了霸王龙。', ['恐龙']);
    readyArc('学了五个水果单词', '苹果香蕉。', ['单词'], 3);
    run(conn, "INSERT INTO chat_messages (mac, session_id, chat_type, content, arc_id) VALUES (?, 's9', 1, '霸王龙有多大呀', ?)", MAC, dino);
    run(conn, "INSERT INTO chat_messages (mac, session_id, chat_type, content, arc_id) VALUES (?, 's9', 2, '🙂比校车还长呢', ?)", MAC, dino);

    const d = deps(async () => new Response('{}'));
    const ctx: ToolContext = {
      deps: d, agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(),
      sink: silentSink, signal: new AbortController().signal, conversationKey: `device:${MAC}`,
    };
    const recall = (await collectTools(ctx)).find((t) => t.name === 'recall_memory')!;

    const found = await recall.run(ctx, { query: '恐龙' });
    assert.match(found.content, /恐龙和小饼干/u);
    assert.doesNotMatch(found.content, /水果单词/u, '关键词不匹配的不返回');
    assert.match(found.content, new RegExp(`#${dino}`, 'u'), '带编号,好让模型再来调原话');

    const raw = await recall.run(ctx, { arc_id: dino });
    assert.match(raw.content, /霸王龙有多大呀/u);
    assert.match(raw.content, /比校车还长呢/u);

    assert.match((await recall.run(ctx, { query: '滑板车' })).content, /想不起来|没有聊到过/u);

    run(conn, "UPDATE memory_arcs SET status = 'raw_gone' WHERE id = ?", dino);
    assert.match((await recall.run(ctx, { arc_id: dino })).content, /只剩摘要/u);
  });
});
