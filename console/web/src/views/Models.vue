<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Catalog, type Model, type ProviderDef, type Voice } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import type { IconName } from '../icons';
import { confirmDialog, toast, toastError } from '../ui';

const models = ref<Model[]>([]);
const voices = ref<Voice[]>([]);
const catalog = ref<Catalog | null>(null);
const loading = ref(true);
const loadError = ref('');

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
const revealed = ref<Record<string, boolean>>({});
const draftError = ref('');
const saving = ref(false);

interface VoiceDraft {
  tts_model_id: string;
  id: string;
  name: string;
  voice: string;
  languages: string;
}
const voiceDraft = ref<VoiceDraft | null>(null);
const voiceError = ref('');
const savingVoice = ref(false);

async function load() {
  loadError.value = '';
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
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const TYPE_META: Record<string, { label: string; hint: string; icon: IconName; tone: string }> = {
  LLM: { label: '对话模型', hint: '决定它怎么思考和回话。要用工具,需选支持函数调用的模型。', icon: 'bot', tone: 'tone-sky' },
  TTS: { label: '语音合成', hint: '把回复念出来。音色挂在语音合成模型下面。', icon: 'volume', tone: 'tone-violet' },
  ASR: { label: '语音识别', hint: '把用户说的话转成文字。', icon: 'mic', tone: 'tone-grass' },
  Intent: { label: '工具调用', hint: '决定模型能不能调用天气、日历等工具。', icon: 'zap', tone: 'tone-sun' },
  VAD: { label: '语音活动检测', hint: '判断用户什么时候说完了。', icon: 'wave', tone: 'tone-muted' },
  Memory: { label: '记忆', hint: '要不要记住之前聊过什么。', icon: 'sparkles', tone: 'tone-muted' },
  VLLM: { label: '视觉模型', hint: '这块硬件没有摄像头,可以不配。', icon: 'eye', tone: 'tone-muted' },
};
const TYPE_ORDER = ['LLM', 'TTS', 'ASR', 'Intent', 'VAD', 'Memory', 'VLLM'];
const meta = (type: string) => TYPE_META[type] ?? { label: type, hint: '', icon: 'layers' as IconName, tone: 'tone-muted' };
const types = computed(() => {
  const rank = (type: string) => (TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length);
  return [...(catalog.value?.modelTypes ?? [])].sort((a, b) => rank(a) - rank(b));
});

const providersOf = (type: string): ProviderDef[] => catalog.value?.providers[type] ?? [];
const providerLabel = (type: string, provider: string) =>
  providersOf(type).find((item) => item.provider === provider)?.label ?? provider;
const modelsOf = (type: string) => models.value.filter((m) => m.model_type === type);
const currentProvider = computed<ProviderDef | undefined>(() =>
  draft.value ? providersOf(draft.value.model_type).find((p) => p.provider === draft.value!.provider) : undefined,
);
const ttsModels = computed(() => models.value.filter((m) => m.model_type === 'TTS'));
const modelName = (id: string) => models.value.find((m) => m.id === id)?.name ?? id;

function openCreate(type: string) {
  const provider = providersOf(type)[0];
  const config: Record<string, string> = {};
  for (const field of provider?.fields ?? []) config[field.key] = String(field.default ?? '');
  draft.value = {
    id: `${type}_`, model_type: type, name: '', provider: provider?.provider ?? '',
    config, remark: '', enabled: true, creating: true,
  };
  revealed.value = {};
  draftError.value = '';
}

function openEdit(model: Model) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(model.config_json) as Record<string, unknown>;
  } catch {
    /* 坏数据按空处理 */
  }
  const config: Record<string, string> = {};
  const provider = providersOf(model.model_type).find((p) => p.provider === model.provider);
  for (const field of provider?.fields ?? []) config[field.key] = String(parsed[field.key] ?? field.default ?? '');
  draft.value = {
    id: model.id, model_type: model.model_type, name: model.name, provider: model.provider,
    config, remark: model.remark, enabled: model.enabled === 1, creating: false,
  };
  revealed.value = {};
  draftError.value = '';
}

function switchProvider(provider: string) {
  if (!draft.value) return;
  const def = providersOf(draft.value.model_type).find((p) => p.provider === provider);
  const config: Record<string, string> = {};
  for (const field of def?.fields ?? []) config[field.key] = draft.value.config[field.key] ?? String(field.default ?? '');
  draft.value = { ...draft.value, provider, config };
}

