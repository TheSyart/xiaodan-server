<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Agent, type Catalog, type Model, type PluginDef, type Voice } from '../api';

const agents = ref<Agent[]>([]);
const models = ref<Model[]>([]);
const voices = ref<Voice[]>([]);
const catalog = ref<Catalog | null>(null);
const error = ref('');
const saved = ref('');

const editing = ref<Agent | null>(null);
/** 插件代号 → 参数。只有被勾选的才在这个表里。 */
const pluginState = ref<Record<string, Record<string, string>>>({});

async function load() {
  error.value = '';
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
    error.value = (e as Error).message;
  }
}
onMounted(load);

const byType = (type: string) => models.value.filter((m) => m.model_type === type && m.enabled === 1);

const voicesOfModel = computed(() =>
  editing.value?.tts_model_id
    ? voices.value.filter((v) => v.tts_model_id === editing.value!.tts_model_id)
    : [],
);

/** 当前选中的意图模型是不是 nointent —— 决定插件区要不要提示"不会生效"。 */
const toolsEnabled = computed(() => {
  const id = editing.value?.intent_model_id;
  if (!id) return false;
  const model = models.value.find((m) => m.id === id);
  return model ? model.provider !== 'nointent' : false;
});

function edit(agent: Agent) {
  editing.value = JSON.parse(JSON.stringify(agent)) as Agent;
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
  pluginState.value = state;
  saved.value = '';
}

/**
 * 某类型标为默认的模型;没有默认项就留空。不能取列表第一个:排序靠 id 而不是用户的选择,
 * 新建的智能体会拿到一个谁也没选过的模型。新库里工具调用(函数调用)本身就是默认项。
 */
const defaultOf = (type: string) => byType(type).find((m) => m.is_default === 1)?.id ?? null;

/** 当前所选音色支持的语言。 */
const voiceLanguages = computed(() => {
  const voice = voices.value.find((v) => v.id === editing.value?.tts_voice_id);
  return voice ? voice.languages.split('、').map((item) => item.trim()).filter(Boolean) : [];
});

function create() {
  editing.value = {
    id: '', name: '新的智能体', system_prompt: '',
    vad_model_id: defaultOf('VAD'), asr_model_id: defaultOf('ASR'), llm_model_id: defaultOf('LLM'),
    vllm_model_id: null, tts_model_id: defaultOf('TTS'),
    memory_model_id: defaultOf('Memory'), intent_model_id: defaultOf('Intent'),
    tts_voice_id: null, tts_language: null, chat_history_conf: 1, is_default: 0, plugins: [], device_count: 0,
  };
  pluginState.value = {};
  saved.value = '';
}

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

