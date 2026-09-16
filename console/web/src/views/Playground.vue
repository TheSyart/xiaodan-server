<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, postEventStream, type Agent, type Device, type DeviceList, type RuntimeStatus } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PixelMascot from '../components/PixelMascot.vue';
import { toast, toastError } from '../ui';

// 网页试聊:不接硬件,用与设备完全相同的智能体循环跑一轮,并把每一步的工具调用摊开给你看。
// 选「借用设备」时,引擎里的工具(日历、天气、音量)在那台在线设备上执行,画面也会出现在它的屏幕上;声音不会播。

interface Step {
  kind: 'tool';
  name: string;
  arguments: unknown;
  content?: string;
  ms?: number;
  ok?: boolean;
}

interface Entry {
  id: number;
  role: 'user' | 'bot';
  text: string;
  steps: Step[];
  device: Record<string, unknown>[];
  media: { title: string; url: string }[];
  summary?: { steps: number; tool_calls: number; ms: number; error: string | null };
  pending?: boolean;
}

const agents = ref<Agent[]>([]);
const devices = ref<Device[]>([]);
const status = ref<RuntimeStatus | null>(null);
const agentId = ref('');
const deviceMac = ref('');
const conversationId = ref(Math.random().toString(36).slice(2, 10));
const input = ref('');
const entries = ref<Entry[]>([]);
const busy = ref(false);
const loadError = ref('');
let seq = 0;
let controller: AbortController | null = null;
const scroller = ref<HTMLElement | null>(null);

async function load() {
  try {
    const [a, d, s] = await Promise.all([
      api.get<{ items: Agent[] }>('/agents'),
      api.get<DeviceList>('/devices'),
      api.get<RuntimeStatus>('/agent-runtime/status'),
    ]);
    agents.value = a.items;
    devices.value = d.items;
    status.value = s;
    if (!agentId.value) agentId.value = (a.items.find((x) => x.runtime === 'agent') ?? a.items[0])?.id ?? '';
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}
onMounted(load);
onBeforeUnmount(() => controller?.abort());

const agent = computed(() => agents.value.find((a) => a.id === agentId.value));
const PRESETS = ['今天几号?', '北京明天天气怎么样,要下雨就把音量调小一点', '声音大一点', '给我讲个笑话'];

async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
}

async function send(text = input.value) {
  const message = text.trim();
  if (!message || busy.value || !agentId.value) return;
  input.value = '';
  entries.value.push({ id: ++seq, role: 'user', text: message, steps: [], device: [], media: [] });
  const bot: Entry = { id: ++seq, role: 'bot', text: '', steps: [], device: [], media: [], pending: true };
  entries.value.push(bot);
  const live = entries.value[entries.value.length - 1]!;
  busy.value = true;
  controller = new AbortController();
  void scrollDown();
  try {
    await postEventStream('/agent-runtime/try', {
      agent_id: agentId.value, message, conversation_id: conversationId.value, ...(deviceMac.value ? { device_mac: deviceMac.value } : {}),
    }, (event) => {
      switch (event['t']) {
        case 'meta':
          if (deviceMac.value && !event['device']) toast('借用的设备不在线,这轮按没有设备处理。', 'warn');
          break;
        case 'text':
          live.text += String(event['v'] ?? '');
          break;
        case 'trace':
          if (event['kind'] === 'tool_call') {
            live.steps.push({ kind: 'tool', name: String(event['name']), arguments: event['arguments'] });
          } else if (event['kind'] === 'tool_result') {
            const step = [...live.steps].reverse().find((s) => s.name === event['name'] && s.content === undefined);
            if (step) Object.assign(step, { content: String(event['content'] ?? ''), ms: Number(event['ms'] ?? 0), ok: event['ok'] !== false });
          }
          break;
        case 'device':
          live.device.push(event['msg'] as Record<string, unknown>);
          break;
        case 'media':
          live.media.push({ title: String(event['title'] ?? ''), url: String(event['url'] ?? '') });
          break;
        case 'summary':
          live.summary = event as unknown as Entry['summary'];
          break;
        case 'error':
          live.text += live.text ? '' : `(出错:${String(event['message'] ?? '')})`;
          break;
        default:
          break;
      }
      void scrollDown();
    }, controller.signal);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toastError(e);
  } finally {
    live.pending = false;
    busy.value = false;
    controller = null;
  }
}

function stop() {
  controller?.abort();
}

async function reset() {
  try {
    const result = await api.post<{ conversation_id: string }>('/agent-runtime/try/reset', {
      agent_id: agentId.value, conversation_id: conversationId.value,
    });
    conversationId.value = result.conversation_id;
    entries.value = [];
    toast('已开始新的对话');
  } catch (e) {
    toastError(e);
  }
}

const deviceText = (msg: Record<string, unknown>) => {
  if (msg['type'] === 'stt') return `提示:${String(msg['text'] ?? '')}`;
  if (msg['type'] === 'llm') return `表情:${String(msg['text'] ?? '')} ${String(msg['emotion'] ?? '')}`;
  if (msg['cmd'] === 'hint') return `提示:${String(msg['text'] ?? '')}`;
  return JSON.stringify(msg);
};
const shortJson = (value: unknown) => {
  const text = JSON.stringify(value);
  return text === '{}' ? '' : text;
};
</script>

