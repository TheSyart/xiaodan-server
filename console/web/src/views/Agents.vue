<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, RouterLink } from 'vue-router';
import { api, type Agent, type McpServerView, type Model, type RoleTemplate, type RoleTemplateApplied, type Skill, type ToolView, type Voice } from '../api';
import { playBlob, stopPlayback } from '../audio';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import type { IconName } from '../icons';
import { confirmDialog, toast, toastError } from '../ui';

const agents = ref<Agent[]>([]);
const models = ref<Model[]>([]);
const voices = ref<Voice[]>([]);
const tools = ref<ToolView[]>([]);
const mcpServers = ref<McpServerView[]>([]);
const skills = ref<Skill[]>([]);
// 智能体页只决定开不开:工具代号、MCP 服务器 id、技能名。能力自己的设置在工具、MCP、技能页
const toolState = ref<string[]>([]);
const mcpState = ref<string[]>([]);
const skillState = ref<string[]>([]);
const loading = ref(true);
const loadError = ref('');

const editing = ref<Agent | null>(null);
/** 模型参数:是否开思考 */
const llmParams = ref({ thinking: false });
const snapshot = ref('');
const saving = ref(false);
const nameError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [a, m, v, t, ms, sk] = await Promise.all([
      api.get<{ items: Agent[] }>('/agents'),
      api.get<{ items: Model[] }>('/models'),
      api.get<{ items: Voice[] }>('/voices'),
      api.get<{ items: ToolView[] }>('/tools'),
      api.get<{ items: McpServerView[] }>('/mcp-servers'),
      api.get<{ items: Skill[] }>('/skills'),
    ]);
    mcpServers.value = ms.items;
    skills.value = sk.items;
    agents.value = a.items;
    models.value = m.items;
    voices.value = v.items;
    tools.value = t.items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const byType = (type: string) => models.value.filter((m) => m.model_type === type && m.enabled === 1);
const modelById = (id: string | null) => (id ? models.value.find((m) => m.id === id) : undefined);
const pluginLabel = (code: string) => tools.value.find((t) => t.code === code)?.label;
const agentPluginLabels = (agent: Agent) =>
  agent.plugins.map((code) => pluginLabel(code)).filter((label): label is string => !!label);

/**
 * 某类型标为默认的模型;没有默认项就留空。不能取列表第一个:排序靠 id 而不是用户的选择,
 * 新建的智能体会拿到一个谁也没选过的模型。新库里工具调用(函数调用)本身就是默认项。
 */
const defaultOf = (type: string) => byType(type).find((m) => m.is_default === 1)?.id ?? null;

/** 对话模型能不能看图(模型页的「支持看图」) */
const visionOf = (id: string | null) => {
  try {
    const config = JSON.parse(modelById(id)?.config_json ?? '{}') as { vision?: unknown };
    return config.vision === true || config.vision === 'true';
  } catch {
    return false;
  }
};
const voiceById = (id: string | null) => voices.value.find((voice) => voice.id === id);
const selectedVoice = computed(() => voiceById(editing.value?.tts_voice_id ?? null));
const VOICE_GROUPS: [Voice['kind'], string][] = [['system', '系统音色'], ['clone', '复刻音色'], ['design', '设计音色']];
const usableVoices = computed(() => voices.value.filter((voice) => voice.compatible));
/** 工具按分组显示 */
const toolGroups = computed(() => {
  const groups = new Map<string, ToolView[]>();
  for (const tool of tools.value) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool]);
  return [...groups.entries()];
});

const toggleIn = (list: string[], item: string, on: boolean) => (on ? [...new Set([...list, item])].sort() : list.filter((x) => x !== item));
function toggleTool(code: string, on: boolean) {
  toolState.value = toggleIn(toolState.value, code, on);
}
function toggleMcp(id: string, on: boolean) {
  mcpState.value = toggleIn(mcpState.value, id, on);
}
function toggleSkill(name: string, on: boolean) {
  skillState.value = toggleIn(skillState.value, name, on);
}

