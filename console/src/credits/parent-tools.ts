// 智能体的大人版学分工具:给家长用,完全权限——布置作业、打分、记没完成、改作业、驳回申报、
// 加减分、代兑换、撤销、增删改规则与奖励、看历史,都能用说话完成。
//
// 它就是一个普通工具:开在哪个角色上就在哪儿生效,代码不另做拦截。开在孩子玩具的角色上,
// 对着玩具说话的人就都有这些权限(控制台工具目录里写明了)——孩子的玩具请开儿童版 credits。
// 删除、撤销、大额加减分前先跟家长确认,只写在函数说明里,靠模型遵守。
//
// 业务逻辑全部复用 store.ts,和页面、外部接口是同一套;流水记 source='agent'、actor=角色名。
// 家长 App 自己也是一台设备(board = xiaodan-app),它不是孩子,所以「操作哪个孩子」要另外定:
// 填了 child 就按名字 / MAC 找;没填时当前设备是玩具就用它,只有一个孩子就用那一个,否则让模型问。

import { CONSOLE_TOOLS } from '../agent/registry.ts';
import type { AgentTool, ToolContext, ToolResult } from '../agent/types.ts';
import { canonicalMac } from '../identity.ts';
import { childDevice, childDevices } from './devices.ts';
import { QUALITIES, QUALITY_LABEL, type Quality } from './score.ts';
import { PARAM_DESCRIPTIONS, RULE_RANGES } from './schemas.ts';
import {
  CreditError, PARAM_KEYS, adjust, assignTasks, balance, createCustomTask, createReward, createRule, deleteReward, deleteRule,
  deleteTask, ledgerById, ledgerPage, listRewards, listRules, listTasks, missTask, queryTasks, redeem, restoreReward,
  restoreRule, revert, scoreTask, shiftDay, stats, taskById, today, unclaimTask, updateReward, updateRule, updateTask,
  walletBalance, walletById, walletRows, walletSummary,
  type Actor, type LedgerRow, type RewardRow, type RuleInput, type RuleRow, type TaskRow,
} from './store.ts';
import { match, norm, redeemTimes, rewardRate, signed, walletLine } from './tools.ts';
import { formatQty, KIND_LABEL, REWARD_KINDS, toBase, UNIT, type RewardKind } from './units.ts';
import { walletAdjust, walletOut, walletRevert, walletUse, type WalletEntry } from './wallet.ts';

export const CREDITS_PARENT_PLUGIN = 'credits_parent';

interface Child { mac: string; alias: string }

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;
const CONFIRM = '删除、撤销,或者一次加减 50 分及以上之前,先跟家长复述一遍要做什么、得到确认再调用。';
const QUALITY_WORDS: Record<string, Quality> = { 优: 'excellent', 良: 'good', 中: 'fair', 差: 'poor' };

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
const intArg = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
};
const childName = (child: Child) => child.alias || child.mac;
const fail = (content: string): ToolResult => ({ ok: false, content });

function ruleLine(rule: RuleRow): string {
  return `- ${rule.name}(编号 ${rule.id}${rule.archived ? ',已停用' : ''}):规定 ${rule.target_minutes} 分钟,按时 ${signed(rule.ontime_points)},`
    + `超时每 ${rule.overtime_step} 分钟扣 ${rule.overtime_penalty} 最多扣 ${rule.overtime_cap},`
    + `质量优/良/中/差 ${signed(rule.q_excellent)}/${signed(rule.q_good)}/${signed(rule.q_fair)}/${signed(rule.q_poor)},没完成扣 ${rule.missed_penalty}`;
}

function taskLine(task: TaskRow): string {
  const head = `- ${task.name}(编号 ${task.id},${task.day})`;
  if (task.status === 'done') {
    return `${head}:已打分,用时 ${task.actual_minutes} 分钟、质量${QUALITY_LABEL[task.quality!]},${signed(task.total_points ?? 0)} 分`;
  }
  if (task.status === 'missed') return `${head}:记为没完成,${signed(task.total_points ?? 0)} 分`;
  const claim = task.claimed_at
    ? `,孩子说做完了${task.claimed_minutes !== null ? `(说用了 ${task.claimed_minutes} 分钟)` : ''}${task.claim_note ? `「${task.claim_note}」` : ''},等你检查打分`
    : '';
  return `${head}:待完成,规定 ${task.target_minutes} 分钟${claim}`;
}

function rewardLine(reward: RewardRow): string {
  const tags = [`编号 ${reward.id}`, KIND_LABEL[reward.kind], ...(reward.archived ? ['已停用'] : [])].join(',');
  return `- ${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}(${tags}):${rewardRate(reward)}`;
}

