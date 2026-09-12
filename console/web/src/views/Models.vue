<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Catalog, type Model, type ProviderDef, type Voice } from '../api';

const models = ref<Model[]>([]);
const voices = ref<Voice[]>([]);
const catalog = ref<Catalog | null>(null);
const error = ref('');
const notice = ref('');

interface Draft {
  id: string;
  model_type: string;
  name: string;
  provider: string;
  config: Record<string, string>;
  remark: string;
  enabled: boolean;
  creating: boolean;
}
const draft = ref<Draft | null>(null);

const voiceDraft = ref<{ tts_model_id: string; id: string; name: string; voice: string } | null>(null);

async function load() {
  error.value = '';
  try {
    const [m, v, c] = await Promise.all([
      api.get<{ items: Model[] }>('/models'),
      api.get<{ items: Voice[] }>('/voices'),
      api.get<Catalog>('/catalog'),
    ]);
    models.value = m.items;
    voices.value = v.items;
    catalog.value = c;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

const providersOf = (type: string): ProviderDef[] => catalog.value?.providers[type] ?? [];

const currentProvider = computed<ProviderDef | undefined>(() =>
  draft.value ? providersOf(draft.value.model_type).find((p) => p.provider === draft.value!.provider) : undefined,
);

function create(type: string) {
  const provider = providersOf(type)[0];
  const config: Record<string, string> = {};
  for (const field of provider?.fields ?? []) config[field.key] = String(field.default ?? '');
  draft.value = {
    id: `${type}_`, model_type: type, name: '', provider: provider?.provider ?? '',
    config, remark: '', enabled: true, creating: true,
  };
}

function edit(model: Model) {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(model.config_json) as Record<string, unknown>; } catch { /* 坏数据按空处理 */ }
  const config: Record<string, string> = {};
  const provider = providersOf(model.model_type).find((p) => p.provider === model.provider);
  for (const field of provider?.fields ?? []) config[field.key] = String(parsed[field.key] ?? field.default ?? '');
  draft.value = {
    id: model.id, model_type: model.model_type, name: model.name, provider: model.provider,
    config, remark: model.remark, enabled: model.enabled === 1, creating: false,
  };
}

function switchProvider(provider: string) {
  if (!draft.value) return;
  const def = providersOf(draft.value.model_type).find((p) => p.provider === provider);
  const config: Record<string, string> = {};
  for (const field of def?.fields ?? []) config[field.key] = draft.value.config[field.key] ?? String(field.default ?? '');
  draft.value = { ...draft.value, provider, config };
}

async function save() {
  if (!draft.value) return;
  error.value = '';
  const d = draft.value;
  // 数字字段送字符串过去服务端也能吃,但存成数字更贴近上游形状
  const config: Record<string, unknown> = {};
  for (const field of currentProvider.value?.fields ?? []) {
    const raw = d.config[field.key] ?? '';
    if (raw === '') continue;
    config[field.key] = field.type === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const payload = {
    id: d.id, model_type: d.model_type, name: d.name || d.id,
    provider: d.provider, config, remark: d.remark, enabled: d.enabled,
  };
  try {
    if (d.creating) await api.post('/models', payload);
    else await api.put(`/models/${d.id}`, payload);
    draft.value = null;
    notice.value = '已保存。设备下次连接时生效。';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function setDefault(model: Model) {
  try { await api.post(`/models/${model.id}/default`); await load(); }
  catch (e) { error.value = (e as Error).message; }
}

async function remove(model: Model) {
  if (!confirm(`删除模型配置「${model.name}」?`)) return;
  try { await api.del(`/models/${model.id}`); await load(); }
  catch (e) { error.value = (e as Error).message; }
}

async function saveVoice() {
  if (!voiceDraft.value) return;
  try {
    await api.post('/voices', { ...voiceDraft.value, languages: '中文' });
    voiceDraft.value = null;
    await load();
  } catch (e) { error.value = (e as Error).message; }
}

async function removeVoice(voice: Voice) {
  if (!confirm(`删除音色「${voice.name}」?`)) return;
  try { await api.del(`/voices/${voice.id}`); await load(); }
  catch (e) { error.value = (e as Error).message; }
}

const ttsModels = computed(() => models.value.filter((m) => m.model_type === 'TTS'));
</script>

<template>
  <div class="page-head">
    <h1>模型</h1>
    <p>各类模型的接入地址与密钥。</p>
  </div>

  <div v-if="error" class="notice error">{{ error }}</div>
  <div v-if="notice" class="notice info">{{ notice }}</div>

  <template v-if="!draft">
    <div v-for="type in catalog?.modelTypes ?? []" :key="type" class="card">
      <h2>
        {{ type }}
        <button class="link" style="float: right" @click="create(type)">新增</button>
      </h2>
      <div v-if="models.filter((m) => m.model_type === type).length === 0" class="empty">
        还没有配置 {{ type }}。
      </div>
      <table v-else>
        <tbody>
          <tr v-for="model in models.filter((m) => m.model_type === type)" :key="model.id">
            <td>
              {{ model.name }}
              <span v-if="model.is_default" class="tag ok">默认</span>
              <span v-if="model.enabled === 0" class="tag">已停用</span>
              <div style="color: var(--muted); font-size: 12px">
                <span class="code">{{ model.id }}</span> · {{ model.provider }}
              </div>
            </td>
            <td class="actions">
              <button v-if="!model.is_default" class="link" @click="setDefault(model)">设为默认</button>
              <button class="link" @click="edit(model)">编辑</button>
              <button class="link danger" @click="remove(model)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>
        音色
        <button
          class="link" style="float: right" :disabled="ttsModels.length === 0"
          @click="voiceDraft = { tts_model_id: ttsModels[0]?.id ?? '', id: '', name: '', voice: '' }"
        >新增</button>
      </h2>
      <p>音色挂在某个语音合成模型下,智能体再从中选一个。</p>
      <div v-if="voices.length === 0" class="empty">还没有音色。不加也可以,那样会用模型自带的默认音色。</div>
      <table v-else>
        <tbody>
          <tr v-for="voice in voices" :key="voice.id">
            <td>
              {{ voice.name }}
              <div style="color: var(--muted); font-size: 12px">
                <span class="code">{{ voice.voice }}</span> · 属于 {{ voice.tts_model_id }}
              </div>
            </td>
            <td class="actions"><button class="link danger" @click="removeVoice(voice)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>

  <template v-else>
    <div class="card">
      <h2>{{ draft.creating ? `新增 ${draft.model_type} 模型` : `编辑 ${draft.id}` }}</h2>

      <div class="field-row">
        <label>
          <span>标识(id)</span>
          <input v-model="draft.id" type="text" :disabled="!draft.creating" />
          <small>会原样出现在服务端日志里,建议用 {{ draft.model_type }}_XxxGateway 这种形式。</small>
        </label>
        <label>
          <span>显示名称</span>
          <input v-model="draft.name" type="text" placeholder="给自己看的名字" />
        </label>
      </div>

      <label>
        <span>供应商</span>
        <select :value="draft.provider" @change="switchProvider(($event.target as HTMLSelectElement).value)">
          <option v-for="p in providersOf(draft.model_type)" :key="p.provider" :value="p.provider">
            {{ p.label }}
          </option>
        </select>
      </label>

      <div v-if="currentProvider?.note" class="notice info">{{ currentProvider.note }}</div>

      <div class="field-row">
        <label v-for="field in currentProvider?.fields ?? []" :key="field.key">
          <span>{{ field.label }}<template v-if="field.required"> *</template></span>
          <input
            v-model="draft.config[field.key]"
            :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
            :placeholder="String(field.default ?? '')"
          />
          <small v-if="field.hint">{{ field.hint }}</small>
        </label>
      </div>

      <label>
        <input v-model="draft.enabled" type="checkbox" />
        启用
      </label>

      <div class="btn-row">
        <button class="primary" @click="save">保存</button>
        <button @click="draft = null">取消</button>
      </div>
    </div>
  </template>

  <div v-if="voiceDraft" class="modal-mask" @click.self="voiceDraft = null">
    <div class="card modal">
      <h2>新增音色</h2>
      <label>
        <span>所属语音合成模型</span>
        <select v-model="voiceDraft.tts_model_id">
          <option v-for="model in ttsModels" :key="model.id" :value="model.id">{{ model.name }}</option>
        </select>
      </label>
      <div class="field-row">
        <label>
          <span>标识</span>
          <input v-model="voiceDraft.id" type="text" placeholder="voice_ethan" />
        </label>
        <label>
          <span>显示名称</span>
          <input v-model="voiceDraft.name" type="text" placeholder="Ethan" />
        </label>
      </div>
      <label>
        <span>音色值</span>
        <input v-model="voiceDraft.voice" type="text" placeholder="传给服务商的音色名,例如 Ethan" />
      </label>
      <div class="modal-foot">
        <button @click="voiceDraft = null">取消</button>
        <button class="primary" @click="saveVoice">保存</button>
      </div>
    </div>
  </div>
</template>
