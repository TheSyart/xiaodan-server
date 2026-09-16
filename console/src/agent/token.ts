// 引擎调控制塔对话接口时用的设备令牌:mac.base64url(HMAC-SHA256(server.secret, "xiaodan/agent/v1\n" + mac))。
//
// 令牌在 agent-models 里随 LLM 配置下发给引擎。它把请求绑死在一台设备上:
// 就算引擎被别的设备连着,也拿不到另一台设备的令牌去冒用它的角色、提醒与对话记录。轮换 server.secret 后全部失效。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalMac } from '../identity.ts';

const DOMAIN = 'xiaodan/agent/v1\n';

function sign(secret: string, mac: string): string {
  return createHmac('sha256', secret).update(DOMAIN + mac).digest('base64url');
}

export function agentToken(secret: string, mac: string): string {
  const canonical = canonicalMac(mac);
  if (!canonical || !secret) throw new Error('生成设备令牌需要合法的 MAC 与密钥');
  return `${canonical}.${sign(secret, canonical)}`;
}

/** 校验令牌,返回其中的 MAC;不合法返回 null。 */
export function verifyAgentToken(secret: string, token: string | null | undefined): string | null {
  if (!secret || typeof token !== 'string') return null;
  const at = token.lastIndexOf('.');
  if (at <= 0) return null;
  const mac = canonicalMac(token.slice(0, at));
  if (!mac) return null;
  const given = Buffer.from(token.slice(at + 1));
  const expected = Buffer.from(sign(secret, mac));
  return given.length === expected.length && timingSafeEqual(given, expected) ? mac : null;
}
