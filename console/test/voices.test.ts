// 音色定制:系统音色导入、试听、声音设计、声音复刻(两条样本通道)、状态刷新、删除,
// 以及智能体的合成参数与审核状态如何进到下发给引擎的配置里。百炼接口全部用假的 fetch 代替。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb, one, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, SECRET_KEY, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { hashClientId } from '../src/identity.ts';
import { clampInstruction, httpBase, mapVoiceStatus, voicePrefix } from '../src/voice/dashscope.ts';
import { sampleUrl } from '../src/voice/samples.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let conn: Db;
let app: ReturnType<typeof createApp>;
let calls: Call[];
let dataDir: string;
/** 每个测试可替换的假百炼 */
let handler: (call: Call) => Response | Promise<Response>;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40_000, 1)]);

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  let body: unknown = init.body;
  if (typeof init.body === 'string') body = JSON.parse(init.body);
  const call = { url: input, method: init.method ?? 'GET', headers, body };
  calls.push(call);
  return handler(call);
}

beforeEach(() => {
  process.env.XIAODAN_AUTH_MODE = 'proxy';
  conn = openMemoryDb();
  seed(conn);
  calls = [];
  dataDir = mkdtempSync(join(tmpdir(), 'xiaodan-voices-'));
  app = createApp(conn, { admin: { fetch: fakeFetch, dataDir: () => dataDir } });
  run(
    conn,
    "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Qwen', 'TTS', '千问', 'qwen_audio_tts', ?)",
    JSON.stringify({ type: 'qwen_audio_tts', api_key: 'sk-test', workspace_id: 'ws-1', model_name: 'qwen-audio-3.0-tts-flash' }),
  );
  run(
    conn,
    "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Edge', 'TTS', 'Edge', 'edge', '{\"type\":\"edge\"}')",
  );
  handler = () => jsonResponse({ code: 'Unexpected', message: '测试没有设置假百炼' }, 500);
});

