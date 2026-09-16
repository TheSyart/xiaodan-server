// 在工作线程里做像素化:解码一张 1024 像素的 PNG 要几百毫秒,放在主线程会卡住所有设备的对话事件流。

import { parentPort, workerData } from 'node:worker_threads';
import { pixelate } from './pixel.ts';

const { buffer, size, colors } = workerData as { buffer: Uint8Array; size: number; colors: number };
try {
  const art = pixelate(Buffer.from(buffer), size, colors);
  parentPort!.postMessage({ ok: true, palette: art.palette, packed: art.packed, preview: art.preview, indices: art.indices });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: (error as Error).message });
}
