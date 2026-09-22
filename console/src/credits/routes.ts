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
import { canonicalMac } from '../identity.ts';
import { bindAppToChild, boundChild, unbindApp } from './binding.ts';
import { childDevice, childDevices } from './devices.ts';
import { buildOpenApi } from './openapi.ts';
import { createKey, keyById, listKeys, renameKey, revokeKey } from './open-key.ts';
import { LEGACY_QUALITY_LABELS, QUALITY_CHOICES, QUALITY_CHOICE_LABEL } from './score.ts';
import {
  adjustBody, bindingBody, examplesBody, keyCreate, keyUpdate, LEDGER_KINDS, redeemBody, reorderBody, rewardCreate,
  rewardUpdate, ruleCreate, ruleUpdate, taskAssign, taskClaim, taskCustom, taskMissed, taskResult,
  TASK_STATUSES, taskUpdate, WALLET_KINDS, walletAdjustBody, walletUseBody, day as daySchema,
} from './schemas.ts';
import {
  ADMIN, CreditError, adjust, assignTasks, balance, childView, claimTask, createCustomTask, createReward, createRule,
  daySummary, deleteReward, deleteRule, deleteTask, ledgerById, ledgerPage, listRewards, listRules, listTasks, missTask,
  pendingClaims, previewTask, queryTasks, redeem, reorder, requireReward, requireRule, requireTask, restoreReward,
  restoreRule, revert, scoreTask, seedExamples, shiftDay, stats, today, unclaimTask, updateReward, updateRule, updateTask,
  walletBalance, walletSummary,
  type Actor, type LedgerKind, type RewardRow, type TaskStatusFilter, type WalletKind, type WalletRow,
} from './store.ts';
import { AMOUNT_MAX, fromBase, KIND_LABEL, REWARD_KINDS, toBase, UNIT, type RewardKind } from './units.ts';
import { walletAdjust, walletEntry, walletOut, walletPage, walletRevert, walletUse } from './wallet.ts';

export interface CreditRouteOptions {
  now?: (() => Date) | undefined;
  /** 只在 /api 下为 true:挂上密钥管理接口 */
  keyAdmin?: boolean;
  /** 这一次请求是谁:页面、哪把外部密钥。写流水时记下来 */
  actorOf?: (c: Context) => Actor;
  /** 挂载的前缀,写进 openapi.json 的 servers */
  basePath?: string;
  /**
   * 家长 App 的设备身份:返回 { mac, childMac },childMac 为 null 表示这台 App 还没绑硬件。
   * 只有挂在 /open 下、而且这次请求带的是 App 设备身份时才有值;控制台页面与命名密钥都拿不到 ——
   * 他们按显式传的 mac 操作(家长在电脑上配的脚本,视为管理员)。
   */
  appCaller?: ((c: Context) => { mac: string; childMac: string | null } | undefined) | undefined;
}

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? '参数不正确';
const idParam = (c: Context) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new CreditError('id 不对', 404, 'not_found');
  return id;
};
const limitParam = (c: Context) => Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30) || 30));

/**
 * 奖励对外的样子:amount 换成自然单位(分钟 / 元),带上单位;
 * 时间与零花钱奖励再带上账户余额 wallet_balance,页面和 App 不用另查。
 */
function rewardOut(conn: Db, row: RewardRow) {
  return {
    ...row,
    amount: fromBase(row.kind, row.amount),
    unit: UNIT[row.kind],
    ...(row.kind === 'item' ? {} : { wallet_balance: fromBase(row.kind, walletBalance(conn, row.id)) }),
  };
}

/** 账户那一块的返回:数额换成自然单位 */
function walletPart(wallet: { entry: WalletRow; balance: number } | undefined) {
  if (!wallet) return {};
  const kind = wallet.entry.reward_kind;
  return { wallet: { entry: walletOut(wallet.entry), balance: fromBase(kind, wallet.balance), unit: UNIT[kind] } };
}

