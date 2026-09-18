// 小智服务端 → 控制台 的接口。这是整个项目的核心契约。
//
// 服务端(Python)的 config/manage_api_client.py 用固定的 base_url + Bearer 调这些路径。
// 只要这里的响应形状对,服务端一行都不用改 —— 本文件的每个字段都对照过上游
// Java 版 ConfigServiceImpl / DeviceServiceImpl 的行为,以及服务端消费这些字段的
// core/connection.py。
//
// 约定:HTTP 状态码永远 200,成败靠 body 里的 code。这是上游的做法,服务端的
// _async_request 也是按 code 判断的(只识别 0、10041、10042),所以必须照做。

import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Db } from './db.ts';
import { all, one, run, tx } from './db.ts';
import { nestSettings, readAllSettings } from './settings.ts';
import { SECRET_KEY } from './seed.ts';
import { agentToken } from './agent/token.ts';
import { ttsOverrides } from './voice/profile.ts';
import { defaultVoiceOf, modelFamily, resolveVoice } from './voice/store.ts';
import { defaultSystemVoice } from './voice/system-voices.ts';
import { onDeviceConfigFetched } from './agent/hooks.ts';
import { nudgeArchive } from './agent/memory/archive.ts';
import { locateEnabled, noteScan } from './agent/locate/store.ts';
import {
  canonicalMac, findPendingCode, hashClientId, parseClientId, recordIdentityEvent, resolveDevice,
} from './identity.ts';

/** 服务端会识别的两个业务错误码。其余 code 一律被它当作通用异常。 */
const CODE_DEVICE_NOT_FOUND = 10041;
const CODE_DEVICE_NEED_BIND = 10042;

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
  tts_voice_id: string | null;
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

/** 智能体选的模型;没选或已停用时用这一类的默认模型 */
function modelOrDefault(conn: Db, type: 'VAD' | 'ASR', id: string | null | undefined): ModelRow | undefined {
  return loadModel(conn, id)
    ?? one<ModelRow>(conn, 'SELECT id, model_type, config_json FROM models WHERE model_type = ? AND enabled = 1 ORDER BY is_default DESC, id LIMIT 1', type);
}

/**
 * 组装引擎要的「模块配置」。产物形如:
 *   { VAD: { VAD_SileroVAD: {...} }, ASR: {...}, TTS: { TTS_Qwen: {...} }, selected_module: { VAD: 'VAD_SileroVAD', … } }
 *
 * 引擎只负责听与说:对话模型、意图、记忆在 applyAgentRuntime 里固定成转发到控制塔与空实现。
 * 引擎报上来的 `already`(它已经实例化的模块)里有同一个 VAD/ASR 时不重发 —— VAD 要载模型文件,重载代价不小。
 */
function buildModules(conn: Db, agent: AgentRow, already: Record<string, string>, withTts: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const selected: Record<string, string> = {};

  for (const [type, id] of [['VAD', agent.vad_model_id], ['ASR', agent.asr_model_id]] as const) {
    const row = modelOrDefault(conn, type, id);
    if (!row || already[type] === row.id) continue;
    result[type] = { [row.id]: parseConfig(row) };
    selected[type] = row.id;
  }

  if (withTts) {
    // 合成模型由音色决定;音色自带音量、语速、方言与语气(合成语气指令)和允许的情感标签。
    // 选的音色用不了(审核中、模型停用、与模型不符)时退到默认千问合成模型的默认音色。
    const resolved = resolveVoice(conn, agent.tts_voice_id);
    if (resolved) {
      const config: Record<string, unknown> = { ...resolved.model.config, type: resolved.model.provider };
      delete config['voice'];
      if (resolved.voice) Object.assign(config, ttsOverrides(resolved.voice));
      else config['private_voice'] = (defaultVoiceOf(conn, resolved.model)?.voice) ?? defaultSystemVoice(modelFamily(resolved.model)).voice;
      result['TTS'] = { [resolved.model.id]: config };
      selected['TTS'] = resolved.model.id;
    }
  }

  result['selected_module'] = selected;
  return result;
}

