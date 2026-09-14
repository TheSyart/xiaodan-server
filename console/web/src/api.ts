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
    const error = new Error(
      (data as { error?: string } | null)?.error ?? `请求失败(${response.status})`,
    ) as ApiError;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
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
  chat_history_conf: number;
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
