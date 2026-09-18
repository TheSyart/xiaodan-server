// 把待办里的热点与 IP 解析成位置。后台定时器做,不占对话那条路。
//
// 优先用设备扫到的热点(几十米),扫到的不够两个、没配服务商或高德失败时退回按 IP 的城市级。

import type { Db } from '../../db.ts';
import { all } from '../../db.ts';
import { defaultService } from '../services.ts';
import type { AgentDeps } from '../types.ts';
import { LocateError, locateByIp, locateByWifi, maskIp, type Bss } from './providers.ts';
import { locateEnabled, noteLocateError, saveLocation, takePending } from './store.ts';

const SCAN_MS = 20_000;

/** 定位服务商配好了没有 */
export function locateReady(conn: Db): boolean {
  return !!defaultService(conn, 'locate');
}

async function resolveOne(
  deps: AgentDeps, mac: string, input: { ip?: string; self?: Bss | null; aps?: Bss[] },
): Promise<'wifi' | 'ip' | 'failed'> {
  const { conn } = deps;
  const service = defaultService(conn, 'locate');
  const aps = input.aps ?? [];
  if (service && aps.length >= 2) {
    try {
      const result = await locateByWifi(deps.fetch, service.config, { self: input.self ?? null, aps });
      saveLocation(conn, mac, result, aps.length);
      deps.log?.(`[定位] ${mac} 按 ${aps.length} 个热点定到 ${result.city}${result.district},精度约 ${result.radius} 米`);
      return 'wifi';
    } catch (error) {
      deps.log?.(`[定位] ${mac} 热点定位失败:${(error as Error).message}`);
      noteLocateError(conn, mac, (error as Error).message);
    }
  }
  if (input.ip) {
    try {
      const result = await locateByIp(deps.fetch, input.ip);
      saveLocation(conn, mac, result, 0);
      deps.log?.(`[定位] ${mac} 按 IP(${maskIp(input.ip)})定到 ${result.province}${result.city}`);
      return 'ip';
    } catch (error) {
      const message = (error as Error).message;
      if (!(error instanceof LocateError)) deps.log?.(`[定位] ${mac} IP 定位出错:${message}`);
      noteLocateError(conn, mac, message);
    }
  }
  return 'failed';
}

/** 跑一轮:把待办清空并解析。测试直接调它,不等定时器。 */
export async function locateTick(deps: AgentDeps): Promise<number> {
  const todo = takePending().filter((item) => locateEnabled(deps.conn, item.mac));
  let done = 0;
  for (const item of todo) {
    const outcome = await resolveOne(deps, item.mac, item);
    if (outcome !== 'failed') done += 1;
  }
  return done;
}

/** 在 server.ts 的 onAgentDeps 里启动;测试环境不启动 */
export function startLocator(deps: AgentDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    locateTick(deps)
      .catch((error: unknown) => deps.log?.(`[定位] 出错:${(error as Error).message}`))
      .finally(() => { running = false; });
  }, SCAN_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** 开着定位的设备 */
export function locatingDevices(conn: Db): string[] {
  return all<{ mac: string }>(conn, 'SELECT mac FROM devices WHERE locate = 1').map((row) => row.mac);
}
