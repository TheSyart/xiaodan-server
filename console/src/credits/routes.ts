// 学分接口 v1。同一份路由挂两处:
//   /api/credits/*      控制台页面用,走 /api 的登录守卫(运维面板的统一登录);
//   /open/v1/credits/*  外部程序用(App、手机快捷指令、脚本),按 Bearer 密钥鉴权,见 app.ts。
// 密钥的增删改只挂在 /api 下:外部密钥不能自己给自己换权限。
//
// 给调用方的约定(openapi.json 里也写着):
//   - 改动同时认 PATCH 与 PUT,都是部分更新;
//   - 错误体 {error: 中文说明, code: 机器可读代码},HTTP 状态 400/403/404/409/422;
//   - 列表 {items, next},带 before 游标翻页,limit 最大 100;
//   - MAC 冒号、连字符、12 位紧凑写法都认,拼进 URL 请用紧凑写法(运维面板会误判 %3A)。

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { all, one } from '../db.ts';
import { canonicalMac } from '../identity.ts';
import { buildOpenApi } from './openapi.ts';
import { createKey, keyById, listKeys, renameKey, revokeKey } from './open-key.ts';
import { QUALITIES, QUALITY_LABEL, scoreResult } from './score.ts';
import {
  adjustBody, examplesBody, keyCreate, keyUpdate, LEDGER_KINDS, redeemBody, reorderBody, rewardCreate, rewardUpdate,
  RULE_RANGES, ruleCreate, rulePreview, ruleUpdate, taskAssign, taskClaim, taskCustom, taskMissed, taskResult,
  TASK_STATUSES, taskUpdate, day as daySchema,
} from './schemas.ts';
import {
  ADMIN, CreditError, adjust, assignTasks, balance, childView, claimTask, createCustomTask, createReward, createRule,
  daySummary, deleteReward, deleteRule, deleteTask, ledgerById, ledgerPage, listRewards, listRules, listTasks, missTask,
  pendingClaims, previewTask, queryTasks, redeem, reorder, requireReward, requireRule, requireTask, restoreReward,
  restoreRule, revert, scoreTask, seedExamples, shiftDay, stats, today, unclaimTask, updateReward, updateRule, updateTask,
  type Actor, type LedgerKind, type TaskStatusFilter,
} from './store.ts';

export interface CreditRouteOptions {
  now?: (() => Date) | undefined;
  /** 只在 /api 下为 true:挂上密钥管理接口 */
  keyAdmin?: boolean;
  /** 这一次请求是谁:页面、哪把外部密钥。写流水时记下来 */
  actorOf?: (c: Context) => Actor;
  /** 挂载的前缀,写进 openapi.json 的 servers */
  basePath?: string;
}

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? '参数不正确';
const idParam = (c: Context) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new CreditError('id 不对', 404, 'not_found');
  return id;
};
const limitParam = (c: Context) => Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30) || 30));

