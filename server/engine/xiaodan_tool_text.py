"""把模型写在正文里的工具调用文本,转换成引擎认识的结构化工具调用。

背景:模型网关背后的模型有时不把工具调用放进 delta.tool_calls,而是当作正文吐出来。生产上见过两种写法:

    DeepSeek 的 DSML 标记
    <｜DSML｜function_calls>
    <｜DSML｜invoke name="get_weather">
    <｜DSML｜parameter name="location" string="true">北京</｜DSML｜parameter>
    </｜DSML｜invoke>
    </｜DSML｜function_calls>

    <tool_call> 标签(里面可能只有函数名,也可能是 JSON 或 函数名(参数))
    <tool_call>get_weather</tool_call>
    <tool_call>{"name": "get_weather", "arguments": {"location": "北京"}}</tool_call>

引擎(core/connection.py 的 chat)只认 delta.tool_calls,以及以 <tool_call> 开头、里面是 {"name","arguments"} JSON 的文本。
其余写法都被当成回复念出来、显示成字幕、写进对话记录,工具一个也没执行;标记在凑齐之前流出的残段还会被送去合成语音。
本模块包在 LLM provider 外面:普通正文原样放行,工具调用块截下来解析成 tool_calls 增量再交给引擎,
引擎后面的合并、执行、上报链路一行不改。

几个必须照顾到的细节:
- 标记可能被切在两个流式分块之间。正文末尾像是标记开头的残段(比如一个 "<｜" 或 "<tool_c")先扣住,确认不是再放行,
  否则半个标记已经送去合成语音了。
- 生产记录里见过双竖线、缺 function_ 前缀的 DSML,DeepSeek V4 外层又叫 tool_calls,所以解析对竖线个数、前缀、
  大小写与空白都宽容;也接受没有外层标签、直接以 invoke 开头的块。
- 开启函数调用后模型常用 direct_answer 虚拟工具直接作答。整块攒完再交会让第一句话晚一整段生成时间,
  所以 DSML 里它的 response 参数边收边交:引擎本来就会从不完整的 JSON 里逐段取出文字送去合成。
  引擎那条流式兜底只还原 \\" \\n \\\\ 三种转义,所以片段里的制表符与回车先换成空格。
- 上游 chat() 用 `"content" in response` 判断元组,正文片段恰好等于 "content" 时会抛异常;拆开再交。
- 解析不出任何调用的块整块丢弃(不念),通过 log 回调记一笔。

只用标准库,兼容引擎的 Python 3.10。单元测试见 server/tests/test_tool_text.py。
"""

import json
import re
import uuid
from types import SimpleNamespace

_I = re.IGNORECASE
_BARS = r"[｜|]+"
_DSML = rf"{_BARS}\s*DSML\s*{_BARS}"
# 开标签的开头 "<｜DSML｜"。后面紧跟 "/" 的是另一种闭标签写法,不算开头。
_OPEN = re.compile(rf"<\s*{_DSML}\s*(?!/)", _I)
_BLOCK_OPEN = re.compile(rf"<\s*{_DSML}\s*[a-z_]*calls\s*>", _I)
# 闭标签两种写法都认:"</｜DSML｜invoke>" 与 "<｜DSML｜/invoke>"
_CLOSE = rf"<\s*(?:/\s*{_DSML}|{_DSML}\s*/)\s*"
_INVOKE_OPEN = re.compile(rf"<\s*{_DSML}\s*invoke\s+name\s*=\s*\"([^\"]*)\"\s*>", _I)
_INVOKE_CLOSE = re.compile(rf"{_CLOSE}invoke\s*>", _I)
_PARAM_OPEN = re.compile(
    rf"<\s*{_DSML}\s*parameter\s+name\s*=\s*\"([^\"]*)\"(?:\s+string\s*=\s*\"(true|false)\")?\s*>", _I
)
_PARAM_CLOSE = re.compile(rf"{_CLOSE}parameter\s*>", _I)
_BLOCK_CLOSE = re.compile(rf"{_CLOSE}[a-z_]*calls\s*>", _I)

_TC_OPEN = re.compile(r"<\s*tool_call\s*>", _I)
_TC_CLOSE = re.compile(r"<\s*/\s*tool_call\s*>", _I)
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]*")
_KWARG = re.compile(r"([A-Za-z_]\w*)\s*[=:]\s*(\"(?:[^\"\\]|\\.)*\"|'[^']*'|[^,]+)")

