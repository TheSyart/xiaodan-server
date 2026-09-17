// 能力三类的页面接口:工具页(查看、改全局设置)、技能与 MCP 的「哪些智能体在用」,以及运行时读全局设置。
// 外部服务与设备桥用假的代替。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { PLUGINS } from '../src/catalog.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { collectTools } from '../src/agent/registry.ts';
import { loadAgent } from '../src/agent/routes.ts';
import { skillNeeds } from '../src/agent/tools-routes.ts';
import type { AgentDeps, ToolContext } from '../src/agent/types.ts';

class RecordingBridge extends Bridge {
  calls: { name: string; plugin_config: Record<string, unknown> }[] = [];
  constructor() {
    super(() => 'http://engine:8003', () => 'secret', async () => new Response('{}'));
  }
  override async callTool(body: { session_id: string; turn_id: string | null; name: string; arguments: Record<string, unknown>; plugin_config: Record<string, unknown> }) {
    this.calls.push({ name: body.name, plugin_config: body.plugin_config });
    return { action: 'REQLLM', result: 'ok', response: null };
  }
}

let conn: Db;
let bridge: RecordingBridge;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  process.env.XIAODAN_AUTH_MODE = 'proxy';
  conn = openMemoryDb();
  seed(conn);
  bridge = new RecordingBridge();
  app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge, dataDir: () => '/tmp', log: () => {} } });
});

