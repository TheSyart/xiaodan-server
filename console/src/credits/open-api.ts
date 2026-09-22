// 学分外部接口 /open/v1/credits 的挂载:CORS、接口描述、密钥守卫、防重复提交。
//
// 与 /api/credits 是同一份路由(routes.ts),这里只多套一层外部调用需要的东西:
//   - CORS 放开所有来源:认的是 Bearer 密钥、不带 Cookie,开放来源不会让别的网页借用户的登录态;
//   - openapi.json 不需要密钥,App 开发时直接拉;
//   - 两种身份:命名密钥(Authorization: Bearer,给脚本、快捷指令),或者家长 App 自己的设备身份
//     (Device-Id + Client-Id,与玩具连引擎时带的是同一对头)。App 已经像设备一样绑定过控制塔,
//     不必再让家长去建密钥;只认 board = xiaodan-app 的设备,玩具的身份调不了这套接口;
//   - 只读密钥做写操作回 403 read_only_key;
//   - 写操作带 Idempotency-Key 时,同一把密钥、同一个值 24 小时内再来,回放第一次的结果不再写库——
//     手机网络抖一下重试,不会扣两次分。
// 失败按常规回 HTTP 401/403,不学 manager-api 那套「200 + body code」(那是为了兼容上游引擎)。
// nginx 上 /open/ 要单独放行统一登录,否则外部程序会被 302 到登录页(README「学分奖惩」一节)。

import type { Hono, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Db } from '../db.ts';
import { one, run } from '../db.ts';
import { verifyAppDevice } from '../identity.ts';
import type { AppDeviceCheck } from '../identity.ts';
import { anyActiveKey, findKey, requestKey, setRequestKey, type ApiKey } from './open-key.ts';
import { buildOpenApi } from './openapi.ts';
import { creditRoutes } from './routes.ts';

export const OPEN_BASE = '/open/v1/credits';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENCY_TTL = '-1 day';

export function mountOpenCredits(app: Hono, conn: Db, now: () => Date): void {
  app.use(`${OPEN_BASE}/*`, cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Device-Id', 'Client-Id'],
    exposeHeaders: ['Idempotent-Replayed'],
    maxAge: 600,
  }));

  // 接口描述先于守卫注册:不需要密钥
  app.get(`${OPEN_BASE}/openapi.json`, (c) => c.json(buildOpenApi(OPEN_BASE)));

  app.use(`${OPEN_BASE}/*`, keyGuard(conn, now));
  app.use(`${OPEN_BASE}/*`, idempotency(conn));
  app.route(OPEN_BASE, creditRoutes(conn, {
    now,
    basePath: OPEN_BASE,
    actorOf: (c) => ({ source: 'api', actor: requestKey(c.req.raw)?.name ?? '' }),
  }));
}

/** 家长 App 的设备身份 → 学分接口认的「密钥」形状。核验本身在 identity.ts(App 的对话接口也用同一处) */
function appKeyOf(check: Extract<AppDeviceCheck, { ok: true }>): ApiKey {
  // 防重复表按 key_id 分;设备用负的 rowid,和命名密钥的正 id 不会撞
  return {
    id: -check.rowid, name: check.alias || '家长 App', prefix: '', scope: 'write',
    created_at: check.createdAt, last_used_at: null, revoked_at: null,
  };
}

function keyGuard(conn: Db, now: () => Date): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const deviceId = c.req.header('device-id');
    const clientId = c.req.header('client-id');
    if (deviceId && clientId && !c.req.header('authorization')) {
      const check = verifyAppDevice(conn, deviceId, clientId);
      if (!check.ok) return c.json({ error: check.error, code: check.code }, check.status);
      setRequestKey(c.req.raw, appKeyOf(check));
      return next();
    }
    if (!anyActiveKey(conn)) {
      return c.json({ error: '外部接口未开启:先在控制台「学分 → 开放接口」创建密钥', code: 'unauthorized' }, 404);
    }
    const auth = c.req.header('authorization') ?? '';
    const key = findKey(conn, auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', now());
    if (!key) return c.json({ error: '密钥不对或已吊销', code: 'unauthorized' }, 401);
    if (key.scope === 'read' && WRITE_METHODS.has(c.req.method)) {
      return c.json({ error: `「${key.name}」是只读密钥,不能改数据`, code: 'read_only_key' }, 403);
    }
    setRequestKey(c.req.raw, key);
    return next();
  };
}

function idempotency(conn: Db): MiddlewareHandler {
  return async (c, next) => {
    const idemKey = c.req.header('idempotency-key');
    const key = requestKey(c.req.raw);
    if (!idemKey || !key || !WRITE_METHODS.has(c.req.method)) return next();
    if (idemKey.length > 100) return c.json({ error: 'Idempotency-Key 最长 100 个字符', code: 'invalid' }, 400);

    const seen = one<{ method: string; path: string; status: number; body: string }>(conn,
      `SELECT method, path, status, body FROM credit_idempotency
       WHERE key_id = ? AND idem_key = ? AND created_at > datetime('now', ?)`, key.id, idemKey, IDEMPOTENCY_TTL);
    if (seen) {
      if (seen.method !== c.req.method || seen.path !== c.req.path) {
        return c.json({ error: '这个 Idempotency-Key 已经用在另一个请求上了', code: 'idempotency_key_reused' }, 422);
      }
      return new Response(seen.body, {
        status: seen.status,
        headers: { 'content-type': 'application/json; charset=UTF-8', 'Idempotent-Replayed': 'true' },
      });
    }

    await next();
    // 服务端出错(5xx)不记:下次重试应当真的再执行一次
    if (c.res.status >= 500) return;
    const body = await c.res.clone().text();
    run(conn, "DELETE FROM credit_idempotency WHERE created_at <= datetime('now', ?)", IDEMPOTENCY_TTL);
    run(conn,
      `INSERT INTO credit_idempotency (key_id, idem_key, method, path, status, body) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key_id, idem_key) DO UPDATE SET method = excluded.method, path = excluded.path,
         status = excluded.status, body = excluded.body, created_at = datetime('now')`,
      key.id, idemKey, c.req.method, c.req.path, c.res.status, body);
  };
}
