// 与小智服务端之间的接口契约测试。
//
// 这些用例不是在测"我写的代码符合我写的规格",而是在测"响应形状符合服务端
// 真正会消费的形状"。每条断言都能追溯到服务端的具体代码位置,注释里标了出处。
// 参照样本是从仍在运行的官方 Java 智控台上抓下来的真实响应(密钥已打码)。

import { strict as assert } from 'node:assert';
import { test, beforeEach, describe } from 'node:test';
import { openMemoryDb, run, type Db } from '../src/db.ts';
import { seed, SECRET_KEY, DEFAULT_AGENT_ID } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { getSetting } from '../src/settings.ts';

let conn: Db;
let app: ReturnType<typeof createApp>;
let secret: string;

beforeEach(() => {
  conn = openMemoryDb();
  seed(conn);
  app = createApp(conn);
  secret = getSetting(conn, SECRET_KEY)!;
});

/** 照着服务端 manage_api_client.py 的调用方式发请求。 */
async function call(path: string, body?: unknown, token = secret) {
  const response = await app.request(`http://localhost/xiaozhi${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'PythonClient/2.0 (PID:1)',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as { code: number; msg: string; data: unknown } };
}

/** 配齐一套可用的模型与智能体,模拟真实部署。 */
function seedGateway(): void {
  const models: [string, string, string, Record<string, unknown>][] = [
    ['ASR_Gateway', 'ASR', 'gateway_chat',
      { type: 'gateway_chat', base_url: 'https://gw.example/v1', model_name: 'asr-x', api_key: 'k-asr' }],
    ['LLM_Gateway', 'LLM', 'openai',
      { type: 'openai', base_url: 'https://gw.example/v1', model_name: 'llm-x', api_key: 'k-llm', max_tokens: 1200 }],
    ['TTS_Gateway', 'TTS', 'gateway_omni_tts',
      { type: 'gateway_omni_tts', base_url: 'https://gw.example/v1', model_name: 'tts-x', api_key: 'k-tts', voice: 'Ethan' }],
  ];
  for (const [id, type, provider, config] of models) {
    run(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      id, type, id, provider, JSON.stringify(config));
  }
  run(conn, 'INSERT INTO voices (id, tts_model_id, name, voice, languages) VALUES (?,?,?,?,?)',
    'voice_ethan', 'TTS_Gateway', 'Ethan', 'Ethan', '中文、粤语');
  run(conn,
    `UPDATE agents SET asr_model_id = 'ASR_Gateway', llm_model_id = 'LLM_Gateway',
                       tts_model_id = 'TTS_Gateway', tts_voice_id = 'voice_ethan'
     WHERE id = ?`, DEFAULT_AGENT_ID);
}

function bindDevice(mac: string, agentId = DEFAULT_AGENT_ID): void {
  run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', mac, agentId, '测试设备');
}

describe('鉴权', () => {
  test('密钥不对时返回 code 401,但 HTTP 仍是 200', async () => {
    // 服务端的 _async_request 先 raise_for_status() 再看 code。
    // 如果这里回真的 401,它会当成网络错误重试 6 次、每次间隔 10 秒,
    // 表现为设备连上后长时间毫无反应 —— 所以必须 HTTP 200 + body 里报错。
    const res = await call('/config/server-base', undefined, 'wrong-secret');
    assert.equal(res.status, 200);
    assert.equal(res.json.code, 401);
  });

  test('没有 Authorization 头也一样', async () => {
    const response = await app.request('http://localhost/xiaozhi/config/server-base', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { code: number }).code, 401);
  });

  test('OTA 接口不受 Bearer 保护', async () => {
    // 设备调 OTA 时没有也不可能有密钥。若 manager-api 的鉴权中间件用了通配
    // 前缀,就会把这里一起拦掉 —— 这个用例专门盯住那个错误。
    const response = await app.request('http://localhost/xiaozhi/ota/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'device-id': 'aa:bb:cc:dd:ee:ff' },
      body: JSON.stringify({ application: { version: '1.0.0' }, board: { type: 'ai-passport' } }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.ok(body['server_time'], '应返回 server_time');
  });
});

describe('server-base:服务端启动时拉的基础配置', () => {
  test('点号键被展开成嵌套对象', async () => {
    // 服务端读的是 config["server"]["auth"]["enabled"]、config["log"]["log_level"]。
    // 参数表里存的是扁平的 server.auth.enabled,必须在这里展开。
    const { json } = await call('/config/server-base');
    assert.equal(json.code, 0);
    const data = json.data as Record<string, any>;
    assert.equal(typeof data['server'], 'object');
    assert.equal(data['server']['auth']['enabled'], false);
    assert.equal(data['log']['log_level'], 'INFO');
  });

  test('各类型按 value_type 还原,不是一律字符串', async () => {
    const { json } = await call('/config/server-base');
    const data = json.data as Record<string, any>;
    assert.equal(typeof data['delete_audio'], 'boolean', 'boolean 型');
    assert.equal(typeof data['tts_timeout'], 'number', 'number 型');
    assert.ok(Array.isArray(data['exit_commands']), 'array 型应拆成数组');
    assert.deepEqual(data['exit_commands'], ['退出', '关闭']);
    assert.equal(typeof data['xiaozhi'], 'object', 'json 型应解析成对象');
    assert.equal(data['xiaozhi']['type'], 'hello');
  });

  test('prompt 与 summaryMemory 必须存在且为 null', async () => {
    // 服务端用 config.get("prompt") 判断要不要初始化提示词;缺键与 null
    // 在 Python 里都会走到同一分支,但上游显式给 null,照做以免形状漂移。
    const { json } = await call('/config/server-base');
    const data = json.data as Record<string, unknown>;
    assert.ok('prompt' in data);
    assert.equal(data['prompt'], null);
    assert.ok('summaryMemory' in data);
    assert.equal(data['summaryMemory'], null);
  });

  test('带上默认智能体的 VAD 与 selected_module', async () => {
    // 服务端在没有设备上下文时也要能实例化 VAD,所以这一份必须有。
    const { json } = await call('/config/server-base');
    const data = json.data as Record<string, any>;
    assert.ok(data['VAD'], '应下发 VAD 段');
    assert.ok(data['VAD']['VAD_SileroVAD'], 'VAD 段的键是模型 id');
    assert.equal(data['VAD']['VAD_SileroVAD']['type'], 'silero');
    assert.equal(data['selected_module']['VAD'], 'VAD_SileroVAD');
  });

  test('不下发带密钥的 LLM/TTS —— 那些要按设备区分', async () => {
    seedGateway();
    const { json } = await call('/config/server-base');
    const data = json.data as Record<string, unknown>;
    assert.equal(data['LLM'], undefined);
    assert.equal(data['TTS'], undefined);
  });
});

describe('agent-models:设备连上来时拉的差异化配置', () => {
  test('未知设备返回 10042,msg 是六位绑定码', async () => {
    // 这是与官方智控台最重要的行为差异。官方只在设备调过 OTA 后才有绑定码,
    // 没有时返回 10041;而我们的固件从不调 OTA,于是在官方那边永远绑不上,
    // 设备只会一遍遍念"请正确配置 OTA 地址"。这里改成就地生成。
    const { json } = await call('/config/agent-models',
      { macAddress: 'aa:bb:cc:dd:ee:01', clientId: 'c1', selectedModule: {} });
    assert.equal(json.code, 10042);
    assert.match(json.msg, /^\d{6}$/u, 'msg 必须正好是六位数字');
  });

  test('同一台设备重复来问,拿到的是同一个码', async () => {
    // 否则用户在页面上看到的码和设备刚念过的对不上。
    const first = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:02', selectedModule: {} });
    const second = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:02', selectedModule: {} });
    assert.equal(first.json.msg, second.json.msg);
  });

  test('不同设备拿到不同的码', async () => {
    const a = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:03', selectedModule: {} });
    const b = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:04', selectedModule: {} });
    assert.notEqual(a.json.msg, b.json.msg);
  });

  test('已绑定设备拿到完整的模块配置', async () => {
    seedGateway();
    bindDevice('aa:bb:cc:dd:ee:10');
    const { json } = await call('/config/agent-models',
      { macAddress: 'aa:bb:cc:dd:ee:10', clientId: 'c1', selectedModule: {} });
    assert.equal(json.code, 0);
    const data = json.data as Record<string, any>;

    // 每个类型都是 { 模型id: 配置 } —— 服务端用 selected_module 的值去这里取。
    assert.equal(data['LLM']['LLM_Gateway']['api_key'], 'k-llm');
    assert.equal(data['ASR']['ASR_Gateway']['type'], 'gateway_chat');
    assert.equal(data['TTS']['TTS_Gateway']['type'], 'gateway_omni_tts');
    assert.equal(data['selected_module']['LLM'], 'LLM_Gateway');
    assert.equal(data['selected_module']['ASR'], 'ASR_Gateway');
    assert.equal(data['selected_module']['TTS'], 'TTS_Gateway');
  });

  test('智能体选的音色写进 TTS 配置的 private_voice', async () => {
    // 服务端的 TTS provider 一律优先读 private_voice,读不到才回落 voice。
    seedGateway();
    bindDevice('aa:bb:cc:dd:ee:11');
    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:11', selectedModule: {} });
    const tts = (json.data as any)['TTS']['TTS_Gateway'];
    assert.equal(tts['private_voice'], 'Ethan');
    assert.equal(tts['language'], '中文', '语言取音色支持列表的第一个');
  });

  test('服务端已实例化同一个 VAD/ASR 时不重复下发', async () => {
    // VAD 要加载模型文件,重载代价高。上游用同样的省略策略,服务端那边
    // 的 check_vad_update 也是靠"键在不在"判断要不要重建。
    seedGateway();
    bindDevice('aa:bb:cc:dd:ee:12');
    const { json } = await call('/config/agent-models', {
      macAddress: 'aa:bb:cc:dd:ee:12',
      selectedModule: { VAD: 'VAD_SileroVAD', ASR: 'ASR_Gateway' },
    });
    const data = json.data as Record<string, unknown>;
    assert.equal(data['VAD'], undefined, '相同的 VAD 应被省略');
    assert.equal(data['ASR'], undefined, '相同的 ASR 应被省略');
    assert.equal((data['selected_module'] as any)['VAD'], undefined, '省略的类型也不应出现在 selected_module');
    assert.ok(data['LLM'], '其余类型照常下发');
  });

  test('服务端持有的是别的模型时照常下发', async () => {
    seedGateway();
    bindDevice('aa:bb:cc:dd:ee:13');
    const { json } = await call('/config/agent-models', {
      macAddress: 'aa:bb:cc:dd:ee:13',
      selectedModule: { VAD: 'VAD_SomethingElse', ASR: 'ASR_SomethingElse' },
    });
    const data = json.data as Record<string, any>;
    assert.ok(data['VAD'], '不同的 VAD 必须下发');
    assert.ok(data['ASR'], '不同的 ASR 必须下发');
  });

  test('人设里的 {{assistant_name}} 被替换成智能体名', async () => {
    run(conn, 'UPDATE agents SET system_prompt = ?, name = ? WHERE id = ?',
      '你叫{{assistant_name}},是一个助手。', '小单', DEFAULT_AGENT_ID);
    bindDevice('aa:bb:cc:dd:ee:14');
    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:14', selectedModule: {} });
    assert.equal((json.data as any)['prompt'], '你叫小单,是一个助手。');
  });

  test('chat_history_conf 是数字,device_max_output_size 是字符串', async () => {
    // 服务端分别用 int(private_config["device_max_output_size"]) 与
    // int(private_config["chat_history_conf"]) 取值,两种都能吃,
    // 但形状要与上游一致,免得将来对比行为时产生困惑。
    bindDevice('aa:bb:cc:dd:ee:15');
    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:15', selectedModule: {} });
    const data = json.data as Record<string, unknown>;
    assert.equal(typeof data['chat_history_conf'], 'number');
    assert.equal(typeof data['device_max_output_size'], 'string');
  });

  test('nointent 模式下不下发插件', async () => {
    // 服务端会把 plugins 的键展开成可调函数列表。在 nointent 模式下送过去,
    // 它会注册出一堆根本调不动的工具。
    bindDevice('aa:bb:cc:dd:ee:16');
    run(conn, 'INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?,?,?)',
      DEFAULT_AGENT_ID, 'get_time', '{}');
    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:16', selectedModule: {} });
    assert.equal((json.data as any)['plugins'], undefined);
  });

  test('function_call 模式下插件值是 JSON 字符串而不是对象', async () => {
    // 服务端拿到后会自己 json.loads 一次(connection.py 的
    // `plugin_from_server[plugin] = json.loads(config_str)`)。
    // 如果这里直接给对象,那句会抛 TypeError,插件全部加载失败。
    run(conn, 'UPDATE agents SET intent_model_id = ? WHERE id = ?', 'Intent_function_call', DEFAULT_AGENT_ID);
    bindDevice('aa:bb:cc:dd:ee:17');
    run(conn, 'INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?,?,?)',
      DEFAULT_AGENT_ID, 'get_weather', '{"api_key":"w-key","default_location":"广州"}');

    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:17', selectedModule: {} });
    const plugins = (json.data as any)['plugins'];
    assert.ok(plugins, '应下发 plugins');
    assert.equal(typeof plugins['get_weather'], 'string', '值必须是字符串');
    assert.deepEqual(JSON.parse(plugins['get_weather']), { api_key: 'w-key', default_location: '广州' });
  });

  test('Intent 的 functions 由分号串拆成数组', async () => {
    run(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
       VALUES ('Intent_fc2', 'Intent', 'fc', 'function_call', ?, 0, 1)`,
      JSON.stringify({ type: 'function_call', functions: 'get_time;get_weather;web_search' }));
    run(conn, 'UPDATE agents SET intent_model_id = ? WHERE id = ?', 'Intent_fc2', DEFAULT_AGENT_ID);
    bindDevice('aa:bb:cc:dd:ee:18');

    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:18', selectedModule: {} });
    const intent = (json.data as any)['Intent']['Intent_fc2'];
    assert.deepEqual(intent['functions'], ['get_time', 'get_weather', 'web_search']);
  });

  test('意图模型挂的辅助 LLM 会一并下发,且不覆盖主 LLM', async () => {
    // 服务端按 id 去 config["LLM"] 里找这个辅助模型。找不到就静默回落到主 LLM,
    // 行为不对却不报错 —— 正是这种问题最难查。
    seedGateway();
    run(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
       VALUES ('LLM_Small', 'LLM', '小模型', 'openai', ?, 0, 1)`,
      JSON.stringify({ type: 'openai', base_url: 'https://gw.example/v1', model_name: 'small', api_key: 'k-small' }));
    run(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
       VALUES ('Intent_llm', 'Intent', '意图', 'intent_llm', ?, 0, 1)`,
      JSON.stringify({ type: 'intent_llm', llm: 'LLM_Small' }));
    run(conn, 'UPDATE agents SET intent_model_id = ? WHERE id = ?', 'Intent_llm', DEFAULT_AGENT_ID);
    bindDevice('aa:bb:cc:dd:ee:19');

    const { json } = await call('/config/agent-models', { macAddress: 'aa:bb:cc:dd:ee:19', selectedModule: {} });
    const llm = (json.data as any)['LLM'];
    assert.ok(llm['LLM_Small'], '辅助模型必须在 LLM 段里');
    assert.ok(llm['LLM_Gateway'], '主模型不能被覆盖掉');
    assert.equal((json.data as any)['selected_module']['LLM'], 'LLM_Gateway', '选中的仍是主模型');
  });

  test('缺少 macAddress 时不崩,返回 10041', async () => {
    const { json } = await call('/config/agent-models', { selectedModule: {} });
    assert.equal(json.code, 10041);
  });
});

