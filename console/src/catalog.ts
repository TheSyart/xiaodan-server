// 供应商与插件目录。
//
// 上游把这些放在数据库的 ai_model_provider 表里,靠 100 多个 changelog 维护。
// 但它本质上是【代码的镜像】:provider 代号必须与服务端 core/providers 下的
// 模块名逐字对应,字段定义必须与那个 Python 文件读的 key 对应。放进数据库只会
// 让两边悄悄漂移 —— 改了 Python 忘了改库,表现是运行时"不支持的 XXX 类型"。
// 所以这里把它写成代码常量,跟着仓库一起版本化。
//
// 服务端的加载规则(已在容器里核对):
//   ASR / TTS / VAD  →  core/providers/<类型小写>/<provider>.py
//   LLM / Memory / Intent → core/providers/<类型小写>/<provider>/<provider>.py
// 名字写错不会在控制台报错,只会在设备连上来时炸,所以改动这里要对着服务端核。

export type FieldType = 'string' | 'password' | 'number' | 'boolean' | 'text';

export interface ProviderField {
  key: string;
  label: string;
  type: FieldType;
  /** 新建时的预填值 */
  default?: string | number | boolean;
  required?: boolean;
  hint?: string;
}

export interface ProviderDef {
  /** 下发给服务端的 config_json.type,必须与 Python 模块名一致 */
  provider: string;
  label: string;
  fields: ProviderField[];
  /** 该供应商的说明,显示在表单顶部 */
  note?: string;
}

export type ModelType = 'VAD' | 'ASR' | 'LLM' | 'VLLM' | 'TTS' | 'Memory' | 'Intent';

export const MODEL_TYPES: ModelType[] = ['VAD', 'ASR', 'LLM', 'VLLM', 'TTS', 'Memory', 'Intent'];

const OUTPUT_DIR: ProviderField = {
  key: 'output_dir',
  label: '音频临时目录',
  type: 'string',
  default: 'tmp/',
};

