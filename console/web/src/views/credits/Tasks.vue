<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, urlMac, type CreditParams, type CreditQuality, type CreditRule, type CreditScore, type CreditTask } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { QUALITY, qualityLabel, signed, useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, formatTime, toast, toastError } from '../../ui';

// 今日作业:布置、录入结果(边输边预览得分)、记没完成、撤销;孩子通过智能体报了完成的,在这里检查打分。
// 计分公式只在后端一处,这里的预览都是调接口算的。

const { mac, today, refresh } = useCreditChild();
const q = () => `?mac=${urlMac(mac.value)}`;

const view = ref<'day' | 'recent'>('day');
const day = ref('');
const tasks = ref<CreditTask[]>([]);
const claims = ref<CreditTask[]>([]);
const rules = ref<CreditRule[]>([]);

const isToday = computed(() => day.value === today.value);

async function load() {
  // 「今天」由页头拉孩子列表时一起带回来;还没到之前别发请求,否则会拿空日期去查
  if (!mac.value || !today.value) return;
  if (!day.value) day.value = today.value;
  try {
    const [list, claimed, ruleList] = await Promise.all([
      view.value === 'day'
        ? api.get<{ items: CreditTask[] }>(`/credits/tasks${q()}&day=${day.value}`)
        : api.get<{ items: CreditTask[] }>(`/credits/tasks${q()}&from=${shiftDay(today.value, -13)}&to=${today.value}&limit=100`),
      api.get<{ items: CreditTask[] }>(`/credits/tasks${q()}&status=claimed&limit=100`),
      api.get<{ items: CreditRule[] }>(`/credits/rules${q()}`),
    ]);
    tasks.value = list.items;
    claims.value = claimed.items;
    rules.value = ruleList.items;
  } catch (e) {
    toastError(e);
  }
}
watch([mac, today], () => void load(), { immediate: true });
watch([day, view], () => void load());

function shiftDay(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function afterMoney() {
  await Promise.all([load(), refresh()]);
}

const STATUS: Record<CreditTask['status'], { text: string; tone: string }> = {
  pending: { text: '待完成', tone: 'sky' },
  done: { text: '已完成', tone: 'ok' },
  missed: { text: '没完成', tone: 'warn' },
};
const statusOf = (t: CreditTask) => (t.status === 'pending' && t.claimed_at ? { text: '孩子说做完了', tone: 'warn' } : STATUS[t.status]);
const overtimeText = (r: CreditParams) =>
  r.overtime_penalty ? `超时每 ${r.overtime_step} 分钟 -${r.overtime_penalty},最多 -${r.overtime_cap}` : '超时不扣分';

// ---- 布置 ----

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
    await api.post('/credits/tasks', { mac: mac.value, day: day.value || today.value, items });
    assignOpen.value = false;
    await afterMoney();
  } catch (e) {
    toastError(e);
  } finally {
    assigning.value = false;
  }
}

const customOpen = ref(false);
const customForm = ref({ name: '', target_minutes: 30, ontime_points: 5, missed_penalty: 5 });
async function addCustom() {
  try {
    await api.post('/credits/tasks/custom', { mac: mac.value, day: day.value || today.value, ...customForm.value, name: customForm.value.name.trim() });
    customOpen.value = false;
    customForm.value = { name: '', target_minutes: 30, ontime_points: 5, missed_penalty: 5 };
    await afterMoney();
  } catch (e) {
    toastError(e);
  }
}

// ---- 录入结果 ----

const resultTask = ref<CreditTask | null>(null);
const resultForm = ref({ minutes: 0, quality: 'good' as CreditQuality, note: '' });
const resultPreview = ref<CreditScore | null>(null);
const saving = ref(false);
function openResult(task: CreditTask) {
  resultTask.value = task;
  // 孩子报了用时就预填他报的,家长核对后改
  resultForm.value = { minutes: task.claimed_minutes ?? task.target_minutes, quality: 'good', note: '' };
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
    await afterMoney();
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
    await afterMoney();
  } catch (e) {
    toastError(e);
  }
}

async function rejectClaim(task: CreditTask) {
  if (!(await confirmDialog({ title: `「${task.name}」其实还没做完?`, message: '清掉孩子的申报,作业仍是待完成。', confirmText: '驳回' }))) return;
  try {
    await api.del(`/credits/tasks/${task.id}/claim`);
    await afterMoney();
  } catch (e) {
    toastError(e);
  }
}

async function removeTask(task: CreditTask) {
  try {
    await api.del(`/credits/tasks/${task.id}`);
    await afterMoney();
  } catch (e) {
    toastError(e);
  }
}

async function undoTask(task: CreditTask) {
  if (!task.ledger_id) return;
  if (!(await confirmDialog({ title: `撤销「${task.name}」的打分?`, message: '分数退回,作业回到待完成,可以重新录入。', confirmText: '撤销' }))) return;
  try {
    await api.post(`/credits/ledger/${task.ledger_id}/revert`, {});
    await afterMoney();
  } catch (e) {
    toastError(e);
  }
}

/** 当前列表里没显示出来、还挂着的申报(比如昨天报的) */
const otherClaims = computed(() => claims.value.filter((t) => !tasks.value.some((shown) => shown.id === t.id)));
</script>

