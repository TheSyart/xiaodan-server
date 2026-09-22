<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  api, urlMac,
  type CreditKeyStatus, type CreditLedgerItem, type CreditOverview, type CreditParams, type CreditQuality,
  type CreditReward, type CreditRule, type CreditScore, type CreditTask,
} from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, formatTime, toast, toastError } from '../ui';

// 学分奖惩。按设备记账(一台设备 = 一个孩子)。
// 家长给每类作业定规则 → 每天布置 → 孩子做完录入用时与质量 → 算分;攒的分兑换奖励。
// 计分公式只在后端一处(console/src/credits/score.ts),这里的预览都是调接口算的。

type Tab = 'tasks' | 'rewards' | 'rules' | 'ledger';

const QUALITY: { key: CreditQuality; label: string }[] = [
  { key: 'excellent', label: '优' }, { key: 'good', label: '良' }, { key: 'fair', label: '中' }, { key: 'poor', label: '差' },
];
const qualityLabel = (key: CreditQuality | null) => QUALITY.find((q) => q.key === key)?.label ?? '';
const signed = (n: number | null | undefined) => (n == null ? '' : n > 0 ? `+${n}` : String(n));

const overview = ref<CreditOverview | null>(null);
const mac = ref('');
const tab = ref<Tab>('tasks');
const loading = ref(true);
const loadError = ref('');

const day = ref('');
const tasks = ref<CreditTask[]>([]);
const summary = ref({ total: 0, done: 0, points: 0 });
const rules = ref<CreditRule[]>([]);
const rewards = ref<CreditReward[]>([]);
const ledger = ref<CreditLedgerItem[]>([]);
const ledgerNext = ref<number | null>(null);
const balance = ref(0);
const keyStatus = ref<CreditKeyStatus | null>(null);
const shownKey = ref('');

const q = () => `?mac=${urlMac(mac.value)}`;

