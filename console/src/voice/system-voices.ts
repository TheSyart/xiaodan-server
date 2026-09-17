// 千问语音合成(Qwen-Audio-TTS)有名字的系统音色(百炼文档「Qwen-Audio-TTS 音色列表」,2026-09)。
//
// flash 与 plus 各有一套,不能混用:qwen-audio-3.0-tts-plus 的音色不能拿去给 flash 合成,反之亦然。
// 另有五百多个基础音色,名字形如 qwen-audio-3.0-tts-flash-<后缀>,需要时在音色页按 ID 添加。
// 本文件是纯数据,不依赖数据库:迁移与业务代码都从这里取。

export type VoiceFamily = 'flash' | 'plus';

export interface SystemVoice {
  voice: string;
  /** 百炼官方中文名 */
  name: string;
  family: VoiceFamily;
  gender: '女' | '男';
  age: number;
  /** 百炼给的风格描述 */
  style: string;
  /** 能说的语种,顿号分隔 */
  languages: string;
  /** 筛选用标签:儿童、英语 */
  tags: string;
}

const ZH_EN = '中文、英语';

export const QWEN_TTS_SYSTEM_VOICES: readonly SystemVoice[] = [
  { voice: 'longanhuan_v3.6', name: '龙安欢', family: 'flash', gender: '女', age: 25, style: '亲切自然音', languages: ZH_EN, tags: '' },
  { voice: 'longanfengyue', name: '龙安风悦', family: 'flash', gender: '女', age: 30, style: '自然亲切音', languages: ZH_EN, tags: '' },
  { voice: 'longanyuanfei', name: '龙安元妃', family: 'flash', gender: '女', age: 30, style: '高傲妃子音', languages: ZH_EN, tags: '' },
  { voice: 'longanlingxi', name: '龙安灵希', family: 'flash', gender: '女', age: 25, style: '可爱甜美音', languages: ZH_EN, tags: '' },
  { voice: 'longanxiaoxin', name: '龙安小昕', family: 'flash', gender: '女', age: 22, style: '亲切活泼音', languages: ZH_EN, tags: '' },
  { voice: 'longjielidou_v3.6', name: '龙杰力豆', family: 'flash', gender: '男', age: 5, style: '天真男童音', languages: ZH_EN, tags: '儿童' },
  { voice: 'longpaopao_v3.6', name: '龙泡泡', family: 'flash', gender: '女', age: 5, style: '软糯可爱音', languages: ZH_EN, tags: '儿童' },
  { voice: 'longhuohuo_v3.6', name: '龙火火', family: 'flash', gender: '男', age: 8, style: '顽皮少年音', languages: ZH_EN, tags: '儿童' },
  { voice: 'longchuanshu_v3.6', name: '龙川叔', family: 'flash', gender: '男', age: 40, style: '川普大叔音', languages: ZH_EN, tags: '' },
  { voice: 'loongmary', name: 'loongmary', family: 'flash', gender: '女', age: 20, style: '温暖英音', languages: '英语', tags: '英语' },
  { voice: 'loongeva_v3.6', name: 'loongeva', family: 'flash', gender: '女', age: 28, style: '高智美音', languages: '英语', tags: '英语' },
  { voice: 'loongjohn', name: 'loongJohn', family: 'flash', gender: '男', age: 28, style: '沉稳亲切美音', languages: '英语', tags: '英语' },
  { voice: 'longanlingxin', name: '龙安灵心', family: 'plus', gender: '女', age: 25, style: '知心温暖音', languages: ZH_EN, tags: '' },
  { voice: 'longanlufeng', name: '龙安鲁风', family: 'plus', gender: '男', age: 25, style: '明亮开朗音', languages: ZH_EN, tags: '' },
];

/** 旧版控制塔自拟的系统音色名与说明(导入时写进库里的)。迁移时没被改过的换成官方名。 */
export const LEGACY_SYSTEM_VOICE_TEXT: Readonly<Record<string, { name: string; description: string }>> = {
  'longanhuan_v3.6': { name: '安欢', description: '女 · 约 25 岁 · 亲切自然' },
  longanfengyue: { name: '安风月', description: '女 · 约 30 岁 · 自然温暖' },
  longanyuanfei: { name: '安元妃', description: '女 · 约 30 岁 · 端庄大气' },
  longanlingxi: { name: '安灵犀', description: '女 · 约 25 岁 · 甜美可爱' },
  longanxiaoxin: { name: '安小欣', description: '女 · 约 22 岁 · 活泼开朗' },
  'longjielidou_v3.6': { name: '杰力豆', description: '男孩 · 约 5 岁 · 儿童陪伴' },
  'longpaopao_v3.6': { name: '泡泡', description: '女孩 · 约 5 岁 · 儿童陪伴' },
  'longhuohuo_v3.6': { name: '火火', description: '男孩 · 约 8 岁 · 调皮活泼' },
  'longchuanshu_v3.6': { name: '川叔', description: '男 · 约 40 岁 · 四川口音' },
  loongmary: { name: 'Mary', description: '女 · 约 20 岁 · 英式英语' },
  'loongeva_v3.6': { name: 'Eva', description: '女 · 约 28 岁 · 美式英语' },
  loongjohn: { name: 'John', description: '男 · 约 28 岁 · 美式英语' },
};

export const DEFAULT_TTS_MODEL_NAME = 'qwen-audio-3.0-tts-flash';

/** 合成模型属于哪一套音色。模型名里带 plus 的是 plus,其余按 flash。 */
export function familyOf(modelName: unknown): VoiceFamily {
  return typeof modelName === 'string' && modelName.includes('-plus') ? 'plus' : 'flash';
}

/** 每套里默认用的音色 */
export function defaultSystemVoice(family: VoiceFamily): SystemVoice {
  return QWEN_TTS_SYSTEM_VOICES.find((voice) => voice.family === family)!;
}

export function systemVoiceOf(voice: string): SystemVoice | undefined {
  return QWEN_TTS_SYSTEM_VOICES.find((item) => item.voice === voice);
}

/** 音色表的主键:模型 id + 音色值,换掉不允许的字符。 */
export function voiceKey(modelId: string, voice: string): string {
  return `${modelId}__${voice}`.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 128);
}

/** 给人看的一行说明:「女 · 25 岁 · 知心温暖音」 */
export function systemVoiceDescription(voice: SystemVoice): string {
  return `${voice.gender} · ${voice.age} 岁 · ${voice.style}`;
}
