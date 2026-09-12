<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type SetupStatus } from './api';

const route = useRoute();
const router = useRouter();
const ready = ref(false);
const authed = ref(false);

async function check() {
  try {
    const status = await api.get<SetupStatus>('/setup/status');
    authed.value = status.authenticated;
    if (!status.authenticated && route.path !== '/login') {
      router.replace({ path: '/login', query: { next: route.fullPath } });
    }
  } catch {
    authed.value = false;
  } finally {
    ready.value = true;
  }
}

onMounted(check);

// 任何页面拿到 401 都会跳登录,这里统一处理一次即可
router.afterEach(() => { void check(); });

async function logout() {
  await api.post('/logout');
  authed.value = false;
  router.replace('/login');
}

const nav = [
  { path: '/devices', label: '设备' },
  { path: '/agents', label: '智能体' },
  { path: '/models', label: '模型' },
  { path: '/chats', label: '对话记录' },
  { path: '/settings', label: '设置' },
];
</script>

<template>
  <div v-if="!ready" class="center-screen">正在加载…</div>
  <router-view v-else-if="!authed" />
  <div v-else class="layout">
    <aside class="sidebar">
      <div class="brand">
        小单控制台
        <small>Xiaodan Console</small>
      </div>
      <nav class="nav">
        <router-link
          v-for="item in nav" :key="item.path" :to="item.path"
          :class="{ active: route.path === item.path }"
        >{{ item.label }}</router-link>
      </nav>
      <div class="sidebar-foot">
        <button class="link" @click="logout">退出登录</button>
      </div>
    </aside>
    <main class="main"><router-view /></main>
  </div>
</template>
