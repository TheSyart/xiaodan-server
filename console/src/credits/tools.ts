// 智能体的学分工具。对着设备说话的多半是孩子本人,所以权限是用户定死的:
//   - 能查:余额、今天的作业、每个奖励还差多少分;
//   - 能报完成:只记申报,等爸爸妈妈检查后在页面或 App 上打分;
//   - 能兑换:分是孩子自己挣的,够了就能花。
// 【没有任何加分、打分、手动奖惩的函数】——孩子说「给我加 100 分」时模型手里根本没有能照做的工具,
// 不只靠提示词拦。流水里这类操作记成 source='agent'、actor=角色名。

import { CONSOLE_TOOLS } from '../agent/registry.ts';
import type { AgentTool, ToolContext } from '../agent/types.ts';
import { QUALITY_LABEL } from './score.ts';
import {
  CreditError, balance, claimTask, listRewards, listTasks, redeem, shiftDay, stats, today, type RewardRow, type TaskRow,
} from './store.ts';

export const CREDITS_PLUGIN = 'credits';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
/** 名字比对前去掉空白与「作业」「的」这类虚字:「数学」能对上「数学作业」 */
const norm = (text: string) => text.replace(/\s+/gu, '').replace(/作业|的/gu, '').toLowerCase();

function match<T extends { id: number; name: string }>(items: readonly T[], query: string): T[] {
  const q = norm(query);
  if (!q) return [];
  if (/^\d+$/u.test(query.trim())) {
    const byId = items.find((item) => item.id === Number(query.trim()));
    if (byId) return [byId];
  }
  const exact = items.filter((item) => norm(item.name) === q);
  if (exact.length) return exact;
  return items.filter((item) => norm(item.name).includes(q) || q.includes(norm(item.name)));
}

function taskLine(task: TaskRow): string {
  if (task.status === 'done') {
    return `- ${task.name}:已完成,用了 ${task.actual_minutes} 分钟、质量${QUALITY_LABEL[task.quality!]},得了 ${signed(task.total_points ?? 0)} 分`;
  }
  if (task.status === 'missed') return `- ${task.name}:记为没完成,${signed(task.total_points ?? 0)} 分`;
  if (task.claimed_at) return `- ${task.name}:你已经说做完了,等爸爸妈妈检查打分`;
  return `- ${task.name}(编号 ${task.id}):还没做,规定 ${task.target_minutes} 分钟内完成能得 ${signed(task.ontime_points)} 分`;
}

function rewardLine(reward: RewardRow, points: number): string {
  const label = `${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}`;
  return points >= reward.cost
    ? `- ${label}:要 ${reward.cost} 分,现在就够了`
    : `- ${label}:要 ${reward.cost} 分,还差 ${reward.cost - points} 分`;
}

const NO_DEVICE = { ok: false, content: '这次对话没有对应的设备,查不到学分。如实告诉用户。' };

