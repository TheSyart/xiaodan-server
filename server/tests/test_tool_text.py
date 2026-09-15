"""xiaodan_tool_text 的单元测试。只用标准库,不需要引擎:

    python3 -m unittest discover -s server/tests -v

合并与提取两个辅助函数照抄上游 core/connection.py(c7b126c)的 _merge_tool_calls 与
_extract_direct_answer_response:转换出来的增量必须经过引擎自己的规则还能拼回正确的调用。
镜像里用真实引擎再跑一遍的冒烟见 server/tests/smoke_engine.py。
"""

import json
import os
import random
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

import xiaodan_tool_text as tt  # noqa: E402


def merge_tool_calls(tool_calls_list, tools_call):
    for tool_call in tools_call:
        tool_index = getattr(tool_call, "index", None)
        if tool_index is None:
            if tool_call.function.name:
                tool_index = len(tool_calls_list)
            else:
                tool_index = len(tool_calls_list) - 1 if tool_calls_list else 0
        if tool_index >= len(tool_calls_list):
            tool_calls_list.append({"id": "", "name": "", "arguments": ""})
        if tool_call.id:
            tool_calls_list[tool_index]["id"] = tool_call.id
        if tool_call.function.name:
            tool_calls_list[tool_index]["name"] = tool_call.function.name
        if tool_call.function.arguments:
            tool_calls_list[tool_index]["arguments"] += tool_call.function.arguments


def extract_direct_answer(arguments_str):
    if not arguments_str:
        return ""
    try:
        data = json.loads(arguments_str)
        if isinstance(data, dict) and "response" in data:
            return data["response"]
    except (json.JSONDecodeError, TypeError):
        pass
    marker = '"response": "'
    idx = arguments_str.find(marker)
    if idx < 0:
        marker = '"response":"'
        idx = arguments_str.find(marker)
    if idx < 0:
        return ""
    raw = arguments_str[idx + len(marker):]
    if raw.endswith('"}'):
        raw = raw[:-2]
    elif raw.endswith('"'):
        raw = raw[:-1]
    return raw.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")


def run(chunks, structured=None):
    """把分块喂进 wrap_function_stream,按引擎的方式合并。返回 (正文, 工具调用, 全部产出, 日志)。"""
    logs = []
    source = [(chunk, None) for chunk in chunks]
    if structured:
        source.insert(0, (None, structured))
    items = list(tt.wrap_function_stream(iter(source), log=logs.append))
    text = "".join(content for content, _ in items if content)
    calls = []
    for _, tool_calls in items:
        if tool_calls:
            merge_tool_calls(calls, tool_calls)
    return text, calls, items, logs


def chunkings(text, seeds=range(12)):
    yield [text]
    yield list(text)
    for seed in seeds:
        rnd = random.Random(seed)
        pieces, at = [], 0
        while at < len(text):
            size = rnd.randint(1, 7)
            pieces.append(text[at:at + size])
            at += size
        yield pieces


def block(*invokes, open_tag="<｜DSML｜function_calls>", close_tag="</｜DSML｜function_calls>"):
    return open_tag + "\n" + "\n".join(invokes) + "\n" + close_tag


def invoke(name, *params, close="</｜DSML｜invoke>"):
    return f'<｜DSML｜invoke name="{name}">\n' + "\n".join(params) + ("\n" if params else "") + close


def param(name, value, string="true", close="</｜DSML｜parameter>"):
    attr = f' string="{string}"' if string is not None else ""
    return f'<｜DSML｜parameter name="{name}"{attr}>{value}{close}'


WEATHER = block(invoke("get_weather", param("location", "北京")))
ANSWER = "😊你好呀,我是小单。\n有什么想聊的?"
DIRECT = block(invoke("direct_answer", param("response", ANSWER)))