/** 技能 allowed-tools 里的一项(可以带 * 通配)能不能匹配这个函数名 */
const matches = (pattern: string, name: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u').test(name);
/** MCP 服务器对外提供的函数名(与控制塔 mcpToolName 的常见情形一致) */
const mcpFunctions = (server: McpServerView) =>
  server.tools.filter((t) => server.tool_allowlist === null || server.tool_allowlist.includes(t.name)).map((t) => `mcp_${server.id}__${t.name}`);

/** 技能需要、但这个智能体没开的工具 */
function missingTools(skill: Skill): string[] {
  const available = [
    ...tools.value.filter((t) => toolState.value.includes(t.code)).flatMap((t) => t.functions.map((fn) => fn.name)),
    ...mcpServers.value.filter((s) => mcpState.value.includes(s.id)).flatMap(mcpFunctions),
  ];
  return skill.allowed_tools.split(/[,\s]+/u).filter(Boolean).filter((pattern) => !available.some((name) => matches(pattern, name)));
}

/** 把技能缺的工具一起打开:能找到提供它的工具或 MCP 服务器就开;找不到的留着提示 */
function enableMissing(skill: Skill) {
  const missing = missingTools(skill);
  for (const tool of tools.value) {
    if (tool.functions.some((fn) => missing.some((pattern) => matches(pattern, fn.name)))) toggleTool(tool.code, true);
  }
  for (const server of mcpServers.value) {
    if (mcpFunctions(server).some((name) => missing.some((pattern) => matches(pattern, name)))) toggleMcp(server.id, true);
  }
  const still = missingTools(skill);
  if (still.length) toast(`这些还找不到来源,先去工具或 MCP 页看看:${still.join('、')}`, 'warn');
}
const toolLabelsFor = (skill: Skill) => {
  const missing = missingTools(skill);
  const labels = [
    ...tools.value.filter((t) => t.functions.some((fn) => missing.some((p) => matches(p, fn.name)))).map((t) => `工具「${t.label}」`),
    ...mcpServers.value.filter((s) => mcpFunctions(s).some((name) => missing.some((p) => matches(p, name)))).map((s) => `MCP「${s.name}」`),
  ];
  return labels.length ? labels : missing;
};
const previewing = ref(false);
async function previewVoice() {
  const agent = editing.value;
  const voice = selectedVoice.value;
  if (!agent || !voice || previewing.value) return;
  previewing.value = true;
  try {
    const blob = await api.postForBlob('/voices/preview', { voice_id: voice.id });
    await playBlob(blob);
  } catch (e) {
    toastError(e);
  } finally {
    previewing.value = false;
  }
}
onBeforeUnmount(stopPlayback);

const draftJson = () => JSON.stringify({
  agent: editing.value, tools: toolState.value, llm: llmParams.value, mcp: mcpState.value, skills: skillState.value,
});
const dirty = computed(() => !!editing.value && draftJson() !== snapshot.value);

function startEditing(agent: Agent) {
  editing.value = agent;
  // 库里可能残留目录已移除的工具(比如早先的 get_time)。不带进表单:保存时接口会拒绝未知工具。
  const known = new Set(tools.value.map((t) => t.code));
  toolState.value = [...(agent.plugins ?? [])].filter((code) => known.has(code)).sort();
  mcpState.value = [...(agent.mcp_servers ?? [])].sort();
  skillState.value = [...(agent.skills ?? [])].sort();
  try {
    llmParams.value = { thinking: (JSON.parse(agent.llm_params_json || '{}') as { thinking?: boolean }).thinking === true };
  } catch {
    llmParams.value = { thinking: false };
  }
  snapshot.value = draftJson();
  nameError.value = '';
}

function edit(agent: Agent) {
  startEditing(JSON.parse(JSON.stringify(agent)) as Agent);
}

function create() {
  startEditing(
    {
      id: '', name: '新的智能体', system_prompt: '',
      asr_model_id: defaultOf('ASR'), llm_model_id: defaultOf('LLM'),
      tts_voice_id: usableVoices.value.find((voice) => voice.status === 'ok' && voice.kind === 'system')?.id ?? null,
      chat_history_conf: 1, is_default: 0,
      max_steps: 6, safety_level: 'standard', description: '', greeting: '', role_template: '',
      llm_params_json: '{}', plugins: [], device_count: 0, mcp_servers: [], skills: [],
    },
  );
}

// ---- 角色模板 ----

const templates = ref<RoleTemplate[]>([]);
const templatesOpen = ref(false);
const templateNames = ref<Record<string, string>>({});
const applying = ref('');

async function openTemplates() {
  try {
    templates.value = (await api.get<{ items: RoleTemplate[] }>('/role-templates')).items;
    templateNames.value = Object.fromEntries(templates.value.map((t) => [t.id, t.created ? `${t.name}${t.created + 1}` : t.name]));
    templatesOpen.value = true;
  } catch (e) {
    toastError(e);
  }
}

async function applyTemplate(template: RoleTemplate) {
  if (applying.value) return;
  applying.value = template.id;
  try {
    const result = await api.post<RoleTemplateApplied>(`/role-templates/${template.id}/apply`, { name: templateNames.value[template.id] });
    templatesOpen.value = false;
    await load();
    const created = agents.value.find((agent) => agent.id === result.id);
    if (result.missing.length) toast(`已创建,但还缺:${result.missing.join('、')}`, 'warn');
    else toast(`已创建「${created?.name ?? template.name}」`);
    if (created) edit(created);
  } catch (e) {
    toastError(e);
  } finally {
    applying.value = '';
  }
}

const DISCARD = { title: '放弃未保存的修改?', message: '离开后这次的修改不会保存。', confirmText: '放弃修改', danger: true };

async function leaveEdit() {
  if (dirty.value && !(await confirmDialog(DISCARD))) return;
  editing.value = null;
}

onBeforeRouteLeave(async () => (editing.value && dirty.value ? confirmDialog(DISCARD) : true));

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
    asr_model_id: agent.asr_model_id,
    llm_model_id: agent.llm_model_id,
    tts_voice_id: agent.tts_voice_id,
    chat_history_conf: agent.chat_history_conf ? 1 : 0,
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
      // 先记下新 id:后面保存开关失败时再点保存,走的是更新而不是再建一个
      agent.id = (await api.post<{ id: string }>('/agents', payload)).id;
    } else {
      await api.put(`/agents/${agent.id}`, payload);
    }
    await api.put(`/agents/${agent.id}/plugins`, toolState.value);
    await api.put(`/agents/${agent.id}/mcp`, mcpState.value);
    await api.put(`/agents/${agent.id}/skills`, skillState.value);
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

