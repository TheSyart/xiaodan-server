"""千问语音(百炼 Qwen-Audio 3.0)的纯逻辑:地址拼装、请求体、响应解析、分段。只用标准库。

引擎里的两个 provider(core/providers/asr/qwen_audio_asr.py、core/providers/tts/qwen_audio_tts.py)
负责联网与线程,这里只放能脱离引擎单独测试的部分:

    python3 -m unittest discover -s server/tests -v

协议出处(2026-09 百炼文档):
- 识别 qwen-audio-3.0-asr-flash:同步 HTTP,POST {base}/api/v1/services/aigc/multimodal-generation/generation,
  音频放在 input.messages[-1].content[{"type":"input_audio","input_audio":{"data": data URI}}],
  parameters 里 format/sample_rate(字符串)/vocabulary。不支持 OpenAI 兼容方式,裸 PCM 不在格式列表里,须包成 WAV。
- 合成 qwen-audio-3.0-tts-flash:与 CosyVoice 同一套 WebSocket 协议,wss://{host}/api-ws/v1/inference,
  run-task → task-started → continue-task → finish-task → 二进制音频帧 + result-generated → task-finished。
- 两者默认走业务空间域名 {WorkspaceId}.cn-beijing.maas.aliyuncs.com;新模型能否走旧的共享域名文档未写明。
- 情感标签:要念的文字里可以写 [excited]、[laughing] 这类英文方括号标签,控制这一句的情绪或插入声音。
  控制塔按音色下发允许的标签(inline_tags),其余的在这里去掉;字幕里一律去掉。
"""

import base64
import io
import json
import re
import wave

LEGACY_BASE = "https://dashscope.aliyuncs.com"
ASR_MODEL = "qwen-audio-3.0-asr-flash"
TTS_MODEL = "qwen-audio-3.0-tts-flash"
TTS_DEFAULT_VOICE = "longanhuan_v3.6"
# 语气指令按文档计 100 个单位,一个汉字算 2 个
INSTRUCTION_UNITS = 100
# 识别的上下文每轮最多 400 字
ASR_CONTEXT_CHARS = 400
# 单段合成的文字上限。设备上 sentence_start 整条消息不能超过 4096 字节,留足余量
SEGMENT_CHARS = 200

_WORKSPACE_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_SPEAKABLE = re.compile(r"[0-9A-Za-z㐀-鿿豈-﫿]")


# 百炼的情感标签:半角方括号里的小写英文,如 [excited]、[clears throat]
INLINE_TAG = re.compile(r"\[([a-z][a-z ]{0,30})\]")
_SPACES = re.compile(r"[ \t]{2,}")
# 修边时暂时替换完整标签用的占位字符(Unicode 私用区,不是标点也不是表情)
_PLACEHOLDER_BASE = 0xE000
_PLACEHOLDER = re.compile("[\ue000-\uf8ff]")


def speakable(text):
    """去掉情感标签后至少有一个字母、数字或汉字才值得合成。只剩标点、表情或标签时发出去只会浪费一次请求。"""
    return bool(text) and _SPEAKABLE.search(strip_tags(text)) is not None


def parse_allowed_tags(value):
    """控制塔下发的允许标签:列表或逗号分隔的串。"""
    if isinstance(value, str):
        items = value.split(",")
    elif isinstance(value, (list, tuple, set, frozenset)):
        items = list(value)
    else:
        items = []
    return frozenset(str(item).strip() for item in items if str(item).strip())


def filter_tags(text, allowed):
    """只留允许的情感标签。没有允许的标签时全部去掉,模型乱写的也不会被念出来。"""
    return _SPACES.sub(" ", INLINE_TAG.sub(lambda m: m.group(0) if m.group(1) in allowed else "", text or ""))


def strip_tags(text):
    """去掉全部情感标签(字幕用)。"""
    return _SPACES.sub(" ", INLINE_TAG.sub("", text or ""))


def tags_only(text):
    """文字里的标签原样拼起来(一段只剩标签时,留给下一段)。"""
    return "".join(m.group(0) for m in INLINE_TAG.finditer(text or ""))