class PlainTextTest(unittest.TestCase):
    def test_plain_text_passes_unchanged(self):
        for text in ["今天天气不错。", "a < b 并且 c > d", "结尾是个小于号 <", "<｜看起来像但不是", "x<|y", "<｜DS 不是标记"]:
            for chunks in chunkings(text):
                got, calls, items, _ = run(chunks)
                self.assertEqual(got, text, chunks)
                self.assertEqual(calls, [])

    def test_every_upstream_chunk_yields_at_least_one_item(self):
        # 截留期间也要让引擎的每轮循环跑起来,它靠这个及时发现用户打断
        chunks = list(WEATHER)
        _, _, items, _ = run(chunks)
        self.assertGreaterEqual(len(items), len(chunks))

    def test_never_yields_the_word_content_as_one_piece(self):
        for chunks in (["content"], ["好的", "content"], list("前content后")):
            got, _, items, _ = run(chunks)
            self.assertEqual(got, "".join(chunks))
            self.assertNotIn("content", [content for content, _ in items])


class ToolCallTest(unittest.TestCase):
    def assert_single_call(self, source, name, arguments, expect_text=""):
        for chunks in chunkings(source):
            text, calls, items, logs = run(chunks)
            self.assertEqual(text, expect_text, chunks)
            self.assertEqual(len(calls), 1, chunks)
            self.assertEqual(calls[0]["name"], name)
            self.assertEqual(json.loads(calls[0]["arguments"]), arguments)
            self.assertTrue(calls[0]["id"].startswith("call_"))
            for content, _ in items:
                self.assertNotIn("DSML", content or "", chunks)
            self.assertTrue(logs)

    def test_weather_call_every_chunking(self):
        self.assert_single_call(WEATHER, "get_weather", {"location": "北京"})

    def test_call_without_parameters(self):
        self.assert_single_call(block(invoke("show_calendar")), "show_calendar", {})

    def test_parameter_types(self):
        source = block(invoke(
            "set_volume",
            param("level", "60", string="false"),
            param("steps", "[1, 2]", string="false"),
            param("broken", "abc", string="false"),
            param("change", "up", string=None),
        ))
        self.assert_single_call(source, "set_volume", {"level": 60, "steps": [1, 2], "broken": "abc", "change": "up"})

    def test_tolerant_variants(self):
        variants = [
            WEATHER.replace("｜DSML｜", "｜｜DSML｜｜").replace("function_calls", "calls"),
            WEATHER.replace("｜", "|"),
            WEATHER.replace("function_calls", "tool_calls"),
            WEATHER.replace("</｜DSML｜invoke>", "<｜DSML｜/invoke>").replace("</｜DSML｜parameter>", "<｜DSML｜/parameter>"),
            WEATHER.replace('<｜DSML｜invoke name="get_weather">', '< ｜DSML｜ invoke name = "get_weather" >'),
            WEATHER.replace("DSML", "dsml"),
        ]
        for source in variants:
            with self.subTest(source=source):
                self.assert_single_call(source, "get_weather", {"location": "北京"})

    def test_text_before_and_after_block(self):
        self.assert_single_call("好的。" + WEATHER + "马上告诉你", "get_weather", {"location": "北京"}, "好的。马上告诉你")

    def test_two_invokes_keep_order(self):
        source = block(invoke("get_weather", param("location", "上海")), invoke("show_calendar"))
        for chunks in chunkings(source):
            _, calls, _, _ = run(chunks)
            self.assertEqual([call["name"] for call in calls], ["get_weather", "show_calendar"])
            self.assertEqual(json.loads(calls[0]["arguments"]), {"location": "上海"})

    def test_bare_invoke_without_wrapper(self):
        source = invoke("show_calendar") + "\n好的"
        for chunks in chunkings(source):
            text, calls, _, _ = run(chunks)
            self.assertEqual([call["name"] for call in calls], ["show_calendar"], chunks)
            self.assertEqual(text.strip(), "好的")

    def test_unterminated_block_at_end_of_stream(self):
        without_wrapper_close = WEATHER[:WEATHER.rindex("</｜DSML｜function_calls>")]
        self.assert_single_call(without_wrapper_close, "get_weather", {"location": "北京"})
        without_invoke_close = without_wrapper_close[:without_wrapper_close.rindex("</｜DSML｜invoke>")]
        self.assert_single_call(without_invoke_close, "get_weather", {"location": "北京"})

    def test_unparseable_block_is_dropped(self):
        source = "<｜DSML｜function_calls>\n乱七八糟\n</｜DSML｜function_calls>好的"
        for chunks in chunkings(source):
            text, calls, _, logs = run(chunks)
            self.assertEqual(text, "好的", chunks)
            self.assertEqual(calls, [])
            self.assertTrue(any("丢弃" in line for line in logs))

    def test_structured_calls_pass_through_and_keep_their_index(self):
        real = SimpleNamespace(index=0, id="real-1", type="function",
                               function=SimpleNamespace(name="get_weather", arguments='{"location": "广州"}'))
        _, calls, items, _ = run(list(block(invoke("show_calendar"))), structured=[real])
        self.assertIs(items[0][1][0], real)
        self.assertEqual([call["name"] for call in calls], ["get_weather", "show_calendar"])
        self.assertEqual(calls[0]["id"], "real-1")

    def test_closing_the_wrapper_closes_the_inner_stream(self):
        state = {"closed": False}

        def inner():
            try:
                yield "你", None
                yield "好", None
            finally:
                state["closed"] = True

        stream = tt.wrap_function_stream(inner())
        next(stream)
        stream.close()
        self.assertTrue(state["closed"])


