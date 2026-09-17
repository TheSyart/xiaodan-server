// 住在引擎里的工具:查日期显示日历、查天气显示天气画面、调音量(server/plugins/)。
//
// 它们要拿着设备连接推卡片,只能在引擎里跑;控制塔经设备桥调用,结果交还模型。
// 模型看到的函数说明以这里为准(引擎里的插件说明只是注册要求,不会交给模型)。

import { BridgeError } from './bridge.ts';
import type { ToolSpec } from './llm.ts';
import type { AgentTool, DeviceAct, ToolContext, ToolResult } from './types.ts';

interface EngineToolMeta {
  label: string;
  hint: string;
  act?: DeviceAct;
  progress?: string;
  spec: ToolSpec;
}

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: [] });

export const ENGINE_TOOL_META: Readonly<Record<string, EngineToolMeta>> = {
  show_calendar: {
    label: '日期与日历',
    hint: '正在翻日历',
    act: 'calendar',
    spec: {
      type: 'function',
      function: {
        name: 'show_calendar',
        description: '查日期并在设备屏幕上显示日历。用户问今天或某一天是几号、星期几、农历几号,或者想看日历时,必须调用本工具,由它显示并播报,不要自己口头回答日期。',
        parameters: obj({
          date: { type: 'string', description: '要查的日期,格式 YYYY-MM-DD。问今天时不传' },
          offset_days: { type: 'integer', description: '相对今天的天数:明天 1,后天 2,昨天 -1。与 date 二选一' },
        }),
      },
    },
  },
  get_weather: {
    label: '天气',
    hint: '正在查天气',
    act: 'weather',
    progress: '我看看天气哦。',
    spec: {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询天气,并在设备屏幕上显示天气画面。用户问天气、气温、会不会下雨、要不要带伞、穿什么时调用。用户没说地点时不要传 location,会按设备所在的城市查。',
        parameters: obj({
          location: { type: 'string', description: '地点。中国的城市或区县用中文,例如杭州、海淀;外国城市用英文,例如 Tokyo。用户没说就不传' },
        }),
      },
    },
  },
  set_volume: {
    label: '调音量',
    hint: '正在调音量',
    spec: {
      type: 'function',
      function: {
        name: 'set_volume',
        description: '调节设备的播放音量。用户说大声点、小声点、音量调到百分之几、静音时调用。',
        parameters: obj({
          level: { type: 'integer', description: '目标音量,0 到 100。用户说了具体数值时传' },
          change: { type: 'string', description: 'up 表示调大,down 表示调小。用户没说具体数值时传' },
        }),
      },
    },
  },
};

async function runEngineTool(
  ctx: ToolContext, name: string, args: Record<string, unknown>, pluginConfig: Record<string, unknown>,
): Promise<ToolResult> {
  const { device } = ctx;
  if (!device.sessionId) {
    return { ok: false, content: `现在没有连着设备,「${ENGINE_TOOL_META[name]?.label ?? name}」要在设备上才能用。如实告诉用户这次查不了。` };
  }
  try {
    const result = await ctx.deps.bridge.callTool({
      session_id: device.sessionId, turn_id: device.turnId, name, arguments: args, plugin_config: pluginConfig,
    });
    switch (result.action) {
      case 'RESPONSE':
        // 插件已经把画面推到屏幕上,并给出了一句现成的回答;交给模型用自己的口吻说
        return { ok: true, content: `已完成。结果:${result.response ?? result.result ?? ''}` };
      case 'REQLLM':
        return { ok: true, content: result.result ?? result.response ?? '' };
      default:
        return { ok: false, content: `工具出错:${result.response ?? result.result ?? result.action}` };
    }
  } catch (error) {
    if (error instanceof BridgeError && error.status === 409) {
      return { ok: false, content: '用户已经开始说下一句了,这次调用作废。', endTurn: true };
    }
    return { ok: false, content: `工具暂时不可用:${(error as Error).message}` };
  }
}

/** 按智能体开着的工具生成引擎工具;enabled 的值是工具页里的全局设置,随调用交给引擎插件。 */
export async function engineTools(
  _ctx: Pick<ToolContext, 'deps'>, enabled: ReadonlyMap<string, Record<string, unknown>>,
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const [name, meta] of Object.entries(ENGINE_TOOL_META)) {
    if (!enabled.has(name)) continue;
    const spec = meta.spec;
    const pluginConfig = enabled.get(name) ?? {};
    tools.push({
      name,
      label: meta.label,
      description: spec.function.description,
      parameters: spec.function.parameters,
      hint: meta.hint,
      ...(meta.act ? { act: meta.act } : {}),
      ...(meta.progress ? { progress: meta.progress } : {}),
      timeoutMs: 35_000,
      run: (toolCtx, args) => runEngineTool(toolCtx, name, args, pluginConfig),
    });
  }
  return tools;
}
