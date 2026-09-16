<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type Agent, type McpServerView } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import { confirmDialog, relativeTime, toast, toastError } from '../ui';

// MCP 服务器:给智能体接外部工具。只支持远程的 Streamable HTTP 地址,控制塔不在服务器上跑本地命令。
// 在这里添加并测试连接;在「智能体」页给某个角色勾选启用。

const servers = ref<McpServerView[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [s, a] = await Promise.all([api.get<{ items: McpServerView[] }>('/mcp-servers'), api.get<{ items: Agent[] }>('/agents')]);
    servers.value = s.items;
    agents.value = a.items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const agentName = (id: string) => agents.value.find((a) => a.id === id)?.name ?? id;

interface Draft {
  id: string | null;
  name: string;
  url: string;
  headers: string;
  enabled: boolean;
  timeout_s: number;
}
const draft = ref<Draft | null>(null);
const saving = ref(false);

function openCreate() {
  draft.value = { id: null, name: '', url: '', headers: '', enabled: true, timeout_s: 20 };
}

async function openEdit(server: McpServerView) {
  try {
    const full = await api.get<McpServerView>(`/mcp-servers/${server.id}`);
    draft.value = {
      id: server.id, name: full.name, url: full.url ?? '', enabled: full.enabled === 1, timeout_s: Math.round(full.timeout_ms / 1000),
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
    const payload = { name: d.name.trim(), url: d.url.trim(), headers, enabled: d.enabled, timeout_ms: Math.round(d.timeout_s * 1000) };
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
    message: server.agents.length ? `有 ${server.agents.length} 个智能体在用它,删除后它们不再能用这些工具。` : '删除后无法恢复。',
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
  <PageHeader title="MCP" description="给智能体接外部工具(Model Context Protocol)。添加远程 MCP 服务器后,在「智能体」页按角色勾选启用。">
    <template #actions>
      <button class="btn btn-primary" type="button" @click="openCreate"><AppIcon name="plus" :size="16" /><span>添加服务器</span></button>
    </template>
  </PageHeader>

  <div class="callout info">
    <AppIcon name="info" :size="18" />
    <div class="callout-body">
      只支持远程 Streamable HTTP 地址(https)。工具返回的内容会作为外部资料交给模型,并提醒它不要执行其中的指令。
      地址里常带个人令牌(例如 AIHOT 的 aihot_actor),列表里只显示域名与路径。
    </div>
  </div>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>
  <div v-if="loading" class="card"><SkeletonRows :rows="3" /></div>

  <template v-else>
    <div v-if="servers.length === 0" class="card">
      <EmptyState title="还没有 MCP 服务器" description="例如 AIHOT(AI 资讯):地址形如 https://aihot.news/api/mcp?aihot_actor=你的标识。">
        <button class="btn btn-primary" type="button" @click="openCreate"><AppIcon name="plus" :size="16" /><span>添加服务器</span></button>
      </EmptyState>
    </div>
    <section v-for="server in servers" :key="server.id" class="card">
      <div class="card-head">
        <div>
          <h2>
            <AppIcon name="link" :size="18" />{{ server.name }}
            <span v-if="server.enabled === 0" class="tag">已停用</span>
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
          <thead><tr><th>工具</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="tool in server.tools" :key="tool.name">
              <td class="mono nowrap">{{ tool.name }}</td>
              <td class="cell-sub">{{ tool.description }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else title="还没有工具列表" description="点「测试连接」拉取。" />
      <p class="cell-sub" style="margin-top: 10px">
        <template v-if="server.agents.length">启用它的智能体:{{ server.agents.map((a) => agentName(a.agent_id)).join('、') }}</template>
        <template v-else>还没有智能体启用它,去 <RouterLink to="/agents">智能体</RouterLink> 页勾选。</template>
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
      <SwitchToggle v-model="draft.enabled" label="启用" />
    </form>
    <template #footer>
      <button class="btn" type="button" @click="draft = null">取消</button>
      <button class="btn btn-primary" type="submit" form="mcp-form" :aria-busy="saving"><AppIcon name="check" :size="16" /><span>保存并测试</span></button>
    </template>
  </ModalDialog>
</template>
