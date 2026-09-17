<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, postEventStream, type Agent, type Device, type DeviceList, type Model, type RuntimeStatus } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import PixelMascot from '../components/PixelMascot.vue';
import { toast, toastError } from '../ui';
import { inlineTagsOf, stripInlineTags } from '../voice-profile';

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
  images?: string[];
  summary?: { steps: number; tool_calls: number; ms: number; error: string | null };
  pending?: boolean;
}

const agents = ref<Agent[]>([]);
const models = ref<Model[]>([]);
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
    const [a, d, s, m] = await Promise.all([
      api.get<{ items: Agent[] }>('/agents'),
      api.get<DeviceList>('/devices'),
      api.get<RuntimeStatus>('/agent-runtime/status'),
      api.get<{ items: Model[] }>('/models'),
    ]);
    agents.value = a.items;
    models.value = m.items;
    devices.value = d.items;
    status.value = s;
    if (!agentId.value) agentId.value = (a.items.find((x) => x.is_default === 1) ?? a.items[0])?.id ?? '';
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}
onMounted(load);
onBeforeUnmount(() => controller?.abort());

const agent = computed(() => agents.value.find((a) => a.id === agentId.value));
/** 智能体的对话模型能不能看图 */
const vision = computed(() => {
  const model = models.value.find((m) => m.id === agent.value?.llm_model_id);
  try {
    const config = JSON.parse(model?.config_json ?? '{}') as { vision?: unknown };
    return config.vision === true || config.vision === 'true';
  } catch {
    return false;
  }
});

// ---- 附图:浏览器里缩到 1024 像素以内、转成 JPEG,最多 3 张 ----
const attachments = ref<string[]>([]);
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('读不出这张图片'));
      img.src = url;
    });
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function attach(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  for (const file of files) {
    if (attachments.value.length >= 3) {
      toast('一次最多附 3 张图。', 'warn');
      break;
    }
    try {
      attachments.value = [...attachments.value, await shrink(file)];
    } catch (e) {
      toastError(e);
    }
  }
}
const PRESETS = ['今天几号?', '北京明天天气怎么样,要下雨就把音量调小一点', '声音大一点', '给我讲个笑话'];

async function scrollDown() {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
}

