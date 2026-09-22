// 学分的计分规则。纯函数,页面的预览、接口的落库都走这一处,公式不在别处重写。
//
//   用时分 = 实际 ≤ 规定 ? 按时得分
//          : -min(超时上限, 向上取整((实际 - 规定) / 每档分钟) × 每档扣分)
//   质量分 = 优/良/中/差 对应的那一档
//   合计   = 用时分 + 质量分
//   没完成 = -没完成扣分
//
// 「向上取整」:超 1 分钟也算一档。规定 40 分钟、每 10 分钟一档,用了 41 分钟就扣一档,50 分钟也是一档,51 分钟两档。

export const QUALITIES = ['excellent', 'good', 'fair', 'poor'] as const;
export type Quality = (typeof QUALITIES)[number];

export const QUALITY_LABEL: Record<Quality, string> = { excellent: '优', good: '良', fair: '中', poor: '差' };

/** 一项作业计分要用的参数:规则上的,或布置时抄下来的快照 */
export interface ScoreParams {
  target_minutes: number;
  ontime_points: number;
  overtime_step: number;
  overtime_penalty: number;
  overtime_cap: number;
  q_excellent: number;
  q_good: number;
  q_fair: number;
  q_poor: number;
  missed_penalty: number;
}

export interface ScoreResult {
  time_points: number;
  quality_points: number;
  total: number;
  /** 一句话讲清楚这个分是怎么来的,页面和接口直接展示 */
  explain: string;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function qualityPoints(params: ScoreParams, quality: Quality): number {
  switch (quality) {
    case 'excellent': return params.q_excellent;
    case 'good': return params.q_good;
    case 'fair': return params.q_fair;
    case 'poor': return params.q_poor;
  }
}

export function scoreResult(params: ScoreParams, actualMinutes: number, quality: Quality): ScoreResult {
  const over = actualMinutes - params.target_minutes;
  let timePoints: number;
  let timeText: string;
  if (over <= 0) {
    timePoints = params.ontime_points;
    timeText = over === 0
      ? `刚好按时(${params.target_minutes} 分钟) ${signed(timePoints)}`
      : `提前 ${-over} 分钟完成 ${signed(timePoints)}`;
  } else {
    const steps = Math.ceil(over / params.overtime_step);
    const raw = steps * params.overtime_penalty;
    const deducted = Math.min(params.overtime_cap, raw);
    // 0 - x 而不是 -x:扣 0 分时 -x 会得到 -0,序列化没事,比较与展示会出怪
    timePoints = 0 - deducted;
    timeText = deducted === 0
      ? `超时 ${over} 分钟,不扣分`
      : `超时 ${over} 分钟,按每 ${params.overtime_step} 分钟扣 ${params.overtime_penalty} 分扣 ${deducted} 分`
        + (raw > deducted ? `(已到上限 ${params.overtime_cap} 分)` : '');
  }
  const qp = qualityPoints(params, quality);
  const total = timePoints + qp;
  return {
    time_points: timePoints,
    quality_points: qp,
    total,
    explain: `${timeText};质量${QUALITY_LABEL[quality]} ${signed(qp)};合计 ${signed(total)}`,
  };
}

export function scoreMissed(params: ScoreParams): ScoreResult {
  const total = 0 - params.missed_penalty;
  return {
    time_points: 0,
    quality_points: 0,
    total,
    explain: params.missed_penalty ? `没完成,扣 ${params.missed_penalty} 分` : '没完成,不扣分',
  };
}
