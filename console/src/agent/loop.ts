// 一轮对话的多步循环:模型 → 工具 → 模型 → … → 回答。
//
// 文字边生成边交给引擎(设备立刻开始说);工具并行执行,每个有自己的超时;
// 步数到上限后最后一次不给工具,要求模型基于已有信息回答。用户打断时 signal 触发,模型请求与工具一并取消。

import { randomUUID } from 'node:crypto';
import { one, run } from '../db.ts';
import { conversations, historyMessages, sanitize, type StoredTurn } from './context.ts';
import { emotionOf, LeadingEmoji } from './emoji.ts';
import { LlmError, streamChat, type ChatMessage, type LlmConfig, type ToolCall, type ToolSpec } from './llm.ts';
import { buildSystemPrompt } from './prompt.ts';
import { collectTools, skillCatalog } from './registry.ts';
import { ToolTextFilter } from './tool-text.ts';
import {
  xiaodanVersion, type AgentDeps, type AgentRow, type AgentTool, type DeviceContext, type ToolContext, type TraceEvent,
  type TurnSink,
} from './types.ts';

export const HARD_MAX_STEPS = 10;
const TOOL_RESULT_CHARS = 4000;
const DEFAULT_TOOL_TIMEOUT_MS = 20_000;

export { conversations };

export interface TurnInput {
  agent: AgentRow;
  device: DeviceContext;
  query: string;
  engineMessages: readonly { role: string; content: string }[];
  conversationKey: string;
  /** 写对话记录用;网页试聊不记 */
  record: { mac: string; sessionId: string } | null;
  signal: AbortSignal;
  sink: TurnSink;
  trace?: (event: TraceEvent) => void;
}

export interface TurnSummary {
  reply: string;
  steps: number;
  toolCalls: number;
  error?: string;
}

function loadLlm(deps: AgentDeps, agent: AgentRow): LlmConfig | null {
  if (!agent.llm_model_id) return null;
  const row = one<{ config_json: string; provider: string }>(
    deps.conn, "SELECT config_json, provider FROM models WHERE id = ? AND model_type = 'LLM' AND enabled = 1", agent.llm_model_id,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.config_json) as LlmConfig;
  } catch {
    return null;
  }
}

function llmParams(agent: AgentRow): { thinking: boolean; temperature?: number } {
  try {
    const parsed = JSON.parse(agent.llm_params_json || '{}') as { thinking?: unknown; temperature?: unknown };
    return {
      thinking: parsed.thinking === true,
      ...(typeof parsed.temperature === 'number' ? { temperature: parsed.temperature } : {}),
    };
  } catch {
    return { thinking: false };
  }
}