const api = (method: string, path: string, body?: unknown) => app.request(`http://localhost/api${path}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

interface ToolView {
  code: string;
  runs_in: string;
  functions: { name: string; description: string }[];
  fields: { key: string; options?: { value: string }[] }[];
  config: Record<string, unknown>;
  status: { ready: boolean; message: string };
  agents: { id: string; name: string }[];
  skills: string[];
}

describe('工具页', () => {
  test('列出全部工具:函数、在哪执行、状态、哪些智能体开着、哪些技能依赖', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'vocab', '{}') ON CONFLICT DO NOTHING", DEFAULT_AGENT_ID);
    const { items } = await (await api('GET', '/tools')).json() as { items: ToolView[] };
    assert.deepEqual(items.map((t) => t.code), PLUGINS.map((p) => p.code), '工具是代码里的,一个不多一个不少');
    const byCode = Object.fromEntries(items.map((t) => [t.code, t]));
    assert.equal(byCode['get_weather']!.runs_in, 'engine');
    assert.equal(byCode['search']!.runs_in, 'console');
    assert.deepEqual(byCode['get_weather']!.functions.map((f) => f.name), ['get_weather']);
    assert.deepEqual(byCode['vocab']!.functions.map((f) => f.name), ['vocab_deck', 'vocab_answer', 'vocab_progress', 'vocab_next', 'vocab_show'], '新老固件的函数都列出');
    assert.match(byCode['vocab']!.functions[0]!.description, /^\(新固件才有\)/u);
    assert.match(byCode['vocab']!.functions[3]!.description, /^\(老固件才有\)/u);
    assert.deepEqual(byCode['vocab']!.agents.map((a) => a.id), [DEFAULT_AGENT_ID]);
    assert.ok(byCode['vocab']!.skills.includes('word-coach'), '技能 word-coach 依赖学单词');
    assert.ok(byCode['stories']!.skills.includes('bedtime-story'));
    assert.deepEqual(byCode['search']!.status, { ready: false, message: '还没有配置搜索服务' });
    assert.equal(byCode['image']!.status.ready, false);
    assert.equal(byCode['show_calendar']!.status.ready, true);
    // 单词书下拉由库里的数据现填
    run(conn, "INSERT INTO vocab_books (id, title) VALUES ('mine', '我的单词书')");
    const vocab = await (await api('GET', '/tools/vocab')).json() as ToolView;
    assert.ok(vocab.fields.find((f) => f.key === 'book')!.options!.some((o) => o.value === 'mine'));
    assert.equal((await api('GET', '/tools/nope')).status, 404);
  });

  test('改设置:按字段校验,空值当默认不存,不认识的字段丢掉', async () => {
    let response = await api('PUT', '/tools/get_weather', { config: { default_location: ' 杭州 ', hold_s: 30, extra: 'x' } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { config: unknown }).config, { default_location: '杭州', hold_s: 30 });
    assert.equal((await api('PUT', '/tools/get_weather', { config: { hold_s: 99 } })).status, 400, '停留秒数 5 到 60');
    assert.equal((await api('PUT', '/tools/get_weather', { config: { hold_s: 'abc' } })).status, 400);
    assert.equal((await api('PUT', '/tools/image', { config: { model_id: 'nope' } })).status, 400, '选的模型要存在');
    assert.equal((await api('PUT', '/tools/nope', { config: {} })).status, 404);
    response = await api('PUT', '/tools/get_weather', { config: { default_location: '' } });
    assert.deepEqual((await response.json() as { config: unknown }).config, {}, '清空就回到默认');
  });

  test('运行时读全局设置:引擎工具随调用带上,画画用选的模型,删模型前要先改掉', async () => {
    await api('PUT', '/tools/get_weather', { config: { default_location: '杭州', hold_s: 30 } });
    const deps: AgentDeps = { conn, fetch: async () => new Response('{}'), bridge, dataDir: () => '/tmp' };
    const ctx: ToolContext = {
      deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!,
      device: { mac: 'aa:bb:cc:dd:ee:ff', sessionId: 's', turnId: 't', clientIp: null, features: { xiaodan: 3 } },
      sink: { text() {}, device() {}, media() {}, closeAfterTurn() {} }, signal: new AbortController().signal, conversationKey: 'k',
    };
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'get_weather', '{}') ON CONFLICT DO NOTHING", DEFAULT_AGENT_ID);
    const weather = (await collectTools(ctx)).find((t) => t.name === 'get_weather')!;
    await weather.run(ctx, {});
    assert.deepEqual(bridge.calls.at(-1), { name: 'get_weather', plugin_config: { default_location: '杭州', hold_s: 30 } });

    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('Image_A', 'Image', 'a', 'qwen_image', '{}')");
    assert.equal((await api('PUT', '/tools/image', { config: { model_id: 'Image_A' } })).status, 200);
    const image = await (await api('GET', '/tools/image')).json() as ToolView;
    assert.equal(image.status.ready, true);
    const deleted = await api('DELETE', '/models/Image_A');
    assert.equal(deleted.status, 409);
    assert.match((await deleted.json() as { error: string }).error, /画画/u);
  });
});

describe('技能与 MCP 没有全局开关,只看哪些智能体在用', () => {
  test('技能列表带智能体;编辑时提交的启用开关不再生效', async () => {
    run(conn, "INSERT INTO agent_skills (agent_id, skill_name) VALUES (?, 'word-coach')", DEFAULT_AGENT_ID);
    const { items } = await (await api('GET', '/skills')).json() as { items: { name: string; agents: { id: string }[]; enabled?: unknown }[] };
    const coach = items.find((s) => s.name === 'word-coach')!;
    assert.deepEqual(coach.agents.map((a) => a.id), [DEFAULT_AGENT_ID]);
    assert.equal(coach.enabled, undefined);
    const markdown = '---\nname: word-coach\ndescription: 改过\nallowed-tools: vocab_deck\n---\n正文';
    assert.equal((await api('PUT', '/skills/word-coach', { markdown, enabled: false })).status, 200);
    assert.equal(one<{ enabled: number }>(conn, "SELECT enabled FROM skills WHERE name = 'word-coach'")?.enabled, 1);
  });

  test('技能依赖的工具名支持通配', () => {
    assert.equal(skillNeeds('vocab_deck, vocab_answer', 'vocab_deck'), true);
    assert.equal(skillNeeds('mcp_*__aihot_search', 'mcp_aihot__aihot_search'), true);
    assert.equal(skillNeeds('list_stories play_story', 'play_music'), false);
    assert.equal(skillNeeds('', 'play_music'), false);
  });
});
