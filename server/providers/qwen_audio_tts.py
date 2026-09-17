"""百炼 Qwen-Audio 3.0 语音合成(qwen-audio-3.0-tts-flash),WebSocket 流式。

为什么不直接用上游的 alibl_stream(同一套 CosyVoice 协议):
  - 它把一整轮对话开成一个双工任务。控制塔跑多步工具时文字会停顿十几秒,百炼会关掉空闲的任务,后半轮就没声了;
  - 它把音频文件(音乐、故事、提示音)攒到整轮结束才播,顺序全乱;
  - 地址写死、没有语气指令(instruction)。
所以这里沿用引擎基类的文本线程(按标点切句),每一句开一个 run-task/continue-task/finish-task,
收到的 PCM 边到边编码成 Opus,首包延迟与流式相当。协议与请求体见 core/utils/qwen_audio.py。

另外修两处上游基类的问题:
  - _process_remaining_text_stream 把 processed_chars 累加了全文长度(应为赋值),
    一轮中间插一个音频文件后,后面的文字会被跳过;
  - 音频文件只有二进制帧,设备的播放看门狗 60 秒收不到 JSON 就收起播放,长音乐、长故事会被截断,
    所以播文件时每约 20 秒插一条 sentence_start。

情感标签([excited]、[laughing]……,见 core/utils/qwen_audio.py):
  - 基类切句后修边会把方括号当标点去掉,所以 _get_segment_text 与 _process_remaining_text_stream 换成保住标签的修边;
  - 只保留控制塔下发的 inline_tags,其余去掉;一段只剩标签时留给这一轮的下一段;
  - 发给设备的字幕去掉全部标签。

配置示例(控制台模型页填):
  TTS:
    QwenAudioTTS:
      type: qwen_audio_tts
      api_key: <百炼 API Key>
      workspace_id: <业务空间 ID>      # 或 base_url / ws_url
      model_name: qwen-audio-3.0-tts-flash
      voice: longanhuan_v3.6            # 控制台会用 private_voice 覆盖成智能体选的音色
      volume: 50                        # 0-100
      rate: 1.0                         # 0.5-2.0
      pitch: 1.0                        # 0.5-2.0
      instruction: 用温柔亲切的语气说话   # 可选,至多 100 个单位(一个汉字算 2 个);方言也写在这里
      inline_tags: [excited, laughing]  # 允许模型写在文字里的情感标签;不给就全部去掉
      output_dir: tmp/
"""

import os
import threading
import time
import uuid

from websockets.sync.client import connect as ws_connect

from config.logger import setup_logging
from core.providers.tts.base import TTSProviderBase
from core.providers.tts.dto.dto import SentenceType
from core.utils import qwen_audio as qa
from core.utils.tts import MarkdownCleaner

TAG = __name__
logger = setup_logging()

# 百炼在任务结束后 60 秒关闭空闲连接,提前一点主动换新连接,免得发出去才发现已断
_IDLE_RECONNECT_S = 45


class _Stopped(Exception):
    """本段合成被打断(用户打断或已经开始了新的一轮)。"""


