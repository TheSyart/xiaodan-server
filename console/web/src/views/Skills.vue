<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type Skill } from '../api';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import { confirmDialog, toast, toastError } from '../ui';

// 技能:一份写给智能体的「做法说明」,兼容 Agent Skills 的 SKILL.md。
// 智能体平时只看到技能的名字与描述,需要时才读正文,所以装很多技能也不会拖慢每轮对话。
// 这里增删改查;哪个智能体用哪些技能只在智能体页决定,技能本身没有启用开关。

const skills = ref<Skill[]>([]);
const loading = ref(true);
const loadError = ref('');
const expanded = ref<string | null>(null);

async function load() {
  loadError.value = '';
  try {
    skills.value = (await api.get<{ items: Skill[] }>('/skills')).items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function toMarkdown(skill: Skill): string {
  const tools = skill.allowed_tools ? `allowed-tools: ${skill.allowed_tools}\n` : '';
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n${tools}---\n${skill.body}\n`;
}

// ---- 编辑 ----
const editing = ref<{ name: string; markdown: string } | null>(null);
const saving = ref(false);
function openEdit(skill: Skill) {
  editing.value = { name: skill.name, markdown: toMarkdown(skill) };
}
async function saveEdit() {
  const e = editing.value;
  if (!e || saving.value) return;
  saving.value = true;
  try {
    await api.put(`/skills/${e.name}`, { markdown: e.markdown });
    toast('已保存,下一轮对话生效');
    editing.value = null;
    await load();
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}

// ---- 导入 ----
const importing = ref<{ markdown: string; replace: boolean } | null>(null);
const TEMPLATE = `---
name: my-skill
description: 一句话说明这个技能做什么、什么时候该用
allowed-tools: web_search
---
# 技能标题

## 怎么做
1. 第一步……
2. 第二步……
`;
async function importText() {
  const i = importing.value;
  if (!i || saving.value) return;
  saving.value = true;
  try {
    const result = await api.post<{ name: string }>('/skills/import', { markdown: i.markdown, replace: i.replace });
    toast(`已导入技能「${result.name}」`);
    importing.value = null;
    await load();
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 1024 * 1024) {
    toast('技能包不能超过 1 MB', 'warn');
    return;
  }
  const replace = importing.value?.replace ?? false;
  saving.value = true;
  try {
    const type = file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'text/markdown';
    const result = await api.postBlob<{ name: string; files: string[]; skipped: string[] }>(
      `/skills/import${replace ? '?replace=1' : ''}`, new Blob([await file.arrayBuffer()], { type }),
    );
    toast(`已导入技能「${result.name}」${result.files.length ? `,附带 ${result.files.length} 个文件` : ''}${result.skipped.length ? `;跳过了 ${result.skipped.length} 个非文本文件(不执行脚本)` : ''}`);
    importing.value = null;
    await load();
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}

async function remove(skill: Skill) {
  const ok = await confirmDialog({
    title: `删除技能「${skill.name}」?`,
    message: [
      skill.agents.length ? `${skill.agents.map((a) => a.name).join('、')}在用它,删除后它们不再有这个技能。` : '',
      skill.source === 'builtin' ? '这是内置技能,删除后控制塔下次启动会重新创建默认版本。' : '删除后无法恢复。',
    ].filter(Boolean).join(''),
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/skills/${skill.name}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <PageHeader title="技能" description="写给智能体的「做法说明」,兼容 Agent Skills 的 SKILL.md。这里新建、导入、编辑、删除;哪个智能体用哪些技能,在「智能体」页。">
    <template #actions>
      <button class="btn btn-primary" type="button" @click="importing = { markdown: TEMPLATE, replace: false }">
        <AppIcon name="plus" :size="16" /><span>导入或新建</span>
      </button>
    </template>
  </PageHeader>

  <div class="callout info">
    <AppIcon name="info" :size="18" />
    <div class="callout-body">
      智能体平时只看得到技能的名字与描述,用户的请求相关时才读出正文照着做。描述要写清「做什么、什么时候用」。
      技能包里的脚本不会执行,只读取文本文件。
    </div>
  </div>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>
  <div v-if="loading" class="card"><SkeletonRows :rows="3" /></div>

  <section v-else class="card">
    <EmptyState v-if="skills.length === 0" title="还没有技能" />
    <div v-for="skill in skills" :key="skill.name" class="model-row" style="flex-wrap: wrap">
      <div class="model-info">
        <div class="model-name">
          <span class="mono">{{ skill.name }}</span>
          <span v-if="skill.source === 'builtin'" class="tag sky">内置</span>
          <span v-if="skill.files.length" class="tag">{{ skill.files.length }} 个附带文件</span>
        </div>
        <div class="cell-sub">{{ skill.description }}</div>
        <div v-if="skill.allowed_tools" class="cell-sub">需要的工具:<span class="chip-mono">{{ skill.allowed_tools }}</span></div>
        <div class="cell-sub">
          在用它的智能体:<template v-if="skill.agents.length">{{ skill.agents.map((a) => a.name).join('、') }}</template><template v-else>还没有</template>
        </div>
      </div>
      <div class="row" style="gap: 2px">
        <button class="btn btn-ghost btn-sm" type="button" @click="expanded = expanded === skill.name ? null : skill.name">
          <AppIcon name="eye" :size="14" /><span>{{ expanded === skill.name ? '收起' : '查看' }}</span>
        </button>
        <button class="btn btn-ghost btn-sm" type="button" @click="openEdit(skill)"><AppIcon name="pencil" :size="14" /><span>编辑</span></button>
        <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(skill)"><AppIcon name="trash" :size="14" /><span>删除</span></button>
      </div>
      <pre v-if="expanded === skill.name" class="code-block" style="width: 100%; white-space: pre-wrap; margin: 10px 0 0">{{ skill.body }}</pre>
    </div>
    <p class="cell-sub" style="margin-top: 10px">在 <RouterLink to="/agents">智能体</RouterLink> 页决定哪个角色用哪些技能。</p>
  </section>

  <ModalDialog :open="!!editing" wide :title="`编辑技能「${editing?.name}」`" @close="editing = null">
    <form v-if="editing" id="skill-edit" class="stack" @submit.prevent="saveEdit">
      <textarea v-model="editing.markdown" class="textarea mono" rows="22" spellcheck="false"></textarea>
      <span class="field-hint">完整的 SKILL.md。name 不能改;要改名请导入一个新技能。allowed-tools 写它需要的工具,智能体开这个技能时会提示一起开启。</span>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="editing = null">取消</button>
      <button class="btn btn-primary" type="submit" form="skill-edit" :aria-busy="saving"><AppIcon name="check" :size="16" /><span>保存</span></button>
    </template>
  </ModalDialog>

  <ModalDialog :open="!!importing" wide title="导入或新建技能" @close="importing = null">
    <div v-if="importing" class="stack">
      <div class="row" style="gap: 8px; flex-wrap: wrap">
        <label class="btn">
          <AppIcon name="plus" :size="16" /><span>上传 SKILL.md 或 .zip 技能包</span>
          <input type="file" accept=".md,.zip,text/markdown,application/zip" class="visually-hidden" @change="importFile" />
        </label>
        <SwitchToggle v-model="importing.replace" label="覆盖同名技能" />
      </div>
      <span class="field-hint">或者直接在下面写 SKILL.md:</span>
      <textarea v-model="importing.markdown" class="textarea mono" rows="16" spellcheck="false"></textarea>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="importing = null">取消</button>
      <button class="btn btn-primary" type="button" :aria-busy="saving" @click="importText"><AppIcon name="check" :size="16" /><span>保存文字版</span></button>
    </template>
  </ModalDialog>
</template>
