// v15:学分四期 —— 奖励按比例整份兑换(10 分 = 5 分钟游戏 / 5 元钱),时间与钱各记余额。只加列加表,不重建表。
//
// 1. credit_rewards  加 kind(item 物品 / time 时间 / money 零花钱)与 amount(一份换多少,按基本单位:
//                    时间是分钟、钱是「分」=1/100 元,物品恒为 1)。老奖励自动是 item × 1,行为和以前一样。
// 2. credit_ledger   加 times:这次兑换了几份。
// 3. credit_wallet   时间与钱的余额账户流水,一个奖励一个账户(游戏的分钟和电视的分钟分开算)。
//                    余额 = SUM(qty),不另存;兑换进账关联那笔学分流水(ledger_id),用掉 / 花掉、调整、撤销各记一笔。
//                    和学分流水同一套规矩:只追加,撤销是追加反向记录并在原记录上记 reverted_by。
//
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。

import type { DatabaseSync } from 'node:sqlite';

export function migrateCreditsWallet(conn: DatabaseSync): void {
  conn.exec(`
    ALTER TABLE credit_rewards ADD COLUMN kind TEXT NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'time', 'money'));
    ALTER TABLE credit_rewards ADD COLUMN amount INTEGER NOT NULL DEFAULT 1 CHECK (amount BETWEEN 1 AND 10000000);

    ALTER TABLE credit_ledger ADD COLUMN times INTEGER CHECK (times IS NULL OR times BETWEEN 1 AND 100);

    CREATE TABLE credit_wallet (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      mac          TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      reward_id    INTEGER NOT NULL,
      qty          INTEGER NOT NULL CHECK (qty BETWEEN -100000000 AND 100000000),
      kind         TEXT    NOT NULL CHECK (kind IN ('redeem', 'use', 'adjust', 'revert')),
      ledger_id    INTEGER,
      ref_id       INTEGER,
      title        TEXT    NOT NULL DEFAULT '' CHECK (length(title) <= 80),
      note         TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 200),
      reverted_by  INTEGER,
      source       TEXT    NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'api', 'agent')),
      actor        TEXT    NOT NULL DEFAULT '' CHECK (length(actor) <= 40),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_credit_wallet_mac ON credit_wallet (mac, id DESC);
    CREATE INDEX idx_credit_wallet_reward ON credit_wallet (reward_id, id DESC);
    CREATE INDEX idx_credit_wallet_ledger ON credit_wallet (ledger_id);
  `);
}
