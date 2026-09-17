// MP3 时长:逐帧扫描帧头累加采样数。故事音频由几段合成结果首尾拼接而成,没有可靠的 Xing/VBRI 总时长,
// 只能数帧。只认 Layer III(百炼与常见编码器的输出),遇到认不出的字节就往后找下一个帧同步字。

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** 版本位 → 采样率表:3 = MPEG-1,2 = MPEG-2,0 = MPEG-2.5(1 保留) */
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function id3Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const footer = (buf[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** 返回毫秒;不是 MP3 或一帧都没找到返回 0 */
export function mp3DurationMs(buf: Buffer): number {
  let i = id3Size(buf);
  let seconds = 0;
  while (i + 4 <= buf.length) {
    const b1 = buf[i + 1]!;
    const b2 = buf[i + 2]!;
    if (buf[i] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      i += 1;
      continue;
    }
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = b2 >> 4;
    const rateIndex = (b2 >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      i += 1;
      continue;
    }
    const mpeg1 = version === 3;
    const bitrate = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]! * 1000;
    const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
    const padding = (b2 >> 1) & 1;
    const frameBytes = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
    if (frameBytes < 4) {
      i += 1;
      continue;
    }
    seconds += (mpeg1 ? 1152 : 576) / sampleRate;
    i += frameBytes;
  }
  return Math.round(seconds * 1000);
}