/**
 * 大脑在控制塔:引擎只保留听、说与设备桥。
 *   - LLM 换成 xiaodan_agent provider,一轮对话交给控制塔的 /xiaodan/agent/turn;令牌按设备签发;
 *   - Intent 固定 nointent、Memory 固定 nomem:工具、记忆都在控制塔,引擎再调一遍只会重复;
 *   - 不下发插件,对话记录由控制塔自己写(引擎再上报会重复)。
 */
function applyAgentRuntime(conn: Db, result: Record<string, unknown>, mac: string): void {
  const setting = (key: string) => one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? '';
  const secret = setting(SECRET_KEY);
  const selected = { ...((result['selected_module'] as Record<string, string> | undefined) ?? {}) };
  result['LLM'] = {
    LLM_XiaodanAgent: {
      type: 'xiaodan_agent',
      url: setting('agent.turn_url') || 'http://console:8002/xiaodan/agent/turn',
      api_key: agentToken(secret, mac),
      media_secret: secret,
    },
  };
  selected['LLM'] = 'LLM_XiaodanAgent';
  result['Intent'] = { Intent_nointent: { type: 'nointent' } };
  selected['Intent'] = 'Intent_nointent';
  result['Memory'] = { Memory_nomem: { type: 'nomem' } };
  selected['Memory'] = 'Memory_nomem';
  result['selected_module'] = selected;
  delete result['plugins'];
  result['chat_history_conf'] = 0;
  // 引擎仍会把它放进自己的系统消息,但控制塔不读;留一句便于看日志时认出来
  result['prompt'] = '(本智能体由控制塔的智能体运行时驱动,系统提示词在控制塔组装)';
}

