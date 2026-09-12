// 管理接口测试:登录、权限边界、各资源的增删改,以及几条"不允许做"的规则。

import { strict as assert } from 'node:assert';
import { test, beforeEach, describe } from 'node:test';
import { openMemoryDb, one, run, type Db } from '../src/db.ts';
import { seed, DEFAULT_AGENT_ID } from '../src/seed.ts';
import { createApp } from '../src/app.ts';

let conn: Db;
let app: ReturnType<typeof createApp>;
let cookie = '';

const USER = 'admin';
const PASS = 'correct-horse-battery';

beforeEach(async () => {
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
  /** 让一台设备进入待绑定状态:模拟它连了一次服务端。 */
  async function makePending(mac: string): Promise<string> {
    const response = await app.request('http://localhost/xiaozhi/config/agent-models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${one<{ value: string }>(conn, "SELECT value FROM settings WHERE key='server.secret'")!.value}`,
      },
      body: JSON.stringify({ macAddress: mac, selectedModule: {} }),
    });
    return ((await response.json()) as { msg: string }).msg;
  }

  test('待绑定列表能看到设备与它的码', async () => {
    // 这正是自建控制台的意义:官方那边要用户去听设备把六位数字念出来。
    const code = await makePending('aa:bb:cc:dd:ee:10');
    const list = await json(await api('GET', '/devices'));
    assert.equal(list.pending.length, 1);
    assert.equal(list.pending[0].mac, 'aa:bb:cc:dd:ee:10');
    assert.equal(list.pending[0].code, code);
  });

  test('用绑定码绑定', async () => {
    const code = await makePending('aa:bb:cc:dd:ee:11');
    const response = await api('POST', '/devices/bind', { code, agent_id: DEFAULT_AGENT_ID, alias: '客厅' });
    assert.equal(response.status, 200);
    const list = await json(await api('GET', '/devices'));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].alias, '客厅');
    assert.equal(list.pending.length, 0, '绑定后应从待绑定列表移除');
  });

  test('直接用 MAC 绑定,不必输码', async () => {
    await makePending('aa:bb:cc:dd:ee:12');
    const response = await api('POST', '/devices/bind', { mac: 'aa:bb:cc:dd:ee:12', agent_id: DEFAULT_AGENT_ID });
    assert.equal(response.status, 200);
  });

  test('错误的码返回 404', async () => {
    await makePending('aa:bb:cc:dd:ee:13');
    const response = await api('POST', '/devices/bind', { code: '000000', agent_id: DEFAULT_AGENT_ID });
    assert.equal(response.status, 404);
  });

  test('绑到不存在的智能体上会被拒绝', async () => {
    const code = await makePending('aa:bb:cc:dd:ee:14');
    const response = await api('POST', '/devices/bind', { code, agent_id: 'agent_nope' });
    assert.equal(response.status, 400);
  });

  test('同一台设备不能绑两次', async () => {
    const code = await makePending('aa:bb:cc:dd:ee:15');
    await api('POST', '/devices/bind', { code, agent_id: DEFAULT_AGENT_ID });
    const again = await api('POST', '/devices/bind', { mac: 'aa:bb:cc:dd:ee:15', agent_id: DEFAULT_AGENT_ID });
    assert.notEqual(again.status, 200);
  });

  test('绑定后设备取配置就能拿到完整内容', async () => {
    const code = await makePending('aa:bb:cc:dd:ee:16');
    await api('POST', '/devices/bind', { code, agent_id: DEFAULT_AGENT_ID });
    const secret = one<{ value: string }>(conn, "SELECT value FROM settings WHERE key='server.secret'")!.value;
    const response = await app.request('http://localhost/xiaozhi/config/agent-models', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ macAddress: 'aa:bb:cc:dd:ee:16', selectedModule: {} }),
    });
    const body = await json(response);
    assert.equal(body.code, 0, '绑定之后不应再返回 10042');
    assert.ok(body.data.prompt, '应带上人设');
  });
});

describe('系统参数', () => {
  test('内部参数不出现在设置页', async () => {
    const body = await json(await api('GET', '/settings'));
    const keys = body.items.map((item: any) => item.key);
    assert.ok(keys.includes('server.websocket'), '面向用户的参数要显示');
    assert.ok(!keys.includes('log.log_format'), '日志格式这类内部项不显示');
  });

  test('能改值', async () => {
    await api('PUT', '/settings', { 'server.websocket': 'wss://example/xiaozhi/v1/' });
    const body = await json(await api('GET', '/settings'));
    const item = body.items.find((row: any) => row.key === 'server.websocket');
    assert.equal(item.value, 'wss://example/xiaozhi/v1/');
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
