// 智能体能力:联网搜索、MCP、技能、定时提醒。外部服务、模型与设备桥全部用假的代替。

import { strict as assert } from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { conversations } from '../src/agent/context.ts';
import { runTurn } from '../src/agent/loop.ts';
import { loadAgent } from '../src/agent/routes.ts';
import { collectTools, skillCatalog } from '../src/agent/registry.ts';
import { deepseekSearch, formatResults, parseAnthropicSearch } from '../src/agent/search/providers.ts';
import { callTool, contentToText, listTools, resetMcpSession, type McpServer } from '../src/agent/mcp/client.ts';
import { mcpToolName } from '../src/agent/mcp/tools.ts';
import { BUILTIN_MCP_SERVERS, parseMcpConfig, seedBuiltinMcp } from '../src/agent/mcp/builtin.ts';
import { buildSystemPrompt } from '../src/agent/prompt.ts';
import { packageFromZip, parseSkillMarkdown } from '../src/agent/skills/parse.ts';
import { nextOccurrence, parseBeijing, formatBeijing, speakBeijing } from '../src/agent/reminders/time.ts';
import { catchUp, reminderCard, scanOnce } from '../src/agent/reminders/scheduler.ts';
import type { AgentDeps, DeviceContext, ToolContext, TurnSink } from '../src/agent/types.ts';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function router(routes: [RegExp, Handler][]) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* 原样 */
      }
    }
    calls.push({ url, body, headers });
    for (const [pattern, handler] of routes) if (pattern.test(url)) return handler(url, init);
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