<template>
  <PageHeader title="试聊" description="不接硬件,直接和智能体聊。每一步调用了什么工具、拿到什么结果都会摊开显示。">
    <template #actions>
      <span v-if="status" class="tag dot" :class="status.bridge.ok ? 'ok' : 'warn'" :title="status.bridge.error ?? status.bridge_url">
        设备桥{{ status.bridge.ok ? `已连通 · ${status.bridge.connections ?? 0} 个连接` : '连不上' }}
      </span>
      <button class="btn" type="button" :disabled="busy" @click="reset"><AppIcon name="refresh" :size="16" /><span>新对话</span></button>
    </template>
  </PageHeader>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <section class="card">
    <div class="form-grid">
      <label class="field">
        <span class="field-label">智能体</span>
        <select v-model="agentId" class="select" :disabled="busy" @change="entries = []">
          <option v-for="item in agents" :key="item.id" :value="item.id">{{ item.name }}{{ item.runtime === 'agent' ? '' : '(引擎旧路径)' }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">借用设备</span>
        <select v-model="deviceMac" class="select" :disabled="busy">
          <option value="">不借用(引擎里的工具不可用)</option>
          <option v-for="d in devices" :key="d.mac" :value="d.mac">{{ d.alias || d.mac }}</option>
        </select>
      </label>
    </div>
    <div v-if="agent && agent.runtime !== 'agent'" class="callout warn" style="margin: 12px 0 0">
      <AppIcon name="alert" :size="18" />
      <div class="callout-body">
        这个智能体还在用引擎旧路径,设备上不会走这里的循环。试聊照样按控制塔运行时跑;要让设备也用上,在
        <RouterLink :to="'/agents'">智能体</RouterLink> 页把「大脑」切到控制塔。
      </div>
    </div>
  </section>

  <section class="card">
    <div ref="scroller" class="chat" style="max-height: 60vh; overflow-y: auto; padding-right: 4px">
      <EmptyState v-if="entries.length === 0" title="说点什么试试" description="也可以点下面的例句。">
        <div class="chips" style="justify-content: center">
          <button v-for="preset in PRESETS" :key="preset" class="btn btn-sm" type="button" :disabled="busy || !agentId" @click="send(preset)">{{ preset }}</button>
        </div>
      </EmptyState>
      <template v-for="entry in entries" :key="entry.id">
        <template v-if="entry.role === 'bot'">
          <div v-for="(step, i) in entry.steps" :key="`${entry.id}-s${i}`" class="tool-line" :title="step.content">
            <AppIcon name="zap" :size="13" />
            <span>
              {{ step.name }}{{ shortJson(step.arguments) }}
              <template v-if="step.content !== undefined"> → {{ step.ok ? '' : '失败:' }}{{ step.content.slice(0, 80) }}{{ step.content.length > 80 ? '…' : '' }} · {{ step.ms }}ms</template>
              <template v-else> …</template>
            </span>
          </div>
          <div v-for="(msg, i) in entry.device" :key="`${entry.id}-d${i}`" class="tool-line" :title="JSON.stringify(msg)">
            <AppIcon name="device" :size="13" /><span>{{ deviceText(msg) }}</span>
          </div>
          <div v-for="(item, i) in entry.media" :key="`${entry.id}-m${i}`" class="tool-line">
            <AppIcon name="music" :size="13" /><span>播放:{{ item.title || item.url }}</span>
          </div>
        </template>
        <div class="bubble-row" :class="entry.role">
          <span v-if="entry.role === 'user'" class="avatar tone-sky"><AppIcon name="user" :size="16" /></span>
          <span v-else class="mascot-tile" style="width: 32px; height: 32px; border-radius: 9px; box-shadow: none; border-width: 1.5px">
            <PixelMascot :size="22" :blink="entry.pending === true" />
          </span>
          <div class="bubble-col">
            <div class="bubble">{{ entry.text || (entry.pending ? '…' : '(没有说话)') }}</div>
            <span v-if="entry.summary" class="bubble-time">
              {{ entry.summary.steps }} 步 · {{ entry.summary.tool_calls }} 次工具 · {{ (entry.summary.ms / 1000).toFixed(1) }} 秒
              <template v-if="entry.summary.error"> · {{ entry.summary.error }}</template>
            </span>
          </div>
        </div>
      </template>
    </div>
    <form style="display: flex; gap: 8px; margin-top: 14px; align-items: center" @submit.prevent="send()">
      <input v-model="input" class="input" style="flex: 1; min-width: 0" type="text" maxlength="2000" placeholder="像对着设备说话一样打字,回车发送" :disabled="!agentId" />
      <button v-if="busy" class="btn btn-danger" type="button" @click="stop"><AppIcon name="x" :size="16" /><span>打断</span></button>
      <button v-else class="btn btn-primary" type="submit" :disabled="!input.trim() || !agentId"><AppIcon name="arrowRight" :size="16" /><span>发送</span></button>
    </form>
  </section>
</template>
