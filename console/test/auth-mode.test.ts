// 两种鉴权模式的行为边界。
//
// proxy 模式把鉴权完全交给前面的运维面板,控制台自己不再检查登录。这是本部署
// 实际使用的模式,它的正确性依赖两个外部前提:容器只监听回环、nginx 已被面板
// 接管并启用统一 Auth。代码层面能守住的是下面这些:该放行的放行、该拒绝的仍拒绝、
// 本地账号的入口彻底关掉。

import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach, describe } from 'node:test';
import { openMemoryDb, one, type Db } from '../src/db.ts';
import { seed, SECRET_KEY } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import { setAdmin } from '../src/auth.ts';

let conn: Db;
let app: ReturnType<typeof createApp>;

const original = process.env.XIAODAN_AUTH_MODE;
afterEach(() => {
  if (original === undefined) delete process.env.XIAODAN_AUTH_MODE;
  else process.env.XIAODAN_AUTH_MODE = original;
});

function boot(mode: string | undefined): void {
  if (mode === undefined) delete process.env.XIAODAN_AUTH_MODE;
  else process.env.XIAODAN_AUTH_MODE = mode;
  conn = openMemoryDb();
  seed(conn);
  app = createApp(conn);
}

const get = (path: string) => app.request(`http://localhost${path}`);
const post = (path: string, body?: unknown) =>
  app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('proxy 模式(默认):由运维面板鉴权', () => {
  beforeEach(() => boot(undefined));

  test('不设环境变量时默认就是 proxy', async () => {
    // 默认值选 proxy 而不是 local,是因为这个控制台就是为面板后面而生的。
    // 若默认成 local,忘了配环境变量的部署会多出一个登录页和一套弱凭据。
    const body = (await (await get('/api/setup/status')).json()) as { mode: string };
    assert.equal(body.mode, 'proxy');
  });

  test('没有任何 Cookie 也能访问管理接口', async () => {
    const response = await get('/api/models');
    assert.equal(response.status, 200, '面板已经在前面拦过了,这里不该再拦一次');
  });

  test('状态接口报告为已授权', async () => {
    const body = (await (await get('/api/setup/status')).json()) as
      { initialized: boolean; authenticated: boolean };
    assert.equal(body.authenticated, true);
    assert.equal(body.initialized, true, 'proxy 模式没有"未初始化"这个状态');
  });

  test('本地账号的两个入口都关掉了', async () => {
    // 留着它们等于在面板之外又开一道门,而那道门的凭据没人会去轮换。
    assert.equal((await post('/api/setup', { username: 'a', password: 'bbbbbbbb' })).status, 404);
    assert.equal((await post('/api/login', { username: 'a', password: 'bbbbbbbb' })).status, 404);
  });

  test('即使库里残留着旧账号,登录入口依然是关的', async () => {
    setAdmin(conn, 'leftover', 'leftover-password');
    assert.equal((await post('/api/login', { username: 'leftover', password: 'leftover-password' })).status, 404);
  });

  test('给服务端用的 Bearer 鉴权【不受影响】', async () => {
    // 这一条最关键:proxy 模式放行的是浏览器来的管理请求,
    // 而服务端走的是另一条路径,它的密钥校验必须照常生效 ——
    // 否则任何能碰到这个端口的东西都能读出全部模型密钥。
    const noKey = (await post('/xiaozhi/config/server-base')).json() as Promise<{ code: number }>;
    assert.equal((await noKey).code, 401);

    const secret = one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', SECRET_KEY)!.value;
    const withKey = await app.request('http://localhost/xiaozhi/config/server-base', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(((await withKey.json()) as { code: number }).code, 0);
  });

  test('健康检查仍然无需任何凭据', async () => {
    assert.equal((await get('/health')).status, 200);
  });
});

describe('local 模式:控制台自管账号', () => {
  beforeEach(() => boot('local'));

  test('状态接口报告为 local 且未初始化', async () => {
    const body = (await (await get('/api/setup/status')).json()) as
      { mode: string; initialized: boolean; authenticated: boolean };
    assert.equal(body.mode, 'local');
    assert.equal(body.initialized, false);
    assert.equal(body.authenticated, false);
  });

  test('没有会话时管理接口仍返回 401', async () => {
    assert.equal((await get('/api/models')).status, 401);
  });

  test('初始化入口可用', async () => {
    const response = await post('/api/setup', { username: 'admin', password: 'a-good-password' });
    assert.equal(response.status, 200);
  });
});
