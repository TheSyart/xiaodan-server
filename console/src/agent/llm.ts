// OpenAI 兼容的流式对话客户端(DeepSeek 官方、百炼 compatible-mode、自建网关都走这一套)。
//
// 只做一件事:把 /chat/completions 的 SSE 流解析成「文字增量」与「工具调用」两类事件。
// 工具调用按 index 合并增量;思考内容(reasoning_content)不外露。
// 思考模式默认关:语音对话等不起隐藏推理的几秒钟,也免得 max_tokens 被推理吃光导致空回复。

import type { FetchLike } from '../voice/dashscope.ts';

export interface LlmConfig {
  base_url?: unknown;
  url?: unknown;
  model_name?: unknown;
  api_key?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  top_p?: unknown;
  /** 模型能看图(模型页的「支持看图」) */
  vision?: unknown;
}

/** OpenAI 兼容的多模态内容:文字与图片地址(data: 或 https) */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function supportsVision(config: LlmConfig): boolean {
  return config.vision === true || config.vision === 'true';
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; toolCalls: ToolCall[]; finishReason: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

export class LlmError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export function chatUrl(config: LlmConfig): string {
  const base = (text(config.base_url) || text(config.url)).replace(/\/+$/u, '');
  if (!base) throw new LlmError('对话模型没有配置接口地址');
  return base.endsWith('/chat/completions') ? base : `${bailianCompatible(base)}/chat/completions`;
}

/**
 * 百炼的对话模型只在兼容模式下说 OpenAI 协议。业务空间地址常被原样填成
 * https://<业务空间>.cn-beijing.maas.aliyuncs.com/api/v1(语音与文生图用的原生地址),或者只填了域名:换成 /compatible-mode/v1。
 */
export function bailianCompatible(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  const bailian = /(^|\.)dashscope(-intl)?\.aliyuncs\.com$|\.maas\.aliyuncs\.com$/u.test(url.hostname);
  return bailian && /^\/*(api\/v1\/*)?$/u.test(url.pathname) ? `${url.origin}/compatible-mode/v1` : base;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function buildBody(config: LlmConfig, request: ChatRequest): Record<string, unknown> {
  const model = text(config.model_name);
  if (!model) throw new LlmError('对话模型没有配置模型名');
  const body: Record<string, unknown> = { model, messages: request.messages, stream: true, stream_options: { include_usage: true } };
  if (request.tools && request.tools.length) {
    body['tools'] = request.tools;
    body['tool_choice'] = 'auto';
  }
  const temperature = request.temperature ?? num(config.temperature);
  if (temperature !== undefined) body['temperature'] = temperature;
  const maxTokens = request.maxTokens ?? num(config.max_tokens);
  if (maxTokens !== undefined) body['max_tokens'] = Math.round(maxTokens);
  const topP = num(config.top_p);
  if (topP !== undefined) body['top_p'] = topP;
  // 各家关思考的写法不同;不认识的参数多数服务会忽略
  const host = (() => {
    try {
      return new URL(chatUrl(config)).hostname;
    } catch {
      return '';
    }
  })();
  if (host.endsWith('deepseek.com') || host.endsWith('volces.com') || host.endsWith('bigmodel.cn') || host.endsWith('moonshot.cn')) {
    body['thinking'] = { type: request.thinking ? 'enabled' : 'disabled' };
  } else if (host.endsWith('aliyuncs.com')) {
    body['enable_thinking'] = request.thinking === true;
  }
  return body;
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

/** 流式调用。产出文字增量,最后产出一个带合并好的工具调用的 done 事件。 */
export async function* streamChat(fetchImpl: FetchLike, config: LlmConfig, request: ChatRequest): AsyncGenerator<LlmEvent> {
  const apiKey = text(config.api_key);
  const signals = [AbortSignal.timeout(request.timeoutMs ?? 90_000)];
  if (request.signal) signals.push(request.signal);
  let response: Response;
  try {
    response = await fetchImpl(chatUrl(config), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(buildBody(config, request)),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new LlmError(`连不上对话模型:${(error as Error).message}`);
  }
  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new LlmError(`对话模型返回 HTTP ${response.status}:${detail}`, response.status);
  }

  const calls: PartialCall[] = [];
  let finishReason = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const decoder = new TextDecoder();
  let pending = '';
  const reader = response.body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, '');
        pending = pending.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (chunk['error']) throw new LlmError(`对话模型报错:${JSON.stringify(chunk['error']).slice(0, 300)}`);
        if (chunk['usage'] && typeof chunk['usage'] === 'object') usage = chunk['usage'] as typeof usage;
        const choice = (Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined) as Record<string, unknown> | undefined;
        if (!choice) continue;
        if (typeof choice['finish_reason'] === 'string') finishReason = choice['finish_reason'];
        const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
        if (typeof delta['content'] === 'string' && delta['content']) yield { type: 'text', text: delta['content'] };
        if (Array.isArray(delta['tool_calls'])) {
          for (const raw of delta['tool_calls'] as Record<string, unknown>[]) {
            const index = typeof raw['index'] === 'number' ? raw['index'] : calls.length;
            calls[index] ??= { id: '', name: '', arguments: '' };
            const target = calls[index]!;
            if (typeof raw['id'] === 'string' && raw['id']) target.id = raw['id'];
            const fn = (raw['function'] ?? {}) as Record<string, unknown>;
            // 与引擎的 _merge_tool_calls 一致:名字整段给出,非空才覆盖;参数按片段拼接
            if (typeof fn['name'] === 'string' && fn['name']) target.name = fn['name'];
            if (typeof fn['arguments'] === 'string') target.arguments += fn['arguments'];
          }
        }
      }
    }
  } finally {
    // 调用方提前停止(用户打断)时主动取消,不然连接会一直挂着直到模型生成完
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const toolCalls: ToolCall[] = calls
    .filter((call) => call && call.name)
    .map((call, i) => ({
      id: call.id || `call_${Date.now().toString(36)}_${i}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments || '{}' },
    }));
  yield { type: 'done', toolCalls, finishReason, ...(usage ? { usage } : {}) };
}

/**
 * 一次性调用:把流式增量拼成一段文字。后台用途(整理对话档案、起标题)不需要边生成边吐,
 * 也不给工具,复用同一套请求构造与错误处理。
 */
export async function completeChat(fetchImpl: FetchLike, config: LlmConfig, request: ChatRequest): Promise<string> {
  let out = '';
  for await (const event of streamChat(fetchImpl, config, { ...request, tools: undefined })) {
    if (event.type === 'text') out += event.text;
  }
  return out.trim();
}