function llmSse(reply: { text?: string; calls?: { name: string; arguments: unknown }[] }): Response {
  const lines: string[] = [];
  if (reply.text) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`);
  (reply.calls ?? []).forEach((call, index) => {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `c${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] })}\n\n`);
  });
  lines.push('data: [DONE]\n\n');
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

class FakeBridge extends Bridge {
  announces: { mac: string; body: any }[] = [];
  announceStatus = 202;
  online = true;
  features: Record<string, unknown> = { xiaodan: 2 };
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
  override async tools() {
    return null;
  }
  override async device() {
    return this.online ? { online: true, session_id: 'sess', features: this.features } : { online: false };
  }
  override async announce(mac: string, body: any) {
    this.announces.push({ mac, body });
    return { status: this.announceStatus, data: {} };
  }
}

let conn: Db;
const MAC = '4c:11:ae:31:7a:30';

function baseDeps(fetchImpl: AgentDeps['fetch'], bridge = new FakeBridge(), now?: () => Date): AgentDeps {
  return { conn, fetch: fetchImpl, bridge, dataDir: () => '/tmp', ...(now ? { now } : {}) };
}

function device(): DeviceContext {
  return { mac: MAC, sessionId: 'sess', turnId: null, clientIp: null, features: { xiaodan: 2 } };
}

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
  run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_DS', 'LLM', 'DeepSeek', 'openai', ?)",
    JSON.stringify({ type: 'openai', base_url: 'https://api.deepseek.com/v1', model_name: 'deepseek-chat', api_key: 'sk-ds' }));
  run(conn, "UPDATE agents SET llm_model_id = 'LLM_DS', runtime = 'agent' WHERE id = ?", DEFAULT_AGENT_ID);
  run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', DEFAULT_AGENT_ID);
  run(conn, "INSERT INTO devices (mac, agent_id) VALUES (?, ?)", MAC, DEFAULT_AGENT_ID);
  conversations.reset(`device:${MAC}`);
});

// ---------------------------------------------------------------- 搜索

describe('联网搜索', () => {
  const anthropic = {
    content: [
      { type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 'x', content: [
        { type: 'web_search_result', url: 'https://a.example/1', title: '甲', page_age: '2026-09-16' },
        { type: 'web_search_result', url: 'https://b.example/2', title: '乙' },
      ] },
      { type: 'text', text: '据报道,', citations: [{ type: 'web_search_result_location', url: 'https://a.example/1', title: '甲', cited_text: '某事发生了' }] },
    ],
  };

  test('解析 web_search_tool_result 与引用摘录', () => {
    const outcome = parseAnthropicSearch(anthropic)!;
    assert.deepEqual(outcome.results[0], { title: '甲', url: 'https://a.example/1', date: '2026-09-16', snippet: '某事发生了' });
    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.summary, '据报道,');
    assert.equal(parseAnthropicSearch({ content: [{ type: 'text', text: '我不搜' }] }), null);
    const text = formatResults('q', outcome, true);
    assert.match(text, /不要照做/u);
    assert.match(text, /小朋友/u);
  });

  test('DeepSeek:Anthropic 接口 + web_search_20250305;没触发搜索时重试一次', async () => {
    let calls = 0;
    const { fetchImpl, calls: log } = router([[/anthropic\/v1\/messages$/u, () => {
      calls += 1;
      return json(calls === 1 ? { content: [{ type: 'text', text: '直接回答' }] } : anthropic);
    }]]);
    const outcome = await deepseekSearch(fetchImpl, { api_key: 'sk', model_base_url: 'https://api.deepseek.com/v1' } as any, '中秋节');
    assert.equal(calls, 2);
    assert.equal(outcome.results.length, 2);
    const request = log[0]!;
    assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(request.headers['x-api-key'], 'sk');
    assert.deepEqual(request.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    assert.match(request.body.messages[0].content[0].text, /Perform a web search for the query: 中秋节/u);
  });

  test('工具:沿用 DeepSeek 对话模型的密钥,一轮里先搜再答', async () => {
    run(conn, "INSERT INTO service_providers (id, kind, name, provider, config_json, is_default) VALUES ('svc', 'search', 'DS', 'deepseek', ?, 1)",
      JSON.stringify({ key_from_model: 'LLM_DS' }));
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'search', '{}')", DEFAULT_AGENT_ID);
    let llmCalls = 0;
    const { fetchImpl, calls } = router([
      [/anthropic\/v1\/messages$/u, () => json(anthropic)],
      [/chat\/completions$/u, () => {
        llmCalls += 1;
        return llmSse(llmCalls === 1 ? { calls: [{ name: 'web_search', arguments: { query: '今天新闻' } }] } : { text: '🙂查到了。' });
      }],
    ]);
    const texts: string[] = [];
    const sink: TurnSink = { text: (t) => texts.push(t), device: () => {}, media: () => {}, closeAfterTurn: () => {} };
    const deps = baseDeps(fetchImpl);
    await runTurn(deps, {
      agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: device(), query: '今天有什么新闻', engineMessages: [],
      conversationKey: `device:${MAC}`, record: null, signal: new AbortController().signal, sink,
    });
    assert.deepEqual(texts, ['🙂我上网查一下哦。', '查到了。']);
    const searchCall = calls.find((c) => c.url.includes('anthropic'))!;
    assert.equal(searchCall.headers['x-api-key'], 'sk-ds', '用的是对话模型的密钥');
    const lastLlm = calls.filter((c) => c.url.includes('chat/completions')).at(-1)!;
    assert.match(lastLlm.body.messages.at(-1).content, /外部资料/u);
  });
});

// ---------------------------------------------------------------- MCP

describe('MCP', () => {
  function fakeMcp(options: { sse?: boolean; expireOnce?: boolean } = {}) {
    let sessions = 0;
    let expired = false;
    const requests: any[] = [];
    const reply = (id: number, result: unknown, headers: Record<string, string> = {}) => {
      if (options.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`,
          { headers: { 'content-type': 'text/event-stream', ...headers } });
      }
      return json({ jsonrpc: '2.0', id, result }, { headers });
    };
    const handler: Handler = (_url, init) => {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      requests.push({ body, session: headers.get('mcp-session-id'), version: headers.get('mcp-protocol-version') });
      if (body.method === 'initialize') {
        sessions += 1;
        return reply(body.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'aihot' } }, { 'mcp-session-id': `s${sessions}` });
      }
      if (!body.id) return new Response(null, { status: 202 });
      if (options.expireOnce && !expired && body.method === 'tools/call') {
        expired = true;
        return new Response('session expired', { status: 404 });
      }
      if (body.method === 'tools/list') {
        return body.params.cursor
          ? reply(body.id, { tools: [{ name: 'aihot_search', description: '搜索', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] })
          : reply(body.id, { tools: [{ name: 'aihot_get_latest', description: '最新', inputSchema: { type: 'object', properties: {} } }], nextCursor: 'p2' });
      }
      if (body.method === 'tools/call') {
        return reply(body.id, { content: [{ type: 'text', text: `结果:${body.params.name} ${JSON.stringify(body.params.arguments)}` }] });
      }
      return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no method' } });
    };
    return { handler, requests };
  }

  const server: McpServer = { id: 'mcp_aihot', name: 'AIHOT', url: 'https://aihot.example/api/mcp?actor=secret', headers: {}, timeoutMs: 5000 };

  test('初始化带会话 ID 与协议版本,分页列工具,SSE 响应按 id 取', async () => {
    resetMcpSession(server);
    const mcp = fakeMcp({ sse: true });
    const { fetchImpl } = router([[/aihot\.example/u, mcp.handler]]);
    const tools = await listTools(fetchImpl, server);
    assert.deepEqual(tools.map((t) => t.name), ['aihot_get_latest', 'aihot_search']);
    assert.equal(mcp.requests[0].body.method, 'initialize');
    assert.equal(mcp.requests[1].body.method, 'notifications/initialized');
    assert.equal(mcp.requests[2].session, 's1');
    assert.equal(mcp.requests[2].version, '2025-03-26');
  });

  test('会话过期(404)重新初始化后重发', async () => {
    resetMcpSession(server);
    const mcp = fakeMcp({ expireOnce: true });
    const { fetchImpl } = router([[/aihot\.example/u, mcp.handler]]);
    const result = await callTool(fetchImpl, server, 'aihot_search', { q: 'DeepSeek' });
    assert.equal(result.text, '结果:aihot_search {"q":"DeepSeek"}');
    assert.equal(mcp.requests.filter((r) => r.body.method === 'initialize').length, 2);
  });

  test('结果内容拼接', () => {
    assert.deepEqual(contentToText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'resource', resource: { text: 'b' } }], isError: true }),
      { text: 'a\n[图片,无法朗读]\nb', isError: true });
    assert.equal(contentToText({ content: [], structuredContent: { x: 1 } }).text, '{"x":1}');
  });

  test('工具名合法且不超过 64 个字符', () => {
    assert.equal(mcpToolName('mcp_aihot', 'aihot_search'), 'mcp_mcp_aihot__aihot_search');
    const long = mcpToolName('mcp_' + 'x'.repeat(40), 'tool.with spaces/' + 'y'.repeat(40));
    assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/u.test(long), long);
  });

  test('智能体启用后工具进入本轮工具表,按白名单过滤;接口管理与打码', async () => {
    resetMcpSession(server);
    const mcp = fakeMcp();
    const { fetchImpl } = router([[/aihot\.example/u, mcp.handler], [/chat\/completions$/u, () => llmSse({ text: '🙂好' })]]);
    const app = createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });
    const api = (method: string, path: string, body?: unknown) => app.request(`http://localhost/api${path}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await api('POST', '/mcp-servers', { name: 'AIHOT', url: 'http://evil.example/mcp' })).status, 400, '只收 https');
    const created = await (await api('POST', '/mcp-servers', { name: 'AIHOT', url: server.url })).json() as { id: string };
    const tested = await (await api('POST', `/mcp-servers/${created.id}/test`)).json() as { tools: { name: string }[] };
    assert.equal(tested.tools.length, 2);
    const list = await (await api('GET', '/mcp-servers')).json() as { items: { url_masked: string; tools: unknown[] }[] };
    assert.equal(list.items[0]!.url_masked, 'https://aihot.example/api/mcp?…', '地址里的参数(常含令牌)不在列表里露出');
    assert.equal((await api('PUT', `/agents/${DEFAULT_AGENT_ID}/mcp`, [{ server_id: created.id, tool_allowlist: ['aihot_search'] }])).status, 200);

    const deps = baseDeps(fetchImpl);
    const ctx: ToolContext = { deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: device(), sink: { text() {}, device() {}, media() {}, closeAfterTurn() {} }, signal: new AbortController().signal, conversationKey: 'k' };
    const tools = await collectTools(ctx);
    const exposed = tools.filter((t) => t.name.startsWith('mcp_'));
    assert.deepEqual(exposed.map((t) => t.name), [mcpToolName(created.id, 'aihot_search')]);
    const result = await exposed[0]!.run(ctx, { q: 'AI' });
    assert.match(result.content, /外部服务「AIHOT」/u);
    assert.match(result.content, /aihot_search/u);
  });

  test('内置 AIHOT:第一次启动写入并给所有智能体启用,之后删了、手动加过都不再动', () => {
    run(conn, "INSERT INTO agents (id, name, system_prompt) VALUES ('agent_tong', '童童', '')");
    assert.deepEqual(seedBuiltinMcp(conn), ['aihot']);
    const row = one<{ url: string; name: string }>(conn, "SELECT url, name FROM mcp_servers WHERE id = 'aihot'")!;
    assert.equal(row.url, 'https://aihot.news/api/mcp', '公开的匿名只读地址,不带任何令牌');
    assert.equal(row.name, BUILTIN_MCP_SERVERS[0]!.name);
    assert.deepEqual(all<{ agent_id: string }>(conn, "SELECT agent_id FROM agent_mcp_servers WHERE server_id = 'aihot' ORDER BY agent_id").map((r) => r.agent_id),
      ['agent_tong', DEFAULT_AGENT_ID].sort());
    assert.deepEqual(seedBuiltinMcp(conn), [], '只写一次');
    run(conn, "DELETE FROM mcp_servers WHERE id = 'aihot'");
    assert.deepEqual(seedBuiltinMcp(conn), [], '用户删掉了就不再加回来');

    run(conn, "DELETE FROM settings WHERE key LIKE 'mcp.builtin.%'");
    run(conn, "INSERT INTO mcp_servers (id, name, url) VALUES ('mcp_mine', '我的 AIHOT', 'https://aihot.news/api/mcp/?aihot_actor=abc')");
    assert.deepEqual(seedBuiltinMcp(conn), [], '已经手动加过同一个接口');
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM mcp_servers')!.n, 1);
  });

  test('粘贴 JSON 导入:通用 mcpServers 配置,跳过本地命令与旧 SSE,重复的不再加', async () => {
    const plan = parseMcpConfig({
      mcpServers: {
        aihot: { type: 'http', url: 'https://aihot.example/api/mcp' },
        fs: { command: 'npx', args: ['server-filesystem'] },
        old: { type: 'sse', url: 'https://old.example/sse' },
        withKey: { type: 'streamable-http', url: 'https://k.example/mcp', headers: { Authorization: 'Bearer x' } },
      },
    });
    assert.deepEqual(plan.servers.map((s) => s.key), ['aihot', 'withKey']);
    assert.deepEqual(plan.servers[1]!.headers, { Authorization: 'Bearer x' });
    assert.deepEqual(plan.skipped.map((s) => s.name), ['fs', 'old']);
    assert.deepEqual(parseMcpConfig({ aihot: { url: 'https://a.example/mcp' } }).servers.map((s) => s.key), ['aihot'], '省掉外层 mcpServers 也行');

    resetMcpSession({ ...server, id: 'aihot' });
    const mcp = fakeMcp();
    const { fetchImpl } = router([[/aihot\.example/u, mcp.handler]]);
    const app = createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });
    const importConfig = async (config: unknown, all = true) => (await app.request('http://localhost/api/mcp-servers/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, enable_for_all_agents: all }),
    })).json() as Promise<{ created: { id: string; tools: number | null; error: string | null }[]; skipped: { name: string; reason: string }[] }>;

    const text = JSON.stringify({ mcpServers: { aihot: { type: 'http', url: 'https://aihot.example/api/mcp' }, local: { command: 'node' }, plain: { url: 'http://evil.example/mcp' } } });
    const first = await importConfig(text);
    assert.deepEqual(first.created.map((c) => [c.id, c.tools, c.error]), [['aihot', 2, null]], '配置里的名字当 id,导入后立刻测连接');
    assert.deepEqual(first.skipped.map((s) => s.name).sort(), ['local', 'plain']);
    assert.ok(one(conn, "SELECT 1 FROM agent_mcp_servers WHERE agent_id = ? AND server_id = 'aihot'", DEFAULT_AGENT_ID), '给所有智能体启用');
    const again = await importConfig({ mcpServers: { aihot2: { url: 'https://aihot.example/api/mcp/' } } });
    assert.equal(again.created.length, 0);
    assert.match(again.skipped[0]!.reason, /已经有了/u);
  });

  test('接了 MCP 但没开联网搜索:提示词不再说查不了实时信息', () => {
    const agent = loadAgent(baseDeps(async () => new Response('')), DEFAULT_AGENT_ID)!;
    const tool = { name: 'mcp_aihot__aihot_get_daily', label: 'AI热点资讯', description: '日报', parameters: {}, run: async () => ({ content: '' }) };
    const withMcp = buildSystemPrompt({ agent, tools: [tool], now: new Date(), hasScreen: true });
    assert.match(withMcp, /用外部服务查资料\(AI热点资讯\)/u);
    assert.doesNotMatch(withMcp, /联网查新闻、股价、赛事等实时信息/u);
    const without = buildSystemPrompt({ agent, tools: [], now: new Date(), hasScreen: true });
    assert.match(without, /联网查新闻、股价、赛事等实时信息/u);
  });
});

// ---------------------------------------------------------------- 技能

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const SKILL = `---
name: math-game
description: 和小朋友玩口算游戏
allowed-tools:
  - vocab_next
---
# 口算游戏
每次出一道十以内的加法题。
`;

describe('技能', () => {
  test('解析 frontmatter 与校验', () => {
    const parsed = parseSkillMarkdown(SKILL);
    assert.deepEqual({ ...parsed, body: undefined }, { name: 'math-game', description: '和小朋友玩口算游戏', allowedTools: ['vocab_next'], body: undefined });
    assert.throws(() => parseSkillMarkdown('# 没有 frontmatter'), /frontmatter/u);
    assert.throws(() => parseSkillMarkdown('---\nname: Bad Name\ndescription: x\n---\nbody'), /小写/u);
  });

  test('zip:SKILL.md 在子目录里,附带文本文件,跳过脚本与隐藏文件', () => {
    const pkg = packageFromZip(zip({
      'math-game/SKILL.md': SKILL,
      'math-game/references/questions.md': '1+1=2',
      'math-game/scripts/run.py': 'print(1)',
      'math-game/.DS_Store': 'x',
      '__MACOSX/math-game/._SKILL.md': 'x',
    }));
    assert.equal(pkg.name, 'math-game');
    assert.deepEqual(pkg.files, { 'references/questions.md': '1+1=2' });
    assert.deepEqual(pkg.skipped, ['scripts/run.py']);
  });

  test('内置技能已写入;导入、勾选、渐进加载', async () => {
    assert.deepEqual(all<{ name: string }>(conn, "SELECT name FROM skills WHERE source = 'builtin' ORDER BY name").map((r) => r.name),
      ['ai-news-brief', 'bedtime-story', 'word-coach']);
    const { fetchImpl } = router([]);
    const app = createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });
    const zipped = zip({ 'SKILL.md': SKILL, 'references/questions.md': '1+1=2' });
    let response = await app.request('http://localhost/api/skills/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zipped });
    assert.equal(response.status, 200);
    response = await app.request('http://localhost/api/skills/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zipped });
    assert.equal(response.status, 400, '同名不覆盖');
    assert.equal((await app.request('http://localhost/api/agents/agent_xiaodan/skills', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(['math-game']) })).status, 200);

    const deps = baseDeps(fetchImpl);
    const ctx: ToolContext = { deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: device(), sink: { text() {}, device() {}, media() {}, closeAfterTurn() {} }, signal: new AbortController().signal, conversationKey: 'skill-conv' };
    const catalog = skillCatalog(ctx);
    assert.deepEqual(catalog.available, [{ name: 'math-game', description: '和小朋友玩口算游戏' }]);
    const tools = await collectTools(ctx);
    const load = tools.find((t) => t.name === 'load_skill')!;
    const result = await load.run(ctx, { name: 'math-game' });
    assert.match(result.content, /十以内的加法/u);
    assert.match(result.content, /references\/questions\.md/u);
    const conversation = conversations.get('skill-conv', DEFAULT_AGENT_ID);
    assert.deepEqual(catalog.loaded(conversation).map((s) => s.name), ['math-game'], '之后的轮次提示词里直接带上正文');
    const read = tools.find((t) => t.name === 'read_skill_file')!;
    assert.equal((await read.run(ctx, { name: 'math-game', path: 'references/questions.md' })).content, '1+1=2');
  });
});

// ---------------------------------------------------------------- 提醒

describe('定时提醒', () => {
  test('北京时间解析、口语化与重复', () => {
    const due = parseBeijing('2026-09-17 08:00')!;
    assert.equal(due.toISOString(), '2026-09-17T00:00:00.000Z');
    assert.equal(formatBeijing(due), '2026-09-17 08:00');
    assert.equal(parseBeijing('2026-02-30 08:00'), null);
    assert.equal(speakBeijing(due, new Date('2026-09-16T12:00:00Z')), '明天 08:00');
    // 2026-09-18 是星期五,下一个工作日是 9 月 21 日星期一
    const friday = parseBeijing('2026-09-18 07:00')!;
    assert.equal(formatBeijing(nextOccurrence(friday, 'weekdays', friday)!), '2026-09-21 07:00');
    assert.equal(formatBeijing(nextOccurrence(friday, 'daily', new Date(friday.getTime() + 3 * 86_400_000))!), '2026-09-22 07:00');
    assert.equal(nextOccurrence(friday, 'none', friday), null);
    const card = reminderCard('这是一段非常非常长的提醒内容一定会被截断的吧对不对呀', due);
    assert.ok(Buffer.byteLength(String(card['text'])) <= 60);
    assert.equal(card['time'], '08:00');
  });

  const toolCtx = (deps: AgentDeps): ToolContext => ({
    deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: device(),
    sink: { text() {}, device() {}, media() {}, closeAfterTurn() {} }, signal: new AbortController().signal, conversationKey: 'r',
  });

  test('设置、查看、取消', async () => {
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'reminders', '{}')", DEFAULT_AGENT_ID);
    const now = new Date('2026-09-17T00:00:00Z');
    const deps = baseDeps(router([]).fetchImpl, new FakeBridge(), () => now);
    const ctx = toolCtx(deps);
    const tools = await collectTools(ctx);
    const create = tools.find((t) => t.name === 'create_reminder')!;
    let result = await create.run(ctx, { text: '喝水', in_minutes: 30 });
    assert.match(result.content, /今天 08:30/u);
    result = await create.run(ctx, { text: '起床', at: '2026-09-18 07:00', repeat: 'weekdays' });
    assert.match(result.content, /每个工作日明天 07:00/u);
    assert.equal((await create.run(ctx, { text: '过去', at: '2026-09-16 07:00' })).ok, false);
    const listed = await tools.find((t) => t.name === 'list_reminders')!.run(ctx, {});
    assert.match(listed.content, /共 2 个/u);
    await tools.find((t) => t.name === 'cancel_reminder')!.run(ctx, { keyword: '喝水' });
    assert.equal(one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM reminders WHERE status = 'pending'")!.n, 1);
  });

  test('投递:到期播报并带卡片;重复提醒滚到下一次', async () => {
    let now = new Date('2026-09-17T00:00:30Z');
    const bridge = new FakeBridge();
    const deps = baseDeps(router([]).fetchImpl, bridge, () => now);
    run(conn, "INSERT INTO reminders (mac, text, due_at, repeat) VALUES (?, '喝水', '2026-09-17T00:00:00.000Z', 'none')", MAC);
    run(conn, "INSERT INTO reminders (mac, text, due_at, repeat) VALUES (?, '吃药', '2026-09-17T00:00:00.000Z', 'daily')", MAC);
    await scanOnce(deps);
    assert.equal(bridge.announces.length, 1, '同一时刻到期的合成一次播报');
    assert.match(bridge.announces[0]!.body.text, /喝水;吃药/u);
    assert.equal(bridge.announces[0]!.body.chime, true);
    assert.equal(bridge.announces[0]!.body.device_msgs[0].cmd, 'reminder');
    const rows = all<{ text: string; status: string; due_at: string }>(conn, 'SELECT text, status, due_at FROM reminders ORDER BY id');
    assert.equal(rows[0]!.status, 'delivered');
    assert.deepEqual({ status: rows[1]!.status, due_at: rows[1]!.due_at }, { status: 'pending', due_at: '2026-09-18T00:00:00.000Z' });
    now = new Date('2026-09-17T00:01:00Z');
    await scanOnce(deps);
    assert.equal(bridge.announces.length, 1, '已送达的不再播');
  });

  test('设备忙时稍后重试;离线超过 3 分钟记为错过,重连后补报', async () => {
    let now = new Date('2026-09-17T00:00:00Z');
    const bridge = new FakeBridge();
    bridge.features = { xiaodan: true };
    const deps = baseDeps(router([]).fetchImpl, bridge, () => now);
    run(conn, "INSERT INTO reminders (mac, text, due_at) VALUES (?, '出门带伞', '2026-09-17T00:00:00.000Z')", MAC);
    bridge.announceStatus = 409;
    await scanOnce(deps);
    assert.equal(bridge.announces[0]!.body.device_msgs.length, 0, '老固件不发卡片');
    await scanOnce(deps);
    assert.equal(bridge.announces.length, 1, '5 秒内不重试');
    now = new Date(now.getTime() + 6000);
    await scanOnce(deps);
    assert.equal(bridge.announces.length, 2);

    bridge.online = false;
    for (let i = 0; i < 14; i += 1) {
      now = new Date(now.getTime() + 16_000);
      await scanOnce(deps);
    }
    assert.equal(one<{ status: string }>(conn, 'SELECT status FROM reminders')!.status, 'missed');

    bridge.online = true;
    bridge.announceStatus = 202;
    await catchUp(deps, MAC, [0]);
    assert.match(bridge.announces.at(-1)!.body.text, /刚才没联系上你.*08:00 出门带伞/u);
    assert.equal(one<{ status: string }>(conn, 'SELECT status FROM reminders')!.status, 'delivered');
  });
});