# 判断"末尾残段是不是某个标签的开头"时,先去掉空白、统一竖线与大小写,再与这些规范写法比前缀。
_OPEN_CANONS = ("<｜DSML｜", "<TOOL_CALL>")
_VALUE_CLOSE_CANONS = ("</｜DSML｜PARAMETER>", "<｜DSML｜/PARAMETER>")
_HOLD_MAX = 40            # 残段超过这个长度就不可能是标签开头
_BLOCK_MAX = 20000        # 迟迟不闭合的块到这个长度就按流结束处理,免得无限攒下去

DIRECT_ANSWER = "direct_answer"


def _canon(text):
    text = re.sub(r"\s+", "", text).replace("|", "｜").upper()
    return re.sub("｜+", "｜", text)


def _partial_tail(text, canons):
    """text 末尾可能是某个标签开头的那一段;不是则返回空串。标签里不会出现 "<",所以只看最后一个 "<" 之后。"""
    at = text.rfind("<")
    if at < 0 or len(text) - at > _HOLD_MAX:
        return ""
    tail = text[at:]
    canon = _canon(tail)
    return tail if any(c.startswith(canon) for c in canons) else ""


def _new_id():
    return "call_" + uuid.uuid4().hex[:24]


def _delta(index, call_id, name, arguments):
    # 引擎的 _merge_tool_calls 只按属性读 index / id / function.name / function.arguments,
    # 并且只在 id、name 非空时才覆盖,所以后续增量把它们留空即可。
    return SimpleNamespace(
        index=index,
        id=call_id,
        type="function" if call_id else None,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _param_value(raw, is_string):
    if is_string is not None and is_string.lower() == "false":
        try:
            return json.loads(raw.strip())
        except ValueError:
            return raw.strip()
    return raw.strip()


def _params(body):
    params = {}
    pos = 0
    while True:
        opened = _PARAM_OPEN.search(body, pos)
        if opened is None:
            return params
        closed = _PARAM_CLOSE.search(body, opened.end())
        if closed is None:
            return params   # 没闭合的参数不可信,不收
        params[opened.group(1)] = _param_value(body[opened.end():closed.start()], opened.group(2))
        pos = closed.end()


def _json_dict(text):
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _kwargs(text):
    """解析 location="北京", days=2 这类参数写法;一个都认不出返回 None。"""
    args = {}
    for match in _KWARG.finditer(text):
        raw = match.group(2).strip()
        if raw[:1] in ("'", '"') and raw[-1:] == raw[:1] and len(raw) >= 2:
            try:
                args[match.group(1)] = json.loads(raw) if raw[0] == '"' else raw[1:-1]
            except ValueError:
                args[match.group(1)] = raw[1:-1]
        else:
            try:
                args[match.group(1)] = json.loads(raw)
            except ValueError:
                args[match.group(1)] = raw
    return args or None


def parse_tool_call_text(body):
    """解析 <tool_call> 标签里的内容,返回 (函数名, 参数字典);认不出返回 (None, None)。

    认得的写法:{"name": ..., "arguments": {...} 或 JSON 字符串};函数名;函数名 {JSON};函数名({JSON});函数名(k="v", ...)。
    """
    text = re.sub(r"^```[a-z]*\s*|\s*```$", "", body.strip(), flags=_I).strip()
    if not text:
        return None, None

    if text.startswith("{"):
        obj = _json_dict(text)
        if obj is None:
            return None, None
        function = obj.get("function") if isinstance(obj.get("function"), dict) else {}
        name = obj.get("name") or function.get("name")
        args = obj.get("arguments", obj.get("parameters", function.get("arguments", {})))
        if isinstance(args, str):
            args = _json_dict(args) if args.strip() else {}
        if not isinstance(name, str) or not _NAME.fullmatch(name.strip()) or not isinstance(args, dict):
            return None, None
        return name.strip(), args

    named = _NAME.match(text)
    if named is None:
        return None, None
    rest = text[named.end():].strip()
    if rest.startswith("(") and rest.endswith(")"):
        rest = rest[1:-1].strip()
    if not rest:
        return named.group(0), {}
    args = _json_dict(rest)
    if args is None:
        args = _kwargs(rest)
    if args is None:
        return None, None
    return named.group(0), args


class DsmlToolCallFilter:
    """流式过滤器。feed 每段正文、流结束时 finish,各自返回要交给引擎的 (content, tool_calls) 列表。

    convert=False 用于不带工具的回复:工具调用块照样截下,但只丢弃并记录,不产出工具调用。
    """

    def __init__(self, log=None, convert=True):
        self._log = log or (lambda message: None)
        self._convert = convert
        self._pending = ""   # 正文模式下扣住的末尾残段
        self._block = None   # 截留中的块;None 表示正文模式
        self._kind = None    # "dsml" 或 "tool_call"
        self._wrapped = False
        self._calls = []     # 当前 DSML 块里每个 invoke 的处理进度
        self._next_index = 0

    def note_structured(self, tool_calls):
        """模型同时给了真正的 tool_calls 时,让出它们占用的序号,免得和转换出来的调用撞在一起。"""
        for call in tool_calls or ():
            index = getattr(call, "index", None)
            if isinstance(index, int):
                self._next_index = max(self._next_index, index + 1)

    def feed(self, content):
        out = []
        if content:
            self._consume(content, out, final=False)
        return out

    def finish(self):
        out = []
        self._consume("", out, final=True)
        return out

    # ------------------------------------------------------------------ 内部

    def _consume(self, text, out, final):
        while True:
            if self._block is None:
                text = self._pending + text
                self._pending = ""
                starts = [(m.start(), kind) for m, kind in ((_OPEN.search(text), "dsml"), (_TC_OPEN.search(text), "tool_call")) if m]
                if not starts:
                    keep = "" if final else _partial_tail(text, _OPEN_CANONS)
                    visible = text[:len(text) - len(keep)]
                    if visible:
                        out.append((visible, None))
                    self._pending = keep
                    return
                start, kind = min(starts)
                if start > 0:
                    out.append((text[:start], None))
                self._block = ""
                self._kind = kind
                self._calls = []
                text = text[start:]

            self._block += text
            text = ""
            final_now = final or len(self._block) > _BLOCK_MAX
            if self._kind == "tool_call":
                rest = self._advance_tool_call(out, final_now)
            else:
                rest = self._advance(out, final_now)
            if rest is None:
                return
            self._block = None
            self._kind = None
            text = rest
            if not text and not final:
                return

    def _advance_tool_call(self, out, final):
        block = self._block
        opened = _TC_OPEN.match(block)
        body_start = opened.end() if opened else 0
        closed = _TC_CLOSE.search(block, body_start)
        if closed is None and not final:
            return None
        body = block[body_start:closed.start() if closed else len(block)]
        name, args = parse_tool_call_text(body)
        if name is None:
            self._log(f"模型输出了无法解析的 <tool_call> 块,已丢弃不念: {block[:200]!r}")
        elif not self._convert:
            self._log(f"不带工具的回复里出现 <tool_call> 调用 {name},已丢弃不念")
        else:
            index = self._next_index
            self._next_index += 1
            out.append((None, [_delta(index, _new_id(), name, json.dumps(args, ensure_ascii=False))]))
            self._log(f"模型以 <tool_call> 文本调用工具 {name},已转换为结构化调用")
        return block[closed.end():] if closed else ""

    def _advance(self, out, final):
        """处理截留中的 DSML 块。块结束时返回块后面剩下的正文(可能为空串),还没结束返回 None。"""
        block = self._block
        self._wrapped = _BLOCK_OPEN.match(block) is not None
        invokes = list(_INVOKE_OPEN.finditer(block))
        last_close_end = 0
        for k, opened in enumerate(invokes):
            if k >= len(self._calls):
                self._calls.append({"name": opened.group(1), "index": None, "sent": 0, "lead": 0, "done": False})
            call = self._calls[k]
            limit = invokes[k + 1].start() if k + 1 < len(invokes) else len(block)
            closed = _INVOKE_CLOSE.search(block, opened.end(), limit)
            if closed is not None:
                last_close_end = closed.end()
            if call["done"]:
                continue
            body = block[opened.end():closed.start() if closed else limit]
            # 后面已经开始下一个 invoke,说明这一个写完了,即使少了闭标签
            finished = closed is not None or k + 1 < len(invokes) or final
            self._handle_invoke(call, body, finished, out)

        end = None   # 块结束的位置:(闭合处起点, 块后正文起点)
        block_closed = _BLOCK_CLOSE.search(block, last_close_end)
        if block_closed is not None:
            end = (block_closed.start(), block_closed.end())
        elif not self._wrapped and invokes and last_close_end:
            # 没有外层标签的块:最后一个 invoke 闭合后紧跟的若是普通文字,块就到此为止
            after = block[last_close_end:].lstrip()
            if after and not after.startswith("<"):
                end = (last_close_end, last_close_end)
        if end is None and not final:
            return None
        if end is None:
            end = (len(block), len(block))

        for k, call in enumerate(self._calls):   # 块结束了,还没交出去的调用按已有内容交掉
            if not call["done"]:
                self._handle_invoke(call, block[invokes[k].end():end[0]], True, out)
        if not self._calls:
            self._log(f"模型输出了无法解析的 DSML 工具调用块,已丢弃不念: {block[:200]!r}")
        return block[end[1]:]

    def _handle_invoke(self, call, body, finished, out):
        if not self._convert:
            if finished:
                call["done"] = True
                self._log(f"不带工具的回复里出现 DSML 工具调用 {call['name']},已丢弃不念")
            return
        if call["name"].strip() == DIRECT_ANSWER:
            self._stream_direct_answer(call, body, finished, out)
        elif finished:
            self._emit_call(call, body, out)

    def _take_index(self, call):
        call["index"] = self._next_index
        self._next_index += 1
        return call["index"]

    def _emit_call(self, call, body, out):
        call["done"] = True
        name = call["name"].strip()
        if not name:
            self._log("DSML 工具调用缺少函数名,已丢弃")
            return
        arguments = json.dumps(_params(body), ensure_ascii=False)
        out.append((None, [_delta(self._take_index(call), _new_id(), name, arguments)]))
        self._log(f"模型以 DSML 文本调用工具 {name},已转换为结构化调用")

    def _stream_direct_answer(self, call, body, finished, out):
        opened = _PARAM_OPEN.search(body)
        while opened is not None and opened.group(1) != "response":
            opened = _PARAM_OPEN.search(body, opened.end())
        if call["index"] is None:
            if opened is None and not finished:
                return   # 还没写到 response 参数,先不出声
            out.append((None, [_delta(self._take_index(call), _new_id(), DIRECT_ANSWER, '{"response": "')]))

        value, value_done = "", finished
        if opened is not None:
            closed = _PARAM_CLOSE.search(body, opened.end())
            value = body[opened.end():closed.start() if closed else len(body)]
            if closed is None:
                # 参数值末尾可能是被切开的闭标签,先扣住;流已结束时残段也不属于回答
                value = value[:len(value) - len(_partial_tail(value, _VALUE_CLOSE_CANONS))]
            else:
                value_done = True
        if call["sent"] == 0:
            call["lead"] = len(value) - len(value.lstrip())
        value = value[call["lead"]:]
        if value_done:
            value = value.rstrip()

        fresh = value[call["sent"]:]
        if fresh:
            fresh = fresh.replace("\t", " ").replace("\r", " ")
            out.append((None, [_delta(call["index"], None, None, json.dumps(fresh, ensure_ascii=False)[1:-1])]))
            call["sent"] = len(value)
        if value_done:
            out.append((None, [_delta(call["index"], None, None, '"}')]))
            call["done"] = True


def _chat_safe(parts):
    for content, tool_calls in parts:
        if content == "content":   # 见模块说明:上游会把它当成字典键去取
            yield "conten", None
            yield "t", None
        else:
            yield content, tool_calls


def wrap_function_stream(inner, log=None):
    """包住 response_with_functions 返回的生成器,产出同样形状的 (content, tool_calls)。"""
    dsml = DsmlToolCallFilter(log=log)
    try:
        for content, tool_calls in inner:
            parts = dsml.feed(content)
            if tool_calls:
                dsml.note_structured(tool_calls)
                parts.append((None, tool_calls))
            # 每个上游分块至少交出一项:引擎在每次迭代里检查用户是否打断,截留期间也不能让它等太久
            yield from _chat_safe(parts or [("", None)])
        yield from _chat_safe(dsml.finish())
    finally:
        close = getattr(inner, "close", None)
        if close is not None:
            close()


def strip_text_stream(inner, log=None):
    """包住不带工具的 response() 生成器:只产出正文,工具调用块丢弃不念。"""
    dsml = DsmlToolCallFilter(log=log, convert=False)
    try:
        for content in inner:
            for text, _ in dsml.feed(content):
                if text:
                    yield text
        for text, _ in dsml.finish():
            if text:
                yield text
    finally:
        close = getattr(inner, "close", None)
        if close is not None:
            close()
