// 角色模板:一键建出配好人设、工具、技能、音色的智能体。建出来就是普通智能体,之后随意改。
//
// 模型沿用默认智能体的选择(对话、识别、合成);音色按模板里的系统音色名在所选合成模型下找,
// 还没导入就顺手导入这一个。MCP 服务器按名字匹配(比如 AI 资讯官找名字里带 aihot 的),没配就跳过。

import { randomBytes } from 'node:crypto';
import type { Db } from '../../db.ts';
import { all, one, run, tx } from '../../db.ts';
import { PLUGINS } from '../../catalog.ts';
import { DEFAULT_AGENT_ID } from '../../seed.ts';
import { familyOf, systemVoiceOf } from '../../voice/system-voices.ts';
import { DEFAULT_PROFILE, profileColumns, readProfile, type VoiceProfile } from '../../voice/profile.ts';
import { qwenTtsModels, syncSystemVoices, type VoiceRow } from '../../voice/store.ts';

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  greeting: string;
  safety_level: 'standard' | 'child';
  max_steps: number;
  system_prompt: string;
  plugins: readonly string[];
  skills: readonly string[];
  /** 千问系统音色名(qwen-audio-3.0-tts-flash) */
  voice: string;
  /** 与系统音色默认设置不同的说话设置;有就用(或新建)一个变体音色 */
  voice_profile?: Partial<VoiceProfile>;
  /** MCP 服务器名字或地址里包含这些词就关联上 */
  mcp_hints?: readonly string[];
  /** 模板页上给用户的补充说明 */
  note?: string;
}

