// 音色页:系统音色自动同步(flash 与 plus 各一套)、说话设置的合成与校验、复制为新音色、试听、
// 声音设计、声音复刻(两条样本通道)、状态刷新、删除。下发给引擎的合成配置在 manager-api.test.ts。
// 百炼接口全部用假的 fetch 代替。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb, one, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { clampInstruction, httpBase, mapVoiceStatus, voicePrefix } from '../src/voice/dashscope.ts';
import {
  composeInstruction, DEFAULT_PROFILE, filterInlineTags, instructionUnits, readProfile, stripInlineTags, ttsOverrides, validateProfile,
  type VoiceProfile,
} from '../src/voice/profile.ts';
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
    "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Plus', 'TTS', '千问 plus', 'qwen_audio_tts', ?)",
    JSON.stringify({ type: 'qwen_audio_tts', api_key: 'sk-test', model_name: 'qwen-audio-3.0-tts-plus' }),
  );
  // 旧版留下的别家合成模型:目录里已不支持,音色操作要拒绝
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

const profile = (patch: Partial<VoiceProfile> = {}): VoiceProfile => ({ ...DEFAULT_PROFILE, tone_tags: [], emotion_tags: [], ...patch });
const HUAN = 'TTS_Qwen__longanhuan_v3.6';

/** 试听限流窗口是 400 毫秒:连续点试听的测试之间要等一下 */
const pastPreviewWindow = () => new Promise((resolve) => setTimeout(resolve, 450));

async function listVoices() {
  const response = await api('GET', '/voices');
  assert.equal(response.status, 200);
  return ((await response.json()) as { items: Record<string, any>[] }).items;
}

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

  test('语气指令:方言(仅中文)→ 固定语气 → 补充说明 → 额外要求,按 100 单位截断', () => {
    const sichuan = profile({ dialect: '四川话', tone_tags: ['gentle', 'slow'], tone_text: '带点笑意' });
    assert.equal(composeInstruction(sichuan), '请用四川话表达,语气温柔,语速稍慢,带点笑意');
    assert.equal(composeInstruction(sichuan, '讲睡前故事'), '请用四川话表达,语气温柔,语速稍慢,带点笑意,讲睡前故事');
    assert.equal(composeInstruction({ ...sichuan, language: '英语' }), '语气温柔,语速稍慢,带点笑意', '英语不带方言');
    assert.equal(composeInstruction(profile()), '');
    const long = composeInstruction(profile({ tone_text: '好'.repeat(50) }), '再加一句');
    assert.equal(instructionUnits(long), 100);
    assert.equal(instructionUnits('abc中文'), 7);
  });

  test('设置校验给出人能看懂的原因', () => {
    const zhEn = ['中文', '英语'];
    assert.equal(validateProfile(profile({ dialect: '四川话', tone_tags: ['gentle'] }), zhEn), null);
    assert.match(validateProfile(profile({ language: '英语', dialect: '四川话' }), zhEn)!, /方言只在语种为中文时可用/u);
    assert.match(validateProfile(profile({ language: '日语' }), zhEn)!, /不会说日语/u);
    assert.equal(validateProfile(profile({ language: '日语' }), []), null, '不知道能说什么语种时不拦');
    assert.match(validateProfile(profile({ dialect: '火星话' }), zhEn)!, /不认识的方言/u);
    assert.match(validateProfile(profile({ tone_tags: ['angry-ish'] }), zhEn)!, /不认识的语气/u);
    assert.match(validateProfile(profile({ emotion_tags: ['dancing'] }), zhEn)!, /不认识的情感标签/u);
    assert.match(validateProfile(profile({ rate: 3 }), zhEn)!, /语速/u);
    assert.match(validateProfile(profile({ tone_text: '好'.repeat(51) }), zhEn)!, /不能超过 50 个字/u);
    assert.match(validateProfile(profile({ dialect: '宁夏话', tone_tags: ['story', 'excited', 'patient'], tone_text: '好'.repeat(30) }), zhEn)!,
      /已用 \d+\/100/u);
  });

  test('情感标签:只认半角方括号里的小写英文;过滤只留允许的', () => {
    assert.equal(stripInlineTags('[excited]哇,你做到啦![laughing]'), '哇,你做到啦!');
    assert.equal(stripInlineTags('数组 a[0] 与 [Note] 不是标签'), '数组 a[0] 与 [Note] 不是标签');
    assert.equal(filterInlineTags('[excited]哇[sad]好吧[laughing]', ['excited', 'laughing']), '[excited]哇好吧[laughing]');
    assert.equal(filterInlineTags('[deep and loud shouting]站住', []), '站住');
  });

  test('读库里的设置时坏值按默认;下发参数带上指令与允许的标签', () => {
    assert.deepEqual(readProfile({ volume: 'x', tone_tags: '{bad', emotion_tags: '["excited"]', language: '' }),
      { ...DEFAULT_PROFILE, tone_tags: [], emotion_tags: ['excited'] });
    assert.deepEqual(ttsOverrides({ voice: 'longpaopao_v3.6', rate: 0.9, tone_tags: '["gentle"]', emotion_tags: '["giggles"]' } as { voice: string }), {
      private_voice: 'longpaopao_v3.6', volume: 50, rate: 0.9, pitch: 1, inline_tags: ['giggles'], instruction: '语气温柔',
    });
    assert.equal('instruction' in ttsOverrides({ voice: 'v' }), false);
  });
});

