// 数据库迁移。
//
// schema.sql 是冻结的 v0 基线,每次启动都整体执行一遍;此后表结构的一切变化都写在这里,
// 按版本号顺序执行,进度记在 PRAGMA user_version。新库与已上线的库走完全相同的路径,
// 所以不会出现"新装的形状和升级上来的形状不一样"。
//
// 迁移只进不退。回滚程序时必须连同数据备份一起恢复:旧程序遇到更新的库版本会拒绝启动。

import type { Db } from './db.ts';
import { migrateQwenOnly } from './migrations/v8-qwen-only.ts';
import { migrateCapabilityPages } from './migrations/v10-capability-pages.ts';
import { migrateRetireBuiltinSkills } from './migrations/v11-retire-builtin-skills.ts';
import { migrateMemoryAndLocation } from './migrations/v12-memory-and-location.ts';
import { migrateCredits } from './migrations/v13-credits.ts';
import { migrateCreditsApi } from './migrations/v14-credits-api.ts';

export interface Migration {
  version: number;
  name: string;
  /**
   * 在关闭外键的情况下执行(重建被引用的表时需要)。此时 ON DELETE 动作都不会触发,
   * 迁移要自己清理引用;执行完会做一次外键检查,新造出悬空引用就整体回滚。
   */
  disableForeignKeys?: boolean;
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
  {
    version: 4,
    name: 'agent-capabilities',
    up(conn) {
      conn.exec(`
        -- 外部服务:联网搜索(search)与文生图(image)的服务商配置。同一类可以配多家,默认那家生效。
        CREATE TABLE service_providers (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('search', 'image')),
          name        TEXT NOT NULL,
          provider    TEXT NOT NULL,
          config_json TEXT NOT NULL DEFAULT '{}',
          is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
          enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- MCP 服务器(只支持远程 Streamable HTTP;不跑本地命令)。headers_json 里可能有密钥,接口返回时打码。
        CREATE TABLE mcp_servers (
          id               TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          url              TEXT NOT NULL,
          headers_json     TEXT NOT NULL DEFAULT '{}',
          enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          timeout_ms       INTEGER NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
          -- 最近一次 tools/list 的结果与时间,页面展示与离线兜底用
          tools_json       TEXT NOT NULL DEFAULT '[]',
          tools_updated_at TEXT,
          last_error       TEXT NOT NULL DEFAULT '',
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- 智能体启用哪些 MCP 服务器;tool_allowlist_json 为 null 表示该服务器的工具全部可用
        CREATE TABLE agent_mcp_servers (
          agent_id            TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
          server_id           TEXT NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
          tool_allowlist_json TEXT,
          PRIMARY KEY (agent_id, server_id)
        );

        -- 技能:兼容 Agent Skills 的 SKILL.md(frontmatter 的 name/description + 正文)与附带的文本文件
        CREATE TABLE skills (
          name        TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z0-9-]*'),
          description TEXT NOT NULL,
          body        TEXT NOT NULL,
          -- {"references/words.md": "…"}
          files_json  TEXT NOT NULL DEFAULT '{}',
          -- 声明需要的工具(allowed-tools),逗号分隔,保存角色时据此提示
          allowed_tools TEXT NOT NULL DEFAULT '',
          source      TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('builtin', 'custom')),
          enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agent_skills (
          agent_id   TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
          skill_name TEXT NOT NULL REFERENCES skills (name) ON DELETE CASCADE ON UPDATE CASCADE,
          PRIMARY KEY (agent_id, skill_name)
        );

        -- 定时提醒。due_at 是 UTC 的 ISO 时间;重复提醒送达后滚到下一次
        CREATE TABLE reminders (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          mac             TEXT NOT NULL,
          agent_id        TEXT,
          text            TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
          due_at          TEXT NOT NULL,
          repeat          TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekdays', 'weekly')),
          status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'missed', 'cancelled')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          first_attempt_at TEXT,
          last_attempt_at TEXT,
          delivered_at    TEXT,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_reminders_due ON reminders (status, due_at);
        CREATE INDEX idx_reminders_mac ON reminders (mac, status);
      `);
    },
  },
  {
    version: 5,
    name: 'content-library',
    up(conn) {
      conn.exec(`
        -- 内容库:有声故事与音乐。音频文件在数据目录 media/ 下,file 是相对路径。
        -- 故事有正文,音频由控制塔用千问合成(audio_status);音乐只有文件,带许可证与署名。
        CREATE TABLE media_items (
          id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^a-z0-9-]*'),
          kind         TEXT NOT NULL CHECK (kind IN ('story', 'music')),
          title        TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          tags_json    TEXT NOT NULL DEFAULT '[]',
          summary      TEXT NOT NULL DEFAULT '',
          body         TEXT NOT NULL DEFAULT '',
          -- 给合成用的语气指令(故事)
          voice_instruction TEXT NOT NULL DEFAULT '',
          file         TEXT NOT NULL DEFAULT '',
          audio_status TEXT NOT NULL DEFAULT 'none' CHECK (audio_status IN ('none', 'pending', 'ready', 'failed')),
          audio_error  TEXT NOT NULL DEFAULT '',
          duration_s   INTEGER NOT NULL DEFAULT 0,
          age          TEXT NOT NULL DEFAULT '',
          license      TEXT NOT NULL DEFAULT '',
          source_url   TEXT NOT NULL DEFAULT '',
          attribution  TEXT NOT NULL DEFAULT '',
          builtin      INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
          enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_media_kind ON media_items (kind, enabled);

        -- 单词书与学习进度(Leitner 盒子:0 刚学,1-5 越来越熟,到期复习)
        CREATE TABLE vocab_books (
          id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^a-z0-9-]*'),
          title       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE vocab_words (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id    TEXT NOT NULL REFERENCES vocab_books (id) ON DELETE CASCADE,
          word       TEXT NOT NULL,
          meaning    TEXT NOT NULL,
          example    TEXT NOT NULL DEFAULT '',
          example_cn TEXT NOT NULL DEFAULT '',
          topic      TEXT NOT NULL DEFAULT '',
          level      INTEGER NOT NULL DEFAULT 1,
          sort       INTEGER NOT NULL DEFAULT 0,
          UNIQUE (book_id, word)
        );
        CREATE TABLE vocab_progress (
          learner      TEXT NOT NULL,
          word_id      INTEGER NOT NULL REFERENCES vocab_words (id) ON DELETE CASCADE,
          box          INTEGER NOT NULL DEFAULT 0 CHECK (box BETWEEN 0 AND 5),
          due_at       TEXT NOT NULL,
          right_count  INTEGER NOT NULL DEFAULT 0,
          wrong_count  INTEGER NOT NULL DEFAULT 0,
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (learner, word_id)
        );
        CREATE INDEX idx_vocab_progress_due ON vocab_progress (learner, due_at);
      `);
    },
  },
  {
    version: 6,
    name: 'images',
    up(conn) {
      conn.exec(`
        -- 文生图的记录。原图、像素数据与预览存在数据目录 images/<id>.*
        CREATE TABLE images (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          mac          TEXT,
          agent_id     TEXT,
          prompt       TEXT NOT NULL,
          full_prompt  TEXT NOT NULL DEFAULT '',
          provider     TEXT NOT NULL DEFAULT '',
          model        TEXT NOT NULL DEFAULT '',
          ext          TEXT NOT NULL DEFAULT 'png' CHECK (ext IN ('png', 'jpg')),
          palette_json TEXT NOT NULL DEFAULT '[]',
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_images_created ON images (created_at);
      `);
    },
  },
  {
    version: 7,
    name: 'roles-memory',
    up(conn) {
      conn.exec(`
        -- 一台设备用语音能切换到哪些角色。某台设备没有任何行时,可以切到所有由控制塔驱动(runtime = agent)的角色
        CREATE TABLE device_roles (
          mac      TEXT NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
          PRIMARY KEY (mac, agent_id)
        );

        -- 长期记忆:按设备记关于用户的事实(名字、喜好、生日……),换了角色也记得
        CREATE TABLE device_memory (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          mac        TEXT NOT NULL REFERENCES devices (mac) ON DELETE CASCADE,
          text       TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 120),
          source     TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'admin')),
          agent_id   TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_device_memory_mac ON device_memory (mac, updated_at);
      `);
    },
  },
  {
    version: 8,
    name: 'qwen-only-voices',
    disableForeignKeys: true,
    // 语音全走千问、音色自带说话设置、大脑只剩控制塔、文生图成为模型类型。步骤多,单独放一个文件。
    up: migrateQwenOnly,
  },
  {
    version: 9,
    name: 'story-timing',
    up(conn) {
      conn.exec(`
        -- 故事音频每一块的字数与实测毫秒数:[{"chars":…,"ms":…}]。讲故事时据此把原文按朗读进度显示在设备卡片上;
        -- 空串表示还没测过(老音频、手动上传的音频),播放时读文件数帧现算整段时长
        ALTER TABLE media_items ADD COLUMN timing_json TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 10,
    name: 'capability-pages',
    // 工具设置收拢成全局一份、MCP 对外工具挪到服务器级、去掉技能与 MCP 的全局启用开关。见迁移文件开头
    up: migrateCapabilityPages,
  },
  {
    version: 11,
    name: 'retire-builtin-skills',
    // 讲故事、学单词、AI 资讯各只归一类能力:删掉没改过的内置技能,MCP 服务器加使用说明。见迁移文件开头
    up: migrateRetireBuiltinSkills,
  },
  {
    version: 12,
    name: 'memory-and-location',
    disableForeignKeys: true,
    // 记忆独立成页(热记忆分类、冷记忆档案、变更留痕)与设备定位。重建了 device_memory 与 service_providers。见迁移文件开头
    up: migrateMemoryAndLocation,
  },
  {
    version: 13,
    name: 'credits',
    // 学分奖惩:作业规则、每天的作业(布置时抄规则快照)、奖励目录、流水。只建新表。见迁移文件开头
    up: migrateCredits,
  },
  {
    version: 14,
    name: 'credits-api',
    // 学分二期:多把外部密钥(一期那把搬过来)、孩子报完成、流水记来源、外部写接口防重复。只加表加列。见迁移文件开头
    up: migrateCreditsApi,
  },
];