class DirectAnswerTest(unittest.TestCase):
    def test_arguments_are_valid_json_every_chunking(self):
        expected = json.dumps({"response": ANSWER}, ensure_ascii=False)
        for chunks in chunkings(DIRECT):
            text, calls, _, _ = run(chunks)
            self.assertEqual(text, "")
            self.assertEqual(len(calls), 1, chunks)
            self.assertEqual(calls[0]["name"], "direct_answer")
            self.assertEqual(calls[0]["arguments"], expected, chunks)

    def test_text_is_streamed_before_the_block_ends(self):
        dsml = tt.DsmlToolCallFilter()
        calls = []
        seen = []
        cut = DIRECT.index("有什么")
        for char in DIRECT[:cut]:
            for _, tool_calls in dsml.feed(char):
                if tool_calls:
                    merge_tool_calls(calls, tool_calls)
            if calls:
                seen.append(extract_direct_answer(calls[0]["arguments"]))
        self.assertTrue(seen[-1].startswith("😊你好呀,我是小单。"), seen[-1])
        for partial in seen:
            self.assertNotIn("｜", partial)
            self.assertNotIn("DSML", partial)
            self.assertNotIn("<", partial)
            self.assertTrue(ANSWER.startswith(partial), partial)

    def test_tab_and_carriage_return_become_spaces(self):
        source = block(invoke("direct_answer", param("response", "一\t二\r三")))
        _, calls, _, _ = run(list(source))
        self.assertEqual(json.loads(calls[0]["arguments"]), {"response": "一 二 三"})

    def test_direct_answer_without_response_parameter(self):
        _, calls, _, _ = run([block(invoke("direct_answer"))])
        self.assertEqual(json.loads(calls[0]["arguments"]), {"response": ""})

    def test_stream_ends_inside_the_answer(self):
        cut = DIRECT.index("</｜DSML｜parameter>") + len("</｜DS")
        for chunks in chunkings(DIRECT[:cut]):
            _, calls, _, _ = run(chunks)
            self.assertEqual(json.loads(calls[0]["arguments"]), {"response": ANSWER}, chunks)

    def test_answer_then_real_tool(self):
        source = block(invoke("direct_answer", param("response", "我查一下")), invoke("get_weather"))
        _, calls, _, _ = run(list(source))
        self.assertEqual([call["name"] for call in calls], ["direct_answer", "get_weather"])
        self.assertEqual(json.loads(calls[0]["arguments"]), {"response": "我查一下"})


class StripTextTest(unittest.TestCase):
    def test_block_removed_from_plain_replies(self):
        logs = []
        for chunks in chunkings("前面" + WEATHER + "后面"):
            got = "".join(tt.strip_text_stream(iter(chunks), log=logs.append))
            self.assertEqual(got, "前面后面", chunks)
        self.assertTrue(any("丢弃" in line for line in logs))

    def test_plain_replies_unchanged(self):
        for chunks in chunkings("普通的回复 a < b"):
            self.assertEqual("".join(tt.strip_text_stream(iter(chunks))), "普通的回复 a < b")


if __name__ == "__main__":
    unittest.main()
