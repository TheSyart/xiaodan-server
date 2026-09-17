// 与小智服务端之间的接口契约测试。
//
// 这些用例不是在测"我写的代码符合我写的规格",而是在测"响应形状符合服务端
// 真正会消费的形状"。每条断言都能追溯到服务端的具体代码位置,注释里标了出处。
// 参照样本是从仍在运行的官方 Java 智控台上抓下来的真实响应(密钥已打码)。

import { strict as assert } from 'node:assert';
import { test, beforeEach, describe } from 'node:test';
import { randomBytes } from 'node:crypto';
import { one, openMemoryDb, run, type Db } from '../src/db.ts';
import { seed, SECRET_KEY, DEFAULT_AGENT_ID } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { getSetting } from '../src/settings.ts';
import { hashClientId } from '../src/identity.ts';

/** 测试设备的密钥。真设备第一次开机时用硬件随机数生成,放在 Client-Id 请求头里。 */
const CLIENT_ID = randomBytes(32).toString('hex');
const newSecret = () => randomBytes(32).toString('hex');

let conn: Db;
let app: ReturnType<typeof createApp>;
let secret: string;

beforeEach(() => {
  // 这些接口用 Bearer 而非会话,与鉴权模式无关;显式设一下免得将来默认值变化时漂移。
  process.env.XIAODAN_AUTH_MODE = 'local';
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

/**
 * 引擎取某台设备的配置。它把设备的 Client-Id 请求头原样放进 clientId(connection.py 的 get_private_config)。
 * clientId 传 null 表示请求体里不带这个字段(传 undefined 会落到默认值上)。
 */
function agentModels(mac: string, selectedModule: Record<string, string> = {}, clientId: string | null = CLIENT_ID) {
  return call('/config/agent-models', {
    macAddress: mac,
    ...(clientId === null ? {} : { clientId }),
    selectedModule,
  });
}

/** 配齐一套可用的模型与智能体,模拟真实部署:识别与合成走千问,对话模型是 OpenAI 兼容接口。 */
function seedQwen(): void {
  const models: [string, string, string, Record<string, unknown>][] = [
    ['ASR_Qwen', 'ASR', 'qwen_audio_asr', { type: 'qwen_audio_asr', api_key: 'k-asr', workspace_id: 'ws' }],
    ['LLM_DS', 'LLM', 'openai', { type: 'openai', base_url: 'https://api.deepseek.com', model_name: 'deepseek-chat', api_key: 'k-llm' }],
    ['TTS_Qwen', 'TTS', 'qwen_audio_tts', { type: 'qwen_audio_tts', api_key: 'k-tts', workspace_id: 'ws', model_name: 'qwen-audio-3.0-tts-flash' }],
  ];
  for (const [id, type, provider, config] of models) {
    run(conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      id, type, id, provider, JSON.stringify(config));
  }
  run(conn,
    `INSERT INTO voices (id, tts_model_id, name, voice, languages, language, dialect, volume, rate, pitch, tone_tags, tone_text, emotion_tags)
     VALUES ('voice_kid', 'TTS_Qwen', '泡泡·童童', 'longpaopao_v3.6', '中文、英语', '中文', '四川话', 70, 0.9, 1, '["gentle"]', '带点笑意', '["excited","laughing"]')`);
  run(conn, "UPDATE agents SET asr_model_id = 'ASR_Qwen', llm_model_id = 'LLM_DS', tts_voice_id = 'voice_kid' WHERE id = ?", DEFAULT_AGENT_ID);
}

/** 模拟一台已经用绑定码绑好的设备:库里存的是它密钥的哈希。 */
function bindDevice(mac: string, agentId = DEFAULT_AGENT_ID, clientId = CLIENT_ID): void {
  run(conn, 'INSERT INTO devices (mac, agent_id, alias, secret_hash) VALUES (?, ?, ?, ?)',
    mac, agentId, '测试设备', hashClientId(clientId));
}

describe('鉴权', () => {
  test('密钥不对时返回 code 401,但 HTTP 仍是 200', async () => {
    // 服务端的 _async_request 先 raise_for_status() 再看 code。
    // 如果这里回真的 401,它会当成网络错误重试 6 次、每次间隔 10 秒,
    // 表现为设备连上后长时间毫无反应 —— 所以必须 HTTP 200 + body 里报错。
    const res = await call('/config/server-base', undefined, 'wrong-secret');
    assert.equal(res.status, 200);
    assert.equal(res.json.code, 401);
    // 比较前先取摘要,长度不同的错误密钥走的是同一条路径
    assert.equal((await call('/config/server-base', undefined, 'x')).json.code, 401);
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
      headers: { 'content-type': 'application/json', 'device-id': 'aa:bb:cc:dd:ee:ff', 'client-id': CLIENT_ID },
      body: JSON.stringify({ application: { version: '1.0.0' }, board: { type: 'ai-passport' } }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['status'], 'unbound');
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
    // 退出指令默认为空(说"关闭"会被引擎当成断线指令,见迁移 v3);空串要拆成空数组,不是 [""]
    assert.ok(Array.isArray(data['exit_commands']), 'array 型应拆成数组');
    assert.deepEqual(data['exit_commands'], []);
    assert.deepEqual(data['wakeup_words'], ['你好小单', '小单小单', '你好小智'], '有值的 array 型按分号拆开');
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
    seedQwen();
    const { json } = await call('/config/server-base');
    const data = json.data as Record<string, unknown>;
    assert.equal(data['LLM'], undefined);
    assert.equal(data['TTS'], undefined);
  });
});

describe('agent-models:设备身份', () => {
  // 引擎只认 0、10041、10042。拒绝一律用 10041:引擎念一句不泄露信息的固定提示并丢弃这条连接的消息。

  /** 让设备走一次 OTA,拿到与这个身份对应的绑定码。 */
  async function otaCode(mac: string, clientId = CLIENT_ID): Promise<string> {
    const response = await app.request('http://localhost/xiaozhi/ota/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'device-id': mac, 'client-id': clientId },
      body: '{}',
    });
    return ((await response.json()) as { activation: { code: string } }).activation.code;
  }

  const events = (mac: string) =>
    conn.prepare('SELECT kind, source, count FROM identity_events WHERE mac = ? ORDER BY id').all(mac)
      .map((row) => ({ ...row }));

  test('没走过 OTA 的未知设备返回 10041,且不在这里造码', async () => {
    // 造码只走 OTA 并受限流。这条路径任何能连上 WebSocket 的人都能触发,不能让它往表里写。
    const { json } = await agentModels('aa:bb:cc:dd:ee:01');
    assert.equal(json.code, 10041);
    assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM pending_devices')!.n, 0);
  });

  test('走过 OTA 的未绑定设备返回 10042,msg 正是它屏幕上的码,且不顺延有效期', async () => {
    const mac = 'aa:bb:cc:dd:ee:02';
    const code = await otaCode(mac);
    run(conn, "UPDATE pending_devices SET expires_at = datetime('now', '+1 minute')");
    const before = one<{ expires_at: string }>(conn, 'SELECT expires_at FROM pending_devices')!.expires_at;

    const { json } = await agentModels(mac);
    assert.equal(json.code, 10042);
    assert.match(json.msg, /^\d{6}$/u, 'msg 必须正好是六位数字');
    assert.equal(json.msg, code, '设备念出来的码必须与屏幕上显示的一致');
    assert.equal(one<{ expires_at: string }>(conn, 'SELECT expires_at FROM pending_devices')!.expires_at, before);
  });

  test('同一 MAC 但密钥不同,拿不到别人的码', async () => {
    const mac = 'aa:bb:cc:dd:ee:03';
    await otaCode(mac);
    assert.equal((await agentModels(mac, {}, newSecret())).json.code, 10041);
  });

  test('Client-Id 缺失或是旧固件由 MAC 推出的值时,未知设备返回 10041', async () => {
    assert.equal((await agentModels('aa:bb:cc:dd:ee:04', {}, null)).json.code, 10041);
    assert.equal((await agentModels('aa:bb:cc:dd:ee:04', {}, 'xiaodan-ddee04')).json.code, 10041);
  });

  test('已绑定且密钥相符:下发配置并记下连接时间', async () => {
    bindDevice('aa:bb:cc:dd:ee:05');
    const { json } = await agentModels('aa:bb:cc:dd:ee:05');
    assert.equal(json.code, 0);
    assert.ok(one<{ t: string | null }>(conn, 'SELECT last_connected_at AS t FROM devices')!.t);
  });

  test('已绑定但密钥不符:10041,记为冒充,同一冒充者重复出现只累加次数', async () => {
    const mac = 'aa:bb:cc:dd:ee:06';
    bindDevice(mac);
    const spoof = newSecret();
    const first = await agentModels(mac, {}, spoof);
    await agentModels(mac, {}, spoof);
    assert.equal(first.json.code, 10041);
    assert.equal(first.json.data, null, '冒充者拿不到任何配置');
    assert.deepEqual(events(mac), [{ kind: 'mismatch', source: 'engine', count: 2 }]);
  });

  test('已绑定但没有出示有效密钥:10041,记为缺少身份', async () => {
    const mac = 'aa:bb:cc:dd:ee:07';
    bindDevice(mac);
    assert.equal((await agentModels(mac, {}, null)).json.code, 10041);
    assert.equal((await agentModels(mac, {}, 'xiaodan-ddee07')).json.code, 10041);
    assert.deepEqual(events(mac), [{ kind: 'missing_identity', source: 'engine', count: 2 }]);
  });

  test('升级前绑定、还没有重新配对的旧设备一律 10041', async () => {
    // MAC 是公开的,不能把第一个来要的密钥自动认作这台设备。
    const mac = '4c:11:ae:31:7a:30';
    run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', mac, DEFAULT_AGENT_ID, 'AI Passport');
    assert.equal((await agentModels(mac)).json.code, 10041);
    assert.deepEqual(events(mac), [{ kind: 'legacy_unverified', source: 'engine', count: 1 }]);
  });

  test('大写或连字符形式的 MAC 与库里的规范形式视为同一台', async () => {
    bindDevice('aa:bb:cc:dd:ee:08');
    assert.equal((await agentModels('AA-BB-CC-DD-EE-08')).json.code, 0);
  });
});

describe('agent-models:下发的配置', () => {
  test('已绑定设备拿到完整的模块配置;大脑一律在控制塔', async () => {
    seedQwen();
    bindDevice('aa:bb:cc:dd:ee:10');
    const { json } = await agentModels('aa:bb:cc:dd:ee:10');
    assert.equal(json.code, 0);
    const data = json.data as Record<string, any>;

    // 每个类型都是 { 模型id: 配置 } —— 服务端用 selected_module 的值去这里取。
    assert.equal(data['ASR']['ASR_Qwen']['type'], 'qwen_audio_asr');
    assert.equal(data['TTS']['TTS_Qwen']['type'], 'qwen_audio_tts');
    assert.equal(data['selected_module']['ASR'], 'ASR_Qwen');
    assert.equal(data['selected_module']['TTS'], 'TTS_Qwen');
    assert.equal(data['selected_module']['VAD'], 'VAD_SileroVAD');
    // 对话模型的密钥不下发给引擎:引擎的 LLM 是转发到控制塔的 xiaodan_agent
    assert.deepEqual(Object.keys(data['LLM']), ['LLM_XiaodanAgent']);
    assert.equal(data['selected_module']['LLM'], 'LLM_XiaodanAgent');
    assert.equal(data['selected_module']['Intent'], 'Intent_nointent');
    assert.equal(data['VLLM'], undefined, '视觉模型类型已经没有了');
    assert.equal(data['plugins'], undefined, '工具在控制塔里跑,不下发给引擎');
  });

  test('音色自带的说话设置合进千问合成配置', async () => {
    seedQwen();
    bindDevice('aa:bb:cc:dd:ee:11');
    const { json } = await agentModels('aa:bb:cc:dd:ee:11');
    const tts = (json.data as any)['TTS']['TTS_Qwen'];
    assert.equal(tts['private_voice'], 'longpaopao_v3.6');
    assert.equal(tts['volume'], 70);
    assert.equal(tts['rate'], 0.9);
    assert.equal(tts['pitch'], 1);
    assert.equal(tts['instruction'], '请用四川话表达,语气温柔,带点笑意', '方言、固定语气与补充说明合成语气指令');
    assert.deepEqual(tts['inline_tags'], ['excited', 'laughing']);
    assert.equal(tts['language'], undefined, '合成没有语种参数,不再下发');
  });

  test('音色用不了时退到默认千问合成模型的默认音色', async () => {
    seedQwen();
    bindDevice('aa:bb:cc:dd:ee:1b');
    run(conn, "UPDATE voices SET status = 'pending' WHERE id = 'voice_kid'");
    let tts = (await agentModels('aa:bb:cc:dd:ee:1b')).json.data as any;
    assert.equal(tts['TTS']['TTS_Qwen']['private_voice'], 'longanhuan_v3.6', '审核中的音色不下发');
    assert.equal(tts['TTS']['TTS_Qwen']['instruction'], undefined);

    // plus 模型的音色不能拿去给 flash 合成
    run(conn, "UPDATE voices SET status = 'ok', voice = 'longanlingxin' WHERE id = 'voice_kid'");
    tts = (await agentModels('aa:bb:cc:dd:ee:1b')).json.data as any;
    assert.equal(tts['TTS']['TTS_Qwen']['private_voice'], 'longanhuan_v3.6');
  });

  test('服务端已实例化同一个 VAD/ASR 时不重复下发', async () => {
    // VAD 要加载模型文件,重载代价高。上游用同样的省略策略,服务端那边
    // 的 check_vad_update 也是靠"键在不在"判断要不要重建。
    seedQwen();
    bindDevice('aa:bb:cc:dd:ee:12');
    const { json } = await agentModels('aa:bb:cc:dd:ee:12', { VAD: 'VAD_SileroVAD', ASR: 'ASR_Qwen' });
    const data = json.data as Record<string, unknown>;
    assert.equal(data['VAD'], undefined, '相同的 VAD 应被省略');
    assert.equal(data['ASR'], undefined, '相同的 ASR 应被省略');
    assert.equal((data['selected_module'] as any)['VAD'], undefined, '省略的类型也不应出现在 selected_module');
    assert.ok(data['TTS'], '其余类型照常下发');
  });

  test('服务端持有的是别的模型时照常下发;智能体没选识别模型时用默认的', async () => {
    seedQwen();
    run(conn, 'UPDATE agents SET asr_model_id = NULL WHERE id = ?', DEFAULT_AGENT_ID);
    bindDevice('aa:bb:cc:dd:ee:13');
    const { json } = await agentModels('aa:bb:cc:dd:ee:13', { VAD: 'VAD_SomethingElse', ASR: 'ASR_SomethingElse' });
    const data = json.data as Record<string, any>;
    assert.ok(data['VAD'], '不同的 VAD 必须下发');
    assert.ok(data['ASR']['ASR_Qwen'], '没选时用默认识别模型');
  });

  test('chat_history_conf 是数字,device_max_output_size 是字符串', async () => {
    // 服务端分别用 int(private_config["device_max_output_size"]) 与
    // int(private_config["chat_history_conf"]) 取值,两种都能吃,
    // 但形状要与上游一致,免得将来对比行为时产生困惑。
    bindDevice('aa:bb:cc:dd:ee:15');
    const { json } = await agentModels('aa:bb:cc:dd:ee:15');
    const data = json.data as Record<string, unknown>;
    assert.equal(data['chat_history_conf'], 0, '对话记录由控制塔自己写,引擎不再上报');
    assert.equal(typeof data['device_max_output_size'], 'string');
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
