"""在真实的引擎代码里,把「大脑在控制塔」这条链路跑一遍。CI 冒烟用,discover 不会收它。

    docker exec -i <引擎容器> python - < server/tests/smoke_agent.py

本机起一个假的控制塔(SSE 对话接口 + 音频下载),用引擎自己的 ConnectionHandler 与 chat(),证明:
  - 打过补丁的 connection.py 能导入,provider 能经引擎工厂创建;
  - 文字、设备消息、音频文件按顺序进入合成队列:FIRST → 文字 → 文件 → 文字 → LAST,情绪消息照发;
  - close_after_turn 生效;控制塔没发 done、返回的不是事件流、连不上时都说一句兜底话并正常收尾;
  - 用户打断时两秒内停下并断开对控制塔的请求(控制塔据此取消模型调用);
  - 设备桥接口:不带密钥 401,工具列表只含允许的插件,调插件能推出设备消息,离线设备 404,
    空闲设备能主动播报(先发 tts start,再按 FIRST/文件/文字/LAST 入队),忙时 409;
  - 小单协议 3 级:单词卡组的读音文字留在引擎、发给设备前去掉;故事进度片段随音频登记;
    打过补丁的 textHandle 能收设备上行的 deck_say(直接合成)、忙与过期时回 deck_busy、deck_exit 清缓存。
"""

import asyncio
import http.server
import io
import json
import queue
import socket
import threading
import time
import wave

import httpx
from aiohttp import web

from config.config_loader import load_config
from core import xiaodan_bridge
from core.connection import ConnectionHandler
from core.providers.tts.dto.dto import ContentType, SentenceType
from core.utils import llm as llm_factory

SECRET = "smoke-secret"
MAC = "aa:bb:cc:dd:ee:01"


def wav_bytes(seconds=0.2):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buf.getvalue()


# ---------------------------------------------------------------- 假的控制塔

turn_requests = []
disconnected = threading.Event()
SCENARIO = {"name": "normal"}


class Console(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/xiaodan/media/song/audio":
            if self.headers.get("Authorization") != f"Bearer {SECRET}":
                self.send_response(401)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = wav_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        turn_requests.append((dict(self.headers), body))
        name = SCENARIO["name"]
        if name == "json":
            data = b'{"code":401,"msg":"unauthorized"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()

        def event(obj):
            self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        try:
            if name == "normal":
                event({"t": "text", "v": "🙂好呀,"})
                self.wfile.write(b": hb\n\n")
                event({"t": "device", "msg": {"type": "xiaodan", "cmd": "volume", "value": 40}})
                event({"t": "text", "v": "给你放首歌。"})
                host = self.headers["Host"]
                event({"t": "media", "url": f"http://{host}/xiaodan/media/song/audio", "ext": "wav", "title": "小星星"})
                event({"t": "media", "url": "http://169.254.169.254/evil.wav", "ext": "wav"})
                event({"t": "text", "v": "听完告诉我好不好听。"})
                event({"t": "close_after_turn"})
                event({"t": "done"})
            elif name == "level3":
                event({"t": "text", "v": "🙂我们来学单词。"})
                for i, (w, say) in enumerate((("apple", "apple。苹果。I eat an apple."), ("cat", "cat。猫。I have a cat."))):
                    event({"t": "device", "msg": {"type": "xiaodan_deck", "id": 9, "i": i, "n": 2, "w": w, "m": "…", "say": say}})
                host = self.headers["Host"]
                event({"t": "media", "url": f"http://{host}/xiaodan/media/song/audio", "ext": "wav", "title": "小熊",
                       "cues": [{"ms": 0, "x": "从前", "p": True}, {"ms": 900, "x": "有只小熊"}]})
                event({"t": "done"})
            elif name == "truncated":
                pass
            elif name == "slow":
                for _ in range(100):
                    self.wfile.write(b": hb\n\n")
                    self.wfile.flush()
                    time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError):
            disconnected.set()


httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Console)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
console_url = f"http://127.0.0.1:{httpd.server_address[1]}/xiaodan/agent/turn"


