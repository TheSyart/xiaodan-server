// 一个智能体在这一轮能用的全部工具与技能。
//
// 工具白名单沿用 agent_plugins 表(智能体页的勾选框):
//   - 引擎工具(日历、天气、音量)经设备桥调用,见 engine-tools.ts;
//   - 控制塔工具(搜索、提醒、故事、音乐、单词、画画、切换角色……)在 CONSOLE_TOOLS 里按插件代号注册;
//   - MCP 服务器与技能按智能体各自的关联表加进来。

import { all } from '../db.ts';
import type { Conversation } from './context.ts';
import { ENGINE_TOOL_META, engineTools } from './engine-tools.ts';
import type { AgentTool, ToolContext } from './types.ts';

export type ConsoleToolBuilder = (ctx: ToolContext, params: Record<string, unknown>) => AgentTool[] | Promise<AgentTool[]>;

/** 控制塔工具的注册表:插件代号 → 生成工具的函数。各功能模块在导入时往里登记。 */
export const CONSOLE_TOOLS = new Map<string, ConsoleToolBuilder>();

/** 与插件无关、按智能体其他配置追加的工具来源(MCP、技能)。 */
export const EXTRA_TOOL_SOURCES: ((ctx: ToolContext) => AgentTool[] | Promise<AgentTool[]>)[] = [];

export interface SkillCatalog {
  available: { name: string; description: string }[];
  loaded: (conversation: Conversation) => { name: string; body: string }[];
  memory?: string;
}

/** 技能目录与记忆的提供者(P3 技能、P6 记忆在导入时替换)。 */
export const PROMPT_EXTRAS: { skills: (ctx: ToolContext) => SkillCatalog } = {
  skills: () => ({ available: [], loaded: () => [] }),
};

function parseParams(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function collectTools(ctx: ToolContext): Promise<AgentTool[]> {
  const rows = all<{ plugin_code: string; params_json: string }>(
    ctx.deps.conn, 'SELECT plugin_code, params_json FROM agent_plugins WHERE agent_id = ?', ctx.agent.id,
  );
  const enabledEngine = new Map<string, Record<string, unknown>>();
  const tools: AgentTool[] = [];
  for (const row of rows) {
    const params = parseParams(row.params_json);
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
