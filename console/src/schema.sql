-- 小单控制台持久化结构的 v0 基线。
--
-- 【此后不要再改动这里的表形状】。本文件每次启动都会整体执行一遍,全是 IF NOT EXISTS:
-- 给已有表加列不会进到已上线的库里,给新列建索引还会让启动直接失败。
-- 表结构的一切后续变化都写成 migrations.ts 里的编号迁移,进度记在 PRAGMA user_version。
-- 本文件里注释描述的是 v0 的形状,以迁移后的实际结构为准。
--
-- 对照小智官方智控台的 30 张表,这里只有 11 张。被删掉的是:多租户用户体系、
-- 短信与验证码、字典与国际化、知识库与向量库、声纹、声音克隆、MCP 接入点、
-- 智能体模板市场、OTA 固件仓库、设备通讯录。那些功能我们一个也用不上,
-- 而它们恰恰是官方版本需要 MySQL + Redis + Java 的原因。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 系统参数。服务端的 server-base 接口就是把这张表按 param_code 里的点号
-- 拆成嵌套对象返回,所以键名必须与上游一致,值的类型由 value_type 决定。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  value_type TEXT NOT NULL DEFAULT 'string'
               CHECK (value_type IN ('string', 'number', 'boolean', 'array', 'json')),
  label      TEXT NOT NULL DEFAULT '',
  -- 0 = 控制台设置页可见可改;1 = 内部项,只有服务端读,页面不展示
  internal   INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 模型配置。id 会被原样下发给服务端当 selected_module 的值,
-- 因此保持 <类型>_<名字> 的形式(如 LLM_XiaodanGateway)以便日志可读。
CREATE TABLE IF NOT EXISTS models (
  id          TEXT PRIMARY KEY,
  model_type  TEXT NOT NULL
                CHECK (model_type IN ('VAD', 'ASR', 'LLM', 'VLLM', 'TTS', 'Memory', 'Intent')),
  name        TEXT NOT NULL,
  -- 供应商代号。服务端据此加载 core/providers/<小写类型>/<provider>.py,
  -- 所以它必须与那边的文件名一致,写错的表现是"不支持的 XXX 类型"。
  provider    TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  remark      TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_models_type ON models (model_type, sort);

-- 音色。附属于某个 TTS 模型,下发时写进该模型配置的 private_voice 字段。
CREATE TABLE IF NOT EXISTS voices (
  id           TEXT PRIMARY KEY,
  tts_model_id TEXT NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  voice        TEXT NOT NULL,
  languages    TEXT NOT NULL DEFAULT '中文',
  sort         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_voices_model ON voices (tts_model_id, sort);

-- 智能体。一台设备绑定一个智能体;人设、模型组合、音色都挂在这里。
CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  system_prompt     TEXT NOT NULL DEFAULT '',
  summary_memory    TEXT,
  vad_model_id      TEXT REFERENCES models (id) ON DELETE SET NULL,
  asr_model_id      TEXT REFERENCES models (id) ON DELETE SET NULL,
  llm_model_id      TEXT REFERENCES models (id) ON DELETE SET NULL,
  vllm_model_id     TEXT REFERENCES models (id) ON DELETE SET NULL,
  tts_model_id      TEXT REFERENCES models (id) ON DELETE SET NULL,
  memory_model_id   TEXT REFERENCES models (id) ON DELETE SET NULL,
  intent_model_id   TEXT REFERENCES models (id) ON DELETE SET NULL,
  tts_voice_id      TEXT REFERENCES voices (id) ON DELETE SET NULL,
  tts_language      TEXT,
  -- 0 不记录 / 1 只记文本 / 2 记文本与音频。本控制台不做音频回放,
  -- 但值仍按上游语义下发,便于将来改主意时不用动服务端。
  chat_history_conf INTEGER NOT NULL DEFAULT 1 CHECK (chat_history_conf IN (0, 1, 2)),
  is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 智能体启用的插件及其参数。只有当智能体的意图模型不是 nointent 时才下发。
CREATE TABLE IF NOT EXISTS agent_plugins (
  agent_id    TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  plugin_code TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (agent_id, plugin_code)
);

-- 已绑定设备。mac 为主键 —— 设备端的 Device-Id 就是它的 MAC。
CREATE TABLE IF NOT EXISTS devices (
  mac               TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  alias             TEXT NOT NULL DEFAULT '',
  board             TEXT NOT NULL DEFAULT '',
  app_version       TEXT NOT NULL DEFAULT '',
  auto_update       INTEGER NOT NULL DEFAULT 0 CHECK (auto_update IN (0, 1)),
  last_connected_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 待绑定设备的验证码(v0 形状)。
--
-- 迁移 v1(device-identity)已把它替换成按 (MAC, 设备密钥哈希) 区分的新表:
-- 码只由 OTA 接口发给持有那把密钥的设备,控制塔页面不再显示,也不再能按 MAC 一键绑定。
-- 详见 migrations.ts 与 identity.ts。
CREATE TABLE IF NOT EXISTS pending_devices (
  mac         TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  board       TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_devices (expires_at);

-- 对话记录。会话由服务端给的 session_id 划分。
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mac        TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- 1 用户说的(识别结果) / 2 智能体说的 / 3 工具调用
  chat_type  INTEGER NOT NULL CHECK (chat_type IN (1, 2, 3)),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages (session_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_mac_time ON chat_messages (mac, created_at DESC);

-- 替换词。识别结果里把 source 换成 target,下发给服务端。
CREATE TABLE IF NOT EXISTS correct_words (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  source   TEXT NOT NULL,
  target   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_correct_agent ON correct_words (agent_id);

-- 单管理员。密码只存 scrypt 派生值,不可逆。
CREATE TABLE IF NOT EXISTS admin (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会话。只存 token 的 SHA-256,数据库泄露也无法反推出可用的 Cookie。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
