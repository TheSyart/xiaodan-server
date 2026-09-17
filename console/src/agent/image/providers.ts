// 千问(百炼)文生图,返回图片字节。模型在「模型」页配置(类型 Image),智能体可以单独选。
//
// 两种接口(2026-09 百炼文档「文生图」):
//   同步  qwen-image-3.0-pro / qwen-image-2.0 / z-image-turbo:
//         POST {base}/api/v1/services/aigc/multimodal-generation/generation,直接返回图片地址
//   异步  wan2.7-image / wan2.7-image-pro(万相):
//         POST {base}/api/v1/services/aigc/image-generation/generation,带 X-DashScope-Async: enable 拿 task_id,
//         再轮询 GET {base}/api/v1/tasks/{task_id} 到 SUCCEEDED
// 两种结果都在 output.choices[0].message.content[].image,地址 24 小时有效,拿到就下载。

import type { FetchLike } from '../../voice/dashscope.ts';
import { DashscopeError, dashscopeHeaders, httpBase, resultFileUrl } from '../../voice/dashscope.ts';
import { IMAGE_MODELS } from '../../catalog.ts';

export class ImageError extends Error {}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const POLL_MS = 2000;
const DEADLINE_MS = 110_000;

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
    throw new ImageError(`连不上百炼:${(error as Error).message}`);
  }
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ImageError(`百炼返回的不是 JSON(HTTP ${response.status})`);
  }
  if (!response.ok || (typeof data['code'] === 'string' && data['code'])) {
    const error = data['error'] as { message?: string; code?: string } | undefined;
    const code = str(data['code']) || str(error?.code);
    const message = str(data['message']) || str(error?.message) || text.slice(0, 160);
    // 百炼的内容审核不通过是 DataInspectionFailed,单独说清楚
    if (/DataInspection|content_policy|sensitive/iu.test(`${code} ${message}`)) throw new ImageError('画图请求没有通过内容安全审核,换个说法试试');
    throw new ImageError(`百炼报错 ${code || response.status}:${message}`);
  }
  return data;
}

async function download(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<Buffer> {
  const safe = resultFileUrl(url);
  if (!safe) throw new ImageError('百炼返回的图片地址不是 https');
  const signals = [AbortSignal.timeout(30_000)];
  if (signal) signals.push(signal);
  const response = await fetchImpl(safe, { signal: AbortSignal.any(signals) });
  if (!response.ok) throw new ImageError(`下载图片失败:HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new ImageError('图片为空或过大');
  return bytes;
}

function imageUrlOf(data: Record<string, unknown>): string | undefined {
  const output = (data['output'] ?? {}) as Record<string, unknown>;
  const choices = (Array.isArray(output['choices']) ? output['choices'] : []) as Record<string, unknown>[];
  const content = ((choices[0]?.['message'] as Record<string, unknown> | undefined)?.['content'] ?? []) as Record<string, unknown>[];
  const fromChoices = content.map((item) => str(item['image'])).find(Boolean);
  if (fromChoices) return fromChoices;
  // 旧版万相的结果形状
  const results = (Array.isArray(output['results']) ? output['results'] : []) as Record<string, unknown>[];
  return results.map((item) => str(item['url'])).find(Boolean);
}

function headersFor(config: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  try {
    return dashscopeHeaders(config, extra);
  } catch (error) {
    throw new ImageError(error instanceof DashscopeError ? '文生图模型没有配置百炼 API Key' : (error as Error).message);
  }
}

function baseOf(config: Record<string, unknown>): string {
  try {
    return httpBase({ base_url: config['base_url'], workspace_id: config['workspace_id'] });
  } catch (error) {
    throw new ImageError((error as Error).message);
  }
}

export function isAsyncModel(model: string): boolean {
  return IMAGE_MODELS.find((item) => item.value === model)?.async ?? model.startsWith('wan');
}

export async function generateQwenImage(
  fetchImpl: FetchLike, config: Record<string, unknown>, prompt: string, signal?: AbortSignal,
): Promise<ImageOutcome & { model: string }> {
  const model = str(config['model_name']) || 'qwen-image-3.0-pro';
  const base = baseOf(config);
  const parameters: Record<string, unknown> = { size: str(config['size']) || '1024*1024', n: 1, watermark: false };
  const negative = str(config['negative_prompt']);
  const input = { messages: [{ role: 'user', content: [{ text: prompt }] }] };

  if (!isAsyncModel(model)) {
    parameters['prompt_extend'] = config['prompt_extend'] === true;
    if (negative) parameters['negative_prompt'] = negative;
    const data = await postJson(fetchImpl, `${base}/api/v1/services/aigc/multimodal-generation/generation`, headersFor(config),
      { model, input, parameters }, signal);
    const url = imageUrlOf(data);
    if (!url) throw new ImageError('百炼没有返回图片');
    return { bytes: await download(fetchImpl, url, signal), model };
  }

  // 万相:异步任务
  if (negative) parameters['negative_prompt'] = negative;
  const created = await postJson(fetchImpl, `${base}/api/v1/services/aigc/image-generation/generation`,
    headersFor(config, { 'X-DashScope-Async': 'enable' }), { model, input, parameters }, signal);
  const taskId = str((created['output'] as Record<string, unknown> | undefined)?.['task_id']);
  if (!taskId) throw new ImageError('百炼没有返回画图任务');
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    if (signal?.aborted) throw new ImageError('画图被打断了');
    if (Date.now() > deadline) throw new ImageError('画图超时了,稍后再试');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_MS);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new ImageError('画图被打断了'));
      }, { once: true });
    });
    const data = await getJson(fetchImpl, `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`, headersFor(config), signal);
    const output = (data['output'] ?? {}) as Record<string, unknown>;
    const status = str(output['task_status']);
    if (status === 'SUCCEEDED') {
      const url = imageUrlOf(data);
      if (!url) throw new ImageError('百炼没有返回图片');
      return { bytes: await download(fetchImpl, url, signal), model };
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const message = str(output['message']) || str(output['code']) || status;
      if (/DataInspection|sensitive/iu.test(message)) throw new ImageError('画图请求没有通过内容安全审核,换个说法试试');
      throw new ImageError(`画图失败:${message}`);
    }
  }
}

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const signals = [AbortSignal.timeout(20_000)];
  if (signal) signals.push(signal);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.any(signals) });
  } catch (error) {
    throw new ImageError(`连不上百炼:${(error as Error).message}`);
  }
  const text = await response.text();
  try {
    const data = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!response.ok) throw new ImageError(`查询画图任务失败 ${str(data['code']) || response.status}:${str(data['message']) || text.slice(0, 160)}`);
    return data;
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError(`百炼返回的不是 JSON(HTTP ${response.status})`);
  }
}

/** 给小屏幕的提示词:主体居中、色块分明、背景简单,量化成 16 色也好看 */
export function devicePrompt(prompt: string, childSafe: boolean): string {
  const style = '画面简洁,主体居中且占满画面,色块分明、轮廓清晰,背景干净,明亮的卡通插画风格,不要文字';
  const safety = childSafe ? ',内容适合儿童,温馨可爱,没有暴力、恐怖或不雅元素' : '';
  return `${prompt.trim()}。${style}${safety}。`;
}