async function send(text = input.value) {
  const message = text.trim() || (attachments.value.length ? '看看这张图' : '');
  if (!message || busy.value || !agentId.value) return;
  input.value = '';
  const images = attachments.value;
  attachments.value = [];
  entries.value.push({ id: ++seq, role: 'user', text: message, steps: [], device: [], media: [], images });
  const bot: Entry = { id: ++seq, role: 'bot', text: '', steps: [], device: [], media: [], pending: true };
  entries.value.push(bot);
  const live = entries.value[entries.value.length - 1]!;
  busy.value = true;
  controller = new AbortController();
  void scrollDown();
  try {
    await postEventStream('/agent-runtime/try', {
      agent_id: agentId.value, message, conversation_id: conversationId.value, ...(deviceMac.value ? { device_mac: deviceMac.value } : {}),
      ...(images.length ? { images } : {}),
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
          live.media.push({
            title: `${String(event['title'] ?? '')}${Array.isArray(event['cues']) ? `(正文进度 ${event['cues'].length} 段)` : ''}`,
            url: String(event['url'] ?? ''),
          });
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

const ACT_LABELS: Record<string, string> = {
  paint: '画画', story: '讲故事', music: '放音乐', learn: '学单词', weather: '查天气', calendar: '看日历',
  search: '查资料', remind: '提醒', memory: '记事', role: '换角色', think: '想一想',
};
const deviceText = (msg: Record<string, unknown>) => {
  if (msg['type'] === 'stt') return `提示:${String(msg['text'] ?? '')}`;
  if (msg['type'] === 'llm') return `表情:${String(msg['text'] ?? '')} ${String(msg['emotion'] ?? '')}`;
  if (msg['cmd'] === 'hint') {
    const act = typeof msg['act'] === 'string' ? ` · 动画:${ACT_LABELS[msg['act']] ?? msg['act']}` : '';
    return msg['text'] ? `提示:${String(msg['text'])}${act}` : '收起提示';
  }
  if (msg['cmd'] === 'media') {
    return `${msg['k'] === 'music' ? '音乐' : '故事'}卡片:《${String(msg['t'] ?? '')}》${msg['s'] ? ` ${String(msg['s'])}` : ''}${msg['a'] ? ` · ${String(msg['a'])}` : ''}`;
  }
  if (msg['type'] === 'xiaodan_deck') {
    return `单词卡 ${Number(msg['i']) + 1}/${String(msg['n'])}:${String(msg['w'] ?? '')} ${String(msg['m'] ?? '')}${msg['say'] ? ` · 读「${String(msg['say'])}」` : ''}`;
  }
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
          <option v-for="item in agents" :key="item.id" :value="item.id">{{ item.name }}</option>
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
    <p v-if="agent" class="field-hint" style="margin: 12px 0 0">
      {{ vision ? '这个智能体的对话模型能看图,可以附图片。' : '这个智能体的对话模型看不了图;要试看图,先在' }}
      <template v-if="!vision"><RouterLink to="/models">模型</RouterLink> 页给对话模型打开「支持看图」。</template>
    </p>
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
            <div class="bubble">
              {{ stripInlineTags(entry.text) || (entry.pending ? '…' : '(没有说话)') }}
              <div v-if="entry.images?.length" class="chips" style="margin-top: 6px">
                <img v-for="(src, i) in entry.images" :key="i" :src="src" alt="附图" style="width: 72px; height: 72px; object-fit: cover; border-radius: 8px" />
              </div>
            </div>
            <div v-if="entry.role === 'bot' && inlineTagsOf(entry.text).length" class="chips">
              <span v-for="tag in inlineTagsOf(entry.text)" :key="tag" class="tag violet" title="情感标签:念的时候用,字幕里不显示">语气 {{ tag }}</span>
            </div>
            <span v-if="entry.summary" class="bubble-time">
              {{ entry.summary.steps }} 步 · {{ entry.summary.tool_calls }} 次工具 · {{ (entry.summary.ms / 1000).toFixed(1) }} 秒
              <template v-if="entry.summary.error"> · {{ entry.summary.error }}</template>
            </span>
          </div>
        </div>
      </template>
    </div>
    <div v-if="attachments.length" class="chips" style="margin-top: 12px">
      <span v-for="(src, i) in attachments" :key="i" style="position: relative">
        <img :src="src" alt="待发送的图片" style="width: 56px; height: 56px; object-fit: cover; border-radius: 8px" />
        <button class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="移除这张图" style="position: absolute; top: -8px; right: -8px"
          @click="attachments = attachments.filter((_, j) => j !== i)"><AppIcon name="x" :size="12" /></button>
      </span>
    </div>
    <form style="display: flex; gap: 8px; margin-top: 14px; align-items: center" @submit.prevent="send()">
      <label class="btn btn-ghost btn-icon" :class="{ disabled: !vision }" :title="vision ? '附图片' : '对话模型看不了图'">
        <AppIcon name="plus" :size="16" />
        <input type="file" accept="image/png,image/jpeg,image/webp" multiple class="visually-hidden" :disabled="!vision || busy" @change="attach" />
      </label>
      <input v-model="input" class="input" style="flex: 1; min-width: 0" type="text" maxlength="2000" placeholder="像对着设备说话一样打字,回车发送" :disabled="!agentId" />
      <button v-if="busy" class="btn btn-danger" type="button" @click="stop"><AppIcon name="x" :size="16" /><span>打断</span></button>
      <button v-else class="btn btn-primary" type="submit" :disabled="(!input.trim() && !attachments.length) || !agentId"><AppIcon name="arrowRight" :size="16" /><span>发送</span></button>
    </form>
  </section>
</template>
