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
  type: 'string' | 'password' | 'number' | 'boolean' | 'text';
  default?: string | number | boolean;
  required?: boolean;
  hint?: string;
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
  /** engine 只在引擎旧路径生效;agent 只在控制塔运行时生效;both 两边都行 */
  runtime: 'engine' | 'agent' | 'both';
  group?: string;
}

export interface Catalog {
  providers: Record<string, ProviderDef[]>;
  plugins: PluginDef[];
  modelTypes: string[];
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

export interface Voice {
  id: string;
  tts_model_id: string;
  name: string;
  voice: string;
  languages: string;
  /** system 服务商自带;design 声音设计;clone 声音复刻 */
  kind: 'system' | 'design' | 'clone';
  /** 设计与复刻的音色要百炼审核通过(ok)才能用 */
  status: 'ok' | 'pending' | 'failed';
  description: string;
  tags: string;
  prompt: string;
  status_detail: string;
  created_at: string | null;
  agent_count: number;
}

/** 千问合成按智能体调的参数 */
export interface TtsParams {
  rate?: number;
  pitch?: number;
  volume?: number;
  instruction?: string;
}

export interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  vad_model_id: string | null;
  asr_model_id: string | null;
  llm_model_id: string | null;
  vllm_model_id: string | null;
  tts_model_id: string | null;
  memory_model_id: string | null;
  intent_model_id: string | null;
  tts_voice_id: string | null;
  /** 合成语言;为空时取所选音色支持列表里的第一个 */
  tts_language: string | null;
  chat_history_conf: number;
  /** TtsParams 的 JSON */
  tts_params_json: string;
  /** 大脑在哪:engine 引擎旧路径 / agent 控制塔智能体运行时 */
  runtime: 'engine' | 'agent';
  max_steps: number;
  safety_level: 'standard' | 'child';
  description: string;
  greeting: string;
  role_template: string;
  /** {"thinking":false,"temperature":0.8} */
  llm_params_json: string;
  mcp_servers: { server_id: string; tool_allowlist_json: string | null }[];
  skills: string[];
  is_default: number;
  plugins: { plugin_code: string; params_json: string }[];
  device_count: number;
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
  kind: 'search' | 'image';
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
  enabled: number;
  timeout_ms: number;
  tools: { name: string; description: string }[];
  tools_updated_at: string | null;
  last_error: string;
  agents: { agent_id: string; tool_allowlist_json: string | null }[];
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  files: string[];
  allowed_tools: string;
  source: 'builtin' | 'custom';
  enabled: number;
  updated_at: string;
  agent_count: number;
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
