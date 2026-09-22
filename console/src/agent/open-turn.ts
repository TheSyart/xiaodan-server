// 家长 App 直连控制塔的对话接口:带图的那一轮走这里。
//
// 为什么不走引擎:引擎调的 /xiaodan/agent/turn 只收文字 —— 小智协议的 listen 消息里没有图片这一类,
// 想让玩具或 App 经引擎送图得改上游 Python 与协议。而家长 App 本来就有直连控制塔的 HTTPS 通道
// (学分接口 /open/v1/credits),设备身份核验与公网放行都现成,把图直接送进来最省事。
// 文字轮仍然走引擎的 WebSocket:两条路共用同一段会话(device:<mac>),发完图接着说文字接得上。
//
// 鉴权:与学分外部接口同一套家长 App 设备身份(identity.ts 的 verifyAppDevice),只认 App 设备。
// 事件流(text/event-stream,与 /xiaodan/agent/turn 共用 sseResponse):
//   {t:'text', v}        回复文字,可能分几次到,客户端往后拼
//   {t:'tool', name}     这一轮在调哪个工具(客户端翻成「正在布置作业…」)
//   {t:'summary', ...}   本轮结束:steps、tool_calls、ms、error
//   {t:'error', message} 出错;最后固定一条 {t:'done'}

import type { Hono } from 'hono';
import { z } from 'zod';
import { verifyAppDevice } from '../identity.ts';
import { stripEmoji } from './emoji.ts';
import { runTurn } from './loop.ts';
import { loadAgent, sseResponse } from './routes.ts';
import type { AgentDeps, DeviceContext, TraceEvent, TurnSink } from './types.ts';
import { stripInlineTags } from '../voice/profile.ts';

export const OPEN_TURN_BASE = '/open/v1/agent/turn';

/**
 * App 这条路上没有引擎帮忙去表情与情感标签(那是引擎给设备做字幕时干的活),这里自己去掉:
 * 表情一律去掉(每句开头那个是给设备屏幕的表情),方括号里的英文标签也去掉。
 * 文字是逐块流下来的,残缺的部分先扣住 —— 免得把 "[ex" 这样的半截标签泄漏到界面上。
 */
export class DisplayText {
  private held = '';
  private started = false;
  private readonly stripTags: boolean;

  constructor(stripTags = true) {
    this.stripTags = stripTags;
  }

  push(chunk: string): string {
    let text = stripEmoji(this.held + chunk).replaceAll('\u001E', '');
    this.held = '';
    if (!this.started) {
      // 表情后面常跟一个空格;开头这段先别发出去,免得界面上先冒一个空白
      text = text.replace(/^\s+/u, '');
      if (!text) return '';
      this.started = true;
    }
    if (this.stripTags) {
      // 还没等到 ']' 的方括号尾巴:像标签就先扣住,不像(比如 "[1]" 的 "[1")就照常显示
      const open = text.lastIndexOf('[');
      if (open > text.lastIndexOf(']')) {
        const tail = text.slice(open);
        if (/^\[[a-z][a-z ]{0,30}$/u.test(tail)) {
          this.held = tail;
          text = text.slice(0, open);
        }
      }
      text = stripInlineTags(text);
    }
    // 落单的代理对(表情被切成了两半):扣到下一块再一起处理
    if (/[\uD800-\uDBFF]$/u.test(text)) {
      this.held = text.slice(-1) + this.held;
      text = text.slice(0, -1);
    }
    return text;
  }

  /** 收尾:扣住的残余里,没写完的标签与落单的代理对都不该显示出来,其余放出来 */
  finish(): string {
    const held = this.held;
    this.held = '';
    if (/^\[[a-z][a-z ]{0,30}$/u.test(held)) return '';
    const text = stripEmoji(held).replaceAll('\u001E', '').replace(/[\uD800-\uDBFF]$/u, '');
    return this.stripTags ? stripInlineTags(text) : text;
  }
}

const bodySchema = z.object({
  /** 家长说的话;只发图不说话时留空,这里补一句「看看这张图片。」 */
  text: z.string().max(2000).default(''),
  /** data URL,和网页试聊同一套限制:最多 3 张、每张 3MB 以内 */
  images: z.array(
    z.string().max(3_000_000).regex(/^data:image\/(png|jpeg|webp);base64,/u, '图片格式不对'),
  ).max(3).default([]),
});

/** 同一台设备同时只跑一轮:App 连点两下不该排出两轮,也不该让两轮去改同一段会话 */
const running = new Set<string>();

export function mountOpenTurn(app: Hono, deps: AgentDeps): void {
  app.post(OPEN_TURN_BASE, async (c) => {
    const check = verifyAppDevice(deps.conn, c.req.header('device-id'), c.req.header('client-id'));
    if (!check.ok) return c.json({ error: check.error, code: check.code }, check.status);

    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确', code: 'invalid' }, 400);
    const images = parsed.data.images;
    const text = parsed.data.text.trim() || (images.length ? '看看这张图片。' : '');
    if (!text) return c.json({ error: '要发一句话或者一张图片', code: 'invalid' }, 400);
    if (running.has(check.mac)) return c.json({ error: '上一轮还没说完,等它说完再发', code: 'busy' }, 409);

    const agent = loadAgent(deps, check.agentId);
    const mac = check.mac;
    return sseResponse(c.req.raw.signal, async (send, signal) => {
      if (!agent) {
        send({ t: 'error', message: '这台设备还没有绑定智能体' });
        return;
      }
      running.add(mac);
      // 引擎帮我们转发的客户端地址(nginx 的 location /open/ 带了 X-Real-IP);定位用得上,只留内存
      const clientIp = (c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? '').trim() || null;
      // features 为空:App 没有引擎那块屏,prompt 里就不该说「设备有一块小屏幕」
      const device: DeviceContext = { mac, sessionId: null, turnId: null, clientIp, features: {} };
      const display = new DisplayText();
      const sink: TurnSink = {
        text: (v) => {
          const clean = display.push(v);
          if (clean) send({ t: 'text', v: clean });
        },
        // 推给设备的东西(App 没有屏幕、也没连引擎)一律丢掉,工具进度改走下面的 trace
        device: () => {},
        media: (item) => send({ t: 'media', ...item }),
        closeAfterTurn: () => {},
      };
      const trace = (event: TraceEvent) => {
        if (event.kind === 'tool_call' && event.name) send({ t: 'tool', name: event.name, step: event.step });
      };
      const started = Date.now();
      try {
        const summary = await runTurn(deps, {
          agent,
          device,
          query: text,
          images,
          engineMessages: [],
          conversationKey: `device:${mac}`,
          record: { mac, sessionId: `app:${mac}` },
          signal,
          sink,
          trace,
        });
        const tail = display.finish();
        if (tail) send({ t: 'text', v: tail });
        send({ t: 'summary', steps: summary.steps, tool_calls: summary.toolCalls, ms: Date.now() - started, error: summary.error ?? null });
        deps.log?.(`[open-turn] ${mac} ${agent.name} ${summary.steps} 步 ${summary.toolCalls} 次工具 `
          + `${images.length ? `${images.length} 图 ` : ''}${Date.now() - started}ms${summary.error ? ` 错误:${summary.error}` : ''}`);
      } finally {
        running.delete(mac);
      }
    });
  });
}