describe('系统音色', () => {
  test('打开音色页就按模型补齐那一套系统音色:flash 12 个、plus 2 个,不混用,不重复', async () => {
    const items = await listVoices();
    const byModel = (id: string) => items.filter((item) => item.tts_model_id === id);
    assert.equal(byModel('TTS_Qwen').length, 12);
    assert.deepEqual(byModel('TTS_Plus').map((item) => item.voice).sort(), ['longanlingxin', 'longanlufeng']);
    assert.equal(byModel('TTS_Edge').length, 0);
    assert.equal((await listVoices()).length, 14);

    const paopao = items.find((item) => item.id === 'TTS_Qwen__longpaopao_v3.6')!;
    assert.deepEqual(
      { name: paopao.name, kind: paopao.kind, status: paopao.status, tags: paopao.tags, gender: paopao.gender, age: paopao.age, compatible: paopao.compatible, family: paopao.family },
      { name: '龙泡泡', kind: 'system', status: 'ok', tags: '儿童', gender: '女', age: 5, compatible: true, family: 'flash' },
    );
    assert.deepEqual(paopao.languages, ['中文', '英语']);
    assert.equal(items.find((item) => item.voice === 'longanlingxin')!.model_name, 'qwen-audio-3.0-tts-plus');
  });

  test('改过名字与设置的系统音色,再次同步不会被覆盖;删掉的会以默认设置回来', async () => {
    await listVoices();
    run(conn, "UPDATE voices SET name = '安安', rate = 0.8 WHERE id = ?", HUAN);
    run(conn, "DELETE FROM voices WHERE id = 'TTS_Qwen__loongjohn'");
    const items = await listVoices();
    assert.deepEqual([items.find((item) => item.id === HUAN)!.name, items.find((item) => item.id === HUAN)!.rate], ['安安', 0.8]);
    assert.equal(items.find((item) => item.id === 'TTS_Qwen__loongjohn')!.rate, 1);
  });

  test('按 ID 添加基础音色;重复添加 409;非千问模型 400', async () => {
    let response = await api('POST', '/voices', { tts_model_id: 'TTS_Qwen', name: '瑶瑶', voice: 'qwen-audio-3.0-tts-flash-longyaoxuanke' });
    assert.equal(response.status, 200);
    const { id } = (await response.json()) as { id: string };
    assert.equal(id, 'TTS_Qwen__qwen-audio-3.0-tts-flash-longyaoxuanke');
    assert.equal((await api('POST', '/voices', { tts_model_id: 'TTS_Qwen', name: 'x', voice: 'qwen-audio-3.0-tts-flash-longyaoxuanke' })).status, 409);
    assert.equal((await api('POST', '/voices', { tts_model_id: 'TTS_Edge', name: 'x', voice: 'abc' })).status, 400);
    // 按 ID 加的 flash 基础音色挂到 plus 模型下,标出不兼容
    await api('POST', '/voices', { tts_model_id: 'TTS_Plus', name: '错配', voice: 'qwen-audio-3.0-tts-flash-longyaoxuanke' });
    assert.equal((await listVoices()).find((item) => item.id === 'TTS_Plus__qwen-audio-3.0-tts-flash-longyaoxuanke')!.compatible, false);
  });
});

