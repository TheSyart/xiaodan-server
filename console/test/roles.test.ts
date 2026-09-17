// 角色模板、语音切换角色、长期记忆。模型与设备桥用假的代替。

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
import { forget, listMemory, MAX_FACTS_PER_DEVICE, memoryPrompt, privacyReason, remember } from '../src/agent/memory/store.ts';
import { applyTemplate, ROLE_TEMPLATES, templateById } from '../src/agent/roles/templates.ts';
import { greetAfterSwitch, matchRole, needsReconnect, queueGreeting, switchableRoles, takeGreeting } from '../src/agent/roles/switch.ts';
import { seedBuiltinSkills } from '../src/agent/skills/builtin.ts';
import { syncSystemVoices } from '../src/voice/store.ts';
import type { AgentDeps, DeviceContext, TurnSink } from '../src/agent/types.ts';

let conn: Db;
const MAC = '4c:11:ae:31:7a:30';
const BASE_VOICE = 'TTS_QWEN__longanhuan_v3.6';

class FakeBridge extends Bridge {
  announces: { mac: string; body: any }[] = [];
  statuses: number[] = [];
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
  override async announce(mac: string, body: any) {
    this.announces.push({ mac, body });
    return { status: this.statuses.shift() ?? 202, data: {} };
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

function deps(fetchImpl: AgentDeps['fetch'], bridge = new FakeBridge()): AgentDeps {
  return { conn, fetch: fetchImpl, bridge, dataDir: () => '/tmp', log: () => {} };
}

function device(mac: string | null = MAC): DeviceContext {
  return { mac, sessionId: 'sess', turnId: null, clientIp: null, features: { xiaodan: 2 } };
}

function recorder() {
  const out = { texts: [] as string[], device: [] as Record<string, unknown>[], closed: 0 };
  const sink: TurnSink = { text: (t) => out.texts.push(t), device: (m) => out.device.push(m), media: () => {}, closeAfterTurn: () => { out.closed += 1; } };
  return { out, sink };
}

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
  run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_DS', 'LLM', 'DeepSeek', 'openai', ?)",
    JSON.stringify({ type: 'openai', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: 'sk-ds' }));
  run(conn, "INSERT INTO models (id, model_type, name, provider, config_json, is_default) VALUES ('TTS_QWEN', 'TTS', '千问合成', 'qwen_audio_tts', '{\"model_name\":\"qwen-audio-3.0-tts-flash\"}', 1)");
  syncSystemVoices(conn);
  run(conn, 'UPDATE agents SET llm_model_id = ?, tts_voice_id = ? WHERE id = ?', 'LLM_DS', BASE_VOICE, DEFAULT_AGENT_ID);
  run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', DEFAULT_AGENT_ID);
  run(conn, 'INSERT INTO devices (mac, agent_id) VALUES (?, ?)', MAC, DEFAULT_AGENT_ID);
  conversations.reset(`device:${MAC}`);
});

// ---------------------------------------------------------------- 模板

