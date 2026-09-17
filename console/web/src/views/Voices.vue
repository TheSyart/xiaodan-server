<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type Catalog, type Model, type Voice, type VoiceProfile } from '../api';
import { playBase64Wav, playBlob, startRecording, stopPlayback, toWav16k, type Recorder } from '../audio';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import { confirmDialog, toast, toastError } from '../ui';
import { composeInstruction, instructionUnits, profileOf } from '../voice-profile';

// 音色是智能体「怎么说话」的全部:百炼里的哪个音色,加上语种、方言、音量、语速、固定语气与允许的情感标签。
// 每个智能体只选一个音色。系统音色随千问合成模型自动列出;复刻与设计出的音色在这里新增。

const voices = ref<Voice[]>([]);
const models = ref<Model[]>([]);
const catalog = ref<Catalog | null>(null);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [v, m, c] = await Promise.all([
      api.get<{ items: Voice[] }>('/voices'),
      api.get<{ items: Model[] }>('/models'),
      api.get<Catalog>('/catalog'),
    ]);
    voices.value = v.items;
    models.value = m.items.filter((item) => item.model_type === 'TTS' && item.provider === 'qwen_audio_tts');
    catalog.value = c;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const vc = computed(() => catalog.value?.voice);
const defaultModelId = computed(() => (models.value.find((m) => m.is_default === 1 && m.enabled === 1) ?? models.value[0])?.id ?? '');

// ---- 筛选 ----

type KindFilter = 'all' | 'system' | 'clone' | 'design' | 'variant';
const filter = ref({ kind: 'all' as KindFilter, model: '', language: '', audience: '', search: '', inUse: false });
const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'system', label: '系统音色' },
  { value: 'clone', label: '复刻' },
  { value: 'design', label: '设计' },
  { value: 'variant', label: '我的变体' },
];

const shown = computed(() => {
  const f = filter.value;
  const q = f.search.trim().toLowerCase();
  return voices.value.filter((voice) => {
    if (f.kind === 'variant' ? !voice.parent_id : f.kind !== 'all' && voice.kind !== f.kind) return false;
    if (f.model && voice.tts_model_id !== f.model) return false;
    if (f.language && !voice.languages.includes(f.language)) return false;
    if (f.audience === 'child' && !(voice.age !== null && voice.age < 12)) return false;
    if (f.audience === 'adult' && voice.age !== null && voice.age < 12) return false;
    if (f.inUse && voice.agent_count === 0) return false;
    if (q && !`${voice.name} ${voice.voice} ${voice.description} ${voice.summary}`.toLowerCase().includes(q)) return false;
    return true;
  });
});

const KIND_LABEL: Record<Voice['kind'], string> = { system: '系统', design: '设计', clone: '复刻' };
const KIND_TONE: Record<Voice['kind'], string> = { system: 'tone-sky', design: 'tone-violet', clone: 'tone-grass' };
const STATUS_LABEL: Record<Voice['status'], { text: string; tone: string }> = {
  ok: { text: '可用', tone: 'ok' },
  pending: { text: '审核中', tone: 'warn' },
  failed: { text: '未通过', tone: 'danger' },
};
const nameOf = (id: string | null) => voices.value.find((voice) => voice.id === id)?.name ?? '';

// ---- 试听 ----

const previewing = ref('');
async function preview(voice: Voice, draft?: VoiceProfile, text?: string) {
  if (voice.status !== 'ok') {
    toast('这个音色还没通过审核,暂时不能试听。', 'warn');
    return;
  }
  previewing.value = voice.id;
  try {
    const blob = await api.postForBlob('/voices/preview', {
      voice_id: voice.id,
      ...(draft ? { draft } : {}),
      ...(text?.trim() ? { text: text.trim() } : {}),
    });
    await playBlob(blob);
  } catch (e) {
    toastError(e);
  } finally {
    previewing.value = '';
  }
}

// ---- 说话设置 ----

interface Editing {
  voice: Voice;
  name: string;
  description: string;
  profile: VoiceProfile;
  sample: string;
  advanced: boolean;
}
const editing = ref<Editing | null>(null);
const saving = ref(false);

function openSettings(voice: Voice) {
  editing.value = { voice, name: voice.name, description: voice.description, profile: profileOf(voice), sample: '', advanced: voice.pitch !== 1 };
}

