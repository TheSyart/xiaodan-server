// 自我介绍工具:开了才有、稿子可以在工具页换、太长会截断,交给模型的话要求一字不改地念。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { collectTools } from '../src/agent/registry.ts';
import { DEFAULT_SCRIPT, INTRO_PLUGIN, MAX_SCRIPT_CHARS, introPrompt } from '../src/agent/intro.ts';
import '../src/agent/index.ts';
import type { AgentRow, ToolContext } from '../src/agent/types.ts';

let conn: Db;

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
});

/** 收集工具只用到 deps.conn 与 agent，其余字段这里用不上 */
function ctx(): ToolContext {
  const agent = { id: DEFAULT_AGENT_ID, safety_level: 'child' } as AgentRow;
  return { deps: { conn }, agent } as unknown as ToolContext;
}

const enable = (params = '{}') =>
  run(conn, 'INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, ?)',
    DEFAULT_AGENT_ID, INTRO_PLUGIN, params);

describe('自我介绍', () => {
  test('角色没开这个工具时模型看不到它', async () => {
    const tools = await collectTools(ctx());
    assert.equal(tools.find((t) => t.name === 'introduce_self'), undefined);
  });

  test('开了就有,念的是内置稿子', async () => {
    enable();
    const tool = (await collectTools(ctx())).find((t) => t.name === 'introduce_self')!;
    assert.ok(tool, '开了之后应该有这个工具');
    assert.match(tool.description, /你是谁/u, '说明里要写清什么时候调用');

    const result = await tool.run(ctx(), {});
    assert.equal(result.ok, true);
    assert.equal(result.longAnswer, true, '稿子很长,要放宽这一轮的输出上限');
    assert.match(result.content, /一字不改/u, '要交代模型别改写');
    assert.match(result.content, /激情/u, '要交代语气');
    assert.ok(result.content.includes(DEFAULT_SCRIPT), '稿子要完整带上');
  });

  test('工具页换了稿子就念新的', async () => {
    enable();
    run(conn, "INSERT INTO tool_settings (code, config_json) VALUES (?, ?)",
      INTRO_PLUGIN, JSON.stringify({ script: '我是小单,很高兴认识你!' }));
    const tool = (await collectTools(ctx())).find((t) => t.name === 'introduce_self')!;
    const result = await tool.run(ctx(), {});
    assert.match(result.content, /很高兴认识你/u);
    assert.doesNotMatch(result.content, /99 元/u, '换了稿子就不该再出现内置那份');
  });

  test('稿子留空回落到内置那份;超长截断,不让它念个没完', async () => {
    enable();
    run(conn, "INSERT INTO tool_settings (code, config_json) VALUES (?, ?)",
      INTRO_PLUGIN, JSON.stringify({ script: '   ' }));
    let tool = (await collectTools(ctx())).find((t) => t.name === 'introduce_self')!;
    assert.ok((await tool.run(ctx(), {})).content.includes(DEFAULT_SCRIPT), '空白稿子应该回落到内置');

    run(conn, "UPDATE tool_settings SET config_json = ? WHERE code = ?",
      JSON.stringify({ script: '啦'.repeat(MAX_SCRIPT_CHARS + 500) }), INTRO_PLUGIN);
    tool = (await collectTools(ctx())).find((t) => t.name === 'introduce_self')!;
    const content = (await tool.run(ctx(), {})).content;
    assert.equal(content.length - introPrompt('').length, MAX_SCRIPT_CHARS);
  });

  test('内置稿子是念出来的:不带 markdown 标记', () => {
    assert.doesNotMatch(DEFAULT_SCRIPT, /\*\*/u, '** 会被合成念成「星号」');
    assert.ok(DEFAULT_SCRIPT.length <= MAX_SCRIPT_CHARS, '内置稿子自己不能超过上限');
  });
});

// 工具页保存介绍稿这条路:整段文字曾被写死的 200 字上限卡住,存不进去。
describe('工具页保存介绍稿', () => {
  test('介绍稿能存下整段,其余文字字段仍是 200 字', async () => {
    const { validateToolConfig } = await import('../src/agent/tool-settings.ts');
    const { PLUGINS } = await import('../src/catalog.ts');
    const intro = PLUGINS.find((p) => p.code === INTRO_PLUGIN)!;
    assert.ok(intro, '工具目录里要有这条');

    const saved = validateToolConfig(conn, intro, { script: DEFAULT_SCRIPT });
    assert.ok('config' in saved, `内置稿子自己都存不下:${JSON.stringify(saved)}`);
    assert.equal(saved.config['script'], DEFAULT_SCRIPT);

    const tooLong = validateToolConfig(conn, intro, { script: '啦'.repeat(MAX_SCRIPT_CHARS + 1) });
    assert.ok('error' in tooLong, '超过上限要挡住');

    // 没声明上限的字段不受影响
    const weather = PLUGINS.find((p) => p.fields.some((f) => f.type === 'text' && f.maxLength === undefined));
    if (weather) {
      const field = weather.fields.find((f) => f.type === 'text' && f.maxLength === undefined)!;
      const result = validateToolConfig(conn, weather, { [field.key]: '啦'.repeat(201) });
      assert.ok('error' in result, '没声明上限的还是 200 字');
    }
  });
});
