<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, urlMac, type CreditLedgerItem } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { signed, useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, formatTime, toastError } from '../../ui';

// 流水:每一笔加减分,余额就是它们的总和。撤销会追加一条反向记录,原记录保留。
// 每笔都看得出是谁动的:页面、哪把外部密钥、还是智能体(孩子通过小单兑换)。

const { mac, refresh } = useCreditChild();
const items = ref<CreditLedgerItem[]>([]);
const next = ref<number | null>(null);
const kind = ref<'' | CreditLedgerItem['kind']>('');

const KIND: Record<CreditLedgerItem['kind'], { text: string; tone: string }> = {
  task: { text: '作业', tone: 'ok' },
  missed: { text: '没完成', tone: 'warn' },
  redeem: { text: '兑换', tone: 'violet' },
  adjust: { text: '手动', tone: 'sky' },
  revert: { text: '撤销', tone: '' },
};
const sourceText = (item: CreditLedgerItem) =>
  item.source === 'agent' ? `智能体${item.actor ? `「${item.actor}」` : ''}`
    : item.source === 'api' ? `密钥${item.actor ? `「${item.actor}」` : ''}` : '页面';

async function load(more = false) {
  if (!mac.value) return;
  const params = new URLSearchParams({ mac: urlMac(mac.value) });
  if (kind.value) params.set('kind', kind.value);
  if (more && next.value) params.set('before', String(next.value));
  try {
    const data = await api.get<{ items: CreditLedgerItem[]; next: number | null }>(`/credits/ledger?${params}`);
    items.value = more ? [...items.value, ...data.items] : data.items;
    next.value = data.next;
  } catch (e) {
    toastError(e);
  }
}
watch([mac, kind], () => void load(), { immediate: true });

async function revert(item: CreditLedgerItem) {
  if (!(await confirmDialog({ title: `撤销「${item.title}」?`, message: `这一笔 ${signed(item.delta)} 分会被冲回;如果是作业打分,作业回到待完成。`, confirmText: '撤销' }))) return;
  try {
    await api.post(`/credits/ledger/${item.id}/revert`, {});
    await Promise.all([load(), refresh()]);
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <CreditHeader title="流水" description="每一笔加减分都在这里,余额就是它们的总和。撤销会追加一条反向记录,原记录保留。">
    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="clock" :size="18" />流水</h2></div>
        <div class="card-actions">
          <select v-model="kind" class="select" style="height: 32px; width: auto" aria-label="按类型筛选">
            <option value="">全部类型</option>
            <option v-for="(meta, key) in KIND" :key="key" :value="key">{{ meta.text }}</option>
          </select>
        </div>
      </div>
      <EmptyState v-if="items.length === 0" title="还没有记录" />
      <template v-else>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>时间</th><th>类型</th><th>内容</th><th>来源</th><th>分数</th><th>余额</th><th></th></tr></thead>
            <tbody>
              <tr v-for="l in items" :key="l.id" :class="{ reverted: l.reverted_by }">
                <td class="nowrap mono">{{ formatTime(l.created_at) }}</td>
                <td><span class="tag" :class="KIND[l.kind].tone">{{ KIND[l.kind].text }}</span></td>
                <td>{{ l.title }}<div v-if="l.note" class="cell-sub">{{ l.note }}</div></td>
                <td class="nowrap cell-sub">{{ sourceText(l) }}</td>
                <td class="nowrap points" :class="{ negative: l.delta < 0 }">{{ signed(l.delta) }}</td>
                <td class="nowrap mono">{{ l.balance_after }}</td>
                <td class="actions">
                  <span v-if="l.reverted_by" class="cell-sub">已撤销</span>
                  <button v-else-if="l.kind !== 'revert'" class="btn btn-ghost btn-sm" type="button" @click="revert(l)"><AppIcon name="refresh" :size="14" /><span>撤销</span></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="next" class="row" style="justify-content: center; margin-top: 12px">
          <button class="btn btn-sm" type="button" @click="load(true)">加载更多</button>
        </div>
      </template>
    </section>
  </CreditHeader>
</template>

<style scoped>
.negative { color: var(--red); }
.points { font-weight: 700; font-variant-numeric: tabular-nums; }
tr.reverted td { opacity: 0.55; }
tr.reverted td.points { text-decoration: line-through; }
</style>
