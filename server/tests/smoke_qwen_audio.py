"""在真实的引擎代码里,对着本机假的百炼服务端把千问识别与合成跑一遍。CI 冒烟用,discover 不会收它。

    docker exec -i <引擎容器> python - < server/tests/smoke_qwen_audio.py

证明单元测试证明不了的部分:
  - 两个 provider 能经引擎自己的工厂创建;
  - 合成按 run-task → task-started → continue-task → finish-task 走完,PCM 编成设备收得下的 Opus 帧(每帧 < 400 字节),
    每句先发一条带原文的 sentence_start;
  - 打断时一秒内停下并丢掉连接;服务端失败时不抛异常、不重复念;
  - 修掉了上游 processed_chars 累加的问题(中途插入音频文件后,后面的文字不丢);
  - 长音频文件播放期间每约 20 秒插一条 sentence_start 保活;
  - 识别把 PCM 包成 WAV 放进 data URI,带上热词,能解析返回的文字。
"""

import asyncio
import base64
import http.server
import io
import json
import math
import os
import queue
import struct
import tempfile
import threading
import time
import wave

from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve

from core.providers.asr.base import ASRProviderBase
from core.providers.tts.dto.dto import SentenceType
from core.utils import asr as asr_factory
from core.utils import tts as tts_factory
from core.utils.opus_encoder_utils import OpusEncoderUtils

RATE = 24000


def tone(seconds, rate=RATE):
    n = int(seconds * rate)
    return b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(n))


# ---- 假的百炼合成服务 ----

seen_runs = []


def tts_handler(ws):
    try:
        _tts_session(ws)
    except ConnectionClosed:
        # 打断时客户端直接断开,属预期
        pass


def _tts_session(ws):
    task_id = None
    text = ""
    for message in ws:
        data = json.loads(message)
        header = data["header"]
        if header["action"] == "run-task":
            task_id = header["task_id"]
            seen_runs.append(data["payload"])
            ws.send(json.dumps({"header": {"event": "task-started", "task_id": task_id}}))
        elif header["action"] == "continue-task":
            text = data["payload"]["input"]["text"]
        elif header["action"] == "finish-task":
            if "失败" in text:
                ws.send(json.dumps({"header": {"event": "task-failed", "task_id": task_id,
                                               "error_code": "InvalidParameter", "error_message": "boom"}}))
                continue
            chunks = 40 if "很慢" in text else 3
            for _ in range(chunks):
                ws.send(tone(0.1))
                if chunks > 3:
                    time.sleep(0.1)
            ws.send(json.dumps({"header": {"event": "result-generated", "task_id": task_id}}))
            ws.send(json.dumps({"header": {"event": "task-finished", "task_id": task_id}}))


server = serve(tts_handler, "127.0.0.1", 0)
threading.Thread(target=server.serve_forever, daemon=True).start()
ws_port = server.socket.getsockname()[1]


class Conn:
    def __init__(self):
        self.sample_rate = RATE
        self.client_abort = False
        self.stop_event = threading.Event()
        self.sentence_id = "s1"
        self.audio_format = "opus"


def drain(tts):
    items = []
    while True:
        try:
            items.append(tts.tts_audio_queue.get_nowait())
        except queue.Empty:
            return items


def new_tts(**extra):
    config = {"api_key": "sk-test", "ws_url": f"ws://127.0.0.1:{ws_port}", "voice": "longanhuan_v3.6",
              "instruction": "用温柔的语气", "rate": "1.1"}
    config.update(extra)
    tts = tts_factory.create_instance("qwen_audio_tts", config, True)
    conn = Conn()
    tts.conn = conn
    tts.opus_encoder = OpusEncoderUtils(sample_rate=RATE, channels=1, frame_size_ms=60)
    tts.current_sentence_id = "s1"
    return tts, conn


# 1. 正常合成
tts, conn = new_tts()
tts.to_tts_stream("你好,我是小单。", opus_handler=tts.handle_opus)
items = drain(tts)
assert items[0] == (SentenceType.FIRST, None, "你好,我是小单。", "s1"), items[0]
frames = [item[1] for item in items[1:]]
assert len(frames) >= 5 and all(isinstance(f, bytes) and 0 < len(f) < 400 for f in frames), [len(f) for f in frames]
payload = seen_runs[-1]
assert payload["model"] == "qwen-audio-3.0-tts-flash", payload
params = payload["parameters"]
assert params["sample_rate"] == RATE and params["format"] == "pcm", params
assert params["voice"] == "longanhuan_v3.6" and params["instruction"] == "用温柔的语气" and params["rate"] == 1.1, params

# 连接复用:第二句不重新握手
first_ws = tts._ws
tts.to_tts_stream("第二句。", opus_handler=tts.handle_opus)
assert tts._ws is first_ws, "空闲不久应复用连接"
drain(tts)

# 2. 控制台下发的 private_voice 覆盖默认音色
tts2, _ = new_tts(private_voice="longpaopao_v3.6")
tts2.to_tts_stream("换个音色。", opus_handler=tts2.handle_opus)
assert seen_runs[-1]["parameters"]["voice"] == "longpaopao_v3.6", seen_runs[-1]
drain(tts2)

