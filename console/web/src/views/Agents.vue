<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, RouterLink } from 'vue-router';
import { api, type Agent, type Catalog, type Model, type PluginDef, type TtsParams, type Voice } from '../api';
import { playBlob, stopPlayback } from '../audio';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import type { IconName } from '../icons';
import { confirmDialog, toast, toastError } from '../ui';

const agents = ref<Agent[]>([]);
const models = ref<Model[]>([]);
const voices = ref<Voice[]>([]);
const catalog = ref<Catalog | null>(null);
const loading = ref(true);
const loadError = ref('');

const editing = ref<Agent | null>(null);
/** 插件代号 → 参数。只有被勾选的才在这个表里。 */
const pluginState = ref<Record<string, Record<string, string>>>({});
/** 千问合成的语速、音调、音量与语气指令;表单里一律是完整的数值,保存时再去掉默认值 */
const ttsParams = ref({ rate: 1, pitch: 1, volume: 50, instruction: '' });
/** 模型参数:是否开思考 */
const llmParams = ref({ thinking: false });
const snapshot = ref('');
const saving = ref(false);
const nameError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [a, m, v, c] = await Promise.all([
      api.get<{ items: Agent[] }>('/agents'),
      api.get<{ items: Model[] }>('/models'),
      api.get<{ items: Voice[] }>('/voices'),
      api.get<Catalog>('/catalog'),
    ]);
    agents.value = a.items;
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

const byType = (type: string) => models.value.filter((m) => m.model_type === type && m.enabled === 1);
const modelById = (id: string | null) => (id ? models.value.find((m) => m.id === id) : undefined);
const toolsOn = (agent: Agent) => {
  const model = modelById(agent.intent_model_id);
  return !!model && model.provider !== 'nointent';
};
const pluginLabel = (code: string) => catalog.value?.plugins.find((p) => p.code === code)?.label;
const agentPluginLabels = (agent: Agent) =>
  agent.plugins.map((p) => pluginLabel(p.plugin_code)).filter((label): label is string => !!label);

/**
 * 某类型标为默认的模型;没有默认项就留空。不能取列表第一个:排序靠 id 而不是用户的选择,
 * 新建的智能体会拿到一个谁也没选过的模型。新库里工具调用(函数调用)本身就是默认项。
 */
const defaultOf = (type: string) => byType(type).find((m) => m.is_default === 1)?.id ?? null;

const voicesOfModel = computed(() =>
  editing.value?.tts_model_id ? voices.value.filter((v) => v.tts_model_id === editing.value!.tts_model_id) : [],
);
const voiceLanguages = computed(() => {
  const voice = voices.value.find((v) => v.id === editing.value?.tts_voice_id);
  return voice ? voice.languages.split('、').map((item) => item.trim()).filter(Boolean) : [];
});
const toolsEnabled = computed(() => !!editing.value && (editing.value.runtime === 'agent' || toolsOn(editing.value)));
const isAgentRuntime = computed(() => editing.value?.runtime === 'agent');
/** 控制塔智能体自己管工具与记忆,这两项选了也不生效,不显示 */
const visibleModelLabels = computed(() =>
  MODEL_LABELS.filter(([key]) => !isAgentRuntime.value || (key !== 'intent_model_id' && key !== 'memory_model_id')));
/** 当前大脑能用的插件 */
const visiblePlugins = computed(() =>
  (catalog.value?.plugins ?? []).filter((plugin) =>
    plugin.runtime === 'both' || plugin.runtime === (isAgentRuntime.value ? 'agent' : 'engine')),
);
const qwenTts = computed(() => modelById(editing.value?.tts_model_id ?? null)?.provider === 'qwen_audio_tts');
const selectedVoice = computed(() => voices.value.find((v) => v.id === editing.value?.tts_voice_id));
const VOICE_STATUS: Record<Voice['status'], string> = { ok: '', pending: '(审核中,暂不可用)', failed: '(未通过审核)' };

function parseTtsParams(json: string | undefined) {
  let parsed: TtsParams = {};
  try {
    parsed = JSON.parse(json || '{}') as TtsParams;
  } catch {
    /* 坏数据按默认值 */
  }
  return {
    rate: typeof parsed.rate === 'number' ? parsed.rate : 1,
    pitch: typeof parsed.pitch === 'number' ? parsed.pitch : 1,
    volume: typeof parsed.volume === 'number' ? parsed.volume : 50,
    instruction: typeof parsed.instruction === 'string' ? parsed.instruction : '',
  };
}

