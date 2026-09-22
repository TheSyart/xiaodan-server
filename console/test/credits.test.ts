// 学分奖惩:计分公式、布置时的规则快照、余额与撤销、兑换够分、两套接口入口与外部密钥。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { scoreMissed, scoreResult, type ScoreParams } from '../src/credits/score.ts';
import { today } from '../src/credits/store.ts';

const MAC = '4c:11:ae:31:7a:30';
const COMPACT = '4c11ae317a30';
let conn: Db;
let clock: Date;

class FakeBridge extends Bridge {
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
}

const PARAMS: ScoreParams = {
  target_minutes: 40, ontime_points: 5, overtime_step: 10, overtime_penalty: 1, overtime_cap: 5,
  q_excellent: 5, q_good: 3, q_fair: 0, q_poor: -2, missed_penalty: 5,
};

beforeEach(() => {
  process.env['XIAODAN_AUTH_MODE'] = 'proxy';
  conn = openMemoryDb();
  seed(conn);
  run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', MAC, DEFAULT_AGENT_ID, '乐乐的小单');
  clock = new Date('2026-09-22T12:00:00Z');   // 北京时间 20:00
});

const newApp = () => createApp(conn, {
  agent: { fetch: async () => new Response('{}'), bridge: new FakeBridge(), log: () => {}, now: () => clock },
});

type App = ReturnType<typeof createApp>;
const call = async (app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await app.request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
};
const api = (app: App, method: string, path: string, body?: unknown) => call(app, method, `/api/credits${path}`, body);

async function mathRule(app: App, extra: Record<string, number> = {}) {
  const { data } = await api(app, 'POST', '/rules', { mac: MAC, name: '数学作业', target_minutes: 40, ...extra });
  return data.item as { id: number };
}

async function assign(app: App, ruleId: number, target?: number) {
  const { data } = await api(app, 'POST', '/tasks', {
    mac: MAC, items: [{ rule_id: ruleId, ...(target ? { target_minutes: target } : {}) }],
  });
  return data.items[0] as { id: number; day: string; target_minutes: number; ontime_points: number };
}

const balanceOf = () => one<{ n: number | null }>(conn, 'SELECT SUM(delta) AS n FROM credit_ledger WHERE mac = ?', MAC)?.n ?? 0;

describe('计分公式', () => {
  test('按时与提前都拿按时分;刚好压线算按时', () => {
    assert.equal(scoreResult(PARAMS, 40, 'good').time_points, 5);
    assert.equal(scoreResult(PARAMS, 25, 'good').time_points, 5);
    assert.match(scoreResult(PARAMS, 40, 'good').explain, /刚好按时/u);
    assert.match(scoreResult(PARAMS, 25, 'good').explain, /提前 15 分钟/u);
  });

  test('超时向上取整算档:超 1 分钟就是一档,超 10 分钟还是一档,超 11 分钟两档', () => {
    assert.equal(scoreResult(PARAMS, 41, 'fair').time_points, -1);
    assert.equal(scoreResult(PARAMS, 50, 'fair').time_points, -1);
    assert.equal(scoreResult(PARAMS, 51, 'fair').time_points, -2);
  });

  test('超时扣分到上限为止', () => {
    const score = scoreResult(PARAMS, 200, 'fair');
    assert.equal(score.time_points, -5);
    assert.match(score.explain, /已到上限 5 分/u);
  });

  test('质量四档各自计分,可以是负分;合计 = 用时 + 质量', () => {
    const score = scoreResult(PARAMS, 55, 'good');
    assert.deepEqual([score.time_points, score.quality_points, score.total], [-2, 3, 1]);
    assert.equal(scoreResult(PARAMS, 30, 'poor').total, 3);
    assert.equal(scoreResult(PARAMS, 90, 'poor').total, -7);
    assert.match(score.explain, /超时 15 分钟.*质量良 \+3;合计 \+1/u);
  });

  test('没完成扣没完成分;设成 0 就不扣', () => {
    assert.equal(scoreMissed(PARAMS).total, -5);
    assert.equal(scoreMissed({ ...PARAMS, missed_penalty: 0 }).total, 0);
  });

  test('「今天」按北京时间:UTC 16:30 已经是北京的第二天', () => {
    assert.equal(today(new Date('2026-09-22T15:59:00Z')), '2026-09-22');
    assert.equal(today(new Date('2026-09-22T16:30:00Z')), '2026-09-23');
  });
});

describe('作业与打分', () => {
  test('建规则 → 布置 → 录入结果:流水与余额对得上,预览不落库', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    const task = await assign(app, rule.id);
    assert.equal(task.day, '2026-09-22', '不传日期就是北京时间的今天');

    const preview = await api(app, 'POST', `/tasks/${task.id}/result`, { actual_minutes: 55, quality: 'good', preview: true });
    assert.equal(preview.data.score.total, 1);
    assert.equal(balanceOf(), 0, '预览不落库');

    const scored = await api(app, 'POST', `/tasks/${task.id}/result`, { actual_minutes: 55, quality: 'good', note: '字写得工整' });
    assert.equal(scored.status, 200);
    assert.equal(scored.data.task.status, 'done');
    assert.equal(scored.data.task.total_points, 1);
    assert.equal(scored.data.balance, 1);
    assert.equal(balanceOf(), 1);

    const again = await api(app, 'POST', `/tasks/${task.id}/result`, { actual_minutes: 30, quality: 'excellent' });
    assert.equal(again.status, 409, '打过分的不能直接重录');

    const list = await api(app, 'GET', `/tasks?mac=${COMPACT}`);
    assert.equal(list.data.summary.done, 1);
    assert.equal(list.data.summary.points, 1);
  });

  test('改规则只影响以后布置的作业,已打分的历史一分不变', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    const first = await assign(app, rule.id);
    await api(app, 'POST', `/tasks/${first.id}/result`, { actual_minutes: 30, quality: 'fair' });
    assert.equal(balanceOf(), 5);

    await api(app, 'PUT', `/rules/${rule.id}`, { ontime_points: 8 });
    const history = await api(app, 'GET', `/tasks/${first.id}`);
    assert.equal(history.data.item.total_points, 5, '历史分数不动');
    assert.equal(history.data.item.ontime_points, 5, '快照里还是当时的数值');

    const second = await assign(app, rule.id);
    assert.equal(second.ontime_points, 8, '新布置的用新数值');
  });

  test('布置时可以临时改用时,还没打分时能改能删', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    const task = await assign(app, rule.id, 60);
    assert.equal(task.target_minutes, 60);
    const edited = await api(app, 'PUT', `/tasks/${task.id}`, { target_minutes: 50 });
    assert.equal(edited.data.item.target_minutes, 50);
    assert.equal((await api(app, 'DELETE', `/tasks/${task.id}`)).status, 200);
    assert.equal((await api(app, 'GET', `/tasks/${task.id}`)).status, 404);
  });

  test('没完成扣分,余额可以扣成负数', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    const task = await assign(app, rule.id);
    const missed = await api(app, 'POST', `/tasks/${task.id}/missed`, { note: '拖到睡觉都没写' });
    assert.equal(missed.data.task.status, 'missed');
    assert.equal(missed.data.balance, -5);
  });

  test('撤销打分:作业回到待完成、分数退回,可以重新录入;同一笔不能撤两次', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    const task = await assign(app, rule.id);
    const scored = await api(app, 'POST', `/tasks/${task.id}/result`, { actual_minutes: 30, quality: 'excellent' });
    const ledgerId = scored.data.task.ledger_id as number;
    assert.equal(balanceOf(), 10);

    const reverted = await api(app, 'POST', `/ledger/${ledgerId}/revert`);
    assert.equal(reverted.status, 200);
    assert.equal(reverted.data.balance, 0);
    assert.equal(reverted.data.task.status, 'pending');
    assert.equal(reverted.data.task.total_points, null);

    assert.equal((await api(app, 'POST', `/ledger/${ledgerId}/revert`)).status, 409, '已经撤销过');
    assert.equal((await api(app, 'POST', `/ledger/${reverted.data.ledger.id}/revert`)).status, 409, '撤销记录本身不能撤');

    const rescored = await api(app, 'POST', `/tasks/${task.id}/result`, { actual_minutes: 45, quality: 'good' });
    assert.equal(rescored.status, 200, '撤销后能重新录入');
  });

  test('规则示例预览:数值没保存也能算', async () => {
    const app = newApp();
    const { data, status } = await api(app, 'POST', '/rules/preview', { params: PARAMS, actual_minutes: 55, quality: 'good' });
    assert.equal(status, 200);
    assert.equal(data.score.total, 1);
    assert.equal((await api(app, 'POST', '/rules/preview', { params: { ...PARAMS, overtime_step: 0 }, actual_minutes: 55, quality: 'good' })).status, 400);
  });

  test('用过的规则删除变归档,没用过的真删;归档的不能再布置', async () => {
    const app = newApp();
    const used = await mathRule(app);
    await assign(app, used.id);
    const unused = (await api(app, 'POST', '/rules', { mac: MAC, name: '英语', target_minutes: 30 })).data.item;

    assert.equal((await api(app, 'DELETE', `/rules/${used.id}`)).data.result, 'archived');
    assert.equal((await api(app, 'DELETE', `/rules/${unused.id}`)).data.result, 'deleted');
    const rules = await api(app, 'GET', `/rules?mac=${COMPACT}`);
    assert.equal(rules.data.items.length, 0, '列表不显示归档的');
    const blocked = await api(app, 'POST', '/tasks', { mac: MAC, items: [{ rule_id: used.id }] });
    assert.equal(blocked.status, 409);
  });

  test('参数校验:越界的数值、写错的质量档、别的设备的规则', async () => {
    const app = newApp();
    assert.equal((await api(app, 'POST', '/rules', { mac: MAC, name: '数学', target_minutes: 0 })).status, 400);
    assert.equal((await api(app, 'POST', '/rules', { mac: MAC, name: '数学', target_minutes: 40, q_good: 999 })).status, 400);
    assert.equal((await api(app, 'POST', '/rules', { mac: 'zz', name: '数学', target_minutes: 40 })).status, 404);
    const rule = await mathRule(app);
    const task = await assign(app, rule.id);
    assert.equal((await api(app, 'POST', `/tasks/${task.id}/result`, { actual_minutes: 30, quality: 'great' })).status, 400);

    run(conn, 'INSERT INTO devices (mac, agent_id) VALUES (?, ?)', 'aa:bb:cc:dd:ee:02', DEFAULT_AGENT_ID);
    const cross = await api(app, 'POST', '/tasks', { mac: 'aa:bb:cc:dd:ee:02', items: [{ rule_id: rule.id }] });
    assert.equal(cross.status, 404, '不能拿别的孩子的规则布置');
  });
});

describe('奖励与流水', () => {
  test('分不够不能兑换,余额不变;够了就扣分并记一笔', async () => {
    const app = newApp();
    const tv = (await api(app, 'POST', '/rewards', { mac: MAC, name: '看电视 30 分钟', cost: 20, emoji: '📺' })).data.item;

    const poor = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: tv.id });
    assert.equal(poor.status, 409);
    assert.match(poor.data.error, /还差 20 分/u);
    assert.equal(balanceOf(), 0);

    await api(app, 'POST', '/adjust', { mac: MAC, delta: 25, reason: '帮妈妈洗碗' });
    const ok = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: tv.id });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.balance, 5);
    assert.equal(ok.data.ledger.delta, -20);
    assert.equal(ok.data.ledger.title, '📺 看电视 30 分钟');

    // 撤销兑换:分退回
    assert.equal((await api(app, 'POST', `/ledger/${ok.data.ledger.id}/revert`)).data.balance, 25);
  });

  test('负余额时同样不能兑换', async () => {
    const app = newApp();
    const toy = (await api(app, 'POST', '/rewards', { mac: MAC, name: '小玩具', cost: 1 })).data.item;
    await api(app, 'POST', '/adjust', { mac: MAC, delta: -3, reason: '打架' });
    assert.equal((await api(app, 'POST', '/redeem', { mac: MAC, reward_id: toy.id })).status, 409);
  });

  test('手动奖惩要写原因,不能是 0', async () => {
    const app = newApp();
    assert.equal((await api(app, 'POST', '/adjust', { mac: MAC, delta: 0, reason: 'x' })).status, 400);
    assert.equal((await api(app, 'POST', '/adjust', { mac: MAC, delta: 5, reason: ' ' })).status, 400);
  });

  test('流水倒序翻页,每条带当时的余额', async () => {
    const app = newApp();
    for (const delta of [10, -3, 5]) await api(app, 'POST', '/adjust', { mac: MAC, delta, reason: `调整${delta}` });
    const page1 = await api(app, 'GET', `/ledger?mac=${COMPACT}&limit=2`);
    assert.deepEqual(page1.data.items.map((i: any) => [i.delta, i.balance_after]), [[5, 12], [-3, 7]]);
    assert.ok(page1.data.next);
    const page2 = await api(app, 'GET', `/ledger?mac=${COMPACT}&limit=2&before=${page1.data.next}`);
    assert.deepEqual(page2.data.items.map((i: any) => [i.delta, i.balance_after]), [[10, 10]]);
    assert.equal(page2.data.next, null);
  });

  test('兑换过的奖励删除变归档', async () => {
    const app = newApp();
    const tv = (await api(app, 'POST', '/rewards', { mac: MAC, name: '看电视', cost: 1 })).data.item;
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 5, reason: '奖励' });
    await api(app, 'POST', '/redeem', { mac: MAC, reward_id: tv.id });
    assert.equal((await api(app, 'DELETE', `/rewards/${tv.id}`)).data.result, 'archived');
    assert.equal((await api(app, 'GET', `/rewards?mac=${COMPACT}`)).data.items.length, 0);
  });

  test('一键示例:空设备建好三条规则三个奖励,已有的不重复建', async () => {
    const app = newApp();
    const first = await api(app, 'POST', '/examples', { mac: MAC });
    assert.deepEqual([first.data.rules, first.data.rewards], [3, 3]);
    const second = await api(app, 'POST', '/examples', { mac: MAC });
    assert.deepEqual([second.data.rules, second.data.rewards], [0, 0]);
    const overview = await api(app, 'GET', `/overview?mac=${COMPACT}`);
    assert.deepEqual(overview.data.counts, { rules: 3, rewards: 3 });
    assert.equal(overview.data.today, '2026-09-22');
  });

  test('解绑设备时学分一起删掉', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 5, reason: '奖励' });
    await call(app, 'DELETE', `/api/devices/${COMPACT}`);
    for (const table of ['credit_rules', 'credit_rewards', 'credit_ledger']) {
      assert.equal(one<{ n: number }>(conn, `SELECT COUNT(*) AS n FROM ${table}`)!.n, 0, table);
    }
  });
});

// ---------------------------------------------------------------- v1 接口补齐

