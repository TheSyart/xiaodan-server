// 工具页接口(挂在 /api/tools)。工具是服务端代码实现的能力,页面上只能查看和改设置,不能新建或删除;
// 设置全局一份(tool_settings),智能体页只决定开不开。联网搜索的服务商仍在 /api/service-providers 增删改查,工具页里嵌着管理。

import { Hono } from 'hono';
import { z } from 'zod';
import { all, one } from '../db.ts';
import { PLUGINS, pluginDef, type PluginDef } from '../catalog.ts';
import { ENGINE_TOOL_META } from './engine-tools.ts';
import { imageModel } from './image/run.ts';
import { CONSOLE_TOOLS } from './registry.ts';
import { loadAgent } from './routes.ts';
import { defaultService } from './services.ts';
import { fieldOptions, saveToolConfig, toolConfig, validateToolConfig } from './tool-settings.ts';
import type { AgentDeps, ToolContext } from './types.ts';

export interface ToolStatus {
  ready: boolean;
  /** 不能用时的原因,以及去哪里补 */
  message: string;
}

/** 工具现在能不能用:缺服务商、缺模型、内容库是空的 */
export function toolStatus(deps: Pick<AgentDeps, 'conn'>, code: string): ToolStatus {
  const { conn } = deps;
  const count = (sql: string, ...params: unknown[]) => one<{ n: number }>(conn, sql, ...params)?.n ?? 0;
  switch (code) {
    case 'search':
      return defaultService(conn, 'search') ? { ready: true, message: '' } : { ready: false, message: '还没有配置搜索服务' };
    case 'image': {
      const modelId = toolConfig(conn, 'image')['model_id'];
      return imageModel(deps, typeof modelId === 'string' ? modelId : null)
        ? { ready: true, message: '' } : { ready: false, message: '还没有文生图模型,先在「模型」页添加' };
    }
    case 'stories':
      return count("SELECT COUNT(*) AS n FROM media_items WHERE kind = 'story' AND enabled = 1")
        ? { ready: true, message: '' } : { ready: false, message: '故事库是空的,在「内容库」页添加' };
    case 'music':
      return count("SELECT COUNT(*) AS n FROM media_items WHERE kind = 'music' AND enabled = 1 AND audio_status = 'ready'")
        ? { ready: true, message: '' } : { ready: false, message: '曲库是空的,在「内容库」页添加' };
    case 'vocab':
      return count('SELECT COUNT(*) AS n FROM vocab_books')
        ? { ready: true, message: '' } : { ready: false, message: '还没有单词书,在「内容库」页导入' };
    default:
      return { ready: true, message: '' };
  }
}

/**
 * 模型看到的函数。有的工具按固件给不同的函数(学单词:新固件用卡组,老固件一个个显示),两套都列出来并注明,
 * 技能依赖哪个函数都能对上。
 */
async function functionsOf(deps: AgentDeps, def: PluginDef): Promise<{ name: string; description: string }[]> {
  const engine = ENGINE_TOOL_META[def.code];
  if (engine) return [{ name: engine.spec.function.name, description: engine.spec.function.description }];
  const builder = CONSOLE_TOOLS.get(def.code);
  const agentRow = one<{ id: string }>(deps.conn, 'SELECT id FROM agents ORDER BY is_default DESC, created_at LIMIT 1');
  const agent = agentRow ? loadAgent(deps, agentRow.id) : undefined;
  if (!builder || !agent) return [];
  const build = async (xiaodan: number) => {
    const ctx: ToolContext = {
      deps, agent,
      device: { mac: null, sessionId: null, turnId: null, clientIp: null, features: { xiaodan } },
      sink: { text() {}, device() {}, media() {}, closeAfterTurn() {} },
      signal: new AbortController().signal,
      conversationKey: 'tools-page',
    };
    try {
      return (await builder(ctx, toolConfig(deps.conn, def.code))).map((tool) => ({ name: tool.name, description: tool.description }));
    } catch {
      return [];
    }
  };
  const current = await build(3);
  const legacy = await build(2);
  const names = new Set(current.map((fn) => fn.name));
  const legacyNames = new Set(legacy.map((fn) => fn.name));
  return [
    ...current.map((fn) => (legacyNames.has(fn.name) ? fn : { ...fn, description: `(新固件才有)${fn.description}` })),
    ...legacy.filter((fn) => !names.has(fn.name)).map((fn) => ({ ...fn, description: `(老固件才有)${fn.description}` })),
  ];
}

/** 技能声明的 allowed-tools 里有没有这个函数(支持 * 通配) */
export function skillNeeds(allowedTools: string, functionName: string): boolean {
  return allowedTools.split(/[,\s]+/u).filter(Boolean).some((pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u').test(functionName));
}

export function toolRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  const view = async (def: PluginDef) => {
    const functions = await functionsOf(deps, def);
    const skills = all<{ name: string; allowed_tools: string }>(conn, 'SELECT name, allowed_tools FROM skills ORDER BY name')
      .filter((skill) => functions.some((fn) => skillNeeds(skill.allowed_tools, fn.name)))
      .map((skill) => skill.name);
    return {
      code: def.code,
      label: def.label,
      description: def.description,
      group: def.group,
      keyless: def.keyless,
      runs_in: ENGINE_TOOL_META[def.code] ? 'engine' : 'console',
      fields: def.fields.map((field) => (field.optionsFrom ? { ...field, options: fieldOptions(conn, field) } : field)),
      config: toolConfig(conn, def.code),
      functions,
      status: toolStatus(deps, def.code),
      agents: all<{ id: string; name: string }>(conn,
        'SELECT g.id, g.name FROM agent_plugins p JOIN agents g ON g.id = p.agent_id WHERE p.plugin_code = ? ORDER BY g.is_default DESC, g.created_at', def.code),
      skills,
    };
  };

  app.get('/', async (c) => c.json({ items: await Promise.all(PLUGINS.map(view)) }));

  app.get('/:code', async (c) => {
    const def = pluginDef(c.req.param('code'));
    if (!def) return c.json({ error: '没有这个工具' }, 404);
    return c.json(await view(def));
  });

  /** 改设置:按工具声明的字段校验,整体覆盖 */
  app.put('/:code', async (c) => {
    const def = pluginDef(c.req.param('code'));
    if (!def) return c.json({ error: '没有这个工具' }, 404);
    const parsed = z.object({ config: z.record(z.string(), z.unknown()) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);
    const result = validateToolConfig(conn, def, parsed.data.config);
    if ('error' in result) return c.json({ error: result.error }, 400);
    saveToolConfig(conn, def.code, result.config);
    return c.json({ ok: true, config: result.config });
  });

  return app;
}
