// 提醒工具:设置、查看、取消。时间由模型按提示词里的「现在是北京时间 …」换算后传入。

import { CONSOLE_TOOLS } from '../registry.ts';
import type { AgentTool, ToolContext } from '../types.ts';
import { createReminder, MAX_PENDING_PER_DEVICE, pendingForDevice } from './store.ts';
import { formatBeijing, parseBeijing, REPEAT_LABEL, speakBeijing, type Repeat } from './time.ts';
import { run } from '../../db.ts';

export const REMINDER_PLUGIN = 'reminders';
const REPEATS: Repeat[] = ['none', 'daily', 'weekdays', 'weekly'];

function now(ctx: ToolContext): Date {
  return (ctx.deps.now ?? (() => new Date()))();
}

CONSOLE_TOOLS.set(REMINDER_PLUGIN, () => {
  const create: AgentTool = {
    name: 'create_reminder',
    label: '设置提醒',
    description: '设置一个定时提醒,到时间设备会响提示音并播报。用户说「X 点提醒我…」「半小时后叫我…」「每天早上七点提醒我…」时调用。' +
      '相对时间用 in_minutes;具体时间用 at(北京时间,按提示词里的当前时间换算)。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '到时要提醒的事,简短口语,例如「喝水」「出门带伞」' },
        at: { type: 'string', description: '具体时间,北京时间,格式 YYYY-MM-DD HH:mm,例如 2026-09-17 08:00' },
        in_minutes: { type: 'integer', description: '从现在起多少分钟后提醒,例如半小时后填 30' },
        repeat: { type: 'string', enum: REPEATS, description: '重复:none 不重复,daily 每天,weekdays 每个工作日,weekly 每周' },
      },
      required: ['text'],
    },
    hint: '正在设提醒',
    async run(ctx, args) {
      if (!ctx.device.mac) return { ok: false, content: '现在没有连着设备,提醒要设在设备上。如实告诉用户。' };
      const text = String(args['text'] ?? '').trim().slice(0, 100);
      if (!text) return { ok: false, content: '没有说要提醒什么,问一下用户。' };
      const current = now(ctx);
      let due: Date | null = null;
      if (typeof args['in_minutes'] === 'number' && Number.isFinite(args['in_minutes'])) {
        due = new Date(current.getTime() + Math.round(args['in_minutes']) * 60_000);
      } else if (typeof args['at'] === 'string') {
        due = parseBeijing(args['at']);
        if (!due) return { ok: false, content: `时间格式不对:${args['at']},要 YYYY-MM-DD HH:mm。` };
      }
      if (!due) return { ok: false, content: '没有说什么时候提醒,问一下用户。' };
      if (due.getTime() < current.getTime() - 60_000) return { ok: false, content: `${formatBeijing(due)} 已经过去了,跟用户确认时间。` };
      if (due.getTime() - current.getTime() > 366 * 86_400_000) return { ok: false, content: '只能设一年以内的提醒。' };
      const repeat = REPEATS.includes(args['repeat'] as Repeat) ? (args['repeat'] as Repeat) : 'none';
      if (pendingForDevice(ctx.deps.conn, ctx.device.mac).length >= MAX_PENDING_PER_DEVICE) {
        return { ok: false, content: `这台设备的提醒已经有 ${MAX_PENDING_PER_DEVICE} 个了,先取消一些。` };
      }
      const row = createReminder(ctx.deps.conn, { mac: ctx.device.mac, agentId: ctx.agent.id, text, due, repeat });
      return {
        ok: true,
        content: `已设好提醒(编号 ${row.id}):${REPEAT_LABEL[repeat]}${speakBeijing(due, current)} 提醒「${text}」。用一句话跟用户确认时间和事情。`,
      };
    },
  };

  const list: AgentTool = {
    name: 'list_reminders',
    label: '查看提醒',
    description: '查看这台设备还没到时间的提醒。用户问「我有哪些提醒」「明天有什么提醒」时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
    hint: '正在看提醒',
    async run(ctx) {
      if (!ctx.device.mac) return { ok: false, content: '现在没有连着设备。' };
      const rows = pendingForDevice(ctx.deps.conn, ctx.device.mac);
      if (rows.length === 0) return { ok: true, content: '没有待提醒的事项。' };
      const current = now(ctx);
      return {
        ok: true,
        content: `待提醒的事项共 ${rows.length} 个:\n${rows.slice(0, 20).map((r) =>
          `编号 ${r.id}:${REPEAT_LABEL[r.repeat]}${speakBeijing(new Date(r.due_at), current)} ${r.text}`).join('\n')}`,
      };
    },
  };

  const cancel: AgentTool = {
    name: 'cancel_reminder',
    label: '取消提醒',
    description: '取消提醒。知道编号就传 id;不知道就传 keyword(提醒内容里的词),会取消所有匹配的提醒。不确定是哪个时先调用 list_reminders。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '提醒编号' },
        keyword: { type: 'string', description: '提醒内容里的词' },
      },
      required: [],
    },
    hint: '正在取消提醒',
    async run(ctx, args) {
      if (!ctx.device.mac) return { ok: false, content: '现在没有连着设备。' };
      const rows = pendingForDevice(ctx.deps.conn, ctx.device.mac);
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'].trim() : '';
      const targets = typeof args['id'] === 'number'
        ? rows.filter((r) => r.id === args['id'])
        : keyword ? rows.filter((r) => r.text.includes(keyword)) : [];
      if (targets.length === 0) return { ok: false, content: '没有找到要取消的提醒。' };
      for (const row of targets) run(ctx.deps.conn, "UPDATE reminders SET status = 'cancelled' WHERE id = ?", row.id);
      return { ok: true, content: `已取消 ${targets.length} 个提醒:${targets.map((r) => r.text).join('、')}。` };
    },
  };

  return [create, list, cancel];
});
