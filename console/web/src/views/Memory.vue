<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  api, type ChatMessage, type ChatSession, type MemoryArc, type MemoryChange, type MemoryFact, type MemoryOverview,
  type MemorySettings,
} from '../api';
import AppIcon from '../components/AppIcon.vue';
import ChatTranscript from '../components/ChatTranscript.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, formatTime, parseDbTime, relativeTime, toast, toastError } from '../ui';

// 记忆页。热记忆是每次对话都带给模型的事实(按分类,住址与联系方式默认打码);
// 下面是这台设备的对话,归档功能上线后会变成一段段带摘要的档案。

const overview = ref<MemoryOverview | null>(null);
const facts = ref<MemoryFact[]>([]);
const changes = ref<MemoryChange[]>([]);
const sessions = ref<ChatSession[]>([]);
const loading = ref(true);
const loadError = ref('');
const mac = ref('');
const newFact = ref('');
const adding = ref(false);
const editing = ref<MemoryFact | null>(null);
const editText = ref('');
const revealed = ref<number[]>([]);
const revealedChanges = ref<number[]>([]);

const current = ref<ChatSession | null>(null);
const currentArc = ref<MemoryArc | null>(null);
const messages = ref<ChatMessage[]>([]);
const loadingMessages = ref(false);

const arcs = ref<MemoryArc[]>([]);
const arcNext = ref<string | null>(null);
const arcQuery = ref('');
const loadingArcs = ref(false);
const retrying = ref(0);

const settingsOpen = ref(false);
const settings = ref<MemorySettings | null>(null);
const settingsDraft = ref({ scope: '', summaryModelId: '', rawKeepDays: 0, minTurns: 2 });
const savingSettings = ref(false);