# ---------------------------------------------------------------- 连接对象

loop = asyncio.new_event_loop()
threading.Thread(target=loop.run_forever, daemon=True).start()


class Socket:
    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(json.loads(text))


class TtsStub:
    def __init__(self):
        self.tts_text_queue = queue.Queue()
        self.tts_audio_queue = queue.Queue()
        self.texts = {}
        self.xd_media_titles = {}
        self.xd_media_cues = {}

    def store_tts_text(self, sentence_id, text):
        self.texts[sentence_id] = text

    def tts_one_sentence(self, conn, content_type, content_detail=None, content_file=None, sentence_id=None):
        from core.providers.tts.dto.dto import TTSMessageDTO

        self.tts_text_queue.put(TTSMessageDTO(sentence_id=sentence_id, sentence_type=SentenceType.MIDDLE,
                                              content_type=content_type, content_detail=content_detail))


config = asyncio.run(load_config())


def new_conn(session_id="sess-1"):
    c = ConnectionHandler(config, None, None, None, None, None)
    c.session_id = session_id
    c.device_id = MAC
    c.headers = {"device-id": MAC}
    c.client_ip = "127.0.0.1"
    c.loop = loop
    c.websocket = Socket()
    c.tts = TtsStub()
    c.features = {"xiaodan": True}
    c.intent_type = "nointent"
    c.memory = None
    c.bind_completed_event.set()
    c.llm = llm_factory.create_instance("xiaodan_agent", {
        "type": "xiaodan_agent", "url": console_url, "api_key": "device-token", "media_secret": SECRET, "read_timeout": 5,
    })
    xiaodan_bridge.register(c)
    return c


def drain(q):
    items = []
    while True:
        try:
            items.append(q.get_nowait())
        except queue.Empty:
            return items


# ---------------------------------------------------------------- 1. 正常的一轮

conn = new_conn()
conn.chat("放首歌吧")
time.sleep(0.3)
items = drain(conn.tts.tts_text_queue)
kinds = [(i.sentence_type, i.content_type) for i in items]
assert kinds[0] == (SentenceType.FIRST, ContentType.ACTION), kinds
assert kinds[-1] == (SentenceType.LAST, ContentType.ACTION), kinds
files = [i for i in items if i.content_type == ContentType.FILE]
assert len(files) == 1, f"跨源的音频地址应被忽略,只剩一个文件: {kinds}"
file_index = items.index(files[0])
texts_before = "".join(i.content_detail for i in items[:file_index] if i.content_type == ContentType.TEXT)
texts_after = "".join(i.content_detail for i in items[file_index:] if i.content_type == ContentType.TEXT)
assert texts_before == "🙂好呀,给你放首歌。", texts_before
assert texts_after == "听完告诉我好不好听。", texts_after
assert all(i.sentence_id == items[0].sentence_id for i in items), "整轮的 sentence_id 必须一致"
assert conn.tts.xd_media_titles.get(files[0].content_file) == "小星星"
assert conn.close_after_chat is True
assert conn._xd_turn_active is False
sent = conn.websocket.sent
assert {"type": "xiaodan", "cmd": "volume", "value": 40, "session_id": "sess-1"} in sent, sent
assert any(m.get("type") == "llm" and m.get("emotion") == "happy" for m in sent), f"应按首段文字发情绪: {sent}"
headers, body = turn_requests[-1]
assert headers["Authorization"] == "Bearer device-token"
assert body["session_id"] == "sess-1" and body["device_id"] == MAC and body["query"] == "放首歌吧", body
assert body["turn_id"] == items[0].sentence_id and body["features"] == {"xiaodan": True}
assert body["messages"][-1] == {"role": "user", "content": "放首歌吧"}
assert conn.dialogue.dialogue[-1].content == "🙂好呀,给你放首歌。听完告诉我好不好听。"
print("agent turn ok")

# ---------------------------------------------------------------- 2. 兜底


def spoken_text(c):
    return "".join(i.content_detail or "" for i in drain(c.tts.tts_text_queue) if i.content_type == ContentType.TEXT)


