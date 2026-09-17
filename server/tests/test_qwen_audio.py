"""qwen_audio(千问语音纯逻辑)的单元测试。只用标准库:

    python3 -m unittest discover -s server/tests -v

联网与线程部分在镜像里用假的百炼服务端跑一遍,见 server/tests/smoke_qwen_audio.py。
"""

import base64
import io
import json
import os
import sys
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

import qwen_audio as qa  # noqa: E402


class AddressTest(unittest.TestCase):
    def test_workspace_domain_is_default_when_given(self):
        self.assertEqual(qa.http_base({"workspace_id": "ws-1a2b"}), "https://ws-1a2b.cn-beijing.maas.aliyuncs.com")
        self.assertEqual(qa.ws_url({"workspace_id": "ws-1a2b"}), "wss://ws-1a2b.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference")

    def test_explicit_base_url_wins_and_suffix_is_trimmed(self):
        config = {"workspace_id": "ws", "base_url": "https://dashscope.aliyuncs.com/api/v1/"}
        self.assertEqual(qa.http_base(config), "https://dashscope.aliyuncs.com")
        self.assertEqual(qa.ws_url(config), "wss://dashscope.aliyuncs.com/api-ws/v1/inference")
        self.assertEqual(qa.http_base({"base_url": "http://127.0.0.1:9/compatible-mode/v1"}), "http://127.0.0.1:9")
        self.assertEqual(qa.ws_url({"base_url": "http://127.0.0.1:9"}), "ws://127.0.0.1:9/api-ws/v1/inference")

    def test_legacy_domain_without_workspace(self):
        self.assertEqual(qa.http_base({}), qa.LEGACY_BASE)

    def test_explicit_ws_url(self):
        self.assertEqual(qa.ws_url({"ws_url": "ws://x/y"}), "ws://x/y")

    def test_bad_workspace_rejected(self):
        with self.assertRaises(ValueError):
            qa.http_base({"workspace_id": "evil.example.com/"})

    def test_auth_headers(self):
        with self.assertRaises(ValueError):
            qa.auth_headers({})
        self.assertEqual(qa.auth_headers({"api_key": " sk-1 "}), {"Authorization": "Bearer sk-1"})
        headers = qa.auth_headers({"api_key": "sk-1", "workspace_id": "ws"})
        self.assertEqual(headers["X-DashScope-WorkSpace"], "ws")
        self.assertNotIn("X-DashScope-WorkSpace", qa.auth_headers({"api_key": "k", "workspace_id": "ws", "base_url": "https://a"}))


