// 智能体运行时的公共类型。

import type { Db } from '../db.ts';
import type { FetchLike } from '../voice/dashscope.ts';
import type { Bridge } from './bridge.ts';

export interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  llm_model_id: string | null;
  image_model_id: string | null;
  /** 音色决定合成模型、音量语速、方言语气与允许的情感标签 */
  tts_voice_id: string | null;
  /** 0 不记对话记录,1 记 */
  chat_history_conf: number;
  description: string;
  role_template: string;
  safety_level: 'standard' | 'child';
  max_steps: number;
  llm_params_json: string;
  greeting: string;
}

/** 这一轮对应的设备。网页试聊时可能没有设备(mac 为 null)。 */
export interface DeviceContext {
  mac: string | null;
  /** 引擎里的会话 ID,调用引擎插件要用 */
  sessionId: string | null;
  /** 引擎这一轮的 sentence_id;插件执行前桥会核对,过期(用户已经开始下一轮)就不执行 */
  turnId: string | null;
  clientIp: string | null;
  features: Record<string, unknown>;
}

/** 设备支持的小单协议版本:hello 里 features.xiaodan 为 true 记作 1,数字原样。 */
export function xiaodanVersion(device: DeviceContext): number {
  const value = device.features['xiaodan'];
  if (value === true) return 1;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 故事音频的正文进度片段:ms 是这段文字在音频里大约开始的毫秒,p 表示新起一段 */
export interface MediaCue {
  ms: number;
  x: string;
  p?: boolean;
}

/** 一轮里往引擎(设备)送的东西。网页试聊把它们画在页面上。 */
export interface TurnSink {
  text(text: string): void;
  device(message: Record<string, unknown>): void;
  media(item: { url: string; ext: string; title: string; cues?: MediaCue[] }): void;
  closeAfterTurn(): void;
}

/**
 * 设备上工具进行时的活动动画(小单协议 3 级,随 hint 下发)。固件把它画在脸旁:
 * 画画的画笔、讲故事的书、放音乐的音符……不认得的值按普通思考显示。
 */
export type DeviceAct = 'paint' | 'story' | 'music' | 'learn' | 'weather' | 'calendar' | 'search' | 'remind' | 'memory' | 'role' | 'think';

export interface TraceEvent {
  kind: 'step' | 'tool_call' | 'tool_result' | 'log';
  step?: number;
  name?: string;
  arguments?: unknown;
  content?: string;
  ms?: number;
  ok?: boolean;
}

export interface AgentDeps {
  conn: Db;
  fetch: FetchLike;
  bridge: Bridge;
  dataDir: () => string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ToolContext {
  deps: AgentDeps;
  agent: AgentRow;
  device: DeviceContext;
  sink: TurnSink;
  signal: AbortSignal;
  /** 这一轮所属的对话(同一台设备跨重连延续),技能加载等状态挂在上面 */
  conversationKey: string;
}

export interface ToolResult {
  /** 交还给模型的结果文字 */
  content: string;
  /** 为 true 时本轮到此结束,不再请求模型(例如已经开始播放音乐,再说话会排到音乐之后) */
  endTurn?: boolean;
  /** 为 true 时下一次请求模型放宽输出长度(例如要把整篇故事讲出来) */
  longAnswer?: boolean;
  /** 工具拿到的图片(data: 或 https 地址);对话模型支持看图时交给它看 */
  images?: string[];
  ok?: boolean;
}

export interface AgentTool {
  name: string;
  /** 给人看的名字,用于设备上的提示与试聊页 */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  /** 这一轮还没说过话时,调用它之前先说的一句过渡语 */
  progress?: string;
  /** 设备屏幕上的工具提示 */
  hint?: string;
  /** 设备上的活动动画;不填就只显示提示文字 */
  act?: DeviceAct;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}
