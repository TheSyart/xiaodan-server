"""百炼 Qwen-Audio 3.0 语音识别(qwen-audio-3.0-asr-flash),同步 HTTP。

设备是按住说话:松手后整段音频一次识别,正合 flash 的同步接口(单段 5 分钟以内)。
请求体与响应解析在 core/utils/qwen_audio.py,这里只管联网。

配置示例(控制台模型页填):
  ASR:
    QwenAudioASR:
      type: qwen_audio_asr
      api_key: <百炼 API Key>
      workspace_id: <业务空间 ID>      # 或 base_url: https://dashscope.aliyuncs.com
      model_name: qwen-audio-3.0-asr-flash
      vocabulary: "小单|5, 小丹"         # 热词,可选
      language_hints: zh,en             # 可选,不填自动识别
      output_dir: tmp/
"""

import os
import time
from typing import List, Optional, Tuple

import httpx

from config.logger import setup_logging
from core.providers.asr.base import ASRProviderBase
from core.providers.asr.dto.dto import InterfaceType
from core.utils import qwen_audio as qa

TAG = __name__
logger = setup_logging()


class ASRProvider(ASRProviderBase):
    def __init__(self, config: dict, delete_audio_file: bool):
        super().__init__()
        self.interface_type = InterfaceType.NON_STREAM
        self.headers = qa.auth_headers(config)
        self.headers["Content-Type"] = "application/json"
        self.url = qa.http_base(config) + "/api/v1/services/aigc/multimodal-generation/generation"
        self.model = config.get("model_name") or qa.ASR_MODEL
        self.vocabulary = qa.parse_vocabulary(config.get("vocabulary"))
        hints = config.get("language_hints") or []
        if isinstance(hints, str):
            hints = [h.strip() for h in hints.split(",") if h.strip()]
        self.language_hints = hints
        self.timeout = float(config.get("timeout", 8))
        self.output_dir = config.get("output_dir", "tmp/")
        self.delete_audio_file = delete_audio_file
        # 基类在识别前会检查这个目录的剩余空间,目录不存在会直接抛错
        os.makedirs(self.output_dir, exist_ok=True)
        self._client = None

    def _http(self):
        # 识别在引擎共享的事件循环里被 await,必须用异步客户端,同步请求会让所有设备的收发一起停摆
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=3.0), trust_env=False)
        return self._client

    async def receive_audio(self, conn, pcm_frame, audio_have_voice):
        # 设备桥据此判断设备是否正在说话,避免主动播报打断用户
        conn._xd_last_audio_in = time.monotonic()
        await super().receive_audio(conn, pcm_frame, audio_have_voice)

    async def handle_voice_stop(self, conn, asr_audio_task):
        conn._xd_asr_busy = True
        try:
            await super().handle_voice_stop(conn, asr_audio_task)
        finally:
            conn._xd_asr_busy = False

    async def speech_to_text(
        self, opus_data: List[bytes], session_id: str, artifacts=None
    ) -> Tuple[Optional[str], Optional[str]]:
        if artifacts is None or not artifacts.pcm_bytes:
            return "", None
        body = qa.asr_request_body(
            qa.pcm_to_wav(artifacts.pcm_bytes, 16000),
            model=self.model,
            vocabulary=self.vocabulary,
            language_hints=self.language_hints,
        )
        start = time.monotonic()
        try:
            resp = await self._http().post(self.url, json=body, headers=self.headers)
        except Exception as e:
            logger.bind(tag=TAG).error(f"识别请求失败: {type(e).__name__}: {e}")
            return "", None
        elapsed = time.monotonic() - start
        try:
            data = resp.json()
        except ValueError:
            logger.bind(tag=TAG).error(f"识别返回的不是 JSON {resp.status_code}: {resp.text[:200]}")
            return "", None
        if resp.status_code != 200:
            logger.bind(tag=TAG).error(f"识别失败 {resp.status_code}: {qa.asr_error(data) or resp.text[:200]}")
            return "", None
        text = qa.parse_asr_response(data)
        logger.bind(tag=TAG).info(f"识别耗时 {elapsed:.2f}s 结果: {text}")
        return text, None

    async def close(self):
        client, self._client = self._client, None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass
