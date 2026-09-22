// 供应商与插件目录。
//
// 上游把这些放在数据库的 ai_model_provider 表里,靠 100 多个 changelog 维护。
// 但它本质上是【代码的镜像】:provider 代号必须与服务端 core/providers 下的
// 模块名逐字对应,字段定义必须与那个 Python 文件读的 key 对应。放进数据库只会
// 让两边悄悄漂移 —— 改了 Python 忘了改库,表现是运行时"不支持的 XXX 类型"。
// 所以这里把它写成代码常量,跟着仓库一起版本化。
//
// 模型类型:
//   VAD    本地语音活动检测,引擎内部用,只有一种,页面不展示
//   ASR    语音识别,千问(百炼)
//   TTS    语音合成,千问(百炼);音色与说话设置在音色页
//   LLM    对话模型,OpenAI 兼容接口;「支持看图」开关决定智能体有没有视觉能力
//   Image  文生图,千问(百炼);只在控制塔里用(画画工具),不下发给引擎
// 工具能不能用、记不记忆,都由每个智能体自己勾选,不再是模型类型。
//
// 服务端的加载规则(已在容器里核对):ASR / TTS / VAD → core/providers/<类型小写>/<provider>.py。
// 对话模型不下发给引擎:引擎的 LLM 固定是转发到控制塔的 xiaodan_agent。

export type FieldType = 'string' | 'password' | 'number' | 'boolean' | 'text' | 'select';

export interface ProviderField {
  key: string;
  label: string;
  type: FieldType;
  /** 新建时的预填值 */
  default?: string | number | boolean;
  required?: boolean;
  hint?: string;
  /** type 为 select 时的可选项 */
  options?: { value: string; label: string }[];
  /** type 为 select 时,可选项由接口按库里的数据现填:文生图模型、单词书 */
  optionsFrom?: 'image_models' | 'vocab_books';
  /** type 为 number 时的范围 */
  min?: number;
  max?: number;
  /** 文字类字段的字数上限,不填是 200。介绍稿这类整段文字要显式放宽 */
  maxLength?: number;
}

export interface ProviderDef {
  /** 下发给服务端的 config_json.type,必须与 Python 模块名一致 */
  provider: string;
  label: string;
  fields: ProviderField[];
  /** 该供应商的说明,显示在表单顶部 */
  note?: string;
}

export type ModelType = 'VAD' | 'ASR' | 'LLM' | 'TTS' | 'Image';

export const MODEL_TYPES: ModelType[] = ['VAD', 'ASR', 'LLM', 'TTS', 'Image'];

/** 模型页上展示、可以增删改的类型 */
export const EDITABLE_MODEL_TYPES: ModelType[] = ['LLM', 'ASR', 'TTS', 'Image'];

const OUTPUT_DIR: ProviderField = {
  key: 'output_dir',
  label: '音频临时目录',
  type: 'string',
  default: 'tmp/',
};

const BAILIAN_KEY: ProviderField[] = [
  { key: 'api_key', label: '百炼 API Key', type: 'password', required: true },
  { key: 'workspace_id', label: '业务空间 ID', type: 'string', hint: '推荐填写;与接口地址二选一' },
  { key: 'base_url', label: '接口地址', type: 'string', hint: '可以直接填业务空间地址 https://<业务空间>.cn-beijing.maas.aliyuncs.com/api/v1;留空按业务空间 ID 自动拼' },
];

