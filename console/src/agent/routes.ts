// 智能体运行时的接口。
//
//   POST /xiaodan/agent/turn     引擎的 xiaodan_agent provider 调:一轮对话,回 text/event-stream(令牌鉴权,见 token.ts)
//   GET  /api/agent-runtime/status  控制塔页面:设备桥是否连得通
//   POST /api/agent-runtime/try     网页试聊:不接硬件跑同一个循环,额外回传每一步的工具调用
//
// /xiaodan/agent/turn 不能挂在 /xiaozhi/agent/* 下:那里有 manager-api 的密钥守卫,还会回 HTTP 200 + code 401,
// provider 会把 JSON 当成事件流读,整轮沉默。

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { one } from '../db.ts';
import { canonicalMac } from '../identity.ts';
import { SECRET_KEY } from '../seed.ts';
import { conversations, runTurn } from './loop.ts';
import { verifyAgentToken } from './token.ts';
import type { AgentDeps, AgentRow, DeviceContext, TraceEvent, TurnSink } from './types.ts';

const HEARTBEAT_MS = 2000;

export function loadAgent(deps: AgentDeps, id: string): AgentRow | undefined {
  const row = one<Record<string, unknown>>(deps.conn, 'SELECT * FROM agents WHERE id = ?', id);
  if (!row) return undefined;
  return {
    id: String(row['id']),
    name: String(row['name'] ?? ''),
    system_prompt: String(row['system_prompt'] ?? ''),
    llm_model_id: (row['llm_model_id'] as string | null) ?? null,
    tts_model_id: (row['tts_model_id'] as string | null) ?? null,
    tts_voice_id: (row['tts_voice_id'] as string | null) ?? null,
    description: String(row['description'] ?? ''),
    role_template: String(row['role_template'] ?? ''),
    safety_level: row['safety_level'] === 'child' ? 'child' : 'standard',
    max_steps: Number(row['max_steps'] ?? 6),
    llm_params_json: String(row['llm_params_json'] ?? '{}'),
    greeting: String(row['greeting'] ?? ''),
    runtime: row['runtime'] === 'agent' ? 'agent' : 'engine',
  };
}

type Send = (event: Record<string, unknown>) => void;

/**
 * 事件流响应。心跳每 2 秒一条注释行:工具慢时文字会停顿,provider 靠读到心跳来及时检查用户是否打断。
 * 对端断开(引擎关掉请求)时 cancel 触发,signal 随之中止,模型请求与工具一并取消。
 */
