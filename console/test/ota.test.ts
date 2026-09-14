// OTA 接口:设备联网后先来这里问身份与绑定状态。
//
// 这组测试守的是安全边界:码只发给持有那把密钥的设备;冒充者既拿不到码也拿不到对话地址;
// 响应里永远不出现密钥或它的哈希;有人刷接口时,真设备不会被挡在外面。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, SECRET_KEY, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { getSetting } from '../src/settings.ts';
import { MAX_NEW_PENDING_PER_MINUTE, MAX_PENDING_PER_MAC, hashClientId } from '../src/identity.ts';

const WS = 'wss://agent.example.com/xiaozhi/v1/';

let conn: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
  app = createApp(conn);
  run(conn, "UPDATE settings SET value = ? WHERE key = 'server.websocket'", WS);
});

const newSecret = () => randomBytes(32).toString('hex');

interface OtaReply {
  status: string;
  [key: string]: unknown;
}

async function ota(headers: Record<string, string>) {
  const response = await app.request('http://localhost/xiaozhi/ota/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ application: { version: '0.2.0' }, board: { type: 'ai-passport' } }),
  });
  const text = await response.text();
  return { response, text, json: JSON.parse(text) as OtaReply };
}

const ask = (mac: string, clientId: string) => ota({ 'device-id': mac, 'client-id': clientId });

const activation = (reply: OtaReply) =>
  reply['activation'] as { code: string; expires_in_s: number; challenge: string } | undefined;

function bindDirect(mac: string, clientId: string): void {
  run(
    conn,
    'INSERT INTO devices (mac, agent_id, alias, secret_hash) VALUES (?, ?, ?, ?)',
    mac, DEFAULT_AGENT_ID, '测试设备', hashClientId(clientId),
  );
}

describe('请求校验', () => {
  test('缺 Device-Id 回 invalid_request', async () => {
    const { json } = await ota({ 'client-id': newSecret() });
    assert.equal(json.status, 'invalid_request');
    assert.equal(activation(json), undefined);
  });

  test('缺 Client-Id 回 invalid_request', async () => {
    const { json } = await ota({ 'device-id': 'aa:bb:cc:dd:ee:01' });
    assert.equal(json.status, 'invalid_request');
  });

  test('旧固件由 MAC 推出的 Client-Id 不再被接受', async () => {
    const { json } = await ask('aa:bb:cc:dd:ee:01', 'xiaodan-ddee01');
    assert.equal(json.status, 'invalid_request');
  });

  test('原版小智固件的 UUID Client-Id 被接受', async () => {
    const { json } = await ask('aa:bb:cc:dd:ee:02', randomUUID());
    assert.equal(json.status, 'unbound');
  });
});

describe('未绑定设备', () => {
  test('未知设备拿到六位码、轮询间隔与有效期', async () => {
    const { json } = await ask('AA:BB:CC:DD:EE:03', newSecret());
    assert.equal(json.status, 'unbound');
    const act = activation(json)!;
    assert.match(act.code, /^\d{6}$/u);
    assert.equal(act.expires_in_s, 600);
    assert.equal(act.challenge, 'aa:bb:cc:dd:ee:03', 'MAC 以规范化形式记录');
    assert.equal(json['poll_interval_s'], 5);
    assert.equal(json['rebind'], false);
  });

  test('同一身份再问得到同一个码,且有效期顺延', async () => {
    const mac = 'aa:bb:cc:dd:ee:04';
    const secret = newSecret();
    const first = await ask(mac, secret);
    run(conn, "UPDATE pending_devices SET expires_at = datetime('now', '+1 minute') WHERE mac = ?", mac);
    const before = one<{ expires_at: string }>(conn, 'SELECT expires_at FROM pending_devices WHERE mac = ?', mac)!.expires_at;

    const second = await ask(mac, secret);
    const after = one<{ expires_at: string }>(conn, 'SELECT expires_at FROM pending_devices WHERE mac = ?', mac)!.expires_at;
    assert.equal(activation(second.json)?.code, activation(first.json)?.code);
    assert.ok(after > before, '设备一直在轮询,码就不应过期');
  });

  test('同一 MAC 不同密钥拿到不同的码', async () => {
    const mac = 'aa:bb:cc:dd:ee:05';
    const real = await ask(mac, newSecret());
    const spoof = await ask(mac, newSecret());
    assert.notEqual(activation(real.json)?.code, activation(spoof.json)?.code,
      '冒充者抢先用同一 MAC 来要码,也不能拿到真设备屏幕上的那个码');
  });

  test('过期的待绑定行会被清理', async () => {
    await ask('aa:bb:cc:dd:ee:06', newSecret());
    run(conn, "UPDATE pending_devices SET expires_at = datetime('now', '-1 minute')");
    await ask('aa:bb:cc:dd:ee:07', newSecret());
    assert.equal(
      one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM pending_devices WHERE mac = 'aa:bb:cc:dd:ee:06'")!.n,
      0,
    );
  });
});

