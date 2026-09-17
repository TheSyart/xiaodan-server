// 画画工具:按用户的描述出图,像素画发到设备屏幕,原图进画廊。

import { CONSOLE_TOOLS } from '../registry.ts';
import { xiaodanVersion, type AgentTool } from '../types.ts';
import { imageMessages } from './pixel.ts';
import { ImageError } from './providers.ts';
import { generateImage } from './run.ts';

export const IMAGE_PLUGIN = 'image';

CONSOLE_TOOLS.set(IMAGE_PLUGIN, () => {
  const tool: AgentTool = {
    name: 'generate_image',
    label: '画画',
    description: '按描述画一幅画(文生图),画好后显示在设备屏幕上,原图保存在控制塔画廊。用户说「画一只…」「帮我画…」时调用。' +
      'prompt 要把用户想要的主体、动作、场景、颜色写具体。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述,中文,具体一些,例如「一只戴着红色小帽子的橘猫坐在月亮上,星空背景」' },
      },
      required: ['prompt'],
    },
    timeoutMs: 120_000,
    progress: '好呀,我来画一画,稍等一下哦。',
    hint: '正在画画',
    async run(ctx, args) {
      const prompt = String(args['prompt'] ?? '').trim().slice(0, 400);
      if (!prompt) return { ok: false, content: '没有说要画什么,问一下用户。' };
      try {
        const record = await generateImage(ctx.deps, {
          prompt, mac: ctx.device.mac, agentId: ctx.agent.id, modelId: ctx.agent.image_model_id,
          childSafe: ctx.agent.safety_level === 'child', signal: ctx.signal,
        });
        const canShow = xiaodanVersion(ctx.device) >= 2;
        if (canShow) for (const message of imageMessages(record.id, { size: 128, palette: record.palette, packed: record.packed })) ctx.sink.device(message);
        return {
          ok: true,
          content: canShow
            ? '画好了,已经显示在设备屏幕上,原图保存在控制塔画廊。用一两句话简单描述一下画里有什么。'
            : '画好了,原图保存在控制塔画廊(这台设备的屏幕显示不了图片)。告诉用户可以在控制塔的画廊里看。',
        };
      } catch (error) {
        const message = error instanceof ImageError ? error.message : (error as Error).message;
        return { ok: false, content: `画画失败:${message}。如实告诉用户。` };
      }
    },
  };
  return [tool];
});