describe('v1 接口:按 id 读、部分更新、恢复、排序、筛选', () => {
  test('按 id 读取;PATCH 与 PUT 都是部分更新;错误带 code', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    assert.equal((await api(app, 'GET', `/rules/${rule.id}`)).data.item.name, '数学作业');
    const patched = await api(app, 'PATCH', `/rules/${rule.id}`, { q_good: 4 });
    assert.equal(patched.data.item.q_good, 4);
    assert.equal(patched.data.item.target_minutes, 40, '没传的字段不动');
    const put = await api(app, 'PUT', `/rules/${rule.id}`, { name: '数学练习' });
    assert.deepEqual([put.data.item.name, put.data.item.q_good], ['数学练习', 4]);

    const missing = await api(app, 'GET', '/rules/9999');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'not_found');
    const invalid = await api(app, 'PATCH', `/rules/${rule.id}`, { q_good: 999 });
    assert.equal(invalid.data.code, 'invalid');
    const noDevice = await api(app, 'GET', '/rules?mac=aabbccddee99');
    assert.equal(noDevice.data.code, 'device_not_found');
  });

  test('停用的规则与奖励可以恢复;排序按给定顺序', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const rules = (await api(app, 'GET', `/rules?mac=${COMPACT}`)).data.items as { id: number; name: string }[];
    await assign(app, rules[0]!.id);
    await api(app, 'DELETE', `/rules/${rules[0]!.id}`);
    assert.equal((await api(app, 'GET', `/rules?mac=${COMPACT}`)).data.items.length, 2);
    assert.equal((await api(app, 'GET', `/rules?mac=${COMPACT}&archived=1`)).data.items.length, 3);
    await api(app, 'POST', `/rules/${rules[0]!.id}/restore`);
    assert.equal((await api(app, 'GET', `/rules?mac=${COMPACT}`)).data.items.length, 3);

    const reversed = rules.map((r) => r.id).reverse();
    const reordered = await api(app, 'POST', '/rules/reorder', { mac: COMPACT, ids: reversed });
    assert.deepEqual(reordered.data.items.map((r: any) => r.id), reversed);

    const rewards = (await api(app, 'GET', `/rewards?mac=${COMPACT}`)).data.items as { id: number }[];
    const rewardOrder = rewards.map((r) => r.id).reverse();
    assert.deepEqual((await api(app, 'POST', '/rewards/reorder', { mac: MAC, ids: rewardOrder })).data.items.map((r: any) => r.id), rewardOrder);
  });

  test('临时作业不挂规则、参数现填;按日期段与状态查历史并翻页', async () => {
    const app = newApp();
    const custom = await api(app, 'POST', '/tasks/custom', { mac: MAC, day: '2026-09-20', name: '练钢琴', target_minutes: 30, ontime_points: 8 });
    assert.equal(custom.data.item.rule_id, null);
    assert.equal(custom.data.item.ontime_points, 8);
    assert.equal(custom.data.item.q_good, 3, '没填的用默认');

    const rule = await mathRule(app);
    for (const day of ['2026-09-20', '2026-09-21', '2026-09-22']) {
      await api(app, 'POST', '/tasks', { mac: MAC, day, items: [{ rule_id: rule.id }] });
    }
    const t21 = (await api(app, 'GET', `/tasks?mac=${COMPACT}&day=2026-09-21`)).data.items[0];
    await api(app, 'POST', `/tasks/${t21.id}/result`, { actual_minutes: 30, quality: 'good' });

    const page1 = await api(app, 'GET', `/tasks?mac=${COMPACT}&from=2026-09-20&to=2026-09-22&limit=2`);
    assert.deepEqual(page1.data.items.map((t: any) => t.day), ['2026-09-22', '2026-09-21']);
    const page2 = await api(app, 'GET', `/tasks?mac=${COMPACT}&from=2026-09-20&to=2026-09-22&limit=2&before=${page1.data.next}`);
    assert.deepEqual(page2.data.items.map((t: any) => t.day), ['2026-09-20', '2026-09-20']);
    assert.equal(page2.data.next, null);

    const done = await api(app, 'GET', `/tasks?mac=${COMPACT}&status=done`);
    assert.deepEqual(done.data.items.map((t: any) => t.id), [t21.id]);
    assert.equal((await api(app, 'GET', `/tasks?mac=${COMPACT}&status=bogus`)).data.code, 'invalid');
  });

  test('孩子报完成只记申报不加分;驳回后清掉;按 claimed 筛得出来', async () => {
    const app = newApp();
    const task = await assign(app, (await mathRule(app)).id);
    const claimed = await api(app, 'POST', `/tasks/${task.id}/claim`, { minutes: 35, note: '写完啦' });
    assert.ok(claimed.data.item.claimed_at);
    assert.equal(claimed.data.item.claimed_minutes, 35);
    assert.equal(claimed.data.item.status, 'pending');
    assert.equal(balanceOf(), 0, '申报不加分');
    assert.equal((await api(app, 'GET', `/tasks?mac=${COMPACT}&status=claimed`)).data.items.length, 1);
    assert.equal((await api(app, 'GET', `/overview?mac=${COMPACT}`)).data.pending_claims, 1);

    const rejected = await api(app, 'DELETE', `/tasks/${task.id}/claim`);
    assert.equal(rejected.data.item.claimed_at, null);
    assert.equal((await api(app, 'GET', `/tasks?mac=${COMPACT}&status=claimed`)).data.items.length, 0);
  });

  test('流水按类型、日期筛选;按 id 读取;每笔记下来源', async () => {
    const app = newApp();
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 30, reason: '奖励' });
    const tv = (await api(app, 'POST', '/rewards', { mac: MAC, name: '看电视', cost: 10 })).data.item;
    const redeemed = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: tv.id });
    const onlyRedeem = await api(app, 'GET', `/ledger?mac=${COMPACT}&kind=redeem`);
    assert.deepEqual(onlyRedeem.data.items.map((i: any) => i.kind), ['redeem']);
    const one = await api(app, 'GET', `/ledger/${redeemed.data.ledger.id}`);
    assert.equal(one.data.item.balance_after, 20);
    assert.equal(one.data.item.source, 'admin');
    assert.equal((await api(app, 'GET', `/ledger?mac=${COMPACT}&from=2099-01-01`)).data.items.length, 0);
  });

  test('统计:每天挣/扣/花与流水对得上,撤销过的不计;完成率与按时率', async () => {
    const app = newApp();
    const rule = await mathRule(app);
    const a = await assign(app, rule.id);
    const b = await assign(app, rule.id);
    const c = await assign(app, rule.id);
    await api(app, 'POST', `/tasks/${a.id}/result`, { actual_minutes: 30, quality: 'excellent' });   // +10
    await api(app, 'POST', `/tasks/${b.id}/result`, { actual_minutes: 70, quality: 'poor' });        // -3 -2 = -5
    await api(app, 'POST', `/tasks/${c.id}/missed`, {});                                              // -5
    const wrong = await api(app, 'POST', '/adjust', { mac: MAC, delta: 50, reason: '手滑' });
    await api(app, 'POST', `/ledger/${wrong.data.ledger.id}/revert`);

    const s = (await api(app, 'GET', `/stats?mac=${COMPACT}`)).data;
    assert.equal(s.days.length, 7, '默认最近 7 天');
    const todayRow = s.days.at(-1);
    assert.equal(todayRow.day, '2026-09-22');
    assert.deepEqual([todayRow.earned, todayRow.penalty, todayRow.spent], [10, 10, 0], '手滑那笔撤销了不计');
    assert.equal(s.balance, 0);
    assert.equal(s.tasks[0].assigned, 3);
    assert.equal(s.tasks[0].ontime, 1);
    assert.equal(s.completion_rate, 0.667);
    assert.equal(s.ontime_rate, 0.5);
    assert.equal((await api(app, 'GET', `/stats?mac=${COMPACT}&from=2026-09-23&to=2026-09-22`)).status, 400);
  });

  test('meta 给出取值范围与今天', async () => {
    const meta = (await api(newApp(), 'GET', '/meta')).data;
    assert.equal(meta.today, '2026-09-22');
    assert.deepEqual(meta.ranges.target_minutes, [1, 600]);
    assert.equal(meta.qualities.length, 4);
  });
});

// ---------------------------------------------------------------- 外部接口

const OPEN = '/open/v1/credits';
const open = (app: App, method: string, path: string, key: string, body?: unknown, extra: Record<string, string> = {}) =>
  call(app, method, `${OPEN}${path}`, body, { authorization: `Bearer ${key}`, ...extra });
const newKey = async (app: App, name: string, scope: 'read' | 'write' = 'write') =>
  (await api(app, 'POST', '/keys', { name, scope })).data as { key: string; item: { id: number; prefix: string } };

