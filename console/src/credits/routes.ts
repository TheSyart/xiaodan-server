// 学分接口。同一份路由挂两次:
//   /api/credits/*   控制台页面用,走 /api 的登录守卫(运维面板的统一登录);
//   /open/credits/*  外部程序用(家长手机快捷指令、别的程序、以后的智能体),按 Bearer 密钥鉴权,见 app.ts。
// 密钥的生成、轮换、关闭只挂在 /api 下:外部密钥不能自己换掉自己。
//
// 约定与控制台其他接口一致:参数 zod 校验,错误回 {error: 中文} + 400/404/409;
// MAC 先过 canonicalMac(冒号、连字符、12 位紧凑形式都认——外部调用拼 URL 建议用紧凑形式)。

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { all, one } from '../db.ts';
import { canonicalMac } from '../identity.ts';
import { disableKey, keyStatus, rotateKey } from './open-key.ts';
import { QUALITIES, QUALITY_LABEL, scoreResult } from './score.ts';
import {
  CreditError, PARAM_KEYS, adjust, assignTasks, balance, createReward, createRule, daySummary, deleteReward, deleteRule,
  deleteTask, ledgerPage, listRewards, listRules, listTasks, missTask, previewTask, redeem, revert, scoreTask,
  seedExamples, taskById, today, updateReward, updateRule, updateTask,
} from './store.ts';

export interface CreditRouteOptions {
  now?: (() => Date) | undefined;
  /** 只在 /api 下为 true:挂上密钥管理接口 */
  keyAdmin?: boolean;
}

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const name = z.string().trim().min(1, '名称不能为空').max(40, '名称最多 40 个字');

const RULE_RANGES: Record<(typeof PARAM_KEYS)[number], [number, number]> = {
  target_minutes: [1, 600],
  ontime_points: [-100, 100],
  overtime_step: [1, 120],
  overtime_penalty: [0, 100],
  overtime_cap: [0, 100],
  q_excellent: [-100, 100],
  q_good: [-100, 100],
  q_fair: [-100, 100],
  q_poor: [-100, 100],
  missed_penalty: [0, 100],
};
const ruleParams = z.object(
  Object.fromEntries(PARAM_KEYS.map((key) => [key, int(...RULE_RANGES[key]).optional()])) as {
    [K in (typeof PARAM_KEYS)[number]]: z.ZodOptional<z.ZodNumber>
  },
);

const body = async (c: Context) => c.req.json().catch(() => ({}));
const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? '参数不正确';
const idParam = (c: Context) => {
  const id = Number(c.req.param('id'));
  return Number.isInteger(id) && id > 0 ? id : 0;
};

