// 文生图的几家实现,统一返回图片字节。换服务商只改「工具与服务」页的默认项。
//
// qwen-image:百炼 compatible-mode 的 /images/generations(OpenAI 形状,只有 qwen-image-3.0 系列支持),返回 24 小时有效的 PNG 地址。
// dashscope:百炼原生同步接口 multimodal-generation(z-image-turbo、wan2.7-image、qwen-image 各代都支持)。
// openai-images:任意 OpenAI 兼容的 /images/generations(OpenAI、火山方舟 Seedream、硅基流动等)。

import type { FetchLike } from '../../voice/dashscope.ts';
import { httpBase } from '../../voice/dashscope.ts';

export class ImageError extends Error {}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface ImageOutcome {
  bytes: Buffer;
  /** 服务商改写过的提示词(若有) */
  revisedPrompt?: string;
}

async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const signals = [AbortSignal.timeout(110_000)];
  if (signal) signals.push(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw new ImageError(`连不上画图服务:${(error as Error).message}`);
  }
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ImageError(`画图服务返回的不是 JSON(HTTP ${response.status})`);
  }
  if (!response.ok || (typeof data['code'] === 'string' && data['code'])) {
    const error = data['error'] as { message?: string; code?: string } | undefined;
    const code = str(data['code']) || str(error?.code);
    const message = str(data['message']) || str(error?.message) || text.slice(0, 160);
    // 百炼的内容审核不通过是 DataInspectionFailed,单独说清楚
    if (/DataInspection|content_policy|sensitive/iu.test(`${code} ${message}`)) throw new ImageError('画图请求没有通过内容安全审核,换个说法试试');
    throw new ImageError(`画图服务报错 ${code || response.status}:${message}`);
  }
  return data;
}

async function download(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<Buffer> {
  if (!/^https:\/\//u.test(url)) throw new ImageError('画图服务返回的图片地址不是 https');
  const signals = [AbortSignal.timeout(30_000)];
  if (signal) signals.push(signal);
  const response = await fetchImpl(url, { signal: AbortSignal.any(signals) });
  if (!response.ok) throw new ImageError(`下载图片失败:HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new ImageError('图片为空或过大');
  return bytes;
}

async function fromOpenAiShape(fetchImpl: FetchLike, data: Record<string, unknown>, signal?: AbortSignal): Promise<ImageOutcome> {
  const first = (Array.isArray(data['data']) ? data['data'][0] : undefined) as Record<string, unknown> | undefined;
  if (!first) throw new ImageError('画图服务没有返回图片');
  const revised = str(first['revised_prompt']);
  if (str(first['b64_json'])) return { bytes: Buffer.from(str(first['b64_json']), 'base64'), ...(revised ? { revisedPrompt: revised } : {}) };
  if (str(first['url'])) return { bytes: await download(fetchImpl, str(first['url']), signal), ...(revised ? { revisedPrompt: revised } : {}) };
  throw new ImageError('画图服务没有返回图片');
}

export async function qwenImage(fetchImpl: FetchLike, config: Record<string, unknown>, prompt: string, signal?: AbortSignal): Promise<ImageOutcome> {
  const apiKey = str(config['api_key']);
  if (!apiKey) throw new ImageError('画图服务没有配置百炼 API Key');
  const base = httpBase({ base_url: config['base_url'], workspace_id: config['workspace_id'] });
  const data = await postJson(fetchImpl, `${base}/compatible-mode/v1/images/generations`, { Authorization: `Bearer ${apiKey}` }, {
    model: str(config['model']) || 'qwen-image-3.0',
    prompt,
    size: str(config['size']) || '1024x1024',
    n: 1,
    prompt_extend: false,
    watermark: false,
  }, signal);
  return fromOpenAiShape(fetchImpl, data, signal);
}

export async function dashscopeImage(fetchImpl: FetchLike, config: Record<string, unknown>, prompt: string, signal?: AbortSignal): Promise<ImageOutcome> {
  const apiKey = str(config['api_key']);
  if (!apiKey) throw new ImageError('画图服务没有配置百炼 API Key');
  const base = httpBase({ base_url: config['base_url'], workspace_id: config['workspace_id'] });
  const data = await postJson(fetchImpl, `${base}/api/v1/services/aigc/multimodal-generation/generation`, { Authorization: `Bearer ${apiKey}` }, {
    model: str(config['model']) || 'z-image-turbo',
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: { size: str(config['size']) || '1024*1024', prompt_extend: false, watermark: false },
  }, signal);
  const choices = ((data['output'] as Record<string, unknown> | undefined)?.['choices'] ?? []) as Record<string, unknown>[];
  const content = ((choices[0]?.['message'] as Record<string, unknown> | undefined)?.['content'] ?? []) as Record<string, unknown>[];
  const url = content.map((item) => str(item['image'])).find(Boolean);
  if (!url) throw new ImageError('画图服务没有返回图片');
  return { bytes: await download(fetchImpl, url, signal) };
}

export async function openaiImages(fetchImpl: FetchLike, config: Record<string, unknown>, prompt: string, signal?: AbortSignal): Promise<ImageOutcome> {
  const apiKey = str(config['api_key']);
  const base = str(config['base_url']).replace(/\/+$/u, '');
  if (!base || !apiKey) throw new ImageError('画图服务没有配置接口地址或 API Key');
  const url = base.endsWith('/images/generations') ? base : `${base}/images/generations`;
  const data = await postJson(fetchImpl, url, { Authorization: `Bearer ${apiKey}` }, {
    model: str(config['model']),
    prompt,
    size: str(config['size']) || '1024x1024',
    n: 1,
    ...(str(config['response_format']) ? { response_format: str(config['response_format']) } : {}),
  }, signal);
  return fromOpenAiShape(fetchImpl, data, signal);
}

export const IMAGE_PROVIDERS: Record<string, (fetchImpl: FetchLike, config: Record<string, unknown>, prompt: string, signal?: AbortSignal) => Promise<ImageOutcome>> = {
  'qwen-image': qwenImage,
  dashscope: dashscopeImage,
  'openai-images': openaiImages,
};

/** 给小屏幕的提示词:主体居中、色块分明、背景简单,量化成 16 色也好看 */
export function devicePrompt(prompt: string, childSafe: boolean): string {
  const style = '画面简洁,主体居中且占满画面,色块分明、轮廓清晰,背景干净,明亮的卡通插画风格,不要文字';
  const safety = childSafe ? ',内容适合儿童,温馨可爱,没有暴力、恐怖或不雅元素' : '';
  return `${prompt.trim()}。${style}${safety}。`;
}
