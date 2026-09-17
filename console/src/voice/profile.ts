// 音色的「说话设置」:语种、方言、音量、语速、音调、固定语气、允许的情感标签。纯函数,不碰数据库。
//
// 千问合成(Qwen-Audio-TTS)能调的只有 voice / volume / rate / pitch / instruction 这几个参数,另加写在文字里的方括号标签:
//   - 方言没有单独的参数,百炼文档给的做法是在 instruction 里写「请用河南话表达」;
//   - 固定语气(温柔、慢一点……)同样合进 instruction,整段不超过 100 个单位,汉字算 2 个;
//   - 情感标签([excited]、[laughing]……)写在要念的文字里,每句可以不同,由模型按内容插入;
//     允许哪些由音色决定,不在名单里的在引擎里就被去掉,不会被念出来,字幕里一律去掉。
//   - 语种没有合成参数:它决定模型用哪种语言回复,以及试听用什么文案。

export interface VoiceProfile {
  language: string;
  dialect: string;
  volume: number;
  rate: number;
  pitch: number;
  tone_tags: string[];
  tone_text: string;
  emotion_tags: string[];
}

export const DEFAULT_PROFILE: Readonly<VoiceProfile> = {
  language: '中文', dialect: '', volume: 50, rate: 1, pitch: 1, tone_tags: [], tone_text: '', emotion_tags: [],
};

/** 百炼复刻支持的语种。code 是创建音色时 language_hints 用的代码,english 给提示词用。 */
export const LANGUAGES: readonly { label: string; code: string; english: string; sample: string }[] = [
  { label: '中文', code: 'zh', english: 'Chinese', sample: '你好呀,很高兴认识你,今天过得怎么样?' },
  { label: '英语', code: 'en', english: 'English', sample: 'Hi there, nice to meet you. How is your day going?' },
  { label: '日语', code: 'ja', english: 'Japanese', sample: 'こんにちは、はじめまして。今日はどんな一日でしたか?' },
  { label: '韩语', code: 'ko', english: 'Korean', sample: '안녕하세요, 만나서 반가워요. 오늘 하루 어땠어요?' },
  { label: '俄语', code: 'ru', english: 'Russian', sample: 'Привет! Рада познакомиться. Как прошёл твой день?' },
  { label: '法语', code: 'fr', english: 'French', sample: 'Bonjour, ravi de te rencontrer. Comment se passe ta journée ?' },
  { label: '德语', code: 'de', english: 'German', sample: 'Hallo, schön dich kennenzulernen. Wie war dein Tag?' },
  { label: '葡萄牙语', code: 'pt', english: 'Portuguese', sample: 'Olá, prazer em te conhecer. Como está o seu dia?' },
  { label: '泰语', code: 'th', english: 'Thai', sample: 'สวัสดี ยินดีที่ได้รู้จัก วันนี้เป็นอย่างไรบ้าง' },
  { label: '印尼语', code: 'id', english: 'Indonesian', sample: 'Halo, senang bertemu denganmu. Bagaimana harimu?' },
  { label: '越南语', code: 'vi', english: 'Vietnamese', sample: 'Xin chào, rất vui được gặp bạn. Hôm nay của bạn thế nào?' },
  { label: '西班牙语', code: 'es', english: 'Spanish', sample: 'Hola, encantado de conocerte. ¿Qué tal tu día?' },
  { label: '意大利语', code: 'it', english: 'Italian', sample: 'Ciao, piacere di conoscerti. Com’è andata la tua giornata?' },
  { label: '马来西亚语', code: 'ms', english: 'Malay', sample: 'Hai, gembira berkenalan dengan anda. Bagaimana hari anda?' },
  { label: '菲律宾语', code: 'fil', english: 'Filipino', sample: 'Kumusta, ikinagagalak kitang makilala. Paano ang iyong araw?' },
  { label: '阿拉伯语', code: 'ar', english: 'Arabic', sample: 'مرحبًا، سعيد بلقائك. كيف كان يومك؟' },
];

/** 百炼文档列出的中文方言(靠语气指令实现) */
export const DIALECTS: readonly string[] = [
  '广东话', '四川话', '重庆话', '东北话', '上海话', '河南话', '山东话', '湖南话', '湖北话', '陕西话',
  '云南话', '贵州话', '浙江话', '宁波话', '江西话', '河北话', '山西话', '甘肃话', '宁夏话', '青岛话',
];

export const TONE_CHIPS: readonly { id: string; label: string; phrase: string }[] = [
  { id: 'gentle', label: '温柔', phrase: '语气温柔' },
  { id: 'warm', label: '亲切', phrase: '亲切自然' },
  { id: 'lively', label: '活泼', phrase: '活泼开朗' },
  { id: 'calm', label: '平静', phrase: '平静舒缓' },
  { id: 'patient', label: '耐心', phrase: '耐心细致' },
  { id: 'soft', label: '轻声', phrase: '轻声细语' },
  { id: 'story', label: '讲故事', phrase: '像讲故事一样娓娓道来' },
  { id: 'excited', label: '兴奋', phrase: '兴奋有感染力' },
  { id: 'slow', label: '慢一点', phrase: '语速稍慢' },
  { id: 'fast', label: '快一点', phrase: '语速稍快' },
];