class AsrTest(unittest.TestCase):
    def test_wav_wrapping(self):
        wav = qa.pcm_to_wav(b"\x01\x02\x03", 16000)
        with wave.open(io.BytesIO(wav)) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 16000, 1))

    def test_request_body(self):
        body = qa.asr_request_body(b"RIFF", vocabulary={"小单": 5}, context="上一句", language_hints=["zh", "en", "", 3])
        self.assertEqual(body["model"], qa.ASR_MODEL)
        self.assertEqual(body["parameters"], {"format": "wav", "sample_rate": "16000", "vocabulary": {"小单": 5}, "language_hints": ["zh", "en"]})
        messages = body["input"]["messages"]
        self.assertEqual(messages[0]["role"], "assistant")
        self.assertEqual(messages[-1]["role"], "user")
        data = messages[-1]["content"][0]["input_audio"]["data"]
        self.assertTrue(data.startswith("data:audio/wav;base64,"))
        self.assertEqual(base64.b64decode(data.split(",", 1)[1]), b"RIFF")
        json.dumps(body)

    def test_request_body_minimal(self):
        body = qa.asr_request_body(b"x")
        self.assertEqual(len(body["input"]["messages"]), 1)
        self.assertEqual(body["parameters"], {"format": "wav", "sample_rate": "16000"})

    def test_context_is_truncated(self):
        body = qa.asr_request_body(b"x", context="字" * 1000)
        self.assertEqual(len(body["input"]["messages"][0]["content"][0]["text"]), qa.ASR_CONTEXT_CHARS)

    def test_parse_response_shapes(self):
        self.assertEqual(qa.parse_asr_response({"output": {"text": " 你好 "}}), "你好")
        self.assertEqual(qa.parse_asr_response({"output": {"sentence": {"text": "句子"}}}), "句子")
        self.assertEqual(qa.parse_asr_response({"output": {"choices": [{"message": {"content": [{"text": "a"}, {"text": "b"}]}}]}}), "ab")
        self.assertEqual(qa.parse_asr_response({"output": {"choices": [{"message": {"content": "c"}}]}}), "c")
        self.assertEqual(qa.parse_asr_response({"output": {}}), "")
        self.assertEqual(qa.parse_asr_response(None), "")

    def test_error_message(self):
        self.assertEqual(qa.asr_error({"code": "InvalidApiKey", "message": "bad"}), "InvalidApiKey: bad")
        self.assertIsNone(qa.asr_error({"output": {}}))

    def test_vocabulary(self):
        self.assertEqual(qa.parse_vocabulary("小单|5, 小丹\n千问|9；x|0"), {"小单": 5, "小丹": 4, "千问": 5, "x": 1})
        self.assertEqual(qa.parse_vocabulary({"a": "3", "": 2}), {"a": 3})
        self.assertEqual(qa.parse_vocabulary(None), {})
        self.assertEqual(qa.parse_vocabulary("超" * 21), {})


