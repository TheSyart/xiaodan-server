"""走 OpenAI 兼容网关的语音合成(HTTP 分块流式)。

与 qwen_audio_tts 的关系:**只换传输层**。那边是百炼的 WebSocket 双工(run-task/continue-task),
这边是网关的 POST /v1/audio/speech + stream:true。其余全部继承 ——
按标点切句、字幕分条、情感标签、音频文件播放保活、以及那三处上游基类的修补,
都在 qwen_audio_tts 里,重写一遍只会让两份逐渐走样。

所以这里只覆盖两样:__init__ 里的地址与请求头,还有 _synthesize。

为什么仍是逐句合成:与 WS 版同理,一句一个请求,收到的 PCM 边到边编码成 Opus。
实测首包约 390 毫秒且与句子长短无关,和直连百炼的 380 毫秒基本持平。

采样率是这条链路最容易出事的地方:引擎按 conn.sample_rate(握手模板里是 24000)建 Opus 编码器,
网关默认却给 22050。请求体里必须带整数 sample_rate,拿回来还要核对响应头里的 rate ——
对不上时音频听起来音调偏高、语速偏快,而且【不会报错】,只能靠这里自己查。

配置示例(控制台模型页填):
  TTS:
    GatewayTTS:
      type: gateway_tts
      base_url: https://model.shanchen.space/v1
      api_key: <网关 API Key>
      model_name: bailian/qwen-audio-3.0-tts-flash
      voice: longanhuan_v3.6            # 控制台会用 private_voice 覆盖成智能体选的音色
      volume: 50                        # 0-100
      rate: 1.0                         # 0.5-2.0,请求时映射成网关的 speed
      pitch: 1.0                        # 0.5-2.0
      instruction: 用温柔亲切的语气说话   # 可选
      inline_tags: [excited, laughing]  # 允许模型写在文字里的情感标签
      output_dir: tmp/
"""

import httpx

from config.logger import setup_logging
from core.providers.tts.qwen_audio_tts import TTSProvider as QwenAudioTTS, _Stopped
from core.utils import gateway_audio as ga

TAG = __name__
logger = setup_logging()


class TTSProvider(QwenAudioTTS):
    def __init__(self, config, delete_audio_file):
        super().__init__(config, delete_audio_file)
        # 父类按百炼的规则算出了 WebSocket 地址与鉴权头,这里整体换掉
        self.url = ga.speech_url(config)
        self.headers = ga.auth_headers(config)
        self.headers["Content-Type"] = "application/json"
        self.model = config.get("model_name") or ga.DEFAULT_TTS_MODEL
        self._client = None
        # 采样率对不上时只警告一次,免得每句刷一行
        self._rate_warned = False
        # 父类的 _drop_connection 见 self._ws 是 None 就什么都不做,这条链路没有长连接,不必覆盖

    def _http(self):
        if self._client is None:
            # 合成在基类的文本线程里跑(不是事件循环),所以用同步客户端。
            # connect 给 5 秒,read 用 tts_timeout:流式下它是「两块数据之间」的间隔上限,不是整句的总时长。
            self._client = httpx.Client(
                timeout=httpx.Timeout(self.tts_timeout, connect=5.0),
                trust_env=False,
            )
        return self._client

    def _check_rate(self, content_type, wanted):
        if self._rate_warned:
            return
        if not ga.is_raw_pcm(content_type):
            self._rate_warned = True
            logger.bind(tag=TAG).error(
                f"网关没有按 pcm 返回(content-type={content_type})。"
                f"qwen3-tts 系会悄悄退回 WAV,请把 model_name 换成 {ga.DEFAULT_TTS_MODEL} 这一族"
            )
            return
        got = ga.parse_rate(content_type)
        if got and got != wanted:
            self._rate_warned = True
            logger.bind(tag=TAG).error(
                f"网关返回 {got}Hz,引擎按 {wanted}Hz 编码,声音会偏尖偏快。"
                f"检查请求里的 sample_rate 是否被网关忽略(必须是整数)"
            )

    def _synthesize(self, text, on_pcm, should_stop=lambda: False):
        """合成一段文字,PCM 分块交给 on_pcm。被打断时抛 _Stopped;服务端失败时抛 RuntimeError。"""
        sample_rate = self._sample_rate()
        body = ga.speech_body(self.config, text, sample_rate)
        try:
            with self._http().stream("POST", self.url, json=body, headers=self.headers) as response:
                if response.status_code != 200:
                    response.read()
                    try:
                        detail = ga.error_message(response.json(), response.text[:200])
                    except ValueError:
                        detail = response.text[:200]
                    raise RuntimeError(f"网关合成失败 {response.status_code}: {detail}")
                self._check_rate(response.headers.get("content-type"), sample_rate)
                for chunk in response.iter_bytes():
                    if should_stop():
                        # 退出 with 会断掉这条连接,剩下的音频不会再流进来
                        raise _Stopped()
                    if chunk:
                        on_pcm(chunk)
        except _Stopped:
            raise
        except httpx.HTTPError as e:
            raise RuntimeError(f"网关合成请求失败: {type(e).__name__}: {e}") from e

    async def close(self):
        client, self._client = self._client, None
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        await super().close()