export function creditRoutes(conn: Db, options: CreditRouteOptions = {}): Hono {
  const app = new Hono({ strict: false });
  const now = () => options.now?.() ?? new Date();

  /** 业务错误统一转成 {error} */
  const handle = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof CreditError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  };

  /** 已绑定的设备;MAC 不认识或设备不存在都返回 undefined */
  const device = (raw: unknown) => {
    const mac = typeof raw === 'string' && raw ? canonicalMac(raw) : null;
    return mac ? one<{ mac: string; alias: string }>(conn, 'SELECT mac, alias FROM devices WHERE mac = ?', mac) : undefined;
  };
  const requireDevice = (raw: unknown) => {
    const found = device(raw);
    if (!found) throw new CreditError('设备不存在', 404);
    return found;
  };

  // ---- 概览 ----

  app.get('/overview', handle((c) => {
    const devices = all<{ mac: string; alias: string }>(conn,
      'SELECT mac, alias FROM devices ORDER BY last_connected_at DESC').map((row) => ({ ...row }));
    const found = device(c.req.query('mac')) ?? (devices[0] ? device(devices[0].mac) : undefined);
    const day = today(now());
    if (!found) return c.json({ devices, device: null, today: day });
    return c.json({
      devices,
      device: { ...found },
      today: day,
      balance: balance(conn, found.mac),
      today_summary: daySummary(conn, found.mac, day),
      counts: {
        rules: listRules(conn, found.mac).length,
        rewards: listRewards(conn, found.mac).length,
      },
      qualities: QUALITIES.map((key) => ({ key, label: QUALITY_LABEL[key] })),
    });
  }));

  /** 什么都还没有时一键建好示例规则与奖励 */
  app.post('/examples', handle(async (c) => {
    const { mac } = await body(c) as { mac?: unknown };
    const found = requireDevice(mac);
    return c.json({ ok: true, ...seedExamples(conn, found.mac) });
  }));

  // ---- 作业规则 ----

  app.get('/rules', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    return c.json({ items: listRules(conn, found.mac, c.req.query('archived') === '1') });
  }));

  app.post('/rules', handle(async (c) => {
    const parsed = ruleParams.extend({
      mac: z.string().min(1).max(32),
      name,
      target_minutes: int(1, 600),
    }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const { mac, ...input } = parsed.data;
    const found = requireDevice(mac);
    return c.json({ ok: true, item: createRule(conn, found.mac, input) });
  }));

  /** 编辑规则时的示例:数值还没保存,也要能看到「用了多久、质量几档 → 得几分」 */
  app.post('/rules/preview', handle(async (c) => {
    const full = z.object(Object.fromEntries(PARAM_KEYS.map((key) => [key, int(...RULE_RANGES[key])])) as {
      [K in (typeof PARAM_KEYS)[number]]: z.ZodNumber
    });
    const parsed = z.object({
      params: full,
      actual_minutes: int(0, 1440),
      quality: z.enum(QUALITIES),
    }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    return c.json({ score: scoreResult(parsed.data.params, parsed.data.actual_minutes, parsed.data.quality) });
  }));

  app.put('/rules/:id', handle(async (c) => {
    const parsed = ruleParams.extend({ name: name.optional() }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const item = updateRule(conn, idParam(c), parsed.data);
    if (!item) return c.json({ error: '规则不存在' }, 404);
    return c.json({ ok: true, item });
  }));

  app.delete('/rules/:id', handle((c) => {
    const result = deleteRule(conn, idParam(c));
    if (!result) return c.json({ error: '规则不存在' }, 404);
    return c.json({ ok: true, result });
  }));

  // ---- 每天的作业 ----

  app.get('/tasks', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    const raw = c.req.query('day');
    const parsed = DAY.safeParse(raw ?? today(now()));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    return c.json({ day: parsed.data, items: listTasks(conn, found.mac, parsed.data), summary: daySummary(conn, found.mac, parsed.data) });
  }));

  app.post('/tasks', handle(async (c) => {
    const parsed = z.object({
      mac: z.string().min(1).max(32),
      day: DAY.optional(),
      items: z.array(z.object({ rule_id: z.number().int().positive(), target_minutes: int(1, 600).optional() }))
        .min(1, '至少选一项作业').max(30, '一次最多布置 30 项'),
    }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const found = requireDevice(parsed.data.mac);
    return c.json({ ok: true, items: assignTasks(conn, found.mac, parsed.data.day ?? today(now()), parsed.data.items) });
  }));

  app.put('/tasks/:id', handle(async (c) => {
    const parsed = z.object({ name: name.optional(), target_minutes: int(1, 600).optional() }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    return c.json({ ok: true, item: updateTask(conn, idParam(c), parsed.data) });
  }));

  app.delete('/tasks/:id', handle((c) => {
    deleteTask(conn, idParam(c));
    return c.json({ ok: true });
  }));

  /** 录入结果;preview=true 只算不存(页面边输边预览) */
  app.post('/tasks/:id/result', handle(async (c) => {
    const parsed = z.object({
      actual_minutes: int(0, 1440),
      quality: z.enum(QUALITIES, { message: '质量要选优、良、中、差之一' }),
      note: z.string().max(200).optional(),
      preview: z.boolean().optional(),
    }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const id = idParam(c);
    const { actual_minutes: minutes, quality, note, preview } = parsed.data;
    if (preview) return c.json({ preview: true, score: previewTask(conn, id, minutes, quality) });
    return c.json({ ok: true, ...scoreTask(conn, id, minutes, quality, note ?? '') });
  }));

  app.post('/tasks/:id/missed', handle(async (c) => {
    const parsed = z.object({ note: z.string().max(200).optional() }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    return c.json({ ok: true, ...missTask(conn, idParam(c), parsed.data.note ?? '') });
  }));

  app.get('/tasks/:id', handle((c) => {
    const task = taskById(conn, idParam(c));
    if (!task) return c.json({ error: '作业不存在' }, 404);
    return c.json({ item: task });
  }));

  // ---- 奖励 ----

  const rewardFields = { name, cost: int(1, 100000), emoji: z.string().max(8).optional() };

  app.get('/rewards', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    return c.json({ items: listRewards(conn, found.mac), balance: balance(conn, found.mac) });
  }));

  app.post('/rewards', handle(async (c) => {
    const parsed = z.object({ mac: z.string().min(1).max(32), ...rewardFields }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const { mac, ...input } = parsed.data;
    const found = requireDevice(mac);
    return c.json({ ok: true, item: createReward(conn, found.mac, input) });
  }));

  app.put('/rewards/:id', handle(async (c) => {
    const parsed = z.object({ name: name.optional(), cost: int(1, 100000).optional(), emoji: z.string().max(8).optional() })
      .safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const item = updateReward(conn, idParam(c), parsed.data);
    if (!item) return c.json({ error: '奖励不存在' }, 404);
    return c.json({ ok: true, item });
  }));

  app.delete('/rewards/:id', handle((c) => {
    const result = deleteReward(conn, idParam(c));
    if (!result) return c.json({ error: '奖励不存在' }, 404);
    return c.json({ ok: true, result });
  }));

  app.post('/redeem', handle(async (c) => {
    const parsed = z.object({
      mac: z.string().min(1).max(32),
      reward_id: z.number().int().positive(),
      note: z.string().max(200).optional(),
    }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const found = requireDevice(parsed.data.mac);
    return c.json({ ok: true, ...redeem(conn, found.mac, parsed.data.reward_id, parsed.data.note ?? '') });
  }));

  /** 家长手动奖惩 */
  app.post('/adjust', handle(async (c) => {
    const parsed = z.object({
      mac: z.string().min(1).max(32),
      delta: int(-1000, 1000).refine((n) => n !== 0, '分数不能是 0'),
      reason: z.string().trim().min(1, '要写明原因').max(80),
    }).safeParse(await body(c));
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error) }, 400);
    const found = requireDevice(parsed.data.mac);
    return c.json({ ok: true, ...adjust(conn, found.mac, parsed.data.delta, parsed.data.reason) });
  }));

  // ---- 流水 ----

  app.get('/ledger', handle((c) => {
    const found = requireDevice(c.req.query('mac'));
    const before = Number(c.req.query('before') ?? 0);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30) || 30));
    return c.json({
      balance: balance(conn, found.mac),
      ...ledgerPage(conn, found.mac, Number.isInteger(before) && before > 0 ? before : null, limit),
    });
  }));

  app.post('/ledger/:id/revert', handle((c) => c.json({ ok: true, ...revert(conn, idParam(c)) })));

  // ---- 外部接口密钥(只在 /api 下) ----

  if (options.keyAdmin) {
    app.get('/key', (c) => c.json(keyStatus(conn)));
    app.post('/key/rotate', (c) => c.json({ ok: true, key: rotateKey(conn, now()), ...keyStatus(conn) }));
    app.delete('/key', (c) => {
      disableKey(conn);
      return c.json({ ok: true, ...keyStatus(conn) });
    });
  }

  return app;
}
