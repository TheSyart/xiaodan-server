// v13:学分奖惩。四张新表,全部按设备(一台设备 = 一个孩子)。
//
// 1. credit_rules    作业规则:规定用时、按时得分、超时按档扣分(有上限)、质量四档各几分、没完成扣几分;
// 2. credit_tasks    某一天布置的作业。布置时把规则参数【整份抄一份快照】——规则的数值以后可以调,
//                    但已经算过分的历史一分不能跟着变,否则家长改一次规则,孩子上个月的账全乱了;
// 3. credit_rewards  奖励目录:看电视、玩手机、买玩具……各值多少分;
// 4. credit_ledger   流水。余额就是 SUM(delta),不另存一个余额字段,永远不会对不上账;
//                    撤销 = 追加一条等额反向的流水并在原流水上记 reverted_by,原流水不删不改。
//
// 全部 mac 外键 ON DELETE CASCADE:解绑设备时一并清干净,unbindDevice 不用改。
// 只建新表、不重建被引用的表,所以不需要关外键。
// 外部接口密钥的哈希存在 settings 的 credits.open_key_hash,由接口按需写入,这里不预置。
//
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。

import type { DatabaseSync } from 'node:sqlite';

export function migrateCredits(conn: DatabaseSync): void {
  conn.exec(`
    CREATE TABLE credit_rules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      mac               TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      name              TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      sort              INTEGER NOT NULL DEFAULT 0,
      archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      target_minutes    INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 600),
      ontime_points     INTEGER NOT NULL DEFAULT 5  CHECK (ontime_points BETWEEN -100 AND 100),
      overtime_step     INTEGER NOT NULL DEFAULT 10 CHECK (overtime_step BETWEEN 1 AND 120),
      overtime_penalty  INTEGER NOT NULL DEFAULT 1  CHECK (overtime_penalty BETWEEN 0 AND 100),
      overtime_cap      INTEGER NOT NULL DEFAULT 5  CHECK (overtime_cap BETWEEN 0 AND 100),
      q_excellent       INTEGER NOT NULL DEFAULT 5  CHECK (q_excellent BETWEEN -100 AND 100),
      q_good            INTEGER NOT NULL DEFAULT 3  CHECK (q_good BETWEEN -100 AND 100),
      q_fair            INTEGER NOT NULL DEFAULT 0  CHECK (q_fair BETWEEN -100 AND 100),
      q_poor            INTEGER NOT NULL DEFAULT -2 CHECK (q_poor BETWEEN -100 AND 100),
      missed_penalty    INTEGER NOT NULL DEFAULT 5  CHECK (missed_penalty BETWEEN 0 AND 100),
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_credit_rules_mac ON credit_rules (mac, archived, sort);

    CREATE TABLE credit_tasks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      mac               TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      day               TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      rule_id           INTEGER REFERENCES credit_rules (id) ON DELETE SET NULL,
      name              TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      target_minutes    INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 600),
      ontime_points     INTEGER NOT NULL CHECK (ontime_points BETWEEN -100 AND 100),
      overtime_step     INTEGER NOT NULL CHECK (overtime_step BETWEEN 1 AND 120),
      overtime_penalty  INTEGER NOT NULL CHECK (overtime_penalty BETWEEN 0 AND 100),
      overtime_cap      INTEGER NOT NULL CHECK (overtime_cap BETWEEN 0 AND 100),
      q_excellent       INTEGER NOT NULL CHECK (q_excellent BETWEEN -100 AND 100),
      q_good            INTEGER NOT NULL CHECK (q_good BETWEEN -100 AND 100),
      q_fair            INTEGER NOT NULL CHECK (q_fair BETWEEN -100 AND 100),
      q_poor            INTEGER NOT NULL CHECK (q_poor BETWEEN -100 AND 100),
      missed_penalty    INTEGER NOT NULL CHECK (missed_penalty BETWEEN 0 AND 100),
      status            TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed')),
      actual_minutes    INTEGER CHECK (actual_minutes IS NULL OR actual_minutes BETWEEN 0 AND 1440),
      quality           TEXT    CHECK (quality IS NULL OR quality IN ('excellent', 'good', 'fair', 'poor')),
      note              TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 200),
      time_points       INTEGER,
      quality_points    INTEGER,
      total_points      INTEGER,
      scored_at         TEXT,
      ledger_id         INTEGER,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_credit_tasks_day ON credit_tasks (mac, day, id);

    CREATE TABLE credit_rewards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mac         TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      cost        INTEGER NOT NULL CHECK (cost BETWEEN 1 AND 100000),
      emoji       TEXT    NOT NULL DEFAULT '' CHECK (length(emoji) <= 8),
      sort        INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_credit_rewards_mac ON credit_rewards (mac, archived, sort);

    CREATE TABLE credit_ledger (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      mac          TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      delta        INTEGER NOT NULL CHECK (delta BETWEEN -1000000 AND 1000000),
      kind         TEXT    NOT NULL CHECK (kind IN ('task', 'missed', 'redeem', 'adjust', 'revert')),
      ref_id       INTEGER,
      title        TEXT    NOT NULL DEFAULT '' CHECK (length(title) <= 80),
      note         TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 200),
      reverted_by  INTEGER,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_credit_ledger_mac ON credit_ledger (mac, id DESC);
  `);
}