# 3. 打断:慢速返回途中置 client_abort,应在一秒左右停下并丢掉连接
tts, conn = new_tts()
threading.Timer(0.5, lambda: setattr(conn, "client_abort", True)).start()
start = time.monotonic()
tts.to_tts_stream("这句话会返回得很慢。", opus_handler=tts.handle_opus)
elapsed = time.monotonic() - start
assert elapsed < 2.0, f"打断后应尽快停下,实际 {elapsed:.2f}s"
assert tts._ws is None, "打断后应丢弃连接,免得残留音频串到下一句"
drain(tts)

# 新一轮开始(sentence_id 变了)同样算打断
tts, conn = new_tts()
threading.Timer(0.5, lambda: setattr(conn, "sentence_id", "s2")).start()
start = time.monotonic()
tts.to_tts_stream("这句话会返回得很慢。", opus_handler=tts.handle_opus)
assert time.monotonic() - start < 2.0

# 4. 服务端失败:不抛异常,只重试一次
tts, conn = new_tts()
before = len(seen_runs)
tts.to_tts_stream("这句会失败。", opus_handler=tts.handle_opus)
assert len(seen_runs) - before == 2, f"失败应重试且只重试一次,实际 {len(seen_runs) - before} 次"

# 5. 上游 processed_chars 的问题:中途插入音频文件后,后面的文字不能丢
tts, conn = new_tts()
tts.tts_text_buff = ["你好。", "我在听歌"]
tts.processed_chars = 3
assert tts._process_remaining_text_stream(opus_handler=tts.handle_opus)
assert tts.processed_chars == len("你好。我在听歌")
spoken = [item[2] for item in drain(tts) if item[0] == SentenceType.FIRST]
assert spoken == ["我在听歌"], spoken
tts.tts_text_buff.append("。然后继续")
assert tts._process_remaining_text_stream(opus_handler=tts.handle_opus)
spoken = [item[2] for item in drain(tts) if item[0] == SentenceType.FIRST]
assert spoken == ["然后继续"], f"插入文件后的文字被跳过了: {spoken}"

# 6. 长音频文件:约每 20 秒插一条 sentence_start
fd, path = tempfile.mkstemp(suffix=".wav")
os.close(fd)
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(b"\x00\x00" * 16000 * 45)
tts, conn = new_tts()
tts.xd_media_titles[path] = "小星星"
tts._process_audio_file_stream(path, callback=tts.handle_opus)
items = drain(tts)
keepalives = [item for item in items if item[0] == SentenceType.FIRST]
audio = [item for item in items if item[0] == SentenceType.MIDDLE]
assert len(audio) >= 740, len(audio)
assert [k[2] for k in keepalives] == ["小星星", "小星星"], keepalives
assert all(k[3] == "s1" for k in keepalives)
assert os.path.exists(path), "临时目录之外的文件不该被删"
os.remove(path)

asyncio.run(tts.close())
server.shutdown()
print("qwen tts ok")


# ---- 假的百炼识别服务 ----

asr_requests = []


class AsrHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        asr_requests.append((self.path, dict(self.headers), body))
        reply = {"output": {"choices": [{"message": {"content": [{"text": "今天天气怎么样"}]}}]}}
        if self.headers["Authorization"] == "Bearer sk-bad":
            reply = {"code": "InvalidApiKey", "message": "bad key"}
            self.send_response(401)
        else:
            self.send_response(200)
        data = json.dumps(reply).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), AsrHandler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{httpd.server_address[1]}"

asr = asr_factory.create_instance("qwen_audio_asr", {"api_key": "sk-test", "base_url": base, "vocabulary": "小单|5"}, True)
pcm = tone(0.5, 16000)
artifacts = ASRProviderBase.AudioArtifacts(pcm_frames=[pcm], pcm_bytes=pcm, file_path=None, temp_path=None)


async def recognise():
    try:
        return await asr.speech_to_text([pcm], "sid", artifacts)
    finally:
        await asr.close()


text, _ = asyncio.run(recognise())
assert text == "今天天气怎么样", text
path_seen, headers, body = asr_requests[-1]
assert path_seen == "/api/v1/services/aigc/multimodal-generation/generation", path_seen
assert headers["Authorization"] == "Bearer sk-test"
assert body["model"] == "qwen-audio-3.0-asr-flash" and body["parameters"]["vocabulary"] == {"小单": 5}, body["parameters"]
wav = base64.b64decode(body["input"]["messages"][-1]["content"][0]["input_audio"]["data"].split(",", 1)[1])
with wave.open(io.BytesIO(wav)) as w:
    assert (w.getframerate(), w.getnchannels(), w.getnframes()) == (16000, 1, 8000)

# 空音频不发请求
count = len(asr_requests)
text, _ = asyncio.run(asr.speech_to_text([], "sid", None))
assert text == "" and len(asr_requests) == count

# 服务端报错:provider 返回空文本,不抛异常
asr2 = asr_factory.create_instance("qwen_audio_asr", {"api_key": "sk-bad", "base_url": base}, True)


async def recognise_bad():
    try:
        return await asr2.speech_to_text([pcm], "sid", artifacts)
    finally:
        await asr2.close()


text, _ = asyncio.run(recognise_bad())
assert text == "", text

httpd.shutdown()
print("qwen asr ok")
