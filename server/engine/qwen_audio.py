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


# ---------------------------------------------------------------- 设备字幕与故事进度

# 设备屏幕一行约 11 个汉字宽。显示单位:ASCII 算 0.5,其余(汉字、全角标点)算 1。
# 一条字幕不超过 40 个单位(设备两页),UTF-8 不超过 150 字节(设备字幕缓冲 192 字节,留出余量)。
SUBTITLE_UNITS = 40
SUBTITLE_BYTES = 150
# 故事进度片段:sentence_start 的文字以这个控制字符开头,新固件把它当作卡片上的正文进度,不当字幕;
# 紧跟 CUE_PARAGRAPH 表示新起一段。上游 send_tts_message 会去掉 \n 和表情,但保留这两个字符。
CUE_MARK = "\x1e"
CUE_PARAGRAPH = "\x1f"

_SENTENCE_BREAK = "。！？!?；;…"
_SOFT_BREAK = "，,、：: "
# 这些字符不该出现在一条字幕的开头,跟前一条走
_NO_LEADING = "，。！？、；：”’）》」』…,.!?;:)"


def display_units(text):
    return sum(0.5 if ord(ch) < 0x80 else 1.0 for ch in text or "")


def _best_cut(part):
    """part 已经放不下下一个字:在它里面找最合适的切点(切点之后的字留给下一条)。返回切点下标。"""
    # 句末标点前面有几个字就切;逗号一类要求前半截至少占三分之一,免得切出很碎的一条
    for charset, minimum in ((_SENTENCE_BREAK, 3), (_SOFT_BREAK, len(part) // 3)):
        cut = max(part.rfind(ch) for ch in charset)
        if cut >= minimum:
            cut += 1
            while cut < len(part) and part[cut] in _NO_LEADING:
                cut += 1
            return cut
    # 没有标点:不从英文单词中间切
    i = len(part)
    while i > 0 and part[i - 1].isascii() and part[i - 1].isalnum():
        i -= 1
    return i if i > 0 else len(part)


def subtitle_parts(text, units=SUBTITLE_UNITS, max_bytes=SUBTITLE_BYTES):
    """把一句要显示的字幕切成几条,每条不超过 units 个显示单位、max_bytes 个 UTF-8 字节。
    优先在句末标点切,其次逗号顿号冒号空格,不切开英文单词;行首标点并到前一条。"""
    text = (text or "").strip()
    parts = []
    current = ""
    for ch in text:
        candidate = current + ch
        if current and (display_units(candidate) > units or len(candidate.encode("utf-8")) > max_bytes):
            if ch in _NO_LEADING and len(candidate.encode("utf-8")) <= max_bytes + 8:
                # 句末标点不单独起一条
                current = candidate
                continue
            cut = _best_cut(current)
            head, tail = current[:cut], current[cut:]
            if head.strip():
                parts.append(head.strip())
            current = tail + ch
        else:
            current = candidate
    if current.strip():
        parts.append(current.strip())
    return parts


class SpeechRate:
    """估计合成语速(显示单位/秒),用来决定一句长字幕的后几条什么时候发。按实际合成时长做指数平均。"""

    def __init__(self, rate=1.0, alpha=0.3):
        try:
            rate = float(rate)
        except (TypeError, ValueError):
            rate = 1.0
        rate = min(2.0, max(0.5, rate if rate == rate else 1.0))
        self.units_per_s = 4.4 * rate
        self.alpha = alpha

    def ms_for(self, units):
        return units / self.units_per_s * 1000.0

    def update(self, units, ms):
        if units < 4 or ms < 500:
            return
        observed = min(12.0, max(2.0, units / (ms / 1000.0)))
        self.units_per_s = (1 - self.alpha) * self.units_per_s + self.alpha * observed


def part_offsets_ms(parts, rate):
    """每条字幕相对这句开头的出现时间:按它前面各条的显示单位折算。"""
    offsets = []
    before = 0.0
    for part in parts:
        offsets.append(rate.ms_for(before))
        before += display_units(part)
    return offsets


class CueSchedule:
    """故事音频播放时按已播帧数吐出到点的正文片段(给新固件的卡片);没有片段可发时照常保活。

    cues:[{"ms": 起始毫秒, "x": 文字, "p": 是否新起一段}],已按 ms 升序;
    marker 为 None 时退回老行为:只按 keepalive_frames 发标题 title。
    """

    def __init__(self, cues=None, frame_ms=60, keepalive_frames=333, marker=CUE_MARK, title="正在播放"):
        self.cues = list(cues or [])
        self.frame_ms = frame_ms
        self.keepalive_frames = max(1, int(keepalive_frames))
        self.marker = marker
        self.title = title
        self.frames = 0
        self.index = 0
        self.last_sent = 0

    def _format(self, cue):
        return f"{self.marker}{CUE_PARAGRAPH if cue.get('p') else ''}{cue['x']}"

    def _due(self, now_ms):
        out = []
        while self.marker is not None and self.index < len(self.cues) and self.cues[self.index]["ms"] <= now_ms:
            out.append(self._format(self.cues[self.index]))
            self.index += 1
        return out

    def initial(self):
        out = self._due(0)
        if out:
            self.last_sent = 0
        return out

    def on_frame(self):
        self.frames += 1
        out = self._due(self.frames * self.frame_ms)
        if out:
            self.last_sent = self.frames
        elif self.frames - self.last_sent >= self.keepalive_frames:
            out = [self.marker if self.marker is not None else self.title]
            self.last_sent = self.frames
        return out
