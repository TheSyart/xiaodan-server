"""走 OpenAI 兼容网关的语音识别(标准 multipart /v1/audio/transcriptions)。

与 qwen_audio_asr 的关系:只换请求格式与响应解析。那边是百炼的 multimodal-generation
(JSON + data URI 音频),这边是 Whisper 那套 multipart(file + model),返回 {"text": "..."}。

继承下来的两样不能丢:receive_audio 与 handle_voice_stop 给设备桥打标记
(conn._xd_last_audio_in / conn._xd_asr_busy),主动播报靠它们判断用户是不是正在说话。

热词:网关用扩展字段 vocabulary 传 JSON 字符串。实测【音频短于约 2 秒时热词压不过声学模型】
(「小单你好」仍会识别成「小丹」,「小单你好今天天气怎么样」就对),这是模型特性不是接口问题,
所以控制塔那边还留着识别后替换作兜底。

配置示例(控制台模型页填):
  ASR:
    GatewayASR:
      type: gateway_asr
      base_url: https://model.shanchen.space/v1
      api_key: <网关 API Key>
      model_name: bailian/qwen-audio-3.0-asr-flash   # 这一族才支持热词
      vocabulary: "小单|5"
      language_hints: zh
      timeout: 8
      output_dir: tmp/
"""

import time
from typing import List, Optional, Tuple

from config.logger import setup_logging
from core.providers.asr.qwen_audio_asr import ASRProvider as QwenAudioASR
from core.utils import gateway_audio as ga
from core.utils import qwen_audio as qa

TAG = __name__
logger = setup_logging()


class ASRProvider(QwenAudioASR):
    def __init__(self, config: dict, delete_audio_file: bool):
        super().__init__(config, delete_audio_file)
        # 父类按百炼的规则算出了地址与鉴权头,这里整体换掉
        self.url = ga.transcription_url(config)
        self.headers = ga.auth_headers(config)
        self.model = config.get("model_name") or ga.DEFAULT_ASR_MODEL
        self.form = ga.asr_data(config)

    async def speech_to_text(
        self, opus_data: List[bytes], session_id: str, artifacts=None
    ) -> Tuple[Optional[str], Optional[str]]:
        if artifacts is None or not artifacts.pcm_bytes:
            return "", None
        # 网关要的是完整音频文件,不是裸 PCM;16000Hz 与设备上行一致
        wav = qa.pcm_to_wav(artifacts.pcm_bytes, 16000)
        files = {"file": ("audio.wav", wav, "audio/wav")}
        start = time.monotonic()
        try:
            resp = await self._http().post(self.url, data=self.form, files=files, headers=self.headers)
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
            logger.bind(tag=TAG).error(
                f"识别失败 {resp.status_code}: {ga.error_message(data, resp.text[:200])}"
            )
            return "", None
        text = ga.parse_asr_text(data)
        logger.bind(tag=TAG).info(f"识别耗时 {elapsed:.2f}s 结果: {text}")
        return text, None
