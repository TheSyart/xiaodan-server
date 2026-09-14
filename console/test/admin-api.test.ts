// 管理接口测试:登录、权限边界、各资源的增删改,以及几条"不允许做"的规则。

import { strict as assert } from 'node:assert';
import { test, beforeEach, describe } from 'node:test';
import { randomBytes } from 'node:crypto';
import { openMemoryDb, one, run, type Db } from '../src/db.ts';
import { seed, DEFAULT_AGENT_ID } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { hashClientId } from '../src/identity.ts';

let conn: Db;
let app: ReturnType<typeof createApp>;
let cookie = '';

const USER = 'admin';
const PASS = 'correct-horse-battery';

beforeEach(async () => {
  // 本文件测的是 local 模式(控制台自管账号)。默认是 proxy 模式,
  // 那种模式下所有请求都放行,这里的权限用例就没有意义了。
  process.env.XIAODAN_AUTH_MODE = 'local';
  conn = openMemoryDb();
  seed(conn);
  app = createApp(conn);
  cookie = '';
  const response = await api('POST', '/setup', { username: USER, password: PASS });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
});

async function api(method: string, path: string, body?: unknown, withCookie = true) {
  return app.request(`http://localhost/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(withCookie && cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const json = async <T = any>(response: Response): Promise<T> => (await response.json()) as T;

describe('登录与初始化', () => {
  test('初始化后即为已登录', async () => {
    const status = await json(await api('GET', '/setup/status'));
    assert.equal(status.initialized, true);
    assert.equal(status.authenticated, true);
  });

  test('不能重复初始化', async () => {
    // 否则任何人都能把管理员密码改掉,等于一个后门
    const response = await api('POST', '/setup', { username: 'x', password: 'yyyyyyyy' }, false);
    assert.equal(response.status, 409);
  });

  test('没有 Cookie 时管理接口返回 401', async () => {
    const response = await api('GET', '/models', undefined, false);
    assert.equal(response.status, 401);
  });

  test('密码错误不泄露用户名是否存在', async () => {
    const wrongUser = await api('POST', '/login', { username: 'nobody', password: PASS }, false);
    const wrongPass = await api('POST', '/login', { username: USER, password: 'bad-password' }, false);
    assert.equal(wrongUser.status, 401);
    assert.equal(wrongPass.status, 401);
    assert.deepEqual(await json(wrongUser), await json(wrongPass), '两种失败的响应必须一模一样');
  });

  test('密码至少 8 位', async () => {
    conn.exec('DELETE FROM admin');
    const response = await api('POST', '/setup', { username: 'a', password: 'short' }, false);
    assert.equal(response.status, 400);
  });

  test('登出后会话立即失效', async () => {
    await api('POST', '/logout');
    const response = await api('GET', '/models');
    assert.equal(response.status, 401);
  });
});

describe('模型', () => {
  test('新建时自动写入 type 字段', async () => {
    // 服务端靠 config_json.type 决定加载哪个 provider 模块,漏了就会在
    // 设备连上来时报"不支持的 XXX 类型",而控制台这边看起来一切正常。
    const response = await api('POST', '/models', {
      id: 'LLM_Test', model_type: 'LLM', name: '测试', provider: 'openai',
      config: { base_url: 'https://x/v1', model_name: 'm', api_key: 'k' },
    });
    assert.equal(response.status, 200);
    const row = one<{ config_json: string }>(conn, 'SELECT config_json FROM models WHERE id = ?', 'LLM_Test');
    assert.equal(JSON.parse(row!.config_json).type, 'openai');
  });

  test('拒绝目录里没有的供应商', async () => {
    const response = await api('POST', '/models', {
      id: 'LLM_Bad', model_type: 'LLM', name: 'x', provider: 'not-a-real-provider', config: {},
    });
    assert.equal(response.status, 400);
  });

  test('id 重复时返回 409', async () => {
    const payload = { id: 'LLM_Dup', model_type: 'LLM', name: 'x', provider: 'openai', config: {} };
    assert.equal((await api('POST', '/models', payload)).status, 200);
    assert.equal((await api('POST', '/models', payload)).status, 409);
  });

  test('设为默认会取消同类型的其他默认项', async () => {
    await api('POST', '/models', { id: 'LLM_A', model_type: 'LLM', name: 'A', provider: 'openai', config: {} });
    await api('POST', '/models', { id: 'LLM_B', model_type: 'LLM', name: 'B', provider: 'openai', config: {} });
    await api('POST', '/models/LLM_A/default');
    await api('POST', '/models/LLM_B/default');
    const defaults = conn.prepare("SELECT id FROM models WHERE model_type='LLM' AND is_default=1").all();
    assert.equal(defaults.length, 1);
    assert.equal((defaults[0] as any).id, 'LLM_B');
  });

  test('编辑模型只替换目录里的字段,库里目录之外的配置键保留', async () => {
    // 命令行从旧配置导入的模型常带目录里没有的键(如 pcm_sample_rate)。
    // 表单只提交目录字段,整体覆盖会把它们悄悄抹掉,合成就会用错采样率。
    run(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Keep', 'TTS', '合成', 'gateway_omni_tts', ?)`,
      JSON.stringify({ type: 'gateway_omni_tts', base_url: 'https://old/v1', api_key: 'k-old', voice: 'Ethan', pcm_sample_rate: 24000 }));
    const response = await api('PUT', '/models/TTS_Keep', {
      model_type: 'TTS', name: '合成', provider: 'gateway_omni_tts',
      config: { base_url: 'https://new/v1', api_key: 'k-new', model_name: 'omni' },
    });
    assert.equal(response.status, 200);
    const config = JSON.parse(one<{ config_json: string }>(conn, "SELECT config_json FROM models WHERE id = 'TTS_Keep'")!.config_json);
    assert.equal(config.pcm_sample_rate, 24000, '目录之外的键要保留');
    assert.equal(config.base_url, 'https://new/v1', '目录字段按提交值更新');
    assert.equal(config.voice, undefined, '目录字段没有提交就是清除');
    assert.equal(config.type, 'gateway_omni_tts');
  });

  test('目录里没有引擎镜像已经去掉的本地识别', async () => {
    const catalog = await json(await api('GET', '/catalog'));
    assert.ok(!catalog.providers.ASR.some((p: any) => p.provider === 'fun_local'));
  });

  test('被智能体引用的模型不能删', async () => {
    // 删了会让设备连上来时拿到一份缺模块的配置,那种故障很难定位到这一步。
    const response = await api('DELETE', '/models/VAD_SileroVAD');
    assert.equal(response.status, 409);
  });
});

