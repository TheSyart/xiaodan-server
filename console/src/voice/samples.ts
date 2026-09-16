// 声音复刻样本的一次性公网链接。
//
// 百炼复刻要求样本是它能访问到的地址。优先用百炼自己的临时上传(oss://);若复刻接口不认 oss:// 地址,
// 退回由控制塔临时提供一个链接。挂在 /xiaozhi/ota/ 下是有意的:nginx 对这个前缀关闭了统一鉴权
// (设备取 OTA 时没有登录态),百炼因此能取到文件,不需要在面板里另开放路径。
// 链接 10 分钟过期,令牌是 32 字节随机数,只在进程内存里,重启即失效。

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';

interface Entry {
  path: string;
  mime: string;
  expires: number;
}

const TTL_MS = 10 * 60_000;
const tokens = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [token, entry] of tokens) if (entry.expires <= now) tokens.delete(token);
}

/** 登记一个样本文件,返回令牌(不含扩展名)。 */
export function issueSampleToken(path: string, mime: string, now = Date.now()): string {
  sweep(now);
  const token = randomBytes(32).toString('base64url');
  tokens.set(token, { path, mime, expires: now + TTL_MS });
  return token;
}

export function revokeSampleToken(token: string): void {
  tokens.delete(token);
}

/** 由 OTA 地址推出样本链接,例如 https://host/xiaozhi/ota/ → https://host/xiaozhi/ota/voice-sample/<令牌>.wav */
export function sampleUrl(otaUrl: string, token: string, extension: string): string | null {
  try {
    const base = new URL(otaUrl.endsWith('/') ? otaUrl : `${otaUrl}/`);
    if (base.protocol !== 'https:') return null;
    return new URL(`voice-sample/${token}.${extension}`, base).toString();
  } catch {
    return null;
  }
}

export function sampleRoutes(): Hono {
  const app = new Hono({ strict: false });
  app.get('/:name', (c) => {
    const name = c.req.param('name');
    const token = name.replace(/\.[A-Za-z0-9]{1,5}$/u, '');
    const entry = tokens.get(token);
    if (!entry || entry.expires <= Date.now() || !existsSync(entry.path)) {
      if (entry) tokens.delete(token);
      return c.text('not found', 404);
    }
    const body = readFileSync(entry.path);
    return c.body(body, 200, { 'Content-Type': entry.mime, 'Cache-Control': 'no-store' });
  });
  return app;
}
