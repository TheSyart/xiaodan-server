<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Model, type ServiceDef, type ServiceProvider } from '../api';
import AppIcon from './AppIcon.vue';
import EmptyState from './EmptyState.vue';
import ModalDialog from './ModalDialog.vue';
import SkeletonRows from './SkeletonRows.vue';
import SwitchToggle from './SwitchToggle.vue';
import { confirmDialog, toast, toastError } from '../ui';

// 「联网搜索」工具用的搜索服务:可以配多家,默认那家生效,随时切换。嵌在工具页的联网搜索里。

const emit = defineEmits<{ changed: [] }>();

type Kind = 'search';

const catalog = ref<Record<Kind, ServiceDef[]>>({ search: [] });
const items = ref<ServiceProvider[]>([]);
const models = ref<Model[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [c, s, m] = await Promise.all([
      api.get<Record<Kind, ServiceDef[]>>('/service-providers/catalog'),
      api.get<{ items: ServiceProvider[] }>('/service-providers'),
      api.get<{ items: Model[] }>('/models'),
    ]);
    catalog.value = c;
    items.value = s.items;
    models.value = m.items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const ofKind = (kind: Kind) => items.value.filter((item) => item.kind === kind);
const defOf = (kind: Kind, provider: string) => catalog.value[kind].find((d) => d.provider === provider);

interface Draft {
  id: string | null;
  kind: Kind;
  name: string;
  provider: string;
  config: Record<string, string>;
  enabled: boolean;
}
const draft = ref<Draft | null>(null);
const saving = ref(false);
const currentDef = computed(() => (draft.value ? defOf(draft.value.kind, draft.value.provider) : undefined));
const keyModels = computed(() => models.value.filter((m) => m.model_type === 'LLM' || m.model_type === 'TTS' || m.model_type === 'ASR'));

function openCreate(kind: Kind) {
  const def = catalog.value[kind][0];
  if (!def) {
    toast('这一类还没有可选的服务商。', 'warn');
    return;
  }
  draft.value = { id: null, kind, name: def.label, provider: def.provider, config: defaults(def), enabled: true };
}

function defaults(def: ServiceDef): Record<string, string> {
  return Object.fromEntries(def.fields.map((f) => [f.key, f.default === undefined ? '' : String(f.default)]));
}

function openEdit(item: ServiceProvider) {
  const def = defOf(item.kind, item.provider);
  const config: Record<string, string> = def ? defaults(def) : {};
  for (const [key, value] of Object.entries(item.config)) config[key] = value === undefined || value === null ? '' : String(value);
  draft.value = { id: item.id, kind: item.kind, name: item.name, provider: item.provider, config, enabled: item.enabled === 1 };
}

function switchProvider(provider: string) {
  if (!draft.value) return;
  const def = defOf(draft.value.kind, provider);
  draft.value = { ...draft.value, provider, name: def?.label ?? provider, config: def ? defaults(def) : {} };
}

async function save() {
  const d = draft.value;
  if (!d || saving.value) return;
  const def = currentDef.value;
  const missing = (def?.fields ?? []).filter((f) => f.required && !(d.config[f.key] ?? '').trim());
  if (missing.length) {
    toast(`还没有填:${missing.map((f) => f.label).join('、')}`, 'warn');
    return;
  }
  const config: Record<string, unknown> = {};
  for (const field of def?.fields ?? []) {
    const raw = (d.config[field.key] ?? '').trim();
    if (!raw) continue;
    config[field.key] = field.type === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  saving.value = true;
  try {
    const payload = { kind: d.kind, name: d.name.trim() || d.provider, provider: d.provider, config, enabled: d.enabled };
    if (d.id) await api.put(`/service-providers/${d.id}`, payload);
    else await api.post('/service-providers', payload);
    toast('已保存');
    draft.value = null;
    await load();
    emit('changed');
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

const testing = ref('');
const testResult = ref<Record<string, string>>({});
async function test(item: ServiceProvider) {
  testing.value = item.id;
  try {
    const result = await api.post<{ ms: number; count?: number; sample?: { title: string }[] }>(`/service-providers/${item.id}/test`);
    testResult.value = {
      ...testResult.value,
      [item.id]: `可用 · ${result.count ?? 0} 条结果 · ${(result.ms / 1000).toFixed(1)} 秒${result.sample?.[0] ? ` · 例如「${result.sample[0].title}」` : ''}`,
    };
  } catch (e) {
    testResult.value = { ...testResult.value, [item.id]: `失败:${(e as Error).message}` };
  } finally {
    testing.value = '';
  }
}

async function setDefault(item: ServiceProvider) {
  try {
    await api.post(`/service-providers/${item.id}/default`);
    toast(`已切换到「${item.name}」`);
    await load();
    emit('changed');
  } catch (e) {
    toastError(e);
  }
}

async function remove(item: ServiceProvider) {
  if (!(await confirmDialog({ title: `删除「${item.name}」?`, confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/service-providers/${item.id}`);
    await load();
    emit('changed');
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <div class="provider-block">
    <div class="row" style="gap: 8px; align-items: center">
      <span class="field-label" style="flex: 1">搜索服务 · 可以配多家,默认那家生效。DeepSeek 官方联网搜索可以直接沿用 DeepSeek 对话模型的密钥。</span>
      <button class="btn btn-sm" type="button" :disabled="loading || catalog.search.length === 0" @click="openCreate('search')">
        <AppIcon name="plus" :size="14" /><span>添加</span>
      </button>
    </div>
    <div v-if="loadError" class="callout danger" role="alert" style="margin: 8px 0 0">
      <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
    </div>
    <SkeletonRows v-if="loading" :rows="2" />
    <template v-else>
      <EmptyState v-if="ofKind('search').length === 0" title="还没有配置搜索服务" description="点右上角添加。" />
      <div v-for="item in ofKind('search')" :key="item.id" class="model-row">
        <div class="model-info">
          <div class="model-name">
            {{ item.name }}
            <span v-if="item.is_default" class="tag sky">默认</span>
            <span v-if="item.enabled === 0" class="tag">已停用</span>
          </div>
          <div class="cell-sub">{{ defOf(item.kind, item.provider)?.label ?? item.provider }}<template v-if="testResult[item.id]"> · {{ testResult[item.id] }}</template></div>
        </div>
        <div class="row" style="gap: 2px; flex-wrap: wrap">
          <button class="btn btn-ghost btn-sm" type="button" :aria-busy="testing === item.id" @click="test(item)"><AppIcon name="zap" :size="14" /><span>测试</span></button>
          <button v-if="!item.is_default" class="btn btn-ghost btn-sm" type="button" @click="setDefault(item)"><AppIcon name="star" :size="14" /><span>设为默认</span></button>
          <button class="btn btn-ghost btn-sm" type="button" @click="openEdit(item)"><AppIcon name="pencil" :size="14" /><span>编辑</span></button>
          <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(item)"><AppIcon name="trash" :size="14" /><span>删除</span></button>
        </div>
      </div>
    </template>
  </div>

  <ModalDialog :open="!!draft" wide :title="draft?.id ? `编辑「${draft.name}」` : '添加服务'" @close="draft = null">
    <form v-if="draft" id="service-form" class="stack" @submit.prevent="save">
      <div class="form-grid">
        <label class="field">
          <span class="field-label">服务商</span>
          <select class="select" :value="draft.provider" @change="switchProvider(($event.target as HTMLSelectElement).value)">
            <option v-for="def in catalog[draft.kind]" :key="def.provider" :value="def.provider">{{ def.label }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="draft.name" class="input" type="text" maxlength="64" />
        </label>
      </div>
      <div v-if="currentDef?.note" class="callout info" style="margin: 0">
        <AppIcon name="info" :size="18" /><div class="callout-body">{{ currentDef.note }}</div>
      </div>
      <div class="form-grid">
        <label v-for="field in currentDef?.fields ?? []" :key="field.key" class="field">
          <span class="field-label">{{ field.label }}<span v-if="field.required" class="req">*</span></span>
          <select v-if="field.type === 'model'" v-model="draft.config[field.key]" class="select">
            <option value="">不沿用,单独填密钥</option>
            <option v-for="model in keyModels" :key="model.id" :value="model.id">{{ model.name }}({{ model.model_type }})</option>
          </select>
          <input
            v-else v-model="draft.config[field.key]" class="input" :class="{ mono: field.type === 'password' }"
            :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
            autocomplete="off" :placeholder="field.default === undefined ? '' : String(field.default)"
          />
          <span v-if="field.hint" class="field-hint">{{ field.hint }}</span>
        </label>
      </div>
      <SwitchToggle v-model="draft.enabled" label="启用" />
    </form>
    <template #footer>
      <button class="btn" type="button" @click="draft = null">取消</button>
      <button class="btn btn-primary" type="submit" form="service-form" :aria-busy="saving"><AppIcon name="check" :size="16" /><span>保存</span></button>
    </template>
  </ModalDialog>
</template>
