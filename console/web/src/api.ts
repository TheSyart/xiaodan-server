// 与后端通信的薄封装。会话是 HttpOnly Cookie,所以这里不碰 token。

export interface ApiError extends Error {
  status: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    // 会话过期:由 App.vue 统一带回登录页
    if (response.status === 401) window.dispatchEvent(new Event('xiaodan:unauthorized'));
    const error = new Error(
      (data as { error?: string } | null)?.error ?? `请求失败(${response.status})`,
    ) as ApiError;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

async function failure(response: Response): Promise<ApiError> {
  if (response.status === 401) window.dispatchEvent(new Event('xiaodan:unauthorized'));
  let message = `请求失败(${response.status})`;
  try {
    message = ((await response.json()) as { error?: string }).error ?? message;
  } catch {
    /* 非 JSON 错误体 */
  }
  const error = new Error(message) as ApiError;
  error.status = response.status;
  return error;
}

/**
 * 拼进 URL 的 MAC:去掉冒号写紧凑形式(如 4c11ae317a30)。
 * 冒号会被编码成 %3A,而运维面板的统一 Auth 把「%3A 后面跟小写十六进制字母」
 * 误判成小写的百分号编码,整条请求会被它 400 掉。后端 canonicalMac 两种都认。
 */
export const urlMac = (mac: string) => mac.replaceAll(':', '').toLowerCase();

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** 提交 JSON、拿回二进制(音频试听) */
  async postForBlob(path: string, body: unknown): Promise<Blob> {
    const response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return response.blob();
  },
  /** 以原始字节提交文件(声音复刻样本) */
  async postBlob<T>(path: string, blob: Blob): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  },
};

// ---- 后端返回的数据形状 ----

export interface SetupStatus {
  /** proxy = 鉴权由运维面板负责;local = 控制台自己管一个管理员账号 */
  mode: 'proxy' | 'local';
  initialized: boolean;
  authenticated: boolean;
}

export interface ProviderField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'text' | 'select';
  default?: string | number | boolean;
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** 下拉选项由接口按库里的数据现填(工具页) */
  optionsFrom?: 'image_models' | 'vocab_books';
  min?: number;
  max?: number;
}

export interface ProviderDef {
  provider: string;
  label: string;
  note?: string;
  fields: ProviderField[];
}

export interface PluginDef {
  code: string;
  label: string;
  description: string;
  keyless: boolean;
  fields: ProviderField[];
  group: string;
}

/** 音色设置的词表(与控制塔 voice/profile.ts 一致) */
export interface VoiceCatalog {
  languages: { label: string; code: string; english: string; sample: string }[];
  dialects: string[];
  tone_chips: { id: string; label: string; phrase: string }[];
  control_tags: { tag: string; label: string }[];
  rich_tags: { tag: string; label: string }[];
  recommended_tags: string[];
  instruction_units: number;
}

export interface Catalog {
  providers: Record<string, ProviderDef[]>;
  plugins: PluginDef[];
  modelTypes: string[];
  voice: VoiceCatalog;
}

export interface Model {
  id: string;
  model_type: string;
  name: string;
  provider: string;
  config_json: string;
  is_default: number;
  enabled: number;
  remark: string;
}

/** 音色的说话设置 */
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

export interface Voice extends VoiceProfile {
  id: string;
  tts_model_id: string;
  model_label: string;
  model_name: string;
  family: 'flash' | 'plus';
  name: string;
  /** 百炼里的音色值 */
  voice: string;
  /** 能说的语种 */
  languages: string[];
  /** system 百炼自带;design 声音设计;clone 声音复刻 */
  kind: 'system' | 'design' | 'clone';
  /** 设计与复刻的音色要百炼审核通过(ok)才能用 */
  status: 'ok' | 'pending' | 'failed';
  description: string;
  tags: string;
  prompt: string;
  status_detail: string;
  created_at: string | null;
  updated_at: string | null;
  gender: string;
  age: number | null;
  /** 复制出来的变体指回原音色 */
  parent_id: string | null;
  /** 与所属合成模型相符(flash/plus 不能混用) */
  compatible: boolean;
  /** 合成出来的语气指令 */
  instruction: string;
  summary: string;
  agent_count: number;
  agents: { id: string; name: string }[];
}

export interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  asr_model_id: string | null;
  llm_model_id: string | null;
  /** 智能体绑一个音色:合成模型、音量语速、方言语气都跟着它 */
  tts_voice_id: string | null;
  chat_history_conf: number;
  max_steps: number;
  safety_level: 'standard' | 'child';
  description: string;
  greeting: string;
  role_template: string;
  /** {"thinking":false,"temperature":0.8} */
  llm_params_json: string;
  /** 开着的能力:MCP 服务器 id、技能名、工具代号。能力自己的设置在各自的页面 */
  mcp_servers: string[];
  skills: string[];
  is_default: number;
  plugins: string[];
  device_count: number;
}

/** 工具页的一项:服务端代码实现的能力,只能查看和改设置 */
export interface ToolView {
  code: string;
  label: string;
  description: string;
  group: string;
  keyless: boolean;
  runs_in: 'engine' | 'console';
  fields: ProviderField[];
  config: Record<string, unknown>;
  functions: { name: string; description: string }[];
  status: { ready: boolean; message: string };
  agents: { id: string; name: string }[];
  skills: string[];
  /** 有自己的页面时:工具页只指路 */
  page?: { path: string; label: string };
}

export interface Device {
  mac: string;
  agent_id: string;
  agent_name: string | null;
  alias: string;
  board: string;
  app_version: string;
  last_connected_at: string | null;
  created_at: string;
  /** verified = 用绑定码配对过、每次连接都核验身份;legacy = 身份校验上线前绑定,需重新配对才能对话 */
  identity: 'verified' | 'legacy';
  /** 1 = 这台设备允许定位(默认关) */
  locate: number;
  loc_source: 'wifi' | 'ip' | null;
  loc_lng: number | null;
  loc_lat: number | null;
  loc_radius: number | null;
  loc_province: string | null;
  loc_city: string | null;
  loc_district: string | null;
  loc_address: string | null;
  loc_error: string | null;
  loc_at: string | null;
}

/** 角色模板:一键建出配好人设、工具、技能与音色的智能体 */
export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  greeting: string;
  safety_level: 'standard' | 'child';
  plugins: string[];
  /** 千问系统音色名 */
  voice: string;
  voice_name: string;
  note?: string;
  /** 已经用这个模板建过几个 */
  created: number;
}

export interface RoleTemplateApplied {
  id: string;
  voice: string | null;
  plugins: string[];
  mcp_servers: string[];
  missing: string[];
}

/** 热记忆:一条一件关于用户的事。住址与联系方式标成 sensitive,页面上默认打码 */
export interface MemoryFact {
  id: number;
  text: string;
  kind: string;
  kind_label: string;
  sensitive: number;
  source: 'agent' | 'admin' | 'archive';
  agent_id: string | null;
  agent_name: string | null;
  created_at: string;
  updated_at: string;
}

/** 记忆的一次变更,可以撤销 */
export interface MemoryChange {
  id: number;
  op: 'add' | 'update' | 'delete';
  fact_id: number | null;
  before_text: string;
  after_text: string;
  kind_label: string;
  sensitive: number;
  reason: string;
  source: 'agent' | 'admin' | 'archive';
  agent_name: string | null;
  undone: number;
  created_at: string;
}

export interface MemoryOverview {
  devices: { mac: string; alias: string; agent_id: string; agent_name: string | null }[];
  device: {
    mac: string;
    alias: string;
    agent_id: string;
    /** 这台设备当前的角色开没开记忆 */
    enabled: boolean;
    facts: number;
    sensitive: number;
    max_facts: number;
    max_chars: number;
    arcs: number;
    arc_from: string | null;
    arc_to: string | null;
    arcs_this_month: number;
    /** 还没整理成档案的原文条数 */
    unarchived: number;
  } | null;
  kinds: { kind: string; label: string; sensitive: boolean }[];
  agents_with_memory: { id: string; name: string }[];
}

/** 冷记忆:一段对话的档案 */
export interface MemoryArc {
  id: number;
  title: string;
  summary: string;
  bullets: string[];
  topics: string[];
  agent_name: string | null;
  started_at: string;
  ended_at: string;
  duration_s: number;
  turns: number;
  messages: number;
  sessions: number;
  status: 'pending' | 'ready' | 'failed' | 'skipped' | 'raw_gone';
  error: string;
  has_raw: boolean;
}