describe('correct-words', () => {
  test('返回 "原词|目标词" 的字符串数组', async () => {
    bindDevice('aa:bb:cc:dd:ee:20');
    run(conn, 'INSERT INTO correct_words (agent_id, source, target) VALUES (?,?,?)',
      DEFAULT_AGENT_ID, '小蛋', '小单');
    const { json } = await call('/config/correct-words', { macAddress: 'aa:bb:cc:dd:ee:20' });
    assert.equal(json.code, 0);
    assert.deepEqual(json.data, ['小蛋|小单']);
  });

  test('未知设备返回空数组而不是报错', async () => {
    // 服务端对这个接口的失败是吞掉的,但返回 null 会让它那边多一次判空。
    const { json } = await call('/config/correct-words', { macAddress: 'ff:ff:ff:ff:ff:ff' });
    assert.deepEqual(json.data, []);
  });
});

describe('对话记录上报', () => {
  test('正常上报入库并返回 true', async () => {
    const { json } = await call('/agent/chat-history/report', {
      macAddress: 'aa:bb:cc:dd:ee:30', sessionId: 's-1', chatType: 1,
      content: '今天天气怎么样', audioBase64: null, reportTime: 1757700000,
    });
    assert.equal(json.code, 0);
    assert.equal(json.data, true);
    const rows = conn.prepare('SELECT mac, session_id, chat_type, content FROM chat_messages').all();
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).content, '今天天气怎么样');
  });

  test('携带的音频不入库', async () => {
    // 一句话约 100KB。我们不做音频回放,存下来只会让数据目录无限膨胀,
    // 而运维面板每次发布都要打包这个目录。
    await call('/agent/chat-history/report', {
      macAddress: 'aa:bb:cc:dd:ee:31', sessionId: 's-2', chatType: 2,
      content: '今天多云', audioBase64: 'A'.repeat(10_000),
    });
    const columns = conn.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[];
    assert.ok(!columns.some((col) => col.name.includes('audio')), '表里就不该有音频列');
  });

  test('字段不全时返回 false 而不是抛异常', async () => {
    const { json } = await call('/agent/chat-history/report', { macAddress: 'aa:bb:cc:dd:ee:32' });
    assert.equal(json.code, 0);
    assert.equal(json.data, false);
  });
});

describe('可选接口', () => {
  test('会话摘要与标题返回成功', async () => {
    // 服务端在连接结束时调用,失败只打日志。返回成功即可,不做自动摘要
    // (那要再花一次 LLM 调用,而设备上看不到摘要)。
    for (const path of ['/agent/chat-summary/s-1/save', '/agent/chat-title/s-1/generate']) {
      const { json } = await call(path);
      assert.equal(json.code, 0, `${path} 应返回成功`);
    }
  });

  test('通讯录查询返回 null', async () => {
    const response = await app.request('http://localhost/xiaozhi/device/address-book/lookup?callerMac=x&nickname=y', {
      headers: { authorization: `Bearer ${secret}` },
    });
    const json = (await response.json()) as { code: number; data: unknown };
    assert.equal(json.code, 0);
    assert.equal(json.data, null);
  });
});

describe('健康检查', () => {
  test('无需鉴权即可访问', async () => {
    const response = await app.request('http://localhost/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});
