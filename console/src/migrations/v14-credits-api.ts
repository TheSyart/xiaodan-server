// v14:学分二期 —— 给 App 用的 v1 接口、多把外部密钥、孩子报完成、流水记来源。只加表加列,不重建表。
//
// 1. credit_api_keys  多把命名密钥,各自只读/可写、单独吊销。库里只存 SHA-256,明文只在创建时返回一次。
//                     一期的单把密钥(settings 行 credits.open_key,JSON 里的 hash)搬成一行「默认密钥」(可写),
//                     原来的明文照样能用;然后删掉那个 settings 行。
// 2. credit_tasks     加 claimed_at / claim_note / claimed_minutes:孩子通过智能体说「做完了」。
//                     状态仍是 pending(不改 CHECK,免得重建表),等家长检查后录入结果才算分。
// 3. credit_ledger    加 source('admin' 页面 | 'api' 外部密钥 | 'agent' 智能体)与 actor(密钥名、角色名):
//                     每一笔都看得出是谁、从哪儿动的。老流水都是页面上做的,默认 admin 正好。
// 4. credit_idempotency  外部写接口的 Idempotency-Key:同一把密钥、同一个值再来,回放第一次的结果不再写库。
//
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。

import type { DatabaseSync } from 'node:sqlite';

export function migrateCreditsApi(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE credit_api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      prefix        TEXT    NOT NULL DEFAULT '',
      hash          TEXT    NOT NULL UNIQUE CHECK (length(hash) = 64),
      scope         TEXT    NOT NULL DEFAULT 'write' CHECK (scope IN ('read', 'write')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used_at  TEXT,
      revoked_at    TEXT
    );

    ALTER TABLE credit_tasks ADD COLUMN claimed_at TEXT;
    ALTER TABLE credit_tasks ADD COLUMN claim_note TEXT NOT NULL DEFAULT '' CHECK (length(claim_note) <= 200);
    ALTER TABLE credit_tasks ADD COLUMN claimed_minutes INTEGER CHECK (claimed_minutes IS NULL OR claimed_minutes BETWEEN 0 AND 1440);

    ALTER TABLE credit_ledger ADD COLUMN source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'api', 'agent'));
    ALTER TABLE credit_ledger ADD COLUMN actor TEXT NOT NULL DEFAULT '' CHECK (length(actor) <= 40);

    CREATE TABLE credit_idempotency (
      key_id      INTEGER NOT NULL,
      idem_key    TEXT    NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 100),
      method      TEXT    NOT NULL,
      path        TEXT    NOT NULL,
      status      INTEGER NOT NULL,
      body        TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key_id, idem_key)
    );
  `);

  // 一期的单把密钥搬过来
  const row = conn.prepare("SELECT value FROM settings WHERE key = 'credits.open_key'").get() as { value: string } | undefined;
  if (row?.value) {
    try {
      const old = JSON.parse(row.value) as { hash?: unknown; created_at?: unknown; last_used_at?: unknown };
      if (typeof old.hash === 'string' && /^[0-9a-f]{64}$/u.test(old.hash)) {
        conn.prepare(
          `INSERT INTO credit_api_keys (name, prefix, hash, scope, created_at, last_used_at)
           VALUES ('默认密钥', 'xdc_', ?, 'write', COALESCE(?, datetime('now')), ?)`,
        ).run(old.hash, typeof old.created_at === 'string' ? old.created_at : null,
          typeof old.last_used_at === 'string' ? old.last_used_at : null);
      }
    } catch {
      // 坏数据就当没开过外部接口
    }
  }
  conn.exec("DELETE FROM settings WHERE key = 'credits.open_key'");
}
