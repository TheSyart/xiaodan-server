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
      `INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Keep', 'TTS', '合成', 'qwen_audio_tts', ?)`,
      JSON.stringify({ type: 'qwen_audio_tts', base_url: 'https://old', api_key: 'k-old', workspace_id: 'ws-old', recv_timeout: 20 }));
    const response = await api('PUT', '/models/TTS_Keep', {
      model_type: 'TTS', name: '合成', provider: 'qwen_audio_tts',
      config: { base_url: 'https://new', api_key: 'k-new', model_name: 'qwen-audio-3.0-tts-flash' },
    });
    assert.equal(response.status, 200);
    const config = JSON.parse(one<{ config_json: string }>(conn, "SELECT config_json FROM models WHERE id = 'TTS_Keep'")!.config_json);
    assert.equal(config.recv_timeout, 20, '目录之外的键要保留');
    assert.equal(config.base_url, 'https://new', '目录字段按提交值更新');
    assert.equal(config.workspace_id, undefined, '目录字段没有提交就是清除');
    assert.equal(config.type, 'qwen_audio_tts');
  });

  test('目录里没有引擎镜像已经去掉的本地识别', async () => {
    const catalog = await json(await api('GET', '/catalog'));
    assert.ok(!catalog.providers.ASR.some((p: any) => p.provider === 'fun_local'));
    const codes = catalog.plugins.map((p: any) => p.code);
    assert.deepEqual(codes.slice(0, 3), ['show_calendar', 'get_weather', 'set_volume'], '自写的三个工具排在最前');
    // 引擎里永远开启的两个,以及不对应任何函数的 get_time,都不应作为开关出现
    for (const code of ['get_time', 'handle_exit_intent', 'get_lunar']) assert.ok(!codes.includes(code), code);
    assert.equal(catalog.plugins.find((p: any) => p.code === 'get_weather').keyless, true, '天气不再需要密钥');
  });

  test('被智能体引用的模型不能删', async () => {
    // 删了会让设备连上来时拿到一份缺模块的配置,那种故障很难定位到这一步。
    const response = await api('DELETE', '/models/VAD_SileroVAD');
    assert.equal(response.status, 409);
  });

  test('模型页只有四类:对话、识别、合成、文生图;语音全走千问,工具调用与视觉不再是模型', async () => {
    const catalog = await json(await api('GET', '/catalog'));
    assert.deepEqual(catalog.modelTypes, ['LLM', 'ASR', 'TTS', 'Image']);
    assert.deepEqual(Object.fromEntries(catalog.modelTypes.map((type: string) => [type, catalog.providers[type].map((p: any) => p.provider)])), {
      LLM: ['openai'], ASR: ['qwen_audio_asr'], TTS: ['qwen_audio_tts'], Image: ['qwen_image'],
    });
    assert.equal(catalog.providers.LLM[0].fields.find((f: any) => f.key === 'vision').type, 'boolean');
    assert.equal(catalog.providers.TTS[0].fields.some((f: any) => f.key === 'voice'), false, '音色在音色页选,不在模型上');
    assert.deepEqual(catalog.providers.TTS[0].fields.find((f: any) => f.key === 'model_name').options.map((o: any) => o.value),
      ['qwen-audio-3.0-tts-flash', 'qwen-audio-3.0-tts-plus']);
    assert.ok(catalog.voice.dialects.includes('四川话'));
    assert.ok(catalog.plugins.every((p: any) => typeof p.group === 'string' && !('runtime' in p)));
  });

  test('下拉只收列出的值,开关存成布尔', async () => {
    let response = await api('POST', '/models', {
      id: 'Image_Bad', model_type: 'Image', name: 'x', provider: 'qwen_image', config: { api_key: 'k', model_name: 'dall-e-3' },
    });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /不能选 dall-e-3/u);

    response = await api('POST', '/models', {
      id: 'Image_Qwen', model_type: 'Image', name: '文生图', provider: 'qwen_image',
      config: { api_key: 'k', model_name: 'wan2.7-image', size: '1280*1280', prompt_extend: 'true' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(one<{ config_json: string }>(conn, "SELECT config_json FROM models WHERE id = 'Image_Qwen'")!.config_json), {
      api_key: 'k', model_name: 'wan2.7-image', size: '1280*1280', prompt_extend: true, type: 'qwen_image',
    });
    await api('POST', '/models', { id: 'LLM_V', model_type: 'LLM', name: 'v', provider: 'openai', config: { vision: 1 } });
    assert.equal(JSON.parse(one<{ config_json: string }>(conn, "SELECT config_json FROM models WHERE id = 'LLM_V'")!.config_json).vision, true);
    assert.equal((await api('POST', '/models', { id: 'Memory_x', model_type: 'Memory', name: 'x', provider: 'nomem', config: {} })).status, 400);
  });

  test('加了千问合成就补齐系统音色、给没音色的智能体绑默认音色;有人在用时不许在 flash 与 plus 之间切换', async () => {
    const tts = (modelName: string) => ({ model_type: 'TTS', name: '千问合成', provider: 'qwen_audio_tts', config: { api_key: 'k', model_name: modelName } });
    assert.equal((await api('POST', '/models', { id: 'TTS_Q', ...tts('qwen-audio-3.0-tts-flash') })).status, 200);
    assert.equal(one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM voices WHERE tts_model_id = 'TTS_Q'")!.n, 12);
    assert.equal(one<{ tts_voice_id: string }>(conn, 'SELECT tts_voice_id FROM agents WHERE id = ?', DEFAULT_AGENT_ID)?.tts_voice_id,
      'TTS_Q__longanhuan_v3.6');

    let response = await api('PUT', '/models/TTS_Q', tts('qwen-audio-3.0-tts-plus'));
    assert.equal(response.status, 409);
    assert.match((await json(response)).error, /flash 与 plus 的音色不能混用/u);
    assert.equal((await api('PUT', '/models/TTS_Q', tts('qwen-audio-3.0-tts-flash'))).status, 200, '同一套里改别的字段照常');
    assert.equal((await api('DELETE', '/models/TTS_Q')).status, 409, '智能体选的音色属于它,就算在用');

    run(conn, 'UPDATE agents SET tts_voice_id = NULL');
    run(conn, "DELETE FROM voices WHERE tts_model_id = 'TTS_Q'");
    assert.equal((await api('PUT', '/models/TTS_Q', tts('qwen-audio-3.0-tts-plus'))).status, 200);
    assert.deepEqual(conn.prepare("SELECT voice FROM voices WHERE tts_model_id = 'TTS_Q' ORDER BY voice").all().map((row: any) => row.voice),
      ['longanlingxin', 'longanlufeng']);
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

  test('音色 id 带点也能保存;引用的模型类型与音色都要对得上', async () => {
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Qwen', 'TTS', 'q', 'qwen_audio_tts', '{}')");
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('LLM_A', 'LLM', 'a', 'openai', '{}')");
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('Image_Q', 'Image', 'i', 'qwen_image', '{}')");
    run(conn, "INSERT INTO voices (id, tts_model_id, name, voice) VALUES ('TTS_Qwen__longpaopao_v3.6', 'TTS_Qwen', '龙泡泡', 'longpaopao_v3.6')");
    const put = (patch: Record<string, unknown>) => api('PUT', `/agents/${DEFAULT_AGENT_ID}`, { name: '小单', ...patch });

    let response = await put({ tts_voice_id: 'TTS_Qwen__longpaopao_v3.6', llm_model_id: 'LLM_A', image_model_id: 'Image_Q', chat_history_conf: 0 });
    assert.equal(response.status, 200, await response.clone().text());
    // 文生图模型不再挂在智能体上(画画工具在工具页选):提交了也不存
    assert.deepEqual({ ...one(conn, 'SELECT tts_voice_id, image_model_id, chat_history_conf FROM agents WHERE id = ?', DEFAULT_AGENT_ID) },
      { tts_voice_id: 'TTS_Qwen__longpaopao_v3.6', image_model_id: null, chat_history_conf: 0 });

    response = await put({ llm_model_id: 'Image_Q' });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /对话模型不存在/u);
    assert.equal((await put({ tts_voice_id: 'nope' })).status, 400);
    assert.equal((await put({ chat_history_conf: 2 })).status, 400, '只分记与不记');

    // 新建的智能体没选音色时用默认音色
    const created = await json(await api('POST', '/agents', { name: '新角色' }));
    assert.deepEqual({ ...one(conn, 'SELECT tts_voice_id, vad_model_id FROM agents WHERE id = ?', created.id) },
      { tts_voice_id: 'TTS_Qwen__longanhuan_v3.6', vad_model_id: 'VAD_SileroVAD' });
  });

  test('工具开关整体覆盖,只收工具代号,拒绝未知工具', async () => {
    const good = await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, ['show_calendar', 'get_weather', 'get_weather']);
    assert.equal(good.status, 200);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM agent_plugins').get<any>()!.n, 2);
    const listed = (await json(await api('GET', '/agents'))).items.find((a: { id: string }) => a.id === DEFAULT_AGENT_ID);
    assert.deepEqual(listed.plugins, ['get_weather', 'show_calendar'], '智能体只记开了哪些,没有设置');
    assert.equal(listed.image_model_id, undefined);

    // 再覆盖成一个
    await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, ['show_calendar']);
    assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM agent_plugins').get<any>()!.n, 1);

    assert.equal((await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, ['rm-rf-slash'])).status, 400);
    // 目录里已移除的旧插件同样按未知处理;老格式(带参数的对象)不再接受
    assert.equal((await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, ['get_time'])).status, 400);
    assert.equal((await api('PUT', `/agents/${DEFAULT_AGENT_ID}/plugins`, [{ plugin_code: 'show_calendar', params: {} }])).status, 400);
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
