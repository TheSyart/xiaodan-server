// 把生成的图片变成设备屏幕能显示的像素画:居中裁成正方形 → 面积平均缩到 128×128 → 中位切分选 16 色 →
// Floyd–Steinberg 抖动 → 每像素 4 位打包(一个字节两个像素,高 4 位在前)。约 8 KB,设备在对话中也分配得下。
// 同时生成一张放大 3 倍的预览 PNG,控制塔画廊里看「设备上会是什么样」。纯 JS 实现,不依赖原生模块。

import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export type Color = [number, number, number];

export interface PixelArt {
  size: number;
  palette: Color[];
  /** size*size 个调色板下标 */
  indices: Uint8Array;
  /** 4 位打包后的像素 */
  packed: Buffer;
  preview: Buffer;
}

export function decodeImage(buffer: Buffer): Rgba {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 64 });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  throw new Error('只支持 PNG 与 JPEG 图片');
}

/** 居中裁成正方形并用面积平均缩小到 size×size,半透明按白底合成 */
export function cropResize(image: Rgba, size: number): Uint8Array {
  const side = Math.min(image.width, image.height);
  const x0 = Math.floor((image.width - side) / 2);
  const y0 = Math.floor((image.height - side) / 2);
  const out = new Uint8Array(size * size * 3);
  const scale = side / size;
  for (let y = 0; y < size; y += 1) {
    const sy0 = y0 + Math.floor(y * scale);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x += 1) {
      const sx0 = x0 + Math.floor(x * scale);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor((x + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const a = image.data[i + 3]! / 255;
          r += image.data[i]! * a + 255 * (1 - a);
          g += image.data[i + 1]! * a + 255 * (1 - a);
          b += image.data[i + 2]! * a + 255 * (1 - a);
          n += 1;
        }
      }
      const o = (y * size + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

/** 中位切分:反复把颜色范围最大的那一箱沿最长的通道从中位数切开,每箱取平均色 */
export function medianCut(rgb: Uint8Array, colors: number): Color[] {
  const count = rgb.length / 3;
  let boxes: number[][] = [Array.from({ length: count }, (_, i) => i)];
  const range = (box: number[], channel: number) => {
    let min = 255;
    let max = 0;
    for (const i of box) {
      const v = rgb[i * 3 + channel]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  };
  while (boxes.length < colors) {
    let best = -1;
    let bestRange = 0;
    let bestChannel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let channel = 0; channel < 3; channel += 1) {
        const r = range(box, channel);
        if (r > bestRange) {
          bestRange = r;
          best = index;
          bestChannel = channel;
        }
      }
    });
    if (best < 0 || bestRange === 0) break;
    const box = boxes[best]!.sort((a, b) => rgb[a * 3 + bestChannel]! - rgb[b * 3 + bestChannel]!);
    const middle = Math.floor(box.length / 2);
    boxes = [...boxes.slice(0, best), box.slice(0, middle), box.slice(middle), ...boxes.slice(best + 1)];
  }
  const palette = boxes.map((box): Color => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of box) {
      r += rgb[i * 3]!;
      g += rgb[i * 3 + 1]!;
      b += rgb[i * 3 + 2]!;
    }
    return [Math.round(r / box.length), Math.round(g / box.length), Math.round(b / box.length)];
  });
  while (palette.length < colors) palette.push([0, 0, 0]);
  return palette;
}

function nearest(palette: Color[], r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const [pr, pg, pb] = palette[i]!;
    // 按人眼敏感度加权的距离
    const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** Floyd–Steinberg 抖动;strength 小于 1 时误差扩散减弱,画面更干净 */
export function dither(rgb: Uint8Array, size: number, palette: Color[], strength = 0.8): Uint8Array {
  const work = Float32Array.from(rgb);
  const indices = new Uint8Array(size * size);
  const add = (x: number, y: number, er: number, eg: number, eb: number, factor: number) => {
    if (x < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 3;
    work[o] = work[o]! + er * factor;
    work[o + 1] = work[o + 1]! + eg * factor;
    work[o + 2] = work[o + 2]! + eb * factor;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 3;
      const r = Math.max(0, Math.min(255, work[o]!));
      const g = Math.max(0, Math.min(255, work[o + 1]!));
      const b = Math.max(0, Math.min(255, work[o + 2]!));
      const index = nearest(palette, r, g, b);
      indices[y * size + x] = index;
      const [pr, pg, pb] = palette[index]!;
      const er = (r - pr) * strength;
      const eg = (g - pg) * strength;
      const eb = (b - pb) * strength;
      add(x + 1, y, er, eg, eb, 7 / 16);
      add(x - 1, y + 1, er, eg, eb, 3 / 16);
      add(x, y + 1, er, eg, eb, 5 / 16);
      add(x + 1, y + 1, er, eg, eb, 1 / 16);
    }
  }
  return indices;
}

/** 每字节两个像素,高 4 位是左边那个 */
export function pack4(indices: Uint8Array): Buffer {
  const out = Buffer.alloc(Math.ceil(indices.length / 2));
  for (let i = 0; i < indices.length; i += 1) {
    const byte = i >> 1;
    out[byte] = i % 2 === 0 ? (indices[i]! & 0x0f) << 4 : out[byte]! | (indices[i]! & 0x0f);
  }
  return out;
}

export function unpack4(packed: Buffer, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = i % 2 === 0 ? packed[i >> 1]! >> 4 : packed[i >> 1]! & 0x0f;
  return out;
}

export function previewPng(indices: Uint8Array, size: number, palette: Color[], scale = 3): Buffer {
  const png = new PNG({ width: size * scale, height: size * scale });
  for (let y = 0; y < size * scale; y += 1) {
    for (let x = 0; x < size * scale; x += 1) {
      const [r, g, b] = palette[indices[Math.floor(y / scale) * size + Math.floor(x / scale)]!]!;
      const o = (y * size * scale + x) * 4;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

export function pixelate(buffer: Buffer, size = 128, colors = 16): PixelArt {
  const rgb = cropResize(decodeImage(buffer), size);
  const palette = medianCut(rgb, colors);
  const indices = dither(rgb, size, palette);
  return { size, palette, indices, packed: pack4(indices), preview: previewPng(indices, size, palette) };
}

/**
 * 设备消息:第一片带尺寸与调色板,之后每片只带数据。
 * 每片 512 字节(base64 后 684 字符):加上引擎补的 session_id,整条也在固件 1024 字节的 WebSocket 接收缓冲之内,
 * 固件不用为重组另要 4 KB —— 画图时它已经要为整张图要了 8 KB,对话中的空闲堆经不起两块一起要。
 */
export function imageMessages(id: number, art: Pick<PixelArt, 'size' | 'palette' | 'packed'>, chunkBytes = 512): Record<string, unknown>[] {
  const total = Math.ceil(art.packed.length / chunkBytes);
  const pal = art.palette.map(([r, g, b]) => [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')).join('');
  return Array.from({ length: total }, (_, seq) => ({
    type: 'xiaodan_img',
    id: id & 0xffff,
    seq,
    n: total,
    ...(seq === 0 ? { w: art.size, h: art.size, pal } : {}),
    d: art.packed.subarray(seq * chunkBytes, (seq + 1) * chunkBytes).toString('base64'),
  }));
}
