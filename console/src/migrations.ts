// 数据库迁移。
//
// schema.sql 是冻结的 v0 基线,每次启动都整体执行一遍;此后表结构的一切变化都写在这里,
// 按版本号顺序执行,进度记在 PRAGMA user_version。新库与已上线的库走完全相同的路径,
// 所以不会出现"新装的形状和升级上来的形状不一样"。
//
// 迁移只进不退。回滚程序时必须连同数据备份一起恢复:旧程序遇到更新的库版本会拒绝启动。

import type { Db } from './db.ts';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Db) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'device-identity',
    up(conn) {
      conn.exec(`
        -- 已绑定设备的密钥哈希。身份机制上线前就绑定的设备这里是 NULL,须重新配对。
        ALTER TABLE devices ADD COLUMN secret_hash TEXT
          CHECK (secret_hash IS NULL OR (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'));

        -- 待绑定表改为按 (MAC, 密钥哈希) 区分:同一个 MAC 下不同密钥各有各的码。
        -- SQLite 不能原地改主键,只能建新表替换。旧的待绑定行没有身份信息,无法满足新规则,直接丢弃;
        -- 设备下次来问时会重新拿到码。
        CREATE TABLE pending_devices_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          mac          TEXT NOT NULL,
          secret_hash  TEXT NOT NULL CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
          code         TEXT NOT NULL UNIQUE CHECK (length(code) = 6 AND code NOT GLOB '*[^0-9]*'),
          board        TEXT NOT NULL DEFAULT '',
          app_version  TEXT NOT NULL DEFAULT '',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at   TEXT NOT NULL,
          UNIQUE (mac, secret_hash)
        );
        DROP TABLE pending_devices;
        ALTER TABLE pending_devices_new RENAME TO pending_devices;
        -- 与 schema.sql 里的索引同名,让基线里那句 CREATE INDEX IF NOT EXISTS 继续是空操作。
        CREATE INDEX idx_pending_expires ON pending_devices (expires_at);
        CREATE INDEX idx_pending_mac ON pending_devices (mac);
        CREATE INDEX idx_pending_created ON pending_devices (created_at);

        -- 身份异常:冒充、缺少身份、旧设备未重新配对。控制塔页面据此提示用户。
        CREATE TABLE identity_events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          mac           TEXT NOT NULL,
          kind          TEXT NOT NULL CHECK (kind IN ('mismatch', 'missing_identity', 'legacy_unverified')),
          source        TEXT NOT NULL CHECK (source IN ('ota', 'engine')),
          -- 所出示哈希的前 12 位,无则为空;同一 MAC 指纹过多时合并为 '*'
          client_fp     TEXT NOT NULL DEFAULT '',
          count         INTEGER NOT NULL DEFAULT 1,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (mac, kind, source, client_fp)
        );
        CREATE INDEX idx_identity_events_seen ON identity_events (last_seen_at);
      `);
    },
  },
];
