// 联网搜索工具。用「工具与服务」页里默认的搜索服务商。

import { CONSOLE_TOOLS } from '../registry.ts';
import { defaultService } from '../services.ts';
import type { AgentTool } from '../types.ts';
import { formatResults, SEARCH_PROVIDERS, SearchError } from './providers.ts';

export const SEARCH_PLUGIN = 'search';

CONSOLE_TOOLS.set(SEARCH_PLUGIN, (ctx) => {
  const tool: AgentTool = {
    name: 'web_search',
    act: 'search',
    label: '联网搜索',
    description: '联网搜索最新的信息,例如新闻、赛事比分、股价、上映的电影、刚发布的产品、你不确定的事实。问题需要实时或最新信息时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词,简洁、包含关键实体,例如「2026 年中秋节是几号」' },
      },
      required: ['query'],
    },
    timeoutMs: 60_000,
    progress: '我上网查一下哦。',
    hint: '正在联网搜索',
    async run(toolCtx, args) {
      const query = typeof args['query'] === 'string' ? args['query'].trim().slice(0, 200) : '';
      if (!query) return { ok: false, content: '没有给出搜索词。' };
      const service = defaultService(toolCtx.deps.conn, 'search');
      if (!service) return { ok: false, content: '还没有配置搜索服务(控制塔「工具与服务」页)。如实告诉用户现在查不了。' };
      const provider = SEARCH_PROVIDERS[service.provider];
      if (!provider) return { ok: false, content: `不认识的搜索服务商:${service.provider}` };
      try {
        const outcome = await provider(toolCtx.deps.fetch, service.config, query, toolCtx.signal);
        return { ok: true, content: formatResults(query, outcome, toolCtx.agent.safety_level === 'child') };
      } catch (error) {
        const message = error instanceof SearchError ? error.message : (error as Error).message;
        return { ok: false, content: `搜索失败:${message}。如实告诉用户这次没查到。` };
      }
    },
  };
  void ctx;
  return [tool];
});
