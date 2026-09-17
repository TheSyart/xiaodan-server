<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type Device, type DeviceList } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, formatTime, toast, toastError } from '../ui';

// 画廊:智能体画过的画。左边是原图,右边是发到设备屏幕上的 128×128、16 色像素画。

interface ImageItem {
  id: number;
  mac: string | null;
  alias: string | null;
  agent_name: string | null;
  prompt: string;
  provider: string;
  model: string;
  created_at: string;
}

const items = ref<ImageItem[]>([]);
const devices = ref<Device[]>([]);
const loading = ref(true);
const loadError = ref('');
const showPixel = ref<Record<number, boolean>>({});

async function load() {
  loadError.value = '';
  try {
    const [i, d] = await Promise.all([api.get<{ items: ImageItem[] }>('/images'), api.get<DeviceList>('/devices')]);
    items.value = i.items;
    devices.value = d.items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function send(item: ImageItem, mac: string) {
  try {
    await api.post(`/images/${item.id}/send`, { mac });
    toast('已发到设备屏幕');
  } catch (e) {
    toastError(e);
  }
}

async function remove(item: ImageItem) {
  if (!(await confirmDialog({ title: '删除这幅画?', message: item.prompt, confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/images/${item.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <PageHeader title="画廊" description="智能体画过的画。点图片可以在原图与设备上的像素画之间切换。" />

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>
  <div v-if="loading" class="card"><SkeletonRows :rows="3" /></div>
  <div v-else-if="items.length === 0" class="card">
    <EmptyState title="还没有画" description="给智能体打开「画画」工具并在「模型」页添加千问文生图模型,然后在设备上说「画一只戴帽子的小猫」。" />
  </div>
  <div v-else class="grid-cards">
    <article v-for="item in items" :key="item.id" class="card" style="padding: 12px">
      <button type="button" style="all: unset; cursor: pointer; display: block; width: 100%" :title="showPixel[item.id] ? '看原图' : '看设备上的像素画'" @click="showPixel[item.id] = !showPixel[item.id]">
        <img
          :src="showPixel[item.id] ? `/api/images/${item.id}/pixel` : `/api/images/${item.id}/original`"
          :alt="item.prompt" loading="lazy"
          style="width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: var(--paper-2)"
          :style="showPixel[item.id] ? 'image-rendering: pixelated' : ''"
        />
      </button>
      <div class="cell-main" style="margin-top: 10px">{{ item.prompt }}</div>
      <div class="cell-sub">{{ formatTime(item.created_at) }} · {{ item.alias || item.mac || '试聊' }}<template v-if="item.agent_name"> · {{ item.agent_name }}</template></div>
      <div class="cell-sub small">{{ item.provider }}{{ item.model ? ` · ${item.model}` : '' }}</div>
      <div class="row" style="gap: 4px; margin-top: 8px">
        <select v-if="devices.length" class="select" style="height: 30px; flex: 1" @change="($event.target as HTMLSelectElement).value && send(item, ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
          <option value="">发到设备…</option>
          <option v-for="d in devices" :key="d.mac" :value="d.mac">{{ d.alias || d.mac }}</option>
        </select>
        <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(item)"><AppIcon name="trash" :size="14" /></button>
      </div>
    </article>
  </div>
</template>
