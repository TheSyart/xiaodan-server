// SQLite 访问层。用 Node 内置的 node:sqlite,不引入原生模块 ——
// better-sqlite3 那类依赖需要在镜像里装 python3/make/g++ 才能编译,
// 对一个只存几百行配置的控制台来说不值得。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * 打开数据库并建表。可重复调用,返回同一个连接。
 *
 * schema.sql 全部是 CREATE ... IF NOT EXISTS,所以每次启动都执行一遍即可,
 * 不需要版本号迁移表。等到真要改列时再引入迁移。
 */
export function openDb(path = dbPath()): Db {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

/** 仅供测试:开一个独立的内存库,不影响全局单例。 */
export function openMemoryDb(): Db {
  const mem = new DatabaseSync(':memory:');
  mem.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
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

/** 在一个事务里跑 fn;抛异常则回滚。 */
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
