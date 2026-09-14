// 控制台页面用的管理接口。与 manager-api 的区别:这里用 Cookie 会话鉴权,
// 用真实 HTTP 状态码,入参一律经 zod 校验。

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from './db.ts';
import { all, one, run, tx } from './db.ts';
import { MODEL_TYPES, PLUGINS, PROVIDERS, providerDef, type ModelType } from './catalog.ts';
import { DEFAULT_SETTINGS, readAllSettings } from './settings.ts';
import { SECRET_KEY } from './seed.ts';
import {
  authMode, authorized, clearCookie, isInitialized, issueCookie, login, logout, requireAuth,
  sessionToken, setAdmin,
} from './auth.ts';
import { bindByCode, canonicalMac, unbindDevice } from './identity.ts';

const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u, 'id 只能包含字母、数字、下划线与连字符');

/** 输错绑定码的限流。计数只在内存里,进程重启即清零 —— 它防的是在线穷举,不是持久封禁。 */
const BIND_FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_BIND_FAILURES = 10;

/** 固件只接受 wss:// 的对话服务地址。 */
function isWssUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.hostname !== '';
  } catch {
    return false;
  }
}

const modelTypeSchema = z.enum(MODEL_TYPES as [ModelType, ...ModelType[]]);

const modelSchema = z.object({
  id: idSchema,
  model_type: modelTypeSchema,
  name: z.string().min(1).max(64),
  provider: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()).default({}),
  remark: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
});

const agentSchema = z.object({
  name: z.string().min(1).max(64),
  system_prompt: z.string().max(8000).default(''),
  vad_model_id: idSchema.nullish(),
  asr_model_id: idSchema.nullish(),
  llm_model_id: idSchema.nullish(),
  vllm_model_id: idSchema.nullish(),
  tts_model_id: idSchema.nullish(),
  memory_model_id: idSchema.nullish(),
  intent_model_id: idSchema.nullish(),
  tts_voice_id: idSchema.nullish(),
  tts_language: z.string().max(32).nullish(),
  chat_history_conf: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
});

const nullable = (value: string | null | undefined) => (value === undefined || value === '' ? null : value);