describe('外部接口 /open/v1/credits', () => {
  test('一把都没有时整组 404;没带或带错密钥 401;带对了与页面接口一致;一期的旧路径不存在', async () => {
    const app = newApp();
    assert.equal((await call(app, 'GET', `${OPEN}/overview?mac=${COMPACT}`)).status, 404);
    const { key } = await newKey(app, '妈妈的手机');
    assert.match(key, /^xdc_/u);
    assert.equal((await call(app, 'GET', `${OPEN}/overview?mac=${COMPACT}`)).status, 401);
    assert.equal((await open(app, 'GET', `/overview?mac=${COMPACT}`, 'xdc_wrong')).status, 401);

    await api(app, 'POST', '/adjust', { mac: MAC, delta: 7, reason: '页面加的' });
    assert.equal((await open(app, 'GET', `/children/${COMPACT}`, key)).data.item.balance, 7);
    const viaOpen = await open(app, 'POST', '/adjust', key, { mac: COMPACT, delta: 3, reason: 'App 加的' });
    assert.equal(viaOpen.data.balance, 10);
    assert.deepEqual([viaOpen.data.ledger.source, viaOpen.data.ledger.actor], ['api', '妈妈的手机'], '流水记下是哪把密钥');

    const old = await call(app, 'GET', `/open/credits/overview?mac=${COMPACT}`, undefined, { authorization: `Bearer ${key}` });
    assert.notEqual(old.data?.balance, 10, '一期路径已经不再提供接口');
  });

  test('多把密钥各自可用;只读的不能写;吊销后 401;列表里没有明文', async () => {
    const app = newApp();
    const mom = await newKey(app, '妈妈的手机');
    const tablet = await newKey(app, '客厅平板', 'read');
    assert.equal((await open(app, 'GET', '/children', tablet.key)).status, 200);
    const denied = await open(app, 'POST', '/adjust', tablet.key, { mac: COMPACT, delta: 5, reason: 'x' });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'read_only_key');

    const list = (await api(app, 'GET', '/keys')).data.items as any[];
    assert.equal(list.length, 2);
    assert.ok(list.every((k) => !('hash' in k) && k.prefix.length === 8));
    assert.ok(!JSON.stringify(list).includes(mom.key), '列表里没有明文');

    await api(app, 'PATCH', `/keys/${mom.item.id}`, { name: '妈妈的新手机' });
    await api(app, 'DELETE', `/keys/${mom.item.id}`);
    assert.equal((await open(app, 'GET', '/children', mom.key)).status, 401, '吊销后不认');
    assert.equal((await open(app, 'GET', '/children', tablet.key)).status, 200, '别的密钥不受影响');
    const revoked = (await api(app, 'GET', '/keys')).data.items.find((k: any) => k.id === mom.item.id);
    assert.ok(revoked.revoked_at);
    assert.equal(revoked.name, '妈妈的新手机');

    assert.equal((await open(app, 'GET', '/keys', tablet.key)).status, 404, '密钥管理不在外部接口上');
  });

  test('Idempotency-Key:同一个值重复兑换只扣一次、回放同样结果;换一把密钥不串;换个请求用同一个值 422', async () => {
    const app = newApp();
    const { key } = await newKey(app, 'App');
    const other = await newKey(app, '快捷指令');
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 100, reason: '起步' });
    const tv = (await api(app, 'POST', '/rewards', { mac: MAC, name: '看电视', cost: 20 })).data.item;
    const idem = { 'idempotency-key': 'order-001' };

    const first = await open(app, 'POST', '/redeem', key, { mac: COMPACT, reward_id: tv.id }, idem);
    const again = await open(app, 'POST', '/redeem', key, { mac: COMPACT, reward_id: tv.id }, idem);
    assert.equal(first.data.balance, 80);
    assert.deepEqual(again.data, first.data, '回放第一次的结果');
    assert.equal(balanceOf(), 80, '只扣了一次');

    const otherKey = await open(app, 'POST', '/redeem', other.key, { mac: COMPACT, reward_id: tv.id }, idem);
    assert.equal(otherKey.data.balance, 60, '别的密钥用同样的值是另一个请求');

    const reused = await open(app, 'POST', '/adjust', key, { mac: COMPACT, delta: 1, reason: 'x' }, idem);
    assert.equal(reused.status, 422);
    assert.equal(reused.data.code, 'idempotency_key_reused');
  });

  test('CORS 预检不要密钥;响应带允许的来源与请求头', async () => {
    const app = newApp();
    await newKey(app, 'App');
    const response = await app.request(`http://localhost${OPEN}/redeem`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key' },
    });
    assert.ok(response.status < 300);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Idempotency-Key/iu);
  });

  test('openapi.json 不要密钥;覆盖路由注册的每个端点;取值范围与校验一致', async () => {
    const app = newApp();
    const response = await call(app, 'GET', `${OPEN}/openapi.json`);
    assert.equal(response.status, 200);
    const spec = response.data;
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.servers[0].url, OPEN);

    const { creditRoutes } = await import('../src/credits/routes.ts');
    const registered = new Set(creditRoutes(conn).routes
      .filter((r) => r.method !== 'ALL' && r.path !== '/openapi.json')
      .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/gu, '{$1}')}`));
    const documented = new Set(Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m} ${path}`)));
    assert.deepEqual([...registered].filter((r) => !documented.has(r)), [], '路由里有、文档里没有');
    assert.deepEqual([...documented].filter((d) => !registered.has(d)), [], '文档里有、路由里没有');

    const ruleBody = spec.paths['/rules'].post.requestBody.content['application/json'].schema;
    assert.deepEqual([ruleBody.properties.target_minutes.minimum, ruleBody.properties.target_minutes.maximum], [1, 600]);
    assert.ok(ruleBody.required.includes('mac'));
  });
});

// ---------------------------------------------------------------- 智能体工具