def trim_segment(text, is_trim_char):
    """按引擎的规则去掉首尾的标点、空白与表情,但保住完整的情感标签。

    引擎切句后用 get_string_no_punctuation_or_emoji 修边,它把 [ 与 ] 也当成要去掉的标点,
    句首的 [excited] 会变成 excited]。这里先把完整标签换成占位字符,修完边再换回来。
    """
    tags = []

    def protect(match):
        if len(tags) >= 0x18FF:
            return match.group(0)
        tags.append(match.group(0))
        return chr(_PLACEHOLDER_BASE + len(tags) - 1)

    chars = list(INLINE_TAG.sub(protect, text or ""))
    start, end = 0, len(chars) - 1
    while start <= end and is_trim_char(chars[start]):
        start += 1
    while end >= start and is_trim_char(chars[end]):
        end -= 1
    trimmed = "".join(chars[start:end + 1])

    def restore(match):
        index = ord(match.group(0)) - _PLACEHOLDER_BASE
        return tags[index] if index < len(tags) else ""

    return _PLACEHOLDER.sub(restore, trimmed)


def http_base(config):
    """HTTP 接口的基地址。显式 base_url 优先,其次业务空间 ID,最后退回旧的共享域名。"""
    base = str(config.get("base_url") or "").strip().rstrip("/")
    if base:
        # 允许有人把 .../api/v1 也填进来
        for suffix in ("/api/v1", "/compatible-mode/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
        return base
    workspace = str(config.get("workspace_id") or "").strip()
    if workspace:
        if not _WORKSPACE_ID.match(workspace):
            raise ValueError("workspace_id 只能是字母、数字与连字符")
        return f"https://{workspace}.cn-beijing.maas.aliyuncs.com"
    return LEGACY_BASE


def ws_url(config):
    explicit = str(config.get("ws_url") or "").strip()
    if explicit:
        return explicit
    base = http_base(config)
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    return f"{base}/api-ws/v1/inference"


def auth_headers(config):
    api_key = str(config.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("千问语音需要配置 api_key")
    headers = {"Authorization": f"Bearer {api_key}"}
    workspace = str(config.get("workspace_id") or "").strip()
    if workspace and not config.get("base_url"):
        headers["X-DashScope-WorkSpace"] = workspace
    return headers


def pcm_to_wav(pcm, sample_rate=16000):
    if len(pcm) % 2:
        pcm = pcm[:-1]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm)
    return buf.getvalue()


def parse_vocabulary(value):
    """热词表。接受 {"词": 权重} 字典,或每行/逗号分隔的 "词" 与 "词|权重" 文本;权重 1-5,默认 4。"""
    result = {}
    if not value:
        return result
    if isinstance(value, dict):
        items = value.items()
    else:
        items = []
        for raw in re.split(r"[\n,，;；]+", str(value)):
            raw = raw.strip()
            if not raw:
                continue
            word, _, weight = raw.partition("|")
            items.append((word.strip(), weight.strip()))
    for word, weight in items:
        word = str(word).strip()
        if not word or len(word) > 20:
            continue
        try:
            weight = int(weight)
        except (TypeError, ValueError):
            weight = 4
        result[word] = min(5, max(1, weight))
        if len(result) >= 500:
            break
    return result


def asr_request_body(wav_bytes, model=ASR_MODEL, vocabulary=None, context=None, language_hints=None):
    audio = {
        "type": "input_audio",
        "input_audio": {"data": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode("ascii")},
    }
    messages = []
    context = (context or "").strip()
    if context:
        # 上一句回复作为助手消息放在前面,帮助识别本轮里的专名与指代
        messages.append({"role": "assistant", "content": [{"type": "text", "text": context[-ASR_CONTEXT_CHARS:]}]})
    messages.append({"role": "user", "content": [audio]})
    parameters = {"format": "wav", "sample_rate": "16000"}
    if vocabulary:
        parameters["vocabulary"] = dict(vocabulary)
    hints = [h for h in (language_hints or []) if isinstance(h, str) and h][:4]
    if hints:
        parameters["language_hints"] = hints
    return {"model": model, "input": {"messages": messages}, "parameters": parameters}


def parse_asr_response(data):
    """取出识别文本。兼容 output.text 与 output.choices[0].message.content[*].text 两种形状。"""
    if not isinstance(data, dict):
        return ""
    output = data.get("output") or {}
    text = output.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    sentence = output.get("sentence")
    if isinstance(sentence, dict) and isinstance(sentence.get("text"), str):
        return sentence["text"].strip()
    choices = output.get("choices") or []
    if choices and isinstance(choices[0], dict):
        content = (choices[0].get("message") or {}).get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            ).strip()
    return ""