const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`http://localhost/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });

describe('纯函数', () => {
  test('地址、前缀、状态映射与语气指令截断', () => {
    assert.equal(httpBase({ workspace_id: 'ws-1' }), 'https://ws-1.cn-beijing.maas.aliyuncs.com');
    assert.equal(httpBase({ base_url: 'https://dashscope.aliyuncs.com/api/v1/' }), 'https://dashscope.aliyuncs.com');
    assert.throws(() => httpBase({ workspace_id: 'evil.com/x' }), /业务空间/u);
    assert.equal(voicePrefix('my voice!!_2026'), 'myvoice202');
    assert.match(voicePrefix(''), /^xd[0-9a-z]+$/u);
    assert.equal(mapVoiceStatus('OK'), 'ok');
    assert.equal(mapVoiceStatus('DEPLOYING'), 'pending');
    assert.equal(mapVoiceStatus('UNDEPLOYED'), 'failed');
    assert.equal(clampInstruction('中'.repeat(60)), '中'.repeat(50));
    assert.equal(sampleUrl('https://a.example/xiaozhi/ota/', 'tok', 'wav'), 'https://a.example/xiaozhi/ota/voice-sample/tok.wav');
    assert.equal(sampleUrl('https://a.example/xiaozhi/ota', 'tok', 'wav'), 'https://a.example/xiaozhi/ota/voice-sample/tok.wav');
    assert.equal(sampleUrl('http://a.example/xiaozhi/ota/', 'tok', 'wav'), null, '百炼只该拿到 https 链接');
  });
});

describe('系统音色', () => {
  test('一键导入千问的 12 个系统音色,重复导入不重复加', async () => {
    let response = await api('POST', '/voices/import-system', { tts_model_id: 'TTS_Qwen' });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { added: number }).added, 12);
    response = await api('POST', '/voices/import-system', { tts_model_id: 'TTS_Qwen' });
    assert.equal(((await response.json()) as { added: number }).added, 0);
    const child = one<{ kind: string; status: string; tags: string }>(
      conn, "SELECT kind, status, tags FROM voices WHERE voice = 'longpaopao_v3.6'",
    );
    assert.deepEqual({ ...child }, { kind: 'system', status: 'ok', tags: '儿童' });
  });

  test('非千问合成模型不能导入', async () => {
    const response = await api('POST', '/voices/import-system', { tts_model_id: 'TTS_Edge' });
    assert.equal(response.status, 400);
  });

  test('手动添加与改名', async () => {
    let response = await api('POST', '/voices', { id: 'v.base', tts_model_id: 'TTS_Qwen', name: '基础', voice: 'qwen-audio-3.0-tts-flash-longyaoxuanke' });
    assert.equal(response.status, 200);
    response = await api('PUT', '/voices/v.base', { name: '瑶瑶', description: '女孩 · 7 岁', tags: '儿童' });
    assert.equal(response.status, 200);
    assert.equal(one<{ name: string }>(conn, "SELECT name FROM voices WHERE id = 'v.base'")?.name, '瑶瑶');
  });
});

describe('试听', () => {
  test('合成后下载音频交给浏览器,并带上语气与语速', async () => {
    handler = (call) => {
      if (call.url.endsWith('/api/v1/services/audio/tts/SpeechSynthesizer')) {
        return jsonResponse({ output: { audio: { url: 'https://oss.example/a.wav' } } });
      }
      if (call.url === 'https://oss.example/a.wav') return new Response(WAV, { headers: { 'content-type': 'audio/wav' } });
      return jsonResponse({}, 404);
    };
    const response = await api('POST', '/voices/preview', {
      tts_model_id: 'TTS_Qwen', voice: 'longanhuan_v3.6', text: '你好', rate: 1.2, instruction: '温柔一点',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await response.arrayBuffer()).length, WAV.length);
    const synth = calls[0]!;
    assert.equal(synth.url, 'https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
    assert.equal(synth.headers['authorization'], 'Bearer sk-test');
    assert.equal(synth.headers['x-dashscope-workspace'], 'ws-1');
    const input = (synth.body as { model: string; input: Record<string, unknown> });
    assert.equal(input.model, 'qwen-audio-3.0-tts-flash');
    assert.deepEqual(input.input, {
      text: '你好', voice: 'longanhuan_v3.6', format: 'wav', sample_rate: 24000, volume: 50, rate: 1.2, pitch: 1, instruction: '温柔一点',
    });
  });

  test('百炼报错原样提示,不是 500', async () => {
    handler = () => jsonResponse({ code: 'InvalidParameter', message: 'voice not found' }, 400);
    // 限流窗口是 400 毫秒,上一个测试刚点过
    await new Promise((resolve) => setTimeout(resolve, 450));
    const response = await api('POST', '/voices/preview', { tts_model_id: 'TTS_Qwen', voice: 'nope' });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /InvalidParameter/u);
  });
});

describe('声音设计', () => {
  test('创建后记为待审核并返回试听,刷新后变为可用', async () => {
    let status = 'DEPLOYING';
    handler = (call) => {
      const body = call.body as { model: string; input: Record<string, unknown>; parameters?: unknown };
      assert.equal(body.model, 'voice-enrollment');
      if (body.input['action'] === 'create_voice') {
        return jsonResponse({ output: { voice_id: 'qwen-audio-3.0-tts-flash-vd-story-abc123', preview_audio: { data: WAV.toString('base64') } } });
      }
      if (body.input['action'] === 'query_voice') return jsonResponse({ output: { status } });
      return jsonResponse({}, 404);
    };
    let response = await api('POST', '/voices/design', {
      tts_model_id: 'TTS_Qwen', name: '讲故事的姐姐', prompt: '温柔的年轻女声,语速稍慢,适合给孩子讲睡前故事',
      preview_text: '从前有一只小兔子,它最喜欢在月光下散步。', prefix: 'story',
    });
    assert.equal(response.status, 200);
    const created = (await response.json()) as { id: string; status: string; preview: string };
    assert.equal(created.status, 'pending');
    assert.ok(created.preview.length > 100);
    const create = calls[0]!.body as { input: Record<string, unknown>; parameters: Record<string, unknown> };
    assert.equal(create.input['target_model'], 'qwen-audio-3.0-tts-flash');
    assert.equal(create.input['prefix'], 'story');
    assert.deepEqual(create.parameters, { sample_rate: 24000, response_format: 'wav' });

    status = 'OK';
    response = await api('POST', `/voices/${created.id}/refresh`);
    assert.equal(((await response.json()) as { status: string }).status, 'ok');
    assert.equal(one<{ status: string }>(conn, 'SELECT status FROM voices WHERE id = ?', created.id)?.status, 'ok');
  });

  test('参数不合规时直接拒绝,不打百炼', async () => {
    const response = await api('POST', '/voices/design', { tts_model_id: 'TTS_Qwen', name: 'x', prompt: '温柔', preview_text: '太短' });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe('声音复刻', () => {
  const clone = (query: string, body: Uint8Array = WAV, type = 'audio/wav') =>
    app.request(`http://localhost/api/voices/clone?${query}`, { method: 'POST', headers: { 'content-type': type }, body });

  test('没勾选授权确认就拒绝', async () => {
    const response = await clone('tts_model_id=TTS_Qwen&name=%E7%88%B8%E7%88%B8');
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /有权使用/u);
  });

  test('格式与长度校验', async () => {
    assert.equal((await clone('tts_model_id=TTS_Qwen&name=a&consent=1', WAV, 'video/mp4')).status, 415);
    assert.equal((await clone('tts_model_id=TTS_Qwen&name=a&consent=1', new Uint8Array(100))).status, 400);
  });

  test('优先走百炼临时上传,复刻请求带 oss 解析头', async () => {
    handler = async (call) => {
      if (call.url.includes('/api/v1/uploads?action=getPolicy')) {
        return jsonResponse({ data: {
          policy: 'p', signature: 's', upload_dir: 'dashscope-instant/abc', upload_host: 'https://upload.example',
          oss_access_key_id: 'ak', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
        } });
      }
      if (call.url === 'https://upload.example') {
        const form = call.body as FormData;
        assert.equal(form.get('OSSAccessKeyId'), 'ak');
        assert.match(String(form.get('key')), /^dashscope-instant\/abc\/.+\.wav$/u);
        assert.equal(((form.get('file') as File).size), WAV.length);
        return new Response('', { status: 200 });
      }
      const body = call.body as { input: Record<string, unknown> };
      if (body.input['action'] === 'create_voice') {
        assert.match(String(body.input['url']), /^oss:\/\/dashscope-instant\/abc\//u);
        assert.equal(call.headers['x-dashscope-ossresourceresolve'], 'enable');
        return jsonResponse({ output: { voice_id: 'qwen-audio-3.0-tts-flash-dad-001' } });
      }
      if (body.input['action'] === 'query_voice') return jsonResponse({ output: { status: 'OK' } });
      return jsonResponse({}, 404);
    };
    const response = await clone('tts_model_id=TTS_Qwen&name=%E7%88%B8%E7%88%B8&prefix=dad&consent=1');
    assert.equal(response.status, 200);
    const created = (await response.json()) as { id: string; status: string; via: string };
    assert.deepEqual({ status: created.status, via: created.via }, { status: 'ok', via: 'oss' });
    const row = one<{ kind: string; sample_file: string }>(conn, 'SELECT kind, sample_file FROM voices WHERE id = ?', created.id);
    assert.equal(row?.kind, 'clone');
    assert.ok(existsSync(join(dataDir, 'voice-samples', row!.sample_file)), '样本要留在数据目录里,便于以后重新复刻');
  });

  test('百炼不认 oss 地址时退回一次性公网链接,链接在 OTA 前缀下、能取到样本', async () => {
    run(conn, "UPDATE settings SET value = 'https://agent.example/xiaozhi/ota/' WHERE key = 'server.ota'");
    let fetchedSample = false;
    handler = async (call) => {
      if (call.url.includes('getPolicy')) return jsonResponse({ code: 'AccessDenied', message: 'no' }, 403);
      const body = call.body as { input: Record<string, unknown> };
      if (body.input['action'] === 'create_voice') {
        const url = String(body.input['url']);
        assert.match(url, /^https:\/\/agent\.example\/xiaozhi\/ota\/voice-sample\/[A-Za-z0-9_-]{43}\.wav$/u);
        // 模拟百炼经公网来取:同一个应用里请求这个路径,不带任何登录态
        const sample = await app.request(url.replace('https://agent.example', 'http://localhost'));
        assert.equal(sample.status, 200);
        assert.equal(Buffer.from(await sample.arrayBuffer()).length, WAV.length);
        fetchedSample = true;
        return jsonResponse({ output: { voice_id: 'qwen-audio-3.0-tts-flash-mom-002' } });
      }
      if (body.input['action'] === 'query_voice') return jsonResponse({ output: { status: 'DEPLOYING' } });
      return jsonResponse({}, 404);
    };
    const response = await clone('tts_model_id=TTS_Qwen&name=mom&consent=1');
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { via: string }).via, 'link');
    assert.ok(fetchedSample);
    // 创建请求结束后链接立即作废
    const token = calls.find((call) => (call.body as { input?: Record<string, unknown> })?.input?.['url'])!;
    const url = String((token.body as { input: Record<string, unknown> }).input['url']).replace('https://agent.example', 'http://localhost');
    assert.equal((await app.request(url)).status, 404);
  });

  test('两条通道都失败时报错并删掉样本', async () => {
    handler = () => jsonResponse({ code: 'Audio.PreprocessError', message: 'too noisy' }, 400);
    const response = await clone('tts_model_id=TTS_Qwen&name=x&consent=1');
    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /临时上传.*公网链接/u);
    const dir = join(dataDir, 'voice-samples');
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
  });
});

