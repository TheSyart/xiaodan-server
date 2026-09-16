// 对话上下文。
//
// 设备空闲 150 秒就重连一次,每次重连引擎都是新会话、对话历史清零;上游的对话记录只在单个连接里。
// 控制塔按设备记住最近的对话:最近几轮保留完整的工具调用与结果(模型接着上一轮办事要用),更早的只留问与答。
// 30 分钟没说话就当作新的一段对话。只在内存里,控制塔重启后丢失(引擎这一连接内的历史仍会带上来兜底)。

import type { ChatMessage } from './llm.ts';

export interface StoredTurn {
  user: string;
  /** 本轮模型与工具之间的完整往来(不含用户消息与最终回答) */
  steps: ChatMessage[];
  reply: string;
  at: number;
}

export interface Conversation {
  agentId: string;
  turns: StoredTurn[];
  /** 本段对话里已经读过正文的技能 */
  loadedSkills: Set<string>;
  lastAt: number;
}

const IDLE_MS = 30 * 60_000;
const MAX_TURNS = 16;
const FULL_TURNS = 3;
const TOOL_RESULT_CHARS = 1500;
const MAX_CONVERSATIONS = 500;

export class ConversationStore {
  private readonly items = new Map<string, Conversation>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 取某台设备当前的对话;换了智能体或闲置太久就重开。 */
  get(key: string, agentId: string): Conversation {
    const now = this.now();
    let conversation = this.items.get(key);
    if (!conversation || conversation.agentId !== agentId || now - conversation.lastAt > IDLE_MS) {
      conversation = { agentId, turns: [], loadedSkills: new Set(), lastAt: now };
      this.items.set(key, conversation);
      this.evict();
    }
    return conversation;
  }

  reset(key: string): void {
    this.items.delete(key);
  }

  record(conversation: Conversation, turn: StoredTurn): void {
    conversation.turns.push(turn);
    if (conversation.turns.length > MAX_TURNS) conversation.turns.splice(0, conversation.turns.length - MAX_TURNS);
    conversation.lastAt = this.now();
  }

  private evict(): void {
    if (this.items.size <= MAX_CONVERSATIONS) return;
    const oldest = [...this.items.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [key] of oldest.slice(0, this.items.size - MAX_CONVERSATIONS)) this.items.delete(key);
  }
}

function truncateToolMessage(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool' || message.content.length <= TOOL_RESULT_CHARS) return message;
  return { ...message, content: `${message.content.slice(0, TOOL_RESULT_CHARS)}…(已截断)` };
}

/**
 * 历史消息。最近 FULL_TURNS 轮带上工具往来,更早的只有问答。
 * 控制塔这边没有记录(刚重启)时,退回用引擎这一连接里的问答。
 */
export function historyMessages(
  conversation: Conversation, engineMessages: readonly { role: string; content: string }[],
): ChatMessage[] {
  if (conversation.turns.length === 0) {
    // 引擎消息的最后一条就是本轮的用户问题,不算历史
    const past = engineMessages.slice(0, -1).filter((m) => m.role === 'user' || m.role === 'assistant');
    return past.slice(-MAX_TURNS * 2).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }
  const messages: ChatMessage[] = [];
  const fullFrom = conversation.turns.length - FULL_TURNS;
  conversation.turns.forEach((turn, index) => {
    messages.push({ role: 'user', content: turn.user });
    if (index >= fullFrom) messages.push(...turn.steps.map(truncateToolMessage));
    if (turn.reply) messages.push({ role: 'assistant', content: turn.reply });
  });
  return sanitize(messages);
}

/** 保证每个带 tool_calls 的助手消息后面都跟齐了对应的 tool 消息,否则接口会拒绝整个请求。 */
export function sanitize(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const ids = new Set(message.tool_calls.map((call) => call.id));
      const results: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        results.push(messages[j]!);
        j += 1;
      }
      const answered = new Set(results.map((m) => (m.role === 'tool' ? m.tool_call_id : '')));
      if ([...ids].every((id) => answered.has(id))) {
        out.push(message, ...results.filter((m) => m.role === 'tool' && ids.has(m.tool_call_id)));
      } else if (message.content) {
        out.push({ role: 'assistant', content: message.content });
      }
      i = j - 1;
      continue;
    }
    if (message.role === 'tool') continue;   // 孤立的工具结果
    out.push(message);
  }
  return out;
}

/** 进程内唯一的对话存储:设备对话按 device:<mac>,网页试聊按 web:<智能体>:<对话>。 */
export const conversations = new ConversationStore();