describe('角色模板', () => {
  test('建出的角色带人设、工具、技能、音色,模型沿用默认智能体', () => {
    seedBuiltinSkills(conn);
    const result = applyTemplate(conn, templateById('tongtong')!);
    const agent = one<Record<string, unknown>>(conn, 'SELECT * FROM agents WHERE id = ?', result.id)!;
    assert.equal(agent['name'], '童童');
    assert.equal(agent['safety_level'], 'child');
    assert.equal(agent['llm_model_id'], 'LLM_DS');
    assert.equal(agent['role_template'], 'tongtong');
    const voice = one<{ voice: string; status: string; rate: number; tone_tags: string; parent_id: string | null; name: string }>(conn,
      'SELECT voice, status, rate, tone_tags, parent_id, name FROM voices WHERE id = ?', String(agent['tts_voice_id']))!;
    assert.deepEqual({ ...voice }, {
      voice: 'longpaopao_v3.6', status: 'ok', rate: 0.95, tone_tags: '["gentle","story"]', parent_id: 'TTS_QWEN__longpaopao_v3.6', name: '龙泡泡·童童',
    }, '模板的说话设置和系统音色的默认设置不同:建一个变体');
    const plugins = all<{ plugin_code: string }>(conn, 'SELECT plugin_code FROM agent_plugins WHERE agent_id = ?', result.id).map((r) => r.plugin_code).sort();
    assert.deepEqual(plugins, ['get_weather', 'image', 'memory', 'music', 'reminders', 'roles', 'set_volume', 'show_calendar', 'stories', 'vocab']);
    assert.deepEqual(result.skills.sort(), ['bedtime-story', 'word-coach']);
    assert.deepEqual(result.missing, []);

    // 再建一次:设置一样的变体复用,不重复建
    const again = applyTemplate(conn, templateById('tongtong')!, { name: '童童二号' });
    assert.equal(one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM voices WHERE voice = 'longpaopao_v3.6'")!.n, 2, '原音色与一个变体');
    assert.equal(one<{ tts_voice_id: string }>(conn, 'SELECT tts_voice_id FROM agents WHERE id = ?', again.id)!.tts_voice_id, agent['tts_voice_id']);
    // 不带说话设置的模板直接用系统音色
    const news = applyTemplate(conn, templateById('ai-news')!);
    assert.equal(one<{ tts_voice_id: string }>(conn, 'SELECT tts_voice_id FROM agents WHERE id = ?', news.id)!.tts_voice_id, 'TTS_QWEN__longanyuanfei');
    assert.equal(one<{ name: string }>(conn, 'SELECT name FROM agents WHERE id = ?', again.id)!.name, '童童二号');
  });

  test('缺的东西如实列出:没有千问合成就没有音色,没配的 MCP、没导入的技能', () => {
    run(conn, "UPDATE models SET enabled = 0 WHERE id = 'TTS_QWEN'");
    run(conn, 'DELETE FROM skills');
    const result = applyTemplate(conn, templateById('ai-news')!);
    assert.equal(result.voice, null);
    assert.ok(result.missing.some((m) => m.includes('音色')));
    assert.ok(result.missing.some((m) => m.includes('aihot')));
    assert.ok(result.missing.some((m) => m.includes('ai-news-brief')));

    run(conn, "UPDATE models SET enabled = 1 WHERE id = 'TTS_QWEN'");
    run(conn, "INSERT INTO mcp_servers (id, name, url) VALUES ('aihot', 'AIHOT', 'https://aihot.example/api/mcp')");
    const linked = applyTemplate(conn, templateById('ai-news')!);
    assert.deepEqual(linked.mcp_servers, ['AIHOT'], '名字匹配上就关联');
  });

  test('模板里的插件与技能都真实存在', () => {
    seedBuiltinSkills(conn);
    const skills = new Set(all<{ name: string }>(conn, 'SELECT name FROM skills').map((r) => r.name));
    for (const template of ROLE_TEMPLATES) {
      for (const name of template.skills) assert.ok(skills.has(name), `${template.id} 的技能 ${name}`);
      const result = applyTemplate(conn, template);
      assert.equal(result.plugins.length, template.plugins.length, `${template.id} 的插件都在目录里`);
    }
  });

  test('管理接口', async () => {
    seedBuiltinSkills(conn);
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const list = await (await app.request('http://localhost/api/role-templates')).json() as { items: { id: string; created: number }[] };
    assert.deepEqual(list.items.map((t) => t.id), ['xiaodan', 'tongtong', 'english-teacher', 'ai-news']);
    const created = await app.request('http://localhost/api/role-templates/english-teacher/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Lily 老师' }),
    });
    assert.equal(created.status, 200);
    const body = await created.json() as { id: string };
    assert.equal(one<{ name: string }>(conn, 'SELECT name FROM agents WHERE id = ?', body.id)!.name, 'Lily 老师');
    assert.equal((await app.request('http://localhost/api/role-templates/nope/apply', { method: 'POST' })).status, 404);
    const again = await (await app.request('http://localhost/api/role-templates')).json() as { items: { id: string; created: number }[] };
    assert.equal(again.items.find((t) => t.id === 'english-teacher')!.created, 1);
  });
});

// ---------------------------------------------------------------- 切换角色