export function adminApi(conn: Db): Hono {
  const app = new Hono({ strict: false });

  // ---- 无需登录 ----

  app.get('/setup/status', (c) =>
    c.json({
      mode: authMode(),
      // proxy 模式下没有本地账号概念:前端据此直接进主界面,不显示登录页。
      initialized: authMode() === 'proxy' ? true : isInitialized(conn),
      authenticated: authorized(conn, c),
    }),
  );

  // 首次设置管理员。只在还没有管理员时可用 —— 否则就成了任何人都能改密码的后门。
  app.post('/setup', async (c) => {
    if (authMode() === 'proxy') return c.json({ error: '本部署由运维面板统一鉴权,控制台不再管理账号' }, 404);
    if (isInitialized(conn)) return c.json({ error: '已经初始化过了' }, 409);
    const parsed = z
      .object({ username: z.string().min(1).max(64), password: z.string().min(8).max(256) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '用户名不能为空,密码至少 8 位' }, 400);

    setAdmin(conn, parsed.data.username, parsed.data.password);
    const token = login(conn, parsed.data.username, parsed.data.password);
    if (token) issueCookie(c, token);
    return c.json({ ok: true });
  });

  app.post('/login', async (c) => {
    if (authMode() === 'proxy') return c.json({ error: '本部署由运维面板统一鉴权,无需在此登录' }, 404);
    const parsed = z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '请填写用户名与密码' }, 400);

    const token = login(conn, parsed.data.username, parsed.data.password);
    // 不区分"用户名不存在"与"密码错误",避免用它来枚举
    if (!token) return c.json({ error: '用户名或密码不正确' }, 401);
    issueCookie(c, token);
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    logout(conn, sessionToken(c));
    clearCookie(c);
    return c.json({ ok: true });
  });

  // ---- 以下都需要登录 ----
  const OPEN_PATHS = new Set(['/api/setup', '/api/setup/status', '/api/login', '/api/logout']);
  app.use('/*', async (c, next) => {
    if (OPEN_PATHS.has(new URL(c.req.url).pathname)) return next();
    return requireAuth(conn)(c, next);
  });

  /** 供应商与插件目录。前端据此渲染表单,不必把字段定义硬编码两遍。 */
  app.get('/catalog', (c) => c.json({ providers: PROVIDERS, plugins: PLUGINS, modelTypes: MODEL_TYPES }));

  // ---- 系统参数 ----

  app.get('/settings', (c) => {
    const internalKeys = new Set(DEFAULT_SETTINGS.filter((d) => d.internal).map((d) => d.key));
    const rows = all<{ key: string; value: string; value_type: string; label: string; internal: number }>(
      conn,
      'SELECT key, value, value_type, label, internal FROM settings ORDER BY key',
    );
    return c.json({
      items: rows.filter((row) => row.internal === 0 && !internalKeys.has(row.key)),
      // 密钥单独给,前端用不同的控件展示(默认打码 + 复制按钮)
      secret: one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)?.value ?? '',
    });
  });

  app.put('/settings', async (c) => {
    const parsed = z.record(z.string(), z.string()).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);
    const ws = parsed.data['server.websocket']?.trim();
    // 设备拿到 ws:// 或其他形式的地址会拒绝连接并一直停在重试页,在这里就挡住。
    if (ws !== undefined && ws !== '' && !isWssUrl(ws)) {
      return c.json({ error: '设备连接地址必须是 wss:// 开头的完整地址' }, 400);
    }
    tx(conn, () => {
      for (const [key, value] of Object.entries(parsed.data)) {
        // 密钥有专用的轮换接口,不允许从这里改成任意值
        if (key === SECRET_KEY) continue;
        run(
          conn,
          "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?",
          key === 'server.websocket' ? ws : value,
          key,
        );
      }
    });
    return c.json({ ok: true });
  });

  app.post('/settings/secret/rotate', (c) => {
    const secret = randomBytes(24).toString('base64url');
    run(conn, "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", secret, SECRET_KEY);
    // 轮换后服务端会立刻鉴权失败,必须同步改它的 .config.yaml 并重启,
    // 这一点在前端会以警告形式提示。
    return c.json({ secret });
  });

  // ---- 模型 ----

  app.get('/models', (c) => {
    const rows = all(
      conn,
      `SELECT id, model_type, name, provider, config_json, is_default, enabled, remark
       FROM models ORDER BY model_type, sort, id`,
    );
    return c.json({ items: rows });
  });

  const upsertModel = (payload: z.infer<typeof modelSchema>, creating: boolean) => {
    const def = providerDef(payload.model_type, payload.provider);
    if (!def) throw new Error(`${payload.model_type} 没有名为 ${payload.provider} 的供应商`);

    // type 必须写进 config:服务端就是靠它决定加载哪个 provider 模块的。
    const config = { ...payload.config, type: payload.provider };

    if (creating) {
      run(
        conn,
        `INSERT INTO models (id, model_type, name, provider, config_json, enabled, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        payload.id, payload.model_type, payload.name, payload.provider,
        JSON.stringify(config), payload.enabled ? 1 : 0, payload.remark,
      );
    } else {
      run(
        conn,
        `UPDATE models SET name = ?, provider = ?, config_json = ?, enabled = ?, remark = ?,
                           updated_at = datetime('now')
         WHERE id = ?`,
        payload.name, payload.provider, JSON.stringify(config),
        payload.enabled ? 1 : 0, payload.remark, payload.id,
      );
    }
  };

  app.post('/models', async (c) => {
    const parsed = modelSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    if (one(conn, 'SELECT 1 FROM models WHERE id = ?', parsed.data.id)) {
      return c.json({ error: '这个 id 已经存在' }, 409);
    }
    try {
      upsertModel(parsed.data, true);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  app.put('/models/:id', async (c) => {
    const id = c.req.param('id');
    if (!one(conn, 'SELECT 1 FROM models WHERE id = ?', id)) return c.json({ error: '模型不存在' }, 404);
    const parsed = modelSchema.safeParse({ ...(await c.req.json().catch(() => ({}))), id });
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    try {
      upsertModel(parsed.data, false);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  app.post('/models/:id/default', (c) => {
    const id = c.req.param('id');
    const row = one<{ model_type: string }>(conn, 'SELECT model_type FROM models WHERE id = ?', id);
    if (!row) return c.json({ error: '模型不存在' }, 404);
    tx(conn, () => {
      run(conn, 'UPDATE models SET is_default = 0 WHERE model_type = ?', row.model_type);
      run(conn, 'UPDATE models SET is_default = 1 WHERE id = ?', id);
    });
    return c.json({ ok: true });
  });

  app.delete('/models/:id', (c) => {
    const id = c.req.param('id');
    // 正被智能体引用的模型不能删,否则设备连上来会拿到一份缺模块的配置。
    //
    // 这里用七个普通的 ? 而不是重复的 ?1:node:sqlite 不支持编号占位符复用,
    // 会抛 "column index out of range",接口就变成 500 而不是友好的提示。
    const used = one<{ n: number }>(
      conn,
      `SELECT COUNT(*) AS n FROM agents
       WHERE vad_model_id = ? OR asr_model_id = ? OR llm_model_id = ? OR vllm_model_id = ?
          OR tts_model_id = ? OR memory_model_id = ? OR intent_model_id = ?`,
      id, id, id, id, id, id, id,
    );
    if ((used?.n ?? 0) > 0) return c.json({ error: '还有智能体在用这个模型,请先改掉它们的选择' }, 409);
    run(conn, 'DELETE FROM models WHERE id = ?', id);
    return c.json({ ok: true });
  });

  // ---- 音色 ----

  app.get('/voices', (c) =>
    c.json({
      items: all(conn, 'SELECT id, tts_model_id, name, voice, languages FROM voices ORDER BY tts_model_id, sort, id'),
    }),
  );

  app.post('/voices', async (c) => {
    const parsed = z
      .object({
        id: idSchema,
        tts_model_id: idSchema,
        name: z.string().min(1).max(64),
        voice: z.string().min(1).max(128),
        languages: z.string().max(64).default('中文'),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    if (!one(conn, "SELECT 1 FROM models WHERE id = ? AND model_type = 'TTS'", parsed.data.tts_model_id)) {
      return c.json({ error: '指定的 TTS 模型不存在' }, 400);
    }
    run(
      conn,
      'INSERT OR REPLACE INTO voices (id, tts_model_id, name, voice, languages) VALUES (?, ?, ?, ?, ?)',
      parsed.data.id, parsed.data.tts_model_id, parsed.data.name, parsed.data.voice, parsed.data.languages,
    );
    return c.json({ ok: true });
  });

  app.delete('/voices/:id', (c) => {
    run(conn, 'DELETE FROM voices WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  // ---- 智能体 ----

  app.get('/agents', (c) => {
    const agents = all<{ id: string }>(conn, 'SELECT * FROM agents ORDER BY is_default DESC, created_at');
    const items = agents.map((agent) => ({
      ...agent,
      plugins: all(conn, 'SELECT plugin_code, params_json FROM agent_plugins WHERE agent_id = ?', agent.id),
      device_count: one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM devices WHERE agent_id = ?', agent.id)?.n ?? 0,
    }));
    return c.json({ items });
  });

  app.post('/agents', async (c) => {
    const parsed = agentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const id = `agent_${randomBytes(8).toString('hex')}`;
    const d = parsed.data;
    run(
      conn,
      `INSERT INTO agents (id, name, system_prompt, vad_model_id, asr_model_id, llm_model_id, vllm_model_id,
                           tts_model_id, memory_model_id, intent_model_id, tts_voice_id, tts_language,
                           chat_history_conf, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      id, d.name, d.system_prompt, nullable(d.vad_model_id), nullable(d.asr_model_id), nullable(d.llm_model_id),
      nullable(d.vllm_model_id), nullable(d.tts_model_id), nullable(d.memory_model_id), nullable(d.intent_model_id),
      nullable(d.tts_voice_id), nullable(d.tts_language), d.chat_history_conf,
    );
    return c.json({ ok: true, id });
  });

  app.put('/agents/:id', async (c) => {
    const id = c.req.param('id');
    if (!one(conn, 'SELECT 1 FROM agents WHERE id = ?', id)) return c.json({ error: '智能体不存在' }, 404);
    const parsed = agentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    run(
      conn,
      `UPDATE agents SET name = ?, system_prompt = ?, vad_model_id = ?, asr_model_id = ?, llm_model_id = ?,
                         vllm_model_id = ?, tts_model_id = ?, memory_model_id = ?, intent_model_id = ?,
                         tts_voice_id = ?, tts_language = ?, chat_history_conf = ?, updated_at = datetime('now')
       WHERE id = ?`,
      d.name, d.system_prompt, nullable(d.vad_model_id), nullable(d.asr_model_id), nullable(d.llm_model_id),
      nullable(d.vllm_model_id), nullable(d.tts_model_id), nullable(d.memory_model_id), nullable(d.intent_model_id),
      nullable(d.tts_voice_id), nullable(d.tts_language), d.chat_history_conf, id,
    );
    return c.json({ ok: true });
  });

  app.delete('/agents/:id', (c) => {
    const id = c.req.param('id');
    const agent = one<{ is_default: number }>(conn, 'SELECT is_default FROM agents WHERE id = ?', id);
    if (!agent) return c.json({ error: '智能体不存在' }, 404);
    if (agent.is_default === 1) return c.json({ error: '默认智能体不能删除' }, 409);
    const devices = one<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM devices WHERE agent_id = ?', id);
    if ((devices?.n ?? 0) > 0) return c.json({ error: '还有设备绑定在这个智能体上' }, 409);
    run(conn, 'DELETE FROM agents WHERE id = ?', id);
    return c.json({ ok: true });
  });

  /** 整体覆盖某个智能体启用的插件。 */
  app.put('/agents/:id/plugins', async (c) => {
    const id = c.req.param('id');
    if (!one(conn, 'SELECT 1 FROM agents WHERE id = ?', id)) return c.json({ error: '智能体不存在' }, 404);
    const parsed = z
      .array(z.object({ plugin_code: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()).default({}) }))
      .safeParse(await c.req.json().catch(() => []));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);

    const known = new Set(PLUGINS.map((p) => p.code));
    const unknown = parsed.data.find((item) => !known.has(item.plugin_code));
    if (unknown) return c.json({ error: `没有名为 ${unknown.plugin_code} 的插件` }, 400);

    tx(conn, () => {
      run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', id);
      for (const item of parsed.data) {
        run(
          conn,
          'INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, ?)',
          id, item.plugin_code, JSON.stringify(item.params),
        );
      }
    });
    return c.json({ ok: true });
  });

  // ---- 设备 ----
  //
  // 绑定只认设备屏幕上显示的六位码。码对应的是 (MAC, 设备密钥) 这一对,只有拿着设备的人才看得到,
  // 所以这里的任何响应都不返回绑定码、密钥哈希或哈希指纹 —— 否则控制塔本身就成了冒充者取码的地方。

  app.get('/devices', (c) =>
    c.json({
      items: all(
        conn,
        `SELECT d.mac, d.agent_id, d.alias, d.board, d.app_version, d.last_connected_at, d.created_at,
                CASE WHEN d.secret_hash IS NULL THEN 'legacy' ELSE 'verified' END AS identity,
                a.name AS agent_name
         FROM devices d LEFT JOIN agents a ON a.id = d.agent_id
         ORDER BY d.last_connected_at DESC, d.created_at DESC`,
      ),
      pending: all(
        conn,
        `SELECT p.id, p.mac, p.board, p.app_version, p.created_at, p.last_seen_at, p.expires_at,
                (SELECT COUNT(*) FROM pending_devices q
                 WHERE q.mac = p.mac AND q.expires_at > datetime('now')) AS same_mac_count
         FROM pending_devices p WHERE p.expires_at > datetime('now')
         ORDER BY p.last_seen_at DESC, p.id DESC`,
      ),
      events: all(
        conn,
        `SELECT id, mac, kind, source, count, first_seen_at, last_seen_at
         FROM identity_events ORDER BY last_seen_at DESC, id DESC LIMIT 50`,
      ),
    }),
  );

  let bindFailures: number[] = [];

  /**
   * 按设备屏幕上的六位码绑定。
   *
   * 不再接受按 MAC 绑定:MAC 是公开的,按它绑定等于谁先来要码就把设备交给谁。
   * 不指定智能体时,新设备绑到默认智能体,升级前绑定的旧设备保留原来的智能体。
   */
  app.post('/devices/bind', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    if (typeof body === 'object' && body !== null && 'mac' in body) {
      return c.json({ error: '只能输入设备屏幕上显示的六位绑定码来绑定' }, 400);
    }
    const parsed = z
      .object({
        code: z.string().regex(/^\d{6}$/u, '绑定码是六位数字'),
        agent_id: idSchema.optional(),
        alias: z.string().max(64).default(''),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);

    const now = Date.now();
    bindFailures = bindFailures.filter((at) => now - at < BIND_FAILURE_WINDOW_MS);
    if (bindFailures.length >= MAX_BIND_FAILURES) {
      const retryAfter = Math.ceil((bindFailures[0]! + BIND_FAILURE_WINDOW_MS - now) / 1000);
      c.header('Retry-After', String(Math.max(1, retryAfter)));
      return c.json({ error: '绑定码输错次数过多,请几分钟后再试' }, 429);
    }

    const { code, agent_id: agentId, alias } = parsed.data;
    if (agentId && !one(conn, 'SELECT 1 FROM agents WHERE id = ?', agentId)) {
      return c.json({ error: '智能体不存在' }, 400);
    }

    const result = tx(conn, () => bindByCode(conn, { code, agentId: agentId ?? null, alias }));
    if (!result.ok) {
      if (result.status === 404) bindFailures.push(now);
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ ok: true, mac: result.mac });
  });

  app.put('/devices/:mac', async (c) => {
    const mac = canonicalMac(c.req.param('mac'));
    const parsed = z
      .object({ alias: z.string().max(64).optional(), agent_id: idSchema.optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    if (!mac || !one(conn, 'SELECT 1 FROM devices WHERE mac = ?', mac)) return c.json({ error: '设备不存在' }, 404);
    if (parsed.data.agent_id && !one(conn, 'SELECT 1 FROM agents WHERE id = ?', parsed.data.agent_id)) {
      return c.json({ error: '智能体不存在' }, 400);
    }
    if (parsed.data.alias !== undefined) run(conn, 'UPDATE devices SET alias = ? WHERE mac = ?', parsed.data.alias, mac);
    if (parsed.data.agent_id) run(conn, 'UPDATE devices SET agent_id = ? WHERE mac = ?', parsed.data.agent_id, mac);
    return c.json({ ok: true });
  });

  /** 清除一条待绑定记录。设备若还开着,下次询问时会重新拿到一个码。 */
  app.delete('/devices/pending/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || !one(conn, 'SELECT 1 FROM pending_devices WHERE id = ?', id)) {
      return c.json({ error: '这条待绑定记录不存在或已过期' }, 404);
    }
    run(conn, 'DELETE FROM pending_devices WHERE id = ?', id);
    return c.json({ ok: true });
  });

  /** 解绑。设备的密钥哈希随设备行一起删除,该 MAC 的待绑定记录与身份事件一并清空。 */
  app.delete('/devices/:mac', (c) => {
    const mac = canonicalMac(c.req.param('mac'));
    const existed = mac ? tx(conn, () => unbindDevice(conn, mac)) : false;
    if (!existed) return c.json({ error: '设备不存在' }, 404);
    return c.json({ ok: true });
  });

  /** 清除身份异常记录。带 mac 只清这台,不带则全部清除。 */
  app.delete('/identity-events', (c) => {
    const raw = c.req.query('mac');
    if (raw === undefined || raw === '') {
      run(conn, 'DELETE FROM identity_events');
      return c.json({ ok: true });
    }
    const mac = canonicalMac(raw);
    if (!mac) return c.json({ error: 'MAC 地址格式不正确' }, 400);
    run(conn, 'DELETE FROM identity_events WHERE mac = ?', mac);
    return c.json({ ok: true });
  });

  // ---- 对话记录 ----

  app.get('/chats', (c) => {
    const mac = c.req.query('mac');
    const rows = mac
      ? all(
          conn,
          `SELECT session_id, mac, COUNT(*) AS messages, MIN(created_at) AS started_at, MAX(created_at) AS ended_at
           FROM chat_messages WHERE mac = ? GROUP BY session_id, mac ORDER BY ended_at DESC LIMIT 100`,
          mac,
        )
      : all(
          conn,
          `SELECT session_id, mac, COUNT(*) AS messages, MIN(created_at) AS started_at, MAX(created_at) AS ended_at
           FROM chat_messages GROUP BY session_id, mac ORDER BY ended_at DESC LIMIT 100`,
        );
    return c.json({ items: rows });
  });

  app.get('/chats/:sessionId', (c) =>
    c.json({
      items: all(
        conn,
        'SELECT id, chat_type, content, created_at FROM chat_messages WHERE session_id = ? ORDER BY id',
        c.req.param('sessionId'),
      ),
    }),
  );

  app.delete('/chats/:sessionId', (c) => {
    run(conn, 'DELETE FROM chat_messages WHERE session_id = ?', c.req.param('sessionId'));
    return c.json({ ok: true });
  });

  // ---- 替换词 ----

  app.get('/correct-words', (c) =>
    c.json({ items: all(conn, 'SELECT id, agent_id, source, target FROM correct_words ORDER BY agent_id, id') }),
  );

  app.post('/correct-words', async (c) => {
    const parsed = z
      .object({ agent_id: idSchema, source: z.string().min(1).max(64), target: z.string().min(1).max(64) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '参数不正确' }, 400);
    run(
      conn,
      'INSERT INTO correct_words (agent_id, source, target) VALUES (?, ?, ?)',
      parsed.data.agent_id, parsed.data.source, parsed.data.target,
    );
    return c.json({ ok: true });
  });

  app.delete('/correct-words/:id', (c) => {
    run(conn, 'DELETE FROM correct_words WHERE id = ?', Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // ---- 概览 ----

  app.get('/overview', (c) => {
    const count = (sql: string) => one<{ n: number }>(conn, sql)?.n ?? 0;
    return c.json({
      devices: count('SELECT COUNT(*) AS n FROM devices'),
      pending: count("SELECT COUNT(*) AS n FROM pending_devices WHERE expires_at > datetime('now')"),
      agents: count('SELECT COUNT(*) AS n FROM agents'),
      models: count('SELECT COUNT(*) AS n FROM models WHERE enabled = 1'),
      messages: count('SELECT COUNT(*) AS n FROM chat_messages'),
      settings: readAllSettings(conn).length,
    });
  });

  return app;
}
