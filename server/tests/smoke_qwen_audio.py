"""在真实的引擎代码里,对着本机假的百炼服务端把千问识别与合成跑一遍。CI 冒烟用,discover 不会收它。

    docker exec -i <引擎容器> python - < server/tests/smoke_qwen_audio.py

证明单元测试证明不了的部分:
  - 两个 provider 能经引擎自己的工厂创建;
  - 合成按 run-task → task-started → continue-task → finish-task 走完,PCM 编成设备收得下的 Opus 帧(每帧 < 400 字节),
    每句先发一条带原文的 sentence_start;
  - 打断时一秒内停下并丢掉连接;服务端失败时不抛异常、不重复念;
  - 修掉了上游 processed_chars 累加的问题(中途插入音频文件后,后面的文字不丢);
  - 长音频文件播放期间每约 20 秒插一条 sentence_start 保活;3 级固件改发故事进度片段与保活标记;
  - 长句的字幕切成几条,按合成出的音频时长插在音频帧之间;
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
seen_texts = []


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
            seen_texts.append(text)
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

# 5b. 情感标签:允许的标签留在要念的文字里,字幕去掉;不允许的去掉;只剩标签的一段留给下一段;句首标签不被修边剥坏
tts, conn = new_tts(inline_tags=["excited", "laughing"])
tts.tts_text_buff = ["[excited]你好呀！[sad]今天真好"]
tts.processed_chars = 0
segment = tts._get_segment_text()
assert segment == "[excited]你好呀", segment
tts.to_tts_stream(segment, opus_handler=tts.handle_opus)
items = drain(tts)
assert items[0][2] == "你好呀", f"字幕应去掉标签: {items[0]}"
assert seen_texts[-1] == "[excited]你好呀", f"要念的文字应保留允许的标签: {seen_texts[-1]}"

tts.tts_stop_request = True
assert tts._process_remaining_text_stream(opus_handler=tts.handle_opus)
items = drain(tts)
assert [item[2] for item in items if item[0] == SentenceType.FIRST] == ["今天真好"], items
assert seen_texts[-1] == "今天真好", f"不允许的 [sad] 应去掉: {seen_texts[-1]}"
tts.tts_text_buff.append("[laughing]")
before = len(seen_runs)
tts._process_remaining_text_stream(opus_handler=tts.handle_opus)
assert len(seen_runs) == before, "只剩标签的一段不该发合成任务"
assert tts._carry_tags == "[laughing]", tts._carry_tags
tts.to_tts_stream("还有一句。", opus_handler=tts.handle_opus)
assert tts._carry_tags == "" and [item[2] for item in drain(tts) if item[0] == SentenceType.FIRST] == ["还有一句。"]
assert seen_texts[-1] == "[laughing]还有一句。", seen_texts[-1]
tts3, _ = new_tts()
tts3.to_tts_stream("[excited]没有允许的标签。", opus_handler=tts3.handle_opus)
assert [item[2] for item in drain(tts3) if item[0] == SentenceType.FIRST] == ["没有允许的标签。"]
assert seen_texts[-1] == "没有允许的标签。", seen_texts[-1]

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

# 6b. 小单协议 3 级:故事按帧插正文进度片段(U+001E 开头,U+001F 表示新起一段),没有片段时只发保活标记
from core.utils import textUtils

tts, conn = new_tts()
conn.features = {"xiaodan": 3}
tts.xd_media_titles[path] = "小星星"
tts.xd_media_cues[path] = [{"ms": 0, "x": "从前", "p": True}, {"ms": 1200, "x": "有座山"}]
tts._process_audio_file_stream(path, callback=tts.handle_opus)
items = drain(tts)
firsts = [(index, item[2]) for index, item in enumerate(items) if item[0] == SentenceType.FIRST]
assert firsts[0] == (0, "\x1e\x1f从前"), firsts[:3]
assert firsts[1][1] == "\x1e有座山" and sum(1 for item in items[:firsts[1][0]] if item[0] == SentenceType.MIDDLE) == 20, firsts[:3]
assert [text for _, text in firsts[2:]] == ["\x1e", "\x1e"], firsts
assert textUtils.check_emoji("\x1e\x1f从前") == "\x1e\x1f从前", "上游字幕清洗不能去掉进度标记"
tts, conn = new_tts()
conn.features = {"xiaodan": 3}
tts._process_audio_file_stream(path, callback=tts.handle_opus)
assert [item[2] for item in drain(tts) if item[0] == SentenceType.FIRST] == ["\x1e", "\x1e"], "音乐只发保活标记"
os.remove(path)

# 7. 长句字幕:显示用的文字切成几条,第一条随句首,其余插在音频帧之间;合成的仍是整句
tts, conn = new_tts(rate="2")
long_text = "很慢的一句话,小朋友们大家好,今天我要给你们讲一个关于月亮上的小邮差的故事,他每天晚上都骑着一只会发光的萤火虫。"
tts.to_tts_stream(long_text, opus_handler=tts.handle_opus)
assert seen_texts[-1] == long_text, seen_texts[-1]
items = drain(tts)
firsts = [(index, item[2]) for index, item in enumerate(items) if item[0] == SentenceType.FIRST]
assert len(firsts) >= 2 and firsts[0][0] == 0, firsts
assert "".join(text for _, text in firsts) == long_text, firsts
assert all(len(text.encode("utf-8")) <= 160 for _, text in firsts), firsts
assert 0 < firsts[1][0] < len(items) - 1, f"后几条字幕应插在音频帧之间: {firsts}"
assert firsts[0][1].report == long_text and all(text.report is None for _, text in firsts[1:]), "只有第一条带整句去记录"

# 7b. 音频线程:字幕的后续几条、故事进度片段与保活照发给设备,但对话记录按整句只记一条
import core.handle.reportHandle as report_handle
import core.handle.sendAudioHandle as send_handle
from core.utils import qwen_audio as qa_mod

reported, sent = [], []
real_report, real_send = report_handle.enqueue_tts_report, send_handle.sendAudioMessage


async def fake_send(conn_, sentence_type, audios, text, sentence_id=None):
    sent.append((sentence_type, text))


report_handle.enqueue_tts_report = lambda conn_, text, audio: reported.append((text, len(audio)))
send_handle.sendAudioMessage = fake_send
loop = asyncio.new_event_loop()
loop_thread = threading.Thread(target=loop.run_forever, daemon=True)
loop_thread.start()
tts, conn = new_tts()
conn.loop = loop
conn.max_output_size = 0
conn.headers = {}
for item in items:
    tts.tts_audio_queue.put(item)
tts.tts_audio_queue.put((SentenceType.FIRST, None, qa_mod.ScreenText("\x1e从前"), "s1"))
tts.tts_audio_queue.put((SentenceType.FIRST, None, "下一句。", "s1"))
tts.tts_audio_queue.put((SentenceType.LAST, [], None, "s1"))
worker = threading.Thread(target=tts._audio_play_priority_thread, daemon=True)
worker.start()
deadline = time.monotonic() + 5
while not tts.tts_audio_queue.empty() and time.monotonic() < deadline:
    time.sleep(0.02)
time.sleep(0.2)
conn.stop_event.set()
worker.join(2)
loop.call_soon_threadsafe(loop.stop)
report_handle.enqueue_tts_report, send_handle.sendAudioMessage = real_report, real_send
assert len(sent) == len(items) + 3, (len(sent), len(items))
assert [text for text, _ in reported] == [long_text, "下一句。"], reported
assert reported[0][1] == sum(1 for item in items if isinstance(item[1], bytes)), "整句的音频都算在第一条记录里"

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
