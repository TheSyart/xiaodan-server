// 定位的管理接口(挂在 /api/devices 下):开关、看一眼现在定到哪、立刻再定一次。
//
// 默认是关的。开着的时候:设备每次对话带上来的公网 IP 会被记下来当兜底,
// 新固件还会在空闲时扫一下周围的 Wi-Fi 热点上报(几十米)。

import { Hono } from 'hono';
import { z } from 'zod';
import { one, run } from '../../db.ts';
import { canonicalMac } from '../../identity.ts';
import type { AgentDeps } from '../types.ts';
import { locateTick, locateReady } from './resolver.ts';
import { deviceLocation, noteClientIp } from './store.ts';

export function locateRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  const device = (raw: string) => {
    const mac = canonicalMac(raw);
    return mac ? one<{ mac: string; locate: number }>(conn, 'SELECT mac, locate FROM devices WHERE mac = ?', mac) : undefined;
  };

  app.get('/:mac/locate', (c) => {
    const found = device(c.req.param('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    return c.json({ enabled: found.locate === 1, ready: locateReady(conn), location: deviceLocation(conn, found.mac) ?? null });
  });

  app.put('/:mac/locate', async (c) => {
    const found = device(c.req.param('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    run(conn, 'UPDATE devices SET locate = ? WHERE mac = ?', parsed.data.enabled ? 1 : 0, found.mac);
    // 关掉时把已经定到的位置一并删掉:不留着不再更新的旧坐标
    if (!parsed.data.enabled) run(conn, 'DELETE FROM device_locations WHERE mac = ?', found.mac);
    return c.json({ ok: true });
  });

  /**
   * 立刻再定一次。新固件会被请求扫一下周围的热点(几十米);老固件只能用这次对话的 IP(城市级)。
   * 设备不在线时直接说不在线,不留一个悬着的请求。
   */
  app.post('/:mac/locate/refresh', async (c) => {
    const found = device(c.req.param('mac'));
    if (!found) return c.json({ error: '设备不存在' }, 404);
    if (!found.locate) return c.json({ error: '这台设备还没有开启定位' }, 409);

    let asked = false;
    try {
      const status = await deps.bridge.device(found.mac);
      if (!status.online) return c.json({ error: '设备不在线' }, 404);
      const level = Number(status.features?.['xiaodan'] ?? 0);
      if (level >= 4) {
        await deps.bridge.send(found.mac, [{ type: 'xiaodan', cmd: 'loc_req' }]);
        asked = true;
      }
      if (status.client_ip) noteClientIp(found.mac, status.client_ip);
    } catch (error) {
      return c.json({ error: `连不上设备桥:${(error as Error).message}` }, 502);
    }
    const done = await locateTick(deps);
    return c.json({
      ok: true,
      asked_device: asked,
      located: done > 0,
      location: deviceLocation(conn, found.mac) ?? null,
      note: asked ? '已经让设备扫一下周围的热点,结果稍后到' : '这台设备的固件还不会扫热点,先按 IP 定到城市',
    });
  });

  return app;
}