class TtsTest(unittest.TestCase):
    def test_parameters_defaults_and_clamping(self):
        params = qa.tts_parameters({"voice": "v", "volume": "999", "rate": "0.1", "pitch": "abc"}, 24000)
        self.assertEqual(params, {"text_type": "PlainText", "voice": "v", "format": "pcm", "sample_rate": 24000,
                                  "volume": 100, "rate": 0.5, "pitch": 1.0})

    def test_private_voice_and_instruction(self):
        params = qa.tts_parameters({"voice": "v", "private_voice": "p", "instruction": "温柔" * 60, "language_hints": "zh, en"}, 16000)
        self.assertEqual(params["voice"], "p")
        self.assertEqual(qa.instruction_units(params["instruction"]), 100)
        self.assertEqual(params["language_hints"], ["zh", "en"])

    def test_default_voice(self):
        self.assertEqual(qa.tts_parameters({}, 24000)["voice"], qa.TTS_DEFAULT_VOICE)

    def test_instruction_units(self):
        self.assertEqual(qa.clamp_instruction("a" * 120), "a" * 100)
        self.assertEqual(qa.clamp_instruction("中" * 51), "中" * 50)
        self.assertEqual(qa.clamp_instruction(None), "")

    def test_task_messages(self):
        run = json.loads(qa.run_task("t1", "m", {"voice": "v"}))
        self.assertEqual(run["header"], {"action": "run-task", "task_id": "t1", "streaming": "duplex"})
        self.assertEqual(run["payload"]["function"], "SpeechSynthesizer")
        self.assertEqual(run["payload"]["input"], {})
        self.assertEqual(json.loads(qa.continue_task("t1", "你好"))["payload"]["input"]["text"], "你好")
        self.assertEqual(json.loads(qa.finish_task("t1"))["payload"]["input"], {})
        self.assertEqual(json.loads(qa.finish_task("t1", cancel=True))["payload"]["input"], {"directive": "cancel"})

    def test_parse_event(self):
        self.assertEqual(qa.parse_event('{"header":{"event":"task-started","task_id":"t"}}'), ("task-started", "t", None))
        event, _, error = qa.parse_event('{"header":{"event":"task-failed","error_code":"E","error_message":"boom"}}')
        self.assertEqual((event, error), ("task-failed", "E: boom"))
        self.assertEqual(qa.parse_event("not json"), (None, None, None))

    def test_split_segments(self):
        self.assertEqual(qa.split_segments("短句。"), ["短句。"])
        long_text = ("这是一个很长的句子，" * 40)
        segments = qa.split_segments(long_text, limit=50)
        self.assertEqual("".join(segments), long_text)
        self.assertTrue(all(len(s) <= 50 for s in segments))
        self.assertTrue(all(s.endswith("，") for s in segments[:-1]))
        no_punct = "字" * 130
        self.assertEqual([len(s) for s in qa.split_segments(no_punct, limit=50)], [50, 50, 30])
        self.assertEqual(qa.split_segments("   "), [])

    def test_speakable(self):
        self.assertTrue(qa.speakable("好的"))
        self.assertTrue(qa.speakable("ok"))
        self.assertFalse(qa.speakable("…！🙂"))
        self.assertFalse(qa.speakable(""))

    def test_inline_tags(self):
        allowed = qa.parse_allowed_tags(["excited", "laughing"])
        self.assertEqual(qa.parse_allowed_tags("excited, laughing"), allowed)
        self.assertEqual(qa.parse_allowed_tags(None), frozenset())
        self.assertEqual(qa.filter_tags("[excited]哇[sad]好[laughing]", allowed), "[excited]哇好[laughing]")
        self.assertEqual(qa.filter_tags("[excited]哇", frozenset()), "哇", "没有允许的标签时全部去掉")
        self.assertEqual(qa.strip_tags("[excited]哇 [clears throat] 好"), "哇 好")
        self.assertEqual(qa.tags_only("[laughing]。[sighing]"), "[laughing][sighing]")
        self.assertEqual(qa.strip_tags("[1] 与 [ABC] 不是标签"), "[1] 与 [ABC] 不是标签")

    def test_speakable_ignores_tags(self):
        self.assertFalse(qa.speakable("[laughing]"))
        self.assertFalse(qa.speakable("[laughing]!"))
        self.assertTrue(qa.speakable("[laughing]哈"))

    def test_trim_segment_keeps_tags(self):
        # 与上游 textUtils.is_punctuation_or_emoji 的标点集一致(含方括号)
        punct = set("，,。.！!“”\"：:-－、[]【】")
        trim = lambda ch: ch.isspace() or ch in punct
        self.assertEqual(qa.trim_segment("[excited]哇,你做到啦![laughing]", trim), "[excited]哇,你做到啦![laughing]")
        self.assertEqual(qa.trim_segment("！[sad]我好难过。", trim), "[sad]我好难过")
        self.assertEqual(qa.trim_segment("，好的。", trim), "好的")
        self.assertEqual(qa.trim_segment("[不是标签]", trim), "不是标签")

    def test_split_segments_never_cuts_inside_tag(self):
        text = "啊" * 190 + "[clears throat]" + "呀" * 30
        segments = qa.split_segments(text)
        self.assertEqual("".join(segments), text)
        self.assertTrue(segments[1].startswith("[clears throat]"), segments)

    def test_keepalive(self):
        keepalive = qa.Keepalive(every=3)
        self.assertEqual([keepalive.tick() for _ in range(7)], [False, False, True, False, False, True, False])



