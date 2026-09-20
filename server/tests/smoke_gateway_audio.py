"""网关语音 provider 的冒烟测试:在镜像里对着一个假网关跑一遍。

    docker exec -i <引擎容器> python - < server/tests/smoke_gateway_audio.py

纯逻辑部分在 server/tests/test_gateway_audio.py 里用标准库测过了,这里要证明的是另外几件事:
  - 两个 provider 能被引擎自己的工厂按 type 名加载(即 Dockerfile 的 COPY 路径没错);
  - 继承链是通的 —— 切句、字幕、打断这些都在父类里,子类只换了传输层;
  - 发出去的请求体确实是网关要的形状(尤其 sample_rate 必须是整数);
  - 识别继承下来的设备桥钩子还在。

文件名不以 test_ 开头,discover 不会收它。
"""

import json
import queue
import threading
import wave
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from core.utils import opus_encoder_utils  # noqa: F401  确认依赖在
from core.utils.opus_encoder_utils import OpusEncoderUtils
from core.utils.tts import create_instance as tts_factory
from core.utils.asr import create_instance as asr_factory

RATE = 24000
failures = []


def check(cond, message):
    if not cond:
        failures.append(message)
        print("FAIL", message)


# ---------------------------------------------------------------- 假网关

seen = {"speech": [], "asr": []}


