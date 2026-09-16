// 进程入口。
import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, dataDir, dbPath, openDb } from './db.ts';
import { seed } from './seed.ts';
import { createApp } from './app.ts';
import { startReminderScheduler } from './agent/reminders/scheduler.ts';
import { seedMedia } from './agent/media/seed.ts';
import { startStorySynthesis } from './agent/media/synth.ts';
import { startRoleGreetings } from './agent/roles/switch.ts';
import { authMode, isInitialized } from './auth.ts';
import { getSetting } from './settings.ts';

const here = dirname(fileURLToPath(import.meta.url));

function main(): void {
  const conn = openDb();
  seed(conn);

  // 前端产物。编译产物运行时在 dist/web;用 --experimental-strip-types 直接跑
  // 源码时目录层级不同,两处都找一下,都没有就只提供接口。
  const webRoot = [join(here, 'web'), join(here, '..', 'dist', 'web')].find((path) => existsSync(path));

  const app = createApp(conn, {
    webRoot,
    onAgentDeps: (deps) => {
      // 内容素材(原创故事、曲库、单词书)缺了才补;故事音频在配好千问合成模型后于后台自动生成
      const seeded = seedMedia(conn, deps.dataDir());
      if (seeded.stories || seeded.music || seeded.words) {
        console.log(`[小单控制台] 内容库新增 故事 ${seeded.stories} 个、曲目 ${seeded.music} 首、单词 ${seeded.words} 个`);
      }
      startReminderScheduler(deps);
      startStorySynthesis(deps);
      startRoleGreetings(deps);
    },
  });
  const port = Number(process.env.PORT ?? 8002);
  const hostname = process.env.HOST ?? '0.0.0.0';

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`[小单控制台] 监听 ${hostname}:${info.port}`);
    console.log(`[小单控制台] 数据库 ${dbPath()}`);
    console.log(`[小单控制台] 数据目录 ${dataDir()}`);
    if (authMode() === 'proxy') {
      console.log('[小单控制台] 鉴权模式:proxy —— 由前面的运维面板负责,控制台不做登录检查');
      console.log('[小单控制台] 前提:本进程只监听回环,且该站点已被面板接管并启用统一 Auth');
    } else {
      console.log('[小单控制台] 鉴权模式:local —— 控制台自己管一个管理员账号');
      if (!isInitialized(conn)) console.log('[小单控制台] 尚未设置管理员,请打开页面完成初始化');
    }
    const ws = getSetting(conn, 'server.websocket');
    if (!ws) {
      console.log('[小单控制台] 提醒:还没有配置设备连接地址(设置 → 设备接入)');
    }
  });

  // 停机要点:先停止接受新连接,再 checkpoint WAL。
  // 运维面板在发布时会 `compose stop --timeout 30` 然后立刻打包数据目录,
  // 没 checkpoint 的写入还留在 -wal 文件里,只拷主库就会丢 —— 上游的迁移
  // 记录里真发生过(1.8MB 停在 WAL 中)。
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[小单控制台] 收到 ${signal},正在停机`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // 兜底:有长连接赖着不走时也要在超时前把数据落盘
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
