<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type Setting } from '../api';

const items = ref<Setting[]>([]);
const secret = ref('');
const showSecret = ref(false);
const error = ref('');
const notice = ref('');

async function load() {
  try {
    const data = await api.get<{ items: Setting[]; secret: string }>('/settings');
    items.value = data.items;
    secret.value = data.secret;
  } catch (e) { error.value = (e as Error).message; }
}
onMounted(load);

async function save() {
  error.value = '';
  notice.value = '';
  const payload: Record<string, string> = {};
  for (const item of items.value) payload[item.key] = item.value;
  try {
    await api.put('/settings', payload);
    notice.value = '已保存。服务端会在下次拉取配置时生效,必要时重启它。';
  } catch (e) { error.value = (e as Error).message; }
}

async function rotate() {
  if (!confirm('轮换密钥后,服务端会立刻鉴权失败,必须同步修改它的 .config.yaml 并重启。确定继续吗?')) return;
  try {
    secret.value = (await api.post<{ secret: string }>('/settings/secret/rotate')).secret;
    showSecret.value = true;
    notice.value = '密钥已轮换。请立刻把新值写进服务端的 data/.config.yaml 的 manager-api.secret,然后重启服务端。';
  } catch (e) { error.value = (e as Error).message; }
}

async function copySecret() {
  try {
    await navigator.clipboard.writeText(secret.value);
    notice.value = '密钥已复制到剪贴板。';
  } catch {
    showSecret.value = true;
    notice.value = '浏览器不允许自动复制,请手动选中上面的密钥。';
  }
}

const isBoolean = (item: Setting) => item.value_type === 'boolean';
</script>

<template>
  <div class="page-head">
    <h1>设置</h1>
    <p>服务端接入地址与对话行为。</p>
  </div>

  <div v-if="error" class="notice error">{{ error }}</div>
  <div v-if="notice" class="notice info">{{ notice }}</div>

  <div class="card">
    <h2>服务端接入密钥</h2>
    <p>小智服务端用它调用本控制台的接口,对应它配置里的 <span class="code">manager-api.secret</span>。</p>
    <div class="btn-row">
      <span class="code" style="flex: 1; overflow-x: auto">
        {{ showSecret ? secret : '•'.repeat(Math.min(secret.length, 32)) }}
      </span>
      <button @click="showSecret = !showSecret">{{ showSecret ? '隐藏' : '显示' }}</button>
      <button @click="copySecret">复制</button>
      <button class="danger" @click="rotate">轮换</button>
    </div>
  </div>

  <div class="card">
    <h2>参数</h2>
    <label v-for="item in items" :key="item.key">
      <span>{{ item.label || item.key }}</span>
      <select v-if="isBoolean(item)" v-model="item.value">
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
      <input
        v-else v-model="item.value"
        :type="item.value_type === 'number' ? 'number' : 'text'"
      />
      <small><span class="code">{{ item.key }}</span></small>
    </label>
    <div class="btn-row">
      <button class="primary" @click="save">保存</button>
    </div>
  </div>
</template>