const instruction = computed(() => (editing.value && vc.value ? composeInstruction(editing.value.profile, vc.value) : ''));
const units = computed(() => instructionUnits(instruction.value));
const tooLong = computed(() => units.value > (vc.value?.instruction_units ?? 100));
const languageOptions = computed(() =>
  editing.value && vc.value ? vc.value.languages.filter((item) => editing.value!.voice.languages.includes(item.label)) : []);

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function setLanguage(language: string) {
  if (!editing.value) return;
  editing.value.profile.language = language;
  if (language !== '中文') editing.value.profile.dialect = '';
}

async function saveSettings(asNew: boolean) {
  const e = editing.value;
  if (!e || saving.value) return;
  if (tooLong.value) {
    toast('语气说明太长了,减掉几个语气标签或缩短补充说明。', 'warn');
    return;
  }
  saving.value = true;
  try {
    if (asNew) {
      const name = e.name.trim() && e.name.trim() !== e.voice.name ? e.name.trim() : `${e.voice.name}(副本)`;
      const result = await api.post<{ id: string }>(`/voices/${encodeURIComponent(e.voice.id)}/duplicate`, { name: name.slice(0, 64), profile: e.profile });
      toast(`已另存为「${name}」`);
      editing.value = null;
      await load();
      const created = voices.value.find((voice) => voice.id === result.id);
      if (created) openSettings(created);
    } else {
      await api.put(`/voices/${encodeURIComponent(e.voice.id)}`, { name: e.name.trim() || e.voice.name, description: e.description, profile: e.profile });
      toast(e.voice.agent_count ? '已保存。用这个音色的设备下次连接时生效。' : '已保存');
      editing.value = null;
      await load();
    }
  } catch (error) {
    toastError(error);
  } finally {
    saving.value = false;
  }
}

async function duplicate(voice: Voice) {
  try {
    const result = await api.post<{ id: string }>(`/voices/${encodeURIComponent(voice.id)}/duplicate`, {});
    await load();
    const created = voices.value.find((item) => item.id === result.id);
    toast('已复制,可以改成另一种说话方式');
    if (created) openSettings(created);
  } catch (e) {
    toastError(e);
  }
}

