<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type SetupStatus } from './api';
import AppIcon from './components/AppIcon.vue';
import ConfirmHost from './components/ConfirmHost.vue';
import PixelMascot from './components/PixelMascot.vue';
import ToastHost from './components/ToastHost.vue';
import type { IconName } from './icons';
import { applyTheme, effectiveTheme, toastError, type Theme } from './ui';

const route = useRoute();
const router = useRouter();

const ready = ref(false);
const authed = ref(false);
const statusError = ref('');
// 'proxy' = 鉴权由前面的运维面板负责,控制台没有自己的账号与登录页。
const mode = ref<'proxy' | 'local'>('proxy');
const theme = ref<Theme>(effectiveTheme());

async function check() {
  try {
    const status = await api.get<SetupStatus>('/setup/status');
    mode.value = status.mode;
    authed.value = status.authenticated;
    statusError.value = '';
  } catch (e) {
    statusError.value = (e as Error).message;
  } finally {
    ready.value = true;
  }
  await router.isReady();
  if (!statusError.value && !authed.value && mode.value === 'local' && route.path !== '/login') {
    await router.replace({ path: '/login', query: { next: route.fullPath } });
  }
}

function retry() {
  ready.value = false;
  void check();
}

// 登录成功离开登录页时重新确认一次;其余导航不必每次都去问
router.afterEach((to, from) => {
  if (from.path === '/login' && to.path !== '/login') void check();
});

// 任何接口回 401(会话过期)都带回登录页
function onUnauthorized() {
  if (mode.value !== 'local' || route.path === '/login') return;
  authed.value = false;
  void router.replace({ path: '/login', query: { next: route.fullPath } });
}

onMounted(() => {
  window.addEventListener('xiaodan:unauthorized', onUnauthorized);
  void check();
});
onBeforeUnmount(() => window.removeEventListener('xiaodan:unauthorized', onUnauthorized));

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  applyTheme(theme.value);
}

async function logout() {
  try {
    await api.post('/logout');
  } catch (e) {
    toastError(e);
    return;
  }
  authed.value = false;
  await router.replace('/login');
}

const NAV_GROUPS: { title: string; items: { path: string; label: string; icon: IconName }[] }[] = [
  {
    title: '设备与角色',
    items: [
      { path: '/devices', label: '设备', icon: 'device' },
      { path: '/memory', label: '记忆', icon: 'brain' },
      { path: '/agents', label: '智能体', icon: 'bot' },
      { path: '/voices', label: '音色', icon: 'volume' },
      { path: '/playground', label: '试聊', icon: 'message' },
    ],
  },
  {
    // 学分:一台设备一个孩子。作业规则 → 每天布置 → 录入算分 → 兑换奖励;开放接口给 App 用
    title: '学分',
    items: [
      { path: '/credits/tasks', label: '今日作业', icon: 'calendar' },
      { path: '/credits/rewards', label: '兑换奖励', icon: 'gift' },
      { path: '/credits/rules', label: '作业规则', icon: 'sliders' },
      { path: '/credits/ledger', label: '流水', icon: 'clock' },
      { path: '/credits/stats', label: '统计', icon: 'chart' },
      { path: '/credits/api', label: '开放接口', icon: 'key' },
    ],
  },
  {
    // 能力分三类:工具(服务端代码)、技能(做法说明)、MCP(外部工具服务器)。各自页面增删改查,智能体页只决定开不开
    title: '能力',
    items: [
      { path: '/tools', label: '工具', icon: 'zap' },
      { path: '/skills', label: '技能', icon: 'sparkles' },
      { path: '/mcp', label: 'MCP', icon: 'link' },
    ],
  },
  {
    title: '内容',
    items: [
      { path: '/content', label: '内容库', icon: 'music' },
      { path: '/gallery', label: '画廊', icon: 'star' },
      { path: '/reminders', label: '提醒', icon: 'clock' },
    ],
  },
  {
    title: '系统',
    items: [
      { path: '/models', label: '模型', icon: 'layers' },
      { path: '/words', label: '读音替换', icon: 'replace' },
      { path: '/settings', label: '设置', icon: 'sliders' },
    ],
  },
];
</script>

<template>
  <div v-if="!ready" class="center-screen">
    <div class="page-loading">
      <span class="mascot-tile" style="width: 60px; height: 60px"><PixelMascot :size="40" /></span>
      <span>正在打开控制台…</span>
    </div>
  </div>

  <div v-else-if="statusError" class="center-screen">
    <div class="card login-card">
      <span class="mascot-tile" style="width: 60px; height: 60px"><PixelMascot :size="40" :blink="false" /></span>
      <h1>连不上控制台</h1>
      <p class="sub">{{ statusError }}</p>
      <button class="btn btn-primary" type="button" style="width: 100%" @click="retry">
        <AppIcon name="refresh" :size="16" /><span>重试</span>
      </button>
    </div>
  </div>

  <router-view v-else-if="!authed" />

  <div v-else class="shell">
    <aside class="sidebar">
      <router-link to="/devices" class="brand" aria-label="小单控制台">
        <span class="mascot-tile" style="width: 44px; height: 44px"><PixelMascot :size="32" /></span>
        <span class="brand-text">
          <span class="brand-name">小单控制台</span><br />
          <span class="brand-sub">Xiaodan Console</span>
        </span>
      </router-link>
      <nav class="nav" aria-label="主导航">
        <template v-for="group in NAV_GROUPS" :key="group.title">
          <span class="nav-group">{{ group.title }}</span>
          <router-link
            v-for="item in group.items" :key="item.path" :to="item.path" class="nav-link"
            :class="{ active: route.path.startsWith(item.path) }"
            :aria-current="route.path.startsWith(item.path) ? 'page' : undefined"
          >
            <AppIcon :name="item.icon" :size="18" />
            <span class="nav-label">{{ item.label }}</span>
          </router-link>
        </template>
      </nav>
      <div class="sidebar-foot">
        <span class="auth-note">{{ mode === 'local' ? '本地管理员' : '由运维面板统一鉴权' }}</span>
        <button
          class="btn btn-ghost btn-sm btn-icon" type="button" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
          :aria-label="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme"
        >
          <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
        <button
          v-if="mode === 'local'" class="btn btn-ghost btn-sm btn-icon" type="button" title="退出登录"
          aria-label="退出登录" @click="logout"
        >
          <AppIcon name="logout" :size="16" />
        </button>
      </div>
    </aside>
    <main class="main">
      <div class="content"><router-view /></div>
    </main>
  </div>

  <ToastHost />
  <ConfirmHost />
</template>