describe('说话设置', () => {
  test('保存后列表里带着合成指令、摘要与在用的智能体', async () => {
    await listVoices();
    run(conn, 'UPDATE agents SET tts_voice_id = ? WHERE id = ?', HUAN, DEFAULT_AGENT_ID);
    const response = await api('PUT', `/voices/${HUAN}`, {
      name: '安欢老师', description: '幼儿园老师',
      profile: profile({ dialect: '四川话', volume: 70, rate: 0.95, tone_tags: ['gentle', 'story', 'gentle'], tone_text: ' 带点笑意 ', emotion_tags: ['excited', 'laughing'] }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const row = one<Record<string, unknown>>(conn, 'SELECT name, dialect, volume, rate, tone_tags, tone_text, emotion_tags, updated_at FROM voices WHERE id = ?', HUAN)!;
    assert.deepEqual({ ...row, updated_at: typeof row['updated_at'] }, {
      name: '安欢老师', dialect: '四川话', volume: 70, rate: 0.95, tone_tags: '["gentle","story"]', tone_text: '带点笑意',
      emotion_tags: '["excited","laughing"]', updated_at: 'string',
    });
    const view = (await listVoices()).find((item) => item.id === HUAN)!;
    assert.equal(view.instruction, '请用四川话表达,语气温柔,像讲故事一样娓娓道来,带点笑意');
    assert.equal(view.summary, '中文 · 四川话 · 语速 0.95 · 音量 70 · 温柔、讲故事 · 带点笑意 · 情感标签 2 个');
    assert.deepEqual(view.tone_tags, ['gentle', 'story']);
    assert.equal(view.agent_count, 1);
    assert.deepEqual(view.agents, [{ id: DEFAULT_AGENT_ID, name: '小单' }]);
  });

  test('不合规的设置拒绝保存,库里不变', async () => {
    await listVoices();
    const put = (patch: Partial<VoiceProfile>) => api('PUT', `/voices/${HUAN}`, { name: '龙安欢', profile: profile(patch) });
    let response = await put({ language: '英语', dialect: '四川话' });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /方言只在语种为中文时可用/u);
    response = await put({ dialect: '宁夏话', tone_tags: ['story', 'excited', 'patient'], tone_text: '好'.repeat(30) });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /已用/u);
    assert.equal((await put({ language: '日语' })).status, 400, '系统音色只会中文与英语');
    assert.equal((await put({ volume: 101 })).status, 400);
    assert.equal((await api('PUT', '/voices/nope', { name: 'x', profile: profile() })).status, 404);
    assert.equal(one<{ dialect: string }>(conn, 'SELECT dialect FROM voices WHERE id = ?', HUAN)?.dialect, '');
  });

  test('复制为新音色:同一个百炼音色,新设置;复制变体时仍指向最初的音色', async () => {
    await listVoices();
    let response = await api('POST', `/voices/${HUAN}/duplicate`, { profile: profile({ rate: 1.2 }) });
    assert.equal(response.status, 200);
    const first = ((await response.json()) as { id: string }).id;
    assert.equal(first, `${HUAN}__2`);
    response = await api('POST', `/voices/${first}/duplicate`, { name: '安欢·慢' });
    const second = ((await response.json()) as { id: string }).id;
    assert.equal(second, `${HUAN}__3`);
    const rows = conn.prepare('SELECT id, name, voice, parent_id, rate, kind FROM voices WHERE id IN (?, ?) ORDER BY id').all(first, second);
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: first, name: '龙安欢(副本)', voice: 'longanhuan_v3.6', parent_id: HUAN, rate: 1.2, kind: 'system' },
      { id: second, name: '安欢·慢', voice: 'longanhuan_v3.6', parent_id: HUAN, rate: 1.2, kind: 'system' },
    ]);
    // 变体不会让同步再补一个同名系统音色
    assert.equal((await listVoices()).filter((item) => item.voice === 'longanhuan_v3.6').length, 3);
    assert.equal((await api('POST', `/voices/${HUAN}/duplicate`, { profile: profile({ language: '英语', dialect: '四川话' }) })).status, 400);
  });
});

