// 回复开头的表情。引擎按一轮里第一段文字中的表情给设备发情绪(上游 core/utils/textUtils.py 的 EMOJI_MAP),
// 表情不在那张表里就一律当作 happy,所以这里保证第一段文字以表内的表情开头。

export const EMOJI_MAP: Readonly<Record<string, string>> = {
  '😂': 'funny', '😭': 'crying', '😠': 'angry', '😔': 'sad', '😍': 'loving', '😲': 'surprised', '😱': 'shocked',
  '🤔': 'thinking', '😌': 'relaxed', '😴': 'sleepy', '😜': 'silly', '🙄': 'confused', '😶': 'neutral', '🙂': 'happy',
  '😆': 'laughing', '😳': 'embarrassed', '😉': 'winking', '😎': 'cool', '🤤': 'delicious', '😘': 'kissy', '😏': 'confident',
};

/** 模型常用但不在表里的表情 → 表里意思最接近的那个 */
const ALIASES: Readonly<Record<string, string>> = {
  '😊': '🙂', '😀': '😆', '😃': '😆', '😄': '😆', '😁': '😆', '🤗': '🙂', '🥰': '😍', '😇': '🙂', '🙃': '😜',
  '😢': '😭', '😥': '😔', '😞': '😔', '😟': '😔', '😕': '🙄', '😮': '😲', '😯': '😲', '😨': '😱', '😰': '😱',
  '😡': '😠', '😤': '😠', '🤩': '😍', '😋': '🤤', '😛': '😜', '😝': '😜', '🤪': '😜', '😪': '😴', '🥱': '😴',
  '🧐': '🤔', '😑': '😶', '😐': '😶', '🥺': '😔', '👋': '🙂', '👍': '🙂', '🎉': '😆', '❤️': '😍', '✨': '🙂',
};

const PICTOGRAPH = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u;
/** 句首的百炼情感标签([excited] 这种),模型可能写在表情前面,也可能写在后面 */
const LEADING_TAGS = /^(?:\s*\[[a-z][a-z ]{0,30}\])+/u;

/** 取开头的表情(若有),返回 [表情, 余下的文字]。句首的情感标签留在余下的文字开头。 */
export function splitLeadingEmoji(text: string): [string | null, string] {
  let rest = text.replace(/^\s+/u, '');
  const before = LEADING_TAGS.exec(rest)?.[0] ?? '';
  rest = rest.slice(before.length).replace(/^\s+/u, '');
  const match = PICTOGRAPH.exec(rest);
  if (!match) return [null, before.trim() + rest];
  return [match[1]!, before.trim() + rest.slice(match[1]!.length)];
}

export function normalizeEmoji(emoji: string | null): string {
  if (emoji && EMOJI_MAP[emoji]) return emoji;
  if (emoji && ALIASES[emoji]) return ALIASES[emoji];
  const bare = emoji?.replace(/️/gu, '');
  if (bare && EMOJI_MAP[bare]) return bare;
  return '🙂';
}

export function emotionOf(emoji: string): string {
  return EMOJI_MAP[emoji] ?? 'happy';
}

/** 去掉文字里所有表情(开头那个之外模型偶尔还会夹带)。 */
export function stripEmoji(text: string): string {
  return text.replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, '');
}

/**
 * 一轮里模型可能分几步说话。整理每一步的开头:
 *  - 这一轮第一次出声:保证以表内表情开头(没有就补 🙂);
 *  - 之后几步:开头的表情去掉,交给调用方另发一条情绪消息让屏幕跟着变。
 * 流式输入时开头可能只到了空白,先扣住,等到第一个非空白字符再决定。
 */
export class LeadingEmoji {
  private pending = '';
  private decided = false;
  private readonly first: boolean;
  /** 这一段开头定下的表情与情绪;非首段且模型没写表情时为 null */
  emoji: string | null = null;
  emotion: string | null = null;

  constructor(firstUtterance: boolean) {
    this.first = firstUtterance;
  }

  feed(chunk: string): string {
    if (this.decided) return stripEmoji(chunk);
    this.pending += chunk;
    if (!/\S/u.test(this.pending)) return '';
    // 开头的情感标签还没写完([exci…),或者目前只有标签、表情可能在下一块:先扣住。太长就不等了
    const afterTags = this.pending.replace(LEADING_TAGS, '').replace(/^\s+/u, '');
    if (this.pending.length < 64 && (/^\s*\[[a-z ]{0,31}$/u.test(afterTags || this.pending) || (!afterTags && LEADING_TAGS.test(this.pending)))) return '';
    // 表情可能被切在两个分块之间(如 ZWJ 序列),凑够几个字符再判断
    if (afterTags.trim().length < 3 && /^\s*\p{Extended_Pictographic}/u.test(afterTags)) return '';
    return this.decide();
  }

  get isDecided(): boolean {
    return this.decided;
  }

  finish(): string {
    if (this.decided || !/\S/u.test(this.pending)) return '';
    return this.decide();
  }

  private decide(): string {
    this.decided = true;
    const [emoji, rest] = splitLeadingEmoji(this.pending);
    this.pending = '';
    const chosen = normalizeEmoji(emoji);
    if (emoji || this.first) {
      this.emoji = chosen;
      this.emotion = emotionOf(chosen);
    }
    const body = stripEmoji(rest);
    return this.first ? chosen + body : body;
  }
}