export const PROVIDERS: Record<ModelType, ProviderDef[]> = {
  VAD: [
    {
      provider: 'silero',
      label: 'SileroVAD(本地)',
      note: '服务端本地运行,不调用外部接口。模型文件随镜像提供。',
      fields: [
        { key: 'model_dir', label: '模型目录', type: 'string', default: 'models/snakers4_silero-vad' },
        { key: 'threshold', label: '判定阈值', type: 'number', default: 0.5 },
        { key: 'min_silence_duration_ms', label: '静音判停(毫秒)', type: 'number', default: 700 },
      ],
    },
  ],

  ASR: [
    {
      provider: 'gateway_chat',
      label: '网关识别(chat 接口)',
      note:
        '把音频当作 input_audio 内容块经 chat/completions 发给模型网关。' +
        '适用于只代理 chat 接口、没有 /v1/audio/transcriptions 的自建网关。',
      fields: [
        { key: 'base_url', label: '网关地址', type: 'string', required: true },
        { key: 'model_name', label: '识别模型', type: 'string', required: true },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        { key: 'timeout', label: '超时(秒)', type: 'number', default: 30 },
        OUTPUT_DIR,
      ],
    },
    {
      provider: 'openai',
      label: 'OpenAI 兼容转写接口',
      note: '需要对方提供 /v1/audio/transcriptions。自建网关多数不提供,请先确认。',
      fields: [
        { key: 'base_url', label: '转写端点', type: 'string', required: true },
        { key: 'model_name', label: '模型', type: 'string', default: 'whisper-1' },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        OUTPUT_DIR,
      ],
    },
    // 不提供 FunASR 本地识别:引擎镜像为了从 10.5GB 瘦身到约 1.9GB 去掉了它的依赖,
    // 选了也只会在设备连上来时报"不支持的 ASR 类型"。
  ],

  LLM: [
    {
      provider: 'openai',
      label: 'OpenAI 兼容接口',
      note:
        'max_tokens 要给足。推理型模型会先把额度花在隐藏推理 token 上,给小了会收到空回复,' +
        '现象与链路故障几乎一样,很容易误判。',
      fields: [
        { key: 'base_url', label: '接口地址', type: 'string', required: true },
        { key: 'model_name', label: '模型', type: 'string', required: true },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        { key: 'temperature', label: '温度', type: 'number', default: 0.8 },
        { key: 'max_tokens', label: '最大输出 token', type: 'number', default: 1200 },
        { key: 'top_p', label: 'top_p', type: 'number', default: 1 },
        { key: 'frequency_penalty', label: '重复惩罚', type: 'number', default: 0 },
      ],
    },
    {
      provider: 'ollama',
      label: 'Ollama(本地)',
      fields: [
        { key: 'base_url', label: '地址', type: 'string', default: 'http://localhost:11434' },
        { key: 'model_name', label: '模型', type: 'string', required: true },
      ],
    },
    {
      provider: 'gemini',
      label: 'Google Gemini',
      fields: [
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        { key: 'model_name', label: '模型', type: 'string', default: 'gemini-2.0-flash' },
        { key: 'http_proxy', label: 'HTTP 代理', type: 'string' },
      ],
    },
  ],

  VLLM: [
    {
      provider: 'openai',
      label: 'OpenAI 兼容视觉接口',
      note: '仅在设备带摄像头时才会被调用。本硬件没有,可留空不配。',
      fields: [
        { key: 'base_url', label: '接口地址', type: 'string', required: true },
        { key: 'model_name', label: '模型', type: 'string', required: true },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
      ],
    },
  ],

  TTS: [
    {
      provider: 'gateway_omni_tts',
      label: '网关合成(Omni chat 接口)',
      note:
        '用 Qwen-Omni 在 chat 里直接输出音频,适用于没有 /v1/audio/speech 的自建网关。' +
        '返回的是裸 PCM16,provider 会自己补 24000Hz 的 WAV 头。',
      fields: [
        { key: 'base_url', label: '网关地址', type: 'string', required: true },
        { key: 'model_name', label: '合成模型', type: 'string', required: true },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        { key: 'voice', label: '默认音色', type: 'string', default: 'Ethan' },
        { key: 'audio_format', label: '音频格式', type: 'string', default: 'wav' },
        { key: 'timeout', label: '超时(秒)', type: 'number', default: 60 },
        OUTPUT_DIR,
      ],
    },
    {
      provider: 'edge',
      label: 'EdgeTTS(免费)',
      note: '不需要密钥。个别音色会报 NoAudioReceived,换一个即可。',
      fields: [
        { key: 'voice', label: '默认音色', type: 'string', default: 'zh-CN-XiaoxiaoNeural' },
        { key: 'format', label: '音频格式', type: 'string', default: 'mp3' },
        { key: 'volume', label: '音量(-100~100)', type: 'number', default: 50 },
        { key: 'rate', label: '语速(-100~100)', type: 'number', default: 0 },
        { key: 'pitch', label: '音调(-100~100)', type: 'number', default: 0 },
        OUTPUT_DIR,
      ],
    },
    {
      provider: 'openai',
      label: 'OpenAI 兼容合成接口',
      note: '需要对方提供 /v1/audio/speech。',
      fields: [
        { key: 'api_url', label: '合成端点', type: 'string', required: true },
        { key: 'model', label: '模型', type: 'string', default: 'tts-1' },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        { key: 'voice', label: '默认音色', type: 'string', default: 'alloy' },
        { key: 'response_format', label: '返回格式', type: 'string', default: 'wav' },
        OUTPUT_DIR,
      ],
    },
  ],

  Memory: [
    { provider: 'nomem', label: '不记忆', fields: [] },
    {
      provider: 'mem_local_short',
      label: '本地短期记忆',
      note: '用一个 LLM 把历史压成摘要存在服务端。填的是模型配置的 id,例如 LLM_XiaodanGateway。',
      fields: [{ key: 'llm', label: '用于摘要的模型 id', type: 'string', required: true }],
    },
    { provider: 'mem_report_only', label: '仅上报不记忆', fields: [] },
  ],

  Intent: [
    {
      provider: 'nointent',
      label: '不启用工具',
      note: '设备只能闲聊。插件开关在这个模式下不会下发。',
      fields: [],
    },
    {
      provider: 'function_call',
      label: '函数调用(推荐)',
      note: '由模型自行决定何时调工具,要求所选 LLM 支持 function calling。',
      fields: [],
    },
    {
      provider: 'intent_llm',
      label: '独立意图模型',
      note: '每轮先用一个小模型判断意图,再决定是否调工具。多一次往返,延迟更高。',
      fields: [{ key: 'llm', label: '用于意图识别的模型 id', type: 'string', required: true }],
    },
  ],
};

