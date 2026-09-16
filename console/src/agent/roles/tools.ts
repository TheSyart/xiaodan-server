// 切换角色工具:list_roles / switch_role。

import { CONSOLE_TOOLS } from '../registry.ts';
import type { AgentTool } from '../types.ts';
import { matchRole, needsReconnect, queueGreeting, switchableRoles, switchDeviceRole } from './switch.ts';

export const ROLES_PLUGIN = 'roles';

const describe = (role: { name: string; description: string }) => (role.description ? `${role.name}(${role.description})` : role.name);

CONSOLE_TOOLS.set(ROLES_PLUGIN, () => {
  const list: AgentTool = {
    name: 'list_roles',
    label: '看看有哪些角色',
    description: '用户问「还有谁能陪我」「你能换成谁」时调用,列出这台设备能切换到的其他角色。',
    parameters: { type: 'object', properties: {} },
    async run(ctx) {
      if (!ctx.device.mac) return { ok: false, content: '网页试聊里没有设备,不能切换角色。' };
      const roles = switchableRoles(ctx.deps.conn, ctx.device.mac, ctx.agent.id);
      if (roles.length === 0) return { ok: true, content: '这台设备没有别的角色可以切换。如实告诉用户。' };
      return { ok: true, content: `可以切换到:${roles.map(describe).join(';')}。用口语简单介绍,问用户想换谁。` };
    },
  };

  const switchRole: AgentTool = {
    name: 'switch_role',
    label: '切换角色',
    description: '用户明确要换成另一个角色陪他时调用,比如「换童童来」「切换到英语老师」。只在用户明确要求时调用,不要自作主张。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要切换到的角色名字,按用户说的填' } },
      required: ['name'],
    },
    hint: '正在切换角色',
    async run(ctx, args) {
      const mac = ctx.device.mac;
      if (!mac) return { ok: false, content: '网页试聊里没有设备,不能切换角色。告诉用户要在设备上说。' };
      const spoken = String(args['name'] ?? '').trim();
      if (spoken && spoken.replace(/\s+/gu, '') === ctx.agent.name.replace(/\s+/gu, '')) {
        return { ok: true, content: `现在就是${ctx.agent.name}。告诉用户你一直都在。` };
      }
      const roles = switchableRoles(ctx.deps.conn, mac, ctx.agent.id);
      const { role, candidates } = matchRole(roles, spoken);
      if (!role) {
        if (candidates.length > 1) return { ok: false, content: `有几个角色都对得上:${candidates.map((r) => r.name).join('、')}。问用户要哪一个。` };
        return {
          ok: false,
          content: roles.length
            ? `没有叫「${spoken}」的角色。可以切换到:${roles.map((r) => r.name).join('、')}。问用户要换哪个。`
            : '这台设备没有别的角色可以切换。如实告诉用户。',
        };
      }
      const reconnect = needsReconnect(ctx.deps.conn, ctx.agent.id, role.id);
      switchDeviceRole(ctx.deps.conn, mac, role.id);
      ctx.deps.log?.(`[roles] ${mac} 从「${ctx.agent.name}」切换到「${role.name}」${reconnect ? ',本轮结束后重连' : ''}`);
      if (reconnect) {
        queueGreeting(mac, role.id);
        ctx.sink.closeAfterTurn();
        return {
          ok: true,
          content: `已切换到「${role.name}」。设备说完这句会重新连接一下,${role.name}会用自己的声音打招呼。` +
            `现在用一句话跟用户道别并告诉他${role.name}马上就来,不要模仿${role.name}说话。`,
        };
      }
      return {
        ok: true,
        content: `已切换到「${role.name}」,从用户的下一句话开始由${role.name}来回应。用一句话告诉用户${role.name}来了,不要模仿${role.name}说话。`,
      };
    },
  };

  return [list, switchRole];
});
