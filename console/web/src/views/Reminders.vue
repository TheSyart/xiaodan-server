<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Device, type DeviceList, type Reminder } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, formatTime, toast, toastError } from '../ui';

// 定时提醒:设备上说「八点提醒我喝水」时由智能体创建,也可以在这里手动添加。
// 到点时设备在线就响提示音、播报并显示卡片;设备不在线 3 分钟后记为错过,下次连上时补报。

const reminders = ref<Reminder[]>([]);
const devices = ref<Device[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [r, d] = await Promise.all([api.get<{ items: Reminder[] }>('/reminders'), api.get<DeviceList>('/devices')]);
    reminders.value = r.items;
    devices.value = d.items;
    if (!form.value.mac) form.value.mac = d.items[0]?.mac ?? '';
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const STATUS: Record<Reminder['status'], { text: string; tone: string }> = {
  pending: { text: '待提醒', tone: 'sky' },
  delivered: { text: '已提醒', tone: 'ok' },
  missed: { text: '错过了', tone: 'warn' },
  cancelled: { text: '已取消', tone: '' },
};
const REPEAT: Record<Reminder['repeat'], string> = { none: '不重复', daily: '每天', weekdays: '工作日', weekly: '每周' };
const deviceName = (mac: string) => devices.value.find((d) => d.mac === mac)?.alias || mac;

const pad = (n: number) => String(n).padStart(2, '0');
function inAnHour(): string {
  const t = new Date(Date.now() + 3600_000 + 8 * 3600_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:00`;
}
const form = ref({ mac: '', text: '', at: inAnHour(), repeat: 'none' as Reminder['repeat'] });
const adding = ref(false);

async function add() {
  if (adding.value) return;
  if (!form.value.mac || !form.value.text.trim()) {
    toast('请选择设备并填写提醒内容。', 'warn');
    return;
  }
  adding.value = true;
  try {
    await api.post('/reminders', { ...form.value, text: form.value.text.trim() });
    toast('已添加');
    form.value = { ...form.value, text: '' };
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    adding.value = false;
  }
}

async function cancel(reminder: Reminder) {
  if (!(await confirmDialog({ title: `取消提醒「${reminder.text}」?`, confirmText: '取消提醒', danger: true }))) return;
  try {
    await api.del(`/reminders/${reminder.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

const active = computed(() => reminders.value.filter((r) => r.status === 'pending' || r.status === 'missed'));
const history = computed(() => reminders.value.filter((r) => r.status === 'delivered' || r.status === 'cancelled'));
</script>

<template>
  <PageHeader title="提醒" description="设备上说「八点提醒我喝水」就会出现在这里。到点设备响提示音并播报;设备不在线时下次连上补报。" />

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <section class="card">
    <div class="card-head"><div><h2><AppIcon name="plus" :size="18" />手动添加</h2><p>时间按北京时间填写。</p></div></div>
    <form class="form-grid" @submit.prevent="add">
      <label class="field">
        <span class="field-label">设备</span>
        <select v-model="form.mac" class="select" :disabled="devices.length === 0">
          <option v-for="d in devices" :key="d.mac" :value="d.mac">{{ d.alias || d.mac }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">提醒内容</span>
        <input v-model="form.text" class="input" type="text" maxlength="100" placeholder="喝水" />
      </label>
      <label class="field">
        <span class="field-label">时间</span>
        <input v-model="form.at" class="input mono" type="text" placeholder="2026-09-17 08:00" />
      </label>
      <label class="field">
        <span class="field-label">重复</span>
        <select v-model="form.repeat" class="select">
          <option v-for="(label, key) in REPEAT" :key="key" :value="key">{{ label }}</option>
        </select>
      </label>
      <div class="field" style="justify-content: flex-end">
        <button class="btn btn-primary" type="submit" :aria-busy="adding" :disabled="devices.length === 0"><AppIcon name="plus" :size="16" /><span>添加</span></button>
      </div>
    </form>
  </section>

  <div v-if="loading" class="card"><SkeletonRows :rows="3" /></div>
  <template v-else>
    <section class="card">
      <div class="card-head"><div><h2><AppIcon name="clock" :size="18" />待提醒与错过的 <span v-if="active.length" class="count">{{ active.length }}</span></h2></div></div>
      <EmptyState v-if="active.length === 0" title="没有待提醒的事项" description="在设备上说「半小时后提醒我喝水」试试。" />
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th>内容</th><th>时间</th><th>重复</th><th>设备</th><th>状态</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in active" :key="r.id">
              <td class="cell-main">{{ r.text }}</td>
              <td class="mono nowrap">{{ r.due_local }}</td>
              <td>{{ REPEAT[r.repeat] }}</td>
              <td>{{ r.alias || deviceName(r.mac) }}</td>
              <td><span class="tag dot" :class="STATUS[r.status].tone">{{ STATUS[r.status].text }}</span><span v-if="r.attempts" class="cell-sub"> · 试过 {{ r.attempts }} 次</span></td>
              <td class="actions"><button class="btn btn-ghost btn-sm danger" type="button" @click="cancel(r)"><AppIcon name="x" :size="14" /><span>取消</span></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="history.length" class="card">
      <div class="card-head"><div><h2><AppIcon name="check" :size="18" />最近 7 天</h2></div></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>内容</th><th>时间</th><th>设备</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="r in history" :key="r.id">
              <td>{{ r.text }}</td>
              <td class="mono nowrap">{{ r.due_local }}</td>
              <td>{{ r.alias || deviceName(r.mac) }}</td>
              <td><span class="tag dot" :class="STATUS[r.status].tone">{{ STATUS[r.status].text }}</span><span v-if="r.delivered_at" class="cell-sub"> · {{ formatTime(r.delivered_at) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
