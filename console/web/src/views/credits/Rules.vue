<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, urlMac, type CreditParams, type CreditQuality, type CreditRule, type CreditScore } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { QUALITY, signed, useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, toast, toastError } from '../../ui';

// 作业规则:每类作业一条。数值随时可调——改规则只影响以后布置的作业,已经算过的分不会变
// (布置时整份抄进了作业的快照)。编辑时底下可以试算,试算也是调接口,公式只在后端一处。

const { mac } = useCreditChild();
const rules = ref<CreditRule[]>([]);
const showArchived = ref(false);

async function load() {
  if (!mac.value) return;
  try {
    rules.value = (await api.get<{ items: CreditRule[] }>(`/credits/rules?mac=${urlMac(mac.value)}${showArchived.value ? '&archived=1' : ''}`)).items;
  } catch (e) {
    toastError(e);
  }
}
watch([mac, showArchived], () => void load(), { immediate: true });

const active = computed(() => rules.value.filter((r) => !r.archived));
const archived = computed(() => rules.value.filter((r) => r.archived));
const overtimeText = (r: CreditParams) =>
  r.overtime_penalty ? `每超 ${r.overtime_step} 分钟 -${r.overtime_penalty},最多 -${r.overtime_cap}` : '不扣分';

async function addExamples() {
  try {
    const result = await api.post<{ rules: number; rewards: number }>('/credits/examples', { mac: mac.value });
    toast(`已添加 ${result.rules} 条规则、${result.rewards} 个奖励,可以再按自家情况改`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

const DEFAULT_PARAMS: CreditParams = {
  target_minutes: 40, ontime_points: 5, overtime_step: 10, overtime_penalty: 1, overtime_cap: 5,
  q_excellent: 5, q_good: 3, q_fair: 0, q_poor: -2, missed_penalty: 5,
};
const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof CreditParams)[];

const open = ref(false);
const editing = ref<CreditRule | null>(null);
const form = ref<CreditParams & { name: string }>({ name: '', ...DEFAULT_PARAMS });
const example = ref({ minutes: 55, quality: 'good' as CreditQuality });
const examplePreview = ref<CreditScore | null>(null);

function openRule(rule?: CreditRule) {
  editing.value = rule ?? null;
  form.value = { name: rule?.name ?? '', ...Object.fromEntries(PARAM_KEYS.map((k) => [k, rule ? rule[k] : DEFAULT_PARAMS[k]])) as unknown as CreditParams };
  example.value = { minutes: form.value.target_minutes + 15, quality: 'good' };
  open.value = true;
}
const params = (): CreditParams => Object.fromEntries(PARAM_KEYS.map((k) => [k, Number(form.value[k])])) as unknown as CreditParams;

let seq = 0;
async function previewExample() {
  if (!open.value) return;
  const mine = ++seq;
  try {
    const data = await api.post<{ score: CreditScore }>('/credits/rules/preview', {
      params: params(), actual_minutes: Number(example.value.minutes), quality: example.value.quality,
    });
    if (mine === seq) examplePreview.value = data.score;
  } catch {
    if (mine === seq) examplePreview.value = null;   // 数值越界时先不显示,保存时会报具体原因
  }
}
watch([form, example, open], () => void previewExample(), { deep: true });

async function save() {
  const body = { name: form.value.name.trim(), ...params() };
  try {
    if (editing.value) await api.patch(`/credits/rules/${editing.value.id}`, body);
    else await api.post('/credits/rules', { mac: mac.value, ...body });
    open.value = false;
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function remove(rule: CreditRule) {
  if (!(await confirmDialog({ title: `删除规则「${rule.name}」?`, message: '布置过的作业不受影响;用过的规则只会停用,可以再恢复。', confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/credits/rules/${rule.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function restore(rule: CreditRule) {
  try {
    await api.post(`/credits/rules/${rule.id}/restore`, {});
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function move(rule: CreditRule, step: -1 | 1) {
  const ids = active.value.map((r) => r.id);
  const from = ids.indexOf(rule.id);
  const to = from + step;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  try {
    rules.value = (await api.post<{ items: CreditRule[] }>('/credits/rules/reorder', { mac: mac.value, ids })).items.concat(archived.value);
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <CreditHeader title="作业规则" description="每类作业一条:规定用时多久、按时得几分、超时怎么扣、质量四档各几分、没完成扣几分。改规则只影响以后布置的作业,已经算过的分不会变。">
    <template #actions>
      <button class="btn btn-primary btn-sm" type="button" @click="openRule()"><AppIcon name="plus" :size="14" /><span>新规则</span></button>
    </template>

    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="sliders" :size="18" />规则</h2></div>
        <div class="card-actions"><label class="row muted" style="gap: 6px"><input v-model="showArchived" type="checkbox" />显示已停用的</label></div>
      </div>
      <EmptyState v-if="active.length === 0" title="还没有作业规则" description="先添加一组示例(语文、数学、英语),再按自家情况改。">
        <button class="btn btn-primary" type="button" @click="addExamples"><AppIcon name="plus" :size="16" /><span>添加示例</span></button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th></th><th>作业</th><th>规定用时</th><th>按时</th><th>超时</th><th>质量 优/良/中/差</th><th>没完成</th><th></th></tr></thead>
          <tbody>
            <tr v-for="(r, index) in active" :key="r.id">
              <td class="nowrap">
                <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="上移" :disabled="index === 0" @click="move(r, -1)">↑</button>
                <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="下移" :disabled="index === active.length - 1" @click="move(r, 1)">↓</button>
              </td>
              <td class="cell-main">{{ r.name }}</td>
              <td class="nowrap">{{ r.target_minutes }} 分钟</td>
              <td class="nowrap">{{ signed(r.ontime_points) }}</td>
              <td>{{ overtimeText(r) }}</td>
              <td class="nowrap mono">{{ signed(r.q_excellent) }} / {{ signed(r.q_good) }} / {{ signed(r.q_fair) }} / {{ signed(r.q_poor) }}</td>
              <td class="nowrap">{{ r.missed_penalty ? `-${r.missed_penalty}` : '不扣' }}</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" type="button" aria-label="编辑" @click="openRule(r)"><AppIcon name="pencil" :size="14" /></button>
                <button class="btn btn-ghost btn-sm danger" type="button" aria-label="删除" @click="remove(r)"><AppIcon name="trash" :size="14" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="showArchived && archived.length" class="card">
      <div class="card-head"><div><h2>已停用</h2><p>布置过作业的规则删除时只会停用。恢复后可以再布置。</p></div></div>
      <div class="table-wrap">
        <table class="table">
          <tbody>
            <tr v-for="r in archived" :key="r.id">
              <td class="cell-main">{{ r.name }}</td>
              <td class="nowrap">{{ r.target_minutes }} 分钟</td>
              <td class="actions"><button class="btn btn-sm" type="button" @click="restore(r)"><AppIcon name="refresh" :size="14" /><span>恢复</span></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </CreditHeader>

  <ModalDialog :open="open" :title="editing ? `编辑规则 · ${editing.name}` : '新规则'" wide @close="open = false">
    <div class="stack">
      <div class="form-grid">
        <label class="field"><span class="field-label">作业名称</span><input v-model="form.name" class="input" type="text" maxlength="40" placeholder="数学作业" /></label>
        <label class="field"><span class="field-label">规定用时(分钟)</span><input v-model.number="form.target_minutes" class="input" type="number" min="1" max="600" /></label>
        <label class="field"><span class="field-label">按时完成得分</span><input v-model.number="form.ontime_points" class="input" type="number" min="-100" max="100" />
          <span class="field-hint">实际用时不超过规定用时就给</span></label>
      </div>
      <div class="form-grid">
        <label class="field"><span class="field-label">超时每几分钟算一档</span><input v-model.number="form.overtime_step" class="input" type="number" min="1" max="120" />
          <span class="field-hint">超 1 分钟也算一档</span></label>
        <label class="field"><span class="field-label">每档扣几分</span><input v-model.number="form.overtime_penalty" class="input" type="number" min="0" max="100" /></label>
        <label class="field"><span class="field-label">超时最多扣几分</span><input v-model.number="form.overtime_cap" class="input" type="number" min="0" max="100" /></label>
      </div>
      <div class="form-grid">
        <label v-for="item in QUALITY" :key="item.key" class="field">
          <span class="field-label">质量「{{ item.label }}」得分</span>
          <input v-model.number="form[`q_${item.key}` as keyof CreditParams]" class="input" type="number" min="-100" max="100" />
        </label>
        <label class="field"><span class="field-label">没完成扣几分</span><input v-model.number="form.missed_penalty" class="input" type="number" min="0" max="100" /></label>
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
          <div style="margin-top: 6px">
            <template v-if="examplePreview"><strong>{{ signed(examplePreview.total) }} 分</strong> · {{ examplePreview.explain }}</template>
            <span v-else class="muted">数值有误,保存时会提示具体原因</span>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="open = false">取消</button>
      <button class="btn btn-primary" type="button" @click="save">保存</button>
    </template>
  </ModalDialog>
</template>
