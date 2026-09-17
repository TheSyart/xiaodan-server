// 生成一张图并做成像素画:服务商出图 → 保存原图 → 工作线程里像素化 → 入库。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { one, run } from '../../db.ts';
import type { AgentDeps } from '../types.ts';
import { devicePrompt, generateQwenImage, ImageError } from './providers.ts';
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

export interface ImageModel {
  id: string;
  name: string;
  config: Record<string, unknown>;
}

/** 智能体选的文生图模型;没选或已停用时用默认的那个 */
export function imageModel(deps: Pick<AgentDeps, 'conn'>, modelId: string | null | undefined): ImageModel | undefined {
  const row = (modelId
    ? one<{ id: string; name: string; config_json: string }>(deps.conn, "SELECT id, name, config_json FROM models WHERE id = ? AND model_type = 'Image' AND enabled = 1", modelId)
    : undefined)
    ?? one<{ id: string; name: string; config_json: string }>(deps.conn,
      "SELECT id, name, config_json FROM models WHERE model_type = 'Image' AND enabled = 1 ORDER BY is_default DESC, id LIMIT 1");
  if (!row) return undefined;
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    /* 坏配置按空处理,后面会报缺密钥 */
  }
  return { id: row.id, name: row.name, config };
}

export async function generateImage(
  deps: AgentDeps,
  input: { prompt: string; mac: string | null; agentId: string | null; modelId?: string | null; childSafe: boolean; signal?: AbortSignal },
): Promise<ImageRecord> {
  const model = imageModel(deps, input.modelId);
  if (!model) throw new ImageError('还没有配置文生图模型(控制塔「模型」页)');
  const prompt = devicePrompt(input.prompt, input.childSafe);
  const outcome = await generateQwenImage(deps.fetch, model.config, prompt, input.signal);
  const art = await pixelateInWorker(outcome.bytes);
  const ext = outcome.bytes[0] === 0xff ? 'jpg' : 'png';
  run(deps.conn,
    'INSERT INTO images (mac, agent_id, prompt, full_prompt, provider, model, ext, palette_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    input.mac, input.agentId, input.prompt, prompt, 'qwen_image', outcome.model, ext, JSON.stringify(art.palette));
  const id = one<{ id: number }>(deps.conn, 'SELECT last_insert_rowid() AS id')!.id;
  const dir = join(deps.dataDir(), 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.${ext}`), outcome.bytes);
  writeFileSync(join(dir, `${id}.pixel.bin`), art.packed);
  writeFileSync(join(dir, `${id}.pixel.png`), art.preview);
  return { id, palette: art.palette, packed: art.packed };
}
