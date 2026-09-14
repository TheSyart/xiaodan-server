// 设备 OTA 接口:设备联网后先来这里问"我绑定了没有、该连哪个对话服务"。
//
// 设备身份由两个请求头组成,详见 identity.ts:Device-Id 是 MAC(公开、可伪造),
// Client-Id 是设备自己生成并保存的密钥。原版小智固件放的是它自己的 UUID,同样接受。
//
// 所有结果都是 HTTP 200 + 顶层 status。这与本控制台对设备、引擎接口"HTTP 恒 200、
// 看 body"的约定一致,也避免 4xx/5xx 的响应体被前面的 nginx 换成它自己的错误页。
// 固件据 status 决定下一步;拿不到可解析的 status 一律按传输错误处理。
//
// 固件分发【不做】:firmware.url 永远指向一个无效地址。

import { Hono } from 'hono';
import type { Db } from './db.ts';
import { one, run, tx } from './db.ts';
import { getSetting } from './settings.ts';
import {
  INVALID_RETRY_S, MISMATCH_RETRY_S, OTA_POLL_INTERVAL_S, UNAVAILABLE_RETRY_S,
  canonicalMac, cleanupIdentityTables, ensurePendingCode, hashClientId, parseClientId,
  recordIdentityEvent, resolveDevice,
} from './identity.ts';

const NO_FIRMWARE = 'https://xiaodan.invalid/no-firmware-distribution';

function serverTime() {
  const now = new Date();
  return {
    timestamp: now.getTime(),
    timeZone: 'Asia/Shanghai',
    // 上游给的是分钟偏移
    timezone_offset: 480,
  };
}

/** 设备自报的板型与版本只用于展示,截断防止被塞进超长内容。 */
function clip(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 64) : '';
}

export function otaApi(conn: Db): Hono {
  const app = new Hono({ strict: false });

  // 浏览器直接打开时的自检页,只说明地址是否已配置,不回显地址本身。
  // (未绑定的回复里仍带地址,那是为原版小智固件保留的兼容字段;引擎会拒绝未通过核验的连接。)
  app.get('/', (c) => {
    const configured = (getSetting(conn, 'server.websocket') ?? '') !== '';
    return c.text(
      configured
        ? 'OTA 接口运行正常,设备连接地址已配置。'
        : 'OTA 接口已就绪,但尚未配置设备连接地址。请在控制塔的「设置」里填写。',
    );
  });

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      application?: { version?: unknown };
      board?: { type?: unknown };
    };
    const version = clip(body.application?.version);
    const board = clip(body.board?.type);
    const mac = canonicalMac(c.req.header('device-id'));
    const clientId = parseClientId(c.req.header('client-id'));
    const base = { server_time: serverTime(), firmware: { version, url: NO_FIRMWARE } };

    if (!mac || !clientId) {
      // 一个已经带身份绑定的 MAC 来问却不出示有效密钥,值得记下来:要么是旧固件,要么是有人在试。
      if (mac) {
        tx(conn, () => {
          const bound = one<{ secret_hash: string | null }>(conn, 'SELECT secret_hash FROM devices WHERE mac = ?', mac);
          if (bound && bound.secret_hash !== null) {
            recordIdentityEvent(conn, { mac, kind: 'missing_identity', source: 'ota', hash: null });
          }
        });
      }
      return c.json({
        status: 'invalid_request',
        error: 'Device-Id 或 Client-Id 缺失或格式不正确',
        retry_after_s: INVALID_RETRY_S,
      });
    }

    const hash = hashClientId(clientId);
    const ws = getSetting(conn, 'server.websocket') ?? '';

    const reply = tx(conn, (): Record<string, unknown> => {
      cleanupIdentityTables(conn);
      const identity = resolveDevice(conn, mac, hash);

      if (identity.kind === 'verified') {
        if (!ws) {
          return { status: 'unavailable', message: '控制塔尚未配置对话服务地址', retry_after_s: UNAVAILABLE_RETRY_S };
        }
        run(
          conn,
          `UPDATE devices SET last_connected_at = datetime('now'),
                              app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END
           WHERE mac = ?`,
          version, version, mac,
        );
        run(conn, 'DELETE FROM pending_devices WHERE mac = ?', mac);
        return { status: 'bound', ...base, websocket: { url: ws, token: '' } };
      }

      if (identity.kind === 'mismatch' || identity.kind === 'missing') {
        // 不给码也不给地址。冒充者从这里得不到任何能用的东西。
        recordIdentityEvent(conn, { mac, kind: 'mismatch', source: 'ota', hash });
        return {
          status: 'identity_mismatch',
          message: '设备身份与控制塔记录不符,请在控制塔解绑后重新绑定',
          retry_after_s: MISMATCH_RETRY_S,
        };
      }

      // 未知设备,或身份机制上线前就已绑定、需要重新配对的旧设备
      const pending = ensurePendingCode(conn, { mac, hash, board, version });
      if (!pending.ok) return { status: 'rate_limited', retry_after_s: pending.retryAfterS };
      return {
        status: 'unbound',
        ...base,
        // websocket 与 challenge 只为兼容原版小智固件保留,我们的固件在 unbound 时不使用它们。
        websocket: { url: ws, token: '' },
        activation: {
          code: pending.code,
          message: `请在控制塔输入 ${pending.code} 完成绑定`,
          challenge: mac,
          expires_in_s: pending.expiresInS,
        },
        poll_interval_s: OTA_POLL_INTERVAL_S,
        rebind: identity.kind === 'legacy',
      };
    });

    if (reply['status'] === 'rate_limited') c.header('Retry-After', String(reply['retry_after_s']));
    return c.json(reply);
  });

  // 原版固件用它轮询"我被激活了吗"。只有身份相符的已绑定设备才回 success,202 表示还没有。
  app.post('/activate', (c) => {
    const mac = canonicalMac(c.req.header('device-id'));
    const clientId = parseClientId(c.req.header('client-id'));
    if (!mac || !clientId) return c.body(null, 202);
    return resolveDevice(conn, mac, hashClientId(clientId)).kind === 'verified'
      ? c.text('success')
      : c.body(null, 202);
  });

  return app;
}
