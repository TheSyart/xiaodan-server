// 设备生命周期钩子:设备每次连上引擎都会来 agent-models 取配置,这是控制塔唯一能及时知道「设备在线了」的时机。
// 各功能模块往 DEVICE_ONLINE_HOOKS 里登记(例如补报错过的提醒);钩子异步执行,不拖慢配置下发,出错只记日志。

export type DeviceOnlineHook = (mac: string, agentId: string) => void | Promise<void>;

export const DEVICE_ONLINE_HOOKS: DeviceOnlineHook[] = [];

export function onDeviceConfigFetched(mac: string, agentId: string): void {
  for (const hook of DEVICE_ONLINE_HOOKS) {
    setImmediate(() => {
      Promise.resolve()
        .then(() => hook(mac, agentId))
        .catch((error: unknown) => console.error(`[device-online] ${(error as Error).message}`));
    });
  }
}
