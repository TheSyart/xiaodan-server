// 奖励的种类与单位换算。纯函数,接口、页面文案、智能体工具都走这一处。
//
// 奖励分三种:
//   item   物品 / 一次性的事(买个小玩具),兑换就完事,没有余额;
//   time   时间(10 分 = 5 分钟游戏),兑换进这个奖励的时间余额,玩的时候再记一笔用掉;
//   money  零花钱(10 分 = 5 元),兑换进零花钱余额,花的时候再记一笔支出。
// 库里一律存「基本单位」的整数:时间是分钟,钱是分(1/100 元),避免小数记账出误差。
// 对外(接口、工具、页面)用自然单位:时间是整数分钟,钱是元、最多两位小数。

import { CreditError } from './errors.ts';

export const REWARD_KINDS = ['item', 'time', 'money'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export const KIND_LABEL: Record<RewardKind, string> = { item: '物品', time: '时间', money: '零花钱' };
export const UNIT: Record<RewardKind, string> = { item: '份', time: '分钟', money: '元' };

/** 一份最多换多少(自然单位) */
export const AMOUNT_MAX: Record<RewardKind, number> = { item: 1, time: 1440, money: 100000 };

/** 基本单位 → 自然单位 */
export function fromBase(kind: RewardKind, base: number): number {
  return kind === 'money' ? base / 100 : base;
}

/**
 * 自然单位 → 基本单位,顺带校验:时间是整数分钟;钱最多两位小数。
 * allowNegative 给「调整」用;为 0 一律不收。
 */
export function toBase(kind: RewardKind, value: number, what = '数额', allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CreditError(`${what}要是数字`, 400, 'invalid');
  const base = kind === 'money' ? Math.round(value * 100) : value;
  if (kind === 'money' && Math.abs(value * 100 - base) > 1e-6) throw new CreditError(`${what}最多两位小数(精确到分)`, 400, 'invalid');
  if (kind !== 'money' && !Number.isInteger(value)) throw new CreditError(`${what}要是整数${UNIT[kind]}`, 400, 'invalid');
  if (base === 0 || (!allowNegative && base < 0)) throw new CreditError(`${what}要${allowNegative ? '不为 0' : '大于 0'}`, 400, 'invalid');
  return base;
}

/** 「5 分钟」「12.5 元」「3 份」 */
export function formatQty(kind: RewardKind, base: number): string {
  const value = fromBase(kind, base);
  const text = kind === 'money' ? String(Math.round(value * 100) / 100) : String(value);
  return `${text} ${UNIT[kind]}`;
}
