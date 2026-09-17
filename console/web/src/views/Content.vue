<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type MediaItem, type VocabBook, type VocabProgress, type Voice } from '../api';
import { playBlob, stopPlayback } from '../audio';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import SkeletonRows from '../components/SkeletonRows.vue';
import { confirmDialog, toast, toastError } from '../ui';

// 内容库:有声故事、曲库、单词书。智能体的「讲故事」「放音乐」「学单词」工具从这里取内容。

type Tab = 'story' | 'music' | 'vocab';
const tab = ref<Tab>('story');
const items = ref<MediaItem[]>([]);
const ttsReady = ref(false);
const storyVoice = ref('');
const storyVoiceEffective = ref<string | null>(null);
const voices = ref<Voice[]>([]);
const books = ref<VocabBook[]>([]);
const progress = ref<VocabProgress[]>([]);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loadError.value = '';
  try {
    const [m, b, p, v] = await Promise.all([
      api.get<{ items: MediaItem[]; tts_ready: boolean; story_voice: string; story_voice_effective: string | null }>('/media'),
      api.get<{ items: VocabBook[] }>('/vocab/books'),
      api.get<{ items: VocabProgress[] }>('/vocab/progress'),
      api.get<{ items: Voice[] }>('/voices'),
    ]);
    voices.value = v.items.filter((voice) => voice.status === 'ok' && voice.compatible);
    storyVoiceEffective.value = m.story_voice_effective;
    items.value = m.items;
    ttsReady.value = m.tts_ready;
    storyVoice.value = m.story_voice;
    books.value = b.items;
    progress.value = p.items;
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onBeforeUnmount(stopPlayback);

async function chooseStoryVoice(id: string) {
  try {
    await api.put('/media/story-voice', { voice_id: id });
    storyVoice.value = id;
    toast('讲故事的音色已更换。已经合成过的故事点「重新合成」才会换声音。');
    await load();
  } catch (e) {
    toastError(e);
  }
}

const stories = computed(() => items.value.filter((i) => i.kind === 'story'));
const music = computed(() => items.value.filter((i) => i.kind === 'music'));
const missingAudio = computed(() => stories.value.filter((s) => s.audio_status === 'none' || s.audio_status === 'failed').length);
const duration = (s: number) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');
const AUDIO: Record<MediaItem['audio_status'], { text: string; tone: string }> = {
  none: { text: '未合成', tone: '' },
  pending: { text: '合成中', tone: 'warn' },
  ready: { text: '有音频', tone: 'ok' },
  failed: { text: '合成失败', tone: 'danger' },
};

const playing = ref('');
async function preview(item: MediaItem) {
  playing.value = item.id;
  try {
    const response = await fetch(`/api/media/${item.id}/audio`);
    if (!response.ok) throw new Error(`加载音频失败(${response.status})`);
    await playBlob(await response.blob());
  } catch (e) {
    toastError(e);
  } finally {
    playing.value = '';
  }
}

const synthesizing = ref('');
async function synthesize(item: MediaItem) {
  synthesizing.value = item.id;
  try {
    await api.post(`/media/${item.id}/synthesize`);
    toast(`《${item.title}》音频已生成`);
    await load();
  } catch (e) {
    toastError(e);
    await load();
  } finally {
    synthesizing.value = '';
  }
}
async function synthesizeAll() {
  try {
    await api.post('/media/synthesize-missing');
    toast('已在后台开始合成,每个故事约半分钟到一分钟,稍后刷新查看。', 'info');
    window.setTimeout(load, 4000);
  } catch (e) {
    toastError(e);
  }
}

// ---- 编辑故事 ----
const editing = ref<{ id: string | null; title: string; summary: string; body: string; tags: string; voice_instruction: string; newId: string } | null>(null);
const saving = ref(false);
async function openStory(item: MediaItem | null) {
  if (!item) {
    editing.value = { id: null, newId: '', title: '', summary: '', body: '', tags: '睡前', voice_instruction: '用温柔、舒缓的语气讲睡前故事,语速稍慢' };
    return;
  }
  const full = await api.get<MediaItem>(`/media/${item.id}`);
  editing.value = { id: item.id, newId: item.id, title: full.title, summary: full.summary, body: full.body ?? '', tags: full.tags.join(','), voice_instruction: full.voice_instruction };
}
async function saveStory() {
  const e = editing.value;
  if (!e || saving.value) return;
  saving.value = true;
  try {
    const tags = e.tags.split(/[,,\s]+/u).filter(Boolean);
    if (e.id) {
      const current = items.value.find((i) => i.id === e.id)!;
      const result = await api.put<{ needs_audio: boolean }>(`/media/${e.id}`, {
        title: e.title, aliases: current.aliases, tags, summary: e.summary, body: e.body, voice_instruction: e.voice_instruction, enabled: current.enabled === 1,
      });
      toast(result.needs_audio ? '已保存。正文改了,音频需要重新合成。' : '已保存');
    } else {
      await api.post('/media/stories', { id: e.newId.trim(), title: e.title, summary: e.summary, body: e.body, tags, voice_instruction: e.voice_instruction });
      toast('已添加故事');
    }
    editing.value = null;
    await load();
  } catch (err) {
    toastError(err);
  } finally {
    saving.value = false;
  }
}

// ---- 上传音乐 ----
const uploading = ref<{ id: string; title: string; license: string; attribution: string; file: File | null } | null>(null);
async function upload() {
  const u = uploading.value;
  if (!u || !u.file || saving.value) return;
  saving.value = true;
  try {
    const query = new URLSearchParams({ id: u.id.trim(), kind: 'music', title: u.title.trim(), license: u.license, attribution: u.attribution });
    const type = u.file.type || (u.file.name.endsWith('.mp3') ? 'audio/mpeg' : u.file.name.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav');
    await api.postBlob(`/media/upload?${query}`, new Blob([await u.file.arrayBuffer()], { type }));
    toast('已上传');
    uploading.value = null;
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove(item: MediaItem) {
  const ok = await confirmDialog({
    title: `删除「${item.title}」?`,
    message: item.builtin ? '这是自带内容,控制塔下次启动时会重新装回来。想让智能体不再用它,可以只停用。' : '音频文件一并删除,无法恢复。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/media/${item.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}

async function toggle(item: MediaItem) {
  try {
    await api.put(`/media/${item.id}`, { title: item.title, aliases: item.aliases, tags: item.tags, summary: item.summary, voice_instruction: item.voice_instruction, enabled: item.enabled !== 1 });
    await load();
  } catch (e) {
    toastError(e);
  }
}

// ---- 单词书 ----
const importingBook = ref<{ title: string; text: string } | null>(null);
async function importBook() {
  const b = importingBook.value;
  if (!b || saving.value) return;
  saving.value = true;
  try {
    const result = await api.post<{ count: number }>('/vocab/books', { title: b.title, text: b.text });
    toast(`已导入 ${result.count} 个单词`);
    importingBook.value = null;
    await load();
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}
async function removeBook(book: VocabBook) {
  if (!(await confirmDialog({ title: `删除单词书「${book.title}」?`, message: '学习进度一并删除。', confirmText: '删除', danger: true }))) return;
  try {
    await api.del(`/vocab/books/${book.id}`);
    await load();
  } catch (e) {
    toastError(e);
  }
}
</script>

<template>
  <PageHeader title="内容库" description="有声故事、曲库与单词书。智能体的讲故事、放音乐、学单词工具从这里取内容。" />

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <div class="row" style="gap: 6px; margin-bottom: 14px">
    <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'story' }" type="button" @click="tab = 'story'"><AppIcon name="news" :size="14" /><span>故事 {{ stories.length }}</span></button>
    <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'music' }" type="button" @click="tab = 'music'"><AppIcon name="music" :size="14" /><span>音乐 {{ music.length }}</span></button>
    <button class="btn btn-sm" :class="{ 'btn-primary': tab === 'vocab' }" type="button" @click="tab = 'vocab'"><AppIcon name="star" :size="14" /><span>单词书 {{ books.length }}</span></button>
  </div>

  <div v-if="loading" class="card"><SkeletonRows :rows="4" /></div>

  <template v-else-if="tab === 'story'">
    <div v-if="!ttsReady" class="callout warn">
      <AppIcon name="alert" :size="18" />
      <div class="callout-body">还没有配置带 API Key 的千问语音合成模型,故事暂时没有音频;智能体会改为自己把故事讲出来。配好后会在后台自动合成。</div>
    </div>
    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="news" :size="18" />有声故事</h2>
          <p>自带 6 个原创故事。音频由千问按下面选的音色合成,音色的语速、方言与语气也会带上。</p>
        </div>
        <div class="card-actions">
          <select class="select" style="width: auto; min-width: 160px" :value="storyVoice" aria-label="讲故事的音色" @change="chooseStoryVoice(($event.target as HTMLSelectElement).value)">
            <option value="">默认音色{{ storyVoiceEffective && !storyVoice ? `(${voices.find((v) => v.id === storyVoiceEffective)?.name ?? ''})` : '' }}</option>
            <option v-for="voice in voices" :key="voice.id" :value="voice.id">{{ voice.name }}</option>
          </select>
          <button v-if="ttsReady && missingAudio" class="btn btn-sm" type="button" @click="synthesizeAll"><AppIcon name="volume" :size="14" /><span>合成缺音频的 {{ missingAudio }} 个</span></button>
          <button class="btn btn-sm" type="button" @click="openStory(null)"><AppIcon name="plus" :size="14" /><span>新故事</span></button>
        </div>
      </div>
      <EmptyState v-if="stories.length === 0" title="还没有故事" />
      <div v-for="item in stories" :key="item.id" class="model-row">
        <div class="model-info">
          <div class="model-name">
            《{{ item.title }}》
            <span class="tag dot" :class="AUDIO[item.audio_status].tone" :title="item.audio_error">{{ AUDIO[item.audio_status].text }}</span>
            <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
            <span v-if="item.enabled === 0" class="tag">已停用</span>
          </div>
          <div class="cell-sub">{{ item.summary }} · {{ item.body_chars }} 字<template v-if="item.duration_s"> · 约 {{ Math.round(item.duration_s / 60) }} 分钟</template></div>
        </div>
        <div class="row" style="gap: 2px">
          <button v-if="item.audio_status === 'ready'" class="btn btn-ghost btn-sm" type="button" :aria-busy="playing === item.id" @click="preview(item)"><AppIcon name="volume" :size="14" /><span>试听</span></button>
          <button v-if="ttsReady" class="btn btn-ghost btn-sm" type="button" :aria-busy="synthesizing === item.id" @click="synthesize(item)"><AppIcon name="refresh" :size="14" /><span>{{ item.audio_status === 'ready' ? '重新合成' : '合成' }}</span></button>
          <button class="btn btn-ghost btn-sm" type="button" @click="openStory(item)"><AppIcon name="pencil" :size="14" /><span>编辑</span></button>
          <button class="btn btn-ghost btn-sm" type="button" @click="toggle(item)"><span>{{ item.enabled ? '停用' : '启用' }}</span></button>
          <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(item)"><AppIcon name="trash" :size="14" /></button>
        </div>
      </div>
    </section>
  </template>

  <template v-else-if="tab === 'music'">
    <section class="card">
      <div class="card-head">
        <div>
          <h2><AppIcon name="music" :size="18" />曲库</h2>
          <p>自带的曲目都核实过录音本身的许可(公有领域、CC0 或 CC BY)。CC BY 的曲目使用时须保留下面的署名。</p>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm" type="button" @click="uploading = { id: '', title: '', license: '', attribution: '', file: null }"><AppIcon name="plus" :size="14" /><span>上传音乐</span></button>
        </div>
      </div>
      <EmptyState v-if="music.length === 0" title="曲库是空的" />
      <div v-for="item in music" :key="item.id" class="model-row" style="align-items: flex-start">
        <div class="model-info">
          <div class="model-name">
            《{{ item.title }}》
            <span class="tag" :class="item.license.startsWith('CC BY') ? 'warn' : 'ok'">{{ item.license || '未注明许可' }}</span>
            <span v-if="item.enabled === 0" class="tag">已停用</span>
          </div>
          <div class="cell-sub">{{ item.summary }}<template v-if="item.duration_s"> · {{ duration(item.duration_s) }}</template></div>
          <div v-if="item.attribution && item.license.startsWith('CC BY')" class="cell-sub small">署名:{{ item.attribution }}</div>
          <div v-if="item.source_url" class="cell-sub small"><a :href="item.source_url" target="_blank" rel="noopener">来源</a></div>
        </div>
        <div class="row" style="gap: 2px">
          <button class="btn btn-ghost btn-sm" type="button" :aria-busy="playing === item.id" @click="preview(item)"><AppIcon name="volume" :size="14" /><span>试听</span></button>
          <button class="btn btn-ghost btn-sm" type="button" @click="toggle(item)"><span>{{ item.enabled ? '停用' : '启用' }}</span></button>
          <button class="btn btn-ghost btn-sm danger" type="button" @click="remove(item)"><AppIcon name="trash" :size="14" /></button>
        </div>
      </div>
    </section>
  </template>

  <template v-else>
    <section class="card">
      <div class="card-head">
        <div><h2><AppIcon name="star" :size="18" />单词书</h2><p>「学单词」工具默认用第一本;在智能体页的工具参数里可以指定。</p></div>
        <div class="card-actions">
          <button class="btn btn-sm" type="button" @click="importingBook = { title: '', text: 'word,meaning,example,example_cn\napple,苹果,I like apples.,我喜欢苹果。' }"><AppIcon name="plus" :size="14" /><span>导入单词书</span></button>
        </div>
      </div>
      <div v-for="book in books" :key="book.id" class="model-row">
        <div class="model-info">
          <div class="model-name">{{ book.title }} <span class="chip-mono">{{ book.id }}</span> <span v-if="book.builtin" class="tag sky">自带</span></div>
          <div class="cell-sub">{{ book.word_count }} 个单词<template v-if="book.description"> · {{ book.description }}</template></div>
        </div>
        <button class="btn btn-ghost btn-sm danger" type="button" @click="removeBook(book)"><AppIcon name="trash" :size="14" /><span>删除</span></button>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2><AppIcon name="check" :size="18" />学习进度</h2></div></div>
      <EmptyState v-if="progress.length === 0" title="还没有学习记录" description="在设备上说「我们来学单词吧」。" />
      <div v-else class="table-wrap">
        <table class="table">
          <thead><tr><th>学习者</th><th>单词书</th><th>学过</th><th>掌握</th><th>待复习</th><th>答对 / 答错</th></tr></thead>
          <tbody>
            <tr v-for="p in progress" :key="`${p.learner}-${p.book_id}`">
              <td>{{ p.alias || (p.learner === 'playground' ? '试聊' : p.learner) }}</td>
              <td>{{ p.book_title }}</td>
              <td class="mono">{{ p.learned }} / {{ p.total }}</td>
              <td class="mono">{{ p.mastered }}</td>
              <td class="mono">{{ p.due }}</td>
              <td class="mono">{{ p.right }} / {{ p.wrong }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>

  <ModalDialog :open="!!editing" wide :title="editing?.id ? '编辑故事' : '新故事'" @close="editing = null">
    <form v-if="editing" id="story-form" class="stack" @submit.prevent="saveStory">
      <div class="form-grid">
        <label v-if="!editing.id" class="field">
          <span class="field-label">id<span class="req">*</span></span>
          <input v-model="editing.newId" class="input mono" type="text" placeholder="brave-little-rabbit" />
        </label>
        <label class="field">
          <span class="field-label">标题<span class="req">*</span></span>
          <input v-model="editing.title" class="input" type="text" maxlength="64" />
        </label>
        <label class="field">
          <span class="field-label">标签</span>
          <input v-model="editing.tags" class="input" type="text" placeholder="睡前,勇气" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">一句话简介</span>
        <input v-model="editing.summary" class="input" type="text" maxlength="200" />
      </label>
      <label class="field">
        <span class="field-label">合成语气</span>
        <input v-model="editing.voice_instruction" class="input" type="text" maxlength="50" />
      </label>
      <label class="field">
        <span class="field-label">正文<span class="req">*</span></span>
        <textarea v-model="editing.body" class="textarea" rows="14"></textarea>
        <span class="field-hint">段落之间空一行;句子短一些,设备字幕一次只显示二十来个字。改了正文需要重新合成音频。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="editing = null">取消</button>
      <button class="btn btn-primary" type="submit" form="story-form" :aria-busy="saving"><AppIcon name="check" :size="16" /><span>保存</span></button>
    </template>
  </ModalDialog>

  <ModalDialog :open="!!uploading" title="上传音乐" @close="uploading = null">
    <form v-if="uploading" id="upload-form" class="stack" @submit.prevent="upload">
      <label class="field"><span class="field-label">id<span class="req">*</span></span><input v-model="uploading.id" class="input mono" type="text" placeholder="happy-birthday-piano" /></label>
      <label class="field"><span class="field-label">曲名<span class="req">*</span></span><input v-model="uploading.title" class="input" type="text" /></label>
      <label class="field"><span class="field-label">许可</span><input v-model="uploading.license" class="input" type="text" placeholder="自有 / CC0 / CC BY 4.0" /></label>
      <label class="field"><span class="field-label">署名</span><input v-model="uploading.attribution" class="input" type="text" /></label>
      <label class="field">
        <span class="field-label">文件<span class="req">*</span></span>
        <input type="file" accept="audio/mpeg,audio/ogg,audio/wav,audio/mp4,.mp3,.ogg,.wav,.m4a" @change="uploading.file = (($event.target as HTMLInputElement).files ?? [])[0] ?? null" />
        <span class="field-hint">请只上传你有权使用的音乐。设备是 16 kHz 单声道小喇叭,文件不必太大。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="uploading = null">取消</button>
      <button class="btn btn-primary" type="submit" form="upload-form" :aria-busy="saving" :disabled="!uploading?.file"><AppIcon name="check" :size="16" /><span>上传</span></button>
    </template>
  </ModalDialog>

  <ModalDialog :open="!!importingBook" wide title="导入单词书" @close="importingBook = null">
    <form v-if="importingBook" id="book-form" class="stack" @submit.prevent="importBook">
      <label class="field"><span class="field-label">书名<span class="req">*</span></span><input v-model="importingBook.title" class="input" type="text" maxlength="64" /></label>
      <label class="field">
        <span class="field-label">内容<span class="req">*</span></span>
        <textarea v-model="importingBook.text" class="textarea mono" rows="12"></textarea>
        <span class="field-hint">每行「单词,释义,例句,例句翻译」(后两项可省略),或粘贴 JSON 数组。</span>
      </label>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="importingBook = null">取消</button>
      <button class="btn btn-primary" type="submit" form="book-form" :aria-busy="saving"><AppIcon name="check" :size="16" /><span>导入</span></button>
    </template>
  </ModalDialog>
</template>
