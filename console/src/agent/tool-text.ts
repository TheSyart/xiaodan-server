// 把模型写在正文里的工具调用文本截下来,解析成结构化调用。移植自 server/engine/xiaodan_tool_text.py(引擎旧路径仍在用)。
//
// DeepSeek 官方接口正常会给 delta.tool_calls;但经网关或换成别家模型时,生产上见过把调用写进正文:
//   DeepSeek DSML:<｜DSML｜function_calls><｜DSML｜invoke name="get_weather"><｜DSML｜parameter name="location" string="true">北京</…>
//   XML 风格:<tool_call>{"name":"get_weather","arguments":{"location":"北京"}}</tool_call>、<tool_calls><tool_name>show_calendar</tool_name></tool_calls>
// 这些块一旦流出去就会被念出来。所以正文先过这个过滤器:普通文字原样放行,像是标记开头的残段先扣住,
// 块整个截下来解析;只放行本轮真正提供的工具名,认不出的块整块丢弃。
// 与 Python 版的区别:不需要 direct_answer 的边收边交(控制塔不用那个虚拟工具)。

export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const BARS = '[｜|]+';
const DSML = `${BARS}\\s*DSML\\s*${BARS}`;
const DSML_START = new RegExp(`<\\s*${DSML}\\s*(?!\\/)`, 'iu');
const DSML_BLOCK_CLOSE = new RegExp(`<\\s*(?:\\/\\s*${DSML}|${DSML}\\s*\\/)\\s*[a-z_]*calls\\s*>`, 'iu');
const DSML_INVOKE = new RegExp(`<\\s*${DSML}\\s*invoke\\s+name\\s*=\\s*"([^"]*)"\\s*>([\\s\\S]*?)(?:<\\s*(?:\\/\\s*${DSML}|${DSML}\\s*\\/)\\s*invoke\\s*>|$)`, 'giu');
const DSML_PARAM = new RegExp(`<\\s*${DSML}\\s*parameter\\s+name\\s*=\\s*"([^"]*)"(?:\\s+string\\s*=\\s*"(true|false)")?[^>]*>([\\s\\S]*?)<\\s*(?:\\/\\s*${DSML}|${DSML}\\s*\\/)\\s*parameter\\s*>`, 'giu');

const TAG_NAMES = 'tool_calls?|function_calls?|tool_use';
const TAG_START = new RegExp(`<\\s*(${TAG_NAMES})\\b[^<>]*>`, 'iu');
const WRAPPER = /<\s*\/?\s*(?:tool_calls|function_calls)\b[^<>]*>/giu;
const UNIT_OPEN = /<\s*(tool_call|function_call|tool_use|invoke)\b([^<>]*)>/giu;
const NAME_TAG = /<\s*(tool_name|function_name|name)\s*>\s*([^<]*?)\s*<\s*\/\s*\1\s*>/iu;
const ARGS_TAG = /<\s*(parameters|arguments|args|params|input)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/iu;
const PARAM_TAG = /<\s*parameter\s+name\s*=\s*"([^"]+)"[^<>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/giu;
const CHILD_TAG = /<\s*([A-Za-z_]\w*)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gu;
const ATTR_NAME = /\bname\s*=\s*["']([^"']+)["']/iu;
const ANY_TAG = /<[^<>]*>/gu;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*/u;
const KWARG = /([A-Za-z_]\w*)\s*[=:]\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,]+)/gu;

/** 可能是标记开头的规范形式(去空白、竖线统一、大写) */
const CANONS = ['<｜DSML｜', '<TOOL_CALL', '<TOOL_CALLS', '<FUNCTION_CALL', '<FUNCTION_CALLS', '<TOOL_USE'];
const HOLD_MAX = 40;
const BLOCK_MAX = 20_000;

const canon = (text: string) => text.replace(/\s+/gu, '').replace(/\|/gu, '｜').toUpperCase().replace(/｜+/gu, '｜');