async function load() {
  loadError.value = '';
  try {
    const data = await api.get<CreditOverview>(`/credits/overview${mac.value ? q() : ''}`);
    overview.value = data;
    if (!day.value) day.value = data.today;
    if (!data.device) return;
    if (mac.value !== data.device.mac) {
      mac.value = data.device.mac;   // 触发 watch 再来一遍
      return;
    }
    balance.value = data.balance ?? 0;
    await Promise.all([loadTasks(), loadRules(), loadRewards(), loadLedger(), loadKey()]);
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(mac, () => {
  shownKey.value = '';
  void load();
});
watch(day, () => {
  if (mac.value) void loadTasks();
});

async function loadTasks() {
  const data = await api.get<{ items: CreditTask[]; summary: typeof summary.value }>(`/credits/tasks${q()}&day=${day.value}`);
  tasks.value = data.items;
  summary.value = data.summary;
}
async function loadRules() {
  rules.value = (await api.get<{ items: CreditRule[] }>(`/credits/rules${q()}`)).items;
}
async function loadRewards() {
  const data = await api.get<{ items: CreditReward[]; balance: number }>(`/credits/rewards${q()}`);
  rewards.value = data.items;
  balance.value = data.balance;
}
async function loadLedger(more = false) {
  const before = more && ledgerNext.value ? `&before=${ledgerNext.value}` : '';
  const data = await api.get<{ items: CreditLedgerItem[]; next: number | null; balance: number }>(`/credits/ledger${q()}${before}`);
  ledger.value = more ? [...ledger.value, ...data.items] : data.items;
  ledgerNext.value = data.next;
  balance.value = data.balance;
}
async function loadKey() {
  keyStatus.value = await api.get<CreditKeyStatus>('/credits/key');
}
/** 改了分数的操作之后,把受影响的几块一起刷新 */
async function refreshMoney() {
  await Promise.all([loadTasks(), loadLedger(), loadRewards()]);
}

const deviceName = (item: { mac: string; alias: string }) => item.alias || item.mac;
const empty = computed(() => rules.value.length === 0 && rewards.value.length === 0);

async function addExamples() {
  try {
    const result = await api.post<{ rules: number; rewards: number }>('/credits/examples', { mac: mac.value });
    toast(`已添加 ${result.rules} 条规则、${result.rewards} 个奖励,可以再按自家情况改`);
    await Promise.all([loadRules(), loadRewards()]);
  } catch (e) {
    toastError(e);
  }
}

// ---------------------------------------------------------------- 今日作业

const STATUS: Record<CreditTask['status'], { text: string; tone: string }> = {
  pending: { text: '待完成', tone: 'sky' },
  done: { text: '已完成', tone: 'ok' },
  missed: { text: '没完成', tone: 'warn' },
};
const isToday = computed(() => day.value === overview.value?.today);

const assignOpen = ref(false);
const assignPick = ref<Record<number, { on: boolean; minutes: number }>>({});
const assigning = ref(false);
function openAssign() {
  assignPick.value = Object.fromEntries(rules.value.map((r) => [r.id, { on: false, minutes: r.target_minutes }]));
  assignOpen.value = true;
}
async function assign() {
  const items = rules.value
    .filter((r) => assignPick.value[r.id]?.on)
    .map((r) => ({ rule_id: r.id, target_minutes: assignPick.value[r.id]!.minutes }));
  if (!items.length) return toast('先勾选要布置的作业', 'warn');
  assigning.value = true;
  try {
    await api.post('/credits/tasks', { mac: mac.value, day: day.value, items });
    assignOpen.value = false;
    await loadTasks();
  } catch (e) {
    toastError(e);
  } finally {
    assigning.value = false;
  }
}

const resultTask = ref<CreditTask | null>(null);
const resultForm = ref({ minutes: 0, quality: 'good' as CreditQuality, note: '' });
const resultPreview = ref<CreditScore | null>(null);
const saving = ref(false);
function openResult(task: CreditTask) {
  resultTask.value = task;
  resultForm.value = { minutes: task.target_minutes, quality: 'good', note: '' };
  void previewResult();
}
let previewSeq = 0;
async function previewResult() {
  const task = resultTask.value;
  if (!task || !Number.isInteger(resultForm.value.minutes) || resultForm.value.minutes < 0) return;
  const seq = ++previewSeq;
  try {
    const data = await api.post<{ score: CreditScore }>(`/credits/tasks/${task.id}/result`, {
      actual_minutes: resultForm.value.minutes, quality: resultForm.value.quality, preview: true,
    });
    if (seq === previewSeq) resultPreview.value = data.score;
  } catch {
    if (seq === previewSeq) resultPreview.value = null;
  }
}
watch(() => [resultForm.value.minutes, resultForm.value.quality], () => void previewResult());
async function saveResult() {
  const task = resultTask.value;
  if (!task) return;
  saving.value = true;
  try {
    const data = await api.post<{ score: CreditScore }>(`/credits/tasks/${task.id}/result`, {
      actual_minutes: resultForm.value.minutes, quality: resultForm.value.quality, note: resultForm.value.note.trim(),
    });
    toast(`${task.name}:${signed(data.score.total)} 分`);
    resultTask.value = null;
    await refreshMoney();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function markMissed(task: CreditTask) {
  const penalty = task.missed_penalty ? `,扣 ${task.missed_penalty} 分` : '';
  if (!(await confirmDialog({ title: `「${task.name}」没完成?`, message: `记为没完成${penalty}。之后可以在流水里撤销。`, confirmText: '记为没完成', danger: true }))) return;
  try {
    await api.post(`/credits/tasks/${task.id}/missed`, {});
    await refreshMoney();
  } catch (e) {
    toastError(e);
  }
}

async function removeTask(task: CreditTask) {
  try {
    await api.del(`/credits/tasks/${task.id}`);
    await loadTasks();
  } catch (e) {
    toastError(e);
  }
}

async function undoTask(task: CreditTask) {
  if (!task.ledger_id) return;
  if (!(await confirmDialog({ title: `撤销「${task.name}」的打分?`, message: '分数退回,作业回到待完成,可以重新录入。', confirmText: '撤销' }))) return;
  try {
    await api.post(`/credits/ledger/${task.ledger_id}/revert`, {});
    await refreshMoney();
  } catch (e) {
    toastError(e);
  }
}

// ---------------------------------------------------------------- 奖励

const rewardOpen = ref(false);
const rewardEditing = ref<CreditReward | null>(null);
const rewardForm = ref({ name: '', cost: 20, emoji: '' });
function openReward(reward?: CreditReward) {
  rewardEditing.value = reward ?? null;
  rewardForm.value = reward ? { name: reward.name, cost: reward.cost, emoji: reward.emoji } : { name: '', cost: 20, emoji: '' };
  rewardOpen.value = true;
}
async function saveReward() {
  const body = { name: rewardForm.value.name.trim(), cost: Number(rewardForm.value.cost), emoji: rewardForm.value.emoji.trim() };
  try {
    if (rewardEditing.value) await api.put(`/credits/rewards/${rewardEditing.value.id}`, body);
    else await api.post('/credits/rewards', { mac: mac.value, ...body });
    rewardOpen.value = false;
    await loadRewards();
  } catch (e) {
    toastError(e);
  }
}
async function removeReward(reward: CreditReward) {
  if (!(await confirmDialog({ title: `删除奖励「${reward.name}」?`, message: '兑换过的奖励只会停用,流水里的记录不受影响。', confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/credits/rewards/${reward.id}`);
    await loadRewards();
  } catch (e) {
    toastError(e);
  }
}
async function redeem(reward: CreditReward) {
  if (!(await confirmDialog({ title: `兑换「${reward.name}」?`, message: `扣 ${reward.cost} 分,兑换后剩 ${balance.value - reward.cost} 分。`, confirmText: '兑换' }))) return;
  try {
    await api.post('/credits/redeem', { mac: mac.value, reward_id: reward.id });
    toast(`兑换成功:${reward.emoji ? `${reward.emoji} ` : ''}${reward.name}`);
    await refreshMoney();
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
    await refreshMoney();
  } catch (e) {
    toastError(e);
  }
}

// ---------------------------------------------------------------- 规则

const DEFAULT_PARAMS: CreditParams = {
  target_minutes: 40, ontime_points: 5, overtime_step: 10, overtime_penalty: 1, overtime_cap: 5,
  q_excellent: 5, q_good: 3, q_fair: 0, q_poor: -2, missed_penalty: 5,
};
const ruleOpen = ref(false);
const ruleEditing = ref<CreditRule | null>(null);
const ruleForm = ref<CreditParams & { name: string }>({ name: '', ...DEFAULT_PARAMS });
const example = ref({ minutes: 55, quality: 'good' as CreditQuality });
const examplePreview = ref<CreditScore | null>(null);
function openRule(rule?: CreditRule) {
  ruleEditing.value = rule ?? null;
  ruleForm.value = rule
    ? { name: rule.name, ...Object.fromEntries(Object.keys(DEFAULT_PARAMS).map((k) => [k, rule[k as keyof CreditParams]])) as unknown as CreditParams }
    : { name: '', ...DEFAULT_PARAMS };
  example.value = { minutes: ruleForm.value.target_minutes + 15, quality: 'good' };
  ruleOpen.value = true;
}
const ruleParams = (): CreditParams =>
  Object.fromEntries(Object.keys(DEFAULT_PARAMS).map((k) => [k, Number(ruleForm.value[k as keyof CreditParams])])) as unknown as CreditParams;
let exampleSeq = 0;
async function previewExample() {
  if (!ruleOpen.value) return;
  const seq = ++exampleSeq;
  try {
    const data = await api.post<{ score: CreditScore }>('/credits/rules/preview', {
      params: ruleParams(), actual_minutes: Number(example.value.minutes), quality: example.value.quality,
    });
    if (seq === exampleSeq) examplePreview.value = data.score;
  } catch {
    if (seq === exampleSeq) examplePreview.value = null;   // 数值越界时先不显示,保存时会报具体原因
  }
}
watch([ruleForm, example, ruleOpen], () => void previewExample(), { deep: true });
async function saveRule() {
  const body = { name: ruleForm.value.name.trim(), ...ruleParams() };
  try {
    if (ruleEditing.value) await api.put(`/credits/rules/${ruleEditing.value.id}`, body);
    else await api.post('/credits/rules', { mac: mac.value, ...body });
    ruleOpen.value = false;
    await loadRules();
  } catch (e) {
    toastError(e);
  }
}
async function removeRule(rule: CreditRule) {
  if (!(await confirmDialog({ title: `删除规则「${rule.name}」?`, message: '布置过的作业不受影响;用过的规则只会停用,不再出现在布置列表里。', confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/credits/rules/${rule.id}`);
    await loadRules();
  } catch (e) {
    toastError(e);
  }
}
const overtimeText = (r: CreditParams) =>
  r.overtime_penalty ? `每超 ${r.overtime_step} 分钟 -${r.overtime_penalty},最多 -${r.overtime_cap}` : '不扣分';

// ---------------------------------------------------------------- 流水

const KIND: Record<CreditLedgerItem['kind'], { text: string; tone: string }> = {
  task: { text: '作业', tone: 'ok' },
  missed: { text: '没完成', tone: 'warn' },
  redeem: { text: '兑换', tone: 'violet' },
  adjust: { text: '手动', tone: 'sky' },
  revert: { text: '撤销', tone: '' },
};
async function revertLedger(item: CreditLedgerItem) {
  if (!(await confirmDialog({ title: `撤销「${item.title}」?`, message: `这一笔 ${signed(item.delta)} 分会被冲回;如果是作业打分,作业回到待完成。`, confirmText: '撤销' }))) return;
  try {
    await api.post(`/credits/ledger/${item.id}/revert`, {});
    await refreshMoney();
  } catch (e) {
    toastError(e);
  }
}

// ---------------------------------------------------------------- 外部接口

async function rotateKey() {
  if (keyStatus.value?.enabled && !(await confirmDialog({ title: '换一把新密钥?', message: '旧密钥立即失效,用旧密钥的快捷指令、程序都要换成新的。', confirmText: '换新密钥', danger: true }))) return;
  try {
    const data = await api.post<CreditKeyStatus>('/credits/key/rotate', {});
    shownKey.value = data.key ?? '';
    keyStatus.value = data;
  } catch (e) {
    toastError(e);
  }
}
async function disableKey() {
  if (!(await confirmDialog({ title: '关闭外部接口?', message: '密钥作废,/open/credits 全部停止服务。页面不受影响。', confirmText: '关闭', danger: true }))) return;
  try {
    keyStatus.value = await api.del<CreditKeyStatus>('/credits/key');
    shownKey.value = '';
  } catch (e) {
    toastError(e);
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败,请手动选中复制', 'warn');
  }
}
const origin = typeof window === 'undefined' ? '' : window.location.origin;
const curlExample = computed(() => {
  const key = shownKey.value || '<你的密钥>';
  const m = urlMac(mac.value);
  return [
    '# 查余额和今天的作业',
    `curl -H "Authorization: Bearer ${key}" "${origin}/open/credits/overview?mac=${m}"`,
    '',
    '# 录入一项作业的结果(id 从 /open/credits/tasks?mac=… 里拿)',
    `curl -X POST -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\`,
    `  -d '{"actual_minutes":45,"quality":"good"}' "${origin}/open/credits/tasks/<id>/result"`,
    '',
    '# 手动加分',
    `curl -X POST -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\`,
    `  -d '{"mac":"${m}","delta":5,"reason":"主动做家务"}' "${origin}/open/credits/adjust"`,
  ].join('\n');
});
</script>

<template>
  <PageHeader title="学分" description="给作业定规则、每天布置、做完录入用时与质量自动算分;攒的分兑换奖励。按设备记账,一台设备就是一个孩子。">
    <template #actions>
      <select v-if="(overview?.devices.length ?? 0) > 1" v-model="mac" class="select" style="height: 32px; width: auto" aria-label="选择设备">
        <option v-for="item in overview?.devices ?? []" :key="item.mac" :value="item.mac">{{ deviceName(item) }}</option>
      </select>
    </template>
  </PageHeader>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <section v-else-if="!overview?.device" class="card">
    <EmptyState title="还没有绑定设备" description="学分按设备记账,先绑定一台设备。">
      <RouterLink class="btn btn-primary" to="/devices"><AppIcon name="device" :size="16" /><span>去绑定设备</span></RouterLink>
    </EmptyState>
  </section>

  <template v-else>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-icon"><AppIcon name="medal" :size="20" /></div>
        <div><div class="stat-value" :class="{ negative: balance < 0 }">{{ balance }}</div><div class="stat-label">当前学分</div></div>
      </div>
      <div class="stat">
        <div class="stat-icon"><AppIcon name="check" :size="20" /></div>
        <div><div class="stat-value">{{ summary.done }} / {{ summary.total }}</div><div class="stat-label">{{ isToday ? '今天' : day }}完成</div></div>
      </div>
      <div class="stat">
        <div class="stat-icon"><AppIcon name="sparkles" :size="20" /></div>
        <div><div class="stat-value" :class="{ negative: summary.points < 0 }">{{ signed(summary.points) || 0 }}</div><div class="stat-label">{{ isToday ? '今天' : day }}得分</div></div>
      </div>
    </div>

    <div v-if="empty" class="callout info">
      <AppIcon name="info" :size="18" />
      <div class="callout-body">
        <strong>这台设备还没有规则和奖励。</strong>可以先添加一组示例(语文、数学、英语三条作业规则;看电视、玩手机、买玩具三个奖励),再按自家情况改。
        <div class="callout-actions"><button class="btn btn-primary btn-sm" type="button" @click="addExamples"><AppIcon name="plus" :size="14" /><span>添加示例</span></button></div>
      </div>
    </div>

    <nav class="credit-tabs" aria-label="学分分区">
      <button v-for="t in ([['tasks', '作业', 'calendar'], ['rewards', '兑换奖励', 'gift'], ['rules', '作业规则', 'sliders'], ['ledger', '流水', 'clock']] as const)"
        :key="t[0]" type="button" class="btn btn-sm" :class="tab === t[0] ? 'btn-primary' : 'btn-ghost'" :aria-pressed="tab === t[0]" @click="tab = t[0]">
        <AppIcon :name="t[2]" :size="14" /><span>{{ t[1] }}</span>
      </button>
    </nav>

    <!-- 作业 -->
    <section v-if="tab === 'tasks'" class="card">
      <div class="card-head">
        <div><h2><AppIcon name="calendar" :size="18" />{{ isToday ? '今天的作业' : `${day} 的作业` }}</h2><p>孩子做完后录入实际用时和质量,按这项作业布置时的规则算分。</p></div>
        <div class="card-actions">
          <input v-model="day" class="input" type="date" style="height: 32px; width: auto" aria-label="日期" />
          <button v-if="!isToday" class="btn btn-sm" type="button" @click="day = overview?.today ?? day">回到今天</button>
          <button class="btn btn-primary btn-sm" type="button" :disabled="rules.length === 0" @click="openAssign"><AppIcon name="plus" :size="14" /><span>布置作业</span></button>
        </div>
      </div>
      <EmptyState v-if="tasks.length === 0" title="这一天还没有布置作业" :description="rules.length ? '点「布置作业」从规则里挑。' : '先在「作业规则」里建几条规则。'" />
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th>作业</th><th>规定用时</th><th>状态</th><th>结果</th><th>得分</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td class="cell-main">{{ t.name }}</td>
              <td class="nowrap">{{ t.target_minutes }} 分钟</td>
              <td><span class="tag dot" :class="STATUS[t.status].tone">{{ STATUS[t.status].text }}</span></td>
              <td>
                <template v-if="t.status === 'done'">用时 {{ t.actual_minutes }} 分钟 · 质量{{ qualityLabel(t.quality) }}</template>
                <span v-if="t.note" class="cell-sub"> · {{ t.note }}</span>
              </td>
              <td class="nowrap points" :class="{ negative: (t.total_points ?? 0) < 0 }">{{ signed(t.total_points) }}</td>
              <td class="actions">
                <template v-if="t.status === 'pending'">
                  <button class="btn btn-primary btn-sm" type="button" @click="openResult(t)"><AppIcon name="pencil" :size="14" /><span>录入结果</span></button>
                  <button class="btn btn-ghost btn-sm" type="button" @click="markMissed(t)">没完成</button>
                  <button class="btn btn-ghost btn-sm danger" type="button" aria-label="删除" @click="removeTask(t)"><AppIcon name="trash" :size="14" /></button>
                </template>
                <button v-else class="btn btn-ghost btn-sm" type="button" @click="undoTask(t)"><AppIcon name="refresh" :size="14" /><span>撤销</span></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 兑换奖励 -->
    <section v-if="tab === 'rewards'" class="card">
      <div class="card-head">
        <div><h2><AppIcon name="gift" :size="18" />兑换奖励</h2><p>分数够才能兑换;惩罚可以把分扣成负数,要先挣回来。</p></div>
        <div class="card-actions">
          <button class="btn btn-sm" type="button" @click="adjustOpen = true"><AppIcon name="sliders" :size="14" /><span>手动加减分</span></button>
          <button class="btn btn-primary btn-sm" type="button" @click="openReward()"><AppIcon name="plus" :size="14" /><span>新奖励</span></button>
        </div>
      </div>
      <EmptyState v-if="rewards.length === 0" title="还没有奖励" description="比如「看电视 30 分钟 20 分」「买个小玩具 200 分」。" />
      <div v-else class="reward-grid">
        <div v-for="r in rewards" :key="r.id" class="reward">
          <div class="reward-emoji" aria-hidden="true">{{ r.emoji || '🎁' }}</div>
          <div class="reward-name">{{ r.name }}</div>
          <div class="reward-cost">{{ r.cost }} 分</div>
          <button class="btn btn-primary btn-sm" type="button" :disabled="balance < r.cost" @click="redeem(r)">
            {{ balance < r.cost ? `还差 ${r.cost - balance} 分` : '兑换' }}
          </button>
          <div class="row reward-tools">
            <button class="btn btn-ghost btn-sm" type="button" aria-label="编辑" @click="openReward(r)"><AppIcon name="pencil" :size="14" /></button>
            <button class="btn btn-ghost btn-sm danger" type="button" aria-label="删除" @click="removeReward(r)"><AppIcon name="trash" :size="14" /></button>
          </div>
        </div>
      </div>
    </section>

    <!-- 作业规则 -->
    <section v-if="tab === 'rules'" class="card">
      <div class="card-head">
        <div><h2><AppIcon name="sliders" :size="18" />作业规则</h2><p>数值随时可以调。改规则只影响以后布置的作业,已经算过的分不会变。</p></div>
        <div class="card-actions"><button class="btn btn-primary btn-sm" type="button" @click="openRule()"><AppIcon name="plus" :size="14" /><span>新规则</span></button></div>
      </div>
      <EmptyState v-if="rules.length === 0" title="还没有作业规则" description="每类作业一条:规定用时多久、按时得几分、超时怎么扣、质量四档各几分。" />
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th>作业</th><th>规定用时</th><th>按时</th><th>超时</th><th>质量 优/良/中/差</th><th>没完成</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in rules" :key="r.id">
              <td class="cell-main">{{ r.name }}</td>
              <td class="nowrap">{{ r.target_minutes }} 分钟</td>
              <td class="nowrap">{{ signed(r.ontime_points) }}</td>
              <td>{{ overtimeText(r) }}</td>
              <td class="nowrap mono">{{ signed(r.q_excellent) }} / {{ signed(r.q_good) }} / {{ signed(r.q_fair) }} / {{ signed(r.q_poor) }}</td>
              <td class="nowrap">{{ r.missed_penalty ? `-${r.missed_penalty}` : '不扣' }}</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" type="button" aria-label="编辑" @click="openRule(r)"><AppIcon name="pencil" :size="14" /></button>
                <button class="btn btn-ghost btn-sm danger" type="button" aria-label="删除" @click="removeRule(r)"><AppIcon name="trash" :size="14" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 流水 -->
    <section v-if="tab === 'ledger'" class="card">
      <div class="card-head"><div><h2><AppIcon name="clock" :size="18" />流水</h2><p>每一笔加减分都在这里,余额就是它们的总和。撤销会追加一条反向记录,原记录保留。</p></div></div>
      <EmptyState v-if="ledger.length === 0" title="还没有任何记录" />
      <template v-else>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>时间</th><th>类型</th><th>内容</th><th>分数</th><th>余额</th><th></th></tr></thead>
            <tbody>
              <tr v-for="l in ledger" :key="l.id" :class="{ reverted: l.reverted_by }">
                <td class="nowrap mono">{{ formatTime(l.created_at) }}</td>
                <td><span class="tag" :class="KIND[l.kind].tone">{{ KIND[l.kind].text }}</span></td>
                <td>{{ l.title }}<div v-if="l.note" class="cell-sub">{{ l.note }}</div></td>
                <td class="nowrap points" :class="{ negative: l.delta < 0 }">{{ signed(l.delta) }}</td>
                <td class="nowrap mono">{{ l.balance_after }}</td>
                <td class="actions">
                  <span v-if="l.reverted_by" class="cell-sub">已撤销</span>
                  <button v-else-if="l.kind !== 'revert'" class="btn btn-ghost btn-sm" type="button" @click="revertLedger(l)"><AppIcon name="refresh" :size="14" /><span>撤销</span></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="ledgerNext" class="row" style="justify-content: center; margin-top: 12px">
          <button class="btn btn-sm" type="button" @click="loadLedger(true)">加载更多</button>
        </div>
      </template>
    </section>

    <!-- 外部接口 -->
    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="key" :size="18" />外部接口</h2>
          <p>给手机快捷指令、别的程序用:同一套接口挂在 <code>/open/credits</code> 下,带密钥就能调,不用登录控制台。密钥全家一把,只在生成时显示一次。</p>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" :class="keyStatus?.enabled ? '' : 'btn-primary'" type="button" @click="rotateKey">
            <AppIcon name="key" :size="14" /><span>{{ keyStatus?.enabled ? '换新密钥' : '生成密钥' }}</span>
          </button>
          <button v-if="keyStatus?.enabled" class="btn btn-ghost btn-sm danger" type="button" @click="disableKey">关闭</button>
        </div>
      </div>
      <p class="muted" style="margin: 0 0 10px">
        <template v-if="keyStatus?.enabled">已开启 · 生成于 {{ formatTime(keyStatus.created_at ?? '') }} · {{ keyStatus.last_used_at ? `最后使用 ${formatTime(keyStatus.last_used_at)}` : '还没用过' }}</template>
        <template v-else>未开启。</template>
      </p>
      <div v-if="shownKey" class="callout warn">
        <AppIcon name="alert" :size="18" />
        <div class="callout-body">
          <strong>这是唯一一次显示密钥,请现在复制保存。</strong>
          <div class="row" style="margin-top: 8px"><code class="mono key-text">{{ shownKey }}</code>
            <button class="btn btn-sm" type="button" @click="copy(shownKey)"><AppIcon name="copy" :size="14" /><span>复制</span></button></div>
        </div>
      </div>
      <pre class="code-block">{{ curlExample }}</pre>
      <p class="field-hint">外部接口在公网能打通,还需要在运维面板给 <code>/open/</code> 放行统一登录(见 README「学分奖惩」一节)。MAC 用去掉冒号的写法。</p>
    </section>
  </template>

  <!-- 布置作业 -->
  <ModalDialog :open="assignOpen" :title="`布置作业 · ${day}`" @close="assignOpen = false">
    <div class="stack" style="gap: 8px">
      <label v-for="r in rules" :key="r.id" class="assign-row">
        <input v-model="assignPick[r.id]!.on" type="checkbox" />
        <span class="assign-name">{{ r.name }}</span>
        <span class="row" style="gap: 6px">
          <input v-model.number="assignPick[r.id]!.minutes" class="input" type="number" min="1" max="600" style="width: 80px; height: 32px" :disabled="!assignPick[r.id]!.on" />
          <span class="muted">分钟</span>
        </span>
      </label>
      <p class="field-hint">用时默认取规则上的,今天特殊可以临时改,只影响这一次。</p>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="assignOpen = false">取消</button>
      <button class="btn btn-primary" type="button" :aria-busy="assigning" @click="assign">布置</button>
    </template>
  </ModalDialog>

  <!-- 录入结果 -->
  <ModalDialog :open="!!resultTask" :title="`录入结果 · ${resultTask?.name ?? ''}`" @close="resultTask = null">
    <div v-if="resultTask" class="stack">
      <label class="field">
        <span class="field-label">实际用时(分钟)</span>
        <input v-model.number="resultForm.minutes" class="input" type="number" min="0" max="1440" />
        <span class="field-hint">规定 {{ resultTask.target_minutes }} 分钟;{{ overtimeText(resultTask) }}</span>
      </label>
      <div class="field">
        <span class="field-label">完成质量</span>
        <div class="row">
          <button v-for="item in QUALITY" :key="item.key" type="button" class="btn btn-sm"
            :class="resultForm.quality === item.key ? 'btn-primary' : ''" :aria-pressed="resultForm.quality === item.key"
            @click="resultForm.quality = item.key">
            {{ item.label }} {{ signed(resultTask[`q_${item.key}` as keyof CreditParams]) }}
          </button>
        </div>
      </div>
      <label class="field">
        <span class="field-label">备注(可选)</span>
        <input v-model="resultForm.note" class="input" type="text" maxlength="200" placeholder="比如:字写得很工整" />
      </label>
      <div v-if="resultPreview" class="callout" :class="resultPreview.total >= 0 ? 'ok' : 'warn'">
        <AppIcon name="medal" :size="18" />
        <div class="callout-body"><strong>{{ signed(resultPreview.total) }} 分</strong> · {{ resultPreview.explain }}</div>
      </div>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="resultTask = null">取消</button>
      <button class="btn btn-primary" type="button" :aria-busy="saving" @click="saveResult">确认打分</button>
    </template>
  </ModalDialog>

  <!-- 奖励 -->
  <ModalDialog :open="rewardOpen" :title="rewardEditing ? '编辑奖励' : '新奖励'" @close="rewardOpen = false">
    <div class="form-grid">
      <label class="field"><span class="field-label">名称</span><input v-model="rewardForm.name" class="input" type="text" maxlength="40" placeholder="看电视 30 分钟" /></label>
      <label class="field"><span class="field-label">需要多少分</span><input v-model.number="rewardForm.cost" class="input" type="number" min="1" max="100000" /></label>
      <label class="field"><span class="field-label">图标(可选)</span><input v-model="rewardForm.emoji" class="input" type="text" maxlength="8" placeholder="📺" /></label>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="rewardOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="saveReward">保存</button>
    </template>
  </ModalDialog>

  <!-- 手动加减分 -->
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

  <!-- 规则 -->
  <ModalDialog :open="ruleOpen" :title="ruleEditing ? `编辑规则 · ${ruleEditing.name}` : '新规则'" wide @close="ruleOpen = false">
    <div class="stack">
      <div class="form-grid">
        <label class="field"><span class="field-label">作业名称</span><input v-model="ruleForm.name" class="input" type="text" maxlength="40" placeholder="数学作业" /></label>
        <label class="field"><span class="field-label">规定用时(分钟)</span><input v-model.number="ruleForm.target_minutes" class="input" type="number" min="1" max="600" /></label>
        <label class="field"><span class="field-label">按时完成得分</span><input v-model.number="ruleForm.ontime_points" class="input" type="number" min="-100" max="100" />
          <span class="field-hint">实际用时不超过规定用时就给</span></label>
      </div>
      <div class="form-grid">
        <label class="field"><span class="field-label">超时每几分钟算一档</span><input v-model.number="ruleForm.overtime_step" class="input" type="number" min="1" max="120" />
          <span class="field-hint">超 1 分钟也算一档</span></label>
        <label class="field"><span class="field-label">每档扣几分</span><input v-model.number="ruleForm.overtime_penalty" class="input" type="number" min="0" max="100" /></label>
        <label class="field"><span class="field-label">超时最多扣几分</span><input v-model.number="ruleForm.overtime_cap" class="input" type="number" min="0" max="100" /></label>
      </div>
      <div class="form-grid">
        <label v-for="item in QUALITY" :key="item.key" class="field">
          <span class="field-label">质量「{{ item.label }}」得分</span>
          <input v-model.number="ruleForm[`q_${item.key}` as keyof CreditParams]" class="input" type="number" min="-100" max="100" />
        </label>
        <label class="field"><span class="field-label">没完成扣几分</span><input v-model.number="ruleForm.missed_penalty" class="input" type="number" min="0" max="100" /></label>
      </div>
      <div class="callout info">
        <AppIcon name="info" :size="18" />
        <div class="callout-body">
          <div class="row">
            <span>试算:用了</span>
            <input v-model.number="example.minutes" class="input" type="number" min="0" max="1440" style="width: 80px; height: 30px" />
            <span>分钟,质量</span>
            <select v-model="example.quality" class="select" style="width: auto; height: 30px">
              <option v-for="item in QUALITY" :key="item.key" :value="item.key">{{ item.label }}</option>
            </select>
          </div>
          <div style="margin-top: 6px"><template v-if="examplePreview"><strong>{{ signed(examplePreview.total) }} 分</strong> · {{ examplePreview.explain }}</template><span v-else class="muted">数值有误,保存时会提示具体原因</span></div>
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="ruleOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="saveRule">保存</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.credit-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 12px; }
.negative { color: var(--red); }
.points { font-weight: 700; font-variant-numeric: tabular-nums; }
tr.reverted td { opacity: 0.55; }
tr.reverted td.points { text-decoration: line-through; }
.reward-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.reward {
  display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
  padding: 16px 12px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper);
}
.reward-emoji { font-size: 34px; line-height: 1; }
.reward-name { font-weight: 600; }
.reward-cost { color: var(--muted); font-variant-numeric: tabular-nums; }
.reward-tools { gap: 2px; }
.assign-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
.assign-name { flex: 1; font-weight: 600; }
.key-text { word-break: break-all; background: var(--paper); padding: 4px 8px; border-radius: 6px; }
</style>