/** 与默认值相同的参数不存:以后调默认值时,没改过的智能体跟着变。 */
function ttsParamsPayload(): TtsParams {
  const t = ttsParams.value;
  const result: TtsParams = {};
  if (Number(t.rate) !== 1) result.rate = Number(t.rate);
  if (Number(t.pitch) !== 1) result.pitch = Number(t.pitch);
  if (Number(t.volume) !== 50) result.volume = Number(t.volume);
  if (t.instruction.trim()) result.instruction = t.instruction.trim();
  return result;
}

const previewing = ref(false);
async function previewVoice() {
  const agent = editing.value;
  if (!agent?.tts_model_id || previewing.value) return;
  const model = modelById(agent.tts_model_id);
  let voice = selectedVoice.value?.voice;
  if (!voice) {
    try {
      voice = String((JSON.parse(model?.config_json ?? '{}') as Record<string, unknown>)['voice'] ?? '');
    } catch {
      voice = '';
    }
  }
  if (!voice) {
    toast('还没有选音色,模型也没有配默认音色。', 'warn');
    return;
  }
  previewing.value = true;
  try {
    const blob = await api.postForBlob('/voices/preview', {
      tts_model_id: agent.tts_model_id, voice,
      text: `你好呀,我是${agent.name || '小单'},很高兴认识你。`,
      ...ttsParamsPayload(),
    });
    await playBlob(blob);
  } catch (e) {
    toastError(e);
  } finally {
    previewing.value = false;
  }
}
onBeforeUnmount(stopPlayback);
const functionCallModel = computed(() =>
  models.value.find((m) => m.model_type === 'Intent' && m.enabled === 1 && m.provider === 'function_call'),
);

const draftJson = () => JSON.stringify({ agent: editing.value, plugins: pluginState.value, tts: ttsParams.value, llm: llmParams.value });
const dirty = computed(() => !!editing.value && draftJson() !== snapshot.value);

function startEditing(agent: Agent, plugins: Record<string, Record<string, string>>) {
  editing.value = agent;
  pluginState.value = plugins;
  ttsParams.value = parseTtsParams(agent.tts_params_json);
  try {
    llmParams.value = { thinking: (JSON.parse(agent.llm_params_json || '{}') as { thinking?: boolean }).thinking === true };
  } catch {
    llmParams.value = { thinking: false };
  }
  snapshot.value = draftJson();
  nameError.value = '';
}

function edit(agent: Agent) {
  const state: Record<string, Record<string, string>> = {};
  // 库里可能残留目录已移除的插件(比如早先的 get_time)。不带进表单:保存时接口会拒绝未知插件。
  const known = new Set((catalog.value?.plugins ?? []).map((plugin) => plugin.code));
  for (const item of agent.plugins) {
    if (!known.has(item.plugin_code)) continue;
    try {
      const params = JSON.parse(item.params_json) as Record<string, unknown>;
      state[item.plugin_code] = Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, String(value ?? '')]),
      );
    } catch {
      state[item.plugin_code] = {};
    }
  }
  startEditing(JSON.parse(JSON.stringify(agent)) as Agent, state);
}

function create() {
  startEditing(
    {
      id: '', name: '新的智能体', system_prompt: '',
      vad_model_id: defaultOf('VAD'), asr_model_id: defaultOf('ASR'), llm_model_id: defaultOf('LLM'),
      vllm_model_id: null, tts_model_id: defaultOf('TTS'),
      memory_model_id: defaultOf('Memory'), intent_model_id: defaultOf('Intent'),
      tts_voice_id: null, tts_language: null, chat_history_conf: 1, tts_params_json: '{}', is_default: 0,
      runtime: 'agent', max_steps: 6, safety_level: 'standard', description: '', greeting: '', role_template: '',
      llm_params_json: '{}', plugins: [], device_count: 0,
    },
    {},
  );
}

const DISCARD = { title: '放弃未保存的修改?', message: '离开后这次的修改不会保存。', confirmText: '放弃修改', danger: true };

async function leaveEdit() {
  if (dirty.value && !(await confirmDialog(DISCARD))) return;
  editing.value = null;
}