/** 文生图模型:同步的直接出图,异步的(万相)要轮询任务 */
export const IMAGE_MODELS: { value: string; label: string; async: boolean }[] = [
  { value: 'qwen-image-3.0-pro', label: 'qwen-image-3.0-pro(千问图像 3.0,推荐)', async: false },
  { value: 'qwen-image-2.0', label: 'qwen-image-2.0', async: false },
  { value: 'z-image-turbo', label: 'z-image-turbo(快、便宜)', async: false },
  { value: 'wan2.7-image', label: 'wan2.7-image(万相)', async: true },
  { value: 'wan2.7-image-pro', label: 'wan2.7-image-pro(万相专业版)', async: true },
];

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
      provider: 'qwen_audio_asr',
      label: '千问语音识别(百炼 Qwen-Audio 3.0)',
      note:
        '松手后整段音频一次识别,走百炼同步接口,单段 5 分钟以内。业务空间 ID 在百炼控制台「业务空间」里;' +
        '填了就走业务空间专属域名,不填走 dashscope.aliyuncs.com。热词每行一个,可写「词|权重」,权重 1-5。',
      fields: [
        ...BAILIAN_KEY,
        { key: 'model_name', label: '识别模型', type: 'string', default: 'qwen-audio-3.0-asr-flash' },
        { key: 'vocabulary', label: '热词', type: 'text', default: '小单|5' },
        { key: 'language_hints', label: '语种提示', type: 'string', hint: '逗号分隔,如 zh,en;留空自动识别' },
        { key: 'timeout', label: '超时(秒)', type: 'number', default: 8 },
        OUTPUT_DIR,
      ],
    },
  ],

  LLM: [
    {
      provider: 'openai',
      label: 'OpenAI 兼容接口(DeepSeek、百炼、Ollama……)',
      note:
        'max_tokens 要给足。推理型模型会先把额度花在隐藏推理 token 上,给小了会收到空回复,' +
        '现象与链路故障几乎一样,很容易误判。模型本身能看图(比如 qwen-vl、qwen3.5-plus)才打开「支持看图」。',
      fields: [
        {
          key: 'base_url', label: '接口地址', type: 'string', required: true,
          hint: '百炼填业务空间地址 https://<业务空间>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1;填成 /api/v1 也会自动换成兼容模式',
        },
        { key: 'model_name', label: '模型', type: 'string', required: true, hint: '百炼里的模型名,例如 qwen3.6-plus、deepseek-v4-flash' },
        { key: 'api_key', label: 'API 密钥', type: 'password', required: true },
        { key: 'vision', label: '支持看图', type: 'boolean', default: false, hint: '打开后智能体可以看懂用户发来的图片;模型不支持时不要打开' },
        { key: 'temperature', label: '温度', type: 'number', default: 0.8 },
        { key: 'max_tokens', label: '最大输出 token', type: 'number', default: 1200 },
        { key: 'top_p', label: 'top_p', type: 'number', default: 1 },
        { key: 'frequency_penalty', label: '重复惩罚', type: 'number', default: 0 },
      ],
    },
  ],

  TTS: [
    {
      provider: 'qwen_audio_tts',
      label: '千问语音合成(百炼 Qwen-Audio 3.0)',
      note:
        '每句话一个流式合成任务,边合成边播。这一套的系统音色会自动出现在「音色」页;音量、语速、方言、语气也在音色页按音色设置。' +
        'flash 与 plus 的音色不能混用,复刻与设计出的音色只能用于创建时的合成模型。',
      fields: [
        ...BAILIAN_KEY,
        {
          key: 'model_name', label: '合成模型', type: 'select', default: 'qwen-audio-3.0-tts-flash',
          options: [
            { value: 'qwen-audio-3.0-tts-flash', label: 'qwen-audio-3.0-tts-flash(快,12 个系统音色)' },
            { value: 'qwen-audio-3.0-tts-plus', label: 'qwen-audio-3.0-tts-plus(旗舰,2 个系统音色)' },
          ],
        },
        OUTPUT_DIR,
      ],
    },
  ],

  Image: [
    {
      provider: 'qwen_image',
      label: '千问文生图(百炼)',
      note:
        '「画画」工具用它出图:原图存进画廊,设备屏幕显示 128×128 的像素画。可以直接用语音模型那把百炼 API Key 与业务空间。' +
        '万相模型是异步任务,出图要多等几秒。',
      fields: [
        ...BAILIAN_KEY,
        {
          key: 'model_name', label: '文生图模型', type: 'select', default: 'qwen-image-3.0-pro',
          options: IMAGE_MODELS.map((model) => ({ value: model.value, label: model.label })),
        },
        {
          key: 'size', label: '图片尺寸', type: 'select', default: '1024*1024',
          options: [
            { value: '1024*1024', label: '1024 × 1024(推荐)' },
            { value: '768*768', label: '768 × 768' },
            { value: '1280*1280', label: '1280 × 1280' },
          ],
          hint: '设备上只显示 128 × 128,尺寸越大越慢越贵',
        },
        { key: 'prompt_extend', label: '让百炼改写提示词', type: 'boolean', default: false, hint: '画面更丰富,但多花几秒' },
        { key: 'negative_prompt', label: '不要出现的内容', type: 'text', hint: '例如:文字,水印,恐怖' },
      ],
    },
  ],
};

/**
 * 工具:服务端代码实现的能力(另两类是技能与 MCP)。工具页查看说明、改设置;设置全局一份,存在 tool_settings;
 * 智能体页只决定开不开(agent_plugins)。
 */
export interface PluginDef {
  /** 工具代号。引擎工具与服务端 plugins_func/functions/<code>.py 的文件名一致 */
  code: string;
  label: string;
  description: string;
  /** 工具页里可以改的设置,所有智能体共用 */
  fields: ProviderField[];
  /** 不需要任何密钥即可工作 */
  keyless: boolean;
  /** 分组显示用 */
  group: string;
  /**
   * 这项能力有自己的页面:工具页不给它列卡片,只在页尾指个路;智能体页照常显示开关。
   * 它仍留在 PLUGINS 里,是因为「哪个角色开着它」还是记在 agent_plugins。
   */
  page?: { path: string; label: string };
}