def asr_error(data):
    if isinstance(data, dict) and data.get("code"):
        return f"{data.get('code')}: {str(data.get('message') or '')[:200]}"
    return None


def instruction_units(text):
    return sum(2 if ord(ch) > 0x7F else 1 for ch in text)


def clamp_instruction(text):
    text = (text or "").strip()
    out = []
    used = 0
    for ch in text:
        cost = 2 if ord(ch) > 0x7F else 1
        if used + cost > INSTRUCTION_UNITS:
            break
        out.append(ch)
        used += cost
    return "".join(out)


def _number(value, default, low, high, cast=float):
    try:
        number = cast(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return min(high, max(low, number))


def tts_parameters(config, sample_rate):
    """run-task 的 parameters。音色优先用控制台下发的 private_voice。"""
    voice = str(config.get("private_voice") or config.get("voice") or TTS_DEFAULT_VOICE).strip()
    params = {
        "text_type": "PlainText",
        "voice": voice,
        "format": "pcm",
        "sample_rate": int(sample_rate),
        "volume": int(_number(config.get("volume"), 50, 0, 100, int)),
        "rate": round(_number(config.get("rate"), 1.0, 0.5, 2.0), 2),
        "pitch": round(_number(config.get("pitch"), 1.0, 0.5, 2.0), 2),
    }
    instruction = clamp_instruction(config.get("instruction"))
    if instruction:
        params["instruction"] = instruction
    hints = config.get("language_hints")
    if isinstance(hints, str):
        hints = [h.strip() for h in hints.split(",") if h.strip()]
    if isinstance(hints, list) and hints:
        params["language_hints"] = [str(h) for h in hints[:4]]
    return params


def run_task(task_id, model, parameters):
    return json.dumps({
        "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": model,
            "parameters": parameters,
            "input": {},
        },
    }, ensure_ascii=False)


def continue_task(task_id, text):
    return json.dumps({
        "header": {"action": "continue-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {"input": {"text": text}},
    }, ensure_ascii=False)


def finish_task(task_id, cancel=False):
    return json.dumps({
        "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
        "payload": {"input": {"directive": "cancel"} if cancel else {}},
    })


def parse_event(message):
    """解析服务端的文字帧,返回 (event, task_id, error)。无法解析时 event 为 None。"""
    try:
        data = json.loads(message)
    except (TypeError, ValueError):
        return None, None, None
    header = data.get("header") or {}
    event = header.get("event")
    error = None
    if event == "task-failed":
        error = f"{header.get('error_code', 'unknown')}: {str(header.get('error_message') or '')[:200]}"
    return event, header.get("task_id"), error


_SPLIT_AT = "。！？!?；;\n，,、 "


def _inside_tag(text, index):
    """切在 index 之后时会不会劈开一个情感标签:返回那个标签的起点,不会则返回 None。"""
    for match in INLINE_TAG.finditer(text):
        if match.start() <= index < match.end() - 1:
            return match.start()
    return None


def split_segments(text, limit=SEGMENT_CHARS):
    """把过长的文字切成不超过 limit 个字符的段,尽量在标点处切,不劈开情感标签。"""
    text = text or ""
    segments = []
    while len(text) > limit:
        window = text[:limit]
        cut = max(window.rfind(ch) for ch in _SPLIT_AT)
        if cut < limit // 2:
            cut = limit - 1
        tag_start = _inside_tag(text, cut)
        if tag_start is not None and tag_start > 0:
            cut = tag_start - 1
        segments.append(text[: cut + 1])
        text = text[cut + 1:]
    if text:
        segments.append(text)
    return [s for s in segments if s.strip()]


class Keepalive:
    """长音频播放时,每隔 every 帧返回一次 True,调用方借此插一条 sentence_start。

    设备的播放看门狗 60 秒内收不到可识别的 JSON 就收起播放,而文件音频只有二进制帧。
    60 毫秒一帧,333 帧约 20 秒。
    """

    def __init__(self, every=333):
        self.every = max(1, int(every))
        self.count = 0

    def tick(self):
        self.count += 1
        return self.count % self.every == 0
