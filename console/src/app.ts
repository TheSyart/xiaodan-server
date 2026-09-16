// 把各路由拼成一个应用。单独成文件是为了让测试能直接拿到 app 而不必起监听端口。

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { dataDir, one } from './db.ts';
import { Bridge } from './agent/bridge.ts';
import { agentRoutes } from './agent/routes.ts';
import type { AgentDeps } from './agent/types.ts';
import { SECRET_KEY } from './seed.ts';
import { adminApi, type AdminDeps } from './admin-api.ts';
import { managerApi } from './manager-api.ts';
import { otaApi } from './ota.ts';
import { sampleRoutes } from './voice/samples.ts';

export interface AppOptions {
  /** 前端构建产物目录。不存在时只提供接口,便于纯后端开发与测试。 */
  webRoot?: string;
  /** 管理接口访问外部服务的依赖,测试注入 */
  admin?: AdminDeps;
  /** 智能体运行时的依赖(模型接口、设备桥),测试注入 */
  agent?: Partial<AgentDeps>;
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
        // 音色试听:接口返回的音频转成 blob 地址交给 <audio> 播放
        mediaSrc: ["'self'", 'blob:', 'data:'],
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
  // 声音复刻样本的一次性链接。放在 OTA 前缀下是因为 nginx 对它关闭了统一鉴权,百炼才取得到(说明见 voice/samples.ts)。
  // 必须先于 OTA 路由挂载。
  app.route('/xiaozhi/ota/voice-sample', sampleRoutes());
  app.route('/xiaozhi/ota', otaApi(conn));
  app.route('/xiaozhi', managerApi(conn));

  // 控制台页面的接口
  // 智能体运行时:引擎经内网调 /xiaodan/agent/turn(按设备令牌鉴权);控制塔经设备桥找设备
  const setting = (key: string) => one<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? '';
  const fetchImpl = options.agent?.fetch ?? options.admin?.fetch ?? fetch;
  const agentDeps: AgentDeps = {
    conn,
    fetch: fetchImpl,
    bridge: options.agent?.bridge ?? new Bridge(() => setting('agent.bridge_url') || 'http://engine:8003', () => setting(SECRET_KEY), fetchImpl),
    dataDir: options.agent?.dataDir ?? options.admin?.dataDir ?? dataDir,
    log: options.agent?.log ?? ((message) => console.log(message)),
    ...(options.agent?.now ? { now: options.agent.now } : {}),
  };
  app.route('/xiaodan', agentRoutes(agentDeps));

  app.route('/api', adminApi(conn, { ...options.admin, agent: agentDeps }));

  // 前端。SPA 路由要求"找不到文件就回 index.html",否则刷新子页面会 404。
  const webRoot = options.webRoot;
  if (webRoot && existsSync(webRoot)) {
    app.use('/assets/*', serveStatic({ root: webRoot }));
    app.get('/favicon.ico', serveStatic({ root: webRoot, path: '/favicon.ico' }));
    app.get('*', serveStatic({ root: webRoot, path: '/index.html' }));
  }

  return app;
}