describe('切换角色', () => {
  function addRole(name: string, extra: Record<string, unknown> = {}): string {
    const id = `agent_${name}`;
    run(conn, `INSERT INTO agents (id, name, system_prompt, vad_model_id, llm_model_id, greeting, tts_voice_id)
               VALUES (?, ?, '', 'VAD_SileroVAD', 'LLM_DS', ?, ?)`,
      id, name, extra['greeting'] ?? '', extra['tts_voice_id'] ?? BASE_VOICE);
    return id;
  }

  test('名字匹配', () => {
    const roles = [
      { id: 'a', name: '童童', description: '', greeting: '' },
      { id: 'b', name: '英语老师', description: '', greeting: '' },
      { id: 'c', name: 'AI资讯官', description: '', greeting: '' },
    ];
    assert.equal(matchRole(roles, '童童').role?.id, 'a');
    assert.equal(matchRole(roles, '英语').role?.id, 'b', '说一部分也行');
    assert.equal(matchRole(roles, 'ai 资讯官').role?.id, 'c', '忽略大小写与空白');
    assert.equal(matchRole(roles, '数学老师').role, null);
    assert.equal(matchRole([...roles, { id: 'd', name: '英语老师二号', description: '', greeting: '' }], '英语老师').role?.id, 'b', '全名优先');
    assert.equal(matchRole([...roles, { id: 'e', name: '英语外教', description: '', greeting: '' }], '英语').candidates.length, 2);
  });

  test('可切换的角色:默认所有角色,设了白名单只在里面挑', () => {
    const tong = addRole('童童');
    const teacher = addRole('英语老师');
    assert.deepEqual(switchableRoles(conn, MAC, DEFAULT_AGENT_ID).map((r) => r.id), [tong, teacher]);
    run(conn, 'INSERT INTO device_roles (mac, agent_id) VALUES (?, ?)', MAC, teacher);
    assert.deepEqual(switchableRoles(conn, MAC, DEFAULT_AGENT_ID).map((r) => r.id), [teacher]);
  });

  test('只换人设不用重连;换了声音要重连', () => {
    const same = addRole('同声');
    run(conn, "INSERT INTO voices (id, tts_model_id, name, voice) VALUES ('v1', 'TTS_QWEN', '泡泡', 'longpaopao_v3.6')");
    const other = addRole('换声', { tts_voice_id: 'v1' });
    assert.equal(needsReconnect(conn, DEFAULT_AGENT_ID, same), false);
    assert.equal(needsReconnect(conn, DEFAULT_AGENT_ID, other), true);
  });

  test('语音切换:改绑设备、本轮后重连、重连后用新声音打招呼', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'roles', '{}')", DEFAULT_AGENT_ID);
    run(conn, "INSERT INTO voices (id, tts_model_id, name, voice) VALUES ('v1', 'TTS_QWEN', '泡泡', 'longpaopao_v3.6')");
    const tong = addRole('童童', { tts_voice_id: 'v1', greeting: '嗨,我是童童!' });
    const { fetchImpl, calls } = fakeLlm([{ calls: [{ name: 'switch_role', arguments: { name: '童童' } }] }, { text: '🙂好的,童童马上就来。' }]);
    const { out, sink } = recorder();
    const bridge = new FakeBridge();
    const d = deps(fetchImpl, bridge);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '换童童来陪我', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.equal(one<{ agent_id: string }>(conn, 'SELECT agent_id FROM devices WHERE mac = ?', MAC)!.agent_id, tong);
    assert.equal(out.closed, 1, '声音不同:这一轮说完关连接');
    assert.match(String(calls[1]!.messages.at(-1)!.content), /重新连接/u);
    assert.ok(calls[0]!.tools!.some((t) => t.function.name === 'switch_role'));

    await greetAfterSwitch(d, MAC, tong, [0]);
    assert.deepEqual(bridge.announces.map((a) => a.body.text), ['嗨,我是童童!']);
    await greetAfterSwitch(d, MAC, tong, [0]);
    assert.equal(bridge.announces.length, 1, '只打一次招呼');
  });

  test('打招呼:设备忙就重试,过期或又换了角色就不打', async () => {
    const tong = addRole('童童');
    run(conn, 'UPDATE devices SET agent_id = ? WHERE mac = ?', tong, MAC);
    const bridge = new FakeBridge();
    bridge.statuses = [409, 404, 202];
    queueGreeting(MAC, tong);
    await greetAfterSwitch(deps(async () => new Response(''), bridge), MAC, tong, [0, 0, 0]);
    assert.equal(bridge.announces.length, 3);
    assert.equal(bridge.announces[2]!.body.text, '你好呀,我是童童。', '没写招呼语时用默认的');

    queueGreeting(MAC, tong, Date.now() - 10 * 60_000);
    assert.equal(takeGreeting(MAC, tong), false, '过期');
    queueGreeting(MAC, tong);
    assert.equal(takeGreeting(MAC, 'agent_other'), false, '连上来的是别的角色');
  });

  test('同一个声音:不重连,下一轮直接换人设;网页试聊不能切', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'roles', '{}')", DEFAULT_AGENT_ID);
    const same = addRole('小助手');
    const { fetchImpl } = fakeLlm([{ calls: [{ name: 'switch_role', arguments: { name: '小助手' } }] }, { text: '🙂好。' }]);
    const { out, sink } = recorder();
    const d = deps(fetchImpl);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '换小助手', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.equal(one<{ agent_id: string }>(conn, 'SELECT agent_id FROM devices WHERE mac = ?', MAC)!.agent_id, same);
    assert.equal(out.closed, 0);

    const web = fakeLlm([{ calls: [{ name: 'switch_role', arguments: { name: '小单' } }] }, { text: '🙂好。' }]);
    const d2 = deps(web.fetchImpl);
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'roles', '{}')", same);
    await runTurn(d2, {
      agent: loadAgent(d2, same)!, device: device(null), query: '换回小单', engineMessages: [],
      conversationKey: 'try:x', record: null, signal: new AbortController().signal, sink: recorder().sink,
    });
    assert.match(String(web.calls[1]!.messages.at(-1)!.content), /网页试聊/u);
    assert.equal(one<{ agent_id: string }>(conn, 'SELECT agent_id FROM devices WHERE mac = ?', MAC)!.agent_id, same, '没有改');
  });

  test('设备的角色白名单接口', async () => {
    const tong = addRole('童童');
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const put = (allowlist: string[] | null) => app.request(`http://localhost/api/devices/${MAC}/roles`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowlist }),
    });
    assert.equal((await put([tong])).status, 200);
    let got = await (await app.request(`http://localhost/api/devices/${MAC}/roles`)).json() as { allowlist: string[] | null };
    assert.deepEqual(got.allowlist, [tong]);
    assert.equal((await put([])).status, 200);
    assert.deepEqual(switchableRoles(conn, MAC, DEFAULT_AGENT_ID), [], '空白名单:不能切换');
    assert.equal((await put(null)).status, 200);
    got = await (await app.request(`http://localhost/api/devices/${MAC}/roles`)).json() as { allowlist: string[] | null };
    assert.equal(got.allowlist, null);
    assert.equal((await put(['agent_missing'])).status, 400);
    assert.equal((await app.request('http://localhost/api/devices/aa:bb:cc:dd:ee:ff/roles')).status, 404);
  });
});