export function creditRoutes(conn: Db, options: CreditRouteOptions = {}): Hono {
  const app = new Hono({ strict: false });
  const now = () => options.now?.() ?? new Date();
  const actorOf = (c: Context) => options.actorOf?.(c) ?? ADMIN;

  /** 业务错误统一转成 {error, code} */
  const handle = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof CreditError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };

  /** 按 zod 定义解析请求体;不合法抛 400 invalid */
  async function parse<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new CreditError(firstIssue(parsed.error), 400, 'invalid');
    return parsed.data;
  }
  function query<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CreditError(firstIssue(parsed.error), 400, 'invalid');
    return parsed.data;
  }

  /** 已绑定的设备;MAC 不认识或设备不存在都返回 undefined */
  const device = (raw: unknown) => {
    const mac = typeof raw === 'string' && raw ? canonicalMac(raw) : null;
    return mac ? one<{ mac: string; alias: string }>(conn, 'SELECT mac, alias FROM devices WHERE mac = ?', mac) : undefined;
  };
  const requireDevice = (raw: unknown) => {
    const found = device(raw);
    if (!found) throw new CreditError('设备不存在', 404, 'device_not_found');
    return { ...found };
  };
  const allDevices = () => all<{ mac: string; alias: string }>(conn,
    'SELECT mac, alias FROM devices ORDER BY last_connected_at DESC').map((row) => ({ ...row }));
  /** 同一个处理函数同时挂 PATCH 与 PUT */
  const patch = (path: string, fn: (c: Context) => Response | Promise<Response>) => {
    app.patch(path, handle(fn));
    app.put(path, handle(fn));
  };

  // ---- 接口描述、元信息 ----

  app.get('/openapi.json', (c) => c.json(buildOpenApi(options.basePath ?? '/open/v1/credits')));

  app.get('/meta', (c) => c.json({
    today: today(now()),
    qualities: QUALITIES.map((key) => ({ key, label: QUALITY_LABEL[key] })),
    task_statuses: TASK_STATUSES,
    ledger_kinds: LEDGER_KINDS,
    ranges: { ...RULE_RANGES, cost: [1, 100000], adjust: [-1000, 1000], actual_minutes: [0, 1440] },
  }));

  // ---- 孩子(= 设备,只读) ----

  app.get('/overview', handle((c) => {
    const devices = allDevices();
    const found = device(c.req.query('mac')) ?? (devices[0] ? device(devices[0].mac) : undefined);
    const day = today(now());
    if (!found) return c.json({ devices, device: null, today: day });
    return c.json({
      devices,
      device: { ...found },
      today: day,
      balance: balance(conn, found.mac),
      today_summary: daySummary(conn, found.mac, day),
      pending_claims: pendingClaims(conn, found.mac),
      counts: { rules: listRules(conn, found.mac).length, rewards: listRewards(conn, found.mac).length },
      qualities: QUALITIES.map((key) => ({ key, label: QUALITY_LABEL[key] })),
    });
  }));

  app.get('/children', handle((c) => {
    const day = today(now());
    return c.json({ items: allDevices().map((d) => childView(conn, d, day)), today: day });
  }));

  app.get('/children/:mac', handle((c) => {
    const found = requireDevice(c.req.param('mac'));
    const day = today(now());
    return c.json({
      item: childView(conn, found, day),
      counts: { rules: listRules(conn, found.mac).length, rewards: listRewards(conn, found.mac).length },
      today: day,
    });
  }));

  /** 什么都还没有时一键建好示例规则与奖励 */
  app.post('/examples', handle(async (c) => {
    const body = await parse(c, examplesBody);
    return c.json({ ok: true, ...seedExamples(conn, requireDevice(body.mac).mac) });
  }));

  // ---- 作业规则 ----

  app.get('/rules', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    return c.json({ items: listRules(conn, found.mac, c.req.query('archived') === '1') });
  }));

  app.post('/rules', handle(async (c) => {
    const { mac, ...input } = await parse(c, ruleCreate);
    return c.json({ ok: true, item: createRule(conn, requireDevice(mac).mac, input) });
  }));

  /** 编辑规则时的示例:数值还没保存,也要能看到「用了多久、质量几档 → 得几分」 */
  app.post('/rules/preview', handle(async (c) => {
    const body = await parse(c, rulePreview);
    return c.json({ score: scoreResult(body.params, body.actual_minutes, body.quality) });
  }));

  app.post('/rules/reorder', handle(async (c) => {
    const body = await parse(c, reorderBody);
    const mac = requireDevice(body.mac).mac;
    reorder(conn, 'credit_rules', mac, body.ids);
    return c.json({ ok: true, items: listRules(conn, mac) });
  }));

  app.get('/rules/:id', handle((c) => c.json({ item: requireRule(conn, idParam(c)) })));

  patch('/rules/:id', async (c) => {
    const input = await parse(c, ruleUpdate);
    return c.json({ ok: true, item: updateRule(conn, idParam(c), input) });
  });

  app.delete('/rules/:id', handle((c) => c.json({ ok: true, result: deleteRule(conn, idParam(c)) })));

  app.post('/rules/:id/restore', handle((c) => c.json({ ok: true, item: restoreRule(conn, idParam(c)) })));

  // ---- 作业 ----

  /** 带 day(或什么都不带)= 某一天的清单;带 from/to/status/before = 历史查询,倒序翻页 */
  app.get('/tasks', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    const { from, to, status, before } = c.req.query();
    if (from || to || status || before) {
      return c.json(queryTasks(conn, found.mac, {
        from: from ? query(daySchema, from) : undefined,
        to: to ? query(daySchema, to) : undefined,
        status: status ? query(z.enum(TASK_STATUSES), status) as TaskStatusFilter : undefined,
        before,
      }, limitParam(c)));
    }
    const day = query(daySchema, c.req.query('day') ?? today(now()));
    return c.json({ day, items: listTasks(conn, found.mac, day), summary: daySummary(conn, found.mac, day) });
  }));

  app.post('/tasks', handle(async (c) => {
    const body = await parse(c, taskAssign);
    const mac = requireDevice(body.mac).mac;
    return c.json({ ok: true, items: assignTasks(conn, mac, body.day ?? today(now()), body.items) });
  }));

  /** 不挂规则的临时作业 */
  app.post('/tasks/custom', handle(async (c) => {
    const { mac, day, ...input } = await parse(c, taskCustom);
    return c.json({ ok: true, item: createCustomTask(conn, requireDevice(mac).mac, day ?? today(now()), input) });
  }));

  app.get('/tasks/:id', handle((c) => c.json({ item: requireTask(conn, idParam(c)) })));

  patch('/tasks/:id', async (c) => {
    const input = await parse(c, taskUpdate);
    return c.json({ ok: true, item: updateTask(conn, idParam(c), input) });
  });

  app.delete('/tasks/:id', handle((c) => {
    deleteTask(conn, idParam(c));
    return c.json({ ok: true });
  }));

  /** 录入结果;preview=true 只算不存(页面边输边预览) */
  app.post('/tasks/:id/result', handle(async (c) => {
    const id = idParam(c);
    const body = await parse(c, taskResult);
    if (body.preview) return c.json({ preview: true, score: previewTask(conn, id, body.actual_minutes, body.quality) });
    return c.json({ ok: true, ...scoreTask(conn, id, body.actual_minutes, body.quality, body.note ?? '', actorOf(c)) });
  }));

  app.post('/tasks/:id/missed', handle(async (c) => {
    const id = idParam(c);
    const body = await parse(c, taskMissed);
    return c.json({ ok: true, ...missTask(conn, id, body.note ?? '', actorOf(c)) });
  }));

  /** 孩子报完成(只记申报,不加分) / 家长驳回申报 */
  app.post('/tasks/:id/claim', handle(async (c) => {
    const id = idParam(c);
    return c.json({ ok: true, item: claimTask(conn, id, await parse(c, taskClaim)) });
  }));
  app.delete('/tasks/:id/claim', handle((c) => c.json({ ok: true, item: unclaimTask(conn, idParam(c)) })));

  // ---- 奖励 ----

  app.get('/rewards', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    return c.json({ items: listRewards(conn, found.mac, c.req.query('archived') === '1'), balance: balance(conn, found.mac) });
  }));

  app.post('/rewards', handle(async (c) => {
    const { mac, ...input } = await parse(c, rewardCreate);
    return c.json({ ok: true, item: createReward(conn, requireDevice(mac).mac, input) });
  }));

  app.post('/rewards/reorder', handle(async (c) => {
    const body = await parse(c, reorderBody);
    const mac = requireDevice(body.mac).mac;
    reorder(conn, 'credit_rewards', mac, body.ids);
    return c.json({ ok: true, items: listRewards(conn, mac) });
  }));

  app.get('/rewards/:id', handle((c) => c.json({ item: requireReward(conn, idParam(c)) })));

  patch('/rewards/:id', async (c) => {
    const input = await parse(c, rewardUpdate);
    return c.json({ ok: true, item: updateReward(conn, idParam(c), input) });
  });

  app.delete('/rewards/:id', handle((c) => c.json({ ok: true, result: deleteReward(conn, idParam(c)) })));

  app.post('/rewards/:id/restore', handle((c) => c.json({ ok: true, item: restoreReward(conn, idParam(c)) })));

  // ---- 兑换与手动奖惩 ----

  app.post('/redeem', handle(async (c) => {
    const body = await parse(c, redeemBody);
    const mac = requireDevice(body.mac).mac;
    return c.json({ ok: true, ...redeem(conn, mac, body.reward_id, body.note ?? '', actorOf(c)) });
  }));

  app.post('/adjust', handle(async (c) => {
    const body = await parse(c, adjustBody);
    const mac = requireDevice(body.mac).mac;
    return c.json({ ok: true, ...adjust(conn, mac, body.delta, body.reason, actorOf(c)) });
  }));

  // ---- 流水 ----

  app.get('/ledger', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    const { kind, from, to } = c.req.query();
    const before = Number(c.req.query('before') ?? 0);
    return c.json({
      balance: balance(conn, found.mac),
      ...ledgerPage(conn, found.mac, Number.isInteger(before) && before > 0 ? before : null, limitParam(c), {
        kind: kind ? query(z.enum(LEDGER_KINDS), kind) as LedgerKind : undefined,
        from: from ? query(daySchema, from) : undefined,
        to: to ? query(daySchema, to) : undefined,
      }),
    });
  }));

  app.get('/ledger/:id', handle((c) => {
    const item = ledgerById(conn, idParam(c));
    if (!item) throw new CreditError('流水不存在', 404, 'not_found');
    return c.json({ item });
  }));

  app.post('/ledger/:id/revert', handle((c) => c.json({ ok: true, ...revert(conn, idParam(c), actorOf(c)) })));

  // ---- 统计 ----

  /** 默认最近 7 天(含今天);日期段最长 366 天 */
  app.get('/stats', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    const to = query(daySchema, c.req.query('to') ?? today(now()));
    const from = query(daySchema, c.req.query('from') ?? shiftDay(to, -6));
    if (from > to) throw new CreditError('开始日期不能晚于结束日期', 400, 'invalid');
    if (shiftDay(from, 366) < to) throw new CreditError('日期段最长一年', 400, 'invalid');
    return c.json(stats(conn, found.mac, from, to));
  }));

  // ---- 外部接口密钥(只在 /api 下) ----

  if (options.keyAdmin) {
    app.get('/keys', (c) => c.json({ items: listKeys(conn) }));
    app.post('/keys', handle(async (c) => {
      const body = await parse(c, keyCreate);
      return c.json({ ok: true, ...createKey(conn, body.name, body.scope) });
    }));
    patch('/keys/:id', async (c) => {
      const id = idParam(c);
      if (!keyById(conn, id)) throw new CreditError('密钥不存在', 404, 'not_found');
      return c.json({ ok: true, item: renameKey(conn, id, (await parse(c, keyUpdate)).name) });
    });
    app.delete('/keys/:id', handle((c) => {
      const id = idParam(c);
      if (!keyById(conn, id)) throw new CreditError('密钥不存在', 404, 'not_found');
      return c.json({ ok: true, item: revokeKey(conn, id) });
    }));
  }

  return app;
}
