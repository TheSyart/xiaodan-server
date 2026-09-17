// 数据库迁移。
//
// 控制台已经在生产上跑着,库里有真实的智能体、模型与已绑定设备。这组测试守的是:
// 旧形状的库能平滑升级且数据不丢,迁移失败时不会留下半截状态,
// 以及旧程序不会去写一个它不认识的新形状的库。

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { all, one, openMemoryDb, prepareDb, runMigrations, schemaVersion, type Db } from '../src/db.ts';
import { MIGRATIONS } from '../src/migrations.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';

const SCHEMA_V0 = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const columns = (conn: Db, table: string) =>
  all<{ name: string }>(conn, 'SELECT name FROM pragma_table_info(?)', table).map((row) => row.name);
const indexes = (conn: Db, table: string) =>
  all<{ name: string }>(conn, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", table)
    .map((row) => row.name);
const tableExists = (conn: Db, table: string) =>
  one(conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table) !== undefined;
const foreignKeysOn = (conn: Db) => one<{ foreign_keys: number }>(conn, 'PRAGMA foreign_keys')!.foreign_keys;
const upTo = (version: number) => MIGRATIONS.filter((migration) => migration.version <= version);
const exec = (conn: Db, sql: string, ...params: unknown[]) => {
  conn.prepare(sql).run(...(params as never[]));
};
const value = (conn: Db, key: string) => one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', key)?.value;

/** 只执行基线、不跑迁移:模拟身份机制上线前的生产库。 */
function v0Database(): Db {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  return conn;
}

test('新库迁移到最新版本,新列与新表都在', () => {
  const conn = openMemoryDb();
  assert.equal(schemaVersion(conn), LATEST);
  assert.ok(columns(conn, 'devices').includes('secret_hash'));
  assert.ok(columns(conn, 'pending_devices').includes('secret_hash'));
  assert.ok(tableExists(conn, 'identity_events'));
  assert.ok(columns(conn, 'agents').includes('image_model_id'));
  assert.ok(columns(conn, 'voices').includes('emotion_tags'));
  assert.ok(columns(conn, 'media_items').includes('timing_json'));
  assert.equal(foreignKeysOn(conn), 1, '关外键跑的迁移结束后要恢复');
});

test('旧形状的库升级后,已绑定设备保留且标记为待重新配对,旧待绑定行被丢弃', () => {
  const conn = v0Database();
  seed(conn);
  conn.prepare('INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)')
    .run('4c:11:ae:31:7a:30', DEFAULT_AGENT_ID, 'AI Passport');
  conn.prepare("INSERT INTO pending_devices (mac, code, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))")
    .run('aa:bb:cc:dd:ee:01', '123456');
  assert.equal(schemaVersion(conn), 0);

  prepareDb(conn);

  assert.equal(schemaVersion(conn), LATEST);
  const device = one<{ alias: string; agent_id: string; secret_hash: string | null }>(
    conn, 'SELECT alias, agent_id, secret_hash FROM devices WHERE mac = ?', '4c:11:ae:31:7a:30',
  );
  assert.ok(device, '已绑定设备不能在升级中丢失');
  assert.equal(device.alias, 'AI Passport');
  assert.equal(device.agent_id, DEFAULT_AGENT_ID);
  assert.equal(device.secret_hash, null, '升级前绑定的设备没有密钥哈希,须重新配对');
  assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM pending_devices')!.n, 0);
  for (const name of ['idx_pending_expires', 'idx_pending_mac', 'idx_pending_created']) {
    assert.ok(indexes(conn, 'pending_devices').includes(name), `缺少索引 ${name}`);
  }
  // 原有配置一并保留
  assert.ok(one(conn, 'SELECT 1 FROM agents WHERE id = ?', DEFAULT_AGENT_ID));
  assert.ok(one(conn, "SELECT 1 FROM settings WHERE key = 'server.secret'"));
});

test('重复执行是幂等的', () => {
  const conn = openMemoryDb();
  prepareDb(conn);
  prepareDb(conn);
  assert.equal(schemaVersion(conn), LATEST);
  assert.ok(tableExists(conn, 'identity_events'));
});

test('迁移中途出错会整步回滚,版本号不变', () => {
  const conn = openMemoryDb();
  const broken = [
    ...MIGRATIONS,
    {
      version: LATEST + 1,
      name: 'broken',
      up(db: Db) {
        db.exec('CREATE TABLE half_done (x INTEGER)');
        throw new Error('故意失败');
      },
    },
  ];
  assert.throws(() => runMigrations(conn, broken), /故意失败/u);
  assert.equal(schemaVersion(conn), LATEST);
  assert.equal(tableExists(conn, 'half_done'), false, '失败的迁移不能留下半截结构');
});

test('库版本高于程序支持的版本时拒绝启动', () => {
  const conn = openMemoryDb();
  conn.exec(`PRAGMA user_version = ${LATEST + 5}`);
  assert.throws(() => prepareDb(conn), /高于本程序支持/u);
});

test('迁移之后 seed 照常工作,且可以重复执行', () => {
  const conn = openMemoryDb();
  seed(conn);
  seed(conn);
  assert.ok(one(conn, 'SELECT 1 FROM agents WHERE id = ?', DEFAULT_AGENT_ID));
});

test('v1 的库升级到音色定制:原有音色记作系统音色且可用,智能体合成参数默认为空对象', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  runMigrations(conn, upTo(1));
  seed(conn);
  conn.prepare("INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Omni', 'TTS', 'Omni', 'gateway_omni_tts', '{}')").run();
  conn.prepare("INSERT INTO voices (id, tts_model_id, name, voice, languages) VALUES ('v_ethan', 'TTS_Omni', 'Ethan', 'Ethan', '中文')").run();
  conn.prepare('UPDATE agents SET tts_model_id = ?, tts_voice_id = ? WHERE id = ?').run('TTS_Omni', 'v_ethan', DEFAULT_AGENT_ID);
  assert.equal(schemaVersion(conn), 1);

  runMigrations(conn, upTo(2));

  assert.equal(schemaVersion(conn), 2);
  const voice = one<{ kind: string; status: string; voice: string; created_at: string | null }>(
    conn, 'SELECT kind, status, voice, created_at FROM voices WHERE id = ?', 'v_ethan',
  );
  assert.deepEqual({ ...voice }, { kind: 'system', status: 'ok', voice: 'Ethan', created_at: null });
  assert.equal(one<{ tts_params_json: string }>(conn, 'SELECT tts_params_json FROM agents WHERE id = ?', DEFAULT_AGENT_ID)?.tts_params_json, '{}');
  assert.throws(() => conn.prepare("UPDATE voices SET kind = 'bogus' WHERE id = 'v_ethan'").run(), /CHECK/u);

  // 一个千问合成模型都没有时,v8 不动旧的合成模型与音色,等用户配好千问再处理
  prepareDb(conn);
  assert.equal(schemaVersion(conn), LATEST);
  assert.equal(one<{ tts_voice_id: string }>(conn, 'SELECT tts_voice_id FROM agents WHERE id = ?', DEFAULT_AGENT_ID)?.tts_voice_id, 'v_ethan');
  assert.ok(one(conn, "SELECT 1 FROM models WHERE id = 'TTS_Omni'"));
});

