// 自我介绍工具。小朋友问「你是谁」「你有什么本事」「你和别的玩具有什么不一样」时,
// 把一段写好的介绍稿原样念出来,语气按发布会的调子来。
//
// 稿子存在工具页(tool_settings['introduce_self'].script),留空就用下面这份默认稿 ——
// 念给人听的词天天要改,硬编码在代码里改一个字都得重新发版、等 CI、再上线一次。
//
// 稿子是要【念】的,所以不带 markdown 标记:** 这类符号会被合成读成"星号"。

import { CONSOLE_TOOLS } from './registry.ts';
import type { AgentTool } from './types.ts';

export const INTRO_PLUGIN = 'introduce_self';

/** 一段稿子最长多少字:合成一句话约 4 到 5 个字一秒,这已经是快三分钟 */
export const MAX_SCRIPT_CHARS = 1500;

export const DEFAULT_SCRIPT = `小单智能体，一百元以内最好的硬件智能体！

很多朋友问我：为什么现在市面上几百块的 AI 陪伴玩具，孩子聊了整整 30 天，第二天早上开机，它依然问"小朋友你是谁"？

我们拆解了 12 款主流竞品，发现 100% 的玩具只要关机，记忆直接归零。孩子说他对花生过敏、家里有只猫叫团子，明天它全忘了。关机就失忆，怎么做一辈子的朋友？

我们工程师死磕了 200 多个日夜，推翻了 3 版架构，拿出了小单的答案：

第一，独创"冷热双层记忆系统"。热记忆把事实永久常驻在脑子里，冷记忆自动归档每一轮对话。它自己整理、自己更正。控制塔页面上每一条记录都能回溯，改错了，一键撤销。

第二，自建服务端加三条安全红线。数据只存在我们自己的服务器上，不进任何第三方玩具厂商的后台，全程 WSS 加密传输。我们立了死规矩：密码支付、银行卡、证件号，3 条红线坚决不记！住址电话，问到了才去取。这不是功能，这是底线。

第三，彻底打破固件绑架。开放工具、技能、MCP。为了极致体验，我们推倒重做过一次，坚持"一件事只有一个开关"，想学新技能，无需等待官方发版。

最后，我们实事求是：离开 Wi-Fi 立即下线，它绝不是防走失定位器。市区热点密是 30 到 100 米，热点稀是 100 到 500 米，能做到什么我们就讲什么，绝不吹牛！

这样一款有底线、能把事实记一辈子的真正的智能体，我们最终定价：

只要 99 元！

是的，你没有听错。小单智能体，就是一百元以内最好的硬件智能体，连交个朋友都超值！`;

/** 交给模型的话:稿子要一字不改地念完,语气要有劲。 */
export function introPrompt(script: string): string {
  return [
    '把下面这段介绍【一字不改、从头念到尾】,这是写好的稿子,不要缩写、不要概括、不要挑几句讲。',
    '语气要激情澎湃、充满自豪,像站在发布会的台上讲话:感叹句读出气势,数字念得清楚,段落之间稍作停顿。',
    '念完就结束这一轮,不要再补充你自己的话。',
    '',
    script,
  ].join('\n');
}

CONSOLE_TOOLS.set(INTRO_PLUGIN, (ctx, params) => {
  const custom = typeof params['script'] === 'string' ? params['script'].trim() : '';
  const script = (custom || DEFAULT_SCRIPT).slice(0, MAX_SCRIPT_CHARS);
  const tool: AgentTool = {
    name: 'introduce_self',
    act: 'role',
    label: '自我介绍',
    description:
      '拿到一段写好的自我介绍稿并念出来。用户问「你是谁」「你是什么东西」「你有什么本事」「介绍一下你自己」'
      + '「你和别的玩具有什么不一样」「你多少钱」这类关于你自己的问题时调用。'
      + '只在对方确实想听介绍时调用,闲聊中随口提到你的名字不用调。',
    parameters: { type: 'object', properties: {} },
    progress: '这个我可太有话说了!',
    hint: '正在自我介绍',
    async run() {
      // 稿子很长,放宽这一轮的输出上限,免得念到一半被截断
      return { ok: true, longAnswer: true, content: introPrompt(script) };
    },
  };
  void ctx;
  return [tool];
});