class TTSProvider(TTSProviderBase):
    def __init__(self, config, delete_audio_file):
        super().__init__(config, delete_audio_file)
        self.config = dict(config)
        self.headers = qa.auth_headers(config)
        self.url = qa.ws_url(config)
        self.model = config.get("model_name") or qa.TTS_MODEL
        self.recv_timeout = float(config.get("recv_timeout", self.tts_timeout))
        self._ws = None
        self._ws_used_at = 0.0
        # 文本线程与 text_to_speak(唤醒词等)可能交叉使用连接
        self._lock = threading.Lock()
        # 设备桥登记的音频文件标题,播放保活时显示在字幕上
        self.xd_media_titles = {}
        # 允许的情感标签;一段只剩标签时暂存,留给同一轮的下一段
        self.inline_tags = qa.parse_allowed_tags(config.get("inline_tags"))
        self._carry_tags = ""
        self._carry_sentence = None

    # ---- 连接 ----

    def _sample_rate(self):
        # 必须与编码器一致:引擎按 conn.sample_rate 建 Opus 编码器(握手模板里是 24000,不是设备 hello 声明的 16000)
        conn = self.conn
        return int(getattr(conn, "sample_rate", 0) or 24000)

    def _connection(self):
        now = time.monotonic()
        if self._ws is not None and now - self._ws_used_at > _IDLE_RECONNECT_S:
            self._drop_connection()
        if self._ws is None:
            self._ws = ws_connect(
                self.url,
                additional_headers=self.headers,
                open_timeout=5,
                close_timeout=2,
                max_size=None,
            )
        self._ws_used_at = now
        return self._ws

    def _drop_connection(self):
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass

    # ---- 合成 ----

    def _synthesize(self, text, on_pcm, should_stop=lambda: False):
        """合成一段文字,PCM 分块交给 on_pcm。被打断时抛 _Stopped;服务端失败时抛 RuntimeError。"""
        parameters = qa.tts_parameters(self.config, self._sample_rate())
        with self._lock:
            ws = self._connection()
            task_id = uuid.uuid4().hex
            try:
                ws.send(qa.run_task(task_id, self.model, parameters))
                self._wait_for(ws, task_id, "task-started", should_stop)
                ws.send(qa.continue_task(task_id, text))
                ws.send(qa.finish_task(task_id))
                while True:
                    if should_stop():
                        raise _Stopped()
                    message = ws.recv(timeout=self.recv_timeout)
                    self._ws_used_at = time.monotonic()
                    if isinstance(message, (bytes, bytearray)):
                        if message:
                            on_pcm(bytes(message))
                        continue
                    event, event_task, error = qa.parse_event(message)
                    if event_task and event_task != task_id:
                        continue
                    if event == "task-finished":
                        return
                    if event == "task-failed":
                        raise RuntimeError(error)
            except _Stopped:
                # 不等服务端收尾:直接换连接最快,残留的音频帧随旧连接一起丢掉
                self._drop_connection()
                raise
            except Exception:
                self._drop_connection()
                raise

    def _wait_for(self, ws, task_id, wanted, should_stop):
        while True:
            if should_stop():
                raise _Stopped()
            message = ws.recv(timeout=self.recv_timeout)
            if isinstance(message, (bytes, bytearray)):
                continue
            event, event_task, error = qa.parse_event(message)
            if event_task and event_task != task_id:
                continue
            if event == wanted:
                return
            if event == "task-failed":
                raise RuntimeError(error)

    def to_tts_stream(self, text, opus_handler=None) -> None:
        conn = self.conn
        sentence_id = getattr(self, "current_sentence_id", None)
        if self._carry_sentence != sentence_id:
            self._carry_tags = ""
            self._carry_sentence = sentence_id
        original_text = qa.filter_tags(self._carry_tags + (text or ""), self.inline_tags)
        self._carry_tags = ""
        text = MarkdownCleaner.clean_markdown(original_text)
        if self._correct_words_pattern:
            text = self._correct_words_pattern.sub(lambda m: self.correct_words[m.group(0)], text)
        if not qa.speakable(text):
            # 只剩标签(比如句末的 [laughing] 被切成了单独一段):留给下一段,这一轮没有下一段就作罢
            self._carry_tags = qa.tags_only(text)
            return None

        def should_stop():
            return bool(
                conn.client_abort
                or conn.stop_event.is_set()
                or (sentence_id and conn.sentence_id != sentence_id)
            )

        def on_pcm(chunk):
            self.opus_encoder.encode_pcm_to_opus_stream(chunk, False, callback=opus_handler)

        for segment in qa.split_segments(text):
            if should_stop():
                return None
            if not qa.speakable(segment):
                continue
            # 字幕用原文(替换词还原前的文本),去掉情感标签。过长的一句会被切段,每段各发一条 sentence_start
            shown = qa.strip_tags(original_text if segment == text else segment).strip()
            self.tts_audio_queue.put((SentenceType.FIRST, None, shown, sentence_id))
            for attempt in (1, 2):
                produced = []

                def counted(chunk, produced=produced):
                    produced.append(len(chunk))
                    on_pcm(chunk)

                try:
                    self._synthesize(segment, counted, should_stop)
                    break
                except _Stopped:
                    self.opus_encoder.reset_state()
                    return None
                except Exception as e:
                    # 已经出了声就不重试,避免同一句话念两遍
                    if produced or attempt == 2:
                        logger.bind(tag=TAG).error(f"语音合成失败: {segment[:40]} {type(e).__name__}: {e}")
                        break
                    logger.bind(tag=TAG).warning(f"语音合成失败,重试一次: {type(e).__name__}: {e}")
            # 把编码器里不足一帧的尾巴补零送出,句与句之间不串音
            self.opus_encoder.encode_pcm_to_opus_stream(b"", True, callback=opus_handler)
        return None

    async def text_to_speak(self, text, output_file):
        """整段合成成 WAV(唤醒词回复等非流式场景用)。"""
        text = qa.filter_tags(text, self.inline_tags)
        if not qa.speakable(text):
            return None
        chunks = []
        try:
            for segment in qa.split_segments(text):
                self._synthesize(segment, chunks.append)
        except Exception as e:
            logger.bind(tag=TAG).error(f"语音合成失败: {type(e).__name__}: {e}")
            return None
        if not chunks:
            return None
        audio = qa.pcm_to_wav(b"".join(chunks), self._sample_rate())
        if output_file:
            os.makedirs(os.path.dirname(output_file) or ".", exist_ok=True)
            with open(output_file, "wb") as f:
                f.write(audio)
            return None
        return audio

    # ---- 修补基类 ----

    def _get_segment_text(self):
        """与上游基类(c7b126c)相同,只把修边换成保住情感标签的 qa.trim_segment。"""
        from core.utils import textUtils

        full_text = "".join(self.tts_text_buff)
        current_text = full_text[self.processed_chars:]
        last_punct_pos = -1
        punctuations_to_use = self.first_sentence_punctuations if self.is_first_sentence else self.punctuations
        for punct in punctuations_to_use:
            pos = current_text.rfind(punct)
            if (pos != -1 and last_punct_pos == -1) or (pos != -1 and pos < last_punct_pos):
                last_punct_pos = pos
        if last_punct_pos != -1:
            segment_text_raw = current_text[: last_punct_pos + 1]
            segment_text = qa.trim_segment(segment_text_raw, textUtils.is_punctuation_or_emoji)
            self.processed_chars += len(segment_text_raw)
            if self.is_first_sentence:
                self.is_first_sentence = False
            return segment_text
        if self.tts_stop_request and current_text:
            self.is_first_sentence = True
            return current_text
        return None

    def _process_remaining_text_stream(self, opus_handler=None):
        full_text = "".join(self.tts_text_buff)
        remaining_text = full_text[self.processed_chars:]
        # 上游这里是 += len(full_text):一轮中途插入音频文件后,后面的文字会被整段跳过
        self.processed_chars = len(full_text)
        if remaining_text:
            from core.utils import textUtils

            segment_text = qa.trim_segment(remaining_text, textUtils.is_punctuation_or_emoji)
            if segment_text:
                self.to_tts_stream(segment_text, opus_handler=opus_handler)
                return True
        return False

    def _process_audio_file_stream(self, tts_file, callback):
        sentence_id = getattr(self, "current_sentence_id", None)
        title = self.xd_media_titles.pop(tts_file, None) or "正在播放"
        keepalive = qa.Keepalive()

        def with_keepalive(data):
            callback(data)
            if keepalive.tick():
                self.tts_audio_queue.put((SentenceType.FIRST, None, title, sentence_id))

        # 文件音频要用独立的编码器状态:上一句 TTS 编码器里可能还留着半帧
        self.opus_encoder.reset_state()
        super()._process_audio_file_stream(tts_file, callback=with_keepalive)

    async def close(self):
        await super().close()
        with self._lock:
            self._drop_connection()
