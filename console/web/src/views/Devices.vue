<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Agent, type Device, type Overview, type PendingDevice } from '../api';

const devices = ref<Device[]>([]);
const pending = ref<PendingDevice[]>([]);
const agents = ref<Agent[]>([]);
const overview = ref<Overview | null>(null);
const error = ref('');
const loading = ref(true);

const bindTarget = ref<PendingDevice | null>(null);
const bindAgent = ref('');
const bindAlias = ref('');

const manualCode = ref('');
const manualAgent = ref('');

async function load() {
  error.value = '';
  try {
    const [list, agentList, stats] = await Promise.all([
      api.get<{ items: Device[]; pending: PendingDevice[] }>('/devices'),
      api.get<{ items: Agent[] }>('/agents'),
      api.get<Overview>('/overview'),
    ]);
    devices.value = list.items;
    pending.value = list.pending;
    agents.value = agentList.items;
    overview.value = stats;
    const fallback = agentList.items[0]?.id ?? '';
    if (!bindAgent.value) bindAgent.value = fallback;
    if (!manualAgent.value) manualAgent.value = fallback;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openBind(device: PendingDevice) {
  bindTarget.value = device;
  bindAlias.value = '';
}

async function confirmBind() {
  if (!bindTarget.value) return;
  try {
    await api.post('/devices/bind', {
      mac: bindTarget.value.mac,
      agent_id: bindAgent.value,
      alias: bindAlias.value,
    });
    bindTarget.value = null;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function bindByCode() {
  if (!/^\d{6}$/.test(manualCode.value)) { error.value = '绑定码是六位数字'; return; }
  try {
    await api.post('/devices/bind', { code: manualCode.value, agent_id: manualAgent.value });
    manualCode.value = '';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function unbind(device: Device) {
  if (!confirm(`确定解绑 ${device.alias || device.mac} 吗?解绑后它会重新出现在待绑定列表里。`)) return;
  try {
    await api.del(`/devices/${encodeURIComponent(device.mac)}`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function rename(device: Device) {
  const alias = prompt('设备名称', device.alias);
  if (alias === null) return;
  try {
    await api.put(`/devices/${encodeURIComponent(device.mac)}`, { alias });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function moveAgent(device: Device, agentId: string) {
  try {
    await api.put(`/devices/${encodeURIComponent(device.mac)}`, { agent_id: agentId });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

const relative = (iso: string | null) => {
  if (!iso) return '从未';
  // SQLite 的 datetime('now') 给的是 UTC 但不带时区标记,补上 Z 再解析
  const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleString('zh-CN');
};

const hasAgents = computed(() => agents.value.length > 0);
</script>

<template>
  <div class="page-head">
    <h1>设备</h1>
    <p>每台设备绑定一个智能体。</p>
  </div>

  <div v-if="error" class="notice error">{{ error }}</div>

  <div v-if="overview" class="stats">
    <div class="stat"><b>{{ overview.devices }}</b><span>已绑定</span></div>
    <div class="stat"><b>{{ overview.pending }}</b><span>等待绑定</span></div>
    <div class="stat"><b>{{ overview.agents }}</b><span>智能体</span></div>
    <div class="stat"><b>{{ overview.messages }}</b><span>对话消息</span></div>
  </div>

  <div class="card">
    <h2>等待绑定</h2>
    <p>
      设备第一次连上服务端时会出现在这里,同时它自己也会把绑定码念出来。
      从这里直接点「绑定」即可,不必去听那六位数字。
    </p>

    <div v-if="!hasAgents" class="notice warn">
      还没有智能体,请先到「智能体」页面创建一个。
    </div>

    <div v-if="pending.length === 0" class="empty">
      暂时没有设备在等待绑定。
    </div>
    <table v-else>
      <thead>
        <tr><th>设备 MAC</th><th>绑定码</th><th>板型 / 固件</th><th>出现时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="item in pending" :key="item.mac">
          <td><span class="code">{{ item.mac }}</span></td>
          <td><span class="bind-code">{{ item.code }}</span></td>
          <td>{{ [item.board, item.app_version].filter(Boolean).join(' / ') || '未上报' }}</td>
          <td>{{ relative(item.created_at) }}</td>
          <td class="actions">
            <button class="primary" :disabled="!hasAgents" @click="openBind(item)">绑定</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="hasAgents" class="btn-row" style="margin-top: 16px">
      <span style="color: var(--muted)">或手动输入绑定码:</span>
      <input v-model="manualCode" type="text" placeholder="六位数字" style="width: 120px" maxlength="6" />
      <select v-model="manualAgent" style="width: auto">
        <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
      </select>
      <button @click="bindByCode">绑定</button>
    </div>
  </div>

  <div class="card">
    <h2>已绑定设备</h2>
    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="devices.length === 0" class="empty">还没有绑定任何设备。</div>
    <table v-else>
      <thead>
        <tr><th>名称</th><th>MAC</th><th>智能体</th><th>最后连接</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="device in devices" :key="device.mac">
          <td>{{ device.alias || '(未命名)' }}</td>
          <td><span class="code">{{ device.mac }}</span></td>
          <td>
            <select
              :value="device.agent_id" style="width: auto"
              @change="moveAgent(device, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </td>
          <td>{{ relative(device.last_connected_at) }}</td>
          <td class="actions">
            <button class="link" @click="rename(device)">改名</button>
            <button class="link danger" @click="unbind(device)">解绑</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div v-if="bindTarget" class="modal-mask" @click.self="bindTarget = null">
    <div class="card modal">
      <h2>绑定设备</h2>
      <p style="color: var(--muted)">
        MAC <span class="code">{{ bindTarget.mac }}</span>,绑定码
        <span class="code">{{ bindTarget.code }}</span>
      </p>
      <label>
        <span>绑定到哪个智能体</span>
        <select v-model="bindAgent">
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
        </select>
      </label>
      <label>
        <span>设备名称(可选)</span>
        <input v-model="bindAlias" type="text" placeholder="例如:客厅的小单" />
      </label>
      <div class="modal-foot">
        <button @click="bindTarget = null">取消</button>
        <button class="primary" @click="confirmBind">确认绑定</button>
      </div>
    </div>
  </div>
</template>