describe('智能体', () => {
  test('默认智能体不能删', async () => {
    const response = await api('DELETE', `/agents/${DEFAULT_AGENT_ID}`);
    assert.equal(response.status, 409);
  });

  test('有设备绑定时不能删', async () => {
    const created = await json(await api('POST', '/agents', { name: '备用' }));
    run(conn, 'INSERT INTO devices (mac, agent_id) VALUES (?, ?)', 'aa:bb:cc:dd:ee:01', created.id);
    const response = await api('DELETE', `/agents/${created.id}`);
    assert.equal(response.status, 409);
  });

  test('插件整体覆盖,且拒绝未知插件', async () => {
    const good = await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, [
      { plugin_code: 'get_time', params: {} },
      { plugin_code: 'get_weather', params: { api_key: 'k' } },
    ]);
    assert.equal(good.status, 200);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM agent_plugins').get<any>()!.n, 2);

    // 再覆盖成一个
    await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, [{ plugin_code: 'get_time', params: {} }]);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM agent_plugins').get<any>()!.n, 1);

    const bad = await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, [
      { plugin_code: 'rm-rf-slash', params: {} },
    ]);
    assert.equal(bad.status, 400);
  });
});

describe('设备绑定', () => {
  const newSecret = () => randomBytes(32).toString('hex');

  /** 模拟一台设备开机后调 OTA:返回它屏幕上会显示的码,以及它的密钥。 */
  async function makePending(mac: string, clientId = newSecret()) {
    const response = await app.request('http://localhost/xiaozhi/ota/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'device-id': mac, 'client-id': clientId },
      body: JSON.stringify({ application: { version: '0.2.0' }, board: { type: 'ai-passport' } }),
    });
    const body = await json(response);
    return { status: body.status as string, code: body.activation?.code as string, clientId };
  }

  /** 引擎替设备取配置。 */
  async function agentModels(mac: string, clientId: string) {
    const secret = one<{ value: string }>(conn, "SELECT value FROM settings WHERE key='server.secret'")!.value;
    const response = await app.request('http://localhost/xiaozhi/config/agent-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ macAddress: mac, clientId, selectedModule: {} }),
    });
    return json(response);
  }

  const devicePath = (mac: string) => `/devices/${encodeURIComponent(mac)}`;

  test('待绑定列表只有设备信息,不含绑定码与任何密钥材料', async () => {
    // 码只应出现在设备屏幕上。页面若显示码,任何能打开控制塔的人都能把别人的设备绑走,
    // 冒充者抢先用同一 MAC 来要的码也会被当成真设备的码。
    const first = await makePending('aa:bb:cc:dd:ee:10');
    await makePending('aa:bb:cc:dd:ee:10');
    const response = await api('GET', '/devices');
    const text = await response.text();
    const list = JSON.parse(text);

    assert.equal(list.pending.length, 2);
    for (const row of list.pending) {
      assert.equal(row.code, undefined);
      assert.equal(row.secret_hash, undefined);
      assert.equal(row.mac, 'aa:bb:cc:dd:ee:10');
      assert.equal(row.same_mac_count, 2, '同一 MAC 出现多个身份时页面要能提示');
      assert.ok(Number.isInteger(row.id));
      assert.ok(row.last_seen_at);
    }
    assert.ok(!text.includes(first.code), '响应里出现了绑定码');
    assert.ok(!text.includes(first.clientId), '响应里出现了设备密钥');
    assert.ok(!/[0-9a-f]{64}/u.test(text), '响应里出现了疑似密钥哈希的串');
    assert.ok(!text.includes('client_fp'), '响应里出现了哈希指纹');
  });

  test('输入屏幕上的码完成绑定,之后只有这台设备能取到配置', async () => {
    const mac = 'aa:bb:cc:dd:ee:11';
    const device = await makePending(mac);
    const response = await api('POST', '/devices/bind', { code: device.code, agent_id: DEFAULT_AGENT_ID, alias: '客厅' });
    assert.equal(response.status, 200);

    const list = await json(await api('GET', '/devices'));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].alias, '客厅');
    assert.equal(list.items[0].identity, 'verified');
    assert.equal(list.items[0].secret_hash, undefined, '绝不返回密钥哈希');
    assert.equal(list.pending.length, 0, '绑定后应从待绑定列表移除');

    const own = await agentModels(mac, device.clientId);
    assert.equal(own.code, 0, '绑定之后不应再返回 10042');
    assert.ok(own.data.prompt, '应带上人设');
    assert.equal((await agentModels(mac, newSecret())).code, 10041, '同 MAC 的其他密钥拿不到配置');
  });

  test('不指定智能体时绑到默认智能体', async () => {
    const device = await makePending('aa:bb:cc:dd:ee:12');
    assert.equal((await api('POST', '/devices/bind', { code: device.code })).status, 200);
    assert.equal((await json(await api('GET', '/devices'))).items[0].agent_id, DEFAULT_AGENT_ID);
  });

  test('不再支持按 MAC 绑定', async () => {
    const device = await makePending('aa:bb:cc:dd:ee:13');
    const byMac = await api('POST', '/devices/bind', { mac: 'aa:bb:cc:dd:ee:13', agent_id: DEFAULT_AGENT_ID });
    assert.equal(byMac.status, 400);
    const both = await api('POST', '/devices/bind', { code: device.code, mac: 'aa:bb:cc:dd:ee:13' });
    assert.equal(both.status, 400, '带着 mac 字段一律拒绝,不能悄悄忽略');
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM devices')!.n, 0);
  });

  test('错误的码返回 404', async () => {
    const device = await makePending('aa:bb:cc:dd:ee:14');
    const wrong = device.code === '000000' ? '000001' : '000000';
    const response = await api('POST', '/devices/bind', { code: wrong, agent_id: DEFAULT_AGENT_ID });
    assert.equal(response.status, 404);
  });

  test('绑到不存在的智能体上会被拒绝', async () => {
    const device = await makePending('aa:bb:cc:dd:ee:15');
    const response = await api('POST', '/devices/bind', { code: device.code, agent_id: 'agent_nope' });
    assert.equal(response.status, 400);
  });

  test('已带身份的设备不能被另一条待绑定记录覆盖', async () => {
    const mac = 'aa:bb:cc:dd:ee:16';
    const device = await makePending(mac);
    await api('POST', '/devices/bind', { code: device.code });
    // 正常流程里设备绑定后就拿不到新码了;这里直接插一条,守住"必须先解绑"这条规则。
    run(conn,
      "INSERT INTO pending_devices (mac, secret_hash, code, expires_at) VALUES (?, ?, '654321', datetime('now', '+10 minutes'))",
      mac, hashClientId(newSecret()));
    const again = await api('POST', '/devices/bind', { code: '654321' });
    assert.equal(again.status, 409);
    assert.equal((await agentModels(mac, device.clientId)).code, 0, '原设备不受影响');
  });

  test('升级前绑定的旧设备输码后原地重新配对,别名与智能体保留', async () => {
    const mac = '4c:11:ae:31:7a:30';
    const spare = await json(await api('POST', '/agents', { name: '备用' }));
    run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', mac, spare.id, '书房');
    assert.equal((await json(await api('GET', '/devices'))).items[0].identity, 'legacy');

    const device = await makePending(mac);
    assert.equal(device.status, 'unbound');
    assert.equal((await api('POST', '/devices/bind', { code: device.code })).status, 200);

    const list = await json(await api('GET', '/devices'));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].identity, 'verified');
    assert.equal(list.items[0].alias, '书房');
    assert.equal(list.items[0].agent_id, spare.id);
    assert.equal((await agentModels(mac, device.clientId)).code, 0);
  });

  test('解绑清除设备、待绑定记录与身份事件;未知设备返回 404', async () => {
    const mac = 'aa:bb:cc:dd:ee:17';
    const device = await makePending(mac);
    await api('POST', '/devices/bind', { code: device.code });
    assert.equal((await makePending(mac)).status, 'identity_mismatch');
    assert.equal((await json(await api('GET', '/devices'))).events.length, 1);

    assert.equal((await api('DELETE', devicePath(mac))).status, 200);
    const list = await json(await api('GET', '/devices'));
    assert.equal(list.items.length, 0);
    assert.equal(list.events.length, 0);
    assert.equal((await agentModels(mac, device.clientId)).code, 10041, '解绑后原设备需要重新输码');

    assert.equal((await api('DELETE', devicePath(mac))).status, 404);
    assert.equal((await api('DELETE', devicePath('not-a-mac'))).status, 404);
  });

  test('身份异常可见、不含哈希指纹,可以清除', async () => {
    const mac = 'aa:bb:cc:dd:ee:18';
    const device = await makePending(mac);
    await api('POST', '/devices/bind', { code: device.code });
    const spoof = newSecret();
    await makePending(mac, spoof);
    await makePending(mac, spoof);

    const events = (await json(await api('GET', '/devices'))).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].mac, mac);
    assert.equal(events[0].kind, 'mismatch');
    assert.equal(events[0].source, 'ota');
    assert.equal(events[0].count, 2);
    assert.equal(events[0].client_fp, undefined);

    assert.equal((await api('DELETE', '/identity-events?mac=bad')).status, 400);
    assert.equal((await api('DELETE', `/identity-events?mac=${encodeURIComponent(mac)}`)).status, 200);
    assert.equal((await json(await api('GET', '/devices'))).events.length, 0);
  });

  test('可以清除单条待绑定记录', async () => {
    await makePending('aa:bb:cc:dd:ee:19');
    const [row] = (await json(await api('GET', '/devices'))).pending;
    assert.equal((await api('DELETE', `/devices/pending/${row.id}`)).status, 200);
    assert.equal((await json(await api('GET', '/devices'))).pending.length, 0);
    assert.equal((await api('DELETE', `/devices/pending/${row.id}`)).status, 404);
  });

  test('连续输错绑定码会被限流,限流期间正确的码也不接受', async () => {
    const device = await makePending('aa:bb:cc:dd:ee:1a');
    const wrong = device.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 10; i++) {
      assert.equal((await api('POST', '/devices/bind', { code: wrong })).status, 404);
    }
    const limited = await api('POST', '/devices/bind', { code: device.code });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('系统参数', () => {
  test('内部参数不出现在设置页', async () => {
    const body = await json(await api('GET', '/settings'));
    const keys = body.items.map((item: any) => item.key);
    assert.ok(keys.includes('server.websocket'), '面向用户的参数要显示');
    assert.ok(!keys.includes('log.log_format'), '日志格式这类内部项不显示');
    assert.ok(!keys.includes('server.secret'), '密钥不进通用列表,那里的值是明文输入框');
    assert.ok(body.secret, '密钥仍单独给出,由专门的打码控件展示');
    assert.ok(!keys.includes('enable_greeting'), '按键说话的设备上开场问候开关没有效果,不展示');
  });

  test('能改值', async () => {
    await api('PUT', '/settings', { 'server.websocket': 'wss://example/xiaozhi/v1/' });
    const body = await json(await api('GET', '/settings'));
    const item = body.items.find((row: any) => row.key === 'server.websocket');
    assert.equal(item.value, 'wss://example/xiaozhi/v1/');
  });

  test('设备连接地址只接受 wss://', async () => {
    // 固件拒收其他形式的地址,填错了设备只会一直停在重试页。
    for (const bad of ['ws://example/xiaozhi/v1/', 'https://example/xiaozhi/v1/', 'example/xiaozhi/v1/']) {
      assert.equal((await api('PUT', '/settings', { 'server.websocket': bad })).status, 400, bad);
    }
    assert.equal((await api('PUT', '/settings', { 'server.websocket': '' })).status, 200, '允许清空');
  });

  test('不能从通用接口改密钥', async () => {
    // 密钥改了必须同步改服务端配置并重启,所以只允许走专门的轮换接口,
    // 免得有人在设置页顺手把它编辑成一个弱值。
    const before = (await json(await api('GET', '/settings'))).secret;
    await api('PUT', '/settings', { 'server.secret': 'hacked' });
    const after = (await json(await api('GET', '/settings'))).secret;
    assert.equal(after, before);
  });

  test('轮换密钥后旧密钥立即失效', async () => {
    const old = (await json(await api('GET', '/settings'))).secret;
    const rotated = await json(await api('POST', '/settings/secret/rotate'));
    assert.notEqual(rotated.secret, old);

    const response = await app.request('http://localhost/xiaozhi/config/server-base', {
      method: 'POST',
      headers: { authorization: `Bearer ${old}` },
    });
    assert.equal(((await response.json()) as { code: number }).code, 401);
  });
});

describe('对话记录', () => {
  test('按会话分组并能读明细', async () => {
    for (const [type, text] of [[1, '你好'], [2, '你好呀']] as const) {
      run(conn, 'INSERT INTO chat_messages (mac, session_id, chat_type, content) VALUES (?,?,?,?)',
        'aa:bb:cc:dd:ee:20', 'sess-1', type, text);
    }
    const list = await json(await api('GET', '/chats'));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].messages, 2);

    const detail = await json(await api('GET', '/chats/sess-1'));
    assert.equal(detail.items.length, 2);
    assert.equal(detail.items[0].content, '你好');
  });
});
