// qwen-audio-3.0-tts-flash 有名字的系统音色(百炼文档「Qwen-Audio-TTS 音色列表」,2026-09)。
// 另有五百多个基础音色,名字形如 qwen-audio-3.0-tts-flash-<后缀>,需要时在音色页按 ID 手动添加。
// 音色与模型绑定,不能跨模型使用。音色值(voice)以文档为准;中文显示名与说明是控制塔按文档描述自拟的,可在音色页改。

export interface SystemVoice {
  voice: string;
  name: string;
  description: string;
  languages: string;
  tags: string;
}

export const QWEN_AUDIO_TTS_FLASH_VOICES: readonly SystemVoice[] = [
  { voice: 'longanhuan_v3.6', name: '安欢', description: '女 · 约 25 岁 · 亲切自然', languages: '中文、英文', tags: '' },
  { voice: 'longanfengyue', name: '安风月', description: '女 · 约 30 岁 · 自然温暖', languages: '中文、英文', tags: '' },
  { voice: 'longanyuanfei', name: '安元妃', description: '女 · 约 30 岁 · 端庄大气', languages: '中文、英文', tags: '' },
  { voice: 'longanlingxi', name: '安灵犀', description: '女 · 约 25 岁 · 甜美可爱', languages: '中文、英文', tags: '' },
  { voice: 'longanxiaoxin', name: '安小欣', description: '女 · 约 22 岁 · 活泼开朗', languages: '中文、英文', tags: '' },
  { voice: 'longjielidou_v3.6', name: '杰力豆', description: '男孩 · 约 5 岁 · 儿童陪伴', languages: '中文、英文', tags: '儿童' },
  { voice: 'longpaopao_v3.6', name: '泡泡', description: '女孩 · 约 5 岁 · 儿童陪伴', languages: '中文、英文', tags: '儿童' },
  { voice: 'longhuohuo_v3.6', name: '火火', description: '男孩 · 约 8 岁 · 调皮活泼', languages: '中文、英文', tags: '儿童' },
  { voice: 'longchuanshu_v3.6', name: '川叔', description: '男 · 约 40 岁 · 四川口音', languages: '中文、英文', tags: '方言' },
  { voice: 'loongmary', name: 'Mary', description: '女 · 约 20 岁 · 英式英语', languages: '英文', tags: '英语' },
  { voice: 'loongeva_v3.6', name: 'Eva', description: '女 · 约 28 岁 · 美式英语', languages: '英文', tags: '英语' },
  { voice: 'loongjohn', name: 'John', description: '男 · 约 28 岁 · 美式英语', languages: '英文', tags: '英语' },
];