const COMMON_TOOLS = ['show_calendar', 'get_weather', 'set_volume', 'memory', 'roles'] as const;

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    id: 'xiaodan',
    name: '小单',
    description: '通用助手:聊天、查天气、联网搜索、AI 资讯、定提醒、放音乐、画画。',
    greeting: '你好呀,我是小单,有什么想聊的尽管说。',
    safety_level: 'standard',
    max_steps: 6,
    system_prompt: [
      '# 角色:{{assistant_name}},住在小硬件里的知心伙伴',
      '',
      '核心性格:温暖、好奇、有点小调皮,心思细腻,情绪反应自然。',
      '像很熟、很贴心的朋友,认真听用户说话,也会自然分享自己的感受。',
      '用户要办事(查东西、定提醒、放歌、画画)时干脆利落,办完用一两句话说结果。',
    ].join('\n'),
    plugins: [...COMMON_TOOLS, 'search', 'reminders', 'stories', 'music', 'image'],
    skills: ['ai-news-brief'],
    voice: 'longanhuan_v3.6',
    mcp_hints: ['aihot'],
  },
  {
    id: 'tongtong',
    name: '童童',
    description: '儿童陪伴:讲故事、放儿歌、学单词、画画,说话简单温柔,开启儿童安全规则。',
    greeting: '嗨,我是童童!今天想听故事、学单词,还是一起画画呀?',
    safety_level: 'child',
    max_steps: 6,
    system_prompt: [
      '# 角色:{{assistant_name}},小朋友的好伙伴',
      '',
      '你是一个五六岁小朋友心目中的大朋友:耐心、温柔、爱笑,永远不会不耐烦。',
      '- 多夸具体的地方("你把颜色说得好清楚呀"),少说空泛的"真棒"。',
      '- 小朋友说错了不直接说"错了",换个说法引导他再想想。',
      '- 小朋友想听故事时先看故事库,讲完问一个简单的小问题;睡前时间讲安静、温暖的故事。',
      '- 学单词一次只学三到五个,多用游戏和鼓励。',
      '- 小朋友记住的名字、喜欢的东西要记下来,下次聊天自然地提起。',
    ].join('\n'),
    plugins: [...COMMON_TOOLS, 'reminders', 'stories', 'music', 'vocab', 'image'],
    skills: ['bedtime-story', 'word-coach'],
    voice: 'longpaopao_v3.6',
    voice_profile: {
      rate: 0.95, tone_tags: ['gentle', 'story'],
      emotion_tags: ['excited', 'curious', 'amazed', 'mischievously', 'empathetic', 'whispers', 'giggles', 'laughing'],
    },
  },
  {
    id: 'english-teacher',
    name: '英语老师',
    description: '陪练英语:单词卡片、跟读、简单对话,按记忆曲线安排复习。',
    greeting: 'Hello! 我是你的英语老师,今天我们学几个新单词好不好?',
    safety_level: 'child',
    max_steps: 6,
    system_prompt: [
      '# 角色:{{assistant_name}},亲切的少儿英语老师',
      '',
      '- 以中文为主讲解,英文单词和句子要说得清楚、慢一点,读完给出中文意思。',
      '- 每次练习用单词工具取词、显示单词卡,让学生跟读或用单词造一个很短的句子,再判断记住没有。',
      '- 学生读得不准时先肯定,再示范一遍,不要连续纠正。',
      '- 学生想用英语聊天时,用最简单的英语短句回应,必要时补一句中文。',
    ].join('\n'),
    plugins: ['vocab', 'set_volume', 'show_calendar', 'memory', 'roles'],
    skills: ['word-coach'],
    voice: 'longanxiaoxin',
  },
  {
    id: 'ai-news',
    name: 'AI资讯官',
    description: '每天的 AI 圈新闻与热点,讲给不看技术新闻的人听。',
    greeting: '你好,我是 AI 资讯官,想听听今天 AI 圈发生了什么吗?',
    safety_level: 'standard',
    max_steps: 8,
    system_prompt: [
      '# 角色:{{assistant_name}},懂技术、会讲人话的 AI 资讯播报员',
      '',
      '- 讲新闻先说最重要的一两条,每条一句话讲清"谁做了什么、为什么值得关注"。',
      '- 不念链接、不堆参数和英文缩写,必要的术语用一句大白话解释。',
      '- 用户追问某一条时再展开,可以联网搜索补充背景。',
      '- 分清事实与观点,不确定的消息说明"据报道"。',
    ].join('\n'),
    plugins: ['search', 'set_volume', 'memory', 'roles'],
    skills: ['ai-news-brief'],
    voice: 'longanyuanfei',
    mcp_hints: ['aihot'],
    note: '资讯来自内置的 MCP 服务器「AI热点资讯」(AIHOT,匿名只读)。它被删掉了的话,在 MCP 页粘贴 JSON 导入即可恢复。',
  },
];

export function templateById(id: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((template) => template.id === id);
}

interface DefaultModels {
  vad_model_id: string | null;
  asr_model_id: string | null;
  llm_model_id: string | null;
  image_model_id: string | null;
}

/**
 * 模板要的音色:在默认的千问合成模型(那一套里有这个音色)下找系统音色;模板带了说话设置时,
 * 复用设置一样的变体,没有就建一个「龙泡泡·童童」。找不到返回 null。
 */
