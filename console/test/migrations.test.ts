// 数据库迁移。
//
// 控制台已经在生产上跑着,库里有真实的智能体、模型与已绑定设备。这组测试守的是:
// 旧形状的库能平滑升级且数据不丢,迁移失败时不会留下半截状态,
// 以及旧程序不会去写一个它不认识的新形状的库。

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
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
  runMigrations(conn, MIGRATIONS.filter((migration) => migration.version <= 1));
  seed(conn);
  conn.prepare("INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Omni', 'TTS', 'Omni', 'gateway_omni_tts', '{}')").run();
  conn.prepare("INSERT INTO voices (id, tts_model_id, name, voice, languages) VALUES ('v_ethan', 'TTS_Omni', 'Ethan', 'Ethan', '中文')").run();
  conn.prepare('UPDATE agents SET tts_model_id = ?, tts_voice_id = ? WHERE id = ?').run('TTS_Omni', 'v_ethan', DEFAULT_AGENT_ID);
  assert.equal(schemaVersion(conn), 1);

  prepareDb(conn);

  assert.equal(schemaVersion(conn), LATEST);
  const voice = one<{ kind: string; status: string; voice: string; created_at: string | null }>(
    conn, 'SELECT kind, status, voice, created_at FROM voices WHERE id = ?', 'v_ethan',
  );
  assert.deepEqual({ ...voice }, { kind: 'system', status: 'ok', voice: 'Ethan', created_at: null });
  const agent = one<{ tts_voice_id: string; tts_params_json: string }>(
    conn, 'SELECT tts_voice_id, tts_params_json FROM agents WHERE id = ?', DEFAULT_AGENT_ID,
  );
  assert.equal(agent?.tts_voice_id, 'v_ethan');
  assert.equal(agent?.tts_params_json, '{}');
  assert.throws(() => conn.prepare("UPDATE voices SET kind = 'bogus' WHERE id = 'v_ethan'").run(), /CHECK/u);
});

test('v2 升级到智能体运行时:已有智能体保持旧路径,两项引擎参数只改默认值', () => {
  const conn = new DatabaseSync(':memory:');
  conn.exec(SCHEMA_V0);
  runMigrations(conn, MIGRATIONS.filter((migration) => migration.version <= 2));
  seed(conn);
  // 模拟生产库里仍是旧默认值的一项,和用户改过的一项
  conn.prepare("UPDATE settings SET value = '退出;关闭' WHERE key = 'exit_commands'").run();
  conn.prepare("UPDATE settings SET value = '300' WHERE key = 'close_connection_no_voice_time'").run();
  conn.prepare("INSERT INTO chat_messages (mac, session_id, chat_type, content) VALUES ('m', 's', 1, 'hi')").run();

  prepareDb(conn);

  assert.equal(schemaVersion(conn), LATEST);
  const agent = one<{ runtime: string; max_steps: number; safety_level: string }>(
    conn, 'SELECT runtime, max_steps, safety_level FROM agents WHERE id = ?', DEFAULT_AGENT_ID,
  );
  assert.deepEqual({ ...agent }, { runtime: 'engine', max_steps: 6, safety_level: 'standard' });
  assert.equal(one<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'exit_commands'")?.value, '');
  assert.equal(one<{ value: string }>(conn, "SELECT value FROM settings WHERE key = 'close_connection_no_voice_time'")?.value, '300', '用户改过的值不动');
  assert.equal(one<{ agent_id: string | null }>(conn, 'SELECT agent_id FROM chat_messages')?.agent_id, null);
  assert.throws(() => conn.prepare("UPDATE agents SET runtime = 'cloud'").run(), /CHECK/u);
});