export function sseResponse(requestSignal: AbortSignal | undefined, body: (send: Send, signal: AbortSignal) => Promise<void>): Response {
  const controller = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (text: string) => {
        if (closed) return;
        try {
          ctrl.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const send: Send = (event) => write(`data: ${JSON.stringify(event)}\n\n`);
      timer = setInterval(() => write(': hb\n\n'), HEARTBEAT_MS);
      write(': open\n\n');
      requestSignal?.addEventListener('abort', () => controller.abort(), { once: true });
      body(send, controller.signal)
        .catch((error: unknown) => {
          send({ t: 'error', message: (error as Error).message });
        })
        .finally(() => {
          clearInterval(timer);
          if (closed) return;
          send({ t: 'done' });
          closed = true;
          try {
            ctrl.close();
          } catch {
            /* 已经关了 */
          }
        });
    },
    cancel() {
      closed = true;
      clearInterval(timer);
      controller.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

const turnSchema = z.object({
  v: z.number().optional(),
  session_id: z.string().max(128).nullish(),
  turn_id: z.string().max(128).nullish(),
  device_id: z.string().max(64).nullish(),
  client_ip: z.string().max(64).nullish(),
  features: z.record(z.string(), z.unknown()).nullish(),
  query: z.string().max(4000).default(''),
  messages: z.array(z.object({ role: z.string().max(16), content: z.string().max(20_000) })).max(200).default([]),
});

export function agentRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });

  app.post('/agent/turn', async (c) => {
    const secret = one<{ value: string }>(deps.conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)?.value ?? '';
    const auth = c.req.header('authorization') ?? '';
    const mac = verifyAgentToken(secret, auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!mac) return c.json({ error: 'unauthorized' }, 401);
    const parsed = turnSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    const body = parsed.data;
    if (body.device_id && canonicalMac(body.device_id) !== mac) return c.json({ error: 'device mismatch' }, 403);

    const device = one<{ agent_id: string }>(deps.conn, 'SELECT agent_id FROM devices WHERE mac = ?', mac);
    const agent = device ? loadAgent(deps, device.agent_id) : undefined;
    const query = body.query || [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';

    return sseResponse(c.req.raw.signal, async (send, signal) => {
      if (!agent) {
        send({ t: 'error', message: '设备未绑定智能体', speak: '😔这台设备还没有绑定智能体,请在控制塔里绑定。' });
        return;
      }
      if (!query.trim()) return;
      const context: DeviceContext = {
        mac,
        sessionId: body.session_id ?? null,
        turnId: body.turn_id ?? null,
        clientIp: body.client_ip ?? null,
        features: body.features ?? {},
      };
      const sink: TurnSink = {
        text: (v) => send({ t: 'text', v }),
        device: (msg) => send({ t: 'device', msg }),
        media: (item) => send({ t: 'media', ...item }),
        closeAfterTurn: () => send({ t: 'close_after_turn' }),
      };
      const started = Date.now();
      const summary = await runTurn(deps, {
        agent,
        device: context,
        query,
        engineMessages: body.messages,
        conversationKey: `device:${mac}`,
        record: body.session_id ? { mac, sessionId: body.session_id } : null,
        signal,
        sink,
      });
      deps.log?.(`[turn] ${mac} ${agent.name} ${summary.steps} 步 ${summary.toolCalls} 次工具 ${Date.now() - started}ms${signal.aborted ? ' (被打断)' : ''}${summary.error ? ` 错误:${summary.error}` : ''}`);
    });
  });

  return app;
}

const trySchema = z.object({
  agent_id: z.string().min(1).max(64),
  message: z.string().min(1).max(2000),
  conversation_id: z.string().min(1).max(64).default('default'),
  /** 借用一台在线设备:引擎工具在它身上执行,卡片也推到它的屏幕上 */
  device_mac: z.string().max(32).nullish(),
});

export function agentAdminRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });

  app.get('/status', async (c) => {
    const setting = (key: string) => one<{ value: string }>(deps.conn, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? '';
    return c.json({
      bridge: await deps.bridge.health(),
      bridge_url: setting('agent.bridge_url'),
      turn_url: setting('agent.turn_url'),
    });
  });

  app.post('/try', async (c) => {
    const parsed = trySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const input = parsed.data;
    const agent = loadAgent(deps, input.agent_id);
    if (!agent) return c.json({ error: '智能体不存在' }, 404);

    let context: DeviceContext = { mac: null, sessionId: null, turnId: null, clientIp: null, features: { xiaodan: 2 } };
    let borrowed = false;
    const mac = input.device_mac ? canonicalMac(input.device_mac) : null;
    if (mac) {
      try {
        const status = await deps.bridge.device(mac);
        if (status.online && status.session_id) {
          context = { mac, sessionId: status.session_id, turnId: null, clientIp: status.client_ip ?? null, features: status.features ?? {} };
          borrowed = true;
        }
      } catch {
        /* 桥不通就当没有设备 */
      }
    }

    return sseResponse(c.req.raw.signal, async (send, signal) => {
      send({ t: 'meta', device: borrowed ? mac : null });
      const forward = (msg: Record<string, unknown>) => {
        // 借用设备时把画面类消息也推过去,方便在真机上看卡片;表情与工具提示不推,免得打断设备当前状态
        if (borrowed && mac && msg['type'] === 'xiaodan') void deps.bridge.send(mac, [msg]).catch(() => {});
      };
      const sink: TurnSink = {
        text: (v) => send({ t: 'text', v }),
        device: (msg) => {
          send({ t: 'device', msg });
          forward(msg);
        },
        media: (item) => send({ t: 'media', ...item }),
        closeAfterTurn: () => send({ t: 'close_after_turn' }),
      };
      const trace = (event: TraceEvent) => send({ t: 'trace', ...event });
      const started = Date.now();
      const summary = await runTurn(deps, {
        agent,
        device: context,
        query: input.message,
        engineMessages: [],
        conversationKey: `web:${agent.id}:${input.conversation_id}`,
        record: null,
        signal,
        sink,
        trace,
      });
      send({ t: 'summary', steps: summary.steps, tool_calls: summary.toolCalls, ms: Date.now() - started, error: summary.error ?? null });
    });
  });

  app.post('/try/reset', async (c) => {
    const parsed = z.object({ agent_id: z.string().min(1).max(64), conversation_id: z.string().min(1).max(64) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    conversations.reset(`web:${parsed.data.agent_id}:${parsed.data.conversation_id}`);
    return c.json({ ok: true, conversation_id: randomUUID().slice(0, 8) });
  });

  return app;
}