describe('智能体的学分工具', () => {
  const agentCtx = (mac: string | null = MAC) => ({
    deps: { conn, now: () => clock },
    agent: { id: DEFAULT_AGENT_ID, name: '小单伴学' },
    device: { mac, sessionId: null, turnId: null, clientIp: null, features: {} },
  }) as any;
  const enable = () => run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'credits', '{}')", DEFAULT_AGENT_ID);
  const tools = async () => {
    const { collectTools } = await import('../src/agent/registry.ts');
    await import('../src/agent/index.ts');
    return collectTools(agentCtx());
  };
  const tool = async (name: string) => (await tools()).find((t) => t.name === name)!;

  test('角色没开时没有;开了只有查、报完成、兑换三个,没有任何能加分打分的', async () => {
    assert.equal((await tools()).filter((t) => t.name.startsWith('credits_')).length, 0);
    enable();
    const names = (await tools()).filter((t) => t.name.startsWith('credits_')).map((t) => t.name).sort();
    assert.deepEqual(names, ['credits_redeem', 'credits_report_done', 'credits_status']);
    for (const t of await tools()) {
      if (t.name.startsWith('credits_')) assert.match(t.description, /只能由爸爸妈妈/u);
    }
  });

  test('查学分:余额、每项作业的状态、每个奖励的比例与能换多少、换到手的余额', async () => {
    enable();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    await api(app, 'POST', '/rewards', { mac: MAC, name: '买个小玩具', cost: 200, emoji: '🧸' });
    const rules = (await api(app, 'GET', `/rules?mac=${COMPACT}`)).data.items;
    await api(app, 'POST', '/tasks', { mac: MAC, items: [{ rule_id: rules[0].id }, { rule_id: rules[1].id }] });
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 38, reason: '奖励' });
    const money = (await api(app, 'GET', `/rewards?mac=${COMPACT}`)).data.items.find((r: any) => r.name === '零花钱');
    await api(app, 'POST', '/redeem', { mac: MAC, reward_id: money.id, times: 2 });
    const result = await (await tool('credits_status')).run(agentCtx(), {});
    assert.match(result.content, /现在有 18 分/u);
    assert.match(result.content, /语文作业\(编号 \d+\):还没做/u);
    assert.match(result.content, /🎮 玩游戏:10 分换 5 分钟,现在最多能换 1 份\(5 分钟\)/u);
    assert.match(result.content, /🧸 买个小玩具:要 200 分,还差 182 分/u);
    assert.match(result.content, /💰 零花钱还有 10 元/u);
  });

  test('报完成按名字模糊匹配,只记申报不加分;对上多项时列出候选', async () => {
    enable();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const rules = (await api(app, 'GET', `/rules?mac=${COMPACT}`)).data.items;
    await api(app, 'POST', '/tasks', { mac: MAC, items: rules.map((r: any) => ({ rule_id: r.id })) });
    const report = await tool('credits_report_done');

    const ok = await report.run(agentCtx(), { task: '数学', minutes: 35 });
    assert.equal(ok.ok, true);
    assert.match(ok.content, /还没有加分/u);
    assert.equal(balanceOf(), 0);
    const math = (await api(app, 'GET', `/tasks?mac=${COMPACT}&status=claimed`)).data.items;
    assert.deepEqual([math.length, math[0].name, math[0].claimed_minutes], [1, '数学作业', 35]);

    const again = await report.run(agentCtx(), { task: '数学作业' });
    assert.match(again.content, /已经报过/u);
    const unknown = await report.run(agentCtx(), { task: '体育' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.content, /语文作业/u);

    // 去掉「作业」后完全对上的优先:「数学」认作「数学作业」,不和「数学口算」混
    await api(app, 'POST', '/tasks/custom', { mac: MAC, name: '钢琴练习', target_minutes: 20 });
    await api(app, 'POST', '/tasks/custom', { mac: MAC, name: '钢琴乐理', target_minutes: 20 });
    const ambiguous = await report.run(agentCtx(), { task: '钢琴' });
    assert.match(ambiguous.content, /好几项.*钢琴练习.*钢琴乐理/u);
  });

  test('兑换:够分直接扣、流水记是智能体;不够说差多少与还能挣分的作业', async () => {
    enable();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const redeemTool = await tool('credits_redeem');

    const short = await redeemTool.run(agentCtx(), { reward: '看电视' });
    assert.equal(short.ok, false);
    assert.match(short.content, /还差 10 分/u);

    await api(app, 'POST', '/adjust', { mac: MAC, delta: 25, reason: '奖励' });
    const ok = await redeemTool.run(agentCtx(), { reward: '看电视' });
    assert.equal(ok.ok, true);
    assert.match(ok.content, /还剩 15 分/u);
    assert.match(ok.content, /看电视现在有 10 分钟/u);
    const last = (await api(app, 'GET', `/ledger?mac=${COMPACT}&kind=redeem`)).data.items[0];
    assert.deepEqual([last.source, last.actor], ['agent', '小单伴学']);
  });

  test('没有设备时如实说', async () => {
    enable();
    const result = await (await tool('credits_status')).run(agentCtx(null), {});
    assert.equal(result.ok, false);
  });
});

