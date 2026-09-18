<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type ToolView } from '../api';
import AppIcon from '../components/AppIcon.vue';
import PageHeader from '../components/PageHeader.vue';
import SearchProviders from '../components/SearchProviders.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import type { IconName } from '../icons';
import { toast, toastError } from '../ui';

// 工具:服务端代码实现的能力。这里查看说明、改设置(所有智能体共用);哪个智能体开哪些,在智能体页。
// 工具不能在页面上新建或删除,新能力用技能或 MCP 添加。

const tools = ref<ToolView[]>([]);
const loading = ref(true);
const loadError = ref('');
/** 工具代号 → 表单里的设置(都按文字编辑,保存时再转类型) */
const drafts = ref<Record<string, Record<string, string>>>({});
const saving = ref('');
const expanded = ref<string | null>(null);

function toDraft(tool: ToolView): Record<string, string> {
  return Object.fromEntries(tool.fields.map((field) => [field.key, tool.config[field.key] === undefined ? '' : String(tool.config[field.key])]));
}

async function load() {
  loadError.value = '';
  try {
    tools.value = (await api.get<{ items: ToolView[] }>('/tools')).items;
    drafts.value = Object.fromEntries(tools.value.map((tool) => [tool.code, toDraft(tool)]));
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// 有自己页面的能力(长期记忆)不在这里列卡片,只在页尾指个路
const groups = computed(() => {
  const map = new Map<string, ToolView[]>();
  for (const tool of tools.value.filter((item) => !item.page)) map.set(tool.group, [...(map.get(tool.group) ?? []), tool]);
  return [...map.entries()];
});
const elsewhere = computed(() => tools.value.filter((tool) => tool.page));

const dirty = (tool: ToolView) => JSON.stringify(drafts.value[tool.code]) !== JSON.stringify(toDraft(tool));

async function save(tool: ToolView) {
  if (saving.value) return;
  const draft = drafts.value[tool.code] ?? {};
  const config: Record<string, unknown> = {};
  for (const field of tool.fields) {
    const raw = (draft[field.key] ?? '').trim();
    if (!raw) continue;
    config[field.key] = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw;
  }
  saving.value = tool.code;
  try {
    await api.put(`/tools/${tool.code}`, { config });
    toast(`「${tool.label}」的设置已保存,下一轮对话生效`);
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = '';
  }
}

const TOOL_ICON: Record<string, IconName> = {
  show_calendar: 'calendar', get_weather: 'cloud', set_volume: 'volume', search: 'globe', reminders: 'clock',
  stories: 'message', music: 'music', vocab: 'key', image: 'sparkles', memory: 'star', roles: 'user',
};
</script>

<template>
  <PageHeader title="工具" description="服务端代码实现的能力。这里查看说明、改设置(所有智能体共用);哪个智能体开哪些,在「智能体」页。" />

  <div class="callout info">
    <AppIcon name="info" :size="18" />
    <div class="callout-body">
      工具是写在服务端的代码,页面上不能新建或删除。要给智能体加新本事:写一份做法说明用 <RouterLink to="/skills">技能</RouterLink>,
      接外部服务用 <RouterLink to="/mcp">MCP</RouterLink>。
    </div>
  </div>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>
  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <template v-else>
    <section v-for="[group, items] in groups" :key="group" class="card">
      <div class="card-head"><div><h2>{{ group }}</h2></div></div>
      <div class="plugin-grid">
        <article v-for="tool in items" :key="tool.code" class="plugin" :class="{ 'tool-wide': tool.code === 'search' }">
          <div class="plugin-head">
            <span class="plugin-icon"><AppIcon :name="TOOL_ICON[tool.code] ?? 'zap'" :size="18" /></span>
            <span class="plugin-title">{{ tool.label }}</span>
          </div>
          <div class="chips" style="margin-top: 8px">
            <span class="tag">{{ tool.runs_in === 'engine' ? '在引擎里执行' : '在控制塔执行' }}</span>
            <span v-if="!tool.keyless" class="tag">需要密钥或模型</span>
            <span v-if="tool.status.ready" class="tag ok">可以用</span>
            <span v-else class="tag warn">{{ tool.status.message }}</span>
          </div>
          <p class="plugin-desc">{{ tool.description }}</p>

          <div class="tool-meta">
            <div>
              <span class="cell-sub">开着它的智能体:</span>
              <template v-if="tool.agents.length">
                <RouterLink v-for="agent in tool.agents" :key="agent.id" to="/agents" class="tag sky">{{ agent.name }}</RouterLink>
              </template>
              <span v-else class="cell-sub">还没有</span>
            </div>
            <div v-if="tool.skills.length">
              <span class="cell-sub">用到它的技能:</span>
              <RouterLink v-for="name in tool.skills" :key="name" to="/skills" class="tag mono">{{ name }}</RouterLink>
            </div>
          </div>

          <button class="btn btn-ghost btn-sm" type="button" style="margin-top: 8px; align-self: flex-start" @click="expanded = expanded === tool.code ? null : tool.code">
            <AppIcon name="eye" :size="14" /><span>{{ expanded === tool.code ? '收起函数说明' : `模型看到的函数(${tool.functions.length})` }}</span>
          </button>
          <dl v-if="expanded === tool.code" class="tool-functions">
            <template v-for="fn in tool.functions" :key="fn.name">
              <dt class="mono">{{ fn.name }}</dt>
              <dd class="cell-sub">{{ fn.description }}</dd>
            </template>
          </dl>

          <div v-if="tool.code === 'search'" class="plugin-fields">
            <SearchProviders @changed="load" />
          </div>
          <form v-else-if="tool.fields.length" class="plugin-fields" @submit.prevent="save(tool)">
            <label v-for="field in tool.fields" :key="field.key" class="field">
              <span class="field-label">{{ field.label }}</span>
              <select v-if="field.type === 'select'" v-model="drafts[tool.code]![field.key]" class="select">
                <option value="">默认</option>
                <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <input
                v-else v-model="drafts[tool.code]![field.key]" class="input"
                :type="field.type === 'number' ? 'number' : 'text'" :min="field.min" :max="field.max"
                :placeholder="field.default === undefined ? '' : String(field.default)"
              />
              <span v-if="field.hint" class="field-hint">{{ field.hint }}</span>
            </label>
            <div class="row" style="justify-content: flex-end">
              <button class="btn btn-primary btn-sm" type="submit" :disabled="!dirty(tool)" :aria-busy="saving === tool.code">
                <AppIcon name="check" :size="14" /><span>保存设置</span>
              </button>
            </div>
          </form>
        </article>
      </div>
    </section>

    <section v-if="elsewhere.length" class="card">
      <div class="card-head"><div><h2>有自己页面的能力</h2><p>它们的内容太多,放在单独的页面里管理;哪个智能体开着它,仍在「智能体」页设置。</p></div></div>
      <div class="plugin-grid">
        <article v-for="tool in elsewhere" :key="tool.code" class="plugin">
          <div class="plugin-head">
            <span class="plugin-icon"><AppIcon :name="TOOL_ICON[tool.code] ?? 'zap'" :size="18" /></span>
            <span class="plugin-title">{{ tool.label }}</span>
          </div>
          <p class="plugin-desc">{{ tool.description }}</p>
          <div class="tool-meta">
            <div>
              <span class="cell-sub">开着它的智能体:</span>
              <template v-if="tool.agents.length">
                <RouterLink v-for="agent in tool.agents" :key="agent.id" to="/agents" class="tag sky">{{ agent.name }}</RouterLink>
              </template>
              <span v-else class="cell-sub">还没有</span>
            </div>
          </div>
          <RouterLink v-if="tool.page" class="btn btn-sm" :to="tool.page.path" style="margin-top: 8px; align-self: flex-start">
            <AppIcon name="arrowRight" :size="14" /><span>去「{{ tool.page.label }}」页</span>
          </RouterLink>
        </article>
      </div>
    </section>
  </template>
</template>

<style scoped>
.tool-wide { grid-column: 1 / -1; }
.plugin { display: flex; flex-direction: column; }
.tool-meta { margin-top: 10px; display: grid; gap: 6px; }
.tool-meta > div { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.tool-meta .tag { text-decoration: none; }
.tool-functions { margin: 8px 0 0; display: grid; gap: 4px; }
.tool-functions dt { font-size: 13px; font-weight: 600; }
.tool-functions dd { margin: 0 0 6px; }
</style>
