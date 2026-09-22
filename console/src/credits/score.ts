// 学分的计分。纯函数,页面预览、接口落库、智能体工具都走这一处,公式不在别处重写。
//
//   给分   = 家长自己打的 0–5 分(参考用时只作对照,不参与计算)
//   质量分 = 好 +1 / 不好 +0
//   合计   = 给分 + 质量分(0–6)
//   没完成 = 记 0 分,不扣分
//
// 旧模型(按时得分、超时按档扣分、质量四档、没完成扣分)在迁移 v16 里退场。历史行仍带着那时算出来的
// total_points 与四档质量值,所以四档的标签表留着给展示用 —— 注意旧模型的「良」和新模型的「好」都存
// 成 good,显示时按新语义叫「好」(线上没有旧模型打过分的作业,老库若有,语义会差一档)。

import { CreditError } from './errors.ts';

/** 家长能打的分数 */
export const POINTS_MIN = 0;
export const POINTS_MAX = 5;

/** 现在只有两档质量 */
export const QUALITY_CHOICES = ['good', 'poor'] as const;
export type Quality = (typeof QUALITY_CHOICES)[number];
export const QUALITY_CHOICE_LABEL: Record<Quality, string> = { good: '好', poor: '不好' };

/** 质量好加几分。就写在这儿 —— 规则(现在的作业模板)里不再有分值。 */
export const QUALITY_BONUS: Record<Quality, number> = { good: 1, poor: 0 };

/** 旧模型留下的两档,只有历史行会出现 */
export type LegacyQuality = 'excellent' | 'fair';
/** 读库时可能遇到的质量值(旧的四档 + 新的两档) */
export type StoredQuality = Quality | LegacyQuality;

/** 旧模型的两档标签:只有历史行会出现 */
export const LEGACY_QUALITY_LABELS: Record<LegacyQuality, string> = { excellent: '优', fair: '中' };

/** 展示用的标签:优良中差是老数据,好/不好是新数据 */
export const QUALITY_LABEL: Record<StoredQuality, string> = {
  excellent: '优', good: '好', fair: '中', poor: '不好',
};

/** 质量值是不是现在还能写的那种 */
export function isQuality(value: unknown): value is Quality {
  return value === 'good' || value === 'poor';
}

export interface ScoreResult {
  /** 家长给的分(0–5) */
  base_points: number;
  /** 质量加成:好 1 / 不好 0 */
  quality_points: number;
  total: number;
  /** 一句话讲清楚这个分是怎么来的,页面与接口直接展示 */
  explain: string;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** 一项作业的得分:给分 + 质量加成。给分超出 0–5 直接拒。 */
export function gradeResult(points: number, quality: Quality): ScoreResult {
  if (!Number.isInteger(points) || points < POINTS_MIN || points > POINTS_MAX) {
    throw new CreditError(`给分要是 ${POINTS_MIN}~${POINTS_MAX} 的整数`, 400, 'invalid');
  }
  const bonus = QUALITY_BONUS[quality];
  const total = points + bonus;
  return {
    base_points: points,
    quality_points: bonus,
    total,
    explain: `给分 ${points};质量${QUALITY_CHOICE_LABEL[quality]} ${signed(bonus)};合计 ${signed(total)}`,
  };
}

/** 没完成:记 0 分,不扣分 */
export function missedResult(): ScoreResult {
  return { base_points: 0, quality_points: 0, total: 0, explain: '没完成,记 0 分' };
}

/** 实际用时与参考用时的对照文案。只是给家长看的参考,不参与算分。 */
export function timeCompare(actualMinutes: number | null, targetMinutes: number): string {
  if (actualMinutes === null) return `参考 ${targetMinutes} 分钟`;
  const diff = actualMinutes - targetMinutes;
  if (diff === 0) return `正好用满参考的 ${targetMinutes} 分钟`;
  return diff > 0
    ? `比参考多用 ${diff} 分钟(${targetMinutes} → ${actualMinutes})`
    : `比参考少用 ${-diff} 分钟(${targetMinutes} → ${actualMinutes})`;
}
