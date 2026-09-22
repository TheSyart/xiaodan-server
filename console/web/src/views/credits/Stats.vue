<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, urlMac, type CreditStats } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { useCreditChild } from '../../credits/useCreditChild';
import { toastError } from '../../ui';

// 统计:每天挣了多少、扣了多少、花了多少,各项作业的完成率与按时率。撤销过的不计。
//
// 图:每天一根,基线以上是挣的,以下依次叠扣的和花的——三者对余额的方向一目了然。
// 颜色按身份分三类,用 dataviz 的校验脚本验过:浅色直接用站点的 sky / sun / violet;
// 深色另取了三档(站点深色的 sky 与 violet 对红绿色弱者几乎一样,ΔE 0.6),
// 深色里的紫对底色只有 2.65:1,所以图下面必须有表格视图——就是那个「按天明细」。

const { mac } = useCreditChild();
const range = ref<7 | 30>(7);
const data = ref<CreditStats | null>(null);
const hover = ref<number | null>(null);

async function load() {
  if (!mac.value) return;
  try {
    const to = (await api.get<{ today: string }>('/credits/meta')).today;
    const from = shift(to, -(range.value - 1));
    data.value = await api.get<CreditStats>(`/credits/stats?mac=${urlMac(mac.value)}&from=${from}&to=${to}`);
  } catch (e) {
    toastError(e);
  }
}
watch([mac, range], () => void load(), { immediate: true });