describe('家长 App 用设备身份调外部接口', () => {
  const APP_MAC = '02:5a:00:00:00:01';
  const APP_SECRET = '0123456789abcdef'.repeat(4);
  const TOY_SECRET = 'fedcba9876543210'.repeat(4);
  const bindApp = async () => {
    const { hashClientId } = await import('../src/identity.ts');
    run(conn, 'INSERT INTO devices (mac, agent_id, alias, board, secret_hash) VALUES (?, ?, ?, ?, ?)',
      APP_MAC, DEFAULT_AGENT_ID, '妈妈的 App', 'xiaodan-app', hashClientId(APP_SECRET));
    run(conn, 'UPDATE devices SET secret_hash = ? WHERE mac = ?', hashClientId(TOY_SECRET), MAC);
  };
  const asDevice = (app: App, method: string, path: string, deviceId: string, clientId: string, body?: unknown) =>
    call(app, method, `${OPEN}${path}`, body, { 'device-id': deviceId, 'client-id': clientId });

  test('已绑定的 App 不用建密钥就能读写,流水记 App 名;玩具的身份 403;身份不对 401', async () => {
    await bindApp();
    const app = newApp();
    const children = await asDevice(app, 'GET', '/children', '025a00000001', APP_SECRET);
    assert.equal(children.status, 200);
    assert.deepEqual(children.data.items.map((c: any) => c.mac), [MAC], '孩子列表里没有 App 自己');

    const added = await asDevice(app, 'POST', '/adjust', APP_MAC, APP_SECRET, { mac: COMPACT, delta: 4, reason: 'App 按钮' });
    assert.equal(added.status, 200);
    assert.deepEqual([added.data.ledger.source, added.data.ledger.actor], ['api', '妈妈的 App']);

    const toy = await asDevice(app, 'GET', '/children', MAC, TOY_SECRET);
    assert.deepEqual([toy.status, toy.data.code], [403, 'not_app_device']);
    assert.equal((await asDevice(app, 'GET', '/children', APP_MAC, '13579bdf02468ace'.repeat(4))).status, 401);
    assert.equal((await asDevice(app, 'GET', '/children', '02:5a:00:00:00:09', APP_SECRET)).status, 401);
    assert.equal((await asDevice(app, 'GET', '/children', APP_MAC, 'not-hex')).status, 401);
  });

  test('App 设备不算孩子:按它的 MAC 查学分 404;命名密钥照旧可用;设备身份也能防重复提交', async () => {
    await bindApp();
    const app = newApp();
    const asChild = await asDevice(app, 'GET', `/children/025a00000001`, APP_MAC, APP_SECRET);
    assert.equal(asChild.status, 404);
    const overview = (await api(app, 'GET', '/overview')).data;
    assert.ok(!JSON.stringify(overview).includes(APP_MAC), '页面概览的设备列表不含 App');

    const { key } = await newKey(app, '快捷指令');
    assert.equal((await open(app, 'GET', '/children', key)).status, 200);

    const body = { mac: COMPACT, delta: 2, reason: '重试' };
    const headers = { 'device-id': APP_MAC, 'client-id': APP_SECRET, 'idempotency-key': 'k1' };
    await call(app, 'POST', `${OPEN}/adjust`, body, headers);
    const replay = await app.request(`http://localhost${OPEN}/adjust`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(balanceOf(), 2);
  });
});

describe('智能体的大人版学分工具', () => {
  const agentCtx = (mac: string | null = MAC) => ({
    deps: { conn, now: () => clock },
    agent: { id: DEFAULT_AGENT_ID, name: '家长助手' },
    device: { mac, sessionId: null, turnId: null, clientIp: null, features: {} },
  }) as any;
  const enable = (code = 'credits_parent') =>
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, '{}')", DEFAULT_AGENT_ID, code);
  const tools = async (mac: string | null = MAC) => {
    const { collectTools } = await import('../src/agent/registry.ts');
    await import('../src/agent/index.ts');
    return collectTools(agentCtx(mac));
  };
  const tool = async (name: string) => (await tools()).find((t) => t.name === name)!;
  const APP_MAC = '02:5a:00:00:00:01';
  const addApp = () => run(conn, 'INSERT INTO devices (mac, agent_id, alias, board) VALUES (?, ?, ?, ?)',
    APP_MAC, DEFAULT_AGENT_ID, '妈妈的 App', 'xiaodan-app');

  test('没开时没有;开了十一个函数;和儿童版同时开也不撞名', async () => {
    assert.equal((await tools()).filter((t) => t.name.startsWith('credits_')).length, 0);
    enable();
    const names = (await tools()).filter((t) => t.name.startsWith('credits_')).map((t) => t.name);
    assert.equal(names.length, 12);
    enable('credits');
    const both = (await tools()).filter((t) => t.name.startsWith('credits_')).map((t) => t.name);
    assert.equal(both.length, 15);
    assert.equal(new Set(both).size, 15);
  });

  test('操作哪个孩子:玩具上默认它自己;App 上只有一个孩子就用他;多个孩子要问;App 不算孩子', async () => {
    enable();
    addApp();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const overview = await tool('credits_overview');
    assert.match((await overview.run(agentCtx(APP_MAC), {})).content, /乐乐的小单 现在有 0 分/u);
    assert.match((await overview.run(agentCtx(null), {})).content, /乐乐的小单/u);

    run(conn, 'INSERT INTO devices (mac, agent_id, alias) VALUES (?, ?, ?)', '4c:11:ae:31:7a:31', DEFAULT_AGENT_ID, '豆豆');
    const ask = await overview.run(agentCtx(APP_MAC), {});
    assert.equal(ask.ok, false);
    assert.match(ask.content, /好几个孩子/u);
    assert.doesNotMatch(ask.content, /妈妈的 App/u);
    assert.match((await overview.run(agentCtx(APP_MAC), { child: '豆豆' })).content, /豆豆 现在有 0 分/u);
    assert.match((await overview.run(agentCtx(MAC), {})).content, /乐乐的小单 现在有/u, '对着玩具说话默认就是它');
    assert.equal((await overview.run(agentCtx(APP_MAC), { child: '妈妈的 App' })).ok, false);
  });

  test('布置:按规则名、可改用时;没规则带用时建临时作业;有一项对不上整批不布置', async () => {
    enable();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const assignTool = await tool('credits_assign');

    const bad = await assignTool.run(agentCtx(), { tasks: [{ name: '数学' }, { name: '体育' }] });
    assert.equal(bad.ok, false);
    assert.match(bad.content, /体育/u);
    assert.equal((await api(app, 'GET', `/tasks?mac=${COMPACT}`)).data.items.length, 0);

    const ok = await assignTool.run(agentCtx(), { tasks: [{ name: '数学', minutes: 30 }, { name: '体育', minutes: 20 }] });
    assert.equal(ok.ok, true);
    const tasks = (await api(app, 'GET', `/tasks?mac=${COMPACT}`)).data.items;
    assert.deepEqual(tasks.map((t: any) => [t.name, t.target_minutes, t.rule_id === null]),
      [['数学作业', 30, false], ['体育', 20, true]]);
  });

  test('打分、没完成、改删、驳回申报;流水记智能体', async () => {
    enable();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    await (await tool('credits_assign')).run(agentCtx(), { tasks: [{ name: '语文' }, { name: '数学' }, { name: '英语' }] });

    const scored = await (await tool('credits_score')).run(agentCtx(), { task: '数学', minutes: 45, quality: '良' });
    assert.equal(scored.ok, true);
    assert.match(scored.content, /超时 5 分钟.*合计 \+2/u);
    const again = await (await tool('credits_score')).run(agentCtx(), { task: '数学', minutes: 45, quality: 'good' });
    assert.equal(again.ok, false, '打过分的不能再打');

    const missed = await (await tool('credits_mark_missed')).run(agentCtx(), { task: '英语' });
    assert.match(missed.content, /扣 5 分/u);
    assert.equal(balanceOf(), -3);

    const edit = await tool('credits_edit_task');
    const yuwen = (await api(app, 'GET', `/tasks?mac=${COMPACT}`)).data.items.find((t: any) => t.name === '语文作业');
    await api(app, 'POST', `/tasks/${yuwen.id}/claim`, { minutes: 30 });
    assert.match((await edit.run(agentCtx(), { task: '语文', action: 'reject_claim' })).content, /已驳回/u);
    assert.match((await edit.run(agentCtx(), { task: '语文', action: 'update', minutes: 50 })).content, /规定 50 分钟/u);
    assert.match((await edit.run(agentCtx(), { task: String(yuwen.id), action: 'delete' })).content, /已删除/u);

    const ledger = (await api(app, 'GET', `/ledger?mac=${COMPACT}`)).data.items;
    assert.ok(ledger.every((row: any) => row.source === 'agent' && row.actor === '家长助手'));
  });

  test('加减分、代兑换、撤销最近一笔(打分被撤销后作业回到待完成)', async () => {
    enable();
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    assert.equal((await (await tool('credits_adjust')).run(agentCtx(), { points: 0, reason: 'x' })).ok, false);
    assert.equal((await (await tool('credits_adjust')).run(agentCtx(), { points: 5 })).ok, false, '要写原因');
    assert.match((await (await tool('credits_adjust')).run(agentCtx(), { points: 30, reason: '帮忙洗碗' })).content, /现在有 30 分/u);
    assert.match((await (await tool('credits_redeem_for')).run(agentCtx(), { reward: '看电视' })).content, /还剩 20 分/u);
    const tooMuch = await (await tool('credits_redeem_for')).run(agentCtx(), { reward: '零花钱', amount: 25 });
    assert.equal(tooMuch.ok, false);
    assert.match(tooMuch.content, /换 5 份要 50 分,还差 30 分/u);

    const undo = await tool('credits_undo');
    assert.match((await undo.run(agentCtx(), {})).content, /撤销流水 \d+「📺 看电视\(10 分钟\)」.*现在有 30 分.*余额现在 0 分钟/u);
    assert.match((await undo.run(agentCtx(), {})).content, /帮忙洗碗.*现在有 0 分/u);
    assert.equal((await undo.run(agentCtx(), {})).ok, false, '没有能撤的了');

    await (await tool('credits_assign')).run(agentCtx(), { tasks: [{ name: '数学' }] });
    await (await tool('credits_score')).run(agentCtx(), { task: '数学', minutes: 30, quality: '优' });
    assert.match((await undo.run(agentCtx(), {})).content, /回到待完成/u);
    assert.equal((await api(app, 'GET', `/tasks?mac=${COMPACT}`)).data.items[0].status, 'pending');
  });

  test('规则与奖励增改删恢复;历史带流水编号', async () => {
    enable();
    const app = newApp();
    const rule = await tool('credits_manage_rule');
    assert.equal((await rule.run(agentCtx(), { action: 'create', name: '钢琴' })).ok, false, '新建要规定用时');
    assert.match((await rule.run(agentCtx(), { action: 'create', name: '钢琴', target_minutes: 30, q_poor: -5 })).content, /规定 30 分钟.*-5/u);
    assert.equal((await rule.run(agentCtx(), { action: 'create', name: '钢琴', target_minutes: 30 })).ok, false, '不重名');
    assert.equal((await rule.run(agentCtx(), { action: 'update', name: '钢琴', ontime_points: 999 })).ok, false, '越界');
    assert.match((await rule.run(agentCtx(), { action: 'update', name: '钢琴', new_name: '钢琴练习', ontime_points: 8 })).content, /钢琴练习.*按时 \+8/u);
    await (await tool('credits_assign')).run(agentCtx(), { tasks: [{ name: '钢琴练习' }] });
    assert.match((await rule.run(agentCtx(), { action: 'delete', name: '钢琴练习' })).content, /停用/u);
    assert.match((await rule.run(agentCtx(), { action: 'restore', name: '钢琴练习' })).content, /已恢复/u);

    const reward = await tool('credits_manage_reward');
    assert.equal((await reward.run(agentCtx(), { action: 'create', name: '去公园' })).ok, false, '要说多少分');
    assert.match((await reward.run(agentCtx(), { action: 'create', name: '去公园', cost: 50, emoji: '🌳' })).content, /🌳 去公园.*50 分/u);
    assert.match((await reward.run(agentCtx(), { action: 'update', name: '公园', cost: 40 })).content, /40 分/u);
    assert.match((await reward.run(agentCtx(), { action: 'delete', name: '去公园' })).content, /已删除/u);
    assert.equal((await api(app, 'GET', `/rewards?mac=${COMPACT}&archived=1`)).data.items.length, 0);

    await (await tool('credits_adjust')).run(agentCtx(), { points: 6, reason: '整理房间' });
    const history = await (await tool('credits_history')).run(agentCtx(), { days: 3 });
    assert.match(history.content, /最近 3 天.*挣 6/u);
    assert.match(history.content, /流水 \d+.*智能体「家长助手」.*整理房间 \+6/u);
  });
});