for scenario in ("truncated", "json"):
    SCENARIO["name"] = scenario
    c = new_conn(f"sess-{scenario}")
    c.chat("你好")
    assert "出了点问题" in spoken_text(c), scenario

c = new_conn("sess-down")
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    dead_port = s.getsockname()[1]
c.llm.url = f"http://127.0.0.1:{dead_port}/xiaodan/agent/turn"
c.chat("你好")
assert "出了点问题" in spoken_text(c)
print("agent fallback ok")

# ---------------------------------------------------------------- 3. 打断

SCENARIO["name"] = "slow"
c = new_conn("sess-slow")
threading.Timer(0.6, lambda: setattr(c, "client_abort", True)).start()
start = time.monotonic()
c.chat("讲个很长的故事")
elapsed = time.monotonic() - start
assert elapsed < 3.0, f"打断后应尽快结束,实际 {elapsed:.2f}s"
assert disconnected.wait(3), "打断后应断开对控制塔的请求"
assert c._xd_turn_active is False
print("agent abort ok")

# ---------------------------------------------------------------- 4. 设备桥接口


async def bridge_checks():
    app = web.Application()
    xiaodan_bridge.add_bridge_routes(app, {"manager-api": {"secret": SECRET}})
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}/xiaodan/bridge"
    auth = {"Authorization": f"Bearer {SECRET}"}
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=10) as client:
            assert (await client.get(f"{base}/tools")).status_code == 401
            assert (await client.get(f"{base}/tools", headers={"Authorization": "Bearer wrong"})).status_code == 401
            names = [t["function"]["name"] for t in (await client.get(f"{base}/tools", headers=auth)).json()["tools"]]
            assert {"show_calendar", "get_weather", "set_volume"} <= set(names) and "change_role" not in names, names

            assert (await client.get(f"{base}/devices/aa:bb:cc:dd:ee:99", headers=auth)).json() == {"online": False}
            r = await client.post(f"{base}/devices/aa:bb:cc:dd:ee:99/announce", headers=auth, json={"text": "喝水"})
            assert r.status_code == 404

            device = new_conn("sess-bridge")
            device.client_is_speaking = False
            device.last_activity_time = time.time() * 1000
            info = (await client.get(f"{base}/devices/AA-BB-CC-DD-EE-01", headers=auth)).json()
            assert info["online"] and info["session_id"] == "sess-bridge" and info["busy"] is False, info

            r = await client.post(f"{base}/tool", headers=auth, json={
                "session_id": "sess-bridge", "turn_id": None, "name": "set_volume", "arguments": {"level": 30}, "plugin_config": {},
            })
            assert r.status_code == 200 and r.json()["action"] == "RESPONSE", r.text
            assert {"type": "xiaodan", "cmd": "volume", "value": 30, "session_id": "sess-bridge"} in device.websocket.sent
            r = await client.post(f"{base}/tool", headers=auth, json={"session_id": "sess-bridge", "name": "change_role"})
            assert r.status_code == 404
            r = await client.post(f"{base}/tool", headers=auth, json={"session_id": "gone", "name": "set_volume"})
            assert r.status_code == 410

            device.websocket.sent.clear()
            r = await client.post(f"{base}/devices/{MAC}/announce", headers=auth, json={
                "text": "提醒你:该喝水啦。", "chime": True, "title": "提醒",
                "device_msgs": [{"type": "xiaodan", "cmd": "volume", "value": 50}],
            })
            assert r.status_code == 202, r.text
            assert device.websocket.sent[0]["type"] == "tts" and device.websocket.sent[0]["state"] == "start", device.websocket.sent
            items = drain(device.tts.tts_text_queue)
            kinds = [(i.sentence_type, i.content_type) for i in items]
            assert kinds[0] == (SentenceType.FIRST, ContentType.ACTION) and kinds[-1] == (SentenceType.LAST, ContentType.ACTION), kinds
            assert kinds[1] == (SentenceType.MIDDLE, ContentType.FILE), "提示音在播报文字之前"
            assert "".join(i.content_detail or "" for i in items if i.content_type == ContentType.TEXT) == "提醒你:该喝水啦。"
            assert device.sentence_id == r.json()["sentence_id"]

            # 讲话中 → 409
            r = await client.post(f"{base}/devices/{MAC}/announce", headers=auth, json={"text": "再提醒一次"})
            assert r.status_code == 409 and r.json()["error"] == "busy", r.text

            r = await client.post(f"{base}/devices/{MAC}/send", headers=auth, json={"msg": {"type": "xiaodan", "cmd": "volume", "value": 1}})
            assert r.status_code == 200
    finally:
        await runner.cleanup()


