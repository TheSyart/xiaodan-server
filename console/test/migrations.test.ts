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