/** 比较前先各自取摘要:两边长度恒为 32 字节,timingSafeEqual 才能用,也不泄露密钥长度。 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
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
    if (!secret || !timingSafeEqual(digest(token), digest(secret))) {
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
      Object.assign(config, buildModules(conn, agent, {}, false));
    } else {
      config['selected_module'] = {};
    }

    // 这两个键服务端会读,没有设备上下文时必须显式为 null,不能缺。
    config['prompt'] = null;
    config['summaryMemory'] = null;
    return c.json(ok(config));
  });

  // ---- 每台设备连上来时拉一次的差异化配置 ----
  //
  // 引擎把设备的 Client-Id 请求头原样放进 clientId 转过来,这里据此核验身份。
  //
  // 拒绝一律回 10041:它让引擎念一句固定的、不泄露任何信息的提示,并丢弃这条连接的全部消息。
  // 不回 10042 —— 那要求给一个六位码,而造码只应走 OTA 且受限流;给冒充者造的码也永远用不上
  // (那个 MAC 已经绑定)。更不要用其他错误码:引擎把它们当通用异常,行为没有验证过。
  app.post('/config/agent-models', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      macAddress?: unknown;
      clientId?: unknown;
      selectedModule?: Record<string, string>;
    };
    const mac = canonicalMac(body.macAddress);
    if (!mac) return c.json(fail(CODE_DEVICE_NOT_FOUND, '缺少或无法识别的设备标识'));
    const clientId = parseClientId(body.clientId);
    const hash = clientId ? hashClientId(clientId) : null;

    const decision = tx(conn, (): { agentId: string } | { bindCode: string } | { refused: true } => {
      const identity = resolveDevice(conn, mac, hash);
      switch (identity.kind) {
        case 'verified':
          run(conn, "UPDATE devices SET last_connected_at = datetime('now') WHERE mac = ?", mac);
          return { agentId: identity.agentId };
        case 'unknown': {
          // 这里只读不造码。设备没先走 OTA 就直接连进来,说明它不是走新流程的固件,
          // 回 10041,引擎会念"请正确配置 OTA 地址",对这种情况恰好是对的提示。
          const code = hash ? findPendingCode(conn, mac, hash) : undefined;
          return code ? { bindCode: code } : { refused: true };
        }
        case 'legacy':
          recordIdentityEvent(conn, { mac, kind: 'legacy_unverified', source: 'engine', hash });
          return { refused: true };
        case 'missing':
          recordIdentityEvent(conn, { mac, kind: 'missing_identity', source: 'engine', hash: null });
          return { refused: true };
        case 'mismatch':
          recordIdentityEvent(conn, { mac, kind: 'mismatch', source: 'engine', hash });
          return { refused: true };
        default:
          return { refused: true };
      }
    });

    if ('refused' in decision) return c.json(fail(CODE_DEVICE_NOT_FOUND, '设备未通过身份校验'));
    if ('bindCode' in decision) return c.json(fail(CODE_DEVICE_NEED_BIND, decision.bindCode));

    const agent = one<AgentRow>(conn, 'SELECT * FROM agents WHERE id = ?', decision.agentId);
    if (!agent) return c.json(fail(CODE_DEVICE_NOT_FOUND, '设备绑定的智能体已不存在'));

    const result: Record<string, unknown> = buildModules(conn, agent, body.selectedModule ?? {}, true);

    const maxOutput = one<{ value: string }>(
      conn,
      "SELECT value FROM settings WHERE key = 'device_max_output_size'",
    )?.value;
    // 上游这里给的是字符串,服务端用 int() 包了一层,两种都能吃。保持一致。
    result['device_max_output_size'] = maxOutput ?? '0';
    result['summaryMemory'] = agent.summary_memory;
    applyAgentRuntime(conn, result, mac);
    // 设备每次连接都会来取配置:借这个时机补报错过的提醒等(见 agent/hooks.ts),不阻塞响应
    onDeviceConfigFetched(mac, agent.id);

    return c.json(ok(result));
  });

  // ---- 识别结果的替换词 ----
  app.post('/config/correct-words', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { macAddress?: unknown };
    const mac = canonicalMac(body.macAddress);
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
      macAddress?: unknown;
      sessionId?: string;
      chatType?: number;
      content?: string;
    };
    const mac = canonicalMac(body.macAddress);
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

  // ---- 设备报上来的东西:现在只有定位用的 Wi-Fi 热点 ----
  //
  // 引擎收到设备上行的热点后转到这里(Bearer 是与引擎共用的那串密钥,上面的守卫已经验过)。
  // **热点只放进内存队列**,由后台解析成位置;BSSID 一个字节都不落库。
  app.post('/agent/device-report', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { macAddress?: unknown; self?: unknown; aps?: unknown };
    const mac = canonicalMac(body.macAddress);
    if (!mac) return c.json(fail(CODE_DEVICE_NOT_FOUND, '缺少或无法识别的设备标识'));
    if (!locateEnabled(conn, mac)) return c.json(ok(false));   // 没开定位就直接丢掉
    const parse = (value: unknown) => {
      const [bssid, rssi] = String(value ?? '').split(',');
      const clean = (bssid ?? '').trim().toLowerCase().replace(/[:-]/gu, '');
      const strength = Number(rssi);
      return /^[0-9a-f]{12}$/u.test(clean) && Number.isFinite(strength) && strength <= 0 && strength >= -113
        ? { bssid: clean, rssi: Math.round(strength) } : null;
    };
    const aps = (Array.isArray(body.aps) ? body.aps : []).slice(0, 30).map(parse).filter((item) => item !== null);
    if (!aps.length) return c.json(fail(CODE_DEVICE_NOT_FOUND, '没有可用的热点'));
    noteScan(mac, { self: parse(body.self), aps });
    return c.json(ok(true));
  });

  // ---- 会话摘要与标题 ----
  // 服务端在连接结束时会调,失败只打日志不影响对话。这是控制塔唯一能及时知道「这次连接结束了」的时机:
  // 只往内存里记一个待办(必须同步返回,引擎是在关连接的路上调的),整理对话档案的活由后台定时器做。
  app.post('/agent/chat-summary/:sessionId/save', (c) => {
    nudgeArchive(c.req.param('sessionId'));
    return c.json(ok(null));
  });
  app.post('/agent/chat-title/:sessionId/generate', (c) => {
    nudgeArchive(c.req.param('sessionId'));
    return c.json(ok(null));
  });

  // ---- 设备互呼通讯录 ----
  // 只有一台设备,没有互呼场景。返回空,服务端会安静地跳过。
  app.get('/device/address-book/lookup', (c) => c.json(ok(null)));

  return app;
}
