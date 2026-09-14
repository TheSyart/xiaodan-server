"""通过 OpenAI 兼容的 chat/completions 接口做语音识别。

为什么需要这个 provider:
自建模型网关(model.shanchen.space)只代理 chat 类接口,不提供 OpenAI 的
/v1/audio/transcriptions 端点(实测 404),因此内置的 OpenaiASR 用不了;
而内置的 Qwen3ASRFlash 直接调用 dashscope SDK,不走 base_url,也用不了。

但网关上的 qwen3-asr-flash 支持以 input_audio 形式通过 chat/completions 传入音频
(实测可正确识别中文)。本 provider 即走这条路,使 LLM/ASR 共用同一个网关与令牌。

配置示例:
  ASR:
    GatewayASR:
      type: gateway_chat
      base_url: https://model.shanchen.space/v1
      api_key: <网关令牌>
      model_name: bailian/qwen3-asr-flash-2026-02-10
      output_dir: tmp/
"""

import asyncio
import base64
import os
import time
from typing import List, Optional, Tuple

import requests

from config.logger import setup_logging
from core.providers.asr.base import ASRProviderBase
from core.providers.asr.dto.dto import InterfaceType

TAG = __name__
logger = setup_logging()


class ASRProvider(ASRProviderBase):
    def __init__(self, config: dict, delete_audio_file: bool):
        super().__init__()
        self.interface_type = InterfaceType.NON_STREAM
        self.api_key = config.get("api_key")
        base_url = (config.get("base_url") or "").rstrip("/")
        # 允许填 base_url(.../v1)或直接填完整端点
        self.api_url = base_url if base_url.endswith("/chat/completions") \
            else f"{base_url}/chat/completions"
        self.model = config.get("model_name")
        self.output_dir = config.get("output_dir", "tmp/")
        self.delete_audio_file = delete_audio_file
        self.timeout = int(config.get("timeout", 30))

        if not self.api_key:
            raise ValueError("GatewayASR 需要配置 api_key")
        if not self.model:
            raise ValueError("GatewayASR 需要配置 model_name")

        os.makedirs(self.output_dir, exist_ok=True)

    # 让基类把 PCM 落成 wav 文件后再交给我们
    def requires_file(self) -> bool:
        return True

    async def speech_to_text(
        self,
        opus_data: List[bytes],
        session_id: str,
        artifacts=None,
    ) -> Tuple[Optional[str], Optional[str]]:
        file_path = None
        try:
            if artifacts is None or not getattr(artifacts, "file_path", None):
                logger.bind(tag=TAG).warning("缺少音频文件,跳过识别")
                return "", None
            file_path = artifacts.file_path

            with open(file_path, "rb") as f:
                wav_bytes = f.read()
            if not wav_bytes:
                return "", file_path

            b64 = base64.b64encode(wav_bytes).decode("ascii")
            payload = {
                "model": self.model,
                "messages": [
                    {
                        "role": "user",
                        # 只传音频、不加任何文字提示:qwen3-asr-flash 是专用识别模型,
                        # 额外的指令文本反而可能被当成待处理内容。
                        "content": [
                            {
                                "type": "input_audio",
                                "input_audio": {
                                    "data": f"data:audio/wav;base64,{b64}",
                                    "format": "wav",
                                },
                            }
                        ],
                    }
                ],
            }

            start = time.time()
            # 识别在引擎共享的事件循环里被 await(asr/base.py)。同步的 requests 会把整个循环
            # 卡住一到数秒,期间所有连接的收发都停摆,所以放到线程里执行。
            resp = await asyncio.to_thread(
                requests.post,
                self.api_url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=self.timeout,
            )
            elapsed = time.time() - start

            if resp.status_code != 200:
                logger.bind(tag=TAG).error(
                    f"识别请求失败 {resp.status_code}: {resp.text[:300]}"
                )
                return "", file_path

            data = resp.json()
            choices = data.get("choices") or []
            text = ""
            if choices:
                text = (choices[0].get("message") or {}).get("content") or ""
            # 某些模型会把内容包成分段列表
            if isinstance(text, list):
                text = "".join(
                    seg.get("text", "") for seg in text if isinstance(seg, dict)
                )
            text = text.strip()

            logger.bind(tag=TAG).info(f"识别耗时 {elapsed:.2f}s 结果: {text}")
            return text, file_path

        except Exception as e:
            logger.bind(tag=TAG).error(f"语音识别失败: {e}")
            return "", file_path