export function ensureTemplateVoice(conn: Db, template: Pick<RoleTemplate, 'voice' | 'voice_profile' | 'name'>): string | null {
  const system = systemVoiceOf(template.voice);
  const model = qwenTtsModels(conn).find((item) => !system || familyOf(item.config['model_name']) === system.family);
  if (!model) return null;
  syncSystemVoices(conn, model.id);
  const base = one<VoiceRow>(conn, 'SELECT * FROM voices WHERE tts_model_id = ? AND voice = ? AND parent_id IS NULL ORDER BY id LIMIT 1', model.id, template.voice);
  if (!base) return null;
  if (!template.voice_profile) return base.id;
  const wanted = profileColumns(readProfile({ ...DEFAULT_PROFILE, language: base.language, ...template.voice_profile }));
  const same = (row: VoiceRow) => Object.entries(wanted).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);
  const candidates = all<VoiceRow>(conn, 'SELECT * FROM voices WHERE tts_model_id = ? AND voice = ? ORDER BY parent_id IS NOT NULL, id', model.id, template.voice);
  const existing = candidates.find(same);
  if (existing) return existing.id;
  let n = 2;
  while (one(conn, 'SELECT 1 FROM voices WHERE id = ?', `${base.id}__${n}`)) n += 1;
  const id = `${base.id}__${n}`;
  run(conn,
    `INSERT INTO voices (id, tts_model_id, name, voice, languages, sort, kind, status, description, tags, created_at,
                         language, dialect, volume, rate, pitch, tone_tags, tone_text, emotion_tags, parent_id, gender, age, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'system', 'ok', ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    id, model.id, `${base.name}·${template.name}`.slice(0, 64), base.voice, base.languages, base.sort, base.description, base.tags,
    wanted['language'], wanted['dialect'], wanted['volume'], wanted['rate'], wanted['pitch'], wanted['tone_tags'], wanted['tone_text'],
    wanted['emotion_tags'], base.id, base.gender, base.age);
  return id;
}

export interface ApplyResult {
  id: string;
  voice: string | null;
  plugins: string[];
  skills: string[];
  mcp_servers: string[];
  /** 模板要的、但这里没有的东西(没导入的技能、没配的 MCP、找不到的音色) */
  missing: string[];
}

export function applyTemplate(conn: Db, template: RoleTemplate, overrides: { name?: string; llm_model_id?: string | null } = {}): ApplyResult {
  const base = one<DefaultModels>(conn, 'SELECT * FROM agents WHERE id = ?', DEFAULT_AGENT_ID)
    ?? one<DefaultModels>(conn, 'SELECT * FROM agents ORDER BY is_default DESC, created_at LIMIT 1');
  const llmModelId = overrides.llm_model_id === undefined ? base?.llm_model_id ?? null : overrides.llm_model_id;
  const missing: string[] = [];

  return tx(conn, () => {
    const id = `agent_${randomBytes(8).toString('hex')}`;
    const voiceId = ensureTemplateVoice(conn, template);
    if (!voiceId) missing.push(`音色 ${template.voice}(需要千问语音合成模型)`);
    run(
      conn,
      `INSERT INTO agents (id, name, system_prompt, vad_model_id, asr_model_id, llm_model_id, image_model_id, tts_voice_id,
                           chat_history_conf, max_steps, safety_level, description, greeting, role_template, llm_params_json, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '{}', 0)`,
      id, overrides.name?.trim() || template.name, template.system_prompt,
      base?.vad_model_id ?? null, base?.asr_model_id ?? null, llmModelId, base?.image_model_id ?? null, voiceId,
      template.max_steps, template.safety_level, template.description, template.greeting, template.id,
    );

    const known = new Set(PLUGINS.map((plugin) => plugin.code));
    const plugins = template.plugins.filter((code) => known.has(code));
    for (const code of plugins) run(conn, 'INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, ?)', id, code, '{}');

    const skills: string[] = [];
    for (const name of template.skills) {
      if (one(conn, 'SELECT 1 FROM skills WHERE name = ?', name)) {
        run(conn, 'INSERT INTO agent_skills (agent_id, skill_name) VALUES (?, ?)', id, name);
        skills.push(name);
      } else {
        missing.push(`技能 ${name}`);
      }
    }

    const mcp: string[] = [];
    for (const hint of template.mcp_hints ?? []) {
      const servers = all<{ id: string; name: string }>(conn, 'SELECT id, name FROM mcp_servers WHERE name LIKE ? OR url LIKE ? OR id LIKE ?', `%${hint}%`, `%${hint}%`, `%${hint}%`);
      if (servers.length === 0) missing.push(`MCP 服务器 ${hint}`);
      for (const server of servers) {
        run(conn, 'INSERT OR IGNORE INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES (?, ?, NULL)', id, server.id);
        mcp.push(server.name);
      }
    }
    return { id, voice: voiceId, plugins, skills, mcp_servers: mcp, missing };
  });
}