async function remove(voice: Voice) {
  const shared = voices.value.some((item) => item.id !== voice.id && item.tts_model_id === voice.tts_model_id && item.voice === voice.voice);
  const cloud = voice.kind !== 'system' && !shared;
  const ok = await confirmDialog({
    title: `删除音色「${voice.name}」?`,
    message: [
      shared ? '只删这一份说话设置,百炼里的音色留给其他同源的音色继续用。' : cloud ? '会同时在百炼侧删除,删除后无法恢复。' : '',
      voice.agent_count > 0 ? `有 ${voice.agent_count} 个智能体在用它,删除后它们改用默认音色。` : '',
    ].filter(Boolean).join('') || '系统音色删除后,下次打开本页会以默认设置重新出现。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/voices/${encodeURIComponent(voice.id)}`);
    toast('已删除');
  } catch (e) {
    const err = e as Error;
    const force = cloud && (await confirmDialog({
      title: '百炼侧删除失败',
      message: `${err.message}。要只删除控制塔里的记录吗?百炼里的音色会继续占用配额。`,
      confirmText: '只删本地记录',
      danger: true,
    }));
    if (!force) return;
    try {
      await api.del(`/voices/${encodeURIComponent(voice.id)}?local_only=1`);
      toast('已删除本地记录');
    } catch (again) {
      toastError(again);
      return;
    }
  }
  await load();
}

async function refresh(voice: Voice) {
  try {
    const result = await api.post<{ status: Voice['status'] }>(`/voices/${encodeURIComponent(voice.id)}/refresh`);
    toast(result.status === 'ok' ? '审核已通过,可以使用了' : result.status === 'failed' ? '审核未通过' : '还在审核中,稍后再刷新', result.status === 'failed' ? 'warn' : 'info');
    await load();
  } catch (e) {
    toastError(e);
  }
}

// ---- 按 ID 添加基础音色 ----

const manual = ref<{ model: string; name: string; voice: string } | null>(null);
const savingManual = ref(false);
async function saveManual() {
  const m = manual.value;
  if (!m || savingManual.value) return;
  if (!m.voice.trim()) {
    toast('请填写音色 ID。', 'warn');
    return;
  }
  savingManual.value = true;
  try {
    const result = await api.post<{ id: string }>('/voices', { tts_model_id: m.model, name: m.name.trim() || m.voice.trim(), voice: m.voice.trim() });
    manual.value = null;
    await load();
    const created = voices.value.find((voice) => voice.id === result.id);
    toast('已添加');
    if (created) openSettings(created);
  } catch (e) {
    toastError(e);
  } finally {
    savingManual.value = false;
  }
}

// ---- 声音设计 ----

const design = ref<{ model: string; name: string; prompt: string; preview_text: string; language: string } | null>(null);
const designing = ref(false);
function openDesign() {
  design.value = { model: defaultModelId.value, name: '', prompt: '', preview_text: '从前有一只小兔子,它最喜欢在月光下的草地上散步。', language: 'zh' };
}
async function createDesign() {
  const d = design.value;
  if (!d || designing.value) return;
  if (!d.name.trim() || d.prompt.trim().length < 4 || d.preview_text.trim().length < 15) {
    toast('请填写名称、至少 4 个字的声音描述,以及 15 字以上的试听文本。', 'warn');
    return;
  }
  designing.value = true;
  try {
    const result = await api.post<{ id: string; status: Voice['status']; preview: string | null }>('/voices/design', {
      tts_model_id: d.model, name: d.name.trim(), prompt: d.prompt.trim(), preview_text: d.preview_text.trim(), language: d.language,
    });
    toast(result.status === 'ok' ? '已生成,可以使用了' : '已生成,正在审核', 'success');
    if (result.preview) await playBase64Wav(result.preview);
    design.value = null;
    await load();
    const created = voices.value.find((voice) => voice.id === result.id);
    if (created) openSettings(created);
  } catch (e) {
    toastError(e);
  } finally {
    designing.value = false;
  }
}

// ---- 声音复刻 ----

const clone = ref<{ model: string; name: string; language: string; consent: boolean } | null>(null);
const sampleWav = ref<Blob | null>(null);
const sampleSeconds = ref(0);
const recorder = ref<Recorder | null>(null);
const recordStartedAt = ref(0);
const now = ref(Date.now());
let ticker: number | undefined;
const cloning = ref(false);

function openClone() {
  clone.value = { model: defaultModelId.value, name: '', language: 'zh', consent: false };
  sampleWav.value = null;
}

async function useFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) {
    toast('文件太大了,请截取 10 到 20 秒的片段。', 'warn');
    return;
  }
  await acceptSample(file);
}

async function acceptSample(blob: Blob) {
  try {
    const { wav, seconds } = await toWav16k(blob);
    if (seconds < 5) {
      toast(`样本只有 ${seconds.toFixed(1)} 秒,至少要 5 秒连续清晰的说话,建议 10 到 20 秒。`, 'warn');
      return;
    }
    sampleWav.value = wav;
    sampleSeconds.value = seconds;
  } catch {
    toast('无法解析这个音频文件,请换成 WAV、MP3 或 M4A。', 'error');
  }
}

async function toggleRecording() {
  if (recorder.value) {
    const r = recorder.value;
    recorder.value = null;
    window.clearInterval(ticker);
    await acceptSample(await r.stop());
    return;
  }
  try {
    recorder.value = await startRecording();
    recordStartedAt.value = Date.now();
    now.value = Date.now();
    ticker = window.setInterval(() => {
      now.value = Date.now();
      if (now.value - recordStartedAt.value > 30_000) void toggleRecording();
    }, 250);
  } catch (e) {
    toastError(e);
  }
}

const recordedSeconds = computed(() => Math.floor((now.value - recordStartedAt.value) / 1000));

async function createClone() {
  const c = clone.value;
  if (!c || cloning.value) return;
  if (!c.name.trim() || !sampleWav.value) {
    toast('请填写名称,并上传或录制一段样本。', 'warn');
    return;
  }
  if (!c.consent) {
    toast('请先确认你有权使用这段声音。', 'warn');
    return;
  }
  cloning.value = true;
  try {
    const query = new URLSearchParams({ tts_model_id: c.model, name: c.name.trim(), language: c.language, consent: '1' });
    const result = await api.postBlob<{ id: string; status: Voice['status'] }>(`/voices/clone?${query}`, sampleWav.value);
    toast(result.status === 'ok' ? '复刻完成,可以使用了' : '已提交,正在审核');
    clone.value = null;
    sampleWav.value = null;
    await load();
    const created = voices.value.find((voice) => voice.id === result.id);
    if (created) openSettings(created);
  } catch (e) {
    toastError(e);
  } finally {
    cloning.value = false;
  }
}

