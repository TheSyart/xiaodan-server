// 小智服务端 → 控制台 的接口。这是整个项目的核心契约。
//
// 服务端(Python)的 config/manage_api_client.py 用固定的 base_url + Bearer 调这些路径。
// 只要这里的响应形状对,服务端一行都不用改 —— 本文件的每个字段都对照过上游
// Java 版 ConfigServiceImpl / DeviceServiceImpl 的行为,以及服务端消费这些字段的
// core/connection.py。
//
// 约定:HTTP 状态码永远 200,成败靠 body 里的 code。这是上游的做法,服务端的
// _async_request 也是按 code 判断的(只识别 0、10041、10042),所以必须照做。

import { Hono } from 'hono';
import type { Db } from './db.ts';
import { all, one, run } from './db.ts';
import { nestSettings, readAllSettings } from './settings.ts';
import { SECRET_KEY } from './seed.ts';

/** 服务端会识别的两个业务错误码。其余 code 一律被它当作通用异常。 */
const CODE_DEVICE_NOT_FOUND = 10041;
const CODE_DEVICE_NEED_BIND = 10042;

/** 绑定码有效期。太短会让用户还没走到电脑前就失效。 */
const BIND_CODE_TTL_MINUTES = 60;

interface ModelRow {
  id: string;
  model_type: string;
  config_json: string;
}

interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  summary_memory: string | null;
  vad_model_id: string | null;
  asr_model_id: string | null;
  llm_model_id: string | null;
  vllm_model_id: string | null;
  tts_model_id: string | null;
  memory_model_id: string | null;
  intent_model_id: string | null;
  tts_voice_id: string | null;
  tts_language: string | null;
  chat_history_conf: number;
}

const ok = (data: unknown) => ({ code: 0, msg: 'success', data });
const fail = (code: number, msg: string) => ({ code, msg, data: null });

function parseConfig(row: ModelRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadModel(conn: Db, id: string | null | undefined): ModelRow | undefined {
  if (!id) return undefined;
  return one<ModelRow>(conn, 'SELECT id, model_type, config_json FROM models WHERE id = ? AND enabled = 1', id);
}

/**
 * 组装一份"模块配置"。产物形如:
 *   { LLM: { LLM_Gateway: {...} }, TTS: { TTS_Omni: {...} }, selected_module: { LLM: 'LLM_Gateway', … } }
 *
 * `skip` 里的类型会被整个略过 —— 用于服务端已经实例化过同一个模型的情况,
 * 省掉一次重复加载(VAD 要载模型文件,重载一次代价不小)。
 */
function buildModules(
  conn: Db,
  agent: AgentRow,
  skip: ReadonlySet<string>,
  voice: string | undefined,
  language: string | undefined,
): Record<string, unknown> {
  // LLM 不在这张表里,它在循环之后单独处理 —— 因为 Intent/Memory 可能各自
  // 挂一个辅助 LLM 放进同一个桶,若在这里用赋值写入就会把它们覆盖掉。
  const pairs: [string, string | null][] = [
    ['VAD', agent.vad_model_id],
    ['ASR', agent.asr_model_id],
    ['TTS', agent.tts_model_id],
    ['Memory', agent.memory_model_id],
    ['Intent', agent.intent_model_id],
    ['VLLM', agent.vllm_model_id],
  ];

  const result: Record<string, unknown> = {};
  const selected: Record<string, string> = {};

  for (const [type, modelId] of pairs) {
    if (!modelId || skip.has(type)) continue;
    const row = loadModel(conn, modelId);
    if (!row) continue;
    const config = parseConfig(row);

    if (type === 'TTS') {
      // 智能体选的音色覆盖模型上配的默认音色。服务端的 TTS provider 一律
      // 优先读 private_voice,读不到才回落到 voice。
      if (voice) config['private_voice'] = voice;
      if (language) config['language'] = language;
    }

    if (type === 'Intent') {
      // functions 在库里存成分号分隔的串,服务端要的是数组。
      const functions = config['functions'];
      if (typeof functions === 'string') {
        config['functions'] = functions
          .split(';')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
    }

    result[type] = { [row.id]: config };
    selected[type] = row.id;

    // 意图与记忆模块可以再挂一个 LLM 做子任务(判意图 / 压缩历史)。
    // 服务端按 id 去 config["LLM"] 里找,所以那个 id 必须一并下发,
    // 否则它会因为找不到而回落到主 LLM —— 静默但行为不对。
    if ((type === 'Intent' || type === 'Memory') && typeof config['llm'] === 'string') {
      const helperId = config['llm'];
      if (helperId && helperId !== agent.llm_model_id) {
        const helper = loadModel(conn, helperId);
        if (helper) {
          const bucket = (result['LLM'] as Record<string, unknown> | undefined) ?? {};
          bucket[helper.id] = parseConfig(helper);
          result['LLM'] = bucket;
        }
      }
    }
  }

  // 主 LLM 要合进可能已被 Intent/Memory 预置的那个桶里,不能直接覆盖。
  if (agent.llm_model_id && !skip.has('LLM')) {
    const row = loadModel(conn, agent.llm_model_id);
    if (row) {
      const bucket = (result['LLM'] as Record<string, unknown> | undefined) ?? {};
      bucket[row.id] = parseConfig(row);
      result['LLM'] = bucket;
      selected['LLM'] = row.id;
    }
  }

  result['selected_module'] = selected;
  return result;
}

function agentVoice(conn: Db, agent: AgentRow): { voice?: string; language?: string } {
  if (!agent.tts_voice_id) return {};
  const row = one<{ voice: string; languages: string }>(
    conn,
    'SELECT voice, languages FROM voices WHERE id = ?',
    agent.tts_voice_id,
  );
  if (!row) return {};
  const language = agent.tts_language ?? row.languages.split('、')[0]?.trim();
  return language ? { voice: row.voice, language } : { voice: row.voice };
}

/** 六位数字绑定码,避开已被占用的值。 */
function newBindCode(conn: Db): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    if (!one(conn, 'SELECT 1 FROM pending_devices WHERE code = ?', code)) return code;
  }
  throw new Error('无法生成未被占用的绑定码');
}

