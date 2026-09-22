// 学分奖惩:计分公式、布置时的规则快照、余额与撤销、兑换够分、两套接口入口与外部密钥。

import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { scoreMissed, scoreResult, type ScoreParams } from '../src/credits/score.ts';
import { today } from '../src/credits/store.ts';
import { OPEN_KEY_SETTING } from '../src/credits/open-key.ts';

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

describe('外部接口', () => {
  test('没生成密钥时整组 404;没带或带错密钥 401;带对了与页面接口一致', async () => {
    const app = newApp();
    assert.equal((await call(app, 'GET', `/open/credits/overview?mac=${COMPACT}`)).status, 404);

    const rotated = await api(app, 'POST', '/key/rotate');
    const key = rotated.data.key as string;
    assert.match(key, /^xdc_/u);
    assert.equal(rotated.data.enabled, true);

    assert.equal((await call(app, 'GET', `/open/credits/overview?mac=${COMPACT}`)).status, 401);
    assert.equal((await call(app, 'GET', `/open/credits/overview?mac=${COMPACT}`, undefined, { authorization: 'Bearer xdc_wrong' })).status, 401);

    const auth = { authorization: `Bearer ${key}` };
    await api(app, 'POST', '/adjust', { mac: MAC, delta: 7, reason: '页面加的' });
    const overview = await call(app, 'GET', `/open/credits/overview?mac=${COMPACT}`, undefined, auth);
    assert.equal(overview.status, 200);
    assert.equal(overview.data.balance, 7);
    const viaOpen = await call(app, 'POST', '/open/credits/adjust', { mac: COMPACT, delta: 3, reason: '快捷指令加的' }, auth);
    assert.equal(viaOpen.data.balance, 10);

    const status = await api(app, 'GET', '/key');
    assert.ok(status.data.last_used_at, '记下最后使用时间');
  });

  test('库里只有哈希;轮换后旧密钥失效;关闭后整组 404', async () => {
    const app = newApp();
    const oldKey = (await api(app, 'POST', '/key/rotate')).data.key as string;
    const stored = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', OPEN_KEY_SETTING)!.value;
    assert.ok(!stored.includes(oldKey), '明文不落库');

    const newKey = (await api(app, 'POST', '/key/rotate')).data.key as string;
    assert.notEqual(newKey, oldKey);
    const probe = (key: string) => call(app, 'GET', `/open/credits/overview?mac=${COMPACT}`, undefined, { authorization: `Bearer ${key}` });
    assert.equal((await probe(oldKey)).status, 401);
    assert.equal((await probe(newKey)).status, 200);

    await api(app, 'DELETE', '/key');
    assert.equal((await probe(newKey)).status, 404);
  });

  test('密钥管理只在页面接口下;设置页的批量保存改不了它', async () => {
    const app = newApp();
    const key = (await api(app, 'POST', '/key/rotate')).data.key as string;
    const auth = { authorization: `Bearer ${key}` };
    assert.equal((await call(app, 'POST', '/open/credits/key/rotate', undefined, auth)).status, 404, '外部密钥不能自己换自己');

    const before = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', OPEN_KEY_SETTING)!.value;
    await call(app, 'PUT', '/api/settings', { [OPEN_KEY_SETTING]: '{"hash":"' + '0'.repeat(64) + '"}' });
    assert.equal(one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', OPEN_KEY_SETTING)!.value, before);
  });
});
