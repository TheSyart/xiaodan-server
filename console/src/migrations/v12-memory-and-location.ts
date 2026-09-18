// 迁移 v12:长期记忆独立成页(热记忆分类、冷记忆档案),以及设备定位。
//
//   1. device_memory 重建:文字上限从 120 放宽到 200,新增 kind(分类)、sensitive(住址与联系方式这类)、
//      arc_id(从哪段对话补录的),source 允许 'archive'。老数据全部通过过旧版一刀切的隐私拦截,
//      按构造就是非敏感的,所以 kind 取 'other'、sensitive 取 0;分类由用户在记忆页改或下次归档顺手纠正。
//   2. 新表 memory_arcs:每段对话的档案(标题、摘要、要点、关键词)。原文仍在 chat_messages 里,
//      靠新列 chat_messages.arc_id 关联;arc_id IS NULL 就是归档器的工作队列,不另建队列表。
//   3. 新表 memory_changes:记忆的每次变更留痕,记忆页据此回溯与撤销(归档时的更正与补录直接生效)。
//   4. 新表 device_locations:每台设备最新一次定位结果。只存最新一条,不做轨迹;BSSID 一个字节都不落库。
//      devices 加 locate 开关(默认关)。
//   5. service_providers 重建:kind 的 CHECK 加 'locate'(定位服务商)。
//   6. settings 写入 memory.archive_from = 迁移执行时刻:归档器只处理这之后的消息,
//      不回溯库里已有的历史(那会瞬间烧掉大量 token,价值也低)。要补档就把这个时间往前调。
//
// 不 import 业务模块里会变的逻辑:迁移一旦上线就要冻结。

import type { DatabaseSync } from 'node:sqlite';

export function migrateMemoryAndLocation(conn: DatabaseSync): void {
  conn.exec(`
    -- 1. 热记忆:关于用户的事实。按设备记,换了角色也共用
    CREATE TABLE device_memory_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      mac        TEXT NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      text       TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
      -- 称呼与身份 / 家人与宠物 / 联系方式 / 住址与常去的地方 / 喜好 / 学习 / 健康与忌口 / 作息与日程
      kind       TEXT NOT NULL DEFAULT 'other' CHECK (kind IN
                   ('profile', 'relation', 'contact', 'place', 'preference', 'learning', 'health', 'routine', 'other')),
      -- 1 = 住址、联系方式这类:页面上默认打码,提示词里不带原文,模型要用时调回忆函数取
      sensitive  INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
      source     TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'admin', 'archive')),
      agent_id   TEXT,
      arc_id     INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO device_memory_new (id, mac, text, source, agent_id, created_at, updated_at)
      SELECT id, mac, text, source, agent_id, created_at, updated_at FROM device_memory;
    DROP TABLE device_memory;
    ALTER TABLE device_memory_new RENAME TO device_memory;
    CREATE INDEX idx_device_memory_mac ON device_memory (mac, updated_at);

    -- 2. 冷记忆:一段对话(同一台设备、相邻消息间隔不超过 30 分钟)的档案
    CREATE TABLE memory_arcs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 与 chat_messages 一致不加外键:设备解绑后档案还在,由解绑流程显式清理
      mac          TEXT NOT NULL,
      agent_id     TEXT,
      title        TEXT NOT NULL DEFAULT '',
      summary      TEXT NOT NULL DEFAULT '',
      bullets_json TEXT NOT NULL DEFAULT '[]',
      topics_json  TEXT NOT NULL DEFAULT '[]',
      -- 标题、摘要、要点、关键词拼起来,检索用
      search_text  TEXT NOT NULL DEFAULT '',
      started_at   TEXT NOT NULL,
      ended_at     TEXT NOT NULL,
      duration_s   INTEGER NOT NULL DEFAULT 0,
      turns        INTEGER NOT NULL DEFAULT 0,
      messages     INTEGER NOT NULL DEFAULT 0,
      -- 这段对话跨了几次 WebSocket 连接(设备空闲 150 秒就重连一次)
      sessions     INTEGER NOT NULL DEFAULT 1,
      -- pending 已认领待整理 / ready 有摘要 / failed 待重试 / skipped 不整理或放弃 / raw_gone 原文已按保留策略清掉
      status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'ready', 'failed', 'skipped', 'raw_gone')),
      error        TEXT NOT NULL DEFAULT '',
      attempts     INTEGER NOT NULL DEFAULT 0,
      model_id     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_arcs_mac_time ON memory_arcs (mac, ended_at DESC);
    CREATE INDEX idx_arcs_pending ON memory_arcs (status, updated_at);

    -- 原文归属哪段档案;NULL 就是还没归档,归档器据此取活
    ALTER TABLE chat_messages ADD COLUMN arc_id INTEGER;
    CREATE INDEX idx_chat_arc ON chat_messages (arc_id, id);

    -- 3. 记忆的变更留痕:谁在什么时候改了什么,页面上可回溯、可一键撤销
    CREATE TABLE memory_changes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mac         TEXT NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
      op          TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),
      fact_id     INTEGER,
      before_text TEXT NOT NULL DEFAULT '',
      after_text  TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL DEFAULT 'other',
      sensitive   INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
      reason      TEXT NOT NULL DEFAULT '',
      source      TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'admin', 'archive')),
      arc_id      INTEGER,
      agent_id    TEXT,
      undone      INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_memory_changes_mac ON memory_changes (mac, created_at DESC);

    -- 4. 定位:每台设备只留最新一条。坐标是高德坐标系(GCJ-02);IP 兜底时没有坐标,只有省市
    CREATE TABLE device_locations (
      mac        TEXT PRIMARY KEY REFERENCES devices (mac) ON DELETE CASCADE,
      source     TEXT NOT NULL CHECK (source IN ('wifi', 'ip')),
      lng        REAL,
      lat        REAL,
      -- 定位精度半径(米);0 = 未知
      radius     INTEGER NOT NULL DEFAULT 0,
      province   TEXT NOT NULL DEFAULT '',
      city       TEXT NOT NULL DEFAULT '',
      district   TEXT NOT NULL DEFAULT '',
      address    TEXT NOT NULL DEFAULT '',
      ap_count   INTEGER NOT NULL DEFAULT 0,
      provider   TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      located_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 这台设备允不允许定位。默认关:位置是这个项目里第一份会落库的隐私数据
    ALTER TABLE devices ADD COLUMN locate INTEGER NOT NULL DEFAULT 0 CHECK (locate IN (0, 1));

    -- 5. 服务商多一类:定位。CHECK 改不了,只能重建
    CREATE TABLE service_providers_new (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('search', 'image', 'locate')),
      name        TEXT NOT NULL,
      provider    TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO service_providers_new SELECT * FROM service_providers;
    DROP TABLE service_providers;
    ALTER TABLE service_providers_new RENAME TO service_providers;
  `);

  // 6. 归档水位线:只整理这之后的对话
  conn.prepare(
    `INSERT INTO settings (key, value, value_type, label, internal) VALUES (?, datetime('now'), 'string', ?, 1)
     ON CONFLICT (key) DO NOTHING`,
  ).run('memory.archive_from', '记忆归档的起点(这之前的对话不整理)');
}
