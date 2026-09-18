<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { api, type Setting } from '../api';
import AppIcon from '../components/AppIcon.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import ServiceProviders from '../components/ServiceProviders.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import type { IconName } from '../icons';
import { confirmDialog, copyText, toast, toastError } from '../ui';

const items = ref<Setting[]>([]);
const original = ref<Record<string, string>>({});
const secret = ref('');
const showSecret = ref(false);
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);
const rotating = ref(false);

async function load() {
  loadError.value = '';
  try {
    const data = await api.get<{ items: Setting[]; secret: string }>('/settings');
    items.value = data.items;
    original.value = Object.fromEntries(data.items.map((item) => [item.key, item.value]));
    secret.value = data.secret;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

interface Meta {
  hint?: string;
  placeholder?: string;
  long?: boolean;
  options?: string[];
}
const META: Record<string, Meta> = {
  'server.websocket': {
    hint: '设备连接对话服务的地址,必须以 wss:// 开头。控制台开机询问时把它告诉已绑定的设备。',
    placeholder: 'wss://example.com/xiaozhi/v1/',
  },
  'server.auth.enabled': { hint: '小单固件不携带设备令牌,开启后它会连不上,保持关闭。' },
  'tool_call_timeout': { hint: '查天气这类工具最长等多久,超时后模型会告诉用户稍后再试。' },
  'system_error_response': { long: true },
  'end_prompt.prompt': { long: true },
  'exit_commands': { hint: '多个指令用分号分隔。' },
  'log.log_level': { options: ['DEBUG', 'INFO', 'WARNING', 'ERROR'] },
};

const GROUPS: { title: string; icon: IconName; description: string; keys: string[] }[] = [
  {
    title: '设备接入',
    icon: 'device',
    description: '设备与对话服务怎样找到彼此。',
    keys: ['server.websocket', 'server.ota', 'server.auth.enabled'],
  },
  {
    title: '对话行为',
    icon: 'message',
    description: '连接什么时候断开、怎样道别、出错时说什么。',
    keys: ['close_connection_no_voice_time', 'exit_commands', 'end_prompt.enable', 'end_prompt.prompt',
      'system_error_response', 'device_max_output_size', 'delete_audio'],
  },
  { title: '超时', icon: 'clock', description: '', keys: ['tts_timeout', 'tool_call_timeout'] },
  { title: '日志', icon: 'news', description: '', keys: ['log.log_level'] },
];

const groups = computed(() => {
  const byKey = new Map(items.value.map((item) => [item.key, item]));
  const used = new Set<string>();
  const result = GROUPS.map((group) => {
    const groupItems = group.keys.map((key) => byKey.get(key)).filter((item): item is Setting => !!item);
    groupItems.forEach((item) => used.add(item.key));
    return { ...group, items: groupItems };
  });
  const rest = items.value.filter((item) => !used.has(item.key));
  if (rest.length) result.push({ title: '其他', icon: 'sliders', description: '', keys: [], items: rest });
  return result.filter((group) => group.items.length > 0);
});

const dirty = computed(() => items.value.some((item) => item.value !== original.value[item.key]));
const wsError = computed(() => {
  const ws = items.value.find((item) => item.key === 'server.websocket')?.value.trim() ?? '';
  return ws && !/^wss:\/\/\S+$/u.test(ws) ? '必须是以 wss:// 开头的完整地址,设备不接受 ws://。' : '';
});

const fieldId = (item: Setting) => `setting-${item.key.replaceAll('.', '-')}`;
const isLong = (item: Setting) => META[item.key]?.long === true;

async function save() {
  if (saving.value) return;
  if (wsError.value) {
    toast(wsError.value, 'error');
    return;
  }
  saving.value = true;
  try {
    await api.put('/settings', Object.fromEntries(items.value.map((item) => [item.key, item.value])));
    original.value = Object.fromEntries(items.value.map((item) => [item.key, item.value]));
    toast('已保存。引擎下次拉取配置时生效,必要时重启它。');
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

function discard() {
  for (const item of items.value) item.value = original.value[item.key] ?? item.value;
}

onBeforeRouteLeave(async () =>
  dirty.value
    ? confirmDialog({ title: '放弃未保存的修改?', message: '离开后这些修改不会保存。', confirmText: '放弃修改', danger: true })
    : true,
);

async function rotate() {
  const ok = await confirmDialog({
    title: '轮换引擎接入密钥?',
    message: '轮换后引擎会立刻鉴权失败,所有设备都无法对话,直到你把新密钥写进引擎的 .config.yaml 并重启它。',
    confirmText: '轮换密钥',
    danger: true,
  });
  if (!ok) return;
  rotating.value = true;
  try {
    secret.value = (await api.post<{ secret: string }>('/settings/secret/rotate')).secret;
    showSecret.value = true;
    toast('密钥已轮换。请立刻把新值写进引擎 data/.config.yaml 的 manager-api.secret,然后重启引擎。', 'warn', 15000);
  } catch (e) {
    toastError(e);
  } finally {
    rotating.value = false;
  }
}
</script>

<template>
  <PageHeader title="设置" description="引擎接入密钥、设备连接地址与对话行为。" />

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <section class="card">
    <div class="card-head">
      <div>
        <h2><AppIcon name="key" :size="18" />引擎接入密钥</h2>
        <p>引擎用它调用本控制台的接口,对应引擎配置里的 <code>manager-api.secret</code>。不要发给别人。</p>
      </div>
    </div>
    <SkeletonRows v-if="loading" :rows="1" />
    <div v-else class="secret-box">
      <span class="secret-value">{{ showSecret ? secret : '•'.repeat(24) }}</span>
      <button
        class="btn btn-ghost btn-sm btn-icon" type="button" :aria-label="showSecret ? '隐藏密钥' : '显示密钥'"
        :title="showSecret ? '隐藏' : '显示'" @click="showSecret = !showSecret"
      >
        <AppIcon :name="showSecret ? 'eyeOff' : 'eye'" :size="16" />
      </button>
      <button class="btn btn-sm" type="button" @click="copyText(secret, '密钥')"><AppIcon name="copy" :size="14" /><span>复制</span></button>
      <button class="btn btn-sm btn-danger" type="button" :aria-busy="rotating" @click="rotate">
        <AppIcon name="refresh" :size="14" /><span>轮换</span>
      </button>
    </div>
  </section>

  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <section v-for="group in groups" v-else :key="group.title" class="card">
    <div class="card-head">
      <div>
        <h2><AppIcon :name="group.icon" :size="18" />{{ group.title }}</h2>
        <p v-if="group.description">{{ group.description }}</p>
      </div>
    </div>
    <div class="form-grid">
      <div
        v-for="item in group.items" :key="item.key" class="field"
        :class="{ 'span-all': isLong(item) || item.key === 'server.websocket' || item.key === 'server.ota' }"
      >
        <template v-if="item.value_type === 'boolean'">
          <span class="field-label">{{ item.label || item.key }}</span>
          <SwitchToggle
            :model-value="item.value === 'true'" :label="item.value === 'true' ? '开启' : '关闭'"
            @update:model-value="item.value = $event ? 'true' : 'false'"
          />
        </template>
        <template v-else>
          <label class="field-label" :for="fieldId(item)">{{ item.label || item.key }}</label>
          <select v-if="META[item.key]?.options" :id="fieldId(item)" v-model="item.value" class="select">
            <option v-for="option in META[item.key]?.options" :key="option" :value="option">{{ option }}</option>
          </select>
          <textarea v-else-if="isLong(item)" :id="fieldId(item)" v-model="item.value" class="textarea" rows="3"></textarea>
          <input
            v-else :id="fieldId(item)" v-model="item.value" class="input"
            :class="{ invalid: item.key === 'server.websocket' && wsError, mono: item.key.startsWith('server.') }"
            :type="item.value_type === 'number' ? 'number' : 'text'" :placeholder="META[item.key]?.placeholder"
          />
        </template>
        <span v-if="item.key === 'server.websocket' && wsError" class="field-error">{{ wsError }}</span>
        <span v-else-if="META[item.key]?.hint" class="field-hint">{{ META[item.key]?.hint }}</span>
        <span class="field-hint"><code>{{ item.key }}</code></span>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <div>
        <h2><AppIcon name="globe" :size="18" />定位服务</h2>
        <p>
          设备扫到周围的 Wi-Fi 热点后,由定位服务换算成坐标(市区通常几十米)。没配也能用:退回按公网 IP 的城市级定位。
          定位默认是关的,要在「设备」页逐台打开。
        </p>
      </div>
    </div>
    <ServiceProviders
      kind="locate"
      hint="定位服务 · 高德「智能硬件定位」需要在高德开放平台申请 Web 服务 Key。"
      empty-text="还没有配置定位服务(只能按 IP 定到城市)"
    />
  </section>

  <div v-if="dirty" class="action-bar">
    <span class="hint">有未保存的修改。引擎下次拉取配置时生效。</span>
    <button class="btn" type="button" @click="discard">放弃</button>
    <button class="btn btn-primary" type="button" :aria-busy="saving" :disabled="!!wsError" @click="save">
      <AppIcon name="check" :size="16" /><span>保存</span>
    </button>
  </div>
</template>