test('v2 升级到 v3:已有智能体记为旧路径,两项引擎参数只改默认值;到 v8 时 runtime 列随旧路径一起删掉', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  runMigrations(conn, upTo(2));
  seed(conn);
  // 模拟生产库里仍是旧默认值的一项,和用户改过的一项
  conn.prepare("UPDATE settings SET value = '退出;关闭' WHERE key = 'exit_commands'").run();
  conn.prepare("UPDATE settings SET value = '300' WHERE key = 'close_connection_no_voice_time'").run();
  conn.prepare("INSERT INTO chat_messages (mac, session_id, chat_type, content) VALUES ('m', 's', 1, 'hi')").run();

  runMigrations(conn, upTo(3));

  assert.equal(schemaVersion(conn), 3);
  const agent = one<{ runtime: string; max_steps: number; safety_level: string }>(
    conn, 'SELECT runtime, max_steps, safety_level FROM agents WHERE id = ?', DEFAULT_AGENT_ID,
  );
  assert.deepEqual({ ...agent }, { runtime: 'engine', max_steps: 6, safety_level: 'standard' });
  assert.equal(value(conn, 'exit_commands'), '');
  assert.equal(value(conn, 'close_connection_no_voice_time'), '300', '用户改过的值不动');
  assert.equal(one<{ agent_id: string | null }>(conn, 'SELECT agent_id FROM chat_messages')?.agent_id, null);
  assert.throws(() => conn.prepare("UPDATE agents SET runtime = 'cloud'").run(), /CHECK/u);

  prepareDb(conn);
  assert.equal(schemaVersion(conn), LATEST);
  assert.equal(columns(conn, 'agents').includes('runtime'), false);
  assert.deepEqual({ ...one(conn, 'SELECT max_steps, safety_level FROM agents WHERE id = ?', DEFAULT_AGENT_ID) }, { max_steps: 6, safety_level: 'standard' });
});

