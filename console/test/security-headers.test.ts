// 安全响应头。控制台页面与接口共用同一套头,这里只断言会被浏览器执行的那几条。

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { openMemoryDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';

test('响应带内容安全策略,且只放行同源资源', async () => {
  const conn = openMemoryDb();
  seed(conn);
  const app = createApp(conn);

  const response = await app.request('http://localhost/health');
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  // 页面不引用任何外部资源:策略里一旦出现 http(s) 来源,说明有人为了加载 CDN 放宽了它
  assert.doesNotMatch(csp, /https?:/u);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('strict-transport-security'), null, 'HSTS 由 nginx 负责');
});

test('设备与引擎调用的接口同样带头,且不影响它们的响应', async () => {
  const conn = openMemoryDb();
  seed(conn);
  const app = createApp(conn);
  const response = await app.request('http://localhost/xiaozhi/ota/');
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy'));
});