async function load() {
  loadError.value = '';
  try {
    const data = await api.get<MemoryOverview>(`/memory/overview${mac.value ? `?mac=${encodeURIComponent(mac.value)}` : ''}`);
    overview.value = data;
    mac.value = data.device?.mac ?? '';
    if (!mac.value) {
      facts.value = [];
      changes.value = [];
      sessions.value = [];
      return;
    }
    const query = `?mac=${encodeURIComponent(mac.value)}`;
    const [factList, changeList, arcList, chats] = await Promise.all([
      api.get<{ items: MemoryFact[] }>(`/memory/facts${query}`),
      api.get<{ items: MemoryChange[] }>(`/memory/changes${query}`),
      api.get<{ items: MemoryArc[]; next: string | null }>(`/memory/arcs${query}${arcQuery.value ? `&q=${encodeURIComponent(arcQuery.value)}` : ''}`),
      api.get<{ items: ChatSession[] }>(`/chats${query}&unarchived=1`).catch(() => ({ items: [] })),
    ]);
    facts.value = factList.items;
    changes.value = changeList.items;
    arcs.value = arcList.items;
    arcNext.value = arcList.next;
    // 还没整理成档案的原文:按会话列出来兜底(上线前攒的老对话、正在聊的那一段)
    sessions.value = chats.items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(mac, () => {
  current.value = null;
  currentArc.value = null;
  arcQuery.value = '';
  revealed.value = [];
  revealedChanges.value = [];
  void load();
});

/** 按分类分组,顺序跟着后端给的分类清单 */
const groups = computed(() => {
  const order = overview.value?.kinds ?? [];
  return order
    .map((kind) => ({ ...kind, items: facts.value.filter((fact) => fact.kind === kind.kind) }))
    .filter((group) => group.items.length);
});

const mask = (text: string) => text.replace(/[0-9A-Za-z一-龥]/gu, '•');
const shown = (fact: MemoryFact) => (fact.sensitive && !revealed.value.includes(fact.id) ? mask(fact.text) : fact.text);

async function addFact() {
  const text = newFact.value.trim();
  if (!text || adding.value || !mac.value) return;
  adding.value = true;
  try {
    await api.post('/memory/facts', { mac: mac.value, text });
    newFact.value = '';
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    adding.value = false;
  }
}

function startEdit(fact: MemoryFact) {
  editing.value = fact;
  editText.value = fact.text;
}

async function saveEdit() {
  const fact = editing.value;
  if (!fact || !editText.value.trim()) return;
  try {
    await api.put(`/memory/facts/${fact.id}`, { text: editText.value.trim() });
    editing.value = null;
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function removeFact(fact: MemoryFact) {
  try {
    await api.del(`/memory/facts/${fact.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function clearFacts() {
  if (!(await confirmDialog({
    title: '清空这台设备的全部记忆?',
    message: '所有角色都会忘掉这些事。可以在下面的「最近的变更」里逐条撤销。',
    confirmText: '清空',
    danger: true,
  }))) return;
  try {
    await api.del(`/memory/facts?mac=${encodeURIComponent(mac.value)}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function undo(change: MemoryChange) {
  try {
    await api.post(`/memory/changes/${change.id}/undo`);
    toast('已撤销');
    await load();
  } catch (e) {
    toastError(e);
  }
}

const CHANGE_VERB: Record<MemoryChange['op'], string> = { add: '记住', update: '改成', delete: '忘掉' };
// 私密内容在变更记录里同样打码,免得删掉一条住址反而让它明晃晃留在这儿
const changeText = (change: MemoryChange) => {
  const text = change.op === 'update' ? `${change.before_text} → ${change.after_text}`
    : change.op === 'add' ? change.after_text : change.before_text;
  return change.sensitive && !revealedChanges.value.includes(change.id) ? mask(text) : text;
};
const changeWho = (change: MemoryChange) =>
  (change.source === 'admin' ? '在这个页面' : change.source === 'archive' ? '整理对话时' : `${change.agent_name ?? '角色'}聊天时`);

async function searchArcs() {
  loadingArcs.value = true;
  try {
    const result = await api.get<{ items: MemoryArc[]; next: string | null }>(
      `/memory/arcs?mac=${encodeURIComponent(mac.value)}${arcQuery.value ? `&q=${encodeURIComponent(arcQuery.value)}` : ''}`,
    );
    arcs.value = result.items;
    arcNext.value = result.next;
  } catch (e) {
    toastError(e);
  } finally {
    loadingArcs.value = false;
  }
}

async function moreArcs() {
  if (!arcNext.value || loadingArcs.value) return;
  loadingArcs.value = true;
  try {
    const result = await api.get<{ items: MemoryArc[]; next: string | null }>(
      `/memory/arcs?mac=${encodeURIComponent(mac.value)}&before=${encodeURIComponent(arcNext.value)}${arcQuery.value ? `&q=${encodeURIComponent(arcQuery.value)}` : ''}`,
    );
    arcs.value = [...arcs.value, ...result.items];
    arcNext.value = result.next;
  } catch (e) {
    toastError(e);
  } finally {
    loadingArcs.value = false;
  }
}

async function openArc(arc: MemoryArc) {
  currentArc.value = arc;
  messages.value = [];
  loadingMessages.value = true;
  window.scrollTo({ top: 0 });
  try {
    messages.value = (await api.get<{ arc: MemoryArc; messages: ChatMessage[] }>(`/memory/arcs/${arc.id}`)).messages;
  } catch (e) {
    toastError(e);
  } finally {
    loadingMessages.value = false;
  }
}

async function retryArc(arc: MemoryArc) {
  if (retrying.value) return;
  retrying.value = arc.id;
  try {
    const result = await api.post<{ status: string; arc: MemoryArc }>(`/memory/arcs/${arc.id}/retry`, {});
    if (currentArc.value?.id === arc.id) currentArc.value = result.arc;
    toast(result.status === 'ready' ? '整理好了' : '还是没能整理好,过会儿再试试');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    retrying.value = 0;
  }
}

async function removeArc(arc: MemoryArc) {
  if (!(await confirmDialog({
    title: '删除这段档案?',
    message: `「${arc.title || '未命名'}」连同这段对话的原文一起删掉,不能恢复。`,
    confirmText: '删除',
    danger: true,
  }))) return;
  try {
    await api.del(`/memory/arcs/${arc.id}`);
    if (currentArc.value?.id === arc.id) currentArc.value = null;
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}

const ARC_STATUS: Record<MemoryArc['status'], string> = {
  pending: '正在整理', ready: '', failed: '没能整理', skipped: '太短,没整理', raw_gone: '原文已清理',
};

function arcDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

async function openSession(session: ChatSession) {
  current.value = session;
  messages.value = [];
  loadingMessages.value = true;
  window.scrollTo({ top: 0 });
  try {
    messages.value = (await api.get<{ items: ChatMessage[] }>(`/chats/${encodeURIComponent(session.session_id)}`)).items;
  } catch (e) {
    toastError(e);
  } finally {
    loadingMessages.value = false;
  }
}

async function removeSession(session: ChatSession) {
  if (!(await confirmDialog({
    title: '删除这段对话?',
    message: `${formatTime(session.started_at)} 开始的对话,共 ${session.messages} 条消息。删除后无法恢复。`,
    confirmText: '删除',
    danger: true,
  }))) return;
  try {
    await api.del(`/chats/${encodeURIComponent(session.session_id)}`);
    if (current.value?.session_id === session.session_id) current.value = null;
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}

function duration(session: ChatSession) {
  const ms = parseDbTime(session.ended_at).getTime() - parseDbTime(session.started_at).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

async function openSettings() {
  try {
    settings.value = await api.get<MemorySettings>('/memory/settings');
    settingsDraft.value = {
      scope: settings.value.scope,
      summaryModelId: settings.value.summaryModelId,
      rawKeepDays: settings.value.rawKeepDays,
      minTurns: settings.value.minTurns,
    };
    settingsOpen.value = true;
  } catch (e) {
    toastError(e);
  }
}

async function saveSettings() {
  if (savingSettings.value) return;
  savingSettings.value = true;
  try {
    await api.put('/memory/settings', {
      scope: settingsDraft.value.scope,
      summaryModelId: settingsDraft.value.summaryModelId,
      rawKeepDays: Number(settingsDraft.value.rawKeepDays) || 0,
      minTurns: Number(settingsDraft.value.minTurns) || 0,
    });
    settingsOpen.value = false;
    toast('已保存,下一轮对话生效');
  } catch (e) {
    toastError(e);
  } finally {
    savingSettings.value = false;
  }
}

const deviceName = (item: { alias: string; mac: string }) => item.alias || item.mac;
</script>

<template>
  <template v-if="currentArc">
    <PageHeader :title="currentArc.title || '这段对话'" :description="`${formatTime(currentArc.started_at)} · ${arcDuration(currentArc.duration_s)} · ${currentArc.messages} 条消息${currentArc.agent_name ? ` · ${currentArc.agent_name}` : ''}`">
      <template #actions>
        <button class="btn" type="button" @click="currentArc = null"><AppIcon name="arrowLeft" :size="16" /><span>返回</span></button>
        <button class="btn" type="button" :aria-busy="retrying === currentArc.id" @click="retryArc(currentArc)">
          <AppIcon name="refresh" :size="16" /><span>重新整理</span>
        </button>
        <button class="btn btn-danger" type="button" @click="removeArc(currentArc)"><AppIcon name="trash" :size="16" /><span>删除</span></button>
      </template>
    </PageHeader>
    <section v-if="currentArc.summary || currentArc.bullets.length" class="card">
      <p style="margin: 0 0 8px">{{ currentArc.summary }}</p>
      <ul v-if="currentArc.bullets.length" style="margin: 0; padding-left: 18px">
        <li v-for="(bullet, i) in currentArc.bullets" :key="i">{{ bullet }}</li>
      </ul>
      <div v-if="currentArc.topics.length" class="chips" style="margin-top: 8px">
        <span v-for="topic in currentArc.topics" :key="topic" class="tag">{{ topic }}</span>
      </div>
    </section>
    <section class="card">
      <EmptyState v-if="!currentArc.has_raw" title="原文已按保留策略清理" description="摘要与要点仍然保留。" />
      <ChatTranscript v-else :messages="messages" :loading="loadingMessages" />
    </section>
  </template>

  <template v-else-if="current">
    <PageHeader title="对话详情" :description="`${formatTime(current.started_at)} · ${current.messages} 条消息`">
      <template #actions>
        <button class="btn" type="button" @click="current = null"><AppIcon name="arrowLeft" :size="16" /><span>返回</span></button>
        <button class="btn btn-danger" type="button" @click="removeSession(current)"><AppIcon name="trash" :size="16" /><span>删除</span></button>
      </template>
    </PageHeader>
    <section class="card"><ChatTranscript :messages="messages" :loading="loadingMessages" /></section>
  </template>

  <template v-else>
    <PageHeader title="记忆" description="关于用户的事实每次对话都会带给模型;下面是这台设备聊过的内容。">
      <template #actions>
        <select v-if="(overview?.devices.length ?? 0) > 1" v-model="mac" class="select" style="height: 32px; width: auto" aria-label="选择设备">
          <option v-for="item in overview?.devices ?? []" :key="item.mac" :value="item.mac">{{ deviceName(item) }}</option>
        </select>
        <button class="btn" type="button" @click="openSettings"><AppIcon name="sliders" :size="16" /><span>记忆设置</span></button>
      </template>
    </PageHeader>

    <div v-if="loadError" class="callout danger" role="alert">
      <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
    </div>
    <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

    <template v-else-if="!overview?.device">
      <EmptyState title="还没有绑定设备" description="绑定一台设备后,它记住的事会显示在这里。">
        <RouterLink class="btn btn-primary" to="/devices"><AppIcon name="device" :size="16" /><span>去绑定设备</span></RouterLink>
      </EmptyState>
    </template>

    <template v-else>
      <div v-if="!overview.device.enabled" class="callout warn">
        <AppIcon name="alert" :size="18" />
        <div class="callout-body">
          这台设备当前的角色没有开「长期记忆」,聊天时既不会记新的事,也读不到下面这些。
          去<RouterLink to="/agents">智能体</RouterLink>页把它打开。
        </div>
      </div>

      <section class="card">
        <div class="card-head">
          <div>
            <h2><AppIcon name="star" :size="18" />关于用户 <span v-if="facts.length" class="count">{{ facts.length }}</span></h2>
            <p>
              最多 {{ overview.device.max_facts }} 条,每条 {{ overview.device.max_chars }} 字以内。
              <template v-if="overview.device.sensitive">
                其中 {{ overview.device.sensitive }} 条是住址或联系方式:默认打码显示,平时也不写进给模型的提示词,模型真的要用时才去取。
              </template>
            </p>
          </div>
          <div v-if="facts.length" class="card-actions">
            <button class="btn btn-ghost btn-sm danger" type="button" @click="clearFacts"><AppIcon name="trash" :size="14" /><span>全部清空</span></button>
          </div>
        </div>

        <EmptyState
          v-if="facts.length === 0" title="还没有记住什么"
          description="聊天时用户说起自己的事,角色会记下来;也可以在下面手动添加。"
        />
        <div v-else class="stack" style="gap: 14px">
          <section v-for="group in groups" :key="group.kind" class="stack" style="gap: 6px">
            <h3 class="memory-group">{{ group.label }}<span v-if="group.sensitive" class="tag warn">私密</span></h3>
            <ul class="memory-list">
              <li v-for="fact in group.items" :key="fact.id">
                <span class="memory-text" :class="{ masked: fact.sensitive && !revealed.includes(fact.id) }">{{ shown(fact) }}</span>
                <button
                  v-if="fact.sensitive" class="btn btn-ghost btn-sm btn-icon" type="button"
                  :aria-label="revealed.includes(fact.id) ? '隐藏' : '显示'"
                  @click="revealed = revealed.includes(fact.id) ? revealed.filter((id) => id !== fact.id) : [...revealed, fact.id]"
                >
                  <AppIcon name="eye" :size="14" />
                </button>
                <span class="tag" :title="formatTime(fact.updated_at)">
                  {{ fact.source === 'admin' ? '手动添加' : fact.source === 'archive' ? '整理对话时记下' : `${fact.agent_name ?? '角色'}记下` }}
                </span>
                <button class="btn btn-ghost btn-sm btn-icon" type="button" :aria-label="`修改:${fact.text}`" @click="startEdit(fact)">
                  <AppIcon name="pencil" :size="14" />
                </button>
                <button class="btn btn-ghost btn-sm btn-icon danger" type="button" :aria-label="`删除:${fact.text}`" @click="removeFact(fact)">
                  <AppIcon name="trash" :size="14" />
                </button>
              </li>
            </ul>
          </section>
        </div>

        <form class="row" style="gap: 8px; margin-top: 12px" @submit.prevent="addFact">
          <input
            v-model="newFact" class="input" type="text" :maxlength="overview.device.max_chars"
            placeholder="比如:名字叫乐乐,最喜欢霸王龙" style="flex: 1; min-width: 0"
          />
          <button class="btn btn-sm" type="submit" :disabled="!newFact.trim()" :aria-busy="adding">
            <AppIcon name="plus" :size="14" /><span>添加</span>
          </button>
        </form>
      </section>

      <section v-if="changes.length" class="card">
        <div class="card-head"><div><h2><AppIcon name="clock" :size="18" />最近的变更</h2><p>聊天里记下、改掉、忘掉的每一次都在这里,点撤销就能还原。</p></div></div>
        <ul class="memory-list">
          <li v-for="change in changes" :key="change.id" :class="{ undone: change.undone }">
            <span class="tag">{{ CHANGE_VERB[change.op] }}</span>
            <span class="memory-text" :class="{ masked: change.sensitive && !revealedChanges.includes(change.id) }">{{ changeText(change) }}</span>
            <button
              v-if="change.sensitive" class="btn btn-ghost btn-sm btn-icon" type="button" aria-label="显示或隐藏"
              @click="revealedChanges = revealedChanges.includes(change.id) ? revealedChanges.filter((id) => id !== change.id) : [...revealedChanges, change.id]"
            >
              <AppIcon name="eye" :size="14" />
            </button>
            <span class="cell-sub" :title="formatTime(change.created_at)">{{ changeWho(change) }} · {{ relativeTime(change.created_at) }}</span>
            <span v-if="change.undone" class="tag">已撤销</span>
            <button v-else class="btn btn-ghost btn-sm" type="button" @click="undo(change)"><AppIcon name="refresh" :size="14" /><span>撤销</span></button>
          </li>
        </ul>
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <h2><AppIcon name="message" :size="18" />对话档案 <span v-if="overview.device.arcs" class="count">{{ overview.device.arcs }}</span></h2>
            <p>
              每段对话(中间停超过半小时就算新的一段)会自动整理成一条档案:标题、一句话摘要、几条要点。
              模型需要时用「回想」把它们找回来。<template v-if="overview.device.arcs_this_month">本月整理了 {{ overview.device.arcs_this_month }} 段。</template>
            </p>
          </div>
          <div class="card-actions">
            <form @submit.prevent="searchArcs">
              <input v-model="arcQuery" class="input" type="search" placeholder="搜标题、摘要、关键词" style="height: 32px; width: 200px" />
            </form>
          </div>
        </div>
        <EmptyState
          v-if="arcs.length === 0" title="还没有整理好的档案"
          description="聊完静置十分钟左右,后台会自动整理;下面「还没整理的」里是原文。"
        />
        <div v-else class="table-wrap">
          <table class="table">
            <thead><tr><th>标题</th><th>摘要</th><th>时间</th><th>时长</th><th></th></tr></thead>
            <tbody>
              <tr v-for="arc in arcs" :key="arc.id">
                <td>
                  <div class="cell-main">{{ arc.title || '未命名' }}</div>
                  <div v-if="ARC_STATUS[arc.status]" class="cell-sub">{{ ARC_STATUS[arc.status] }}</div>
                </td>
                <td class="cell-sub">{{ arc.summary }}</td>
                <td class="nowrap" :title="formatTime(arc.started_at)">{{ relativeTime(arc.ended_at) }}</td>
                <td class="nowrap muted">{{ arcDuration(arc.duration_s) }}</td>
                <td class="actions">
                  <button
                    v-if="arc.status === 'failed' || arc.status === 'skipped'" class="btn btn-ghost btn-sm" type="button"
                    :aria-busy="retrying === arc.id" @click="retryArc(arc)"
                  >
                    <AppIcon name="refresh" :size="14" /><span>重新整理</span>
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" @click="openArc(arc)">
                    <span>查看</span><AppIcon name="chevronRight" :size="14" />
                  </button>
                  <button class="btn btn-ghost btn-sm btn-icon danger" type="button" aria-label="删除" title="删除" @click="removeArc(arc)">
                    <AppIcon name="trash" :size="14" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="arcNext" class="row" style="justify-content: center; margin-top: 10px">
          <button class="btn btn-sm" type="button" :aria-busy="loadingArcs" @click="moreArcs">加载更多</button>
        </div>
      </section>

      <section v-if="sessions.length" class="card">
        <div class="card-head">
          <div>
            <h2><AppIcon name="clock" :size="18" />还没整理的 <span class="count">{{ sessions.length }}</span></h2>
            <p>刚聊完的、以及记忆页上线之前攒下的对话。原文按连接分段,整理成档案后会合并到上面。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>开始</th><th>消息</th><th>时长</th><th></th></tr></thead>
            <tbody>
              <tr v-for="session in sessions" :key="session.session_id">
                <td class="nowrap" :title="formatTime(session.started_at)">{{ relativeTime(session.started_at) }}</td>
                <td class="mono">{{ session.messages }}</td>
                <td class="nowrap muted">{{ duration(session) }}</td>
                <td class="actions">
                  <button class="btn btn-ghost btn-sm" type="button" @click="openSession(session)">
                    <span>查看</span><AppIcon name="chevronRight" :size="14" />
                  </button>
                  <button class="btn btn-ghost btn-sm btn-icon danger" type="button" aria-label="删除" title="删除" @click="removeSession(session)">
                    <AppIcon name="trash" :size="14" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </template>

  <ModalDialog :open="!!editing" title="修改这条记忆" @close="editing = null">
    <form class="stack" @submit.prevent="saveEdit">
      <label class="field">
        <span class="field-label">内容</span>
        <input v-model="editText" class="input" type="text" :maxlength="overview?.device?.max_chars ?? 90" />
        <span class="field-hint">改完会重新判断它属于哪一类、算不算私密。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="editing = null">取消</button>
      <button class="btn btn-primary" type="button" :disabled="!editText.trim()" @click="saveEdit">
        <AppIcon name="check" :size="16" /><span>保存</span>
      </button>
    </template>
  </ModalDialog>

  <ModalDialog :open="settingsOpen" wide title="记忆设置" @close="settingsOpen = false">
    <div v-if="settings" class="stack">
      <label class="field">
        <span class="field-label">记录范围</span>
        <textarea v-model="settingsDraft.scope" class="input" rows="6"></textarea>
        <span class="field-hint">
          这段话会写进模型的「记住」函数说明里,也用于事后整理对话时补录 —— 两边口径是同一份。
          密码、支付信息与证件号无论怎么写都不会记。
        </span>
      </label>
      <label class="field">
        <span class="field-label">整理对话用的模型</span>
        <select v-model="settingsDraft.summaryModelId" class="select">
          <option value="">跟着这段对话的角色</option>
          <option v-for="model in settings.models" :key="model.id" :value="model.id">{{ model.name }}</option>
        </select>
        <span class="field-hint">整理每段对话会调一次模型,可以挑个便宜的。</span>
      </label>
      <div class="row" style="gap: 12px">
        <label class="field" style="flex: 1">
          <span class="field-label">原文保留天数</span>
          <input v-model.number="settingsDraft.rawKeepDays" class="input" type="number" min="0" max="3650" />
          <span class="field-hint">0 表示永久保留。设成 N 天后,整理过的对话原文会被清掉,摘要与要点仍在。</span>
        </label>
        <label class="field" style="flex: 1">
          <span class="field-label">少于几轮不整理</span>
          <input v-model.number="settingsDraft.minTurns" class="input" type="number" min="0" max="20" />
          <span class="field-hint">只说了一两句的对话不值得调一次模型。</span>
        </label>
      </div>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="settingsOpen = false">取消</button>
      <button class="btn btn-primary" type="button" :aria-busy="savingSettings" @click="saveSettings">
        <AppIcon name="check" :size="16" /><span>保存</span>
      </button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.memory-group { margin: 0; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.memory-text.masked { letter-spacing: 1px; color: var(--muted); }
.memory-list li.undone { opacity: 0.55; }
</style>