export interface PluginDef {
  /** 与服务端 plugins_func/functions/<code>.py 的文件名一致 */
  code: string;
  label: string;
  description: string;
  fields: ProviderField[];
  /** 不需要任何密钥即可工作 */
  keyless: boolean;
}

export const PLUGINS: PluginDef[] = [
  {
    code: 'get_time',
    label: '查询时间日期',
    description: '回答"今天几号""现在几点""星期几"。用服务器时间,不联网。',
    keyless: true,
    fields: [],
  },
  {
    code: 'handle_exit_intent',
    label: '识别告别意图',
    description: '听懂"再见""拜拜"并主动结束对话,避免连接空转到超时。',
    keyless: true,
    fields: [],
  },
  {
    code: 'change_role',
    label: '切换人设',
    description: '让用户用一句话临时改变说话风格。',
    keyless: true,
    fields: [],
  },
  {
    code: 'get_weather',
    label: '天气预报',
    description: '查询实时天气与未来几天预报。需要和风天气的密钥。',
    keyless: false,
    fields: [
      { key: 'api_key', label: '和风天气 API 密钥', type: 'password', required: true },
      { key: 'api_host', label: 'API 主机', type: 'string', hint: '在和风控制台可查到专属域名' },
      { key: 'default_location', label: '默认城市', type: 'string', default: '广州' },
    ],
  },
  {
    code: 'web_search',
    label: '联网搜索',
    description: '让模型能查它训练数据之外的信息。需要搜索服务的密钥。',
    keyless: false,
    fields: [
      { key: 'provider', label: '搜索源', type: 'string', default: 'tavily', hint: 'metaso 或 tavily' },
      { key: 'api_key', label: '搜索服务密钥', type: 'password', required: true },
      { key: 'max_results', label: '返回条数', type: 'number', default: 3 },
    ],
  },
  {
    code: 'get_news_from_newsnow',
    label: '新闻聚合',
    description: '从 newsnow 拉取热点。公共接口,不需要密钥。',
    keyless: true,
    fields: [
      { key: 'url', label: '接口地址', type: 'string', default: 'https://newsnow.busiyi.world/api/s?id=' },
      { key: 'news_sources', label: '新闻源', type: 'string', default: '澎湃新闻;百度热搜;财联社' },
    ],
  },
  {
    code: 'get_news_from_chinanews',
    label: '中新网新闻',
    description: '读取中新网的 RSS。不需要密钥。',
    keyless: true,
    fields: [
      {
        key: 'default_rss_url',
        label: '默认 RSS 源',
        type: 'string',
        default: 'https://www.chinanews.com.cn/rss/society.xml',
      },
    ],
  },
  {
    code: 'play_music',
    label: '播放本地音乐',
    description: '播放服务端 music 目录里的文件。设备扬声器很小,效果有限。',
    keyless: true,
    fields: [{ key: 'music_dir', label: '音乐目录', type: 'string', default: './music' }],
  },
  {
    code: 'hass_state',
    label: 'HomeAssistant 设备控制',
    description: '通过 HomeAssistant 开关家里的灯与电器。需要 HA 地址与长期令牌。',
    keyless: false,
    fields: [
      { key: 'base_url', label: 'HA 地址', type: 'string', required: true },
      { key: 'api_key', label: 'HA 长期访问令牌', type: 'password', required: true },
    ],
  },
];

export function providerDef(type: ModelType, provider: string): ProviderDef | undefined {
  return PROVIDERS[type].find((item) => item.provider === provider);
}

export function pluginDef(code: string): PluginDef | undefined {
  return PLUGINS.find((item) => item.code === code);
}