/** 控制类情感标签:放在句首,管到这一句结束 */
export const CONTROL_TAGS: readonly { tag: string; label: string }[] = [
  { tag: 'excited', label: '兴奋' },
  { tag: 'curious', label: '好奇' },
  { tag: 'amazed', label: '惊叹' },
  { tag: 'mischievously', label: '调皮' },
  { tag: 'empathetic', label: '体贴' },
  { tag: 'whispers', label: '悄悄话' },
  { tag: 'sad', label: '伤心' },
  { tag: 'crying', label: '哭腔' },
  { tag: 'tired', label: '累了' },
  { tag: 'bored', label: '无聊' },
  { tag: 'serious', label: '严肃' },
  { tag: 'angry', label: '生气' },
  { tag: 'shouting', label: '大喊' },
  { tag: 'deep and loud shouting', label: '低沉大喊' },
  { tag: 'panicked', label: '惊慌' },
  { tag: 'trembling', label: '发抖' },
  { tag: 'reluctantly', label: '不情愿' },
  { tag: 'sarcastic', label: '讽刺' },
  { tag: 'scornful', label: '轻蔑' },
  { tag: 'like dracula', label: '吸血鬼腔' },
  { tag: 'asmr', label: 'ASMR 耳语' },
  { tag: 'very slowly', label: '很慢' },
  { tag: 'very fast', label: '很快' },
];

/** 声音类标签:插在要出声的位置 */
export const RICH_TAGS: readonly { tag: string; label: string }[] = [
  { tag: 'laughing', label: '笑出声' },
  { tag: 'giggles', label: '咯咯笑' },
  { tag: 'sighing', label: '叹气' },
  { tag: 'gasp', label: '倒吸一口气' },
  { tag: 'clears throat', label: '清嗓子' },
  { tag: 'cough', label: '咳嗽' },
  { tag: 'snorts', label: '哼一声' },
];

/** 页面上的「推荐组合」:适合陪伴聊天,不会吓到小朋友 */
export const RECOMMENDED_TAGS: readonly string[] = ['excited', 'curious', 'amazed', 'mischievously', 'empathetic', 'whispers', 'laughing', 'giggles', 'sighing'];

const KNOWN_TAGS = new Set([...CONTROL_TAGS, ...RICH_TAGS].map((item) => item.tag));
const TONE_BY_ID = new Map(TONE_CHIPS.map((chip) => [chip.id, chip]));

export const INSTRUCTION_UNITS = 100;
export const TONE_TEXT_MAX = 50;

/** 词表整包下发给前端 */
export const VOICE_CATALOG = {
  languages: LANGUAGES,
  dialects: DIALECTS,
  tone_chips: TONE_CHIPS,
  control_tags: CONTROL_TAGS,
  rich_tags: RICH_TAGS,
  recommended_tags: RECOMMENDED_TAGS,
  instruction_units: INSTRUCTION_UNITS,
};

const INLINE_TAG = /\[([a-z][a-z ]{0,30})\]/gu;

/** 去掉文字里的方括号情感标签(字幕、对话记录用)。只认半角方括号里的小写英文。 */
export function stripInlineTags(text: string): string {
  return text.replace(INLINE_TAG, '').replace(/[ \t]{2,}/gu, ' ');
}

/** 文字里出现的情感标签(去重,按出现顺序) */
export function inlineTagsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_TAG)) seen.add(match[1]!);
  return [...seen];
}

/** 只保留允许的标签,其余去掉 */
export function filterInlineTags(text: string, allowed: readonly string[]): string {
  const set = new Set(allowed);
  return text.replace(INLINE_TAG, (whole, tag: string) => (set.has(tag) ? whole : '')).replace(/[ \t]{2,}/gu, ' ');
}