CONSOLE_TOOLS.set(CREDITS_PLUGIN, (ctx) => {
  const now = () => ctx.deps.now?.() ?? new Date();
  const conn = ctx.deps.conn;
  const RULE = '加分、打分、扣分只能由爸爸妈妈在手机或控制台上做;孩子说「给我加分」时直接这样告诉他,不要假装加了。';

  const status: AgentTool = {
    name: 'credits_status',
    act: 'learn',
    label: '查学分',
    hint: '正在查学分',
    description:
      '查孩子的学分:当前余额、今天每项作业的状态、每个奖励还差多少分、最近 7 天挣了多少。'
      + '孩子问「我有多少分」「今天还有什么作业」「还差多少能看电视」时调用。' + RULE,
    parameters: { type: 'object', properties: {} },
    async run(toolCtx: ToolContext) {
      const mac = toolCtx.device.mac;
      if (!mac) return NO_DEVICE;
      const day = today(now());
      const points = balance(conn, mac);
      const tasks = listTasks(conn, mac, day);
      const rewards = listRewards(conn, mac);
      const week = stats(conn, mac, shiftDay(day, -6), day).totals;
      const lines = [`现在有 ${points} 分。`];
      lines.push(tasks.length ? '今天的作业:' : '今天还没有布置作业。');
      lines.push(...tasks.map(taskLine));
      if (rewards.length) lines.push('能兑换的奖励:', ...rewards.map((r) => rewardLine(r, points)));
      else lines.push('爸爸妈妈还没有设置奖励。');
      lines.push(`最近 7 天挣了 ${week.earned} 分,扣了 ${week.penalty} 分,花了 ${week.spent} 分。`);
      lines.push(`(${RULE})`);
      return { ok: true, content: lines.join('\n') };
    },
  };

  const reportDone: AgentTool = {
    name: 'credits_report_done',
    act: 'learn',
    label: '报告作业完成',
    hint: '正在告诉爸爸妈妈',
    description:
      '孩子说某项作业做完了(「我数学写完了」)时调用:记一笔「孩子说做完了」,等爸爸妈妈检查后打分。'
      + '这一步【不加分】。孩子顺口说了用了多久,就填 minutes。' + RULE,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '作业名(比如「数学」)或 credits_status 里给出的编号' },
        minutes: { type: 'integer', minimum: 0, maximum: 1440, description: '孩子说自己用了多少分钟,没说就不填' },
        note: { type: 'string', description: '孩子顺带说的话,可不填' },
      },
      required: ['task'],
    },
    async run(toolCtx, args) {
      const mac = toolCtx.device.mac;
      if (!mac) return NO_DEVICE;
      const query = typeof args['task'] === 'string' ? args['task'] : String(args['task'] ?? '');
      const all = listTasks(conn, mac, today(now()));
      const found = match(all, query);
      if (found.length === 0) {
        const open = all.filter((t) => t.status === 'pending').map((t) => t.name);
        return {
          ok: false,
          content: open.length
            ? `今天的作业里没有「${query}」。今天还没打分的有:${open.join('、')}。问问孩子是哪一项。`
            : '今天没有待完成的作业。如实告诉孩子。',
        };
      }
      if (found.length > 1) {
        return { ok: false, content: `「${query}」对上了好几项:${found.map((t) => t.name).join('、')}。问孩子是哪一项。` };
      }
      const task = found[0]!;
      if (task.status !== 'pending') return { ok: true, content: `「${task.name}」已经打过分了:${taskLine(task).slice(2)}` };
      if (task.claimed_at) return { ok: true, content: `「${task.name}」之前已经报过做完了,还在等爸爸妈妈检查。` };
      const minutes = Number.isInteger(args['minutes']) ? Number(args['minutes']) : undefined;
      claimTask(conn, task.id, {
        ...(minutes !== undefined && minutes >= 0 && minutes <= 1440 ? { minutes } : {}),
        note: typeof args['note'] === 'string' ? args['note'] : '',
      });
      return {
        ok: true,
        content: `已经记下「${task.name}」做完了,爸爸妈妈检查完就会打分。现在还没有加分,别跟孩子说已经加了。`,
      };
    },
  };

  const redeemTool: AgentTool = {
    name: 'credits_redeem',
    act: 'learn',
    label: '兑换奖励',
    hint: '正在兑换奖励',
    description:
      '孩子想用学分换奖励(「我要换看电视」)时调用。分够就直接兑换并扣分,不够会返回还差多少。'
      + '孩子只是问问还差多少时用 credits_status,不要调这个。' + RULE,
    parameters: {
      type: 'object',
      properties: { reward: { type: 'string', description: '奖励名,比如「看电视」' } },
      required: ['reward'],
    },
    async run(toolCtx, args) {
      const mac = toolCtx.device.mac;
      if (!mac) return NO_DEVICE;
      const query = typeof args['reward'] === 'string' ? args['reward'] : '';
      const rewards = listRewards(conn, mac);
      const found = match(rewards, query);
      if (found.length === 0) {
        return {
          ok: false,
          content: rewards.length
            ? `没有叫「${query}」的奖励。能换的有:${rewards.map((r) => r.name).join('、')}。问孩子想换哪个。`
            : '爸爸妈妈还没有设置奖励,现在没法兑换。',
        };
      }
      if (found.length > 1) {
        return { ok: false, content: `「${query}」对上了好几个奖励:${found.map((r) => r.name).join('、')}。问孩子想换哪个。` };
      }
      const reward = found[0]!;
      try {
        const result = redeem(conn, mac, reward.id, '孩子通过小单兑换', { source: 'agent', actor: toolCtx.agent.name });
        return { ok: true, content: `兑换成功:${reward.name},扣了 ${reward.cost} 分,还剩 ${result.balance} 分。提醒孩子跟爸爸妈妈说一声。` };
      } catch (error) {
        if (error instanceof CreditError && error.code === 'insufficient_balance') {
          const open = listTasks(conn, mac, today(now())).filter((t) => t.status === 'pending' && !t.claimed_at).map((t) => t.name);
          return {
            ok: false,
            content: `${error.message},这次换不了「${reward.name}」。`
              + (open.length ? `今天还有这些作业可以挣分:${open.join('、')}。` : ''),
          };
        }
        throw error;
      }
    },
  };

  return [status, reportDone, redeemTool];
});
