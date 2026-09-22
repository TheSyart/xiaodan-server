<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  urlMac,
  api, type Agent, type ApiError, type Device, type DeviceList, type IdentityEvent, type Overview, type PendingDevice,
} from '../api';
import AppIcon from '../components/AppIcon.vue';
import CodeInput from '../components/CodeInput.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import type { IconName } from '../icons';
import { confirmDialog, copyText, formatTime, promptDialog, relativeTime, toast, toastError } from '../ui';

const devices = ref<Device[]>([]);
const pending = ref<PendingDevice[]>([]);
const events = ref<IdentityEvent[]>([]);
const agents = ref<Agent[]>([]);
const overview = ref<Overview | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const loadError = ref('');

// 绑定表单。智能体留空时:新设备绑到默认智能体,重新配对的旧设备保留原来的智能体。
const code = ref('');
const agentId = ref('');
const alias = ref('');
const binding = ref(false);
const bindError = ref('');

async function load(manual = false) {
  refreshing.value = manual;
  loadError.value = '';
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
    if (manual) toast('已刷新', 'info', 1600);
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}
onMounted(() => load());

const deviceName = (device: Device) => device.alias || device.mac;

async function bind() {
  bindError.value = '';
  if (!/^\d{6}$/u.test(code.value)) {
    bindError.value = '绑定码是设备屏幕上显示的六位数字。';
    return;
  }
  binding.value = true;
  try {
    const result = await api.post<{ ok: boolean; mac: string }>('/devices/bind', {
      code: code.value,
      alias: alias.value.trim(),
      ...(agentId.value ? { agent_id: agentId.value } : {}),
    });
    code.value = '';
    alias.value = '';
    toast(`已绑定 ${result.mac}。设备会在几秒内自动开始工作。`);
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
  const ok = await confirmDialog({
    title: `解绑「${deviceName(device)}」?`,
    message:
      '解绑后这台设备无法再对话。要重新绑定,需要在设备屏幕上看到新的绑定码并在这里输入。\n'
      + '正在进行中的对话会持续到设备下次重连为止。',
    confirmText: '解绑',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/devices/${urlMac(device.mac)}`);
    toast(`已解绑 ${deviceName(device)}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

/** 解除家长 App 与它绑定的那台硬件:传的是这台 App 的 MAC,设备记录本身不动 */
async function unbindChild(device: Device) {
  const bound = device.binding;
  if (!bound) return;
  const ok = await confirmDialog({
    title: `解除「${deviceName(device)}」与「${bound.alias || bound.mac}」的绑定?`,
    message: '解除后这台家长 App 不能再按那个孩子用学分接口,要重新绑定才能用。设备本身不受影响。',
    confirmText: '解除绑定',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/credits/binding?mac=${urlMac(device.mac)}`);
    toast('已解除绑定');
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function dismissPending(item: PendingDevice) {
  const ok = await confirmDialog({
    title: `清除 ${item.mac} 的等待记录?`,
    message: '如果那台设备还开着,它下次询问时会带着一个新的码重新出现。',
    confirmText: '清除',
  });
  if (!ok) return;
  try {
    await api.del(`/devices/pending/${item.id}`);
    toast('已清除');
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function clearEvents() {
  const ok = await confirmDialog({
    title: '清除全部身份异常记录?',
    message: '只清除记录本身,不影响任何设备。以后再出现异常时会重新记录。',
    confirmText: '全部清除',
  });
  if (!ok) return;
  try {
    await api.del('/identity-events');
    toast('已清除身份异常记录');
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function rename(device: Device) {
  const next = await promptDialog({
    title: '修改设备名称',
    input: { label: '名称', value: device.alias, placeholder: '例如 客厅的小单', maxlength: 64 },
    confirmText: '保存',
  });
  if (next === null) return;
  try {
    await api.put(`/devices/${urlMac(device.mac)}`, { alias: next.trim() });
    toast('名称已保存');
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function moveAgent(device: Device, target: string) {
  const agent = agents.value.find((item) => item.id === target);
  try {
    await api.put(`/devices/${urlMac(device.mac)}`, { agent_id: target });
    toast(`${deviceName(device)} 已切换到「${agent?.name ?? target}」,下次连接时生效`);
  } catch (e) {
    toastError(e);
  }
  await load();   // 失败时把下拉框恢复成真实值
}

// ---- 可切换的角色 ----
//
// 设备上说「换童童来陪我」时能切到哪些角色(需要当前角色开着「切换角色」工具)。
// 这台设备的长期记忆与聊过的内容在「记忆」页。

const roleDevice = ref<Device | null>(null);
const restrictRoles = ref(false);
const allowedRoles = ref<string[]>([]);
const savingRoles = ref(false);
const agentRuntimeRoles = computed(() => agents.value);

async function openRoles(device: Device) {
  const mac = urlMac(device.mac);
  try {
    const roles = await api.get<{ agent_id: string; allowlist: string[] | null }>(`/devices/${mac}/roles`);
    restrictRoles.value = roles.allowlist !== null;
    allowedRoles.value = roles.allowlist ?? agentRuntimeRoles.value.map((agent) => agent.id);
    roleDevice.value = device;
  } catch (e) {
    toastError(e);
  }
}

function toggleRole(id: string, on: boolean) {
  allowedRoles.value = on ? [...new Set([...allowedRoles.value, id])] : allowedRoles.value.filter((item) => item !== id);
}

async function saveRoles() {
  const device = roleDevice.value;
  if (!device || savingRoles.value) return;
  savingRoles.value = true;
  try {
    const known = new Set(agentRuntimeRoles.value.map((agent) => agent.id));
    await api.put(`/devices/${urlMac(device.mac)}/roles`, {
      allowlist: restrictRoles.value ? allowedRoles.value.filter((id) => known.has(id)) : null,
    });
    toast('已保存可切换的角色');
  } catch (e) {
    toastError(e);
  } finally {
    savingRoles.value = false;
  }
}

// ---- 定位 ----
//
// 默认关着。开了之后:每次对话带上来的公网 IP 会被记下当兜底(城市级),
// 新固件还会在空闲时扫一下周围的 Wi-Fi 热点(几十米)。位置只存最新一条,关掉时一并删除。

const locating = ref('');

function locateText(device: Device): string {
  const place = [device.loc_province, device.loc_city, device.loc_district].filter(Boolean);
  const where = device.loc_address || [...new Set(place)].join(' ');
  const precision = device.loc_source === 'wifi' && device.loc_radius ? `约 ${device.loc_radius} 米` : '城市级';
  return `${where} · ${precision}`;
}

const locateTitle = (device: Device) =>
  `${device.loc_source === 'wifi' ? '按周围 Wi-Fi 热点' : '按公网 IP'}定位,${relativeTime(device.loc_at)}`
  + (device.loc_lat && device.loc_lng ? `(${device.loc_lat.toFixed(4)}, ${device.loc_lng.toFixed(4)} 高德坐标系)` : '');

async function setLocate(device: Device, enabled: boolean) {
  if (enabled && !(await confirmDialog({
    title: `给「${deviceName(device)}」开启定位?`,
    message: '开启后会记下这台设备的大致位置(先按公网 IP 定到城市;新固件在空闲时扫一下周围的 Wi-Fi 热点,可以精确到几十米)。'
      + '只保留最新一条,关掉时一并删除。',
    confirmText: '开启',
  }))) return;
  try {
    await api.put(`/devices/${urlMac(device.mac)}/locate`, { enabled });
    toast(enabled ? '已开启定位' : '已关闭定位并删掉记录');
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function refreshLocate(device: Device) {
  if (locating.value) return;
  locating.value = device.mac;
  try {
    const result = await api.post<{ located: boolean; asked_device: boolean; note: string }>(
      `/devices/${urlMac(device.mac)}/locate/refresh`, {},
    );
    toast(result.located ? '定位好了' : result.note);
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    locating.value = '';
  }
}

const EVENT_TEXT: Record<IdentityEvent['kind'], string> = {
  mismatch: '出示的设备密钥与绑定时记录的不一致',
  missing_identity: '没有出示有效的设备密钥',
  legacy_unverified: '升级前绑定、尚未重新配对的设备尝试对话',
};
const SOURCE_TEXT: Record<IdentityEvent['source'], string> = {
  ota: '开机询问控制塔时',
  engine: '连接对话服务时',
};

const stats = computed<{ label: string; value: number; icon: IconName; tone: string }[]>(() =>
  overview.value
    ? [
        { label: '已绑定设备', value: overview.value.devices, icon: 'device', tone: 'tone-sky' },
        { label: '等待绑定', value: overview.value.pending, icon: 'clock', tone: 'tone-sun' },
        { label: '智能体', value: overview.value.agents, icon: 'bot', tone: 'tone-grass' },
        { label: '对话消息', value: overview.value.messages, icon: 'message', tone: 'tone-violet' },
      ]
    : [],
);

const hasLegacy = computed(() => devices.value.some((device) => device.identity === 'legacy'));
const sharedMac = computed(() => pending.value.some((item) => item.same_mac_count > 1));
/** 硬件设备(孩子);家长 App 自己不算孩子 */
const hardwareDevices = computed(() => devices.value.filter((device) => device.board !== 'xiaodan-app'));
/** 现在只允许一台硬件:存量里有多台时页面上不静默 */
const tooManyHardware = computed(() => hardwareDevices.value.length > 1);
</script>

<template>
  <PageHeader title="设备" description="绑定新设备、看它们最近是否连接过,并为每台设备选择一个智能体。">
    <template #actions>
      <button class="btn" type="button" :aria-busy="refreshing" @click="load(true)">
        <AppIcon name="refresh" :size="16" /><span>刷新</span>
      </button>
    </template>
  </PageHeader>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body">
      <strong>加载失败。</strong>{{ loadError }}
      <div class="callout-actions"><button class="btn btn-sm" type="button" @click="load(true)">重试</button></div>
    </div>
  </div>

  <div v-if="tooManyHardware" class="callout warn" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body">
      <strong>有 {{ hardwareDevices.length }} 台硬件设备。</strong>现在只支持一个孩子,请在下方解绑多余的,只留一台。
    </div>
  </div>

  <div class="stat-grid">
    <template v-if="overview">
      <div v-for="stat in stats" :key="stat.label" class="stat">
        <span class="stat-icon" :class="stat.tone"><AppIcon :name="stat.icon" :size="20" /></span>
        <div>
          <div class="stat-value">{{ stat.value }}</div>
          <div class="stat-label">{{ stat.label }}</div>
        </div>
      </div>
    </template>
    <template v-else>
      <div v-for="i in 4" :key="i" class="stat">
        <span class="skeleton" style="width: 40px; height: 40px; border-radius: 11px"></span>
        <div style="flex: 1">
          <span class="skeleton" style="width: 36%; height: 20px"></span>
          <span class="skeleton" style="width: 62%; margin-top: 8px"></span>
        </div>
      </div>
    </template>
  </div>

  <section class="card accent-sky">
    <div class="bind">
      <div>
        <div class="card-head" style="margin-bottom: 0">
          <div>
            <h2><AppIcon name="link" :size="18" />绑定新设备</h2>
            <p>只有拿着设备的人能看到绑定码,所以控制台不会在页面上列出它。</p>
          </div>
        </div>
        <ol class="steps">
          <li>给设备配好 Wi-Fi,它会先询问控制台自己有没有被绑定。</li>
          <li>还没绑定时,设备屏幕上会显示六位绑定码。</li>
          <li>在这里输入那六位数字、选好智能体,几秒后设备就能对话。</li>
        </ol>
      </div>

      <form class="bind-form" @submit.prevent="bind">
        <div v-if="!loading && agents.length === 0" class="callout warn" style="margin: 0">
          <AppIcon name="alert" :size="18" />
          <div class="callout-body">还没有智能体,请先到<router-link to="/agents">智能体</router-link>页面创建一个。</div>
        </div>
        <div v-if="!loading && hardwareDevices.length > 0" class="callout warn" style="margin: 0">
          <AppIcon name="alert" :size="18" />
          <div class="callout-body">现在只支持一个孩子,先解绑现有那台。</div>
        </div>
        <div class="field">
          <span class="field-label">绑定码</span>
          <CodeInput v-model="code" :invalid="!!bindError" :disabled="binding" @update:model-value="bindError = ''" />
          <span v-if="bindError" class="field-error" role="alert">{{ bindError }}</span>
        </div>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">智能体</span>
            <select v-model="agentId" class="select">
              <option value="">默认智能体</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
            <span class="field-hint">家长 App 不选时自动绑到「家长」智能体;重新配对的旧设备会保留原来的智能体。</span>
          </label>
          <label class="field">
            <span class="field-label">设备名称</span>
            <input v-model="alias" class="input" type="text" maxlength="64" placeholder="可选,例如 客厅的小单" />
          </label>
        </div>
        <div class="row">
          <button class="btn btn-primary" type="submit" :disabled="binding || agents.length === 0 || hardwareDevices.length > 0" :aria-busy="binding">
            <AppIcon name="link" :size="16" /><span>绑定设备</span>
          </button>
        </div>
      </form>
    </div>
  </section>

  <section v-if="events.length > 0" class="card accent-danger">
    <div class="card-head">
      <div>
        <h2><AppIcon name="shield" :size="18" />身份异常 <span class="count">{{ events.length }}</span></h2>
        <p>
          有设备用已绑定设备的 MAC 连接,但身份对不上。如果你刚给设备恢复出厂或擦除过闪存,这是正常的:
          在下方解绑它,再输入屏幕上出现的新码。否则可能有人在冒充你的设备,冒充者拿不到任何配置,也无法对话。
        </p>
      </div>
      <div class="card-actions">
        <button class="btn btn-sm btn-danger" type="button" @click="clearEvents">
          <AppIcon name="trash" :size="14" /><span>全部清除</span>
        </button>
      </div>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>设备</th><th>情况</th><th>次数</th><th>最近一次</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in events" :key="item.id">
            <td><span class="chip-mono">{{ item.mac }}</span></td>
            <td class="text-cell">{{ SOURCE_TEXT[item.source] }}{{ EVENT_TEXT[item.kind] }}</td>
            <td class="mono">{{ item.count }}</td>
            <td class="nowrap" :title="formatTime(item.last_seen_at)">{{ relativeTime(item.last_seen_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <div>
        <h2><AppIcon name="clock" :size="18" />正在等待绑定 <span v-if="pending.length" class="count">{{ pending.length }}</span></h2>
        <p>正在屏幕上显示绑定码的设备。设备关机后约十分钟自动消失。</p>
      </div>
    </div>
    <div v-if="sharedMac" class="callout warn">
      <AppIcon name="alert" :size="18" />
      <div class="callout-body">有多个身份在用同一个 MAC 等待绑定,其中可能有冒充者。只输入你自己设备屏幕上的码。</div>
    </div>
    <SkeletonRows v-if="loading" :rows="2" />
    <EmptyState
      v-else-if="pending.length === 0" title="没有设备在等待绑定"
      description="给新设备配好 Wi-Fi,它就会出现在这里,屏幕上同时显示绑定码。"
    />
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>设备</th><th>板型 / 固件</th><th>首次出现</th><th>最近询问</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="item in pending" :key="item.id">
            <td>
              <div class="row" style="gap: 6px">
                <span class="chip-mono">{{ item.mac }}</span>
                <span v-if="item.same_mac_count > 1" class="tag warn">同 MAC 共 {{ item.same_mac_count }} 个</span>
              </div>
            </td>
            <td class="muted">{{ [item.board, item.app_version].filter(Boolean).join(' / ') || '未上报' }}</td>
            <td class="nowrap" :title="formatTime(item.created_at)">{{ relativeTime(item.created_at) }}</td>
            <td class="nowrap" :title="formatTime(item.last_seen_at)">{{ relativeTime(item.last_seen_at) }}</td>
            <td class="actions">
              <button class="btn btn-ghost btn-sm danger" type="button" @click="dismissPending(item)">
                <AppIcon name="x" :size="14" /><span>清除</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <div>
        <h2><AppIcon name="device" :size="18" />已绑定设备 <span v-if="devices.length" class="count">{{ devices.length }}</span></h2>
        <p>切换智能体或解绑都在设备下次连接时生效。</p>
      </div>
    </div>
    <div v-if="hasLegacy" class="callout warn">
      <AppIcon name="alert" :size="18" />
      <div class="callout-body">
        有设备是在身份校验上线前绑定的,重新配对之前它无法对话。给它刷入新固件并开机,屏幕上会显示六位绑定码,
        在上方输入即可,名称和智能体都会保留。
      </div>
    </div>
    <SkeletonRows v-if="loading" />
    <EmptyState
      v-else-if="devices.length === 0" title="还没有绑定任何设备"
      description="在上方输入设备屏幕上的六位绑定码,完成第一次绑定。"
    />
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>设备</th><th>身份</th><th>智能体</th><th>最后连接</th><th>位置</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="device in devices" :key="device.mac">
            <td>
              <div class="row" style="gap: 6px">
                <span class="cell-main">{{ device.alias || '未命名设备' }}</span>
                <span v-if="device.board === 'xiaodan-app'" class="tag" title="手机上的家长 App,不计学分">家长 App</span>
                <template v-if="device.board === 'xiaodan-app' && device.binding">
                  <span class="tag ok" :title="`绑定的是 ${device.binding.mac}`">已绑:{{ device.binding.alias || device.binding.mac }}</span>
                  <button class="btn btn-ghost btn-sm" type="button" @click="unbindChild(device)">解绑</button>
                </template>
              </div>
              <div class="row" style="gap: 2px; margin-top: 3px">
                <span class="chip-mono">{{ device.mac }}</span>
                <button
                  class="btn btn-ghost btn-sm btn-icon" type="button" title="复制 MAC" :aria-label="`复制 ${device.mac}`"
                  @click="copyText(device.mac, ' MAC 地址')"
                >
                  <AppIcon name="copy" :size="14" />
                </button>
              </div>
            </td>
            <td>
              <span v-if="device.identity === 'verified'" class="tag ok dot">已验证</span>
              <span v-else class="tag warn dot">需重新配对</span>
            </td>
            <td>
              <select
                class="select" :value="device.agent_id" :aria-label="`${deviceName(device)} 使用的智能体`"
                @change="moveAgent(device, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
              </select>
            </td>
            <td>
              <div class="nowrap" :title="formatTime(device.last_connected_at)">{{ relativeTime(device.last_connected_at) }}</div>
              <div v-if="device.app_version" class="cell-sub">固件 {{ device.app_version }}</div>
            </td>
            <td>
              <template v-if="device.locate">
                <div v-if="device.loc_city" class="nowrap" :title="locateTitle(device)">{{ locateText(device) }}</div>
                <div v-else class="cell-sub">{{ device.loc_error ? '定位失败' : '等设备下次说话' }}</div>
                <div class="row" style="gap: 2px; margin-top: 2px">
                  <button class="btn btn-ghost btn-sm" type="button" :aria-busy="locating === device.mac" @click="refreshLocate(device)">
                    <AppIcon name="refresh" :size="13" /><span>立即定位</span>
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" @click="setLocate(device, false)"><span>关闭</span></button>
                </div>
              </template>
              <button v-else class="btn btn-ghost btn-sm" type="button" @click="setLocate(device, true)">
                <AppIcon name="globe" :size="13" /><span>开启定位</span>
              </button>
            </td>
            <td class="actions">
              <button class="btn btn-ghost btn-sm" type="button" @click="openRoles(device)">
                <AppIcon name="user" :size="14" /><span>可切换的角色</span>
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="rename(device)">
                <AppIcon name="pencil" :size="14" /><span>改名</span>
              </button>
              <button class="btn btn-ghost btn-sm danger" type="button" @click="unbind(device)">
                <AppIcon name="unlink" :size="14" /><span>解绑</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <ModalDialog :open="!!roleDevice" wide :title="`${roleDevice ? deviceName(roleDevice) : ''} · 可切换的角色`" @close="roleDevice = null">
    <div v-if="roleDevice" class="stack">
      <section class="stack" style="gap: 10px">
        <h3 style="margin: 0; font-size: 15px">可以切换到的角色</h3>
        <p class="field-hint" style="margin: 0">
          在设备上说「换童童来陪我」时能切到哪些角色。当前角色要开着「切换角色」工具;新角色声音不同时设备会重连一下,再用新声音打招呼。
        </p>
        <SwitchToggle v-model="restrictRoles" label="只允许切换到勾选的角色" />
        <p v-if="!restrictRoles" class="field-hint" style="margin: 0">不限制:所有智能体都能切换。</p>
        <div v-else class="chips">
          <label v-for="agent in agentRuntimeRoles" :key="agent.id" class="tag" style="cursor: pointer; gap: 6px">
            <input type="checkbox" :checked="allowedRoles.includes(agent.id)" @change="toggleRole(agent.id, ($event.target as HTMLInputElement).checked)" />
            {{ agent.name }}<template v-if="agent.id === roleDevice.agent_id">(当前)</template>
          </label>
          <span v-if="agentRuntimeRoles.length === 0" class="field-hint">还没有别的智能体。</span>
        </div>
        <div><button class="btn btn-sm" type="button" :aria-busy="savingRoles" @click="saveRoles"><AppIcon name="check" :size="14" /><span>保存角色设置</span></button></div>
      </section>

      <p class="field-hint" style="margin: 0">
        这台设备记住的事、聊过的内容都在<RouterLink to="/memory">记忆</RouterLink>页。
      </p>
    </div>
  </ModalDialog>
</template>