function recordMessage(deps: AgentDeps, input: TurnInput, chatType: 1 | 2 | 3, content: string): void {
  if (!input.record || !content) return;
  try {
    run(
      deps.conn,
      'INSERT INTO chat_messages (mac, session_id, chat_type, content, agent_id) VALUES (?, ?, ?, ?, ?)',
      input.record.mac, input.record.sessionId, chatType, content, input.agent.id,
    );
  } catch (error) {
    deps.log?.(`写对话记录失败:${(error as Error).message}`);
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)} 秒没有结果`)), ms);
    const onAbort = () => reject(new Error('本轮已被打断'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function hintMessage(device: DeviceContext, tool: AgentTool): Record<string, unknown> {
  // 新固件认 hint 命令、显示服务端给的文字;老固件只认引擎原来那条 "% 工具名" 的 stt 消息
  return xiaodanVersion(device) >= 2
    ? { type: 'xiaodan', cmd: 'hint', text: (tool.hint ?? `正在${tool.label}`).slice(0, 12) }
    : { type: 'stt', text: `% ${tool.name}` };
}

const FALLBACK_NO_MODEL = '😔我还没有配置对话模型,请在控制塔的智能体页面选一个对话模型。';
const FALLBACK_ERROR = '😔我这边连不上大脑了,稍后再试试吧。';
const FALLBACK_EMPTY = '🤔我刚刚走神了,你再说一次好吗?';

export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<TurnSummary> {
  const { agent, device, sink, signal } = input;
  const trace = input.trace ?? (() => {});
  const conversation = conversations.get(input.conversationKey, agent.id);
  let reply = '';
  let spoken = false;
  let toolCallCount = 0;
  let steps = 0;

  const say = (text: string) => {
    if (!text) return;
    sink.text(text);
    reply += text;
    spoken = true;
  };

  recordMessage(deps, input, 1, input.query);

  const llm = loadLlm(deps, agent);
  if (!llm) {
    say(FALLBACK_NO_MODEL);
    return { reply, steps: 0, toolCalls: 0, error: 'no-llm' };
  }

  const toolContext: ToolContext = { deps, agent, device, sink, signal, conversationKey: input.conversationKey };
  const tools = await collectTools(toolContext);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const specs: ToolSpec[] = tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const catalog = skillCatalog(toolContext);
  const system = buildSystemPrompt({
    agent,
    tools,
    now: (deps.now ?? (() => new Date()))(),
    hasScreen: xiaodanVersion(device) >= 1,
    skills: catalog.available,
    loadedSkills: catalog.loaded(conversation),
    memory: catalog.memory,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...historyMessages(conversation, input.engineMessages),
    { role: 'user', content: input.query },
  ];
  const turnSteps: ChatMessage[] = [];
  const maxSteps = Math.min(HARD_MAX_STEPS, Math.max(1, agent.max_steps || 6));
  const params = llmParams(agent);
  let longAnswer = false;
  let error: string | undefined;

  try {
    for (let step = 0; step <= maxSteps; step += 1) {
      if (signal.aborted) break;
      steps = step + 1;
      const lastStep = step === maxSteps;
      const requestMessages = lastStep
        ? [...messages, { role: 'user' as const, content: '[系统提示] 工具调用次数已经到上限。请基于目前已经拿到的信息,直接给用户一个简短的回答,不要再调用工具。' }]
        : messages;
      trace({ kind: 'step', step: steps });

      const leading = new LeadingEmoji(!spoken);
      const filter = new ToolTextFilter(lastStep ? [] : byName.keys(), (m) => deps.log?.(m));
      let stepText = '';
      const textCalls: ToolCall[] = [];
      let nativeCalls: ToolCall[] = [];

      const emit = (raw: string) => {
        const filtered = filter.feed(raw);
        for (const call of filtered.calls) {
          textCalls.push({ id: `call_${randomUUID().slice(0, 12)}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
        }
        if (!filtered.text) return;
        const wasDecided = leading.isDecided;
        const out = leading.feed(filtered.text);
        if (!wasDecided && leading.isDecided && spoken && leading.emoji && leading.emotion) {
          // 这一轮已经说过话(比如过渡语),后面的回答换了情绪:另发一条让屏幕上的表情跟着变
          sink.device({ type: 'llm', text: leading.emoji, emotion: leading.emotion });
        }
        if (out) {
          stepText += out;
          say(out);
        }
      };

      for await (const event of streamChat(deps.fetch, llm, {
        messages: sanitize(requestMessages),
        ...(lastStep || specs.length === 0 ? {} : { tools: specs }),
        thinking: params.thinking,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        // 讲整篇故事这类长回答:输出上限放宽,免得讲到一半被截断
        ...(longAnswer ? { maxTokens: Math.max(4096, Number(llm.max_tokens) || 0) } : {}),
        signal,
      })) {
        if (event.type === 'text') emit(event.text);
        else nativeCalls = event.toolCalls;
      }
      const flushed = filter.finish();
      for (const call of flushed.calls) {
        textCalls.push({ id: `call_${randomUUID().slice(0, 12)}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } });
      }
      const wasDecided = leading.isDecided;
      const tail = leading.feed(flushed.text) + leading.finish();
      if (!wasDecided && leading.isDecided && spoken && leading.emoji && leading.emotion) {
        sink.device({ type: 'llm', text: leading.emoji, emotion: leading.emotion });
      }
      if (tail) {
        stepText += tail;
        say(tail);
      }

      const calls = [...nativeCalls, ...textCalls].filter((call) => byName.has(call.function.name));
      if (calls.length === 0 || lastStep) break;

      const assistant: ChatMessage = { role: 'assistant', content: stepText || null, tool_calls: calls };
      messages.push(assistant);
      turnSteps.push(assistant);

      if (!spoken) {
        const progress = calls.map((call) => byName.get(call.function.name)?.progress).find(Boolean);
        if (progress) say(`🙂${progress}`);
      }
      for (const call of calls) sink.device(hintMessage(device, byName.get(call.function.name)!));

      const results = await Promise.all(calls.map(async (call) => {
        const tool = byName.get(call.function.name)!;
        const args = parseArguments(call.function.arguments);
        trace({ kind: 'tool_call', step: steps, name: tool.name, arguments: args });
        const started = Date.now();
        try {
          const result = await withTimeout(tool.run(toolContext, args), tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, signal);
          trace({ kind: 'tool_result', step: steps, name: tool.name, content: result.content, ms: Date.now() - started, ok: result.ok !== false });
          return { call, tool, args, result };
        } catch (failure) {
          const content = `工具「${tool.label}」失败:${(failure as Error).message}`;
          trace({ kind: 'tool_result', step: steps, name: tool.name, content, ms: Date.now() - started, ok: false });
          return { call, tool, args, result: { content, ok: false } };
        }
      }));
      toolCallCount += results.length;

      let endTurn = false;
      for (const { call, tool, args, result } of results) {
        const content = result.content.length > TOOL_RESULT_CHARS ? `${result.content.slice(0, TOOL_RESULT_CHARS)}…(已截断)` : result.content;
        const toolMessage: ChatMessage = { role: 'tool', tool_call_id: call.id, content };
        messages.push(toolMessage);
        turnSteps.push(toolMessage);
        recordMessage(deps, input, 3, JSON.stringify([
          { type: 'tool', text: `${tool.name}(${JSON.stringify(args)})` },
          { type: 'tool_result', text: content.slice(0, 500) },
        ]));
        if (result.endTurn) endTurn = true;
        if (result.longAnswer) longAnswer = true;
      }
      if (endTurn || signal.aborted) break;
    }
  } catch (failure) {
    if (!signal.aborted) {
      error = failure instanceof LlmError ? failure.message : `${(failure as Error).name}: ${(failure as Error).message}`;
      deps.log?.(`智能体本轮出错:${error}`);
      if (!spoken) say(FALLBACK_ERROR);
    }
  }

  if (!spoken && !signal.aborted && !error) say(FALLBACK_EMPTY);

  const turn: StoredTurn = { user: input.query, steps: turnSteps, reply, at: Date.now() };
  conversations.record(conversation, turn);
  recordMessage(deps, input, 2, reply);
  return { reply, steps, toolCalls: toolCallCount, ...(error ? { error } : {}) };
}

/** 本模块外用得到的情绪工具 */
export { emotionOf };