function shift(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const percent = (value: number | null) => (value == null ? '—' : `${Math.round(value * 100)}%`);
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/** 上下两半共用一个刻度:以最高的一根(挣的,或扣+花)为满格 */
const scale = computed(() => {
  const days = data.value?.days ?? [];
  return Math.max(1, ...days.map((d) => Math.max(d.earned, d.penalty + d.spent)));
});
const pct = (value: number) => `${(value / scale.value) * 100}%`;
const empty = computed(() => !!data.value && data.value.days.every((d) => !d.earned && !d.penalty && !d.spent));
/** 30 天时日期太挤,只标每 5 天和最后一天 */
const showLabel = (index: number, total: number) => total <= 10 || index % 5 === 0 || index === total - 1;
</script>

<template>
  <CreditHeader title="统计" description="每天挣了多少、扣了多少、花了多少,各项作业的完成率与按时率。撤销过的不计。">
    <template #actions>
      <button class="btn btn-sm" :class="range === 7 ? 'btn-primary' : 'btn-ghost'" type="button" @click="range = 7">最近 7 天</button>
      <button class="btn btn-sm" :class="range === 30 ? 'btn-primary' : 'btn-ghost'" type="button" @click="range = 30">最近 30 天</button>
    </template>

    <template v-if="data">
      <div class="stat-grid">
        <div class="stat"><div><div class="stat-value">+{{ data.totals.earned }}</div><div class="stat-label">挣的</div></div></div>
        <div class="stat"><div><div class="stat-value">-{{ data.totals.penalty }}</div><div class="stat-label">扣的</div></div></div>
        <div class="stat"><div><div class="stat-value">-{{ data.totals.spent }}</div><div class="stat-label">花掉的</div></div></div>
        <div class="stat"><div><div class="stat-value">{{ percent(data.completion_rate) }}</div><div class="stat-label">完成率(完成 / 已判定)</div></div></div>
        <div class="stat"><div><div class="stat-value">{{ percent(data.ontime_rate) }}</div><div class="stat-label">按时率(按时 / 完成)</div></div></div>
      </div>

      <section class="card">
        <div class="card-head">
          <div><h2><AppIcon name="chart" :size="18" />每天的分</h2><p>基线以上是挣的,以下是扣的和花掉的。</p></div>
          <div class="legend" aria-hidden="true">
            <span><i class="swatch earned" />挣的</span>
            <span><i class="swatch penalty" />扣的</span>
            <span><i class="swatch spent" />花掉的</span>
          </div>
        </div>
        <EmptyState v-if="empty" title="这段时间还没有分数变动" />
        <template v-else>
          <div class="chart" role="img" :aria-label="`最近 ${range} 天每天挣、扣、花的分,明细见下方表格`">
            <div v-for="(d, index) in data.days" :key="d.day" class="col" tabindex="0"
              @mouseenter="hover = index" @mouseleave="hover = null" @focus="hover = index" @blur="hover = null">
              <div class="half up">
                <div v-if="d.earned" class="bar earned" :style="{ height: pct(d.earned) }" />
              </div>
              <div class="baseline" />
              <div class="half down">
                <div v-if="d.penalty" class="bar penalty" :class="{ end: !d.spent }" :style="{ height: pct(d.penalty) }" />
                <div v-if="d.spent" class="bar spent end" :style="{ height: pct(d.spent) }" />
              </div>
              <div class="label">{{ showLabel(index, data.days.length) ? shortDay(d.day) : '' }}</div>
              <div v-if="hover === index" class="tip" role="tooltip">
                <strong>{{ d.day }}</strong>
                <span>挣 +{{ d.earned }}</span><span>扣 -{{ d.penalty }}</span><span>花 -{{ d.spent }}</span>
                <span class="muted">净 {{ d.net > 0 ? '+' : '' }}{{ d.net }}</span>
              </div>
            </div>
          </div>
          <details class="table-view">
            <summary>按天明细</summary>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>日期</th><th>挣的</th><th>扣的</th><th>花掉的</th><th>净</th></tr></thead>
                <tbody>
                  <tr v-for="d in data.days" :key="d.day">
                    <td class="mono nowrap">{{ d.day }}</td><td>+{{ d.earned }}</td><td>-{{ d.penalty }}</td><td>-{{ d.spent }}</td>
                    <td>{{ d.net > 0 ? '+' : '' }}{{ d.net }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </template>
      </section>

      <section class="card">
        <div class="card-head"><div><h2><AppIcon name="calendar" :size="18" />各项作业</h2></div></div>
        <EmptyState v-if="!data.tasks.length" title="这段时间没有布置作业" />
        <div v-else class="table-wrap">
          <table class="table">
            <thead><tr><th>作业</th><th>布置</th><th>完成</th><th>没完成</th><th>按时</th><th>平均用时</th><th>平均得分</th></tr></thead>
            <tbody>
              <tr v-for="t in data.tasks" :key="t.name">
                <td class="cell-main">{{ t.name }}</td>
                <td>{{ t.assigned }}</td><td>{{ t.done }}</td><td>{{ t.missed }}</td><td>{{ t.ontime }}</td>
                <td class="nowrap">{{ t.avg_minutes == null ? '—' : `${t.avg_minutes} 分钟` }}</td>
                <td>{{ t.avg_points == null ? '—' : t.avg_points }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </CreditHeader>
</template>

<style>
/*
 * 图的三种颜色放在 :root 上,跟着站点主题走(选择器与 styles.css 的深浅色一致)。
 * 不能写在带 scoped 的块里:Vue 编译 :global(:root[data-theme=dark]) .card 时会把后面的 .card 丢掉,
 * 深色值落到 :root,而 scoped 的 .card 规则离柱子更近,浅色值永远赢。
 */
/* 浅色:站点自己的 sky / sun / violet,校验全过 */
:root { --credit-earned: #1689e8; --credit-penalty: #c77a05; --credit-spent: #6a4dd0; }
/* 深色:另取的三档,校验全过(紫对底色 2.65:1,由下方表格视图兜底) */
:root[data-theme='dark'] { --credit-earned: #4299e9; --credit-penalty: #b57e19; --credit-spent: #6049ca; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { --credit-earned: #4299e9; --credit-penalty: #b57e19; --credit-spent: #6049ca; }
}
</style>

<style scoped>

.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.swatch.earned { background: var(--credit-earned); }
.swatch.penalty { background: var(--credit-penalty); }
.swatch.spent { background: var(--credit-spent); }

.chart { display: flex; align-items: stretch; gap: 4px; height: 240px; padding: 8px 0 22px; }
.col { position: relative; flex: 1; min-width: 6px; display: flex; flex-direction: column; outline: none; border-radius: 6px; }
.col:hover, .col:focus-visible { background: color-mix(in srgb, var(--paper-2) 70%, transparent); }
.half { flex: 1; display: flex; flex-direction: column; align-items: center; }
.half.up { justify-content: flex-end; }
.half.down { justify-content: flex-start; gap: 2px; }   /* 2px 底色缝隔开叠在一起的两段 */
.baseline { height: 1px; background: var(--line); }
.bar { width: min(70%, 28px); }
.bar.earned { background: var(--credit-earned); border-radius: 4px 4px 0 0; }   /* 圆角只在远离基线的一端 */
.bar.penalty { background: var(--credit-penalty); }
.bar.spent { background: var(--credit-spent); }
.bar.end { border-radius: 0 0 4px 4px; }
.label { position: absolute; bottom: -20px; left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--muted); white-space: nowrap; }
.tip {
  position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 2;
  display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; min-width: 110px;
  background: var(--paper); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 4px 14px rgb(0 0 0 / 0.12);
  font-size: 12px; color: var(--ink); white-space: nowrap; pointer-events: none;
}
.table-view { margin-top: 10px; }
.table-view summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
</style>
