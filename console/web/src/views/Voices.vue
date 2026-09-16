<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type Model, type Voice } from '../api';
import { playBase64Wav, playBlob, startRecording, stopPlayback, toWav16k, type Recorder } from '../audio';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, promptDialog, relativeTime, toast, toastError } from '../ui';

// 音色挂在语音合成模型下。千问合成支持系统音色、声音设计与声音复刻;别家模型只能手动填音色名。

const models = ref<Model[]>([]);
const voices = ref<Voice[]>([]);
const loading = ref(true);
const loadError = ref('');
const modelId = ref('');

async function load() {
  loadError.value = '';
  try {
    const [m, v] = await Promise.all([
      api.get<{ items: Model[] }>('/models'),
      api.get<{ items: Voice[] }>('/voices'),
    ]);
    models.value = m.items.filter((item) => item.model_type === 'TTS');
    voices.value = v.items;
    if (!models.value.some((item) => item.id === modelId.value)) {
      modelId.value = (models.value.find((item) => item.provider === 'qwen_audio_tts') ?? models.value[0])?.id ?? '';
    }
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const model = computed(() => models.value.find((item) => item.id === modelId.value));
const isQwen = computed(() => model.value?.provider === 'qwen_audio_tts');
const ofModel = computed(() => voices.value.filter((voice) => voice.tts_model_id === modelId.value));
const systemVoices = computed(() => ofModel.value.filter((voice) => voice.kind === 'system'));
const customVoices = computed(() => ofModel.value.filter((voice) => voice.kind !== 'system'));
const tagsOf = (voice: Voice) => voice.tags.split(',').map((tag) => tag.trim()).filter(Boolean);

// ---- 试听 ----

const sample = ref({ text: '你好呀,我是小单。今天想聊点什么?', rate: 1, pitch: 1, volume: 50, instruction: '' });
const previewing = ref('');

async function preview(voice: Voice) {
  if (voice.status !== 'ok') {
    toast('这个音色还没通过审核,暂时不能试听。', 'warn');
    return;
  }
  previewing.value = voice.id;
  try {
    const blob = await api.postForBlob('/voices/preview', {
      tts_model_id: voice.tts_model_id,
      voice: voice.voice,
      text: sample.value.text.trim() || '你好呀,我是小单。',
      rate: Number(sample.value.rate),
      pitch: Number(sample.value.pitch),
      volume: Number(sample.value.volume),
      ...(sample.value.instruction.trim() ? { instruction: sample.value.instruction.trim() } : {}),
    });
    await playBlob(blob);
  } catch (e) {
    toastError(e);
  } finally {
    previewing.value = '';
  }
}

// ---- 系统音色 ----

const importing = ref(false);
async function importSystem() {
  if (importing.value) return;
  importing.value = true;
  try {
    const result = await api.post<{ added: number }>('/voices/import-system', { tts_model_id: modelId.value });
    toast(result.added ? `已导入 ${result.added} 个系统音色` : '系统音色都已经在列表里了');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    importing.value = false;
  }
}

const manual = ref<{ name: string; voice: string; languages: string } | null>(null);
const savingManual = ref(false);
async function saveManual() {
  const m = manual.value;
  if (!m || savingManual.value) return;
  if (!m.voice.trim()) {
    toast('请填写音色名(传给服务商的值)。', 'warn');
    return;
  }
  savingManual.value = true;
  try {
    const id = `${modelId.value}__${m.voice.trim()}`.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 128);
    await api.post('/voices', {
      id, tts_model_id: modelId.value, name: m.name.trim() || m.voice.trim(), voice: m.voice.trim(),
      languages: m.languages.trim() || '中文',
    });
    manual.value = null;
    toast('已添加');
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    savingManual.value = false;
  }
}

async function rename(voice: Voice) {
  const name = await promptDialog({
    title: '修改显示名称',
    input: { label: '名称', value: voice.name, maxlength: 64 },
    confirmText: '保存',
  });
  if (name === null || !name.trim() || name.trim() === voice.name) return;
  try {
    await api.put(`/voices/${encodeURIComponent(voice.id)}`, {
      name: name.trim(), description: voice.description, tags: voice.tags, languages: voice.languages,
    });
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function remove(voice: Voice) {
  const cloud = voice.kind !== 'system';
  const ok = await confirmDialog({
    title: `删除音色「${voice.name}」?`,
    message: [
      cloud ? '会同时在百炼侧删除,删除后无法恢复。' : '',
      voice.agent_count > 0 ? `有 ${voice.agent_count} 个智能体在用它,删除后它们改用模型默认音色。` : '',
    ].filter(Boolean).join('') || '删除后无法恢复。',
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

// ---- 声音设计 ----

const design = ref({ name: '', prompt: '', preview_text: '从前有一只小兔子,它最喜欢在月光下的草地上散步。', language: 'zh' as 'zh' | 'en' });
const designing = ref(false);
async function createDesign() {
  const d = design.value;
  if (designing.value) return;
  if (!d.name.trim() || d.prompt.trim().length < 4 || d.preview_text.trim().length < 15) {
    toast('请填写名称、至少 4 个字的声音描述,以及 15 字以上的试听文本。', 'warn');
    return;
  }
  designing.value = true;
  try {
    const result = await api.post<{ status: Voice['status']; preview: string | null }>('/voices/design', {
      tts_model_id: modelId.value, name: d.name.trim(), prompt: d.prompt.trim(),
      preview_text: d.preview_text.trim(), language: d.language,
    });
    toast(result.status === 'ok' ? '已生成,可以使用了' : '已生成,正在审核', 'success');
    if (result.preview) await playBase64Wav(result.preview);
    design.value = { ...d, name: '', prompt: '' };
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    designing.value = false;
  }
}

// ---- 声音复刻 ----

const clone = ref({ name: '', language: 'zh' as 'zh' | 'en', consent: false });
const sampleWav = ref<Blob | null>(null);
const sampleSeconds = ref(0);
const recorder = ref<Recorder | null>(null);
const recordStartedAt = ref(0);
const now = ref(Date.now());
let ticker: number | undefined;
const cloning = ref(false);

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
  if (cloning.value) return;
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
    const query = new URLSearchParams({
      tts_model_id: modelId.value, name: c.name.trim(), language: c.language, consent: '1',
    });
    const result = await api.postBlob<{ status: Voice['status'] }>(`/voices/clone?${query}`, sampleWav.value);
    toast(result.status === 'ok' ? '复刻完成,可以使用了' : '已提交,正在审核');
    clone.value = { name: '', language: c.language, consent: false };
    sampleWav.value = null;
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    cloning.value = false;
  }
}

watch(modelId, () => stopPlayback());
onBeforeUnmount(() => {
  stopPlayback();
  recorder.value?.cancel();
  window.clearInterval(ticker);
});

const STATUS_LABEL: Record<Voice['status'], { text: string; tone: string }> = {
  ok: { text: '可用', tone: 'ok' },
  pending: { text: '审核中', tone: 'warn' },
  failed: { text: '未通过', tone: 'danger' },
};
const KIND_LABEL: Record<Voice['kind'], string> = { system: '系统', design: '设计', clone: '复刻' };
</script>

<template>
  <PageHeader
    title="音色"
    description="小单用什么声音说话。千问语音合成支持系统音色、用文字描述设计音色、用一段录音复刻音色;智能体在编辑页里挑选。"
  />

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <template v-else>
    <div v-if="models.length === 0" class="card">
      <EmptyState title="还没有语音合成模型" description="先在「模型」页添加一个「千问语音合成」,填入百炼 API Key。">
        <RouterLink class="btn btn-primary" to="/models"><AppIcon name="layers" :size="16" /><span>去模型页</span></RouterLink>
      </EmptyState>
    </div>

    <template v-else>
      <section class="card">
        <div class="card-head">
          <div><h2><AppIcon name="volume" :size="18" />试听设置</h2><p>下面每个音色的「试听」都按这里的文字与参数合成。</p></div>
        </div>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">语音合成模型</span>
            <select v-model="modelId" class="select">
              <option v-for="item in models" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">试听文字</span>
            <input v-model="sample.text" class="input" type="text" maxlength="200" />
          </label>
          <template v-if="isQwen">
            <label class="field">
              <span class="field-label">语速 {{ Number(sample.rate).toFixed(2) }}</span>
              <input v-model.number="sample.rate" type="range" min="0.5" max="2" step="0.05" />
            </label>
            <label class="field">
              <span class="field-label">音调 {{ Number(sample.pitch).toFixed(2) }}</span>
              <input v-model.number="sample.pitch" type="range" min="0.5" max="2" step="0.05" />
            </label>
            <label class="field">
              <span class="field-label">音量 {{ sample.volume }}</span>
              <input v-model.number="sample.volume" type="range" min="0" max="100" step="1" />
            </label>
            <label class="field">
              <span class="field-label">语气指令</span>
              <input v-model="sample.instruction" class="input" type="text" maxlength="50" placeholder="例如:用温柔、舒缓的语气讲睡前故事" />
            </label>
          </template>
        </div>
        <div v-if="!isQwen" class="callout info" style="margin: 12px 0 0">
          <AppIcon name="info" :size="18" />
          <div class="callout-body">这个模型不是千问语音合成,只能手动添加音色名;试听、设计与复刻需要千问语音合成。</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <h2><AppIcon name="user" :size="18" />系统音色 <span v-if="systemVoices.length" class="count">{{ systemVoices.length }}</span></h2>
            <p>服务商自带的音色。千问另有五百多个基础音色,名字形如 qwen-audio-3.0-tts-flash-xxx,可按 ID 手动添加。</p>
          </div>
          <div class="card-actions">
            <button v-if="isQwen" class="btn btn-sm" type="button" :aria-busy="importing" @click="importSystem">
              <AppIcon name="plus" :size="14" /><span>导入系统音色</span>
            </button>
            <button class="btn btn-sm btn-ghost" type="button" @click="manual = { name: '', voice: '', languages: '中文' }">
              <AppIcon name="pencil" :size="14" /><span>按 ID 添加</span>
            </button>
          </div>
        </div>
        <EmptyState
          v-if="systemVoices.length === 0" title="还没有系统音色"
          :description="isQwen ? '点右上角「导入系统音色」,一次加入 12 个有名字的音色(含 3 个儿童音色)。' : '点右上角按 ID 添加。'"
        />
        <div v-else>
          <div v-for="voice in systemVoices" :key="voice.id" class="model-row">
            <div class="model-info">
              <div class="model-name">
                {{ voice.name }}
                <span v-for="tag in tagsOf(voice)" :key="tag" class="tag violet">{{ tag }}</span>
                <span v-if="voice.agent_count" class="tag sky">{{ voice.agent_count }} 个智能体在用</span>
              </div>
              <div class="cell-sub"><span class="chip-mono">{{ voice.voice }}</span><template v-if="voice.description"> · {{ voice.description }}</template></div>
            </div>
            <div class="row" style="gap: 2px">
              <button v-if="isQwen" class="btn btn-ghost btn-sm" type="button" :aria-busy="previewing === voice.id" @click="preview(voice)">
                <AppIcon name="volume" :size="14" /><span>试听</span>
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="rename(voice)"><AppIcon name="pencil" :size="14" /><span>改名</span></button>
              <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(voice)"><AppIcon name="trash" :size="14" /><span>删除</span></button>
            </div>
          </div>
        </div>
      </section>

      <template v-if="isQwen">
        <section class="card">
          <div class="card-head">
            <div>
              <h2><AppIcon name="sparkles" :size="18" />定制音色 <span v-if="customVoices.length" class="count">{{ customVoices.length }}</span></h2>
              <p>设计与复刻出的音色只能用于这个合成模型。百炼审核通过后才能使用;一年没用过会被百炼自动删除。</p>
            </div>
          </div>
          <EmptyState v-if="customVoices.length === 0" title="还没有定制音色" description="用下面的声音设计或声音复刻创建一个。" />
          <div v-else>
            <div v-for="voice in customVoices" :key="voice.id" class="model-row">
              <div class="model-info">
                <div class="model-name">
                  {{ voice.name }}
                  <span class="tag">{{ KIND_LABEL[voice.kind] }}</span>
                  <span class="tag dot" :class="STATUS_LABEL[voice.status].tone">{{ STATUS_LABEL[voice.status].text }}</span>
                  <span v-if="voice.agent_count" class="tag sky">{{ voice.agent_count }} 个智能体在用</span>
                </div>
                <div class="cell-sub">
                  <span class="chip-mono">{{ voice.voice }}</span> · {{ relativeTime(voice.created_at) }}创建
                  <template v-if="voice.prompt"> · {{ voice.prompt }}</template>
                </div>
              </div>
              <div class="row" style="gap: 2px">
                <button v-if="voice.status !== 'ok'" class="btn btn-ghost btn-sm" type="button" @click="refresh(voice)">
                  <AppIcon name="refresh" :size="14" /><span>刷新状态</span>
                </button>
                <button v-else class="btn btn-ghost btn-sm" type="button" :aria-busy="previewing === voice.id" @click="preview(voice)">
                  <AppIcon name="volume" :size="14" /><span>试听</span>
                </button>
                <button class="btn btn-ghost btn-sm" type="button" @click="rename(voice)"><AppIcon name="pencil" :size="14" /><span>改名</span></button>
                <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(voice)"><AppIcon name="trash" :size="14" /><span>删除</span></button>
              </div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <div><h2><AppIcon name="sparkles" :size="18" />声音设计</h2><p>用一段文字描述想要的声音,百炼生成一个新音色并先念一段给你听。描述声音特征即可,不支持模仿真人。</p></div>
          </div>
          <form class="stack" @submit.prevent="createDesign">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">名称<span class="req">*</span></span>
                <input v-model="design.name" class="input" type="text" maxlength="64" placeholder="讲故事的姐姐" />
              </label>
              <label class="field">
                <span class="field-label">语言</span>
                <select v-model="design.language" class="select"><option value="zh">中文</option><option value="en">英文</option></select>
              </label>
            </div>
            <label class="field">
              <span class="field-label">声音描述<span class="req">*</span></span>
              <textarea v-model="design.prompt" class="textarea" rows="3" maxlength="500" placeholder="温柔的年轻女声,音色清亮,语速稍慢,带一点笑意,适合给小朋友讲睡前故事"></textarea>
              <span class="field-hint">写清性别、年龄感、音色、语速、情绪与适用场景,最多 500 字。</span>
            </label>
            <label class="field">
              <span class="field-label">试听文本<span class="req">*</span></span>
              <input v-model="design.preview_text" class="input" type="text" maxlength="200" />
              <span class="field-hint">15 到 200 字,生成后会用新音色念这句话。</span>
            </label>
            <div class="row">
              <button class="btn btn-primary" type="submit" :aria-busy="designing"><AppIcon name="sparkles" :size="16" /><span>生成音色</span></button>
            </div>
          </form>
        </section>

        <section class="card">
          <div class="card-head">
            <div><h2><AppIcon name="mic" :size="18" />声音复刻</h2><p>用一段 10 到 20 秒的清晰说话声复刻出一个音色。要安静环境、一个人说话、不要背景音乐。</p></div>
          </div>
          <form class="stack" @submit.prevent="createClone">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">名称<span class="req">*</span></span>
                <input v-model="clone.name" class="input" type="text" maxlength="64" placeholder="妈妈的声音" />
              </label>
              <label class="field">
                <span class="field-label">语言</span>
                <select v-model="clone.language" class="select"><option value="zh">中文</option><option value="en">英文</option></select>
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
            <div class="row">
              <button class="btn btn-primary" type="submit" :aria-busy="cloning" :disabled="!sampleWav || !clone.consent">
                <AppIcon name="mic" :size="16" /><span>开始复刻</span>
              </button>
            </div>
          </form>
        </section>
      </template>
    </template>
  </template>

  <ModalDialog :open="!!manual" title="按 ID 添加音色" @close="manual = null">
    <form v-if="manual" id="manual-voice-form" class="stack" @submit.prevent="saveManual">
      <label class="field">
        <span class="field-label">音色名<span class="req">*</span></span>
        <input v-model="manual.voice" class="input mono" type="text" placeholder="例如 qwen-audio-3.0-tts-flash-longyaoxuanke" />
        <span class="field-hint">传给服务商的值,以服务商文档为准。</span>
      </label>
      <label class="field">
        <span class="field-label">显示名称</span>
        <input v-model="manual.name" class="input" type="text" maxlength="64" />
      </label>
      <label class="field">
        <span class="field-label">支持的语言</span>
        <input v-model="manual.languages" class="input" type="text" placeholder="中文、英文" />
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="manual = null">取消</button>
      <button class="btn btn-primary" type="submit" form="manual-voice-form" :aria-busy="savingManual">
        <AppIcon name="check" :size="16" /><span>保存</span>
      </button>
    </template>
  </ModalDialog>
</template>
