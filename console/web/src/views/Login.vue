<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type SetupStatus } from '../api';
import AppIcon from '../components/AppIcon.vue';
import PixelMascot from '../components/PixelMascot.vue';

const router = useRouter();
const route = useRoute();

const status = ref<SetupStatus | null>(null);
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const reveal = ref(false);
const error = ref('');
const busy = ref(false);

// 只接受站内路径,避免登录后被带去别的网站
function nextPath() {
  const next = route.query.next;
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && next !== '/login'
    ? next
    : '/devices';
}

onMounted(async () => {
  try {
    const current = await api.get<SetupStatus>('/setup/status');
    // proxy 模式下能打开页面就说明已经过了面板的鉴权
    if (current.mode === 'proxy' || current.authenticated) {
      await router.replace(nextPath());
      return;
    }
    status.value = current;
  } catch {
    // 拿不到状态就按已初始化处理,显示登录表单而不是初始化表单
    status.value = { mode: 'local', initialized: true, authenticated: false };
  }
});

async function submit() {
  if (!status.value || busy.value) return;
  error.value = '';
  if (!status.value.initialized) {
    if (password.value.length < 8) {
      error.value = '密码至少 8 位。';
      return;
    }
    if (password.value !== confirmPassword.value) {
      error.value = '两次输入的密码不一致。';
      return;
    }
  }
  busy.value = true;
  try {
    await api.post(status.value.initialized ? '/login' : '/setup', {
      username: username.value.trim(),
      password: password.value,
    });
    await router.replace(nextPath());
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="center-screen">
    <div v-if="!status" class="page-loading">
      <span class="mascot-tile" style="width: 60px; height: 60px"><PixelMascot :size="40" /></span>
      <span>正在检查登录状态…</span>
    </div>

    <form v-else class="card login-card" @submit.prevent="submit">
      <span class="mascot-tile" style="width: 60px; height: 60px"><PixelMascot :size="40" /></span>
      <h1>{{ status.initialized ? '登录小单控制台' : '设置管理员账号' }}</h1>
      <p class="sub">
        {{ status.initialized ? '这个控制台只有一个管理员账号。' : '第一次使用,请设置管理员账号。之后不再开放注册。' }}
      </p>

      <div v-if="error" class="callout danger" role="alert">
        <AppIcon name="alert" :size="18" /><div class="callout-body">{{ error }}</div>
      </div>

      <div class="stack">
        <label class="field">
          <span class="field-label">用户名</span>
          <input v-model="username" class="input" type="text" autocomplete="username" required autofocus />
        </label>
        <label class="field">
          <span class="field-label">密码</span>
          <span class="input-affix">
            <input
              v-model="password" class="input" :type="reveal ? 'text' : 'password'" required
              :autocomplete="status.initialized ? 'current-password' : 'new-password'"
            />
            <button
              type="button" class="btn btn-ghost btn-sm btn-icon affix" :aria-label="reveal ? '隐藏密码' : '显示密码'"
              @click="reveal = !reveal"
            >
              <AppIcon :name="reveal ? 'eyeOff' : 'eye'" :size="16" />
            </button>
          </span>
        </label>
        <label v-if="!status.initialized" class="field">
          <span class="field-label">确认密码</span>
          <input v-model="confirmPassword" class="input" :type="reveal ? 'text' : 'password'" autocomplete="new-password" required />
          <span class="field-hint">至少 8 位。忘记了可以在服务器上用 <code>cli set-password</code> 重设。</span>
        </label>
        <button class="btn btn-primary" type="submit" :aria-busy="busy" style="width: 100%; height: 42px">
          <span>{{ status.initialized ? '登录' : '创建并登录' }}</span>
        </button>
      </div>
    </form>
  </div>
</template>