asyncio.run_coroutine_threadsafe(bridge_checks(), loop).result(60)
print("bridge ok")

# ---------------------------------------------------------------- 5. 小单协议 3 级:单词卡组与故事进度

SCENARIO["name"] = "level3"
xiaodan_bridge.REGISTRY.remove(conn)
deck_conn = new_conn("sess-deck")
deck_conn.features = {"xiaodan": 3}
deck_conn.chat("学单词")
decks = [m for m in deck_conn.websocket.sent if m.get("type") == "xiaodan_deck"]
assert len(decks) == 2 and all("say" not in m for m in decks), decks
assert xiaodan_bridge.DECKS.get(MAC, 9, 1) == "cat。猫。I have a cat."
media_items = [i for i in drain(deck_conn.tts.tts_text_queue) if i.content_type == ContentType.FILE]
assert len(media_items) == 1
assert deck_conn.tts.xd_media_cues.get(media_items[0].content_file) == [
    {"ms": 0, "x": "从前", "p": True}, {"ms": 900, "x": "有只小熊", "p": False}], deck_conn.tts.xd_media_cues


async def device_command_checks():
    from core.handle.textHandle import handleTextMessage

    async def say(i, deck=9):
        deck_conn.websocket.sent.clear()
        await handleTextMessage(deck_conn, json.dumps({"type": "xiaodan", "cmd": "deck_say", "id": deck, "i": i}))
        return deck_conn.websocket.sent

    deck_conn.client_is_speaking = False
    deck_conn.last_activity_time = time.time() * 1000
    sent = await say(1)
    assert sent and sent[0]["type"] == "tts" and sent[0]["state"] == "start", sent
    items = drain(deck_conn.tts.tts_text_queue)
    assert [(i.sentence_type, i.content_type) for i in items][0] == (SentenceType.FIRST, ContentType.ACTION)
    assert "".join(i.content_detail or "" for i in items if i.content_type == ContentType.TEXT) == "cat。猫。I have a cat."
    assert (await say(0))[0] == {"type": "xiaodan", "cmd": "deck_busy", "id": 9, "why": "fast", "session_id": "sess-deck"}
    await asyncio.sleep(0.7)
    assert (await say(0, deck=77))[0]["why"] == "gone"
    await asyncio.sleep(0.7)
    deck_conn._xd_turn_active = True
    started = time.monotonic()
    assert (await say(0))[0]["why"] == "turn"
    assert time.monotonic() - started >= 2.5, "对话还在收尾时应先等一会儿"
    deck_conn._xd_turn_active = False
    await asyncio.sleep(0.7)
    deck_conn.tts.tts_audio_queue.put((SentenceType.MIDDLE, b"x", None, "old"))
    sent = await say(0)
    assert sent[0]["state"] == "start" and deck_conn.tts.tts_audio_queue.qsize() == 0, "还在读上一个词时先清掉再读"
    await handleTextMessage(deck_conn, json.dumps({"type": "xiaodan", "cmd": "deck_exit", "id": 9}))
    assert xiaodan_bridge.DECKS.get(MAC, 9, 0) is None
    old = new_conn("sess-old")
    old.websocket.sent.clear()
    await handleTextMessage(old, json.dumps({"type": "xiaodan", "cmd": "deck_say", "id": 9, "i": 0}))
    assert old.websocket.sent == [], "2 级固件的上行 xiaodan 消息不处理"


asyncio.run_coroutine_threadsafe(device_command_checks(), loop).result(60)
print("device commands ok")
httpd.shutdown()