describe('已绑定设备', () => {
  test('持有正确密钥的设备拿到对话地址,不再给码,并记下版本', async () => {
    const mac = 'aa:bb:cc:dd:ee:10';
    const secret = newSecret();
    bindDirect(mac, secret);
    const { json } = await ask(mac, secret);
    assert.equal(json.status, 'bound');
    assert.deepEqual(json['websocket'], { url: WS, token: '' });
    assert.equal(activation(json), undefined);
    assert.equal(one<{ app_version: string }>(conn, 'SELECT app_version FROM devices WHERE mac = ?', mac)!.app_version, '0.2.0');
  });

  test('同 MAC 不同密钥被识别为冒充:拿不到码与地址,并留下记录', async () => {
    const mac = 'aa:bb:cc:dd:ee:11';
    bindDirect(mac, newSecret());
    const { json } = await ask(mac, newSecret());
    assert.equal(json.status, 'identity_mismatch');
    assert.equal(json['websocket'], undefined);
    assert.equal(activation(json), undefined);
    assert.equal(json['retry_after_s'], 30);
    const event = one<{ kind: string; source: string }>(conn, 'SELECT kind, source FROM identity_events WHERE mac = ?', mac);
    assert.deepEqual({ ...event }, { kind: 'mismatch', source: 'ota' });
  });

  test('已绑定设备不出示密钥时记录为缺少身份', async () => {
    const mac = 'aa:bb:cc:dd:ee:12';
    bindDirect(mac, newSecret());
    const { json } = await ota({ 'device-id': mac });
    assert.equal(json.status, 'invalid_request');
    assert.equal(one<{ kind: string }>(conn, 'SELECT kind FROM identity_events WHERE mac = ?', mac)?.kind, 'missing_identity');
  });

  test('控制塔还没配置对话地址时回 unavailable', async () => {
    const mac = 'aa:bb:cc:dd:ee:13';
    const secret = newSecret();
    bindDirect(mac, secret);
    run(conn, "UPDATE settings SET value = '' WHERE key = 'server.websocket'");
    const { json } = await ask(mac, secret);
    assert.equal(json.status, 'unavailable');
  });

  test('/activate 只对身份相符的已绑定设备回 success', async () => {
    const mac = 'aa:bb:cc:dd:ee:14';
    const secret = newSecret();
    bindDirect(mac, secret);
    const activate = (clientId: string) =>
      app.request('http://localhost/xiaozhi/ota/activate', {
        method: 'POST',
        headers: { 'device-id': mac, 'client-id': clientId },
      });
    assert.equal((await activate(secret)).status, 200);
    assert.equal((await activate(newSecret())).status, 202);
  });
});

describe('升级前就已绑定的设备', () => {
  test('拿到码并标记 rebind;在重新配对之前,引擎取配置仍被拒绝', async () => {
    const mac = '4c:11:ae:31:7a:30';
    const secret = newSecret();
    run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', mac, DEFAULT_AGENT_ID, 'AI Passport');

    const { json } = await ask(mac, secret);
    assert.equal(json.status, 'unbound');
    assert.equal(json['rebind'], true);
    assert.match(activation(json)!.code, /^\d{6}$/u);

    const response = await app.request('http://localhost/xiaozhi/config/agent-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getSetting(conn, SECRET_KEY)}` },
      body: JSON.stringify({ macAddress: mac, clientId: secret, selectedModule: {} }),
    });
    assert.equal(((await response.json()) as { code: number }).code, 10041,
      'MAC 是公开的,不能把第一个来要的身份自动认作这台设备');
  });
});

describe('限流', () => {
  test('同一 MAC 的新身份超过上限被限流,已有身份仍拿回原码', async () => {
    const mac = 'aa:bb:cc:dd:ee:20';
    const real = newSecret();
    const realReply = await ask(mac, real);
    for (let i = 1; i < MAX_PENDING_PER_MAC; i++) {
      assert.equal((await ask(mac, newSecret())).json.status, 'unbound');
    }
    const limited = await ask(mac, newSecret());
    assert.equal(limited.json.status, 'rate_limited');
    assert.equal(limited.response.headers.get('retry-after'), '60');

    const again = await ask(mac, real);
    assert.equal(activation(again.json)?.code, activation(realReply.json)?.code,
      '有人刷同一个 MAC 时,真设备不能被挡在外面');
  });

  test('每分钟新出现的待绑定身份超过上限被限流', async () => {
    for (let i = 0; i < MAX_NEW_PENDING_PER_MINUTE; i++) {
      const mac = `aa:bb:cc:dd:e1:${i.toString(16).padStart(2, '0')}`;
      assert.equal((await ask(mac, newSecret())).json.status, 'unbound');
    }
    assert.equal((await ask('aa:bb:cc:dd:e2:00', newSecret())).json.status, 'rate_limited');
  });
});

describe('信息不外泄', () => {
  test('任何响应里都不出现密钥与哈希', async () => {
    const secret = newSecret();
    const texts: string[] = [];
    texts.push((await ask('aa:bb:cc:dd:ee:30', secret)).text);
    bindDirect('aa:bb:cc:dd:ee:31', secret);
    texts.push((await ask('aa:bb:cc:dd:ee:31', secret)).text);
    texts.push((await ask('aa:bb:cc:dd:ee:31', newSecret())).text);
    for (const text of texts) {
      assert.ok(!text.includes(secret), '响应里出现了密钥');
      assert.ok(!text.includes(hashClientId(secret)), '响应里出现了密钥哈希');
    }
  });

  test('浏览器自检页不回显对话地址', async () => {
    const response = await app.request('http://localhost/xiaozhi/ota/');
    assert.ok(!(await response.text()).includes(WS));
  });
});