describe('按份兑换与时间 / 零花钱余额', () => {
  const rewardsByName = async (app: App) =>
    Object.fromEntries((await api(app, 'GET', `/rewards?mac=${COMPACT}`)).data.items.map((r: any) => [r.name, r]));
  const wallet = async (app: App, name: string) =>
    (await api(app, 'GET', `/wallets?mac=${COMPACT}`)).data.items.find((w: any) => w.name === name);

  test('示例就是 10 分 = 5 分钟游戏 / 5 元 / 10 分钟电视;时间与零花钱要填一份换多少,钱最多两位小数', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    assert.deepEqual(['玩游戏', '零花钱', '看电视'].map((n) => [r[n].kind, r[n].cost, r[n].amount, r[n].unit, r[n].wallet_balance]),
      [['time', 10, 5, '分钟', 0], ['money', 10, 5, '元', 0], ['time', 10, 10, '分钟', 0]]);

    const noAmount = await api(app, 'POST', '/rewards', { mac: MAC, name: '看动画', cost: 10, kind: 'time' });
    assert.deepEqual([noAmount.status, noAmount.data.code], [400, 'invalid']);
    assert.equal((await api(app, 'POST', '/rewards', { mac: MAC, name: '半分钟', cost: 1, kind: 'time', amount: 2.5 })).status, 400);
    assert.equal((await api(app, 'POST', '/rewards', { mac: MAC, name: '一厘钱', cost: 1, kind: 'money', amount: 0.001 })).status, 400);
    const cents = (await api(app, 'POST', '/rewards', { mac: MAC, name: '硬币', cost: 1, kind: 'money', amount: 0.5 })).data.item;
    assert.deepEqual([cents.amount, cents.unit], [0.5, '元']);
    const item = (await api(app, 'POST', '/rewards', { mac: MAC, name: '贴纸', cost: 3, amount: 9 })).data.item;
    assert.deepEqual([item.kind, item.amount, item.unit, 'wallet_balance' in item], ['item', 1, '份', false], '物品不看 amount、没有余额');
  });

  test('整份兑换:扣 cost × times、进账 amount × times、流水记份数;分不够 409;份数越界 400', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 50, reason: '攒的' });

    const game = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['玩游戏'].id, times: 3 });
    assert.equal(game.status, 200);
    assert.deepEqual([game.data.balance, game.data.ledger.delta, game.data.ledger.times, game.data.ledger.title],
      [20, -30, 3, '🎮 玩游戏 ×3(15 分钟)']);
    assert.deepEqual([game.data.wallet.balance, game.data.wallet.unit, game.data.wallet.entry.amount, game.data.wallet.entry.kind],
      [15, '分钟', 15, 'redeem']);

    const cash = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['零花钱'].id, times: 2 });
    assert.deepEqual([cash.data.balance, cash.data.wallet.balance, cash.data.wallet.unit], [0, 10, '元']);

    const short = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['看电视'].id });
    assert.deepEqual([short.status, short.data.code], [409, 'insufficient_balance']);
    assert.equal((await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['看电视'].id, times: 101 })).status, 400);
    assert.equal((await wallet(app, '看电视')).balance, 0, '没换成的不进账');
  });

  test('用掉 / 花掉不能超过余额;调整不能调成负数;钱精确到分;撤销用掉把余额加回来;兑换进账只能从学分流水撤', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 20, reason: '攒的' });
    const cash = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['零花钱'].id, times: 2 });

    const spend = await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['零花钱'].id, amount: 3.5, reason: '买文具' });
    assert.deepEqual([spend.status, spend.data.balance, spend.data.entry.amount, spend.data.entry.balance_after], [200, 6.5, -3.5, 6.5]);
    const over = await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['零花钱'].id, amount: 7, reason: '买零食' });
    assert.deepEqual([over.status, over.data.code], [409, 'insufficient_wallet']);
    assert.match(over.data.error, /只剩 6\.5 元,不够 7 元/u);
    assert.equal((await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['零花钱'].id, amount: 0.005, reason: 'x' })).status, 400);
    assert.equal((await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['零花钱'].id, amount: 1, reason: '' })).status, 400, '要写用在哪');
    const itemReward = (await api(app, 'POST', '/rewards', { mac: MAC, name: '贴纸', cost: 1 })).data.item;
    assert.equal((await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: itemReward.id, amount: 1, reason: 'x' })).status, 400, '物品没有余额');

    assert.equal((await api(app, 'POST', '/wallets/adjust', { mac: MAC, reward_id: r['零花钱'].id, amount: -7, reason: '记错了' })).data.code, 'insufficient_wallet');
    const gift = await api(app, 'POST', '/wallets/adjust', { mac: MAC, reward_id: r['零花钱'].id, amount: 20, reason: '奶奶给的' });
    assert.equal(gift.data.balance, 26.5);

    const back = await api(app, 'POST', `/wallets/entries/${spend.data.entry.id}/revert`, {});
    assert.deepEqual([back.data.balance, back.data.entry.kind, back.data.entry.amount], [30, 'revert', 3.5]);
    assert.equal((await api(app, 'POST', `/wallets/entries/${spend.data.entry.id}/revert`, {})).data.code, 'already_reverted');
    const income = await api(app, 'POST', `/wallets/entries/${cash.data.wallet.entry.id}/revert`, {});
    assert.deepEqual([income.status, income.data.code], [409, 'not_revertible']);

    const summary = await wallet(app, '零花钱');
    assert.deepEqual([summary.balance, summary.redeemed, summary.used, summary.unit], [30, 10, 0, '元'], '撤销过的用掉不算累计');
    const page = (await api(app, 'GET', `/wallets/entries?mac=${COMPACT}&reward_id=${r['零花钱'].id}&kind=use`)).data;
    assert.deepEqual(page.items.map((e: any) => [e.title, e.amount, e.reverted_by !== null]), [['买文具', -3.5, true]]);
    assert.equal((await api(app, 'GET', `/wallets/entries/${gift.data.entry.id}`)).data.item.title, '奶奶给的');
  });

  test('撤销时间 / 零花钱的兑换:分和余额一起退;已经用掉了就先撤用掉的', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 20, reason: '攒的' });
    const game = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['玩游戏'].id, times: 2 });
    const played = await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['玩游戏'].id, amount: 6, reason: '玩了一局' });

    const blocked = await api(app, 'POST', `/ledger/${game.data.ledger.id}/revert`, {});
    assert.deepEqual([blocked.status, blocked.data.code], [409, 'insufficient_wallet']);
    assert.match(blocked.data.error, /10 分钟.*只剩 4 分钟/u);
    assert.equal(balanceOf(), 0, '被拦下时一分都没退');

    await api(app, 'POST', `/wallets/entries/${played.data.entry.id}/revert`, {});
    const ok = await api(app, 'POST', `/ledger/${game.data.ledger.id}/revert`, {});
    assert.deepEqual([ok.status, ok.data.balance, ok.data.wallet.balance, ok.data.wallet.entry.kind], [200, 20, 0, 'revert']);
    assert.equal((await wallet(app, '玩游戏')).redeemed, 0, '撤销过的兑换不算累计');
  });

  test('种类:换过就不能改,没换过可以改;份价与一份换多少随时改;记过账的删除只停用,余额还在就照样列出', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 10, reason: '攒的' });
    await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['看电视'].id });

    const locked = await api(app, 'PATCH', `/rewards/${r['看电视'].id}`, { kind: 'money', amount: 1 });
    assert.equal(locked.status, 409);
    const cheaper = await api(app, 'PATCH', `/rewards/${r['看电视'].id}`, { cost: 5, amount: 15 });
    assert.deepEqual([cheaper.data.item.cost, cheaper.data.item.amount, cheaper.data.item.wallet_balance], [5, 15, 10]);
    const game = await api(app, 'PUT', `/rewards/${r['玩游戏'].id}`, { kind: 'item' });
    assert.deepEqual([game.status, game.data.item.kind, game.data.item.amount], [200, 'item', 1]);
    const back = await api(app, 'PATCH', `/rewards/${r['玩游戏'].id}`, { kind: 'time' });
    assert.equal(back.status, 400, '改回时间要重新说一份换多少');

    assert.equal((await api(app, 'DELETE', `/rewards/${r['看电视'].id}`)).data.result, 'archived');
    assert.equal((await wallet(app, '看电视')).balance, 10, '停用了余额照样能看、能用');
    assert.equal((await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['看电视'].id, amount: 10, reason: '看完了' })).status, 200);
    assert.equal(await wallet(app, '看电视'), undefined, '停用且用完的就不再列');
  });

  test('孩子概览带余额;统计有兑换汇总与用掉多少,撤销过的不计', async () => {
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 60, reason: '攒的' });
    await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['玩游戏'].id, times: 2 });
    await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['零花钱'].id, times: 3 });
    const undone = await api(app, 'POST', '/redeem', { mac: MAC, reward_id: r['看电视'].id });
    await api(app, 'POST', `/ledger/${undone.data.ledger.id}/revert`, {});
    await api(app, 'POST', '/wallets/use', { mac: MAC, reward_id: r['零花钱'].id, amount: 4.2, reason: '买冰棍' });

    const child = (await api(app, 'GET', `/children/${COMPACT}`)).data.item;
    assert.deepEqual(child.wallets.map((w: any) => [w.name, w.balance, w.unit]), [['玩游戏', 10, '分钟'], ['零花钱', 10.8, '元'], ['看电视', 0, '分钟']]);

    const s = (await api(app, 'GET', `/stats?mac=${COMPACT}`)).data;
    assert.deepEqual(s.redeemed.map((x: any) => [x.name, x.count, x.times, x.quantity, x.unit, x.points]),
      [['零花钱', 1, 3, 15, '元', 30], ['玩游戏', 1, 2, 10, '分钟', 20]]);
    assert.deepEqual(s.wallets.map((w: any) => [w.name, w.redeemed, w.used]), [['玩游戏', 10, 0], ['零花钱', 15, 4.2]]);
    assert.equal(s.totals.spent, 50, '花掉的分照旧只算没撤销的兑换');
  });

  test('外部接口:App 设备身份能记用掉,流水记 App 名;openapi 写着新端点与错误码', async () => {
    const { hashClientId } = await import('../src/identity.ts');
    const APP_MAC = '02:5a:00:00:00:01';
    const SECRET = '0123456789abcdef'.repeat(4);
    run(conn, 'INSERT INTO devices (mac, agent_id, alias, board, secret_hash) VALUES (?, ?, ?, ?, ?)',
      APP_MAC, DEFAULT_AGENT_ID, '妈妈的 App', 'xiaodan-app', hashClientId(SECRET));
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    const r = await rewardsByName(app);
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 10, reason: '攒的' });
    const headers = { 'device-id': APP_MAC, 'client-id': SECRET };
    const redeemed = await call(app, 'POST', `${OPEN}/redeem`, { mac: COMPACT, reward_id: r['零花钱'].id }, headers);
    assert.equal(redeemed.data.wallet.entry.actor, '妈妈的 App');
    const spent = await call(app, 'POST', `${OPEN}/wallets/use`, { mac: COMPACT, reward_id: r['零花钱'].id, amount: 2, reason: '买本子' }, headers);
    assert.deepEqual([spent.status, spent.data.balance, spent.data.entry.source, spent.data.entry.actor], [200, 3, 'api', '妈妈的 App']);

    const spec = (await call(app, 'GET', `${OPEN}/openapi.json`)).data;
    for (const path of ['/wallets', '/wallets/entries', '/wallets/entries/{id}', '/wallets/use', '/wallets/adjust', '/wallets/entries/{id}/revert']) {
      assert.ok(spec.paths[path], path);
    }
    assert.ok(spec.components.responses.Error.content['application/json'].schema.properties.code.enum.includes('insufficient_wallet'));
    assert.deepEqual(spec.paths['/redeem'].post.requestBody.content['application/json'].schema.properties.times.maximum, 100);
  });
});