async function save() {
  const d = draft.value;
  if (!d || saving.value) return;
  draftError.value = '';
  if (d.creating && !/^[\w-]+$/u.test(d.id)) {
    draftError.value = '标识只能用字母、数字、下划线和短横线。';
    return;
  }
  const fields = currentProvider.value?.fields ?? [];
  const missing = fields.filter((field) => field.required && !(d.config[field.key] ?? '').trim());
  if (missing.length) {
    draftError.value = `还没有填:${missing.map((field) => field.label).join('、')}`;
    return;
  }
  // 数字字段送字符串过去服务端也能吃,但存成数字更贴近上游形状
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = d.config[field.key] ?? '';
    if (raw === '') continue;
    config[field.key] = field.type === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const payload = {
    id: d.id, model_type: d.model_type, name: d.name.trim() || d.id,
    provider: d.provider, config, remark: d.remark, enabled: d.enabled,
  };
  saving.value = true;
  try {
    if (d.creating) await api.post('/models', payload);
    else await api.put(`/models/${d.id}`, payload);
    toast(d.creating ? `已添加「${payload.name}」` : '已保存。设备下次连接时生效。');
    draft.value = null;
    await load();
  } catch (e) {
    draftError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function setDefault(model: Model) {
  try {
    await api.post(`/models/${model.id}/default`);
    toast(`「${model.name}」已设为默认,新建智能体时会自动选上`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function remove(model: Model) {
  const ok = await confirmDialog({
    title: `删除模型「${model.name}」?`,
    message: '正在用它的智能体会失去这个模块,需要重新选择。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/models/${model.id}`);
    toast(`已删除「${model.name}」`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

function openVoice() {
  voiceDraft.value = { tts_model_id: ttsModels.value[0]?.id ?? '', id: '', name: '', voice: '', languages: '中文' };
  voiceError.value = '';
}

async function saveVoice() {
  const v = voiceDraft.value;
  if (!v || savingVoice.value) return;
  voiceError.value = '';
  if (!v.tts_model_id || !v.id.trim() || !v.voice.trim()) {
    voiceError.value = '请选择语音合成模型,并填写标识与音色值。';
    return;
  }
  savingVoice.value = true;
  try {
    await api.post('/voices', {
      tts_model_id: v.tts_model_id,
      id: v.id.trim(),
      name: v.name.trim() || v.voice.trim(),
      voice: v.voice.trim(),
      languages: v.languages.trim() || '中文',
    });
    toast('已添加音色');
    voiceDraft.value = null;
    await load();
  } catch (e) {
    voiceError.value = (e as Error).message;
  } finally {
    savingVoice.value = false;
  }
}

async function removeVoice(voice: Voice) {
  const ok = await confirmDialog({ title: `删除音色「${voice.name}」?`, confirmText: '删除', danger: true });
  if (!ok) return;
  try {
    await api.del(`/voices/${voice.id}`);
    toast('已删除音色');
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <PageHeader title="模型" description="各类模型的接入地址与密钥。智能体从这里挑选要用的模型。" />

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <template v-else>
    <section v-for="type in types" :key="type" class="card">
      <div class="card-head">
        <div>
          <h2>
            <span class="stat-icon" :class="meta(type).tone" style="width: 30px; height: 30px; border-radius: 9px">
              <AppIcon :name="meta(type).icon" :size="16" />
            </span>
            {{ meta(type).label }}
            <span class="chip-mono">{{ type }}</span>
          </h2>
          <p>{{ meta(type).hint }}</p>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" type="button" @click="openCreate(type)"><AppIcon name="plus" :size="14" /><span>新增</span></button>
        </div>
      </div>
      <EmptyState
        v-if="modelsOf(type).length === 0" :title="`还没有配置${meta(type).label}`"
        description="点右上角的新增,填入服务商的接口地址与密钥。"
      />
      <div v-else>
        <div v-for="model in modelsOf(type)" :key="model.id" class="model-row">
          <div class="model-info">
            <div class="model-name">
              {{ model.name }}
              <span v-if="model.is_default" class="tag sky">默认</span>
              <span v-if="model.enabled === 0" class="tag">已停用</span>
            </div>
            <div class="cell-sub"><span class="chip-mono">{{ model.id }}</span> · {{ providerLabel(type, model.provider) }}</div>
          </div>
          <div class="row" style="gap: 2px">
            <button v-if="!model.is_default" class="btn btn-ghost btn-sm" type="button" @click="setDefault(model)">
              <AppIcon name="star" :size="14" /><span>设为默认</span>
            </button>
            <button class="btn btn-ghost btn-sm" type="button" @click="openEdit(model)">
              <AppIcon name="pencil" :size="14" /><span>编辑</span>
            </button>
            <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(model)">
              <AppIcon name="trash" :size="14" /><span>删除</span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>
            <span class="stat-icon tone-violet" style="width: 30px; height: 30px; border-radius: 9px"><AppIcon name="user" :size="16" /></span>
            音色
          </h2>
          <p>音色挂在某个语音合成模型下,智能体再从中挑一个。不加也可以,那样会用模型自带的默认音色。</p>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" type="button" :disabled="ttsModels.length === 0" @click="openVoice">
            <AppIcon name="plus" :size="14" /><span>新增音色</span>
          </button>
        </div>
      </div>
      <EmptyState
        v-if="voices.length === 0" title="还没有音色"
        :description="ttsModels.length === 0 ? '先在上面添加一个语音合成模型。' : '点右上角的新增音色。'"
      />
      <div v-else>
        <div v-for="voice in voices" :key="voice.id" class="model-row">
          <div class="model-info">
            <div class="model-name">{{ voice.name }}</div>
            <div class="cell-sub">
              <span class="chip-mono">{{ voice.voice }}</span> · {{ modelName(voice.tts_model_id) }} · {{ voice.languages }}
            </div>
          </div>
          <button class="btn btn-ghost btn-sm danger" type="button" @click="removeVoice(voice)">
            <AppIcon name="trash" :size="14" /><span>删除</span>
          </button>
        </div>
      </div>
    </section>
  </template>

  <ModalDialog
    :open="!!draft" wide :title="draft?.creating ? `新增${meta(draft.model_type).label}` : `编辑「${draft?.name || draft?.id}」`"
    @close="draft = null"
  >
    <form v-if="draft" id="model-form" class="stack" @submit.prevent="save">
      <div v-if="draftError" class="callout danger" style="margin: 0" role="alert">
        <AppIcon name="alert" :size="18" /><div class="callout-body">{{ draftError }}</div>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">标识<span class="req">*</span></span>
          <input v-model="draft.id" class="input mono" type="text" :disabled="!draft.creating" />
          <span class="field-hint">会原样出现在引擎日志里,建议写成 {{ draft.model_type }}_XxxGateway 这样。</span>
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="draft.name" class="input" type="text" placeholder="给自己看的名字" />
        </label>
        <label class="field span-all">
          <span class="field-label">供应商</span>
          <select class="select" :value="draft.provider" @change="switchProvider(($event.target as HTMLSelectElement).value)">
            <option v-for="p in providersOf(draft.model_type)" :key="p.provider" :value="p.provider">{{ p.label }}</option>
          </select>
        </label>
      </div>
      <div v-if="currentProvider?.note" class="callout info" style="margin: 0">
        <AppIcon name="info" :size="18" /><div class="callout-body">{{ currentProvider.note }}</div>
      </div>
      <div v-if="currentProvider?.fields.length" class="form-grid">
        <label v-for="field in currentProvider.fields" :key="field.key" class="field">
          <span class="field-label">{{ field.label }}<span v-if="field.required" class="req">*</span></span>
          <div v-if="field.type === 'password'" class="input-affix">
            <input
              v-model="draft.config[field.key]" class="input mono" :type="revealed[field.key] ? 'text' : 'password'"
              autocomplete="off" :placeholder="String(field.default ?? '')"
            />
            <button
              type="button" class="btn btn-ghost btn-sm btn-icon affix" :aria-label="revealed[field.key] ? '隐藏' : '显示'"
              @click="revealed[field.key] = !revealed[field.key]"
            >
              <AppIcon :name="revealed[field.key] ? 'eyeOff' : 'eye'" :size="15" />
            </button>
          </div>
          <input
            v-else v-model="draft.config[field.key]" class="input" :type="field.type === 'number' ? 'number' : 'text'"
            :placeholder="String(field.default ?? '')"
          />
          <span v-if="field.hint" class="field-hint">{{ field.hint }}</span>
        </label>
      </div>
      <SwitchToggle v-model="draft.enabled" label="启用" />
    </form>
    <template #footer>
      <button class="btn" type="button" @click="draft = null">取消</button>
      <button class="btn btn-primary" type="submit" form="model-form" :aria-busy="saving">
        <AppIcon name="check" :size="16" /><span>保存</span>
      </button>
    </template>
  </ModalDialog>

  <ModalDialog :open="!!voiceDraft" title="新增音色" @close="voiceDraft = null">
    <form v-if="voiceDraft" id="voice-form" class="stack" @submit.prevent="saveVoice">
      <div v-if="voiceError" class="callout danger" style="margin: 0" role="alert">
        <AppIcon name="alert" :size="18" /><div class="callout-body">{{ voiceError }}</div>
      </div>
      <label class="field">
        <span class="field-label">所属语音合成模型</span>
        <select v-model="voiceDraft.tts_model_id" class="select">
          <option v-for="model in ttsModels" :key="model.id" :value="model.id">{{ model.name }}</option>
        </select>
      </label>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">标识<span class="req">*</span></span>
          <input v-model="voiceDraft.id" class="input mono" type="text" placeholder="voice_ethan" />
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="voiceDraft.name" class="input" type="text" placeholder="Ethan" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">音色值<span class="req">*</span></span>
        <input v-model="voiceDraft.voice" class="input mono" type="text" placeholder="传给服务商的音色名,例如 Ethan" />
      </label>
      <label class="field">
        <span class="field-label">支持的语言</span>
        <input v-model="voiceDraft.languages" class="input" type="text" placeholder="中文" />
        <span class="field-hint">多个语言用顿号分隔,例如 中文、粤语。智能体的「合成语言」从这里挑。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="voiceDraft = null">取消</button>
      <button class="btn btn-primary" type="submit" form="voice-form" :aria-busy="savingVoice">
        <AppIcon name="check" :size="16" /><span>保存</span>
      </button>
    </template>
  </ModalDialog>
</template>
