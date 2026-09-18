// 设备定位:高德「智能硬件定位」的解析与兜底、开关与立即定位、位置只留最新一条。
// 外部服务与设备桥用假的代替。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { all, one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { colonMac, isPublicIp, locateByIp, locateByWifi, parseLocation } from '../src/agent/locate/providers.ts';
import { locateTick } from '../src/agent/locate/resolver.ts';
import { deviceLocation, noteClientIp, noteScan } from '../src/agent/locate/store.ts';
import type { AgentDeps } from '../src/agent/types.ts';

let conn: Db;
const MAC = '4c:11:ae:31:7a:30';

class FakeBridge extends Bridge {
  sent: { mac: string; messages: Record<string, unknown>[] }[] = [];
  status: { online: boolean; session_id?: string; client_ip?: string; features?: Record<string, unknown> } = {
    online: true, session_id: 's1', client_ip: '1.2.3.4', features: { xiaodan: 3 },
  };
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
  override async device() {
    return this.status;
  }
  override async send(mac: string, messages: Record<string, unknown>[]) {
    this.sent.push({ mac, messages });
    return { status: 200, data: {} };
  }
}

/** 按 URL 分发的假 fetch */
function router(routes: [RegExp, (url: string) => Response][]) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(String(url));
    const hit = routes.find(([re]) => re.test(String(url)));
    return hit ? hit[1](String(url)) : new Response('{}', { status: 404 });
  };
  return { fetchImpl, calls };
}

const amapOk = (location: string, radius = 45) => new Response(JSON.stringify({
  status: '1', info: 'OK', result: { location, radius: String(radius), province: '浙江省', city: '杭州市', district: '西湖区', desc: '文三路附近' },
}));

/** 太平洋那家返回的是 GBK */
function pconlineOk() {
  const body = Buffer.concat([
    Buffer.from('{"city":"'), Buffer.from([0xBA, 0xBC, 0xD6, 0xDD]),
    Buffer.from('","pro":"'), Buffer.from([0xD5, 0xE3, 0xBD, 0xAD]),
    Buffer.from('","addr":"'), Buffer.from([0xD5, 0xE3, 0xBD, 0xAD, 0xBA, 0xBC, 0xD6, 0xDD]), Buffer.from('"}'),
  ]);
  return new Response(body);
}

function deps(fetchImpl: AgentDeps['fetch'], bridge = new FakeBridge()): AgentDeps {
  return { conn, fetch: fetchImpl, bridge, dataDir: () => '/tmp', log: () => {} };
}

beforeEach(() => {
  process.env['XIAODAN_AUTH_MODE'] = 'proxy';
  conn = openMemoryDb();
  seed(conn);
  run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', MAC, DEFAULT_AGENT_ID, '客厅的小单');
  // 清掉上一轮测试留在内存队列里的东西
  noteScan('zz:zz', { aps: [] });
  locateTick({ conn, fetch: async () => new Response('{}'), bridge: new FakeBridge(), dataDir: () => '/tmp' });
});

const enableAmap = () => run(conn,
  "INSERT INTO service_providers (id, kind, name, provider, config_json, is_default, enabled) VALUES ('svc_geo', 'locate', '高德', 'amap', ?, 1, 1)",
  JSON.stringify({ api_key: 'amap-key' }));

describe('解析高德与 IP 的返回', () => {
  test('经纬顺序两种都认得出来,超出中国范围就当没有坐标', () => {
    assert.deepEqual(parseLocation('120.1234,30.2345'), { lng: 120.1234, lat: 30.2345 });
    assert.deepEqual(parseLocation('30.2345,120.1234'), { lng: 120.1234, lat: 30.2345 }, '文档写的是纬在前,别赌');
    assert.equal(parseLocation('200,300'), null);
    assert.equal(parseLocation('abc'), null);
  });

  test('BSSID 要 12 位十六进制,内网 IP 不查', () => {
    assert.equal(colonMac('001122AABBCC'), '00:11:22:aa:bb:cc');
    assert.equal(colonMac('00:11:22:aa:bb:cc'), '00:11:22:aa:bb:cc');
    assert.equal(colonMac('0011'), '');
    assert.equal(isPublicIp('1.2.3.4'), true);
    for (const ip of ['192.168.1.5', '10.0.0.2', '172.16.0.1', '100.64.0.1', '127.0.0.1', '']) {
      assert.equal(isPublicIp(ip), false, ip);
    }
  });

  test('至少要两个热点;高德说没结果时如实报错', async () => {
    const { fetchImpl } = router([[/apilocate/u, () => amapOk('120.1,30.2')]]);
    await assert.rejects(
      locateByWifi(fetchImpl, { api_key: 'k' }, { aps: [{ bssid: '001122334455', rssi: -50 }] }),
      /至少要两个/u,
    );
    const result = await locateByWifi(fetchImpl, { api_key: 'k' }, {
      self: { bssid: '001122334455', rssi: -40 },
      aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }],
    });
    assert.equal(result.source, 'wifi');
    assert.equal(result.city, '杭州市');
    assert.equal(result.radius, 45);

    const failing = router([[/apilocate/u, () => new Response(JSON.stringify({ status: '0', info: 'INVALID_USER_KEY' }))]]);
    await assert.rejects(
      locateByWifi(failing.fetchImpl, { api_key: 'k' }, { aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }] }),
      /INVALID_USER_KEY/u,
    );
  });

  test('IP 定位认得 GBK,内网 IP 直接拒绝', async () => {
    const { fetchImpl, calls } = router([[/pconline/u, () => pconlineOk()]]);
    const result = await locateByIp(fetchImpl, '1.2.3.4');
    assert.equal(result.source, 'ip');
    assert.equal(result.city, '杭州');
    assert.equal(result.province, '浙江');
    assert.equal(result.lat, null, 'IP 定位没有坐标');
    assert.match(calls[0]!, /ip=1\.2\.3\.4/u);
    await assert.rejects(locateByIp(fetchImpl, '192.168.1.9'), /公网/u);
  });
});

