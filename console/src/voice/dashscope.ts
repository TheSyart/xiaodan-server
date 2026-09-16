// 百炼(DashScope)语音接口的客户端:试听合成、声音设计、声音复刻、查询与删除音色、临时文件上传。
//
// 只给控制台管理页面用;设备对话时的合成在引擎里(server/providers/qwen_audio_tts.py),两边地址规则一致。
// 协议出处(2026-09 百炼文档):
//   合成(非流式)POST {base}/api/v1/services/audio/tts/SpeechSynthesizer,返回 output.audio.url(24 小时有效)
//   音色管理      POST {base}/api/v1/services/audio/tts/customization,model 固定为 voice-enrollment,
//                 action = create_voice / query_voice / delete_voice;复刻与设计的音色只能用于创建时的 target_model
//   临时上传      GET  {base}/api/v1/uploads?action=getPolicy&model=… → 表单直传 OSS → oss://{key},
//                 调用时带 X-DashScope-OssResourceResolve: enable(48 小时有效)
// 所有网络调用经可注入的 fetch,测试里换成假的。

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const LEGACY_BASE = 'https://dashscope.aliyuncs.com';
export const DEFAULT_TTS_MODEL = 'qwen-audio-3.0-tts-flash';
const ENROLLMENT_MODEL = 'voice-enrollment';
/** 试听音频最大字节数。24 kHz 单声道 16 位 WAV 一分钟约 2.9 MB,试听句子远小于此。 */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const WORKSPACE_ID = /^[A-Za-z0-9-]{1,64}$/u;

export interface DashscopeConfig {
  api_key?: unknown;
  workspace_id?: unknown;
  base_url?: unknown;
  model_name?: unknown;
}

export class DashscopeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 502, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function httpBase(config: DashscopeConfig): string {
  let base = text(config.base_url).replace(/\/+$/u, '');
  if (base) {
    for (const suffix of ['/api/v1', '/compatible-mode/v1']) {
      if (base.endsWith(suffix)) base = base.slice(0, -suffix.length);
    }
    return base;
  }
  const workspace = text(config.workspace_id);
  if (workspace) {
    if (!WORKSPACE_ID.test(workspace)) throw new DashscopeError('业务空间 ID 只能是字母、数字与连字符', 400);
    return `https://${workspace}.cn-beijing.maas.aliyuncs.com`;
  }
  return LEGACY_BASE;
}

export function targetModel(config: DashscopeConfig): string {
  return text(config.model_name) || DEFAULT_TTS_MODEL;
}

function headers(config: DashscopeConfig, extra: Record<string, string> = {}): Record<string, string> {
  const apiKey = text(config.api_key);
  if (!apiKey) throw new DashscopeError('这个语音合成模型还没有填百炼 API Key', 400);
  const result: Record<string, string> = { Authorization: `Bearer ${apiKey}`, ...extra };
  const workspace = text(config.workspace_id);
  if (workspace && !text(config.base_url)) result['X-DashScope-WorkSpace'] = workspace;
  return result;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new DashscopeError(`百炼返回的不是 JSON(HTTP ${response.status}):${body.slice(0, 120)}`, 502);
  }
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (!response.ok || (typeof record['code'] === 'string' && record['code'])) {
    const code = typeof record['code'] === 'string' ? record['code'] : '';
    const message = typeof record['message'] === 'string' ? record['message'] : `HTTP ${response.status}`;
    // 百炼的 4xx 多半是配置或内容问题(密钥、音色名、样本质量),原样告诉用户;5xx 当作上游故障
    throw new DashscopeError(`百炼报错 ${code || response.status}:${message}`, response.status >= 500 ? 502 : 400, code);
  }
  return record;
}

async function post(
  fetchImpl: FetchLike, url: string, config: DashscopeConfig, body: unknown,
  extraHeaders: Record<string, string> = {}, timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: headers(config, { 'Content-Type': 'application/json', ...extraHeaders }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DashscopeError) throw error;
    throw new DashscopeError(`连不上百炼:${(error as Error).message}`, 502);
  }
  return readJson(response);
}

