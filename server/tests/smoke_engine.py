"""在真实的引擎镜像里验证 DSML 文本工具调用的转换。CI 冒烟用,不属于单元测试(文件名不以 test 开头,discover 不会收它)。

    docker exec -i <引擎容器> python - < server/tests/smoke_engine.py

证明单元测试证明不了的那部分:镜像里的 openai provider 确实打上了包装;真实的 LLMProvider 在引擎的
Python 3.10 上把分块到来的 DSML 转成工具调用,经引擎自己的 _merge_tool_calls 合并后名字与参数正确;
direct_answer 的文字能被引擎的 _extract_direct_answer_response 取出;不带工具的 response 删掉了 DSML 块;<tool_call> 标签同样转成工具调用;语音合成对没有可朗读文字的片段给静音。
模型客户端换成假的,不发任何网络请求。
"""

import json
from types import SimpleNamespace

from core.connection import ConnectionHandler
from core.providers.llm.openai.openai import LLMProvider

assert getattr(LLMProvider.response_with_functions, "xiaodan_dsml", False), "response_with_functions 没有被包装"
assert getattr(LLMProvider.response, "xiaodan_dsml", False), "response 没有被包装"

WEATHER = (
    "<｜DSML｜function_calls>\n"
    '<｜DSML｜invoke name="get_weather">\n'
    '<｜DSML｜parameter name="location" string="true">北京</｜DSML｜parameter>\n'
    "</｜DSML｜invoke>\n"
    "</｜DSML｜function_calls>"
)
ANSWER = "😊你好呀,我是小单。"
DIRECT = (
    "<｜DSML｜function_calls>\n"
    '<｜DSML｜invoke name="direct_answer">\n'
    f'<｜DSML｜parameter name="response" string="true">{ANSWER}</｜DSML｜parameter>\n'
    "</｜DSML｜invoke>\n"
    "</｜DSML｜function_calls>"
)


class FakeStream:
    def __init__(self, text):
        self.pieces = [text[i:i + 3] for i in range(0, len(text), 3)]
        self.closed = False

    def __iter__(self):
        for piece in self.pieces:
            delta = SimpleNamespace(content=piece, tool_calls=None)
            yield SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=None)

    def close(self):
        self.closed = True


class FakeCompletions:
    def __init__(self):
        self.text = ""
        self.streams = []

    def create(self, **params):
        stream = FakeStream(self.text)
        self.streams.append(stream)
        return stream


provider = LLMProvider({"model_name": "smoke", "api_key": "smoke-not-a-real-key", "base_url": "http://127.0.0.1:9/v1"})
completions = FakeCompletions()
provider.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
dialogue = [{"role": "user", "content": "今天天气怎么样"}]


def call_with_functions(text, functions=None):
    completions.text = text
    spoken, calls = [], []
    for content, tool_calls in provider.response_with_functions("smoke", dialogue, functions=functions or []):
        if content:
            spoken.append(content)
        if tool_calls:
            ConnectionHandler._merge_tool_calls(None, calls, tool_calls)
    assert completions.streams[-1].closed, "上游流没有被关闭"
    return "".join(spoken), calls


spoken, calls = call_with_functions("好的。" + WEATHER)
assert spoken == "好的。", spoken
assert [call["name"] for call in calls] == ["get_weather"], calls
assert json.loads(calls[0]["arguments"]) == {"location": "北京"}, calls
assert calls[0]["id"], "工具调用 id 不能为空"

spoken, calls = call_with_functions(DIRECT)
assert spoken == "" and [call["name"] for call in calls] == ["direct_answer"], (spoken, calls)
assert ConnectionHandler._extract_direct_answer_response(calls[0]["arguments"]) == ANSWER, calls

spoken, calls = call_with_functions("<tool_call>get_weather</tool_call>")
assert spoken == "" and [call["name"] for call in calls] == ["get_weather"], (spoken, calls)
assert json.loads(calls[0]["arguments"]) == {}, calls

weather_only = [{"type": "function", "function": {"name": "get_weather", "parameters": {}}}]
spoken, calls = call_with_functions("<tool_calls><tool_calls><tool_name>get_weather</tool_name></tool_calls></tool_calls>", weather_only)
assert spoken == "" and [call["name"] for call in calls] == ["get_weather"], (spoken, calls)
spoken, calls = call_with_functions("<tool_call>get_time</tool_call>", weather_only)
assert calls == [], "本轮没有提供的工具应被丢弃"

from core.providers.tts.gateway_omni_tts import speakable  # noqa: E402

assert not speakable("") and not speakable("<> ,。!\n") and speakable("今天") and speakable("27"), "可朗读判断不对"

completions.text = "前面" + WEATHER + "后面"
plain = "".join(provider.response("smoke", dialogue))
assert plain == "前面后面", plain

print("tool-call text ok")