class SubtitlePartsTest(unittest.TestCase):
    def test_short_text_is_one_part(self):
        self.assertEqual(qa.subtitle_parts("你好呀,今天过得怎么样?"), ["你好呀,今天过得怎么样?"])
        self.assertEqual(qa.subtitle_parts("   "), [])

    def test_units_and_bytes_limits(self):
        text = "小朋友们大家好,今天我要给你们讲一个关于月亮上的小邮差的故事,他每天晚上都骑着一只会发光的萤火虫,把星星写的信送到每一个睡着的孩子的枕头边。你知道信里写了什么吗?"
        parts = qa.subtitle_parts(text)
        self.assertGreater(len(parts), 1)
        self.assertEqual("".join(parts), text.replace(" ", ""))
        for part in parts:
            self.assertLessEqual(qa.display_units(part), qa.SUBTITLE_UNITS + 1)  # 句末标点可以跟在满额的一条后面
            self.assertLessEqual(len(part.encode("utf-8")), qa.SUBTITLE_BYTES + 8)

    def test_prefers_sentence_break_then_comma(self):
        text = "今天天气很好。" + "我们一起去公园玩滑梯荡秋千还要喂小鸭子" * 2
        self.assertEqual(qa.subtitle_parts(text)[0], "今天天气很好。")
        parts = qa.subtitle_parts("第一件事情是先把小书包收拾好,第二件事情是把明天要穿的衣服放在床头边上,第三件事情是刷牙洗脸")
        self.assertTrue(parts[0].endswith(","), parts)

    def test_punctuation_never_starts_a_part(self):
        text = "啊" * 40 + "。" + "好"
        parts = qa.subtitle_parts(text)
        self.assertTrue(all(p[0] not in "，。！？、" for p in parts), parts)
        self.assertEqual(parts[0], "啊" * 40 + "。")

    def test_english_words_are_not_split(self):
        text = "The quick brown fox jumps over the lazy dog and keeps running across the wide green field until sunset comes"
        parts = qa.subtitle_parts(text)
        self.assertEqual(" ".join(parts), text)
        for part in parts:
            for word in part.split(" "):
                self.assertIn(word, text.split(" "))

    def test_display_units(self):
        self.assertEqual(qa.display_units("ab你好"), 3.0)
        self.assertEqual(qa.display_units(""), 0)


class SpeechRateTest(unittest.TestCase):
    def test_offsets_follow_units(self):
        rate = qa.SpeechRate(1.0)
        offsets = qa.part_offsets_ms(["一二三四", "五六七八九十"], rate)
        self.assertEqual(offsets[0], 0.0)
        self.assertAlmostEqual(offsets[1], 4 / 4.4 * 1000)

    def test_rate_config_and_update(self):
        self.assertAlmostEqual(qa.SpeechRate(2).units_per_s, 8.8)
        self.assertAlmostEqual(qa.SpeechRate("bad").units_per_s, 4.4)
        rate = qa.SpeechRate(1.0)
        rate.update(40, 5000)          # 实测 8 单位/秒
        self.assertAlmostEqual(rate.units_per_s, 0.7 * 4.4 + 0.3 * 8)
        rate.update(2, 5000)           # 太短不采信
        rate.update(40, 100)
        self.assertAlmostEqual(rate.units_per_s, 0.7 * 4.4 + 0.3 * 8)
        rate.update(40, 1000)          # 40 单位/秒被夹到 12
        self.assertLessEqual(rate.units_per_s, 12)


class CueScheduleTest(unittest.TestCase):
    def test_cues_follow_frames_and_paragraphs(self):
        schedule = qa.CueSchedule([{"ms": 0, "x": "从前", "p": True}, {"ms": 120, "x": "有座山"}, {"ms": 125, "x": "山里"}], keepalive_frames=100)
        self.assertEqual(schedule.initial(), ["\x1e\x1f从前"])
        self.assertEqual(schedule.on_frame(), [])                         # 60 ms
        self.assertEqual(schedule.on_frame(), ["\x1e有座山"])            # 120 ms
        self.assertEqual(schedule.on_frame(), ["\x1e山里"])              # 180 ms

    def test_keepalive_marker_when_quiet(self):
        schedule = qa.CueSchedule(None, keepalive_frames=3)
        self.assertEqual(schedule.initial(), [])
        self.assertEqual([schedule.on_frame() for _ in range(7)], [[], [], ["\x1e"], [], [], ["\x1e"], []])

    def test_cue_resets_keepalive(self):
        schedule = qa.CueSchedule([{"ms": 120, "x": "甲"}], keepalive_frames=3)
        out = [schedule.on_frame() for _ in range(6)]
        self.assertEqual(out, [[], ["\x1e甲"], [], [], ["\x1e"], []])


if __name__ == "__main__":
    unittest.main()
