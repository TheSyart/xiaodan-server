"""走 OpenAI 兼容网关的语音接口:地址、请求体与响应解析。

为什么单独一个模块:provider 那两个文件只管联网与线程,凡是能脱离引擎跑的判断都放这里,
好让 server/tests/test_gateway_audio.py 不装引擎就能测(与 qwen_audio.py 同一套路数)。
所以这里【不 import 任何 core.*】。

网关实测下来与标准 OpenAI 的差异(2026-09-21 对 model.shanchen.space 实测):
  - 合成要 `sample_rate` 且必须是【整数】:传字符串 "24000" 或写成 sampleRate/rate 都会被忽略,
    悄悄退回模型默认的 22050。采样率与引擎的 Opus 编码器对不上,听感是音调升高、语速变快,
    而且不报错 —— 所以 parse_rate() 要把返回头里的 rate 读出来核对;
  - 语速用 OpenAI 的 `speed`(实测 0.5 → 音频翻倍),百炼那套 `rate` 不认;
  - `response_format: "pcm"` 返回裸流(audio/L16;rate=…;channels=1),没有 WAV 头,
    正好直接喂 Opus 编码器;qwen3-tts 系目前会悄悄退回 WAV,所以本模块只认 3.0 族;
  - 识别是标准 multipart(file + model),热词用扩展字段 `vocabulary` 传 JSON 字符串。
"""

import json

# 只认这一族:它的 pcm 是真裸流、音色名与控制塔现有的「龙」字辈一致
DEFAULT_TTS_MODEL = "bailian/qwen-audio-3.0-tts-flash"
DEFAULT_ASR_MODEL = "bailian/qwen-audio-3.0-asr-flash"
DEFAULT_VOICE = "longanhuan_v3.6"
DEFAULT_BASE = "https://model.shanchen.space/v1"


def _number(value, default, low, high, cast=float):
    try:
        number = cast(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return min(high, max(low, number))


def api_base(config):
    """规范化成以 /v1 结尾的地址。填了完整端点(…/v1/audio/speech)也认。"""
    base = str(config.get("base_url") or "").strip().rstrip("/")
    if not base:
        return DEFAULT_BASE
    for suffix in ("/audio/speech", "/audio/transcriptions"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.rstrip("/")


def speech_url(config):
    return api_base(config) + "/audio/speech"


def transcription_url(config):
    return api_base(config) + "/audio/transcriptions"


def auth_headers(config):
    key = str(config.get("api_key") or "").strip()
    return {"Authorization": f"Bearer {key}"} if key else {}


def speech_body(config, text, sample_rate, stream=True):
    """合成请求体。音色优先用控制塔下发的 private_voice(智能体选的那个)。"""
    voice = str(config.get("private_voice") or config.get("voice") or DEFAULT_VOICE).strip()
    body = {
        "model": str(config.get("model_name") or DEFAULT_TTS_MODEL),
        "input": text,
        "voice": voice,
        "response_format": "pcm",
        # 必须是整数,见模块头注释
        "sample_rate": int(sample_rate),
        "stream": bool(stream),
    }
    # 控制塔的音色设置里语速叫 rate(0.5-2.0),网关只认 OpenAI 的 speed
    speed = _number(config.get("rate"), 1.0, 0.5, 2.0)
    if abs(speed - 1.0) > 1e-6:
        body["speed"] = round(speed, 2)
    volume = _number(config.get("volume"), 50, 0, 100, int)
    if volume != 50:
        body["volume"] = int(volume)
    pitch = _number(config.get("pitch"), 1.0, 0.5, 2.0)
    if abs(pitch - 1.0) > 1e-6:
        body["pitch"] = round(pitch, 2)
    instruction = str(config.get("instruction") or "").strip()
    if instruction:
        body["instruction"] = instruction
    hints = language_hints(config)
    if hints:
        body["language_hints"] = hints
    return body


def language_hints(config):
    hints = config.get("language_hints") or []
    if isinstance(hints, str):
        hints = [h.strip() for h in hints.split(",") if h.strip()]
    if not isinstance(hints, list):
        return []
    return [str(h) for h in hints[:4]]


def parse_rate(content_type):
    """从 audio/L16;rate=24000;channels=1 里取采样率;取不到返回 None。"""
    if not content_type:
        return None
    for part in str(content_type).split(";"):
        key, _, value = part.strip().partition("=")
        if key.strip().lower() == "rate":
            try:
                return int(value.strip())
            except (TypeError, ValueError):
                return None
    return None


def is_raw_pcm(content_type):
    """真裸流才能直接喂编码器。qwen3-tts 系请求 pcm 会退回 audio/x-wav,要认出来。"""
    return str(content_type or "").split(";")[0].strip().lower() in ("audio/l16", "audio/pcm")


def asr_data(config):
    """识别的 multipart 表单字段(file 之外的部分)。"""
    data = {"model": str(config.get("model_name") or DEFAULT_ASR_MODEL)}
    vocabulary = parse_vocabulary(config.get("vocabulary"))
    if vocabulary:
        # 网关的扩展字段:JSON 字符串,形如 {"小单": 5}
        data["vocabulary"] = json.dumps(vocabulary, ensure_ascii=False)
    hints = language_hints(config)
    if hints:
        data["language"] = hints[0]
    return data


def parse_vocabulary(value):
    """热词:"小单|5, 小丹" → {"小单": 5, "小丹": 4}。已经是 dict 就原样校正。"""
    if isinstance(value, dict):
        out = {}
        for word, weight in value.items():
            word = str(word).strip()
            if word:
                out[word] = int(_number(weight, 4, 1, 5, int))
        return out
    if not isinstance(value, str):
        return {}
    out = {}
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        word, _, weight = item.partition("|")
        word = word.strip()
        if word:
            out[word] = int(_number(weight, 4, 1, 5, int))
    return out


def parse_asr_text(data):
    """标准 Whisper 形状 {"text": "..."};顺带认一下 segments 拼接的变体。"""
    if not isinstance(data, dict):
        return ""
    text = data.get("text")
    if isinstance(text, str):
        return text.strip()
    segments = data.get("segments")
    if isinstance(segments, list):
        parts = [str(s.get("text", "")) for s in segments if isinstance(s, dict)]
        return "".join(parts).strip()
    return ""


def error_message(data, fallback=""):
    """网关的错误体:{"error": {"message": "..."}}。"""
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message:
                return message
        if isinstance(error, str) and error:
            return error
        message = data.get("message")
        if isinstance(message, str) and message:
            return message
    return fallback