const PLUGIN_ICON: Record<string, IconName> = {
  show_calendar: 'calendar',
  get_weather: 'cloud',
  set_volume: 'volume',
  search: 'globe',
  reminders: 'clock',
  stories: 'message',
  music: 'music',
  vocab: 'key',
  image: 'sparkles',
  memory: 'star',
  roles: 'user',
};
</script>

<template>
  <template v-if="!editing">
    <PageHeader title="智能体" description="人设、模型组合,以及开哪些工具、技能与 MCP。每台设备绑定一个智能体。">
      <template #actions>
        <button class="btn" type="button" :disabled="loading" @click="openTemplates">
          <AppIcon name="sparkles" :size="16" /><span>从模板创建</span>
        </button>
        <button class="btn btn-primary" type="button" :disabled="loading" @click="create">
          <AppIcon name="plus" :size="16" /><span>新建智能体</span>
        </button>
      </template>
    </PageHeader>

    <ModalDialog :open="templatesOpen" wide title="从模板创建角色" @close="templatesOpen = false">
      <p class="field-hint" style="margin: 0 0 12px">
        建出来的是普通智能体:模型沿用默认智能体的选择,之后在编辑页随意改。设备上说「换童童来陪我」就能切换(需要开启「切换角色」工具)。
      </p>
      <div class="template-grid">
        <article v-for="template in templates" :key="template.id" class="card template-card">
          <div class="agent-card-head">
            <span class="avatar tone-sky">{{ template.name.slice(0, 1) }}</span>
            <div style="flex: 1; min-width: 0">
              <h3 class="truncate">{{ template.name }}</h3>
              <div class="cell-sub">
                音色 {{ template.voice_name }}<template v-if="template.safety_level === 'child'"> · 儿童模式</template>
                <template v-if="template.created"> · 已建 {{ template.created }} 个</template>
              </div>
            </div>
          </div>
          <p class="template-desc">{{ template.description }}</p>
          <div class="chips">
            <span v-for="code in template.plugins" :key="code" class="tag">{{ pluginLabel(code) ?? code }}</span>
            <span v-for="name in template.skills" :key="name" class="tag sky">技能 {{ name }}</span>
          </div>
          <div v-if="template.note" class="callout info" style="margin: 0"><AppIcon name="info" :size="16" /><div class="callout-body">{{ template.note }}</div></div>
          <div v-if="template.missing_skills.length" class="callout warn" style="margin: 0">
            <AppIcon name="alert" :size="16" /><div class="callout-body">技能页里还没有:{{ template.missing_skills.join('、') }}</div>
          </div>
          <div class="row" style="gap: 8px; margin-top: auto">
            <input v-model="templateNames[template.id]" class="input" type="text" maxlength="64" :aria-label="`${template.name} 的名字`" style="flex: 1; min-width: 0" />
            <button class="btn btn-primary btn-sm" type="button" :aria-busy="applying === template.id" @click="applyTemplate(template)">
              <AppIcon name="plus" :size="14" /><span>创建</span>
            </button>
          </div>
        </article>
      </div>
    </ModalDialog>

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
          <dt>音色</dt>
          <dd :class="{ muted: !voiceById(agent.tts_voice_id) }">{{ voiceById(agent.tts_voice_id)?.name ?? '默认音色' }}</dd>
          <dt>语音识别</dt>
          <dd :class="{ muted: !modelById(agent.asr_model_id) }">{{ modelById(agent.asr_model_id)?.name ?? '默认' }}</dd>
          <dt>模式</dt>
          <dd>
            <span v-if="agent.safety_level === 'child'" class="tag dot ok">儿童模式</span>
            <span v-else class="tag dot">标准</span>
            <span v-if="visionOf(agent.llm_model_id)" class="tag sky" style="margin-left: 4px">能看图</span>
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
        <div><h2><AppIcon name="layers" :size="18" />模型与声音</h2><p>对话、识别模型在「模型」页维护;声音的音量、语速、方言与语气在「音色」页调。画画用哪个文生图模型在「工具」页选。</p></div>
        <div class="card-actions"><RouterLink class="btn btn-sm" to="/playground"><AppIcon name="message" :size="14" /><span>去试聊</span></RouterLink></div>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">对话模型</span>
          <select v-model="editing.llm_model_id" class="select">
            <option :value="null">请选择</option>
            <option v-for="model in byType('LLM')" :key="model.id" :value="model.id">{{ model.name }}{{ visionOf(model.id) ? ' · 能看图' : '' }}</option>
          </select>
          <span class="field-hint">{{ visionOf(editing.llm_model_id) ? '这个模型能看图,用户发的图片它能看懂。' : '这个模型看不了图;要看图能力,选一个在模型页打开了「支持看图」的模型。' }}</span>
        </label>
        <label class="field">
          <span class="field-label">语音识别</span>
          <select v-model="editing.asr_model_id" class="select">
            <option :value="null">默认{{ defaultOf('ASR') ? `(${modelById(defaultOf('ASR'))?.name})` : '' }}</option>
            <option v-for="model in byType('ASR')" :key="model.id" :value="model.id">{{ model.name }}</option>
          </select>
        </label>
        <div class="field span-all">
          <span class="field-label">音色</span>
          <div class="row" style="gap: 8px; flex-wrap: wrap">
            <select v-model="editing.tts_voice_id" class="select" style="flex: 1; min-width: 220px">
              <option :value="null">默认音色</option>
              <optgroup v-for="[kind, label] in VOICE_GROUPS" :key="kind" :label="label">
                <option
                  v-for="voice in usableVoices.filter((v) => v.kind === kind)" :key="voice.id" :value="voice.id"
                  :disabled="voice.status !== 'ok' && voice.id !== editing.tts_voice_id"
                >{{ voice.name }}{{ voice.status === 'pending' ? '(审核中)' : voice.status === 'failed' ? '(未通过审核)' : '' }}</option>
              </optgroup>
            </select>
            <button class="btn" type="button" :disabled="!selectedVoice || selectedVoice.status !== 'ok'" :aria-busy="previewing" @click="previewVoice">
              <AppIcon name="volume" :size="16" /><span>试听</span>
            </button>
            <RouterLink class="btn btn-ghost" to="/voices"><AppIcon name="sliders" :size="16" /><span>去音色页调整</span></RouterLink>
          </div>
          <span class="field-hint">{{ selectedVoice ? selectedVoice.summary : '用默认千问合成模型的默认音色。' }}</span>
        </div>
        <label class="field">
          <span class="field-label">对话记录</span>
          <select v-model.number="editing.chat_history_conf" class="select">
            <option :value="1">记录</option>
            <option :value="0">不记录</option>
          </select>
        </label>
      </div>
      <div v-if="!editing.llm_model_id" class="callout warn" style="margin: 12px 0 0">
        <AppIcon name="alert" :size="18" /><div class="callout-body">还没有选对话模型,设备说话时它只会提示去配置。</div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="sparkles" :size="18" />对话行为</h2></div>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">一轮最多调用几步工具</span>
          <input v-model.number="editing.max_steps" class="input" type="number" min="1" max="10" />
          <span class="field-hint">到上限后强制回答。步数越多越能办复杂的事,也越慢。</span>
        </label>
        <label class="field">
          <span class="field-label">内容安全</span>
          <select v-model="editing.safety_level" class="select">
            <option value="standard">标准</option>
            <option value="child">儿童模式</option>
          </select>
          <span class="field-hint">儿童模式在提示词里加儿童安全规则,搜索与画画按儿童标准约束。</span>
        </label>
        <label class="field">
          <span class="field-label">深度思考</span>
          <select v-model="llmParams.thinking" class="select">
            <option :value="false">关闭(推荐,回答快)</option>
            <option :value="true">开启(更慢,适合复杂推理)</option>
          </select>
        </label>
        <label class="field span-all">
          <span class="field-label">切换到这个角色时的招呼</span>
          <input v-model="editing.greeting" class="input" type="text" maxlength="200" placeholder="例如:嗨,我是童童,今天想听故事还是学单词呀?" />
        </label>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="zap" :size="18" />工具</h2>
          <p>这个角色能用哪些工具。工具的说明与设置在 <RouterLink to="/tools">工具</RouterLink> 页,所有角色共用。</p>
        </div>
      </div>
      <template v-for="[group, items] in toolGroups" :key="group">
        <h3 class="plugin-group-title">{{ group }}</h3>
        <div class="plugin-grid">
          <div v-for="tool in items" :key="tool.code" class="plugin" :class="{ on: toolState.includes(tool.code) }">
            <div class="plugin-head">
              <span class="plugin-icon"><AppIcon :name="PLUGIN_ICON[tool.code] ?? 'zap'" :size="18" /></span>
              <span class="plugin-title">{{ tool.label }}</span>
              <SwitchToggle :model-value="toolState.includes(tool.code)" @update:model-value="toggleTool(tool.code, $event)">
                <span class="visually-hidden">{{ tool.label }}</span>
              </SwitchToggle>
            </div>
            <p class="plugin-desc">{{ tool.description }}</p>
            <div v-if="!tool.status.ready" class="chips" style="margin-top: 8px">
              <RouterLink to="/tools" class="tag warn" style="text-decoration: none">{{ tool.status.message }}</RouterLink>
            </div>
          </div>
        </div>
      </template>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="link" :size="18" />MCP 服务器</h2>
          <p>这个角色能用哪些外部工具服务器。服务器的添加、编辑与对外提供哪些工具在 <RouterLink to="/mcp">MCP</RouterLink> 页。</p>
        </div>
      </div>
      <EmptyState v-if="mcpServers.length === 0" title="还没有 MCP 服务器" description="先去 MCP 页添加,比如 AIHOT。" />
      <div class="plugin-grid">
        <div v-for="server in mcpServers" :key="server.id" class="plugin" :class="{ on: mcpState.includes(server.id) }">
          <div class="plugin-head">
            <span class="plugin-icon"><AppIcon name="link" :size="18" /></span>
            <span class="plugin-title">{{ server.name }}</span>
            <SwitchToggle :model-value="mcpState.includes(server.id)" @update:model-value="toggleMcp(server.id, $event)">
              <span class="visually-hidden">{{ server.name }}</span>
            </SwitchToggle>
          </div>
          <p class="plugin-desc">
            {{ server.tool_allowlist === null ? server.tools.length : server.tool_allowlist.length }} 个工具
            <template v-if="server.last_error"> · <span class="tag danger">上次连接失败</span></template>
          </p>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="sparkles" :size="18" />技能</h2>
          <p>这个角色掌握哪些技能;平时只占一行描述,用到时才读全文。技能的新建与编辑在 <RouterLink to="/skills">技能</RouterLink> 页。</p>
        </div>
      </div>
      <EmptyState v-if="skills.length === 0" title="还没有技能" />
      <div class="plugin-grid">
        <div v-for="skill in skills" :key="skill.name" class="plugin" :class="{ on: skillState.includes(skill.name) }">
          <div class="plugin-head">
            <span class="plugin-icon"><AppIcon name="sparkles" :size="18" /></span>
            <span class="plugin-title mono">{{ skill.name }}</span>
            <SwitchToggle :model-value="skillState.includes(skill.name)" @update:model-value="toggleSkill(skill.name, $event)">
              <span class="visually-hidden">{{ skill.name }}</span>
            </SwitchToggle>
          </div>
          <p class="plugin-desc">{{ skill.description }}</p>
          <div v-if="skillState.includes(skill.name) && missingTools(skill).length" class="callout warn" style="margin: 10px 0 0; padding: 8px 10px">
            <AppIcon name="alert" :size="15" />
            <div class="callout-body small">
              它需要的还没开:{{ toolLabelsFor(skill).join('、') }}
              <button class="btn btn-sm" type="button" style="margin-left: 6px" @click="enableMissing(skill)">一起开启</button>
            </div>
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
