<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  api, type Agent, type ApiError, type Device, type DeviceList, type IdentityEvent, type Overview, type PendingDevice,
} from '../api';

const devices = ref<Device[]>([]);
const pending = ref<PendingDevice[]>([]);
const events = ref<IdentityEvent[]>([]);
const agents = ref<Agent[]>([]);
const overview = ref<Overview | null>(null);
const error = ref('');
const loading = ref(true);

// 绑定表单。智能体留空时:新设备绑到默认智能体,重新配对的旧设备保留原来的智能体。
const code = ref('');
const agentId = ref('');
const alias = ref('');
const binding = ref(false);
const bindError = ref('');
const bindDone = ref('');

async function load() {
  error.value = '';
  try {
    const [list, agentList, stats] = await Promise.all([
      api.get<DeviceList>('/devices'),
      api.get<{ items: Agent[] }>('/agents'),
      api.get<Overview>('/overview'),
    ]);
    devices.value = list.items;
    pending.value = list.pending;
    events.value = list.events;
    agents.value = agentList.items;
    overview.value = stats;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function bind() {
  bindError.value = '';
  bindDone.value = '';
  const value = code.value.replace(/\s/gu, '');
  if (!/^\d{6}$/u.test(value)) {
    bindError.value = '绑定码是设备屏幕上显示的六位数字';
    return;
  }
  binding.value = true;
  try {
    const result = await api.post<{ ok: boolean; mac: string }>('/devices/bind', {
      code: value,
      alias: alias.value.trim(),
      ...(agentId.value ? { agent_id: agentId.value } : {}),
    });
    code.value = '';
    alias.value = '';
    bindDone.value = `已绑定 ${result.mac}。设备会在几秒内自动开始工作。`;
    await load();
  } catch (e) {
    const err = e as ApiError;
    bindError.value =
      err.status === 404 ? '绑定码不对或已过期。请核对设备屏幕上当前显示的六位数字。'
      : err.status === 409 ? '这台设备已经绑定过了。如需重新绑定,请先在下方解绑。'
      : err.status === 429 ? '输错次数太多,请几分钟后再试。'
      : err.message;
  } finally {
    binding.value = false;
  }
}

async function unbind(device: Device) {
  const name = device.alias || device.mac;
  const message = `确定解绑 ${name} 吗?\n\n解绑后这台设备无法再对话。要重新绑定,需要在设备屏幕上看到新的绑定码并在这里输入。`
    + '\n正在进行中的对话会持续到设备下次重连为止。';
  if (!confirm(message)) return;
  try {
    await api.del(`/devices/${encodeURIComponent(device.mac)}`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function dismissPending(item: PendingDevice) {
  if (!confirm(`清除 ${item.mac} 的这条等待记录?\n\n如果那台设备还开着,它下次询问时会带着一个新的码重新出现。`)) return;
  try {
    await api.del(`/devices/pending/${item.id}`);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function clearEvents() {
  try {
    await api.del('/identity-events');
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function rename(device: Device) {
  const next = prompt('设备名称', device.alias);
  if (next === null) return;
  try {
    await api.put(`/devices/${encodeURIComponent(device.mac)}`, { alias: next });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function moveAgent(device: Device, target: string) {
  try {
    await api.put(`/devices/${encodeURIComponent(device.mac)}`, { agent_id: target });
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

const EVENT_TEXT: Record<IdentityEvent['kind'], string> = {
  mismatch: '出示的设备密钥与绑定时记录的不一致',
  missing_identity: '没有出示有效的设备密钥',
  legacy_unverified: '升级前绑定、尚未重新配对的设备尝试对话',
};
const SOURCE_TEXT: Record<IdentityEvent['source'], string> = {
  ota: '开机询问控制塔时',
  engine: '连接对话服务时',
};

const hasAgents = computed(() => agents.value.length > 0);
const hasLegacy = computed(() => devices.value.some((device) => device.identity === 'legacy'));
const sharedMac = computed(() => pending.value.some((item) => item.same_mac_count > 1));
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
    <h2>绑定新设备</h2>
    <p>
      设备连上 Wi-Fi 后会先询问控制塔,还没绑定时屏幕上会显示六位绑定码。
      只有拿着设备的人能看到这个码,所以控制塔不会在页面上列出它。把屏幕上的码输入到这里即可。
    </p>

    <div v-if="!hasAgents" class="notice warn">还没有智能体,请先到「智能体」页面创建一个。</div>

    <form class="btn-row" @submit.prevent="bind">
      <input
        v-model="code" type="text" inputmode="numeric" autocomplete="off" maxlength="6"
        placeholder="六位绑定码" style="width: 140px; letter-spacing: 4px"
      />
      <select v-model="agentId" style="width: auto">
        <option value="">默认智能体(重新配对的设备保留原来的)</option>
        <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
      </select>
      <input v-model="alias" type="text" maxlength="64" placeholder="设备名称(可选)" style="width: 180px" />
      <button class="primary" type="submit" :disabled="binding || !hasAgents">绑定</button>
    </form>
    <div v-if="bindError" class="notice error" style="margin-top: 12px">{{ bindError }}</div>
    <div v-if="bindDone" class="notice info" style="margin-top: 12px">{{ bindDone }}</div>
  </div>

  <div v-if="events.length > 0" class="card">
    <h2>身份异常</h2>
    <p>
      有设备用已绑定设备的 MAC 连接,但身份对不上。如果你刚给设备恢复出厂或擦除过闪存,
      这是正常的:在下方解绑它,设备屏幕上会出现新码,重新输入即可。否则可能有人在冒充你的设备 ——
      冒充者拿不到任何配置,也无法对话。
    </p>
    <table>
      <thead>
        <tr><th>设备 MAC</th><th>情况</th><th>次数</th><th>最近一次</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in events" :key="item.id">
          <td><span class="code">{{ item.mac }}</span></td>
          <td>{{ SOURCE_TEXT[item.source] }}{{ EVENT_TEXT[item.kind] }}</td>
          <td>{{ item.count }}</td>
          <td>{{ relative(item.last_seen_at) }}</td>
        </tr>
      </tbody>
    </table>
    <div class="btn-row" style="margin-top: 12px">
      <button @click="clearEvents">全部清除</button>
    </div>
  </div>

  <div class="card">
    <h2>正在等待绑定</h2>
    <p>这里列出正在显示绑定码的设备,方便确认你的设备已经连上控制塔。设备关机后约十分钟自动消失。</p>

    <div v-if="sharedMac" class="notice warn">
      有多个身份在用同一个 MAC 等待绑定,其中可能有冒充者。只输入你自己设备屏幕上的码。
    </div>

    <div v-if="pending.length === 0" class="empty">暂时没有设备在等待绑定。</div>
    <table v-else>
      <thead>
        <tr><th>设备 MAC</th><th>板型 / 固件</th><th>首次出现</th><th>最近询问</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="item in pending" :key="item.id">
          <td>
            <span class="code">{{ item.mac }}</span>
            <span v-if="item.same_mac_count > 1" class="tag warn" style="margin-left: 6px">
              同 MAC 共 {{ item.same_mac_count }} 个
            </span>
          </td>
          <td>{{ [item.board, item.app_version].filter(Boolean).join(' / ') || '未上报' }}</td>
          <td>{{ relative(item.created_at) }}</td>
          <td>{{ relative(item.last_seen_at) }}</td>
          <td class="actions">
            <button class="link danger" @click="dismissPending(item)">清除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>已绑定设备</h2>

    <div v-if="hasLegacy" class="notice warn">
      有设备是在身份校验上线前绑定的,重新配对之前它无法对话。给它刷入新固件并开机,
      屏幕上会显示六位绑定码,在上方输入即可,名称和智能体都会保留。
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="devices.length === 0" class="empty">还没有绑定任何设备。</div>
    <table v-else>
      <thead>
        <tr><th>名称</th><th>MAC</th><th>身份</th><th>智能体</th><th>最后连接</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="device in devices" :key="device.mac">
          <td>{{ device.alias || '(未命名)' }}</td>
          <td><span class="code">{{ device.mac }}</span></td>
          <td>
            <span v-if="device.identity === 'verified'" class="tag ok">已验证</span>
            <span v-else class="tag warn">需重新配对</span>
          </td>
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
</template>
