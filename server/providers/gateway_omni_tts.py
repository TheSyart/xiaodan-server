"""通过 OpenAI 兼容的 chat/completions 接口做语音合成(TTS)。

为什么需要这个 provider:
自建模型网关只代理 chat 类接口,不提供 /v1/audio/speech(实测 404),
也没有 OpenAI→DashScope 的 TTS 参数转换逻辑,因此:
  - 内置的各家 TTS provider 都要求各自的专用端点,用不了;
  - 直接请求 qwen-tts / qwen3-tts 会被上游拒绝(文本传不过去)。

但 Qwen-Omni 系列是多模态模型,支持在 chat/completions 里
以 modalities=["text","audio"] 直接【输出音频】,这条路径恰好是纯 chat 调用,
网关原样转发即可工作。实测 bailian/qwen3.5-omni-flash + voice=Ethan 可返回音频。

音频以流式 delta 分块返回 base64,需按序拼接后再解码。

配置示例:
  TTS:
    GatewayOmniTTS:
      type: gateway_omni_tts
      base_url: https://model.shanchen.space/v1
      api_key: <网关令牌>
      model_name: bailian/qwen3.5-omni-flash
      voice: Ethan
      audio_format: wav
      output_dir: tmp/
"""

import base64
import io
import json
import os
import wave
from typing import Optional

import requests

from config.logger import setup_logging
from core.providers.tts.base import TTSProviderBase

TAG = __name__
logger = setup_logging()


class TTSProvider(TTSProviderBase):
    def __init__(self, config, delete_audio_file):
        super().__init__(config, delete_audio_file)
        self.api_key = config.get("api_key")
        base_url = (config.get("base_url") or "").rstrip("/")
        self.api_url = base_url if base_url.endswith("/chat/completions") \
            else f"{base_url}/chat/completions"
        self.model = config.get("model_name", "bailian/qwen3.5-omni-flash")
        # 控制台把智能体选的音色放在 private_voice,模型自带的默认音色在 voice。
        # 与上游各 TTS provider 一样优先读前者,否则在控制台换音色不会生效。
        self.voice = config.get("private_voice") or config.get("voice") or "Ethan"
        self.audio_format = config.get("audio_format", "wav")
        # Omni 返回的是【裸 PCM16】而非带 RIFF 头的 WAV(实测首字节不是 "RIFF"),
        # 下游用 ffmpeg 解码会直接报 "Invalid data found"。故需自行封装 WAV 头。
        # 采样率是上游固定输出,不随请求参数变化。
        self.pcm_sample_rate = int(config.get("pcm_sample_rate", 24000))
        self.timeout = int(config.get("timeout", 60))

        if not self.api_key:
            raise ValueError("GatewayOmniTTS 需要配置 api_key")

    def _synthesize(self, text: str) -> Optional[bytes]:
        # 指令写得极简且明确:omni 是通用多模态模型,不加约束它会"回答"而不是"朗读"。
        payload = {
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": f"请逐字朗读下面这段话,不要添加任何额外内容:\n{text}",
            }],
            "modalities": ["text", "audio"],
            "audio": {"voice": self.voice, "format": self.audio_format},
            # 该模型仅支持流式输出,非流式会被上游拒绝
            "stream": True,
        }
        resp = requests.post(
            self.api_url,
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
            timeout=self.timeout,
            stream=True,
        )
        if resp.status_code != 200:
            logger.bind(tag=TAG).error(f"合成请求失败 {resp.status_code}: {resp.text[:200]}")
            return None

        chunks = []
        for raw in resp.iter_lines():
            if not raw:
                continue
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                d = json.loads(body)
            except Exception:
                continue
            if "error" in d:
                logger.bind(tag=TAG).error(f"上游返回错误: {str(d['error'])[:200]}")
                return None
            delta = (d.get("choices") or [{}])[0].get("delta") or {}
            audio = delta.get("audio")
            if isinstance(audio, dict) and audio.get("data"):
                chunks.append(audio["data"])

        if not chunks:
            logger.bind(tag=TAG).error("未收到任何音频分块")
            return None
        try:
            pcm = base64.b64decode("".join(chunks))
        except Exception as e:
            logger.bind(tag=TAG).error(f"音频 base64 解码失败: {e}")
            return None

        if not pcm:
            return None
        # 已带 RIFF 头则原样返回,否则按 16bit 单声道封装
        if pcm[:4] == b"RIFF":
            return pcm
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.pcm_sample_rate)
            w.writeframes(pcm)
        return buf.getvalue()

    async def text_to_speak(self, text, output_file):
        try:
            audio = self._synthesize(text)
            if not audio:
                return None
            if output_file:
                os.makedirs(os.path.dirname(output_file), exist_ok=True)
                with open(output_file, "wb") as f:
                    f.write(audio)
                return None
            return audio
        except Exception as e:
            logger.bind(tag=TAG).error(f"语音合成失败: {e}")
            return None