describe('后台解析', () => {
  test('热点够就用高德,不够或没配服务商就退回 IP', async () => {
    run(conn, 'UPDATE devices SET locate = 1 WHERE mac = ?', MAC);
    enableAmap();
    const { fetchImpl } = router([[/apilocate/u, () => amapOk('120.1,30.2')], [/pconline/u, () => pconlineOk()]]);
    const d = deps(fetchImpl);

    noteScan(MAC, { aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }] });
    assert.equal(await locateTick(d), 1);
    let location = deviceLocation(conn, MAC)!;
    assert.equal(location.source, 'wifi');
    assert.equal(location.radius, 45);
    assert.equal(location.ap_count, 2);
    assert.equal(location.district, '西湖区');

    // 只扫到一个热点:退回 IP
    noteScan(MAC, { aps: [{ bssid: '001122334455', rssi: -40 }] });
    noteClientIp(MAC, '1.2.3.4');
    assert.equal(await locateTick(d), 1);
    location = deviceLocation(conn, MAC)!;
    assert.equal(location.source, 'ip');
    assert.equal(location.city, '杭州');
    assert.equal(location.lat, null);

    // 没配定位服务商:热点再多也只能按 IP
    run(conn, 'DELETE FROM service_providers');
    noteScan(MAC, { aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }] });
    noteClientIp(MAC, '1.2.3.4');
    assert.equal(await locateTick(d), 1);
    assert.equal(deviceLocation(conn, MAC)!.source, 'ip');
  });

  test('关着定位的设备一个请求都不发', async () => {
    const { fetchImpl, calls } = router([[/./u, () => new Response('{}')]]);
    noteClientIp(MAC, '1.2.3.4');
    noteScan(MAC, { aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }] });
    assert.equal(await locateTick(deps(fetchImpl)), 0);
    assert.deepEqual(calls, []);
    assert.equal(deviceLocation(conn, MAC), undefined);
  });

  test('定位失败只记原因,不覆盖上一次定到的位置', async () => {
    run(conn, 'UPDATE devices SET locate = 1 WHERE mac = ?', MAC);
    enableAmap();
    const good = router([[/apilocate/u, () => amapOk('120.1,30.2')]]);
    noteScan(MAC, { aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }] });
    await locateTick(deps(good.fetchImpl));

    const bad = router([[/apilocate/u, () => new Response(JSON.stringify({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT' }))]]);
    noteScan(MAC, { aps: [{ bssid: '001122334455', rssi: -40 }, { bssid: '001122334466', rssi: -70 }] });
    assert.equal(await locateTick(deps(bad.fetchImpl)), 0);
    const location = deviceLocation(conn, MAC)!;
    assert.equal(location.city, '杭州市', '旧位置还在');
    assert.match(location.last_error, /DAILY_QUERY_OVER_LIMIT/u);
  });
});

describe('引擎报上来的热点', () => {
  const report = (app: ReturnType<typeof createApp>, body: unknown, secret = 'engine-secret') =>
    app.request('http://localhost/xiaozhi/agent/device-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });

  test('要密钥;开着定位才收;收下的热点只进内存,一个字节都不落库', async () => {
    run(conn, "UPDATE settings SET value = 'engine-secret' WHERE key = 'server.secret'");
    run(conn, 'UPDATE devices SET locate = 1 WHERE mac = ?', MAC);
    enableAmap();
    const { fetchImpl } = router([[/apilocate/u, () => amapOk('120.1,30.2')]]);
    const app = createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });

    // 这套接口照上游的约定:HTTP 永远 200,成败看 body 里的 code
    const denied = await report(app, { macAddress: MAC, aps: ['001122334455,-40'] }, 'wrong');
    assert.equal(((await denied.json()) as { code: number }).code, 401);
    const accepted = await report(app, { macAddress: MAC, self: '001122334455,-40', aps: ['001122334455,-40', '001122334466,-70'] });
    assert.equal(accepted.status, 200);
    assert.equal(((await accepted.json()) as { code: number }).code, 0);

    // 落库的是解析出来的位置,不是热点
    assert.equal(await locateTick(deps(fetchImpl)), 1);
    const location = deviceLocation(conn, MAC)!;
    assert.equal(location.source, 'wifi');
    assert.equal(location.ap_count, 2);
    const dump = JSON.stringify(all(conn, "SELECT * FROM device_locations"));
    assert.doesNotMatch(dump, /001122334455/u, 'BSSID 不落库');
  });

  test('没开定位的设备直接丢掉;热点都不合法时报错', async () => {
    run(conn, "UPDATE settings SET value = 'engine-secret' WHERE key = 'server.secret'");
    const { fetchImpl, calls } = router([[/./u, () => new Response('{}')]]);
    const app = createApp(conn, { agent: { fetch: fetchImpl, bridge: new FakeBridge(), log: () => {} } });
    const ignored = await report(app, { macAddress: MAC, aps: ['001122334455,-40', '001122334466,-70'] });
    assert.equal(((await ignored.json()) as { data: unknown }).data, false, '没开定位就当没收到');
    assert.equal(await locateTick(deps(fetchImpl)), 0);
    assert.deepEqual(calls, []);

    run(conn, 'UPDATE devices SET locate = 1 WHERE mac = ?', MAC);
    const bad = await report(app, { macAddress: MAC, aps: ['zzz,-40', '001122334455'] });
    assert.notEqual(((await bad.json()) as { code: number }).code, 0);
  });
});

describe('设备页的定位开关', () => {
  const api = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
    app.request(`http://localhost/api/devices/${MAC}${path}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test('默认关着;开了才定位,关掉时把位置一并删掉', async () => {
    const bridge = new FakeBridge();
    const app = createApp(conn, { agent: { fetch: async () => pconlineOk(), bridge, log: () => {} } });
    assert.equal(one<{ locate: number }>(conn, 'SELECT locate FROM devices WHERE mac = ?', MAC)!.locate, 0);

    let response = await (await api(app, 'GET', '/locate')).json() as { enabled: boolean; ready: boolean };
    assert.deepEqual(response, { enabled: false, ready: false, location: null } as never);

    assert.equal((await api(app, 'POST', '/locate/refresh', {})).status, 409, '没开就不许定位');
    assert.equal((await api(app, 'PUT', '/locate', { enabled: true })).status, 200);

    const refreshed = await (await api(app, 'POST', '/locate/refresh', {})).json() as { located: boolean; asked_device: boolean; note: string };
    assert.equal(refreshed.located, true, '老固件用这次连接的 IP 定到城市');
    assert.equal(refreshed.asked_device, false, '3 级固件还不会扫热点');
    assert.equal(deviceLocation(conn, MAC)!.city, '杭州');

    assert.equal((await api(app, 'PUT', '/locate', { enabled: false })).status, 200);
    assert.equal(deviceLocation(conn, MAC), undefined, '关掉就不留旧坐标');
  });

  test('设备不在线时如实说,不留悬着的请求', async () => {
    const bridge = new FakeBridge();
    bridge.status = { online: false };
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge, log: () => {} } });
    await api(app, 'PUT', '/locate', { enabled: true });
    const response = await api(app, 'POST', '/locate/refresh', {});
    assert.equal(response.status, 404);
    assert.match((await response.json() as { error: string }).error, /不在线/u);
    assert.deepEqual(bridge.sent, []);
  });

  test('设备列表带上位置,页面不用再逐台查', async () => {
    run(conn, 'UPDATE devices SET locate = 1 WHERE mac = ?', MAC);
    run(conn,
      `INSERT INTO device_locations (mac, source, lng, lat, radius, province, city, district, address, provider, located_at)
       VALUES (?, 'wifi', 120.1, 30.2, 45, '浙江省', '杭州市', '西湖区', '文三路附近', 'amap', datetime('now'))`, MAC);
    const app = createApp(conn, { agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {} } });
    const list = await (await app.request('http://localhost/api/devices')).json() as {
      items: { mac: string; locate: number; loc_city: string; loc_radius: number; loc_source: string }[];
    };
    const device = list.items.find((item) => item.mac === MAC)!;
    assert.equal(device.locate, 1);
    assert.equal(device.loc_city, '杭州市');
    assert.equal(device.loc_radius, 45);
    assert.equal(device.loc_source, 'wifi');
  });

  test('解绑设备时位置一起删掉', () => {
    run(conn,
      "INSERT INTO device_locations (mac, source, city, located_at) VALUES (?, 'ip', '杭州', datetime('now'))", MAC);
    run(conn, 'DELETE FROM devices WHERE mac = ?', MAC);
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM device_locations')!.n, 0);
  });
});
