// 记忆曲线(Leitner 盒子)。答对升一盒、按盒子间隔推迟复习;答错回到 0 盒、几分钟后再考。

export const BOX_INTERVALS_MS = [
  5 * 60_000,            // 0:刚学或答错,5 分钟后再来
  1 * 86_400_000,        // 1
  2 * 86_400_000,        // 2
  4 * 86_400_000,        // 3
  7 * 86_400_000,        // 4
  15 * 86_400_000,       // 5:算掌握了,半个月回顾一次
];

export function nextBox(box: number, correct: boolean): number {
  return correct ? Math.min(5, box + 1) : 0;
}

export function dueAfter(box: number, now: Date): Date {
  return new Date(now.getTime() + BOX_INTERVALS_MS[Math.max(0, Math.min(5, box))]!);
}