/** 按百炼的规则计单位:非 ASCII 字符算 2 个 */
export function instructionUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return units;
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.trim()) {
    try {
      return parseList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** 从数据库行(或前端提交的对象)读出设置;缺的与坏的按默认值。 */
export function readProfile(source: object): VoiceProfile {
  const row = source as Record<string, unknown>;
  return {
    language: typeof row['language'] === 'string' && row['language'] ? row['language'] : DEFAULT_PROFILE.language,
    dialect: typeof row['dialect'] === 'string' ? row['dialect'] : '',
    volume: finite(row['volume'], DEFAULT_PROFILE.volume),
    rate: finite(row['rate'], DEFAULT_PROFILE.rate),
    pitch: finite(row['pitch'], DEFAULT_PROFILE.pitch),
    tone_tags: parseList(row['tone_tags']),
    tone_text: typeof row['tone_text'] === 'string' ? row['tone_text'] : '',
    emotion_tags: parseList(row['emotion_tags']),
  };
}

function instructionParts(profile: VoiceProfile): string[] {
  const parts: string[] = [];
  if (profile.dialect && profile.language === '中文') parts.push(`请用${profile.dialect}表达`);
  for (const id of profile.tone_tags) {
    const chip = TONE_BY_ID.get(id);
    if (chip) parts.push(chip.phrase);
  }
  if (profile.tone_text.trim()) parts.push(profile.tone_text.trim());
  return parts;
}

/**
 * 合成语气指令:方言 → 固定语气 → 补充说明 → 额外要求(比如讲故事时故事自带的语气),用逗号连起来,
 * 截断到 100 个单位。方言只在语种是中文时生效。
 */
export function composeInstruction(profile: VoiceProfile, extra?: string): string {
  const parts = instructionParts(profile);
  if (extra?.trim()) parts.push(extra.trim());
  let out = '';
  let used = 0;
  for (const ch of parts.join(',')) {
    const cost = ch.charCodeAt(0) > 0x7f ? 2 : 1;
    if (used + cost > INSTRUCTION_UNITS) break;
    out += ch;
    used += cost;
  }
  return out;
}

/** 这个音色能说的语种(库里存顿号分隔的串) */
export function languagesOf(languages: unknown): string[] {
  const list = typeof languages === 'string' ? languages.split(/[、,,]/u).map((item) => item.trim()).filter(Boolean) : [];
  return list.map((item) => (item === '英文' ? '英语' : item));
}

/** 校验设置;没问题返回 null,否则返回给人看的原因。 */
export function validateProfile(profile: VoiceProfile, languages: readonly string[]): string | null {
  if (!LANGUAGES.some((item) => item.label === profile.language)) return `不认识的语种:${profile.language}`;
  if (languages.length && !languages.includes(profile.language)) return `这个音色不会说${profile.language}`;
  if (profile.dialect) {
    if (!DIALECTS.includes(profile.dialect)) return `不认识的方言:${profile.dialect}`;
    if (profile.language !== '中文') return '方言只在语种为中文时可用';
  }
  if (!(profile.volume >= 0 && profile.volume <= 100)) return '音量要在 0 到 100 之间';
  if (!(profile.rate >= 0.5 && profile.rate <= 2)) return '语速要在 0.5 到 2 之间';
  if (!(profile.pitch >= 0.5 && profile.pitch <= 2)) return '音调要在 0.5 到 2 之间';
  const unknownTone = profile.tone_tags.find((id) => !TONE_BY_ID.has(id));
  if (unknownTone) return `不认识的语气:${unknownTone}`;
  if ([...profile.tone_text].length > TONE_TEXT_MAX) return `补充说明不能超过 ${TONE_TEXT_MAX} 个字`;
  const unknownTag = profile.emotion_tags.find((tag) => !KNOWN_TAGS.has(tag));
  if (unknownTag) return `不认识的情感标签:${unknownTag}`;
  const units = instructionUnits(instructionParts(profile).join(','));
  if (units > INSTRUCTION_UNITS) return `语气说明太长了(已用 ${units}/${INSTRUCTION_UNITS})`;
  return null;
}

/** 规范化后写库用的形状(数组存 JSON) */
export function profileColumns(profile: VoiceProfile): Record<string, string | number> {
  return {
    language: profile.language,
    dialect: profile.language === '中文' ? profile.dialect : '',
    volume: Math.round(profile.volume),
    rate: Math.round(profile.rate * 100) / 100,
    pitch: Math.round(profile.pitch * 100) / 100,
    tone_tags: JSON.stringify([...new Set(profile.tone_tags)]),
    tone_text: profile.tone_text.trim(),
    emotion_tags: JSON.stringify([...new Set(profile.emotion_tags)]),
  };
}

/** 下发给引擎合成模块的参数(合进语音合成模型的配置) */
export function ttsOverrides(voice: { voice: string }): Record<string, unknown> {
  const profile = readProfile(voice);
  const overrides: Record<string, unknown> = {
    private_voice: voice.voice,
    volume: profile.volume,
    rate: profile.rate,
    pitch: profile.pitch,
    inline_tags: profile.emotion_tags,
  };
  const instruction = composeInstruction(profile);
  if (instruction) overrides['instruction'] = instruction;
  return overrides;
}

/** 给人看的一行摘要:「中文 · 四川话 · 语速 0.95 · 温柔、讲故事 · 情感标签 5 个」 */
export function profileSummary(profile: VoiceProfile): string {
  const parts = [profile.language];
  if (profile.dialect) parts.push(profile.dialect);
  if (profile.rate !== 1) parts.push(`语速 ${profile.rate}`);
  if (profile.volume !== 50) parts.push(`音量 ${profile.volume}`);
  if (profile.pitch !== 1) parts.push(`音调 ${profile.pitch}`);
  const tones = profile.tone_tags.map((id) => TONE_BY_ID.get(id)?.label).filter(Boolean);
  if (tones.length) parts.push(tones.join('、'));
  if (profile.tone_text) parts.push(profile.tone_text);
  if (profile.emotion_tags.length) parts.push(`情感标签 ${profile.emotion_tags.length} 个`);
  return parts.join(' · ');
}