function jsonDict(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function scalar(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function kwargs(text: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  for (const match of text.matchAll(KWARG)) {
    const raw = match[2]!.trim();
    if ((raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0]!) && raw.length >= 2) {
      args[match[1]!] = raw[0] === '"' ? (scalar(raw) as unknown) : raw.slice(1, -1);
    } else {
      args[match[1]!] = scalar(raw);
    }
  }
  return Object.keys(args).length ? args : null;
}

/** 没有标签的调用文字:{"name","arguments"} JSON;函数名;函数名 {JSON};函数名({JSON});函数名(k="v")。 */
export function parseCallText(body: string): TextToolCall | null {
  const text = body.trim().replace(/^```[a-z]*\s*|\s*```$/giu, '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    const obj = jsonDict(text);
    if (!obj) return null;
    const fn = typeof obj['function'] === 'object' && obj['function'] !== null ? (obj['function'] as Record<string, unknown>) : {};
    const name = obj['name'] ?? obj['tool_name'] ?? fn['name'];
    let args: unknown = obj['arguments'] ?? obj['parameters'] ?? fn['arguments'] ?? {};
    if (typeof args === 'string') args = args.trim() ? jsonDict(args) : {};
    if (typeof name !== 'string' || !NAME.test(name.trim()) || typeof args !== 'object' || args === null || Array.isArray(args)) {
      return null;
    }
    return { name: name.trim(), arguments: args as Record<string, unknown> };
  }
  const named = NAME.exec(text);
  if (!named) return null;
  let rest = text.slice(named[0].length).trim();
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
  if (!rest) return { name: named[0], arguments: {} };
  const args = jsonDict(rest) ?? kwargs(rest);
  return args ? { name: named[0], arguments: args } : null;
}

function parseUnit(attrs: string, body: string): TextToolCall | null {
  let name = ATTR_NAME.exec(attrs)?.[1]?.trim() ?? null;
  let rest = body;
  const nameTag = NAME_TAG.exec(rest);
  if (nameTag) {
    name ??= nameTag[2]!.trim();
    rest = rest.replace(nameTag[0], '');
  }
  let args: Record<string, unknown> | null = null;
  const argsTag = ARGS_TAG.exec(rest);
  if (argsTag) {
    const inner = argsTag[2]!.trim();
    args = inner.startsWith('{') ? jsonDict(inner) : null;
    if (!args) {
      const children: Record<string, unknown> = {};
      for (const m of inner.matchAll(CHILD_TAG)) children[m[1]!] = scalar(m[2]!);
      args = Object.keys(children).length ? children : (inner ? kwargs(inner) : null) ?? {};
    }
    rest = rest.replace(argsTag[0], '');
  }
  const params: Record<string, unknown> = {};
  for (const m of rest.matchAll(PARAM_TAG)) params[m[1]!] = scalar(m[2]!);
  if (Object.keys(params).length) {
    args = { ...(args ?? {}), ...params };
    rest = rest.replace(PARAM_TAG, '');
  }
  const leftover = rest.replace(ANY_TAG, '').trim();
  if (name === null) {
    const call = parseCallText(leftover);
    if (!call) return null;
    return { name: call.name, arguments: { ...call.arguments, ...(args ?? {}) } };
  }
  if (!args) args = (leftover.startsWith('{') ? jsonDict(leftover) : null) ?? {};
  return NAME.test(name) && NAME.exec(name)![0] === name ? { name, arguments: args } : null;
}

/** 解析 XML 风格的整块 */
export function parseTagBlock(block: string): TextToolCall[] {
  const text = block.replace(WRAPPER, '');
  const opens = [...text.matchAll(UNIT_OPEN)];
  const units: [string, string][] = [];
  if (opens.length === 0) units.push(['', text]);
  opens.forEach((opened, k) => {
    const start = opened.index! + opened[0].length;
    const end = k + 1 < opens.length ? opens[k + 1]!.index! : text.length;
    const body = text.slice(start, end);
    const closer = new RegExp(`<\\s*\\/\\s*${opened[1]}\\s*>`, 'iu').exec(body);
    units.push([opened[2] ?? '', closer ? body.slice(0, closer.index) : body]);
  });
  return units.map(([attrs, body]) => parseUnit(attrs, body)).filter((call): call is TextToolCall => call !== null);
}

/** 解析 DSML 整块 */
export function parseDsmlBlock(block: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  for (const invoke of block.matchAll(DSML_INVOKE)) {
    const name = invoke[1]!.trim();
    if (!NAME.test(name)) continue;
    const args: Record<string, unknown> = {};
    for (const param of invoke[2]!.matchAll(DSML_PARAM)) {
      const raw = param[3]!;
      if (param[2]?.toLowerCase() === 'false') {
        args[param[1]!] = scalar(raw);
      } else {
        args[param[1]!] = raw.trim();
      }
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

export interface FilterOutput {
  text: string;
  calls: TextToolCall[];
}

export class ToolTextFilter {
  private buffer = '';
  private readonly allowed: Set<string> | null;
  private readonly warn: (message: string) => void;

  constructor(allowedNames: Iterable<string> | null, warn: (message: string) => void = () => {}) {
    this.allowed = allowedNames ? new Set(allowedNames) : null;
    this.warn = warn;
  }

  feed(chunk: string): FilterOutput {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): FilterOutput {
    return this.drain(true);
  }

  private drain(final: boolean): FilterOutput {
    let text = '';
    const calls: TextToolCall[] = [];
    for (;;) {
      const dsml = DSML_START.exec(this.buffer);
      const tag = TAG_START.exec(this.buffer);
      const start = [dsml?.index, tag?.index].filter((i): i is number => i !== undefined).sort((a, b) => a - b)[0];
      if (start === undefined) {
        // 没有块:末尾像标记开头的残段先扣住
        const hold = final ? '' : this.partialTail(this.buffer);
        text += this.buffer.slice(0, this.buffer.length - hold.length);
        this.buffer = hold;
        break;
      }
      text += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start);
      const isDsml = dsml !== null && dsml.index === start;
      const end = isDsml ? this.dsmlEnd() : this.tagEnd();
      if (end === -1 && !final && this.buffer.length < BLOCK_MAX) break;   // 块还没收完
      const block = end === -1 ? this.buffer : this.buffer.slice(0, end);
      this.buffer = end === -1 ? '' : this.buffer.slice(end);
      const parsed = isDsml ? parseDsmlBlock(block) : parseTagBlock(block);
      const kept = parsed.filter((call) => this.allowed === null || this.allowed.has(call.name));
      if (parsed.length !== kept.length) this.warn(`丢弃了本轮没有提供的工具:${parsed.filter((c) => !kept.includes(c)).map((c) => c.name).join('、')}`);
      if (kept.length === 0) this.warn(`正文里的工具调用块没有解析出可用调用,已丢弃:${block.slice(0, 120)}`);
      calls.push(...kept);
      if (end === -1) break;
    }
    return { text, calls };
  }

  private partialTail(text: string): string {
    const at = text.lastIndexOf('<');
    if (at < 0) return '';
    const tail = text.slice(at);
    if (tail.length <= HOLD_MAX && CANONS.some((c) => c.startsWith(canon(tail)))) return tail;
    // 带属性、还没写到 ">" 的开标签
    if (tail.length <= 160 && new RegExp(`^<\\s*(?:${TAG_NAMES})\\b[^<>]*$`, 'iu').test(tail)) return tail;
    return '';
  }

  private dsmlEnd(): number {
    const close = DSML_BLOCK_CLOSE.exec(this.buffer);
    return close ? close.index + close[0].length : -1;
  }

  private tagEnd(): number {
    const open = TAG_START.exec(this.buffer)!;
    const tagName = open[1]!.toLowerCase();
    // 同名标签可能套两层:找与第一个开标签配对的那个闭标签
    const pattern = new RegExp(`<\\s*(\\/)?\\s*${tagName}\\b[^<>]*>`, 'giu');
    let depth = 0;
    for (const match of this.buffer.matchAll(pattern)) {
      depth += match[1] ? -1 : 1;
      if (depth === 0) return match.index! + match[0].length;
    }
    return -1;
  }
}