describe('删除', () => {
  test('设计与复刻的音色先删云端;云端失败时保留本地记录,可强制只删本地', async () => {
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status) VALUES ('v_d', 'TTS_Qwen', 'd', 'qwen-vd-1', 'design', 'ok')`);
    handler = () => jsonResponse({ code: 'Throttling', message: 'slow down' }, 500);
    let response = await api('DELETE', '/voices/v_d');
    assert.equal(response.status, 502);
    assert.ok(one(conn, "SELECT 1 FROM voices WHERE id = 'v_d'"));
    response = await api('DELETE', '/voices/v_d?local_only=1');
    assert.equal(response.status, 200);
    assert.equal(one(conn, "SELECT 1 FROM voices WHERE id = 'v_d'"), undefined);

    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status) VALUES ('v_c', 'TTS_Qwen', 'c', 'qwen-vc-1', 'clone', 'ok')`);
    handler = (call) => {
      assert.deepEqual((call.body as { input: unknown }).input, { action: 'delete_voice', voice_id: 'qwen-vc-1' });
      return jsonResponse({ output: {} });
    };
    response = await api('DELETE', '/voices/v_c');
    assert.equal(response.status, 200);
  });

  test('系统音色直接删,不打百炼', async () => {
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice) VALUES ('v_s', 'TTS_Qwen', 's', 'longanhuan_v3.6')`);
    assert.equal((await api('DELETE', '/voices/v_s')).status, 200);
    assert.equal(calls.length, 0);
  });
});

describe('下发给引擎的合成配置', () => {
  const MAC = '4c:11:ae:31:7a:30';
  const CLIENT_ID = randomBytes(32).toString('hex');

  async function agentModels() {
    const secret = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)!.value;
    const response = await app.request('http://localhost/xiaozhi/config/agent-models', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ macAddress: MAC, clientId: CLIENT_ID, selectedModule: {} }),
    });
    return ((await response.json()) as { data: { TTS?: Record<string, Record<string, unknown>> } }).data;
  }

  beforeEach(() => {
    run(conn, 'INSERT INTO devices (mac, agent_id, secret_hash) VALUES (?, ?, ?)', MAC, DEFAULT_AGENT_ID, hashClientId(CLIENT_ID));
  });

  test('智能体的语速、音调、音量与语气指令合进千问合成配置', async () => {
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status) VALUES ('v_kid', 'TTS_Qwen', '泡泡', 'longpaopao_v3.6', 'system', 'ok')`);
    const response = await api('PUT', `/agents/${DEFAULT_AGENT_ID}`, {
      name: '小单', tts_model_id: 'TTS_Qwen', tts_voice_id: 'v_kid',
      tts_params: { rate: 0.9, pitch: 1.1, volume: 60, instruction: '像幼儿园老师一样温柔' },
    });
    assert.equal(response.status, 200);
    const tts = (await agentModels()).TTS!['TTS_Qwen']!;
    assert.equal(tts['private_voice'], 'longpaopao_v3.6');
    assert.deepEqual([tts['rate'], tts['pitch'], tts['volume'], tts['instruction']], [0.9, 1.1, 60, '像幼儿园老师一样温柔']);
  });

  test('审核中的音色不下发,设备用模型默认音色', async () => {
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status) VALUES ('v_new', 'TTS_Qwen', '新', 'qwen-vc-9', 'clone', 'pending')`);
    run(conn, "UPDATE agents SET tts_model_id = 'TTS_Qwen', tts_voice_id = 'v_new' WHERE id = ?", DEFAULT_AGENT_ID);
    const tts = (await agentModels()).TTS!['TTS_Qwen']!;
    assert.equal(tts['private_voice'], undefined);
  });

  test('别家合成模型不合并这些参数', async () => {
    run(conn, "UPDATE agents SET tts_model_id = 'TTS_Edge', tts_params_json = ? WHERE id = ?", JSON.stringify({ rate: 1.5 }), DEFAULT_AGENT_ID);
    const tts = (await agentModels()).TTS!['TTS_Edge']!;
    assert.equal(tts['rate'], undefined);
  });

  test('超出范围的参数被丢弃', async () => {
    run(conn, "UPDATE agents SET tts_model_id = 'TTS_Qwen', tts_params_json = ? WHERE id = ?", JSON.stringify({ rate: 9, volume: -1, instruction: '  ' }), DEFAULT_AGENT_ID);
    const tts = (await agentModels()).TTS!['TTS_Qwen']!;
    assert.deepEqual([tts['rate'], tts['volume'], tts['instruction']], [undefined, undefined, undefined]);
  });
});