/**
 * 取(或创建)一台未绑定设备的绑定码。
 *
 * 这是本控制台与官方智控台最重要的一处行为差异。官方只在设备调用 OTA 接口时
 * 才生成绑定码;而我们自研的固件直接连 WebSocket、从不调 OTA,于是在官方那边
 * 设备永远拿不到码 —— 实测返回的是 10041,设备会念"没有找到该设备的版本信息,
 * 请正确配置 OTA 地址",而用户按提示去配 OTA 也解决不了。
 *
 * 这里改成:服务端为未知设备取配置时就地生成,并把 MAC 记进待绑定列表,
 * 让用户在控制台上直接看到"哪台设备在等绑定、码是多少",不必再去听设备念。
 */
export function ensureBindCode(conn: Db, mac: string): string {
  const existing = one<{ code: string }>(
    conn,
    "SELECT code FROM pending_devices WHERE mac = ? AND expires_at > datetime('now')",
    mac,
  );
  if (existing) return existing.code;

  run(conn, 'DELETE FROM pending_devices WHERE mac = ?', mac);
  const code = newBindCode(conn);
  run(
    conn,
    `INSERT INTO pending_devices (mac, code, expires_at)
     VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))`,
    mac,
    code,
    BIND_CODE_TTL_MINUTES,
  );
  return code;
}