const pick = (value: unknown, ...path: string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

async function download(fetchImpl: FetchLike, url: string): Promise<Buffer> {
  // 只取百炼给的 https 地址,防止被诱导去访问内网
  if (!/^https:\/\//u.test(url)) throw new DashscopeError('百炼返回的音频地址不是 https', 502);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new DashscopeError(`下载合成音频失败:${(error as Error).message}`, 502);
  }
  if (!response.ok) throw new DashscopeError(`下载合成音频失败:HTTP ${response.status}`, 502);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_AUDIO_BYTES) throw new DashscopeError('合成音频过大', 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) throw new DashscopeError('合成音频过大', 502);
  return bytes;
}

export interface SynthesisOptions {
  text: string;
  voice: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  instruction?: string;
  format?: 'wav' | 'mp3';
  sampleRate?: number;
}

const clamp = (value: number | undefined, low: number, high: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

/** 语气指令按 100 个单位截断,汉字等非 ASCII 字符算 2 个。 */
export function clampInstruction(value: string | undefined): string {
  let used = 0;
  let out = '';
  for (const ch of (value ?? '').trim()) {
    const cost = ch.charCodeAt(0) > 0x7f ? 2 : 1;
    if (used + cost > 100) break;
    out += ch;
    used += cost;
  }
  return out;
}

/** 非流式合成一段文字,返回音频字节。用于试听与故事音频的离线生成。 */
export async function synthesize(
  fetchImpl: FetchLike, config: DashscopeConfig, options: SynthesisOptions,
): Promise<{ audio: Buffer; mime: string }> {
  const format = options.format ?? 'wav';
  const input: Record<string, unknown> = {
    text: options.text,
    voice: options.voice,
    format,
    sample_rate: options.sampleRate ?? 24000,
    volume: Math.round(clamp(options.volume, 0, 100, 50)),
    rate: clamp(options.rate, 0.5, 2, 1),
    pitch: clamp(options.pitch, 0.5, 2, 1),
  };
  const instruction = clampInstruction(options.instruction);
  if (instruction) input['instruction'] = instruction;
  const data = await post(
    fetchImpl, `${httpBase(config)}/api/v1/services/audio/tts/SpeechSynthesizer`, config,
    { model: targetModel(config), input }, {}, 60_000,
  );
  const inline = pick(data, 'output', 'audio', 'data');
  let audio: Buffer;
  if (typeof inline === 'string' && inline) {
    audio = Buffer.from(inline, 'base64');
  } else {
    const url = pick(data, 'output', 'audio', 'url');
    if (typeof url !== 'string' || !url) throw new DashscopeError('百炼没有返回音频', 502);
    audio = await download(fetchImpl, url);
  }
  if (audio.length === 0) throw new DashscopeError('百炼返回了空音频', 502);
  return { audio, mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
}

/** 音色名前缀:百炼要求仅字母与数字、至多 10 个字符。 */
export function voicePrefix(value: string | undefined): string {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 10);
  return cleaned || `xd${Date.now().toString(36).slice(-8)}`;
}

export type VoiceStatus = 'ok' | 'pending' | 'failed';

/** 百炼的音色状态:OK 可用;DEPLOYING 审核中;UNDEPLOYED 审核未通过。 */
export function mapVoiceStatus(value: unknown): VoiceStatus {
  if (value === 'OK') return 'ok';
  if (value === 'UNDEPLOYED') return 'failed';
  return 'pending';
}

function enrollment(
  fetchImpl: FetchLike, config: DashscopeConfig, input: Record<string, unknown>,
  extra: { parameters?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  const body: Record<string, unknown> = { model: ENROLLMENT_MODEL, input };
  if (extra.parameters) body['parameters'] = extra.parameters;
  return post(
    fetchImpl, `${httpBase(config)}/api/v1/services/audio/tts/customization`, config, body, extra.headers, 60_000,
  );
}

export interface DesignResult {
  voiceId: string;
  previewAudio?: Buffer;
}

/** 声音设计:用一段文字描述生成音色,同时返回一段试听。 */
export async function designVoice(
  fetchImpl: FetchLike, config: DashscopeConfig,
  options: { prompt: string; previewText: string; prefix?: string; language?: 'zh' | 'en' },
): Promise<DesignResult> {
  const data = await enrollment(
    fetchImpl, config,
    {
      action: 'create_voice',
      target_model: targetModel(config),
      voice_prompt: options.prompt,
      preview_text: options.previewText,
      prefix: voicePrefix(options.prefix),
      language_hints: [options.language ?? 'zh'],
    },
    { parameters: { sample_rate: 24000, response_format: 'wav' } },
  );
  const voiceId = pick(data, 'output', 'voice_id');
  if (typeof voiceId !== 'string' || !voiceId) throw new DashscopeError('百炼没有返回音色 ID', 502);
  const preview = pick(data, 'output', 'preview_audio', 'data');
  return typeof preview === 'string' && preview
    ? { voiceId, previewAudio: Buffer.from(preview, 'base64') }
    : { voiceId };
}

/** 声音复刻:样本必须是百炼能访问的地址(公网 https 或临时上传得到的 oss://)。 */
export async function cloneVoice(
  fetchImpl: FetchLike, config: DashscopeConfig,
  options: { url: string; prefix?: string; language?: 'zh' | 'en' },
): Promise<string> {
  const oss = options.url.startsWith('oss://');
  const data = await enrollment(
    fetchImpl, config,
    {
      action: 'create_voice',
      target_model: targetModel(config),
      prefix: voicePrefix(options.prefix),
      url: options.url,
      language_hints: [options.language ?? 'zh'],
    },
    oss ? { headers: { 'X-DashScope-OssResourceResolve': 'enable' } } : {},
  );
  const voiceId = pick(data, 'output', 'voice_id');
  if (typeof voiceId !== 'string' || !voiceId) throw new DashscopeError('百炼没有返回音色 ID', 502);
  return voiceId;
}

export async function queryVoice(
  fetchImpl: FetchLike, config: DashscopeConfig, voiceId: string,
): Promise<{ status: VoiceStatus; raw: string }> {
  const data = await enrollment(fetchImpl, config, { action: 'query_voice', voice_id: voiceId });
  const raw = pick(data, 'output', 'status');
  return { status: mapVoiceStatus(raw), raw: typeof raw === 'string' ? raw : '' };
}

export async function deleteVoice(fetchImpl: FetchLike, config: DashscopeConfig, voiceId: string): Promise<void> {
  await enrollment(fetchImpl, config, { action: 'delete_voice', voice_id: voiceId });
}

/** 把文件临时上传到百炼(48 小时有效),返回 oss:// 地址。 */
export async function uploadTemporary(
  fetchImpl: FetchLike, config: DashscopeConfig,
  options: { model: string; fileName: string; bytes: Buffer; mime: string },
): Promise<string> {
  let response: Response;
  const url = `${httpBase(config)}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(options.model)}`;
  try {
    response = await fetchImpl(url, {
      headers: headers(config, { 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof DashscopeError) throw error;
    throw new DashscopeError(`连不上百炼:${(error as Error).message}`, 502);
  }
  const policy = (await readJson(response))['data'] as Record<string, unknown> | undefined;
  const need = ['policy', 'signature', 'upload_dir', 'upload_host', 'oss_access_key_id'] as const;
  if (!policy || need.some((key) => typeof policy[key] !== 'string' || !policy[key])) {
    throw new DashscopeError('百炼没有返回上传凭证', 502);
  }
  const host = String(policy['upload_host']);
  if (!/^https:\/\//u.test(host)) throw new DashscopeError('百炼返回的上传地址不是 https', 502);
  const key = `${String(policy['upload_dir'])}/${options.fileName}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', String(policy['oss_access_key_id']));
  form.append('Signature', String(policy['signature']));
  form.append('policy', String(policy['policy']));
  form.append('x-oss-object-acl', String(policy['x_oss_object_acl'] ?? 'private'));
  form.append('x-oss-forbid-overwrite', String(policy['x_oss_forbid_overwrite'] ?? 'true'));
  form.append('key', key);
  form.append('success_action_status', '200');
  // file 必须是最后一个字段
  form.append('file', new Blob([new Uint8Array(options.bytes)], { type: options.mime }), options.fileName);
  let upload: Response;
  try {
    upload = await fetchImpl(host, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new DashscopeError(`上传样本失败:${(error as Error).message}`, 502);
  }
  if (!upload.ok) throw new DashscopeError(`上传样本失败:HTTP ${upload.status}`, 502);
  return `oss://${key}`;
}
