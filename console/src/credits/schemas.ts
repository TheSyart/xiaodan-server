// 学分接口的请求体与查询参数定义。路由用它们校验,openapi.ts 用同一批生成接口描述,
// 所以接口改了描述自动跟着变,不会出现「文档说能填 0、接口却拒绝」这种两边对不上。

import { z } from 'zod';
import { PARAM_KEYS } from './store.ts';
import { QUALITIES } from './score.ts';
import { REWARD_KINDS } from './units.ts';

export const int = (min: number, max: number) => z.number().int().min(min).max(max);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').describe('北京时间的日期 YYYY-MM-DD');
export const mac = z.string().min(1).max(32).describe('设备(孩子)的 MAC。冒号、连字符、12 位紧凑写法都认;拼进 URL 请用紧凑写法');
export const name = z.string().trim().min(1, '名称不能为空').max(40, '名称最多 40 个字');
export const quality = z.enum(QUALITIES, { message: '质量要选优、良、中、差之一' })
  .describe('excellent 优 / good 良 / fair 中 / poor 差');

export const RULE_RANGES: Record<(typeof PARAM_KEYS)[number], [number, number]> = {
  target_minutes: [1, 600],
  ontime_points: [-100, 100],
  overtime_step: [1, 120],
  overtime_penalty: [0, 100],
  overtime_cap: [0, 100],
  q_excellent: [-100, 100],
  q_good: [-100, 100],
  q_fair: [-100, 100],
  q_poor: [-100, 100],
  missed_penalty: [0, 100],
};

export const PARAM_DESCRIPTIONS: Record<(typeof PARAM_KEYS)[number], string> = {
  target_minutes: '规定用时(分钟)',
  ontime_points: '实际用时不超过规定用时就得这么多分',
  overtime_step: '超时每几分钟算一档(超 1 分钟也算一档)',
  overtime_penalty: '每档扣几分',
  overtime_cap: '超时最多扣几分',
  q_excellent: '质量「优」得分',
  q_good: '质量「良」得分',
  q_fair: '质量「中」得分',
  q_poor: '质量「差」得分',
  missed_penalty: '标记「没完成」扣几分',
};

type ParamShape<T> = { [K in (typeof PARAM_KEYS)[number]]: T };
const paramField = (key: (typeof PARAM_KEYS)[number]) => int(...RULE_RANGES[key]).describe(PARAM_DESCRIPTIONS[key]);

/** 全部计分参数,都可选(部分更新) */
export const ruleParamsPartial = z.object(
  Object.fromEntries(PARAM_KEYS.map((key) => [key, paramField(key).optional()])) as ParamShape<z.ZodOptional<z.ZodNumber>>,
);
/** 全部计分参数,都必填(试算用) */
export const ruleParamsFull = z.object(
  Object.fromEntries(PARAM_KEYS.map((key) => [key, paramField(key)])) as ParamShape<z.ZodNumber>,
);

export const ruleCreate = ruleParamsPartial.extend({ mac, name, target_minutes: paramField('target_minutes') });
export const ruleUpdate = ruleParamsPartial.extend({ name: name.optional() });
export const rulePreview = z.object({ params: ruleParamsFull, actual_minutes: int(0, 1440), quality });
export const reorderBody = z.object({ mac, ids: z.array(z.number().int().positive()).min(1).max(200) });

export const taskAssign = z.object({
  mac,
  day: day.optional().describe('不填就是北京时间的今天'),
  items: z.array(z.object({
    rule_id: z.number().int().positive(),
    target_minutes: paramField('target_minutes').optional().describe('这一次临时改规定用时;不填用规则上的'),
  })).min(1, '至少选一项作业').max(30, '一次最多布置 30 项'),
});
export const taskCustom = ruleParamsPartial.extend({ mac, day: day.optional(), name, target_minutes: paramField('target_minutes') });
export const taskUpdate = z.object({ name: name.optional(), target_minutes: paramField('target_minutes').optional(), day: day.optional() });
export const taskResult = z.object({
  actual_minutes: int(0, 1440).describe('实际用了多少分钟'),
  quality,
  note: z.string().max(200).optional(),
  preview: z.boolean().optional().describe('true 时只算分不保存'),
});
export const taskMissed = z.object({ note: z.string().max(200).optional() });
export const taskClaim = z.object({
  minutes: int(0, 1440).optional().describe('孩子说自己用了多少分钟'),
  note: z.string().max(200).optional(),
});
export const TASK_STATUSES = ['pending', 'done', 'missed', 'claimed'] as const;

export const REWARD_KIND_VALUES = REWARD_KINDS;
const rewardKind = z.enum(REWARD_KINDS, { message: '种类要选 item、time、money 之一' })
  .describe('item 物品(兑换就完事)/ time 时间(进时间余额,单位分钟)/ money 零花钱(进零花钱余额,单位元)');
const rewardAmount = z.number().positive('一份换多少要大于 0').max(100000)
  .describe('一份换多少:time 填整数分钟,money 填元(最多两位小数),item 不用填');
export const rewardCreate = z.object({
  mac, name,
  cost: int(1, 100000).describe('一份要多少分'),
  emoji: z.string().max(8).optional(),
  kind: rewardKind.optional().describe('不填是 item'),
  amount: rewardAmount.optional(),
});
export const rewardUpdate = z.object({
  name: name.optional(),
  cost: int(1, 100000).optional().describe('一份要多少分'),
  emoji: z.string().max(8).optional(),
  kind: rewardKind.optional().describe('兑换或记过账之后不能再改'),
  amount: rewardAmount.optional(),
});
export const redeemBody = z.object({
  mac,
  reward_id: z.number().int().positive(),
  times: int(1, 100).optional().describe('换几份,默认 1。扣 cost × times 分;时间 / 零花钱进账 amount × times'),
  note: z.string().max(200).optional(),
});

export const WALLET_KINDS = ['redeem', 'use', 'adjust', 'revert'] as const;
const walletAmount = z.number().positive('数额要大于 0').max(100000)
  .describe('自然单位:时间是整数分钟,零花钱是元(最多两位小数)');
export const walletUseBody = z.object({
  mac,
  reward_id: z.number().int().positive().describe('哪个时间 / 零花钱奖励(账户)'),
  amount: walletAmount,
  reason: z.string().trim().min(1, '要写明用在哪了').max(80).describe('比如「买文具」「玩了一局游戏」'),
  note: z.string().max(200).optional(),
});
export const walletAdjustBody = z.object({
  mac,
  reward_id: z.number().int().positive(),
  amount: z.number().min(-100000).max(100000).refine((n) => n !== 0, '数额不能是 0')
    .describe('加填正数、减填负数;调完余额不能小于 0'),
  reason: z.string().trim().min(1, '要写明原因').max(80),
});
export const adjustBody = z.object({
  mac,
  delta: int(-1000, 1000).refine((n) => n !== 0, '分数不能是 0').describe('加分填正数,扣分填负数,不能是 0'),
  reason: z.string().trim().min(1, '要写明原因').max(80),
});
export const examplesBody = z.object({ mac });
export const LEDGER_KINDS = ['task', 'missed', 'redeem', 'adjust', 'revert'] as const;

export const keyCreate = z.object({ name, scope: z.enum(['read', 'write']).default('write') });
export const keyUpdate = z.object({ name });
