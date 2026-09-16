"""设备桥与智能体 provider 共用的纯逻辑:连接登记表、忙闲判断、SSE 解析、地址校验。只用标准库。

    python3 -m unittest discover -s server/tests -v

架构(见仓库 README「智能体大脑」):一轮对话的思考在控制塔里跑,引擎只负责听、说与操作设备。
  - 引擎的 LLM provider(xiaodan_agent)把一轮对话 POST 给控制塔,读回 SSE 事件:文字、设备消息、音频文件、结束标记;
  - 控制塔要主动找设备(提醒播报、调用引擎里的插件)时,经引擎内网 HTTP 端口上的「设备桥」接口。
两者都要按会话或设备找到引擎里的连接对象,这张登记表就是干这个的。
"""

import json
import re
import threading
import time
from urllib.parse import urlsplit

_MAC = re.compile(r"^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$")


def normalize_mac(value):
    """统一成小写、冒号分隔;认不出返回 None。"""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not _MAC.match(text):
        return None
    digits = re.sub(r"[^0-9a-f]", "", text)
    return ":".join(digits[i:i + 2] for i in range(0, 12, 2))


class Registry:
    """会话 ID → 连接,MAC → 最新的已核验连接。线程安全(provider 在工作线程里查,桥接口在事件循环里查)。"""

    def __init__(self, is_verified=None):
        self._lock = threading.Lock()
        self._by_session = {}
        self._by_mac = {}
        self._is_verified = is_verified or (lambda conn: True)

    def add(self, conn):
        session_id = getattr(conn, "session_id", None)
        mac = normalize_mac(getattr(conn, "device_id", None))
        with self._lock:
            if session_id:
                self._by_session[session_id] = conn
            if mac:
                self._by_mac[mac] = conn

    def remove(self, conn):
        session_id = getattr(conn, "session_id", None)
        mac = normalize_mac(getattr(conn, "device_id", None))
        with self._lock:
            if session_id and self._by_session.get(session_id) is conn:
                del self._by_session[session_id]
            # 只有索引仍指向这个连接才删:设备重连后,旧连接晚关闭不能把新连接的索引抹掉
            if mac and self._by_mac.get(mac) is conn:
                del self._by_mac[mac]

    def by_session(self, session_id):
        with self._lock:
            return self._by_session.get(session_id)

    def by_mac(self, mac):
        """只返回已通过控制塔身份核验的连接:device-id 请求头谁都能伪造,没核验的连接收不到别人的提醒。"""
        mac = normalize_mac(mac)
        if not mac:
            return None
        with self._lock:
            conn = self._by_mac.get(mac)
        if conn is None:
            return None
        try:
            return conn if self._is_verified(conn) else None
        except Exception:
            return None

    def __len__(self):
        with self._lock:
            return len(self._by_session)


def _qsize(queue_like):
    try:
        return queue_like.qsize()
    except Exception:
        try:
            return len(queue_like)
        except Exception:
            return 0


def busy_reason(conn, now=None):
    """设备此刻是否不宜被主动播报打断。返回原因字符串;空串表示空闲。

    判断依据都来自上游连接对象的真实属性(core/connection.py、sendAudioHandle.py、asr/base.py),
    外加本项目 provider 自己打的标记(_xd_*)。
    """
    now = time.monotonic() if now is None else now
    if getattr(conn, "_xd_turn_active", False):
        return "turn"
    if getattr(conn, "_xd_asr_busy", False):
        return "recognizing"
    last_in = getattr(conn, "_xd_last_audio_in", 0) or 0
    if last_in and now - last_in < 1.5:
        return "listening"
    if getattr(conn, "asr_audio", None):
        return "listening"
    tts = getattr(conn, "tts", None)
    queued = 0
    if tts is not None:
        queued += _qsize(getattr(tts, "tts_text_queue", None))
        queued += _qsize(getattr(tts, "tts_audio_queue", None))
    controller = getattr(conn, "audio_rate_controller", None)
    if controller is not None:
        queued += _qsize(getattr(controller, "queue", None))
    if queued:
        return "speaking"
    if getattr(conn, "client_is_speaking", False):
        # 上游有条路径会让这个标记一直留着(sendAudioHandle 发 stop 时句子已换),队列都空且 30 秒没动静就当它是残留
        last_activity_ms = getattr(conn, "last_activity_time", 0) or 0
        if last_activity_ms and time.time() * 1000 - last_activity_ms > 30_000:
            return ""
        return "speaking"
    return ""


def not_ready_reason(conn):
    stop_event = getattr(conn, "stop_event", None)
    if stop_event is not None and stop_event.is_set():
        return "closing"
    if getattr(conn, "need_bind", False):
        return "unbound"
    bound = getattr(conn, "bind_completed_event", None)
    if bound is not None and not bound.is_set():
        return "initializing"
    if getattr(conn, "tts", None) is None or getattr(conn, "websocket", None) is None:
        return "initializing"
    return ""


class SseParser:
    """逐行喂入 text/event-stream,返回解析出的事件字典列表。注释行(以 ":" 开头,心跳)返回一个 {"t": "hb"}。"""

    def __init__(self):
        self._data = []

    def feed_line(self, line):
        if line is None:
            return []
        if isinstance(line, bytes):
            line = line.decode("utf-8", "replace")
        line = line.rstrip("\r\n")
        if line == "":
            if not self._data:
                return []
            payload = "\n".join(self._data)
            self._data = []
            try:
                event = json.loads(payload)
            except ValueError:
                return [{"t": "invalid", "raw": payload[:200]}]
            return [event] if isinstance(event, dict) else [{"t": "invalid", "raw": payload[:200]}]
        if line.startswith(":"):
            return [{"t": "hb"}]
        if line.startswith("data:"):
            self._data.append(line[5:].lstrip(" "))
        return []

    def finish(self):
        return self.feed_line("") if self._data else []


def same_origin(base_url, other_url):
    """媒体地址必须与控制塔的对话地址同源,防止被诱导去访问内网任意地址。"""
    try:
        a, b = urlsplit(base_url), urlsplit(other_url)
    except ValueError:
        return False
    return bool(a.scheme) and (a.scheme, a.hostname, a.port) == (b.scheme, b.hostname, b.port)


_MEDIA_EXT = {"mp3", "wav", "ogg", "opus", "m4a", "p3"}


def media_extension(value):
    ext = str(value or "").lower().lstrip(".")
    return ext if ext in _MEDIA_EXT else None


def clamp_device_message(message, session_id):
    """设备只收 4096 字节以内的 JSON 文本帧;超长直接拒绝(返回 None),不截断成坏 JSON。"""
    if not isinstance(message, dict) or not isinstance(message.get("type"), str):
        return None
    msg = dict(message)
    msg["session_id"] = session_id
    text = json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
    if len(text.encode("utf-8")) > 4096:
        return None
    return text


FALLBACK_SPEECH = "😔抱歉,我这边出了点问题,稍后再试试吧。"
THINKING_KEEPALIVE_S = 25
