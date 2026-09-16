// 生成一张图并做成像素画:服务商出图 → 保存原图 → 工作线程里像素化 → 入库。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { one, run } from '../../db.ts';
import { defaultService } from '../services.ts';
import type { AgentDeps } from '../types.ts';
import { devicePrompt, IMAGE_PROVIDERS, ImageError } from './providers.ts';
import { pixelate, type Color } from './pixel.ts';

export interface ImageRecord {
  id: number;
  palette: Color[];
  packed: Buffer;
}

const SIZE = 128;
const COLORS = 16;

/** 工作线程里像素化;测试或工作线程不可用时直接在本线程做 */
export function pixelateInWorker(bytes: Buffer): Promise<{ palette: Color[]; packed: Buffer; preview: Buffer }> {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL(`./pixel-worker.${ext}`, import.meta.url), { workerData: { buffer: bytes, size: SIZE, colors: COLORS } });
    } catch {
      const art = pixelate(bytes, SIZE, COLORS);
      resolve({ palette: art.palette, packed: art.packed, preview: art.preview });
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ImageError('像素化超时'));
    }, 30_000);
    worker.once('message', (message: { ok: boolean; error?: string; palette: Color[]; packed: Uint8Array; preview: Uint8Array }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (!message.ok) reject(new ImageError(`图片处理失败:${message.error}`));
      else resolve({ palette: message.palette, packed: Buffer.from(message.packed), preview: Buffer.from(message.preview) });
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(new ImageError(`图片处理失败:${error.message}`));
    });
  });
}

export async function generateImage(
  deps: AgentDeps, input: { prompt: string; mac: string | null; agentId: string | null; childSafe: boolean; signal?: AbortSignal },
): Promise<ImageRecord> {
  const service = defaultService(deps.conn, 'image');
  if (!service) throw new ImageError('还没有配置画图服务(控制塔「工具与服务」页)');
  const provider = IMAGE_PROVIDERS[service.provider];
  if (!provider) throw new ImageError(`不认识的画图服务商:${service.provider}`);
  const prompt = devicePrompt(input.prompt, input.childSafe);
  const outcome = await provider(deps.fetch, service.config, prompt, input.signal);
  const art = await pixelateInWorker(outcome.bytes);
  const ext = outcome.bytes[0] === 0xff ? 'jpg' : 'png';
  run(deps.conn,
    'INSERT INTO images (mac, agent_id, prompt, full_prompt, provider, model, ext, palette_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    input.mac, input.agentId, input.prompt, prompt, service.provider, String(service.config['model'] ?? ''), ext, JSON.stringify(art.palette));
  const id = one<{ id: number }>(deps.conn, 'SELECT last_insert_rowid() AS id')!.id;
  const dir = join(deps.dataDir(), 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.${ext}`), outcome.bytes);
  writeFileSync(join(dir, `${id}.pixel.bin`), art.packed);
  writeFileSync(join(dir, `${id}.pixel.png`), art.preview);
  return { id, palette: art.palette, packed: art.packed };
}
