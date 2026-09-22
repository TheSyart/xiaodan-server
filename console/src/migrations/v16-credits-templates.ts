// v16:学分五期 —— 规则变成「常用作业模板」,打分改成家长自主赋分。重建两张表,新增一张绑定表。
//
// 1. credit_rules 重建:只留 名字 + 参考用时(target_minutes)。按时得分、超时档扣、质量四档、
//    没完成扣分这 9 个分数参数全部删掉 —— 分数不再由规则算出来,规则退化成一份常用作业清单
//    (布置时一键带出,参考用时可以临时改)。
// 2. credit_tasks 重建:布置时抄的快照只留 target_minutes(它仍是「当时要求多久」的历史事实,
//    界面上用来跟实际用时对比,但不参与算分)。结果列 time_points 改名 base_points:新模型里
//    它是家长自己给的 0–5 分,旧数据里就是原来的用时分,历史合计一分不变,旧流水标题里的解释也照旧。
//    CHECK 放宽到 ±100 是为了让旧值(超时扣成负数的)能原样搬过来;新写入由接口层校验 0–5。
//    旧的四档质量值(excellent/fair)原样留着,只作历史展示,新写入只会是 good/poor。
// 3. 新表 child_bindings:家长 App 绑哪台硬件(=哪个孩子)。一台 App 一行、一台硬件只被一台 App 绑;
//    两端都是 devices 外键,解绑设备时级联删。表名不带 credits —— 将来推送这类功能也能复用这条关系。
//
// credit_tasks.rule_id 有指向 credit_rules 的外键,重建两张表要关外键跑(迁移登记里 disableForeignKeys),
// 迁移结束由 runner 跑 PRAGMA foreign_key_check 兜底。
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。

import type { DatabaseSync } from 'node:sqlite';

export function migrateCreditsTemplates(conn: DatabaseSync): void {
  // 先记下旧账:行数与历史合计(total_points)—— 那是账面上真正算过的数。
  // 不能拿 base+quality 去对:旧模型里「没完成」的扣分来自 missed_penalty,两个分量本来就对不上。
  const before = conn.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(total_points), 0) AS sum FROM credit_tasks',
  ).get() as { n: number; sum: number };

  conn.exec(`
    -- 1. 作业规则 → 常用作业模板
    CREATE TABLE credit_rules_new (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      mac            TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      sort           INTEGER NOT NULL DEFAULT 0,
      archived       INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      target_minutes INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 600),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO credit_rules_new (id, mac, name, sort, archived, target_minutes, created_at, updated_at)
      SELECT id, mac, name, sort, archived, target_minutes, created_at, updated_at FROM credit_rules;
    DROP TABLE credit_rules;
    ALTER TABLE credit_rules_new RENAME TO credit_rules;
    CREATE INDEX idx_credit_rules_mac ON credit_rules (mac, archived, sort);

    -- 2. 作业:快照只留参考时效,time_points → base_points
    CREATE TABLE credit_tasks_new (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mac              TEXT    NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      day              TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      rule_id          INTEGER REFERENCES credit_rules (id) ON DELETE SET NULL,
      name             TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
      target_minutes   INTEGER NOT NULL CHECK (target_minutes BETWEEN 1 AND 600),
      status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed')),
      actual_minutes   INTEGER CHECK (actual_minutes IS NULL OR actual_minutes BETWEEN 0 AND 1440),
      quality          TEXT    CHECK (quality IS NULL OR quality IN ('excellent', 'good', 'fair', 'poor')),
      note             TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 200),
      base_points      INTEGER CHECK (base_points IS NULL OR base_points BETWEEN -100 AND 100),
      quality_points   INTEGER,
      total_points     INTEGER,
      scored_at        TEXT,
      ledger_id        INTEGER,
      claimed_at       TEXT,
      claim_note       TEXT    NOT NULL DEFAULT '' CHECK (length(claim_note) <= 200),
      claimed_minutes  INTEGER CHECK (claimed_minutes IS NULL OR claimed_minutes BETWEEN 0 AND 1440),
      created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO credit_tasks_new (id, mac, day, rule_id, name, target_minutes, status, actual_minutes, quality, note,
                                  base_points, quality_points, total_points, scored_at, ledger_id,
                                  claimed_at, claim_note, claimed_minutes, created_at)
      SELECT id, mac, day, rule_id, name, target_minutes, status, actual_minutes, quality, note,
             -- 已完成的:用时分就是原来的 base,合计一分不变;
             -- 没完成的:旧模型的扣分来自 missed_penalty,不是「给分 + 质量」,两个分量留空,
             -- 只保留 total_points 这个历史事实(界面上显示合计,不显示给分构成)
             CASE WHEN status = 'missed' THEN NULL ELSE time_points END,
             CASE WHEN status = 'missed' THEN NULL ELSE quality_points END,
             total_points, scored_at, ledger_id,
             claimed_at, claim_note, claimed_minutes, created_at
        FROM credit_tasks;
    DROP TABLE credit_tasks;
    ALTER TABLE credit_tasks_new RENAME TO credit_tasks;
    CREATE INDEX idx_credit_tasks_day ON credit_tasks (mac, day, id);

    -- 3. 家长 App ↔ 硬件(=孩子)
    CREATE TABLE child_bindings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      app_mac    TEXT NOT NULL UNIQUE REFERENCES devices (mac) ON DELETE CASCADE,
      child_mac  TEXT NOT NULL UNIQUE REFERENCES devices (mac) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 搬完对一遍账:行数与历史合计一分不差,对不上就让迁移失败,别把库改坏
  const after = conn.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(total_points), 0) AS sum FROM credit_tasks',
  ).get() as { n: number; sum: number };
  if (before.n !== after.n || before.sum !== after.sum) {
    throw new Error(`学分作业迁移后对不上:${before.n} 项 / 合计 ${before.sum} → ${after.n} 项 / 合计 ${after.sum}`);
  }
}