export interface MemorySettings {
  scope: string;
  summaryModelId: string;
  rawKeepDays: number;
  minTurns: number;
  default_scope: string;
  models: { id: string; name: string }[];
}

/** 正在等待绑定的设备身份。绑定码只显示在设备屏幕上,这里刻意没有。 */
export interface PendingDevice {
  id: number;
  mac: string;
  board: string;
  app_version: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** 同一 MAC 下正在等待绑定的身份数。大于 1 说明有别的设备在用这个 MAC。 */
  same_mac_count: number;
}

export interface IdentityEvent {
  id: number;
  mac: string;
  kind: 'mismatch' | 'missing_identity' | 'legacy_unverified';
  source: 'ota' | 'engine';
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DeviceList {
  items: Device[];
  pending: PendingDevice[];
  events: IdentityEvent[];
}

export interface Setting {
  key: string;
  value: string;
  value_type: string;
  label: string;
}

export interface ChatSession {
  session_id: string;
  mac: string;
  messages: number;
  started_at: string;
  ended_at: string;
}

export interface ChatMessage {
  id: number;
  chat_type: number;
  content: string;
  created_at: string;
}

export interface Overview {
  devices: number;
  pending: number;
  agents: number;
  models: number;
  messages: number;
  settings: number;
}

export interface CorrectWord {
  id: number;
  agent_id: string;
  source: string;
  target: string;
}

export interface RuntimeStatus {
  bridge: { ok: boolean; connections?: number; error?: string };
  bridge_url: string;
  turn_url: string;
}

/**
 * 以流的方式读一个 text/event-stream 接口,每解析出一个事件回调一次。
 * EventSource 只能发 GET,试聊要 POST 一段 JSON,所以自己解析。
 */
export async function postEventStream(
  path: string, body: unknown, onEvent: (event: Record<string, unknown>) => void, signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) throw await failure(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* 忽略坏事件 */
      }
    }
  }
}

export interface ServiceField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'model';
  default?: string | number;
  required?: boolean;
  hint?: string;
}

export interface ServiceDef {
  provider: string;
  label: string;
  note: string;
  fields: ServiceField[];
}

export interface ServiceProvider {
  id: string;
  kind: 'search';
  name: string;
  provider: string;
  config: Record<string, unknown>;
  is_default: number;
  enabled: number;
}

export interface McpServerView {
  id: string;
  name: string;
  url_masked: string;
  url?: string;
  headers: Record<string, string>;
  timeout_ms: number;
  /** 使用说明:角色开着这个服务器时写进提示词 */
  instructions: string;
  tools: { name: string; description: string }[];
  /** 对外提供哪些工具;null 表示全部 */
  tool_allowlist: string[] | null;
  tools_updated_at: string | null;
  last_error: string;
  agents: { id: string; name: string }[];
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  files: string[];
  allowed_tools: string;
  source: 'builtin' | 'custom';
  updated_at: string;
  agents: { id: string; name: string }[];
}

export interface Reminder {
  id: number;
  mac: string;
  alias: string | null;
  text: string;
  due_at: string;
  due_local: string;
  repeat: 'none' | 'daily' | 'weekdays' | 'weekly';
  status: 'pending' | 'delivered' | 'missed' | 'cancelled';
  attempts: number;
  delivered_at: string | null;
}

export interface MediaItem {
  id: string;
  kind: 'story' | 'music';
  title: string;
  aliases: string[];
  tags: string[];
  summary: string;
  body?: string;
  body_chars: number;
  voice_instruction: string;
  file: string;
  audio_status: 'none' | 'pending' | 'ready' | 'failed';
  audio_error: string;
  duration_s: number;
  age: string;
  license: string;
  source_url: string;
  attribution: string;
  builtin: number;
  enabled: number;
  updated_at: string;
}

export interface VocabBook {
  id: string;
  title: string;
  description: string;
  builtin: number;
  word_count: number;
}

export interface VocabProgress {
  learner: string;
  alias: string | null;
  book_id: string;
  book_title: string;
  total: number;
  learned: number;
  mastered: number;
  due: number;
  right: number;
  wrong: number;
}
