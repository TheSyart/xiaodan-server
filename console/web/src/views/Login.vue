<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type SetupStatus } from '../api';

const router = useRouter();
const initialized = ref(true);
const username = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const busy = ref(false);

const proxyMode = ref(false);

onMounted(async () => {
  try {
    const status = await api.get<SetupStatus>('/setup/status');
    proxyMode.value = status.mode === 'proxy';
    initialized.value = status.initialized;
    // proxy 模式下能走到这里就说明已经过了面板的鉴权,直接进主界面
    if (status.mode === 'proxy' || status.authenticated) router.replace('/devices');
  } catch {
    /* 拿不到状态就按已初始化处理,让用户看到登录表单而不是初始化表单 */
  }
});

async function submit() {
  error.value = '';
  if (!initialized.value) {
    if (password.value.length < 8) { error.value = '密码至少 8 位'; return; }
    if (password.value !== confirm.value) { error.value = '两次输入的密码不一致'; return; }
  }
  busy.value = true;
  try {
    const path = initialized.value ? '/login' : '/setup';
    await api.post(path, { username: username.value, password: password.value });
    router.replace('/devices');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="proxyMode" class="center-screen">
    <div class="card login-card">
      <h1>由运维面板统一鉴权</h1>
      <p class="sub">这个控制台没有自己的账号。能打开这个页面就说明你已经通过了面板的登录。</p>
    </div>
  </div>
  <div v-else class="center-screen">
    <form class="card login-card" @submit.prevent="submit">
      <h1>{{ initialized ? '登录小单控制台' : '设置管理员' }}</h1>
      <p class="sub">
        {{ initialized
          ? '这个控制台只有一个管理员账号。'
          : '第一次使用,请设置管理员账号。之后不再开放注册。' }}
      </p>

      <div v-if="error" class="notice error">{{ error }}</div>

      <label>
        <span>用户名</span>
        <input v-model="username" type="text" autocomplete="username" required />
      </label>
      <label>
        <span>密码</span>
        <input
          v-model="password" type="password" required
          :autocomplete="initialized ? 'current-password' : 'new-password'"
        />
      </label>
      <label v-if="!initialized">
        <span>确认密码</span>
        <input v-model="confirm" type="password" autocomplete="new-password" required />
        <small>至少 8 位。忘记了可以在服务器上用 <code class="code">cli set-password</code> 重设。</small>
      </label>

      <button class="primary" type="submit" :disabled="busy" style="width: 100%">
        {{ busy ? '处理中…' : initialized ? '登录' : '创建并登录' }}
      </button>
    </form>
  </div>
</template>
