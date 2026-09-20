"""gateway_audio(走 OpenAI 兼容网关的语音接口,纯逻辑)的单元测试。只用标准库:

    python3 -m unittest discover -s server/tests -v

联网与流式部分在镜像里用假的网关跑一遍,见 server/tests/smoke_gateway_audio.py。
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

import gateway_audio as ga  # noqa: E402


class AddressTest(unittest.TestCase):
    def test_base_is_normalized_and_endpoints_are_appended(self):
        config = {"base_url": "https://model.shanchen.space/v1/"}
        self.assertEqual(ga.api_base(config), "https://model.shanchen.space/v1")
        self.assertEqual(ga.speech_url(config), "https://model.shanchen.space/v1/audio/speech")
        self.assertEqual(ga.transcription_url(config), "https://model.shanchen.space/v1/audio/transcriptions")

    def test_full_endpoint_is_accepted(self):
        # 照上游 OpenaiASR 的习惯填了完整端点也不该拼出 /audio/speech/audio/speech
        self.assertEqual(
            ga.speech_url({"base_url": "https://g/v1/audio/speech"}),
            "https://g/v1/audio/speech",
        )
        self.assertEqual(
            ga.transcription_url({"base_url": "https://g/v1/audio/transcriptions"}),
            "https://g/v1/audio/transcriptions",
        )

    def test_empty_base_falls_back_and_key_becomes_bearer(self):
        self.assertEqual(ga.api_base({}), ga.DEFAULT_BASE)
        self.assertEqual(ga.auth_headers({"api_key": " k "}), {"Authorization": "Bearer k"})
        self.assertEqual(ga.auth_headers({}), {})


class SpeechBodyTest(unittest.TestCase):
    def test_sample_rate_is_int_and_pcm_is_requested(self):
        body = ga.speech_body({}, "你好", 24000)
        # 网关只认整数;传字符串会被悄悄忽略并退回 22050,听感是音调偏高
        self.assertIsInstance(body["sample_rate"], int)
        self.assertEqual(body["sample_rate"], 24000)
        self.assertEqual(body["response_format"], "pcm")
        self.assertTrue(body["stream"])
        self.assertEqual(body["input"], "你好")

    def test_private_voice_wins_over_voice(self):
        body = ga.speech_body({"voice": "a", "private_voice": "b"}, "x", 24000)
        self.assertEqual(body["voice"], "b")
        self.assertEqual(ga.speech_body({}, "x", 24000)["voice"], ga.DEFAULT_VOICE)

    def test_rate_maps_to_speed_and_defaults_are_omitted(self):
        # 控制塔的音色设置里语速叫 rate,网关只认 OpenAI 的 speed
        self.assertEqual(ga.speech_body({"rate": 1.5}, "x", 24000)["speed"], 1.5)
        body = ga.speech_body({"rate": 1.0, "volume": 50, "pitch": 1.0}, "x", 24000)
        for key in ("speed", "volume", "pitch", "instruction"):
            self.assertNotIn(key, body, f"默认值不该出现在请求里: {key}")

    def test_out_of_range_values_are_clamped_not_rejected(self):
        body = ga.speech_body({"rate": 9, "volume": 999, "pitch": -3}, "x", 24000)
        self.assertEqual(body["speed"], 2.0)
        self.assertEqual(body["volume"], 100)
        self.assertEqual(body["pitch"], 0.5)
        # 填了垃圾就当没填,不要把整句合成搞失败
        self.assertNotIn("speed", ga.speech_body({"rate": "很快"}, "x", 24000))

    def test_instruction_and_language_hints(self):
        body = ga.speech_body({"instruction": " 温柔些 ", "language_hints": "zh, en"}, "x", 24000)
        self.assertEqual(body["instruction"], "温柔些")
        self.assertEqual(body["language_hints"], ["zh", "en"])


class ContentTypeTest(unittest.TestCase):
    def test_rate_is_read_back_from_content_type(self):
        self.assertEqual(ga.parse_rate("audio/L16;rate=24000;channels=1"), 24000)
        self.assertEqual(ga.parse_rate("audio/L16; rate=22050 ; channels=1"), 22050)
        self.assertIsNone(ga.parse_rate("audio/L16"))
        self.assertIsNone(ga.parse_rate("audio/L16;rate=abc"))
        self.assertIsNone(ga.parse_rate(None))

    def test_wav_fallback_is_detected(self):
        # qwen3-tts 系请求 pcm 会悄悄返回 WAV,带 44 字节头,直接喂编码器就是一段噪音
        self.assertTrue(ga.is_raw_pcm("audio/L16;rate=24000;channels=1"))
        self.assertTrue(ga.is_raw_pcm("audio/pcm"))
        self.assertFalse(ga.is_raw_pcm("audio/x-wav"))
        self.assertFalse(ga.is_raw_pcm("audio/mpeg"))
        self.assertFalse(ga.is_raw_pcm(None))


class AsrTest(unittest.TestCase):
    def test_vocabulary_is_json_string_in_form(self):
        data = ga.asr_data({"model_name": "m", "vocabulary": "小单|5, 小丹"})
        self.assertEqual(data["model"], "m")
        self.assertEqual(json.loads(data["vocabulary"]), {"小单": 5, "小丹": 4})

    def test_vocabulary_accepts_dict_and_clamps_weight(self):
        data = ga.asr_data({"vocabulary": {"小单": 99, "团子": 0}})
        self.assertEqual(json.loads(data["vocabulary"]), {"小单": 5, "团子": 1})

    def test_no_vocabulary_key_when_empty(self):
        self.assertNotIn("vocabulary", ga.asr_data({}))
        self.assertNotIn("vocabulary", ga.asr_data({"vocabulary": "  "}))

    def test_language_hint_takes_first(self):
        self.assertEqual(ga.asr_data({"language_hints": "zh,en"})["language"], "zh")
        self.assertNotIn("language", ga.asr_data({}))

    def test_response_parsing(self):
        self.assertEqual(ga.parse_asr_text({"text": " 你好 "}), "你好")
        self.assertEqual(ga.parse_asr_text({"segments": [{"text": "你"}, {"text": "好"}]}), "你好")
        self.assertEqual(ga.parse_asr_text({}), "")
        self.assertEqual(ga.parse_asr_text(None), "")


class ErrorTest(unittest.TestCase):
    def test_gateway_error_shape(self):
        self.assertEqual(ga.error_message({"error": {"message": "坏了"}}), "坏了")
        self.assertEqual(ga.error_message({"error": "坏了"}), "坏了")
        self.assertEqual(ga.error_message({"message": "坏了"}), "坏了")
        self.assertEqual(ga.error_message({}, "兜底"), "兜底")
        self.assertEqual(ga.error_message("不是字典", "兜底"), "兜底")


if __name__ == "__main__":
    unittest.main()