/** 接口收的 amount 是自然单位,库里是基本单位;物品没有 amount */
const amountIn = (kind: RewardKind, amount: number | undefined) =>
  kind === 'item' || amount === undefined ? undefined : toBase(kind, amount, '一份换多少');

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

  /** 已绑定的孩子(硬件设备);MAC 不认识、设备不存在、或者是家长 App 都返回 undefined */
  const device = (raw: unknown) => {
    const mac = typeof raw === 'string' && raw ? canonicalMac(raw) : undefined;
    return mac ? childDevice(conn, mac) : undefined;
  };
  /**
   * 要操作的那个孩子。家长 App 的设备身份多两道门:还没绑硬件时不许动数据;想动别的硬件直接拒 ——
   * App 只认自己在服务端绑定的那一台。控制台页面与命名密钥不看这条(它们显式传 mac)。
   */
  const requireChild = (c: Context, raw: unknown) => {
    const found = device(raw);
    if (!found) throw new CreditError('设备不存在', 404, 'device_not_found');
    const app = options.appCaller?.(c);
    if (app) {
      if (!app.childMac) throw new CreditError('这台 App 还没绑定孩子:先在 App 里选一台硬件', 409, 'no_bound_child');
      if (app.childMac !== found.mac) throw new CreditError('这台 App 绑的是另一台硬件,不能操作别的孩子', 403, 'not_bound_child');
    }
    return { ...found };
  };
  const allDevices = () => childDevices(conn);
  /** 同一个处理函数同时挂 PATCH 与 PUT */
  const patch = (path: string, fn: (c: Context) => Response | Promise<Response>) => {
    app.patch(path, handle(fn));
    app.put(path, handle(fn));
  };

  // ---- 接口描述、元信息 ----

  app.get('/openapi.json', (c) => c.json(buildOpenApi(options.basePath ?? '/open/v1/credits')));

  app.get('/meta', (c) => c.json({
    today: today(now()),
    qualities: QUALITY_CHOICES.map((key) => ({ key, label: QUALITY_CHOICE_LABEL[key] })),
    /** 旧模型留下的两档质量:只有历史行会出现,页面渲染老数据时用 */
    legacy_qualities: Object.entries(LEGACY_QUALITY_LABELS).map(([key, label]) => ({ key, label })),
    task_statuses: TASK_STATUSES,
    ledger_kinds: LEDGER_KINDS,
    reward_kinds: REWARD_KINDS.map((key) => ({ key, label: KIND_LABEL[key], unit: UNIT[key], amount_max: AMOUNT_MAX[key] })),
    wallet_kinds: WALLET_KINDS,
    ranges: {
      target_minutes: [1, 600], points: [0, 5], cost: [1, 100000], adjust: [-1000, 1000],
      actual_minutes: [0, 1440], times: [1, 100], time_amount: [1, 1440], money_amount: [0.01, 100000],
    },
  }));

  // ---- 孩子(= 设备,只读) ----

  app.get('/overview', handle((c) => {
    const devices = allDevices();
    const app = options.appCaller?.(c);
    // 家长 App 只认它绑定的那台;页面与密钥按传进来的 mac,不传就取第一台(现在也只允许一台硬件)
    const found = app
      ? (app.childMac ? device(app.childMac) : undefined)
      : (device(c.req.query('mac')) ?? (devices[0] ? device(devices[0].mac) : undefined));
    const day = today(now());
    if (!found) return c.json({ devices, device: null, today: day, bound: app ? null : undefined });
    return c.json({
      devices,
      device: { ...found },
      today: day,
      balance: balance(conn, found.mac),
      today_summary: daySummary(conn, found.mac, day),
      pending_claims: pendingClaims(conn, found.mac),
      counts: { rules: listRules(conn, found.mac).length, rewards: listRewards(conn, found.mac).length },
      qualities: QUALITY_CHOICES.map((key) => ({ key, label: QUALITY_CHOICE_LABEL[key] })),
    });
  }));

  app.get('/children', handle((c) => {
    const day = today(now());
    return c.json({ items: allDevices().map((d) => childView(conn, d, day)), today: day });
  }));

  app.get('/children/:mac', handle((c) => {
    const found = requireChild(c, c.req.param('mac'));
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
    return c.json({ ok: true, ...seedExamples(conn, requireChild(c, body.mac).mac) });
  }));

  // ---- 家长 App ↔ 硬件(=孩子)的绑定 ----
  //
  // 只有家长 App 的设备身份能用;绑好之后这台 App 调其它接口时 mac 必须等于绑定的那台(requireChild 拦)。
  // 命名密钥(页面、脚本)不走这三条,它们照旧显式传 mac。

  const requireAppCaller = (c: Context) => {
    const app = options.appCaller?.(c);
    if (!app) throw new CreditError('只有家长 App 能用这个接口', 403, 'not_app_device');
    return app;
  };

  app.get('/binding', handle((c) => {
    const app = requireAppCaller(c);
    const child = boundChild(conn, app.mac);
    return c.json({ child: child ? childView(conn, child, today(now())) : null });
  }));

  app.put('/binding', handle(async (c) => {
    const app = requireAppCaller(c);
    const body = await parse(c, bindingBody);
    const child = bindAppToChild(conn, app.mac, body.mac);
    return c.json({ ok: true, child: childView(conn, child, today(now())) });
  }));

  app.delete('/binding', handle((c) => {
    // 控制台页面(登录会话)带 ?mac= 解某台家长 App 的绑定;家长 App 自己解绑则不带 mac,用它的设备身份
    const query = c.req.query('mac');
    if (query) {
      if (!options.keyAdmin) throw new CreditError('只有控制台页面能按 mac 解绑', 403, 'not_app_device');
      const mac = canonicalMac(query);
      if (!mac) throw new CreditError('mac 格式不对', 400, 'invalid');
      return c.json({ ok: true, result: unbindApp(conn, mac) ? 'removed' : 'none' });
    }
    const app = requireAppCaller(c);
    return c.json({ ok: true, result: unbindApp(conn, app.mac) ? 'removed' : 'none' });
  }));

  // ---- 作业规则 ----

  app.get('/rules', handle((c) => {
    const found = requireChild(c, c.req.query('mac'));
    return c.json({ items: listRules(conn, found.mac, c.req.query('archived') === '1') });
  }));

  app.post('/rules', handle(async (c) => {
    const { mac, ...input } = await parse(c, ruleCreate);
    return c.json({ ok: true, item: createRule(conn, requireChild(c, mac).mac, input) });
  }));

  app.post('/rules/reorder', handle(async (c) => {
    const body = await parse(c, reorderBody);
    const mac = requireChild(c, body.mac).mac;
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
    const found = requireChild(c, c.req.query('mac'));
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
    const mac = requireChild(c, body.mac).mac;
    return c.json({ ok: true, items: assignTasks(conn, mac, body.day ?? today(now()), body.items) });
  }));

  /** 不挂规则的临时作业 */
  app.post('/tasks/custom', handle(async (c) => {
    const { mac, day, ...input } = await parse(c, taskCustom);
    return c.json({ ok: true, item: createCustomTask(conn, requireChild(c, mac).mac, day ?? today(now()), input) });
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
    if (body.preview) return c.json({ preview: true, score: previewTask(conn, id, body.points, body.quality) });
    return c.json({
      ok: true,
      ...scoreTask(conn, id, {
        points: body.points,
        quality: body.quality,
        actual_minutes: body.actual_minutes ?? null,
        note: body.note ?? '',
      }, actorOf(c)),
    });
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
    const found = requireChild(c, c.req.query('mac'));
    return c.json({
      items: listRewards(conn, found.mac, c.req.query('archived') === '1').map((r) => rewardOut(conn, r)),
      balance: balance(conn, found.mac),
    });
  }));

  app.post('/rewards', handle(async (c) => {
    const { mac, amount, ...input } = await parse(c, rewardCreate);
    const kind = input.kind ?? 'item';
    const item = createReward(conn, requireChild(c, mac).mac, { ...input, kind, amount: amountIn(kind, amount) });
    return c.json({ ok: true, item: rewardOut(conn, item) });
  }));

  app.post('/rewards/reorder', handle(async (c) => {
    const body = await parse(c, reorderBody);
    const mac = requireChild(c, body.mac).mac;
    reorder(conn, 'credit_rewards', mac, body.ids);
    return c.json({ ok: true, items: listRewards(conn, mac).map((r) => rewardOut(conn, r)) });
  }));

  app.get('/rewards/:id', handle((c) => c.json({ item: rewardOut(conn, requireReward(conn, idParam(c))) })));

  patch('/rewards/:id', async (c) => {
    const id = idParam(c);
    const { amount, ...input } = await parse(c, rewardUpdate);
    const kind = input.kind ?? requireReward(conn, id).kind;
    return c.json({ ok: true, item: rewardOut(conn, updateReward(conn, id, { ...input, amount: amountIn(kind, amount) })) });
  });

  app.delete('/rewards/:id', handle((c) => c.json({ ok: true, result: deleteReward(conn, idParam(c)) })));

  app.post('/rewards/:id/restore', handle((c) => c.json({ ok: true, item: rewardOut(conn, restoreReward(conn, idParam(c))) })));

  // ---- 兑换与手动奖惩 ----

  app.post('/redeem', handle(async (c) => {
    const body = await parse(c, redeemBody);
    const mac = requireChild(c, body.mac).mac;
    const { wallet, ...rest } = redeem(conn, mac, body.reward_id, body.times ?? 1, body.note ?? '', actorOf(c));
    return c.json({ ok: true, ...rest, ...walletPart(wallet) });
  }));

  app.post('/adjust', handle(async (c) => {
    const body = await parse(c, adjustBody);
    const mac = requireChild(c, body.mac).mac;
    return c.json({ ok: true, ...adjust(conn, mac, body.delta, body.reason, actorOf(c)) });
  }));

  // ---- 流水 ----

  app.get('/ledger', handle((c) => {
    const found = requireChild(c, c.req.query('mac'));
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

  app.post('/ledger/:id/revert', handle((c) => {
    const { wallet, ...rest } = revert(conn, idParam(c), actorOf(c));
    return c.json({ ok: true, ...rest, ...walletPart(wallet) });
  }));

  // ---- 时间与零花钱余额 ----

  app.get('/wallets', handle((c) => {
    const found = requireChild(c, c.req.query('mac'));
    return c.json({ items: walletSummary(conn, found.mac) });
  }));

  app.get('/wallets/entries', handle((c) => {
    const found = requireChild(c, c.req.query('mac'));
    const { kind, from, to } = c.req.query();
    const before = Number(c.req.query('before') ?? 0);
    const rewardId = Number(c.req.query('reward_id') ?? 0);
    return c.json(walletPage(conn, found.mac, Number.isInteger(before) && before > 0 ? before : null, limitParam(c), {
      reward_id: Number.isInteger(rewardId) && rewardId > 0 ? rewardId : undefined,
      kind: kind ? query(z.enum(WALLET_KINDS), kind) as WalletKind : undefined,
      from: from ? query(daySchema, from) : undefined,
      to: to ? query(daySchema, to) : undefined,
    }));
  }));

  app.get('/wallets/entries/:id', handle((c) => c.json({ item: walletEntry(conn, idParam(c)) })));

  app.post('/wallets/use', handle(async (c) => {
    const body = await parse(c, walletUseBody);
    const mac = requireChild(c, body.mac).mac;
    return c.json({ ok: true, ...walletUse(conn, mac, body.reward_id, body.amount, body.reason, body.note ?? '', actorOf(c)) });
  }));

  app.post('/wallets/adjust', handle(async (c) => {
    const body = await parse(c, walletAdjustBody);
    const mac = requireChild(c, body.mac).mac;
    return c.json({ ok: true, ...walletAdjust(conn, mac, body.reward_id, body.amount, body.reason, actorOf(c)) });
  }));

  app.post('/wallets/entries/:id/revert', handle((c) => c.json({ ok: true, ...walletRevert(conn, idParam(c), actorOf(c)) })));

  // ---- 统计 ----

  /** 默认最近 7 天(含今天);日期段最长 366 天 */
  app.get('/stats', handle((c) => {
    const found = requireChild(c, c.req.query('mac'));
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