function closeClone() {
  recorder.value?.cancel();
  recorder.value = null;
  window.clearInterval(ticker);
  clone.value = null;
}

onBeforeUnmount(() => {
  stopPlayback();
  recorder.value?.cancel();
  window.clearInterval(ticker);
});
</script>

<template>
  <PageHeader title="音色" description="智能体用什么声音、怎么说话。每个智能体选一个音色;音量、语速、方言、语气都跟着音色走。">
    <template #actions>
      <button class="btn" type="button" :disabled="!models.length" @click="manual = { model: defaultModelId, name: '', voice: '' }">
        <AppIcon name="pencil" :size="16" /><span>按 ID 添加</span>
      </button>
      <button class="btn" type="button" :disabled="!models.length" @click="openDesign"><AppIcon name="sparkles" :size="16" /><span>新增设计</span></button>
      <button class="btn btn-primary" type="button" :disabled="!models.length" @click="openClone"><AppIcon name="mic" :size="16" /><span>新增复刻</span></button>
    </template>
  </PageHeader>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <template v-else>
    <div v-if="models.length === 0" class="card">
      <EmptyState title="还没有千问语音合成模型" description="先在「模型」页添加一个「千问语音合成」,填入百炼 API Key,系统音色会自动出现在这里。">
        <RouterLink class="btn btn-primary" to="/models"><AppIcon name="layers" :size="16" /><span>去模型页</span></RouterLink>
      </EmptyState>
    </div>

    <template v-else>
      <div class="card voice-filters">
        <div class="chips" role="group" aria-label="按来源筛选">
          <button
            v-for="item in KIND_FILTERS" :key="item.value" class="chip-toggle" type="button"
            :aria-pressed="filter.kind === item.value" @click="filter.kind = item.value"
          >{{ item.label }}</button>
        </div>
        <div class="voice-filter-row">
          <select v-if="models.length > 1" v-model="filter.model" class="select" aria-label="合成模型">
            <option value="">全部合成模型</option>
            <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
          </select>
          <select v-model="filter.language" class="select" aria-label="语种">
            <option value="">全部语种</option>
            <option v-for="item in vc?.languages ?? []" :key="item.code" :value="item.label">{{ item.label }}</option>
          </select>
          <select v-model="filter.audience" class="select" aria-label="年龄">
            <option value="">大人与小孩</option>
            <option value="child">小孩的声音</option>
            <option value="adult">大人的声音</option>
          </select>
          <input v-model="filter.search" class="input" type="search" placeholder="搜名称、音色 ID、描述" aria-label="搜索音色" />
          <SwitchToggle v-model="filter.inUse" label="只看在用" />
        </div>
      </div>

      <div v-if="shown.length === 0" class="card">
        <EmptyState title="没有符合条件的音色" description="换个筛选条件,或者新增一个复刻、设计音色。" />
      </div>

      <div class="voice-grid">
        <article v-for="voice in shown" :key="voice.id" class="card voice-card">
          <div class="agent-card-head">
            <span class="avatar" :class="KIND_TONE[voice.kind]" style="width: 40px; height: 40px">{{ voice.name.slice(0, 1) }}</span>
            <div style="flex: 1; min-width: 0">
              <h3 class="truncate" :title="voice.name">{{ voice.name }}</h3>
              <div class="cell-sub truncate" :title="voice.voice"><span class="chip-mono">{{ voice.voice }}</span></div>
            </div>
          </div>
          <div class="chips">
            <span class="tag">{{ KIND_LABEL[voice.kind] }}</span>
            <span v-if="voice.parent_id" class="tag violet">基于 {{ nameOf(voice.parent_id) || '原音色' }}</span>
            <span v-if="voice.status !== 'ok'" class="tag dot" :class="STATUS_LABEL[voice.status].tone">{{ STATUS_LABEL[voice.status].text }}</span>
            <span v-if="!voice.compatible" class="tag danger" title="flash 与 plus 的音色不能混用">不适用于{{ voice.model_label }}</span>
            <span v-if="voice.agent_count" class="tag sky" :title="voice.agents.map((a) => a.name).join('、')">{{ voice.agent_count }} 个智能体在用</span>
            <span v-if="models.length > 1" class="tag">{{ voice.model_label }}</span>
          </div>
          <p v-if="voice.description || voice.prompt" class="voice-desc">{{ voice.kind === 'design' && voice.prompt ? voice.prompt : voice.description }}</p>
          <p class="voice-summary"><AppIcon name="sliders" :size="14" /><span>{{ voice.summary }}</span></p>
          <div class="agent-card-foot">
            <button v-if="voice.status !== 'ok'" class="btn btn-ghost btn-sm" type="button" @click="refresh(voice)">
              <AppIcon name="refresh" :size="14" /><span>刷新状态</span>
            </button>
            <button v-else class="btn btn-ghost btn-sm" type="button" :aria-busy="previewing === voice.id" @click="preview(voice)">
              <AppIcon name="volume" :size="14" /><span>试听</span>
            </button>
            <button class="btn btn-ghost btn-sm" type="button" @click="openSettings(voice)"><AppIcon name="sliders" :size="14" /><span>设置</span></button>
            <button class="btn btn-ghost btn-sm" type="button" @click="duplicate(voice)"><AppIcon name="copy" :size="14" /><span>复制</span></button>
            <span style="flex: 1"></span>
            <button class="btn btn-ghost btn-sm btn-icon danger" type="button" :aria-label="`删除 ${voice.name}`" @click="remove(voice)"><AppIcon name="trash" :size="14" /></button>
          </div>
        </article>
      </div>
    </template>
  </template>

  <!-- 说话设置 -->
  <ModalDialog :open="!!editing" wide :title="editing ? `音色设置 · ${editing.voice.name}` : ''" @close="editing = null">
    <form v-if="editing && vc" id="voice-settings" class="stack" @submit.prevent="saveSettings(false)">
      <div class="form-grid">
        <label class="field">
          <span class="field-label">名称</span>
          <input v-model="editing.name" class="input" type="text" maxlength="64" />
        </label>
        <label class="field">
          <span class="field-label">说明</span>
          <input v-model="editing.description" class="input" type="text" maxlength="200" placeholder="给自己看的一句话" />
        </label>
      </div>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">语种</span>
          <select class="select" :value="editing.profile.language" @change="setLanguage(($event.target as HTMLSelectElement).value)">
            <option v-for="item in languageOptions" :key="item.code" :value="item.label">{{ item.label }}</option>
          </select>
          <span class="field-hint">这个音色说哪种语言,智能体会用这个语言回复。</span>
        </label>
        <label class="field">
          <span class="field-label">方言</span>
          <select v-model="editing.profile.dialect" class="select" :disabled="editing.profile.language !== '中文'">
            <option value="">普通话(不用方言)</option>
            <option v-for="dialect in vc.dialects" :key="dialect" :value="dialect">{{ dialect }}</option>
          </select>
          <span class="field-hint">靠语气指令实现,效果因音色而异,先试听再保存。</span>
        </label>
        <label class="field">
          <span class="field-label">音量 {{ editing.profile.volume }}</span>
          <input v-model.number="editing.profile.volume" type="range" min="0" max="100" step="1" />
        </label>
        <label class="field">
          <span class="field-label">语速 {{ Number(editing.profile.rate).toFixed(2) }}</span>
          <input v-model.number="editing.profile.rate" type="range" min="0.5" max="2" step="0.05" />
        </label>
      </div>

      <details :open="editing.advanced" @toggle="editing.advanced = ($event.target as HTMLDetailsElement).open">
        <summary class="field-label" style="cursor: pointer">高级</summary>
        <label class="field" style="margin-top: 10px; max-width: 320px">
          <span class="field-label">音调 {{ Number(editing.profile.pitch).toFixed(2) }}</span>
          <input v-model.number="editing.profile.pitch" type="range" min="0.5" max="2" step="0.05" />
        </label>
      </details>

      <div class="field">
        <span class="field-label">语气标签</span>
        <div class="chips">
          <button
            v-for="chip in vc.tone_chips" :key="chip.id" class="chip-toggle" type="button" :aria-pressed="editing.profile.tone_tags.includes(chip.id)"
            @click="editing.profile.tone_tags = toggle(editing.profile.tone_tags, chip.id)"
          >{{ chip.label }}</button>
        </div>
        <input v-model="editing.profile.tone_text" class="input" type="text" maxlength="50" placeholder="补充说明(可选),例如:带一点笑意,像哄小朋友睡觉" />
        <div class="instruction-preview" :class="{ over: tooLong }">
          <span>合成指令:{{ instruction || '(无,按音色本来的语气说)' }}</span>
          <span class="nowrap">已用 {{ units }}/{{ vc.instruction_units }}</span>
        </div>
      </div>

      <div class="field">
        <span class="field-label">
          允许的情感标签
          <button class="btn btn-ghost btn-sm" type="button" @click="editing.profile.emotion_tags = [...vc.recommended_tags]">推荐组合</button>
          <button class="btn btn-ghost btn-sm" type="button" @click="editing.profile.emotion_tags = []">清空</button>
        </span>
        <span class="field-hint">勾上的标签,智能体可以按内容插在句子里,让这一句带情绪,或者笑出声、叹口气;屏幕字幕里不会出现。都不勾就不用。</span>
        <div class="tag-group">
          <span class="small muted">情绪(管一整句)</span>
          <div class="chips">
            <button
              v-for="item in vc.control_tags" :key="item.tag" class="chip-toggle" type="button" :title="`[${item.tag}]`"
              :aria-pressed="editing.profile.emotion_tags.includes(item.tag)"
              @click="editing.profile.emotion_tags = toggle(editing.profile.emotion_tags, item.tag)"
            >{{ item.label }}</button>
          </div>
          <span class="small muted">声音(插在出声的位置)</span>
          <div class="chips">
            <button
              v-for="item in vc.rich_tags" :key="item.tag" class="chip-toggle" type="button" :title="`[${item.tag}]`"
              :aria-pressed="editing.profile.emotion_tags.includes(item.tag)"
              @click="editing.profile.emotion_tags = toggle(editing.profile.emotion_tags, item.tag)"
            >{{ item.label }}</button>
          </div>
        </div>
      </div>

      <div class="field">
        <span class="field-label">试听</span>
        <div class="row" style="gap: 8px">
          <input v-model="editing.sample" class="input" type="text" maxlength="300" placeholder="留空用这个语种的问候语;可以写 [excited] 这样的标签试效果" style="flex: 1; min-width: 0" />
          <button
            class="btn" type="button" :disabled="editing.voice.status !== 'ok' || tooLong" :aria-busy="previewing === editing.voice.id"
            @click="preview(editing.voice, editing.profile, editing.sample)"
          ><AppIcon name="volume" :size="16" /><span>试听</span></button>
        </div>
      </div>

      <div v-if="editing.voice.agent_count" class="callout info" style="margin: 0">
        <AppIcon name="info" :size="16" />
        <div class="callout-body">{{ editing.voice.agents.map((a) => a.name).join('、') }} 在用这个音色,保存后设备下次连接时生效。只想给其中一个智能体换说话方式,点「另存为新音色」,再去智能体里选它。</div>
      </div>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="editing = null">取消</button>
      <button class="btn" type="button" :aria-busy="saving" :disabled="tooLong" @click="saveSettings(true)"><AppIcon name="copy" :size="16" /><span>另存为新音色</span></button>
      <button class="btn btn-primary" type="submit" form="voice-settings" :aria-busy="saving" :disabled="tooLong"><AppIcon name="check" :size="16" /><span>保存</span></button>
    </template>
  </ModalDialog>

  <!-- 声音复刻 -->
  <ModalDialog :open="!!clone" wide title="新增复刻音色" @close="closeClone">
    <form v-if="clone" id="clone-form" class="stack" @submit.prevent="createClone">
      <p class="field-hint" style="margin: 0">用一段 10 到 20 秒的清晰说话声复刻出一个音色。要安静环境、一个人说话、不要背景音乐。创建后百炼要审核,通过了才能用。</p>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">名称<span class="req">*</span></span>
          <input v-model="clone.name" class="input" type="text" maxlength="64" placeholder="妈妈的声音" />
        </label>
        <label class="field">
          <span class="field-label">样本的语种</span>
          <select v-model="clone.language" class="select">
            <option v-for="item in vc?.languages ?? []" :key="item.code" :value="item.code">{{ item.label }}</option>
          </select>
        </label>
        <label v-if="models.length > 1" class="field">
          <span class="field-label">合成模型</span>
          <select v-model="clone.model" class="select">
            <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
          </select>
          <span class="field-hint">复刻出的音色只能用于这个合成模型。</span>
        </label>
      </div>
      <div class="row" style="flex-wrap: wrap; gap: 8px">
        <label class="btn">
          <AppIcon name="plus" :size="16" /><span>上传音频</span>
          <input type="file" accept="audio/*" class="visually-hidden" @change="useFile" />
        </label>
        <button class="btn" :class="{ 'btn-danger': recorder }" type="button" @click="toggleRecording">
          <AppIcon name="mic" :size="16" /><span>{{ recorder ? `停止录音(${recordedSeconds} 秒)` : '现场录音' }}</span>
        </button>
        <template v-if="sampleWav">
          <span class="tag ok">样本 {{ sampleSeconds.toFixed(1) }} 秒</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="playBlob(sampleWav!)"><AppIcon name="volume" :size="14" /><span>回放</span></button>
        </template>
      </div>
      <label class="row" style="gap: 8px; align-items: flex-start">
        <input v-model="clone.consent" type="checkbox" style="margin-top: 3px" />
        <span class="small">我确认这段声音是我本人的,或已取得声音主人的明确同意,并对其合法使用负责。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="closeClone">取消</button>
      <button class="btn btn-primary" type="submit" form="clone-form" :aria-busy="cloning" :disabled="!sampleWav || !clone?.consent">
        <AppIcon name="mic" :size="16" /><span>开始复刻</span>
      </button>
    </template>
  </ModalDialog>

  <!-- 声音设计 -->
  <ModalDialog :open="!!design" wide title="新增设计音色" @close="design = null">
    <form v-if="design" id="design-form" class="stack" @submit.prevent="createDesign">
      <p class="field-hint" style="margin: 0">用一段文字描述想要的声音,百炼生成一个新音色并先念一段给你听。描述声音特征即可,不支持模仿真人。</p>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">名称<span class="req">*</span></span>
          <input v-model="design.name" class="input" type="text" maxlength="64" placeholder="讲故事的姐姐" />
        </label>
        <label class="field">
          <span class="field-label">语种</span>
          <select v-model="design.language" class="select">
            <option v-for="item in vc?.languages ?? []" :key="item.code" :value="item.code">{{ item.label }}</option>
          </select>
        </label>
        <label v-if="models.length > 1" class="field">
          <span class="field-label">合成模型</span>
          <select v-model="design.model" class="select">
            <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="field-label">声音描述<span class="req">*</span></span>
        <textarea v-model="design.prompt" class="textarea" rows="3" maxlength="500" placeholder="温柔的年轻女声,音色清亮,语速稍慢,带一点笑意,适合给小朋友讲睡前故事"></textarea>
        <span class="field-hint">写清性别、年龄感、音色、语速、情绪与适用场景,只支持中文或英文描述,最多 500 字。</span>
      </label>
      <label class="field">
        <span class="field-label">试听文本<span class="req">*</span></span>
        <input v-model="design.preview_text" class="input" type="text" maxlength="200" />
        <span class="field-hint">15 到 200 字,生成后会用新音色念这句话。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="design = null">取消</button>
      <button class="btn btn-primary" type="submit" form="design-form" :aria-busy="designing"><AppIcon name="sparkles" :size="16" /><span>生成音色</span></button>
    </template>
  </ModalDialog>

  <!-- 按 ID 添加 -->
  <ModalDialog :open="!!manual" title="按 ID 添加基础音色" @close="manual = null">
    <form v-if="manual" id="manual-voice-form" class="stack" @submit.prevent="saveManual">
      <p class="field-hint" style="margin: 0">百炼另有五百多个基础音色,ID 形如 qwen-audio-3.0-tts-flash-xxx,在百炼文档的音色列表里下载。</p>
      <label class="field">
        <span class="field-label">音色 ID<span class="req">*</span></span>
        <input v-model="manual.voice" class="input mono" type="text" placeholder="qwen-audio-3.0-tts-flash-longyaoxuanke" />
      </label>
      <label class="field">
        <span class="field-label">显示名称</span>
        <input v-model="manual.name" class="input" type="text" maxlength="64" />
      </label>
      <label v-if="models.length > 1" class="field">
        <span class="field-label">合成模型</span>
        <select v-model="manual.model" class="select">
          <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
        </select>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="manual = null">取消</button>
      <button class="btn btn-primary" type="submit" form="manual-voice-form" :aria-busy="savingManual">
        <AppIcon name="check" :size="16" /><span>添加</span>
      </button>
    </template>
  </ModalDialog>
</template>
