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
  {
    version: 2,
    name: 'voice-customization',
    up(conn) {
      conn.exec(`
        -- 音色来源:system 服务商自带;design 声音设计(一段文字描述生成);clone 声音复刻(一段录音生成)。
        -- 后两种在百炼侧有审核,状态从 pending 变成 ok 才能用于合成;failed 表示审核未过或创建失败。
        ALTER TABLE voices ADD COLUMN kind TEXT NOT NULL DEFAULT 'system'
          CHECK (kind IN ('system', 'design', 'clone'));
        ALTER TABLE voices ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'
          CHECK (status IN ('ok', 'pending', 'failed'));
        -- 给人看的说明,例如「女 · 5 岁 · 儿童陪伴」;tags 逗号分隔,用于筛选(如「儿童」)
        ALTER TABLE voices ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE voices ADD COLUMN tags TEXT NOT NULL DEFAULT '';
        -- 声音设计用的文字描述;复刻时留空
        ALTER TABLE voices ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
        -- 复刻样本在数据目录里的文件名(voice-samples/ 下),便于重新复刻;其余为空
        ALTER TABLE voices ADD COLUMN sample_file TEXT NOT NULL DEFAULT '';
        -- 最近一次状态查询或创建失败的原因
        ALTER TABLE voices ADD COLUMN status_detail TEXT NOT NULL DEFAULT '';
        -- ADD COLUMN 不允许非常量默认值,创建时间由写入方填
        ALTER TABLE voices ADD COLUMN created_at TEXT;

        -- 按智能体调的合成参数:{"rate":1.0,"pitch":1.0,"volume":50,"instruction":"…"}。
        -- 只对千问合成生效,下发时合进 TTS 配置;其他服务商的同名参数含义不同,不合并。
        ALTER TABLE agents ADD COLUMN tts_params_json TEXT NOT NULL DEFAULT '{}';
      `);
    },
  },
  {
    version: 3,
    name: 'agent-runtime',
    up(conn) {
      conn.exec(`
        -- 智能体(角色)的大脑在哪:engine 旧路径,由引擎按函数调用跑工具;agent 新路径,由控制塔的智能体运行时跑多步循环。
        -- 已有智能体保持 engine,在智能体页手动切换,切回去即回退。
        ALTER TABLE agents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'engine' CHECK (runtime IN ('engine', 'agent'));
        -- 一轮对话里最多调几次模型带工具(之后再强制回答一次)
        ALTER TABLE agents ADD COLUMN max_steps INTEGER NOT NULL DEFAULT 6 CHECK (max_steps BETWEEN 1 AND 10);
        -- child:提示词加儿童安全约束,内容类工具按儿童标准过滤
        ALTER TABLE agents ADD COLUMN safety_level TEXT NOT NULL DEFAULT 'standard' CHECK (safety_level IN ('standard', 'child'));
        -- 模型参数:{"thinking":false,"temperature":0.8}
        ALTER TABLE agents ADD COLUMN llm_params_json TEXT NOT NULL DEFAULT '{}';
        -- 给人看的一句话介绍;切换角色时模型据此挑选
        ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';
        -- 从哪个角色模板创建的,仅作标记
        ALTER TABLE agents ADD COLUMN role_template TEXT NOT NULL DEFAULT '';
        -- 切换到这个角色后的第一句招呼
        ALTER TABLE agents ADD COLUMN greeting TEXT NOT NULL DEFAULT '';

        -- 对话记录属于哪个智能体:同一台设备换过角色后仍能区分
        ALTER TABLE chat_messages ADD COLUMN agent_id TEXT;
        CREATE INDEX idx_chat_messages_agent ON chat_messages (agent_id, created_at);
      `);
      // 两项引擎参数的默认值不适合按键说话的设备,只在用户没改过(仍是旧默认值)时调整:
      //   exit_commands「退出;关闭」:用户说"关闭"(比如想关掉音乐)会被引擎当成退出指令直接断线;
      //   close_connection_no_voice_time 120:设备每 150 秒空闲重连,120 到 150 秒之间按键说话会被当成闲置、先念告别语。
      conn.exec(`
        UPDATE settings SET value = '', updated_at = datetime('now') WHERE key = 'exit_commands' AND value = '退出;关闭';
        UPDATE settings SET value = '600', updated_at = datetime('now') WHERE key = 'close_connection_no_voice_time' AND value = '120';
      `);
    },
  },
];
