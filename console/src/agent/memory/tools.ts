// 记忆给模型用的函数:remember / forget / list_memories,以及把记忆注入提示词。
//
// 记忆不是「工具页里的一个工具」,它有自己的页面,所以函数走 EXTRA_TOOL_SOURCES 挂上去,
// 不进 CONSOLE_TOOLS(工具页据此列卡片)。哪个角色能用仍看 agent_plugins 里的 memory 行(智能体页的开关)。
// 网页试聊没有设备,不保存。

import { one } from '../../db.ts';
import { EXTRA_TOOL_SOURCES, PROMPT_EXTRAS } from '../registry.ts';
import type { AgentTool, ToolContext } from '../types.ts';
import { arcById, arcMessages, arcsNote, listArcs } from './arcs.ts';
import { memorySettings } from './settings.ts';
import { forget, kindLabel, listMemory, memoryPrompt, remember } from './store.ts';

export const MEMORY_PLUGIN = 'memory';

export function memoryEnabled(ctx: ToolContext): boolean {
  return !!one(ctx.deps.conn, 'SELECT 1 FROM agent_plugins WHERE agent_id = ? AND plugin_code = ?', ctx.agent.id, MEMORY_PLUGIN);
}

PROMPT_EXTRAS.memory = (ctx) => {
  const mac = ctx.device.mac;
  if (!mac || !memoryEnabled(ctx)) return undefined;
  const facts = memoryPrompt(ctx.deps.conn, mac) ?? { facts: '', sensitiveNote: '', arcs: '' };
  const arcs = arcsNote(ctx.deps.conn, mac);
  if (!facts.facts && !facts.sensitiveNote && !arcs) return undefined;
  return { ...facts, arcs };
};

/** 一条档案在工具结果里的样子 */
const arcLine = (arc: { id: number; ended_at: string; title: string; summary: string; bullets: string[] }) =>
  `[#${arc.id}] ${arc.ended_at.slice(0, 10)} ${arc.title}${arc.summary ? ` —— ${arc.summary}` : ''}`
  + (arc.bullets.length ? `\n    ${arc.bullets.join(';')}` : '');

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

  const recallTool: AgentTool = {
    name: 'recall_memory',
    act: 'memory',
    label: '回想以前聊过的',
    description:
      '回想以前聊过的事。用户问「你还记得上次我们聊的那个吗」「我上周说的那件事」,或者你需要以前的细节才能接着聊时调用。'
      + '给 query 按关键词找,给 since/until 按日期找;拿到某一段的编号后,再用 arc_id 把那一段的原话调出来。'
      + '这里也能取到平时不带在身边的私密信息(住址、联系方式),只在真的要用时取。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词,比如「恐龙」「幼儿园」' },
        since: { type: 'string', description: '起始日期 YYYY-MM-DD(可选)' },
        until: { type: 'string', description: '截止日期 YYYY-MM-DD(可选)' },
        arc_id: { type: 'integer', description: '要看原话的那一段的编号(可选)' },
        limit: { type: 'integer', description: '最多返回几段,默认 5' },
      },
    },
    hint: '正在回想',
    async run(toolCtx, args) {
      const mac = toolCtx.device.mac;
      if (!mac) return { ok: true, content: NO_DEVICE };
      const conn = toolCtx.deps.conn;

      const arcId = Number(args['arc_id']);
      if (Number.isFinite(arcId) && arcId > 0) {
        const arc = arcById(conn, arcId);
        if (!arc || arc.mac !== mac) return { ok: false, content: `没有编号 ${arcId} 的那段对话。` };
        if (arc.status === 'raw_gone') {
          return { ok: true, content: `这段对话的原话已经按保留策略清掉了,只剩摘要:${arc.title} —— ${arc.summary}` };
        }
        const rows = arcMessages(conn, arc.id, false);
        let text = '';
        for (const row of rows) {
          const line = `${row.chat_type === 1 ? '用户' : '你'}:${row.content}\n`;
          if (text.length + line.length > 2500) {
            text = `…(前面省略)…\n${text}`;
            break;
          }
          text += line;
        }
        return { ok: true, content: `${arc.ended_at.slice(0, 10)} 那段对话的原话:\n${text.trim() || '(没有内容)'}` };
      }

      const query = typeof args['query'] === 'string' ? args['query'] : '';
      const limit = Math.min(Math.max(Number(args['limit']) || 5, 1), 8);
      const { items } = listArcs(conn, {
        mac,
        ...(query ? { q: query } : {}),
        ...(typeof args['since'] === 'string' && args['since'] ? { since: args['since'] } : {}),
        ...(typeof args['until'] === 'string' && args['until'] ? { until: `${args['until']} 23:59:59` } : {}),
        limit,
      });
      const ready = items.filter((arc) => arc.title);
      if (!ready.length) {
        return { ok: true, content: query ? `以前没有聊到过「${query}」。如实告诉用户想不起来,不要编。` : '还没有整理好的对话。' };
      }
      const lines = ready.map((arc) => arcLine({
        id: arc.id,
        ended_at: arc.ended_at,
        title: arc.title,
        summary: arc.summary,
        bullets: (JSON.parse(arc.bullets_json || '[]') as string[]).slice(0, 3),
      }));
      return {
        ok: true,
        content: `以前聊过这些:\n${lines.join('\n')}\n想看某一段的原话就再调一次,带上它的编号。用一两句口语说给用户听,不要念编号。`,
      };
    },
  };

  return [rememberTool, forgetTool, listTool, recallTool];
}

EXTRA_TOOL_SOURCES.push(memoryTools);