describe('试听', () => {
  const synthHandler = (call: Call) => {
    if (call.url.endsWith('/api/v1/services/audio/tts/SpeechSynthesizer')) {
      return jsonResponse({ output: { audio: { url: 'https://oss.example/a.wav' } } });
    }
    if (call.url === 'https://oss.example/a.wav') return new Response(WAV, { headers: { 'content-type': 'audio/wav' } });
    return jsonResponse({}, 404);
  };
  const synthInput = () => (calls.find((call) => call.url.endsWith('/SpeechSynthesizer'))!.body as { model: string; input: Record<string, unknown> });

  test('用已保存的设置合成,不在允许名单里的标签去掉', async () => {
    await pastPreviewWindow();
    await listVoices();
    run(conn, `UPDATE voices SET dialect = '四川话', volume = 70, rate = 0.9, tone_tags = '["gentle"]', emotion_tags = '["excited","laughing"]' WHERE id = ?`, HUAN);
    handler = synthHandler;
    const response = await api('POST', '/voices/preview', { voice_id: HUAN, text: '[excited]你好[sad]呀[laughing]' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await response.arrayBuffer()).length, WAV.length);
    const synth = calls[0]!;
    assert.equal(synth.url, 'https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
    assert.equal(synth.headers['authorization'], 'Bearer sk-test');
    assert.equal(synth.headers['x-dashscope-workspace'], 'ws-1');
    assert.equal(synthInput().model, 'qwen-audio-3.0-tts-flash');
    assert.deepEqual(synthInput().input, {
      text: '[excited]你好呀[laughing]', voice: 'longanhuan_v3.6', format: 'wav', sample_rate: 24000,
      volume: 70, rate: 0.9, pitch: 1, instruction: '请用四川话表达,语气温柔',
    });
  });

  test('弹窗里没保存的草稿也能试听,且不写库;不给文字时按语种给一句带标签的问候', async () => {
    await pastPreviewWindow();
    await listVoices();
    handler = synthHandler;
    const response = await api('POST', '/voices/preview', {
      voice_id: HUAN, draft: profile({ language: '英语', rate: 1.3, tone_tags: ['lively'], emotion_tags: ['curious', 'giggles'] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(synthInput().input, {
      text: '[curious]Hi there, nice to meet you. How is your day going?[giggles]', voice: 'longanhuan_v3.6', format: 'wav', sample_rate: 24000,
      volume: 50, rate: 1.3, pitch: 1, instruction: '活泼开朗',
    });
    assert.equal(one<{ rate: number }>(conn, 'SELECT rate FROM voices WHERE id = ?', HUAN)?.rate, 1);
  });

  test('plus 音色走 plus 模型;审核中的不能试听;百炼报错原样提示', async () => {
    await pastPreviewWindow();
    await listVoices();
    handler = synthHandler;
    assert.equal((await api('POST', '/voices/preview', { voice_id: 'TTS_Plus__longanlingxin', text: '你好' })).status, 200);
    assert.equal(synthInput().model, 'qwen-audio-3.0-tts-plus');

    run(conn, "INSERT INTO voices (id, tts_model_id, name, voice, kind, status) VALUES ('v_new', 'TTS_Qwen', '新', 'qwen-vc-9', 'clone', 'pending')");
    assert.equal((await api('POST', '/voices/preview', { voice_id: 'v_new' })).status, 409);

    await pastPreviewWindow();
    handler = () => jsonResponse({ code: 'InvalidParameter', message: 'voice not found' }, 400);
    const response = await api('POST', '/voices/preview', { voice_id: HUAN });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /InvalidParameter/u);
  });
});

describe('声音设计', () => {
  test('创建后记为待审核并返回试听;记下目标模型与语种;刷新时变体一起更新', async () => {
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
    assert.equal(created.id, 'TTS_Qwen__qwen-audio-3.0-tts-flash-vd-story-abc123');
    assert.equal(created.status, 'pending');
    assert.ok(created.preview.length > 100);
    const create = calls[0]!.body as { input: Record<string, unknown>; parameters: Record<string, unknown> };
    assert.equal(create.input['target_model'], 'qwen-audio-3.0-tts-flash');
    assert.equal(create.input['prefix'], 'story');
    assert.deepEqual(create.input['language_hints'], ['zh']);
    assert.deepEqual(create.parameters, { sample_rate: 24000, response_format: 'wav' });
    const row = one<{ kind: string; target_model: string; language: string; languages: string }>(
      conn, 'SELECT kind, target_model, language, languages FROM voices WHERE id = ?', created.id)!;
    assert.deepEqual({ kind: row.kind, target_model: row.target_model, language: row.language }, { kind: 'design', target_model: 'qwen-audio-3.0-tts-flash', language: '中文' });
    assert.ok(row.languages.includes('日语'), '设计出的音色能说复刻支持的全部语种');

    response = await api('POST', `/voices/${created.id}/duplicate`, {});
    const variant = ((await response.json()) as { id: string }).id;
    status = 'OK';
    response = await api('POST', `/voices/${variant}/refresh`);
    assert.equal(((await response.json()) as { status: string }).status, 'ok');
    assert.deepEqual(conn.prepare('SELECT status FROM voices WHERE voice = ? ORDER BY id').all('qwen-audio-3.0-tts-flash-vd-story-abc123').map((r) => r['status']), ['ok', 'ok']);
  });

  test('参数不合规时直接拒绝,不打百炼', async () => {
    const response = await api('POST', '/voices/design', { tts_model_id: 'TTS_Qwen', name: 'x', prompt: '温柔', preview_text: '太短' });
    assert.equal(response.status, 400);
    assert.equal((await api('POST', '/voices/design', {
      tts_model_id: 'TTS_Edge', name: 'x', prompt: '温柔的声音', preview_text: '从前有一只小兔子,它最喜欢在月光下散步。',
    })).status, 400);
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
    const row = one<{ kind: string; sample_file: string; target_model: string; language: string }>(
      conn, 'SELECT kind, sample_file, target_model, language FROM voices WHERE id = ?', created.id);
    assert.deepEqual({ kind: row?.kind, target_model: row?.target_model, language: row?.language },
      { kind: 'clone', target_model: 'qwen-audio-3.0-tts-flash', language: '中文' });
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
    const response = await clone('tts_model_id=TTS_Qwen&name=mom&consent=1&language=en');
    assert.equal(response.status, 200);
    const linked = (await response.json()) as { via: string; id: string };
    assert.equal(linked.via, 'link');
    assert.ok(fetchedSample);
    assert.equal(one<{ language: string }>(conn, 'SELECT language FROM voices WHERE id = ?', linked.id)?.language, '英语');
    const create = calls.find((call) => (call.body as { input?: Record<string, unknown> })?.input?.['action'] === 'create_voice')!;
    assert.deepEqual((create.body as { input: Record<string, unknown> }).input['language_hints'], ['en']);
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

  test('还有变体共用时只删本地:删变体不碰云端;删原音色时样本与来源交给剩下的,智能体改用默认', async () => {
    const dir = join(dataDir, 'voice-samples');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dad.wav'), WAV);
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status, sample_file) VALUES ('v_dad', 'TTS_Qwen', '爸爸', 'qwen-vc-dad', 'clone', 'ok', 'dad.wav')`);
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status, parent_id) VALUES ('v_dad__2', 'TTS_Qwen', '爸爸·慢', 'qwen-vc-dad', 'clone', 'ok', 'v_dad')`);
    run(conn, `INSERT INTO voices (id, tts_model_id, name, voice, kind, status, parent_id) VALUES ('v_dad__3', 'TTS_Qwen', '爸爸·快', 'qwen-vc-dad', 'clone', 'ok', 'v_dad')`);
    run(conn, "UPDATE agents SET tts_voice_id = 'v_dad' WHERE id = ?", DEFAULT_AGENT_ID);

    let response = await api('DELETE', '/voices/v_dad__3');
    assert.deepEqual(await response.json(), { ok: true, local_only: true });
    response = await api('DELETE', '/voices/v_dad');
    assert.deepEqual(await response.json(), { ok: true, local_only: true });
    assert.equal(calls.length, 0);
    assert.deepEqual({ ...one(conn, "SELECT parent_id, sample_file FROM voices WHERE id = 'v_dad__2'") }, { parent_id: null, sample_file: 'dad.wav' });
    assert.ok(existsSync(join(dir, 'dad.wav')));
    assert.equal(one<{ tts_voice_id: string | null }>(conn, 'SELECT tts_voice_id FROM agents WHERE id = ?', DEFAULT_AGENT_ID)?.tts_voice_id, null);

    // 最后一个:删云端,也删样本
    handler = () => jsonResponse({ output: {} });
    response = await api('DELETE', '/voices/v_dad__2');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.ok(!existsSync(join(dir, 'dad.wav')));
  });

  test('系统音色直接删,不打百炼', async () => {
    await listVoices();
    assert.equal((await api('DELETE', `/voices/${HUAN}`)).status, 200);
    assert.equal(calls.length, 0);
    assert.equal(one(conn, 'SELECT 1 FROM voices WHERE id = ?', HUAN), undefined);
  });
});