export function managerApi(conn: Db): Hono {
  const app = new Hono({ strict: false });

  // Bearer 鉴权。密钥存在参数表里,可在设置页轮换。
  //
  // 刻意【不用】通配 '*':本应用与 OTA 路由都挂在 /xiaozhi 前缀下,通配会连
  // /xiaozhi/ota/ 一起拦掉,而设备调 OTA 时没有也不可能有 Bearer。
  // 只守这三个前缀,正好是服务端会调的全部路径。
  const guard = async (c: Parameters<Parameters<Hono['use']>[1]>[0], next: () => Promise<void>) => {
    const secret = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)?.value;
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!secret || token !== secret) {
      // 照上游:HTTP 200 + body 里的 401。服务端只看 code。
      return c.json(fail(401, '无效的服务器密钥'));
    }
    await next();
    return undefined;
  };
  app.use('/config/*', guard);
  app.use('/agent/*', guard);
  app.use('/device/*', guard);

  // ---- 服务端启动时拉一次的基础配置 ----
  app.post('/config/server-base', (c) => {
    const config = nestSettings(readAllSettings(conn));

    // 服务端在没有具体设备上下文时也需要能起 VAD/ASR,所以这里把默认智能体的
    // 这两项一并下发。上游用的是"默认智能体模板",我们用标记了 is_default 的智能体。
    const agent = one<AgentRow>(conn, 'SELECT * FROM agents WHERE is_default = 1 LIMIT 1')
      ?? one<AgentRow>(conn, 'SELECT * FROM agents ORDER BY created_at LIMIT 1');

    if (agent) {
      const modules = buildModules(
        conn,
        { ...agent, llm_model_id: null, vllm_model_id: null, tts_model_id: null,
          memory_model_id: null, intent_model_id: null },
        new Set(),
        undefined,
        undefined,
      );
      Object.assign(config, modules);
    } else {
      config['selected_module'] = {};
    }

    // 这两个键服务端会读,没有设备上下文时必须显式为 null,不能缺。
    config['prompt'] = null;
    config['summaryMemory'] = null;
    return c.json(ok(config));
  });

  // ---- 每台设备连上来时拉一次的差异化配置 ----
  app.post('/config/agent-models', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      macAddress?: string;
      selectedModule?: Record<string, string>;
    };
    const mac = (body.macAddress ?? '').trim();
    if (!mac) return c.json(fail(CODE_DEVICE_NOT_FOUND, '缺少设备标识'));

    const device = one<{ mac: string; agent_id: string }>(
      conn,
      'SELECT mac, agent_id FROM devices WHERE mac = ?',
      mac,
    );

    if (!device) {
      // 未绑定:给出绑定码,设备会把它念出来,控制台也会列出来。
      const code = ensureBindCode(conn, mac);
      return c.json(fail(CODE_DEVICE_NEED_BIND, code));
    }

    const agent = one<AgentRow>(conn, 'SELECT * FROM agents WHERE id = ?', device.agent_id);
    if (!agent) return c.json(fail(CODE_DEVICE_NOT_FOUND, '设备绑定的智能体已不存在'));

    run(conn, "UPDATE devices SET last_connected_at = datetime('now') WHERE mac = ?", mac);

    // 服务端已经实例化过同一个模型的类型不必重发。只有 VAD/ASR 值得这样省 ——
    // 它们要加载模型文件,重载代价高;其余模块都是轻量的 HTTP 客户端。
    const already = body.selectedModule ?? {};
    const skip = new Set<string>();
    if (already['VAD'] && already['VAD'] === agent.vad_model_id) skip.add('VAD');
    if (already['ASR'] && already['ASR'] === agent.asr_model_id) skip.add('ASR');

    const { voice, language } = agentVoice(conn, agent);
    const result: Record<string, unknown> = buildModules(conn, agent, skip, voice, language);

    const maxOutput = one<{ value: string }>(
      conn,
      "SELECT value FROM settings WHERE key = 'device_max_output_size'",
    )?.value;
    // 上游这里给的是字符串,服务端用 int() 包了一层,两种都能吃。保持一致。
    result['device_max_output_size'] = maxOutput ?? '0';
    result['chat_history_conf'] = agent.chat_history_conf;

    // 插件只在启用了工具调用时才下发。服务端会用 plugins 的键去展开可调函数列表,
    // 在 nointent 模式下发过去反而会让它注册出一堆调不动的工具。
    const intentModel = loadModel(conn, agent.intent_model_id);
    const intentType = intentModel ? String(parseConfig(intentModel)['type'] ?? '') : 'nointent';
    if (intentType && intentType !== 'nointent') {
      const rows = all<{ plugin_code: string; params_json: string }>(
        conn,
        'SELECT plugin_code, params_json FROM agent_plugins WHERE agent_id = ?',
        agent.id,
      );
      if (rows.length > 0) {
        const plugins: Record<string, string> = {};
        // 值是【JSON 字符串】而不是对象:服务端拿到后会自己 json.loads 一次。
        for (const row of rows) plugins[row.plugin_code] = row.params_json;
        result['plugins'] = plugins;
      }
    }

    result['prompt'] = agent.system_prompt.replaceAll('{{assistant_name}}', agent.name || '小单');
    result['summaryMemory'] = agent.summary_memory;

    return c.json(ok(result));
  });

  // ---- 识别结果的替换词 ----
  app.post('/config/correct-words', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { macAddress?: string };
    const mac = (body.macAddress ?? '').trim();
    if (!mac) return c.json(ok([]));
    const rows = all<{ source: string; target: string }>(
      conn,
      `SELECT w.source, w.target FROM correct_words w
       JOIN devices d ON d.agent_id = w.agent_id
       WHERE d.mac = ?`,
      mac,
    );
    return c.json(ok(rows.map((row) => `${row.source}|${row.target}`)));
  });

  // ---- 对话记录上报 ----
  app.post('/agent/chat-history/report', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      macAddress?: string;
      sessionId?: string;
      chatType?: number;
      content?: string;
    };
    const mac = (body.macAddress ?? '').trim();
    const sessionId = (body.sessionId ?? '').trim();
    const chatType = Number(body.chatType);
    const content = body.content ?? '';

    if (!mac || !sessionId || ![1, 2, 3].includes(chatType) || !content) {
      return c.json(ok(false));
    }
    // audioBase64 会一并送来,这里【不存】:一句话约 100KB,而我们不做音频回放,
    // 存下来只会让数据目录无限增长,备份也跟着变慢。
    run(
      conn,
      'INSERT INTO chat_messages (mac, session_id, chat_type, content) VALUES (?, ?, ?, ?)',
      mac,
      sessionId,
      chatType,
      content,
    );
    return c.json(ok(true));
  });

  // ---- 会话摘要与标题 ----
  // 服务端在连接结束时会调,失败只打日志不影响对话。我们不做自动摘要
  // (那需要再花一次 LLM 调用),直接确认即可。
  app.post('/agent/chat-summary/:sessionId/save', (c) => c.json(ok(null)));
  app.post('/agent/chat-title/:sessionId/generate', (c) => c.json(ok(null)));

  // ---- 设备互呼通讯录 ----
  // 只有一台设备,没有互呼场景。返回空,服务端会安静地跳过。
  app.get('/device/address-book/lookup', (c) => c.json(ok(null)));

  return app;
}
