// 设备 OTA / 激活接口。
//
// 我们自研的固件不用它(直接连 WebSocket),但原版小智固件会先 POST 这里拿
// WebSocket 地址和激活码。实现它的成本很低,却能让这个控制台对现成的小智硬件
// 也能用,所以保留。
//
// 固件分发【不做】:字段保留但永远指向一个无效地址,与上游未激活时的行为一致。

import { Hono } from 'hono';
import type { Db } from './db.ts';
import { one, run } from './db.ts';
import { ensureBindCode } from './manager-api.ts';
import { getSetting } from './settings.ts';

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

/** MAC 形如 aa:bb:cc:dd:ee:ff,允许连字符。 */
function validMac(value: string): boolean {
  return /^([0-9A-Za-z]{2}[:-]){5}[0-9A-Za-z]{2}$/.test(value);
}

export function otaApi(conn: Db): Hono {
  const app = new Hono({ strict: false });

  // 浏览器直接打开时的自检页,方便确认地址配对了没有。
  app.get('/', (c) => {
    const ws = getSetting(conn, 'server.websocket') ?? '';
    if (!ws) {
      return c.text('OTA 接口已就绪,但尚未配置设备连接地址。请在控制台的「设置」里填写 WebSocket 地址。');
    }
    return c.text(`OTA 接口运行正常。设备连接地址:${ws}`);
  });

  app.post('/', async (c) => {
    const deviceId = (c.req.header('device-id') ?? '').trim();
    if (!deviceId || !validMac(deviceId)) {
      return c.json({ error: 'Device ID is required' });
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      application?: { version?: string };
      board?: { type?: string };
    };
    const version = body.application?.version ?? '';
    const board = body.board?.type ?? '';

    const device = one<{ mac: string }>(conn, 'SELECT mac FROM devices WHERE mac = ?', deviceId);
    const ws = getSetting(conn, 'server.websocket') ?? '';

    const response: Record<string, unknown> = {
      server_time: serverTime(),
      firmware: { version, url: NO_FIRMWARE },
      websocket: { url: ws, token: '' },
    };

    if (device) {
      run(
        conn,
        `UPDATE devices SET last_connected_at = datetime('now'),
                            app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END
         WHERE mac = ?`,
        version,
        version,
        deviceId,
      );
    } else {
      const code = ensureBindCode(conn, deviceId);
      // 顺带把设备自报的板型与版本记下来,控制台的待绑定列表能显示得更有信息量
      run(
        conn,
        `UPDATE pending_devices SET board = CASE WHEN ? <> '' THEN ? ELSE board END,
                                    app_version = CASE WHEN ? <> '' THEN ? ELSE app_version END
         WHERE mac = ?`,
        board,
        board,
        version,
        version,
        deviceId,
      );
      response['activation'] = {
        code,
        message: `请在控制台输入 ${code} 完成绑定`,
        challenge: deviceId,
      };
    }

    return c.json(response);
  });

  // 原版固件用它轮询"我被激活了吗"。202 表示还没有。
  app.post('/activate', (c) => {
    const deviceId = (c.req.header('device-id') ?? '').trim();
    if (!deviceId) return c.body(null, 202);
    const device = one(conn, 'SELECT 1 FROM devices WHERE mac = ?', deviceId);
    return device ? c.text('success') : c.body(null, 202);
  });

  return app;
}
