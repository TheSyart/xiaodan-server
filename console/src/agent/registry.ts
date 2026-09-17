// 一个智能体在这一轮能用的全部能力。三类:
//   - 工具:服务端代码实现。智能体开了哪些在 agent_plugins,设置全局一份在 tool_settings(工具页)。
//       引擎工具(日历、天气、音量)经设备桥调用,见 engine-tools.ts;
//       控制塔工具(搜索、提醒、故事、音乐、单词、画画、切换角色……)在 CONSOLE_TOOLS 里按工具代号注册;
//   - MCP:智能体开了哪些服务器在 agent_mcp_servers,服务器对外提供哪些工具在 MCP 页设置;
//   - 技能:智能体开了哪些在 agent_skills。

import { all } from '../db.ts';
import type { Conversation } from './context.ts';
import { ENGINE_TOOL_META, engineTools } from './engine-tools.ts';
import { toolConfig } from './tool-settings.ts';
import type { AgentTool, ToolContext } from './types.ts';

export type ConsoleToolBuilder = (ctx: ToolContext, params: Record<string, unknown>) => AgentTool[] | Promise<AgentTool[]>;

/** 控制塔工具的注册表:插件代号 → 生成工具的函数。各功能模块在导入时往里登记。 */
export const CONSOLE_TOOLS = new Map<string, ConsoleToolBuilder>();

/** 与插件无关、按智能体其他配置追加的工具来源(MCP、技能)。 */
export const EXTRA_TOOL_SOURCES: ((ctx: ToolContext) => AgentTool[] | Promise<AgentTool[]>)[] = [];

export interface SkillCatalog {
  available: { name: string; description: string }[];
  loaded: (conversation: Conversation) => { name: string; body: string }[];
}

/** 提示词里按智能体与设备追加的内容:技能目录(skills/tools.ts)、长期记忆(memory/tools.ts),各自在导入时替换。 */
export const PROMPT_EXTRAS: {
  skills: (ctx: ToolContext) => SkillCatalog;
  memory: (ctx: ToolContext) => string | undefined;
} = {
  skills: () => ({ available: [], loaded: () => [] }),
  memory: () => undefined,
};

export async function collectTools(ctx: ToolContext): Promise<AgentTool[]> {
  const rows = all<{ plugin_code: string }>(ctx.deps.conn, 'SELECT plugin_code FROM agent_plugins WHERE agent_id = ?', ctx.agent.id);
  const enabledEngine = new Map<string, Record<string, unknown>>();
  const tools: AgentTool[] = [];
  for (const row of rows) {
    const params = toolConfig(ctx.deps.conn, row.plugin_code);
    if (ENGINE_TOOL_META[row.plugin_code]) {
      enabledEngine.set(row.plugin_code, params);
      continue;
    }
    const builder = CONSOLE_TOOLS.get(row.plugin_code);
    if (builder) {
      try {
        tools.push(...(await builder(ctx, params)));
      } catch (error) {
        ctx.deps.log?.(`工具 ${row.plugin_code} 初始化失败:${(error as Error).message}`);
      }
    }
  }
  if (enabledEngine.size) tools.unshift(...(await engineTools(ctx, enabledEngine)));
  for (const source of EXTRA_TOOL_SOURCES) {
    try {
      tools.push(...(await source(ctx)));
    } catch (error) {
      ctx.deps.log?.(`工具来源初始化失败:${(error as Error).message}`);
    }
  }
  // 同名只留第一个;模型接口不接受重名函数
  const seen = new Set<string>();
  return tools.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)));
}

export function skillCatalog(ctx: ToolContext): SkillCatalog {
  return PROMPT_EXTRAS.skills(ctx);
}

export function memoryFor(ctx: ToolContext): string | undefined {
  try {
    return PROMPT_EXTRAS.memory(ctx);
  } catch (error) {
    ctx.deps.log?.(`读取长期记忆失败:${(error as Error).message}`);
    return undefined;
  }
}