def pcm_chunks(seconds=0.6, chunk_ms=60):
    """一段静音 PCM,按块吐,模拟边合成边发。"""
    per = int(RATE * chunk_ms / 1000) * 2
    total = int(RATE * seconds) * 2
    return [b"\x00" * per for _ in range(max(1, total // per))]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _read_body(self):
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def do_POST(self):
        if self.path.endswith("/audio/speech"):
            body = json.loads(self._read_body() or b"{}")
            seen["speech"].append(body)
            text = str(body.get("input", ""))
            if "失败" in text:
                payload = json.dumps({"error": {"message": "假网关故意失败"}}).encode()
                self.send_response(400)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            # 「退回WAV」这段模拟 qwen3-tts 系请求 pcm 却给 WAV 的行为
            wav_mode = "退回WAV" in text
            rate = 22050 if "错采样率" in text else int(body.get("sample_rate") or RATE)
            self.send_response(200)
            if wav_mode:
                self.send_header("content-type", "audio/x-wav")
            else:
                self.send_header("content-type", f"audio/L16;rate={rate};channels=1")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            for chunk in pcm_chunks():
                self.wfile.write(hex(len(chunk))[2:].encode() + b"\r\n" + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            return
        if self.path.endswith("/audio/transcriptions"):
            raw = self._read_body()
            seen["asr"].append({"headers": dict(self.headers), "body": raw})
            payload = json.dumps({"text": "小单你好"}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
base = f"http://127.0.0.1:{server.server_port}/v1"
threading.Thread(target=server.serve_forever, daemon=True).start()


# ---------------------------------------------------------------- 合成

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
    config = {"api_key": "sk-test", "base_url": base, "voice": "longanhuan_v3.6",
              "model_name": "bailian/qwen-audio-3.0-tts-flash", "rate": "1.1"}
    config.update(extra)
    tts = tts_factory.create_instance("gateway_tts", config, True)
    conn = Conn()
    tts.conn = conn
    tts.opus_encoder = OpusEncoderUtils(sample_rate=RATE, channels=1, frame_size_ms=60)
    tts.current_sentence_id = "s1"
    return tts, conn


# 1. 正常合成:出 Opus 帧,请求体形状正确
seen["speech"].clear()
tts, conn = new_tts()
tts.to_tts_stream("你好,我是小单。", opus_handler=tts.handle_opus)
frames = [i for i in drain(tts) if isinstance(getattr(i, "audios", None), (bytes, bytearray))]
check(len(frames) > 0, "正常合成应该产出 Opus 帧")
check(all(len(f.audios) < 400 for f in frames), "Opus 帧不该超过 400 字节")
check(len(seen["speech"]) >= 1, "应该发出了合成请求")
body = seen["speech"][0]
check(isinstance(body.get("sample_rate"), int), f"sample_rate 必须是整数,实际 {type(body.get('sample_rate'))}")
check(body.get("sample_rate") == RATE, f"sample_rate 应与编码器一致 {RATE},实际 {body.get('sample_rate')}")
check(body.get("response_format") == "pcm", "要请求裸 PCM")
check(body.get("stream") is True, "要走流式")
check(body.get("voice") == "longanhuan_v3.6", f"音色不对:{body.get('voice')}")
check(abs(float(body.get("speed", 1)) - 1.1) < 1e-6, f"语速 rate 应映射成 speed,实际 {body.get('speed')}")
print("合成 ok")

# 2. 控制塔下发的 private_voice 要盖过配置里的 voice
seen["speech"].clear()
tts, conn = new_tts(private_voice="longpaopao_v3.6")
tts.to_tts_stream("换个音色。", opus_handler=tts.handle_opus)
check(seen["speech"][0].get("voice") == "longpaopao_v3.6", "private_voice 应该优先")
print("音色覆盖 ok")

# 3. 切句:父类按标点切,应该是多次请求而不是一整段
seen["speech"].clear()
tts, conn = new_tts()
tts.to_tts_stream("第一句话。第二句话。第三句话。", opus_handler=tts.handle_opus)
check(len(seen["speech"]) >= 2, f"长文本应该切成多次请求,实际 {len(seen['speech'])} 次")
print("切句 ok")

# 4. 打断:标记 abort 之后不该再发新请求
seen["speech"].clear()
tts, conn = new_tts()
conn.client_abort = True
tts.to_tts_stream("这段不该被合成。", opus_handler=tts.handle_opus)
check(len(seen["speech"]) == 0, f"打断后不该再请求,实际 {len(seen['speech'])} 次")
print("打断 ok")

# 5. 服务端报错:不抛到外面,基类自己吞掉
seen["speech"].clear()
tts, conn = new_tts()
try:
    tts.to_tts_stream("这句会失败。", opus_handler=tts.handle_opus)
    print("服务端报错 ok")
except Exception as e:
    failures.append(f"服务端报错不该抛出来: {type(e).__name__}: {e}")
    print("FAIL 服务端报错抛出来了", e)

# 6. 采样率对不上 / 退回 WAV:只警告,不静默出怪声音
for text, label in (("错采样率的一段话。", "采样率不符"), ("退回WAV的一段话。", "退回 WAV")):
    tts, conn = new_tts()
    tts._rate_warned = False
    tts.to_tts_stream(text, opus_handler=tts.handle_opus)
    check(tts._rate_warned, f"{label} 应该被发现并警告")
print("采样率与格式核对 ok")


# ---------------------------------------------------------------- 识别

def wav_bytes(seconds=0.5, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00" * int(rate * seconds) * 2)
    return buf.getvalue()


class Artifacts:
    def __init__(self, pcm):
        self.pcm_bytes = pcm
        self.pcm_frames = []
        self.file_path = None
        self.temp_path = None


import asyncio  # noqa: E402

seen["asr"].clear()
asr = asr_factory.create_instance(
    "gateway_asr",
    {"api_key": "sk-test", "base_url": base, "model_name": "bailian/qwen-audio-3.0-asr-flash",
     "vocabulary": "小单|5", "output_dir": "tmp/"},
    True,
)
text, path = asyncio.run(asr.speech_to_text([], "sess", Artifacts(b"\x00" * 16000 * 2)))
check(text == "小单你好", f"识别结果不对:{text!r}")
check(len(seen["asr"]) == 1, "应该发出了识别请求")
raw = seen["asr"][0]["body"]
headers = seen["asr"][0]["headers"]
check("multipart/form-data" in (headers.get("content-type") or ""), "识别要用 multipart")
check(b"bailian/qwen-audio-3.0-asr-flash" in raw, "请求里要带模型名")
check("小单".encode() in raw and b"vocabulary" in raw, "请求里要带热词")
check(b"RIFF" in raw[:2000] or b"RIFF" in raw, "上传的应该是 WAV 文件")
check(headers.get("authorization") == "Bearer sk-test", "要带 Bearer 鉴权")
print("识别 ok")

# 空音频不该发请求
seen["asr"].clear()
text, _ = asyncio.run(asr.speech_to_text([], "sess", Artifacts(b"")))
check(text == "" and not seen["asr"], "空音频不该发请求")
print("空音频 ok")

# 继承下来的设备桥钩子还在(主动播报靠它判断用户是不是正在说话)
check(hasattr(asr, "receive_audio") and hasattr(asr, "handle_voice_stop"), "设备桥钩子丢了")
print("设备桥钩子 ok")

server.shutdown()
if failures:
    print(f"\nsmoke_gateway_audio: {len(failures)} FAILED")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print("\nsmoke_gateway_audio: OK")