function walletEntryLine(entry: WalletEntry): string {
  const what = { redeem: '兑换进账', use: '用掉', adjust: '调整', revert: '撤销' }[entry.kind];
  const who = entry.source === 'agent' ? `智能体${entry.actor ? `「${entry.actor}」` : ''}` : entry.source === 'api' ? (entry.actor || '外部接口') : '控制台';
  const sign = entry.amount > 0 ? '+' : '';
  return `- 记录 ${entry.id}(${entry.created_at} UTC,${who}):${entry.reward_emoji} ${entry.reward_name} ${what} ${sign}${entry.amount} ${entry.unit}`
    + `「${entry.title}」${entry.reverted_by ? ',已撤销' : ''},之后余额 ${entry.balance_after} ${entry.unit}`;
}

function ledgerLine(row: LedgerRow): string {
  const who = row.source === 'agent' ? `智能体${row.actor ? `「${row.actor}」` : ''}` : row.source === 'api' ? (row.actor || '外部接口') : '控制台';
  return `- 流水 ${row.id}(${row.created_at} UTC,${who}):${row.title} ${signed(row.delta)}${row.note ? `,${row.note}` : ''}`
    + `${row.reverted_by ? ',已撤销' : ''},之后余额 ${row.balance_after ?? '?'}`;
}

function parseQuality(value: unknown): Quality | undefined {
  const text = str(value).toLowerCase();
  if ((QUALITIES as readonly string[]).includes(text)) return text as Quality;
  return QUALITY_WORDS[text.slice(0, 1)];
}

/** 规则数值参数:按 schemas.ts 的取值范围校验,出错返回说明 */
function ruleParams(args: Record<string, unknown>): RuleInput | string {
  const input: RuleInput = {};
  for (const key of PARAM_KEYS) {
    if (args[key] === undefined || args[key] === null || args[key] === '') continue;
    const n = intArg(args[key]);
    const [min, max] = RULE_RANGES[key];
    if (n === undefined || n < min || n > max) return `${PARAM_DESCRIPTIONS[key]}(${key})要是 ${min}~${max} 的整数`;
    input[key] = n;
  }
  return input;
}

const RULE_PARAM_PROPS = Object.fromEntries(PARAM_KEYS.map((key) => [key, {
  type: 'integer', minimum: RULE_RANGES[key][0], maximum: RULE_RANGES[key][1], description: PARAM_DESCRIPTIONS[key],
}]));

const CHILD_PROP = {
  child: {
    type: 'string',
    description: '操作哪个孩子:孩子的称呼 / 设备名或 MAC。家里只有一个孩子、或正对着孩子的玩具说话时可以不填',
  },
};
const DAY_PROP = { day: { type: 'string', description: '日期 YYYY-MM-DD(北京时间),不填就是今天' } };
const TASK_PROP = { task: { type: 'string', description: '作业名(比如「数学」)或 credits_overview 里给出的编号' } };

