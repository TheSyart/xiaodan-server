// 引擎「设备桥」的客户端(server/engine/xiaodan_bridge.py)。地址默认 http://engine:8003,在设置页可改。

import type { FetchLike } from '../voice/dashscope.ts';

export interface DeviceStatus {
  online: boolean;
  session_id?: string;
  busy?: boolean;
  reason?: string;
  client_ip?: string | null;
  features?: Record<string, unknown>;
}

export interface EngineToolResult {
  action: string;
  result: string | null;
  response: string | null;
}

export class BridgeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class Bridge {
  private readonly baseUrl: () => string;
  private readonly secret: () => string;
  private readonly fetchImpl: FetchLike;

  // 地址与密钥用函数传入:设置页改了、密钥轮换了,不必重启就生效
  constructor(baseUrl: () => string, secret: () => string, fetchImpl: FetchLike) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; data: any }> {
    const base = this.baseUrl().replace(/\/+$/u, '');
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/xiaodan/bridge${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secret()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BridgeError(`连不上引擎的设备桥:${(error as Error).message}`, 0);
    }
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    return { status: response.status, data };
  }

  async health(): Promise<{ ok: boolean; connections?: number; error?: string }> {
    try {
      const { status, data } = await this.request('GET', '/health', undefined, 3000);
      return status === 200 ? { ok: true, connections: data?.connections } : { ok: false, error: `HTTP ${status}` };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async callTool(body: {
    session_id: string; turn_id: string | null; name: string; arguments: Record<string, unknown>; plugin_config: Record<string, unknown>;
  }): Promise<EngineToolResult> {
    const { status, data } = await this.request('POST', '/tool', body, 35_000);
    if (status !== 200) throw new BridgeError(data?.error ?? `HTTP ${status}`, status);
    return data as EngineToolResult;
  }

  async device(mac: string): Promise<DeviceStatus> {
    const { status, data } = await this.request('GET', `/devices/${encodeURIComponent(mac)}`, undefined, 3000);
    if (status !== 200) throw new BridgeError(data?.error ?? `HTTP ${status}`, status);
    return data as DeviceStatus;
  }

  async announce(mac: string, body: {
    text: string; chime?: boolean | string; chime_ext?: string; title?: string; device_msgs?: Record<string, unknown>[];
  }): Promise<{ status: number; data: any }> {
    return this.request('POST', `/devices/${encodeURIComponent(mac)}/announce`, body, 20_000);
  }

  async send(mac: string, messages: Record<string, unknown>[]): Promise<{ status: number; data: any }> {
    return this.request('POST', `/devices/${encodeURIComponent(mac)}/send`, { messages }, 10_000);
  }
}