test('生产形状的 v2 库直接升到 v8:千问收拢、合成参数搬到音色(不一致时拆变体)、设备与复刻音色都在', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  runMigrations(conn, upTo(2));
  seed(conn);
  const model = (id: string, type: string, provider: string, cfg: Record<string, unknown> = {}) =>
    exec(conn, 'INSERT INTO models (id, model_type, name, provider, config_json) VALUES (?, ?, ?, ?, ?)', id, type, id, provider, JSON.stringify(cfg));
  model('ASR_Qwen', 'ASR', 'qwen_audio_asr', { api_key: 'sk' });
  model('ASR_Fun', 'ASR', 'funasr');
  model('LLM_Gw', 'LLM', 'openai', { base_url: 'https://gw.example/v1', model_name: 'deepseek-chat' });
  model('LLM_Ollama', 'LLM', 'ollama', { base_url: 'http://ollama:11434/', model_name: 'qwen3' });
  model('VLLM_Qwen', 'VLLM', 'openai');
  model('TTS_Qwen', 'TTS', 'qwen_audio_tts', { api_key: 'sk', model_name: 'qwen-audio-3.0-tts-flash', voice: 'longpaopao_v3.6' });
  model('TTS_Gw', 'TTS', 'gateway_omni_tts');
  model('Memory_nomem', 'Memory', 'nomem');
  model('Intent_fc', 'Intent', 'function_call');
  model('Intent_no', 'Intent', 'nointent');

  const voice = (id: string, modelId: string, name: string, v: string, extra: { kind?: string; languages?: string; sample?: string } = {}) =>
    exec(conn, 'INSERT INTO voices (id, tts_model_id, name, voice, languages, kind, sample_file) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, modelId, name, v, extra.languages ?? '中文', extra.kind ?? 'system', extra.sample ?? '');
  voice('v_huan', 'TTS_Qwen', '安欢', 'longanhuan_v3.6', { languages: '中文、英文' });
  voice('v_dad', 'TTS_Qwen', '爸爸', 'qwen-audio-3.0-tts-flash-dad-001', { kind: 'clone', sample: 'dad.wav' });
  voice('v_ethan', 'TTS_Gw', 'Ethan', 'Ethan');

  exec(conn, `UPDATE agents SET asr_model_id = 'ASR_Fun', llm_model_id = 'LLM_Gw', vllm_model_id = 'VLLM_Qwen', tts_model_id = 'TTS_Qwen',
                 tts_voice_id = 'v_huan', memory_model_id = 'Memory_nomem', intent_model_id = 'Intent_fc', tts_language = '中文',
                 tts_params_json = '{"rate":0.9,"instruction":"温柔"}', chat_history_conf = 2 WHERE id = ?`, DEFAULT_AGENT_ID);
  exec(conn, "INSERT INTO agent_plugins (agent_id, plugin_code) VALUES (?, 'play_music')", DEFAULT_AGENT_ID);
  const agent = (id: string, name: string, cols: Record<string, string | null>) => {
    const keys = Object.keys(cols);
    exec(conn, `INSERT INTO agents (id, name, llm_model_id, ${keys.join(', ')}) VALUES (?, ?, 'LLM_Ollama', ${keys.map(() => '?').join(', ')})`,
      id, name, ...Object.values(cols));
  };
  agent('a_same', '同款', { tts_model_id: 'TTS_Qwen', tts_voice_id: 'v_huan', tts_language: '中文', tts_params_json: '{"rate":0.9,"instruction":"温柔"}', intent_model_id: 'Intent_fc' });
  agent('a_story', '故事', { tts_model_id: 'TTS_Qwen', tts_voice_id: 'v_huan', tts_params_json: '{"rate":1.2,"volume":300}', intent_model_id: 'Intent_no' });
  agent('a_bare', '只选了模型', { tts_model_id: 'TTS_Qwen', tts_voice_id: null });
  agent('a_dad', '爸爸', { tts_model_id: 'TTS_Qwen', tts_voice_id: 'v_dad' });
  agent('a_gw', '网关', { tts_model_id: 'TTS_Gw', tts_voice_id: 'v_ethan' });
  exec(conn, "INSERT INTO agent_plugins (agent_id, plugin_code) VALUES ('a_story', 'get_weather')");
  exec(conn, "INSERT INTO devices (mac, agent_id, alias) VALUES ('4c:11:ae:31:7a:30', 'a_story', 'AI Passport')");
  // 在本地跑过 P5 的库里还会有讲故事的设置(生产库没有这两项)
  exec(conn, "UPDATE settings SET value = 'longpaopao_v3.6' WHERE key = 'media.story_voice'");
  exec(conn, "INSERT INTO settings (key, value) VALUES ('media.story_tts_model', 'TTS_Qwen')");

  prepareDb(conn);

  assert.equal(schemaVersion(conn), LATEST);
  assert.equal(foreignKeysOn(conn), 1);
  assert.deepEqual(conn.prepare('PRAGMA foreign_key_check').all(), []);
  // 设备与绑定一个不少
  assert.deepEqual({ ...one(conn, 'SELECT agent_id, alias FROM devices') }, { agent_id: 'a_story', alias: 'AI Passport' });

  // 模型:视觉、意图、记忆、别家识别与合成都没了;ollama 改写成 OpenAI 兼容
  assert.deepEqual(all<{ id: string }>(conn, 'SELECT id FROM models ORDER BY id').map((row) => row.id),
    ['ASR_Qwen', 'LLM_Gw', 'LLM_Ollama', 'TTS_Qwen', 'VAD_SileroVAD']);
  const ollama = one<{ provider: string; config_json: string }>(conn, "SELECT provider, config_json FROM models WHERE id = 'LLM_Ollama'")!;
  assert.equal(ollama.provider, 'openai');
  assert.deepEqual(JSON.parse(ollama.config_json), { type: 'openai', model_name: 'qwen3', base_url: 'http://ollama:11434/v1', api_key: 'ollama' });
  assert.throws(() => exec(conn, "INSERT INTO models (id, model_type, name, provider) VALUES ('Intent_x', 'Intent', 'x', 'nointent')"), /CHECK/u);
  exec(conn, "INSERT INTO models (id, model_type, name, provider) VALUES ('Image_x', 'Image', 'x', 'qwen_image')");
  assert.ok(indexes(conn, 'models').includes('idx_models_type'));

  // 智能体:旧列删掉,新列加上
  for (const gone of ['vllm_model_id', 'memory_model_id', 'intent_model_id', 'runtime', 'tts_params_json', 'tts_language', 'tts_model_id']) {
    assert.equal(columns(conn, 'agents').includes(gone), false, `${gone} 应该删掉`);
  }
  const agents = Object.fromEntries(all<{ id: string; asr_model_id: string | null; tts_voice_id: string | null; chat_history_conf: number; image_model_id: string | null }>(
    conn, 'SELECT id, asr_model_id, tts_voice_id, chat_history_conf, image_model_id FROM agents').map((row) => [row.id, { ...row }]));
  assert.deepEqual(agents[DEFAULT_AGENT_ID], { id: DEFAULT_AGENT_ID, asr_model_id: 'ASR_Qwen', tts_voice_id: 'v_huan', chat_history_conf: 1, image_model_id: null });
  assert.equal(agents['a_same']!.tts_voice_id, 'v_huan');
  assert.equal(agents['a_story']!.tts_voice_id, 'v_huan__2');
  assert.equal(agents['a_bare']!.tts_voice_id, 'TTS_Qwen__longpaopao_v3.6', '只选了模型的用模型上配的音色');
  assert.equal(agents['a_gw']!.tts_voice_id, 'TTS_Qwen__longpaopao_v3.6', '别家合成的改用千问');
  assert.equal(agents['a_dad']!.tts_voice_id, 'v_dad');
  assert.equal(agents['a_bare']!.asr_model_id, 'ASR_Qwen');

  // 音色:官方名、设置搬过来、变体指回原音色、复刻音色与样本保留
  const voices = Object.fromEntries(all<Record<string, unknown>>(conn,
    'SELECT id, name, languages, language, volume, rate, tone_text, parent_id, gender, age, target_model, sample_file, kind FROM voices').map((row) => [row['id'], { ...row }]));
  assert.deepEqual(voices['v_huan'], {
    id: 'v_huan', name: '龙安欢', languages: '中文、英语', language: '中文', volume: 50, rate: 0.9, tone_text: '温柔', parent_id: null,
    gender: '女', age: 25, target_model: '', sample_file: '', kind: 'system',
  });
  assert.deepEqual(voices['v_huan__2'], {
    id: 'v_huan__2', name: '龙安欢(故事)', languages: '中文、英语', language: '中文', volume: 50, rate: 1.2, tone_text: '', parent_id: 'v_huan',
    gender: '女', age: 25, target_model: '', sample_file: '', kind: 'system',
  }, '超出范围的旧参数按默认值');
  assert.deepEqual({ name: voices['v_dad']!['name'], kind: voices['v_dad']!['kind'], target_model: voices['v_dad']!['target_model'], sample_file: voices['v_dad']!['sample_file'] },
    { name: '爸爸', kind: 'clone', target_model: 'qwen-audio-3.0-tts-flash', sample_file: 'dad.wav' });
  assert.equal(voices['v_ethan'], undefined);

  // 插件:旧路径下没开函数调用的智能体,插件从来没生效过,清掉;引擎专用的插件代号清掉
  assert.deepEqual(all<{ plugin_code: string }>(conn, 'SELECT plugin_code FROM agent_plugins WHERE agent_id = ? ORDER BY plugin_code', DEFAULT_AGENT_ID)
    .map((row) => row.plugin_code), ['get_weather', 'set_volume', 'show_calendar']);
  assert.equal(one(conn, "SELECT 1 FROM agent_plugins WHERE agent_id = 'a_story'"), undefined);

  // 讲故事的音色改存音色 id
  assert.equal(value(conn, 'media.story_voice'), 'TTS_Qwen__longpaopao_v3.6');
  assert.equal(value(conn, 'media.story_tts_model'), undefined);

  // 迁移后启动时的 seed 补齐 flash 的系统音色,不和已有的重复
  seed(conn);
  assert.equal(one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM voices WHERE tts_model_id = 'TTS_Qwen' AND kind = 'system' AND parent_id IS NULL")!.n, 12);
});

test('v7 的千问画图服务转成文生图模型,开了画画插件的智能体填上它', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  runMigrations(conn, upTo(7));
  seed(conn);
  exec(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Qwen', 'TTS', '千问', 'qwen_audio_tts', ?)",
    JSON.stringify({ api_key: 'sk-q', workspace_id: 'ws' }));
  const service = (id: string, kind: string, provider: string, cfg: Record<string, unknown>, isDefault = 0) =>
    exec(conn, 'INSERT INTO service_providers (id, kind, name, provider, config_json, is_default) VALUES (?, ?, ?, ?, ?, ?)',
      id, kind, id, provider, JSON.stringify(cfg), isDefault);
  service('img', 'image', 'qwen-image', { key_from_model: 'TTS_Qwen', size: '768x768' }, 1);
  service('img_openai', 'image', 'openai-images', { api_key: 'sk-o' });
  service('search', 'search', 'bocha', { api_key: 'sk-b' }, 1);
  exec(conn, "UPDATE agents SET runtime = 'agent' WHERE id = ?", DEFAULT_AGENT_ID);
  exec(conn, "INSERT INTO agent_plugins (agent_id, plugin_code) VALUES (?, 'image')", DEFAULT_AGENT_ID);
  exec(conn, "INSERT INTO agents (id, name) VALUES ('a_plain', '不画画')");

  prepareDb(conn);

  const image = one<{ model_type: string; provider: string; config_json: string; is_default: number }>(
    conn, "SELECT model_type, provider, config_json, is_default FROM models WHERE id = 'Image_Qwen'")!;
  assert.deepEqual({ ...image, config_json: JSON.parse(image.config_json) }, {
    model_type: 'Image', provider: 'qwen_image', is_default: 1,
    config_json: { type: 'qwen_image', api_key: 'sk-q', workspace_id: 'ws', model_name: 'qwen-image-3.0-pro', size: '768*768', prompt_extend: false },
  });
  assert.equal(one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM models WHERE model_type = 'Image'")!.n, 1, '别家的画图接口不再支持');
  assert.deepEqual(all<{ id: string }>(conn, 'SELECT id FROM service_providers').map((row) => row.id), ['search']);
  // v8 给开了画画插件的智能体填上文生图模型;v10 再把它收进画画工具的全局设置
  assert.equal(one<{ config_json: string }>(conn, "SELECT config_json FROM tool_settings WHERE code = 'image'")?.config_json, '{"model_id":"Image_Qwen"}');
  assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM agents WHERE image_model_id IS NOT NULL')?.n, 0);
  assert.ok(one(conn, "SELECT 1 FROM agent_plugins WHERE agent_id = ? AND plugin_code = 'image'", DEFAULT_AGENT_ID), '已经在控制塔大脑上的智能体插件不动');
});

test('v10:工具设置收拢成全局、MCP 对外工具挪到服务器级、去掉技能与 MCP 的全局停用', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  runMigrations(conn, upTo(9));
  seed(conn);
  exec(conn, "INSERT INTO agents (id, name, created_at) VALUES ('a_old', '先建的', '2020-01-01 00:00:00')");
  exec(conn, "INSERT INTO agents (id, name) VALUES ('a_new', '后建的')");
  exec(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('Image_A', 'Image', 'a', 'qwen_image', '{}')");
  // 默认智能体填了天气,先建的智能体填了不同的天气和单词书:天气以默认智能体为准,单词书只有它填了就用它的
  exec(conn, `INSERT OR REPLACE INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'get_weather', '{"default_location":"广州","hold_s":30}')`, DEFAULT_AGENT_ID);
  exec(conn, `INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES ('a_old', 'get_weather', '{"default_location":"北京"}')`);
  exec(conn, `INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES ('a_old', 'vocab', '{"book":"starter","extra":""}')`);
  exec(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES ('a_new', 'search', '{}')");
  exec(conn, "UPDATE agents SET image_model_id = 'Image_A' WHERE id = 'a_new'");
  // MCP:两个智能体放行的工具不同,以默认智能体为准;停用的服务器从智能体上摘掉
  exec(conn, "INSERT INTO mcp_servers (id, name, url) VALUES ('m1', 'M1', 'https://m1.example/mcp')");
  exec(conn, "INSERT INTO mcp_servers (id, name, url, enabled) VALUES ('m_off', '停用的', 'https://off.example/mcp', 0)");
  exec(conn, `INSERT INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES ('a_old', 'm1', '["b"]')`);
  exec(conn, `INSERT INTO agent_mcp_servers (agent_id, server_id, tool_allowlist_json) VALUES (?, 'm1', '["a"]')`, DEFAULT_AGENT_ID);
  exec(conn, "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ('a_new', 'm_off')");
  // 技能:停用的从智能体上摘掉
  exec(conn, "INSERT INTO skills (name, description, body, enabled) VALUES ('off-skill', 'd', 'b', 0)");
  exec(conn, "INSERT INTO agent_skills (agent_id, skill_name) VALUES ('a_new', 'off-skill'), ('a_new', 'word-coach')");

  runMigrations(conn);

  const settings = Object.fromEntries(all<{ code: string; config_json: string }>(conn, 'SELECT code, config_json FROM tool_settings').map((r) => [r.code, JSON.parse(r.config_json)]));
  assert.deepEqual(settings, {
    get_weather: { default_location: '广州', hold_s: 30 },
    vocab: { book: 'starter' },
    image: { model_id: 'Image_A' },
  });
  assert.equal(one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM agent_plugins WHERE params_json != '{}'")?.n, 0);
  assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM agents WHERE image_model_id IS NOT NULL')?.n, 0);
  assert.ok(one(conn, "SELECT 1 FROM agent_plugins WHERE agent_id = 'a_old' AND plugin_code = 'vocab'"), '开关本身不动');

  assert.equal(one<{ tool_allowlist_json: string }>(conn, "SELECT tool_allowlist_json FROM mcp_servers WHERE id = 'm1'")?.tool_allowlist_json, '["a"]');
  assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM agent_mcp_servers WHERE tool_allowlist_json IS NOT NULL')?.n, 0);
  assert.equal(one(conn, "SELECT 1 FROM agent_mcp_servers WHERE server_id = 'm_off'"), undefined);
  assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM mcp_servers WHERE enabled = 0')?.n, 0);

  assert.deepEqual(all<{ skill_name: string }>(conn, "SELECT skill_name FROM agent_skills WHERE agent_id = 'a_new'").map((r) => r.skill_name), ['word-coach']);
  assert.equal(one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM skills WHERE enabled = 0')?.n, 0);
});

describe('关外键执行的迁移', () => {
  const withMigration = (up: (db: Db) => void) => [...MIGRATIONS, { version: LATEST + 1, name: 'fk-off', disableForeignKeys: true, up }];

  test('新造出悬空引用时整体回滚,外键开关恢复', () => {
    const conn = openMemoryDb();
    assert.throws(() => runMigrations(conn, withMigration((db) => {
      db.exec("CREATE TABLE scratch (x INTEGER)");
      db.exec(`INSERT INTO devices (mac, agent_id) VALUES ('aa:bb:cc:dd:ee:ff', 'no-such-agent')`);
    })), /对不上的外键引用/u);
    assert.equal(schemaVersion(conn), LATEST);
    assert.equal(tableExists(conn, 'scratch'), false);
    assert.equal(one(conn, 'SELECT 1 FROM devices'), undefined);
    assert.equal(foreignKeysOn(conn), 1);
  });

  test('迁移本身抛错也恢复外键;库里原有的悬空引用不算这一步的错', () => {
    const conn = openMemoryDb();
    assert.throws(() => runMigrations(conn, withMigration(() => {
      throw new Error('故意失败');
    })), /故意失败/u);
    assert.equal(foreignKeysOn(conn), 1);

    conn.exec('PRAGMA foreign_keys = OFF');
    exec(conn, "INSERT INTO devices (mac, agent_id) VALUES ('aa:bb:cc:dd:ee:01', 'ghost')");
    conn.exec('PRAGMA foreign_keys = ON');
    runMigrations(conn, withMigration((db) => db.exec('CREATE TABLE scratch (x INTEGER)')));
    assert.equal(schemaVersion(conn), LATEST + 1);
    assert.equal(foreignKeysOn(conn), 1);
  });
});
