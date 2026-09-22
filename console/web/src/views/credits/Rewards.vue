<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, urlMac, type CreditReward, type CreditRewardKind } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, toast, toastError } from '../../ui';

// 兑换奖励:按整份兑换,分够才能换;惩罚可以把分扣成负数,要先挣回来。手动加减分也在这里。
// 三种奖励:物品(换了就完事)、时间(10 分 = 5 分钟游戏)、零花钱(10 分 = 5 元)。
// 时间和零花钱换到后进各自的余额,用掉 / 花掉在「钱与时间」页记。

const { mac, child, refresh } = useCreditChild();
const rewards = ref<CreditReward[]>([]);
const showArchived = ref(false);
const balance = computed(() => child.value?.balance ?? 0);

async function load() {
  if (!mac.value) return;
  try {
    rewards.value = (await api.get<{ items: CreditReward[] }>(`/credits/rewards?mac=${urlMac(mac.value)}${showArchived.value ? '&archived=1' : ''}`)).items;
  } catch (e) {
    toastError(e);
  }
}
watch([mac, showArchived], () => void load(), { immediate: true });

const active = computed(() => rewards.value.filter((r) => !r.archived));
const archived = computed(() => rewards.value.filter((r) => r.archived));

async function addExamples() {
  try {
    const result = await api.post<{ rules: number; rewards: number }>('/credits/examples', { mac: mac.value });
    toast(`已添加 ${result.rewards} 个奖励、${result.rules} 条规则,可以再按自家情况改`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

const KINDS: { key: CreditRewardKind; label: string; unit: string; hint: string }[] = [
  { key: 'time', label: '时间', unit: '分钟', hint: '比如玩游戏、看电视:换到的分钟存进余额,玩的时候再记用掉' },
  { key: 'money', label: '零花钱', unit: '元', hint: '换到的钱存进零花钱余额,花的时候再记一笔,可以精确到分' },
  { key: 'item', label: '物品', unit: '份', hint: '买个小玩具、去一次公园:换了就完事,没有余额' },
];
const unitOf = (kind: CreditRewardKind) => KINDS.find((k) => k.key === kind)!.unit;
/** 「10 分 = 5 分钟」;物品是「200 分」 */
const rate = (r: CreditReward) => (r.kind === 'item' ? `${r.cost} 分` : `${r.cost} 分 = ${r.amount} ${r.unit}`);
/** 钱按分算,避免 0.1 + 0.2 这种小数误差 */
const times = (r: CreditReward, n: number) => (r.kind === 'money' ? Math.round(r.amount * 100 * n) / 100 : r.amount * n);
const most = (r: CreditReward) => Math.min(100, Math.floor(Math.max(0, balance.value) / r.cost));

const redeemOpen = ref(false);
const redeeming = ref<CreditReward | null>(null);
const portions = ref(1);
function openRedeem(reward: CreditReward) {
  redeeming.value = reward;
  portions.value = 1;
  redeemOpen.value = true;
}
async function redeem() {
  const reward = redeeming.value;
  if (!reward) return;
  try {
    await api.post('/credits/redeem', { mac: mac.value, reward_id: reward.id, times: portions.value });
    toast(`兑换成功:${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}`
      + (reward.kind === 'item' ? (portions.value > 1 ? ` ×${portions.value}` : '') : ` ${times(reward, portions.value)} ${reward.unit}`));
    redeemOpen.value = false;
    await Promise.all([load(), refresh()]);
  } catch (e) {
    toastError(e);
  }
}

const rewardOpen = ref(false);
const editing = ref<CreditReward | null>(null);
const form = ref({ name: '', cost: 10, emoji: '', kind: 'time' as CreditRewardKind, amount: 5 });
function openReward(reward?: CreditReward) {
  editing.value = reward ?? null;
  form.value = reward
    ? { name: reward.name, cost: reward.cost, emoji: reward.emoji, kind: reward.kind, amount: reward.amount }
    : { name: '', cost: 10, emoji: '', kind: 'time', amount: 5 };
  rewardOpen.value = true;
}
async function saveReward() {
  const body = {
    name: form.value.name.trim(), cost: Number(form.value.cost), emoji: form.value.emoji.trim(), kind: form.value.kind,
    ...(form.value.kind === 'item' ? {} : { amount: Number(form.value.amount) }),
  };
  try {
    if (editing.value) await api.patch(`/credits/rewards/${editing.value.id}`, body);
    else await api.post('/credits/rewards', { mac: mac.value, ...body });
    rewardOpen.value = false;
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function removeReward(reward: CreditReward) {
  if (!(await confirmDialog({ title: `删除奖励「${reward.name}」?`, message: '兑换过的奖励只会停用,可以再恢复;流水里的记录不受影响。', confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/credits/rewards/${reward.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function restore(reward: CreditReward) {
  try {
    await api.post(`/credits/rewards/${reward.id}/restore`, {});
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function move(reward: CreditReward, step: -1 | 1) {
  const ids = active.value.map((r) => r.id);
  const from = ids.indexOf(reward.id);
  const to = from + step;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  try {
    rewards.value = (await api.post<{ items: CreditReward[] }>('/credits/rewards/reorder', { mac: mac.value, ids })).items
      .concat(archived.value);
  } catch (e) {
    toastError(e);
  }
}

const adjustOpen = ref(false);
const adjustForm = ref({ delta: 5, reason: '' });
async function saveAdjust() {
  try {
    await api.post('/credits/adjust', { mac: mac.value, delta: Number(adjustForm.value.delta), reason: adjustForm.value.reason.trim() });
    adjustOpen.value = false;
    adjustForm.value = { delta: 5, reason: '' };
    await refresh();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <CreditHeader title="兑换奖励" description="按整份兑换,分够才能换;惩罚可以把分扣成负数,要先挣回来。换到的时间和零花钱存进余额,在「钱与时间」里记用掉。孩子也可以对小单说「换 15 分钟游戏」。">
    <template #actions>
      <button class="btn btn-sm" type="button" @click="adjustOpen = true"><AppIcon name="sliders" :size="14" /><span>手动加减分</span></button>
      <button class="btn btn-primary btn-sm" type="button" @click="openReward()"><AppIcon name="plus" :size="14" /><span>新奖励</span></button>
    </template>

    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="gift" :size="18" />奖励</h2></div>
        <div class="card-actions">
          <label class="row muted" style="gap: 6px"><input v-model="showArchived" type="checkbox" />显示已停用的</label>
        </div>
      </div>
      <EmptyState v-if="active.length === 0" title="还没有奖励" description="比如「10 分 = 5 分钟游戏」「10 分 = 5 元零花钱」「买个小玩具 200 分」。">
        <button class="btn btn-primary" type="button" @click="addExamples"><AppIcon name="plus" :size="16" /><span>添加示例</span></button>
      </EmptyState>
      <div v-else class="reward-grid">
        <div v-for="(r, index) in active" :key="r.id" class="reward">
          <div class="reward-emoji" aria-hidden="true">{{ r.emoji || '🎁' }}</div>
          <div class="reward-name">{{ r.name }}</div>
          <div class="reward-cost">{{ rate(r) }}</div>
          <div v-if="r.kind !== 'item'" class="reward-left">余额 {{ r.wallet_balance ?? 0 }} {{ r.unit }}</div>
          <button class="btn btn-primary btn-sm" type="button" :disabled="balance < r.cost" @click="openRedeem(r)">
            {{ balance < r.cost ? `还差 ${r.cost - balance} 分` : '兑换' }}
          </button>
          <div class="row reward-tools">
            <button class="btn btn-ghost btn-sm" type="button" aria-label="往前移" :disabled="index === 0" @click="move(r, -1)"><AppIcon name="arrowLeft" :size="14" /></button>
            <button class="btn btn-ghost btn-sm" type="button" aria-label="编辑" @click="openReward(r)"><AppIcon name="pencil" :size="14" /></button>
            <button class="btn btn-ghost btn-sm danger" type="button" aria-label="删除" @click="removeReward(r)"><AppIcon name="trash" :size="14" /></button>
            <button class="btn btn-ghost btn-sm" type="button" aria-label="往后移" :disabled="index === active.length - 1" @click="move(r, 1)"><AppIcon name="arrowRight" :size="14" /></button>
          </div>
        </div>
      </div>
    </section>

    <section v-if="showArchived && archived.length" class="card">
      <div class="card-head"><div><h2>已停用</h2><p>兑换过的奖励删除时只会停用。恢复后重新出现在上面。</p></div></div>
      <div class="table-wrap">
        <table class="table">
          <tbody>
            <tr v-for="r in archived" :key="r.id">
              <td class="cell-main">{{ r.emoji }} {{ r.name }}</td>
              <td class="nowrap">{{ rate(r) }}</td>
              <td class="nowrap cell-sub">{{ r.kind === 'item' ? '' : `余额 ${r.wallet_balance ?? 0} ${r.unit}` }}</td>
              <td class="actions"><button class="btn btn-sm" type="button" @click="restore(r)"><AppIcon name="refresh" :size="14" /><span>恢复</span></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </CreditHeader>

  <ModalDialog :open="rewardOpen" :title="editing ? '编辑奖励' : '新奖励'" @close="rewardOpen = false">
    <div class="form-grid">
      <label class="field"><span class="field-label">名称</span><input v-model="form.name" class="input" type="text" maxlength="40" placeholder="玩游戏" /></label>
      <label class="field"><span class="field-label">种类</span>
        <select v-model="form.kind" class="select">
          <option v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
        </select>
        <span class="field-hint">{{ KINDS.find((k) => k.key === form.kind)?.hint }}{{ editing ? '。兑换过的奖励不能再改种类' : '' }}</span>
      </label>
      <label class="field"><span class="field-label">一份要多少分</span><input v-model.number="form.cost" class="input" type="number" min="1" max="100000" /></label>
      <label v-if="form.kind !== 'item'" class="field"><span class="field-label">一份换多少{{ unitOf(form.kind) }}</span>
        <input v-model.number="form.amount" class="input" type="number" :min="form.kind === 'money' ? 0.01 : 1" :step="form.kind === 'money' ? 0.01 : 1" max="100000" />
        <span class="field-hint">{{ form.cost || '?' }} 分 = {{ form.amount || '?' }} {{ unitOf(form.kind) }}</span>
      </label>
      <label class="field"><span class="field-label">图标(可选)</span><input v-model="form.emoji" class="input" type="text" maxlength="8" placeholder="🎮" /></label>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="rewardOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="saveReward">保存</button>
    </template>
  </ModalDialog>

  <ModalDialog :open="redeemOpen" :title="redeeming ? `兑换「${redeeming.name}」` : '兑换'" @close="redeemOpen = false">
    <template v-if="redeeming">
      <p class="muted" style="margin: 0 0 12px">{{ rate(redeeming) }},按整份兑换。现在有 {{ balance }} 分,最多换 {{ most(redeeming) }} 份。</p>
      <div class="stepper" role="group" aria-label="份数">
        <button class="btn btn-sm btn-icon" type="button" aria-label="少一份" :disabled="portions <= 1" @click="portions -= 1"><span aria-hidden="true">−</span></button>
        <span class="stepper-value">{{ portions }} 份</span>
        <button class="btn btn-sm btn-icon" type="button" aria-label="多一份" :disabled="portions >= most(redeeming)" @click="portions += 1"><AppIcon name="plus" :size="14" /></button>
      </div>
      <p class="redeem-sum">
        扣 <strong>{{ redeeming.cost * portions }}</strong> 分
        <template v-if="redeeming.kind !== 'item'"> → 得 <strong>{{ times(redeeming, portions) }}</strong> {{ redeeming.unit }}</template>
        ,兑换后剩 {{ balance - redeeming.cost * portions }} 分
      </p>
    </template>
    <template #footer>
      <button class="btn" type="button" @click="redeemOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="redeem">兑换</button>
    </template>
  </ModalDialog>

  <ModalDialog :open="adjustOpen" title="手动加减分" @close="adjustOpen = false">
    <div class="form-grid">
      <label class="field"><span class="field-label">分数</span><input v-model.number="adjustForm.delta" class="input" type="number" min="-1000" max="1000" />
        <span class="field-hint">加分填正数,扣分填负数</span></label>
      <label class="field"><span class="field-label">原因</span><input v-model="adjustForm.reason" class="input" type="text" maxlength="80" placeholder="主动帮忙做家务" /></label>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="adjustOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="saveAdjust">确定</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.reward-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
.reward {
  display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
  padding: 16px 12px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper);
}
.reward-emoji { font-size: 34px; line-height: 1; }
.reward-name { font-weight: 600; }
.reward-cost { color: var(--muted); font-variant-numeric: tabular-nums; }
.reward-left { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.stepper { display: flex; align-items: center; gap: 12px; }
.stepper-value { min-width: 64px; text-align: center; font-weight: 700; font-size: 18px; font-variant-numeric: tabular-nums; }
.redeem-sum { margin: 14px 0 0; font-variant-numeric: tabular-nums; }
.reward-tools { gap: 2px; }
</style>