async function save() {
  if (!editing.value) return;
  error.value = '';
  const agent = editing.value;
  const payload = {
    name: agent.name,
    system_prompt: agent.system_prompt,
    vad_model_id: agent.vad_model_id, asr_model_id: agent.asr_model_id,
    llm_model_id: agent.llm_model_id, vllm_model_id: agent.vllm_model_id,
    tts_model_id: agent.tts_model_id, memory_model_id: agent.memory_model_id,
    intent_model_id: agent.intent_model_id, tts_voice_id: agent.tts_voice_id,
    // 接口是整体覆盖,漏传这个字段会把已设的语言清空
    tts_language: agent.tts_language ?? null,
    chat_history_conf: agent.chat_history_conf,
  };
  try {
    const id = agent.id || (await api.post<{ id: string }>('/agents', payload)).id;
    if (agent.id) await api.put(`/agents/${agent.id}`, payload);
    await api.put(`/agents/${id}/plugins`,
      Object.entries(pluginState.value).map(([code, params]) => ({ plugin_code: code, params })));
    saved.value = '已保存。设备下次连接时生效。';
    editing.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function remove(agent: Agent) {
  if (!confirm(`删除智能体「${agent.name}」?`)) return;
  try {
    await api.del(`/agents/${agent.id}`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// 人设里的占位符。写在这里而不是模板里 —— 模板中嵌套的 {{ 会让 Vue 的
// 插值解析器失配,报 Unterminated string constant。
const NAME_PLACEHOLDER = '{' + '{assistant_name}' + '}';

const MODEL_LABELS: [keyof Agent, string, string, string][] = [
  ['llm_model_id', 'LLM', '对话模型', '决定它怎么思考和回话'],
  ['tts_model_id', 'TTS', '语音合成', '决定它的声音'],
  ['asr_model_id', 'ASR', '语音识别', '把用户说的话转成文字'],
  ['vad_model_id', 'VAD', '语音活动检测', '判断用户什么时候说完了'],
  ['intent_model_id', 'Intent', '工具调用', '决定它能不能用插件'],
  ['memory_model_id', 'Memory', '记忆', '要不要记住之前聊过什么'],
  ['vllm_model_id', 'VLLM', '视觉模型', '本硬件没有摄像头,可留空'],
];
</script>

<template>
  <div class="page-head">
    <h1>智能体</h1>
    <p>人设、模型组合与插件。</p>
    <div class="spacer" />
    <button class="primary" @click="create">新建智能体</button>
  </div>

  <div v-if="error" class="notice error">{{ error }}</div>
  <div v-if="saved" class="notice info">{{ saved }}</div>

  <div v-if="!editing" class="card">
    <table>
      <thead>
        <tr><th>名称</th><th>对话模型</th><th>音色</th><th>设备</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="agent in agents" :key="agent.id">
          <td>
            {{ agent.name }}
            <span v-if="agent.is_default" class="tag ok">默认</span>
          </td>
          <td>{{ agent.llm_model_id || '未设置' }}</td>
          <td>{{ voices.find((v) => v.id === agent.tts_voice_id)?.name || '默认' }}</td>
          <td>{{ agent.device_count }}</td>
          <td class="actions">
            <button class="link" @click="edit(agent)">编辑</button>
            <button v-if="!agent.is_default" class="link danger" @click="remove(agent)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <template v-else>
    <div class="card">
      <h2>{{ editing.id ? '编辑智能体' : '新建智能体' }}</h2>
      <label>
        <span>名称</span>
        <input v-model="editing.name" type="text" />
        <small>人设里写 <code class="code">{{ NAME_PLACEHOLDER }}</code> 会被替换成这个名字。</small>
      </label>
      <label>
        <span>人设</span>
        <textarea v-model="editing.system_prompt" rows="8"></textarea>
        <small>
          写短一些。提示词每轮对话都会随请求上送,越长延迟和成本越高。
          建议明确写出它<b>做不到</b>什么,否则模型容易承诺自己没有的能力。
        </small>
      </label>
    </div>

    <div class="card">
      <h2>模型</h2>
      <p>没有配置的类型会沿用服务端默认值;留空表示不启用该模块。</p>
      <div class="field-row">
        <label v-for="[key, type, label, hint] in MODEL_LABELS" :key="type">
          <span>{{ label }}</span>
          <select v-model="(editing as any)[key]">
            <option :value="null">不启用</option>
            <option v-for="model in byType(type)" :key="model.id" :value="model.id">
              {{ model.name }}({{ model.id }})
            </option>
          </select>
          <small>{{ hint }}</small>
        </label>
      </div>

      <label v-if="voicesOfModel.length">
        <span>音色</span>
        <select v-model="editing.tts_voice_id" @change="editing.tts_language = null">
          <option :value="null">用语音合成模型自带的默认音色</option>
          <option v-for="voice in voicesOfModel" :key="voice.id" :value="voice.id">
            {{ voice.name }}({{ voice.voice }})
          </option>
        </select>
      </label>

      <label v-if="voiceLanguages.length">
        <span>合成语言</span>
        <select v-model="editing.tts_language">
          <option :value="null">自动(取音色支持的第一个:{{ voiceLanguages[0] }})</option>
          <option v-for="language in voiceLanguages" :key="language" :value="language">{{ language }}</option>
        </select>
      </label>

      <label>
        <span>对话记录</span>
        <select v-model.number="editing.chat_history_conf">
          <option :value="0">不记录</option>
          <option :value="1">记录文字</option>
          <option :value="2">记录文字与音频(本控制台仍只存文字)</option>
        </select>
      </label>
    </div>

    <div class="card">
      <h2>插件</h2>
      <p>勾选后它就能调用这些能力。识别告别与查农历由服务端始终开启,不在这里列出。</p>
      <div v-if="!toolsEnabled" class="notice warn">
        当前的「工具调用」选的是不启用工具,插件不会下发给设备。
        要让插件生效,请把上面的工具调用改成函数调用。
      </div>
      <div v-for="plugin in catalog?.plugins ?? []" :key="plugin.code" style="margin-bottom: 14px">
        <label style="margin-bottom: 4px">
          <input
            type="checkbox" :checked="plugin.code in pluginState"
            @change="togglePlugin(plugin, ($event.target as HTMLInputElement).checked)"
          />
          <b>{{ plugin.label }}</b>
          <span v-if="plugin.keyless" class="tag ok">无需密钥</span>
          <span v-else class="tag warn">需要密钥</span>
        </label>
        <div style="color: var(--muted); font-size: 13px; margin-left: 22px">{{ plugin.description }}</div>
        <div v-if="plugin.code in pluginState && plugin.fields.length" class="field-row" style="margin: 8px 0 0 22px">
          <label v-for="field in plugin.fields" :key="field.key">
            <span>{{ field.label }}</span>
            <input
              v-model="pluginState[plugin.code]![field.key]"
              :type="field.type === 'password' ? 'password' : 'text'"
              :placeholder="String(field.default ?? '')"
            />
            <small v-if="field.hint">{{ field.hint }}</small>
          </label>
        </div>
      </div>
    </div>

    <div class="btn-row">
      <button class="primary" @click="save">保存</button>
      <button @click="editing = null">取消</button>
    </div>
  </template>
</template>