// ---------------------------------------------------------------- 长期记忆

describe('长期记忆', () => {
  test('写入、去重更新、隐私拦截、挤掉最早的', () => {
    assert.equal(remember(conn, { mac: MAC, text: '名字叫乐乐。', source: 'agent' }).status, 'added');
    assert.equal(remember(conn, { mac: MAC, text: '名字叫乐乐', source: 'agent' }).status, 'unchanged', '句号不算不同');
    assert.equal(remember(conn, { mac: MAC, text: '喜欢恐龙', source: 'agent' }).status, 'added');
    const updated = remember(conn, { mac: MAC, text: '最喜欢霸王龙', source: 'agent', replaces: '喜欢恐龙' });
    assert.equal(updated.status, 'updated');
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['名字叫乐乐', '最喜欢霸王龙']);

    for (const text of ['家住在幸福路 12 号', '妈妈电话 13800138000', '在实验小学上学', '密码是 1234']) {
      const outcome = remember(conn, { mac: MAC, text, source: 'agent' });
      assert.equal(outcome.status, 'rejected', text);
    }
    assert.equal(privacyReason('生日是三月十七日'), null);
    assert.equal(privacyReason('在上小学'), null, '年龄段不是隐私');
    assert.equal(privacyReason('上幼儿园大班了'), null);
    assert.notEqual(privacyReason('三年级二班'), null);
    assert.notEqual(privacyReason('学校叫阳光学校'), null);
    assert.equal(remember(conn, { mac: MAC, text: '字'.repeat(61), source: 'agent' }).status, 'rejected');

    run(conn, 'DELETE FROM device_memory');
    remember(conn, { mac: MAC, text: '手动加的', source: 'admin' });
    for (let i = 0; i < MAX_FACTS_PER_DEVICE; i += 1) remember(conn, { mac: MAC, text: `第${i}件事是${'甲乙丙丁'[i % 4]}${i}`, source: 'agent' });
    const rows = listMemory(conn, MAC);
    assert.equal(rows.length, MAX_FACTS_PER_DEVICE);
    assert.equal(rows[0]!.text, '手动加的', '手动添加的不会被挤掉');
    assert.ok(!rows.some((r) => r.text === '第0件事是甲0'), '挤掉最早一条自动记的');

    assert.deepEqual(forget(conn, MAC, '手动').map((r) => r.text), ['手动加的']);
    assert.match(memoryPrompt(conn, MAC)!, /^- 第1件事/u);
    assert.equal(memoryPrompt(conn, 'aa:bb:cc:dd:ee:ff'), undefined);
  });

  test('开了记忆的角色:记忆进提示词,模型能记能忘;没开的角色看不到', async () => {
    remember(conn, { mac: MAC, text: '名字叫乐乐', source: 'admin' });
    const plain = fakeLlm([{ text: '🙂你好。' }]);
    let d = deps(plain.fetchImpl);
    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '你好', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: recorder().sink,
    });
    assert.doesNotMatch(String(plain.calls[0]!.messages[0]!.content), /乐乐/u, '没开记忆插件');

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
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: recorder().sink,
    });
    const system = String(llm.calls[0]!.messages[0]!.content);
    assert.match(system, /<关于用户的记忆>\n- 名字叫乐乐/u);
    assert.ok(llm.calls[0]!.tools!.some((t) => t.function.name === 'remember'));
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['名字叫乐乐', '最喜欢霸王龙']);
    assert.equal(listMemory(conn, MAC)[1]!.agent_id, DEFAULT_AGENT_ID);

    await runTurn(d, {
      agent: loadAgent(d, DEFAULT_AGENT_ID)!, device: device(), query: '忘掉霸王龙吧', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink: recorder().sink,
    });
    assert.deepEqual(listMemory(conn, MAC).map((r) => r.text), ['名字叫乐乐']);
  });

  test('管理接口:增、改、删、清空,隐私同样拦截', async () => {
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const api = (method: string, path: string, body?: unknown) => app.request(`http://localhost/api/devices/${MAC}${path}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const added = await (await api('POST', '/memory', { text: '生日是三月十七日' })).json() as { item: { id: number } };
    assert.equal((await api('POST', '/memory', { text: '电话 13800138000' })).status, 400);
    assert.equal((await api('PUT', `/memory/${added.item.id}`, { text: '生日是三月十八日' })).status, 200);
    assert.equal((await api('PUT', `/memory/${added.item.id}`, { text: '住址是幸福路 12 号' })).status, 400);
    const list = await (await api('GET', '/memory')).json() as { items: { text: string; source: string }[] };
    assert.deepEqual(list.items.map((r) => [r.text, r.source]), [['生日是三月十八日', 'admin']]);
    assert.equal((await api('DELETE', `/memory/${added.item.id}`)).status, 200);
    remember(conn, { mac: MAC, text: '喜欢画画', source: 'agent' });
    assert.equal((await api('DELETE', '/memory')).status, 200);
    assert.equal(listMemory(conn, MAC).length, 0);
  });

  test('解绑设备时记忆与白名单一起删掉', () => {
    remember(conn, { mac: MAC, text: '喜欢画画', source: 'agent' });
    run(conn, 'INSERT INTO device_roles (mac, agent_id) VALUES (?, ?)', MAC, DEFAULT_AGENT_ID);
    run(conn, 'DELETE FROM devices WHERE mac = ?', MAC);
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM device_memory')!.n, 0);
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM device_roles')!.n, 0);
  });
});
