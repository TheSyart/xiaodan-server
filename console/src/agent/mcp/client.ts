// 最小的 MCP 客户端:只做工具(tools/list、tools/call),只支持 Streamable HTTP 传输。
//
// 流程:initialize(拿到 Mcp-Session-Id 与协商的协议版本)→ notifications/initialized → tools/list(分页)→ tools/call。
// 服务端对每个 POST 可以回 application/json,也可以回 text/event-stream(里面按 id 找到对应的响应);
// 会话过期时服务端回 404,重新初始化一次再发。不引入官方 SDK:它为服务端带进 express 等一整套依赖,
// 而控制塔只需要这几个请求。旧的 SSE 双通道传输暂不支持。

import type { FetchLike } from '../../voice/dashscope.ts';

export const CLIENT_PROTOCOL_VERSION = '2025-06-18';

export interface McpServer {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

interface SessionState {
  sessionId: string | null;
  protocolVersion: string;
}

const sessions = new Map<string, SessionState>();
let nextId = 1;

function sessionKey(server: McpServer): string {
  return `${server.id}|${server.url}`;
}

export function resetMcpSession(server: McpServer): void {
  sessions.delete(sessionKey(server));
}

async function readSseResponse(response: Response, id: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new McpError('MCP 服务返回了空的事件流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/gu, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message['id'] === id) return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new McpError('MCP 服务的事件流里没有对应的响应');
}

async function post(
  fetchImpl: FetchLike, server: McpServer, state: SessionState | null, payload: Record<string, unknown>, signal?: AbortSignal,
): Promise<{ response: Response; message: Record<string, unknown> | null }> {
  const signals = [AbortSignal.timeout(server.timeoutMs)];
  if (signal) signals.push(signal);
  let response: Response;
  try {
    response = await fetchImpl(server.url, {
      method: 'POST',
      headers: {
        ...server.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(state?.sessionId ? { 'Mcp-Session-Id': state.sessionId } : {}),
        ...(state ? { 'MCP-Protocol-Version': state.protocolVersion } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    throw new McpError(`连不上 MCP 服务「${server.name}」:${(error as Error).message}`);
  }
  if (!('id' in payload)) {
    // 通知:202/200 都算成功,不读正文
    await response.body?.cancel().catch(() => {});
    return { response, message: null };
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 200);
    return { response, message: { __httpError: `HTTP ${response.status} ${text}` } };
  }
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) return { response, message: await readSseResponse(response, payload['id'] as number) };
  const text = await response.text();
  try {
    return { response, message: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new McpError(`MCP 服务返回的不是 JSON:${text.slice(0, 120)}`);
  }
}

async function initialize(fetchImpl: FetchLike, server: McpServer, signal?: AbortSignal): Promise<SessionState> {
  const id = nextId++;
  const { response, message } = await post(fetchImpl, server, null, {
    jsonrpc: '2.0', id, method: 'initialize',
    params: { protocolVersion: CLIENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'xiaodan-console', version: '1.0.0' } },
  }, signal);
  if (!message || message['__httpError']) throw new McpError(`MCP 初始化失败:${String(message?.['__httpError'] ?? '无响应')}`);
  if (message['error']) throw new McpError(`MCP 初始化失败:${JSON.stringify(message['error']).slice(0, 200)}`);
  const result = (message['result'] ?? {}) as Record<string, unknown>;
  const state: SessionState = {
    sessionId: response.headers.get('mcp-session-id'),
    protocolVersion: typeof result['protocolVersion'] === 'string' ? result['protocolVersion'] : CLIENT_PROTOCOL_VERSION,
  };
  await post(fetchImpl, server, state, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
  sessions.set(sessionKey(server), state);
  return state;
}

/** 发一个请求;没有会话先初始化;会话过期(404)重新初始化再发一次。 */
async function request(
  fetchImpl: FetchLike, server: McpServer, method: string, params: Record<string, unknown>, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const state = sessions.get(sessionKey(server)) ?? (await initialize(fetchImpl, server, signal));
    const id = nextId++;
    const { response, message } = await post(fetchImpl, server, state, { jsonrpc: '2.0', id, method, params }, signal);
    if (response.status === 404 && state.sessionId && attempt === 1) {
      resetMcpSession(server);
      continue;
    }
    if (!message || message['__httpError']) throw new McpError(`MCP 请求 ${method} 失败:${String(message?.['__httpError'] ?? '无响应')}`);
    if (message['error']) {
      const error = message['error'] as { code?: number; message?: string };
      throw new McpError(`MCP 请求 ${method} 出错:${error.message ?? JSON.stringify(error)}`, error.code);
    }
    return (message['result'] ?? {}) as Record<string, unknown>;
  }
  throw new McpError(`MCP 请求 ${method} 失败:会话反复失效`);
}

export async function listTools(fetchImpl: FetchLike, server: McpServer, signal?: AbortSignal): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await request(fetchImpl, server, 'tools/list', cursor ? { cursor } : {}, signal);
    for (const raw of (Array.isArray(result['tools']) ? result['tools'] : []) as Record<string, unknown>[]) {
      if (typeof raw['name'] !== 'string') continue;
      tools.push({
        name: raw['name'],
        description: typeof raw['description'] === 'string' ? raw['description'] : '',
        inputSchema: typeof raw['inputSchema'] === 'object' && raw['inputSchema'] !== null
          ? (raw['inputSchema'] as Record<string, unknown>)
          : { type: 'object', properties: {} },
      });
    }
    cursor = typeof result['nextCursor'] === 'string' && result['nextCursor'] ? result['nextCursor'] : undefined;
    if (!cursor) break;
  }
  return tools;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** 把 tools/call 的结果内容拼成文字:文本原样,资源取其文本,图片与音频只留占位说明。 */
export function contentToText(result: Record<string, unknown>): McpCallResult {
  const parts: string[] = [];
  for (const item of (Array.isArray(result['content']) ? result['content'] : []) as Record<string, unknown>[]) {
    if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text']);
    else if (item['type'] === 'resource') {
      const resource = (item['resource'] ?? {}) as Record<string, unknown>;
      if (typeof resource['text'] === 'string') parts.push(resource['text']);
      else if (typeof resource['uri'] === 'string') parts.push(`[资源 ${resource['uri']}]`);
    } else if (item['type'] === 'resource_link' && typeof item['uri'] === 'string') parts.push(`[链接 ${item['uri']}]`);
    else if (item['type'] === 'image') parts.push('[图片,无法朗读]');
    else if (item['type'] === 'audio') parts.push('[音频]');
  }
  if (parts.length === 0 && result['structuredContent'] !== undefined) parts.push(JSON.stringify(result['structuredContent']));
  return { text: parts.join('\n').trim(), isError: result['isError'] === true };
}

export async function callTool(
  fetchImpl: FetchLike, server: McpServer, name: string, args: Record<string, unknown>, signal?: AbortSignal,
): Promise<McpCallResult> {
  const result = await request(fetchImpl, server, 'tools/call', { name, arguments: args }, signal);
  return contentToText(result);
}
