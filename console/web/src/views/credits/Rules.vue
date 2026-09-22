<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, urlMac, type CreditRule } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import CreditHeader from '../../components/credits/CreditHeader.vue';
import { useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, toast, toastError } from '../../ui';

// 作业模板:常用作业的名字与参考用时。参考用时只在录入结果时与实际用时对比,不参与算分——
// 分由家长自己给。改模板只影响以后布置的作业,已经算过的分不会变(布置时抄进了作业的快照)。

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

async function addExamples() {
  try {
    const result = await api.post<{ rules: number; rewards: number }>('/credits/examples', { mac: mac.value });
    toast(`已添加 ${result.rules} 条模板、${result.rewards} 个奖励,可以再按自家情况改`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

const DEFAULT_MINUTES = 40;

const open = ref(false);
const editing = ref<CreditRule | null>(null);
const form = ref({ name: '', target_minutes: DEFAULT_MINUTES });

function openRule(rule?: CreditRule) {
  editing.value = rule ?? null;
  form.value = { name: rule?.name ?? '', target_minutes: rule?.target_minutes ?? DEFAULT_MINUTES };
  open.value = true;
}

async function save() {
  const body = { name: form.value.name.trim(), target_minutes: Number(form.value.target_minutes) };
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
  if (!(await confirmDialog({ title: `删除模板「${rule.name}」?`, message: '布置过的作业不受影响;用过的模板只会停用,可以再恢复。', confirmText: '删除', danger: true }))) return;
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
  <CreditHeader title="作业模板" description="常用作业的名字与参考用时。参考用时只在录入结果时与实际用时对比,不参与算分;分由你在录入结果时自己给。改模板只影响以后布置的作业,已经算过的分不会变。">
    <template #actions>
      <button class="btn btn-primary btn-sm" type="button" @click="openRule()"><AppIcon name="plus" :size="14" /><span>新模板</span></button>
    </template>

    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="sliders" :size="18" />模板</h2></div>
        <div class="card-actions"><label class="row muted" style="gap: 6px"><input v-model="showArchived" type="checkbox" />显示已停用的</label></div>
      </div>
      <EmptyState v-if="active.length === 0" title="还没有作业模板" description="先添加一组示例(语文、数学、英语),再按自家情况改。">
        <button class="btn btn-primary" type="button" @click="addExamples"><AppIcon name="plus" :size="16" /><span>添加示例</span></button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th>排序</th><th>名称</th><th>参考时效</th><th></th></tr></thead>
          <tbody>
            <tr v-for="(r, index) in active" :key="r.id">
              <td class="nowrap">
                <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="上移" :disabled="index === 0" @click="move(r, -1)">↑</button>
                <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="下移" :disabled="index === active.length - 1" @click="move(r, 1)">↓</button>
              </td>
              <td class="cell-main">{{ r.name }}</td>
              <td class="nowrap">{{ r.target_minutes }} 分钟</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" type="button" aria-label="编辑" @click="openRule(r)"><AppIcon name="pencil" :size="14" /></button>
                <button class="btn btn-ghost btn-sm danger" type="button" aria-label="停用" @click="remove(r)"><AppIcon name="trash" :size="14" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="showArchived && archived.length" class="card">
      <div class="card-head"><div><h2>已停用</h2><p>布置过作业的模板删除时只会停用。恢复后可以再布置。</p></div></div>
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

  <ModalDialog :open="open" :title="editing ? `编辑模板 · ${editing.name}` : '新模板'" @close="open = false">
    <div class="stack">
      <div class="form-grid">
        <label class="field"><span class="field-label">作业名称</span><input v-model="form.name" class="input" type="text" maxlength="40" placeholder="数学作业" /></label>
        <label class="field"><span class="field-label">参考用时(分钟)</span><input v-model.number="form.target_minutes" class="input" type="number" min="1" max="600" />
          <span class="field-hint">布置时的默认用时,只作对比,不参与算分</span></label>
      </div>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="open = false">取消</button>
      <button class="btn btn-primary" type="button" @click="save">保存</button>
    </template>
  </ModalDialog>
</template>
