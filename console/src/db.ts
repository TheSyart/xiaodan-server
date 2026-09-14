// SQLite 访问层。用 Node 内置的 node:sqlite,不引入原生模块 ——
// better-sqlite3 那类依赖需要在镜像里装 python3/make/g++ 才能编译,
// 对一个只存几百行配置的控制台来说不值得。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, type Migration } from './migrations.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = DatabaseSync;

let db: Db | undefined;

/** 数据目录。容器里是绑定挂载进来的 /app/data。 */
export function dataDir(): string {
  return process.env.XIAODAN_DATA_DIR ?? join(process.cwd(), 'data');
}

export function dbPath(): string {
  return process.env.XIAODAN_DB_PATH ?? join(dataDir(), 'console.db');
}

export function schemaVersion(conn: Db): number {
  const row = conn.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 按版本号顺序执行尚未执行的迁移。
 *
 * 每一步独占一个 BEGIN IMMEDIATE 事务,并在拿到写锁之后重读版本号:
 * 命令行工具与服务进程可能同时打开同一个库文件,不这样做两边会把同一步各跑一遍。
 * 库版本高于本程序认识的最新版本时直接拒绝启动 —— 旧程序去写新形状的表只会写坏数据。
 */
export function runMigrations(conn: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  const latest = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  const current = schemaVersion(conn);
  if (current > latest) {
    throw new Error(`数据库版本 ${current} 高于本程序支持的 ${latest},请换用更新的程序或恢复对应版本的数据备份`);
  }
  for (const migration of migrations) {
    if (schemaVersion(conn) >= migration.version) continue;
    conn.exec('BEGIN IMMEDIATE');
    try {
      if (schemaVersion(conn) < migration.version) {
        migration.up(conn);
        conn.exec(`PRAGMA user_version = ${Number(migration.version)}`);
      }
      conn.exec('COMMIT');
    } catch (error) {
      conn.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * 建表并迁移到最新版本。
 *
 * schema.sql 是冻结的 v0 基线(全是 CREATE ... IF NOT EXISTS),每次执行一遍;
 * 之后的一切表结构变化都在 migrations.ts 里。基线里的 journal_mode 必须在事务之外设置,
 * 所以先执行基线再跑迁移。seed() 在这之后单独开事务,不与迁移嵌套。
 */
export function prepareDb(conn: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  runMigrations(conn, migrations);
}

/** 打开数据库并迁移到最新版本。可重复调用,返回同一个连接。 */
export function openDb(path = dbPath()): Db {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);
  try {
    prepareDb(conn);
  } catch (error) {
    conn.close();
    throw error;
  }
  db = conn;
  return db;
}

/** 仅供测试:开一个独立的内存库,不影响全局单例。 */
export function openMemoryDb(): Db {
  const mem = new DatabaseSync(':memory:');
  prepareDb(mem);
  return mem;
}

export function closeDb(): void {
  if (!db) return;
  // WAL 模式下未 checkpoint 的数据留在 -wal 文件里。容器被 SIGTERM 停掉、
  // 运维面板随即打包数据目录时,如果只拷了主库文件就会丢掉最近的写入 ——
  // 上游迁移记录里真出现过这种事(1.8MB 停在 WAL 里)。
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // checkpoint 失败不应该阻止进程退出,数据仍在 -wal 里,下次打开会重放
  }
  db.close();
  db = undefined;
}

/** 单值查询的便利封装。 */
export function one<T = Record<string, unknown>>(
  conn: Db,
  sql: string,
  ...params: unknown[]
): T | undefined {
  return conn.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T = Record<string, unknown>>(
  conn: Db,
  sql: string,
  ...params: unknown[]
): T[] {
  return conn.prepare(sql).all(...(params as never[])) as T[];
}

export function run(conn: Db, sql: string, ...params: unknown[]): void {
  conn.prepare(sql).run(...(params as never[]));
}

/** 在一个事务里跑 fn;抛异常则回滚。不可重入:fn 里不要再调 tx。 */
export function tx<T>(conn: Db, fn: () => T): T {
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    conn.exec('ROLLBACK');
    throw error;
  }
}
