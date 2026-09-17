// 用语音切换设备的角色。
//
// 大脑在控制塔:换了角色,下一轮对话就用新角色的人设、工具与记忆规则,不需要设备做任何事。
// 但声音、识别模型这些是引擎在连接建立时从 agent-models 取走的,换了就得让设备重连一次:
// 这一轮说完后关掉连接(close_after_turn),设备自动重连、取到新配置,再用新角色的声音打招呼。

import type { Db } from '../../db.ts';
import { all, one, run } from '../../db.ts';
import { DEVICE_ONLINE_HOOKS } from '../hooks.ts';
import type { AgentDeps } from '../types.ts';

export interface RoleOption {
  id: string;
  name: string;
  description: string;
  greeting: string;
}

/** 这台设备能切到的角色(不含当前角色)。设了白名单只在白名单里挑,否则是全部角色。 */
export function switchableRoles(conn: Db, mac: string, currentAgentId: string): RoleOption[] {
  const allowlisted = all<RoleOption>(
    conn,
    `SELECT a.id, a.name, a.description, a.greeting FROM device_roles r JOIN agents a ON a.id = r.agent_id
     WHERE r.mac = ? ORDER BY a.is_default DESC, a.created_at`,
    mac,
  );
  const hasAllowlist = !!one(conn, 'SELECT 1 FROM device_roles WHERE mac = ?', mac);
  const rows = hasAllowlist
    ? allowlisted
    : all<RoleOption>(conn, 'SELECT id, name, description, greeting FROM agents ORDER BY is_default DESC, created_at');
  return rows.filter((row) => row.id !== currentAgentId);
}

/** 用户说的名字 → 角色。先全名(忽略大小写与空白),再互相包含;有歧义时返回 null 与候选。 */
export function matchRole(roles: readonly RoleOption[], spoken: string): { role: RoleOption | null; candidates: RoleOption[] } {
  const key = (text: string) => text.replace(/\s+/gu, '').toLowerCase();
  const target = key(spoken);
  if (!target) return { role: null, candidates: [] };
  const exact = roles.filter((role) => key(role.name) === target);
  if (exact.length === 1) return { role: exact[0]!, candidates: exact };
  const partial = roles.filter((role) => key(role.name).includes(target) || target.includes(key(role.name)));
  return partial.length === 1 ? { role: partial[0]!, candidates: partial } : { role: null, candidates: partial.length ? partial : exact };
}

/**
 * 引擎在连接建立时就定下来的那些配置:两个角色这里有任何不同,都要重连才生效。
 * 合成模型与说话设置都跟着音色走,音色 id 相同就是同一个声音。
 */
const ENGINE_FIELDS = ['vad_model_id', 'asr_model_id', 'tts_voice_id'] as const;

export function needsReconnect(conn: Db, fromId: string, toId: string): boolean {
  const columns = ENGINE_FIELDS.join(', ');
  const from = one<Record<string, unknown>>(conn, `SELECT ${columns} FROM agents WHERE id = ?`, fromId);
  const to = one<Record<string, unknown>>(conn, `SELECT ${columns} FROM agents WHERE id = ?`, toId);
  if (!from || !to) return true;
  return ENGINE_FIELDS.some((field) => (from[field] ?? null) !== (to[field] ?? null));
}

// ---------------------------------------------------------------- 重连后的招呼

const GREETING_TTL_MS = 2 * 60_000;
const pendingGreetings = new Map<string, { agentId: string; expires: number }>();

export function queueGreeting(mac: string, agentId: string, now = Date.now()): void {
  pendingGreetings.set(mac, { agentId, expires: now + GREETING_TTL_MS });
}

export function takeGreeting(mac: string, agentId: string, now = Date.now()): boolean {
  const pending = pendingGreetings.get(mac);
  if (!pending) return false;
  if (pending.expires < now || pending.agentId !== agentId) {
    if (pending.expires < now) pendingGreetings.delete(mac);
    return false;
  }
  pendingGreetings.delete(mac);
  return true;
}

export function greetingText(role: { name: string; greeting: string }): string {
  return role.greeting.trim() || `你好呀,我是${role.name || '小单'}。`;
}

/** 设备重连取配置时调用:刚切换过角色就用新声音打个招呼。引擎要几秒才就绪,忙或还没上线就稍后再试。 */
export async function greetAfterSwitch(deps: AgentDeps, mac: string, agentId: string, delaysMs: readonly number[] = [3000, 3000, 5000]): Promise<void> {
  if (!takeGreeting(mac, agentId)) return;
  const role = one<{ name: string; greeting: string }>(deps.conn, 'SELECT name, greeting FROM agents WHERE id = ?', agentId);
  if (!role) return;
  for (const delay of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    // 这期间设备又被切到别的角色(或解绑)就不打招呼了
    if (!one(deps.conn, 'SELECT 1 FROM devices WHERE mac = ? AND agent_id = ?', mac, agentId)) return;
    try {
      const result = await deps.bridge.announce(mac, { text: greetingText(role) });
      if (result.status === 202) {
        deps.log?.(`[roles] ${mac} 切换到「${role.name}」后打了招呼`);
        return;
      }
    } catch {
      // 设备桥暂时不通:下一次再试
    }
  }
}

export function switchDeviceRole(conn: Db, mac: string, agentId: string): void {
  run(conn, 'UPDATE devices SET agent_id = ? WHERE mac = ?', agentId, mac);
}

export function startRoleGreetings(deps: AgentDeps): () => void {
  const hook = (mac: string, agentId: string) => greetAfterSwitch(deps, mac, agentId);
  DEVICE_ONLINE_HOOKS.push(hook);
  return () => {
    const index = DEVICE_ONLINE_HOOKS.indexOf(hook);
    if (index >= 0) DEVICE_ONLINE_HOOKS.splice(index, 1);
  };
}
