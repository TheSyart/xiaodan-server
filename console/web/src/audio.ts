// 音色页用的浏览器端音频工具:播放接口返回的音频、录音、把任意音频转成 16 kHz 单声道 WAV。
//
// 复刻样本统一在浏览器里转成 WAV 再上传:百炼要求 WAV(16 位)/MP3/M4A、至少 16 kHz,
// 而浏览器录音拿到的是 webm/ogg,手机上传的也可能是别的格式。转一遍顺带截到 60 秒以内。

let current: HTMLAudioElement | null = null;
let currentUrl = '';

/** 播放一段音频;再次调用会先停掉上一段。 */
export function playBlob(blob: Blob): Promise<void> {
  stopPlayback();
  currentUrl = URL.createObjectURL(blob);
  current = new Audio(currentUrl);
  return current.play();
}

export function playBase64Wav(base64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return playBlob(new Blob([bytes], { type: 'audio/wav' }));
}

export function stopPlayback(): void {
  current?.pause();
  current = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = '';
}

const TARGET_RATE = 16000;
const MAX_SECONDS = 60;

/** 解码任意浏览器能播放的音频,重采样成 16 kHz 单声道 16 位 WAV。返回 WAV 与时长(秒)。 */
export async function toWav16k(input: Blob): Promise<{ wav: Blob; seconds: number }> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await input.arrayBuffer());
  } finally {
    void context.close();
  }
  const seconds = Math.min(decoded.duration, MAX_SECONDS);
  const length = Math.max(1, Math.floor(seconds * TARGET_RATE));
  const offline = new OfflineAudioContext(1, length, TARGET_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return { wav: encodeWav(rendered.getChannelData(0), TARGET_RATE), seconds };
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface Recorder {
  stop: () => Promise<Blob>;
  cancel: () => void;
}

/** 开始录音。浏览器会先弹出麦克风授权;页面不是 https 或被权限策略禁用时会抛错。 */
export async function startRecording(): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('这个浏览器不支持录音,请改用上传音频文件');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();
  const release = () => stream.getTracks().forEach((track) => track.stop());
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== 'inactive') recorder.stop();
      else release();
    },
  };
}