describe('智能体工具:按份兑换与余额', () => {
  const agentCtx = (mac: string | null = MAC) => ({
    deps: { conn, now: () => clock },
    agent: { id: DEFAULT_AGENT_ID, name: '家长助手' },
    device: { mac, sessionId: null, turnId: null, clientIp: null, features: {} },
  }) as any;
  const enable = (code: string) =>
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, ?, '{}')", DEFAULT_AGENT_ID, code);
  const tool = async (name: string) => {
    const { collectTools } = await import('../src/agent/registry.ts');
    await import('../src/agent/index.ts');
    return (await collectTools(agentCtx())).find((t) => t.name === name)!;
  };

  test('孩子说换多少分钟 / 多少钱:凑成整份就换,凑不成列出能换的;孩子不能记用掉', async () => {
    enable('credits');
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 40, reason: '攒的' });
    const redeemTool = await tool('credits_redeem');

    const odd = await redeemTool.run(agentCtx(), { reward: '游戏', amount: 12 });
    assert.equal(odd.ok, false);
    assert.match(odd.content, /凑不成整份.*10 分钟\(2 份,20 分\) 或 15 分钟\(3 份,30 分\)/u);
    assert.equal(balanceOf(), 40);

    const ok = await redeemTool.run(agentCtx(), { reward: '游戏', amount: 15 });
    assert.match(ok.content, /🎮 玩游戏 ×3\(15 分钟\),扣了 30 分,还剩 10 分.*玩游戏现在有 15 分钟/u);
    const cash = await redeemTool.run(agentCtx(), { reward: '零花钱', times: 1 });
    assert.match(cash.content, /零花钱现在有 5 元/u);

    const names = (await (await import('../src/agent/registry.ts')).collectTools(agentCtx())).map((t) => t.name);
    assert.ok(!names.includes('credits_wallet'), '孩子的工具里没有记用掉的函数');
  });

  test('家长 credits_wallet:看余额、记花费、超了被拒、调整、撤销最近一笔', async () => {
    enable('credits_parent');
    const app = newApp();
    await api(app, 'POST', '/examples', { mac: MAC });
    await (await tool('credits_adjust')).run(agentCtx(), { points: 30, reason: '攒的' });
    await (await tool('credits_redeem_for')).run(agentCtx(), { reward: '零花钱', amount: 10 });
    const w = await tool('credits_wallet');

    const which = await w.run(agentCtx(), { action: 'use', amount: 3, reason: '买文具' });
    assert.equal(which.ok, false);
    assert.match(which.content, /哪个账户/u);
    assert.match((await w.run(agentCtx(), { action: 'use', reward: '零花钱', amount: 3.5, reason: '买文具' })).content, /用掉 -3\.5 元\(买文具\),余额现在 6\.5 元/u);
    const over = await w.run(agentCtx(), { action: 'use', reward: '零花钱', amount: 100, reason: '买玩具' });
    assert.equal(over.ok, false);
    assert.match(over.content, /只剩 6\.5 元/u);
    assert.match((await w.run(agentCtx(), { action: 'adjust', reward: '零花钱', amount: 20, reason: '奶奶给的' })).content, /余额现在 26\.5 元/u);

    const status = await w.run(agentCtx(), { action: 'status', reward: '零花钱' });
    assert.match(status.content, /零花钱:余额 26\.5 元,累计兑换 10 元,累计用掉 3\.5 元/u);
    assert.match(status.content, /记录 \d+.*智能体「家长助手」.*调整 \+20 元「奶奶给的」/u);

    assert.match((await w.run(agentCtx(), { action: 'undo' })).content, /已撤销记录 \d+「奶奶给的」.*余额现在 6\.5 元/u);
    assert.match((await (await tool('credits_manage_reward')).run(agentCtx(), { action: 'create', name: '看动画', cost: 10, kind: 'time' })).content, /一份换多少分钟/u);
    assert.match((await (await tool('credits_manage_reward')).run(agentCtx(), { action: 'create', name: '看动画', cost: 10, kind: 'time', amount: 20 })).content,
      /看动画\(编号 \d+,时间\):10 分换 20 分钟/u);
    assert.match((await (await tool('credits_overview')).run(agentCtx(), {})).content, /余额账户:.*💰 零花钱还有 6\.5 元/u);
  });
});
