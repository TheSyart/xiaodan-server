<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api, urlMac, type CreditWallet, type CreditWalletEntry } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, formatTime, toast, toastError } from '../../ui';

// 钱与时间:时间 / 零花钱奖励换到手之后的余额,一个奖励一个账户(游戏和电视的分钟分开算)。
// 余额 = 账户流水之和,不会小于 0:用掉 / 花掉不能超过余额;兑换进来的要在「流水」里撤销那次兑换。

const { mac, refresh } = useCreditChild();
const wallets = ref<CreditWallet[]>([]);
const entries = ref<CreditWalletEntry[]>([]);
const next = ref<number | null>(null);
const filter = ref<number | ''>('');

const KIND: Record<CreditWalletEntry['kind'], { text: string; tone: string }> = {
  redeem: { text: '兑换', tone: 'violet' },
  use: { text: '用掉', tone: 'warn' },
  adjust: { text: '调整', tone: 'sky' },
  revert: { text: '撤销', tone: '' },
};
const sourceText = (item: CreditWalletEntry) =>
  item.source === 'agent' ? `智能体${item.actor ? `「${item.actor}」` : ''}`
    : item.source === 'api' ? (item.actor || '外部接口') : '页面';
const signedAmount = (n: number) => (n > 0 ? `+${n}` : String(n));

async function loadWallets() {
  if (!mac.value) return;
  try {
    wallets.value = (await api.get<{ items: CreditWallet[] }>(`/credits/wallets?mac=${urlMac(mac.value)}`)).items;
  } catch (e) {
    toastError(e);
  }
}
async function loadEntries(more = false) {
  if (!mac.value) return;
  const params = new URLSearchParams({ mac: urlMac(mac.value) });
  if (filter.value) params.set('reward_id', String(filter.value));
  if (more && next.value) params.set('before', String(next.value));
  try {
    const data = await api.get<{ items: CreditWalletEntry[]; next: number | null }>(`/credits/wallets/entries?${params}`);
    entries.value = more ? [...entries.value, ...data.items] : data.items;
    next.value = data.next;
  } catch (e) {
    toastError(e);
  }
}
const reload = () => Promise.all([loadWallets(), loadEntries(), refresh()]);
watch(mac, () => void Promise.all([loadWallets(), loadEntries()]), { immediate: true });
watch(filter, () => void loadEntries());

const moneyTotal = computed(() => wallets.value.filter((w) => w.kind === 'money'));

const dialog = ref<{ mode: 'use' | 'adjust'; wallet: CreditWallet } | null>(null);
const form = ref({ amount: 0, reason: '' });
function open(mode: 'use' | 'adjust', wallet: CreditWallet) {
  dialog.value = { mode, wallet };
  form.value = { amount: wallet.kind === 'money' ? 1 : 10, reason: '' };
}
async function save() {
  if (!dialog.value) return;
  const { mode, wallet } = dialog.value;
  try {
    const result = await api.post<{ balance: number; unit: string }>(`/credits/wallets/${mode}`, {
      mac: mac.value, reward_id: wallet.reward_id, amount: Number(form.value.amount), reason: form.value.reason.trim(),
    });
    toast(`已记下,「${wallet.name}」还剩 ${result.balance} ${result.unit}`);
    dialog.value = null;
    await reload();
  } catch (e) {
    toastError(e);
  }
}