export const PLUGINS: PluginDef[] = [
  // 前三个在引擎里执行(server/plugins/,构建时覆盖进引擎镜像),控制塔经设备桥调用,会在设备屏幕上显示画面;
  // 其余在控制塔里实现(console/src/agent/)。模型看到的函数说明都以控制塔为准(engine-tools.ts 与各工具模块)。
  {
    code: 'show_calendar',
    group: '生活',
    label: '日期与日历',
    description: '回答"今天几号""星期几""农历几号",并在设备屏幕上显示当月日历。用服务器时间,不联网。',
    keyless: true,
    fields: [
      { key: 'hold_s', label: '屏幕停留秒数', type: 'number', default: 20, min: 5, max: 60, hint: '回答说完后日历停留多久,5 到 60' },
    ],
  },
  {
    code: 'get_weather',
    group: '生活',
    label: '天气',
    description: '查实时天气与明天预报,并在设备屏幕上显示天气画面。没说城市时按设备 IP 所在城市查。数据来自 Open-Meteo,出错时改用 wttr.in,都不需要密钥。',
    keyless: true,
    fields: [
      { key: 'default_location', label: '默认城市', type: 'string', default: '广州', hint: '按设备 IP 查不到所在城市时查这里' },
      { key: 'hold_s', label: '屏幕停留秒数', type: 'number', default: 20, min: 5, max: 60, hint: '回答说完后天气画面停留多久,5 到 60' },
    ],
  },
  {
    code: 'set_volume',
    group: '生活',
    label: '语音调音量',
    description: '听懂"大声点""音量调到一半",直接调节设备音量。需要小单固件,原版小智固件会回答"请用按键调"。',
    keyless: true,
    fields: [],
  },
  {
    code: 'search',
    label: '联网搜索',
    description: '查新闻、赛事、股价、刚发生的事等实时信息。用哪家搜索服务在工具页配置,可以配多家,默认那家生效。',
    keyless: false,
    group: '信息',
    fields: [],
  },
  {
    code: 'reminders',
    label: '定时提醒',
    description: '"八点提醒我喝水""每天七点叫我起床"。到点设备响提示音并播报,屏幕显示提醒卡片;设备不在线时下次连上补报。',
    keyless: true,
    group: '生活',
    fields: [],
  },
  {
    code: 'stories',
    label: '讲故事',
    description: '播放故事库里的有声故事(原创故事,音频由千问合成)。故事在「内容库」页管理。',
    keyless: true,
    group: '陪伴',
    fields: [],
  },
  {
    code: 'music',
    label: '放音乐',
    description: '播放曲库里的音乐(许可核实过的古典与童谣录音,也可以自己上传)。播放中按设备上的说话键即可停止。',
    keyless: true,
    group: '陪伴',
    fields: [],
  },
  {
    code: 'vocab',
    label: '学单词',
    description: '陪小朋友学英语单词:在设备上显示单词卡组(新固件,按键翻看、听读音)、记录答题、按记忆曲线安排复习。单词书在「内容库」页管理。',
    keyless: true,
    group: '学习',
    fields: [{ key: 'book', label: '单词书', type: 'select', optionsFrom: 'vocab_books', hint: '留空用内容库里排第一的那本' }],
  },
  {
    code: 'credits',
    label: '学分',
    description: '孩子问「我有多少分」「还差多少能看电视」时查学分;说「数学写完了」时记下来等爸爸妈妈检查打分;'
      + '分够时直接兑换奖励。智能体【不能加分、打分】,那些只能家长在「学分」页或 App 上做。',
    keyless: true,
    group: '学习',
    fields: [],
  },
  {
    code: 'image',
    label: '画画',
    description: '按描述画一幅画:设备屏幕显示 128×128 的像素画版本(需要新固件),原图保存在画廊。文生图模型在「模型」页添加。',
    keyless: false,
    group: '创作',
    fields: [{ key: 'model_id', label: '文生图模型', type: 'select', optionsFrom: 'image_models', hint: '留空用「模型」页里标为默认的那个' }],
  },
  {
    code: 'memory',
    label: '长期记忆',
    description: '记住关于用户的事(称呼、喜好、家人、作息……),换了角色、过了几天也记得;每段对话还会整理成档案。在「记忆」页查看与管理。',
    keyless: true,
    group: '陪伴',
    fields: [],
    page: { path: '/memory', label: '记忆' },
  },
  {
    code: 'introduce_self',
    group: '角色',
    label: '自我介绍',
    description: '小朋友问"你是谁""你有什么本事"时,把一段写好的稿子念出来。稿子在这里改,语气由模型按"激情"演绎。',
    keyless: true,
    fields: [
      {
        key: 'script',
        label: '介绍稿',
        type: 'text',
        maxLength: 1500,
        hint: '留空就用内置那份。这段会被一字不改地念出来:写成口语,不要 markdown 标记(** 会被念成"星号"),最多 1500 字',
      },
    ],
  },
  {
    code: 'roles',
    label: '切换角色',
    description: '"换童童来陪我""切换到英语老师"。能切到哪些角色在设备页设置;新角色的声音不同时,设备会重连一下,再用新声音打招呼。',
    keyless: true,
    group: '角色',
    fields: [],
  },
];

export function providerDef(type: ModelType, provider: string): ProviderDef | undefined {
  return PROVIDERS[type].find((item) => item.provider === provider);
}

export function pluginDef(code: string): PluginDef | undefined {
  return PLUGINS.find((item) => item.code === code);
}
