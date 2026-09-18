// 记忆给模型用的函数:remember / forget / list_memories,以及把记忆注入提示词。
//
// 记忆不是「工具页里的一个工具」,它有自己的页面,所以函数走 EXTRA_TOOL_SOURCES 挂上去,
// 不进 CONSOLE_TOOLS(工具页据此列卡片)。哪个角色能用仍看 agent_plugins 里的 memory 行(智能体页的开关)。
// 网页试聊没有设备,不保存。

import { one } from '../../db.ts';
import { EXTRA_TOOL_SOURCES, PROMPT_EXTRAS } from '../registry.ts';
import type { AgentTool, ToolContext } from '../types.ts';
import { memorySettings } from './settings.ts';
import { forget, kindLabel, listMemory, memoryPrompt, remember } from './store.ts';

export const MEMORY_PLUGIN = 'memory';

export function memoryEnabled(ctx: ToolContext): boolean {
  return !!one(ctx.deps.conn, 'SELECT 1 FROM agent_plugins WHERE agent_id = ? AND plugin_code = ?', ctx.agent.id, MEMORY_PLUGIN);
}

PROMPT_EXTRAS.memory = (ctx) => (ctx.device.mac && memoryEnabled(ctx) ? memoryPrompt(ctx.deps.conn, ctx.device.mac) : undefined);

const NO_DEVICE = '现在没有连着设备(网页试聊),记忆不会保存。照常回应用户即可。';

function memoryTools(ctx: ToolContext): AgentTool[] {
  if (!memoryEnabled(ctx)) return [];
  const { scope } = memorySettings(ctx.deps.conn);

  const rememberTool: AgentTool = {
    name: 'remember',
    act: 'memory',
    label: '记住',
    description:
      '把关于用户的、以后还用得上的信息记下来,换了角色、过了几天也记得。一次记一件事,写成简短的第三人称陈述,'
      + '例如「名字叫乐乐」「最喜欢霸王龙」「妈妈的电话是 138…」。\n'
      + `${scope}\n`
      + '用户直接要求你记住某件事时照记不误。信息有变化时(比如改口说喜欢三角龙了)用 replaces 指出旧的那条。记完不用特意告诉用户。',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: '要记住的一件事,90 字以内' },
        replaces: { type: 'string', description: '被这条更新掉的旧记忆的内容(可选)' },
      },
      required: ['fact'],
    },
    hint: '记下来',
    async run(toolCtx, args) {
      if (!toolCtx.device.mac) return { ok: true, content: NO_DEVICE };
      const outcome = remember(toolCtx.deps.conn, {
        mac: toolCtx.device.mac,
        text: String(args['fact'] ?? ''),
        source: 'agent',
        agentId: toolCtx.agent.id,
        replaces: typeof args['replaces'] === 'string' ? args['replaces'] : undefined,
      });
      if (outcome.status === 'rejected') return { ok: false, content: `没有记:${outcome.reason}。不用告诉用户记忆的事,继续聊天。` };
      const verb = outcome.status === 'added' ? '已记住' : outcome.status === 'updated' ? '已更新' : '本来就记得';
      const note = outcome.row.sensitive ? '这条算私密信息,平时不要主动提起。' : '';
      return { ok: true, content: `${verb}:${outcome.row.text}。${note}继续自然地聊天。` };
    },
  };

  const forgetTool: AgentTool = {
    name: 'forget',
    act: 'memory',
    label: '忘掉',
    description: '用户要你忘掉某件关于他的事,或者说之前记错了时调用。',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: '要忘掉的内容,用记忆里的原话或其中的关键词' } },
      required: ['fact'],
    },
    async run(toolCtx, args) {
      if (!toolCtx.device.mac) return { ok: true, content: NO_DEVICE };
      const removed = forget(toolCtx.deps.conn, toolCtx.device.mac, String(args['fact'] ?? ''), 'agent', '用户要求忘掉');
      return removed.length
        ? { ok: true, content: `已忘掉:${removed.map((row) => row.text).join(';')}。用一句话告诉用户忘掉了。` }
        : { ok: false, content: '记忆里没有找到这件事。告诉用户本来就没有记着。' };
    },
  };

  const listTool: AgentTool = {
    name: 'list_memories',
    act: 'memory',
    label: '看看记得什么',
    description: '用户问「你记得我什么」「你都知道我哪些事」时调用,列出记着的事。',
    parameters: { type: 'object', properties: {} },
    async run(toolCtx) {
      if (!toolCtx.device.mac) return { ok: true, content: NO_DEVICE };
      const rows = listMemory(toolCtx.deps.conn, toolCtx.device.mac);
      if (rows.length === 0) return { ok: true, content: '还没有记住关于用户的任何事。' };
      const lines = rows.map((row) => `- (${kindLabel(row.kind)})${row.text}`);
      return { ok: true, content: `记着这些(挑几件自然地说,不要逐条念,私密信息不要主动念出来):\n${lines.join('\n')}` };
    },
  };

  return [rememberTool, forgetTool, listTool];
}

EXTRA_TOOL_SOURCES.push(memoryTools);
