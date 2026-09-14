<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type Agent, type CorrectWord } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, toast, toastError } from '../ui';

// 引擎在语音合成之前,按这张表把回复文字里的词替换掉再合成(上游 core/providers/tts/base.py 的 correct_words)。
// 引擎每台设备连接时经 /xiaozhi/config/correct-words 取该设备所属智能体的替换表。

const words = ref<CorrectWord[]>([]);
const agents = ref<Agent[]>([]);
const loading = ref(true);
const loadError = ref('');
const filterAgent = ref('');

const agentId = ref('');
const source = ref('');
const target = ref('');
const adding = ref(false);

async function load() {
  loadError.value = '';
  try {
    const [w, a] = await Promise.all([
      api.get<{ items: CorrectWord[] }>('/correct-words'),
      api.get<{ items: Agent[] }>('/agents'),
    ]);
    words.value = w.items;
    agents.value = a.items;
    if (!agentId.value) agentId.value = (a.items.find((item) => item.is_default === 1) ?? a.items[0])?.id ?? '';
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const agentName = (id: string) => agents.value.find((agent) => agent.id === id)?.name ?? id;
const visible = computed(() =>
  filterAgent.value ? words.value.filter((word) => word.agent_id === filterAgent.value) : words.value,
);

async function add() {
  if (adding.value) return;
  const from = source.value.trim();
  const to = target.value.trim();
  if (!agentId.value || !from || !to) {
    toast('请选择智能体,并填写原词与替换写法。', 'warn');
    return;
  }
  if (from === to) {
    toast('原词和替换写法一样,不需要添加。', 'warn');
    return;
  }
  adding.value = true;
  try {
    await api.post('/correct-words', { agent_id: agentId.value, source: from, target: to });
    source.value = '';
    target.value = '';
    toast(`已添加:${from} → ${to}`);
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    adding.value = false;
  }
}

async function remove(word: CorrectWord) {
  const ok = await confirmDialog({
    title: `删除「${word.source} → ${word.target}」?`,
    message: `属于智能体「${agentName(word.agent_id)}」。设备下次连接时生效。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/correct-words/${word.id}`);
    toast('已删除');
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <PageHeader
    title="读音替换"
    description="语音合成之前,把回复里的词换成另一种写法再念出来,用来纠正多音字和专有名词的读音。"
  />

  <div class="callout info">
    <AppIcon name="info" :size="18" />
    <div class="callout-body">
      例如小单把「重庆」念成了 zhòng qìng,就添加一条「重庆 → 崇庆」。替换按智能体生效,设备下次连接时更新。
    </div>
  </div>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <section class="card">
    <div class="card-head"><div><h2><AppIcon name="plus" :size="18" />添加替换</h2></div></div>
    <form class="form-grid" @submit.prevent="add">
      <label class="field">
        <span class="field-label">智能体</span>
        <select v-model="agentId" class="select" :disabled="agents.length === 0">
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">原词</span>
        <input v-model="source" class="input" type="text" maxlength="64" placeholder="重庆" />
      </label>
      <label class="field">
        <span class="field-label">替换成</span>
        <input v-model="target" class="input" type="text" maxlength="64" placeholder="崇庆" />
      </label>
      <div class="field" style="justify-content: flex-end">
        <button class="btn btn-primary" type="submit" :aria-busy="adding" :disabled="agents.length === 0">
          <AppIcon name="plus" :size="16" /><span>添加</span>
        </button>
      </div>
    </form>
  </section>

  <section class="card">
    <div class="card-head">
      <div><h2><AppIcon name="replace" :size="18" />已有的替换 <span v-if="visible.length" class="count">{{ visible.length }}</span></h2></div>
      <div v-if="agents.length > 1" class="card-actions">
        <select v-model="filterAgent" class="select" style="height: 32px; width: auto" aria-label="按智能体筛选">
          <option value="">全部智能体</option>
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
        </select>
      </div>
    </div>
    <SkeletonRows v-if="loading" :rows="2" />
    <EmptyState
      v-else-if="visible.length === 0" title="还没有读音替换"
      description="听到小单把某个词念错时,在上面加一条替换。"
    />
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>原词 → 替换成</th><th>智能体</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="word in visible" :key="word.id">
            <td class="cell-main">
              <span class="word-pair">
                <span>{{ word.source }}</span><AppIcon name="arrowRight" :size="15" /><span>{{ word.target }}</span>
              </span>
            </td>
            <td><span class="tag">{{ agentName(word.agent_id) }}</span></td>
            <td class="actions">
              <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(word)">
                <AppIcon name="trash" :size="14" /><span>删除</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
