"""智能体 provider:一轮对话交给控制塔的智能体运行时去想,本 provider 只负责转发与执行它回来的事件。

镜像里复制为 core/providers/llm/xiaodan_agent/xiaodan_agent.py,配置由控制塔在 agent-models 里下发:

  LLM:
    LLM_XiaodanAgent:
      type: xiaodan_agent
      url: http://console:8002/xiaodan/agent/turn
      api_key: <这台设备专属的令牌,mac.HMAC(secret)>
      media_secret: <manager-api secret,下载控制塔上的音频用>

控制塔回的是 text/event-stream,每个事件一行 JSON(字段 t):
  text   {"t":"text","v":"…"}            交给引擎的 chat(),照常切句合成;情绪取自第一段文字
  device {"t":"device","msg":{…}}         立刻发给设备(卡片、工具提示、音量、图片分块)
  media  {"t":"media","url":…,"ext":…}     下载到缓存后作为音频文件排进合成队列,排在已经说出的文字之后;
                                           故事可带 cues(正文进度片段),3 级固件播放时按帧数插进音频流
  close_after_turn                         这一轮说完后断开,设备重连时拿到新配置(换角色、换音色)
  error  {"t":"error","speak":"…"}        还什么都没说时把这句话说出来
  done                                     必须有;没有就当作被截断
  以 ":" 开头的注释行是心跳,每 2 秒一次:工具跑得慢时文字会停顿,靠它及时发现用户打断。

chat() 只在每次 yield 之后检查打断,工作线程阻塞在读流上时它管不到,所以打断检查在这里做:
用户打断、连接关闭或新一轮开始(sentence_id 变了)都立即关掉流,控制塔据此取消模型调用与工具。
"""

import json
import time

import httpx

from config.logger import setup_logging
from core.providers.llm.base import LLMProviderBase
from core.utils import xiaodan_bridge_core as core

TAG = __name__
logger = setup_logging()


