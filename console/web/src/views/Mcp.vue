<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type McpServerView } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import { confirmDialog, relativeTime, toast, toastError } from '../ui';

// MCP 服务器:给智能体接外部工具。只支持远程的 Streamable HTTP 地址,控制塔不在服务器上跑本地命令。
// 在这里增删改查、测试连接、选对外提供哪些工具;哪个智能体用哪些服务器只在智能体页决定,服务器本身没有启用开关。

const servers = ref<McpServerView[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loadError.value = '';
  try {
    servers.value = (await api.get<{ items: McpServerView[] }>('/mcp-servers')).items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** 对外提供的工具:勾选立刻保存。全部勾上时存成 null(以后服务器新增的工具也算) */
const toolOn = (server: McpServerView, tool: string) => server.tool_allowlist === null || server.tool_allowlist.includes(tool);
async function toggleTool(server: McpServerView, tool: string, on: boolean) {
  const names = server.tools.map((t) => t.name);
  const current = server.tool_allowlist ?? names;
  const next = on ? [...new Set([...current, tool])] : current.filter((name) => name !== tool);
  const allowlist = names.every((name) => next.includes(name)) ? null : next;
  try {
    await api.put(`/mcp-servers/${server.id}/tools`, { allowlist });
    server.tool_allowlist = allowlist;
  } catch (e) {
    toastError(e);
  }
}

interface Draft {
  id: string | null;
  name: string;
  url: string;
  headers: string;
  timeout_s: number;
}
const draft = ref<Draft | null>(null);
const saving = ref(false);

function openCreate() {
  draft.value = { id: null, name: '', url: '', headers: '', timeout_s: 20 };
}

async function openEdit(server: McpServerView) {
  try {
    const full = await api.get<McpServerView>(`/mcp-servers/${server.id}`);
    draft.value = {
      id: server.id, name: full.name, url: full.url ?? '', timeout_s: Math.round(full.timeout_ms / 1000),
      // 请求头的值不回显,留着打码后的样子;原样提交表示不修改
      headers: Object.entries(full.headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
    };
  } catch (e) {
    toastError(e);
  }
}

function parseHeaders(text: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(':');
    if (at <= 0) return null;
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

async function save() {
  const d = draft.value;
  if (!d || saving.value) return;
  const headers = parseHeaders(d.headers);
  if (!headers) {
    toast('请求头每行写成「名称: 值」。', 'warn');
    return;
  }
  saving.value = true;
  try {
    const payload = { name: d.name.trim(), url: d.url.trim(), headers, timeout_ms: Math.round(d.timeout_s * 1000) };
    let id = d.id;
    if (id) await api.put(`/mcp-servers/${id}`, payload);
    else id = (await api.post<{ id: string }>('/mcp-servers', payload)).id;
    draft.value = null;
    toast('已保存,正在测试连接…', 'info');
    await load();
    const saved = servers.value.find((s) => s.id === id);
    if (saved) await test(saved);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

// ---- 粘贴 JSON 导入 ----

const IMPORT_EXAMPLE = `{
  "mcpServers": {
    "aihot": {
      "type": "http",
      "url": "https://aihot.news/api/mcp"
    }
  }
}`;
const importOpen = ref(false);
const importText = ref('');
const importForAll = ref(true);
const importing = ref(false);

function openImport() {
  importText.value = '';
  importForAll.value = true;
  importOpen.value = true;
}

async function runImport() {
  if (importing.value) return;
  let config: unknown;
  try {
    config = JSON.parse(importText.value || IMPORT_EXAMPLE);
  } catch {
    toast('不是合法的 JSON,检查一下括号和引号。', 'warn');
    return;
  }
  importing.value = true;
  try {
    const result = await api.post<{
      created: { id: string; name: string; tools: number | null; error: string | null }[];
      skipped: { name: string; reason: string }[];
    }>('/mcp-servers/import', { config, enable_for_all_agents: importForAll.value });
    importOpen.value = false;
    for (const item of result.created) {
      if (item.error) toast(`「${item.name}」已添加,但连接失败:${item.error}`, 'error');
      else toast(`「${item.name}」已添加,${item.tools} 个工具${importForAll.value ? ',已给所有智能体启用' : ''}`);
    }
    for (const item of result.skipped) toast(`跳过「${item.name}」:${item.reason}`, 'warn');
    if (!result.created.length && !result.skipped.length) toast('配置里没有找到服务器。', 'warn');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    importing.value = false;
  }
}

const testing = ref('');
async function test(server: McpServerView) {
  testing.value = server.id;
  try {
    const result = await api.post<{ ms: number; tools: unknown[] }>(`/mcp-servers/${server.id}/test`);
    toast(`「${server.name}」连接成功,${result.tools.length} 个工具,${(result.ms / 1000).toFixed(1)} 秒`);
  } catch (e) {
    toast(`「${server.name}」连接失败:${(e as Error).message}`, 'error');
  } finally {
    testing.value = '';
    await load();
  }
}

async function remove(server: McpServerView) {
  const ok = await confirmDialog({
    title: `删除 MCP 服务器「${server.name}」?`,
    message: server.agents.length ? `${server.agents.map((a) => a.name).join('、')}在用它,删除后它们不再能用这些工具。` : '删除后无法恢复。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/mcp-servers/${server.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <PageHeader title="MCP" description="给智能体接外部工具(Model Context Protocol)。这里添加、编辑、删除服务器并选它对外提供哪些工具;哪个智能体用哪些服务器,在「智能体」页。">
    <template #actions>
      <button class="btn" type="button" @click="openImport"><AppIcon name="copy" :size="16" /><span>粘贴 JSON 导入</span></button>
      <button class="btn btn-primary" type="button" @click="openCreate"><AppIcon name="plus" :size="16" /><span>添加服务器</span></button>
    </template>
  </PageHeader>

  <ModalDialog :open="importOpen" wide title="粘贴 JSON 导入" @close="importOpen = false">
    <form id="mcp-import" class="stack" @submit.prevent="runImport">
      <p class="field-hint" style="margin: 0">
        直接粘贴 Claude、Cursor、Codex 等客户端通用的 <code>mcpServers</code> 配置,可以一次导入多个。只收远程 HTTP 地址;
        本地命令型(command)的服务器会跳过。留空直接导入,就是下面这个示例(AIHOT,匿名只读,不需要令牌)。
      </p>
      <textarea v-model="importText" class="textarea mono" rows="10" spellcheck="false" :placeholder="IMPORT_EXAMPLE" aria-label="MCP JSON 配置"></textarea>
      <SwitchToggle v-model="importForAll" label="导入后给所有智能体启用" />
    </form>
    <template #footer>
      <button class="btn" type="button" @click="importOpen = false">取消</button>
      <button class="btn btn-primary" type="submit" form="mcp-import" :aria-busy="importing"><AppIcon name="check" :size="16" /><span>导入并测试连接</span></button>
    </template>
  </ModalDialog>

  <div class="callout info">
    <AppIcon name="info" :size="18" />
    <div class="callout-body">
      只支持远程 Streamable HTTP 地址(https)。工具返回的内容会作为外部资料交给模型,并提醒它不要执行其中的指令。
      内置了 AIHOT 的「AI热点资讯」(匿名只读,个人非商业使用免费)。地址里如果带令牌,列表里只显示域名与路径。
    </div>
  </div>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>
  <div v-if="loading" class="card"><SkeletonRows :rows="3" /></div>

  <template v-else>
    <div v-if="servers.length === 0" class="card">
      <EmptyState title="还没有 MCP 服务器" description="点「粘贴 JSON 导入」,留空直接导入就能接上 AIHOT(AI 热点资讯)。">
        <button class="btn" type="button" @click="openImport"><AppIcon name="copy" :size="16" /><span>粘贴 JSON 导入</span></button>
        <button class="btn btn-primary" type="button" @click="openCreate"><AppIcon name="plus" :size="16" /><span>添加服务器</span></button>
      </EmptyState>
    </div>
    <section v-for="server in servers" :key="server.id" class="card">
      <div class="card-head">
        <div>
          <h2>
            <AppIcon name="link" :size="18" />{{ server.name }}
            <span v-if="server.last_error" class="tag danger" :title="server.last_error">上次连接失败</span>
            <span v-else-if="server.tools_updated_at" class="tag ok">{{ server.tools.length }} 个工具</span>
          </h2>
          <p><span class="chip-mono">{{ server.url_masked }}</span><template v-if="server.tools_updated_at"> · 工具列表 {{ relativeTime(server.tools_updated_at) }}更新</template></p>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" type="button" :aria-busy="testing === server.id" @click="test(server)"><AppIcon name="refresh" :size="14" /><span>测试连接</span></button>
          <button class="btn btn-ghost btn-sm" type="button" @click="openEdit(server)"><AppIcon name="pencil" :size="14" /><span>编辑</span></button>
          <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(server)"><AppIcon name="trash" :size="14" /><span>删除</span></button>
        </div>
      </div>
      <div v-if="server.last_error" class="callout danger" style="margin: 0 0 12px"><AppIcon name="alert" :size="18" /><div class="callout-body">{{ server.last_error }}</div></div>
      <div v-if="server.tools.length" class="table-wrap">
        <table class="table">
          <thead><tr><th>提供</th><th>工具</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="tool in server.tools" :key="tool.name">
              <td><input type="checkbox" :checked="toolOn(server, tool.name)" :aria-label="`对外提供 ${tool.name}`" @change="toggleTool(server, tool.name, ($event.target as HTMLInputElement).checked)" /></td>
              <td class="mono nowrap">{{ tool.name }}</td>
              <td class="cell-sub">{{ tool.description }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="还没有工具列表" description="点「测试连接」拉取。" />
      <p class="cell-sub" style="margin-top: 10px">
        <template v-if="server.agents.length">在用它的智能体:{{ server.agents.map((a) => a.name).join('、') }}</template>
        <template v-else>还没有智能体用它,去 <RouterLink to="/agents">智能体</RouterLink> 页打开。</template>
      </p>
    </section>
  </template>

  <ModalDialog :open="!!draft" wide :title="draft?.id ? '编辑 MCP 服务器' : '添加 MCP 服务器'" @close="draft = null">
    <form v-if="draft" id="mcp-form" class="stack" @submit.prevent="save">
      <div class="form-grid">
        <label class="field">
          <span class="field-label">名称<span class="req">*</span></span>
          <input v-model="draft.name" class="input" type="text" maxlength="64" placeholder="AIHOT" />
          <span class="field-hint">会显示在设备的工具提示里,尽量短。</span>
        </label>
        <label class="field">
          <span class="field-label">超时(秒)</span>
          <input v-model.number="draft.timeout_s" class="input" type="number" min="1" max="120" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">地址<span class="req">*</span></span>
        <input v-model="draft.url" class="input mono" type="url" placeholder="https://aihot.news/api/mcp?aihot_actor=…" />
      </label>
      <label class="field">
        <span class="field-label">请求头</span>
        <textarea v-model="draft.headers" class="textarea mono" rows="3" placeholder="Authorization: Bearer xxx"></textarea>
        <span class="field-hint">每行一个「名称: 值」。编辑时已有的值以打码形式显示,原样保留表示不修改。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="draft = null">取消</button>
      <button class="btn btn-primary" type="submit" form="mcp-form" :aria-busy="saving"><AppIcon name="check" :size="16" /><span>保存并测试</span></button>
    </template>
  </ModalDialog>
</template>
