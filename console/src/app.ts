// 把各路由拼成一个应用。单独成文件是为了让测试能直接拿到 app 而不必起监听端口。

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { adminApi } from './admin-api.ts';
import { managerApi } from './manager-api.ts';
import { otaApi } from './ota.ts';

export interface AppOptions {
  /** 前端构建产物目录。不存在时只提供接口,便于纯后端开发与测试。 */
  webRoot?: string;
}

export function createApp(conn: Db, options: AppOptions = {}): Hono {
  // strict:false —— 设备与 nginx 调的是 /xiaozhi/ota/(带尾斜杠),
  // Hono 默认把带不带尾斜杠当成两个路径,少一个就 404。
  const app = new Hono({ strict: false });

  // 安全响应头。控制台页面只加载同源的脚本、样式与内联图片(data: 图标),不引用任何外部资源,
  // 所以内容安全策略可以收得很紧。style 放开 'unsafe-inline' 是因为 Vue 会给元素写 style 属性。
  // HSTS 由前面的 nginx 负责,这里不重复发;设备与引擎调用的接口不是浏览器,这些头对它们没有影响。
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
      strictTransportSecurity: false,
    }),
  );

  // 健康检查。无鉴权 —— 运维面板与 Docker 都用它判断容器是否就绪,
  // 那两者都无法携带会话。只暴露"数据库能不能读",不泄露任何配置。
  app.get('/health', (c) => {
    try {
      conn.prepare('SELECT 1').get();
      return c.json({ status: 'ok' });
    } catch {
      return c.json({ status: 'degraded' }, 503);
    }
  });

  // 小智服务端拉配置用的接口。路径前缀必须是 /xiaozhi,
  // 因为服务端那边把 base_url 拼成 <host>/xiaozhi。
  // OTA 也在这个前缀下,但它不需要 Bearer —— 两者靠 manager-api 里
  // 精确的中间件前缀区分开,见那边的注释。
  app.route('/xiaozhi/ota', otaApi(conn));
  app.route('/xiaozhi', managerApi(conn));

  // 控制台页面的接口
  app.route('/api', adminApi(conn));

  // 前端。SPA 路由要求"找不到文件就回 index.html",否则刷新子页面会 404。
  const webRoot = options.webRoot;
  if (webRoot && existsSync(webRoot)) {
    app.use('/assets/*', serveStatic({ root: webRoot }));
    app.get('/favicon.ico', serveStatic({ root: webRoot, path: '/favicon.ico' }));
    app.get('*', serveStatic({ root: webRoot, path: '/index.html' }));
  }

  return app;
}