onBeforeRouteLeave(async () => (editing.value && dirty.value ? confirmDialog(DISCARD) : true));

function togglePlugin(plugin: PluginDef, on: boolean) {
  if (on) {
    const defaults: Record<string, string> = {};
    for (const field of plugin.fields) defaults[field.key] = String(field.default ?? '');
    pluginState.value = { ...pluginState.value, [plugin.code]: defaults };
  } else {
    const next = { ...pluginState.value };
    delete next[plugin.code];
    pluginState.value = next;
  }
}

function enableTools() {
  if (!editing.value || !functionCallModel.value) return;
  editing.value.intent_model_id = functionCallModel.value.id;
  toast('已改为函数调用,保存后生效。', 'info');
}

async function save() {
  if (!editing.value || saving.value) return;
  const agent = editing.value;
  nameError.value = agent.name.trim() ? '' : '请给智能体起个名字。';
  if (nameError.value) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const payload = {
    name: agent.name.trim(),
    system_prompt: agent.system_prompt,
    vad_model_id: agent.vad_model_id, asr_model_id: agent.asr_model_id,
    llm_model_id: agent.llm_model_id, vllm_model_id: agent.vllm_model_id,
    tts_model_id: agent.tts_model_id, memory_model_id: agent.memory_model_id,
    intent_model_id: agent.intent_model_id, tts_voice_id: agent.tts_voice_id,
    // 接口是整体覆盖,漏传这个字段会把已设的语言清空
    tts_language: agent.tts_language ?? null,
    chat_history_conf: agent.chat_history_conf,
    // 同样是整体覆盖:不传会清空。非千问合成时也照存,换回千问时参数还在
    tts_params: ttsParamsPayload(),
    runtime: agent.runtime,
    max_steps: Number(agent.max_steps) || 6,
    safety_level: agent.safety_level,
    description: agent.description,
    greeting: agent.greeting,
    role_template: agent.role_template,
    llm_params: llmParams.value.thinking ? { thinking: true } : {},
  };
  const creating = !agent.id;
  saving.value = true;
  try {
    if (creating) {
      // 先记下新 id:后面保存插件失败时再点保存,走的是更新而不是再建一个
      agent.id = (await api.post<{ id: string }>('/agents', payload)).id;
    } else {
      await api.put(`/agents/${agent.id}`, payload);
    }
    await api.put(`/agents/${agent.id}/plugins`,
      Object.entries(pluginState.value).map(([code, params]) => ({ plugin_code: code, params })));
    toast(creating ? `已创建「${payload.name}」` : '已保存。设备下次连接时生效。');
    editing.value = null;
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(agent: Agent) {
  const ok = await confirmDialog({
    title: `删除智能体「${agent.name}」?`,
    message: agent.device_count > 0
      ? `还有 ${agent.device_count} 台设备在用它,需要先在设备页把它们换到别的智能体。`
      : '删除后无法恢复。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/agents/${agent.id}`);
    toast(`已删除「${agent.name}」`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

// 人设里的占位符。写在这里而不是模板里:模板中嵌套的 {{ 会让 Vue 的插值解析器失配。
const NAME_PLACEHOLDER = '{' + '{assistant_name}' + '}';

const MODEL_LABELS: [keyof Agent, string, string, string][] = [
  ['llm_model_id', 'LLM', '对话模型', '决定它怎么思考和回话'],
  ['tts_model_id', 'TTS', '语音合成', '决定它的声音'],
  ['asr_model_id', 'ASR', '语音识别', '把用户说的话转成文字'],
  ['intent_model_id', 'Intent', '工具调用', '选「函数调用」才能用下面的工具'],
  ['vad_model_id', 'VAD', '语音活动检测', '判断用户什么时候说完了'],
  ['memory_model_id', 'Memory', '记忆', '要不要记住之前聊过什么'],
  ['vllm_model_id', 'VLLM', '视觉模型', '本硬件没有摄像头,可以不选'],
];

const PLUGIN_ICON: Record<string, IconName> = {
  show_calendar: 'calendar',
  get_weather: 'cloud',
  set_volume: 'volume',
  change_role: 'sparkles',
  web_search: 'globe',
  get_news_from_newsnow: 'news',
  get_news_from_chinanews: 'news',
  play_music: 'music',
  hass_state: 'home',
};
</script>

<template>
  <template v-if="!editing">
    <PageHeader title="智能体" description="人设、模型组合与工具。每台设备绑定一个智能体。">
      <template #actions>
        <button class="btn btn-primary" type="button" :disabled="loading" @click="create">
          <AppIcon name="plus" :size="16" /><span>新建智能体</span>
        </button>
      </template>
    </PageHeader>

    <div v-if="loadError" class="callout danger" role="alert">
      <AppIcon name="alert" :size="18" />
      <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
    </div>

    <div v-if="loading" class="card"><SkeletonRows :rows="3" /></div>
    <div v-else-if="agents.length === 0" class="card">
      <EmptyState title="还没有智能体" description="智能体决定设备用哪套模型、以什么人设说话。">
        <button class="btn btn-primary" type="button" @click="create"><AppIcon name="plus" :size="16" /><span>新建智能体</span></button>
      </EmptyState>
    </div>
    <div v-else class="grid-cards">
      <article v-for="agent in agents" :key="agent.id" class="card agent-card">
        <div class="agent-card-head">
          <span class="avatar tone-sky">{{ agent.name.slice(0, 1) }}</span>
          <div style="flex: 1; min-width: 0">
            <h3 class="truncate">{{ agent.name }}</h3>
            <div class="cell-sub">{{ agent.device_count }} 台设备在用</div>
          </div>
          <span v-if="agent.is_default" class="tag sky">默认</span>
        </div>
        <dl class="meta">
          <dt>对话模型</dt>
          <dd :class="{ muted: !modelById(agent.llm_model_id) }">{{ modelById(agent.llm_model_id)?.name ?? '未设置' }}</dd>
          <dt>语音合成</dt>
          <dd :class="{ muted: !modelById(agent.tts_model_id) }">
            {{ modelById(agent.tts_model_id)?.name ?? '未设置' }}<template v-if="voices.find((v) => v.id === agent.tts_voice_id)">
              · {{ voices.find((v) => v.id === agent.tts_voice_id)?.name }}</template>
          </dd>
          <dt>语音识别</dt>
          <dd :class="{ muted: !modelById(agent.asr_model_id) }">{{ modelById(agent.asr_model_id)?.name ?? '未设置' }}</dd>
          <dt>大脑</dt>
          <dd>
            <span v-if="agent.runtime === 'agent'" class="tag dot ok">控制塔智能体{{ agent.safety_level === 'child' ? ' · 儿童模式' : '' }}</span>
            <span v-else class="tag dot" :class="toolsOn(agent) ? 'ok' : ''">引擎旧路径 · 工具{{ toolsOn(agent) ? '已开启' : '未开启' }}</span>
          </dd>
        </dl>
        <div v-if="agentPluginLabels(agent).length" class="chips">
          <span v-for="label in agentPluginLabels(agent)" :key="label" class="tag">{{ label }}</span>
        </div>
        <div class="agent-card-foot">
          <button class="btn btn-sm" type="button" @click="edit(agent)"><AppIcon name="pencil" :size="14" /><span>编辑</span></button>
          <span class="spacer"></span>
          <button v-if="!agent.is_default" class="btn btn-ghost btn-sm danger" type="button" @click="remove(agent)">
            <AppIcon name="trash" :size="14" /><span>删除</span>
          </button>
        </div>
      </article>
    </div>
  </template>

  <template v-else>
    <PageHeader
      :title="editing.id ? `编辑「${editing.name || '智能体'}」` : '新建智能体'"
      description="保存后,设备下次连接时生效。"
    >
      <template #actions>
        <button class="btn" type="button" @click="leaveEdit"><AppIcon name="arrowLeft" :size="16" /><span>返回列表</span></button>
      </template>
    </PageHeader>

    <section class="card">
      <div class="card-head"><div><h2><AppIcon name="user" :size="18" />基本信息</h2></div></div>
      <div class="stack">
        <label class="field">
          <span class="field-label">名称<span class="req">*</span></span>
          <input v-model="editing.name" class="input" :class="{ invalid: nameError }" type="text" maxlength="64" />
          <span v-if="nameError" class="field-error">{{ nameError }}</span>
          <span v-else class="field-hint">人设里写 <code>{{ NAME_PLACEHOLDER }}</code> 会被替换成这个名字。</span>
        </label>
        <label class="field">
          <span class="field-label">一句话介绍</span>
          <input v-model="editing.description" class="input" type="text" maxlength="200" placeholder="例如:陪小朋友讲故事、学单词的童童" />
          <span class="field-hint">设备上说「切换到…」时,智能体按这句话挑角色。</span>
        </label>
        <label class="field">
          <span class="field-label">人设</span>
          <textarea v-model="editing.system_prompt" class="textarea" rows="8"></textarea>
          <span class="field-hint">
            写短一些:提示词每轮对话都会随请求上送,越长延迟和成本越高。建议写明它做不到什么,否则模型容易承诺自己没有的能力。
          </span>
        </label>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="sparkles" :size="18" />大脑</h2>
          <p>「控制塔智能体」支持一轮里连续调用多个工具、MCP、技能、提醒与内容库;「引擎旧路径」是原来的做法,切回去即回退。</p>
        </div>
        <div class="card-actions"><RouterLink class="btn btn-sm" to="/playground"><AppIcon name="message" :size="14" /><span>去试聊</span></RouterLink></div>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">大脑</span>
          <select v-model="editing.runtime" class="select">
            <option value="agent">控制塔智能体(推荐)</option>
            <option value="engine">引擎旧路径</option>
          </select>
        </label>
        <label v-if="isAgentRuntime" class="field">
          <span class="field-label">一轮最多调用几步工具</span>
          <input v-model.number="editing.max_steps" class="input" type="number" min="1" max="10" />
          <span class="field-hint">到上限后强制回答。步数越多越能办复杂的事,也越慢。</span>
        </label>
        <label v-if="isAgentRuntime" class="field">
          <span class="field-label">内容安全</span>
          <select v-model="editing.safety_level" class="select">
            <option value="standard">标准</option>
            <option value="child">儿童模式</option>
          </select>
          <span class="field-hint">儿童模式在提示词里加儿童安全规则,搜索与画画按儿童标准约束。</span>
        </label>
        <label v-if="isAgentRuntime" class="field">
          <span class="field-label">深度思考</span>
          <select v-model="llmParams.thinking" class="select">
            <option :value="false">关闭(推荐,回答快)</option>
            <option :value="true">开启(更慢,适合复杂推理)</option>
          </select>
        </label>
        <label v-if="isAgentRuntime" class="field span-all">
          <span class="field-label">切换到这个角色时的招呼</span>
          <input v-model="editing.greeting" class="input" type="text" maxlength="200" placeholder="例如:嗨,我是童童,今天想听故事还是学单词呀?" />
        </label>
      </div>
      <div v-if="isAgentRuntime && !editing.llm_model_id" class="callout warn" style="margin: 12px 0 0">
        <AppIcon name="alert" :size="18" /><div class="callout-body">控制塔智能体需要在下面的「对话模型」里选一个模型(例如 DeepSeek)。</div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="layers" :size="18" />模型组合</h2><p>选「不启用」表示不用这个模块。可选的模型在「模型」页维护。</p></div>
      </div>
      <div class="form-grid">
        <label v-for="[key, type, label, hint] in visibleModelLabels" :key="type" class="field">
          <span class="field-label">{{ label }}</span>
          <select v-model="(editing as any)[key]" class="select">
            <option :value="null">不启用</option>
            <option v-for="model in byType(type)" :key="model.id" :value="model.id">{{ model.name }}</option>
          </select>
          <span class="field-hint">{{ hint }}</span>
        </label>
        <label v-if="voicesOfModel.length" class="field">
          <span class="field-label">音色</span>
          <select v-model="editing.tts_voice_id" class="select" @change="editing.tts_language = null">
            <option :value="null">用语音合成模型自带的默认音色</option>
            <option
              v-for="voice in voicesOfModel" :key="voice.id" :value="voice.id"
              :disabled="voice.status !== 'ok' && voice.id !== editing.tts_voice_id"
            >{{ voice.name }}{{ VOICE_STATUS[voice.status] }}</option>
          </select>
          <span class="field-hint">音色在「音色」页管理;审核中的定制音色暂时不能选。</span>
        </label>
        <label v-if="voiceLanguages.length" class="field">
          <span class="field-label">合成语言</span>
          <select v-model="editing.tts_language" class="select">
            <option :value="null">自动({{ voiceLanguages[0] }})</option>
            <option v-for="language in voiceLanguages" :key="language" :value="language">{{ language }}</option>
          </select>
        </label>
        <template v-if="qwenTts">
          <label class="field">
            <span class="field-label">语速 {{ Number(ttsParams.rate).toFixed(2) }}</span>
            <input v-model.number="ttsParams.rate" type="range" min="0.5" max="2" step="0.05" />
          </label>
          <label class="field">
            <span class="field-label">音调 {{ Number(ttsParams.pitch).toFixed(2) }}</span>
            <input v-model.number="ttsParams.pitch" type="range" min="0.5" max="2" step="0.05" />
          </label>
          <label class="field">
            <span class="field-label">音量 {{ ttsParams.volume }}</span>
            <input v-model.number="ttsParams.volume" type="range" min="0" max="100" step="1" />
          </label>
          <label class="field">
            <span class="field-label">语气指令</span>
            <input v-model="ttsParams.instruction" class="input" type="text" maxlength="50" placeholder="例如:像幼儿园老师一样温柔、耐心" />
            <span class="field-hint">千问合成专用,至多 50 个汉字。</span>
          </label>
          <div class="field" style="justify-content: flex-end">
            <button class="btn" type="button" style="align-self: flex-start" :aria-busy="previewing" @click="previewVoice">
              <AppIcon name="volume" :size="16" /><span>试听当前声音</span>
            </button>
          </div>
        </template>
        <label class="field">
          <span class="field-label">对话记录</span>
          <select v-model.number="editing.chat_history_conf" class="select">
            <option :value="0">不记录</option>
            <option :value="1">记录文字</option>
            <option :value="2">记录文字与音频(控制台仍只存文字)</option>
          </select>
        </label>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="zap" :size="18" />工具</h2>
          <p v-if="isAgentRuntime">打开后,智能体会在需要时调用它们;一件事要好几步时会连续调用直到办完。</p>
          <p v-else>打开后,模型会在需要时调用它们。识别告别与查农历由服务端始终开启,不在这里列出。</p>
        </div>
      </div>
      <div v-if="!toolsEnabled" class="callout warn">
        <AppIcon name="alert" :size="18" />
        <div class="callout-body">
          <strong>工具调用没有开启。</strong>模型组合里的「工具调用」不是函数调用,下面的工具不会生效。
          <div v-if="functionCallModel" class="callout-actions">
            <button class="btn btn-sm btn-primary" type="button" @click="enableTools"><span>改为函数调用</span></button>
          </div>
        </div>
      </div>
      <div class="plugin-grid">
        <div v-for="plugin in visiblePlugins" :key="plugin.code" class="plugin" :class="{ on: plugin.code in pluginState }">
          <div class="plugin-head">
            <span class="plugin-icon"><AppIcon :name="PLUGIN_ICON[plugin.code] ?? 'zap'" :size="18" /></span>
            <span class="plugin-title">{{ plugin.label }}</span>
            <SwitchToggle :model-value="plugin.code in pluginState" @update:model-value="togglePlugin(plugin, $event)">
              <span class="visually-hidden">{{ plugin.label }}</span>
            </SwitchToggle>
          </div>
          <p class="plugin-desc">{{ plugin.description }}</p>
          <div class="chips" style="margin-top: 10px">
            <span class="tag" :class="plugin.keyless ? 'ok' : 'warn'">{{ plugin.keyless ? '无需密钥' : '需要密钥' }}</span>
          </div>
          <div v-if="plugin.code in pluginState && plugin.fields.length" class="plugin-fields">
            <label v-for="field in plugin.fields" :key="field.key" class="field">
              <span class="field-label">{{ field.label }}<span v-if="field.required" class="req">*</span></span>
              <input
                v-model="pluginState[plugin.code]![field.key]" class="input"
                :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
                :placeholder="String(field.default ?? '')"
              />
              <span v-if="field.hint" class="field-hint">{{ field.hint }}</span>
            </label>
          </div>
        </div>
      </div>
    </section>

    <div class="action-bar">
      <span class="hint">{{ dirty ? '有未保存的修改。' : '没有修改。' }}保存后,设备下次连接时生效。</span>
      <button class="btn" type="button" @click="leaveEdit">取消</button>
      <button class="btn btn-primary" type="button" :aria-busy="saving" @click="save">
        <AppIcon name="check" :size="16" /><span>保存</span>
      </button>
    </div>
  </template>
</template>