<template>
  <CreditHeader title="今日作业" description="布置作业,孩子做完后录入实际用时和质量,按这项作业布置时的规则算分。孩子对小单说「做完了」的,会在这里等你检查。">
    <div v-if="otherClaims.length" class="callout warn">
      <AppIcon name="info" :size="18" />
      <div class="callout-body">
        <strong>还有 {{ otherClaims.length }} 项之前报的完成等你检查:</strong>
        <div class="row" style="margin-top: 8px">
          <button v-for="t in otherClaims" :key="t.id" class="btn btn-sm" type="button" @click="openResult(t)">{{ t.day }} {{ t.name }}</button>
        </div>
      </div>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="calendar" :size="18" />{{ view === 'recent' ? '最近 14 天' : isToday ? '今天的作业' : `${day} 的作业` }}</h2>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" :class="view === 'day' ? 'btn-primary' : 'btn-ghost'" type="button" @click="view = 'day'">按天</button>
          <button class="btn btn-sm" :class="view === 'recent' ? 'btn-primary' : 'btn-ghost'" type="button" @click="view = 'recent'">最近 14 天</button>
          <template v-if="view === 'day'">
            <input v-model="day" class="input" type="date" style="height: 32px; width: auto" aria-label="日期" />
            <button v-if="!isToday" class="btn btn-sm" type="button" @click="day = today">回到今天</button>
            <button class="btn btn-sm" type="button" @click="customOpen = true"><AppIcon name="plus" :size="14" /><span>临时作业</span></button>
            <button class="btn btn-primary btn-sm" type="button" :disabled="rules.length === 0" @click="openAssign"><AppIcon name="plus" :size="14" /><span>布置作业</span></button>
          </template>
        </div>
      </div>
      <EmptyState v-if="tasks.length === 0" :title="view === 'day' ? '这一天还没有布置作业' : '最近 14 天没有作业'"
        :description="rules.length ? '点「布置作业」从规则里挑,或加一项临时作业。' : '先去「作业规则」建几条规则,或加一项临时作业。'" />
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th v-if="view === 'recent'">日期</th><th>作业</th><th>规定用时</th><th>状态</th><th>结果</th><th>得分</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td v-if="view === 'recent'" class="nowrap mono">{{ t.day }}</td>
              <td class="cell-main">{{ t.name }}<span v-if="!t.rule_id" class="cell-sub"> · 临时</span></td>
              <td class="nowrap">{{ t.target_minutes }} 分钟</td>
              <td><span class="tag dot" :class="statusOf(t).tone">{{ statusOf(t).text }}</span></td>
              <td>
                <template v-if="t.status === 'done'">用时 {{ t.actual_minutes }} 分钟 · 质量{{ qualityLabel(t.quality) }}</template>
                <template v-else-if="t.claimed_at">
                  {{ formatTime(t.claimed_at) }} 报的<template v-if="t.claimed_minutes != null">,说用了 {{ t.claimed_minutes }} 分钟</template>
                  <span v-if="t.claim_note" class="cell-sub"> · 「{{ t.claim_note }}」</span>
                </template>
                <span v-if="t.note" class="cell-sub"> · {{ t.note }}</span>
              </td>
              <td class="nowrap points" :class="{ negative: (t.total_points ?? 0) < 0 }">{{ signed(t.total_points) }}</td>
              <td class="actions">
                <template v-if="t.status === 'pending'">
                  <button class="btn btn-primary btn-sm" type="button" @click="openResult(t)"><AppIcon name="pencil" :size="14" /><span>{{ t.claimed_at ? '检查打分' : '录入结果' }}</span></button>
                  <button v-if="t.claimed_at" class="btn btn-ghost btn-sm" type="button" @click="rejectClaim(t)">驳回</button>
                  <button class="btn btn-ghost btn-sm" type="button" @click="markMissed(t)">没完成</button>
                  <button v-if="!t.claimed_at" class="btn btn-ghost btn-sm danger" type="button" aria-label="删除" @click="removeTask(t)"><AppIcon name="trash" :size="14" /></button>
                </template>
                <button v-else class="btn btn-ghost btn-sm" type="button" @click="undoTask(t)"><AppIcon name="refresh" :size="14" /><span>撤销</span></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </CreditHeader>

  <ModalDialog :open="assignOpen" :title="`布置作业 · ${day || today}`" @close="assignOpen = false">
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

  <ModalDialog :open="customOpen" title="临时作业" @close="customOpen = false">
    <div class="form-grid">
      <label class="field"><span class="field-label">作业名称</span><input v-model="customForm.name" class="input" type="text" maxlength="40" placeholder="练钢琴" /></label>
      <label class="field"><span class="field-label">规定用时(分钟)</span><input v-model.number="customForm.target_minutes" class="input" type="number" min="1" max="600" /></label>
      <label class="field"><span class="field-label">按时完成得分</span><input v-model.number="customForm.ontime_points" class="input" type="number" min="-100" max="100" /></label>
      <label class="field"><span class="field-label">没完成扣几分</span><input v-model.number="customForm.missed_penalty" class="input" type="number" min="0" max="100" /></label>
    </div>
    <p class="field-hint">不挂规则,只用这一次。超时与质量的分值用默认的(超时每 10 分钟 -1、最多 -5;优良中差 +5/+3/0/-2)。</p>
    <template #footer>
      <button class="btn" type="button" @click="customOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="addCustom">布置</button>
    </template>
  </ModalDialog>

  <ModalDialog :open="!!resultTask" :title="`录入结果 · ${resultTask?.name ?? ''}`" @close="resultTask = null">
    <div v-if="resultTask" class="stack">
      <div v-if="resultTask.claimed_at" class="callout info">
        <AppIcon name="info" :size="18" />
        <div class="callout-body">孩子 {{ formatTime(resultTask.claimed_at) }} 说做完了<template v-if="resultTask.claimed_minutes != null">,说用了 {{ resultTask.claimed_minutes }} 分钟</template><template v-if="resultTask.claim_note">:「{{ resultTask.claim_note }}」</template>。检查过后再打分。</div>
      </div>
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
</template>

<style scoped>
.negative { color: var(--red); }
.points { font-weight: 700; font-variant-numeric: tabular-nums; }
.assign-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
.assign-name { flex: 1; font-weight: 600; }
</style>