async function revert(item: CreditWalletEntry) {
  if (!(await confirmDialog({
    title: `撤销「${item.title}」?`,
    message: `这一笔 ${signedAmount(item.amount)} ${item.unit} 会被冲回,原记录保留。`,
    confirmText: '撤销',
  }))) return;
  try {
    await api.post(`/credits/wallets/entries/${item.id}/revert`, {});
    await reload();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <CreditHeader title="钱与时间" description="时间和零花钱奖励换到手之后存在这里,一个奖励一个账户。玩了、花了就记一笔用掉,不能超过余额。">
    <EmptyState
      v-if="wallets.length === 0"
      title="还没有时间或零花钱类的奖励"
      description="在「兑换奖励」里新建一个种类为时间或零花钱的奖励,比如「10 分 = 5 分钟游戏」「10 分 = 5 元」。"
    >
      <RouterLink class="btn btn-primary" to="/credits/rewards"><AppIcon name="gift" :size="16" /><span>去建奖励</span></RouterLink>
    </EmptyState>

    <template v-else>
      <div class="wallet-grid">
        <section v-for="w in wallets" :key="w.reward_id" class="card wallet">
          <div class="wallet-head">
            <span class="wallet-emoji" aria-hidden="true">{{ w.emoji || (w.kind === 'money' ? '💰' : '⏱️') }}</span>
            <div>
              <div class="wallet-name">{{ w.name }}<span v-if="w.archived" class="tag" style="margin-left: 6px">已停用</span></div>
              <div class="cell-sub">{{ w.kind === 'money' ? '零花钱' : '时间' }}</div>
            </div>
          </div>
          <div class="wallet-balance"><strong>{{ w.balance }}</strong> {{ w.unit }}</div>
          <dl class="wallet-stats">
            <div><dt>累计兑换</dt><dd>{{ w.redeemed }} {{ w.unit }}</dd></div>
            <div><dt>累计{{ w.kind === 'money' ? '花掉' : '用掉' }}</dt><dd>{{ w.used }} {{ w.unit }}</dd></div>
          </dl>
          <div class="row wallet-actions">
            <button class="btn btn-primary btn-sm" type="button" :disabled="w.balance <= 0" @click="open('use', w)">
              <AppIcon name="check" :size="14" /><span>{{ w.kind === 'money' ? '记一笔花费' : '记用掉' }}</span>
            </button>
            <button class="btn btn-sm" type="button" @click="open('adjust', w)"><AppIcon name="sliders" :size="14" /><span>调整</span></button>
          </div>
        </section>
      </div>

      <p v-if="moneyTotal.length" class="muted money-note">
        零花钱一共兑换出 {{ Math.round(moneyTotal.reduce((n, w) => n + w.redeemed, 0) * 100) / 100 }} 元,
        花掉 {{ Math.round(moneyTotal.reduce((n, w) => n + w.used, 0) * 100) / 100 }} 元,
        还剩 {{ Math.round(moneyTotal.reduce((n, w) => n + w.balance, 0) * 100) / 100 }} 元。
      </p>

      <section class="card">
        <div class="card-head">
          <div><h2><AppIcon name="clock" :size="18" />账目</h2><p>兑换进来的要撤销,去「流水」里撤销那次兑换,分和余额一起退。</p></div>
          <div class="card-actions">
            <select v-model="filter" class="select" style="height: 32px; width: auto" aria-label="按账户筛选">
              <option value="">全部账户</option>
              <option v-for="w in wallets" :key="w.reward_id" :value="w.reward_id">{{ w.emoji }} {{ w.name }}</option>
            </select>
          </div>
        </div>
        <EmptyState v-if="entries.length === 0" title="还没有记录" />
        <template v-else>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>时间</th><th>账户</th><th>类型</th><th>内容</th><th>来源</th><th>数额</th><th>余额</th><th></th></tr></thead>
              <tbody>
                <tr v-for="e in entries" :key="e.id" :class="{ reverted: e.reverted_by }">
                  <td class="nowrap mono">{{ formatTime(e.created_at) }}</td>
                  <td class="nowrap">{{ e.reward_emoji }} {{ e.reward_name }}</td>
                  <td><span class="tag" :class="KIND[e.kind].tone">{{ KIND[e.kind].text }}</span></td>
                  <td>{{ e.title }}<div v-if="e.note" class="cell-sub">{{ e.note }}</div></td>
                  <td class="nowrap cell-sub">{{ sourceText(e) }}</td>
                  <td class="nowrap amount" :class="{ negative: e.amount < 0 }">{{ signedAmount(e.amount) }} {{ e.unit }}</td>
                  <td class="nowrap mono">{{ e.balance_after }} {{ e.unit }}</td>
                  <td class="actions">
                    <span v-if="e.reverted_by" class="cell-sub">已撤销</span>
                    <button v-else-if="e.kind === 'use' || e.kind === 'adjust'" class="btn btn-ghost btn-sm" type="button" @click="revert(e)">
                      <AppIcon name="refresh" :size="14" /><span>撤销</span>
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="next" class="row" style="justify-content: center; margin-top: 12px">
            <button class="btn btn-sm" type="button" @click="loadEntries(true)">加载更多</button>
          </div>
        </template>
      </section>
    </template>
  </CreditHeader>

  <ModalDialog
    :open="!!dialog"
    :title="dialog ? `${dialog.wallet.name}:${dialog.mode === 'use' ? (dialog.wallet.kind === 'money' ? '记一笔花费' : '记用掉') : '调整'}` : ''"
    @close="dialog = null"
  >
    <div v-if="dialog" class="form-grid">
      <label class="field">
        <span class="field-label">{{ dialog.mode === 'use' ? (dialog.wallet.kind === 'money' ? '花了多少元' : '用了多少分钟') : `加减多少${dialog.wallet.unit}` }}</span>
        <input
          v-model.number="form.amount" class="input" type="number"
          :min="dialog.mode === 'use' ? (dialog.wallet.kind === 'money' ? 0.01 : 1) : undefined"
          :step="dialog.wallet.kind === 'money' ? 0.01 : 1"
        />
        <span class="field-hint">
          现在余额 {{ dialog.wallet.balance }} {{ dialog.wallet.unit }}{{ dialog.mode === 'adjust' ? ',加填正数、减填负数,调完不能小于 0' : ',不能超过余额' }}
        </span>
      </label>
      <label class="field">
        <span class="field-label">{{ dialog.mode === 'use' ? '用在哪了' : '原因' }}</span>
        <input v-model="form.reason" class="input" type="text" maxlength="80" :placeholder="dialog.mode === 'use' ? (dialog.wallet.kind === 'money' ? '买文具' : '玩了一局') : '奶奶给的'" />
      </label>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="dialog = null">取消</button>
      <button class="btn btn-primary" type="button" @click="save">确定</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.wallet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-bottom: 12px; }
.wallet { display: flex; flex-direction: column; gap: 10px; margin: 0; }
.wallet-head { display: flex; align-items: center; gap: 10px; }
.wallet-emoji { font-size: 30px; line-height: 1; }
.wallet-name { font-weight: 600; }
.wallet-balance { font-size: 15px; color: var(--muted); }
.wallet-balance strong { font-size: 30px; color: var(--ink); font-variant-numeric: tabular-nums; margin-right: 2px; }
.wallet-stats { display: flex; gap: 20px; margin: 0; }
.wallet-stats dt { font-size: 12px; color: var(--muted); }
.wallet-stats dd { margin: 2px 0 0; font-variant-numeric: tabular-nums; }
.wallet-actions { gap: 6px; flex-wrap: wrap; }
.money-note { margin: 0 0 12px; }
.amount { font-weight: 700; font-variant-numeric: tabular-nums; }
.negative { color: var(--red); }
tr.reverted td { opacity: 0.55; }
tr.reverted td.amount { text-decoration: line-through; }
</style>