class LLMProvider(LLMProviderBase):
    def __init__(self, config):
        self.url = config.get("url") or config.get("base_url")
        self.api_key = config.get("api_key") or ""
        self.media_secret = config.get("media_secret") or ""
        self.read_timeout = float(config.get("read_timeout", 15))
        self.max_messages = int(config.get("max_messages", 24))
        if not self.url:
            raise ValueError("xiaodan_agent 需要配置 url")

    # ---- 工具函数 ----

    @staticmethod
    def _conn(session_id):
        from core import xiaodan_bridge

        return xiaodan_bridge.REGISTRY.by_session(session_id) if session_id else None

    @staticmethod
    def _stopped(conn, turn_id):
        if conn is None:
            return False
        stop_event = getattr(conn, "stop_event", None)
        return bool(
            getattr(conn, "client_abort", False)
            or (stop_event is not None and stop_event.is_set())
            or (turn_id and getattr(conn, "sentence_id", None) != turn_id)
        )

    @staticmethod
    def _send(conn, message):
        """在工作线程里把一条 JSON 发给设备,等它真正发出去(最多 5 秒)。"""
        import asyncio

        from core import xiaodan_bridge

        if conn is None or getattr(conn, "loop", None) is None:
            return
        future = asyncio.run_coroutine_threadsafe(xiaodan_bridge.send_device_message(conn, message), conn.loop)
        try:
            future.result(5)
        except Exception as e:
            logger.bind(tag=TAG).warning(f"发给设备失败: {type(e).__name__}: {e}")

    def _messages(self, dialogue):
        # 系统提示词由控制塔按角色组装,引擎这边的不必上送;工具相关的消息在 nointent 模式下不会出现
        items = []
        for message in dialogue or []:
            role = message.get("role")
            content = message.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content:
                items.append({"role": role, "content": content})
        return items[-self.max_messages:]

    def _queue_media(self, conn, turn_id, event):
        from core import xiaodan_bridge
        from core.providers.tts.dto.dto import ContentType, SentenceType, TTSMessageDTO

        url = event.get("url") or ""
        ext = core.media_extension(event.get("ext"))
        if conn is None or getattr(conn, "tts", None) is None or not ext or not core.same_origin(self.url, url):
            logger.bind(tag=TAG).warning(f"忽略音频事件: {str(url)[:80]}")
            return False
        path = xiaodan_bridge.fetch_media_sync(url, ext, self.media_secret)
        title = str(event.get("title") or "")[:40]
        if title and hasattr(conn.tts, "xd_media_titles"):
            conn.tts.xd_media_titles[path] = title
        # 故事的正文进度片段只给认得故事卡片的固件(小单协议 3 级);片段不合法就整组不用
        cues = core.validate_cues(event.get("cues")) if event.get("cues") is not None else None
        if event.get("cues") is not None and cues is None:
            logger.bind(tag=TAG).warning("故事进度片段不合法,本次不显示进度")
        if cues and core.xiaodan_level(getattr(conn, "features", None)) >= 3 and hasattr(conn.tts, "xd_media_cues"):
            conn.tts.xd_media_cues[path] = cues
        conn.tts.tts_text_queue.put(TTSMessageDTO(
            sentence_id=turn_id, sentence_type=SentenceType.MIDDLE, content_type=ContentType.FILE,
            content_detail=title or None, content_file=path,
        ))
        return True

    # ---- 主流程 ----

    def response(self, session_id, dialogue, **kwargs):
        conn = self._conn(session_id)
        turn_id = getattr(conn, "sentence_id", None) if conn is not None else None
        messages = self._messages(dialogue)
        query = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        body = {
            "v": 1,
            "session_id": session_id,
            "turn_id": turn_id,
            "device_id": getattr(conn, "device_id", None),
            "client_ip": getattr(conn, "client_ip", None),
            "features": getattr(conn, "features", None) or {},
            "query": query,
            "messages": messages,
        }
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "text/event-stream"}
        spoken = False
        done = False
        last_output = time.monotonic()
        if conn is not None:
            conn._xd_turn_active = True
        try:
            timeout = httpx.Timeout(connect=3.0, read=self.read_timeout, write=10.0, pool=3.0)
            with httpx.Client(trust_env=False, timeout=timeout) as client:
                with client.stream("POST", self.url, json=body, headers=headers) as resp:
                    content_type = resp.headers.get("content-type", "")
                    if resp.status_code != 200 or "text/event-stream" not in content_type:
                        preview = resp.read()[:200].decode("utf-8", "replace")
                        logger.bind(tag=TAG).error(f"控制塔没有返回事件流 HTTP {resp.status_code} {content_type}: {preview}")
                        yield core.FALLBACK_SPEECH
                        return
                    parser = core.SseParser()
                    for line in resp.iter_lines():
                        if self._stopped(conn, turn_id):
                            logger.bind(tag=TAG).info("本轮被打断或已被新一轮取代,停止接收")
                            return
                        if conn is not None:
                            conn.last_activity_time = time.time() * 1000
                        for event in parser.feed_line(line):
                            kind = event.get("t")
                            if kind == "text":
                                text = event.get("v")
                                if isinstance(text, str) and text:
                                    spoken = True
                                    last_output = time.monotonic()
                                    yield text
                            elif kind == "device":
                                self._send(conn, event.get("msg"))
                                last_output = time.monotonic()
                            elif kind == "media":
                                try:
                                    if self._queue_media(conn, turn_id, event):
                                        spoken = True
                                except Exception as e:
                                    logger.bind(tag=TAG).error(f"音频下载失败: {type(e).__name__}: {e}")
                                last_output = time.monotonic()
                            elif kind == "close_after_turn":
                                if conn is not None:
                                    conn.close_after_chat = True
                            elif kind == "error":
                                speak = event.get("speak")
                                logger.bind(tag=TAG).warning(f"控制塔报告本轮出错: {event.get('message')}")
                                if not spoken and isinstance(speak, str) and speak:
                                    spoken = True
                                    yield speak
                            elif kind == "done":
                                done = True
                            elif kind == "invalid":
                                logger.bind(tag=TAG).warning(f"无法解析的事件: {event.get('raw')}")
                        # 慢工具期间设备收不到任何 JSON,60 秒看门狗会收起界面;每 25 秒补一条"思考中"情绪保活
                        if conn is not None and time.monotonic() - last_output > core.THINKING_KEEPALIVE_S:
                            self._send(conn, {"type": "llm", "text": "🤔", "emotion": "thinking"})
                            last_output = time.monotonic()
                        if done:
                            break
            if not done:
                logger.bind(tag=TAG).warning("控制塔的事件流没有 done 就结束了")
                if not spoken:
                    yield core.FALLBACK_SPEECH
        except httpx.HTTPError as e:
            logger.bind(tag=TAG).error(f"请求控制塔失败: {type(e).__name__}: {e}")
            if not spoken:
                yield core.FALLBACK_SPEECH
        finally:
            if conn is not None:
                conn._xd_turn_active = False
