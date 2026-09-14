<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type ChatMessage, type ChatSession, type DeviceList } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PixelMascot from '../components/PixelMascot.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, formatTime, parseDbTime, relativeTime, toast, toastError } from '../ui';

const sessions = ref<ChatSession[]>([]);
const names = ref<Record<string, string>>({});
const loading = ref(true);
const loadError = ref('');
const filterMac = ref('');

const current = ref<ChatSession | null>(null);
const messages = ref<ChatMessage[]>([]);
const loadingMessages = ref(false);

async function load() {
  loadError.value = '';
  try {
    const [list, devices] = await Promise.all([
      api.get<{ items: ChatSession[] }>('/chats'),
      api.get<DeviceList>('/devices').catch(() => null),
    ]);
    sessions.value = list.items;
    names.value = Object.fromEntries((devices?.items ?? []).filter((d) => d.alias).map((d) => [d.mac, d.alias]));
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const macs = computed(() => [...new Set(sessions.value.map((s) => s.mac))]);
const visible = computed(() =>
  filterMac.value ? sessions.value.filter((s) => s.mac === filterMac.value) : sessions.value,
);
const deviceLabel = (mac: string) => names.value[mac] ?? mac;

function duration(session: ChatSession) {
  const ms = parseDbTime(session.ended_at).getTime() - parseDbTime(session.started_at).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

async function open(session: ChatSession) {
  current.value = session;
  messages.value = [];
  loadingMessages.value = true;
  window.scrollTo({ top: 0 });
  try {
    messages.value = (await api.get<{ items: ChatMessage[] }>(`/chats/${encodeURIComponent(session.session_id)}`)).items;
  } catch (e) {
    toastError(e);
  } finally {
    loadingMessages.value = false;
  }
}

async function remove(session: ChatSession) {
  const ok = await confirmDialog({
    title: '删除这段对话记录?',
    message: `${deviceLabel(session.mac)} 在 ${formatTime(session.started_at)} 开始的对话,共 ${session.messages} 条消息。删除后无法恢复。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/chats/${encodeURIComponent(session.session_id)}`);
    if (current.value?.session_id === session.session_id) current.value = null;
    toast('已删除对话记录');
    await load();
  } catch (e) {
    toastError(e);
  }
}

/** 工具调用记录是引擎上报的 JSON:[{"type":"tool","text":"get_weather({...})"}] 或 tool_result。 */
function toolText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          const entry = item as { type?: string; text?: string };
          return entry.type === 'tool_result' ? `返回 ${entry.text ?? ''}` : `调用 ${entry.text ?? ''}`;
        })
        .join(' · ');
    }
  } catch {
    /* 不是 JSON 就原样显示 */
  }
  return content;
}

interface Line {
  id: number;
  kind: 'user' | 'bot' | 'tool';
  text: string;
  time: string;
}
const lines = computed<Line[]>(() =>
  messages.value.map((m) => ({
    id: m.id,
    kind: m.chat_type === 1 ? 'user' : m.chat_type === 2 ? 'bot' : 'tool',
    text: m.chat_type === 3 ? toolText(m.content) : m.content,
    time: m.created_at,
  })),
);
const clock = (value: string) =>
  parseDbTime(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
</script>

<template>
  <template v-if="current">
    <PageHeader title="对话详情" :description="`${deviceLabel(current.mac)} · ${formatTime(current.started_at)} · ${current.messages} 条消息`">
      <template #actions>
        <button class="btn" type="button" @click="current = null"><AppIcon name="arrowLeft" :size="16" /><span>返回列表</span></button>
        <button class="btn btn-danger" type="button" @click="remove(current)"><AppIcon name="trash" :size="16" /><span>删除</span></button>
      </template>
    </PageHeader>
    <section class="card">
      <SkeletonRows v-if="loadingMessages" :rows="4" />
      <EmptyState v-else-if="lines.length === 0" title="这段对话没有内容" />
      <div v-else class="chat">
        <template v-for="line in lines" :key="line.id">
          <div v-if="line.kind === 'tool'" class="tool-line" :title="line.text">
            <AppIcon name="zap" :size="13" /><span>{{ line.text }}</span>
          </div>
          <div v-else class="bubble-row" :class="line.kind">
            <span v-if="line.kind === 'user'" class="avatar tone-sky"><AppIcon name="user" :size="16" /></span>
            <span v-else class="mascot-tile" style="width: 32px; height: 32px; border-radius: 9px; box-shadow: none; border-width: 1.5px">
              <PixelMascot :size="22" :blink="false" />
            </span>
            <div class="bubble-col">
              <div class="bubble">{{ line.text }}</div>
              <span class="bubble-time" :title="formatTime(line.time)">{{ line.kind === 'user' ? '用户' : '小单' }} · {{ clock(line.time) }}</span>
            </div>
          </div>
        </template>
      </div>
    </section>
  </template>

  <template v-else>
    <PageHeader title="对话记录" description="设备上每一轮对话的文字。音频不落盘,避免数据目录无限增长。" />

    <div v-if="loadError" class="callout danger" role="alert">
      <AppIcon name="alert" :size="18" />
      <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="message" :size="18" />最近的对话 <span v-if="visible.length" class="count">{{ visible.length }}</span></h2>
          <p>只列出最近 100 段。智能体的「对话记录」设成不记录时,这里不会出现新的内容。</p>
        </div>
        <div v-if="macs.length > 1" class="card-actions">
          <select v-model="filterMac" class="select" style="height: 32px; width: auto" aria-label="按设备筛选">
            <option value="">全部设备</option>
            <option v-for="mac in macs" :key="mac" :value="mac">{{ deviceLabel(mac) }}</option>
          </select>
        </div>
      </div>
      <SkeletonRows v-if="loading" />
      <EmptyState
        v-else-if="visible.length === 0" title="还没有对话记录"
        description="设备聊过之后这里会自动出现。"
      />
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>设备</th><th>消息</th><th>开始</th><th>时长</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="session in visible" :key="session.session_id">
              <td>
                <div class="cell-main">{{ deviceLabel(session.mac) }}</div>
                <div v-if="names[session.mac]" class="cell-sub mono">{{ session.mac }}</div>
              </td>
              <td class="mono">{{ session.messages }}</td>
              <td class="nowrap" :title="formatTime(session.started_at)">{{ relativeTime(session.started_at) }}</td>
              <td class="nowrap muted">{{ duration(session) }}</td>
              <td class="actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="open(session)">
                  <span>查看</span><AppIcon name="chevronRight" :size="14" />
                </button>
                <button class="btn btn-ghost btn-sm btn-icon danger" type="button" aria-label="删除" title="删除" @click="remove(session)">
                  <AppIcon name="trash" :size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