CONSOLE_TOOLS.set(CREDITS_PARENT_PLUGIN, (ctx) => {
  const now = () => ctx.deps.now?.() ?? new Date();
  const conn = ctx.deps.conn;
  const by = (toolCtx: ToolContext): Actor => ({ source: 'agent', actor: toolCtx.agent.name });

  /** 定下要操作的孩子;定不下来就返回给模型的说明 */
  function resolveChild(toolCtx: ToolContext, args: Record<string, unknown>): Child | ToolResult {
    const children = childDevices(conn);
    if (!children.length) return fail('还没有绑定任何孩子的设备,学分没法记。告诉家长先在控制台绑定孩子的小单。');
    const query = str(args['child']);
    if (query) {
      const mac = canonicalMac(query);
      const byMac = mac ? children.find((c) => c.mac === mac) : undefined;
      if (byMac) return byMac;
      const q = norm(query);
      const exact = children.filter((c) => norm(c.alias) === q);
      const found = exact.length ? exact : children.filter((c) => c.alias && (norm(c.alias).includes(q) || q.includes(norm(c.alias))));
      if (found.length === 1) return found[0]!;
      const names = children.map(childName).join('、');
      return fail(found.length
        ? `「${query}」对上了好几个孩子:${found.map(childName).join('、')}。问家长是哪一个。`
        : `没有叫「${query}」的孩子。现有的孩子(设备):${names}。问家长是哪一个。`);
    }
    const here = toolCtx.device.mac ? childDevice(conn, toolCtx.device.mac) : undefined;
    if (here) return here;
    if (children.length === 1) return children[0]!;
    return fail(`家里有好几个孩子:${children.map(childName).join('、')}。问家长是给哪个孩子,再把名字填进 child 重新调用。`);
  }

  function dayArg(args: Record<string, unknown>): string | ToolResult {
    const day = str(args['day']);
    if (!day) return today(now());
    return DAY_RE.test(day) ? day : fail(`日期「${day}」格式不对,要 YYYY-MM-DD。`);
  }

  /** 按名字或编号找这个孩子某天的作业;编号可以跨天 */
  function findTask(child: Child, day: string, query: string, only?: (t: TaskRow) => boolean): TaskRow | ToolResult {
    if (!query) return fail('要说明是哪项作业。');
    if (/^\d+$/u.test(query)) {
      const byId = taskById(conn, Number(query));
      if (byId && byId.mac === child.mac) return byId;
    }
    const tasks = listTasks(conn, child.mac, day);
    const pool = only ? tasks.filter(only) : tasks;
    const found = match(pool, query);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return fail(`「${query}」对上了好几项:\n${found.map(taskLine).join('\n')}\n问家长是哪一项,用编号再调用。`);
    return fail(tasks.length
      ? `${childName(child)} ${day} 的作业里没有「${query}」。那天的作业:\n${tasks.map(taskLine).join('\n')}`
      : `${childName(child)} ${day} 没有布置作业。`);
  }

  function findNamed<T extends { id: number; name: string }>(items: T[], query: string, what: string, line: (t: T) => string): T | ToolResult {
    if (!query) return fail(`要说明是哪个${what}。`);
    const found = match(items, query);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return fail(`「${query}」对上了好几个${what}:\n${found.map(line).join('\n')}\n问家长是哪一个。`);
    return fail(items.length
      ? `没有叫「${query}」的${what}。现有的:\n${items.map(line).join('\n')}`
      : `还没有任何${what}。`);
  }

  const isResult = (value: unknown): value is ToolResult => typeof value === 'object' && value !== null && 'content' in value;

  /** 包一层:业务错误(分不够、已经打过分……)原样讲给模型 */
  const tool = (def: Omit<AgentTool, 'run' | 'act'> & { run: AgentTool['run'] }): AgentTool => ({
    ...def,
    act: 'learn',
    async run(toolCtx, args) {
      try {
        return await def.run(toolCtx, args);
      } catch (error) {
        if (error instanceof CreditError) return fail(`没办成:${error.message}。`);
        throw error;
      }
    },
  });

  const overview = tool({
    name: 'credits_overview',
    label: '查看学分',
    hint: '正在查学分',
    description:
      '家长查看孩子的学分:余额、某天每项作业(编号、状态、孩子有没有说做完)、所有待检查的申报、作业规则、奖励清单(兑换比例)、'
      + '零花钱与游戏 / 电视时间的余额。'
      + '操作前拿不准作业、规则、奖励叫什么时先调这个。',
    parameters: { type: 'object', properties: { ...CHILD_PROP, ...DAY_PROP } },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const day = dayArg(args);
      if (isResult(day)) return day;
      const tasks = listTasks(conn, child.mac, day);
      const claims = queryTasks(conn, child.mac, { status: 'claimed' }, 20).items.filter((t) => t.day !== day);
      const rules = listRules(conn, child.mac);
      const rewards = listRewards(conn, child.mac);
      const lines = [`${childName(child)} 现在有 ${balance(conn, child.mac)} 分。`];
      lines.push(tasks.length ? `${day} 的作业:` : `${day} 还没有布置作业。`, ...tasks.map(taskLine));
      if (claims.length) lines.push('其他日子孩子说做完、还没检查的:', ...claims.map(taskLine));
      lines.push(rules.length ? '作业规则:' : '还没有作业规则。', ...rules.map(ruleLine));
      lines.push(rewards.length ? '奖励(按整份兑换):' : '还没有奖励。', ...rewards.map(rewardLine));
      const wallets = walletSummary(conn, child.mac);
      if (wallets.length) lines.push(`余额账户:${wallets.map(walletLine).join(';')}。`);
      return { ok: true, content: lines.join('\n') };
    },
  });

  const assign = tool({
    name: 'credits_assign',
    label: '布置作业',
    hint: '正在布置作业',
    description:
      '给孩子布置作业(「今天给乐乐布置数学 40 分钟、英语」)。每项写规则名,可以为这一次改规定用时;'
      + '没有这条规则时,带上 minutes 就建一项临时作业(计分用默认值)。有一项对不上就整批不布置,把问题说给家长。',
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP, ...DAY_PROP,
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '作业规则名,或临时作业的名字' },
              minutes: { type: 'integer', minimum: 1, maximum: 600, description: '规定用时(分钟);不填用规则上的' },
            },
            required: ['name'],
          },
        },
      },
      required: ['tasks'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const day = dayArg(args);
      if (isResult(day)) return day;
      const items = Array.isArray(args['tasks']) ? args['tasks'] as Record<string, unknown>[] : [];
      if (!items.length) return fail('要说明布置哪些作业。');
      if (items.length > 30) return fail('一次最多布置 30 项。');
      const rules = listRules(conn, child.mac);
      const plan: ({ rule: RuleRow; minutes?: number } | { name: string; minutes: number })[] = [];
      const problems: string[] = [];
      for (const item of items) {
        const name = str(item?.['name']);
        const minutes = intArg(item?.['minutes']);
        if (!name) { problems.push('有一项没写名字'); continue; }
        if (minutes !== undefined && (minutes < 1 || minutes > 600)) { problems.push(`「${name}」的用时要在 1~600 分钟`); continue; }
        const found = match(rules, name);
        if (found.length === 1) plan.push({ rule: found[0]!, ...(minutes !== undefined ? { minutes } : {}) });
        else if (found.length > 1) problems.push(`「${name}」对上了好几条规则:${found.map((r) => r.name).join('、')}`);
        else if (minutes !== undefined) plan.push({ name: name.slice(0, 40), minutes });
        else problems.push(`没有「${name}」这条规则;要布置临时作业得说规定几分钟`);
      }
      if (problems.length) {
        return fail(`这批作业没有布置:${problems.join(';')}。`
          + (rules.length ? `现有规则:${rules.map((r) => r.name).join('、')}。` : '还没有任何作业规则。') + '问清楚家长再调用。');
      }
      const created: TaskRow[] = [];
      for (const entry of plan) {
        if ('rule' in entry) created.push(...assignTasks(conn, child.mac, day, [{ rule_id: entry.rule.id, target_minutes: entry.minutes }]));
        else created.push(createCustomTask(conn, child.mac, day, { name: entry.name, target_minutes: entry.minutes }));
      }
      return { ok: true, content: `已给${childName(child)}布置 ${day} 的作业:\n${created.map(taskLine).join('\n')}` };
    },
  });

  const score = tool({
    name: 'credits_score',
    label: '作业打分',
    hint: '正在打分',
    description:
      '家长检查完作业后录入结果并算分(「数学用了 45 分钟,质量良」)。按布置时的规则快照计分,返回得分和怎么算的。'
      + '孩子说做完了只是申报,打分要家长说出实际用时和质量;家长没说全就先问。',
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP, ...TASK_PROP, ...DAY_PROP,
        minutes: { type: 'integer', minimum: 0, maximum: 1440, description: '实际用了多少分钟' },
        quality: { type: 'string', enum: [...QUALITIES, '优', '良', '中', '差'], description: '质量:优/良/中/差' },
        note: { type: 'string', description: '备注,可不填' },
      },
      required: ['task', 'minutes', 'quality'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const day = dayArg(args);
      if (isResult(day)) return day;
      const minutes = intArg(args['minutes']);
      if (minutes === undefined || minutes < 0 || minutes > 1440) return fail('实际用时要是 0~1440 的整数分钟,问家长用了多久。');
      const quality = parseQuality(args['quality']);
      if (!quality) return fail('质量要是优、良、中、差之一,问家长。');
      const task = findTask(child, day, str(args['task']), (t) => t.status === 'pending');
      if (isResult(task)) return task;
      const result = scoreTask(conn, task.id, minutes, quality, str(args['note']).slice(0, 200), by(toolCtx));
      return {
        ok: true,
        content: `「${task.name}」打分完成:${result.score.explain}。${childName(child)}现在有 ${result.balance} 分。`
          + `(流水 ${result.task.ledger_id},打错了可以撤销)`,
      };
    },
  });

  const missed = tool({
    name: 'credits_mark_missed',
    label: '记没完成',
    hint: '正在记录',
    description: '把一项作业记为没完成,按规则扣分(「英语今天没做」)。',
    parameters: { type: 'object', properties: { ...CHILD_PROP, ...TASK_PROP, ...DAY_PROP, note: { type: 'string', description: '备注,可不填' } }, required: ['task'] },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const day = dayArg(args);
      if (isResult(day)) return day;
      const task = findTask(child, day, str(args['task']), (t) => t.status === 'pending');
      if (isResult(task)) return task;
      const result = missTask(conn, task.id, str(args['note']).slice(0, 200), by(toolCtx));
      return { ok: true, content: `「${task.name}」记为没完成:${result.score.explain}。${childName(child)}现在有 ${result.balance} 分。` };
    },
  });

  const editTask = tool({
    name: 'credits_edit_task',
    label: '修改作业',
    hint: '正在修改作业',
    description:
      '处理还没打分的作业:update 改名字、规定用时或挪到别的日期;delete 删掉;reject_claim 驳回孩子「做完了」的申报(检查发现没做完)。'
      + '已经打过分的要先用 credits_undo 撤销那笔流水。' + CONFIRM,
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP, ...TASK_PROP, ...DAY_PROP,
        action: { type: 'string', enum: ['update', 'delete', 'reject_claim'] },
        name: { type: 'string', description: 'update:新名字' },
        minutes: { type: 'integer', minimum: 1, maximum: 600, description: 'update:新的规定用时' },
        new_day: { type: 'string', description: 'update:挪到哪天 YYYY-MM-DD' },
      },
      required: ['task', 'action'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const day = dayArg(args);
      if (isResult(day)) return day;
      const task = findTask(child, day, str(args['task']));
      if (isResult(task)) return task;
      const action = str(args['action']);
      if (action === 'delete') {
        deleteTask(conn, task.id);
        return { ok: true, content: `已删除${childName(child)} ${task.day} 的「${task.name}」。` };
      }
      if (action === 'reject_claim') {
        if (!task.claimed_at) return fail(`「${task.name}」孩子还没说做完,没有可驳回的申报。`);
        unclaimTask(conn, task.id);
        return { ok: true, content: `已驳回「${task.name}」的申报,作业回到待完成。` };
      }
      if (action !== 'update') return fail('action 要是 update、delete、reject_claim 之一。');
      const name = str(args['name']);
      const minutes = intArg(args['minutes']);
      const newDay = str(args['new_day']);
      if (minutes !== undefined && (minutes < 1 || minutes > 600)) return fail('规定用时要在 1~600 分钟。');
      if (newDay && !DAY_RE.test(newDay)) return fail(`日期「${newDay}」格式不对,要 YYYY-MM-DD。`);
      if (!name && minutes === undefined && !newDay) return fail('要说明改什么:名字、规定用时还是日期。');
      const updated = updateTask(conn, task.id, {
        ...(name ? { name: name.slice(0, 40) } : {}), ...(minutes !== undefined ? { target_minutes: minutes } : {}), ...(newDay ? { day: newDay } : {}),
      });
      return { ok: true, content: `已修改:${taskLine(updated).slice(2)}` };
    },
  });

  const adjustTool = tool({
    name: 'credits_adjust',
    label: '加减分',
    hint: '正在记分',
    description: '家长手动奖惩(「主动帮忙洗碗加 5 分」「顶嘴扣 3 分」)。加分填正数、扣分填负数,必须写原因。' + CONFIRM,
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP,
        points: { type: 'integer', minimum: -1000, maximum: 1000, description: '加分正数、扣分负数,不能是 0' },
        reason: { type: 'string', description: '原因,会记进流水' },
      },
      required: ['points', 'reason'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const points = intArg(args['points']);
      if (points === undefined || points === 0 || points < -1000 || points > 1000) return fail('分数要是 -1000~1000 之间、不为 0 的整数。');
      const reason = str(args['reason']).slice(0, 80);
      if (!reason) return fail('加减分要写原因,问家长为什么。');
      const result = adjust(conn, child.mac, points, reason, by(toolCtx));
      return { ok: true, content: `已给${childName(child)} ${signed(points)} 分(${reason}),现在有 ${result.balance} 分。(流水 ${result.ledger.id})` };
    },
  });

  const redeemTool = tool({
    // 不叫 credits_redeem:两个学分工具开在同一个角色上时函数名不能撞
    name: 'credits_redeem_for',
    label: '代兑换奖励',
    hint: '正在兑换奖励',
    description: '替孩子用学分兑换奖励,按整份换,分够才能换。时间和零花钱换到后存进余额账户,用掉 / 花掉时用 credits_wallet 记。',
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP,
        reward: { type: 'string', description: '奖励名或编号' },
        amount: { type: 'number', description: '换多少:时间填分钟数,零花钱填元;要凑成整份' },
        times: { type: 'integer', minimum: 1, maximum: 100, description: '换几份;和 amount 二选一,都不填就是一份' },
        note: { type: 'string' },
      },
      required: ['reward'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const reward = findNamed(listRewards(conn, child.mac), str(args['reward']), '奖励', rewardLine);
      if (isResult(reward)) return reward;
      const times = redeemTimes(reward, args['amount'], args['times']);
      if (typeof times === 'string') return fail(times);
      const result = redeem(conn, child.mac, reward.id, times, str(args['note']).slice(0, 200) || '家长代兑换', by(toolCtx));
      const got = result.wallet ? `「${reward.name}」余额现在 ${formatQty(reward.kind, result.wallet.balance)}。` : '';
      return {
        ok: true,
        content: `已兑换:${result.ledger.title},扣 ${reward.cost * times} 分,${childName(child)}还剩 ${result.balance} 分。${got}(流水 ${result.ledger.id})`,
      };
    },
  });

  const undo = tool({
    name: 'credits_undo',
    label: '撤销',
    hint: '正在撤销',
    description:
      '撤销一笔流水(打分、没完成、兑换、加减分):追加一笔反向记录,原记录保留;撤销打分后作业回到待完成,可以重新打分。'
      + '不填 entry 就撤销这个孩子最近一笔还没撤销过的。' + CONFIRM,
    parameters: { type: 'object', properties: { ...CHILD_PROP, entry: { type: 'integer', description: '流水编号(credits_history 里的「流水 N」),不填 = 最近一笔' } } },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const entryId = intArg(args['entry']);
      let target: LedgerRow | undefined;
      if (entryId !== undefined) {
        target = ledgerById(conn, entryId);
        if (!target || target.mac !== child.mac) return fail(`${childName(child)}没有编号 ${entryId} 的流水。`);
      } else {
        target = ledgerPage(conn, child.mac, null, 100).items.find((row) => row.kind !== 'revert' && !row.reverted_by);
        if (!target) return fail(`${childName(child)}没有可以撤销的流水。`);
      }
      const result = revert(conn, target.id, by(toolCtx));
      return {
        ok: true,
        content: `已撤销流水 ${target.id}「${target.title}」(${signed(target.delta)}),${childName(child)}现在有 ${result.balance} 分。`
          + (result.task ? `「${result.task.name}」回到待完成,可以重新打分。` : '')
          + (result.wallet ? `换到的也退回了,账户余额现在 ${formatQty(result.wallet.entry.reward_kind, result.wallet.balance)}。` : ''),
      };
    },
  });

  const manageRule = tool({
    name: 'credits_manage_rule',
    label: '管理作业规则',
    hint: '正在修改规则',
    description:
      '新建 / 修改 / 删除 / 恢复作业规则。规则定了规定用时和各项得分扣分;改规则只影响以后布置的作业,已布置的不变。'
      + '删除时布置过的规则改为停用(可恢复)。新建至少要名字和规定用时,其余数值不填用默认。' + CONFIRM,
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP,
        action: { type: 'string', enum: ['create', 'update', 'delete', 'restore'] },
        name: { type: 'string', description: '规则名(新建时是新名字;其他操作用来找规则,也可以填编号)' },
        new_name: { type: 'string', description: 'update:改成的新名字' },
        ...RULE_PARAM_PROPS,
      },
      required: ['action', 'name'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const action = str(args['action']);
      const name = str(args['name']);
      const params = ruleParams(args);
      if (typeof params === 'string') return fail(params);
      if (action === 'create') {
        if (!name) return fail('新规则要有名字。');
        if (params.target_minutes === undefined) return fail(`新建「${name}」要说明规定几分钟。`);
        if (listRules(conn, child.mac).some((r) => norm(r.name) === norm(name))) return fail(`已经有「${name}」这条规则了,要改就用 update。`);
        const rule = createRule(conn, child.mac, { ...params, name: name.slice(0, 40), target_minutes: params.target_minutes });
        return { ok: true, content: `已新建规则:\n${ruleLine(rule)}` };
      }
      const rule = findNamed(listRules(conn, child.mac, action === 'restore'), name, action === 'restore' ? '规则(含已停用)' : '规则', ruleLine);
      if (isResult(rule)) return rule;
      if (action === 'delete') {
        const result = deleteRule(conn, rule.id);
        return { ok: true, content: result === 'archived' ? `「${rule.name}」布置过,已改为停用(以后可以恢复)。` : `已删除规则「${rule.name}」。` };
      }
      if (action === 'restore') return { ok: true, content: `已恢复:\n${ruleLine(restoreRule(conn, rule.id))}` };
      if (action !== 'update') return fail('action 要是 create、update、delete、restore 之一。');
      const newName = str(args['new_name']);
      if (!newName && !Object.keys(params).length) return fail('要说明改什么。');
      const updated = updateRule(conn, rule.id, { ...params, ...(newName ? { name: newName.slice(0, 40) } : {}) });
      return { ok: true, content: `已修改(只影响以后布置的作业):\n${ruleLine(updated)}` };
    },
  });

  const manageReward = tool({
    name: 'credits_manage_reward',
    label: '管理奖励',
    hint: '正在修改奖励',
    description:
      '新建 / 修改 / 删除 / 恢复奖励。奖励按整份兑换:cost 分换一份。种类 kind:item 物品(买个小玩具,换了就完事)、'
      + 'time 时间(「10 分 = 5 分钟游戏」→ cost 10、amount 5)、money 零花钱(「10 分 = 5 元」→ cost 10、amount 5);'
      + '时间和零花钱换到后存进余额账户。换过的奖励不能再改种类。删除时兑换过的改为停用(可恢复)。' + CONFIRM,
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP,
        action: { type: 'string', enum: ['create', 'update', 'delete', 'restore'] },
        name: { type: 'string', description: '奖励名(新建时是新名字;其他操作用来找奖励,也可以填编号)' },
        new_name: { type: 'string', description: 'update:改成的新名字' },
        cost: { type: 'integer', minimum: 1, maximum: 100000, description: '一份要多少分' },
        kind: { type: 'string', enum: [...REWARD_KINDS], description: '新建时不填是 item' },
        amount: { type: 'number', description: 'time / money 一份换多少:分钟数或元' },
        emoji: { type: 'string', description: '一个表情,可不填' },
      },
      required: ['action', 'name'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const action = str(args['action']);
      const name = str(args['name']);
      const cost = args['cost'] === undefined || args['cost'] === null || args['cost'] === '' ? undefined : intArg(args['cost']);
      if (args['cost'] !== undefined && args['cost'] !== null && args['cost'] !== '' && (cost === undefined || cost < 1 || cost > 100000)) {
        return fail('所需分数要是 1~100000 的整数。');
      }
      const emoji = args['emoji'] === undefined ? undefined : str(args['emoji']).slice(0, 8);
      const kindArg = str(args['kind']);
      if (kindArg && !(REWARD_KINDS as readonly string[]).includes(kindArg)) return fail('kind 要是 item、time、money 之一。');
      const amountArg = args['amount'] === undefined || args['amount'] === null || args['amount'] === '' ? undefined : Number(args['amount']);
      /** 自然单位换成库里的基本单位;物品不用 amount */
      const amountFor = (kind: RewardKind) => (kind === 'item' || amountArg === undefined ? undefined : toBase(kind, amountArg, '一份换多少'));
      if (action === 'create') {
        if (!name) return fail('新奖励要有名字。');
        if (cost === undefined) return fail(`「${name}」一份要多少分?问家长。`);
        const kind = (kindArg || 'item') as RewardKind;
        if (kind !== 'item' && amountArg === undefined) return fail(`「${name}」一份换多少${UNIT[kind]}?问家长。`);
        if (listRewards(conn, child.mac).some((r) => norm(r.name) === norm(name))) return fail(`已经有「${name}」这个奖励了,要改就用 update。`);
        const created = createReward(conn, child.mac, { name: name.slice(0, 40), cost, emoji, kind, amount: amountFor(kind) });
        return { ok: true, content: `已新建奖励:\n${rewardLine(created)}` };
      }
      const reward = findNamed(listRewards(conn, child.mac, action === 'restore'), name, action === 'restore' ? '奖励(含已停用)' : '奖励', rewardLine);
      if (isResult(reward)) return reward;
      if (action === 'delete') {
        const result = deleteReward(conn, reward.id);
        return { ok: true, content: result === 'archived' ? `「${reward.name}」兑换过,已改为停用(以后可以恢复)。` : `已删除奖励「${reward.name}」。` };
      }
      if (action === 'restore') return { ok: true, content: `已恢复:\n${rewardLine(restoreReward(conn, reward.id))}` };
      if (action !== 'update') return fail('action 要是 create、update、delete、restore 之一。');
      const newName = str(args['new_name']);
      if (!newName && cost === undefined && emoji === undefined && !kindArg && amountArg === undefined) return fail('要说明改什么。');
      const kind = (kindArg || reward.kind) as RewardKind;
      const updated = updateReward(conn, reward.id, {
        ...(newName ? { name: newName.slice(0, 40) } : {}), cost, emoji, ...(kindArg ? { kind } : {}), amount: amountFor(kind),
      });
      return { ok: true, content: `已修改:\n${rewardLine(updated)}` };
    },
  });

  const walletTool = tool({
    name: 'credits_wallet',
    label: '零花钱与时间',
    hint: '正在记账',
    description:
      '孩子换到手的零花钱和游戏 / 电视时间的余额账户(一个奖励一个账户)。action:'
      + 'status 看余额和最近记录(「零花钱还有多少、最近怎么花的」);'
      + 'use 记一笔用掉 / 花掉(「买文具花了 3.5 元」「游戏玩了 10 分钟」),不能超过余额;'
      + 'adjust 调整,加填正数、减填负数(「奶奶给了 20 元存进零花钱」),调完不能小于 0;'
      + 'undo 撤销一笔用掉或调整,不填 entry 就撤最近一笔(兑换进来的要用 credits_undo 撤销那次兑换)。'
      + '撤销,以及一次调整 50 元或 60 分钟以上之前,先跟家长复述一遍、得到确认再调用。',
    parameters: {
      type: 'object',
      properties: {
        ...CHILD_PROP,
        action: { type: 'string', enum: ['status', 'use', 'adjust', 'undo'] },
        reward: { type: 'string', description: '哪个账户:奖励名(「零花钱」「玩游戏」)或编号;只有一个账户时可以不填' },
        amount: { type: 'number', description: 'use:用掉多少(分钟 / 元,大于 0);adjust:加减多少' },
        reason: { type: 'string', description: 'use / adjust:用在哪了、为什么调,会记进账' },
        entry: { type: 'integer', description: 'undo:记录编号(status 里的「记录 N」),不填 = 最近一笔' },
      },
      required: ['action'],
    },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const action = str(args['action']);
      const accounts = listRewards(conn, child.mac, true)
        .filter((r) => r.kind !== 'item' && (!r.archived || walletBalance(conn, r.id) !== 0));
      if (!accounts.length) return fail(`${childName(child)}还没有时间或零花钱类的奖励,没有余额账户。可以用 credits_manage_reward 建一个。`);
      const query = str(args['reward']);
      const account = query ? findNamed(accounts, query, '账户', rewardLine) : accounts.length === 1 ? accounts[0]! : undefined;
      if (account && isResult(account)) return account;
      const entries = (rewardId?: number, limit = 10) => walletRows(conn,
        rewardId ? 'w.mac = ? AND w.reward_id = ?' : 'w.mac = ?', rewardId ? [child.mac, rewardId] : [child.mac], limit).map(walletOut);

      if (action === 'status') {
        const summary = walletSummary(conn, child.mac).filter((w) => !account || w.reward_id === account.id);
        const lines = summary.map((w) => `- ${w.emoji ? `${w.emoji} ` : ''}${w.name}:余额 ${w.balance} ${w.unit},累计兑换 ${w.redeemed} ${w.unit},累计用掉 ${w.used} ${w.unit}`);
        const recent = entries(account?.id);
        lines.push(recent.length ? '最近的记录(新的在前):' : '还没有记录。', ...recent.map(walletEntryLine));
        return { ok: true, content: lines.join('\n') };
      }
      if (action === 'undo') {
        const entryId = intArg(args['entry']);
        let target: WalletEntry | undefined;
        if (entryId !== undefined) {
          const row = walletById(conn, entryId);
          if (!row || row.mac !== child.mac) return fail(`${childName(child)}没有编号 ${entryId} 的记录。`);
          target = walletOut(row);
        } else {
          target = entries(account?.id, 100).find((e) => (e.kind === 'use' || e.kind === 'adjust') && !e.reverted_by);
          if (!target) return fail('没有可以撤销的用掉 / 调整记录。兑换进来的要用 credits_undo 撤销那次兑换。');
        }
        const result = walletRevert(conn, target.id, by(toolCtx));
        return { ok: true, content: `已撤销记录 ${target.id}「${target.title}」,「${target.reward_name}」余额现在 ${result.balance} ${result.unit}。` };
      }
      if (action !== 'use' && action !== 'adjust') return fail('action 要是 status、use、adjust、undo 之一。');
      if (!account) return fail(`要说明是哪个账户:${accounts.map((a) => a.name).join('、')}。`);
      const amount = typeof args['amount'] === 'number' ? args['amount'] : Number.parseFloat(str(args['amount']));
      if (!Number.isFinite(amount)) return fail(`要说明${action === 'use' ? '用掉' : '调整'}多少${UNIT[account.kind]}。`);
      const reason = str(args['reason']).slice(0, 80);
      if (!reason) return fail(action === 'use' ? '要说明用在哪了,问家长。' : '调整要写原因,问家长。');
      const result = action === 'use'
        ? walletUse(conn, child.mac, account.id, amount, reason, '', by(toolCtx))
        : walletAdjust(conn, child.mac, account.id, amount, reason, by(toolCtx));
      return {
        ok: true,
        content: `已记:「${account.name}」${action === 'use' ? '用掉' : '调整'} ${result.entry.amount > 0 ? '+' : ''}${result.entry.amount} ${result.unit}(${reason}),`
          + `余额现在 ${result.balance} ${result.unit}。(记录 ${result.entry.id})`,
      };
    },
  });

  const history = tool({
    name: 'credits_history',
    label: '学分历史',
    hint: '正在看学分记录',
    description: '最近几天的学分统计(挣了、扣了、花了多少,完成率、按时率,各项作业表现,各奖励换了多少、零花钱和时间用掉多少)和最近的流水(带编号,撤销时用)。',
    parameters: { type: 'object', properties: { ...CHILD_PROP, days: { type: 'integer', minimum: 1, maximum: 366, description: '看最近几天,默认 7' } } },
    async run(toolCtx, args) {
      const child = resolveChild(toolCtx, args);
      if (isResult(child)) return child;
      const days = Math.min(366, Math.max(1, intArg(args['days']) ?? 7));
      const to = today(now());
      const s = stats(conn, child.mac, shiftDay(to, 1 - days), to);
      const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);
      const lines = [
        `${childName(child)} 最近 ${days} 天(${s.from} ~ ${s.to}):挣 ${s.totals.earned}、扣 ${s.totals.penalty}、花 ${s.totals.spent},净 ${signed(s.totals.net)};`
          + `完成率 ${pct(s.completion_rate)},按时率 ${pct(s.ontime_rate)};现在 ${s.balance} 分。`,
      ];
      if (s.tasks.length) {
        lines.push('各项作业:', ...s.tasks.map((t) => `- ${t.name}:布置 ${t.assigned},完成 ${t.done},没完成 ${t.missed},按时 ${t.ontime}`
          + `${t.avg_minutes !== null ? `,平均 ${t.avg_minutes} 分钟` : ''}${t.avg_points !== null ? `,平均 ${t.avg_points} 分` : ''}`));
      }
      if (s.redeemed.length) {
        lines.push(`兑换:${s.redeemed.map((r) => `${r.emoji ? `${r.emoji} ` : ''}${r.name} ${r.quantity} ${r.unit}(${r.points} 分)`).join(';')}。`);
      }
      if (s.wallets.length) {
        lines.push(`用掉:${s.wallets.map((w) => `${w.emoji ? `${w.emoji} ` : ''}${w.name} ${w.used} ${w.unit}`).join(';')}。`);
      }
      const recent = ledgerPage(conn, child.mac, null, 15).items;
      lines.push(recent.length ? '最近的流水(新的在前):' : '还没有流水。', ...recent.map(ledgerLine));
      return { ok: true, content: lines.join('\n') };
    },
  });

  return [overview, assign, score, missed, editTask, adjustTool, redeemTool, undo, manageRule, manageReward, walletTool, history];
});
