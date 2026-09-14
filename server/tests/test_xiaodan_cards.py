"""xiaodan_cards 的单元测试。只用标准库,不联网,不需要引擎:

    python3 -m unittest discover -s server/tests -v

卡片字段的范围与固件 main/xd_proto.c 的校验一一对应:这里放过的值设备必须收得下,
否则设备会把整条消息丢掉,屏幕上什么也不出现。
"""

import asyncio
import datetime as dt
import json
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins"))

import xiaodan_cards as cards  # noqa: E402


class FakeSocket:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send(self, text):
        if self.fail:
            raise ConnectionError("closed")
        self.sent.append(text)


class FakeConn:
    def __init__(self, features=None, plugins=None, fail=False):
        self.features = features
        self.config = {"plugins": plugins or {}}
        self.websocket = FakeSocket(fail)
        self.session_id = "s-1"


def open_meteo_fixture():
    # 2026-09-14 实际请求广州得到的响应(节选)
    return {
        "current": {"time": "2026-09-14T16:00", "temperature_2m": 29.0, "relative_humidity_2m": 77, "weather_code": 51},
        "daily": {
            "time": ["2026-09-14", "2026-09-15"],
            "weather_code": [96, 95],
            "temperature_2m_max": [31.8, 31.7],
            "temperature_2m_min": [24.2, 24.5],
        },
    }


def wttr_fixture():
    hourly = [{"weatherCode": "113"}] * 4 + [{"weatherCode": "353"}] + [{"weatherCode": "113"}] * 3
    return {
        "current_condition": [{"temp_C": "28", "humidity": "81", "weatherCode": "356"}],
        "weather": [
            {"date": "2026-09-14", "maxtempC": "31", "mintempC": "25", "hourly": hourly},
            {"date": "2026-09-15", "maxtempC": "32", "mintempC": "25", "hourly": [{"weatherCode": "176"}]},
        ],
    }


class TextHelpers(unittest.TestCase):
    def test_truncate_on_char_boundary(self):
        self.assertEqual(cards.truncate_utf8("广州市天河区体育西路", 18), "广州市天河区")
        self.assertEqual(cards.truncate_utf8("广州市", 7), "广州")
        self.assertEqual(cards.truncate_utf8("abc", 2), "ab")
        self.assertEqual(cards.truncate_utf8(None, 10), "")

    def test_numbers(self):
        self.assertEqual(cards.to_number("50%"), 50.0)
        self.assertEqual(cards.to_number(" 7 "), 7.0)
        self.assertIsNone(cards.to_number(True))
        self.assertIsNone(cards.to_number("abc"))
        self.assertIsNone(cards.to_number(float("nan")))
        self.assertEqual(cards.round_half_up(27.5), 28)
        self.assertEqual(cards.round_half_up(26.5), 27)
        self.assertEqual(cards.round_half_up(-0.5), 0)
        self.assertEqual(cards.round_half_up(-1.6), -2)

    def test_hold(self):
        self.assertEqual(cards.clamp_hold(None), 20)
        self.assertEqual(cards.clamp_hold(0), 20)
        self.assertEqual(cards.clamp_hold("x"), 20)
        self.assertEqual(cards.clamp_hold(1), 5)
        self.assertEqual(cards.clamp_hold(30), 30)
        self.assertEqual(cards.clamp_hold(999), 60)

    def test_spoken_numbers(self):
        expected = {0: "零", 5: "五", 10: "十", 14: "十四", 20: "二十", 23: "二十三", 31: "三十一", 99: "九十九", 100: "一百"}
        for number, words in expected.items():
            self.assertEqual(cards.cn_int(number), words)
        self.assertEqual(cards.cn_int(101), "101")
        self.assertEqual(cards.cn_digits(2026), "二零二六")

    def test_ttl_cache(self):
        now = [100.0]
        cache = cards.TtlCache(ttl_s=10, max_items=2, clock=lambda: now[0])
        cache.put("a", 1)
        now[0] = 101
        cache.put("b", 2)
        self.assertEqual(cache.get("a"), 1)
        now[0] = 105
        cache.put("c", 3)   # 满了:淘汰最早过期的 a
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("c"), 3)
        now[0] = 111        # b 在 111 过期,c 要到 115
        self.assertIsNone(cache.get("b"))
        self.assertEqual(cache.get("c"), 3)


class Calendar(unittest.TestCase):
    def test_card_fields(self):
        # 2024-02-01 是星期四,2024 年是闰年
        card = cards.calendar_card(dt.date(2024, 2, 29), "正月二十", None)
        self.assertEqual(card, {
            "cmd": "calendar", "year": 2024, "month": 2, "day": 29, "weekday": 4,
            "first_weekday": 4, "days": 29, "lunar": "正月二十", "hold_s": 20,
        })

    def test_sunday_is_zero(self):
        # 2024-09-01 是星期日
        card = cards.calendar_card(dt.date(2024, 9, 1))
        self.assertEqual(card["weekday"], 0)
        self.assertEqual(card["first_weekday"], 0)
        self.assertEqual(card["days"], 30)
        # 2024-01-01 是星期一
        self.assertEqual(cards.weekday_sun0(dt.date(2024, 1, 1)), 1)

    def test_card_ranges_match_firmware(self):
        day = dt.date(2025, 1, 1)
        for offset in range(0, 800, 7):
            card = cards.calendar_card(day + dt.timedelta(days=offset), "闰六月廿九初一初二", 99)
            self.assertTrue(1970 <= card["year"] <= 2199)
            self.assertTrue(28 <= card["days"] <= 31)
            self.assertTrue(1 <= card["day"] <= card["days"])
            self.assertTrue(0 <= card["weekday"] <= 6 and 0 <= card["first_weekday"] <= 6)
            self.assertLessEqual(len(card["lunar"].encode("utf-8")), 24)
            self.assertEqual(card["hold_s"], 60)

    def test_resolve_day(self):
        today = dt.date(2026, 9, 14)
        self.assertEqual(cards.resolve_day(today), (today, ""))
        self.assertEqual(cards.resolve_day(today, None, 1)[0], dt.date(2026, 9, 15))
        self.assertEqual(cards.resolve_day(today, "", "-1")[0], dt.date(2026, 9, 13))
        self.assertEqual(cards.resolve_day(today, "2026-10-01")[0], dt.date(2026, 10, 1))
        self.assertEqual(cards.resolve_day(today, "10月1号")[0], dt.date(2026, 10, 1))
        self.assertEqual(cards.resolve_day(today, "2027年1月1日")[0], dt.date(2027, 1, 1))
        self.assertEqual(cards.resolve_day(today, "2026/2/28", 5)[0], dt.date(2026, 2, 28))   # date 优先
        for bad_date in ("2026-13-01", "2026-02-30", "明天", "1900-01-01"):
            day, error = cards.resolve_day(today, bad_date)
            self.assertIsNone(day)
            self.assertTrue(error)
        for bad_offset in ("abc", 1.5, 99999):
            day, error = cards.resolve_day(today, None, bad_offset)
            self.assertIsNone(day)
            self.assertTrue(error)

    def test_speech(self):
        today = dt.date(2026, 9, 14)   # 星期一
        self.assertEqual(cards.calendar_speech(today, today, "七月廿三"), "今天是九月十四号，星期一，农历七月二十三。")
        self.assertEqual(cards.calendar_speech(dt.date(2026, 9, 15), today, ""), "明天是九月十五号，星期二。")
        self.assertEqual(cards.calendar_speech(dt.date(2026, 10, 1), today, "八月廿一"), "十月一号是星期四，农历八月二十一。")
        self.assertEqual(cards.calendar_speech(dt.date(2027, 1, 3), today, ""), "二零二七年一月三号是星期天。")

    def test_lunar_with_and_without_library(self):
        saved = sys.modules.get("cnlunar")

        class FakeLunar:
            def __init__(self, when, godType):
                assert isinstance(when, dt.datetime) and godType == "8char"
                self.lunarMonthCn = "七月小"
                self.lunarDayCn = "廿三"

        sys.modules["cnlunar"] = types.SimpleNamespace(Lunar=FakeLunar)
        try:
            self.assertEqual(cards.lunar_text(dt.date(2026, 9, 14)), "七月廿三")
        finally:
            if saved is None:
                sys.modules.pop("cnlunar", None)
            else:
                sys.modules["cnlunar"] = saved
        sys.modules["cnlunar"] = None   # 模拟没装这个库
        try:
            self.assertEqual(cards.lunar_text(dt.date(2026, 9, 14)), "")
        finally:
            if saved is None:
                sys.modules.pop("cnlunar", None)
            else:
                sys.modules["cnlunar"] = saved


class Weather(unittest.TestCase):
    def test_code_tables_fit_device(self):
        for table in (cards._WMO, cards._WWO):
            for code, (icon, text) in table.items():
                self.assertIn(icon, cards.ICONS, code)
                self.assertLessEqual(len(text.encode("utf-8")), cards.TEXT_MAX_BYTES, code)
                # 设备字库只有 GB2312 一级汉字(区码 16 到 55)
                for ch in text:
                    area = ch.encode("gb2312")[0] - 0xA0
                    self.assertTrue(16 <= area <= 55, f"{code} {text} 里的「{ch}」不在一级字库")
        self.assertEqual(cards.wmo_to_card(0), ("sun", "晴"))
        self.assertEqual(cards.wmo_to_card("95"), ("thunder", "雷阵雨"))
        self.assertEqual(cards.wmo_to_card(12345), cards.UNKNOWN_WEATHER)
        self.assertEqual(cards.wmo_to_card(None), cards.UNKNOWN_WEATHER)
        self.assertEqual(cards.wwo_to_card("356"), ("rain", "阵雨"))

    def test_parse_open_meteo(self):
        obs = cards.parse_open_meteo(open_meteo_fixture())
        self.assertEqual(obs["source"], "open-meteo")
        self.assertEqual((obs["icon"], obs["text"], obs["temp"], obs["humidity"]), ("rain", "毛毛雨", 29.0, 77))
        self.assertEqual(obs["today"], {"icon": "thunder", "text": "雷雨冰雹", "hi": 31.8, "lo": 24.2})
        self.assertEqual(obs["tomorrow"]["text"], "雷阵雨")

    def test_open_meteo_partial(self):
        data = open_meteo_fixture()
        data["daily"]["temperature_2m_max"][1] = None
        self.assertIsNone(cards.parse_open_meteo(data)["tomorrow"])
        data["current"]["temperature_2m"] = None
        with self.assertRaises(ValueError):
            cards.parse_open_meteo(data)
        with self.assertRaises(ValueError):
            cards.parse_open_meteo({"error": True, "reason": "x"})

    def test_parse_wttr(self):
        obs = cards.parse_wttr(wttr_fixture())
        self.assertEqual((obs["icon"], obs["text"], obs["temp"], obs["humidity"]), ("rain", "阵雨", 28.0, 81))
        self.assertEqual(obs["today"], {"icon": "rain", "text": "小阵雨", "hi": 31.0, "lo": 25.0})
        self.assertEqual(obs["tomorrow"]["text"], "零星小雨")
        with self.assertRaises(ValueError):
            cards.parse_wttr({"data": {"error": "Unknown location"}})

    def test_geocode_ranking(self):
        # 2026-09-14 实际查询"北京"的前两项,顺序调换过:排序不能依赖接口给的顺序
        beijing = {"results": [
            {"name": "北京", "latitude": 29.9, "longitude": 106.1, "feature_code": "PPL"},
            {"name": "北京", "latitude": 39.9075, "longitude": 116.39723, "feature_code": "PPLC", "population": 18960744},
        ]}
        place = cards.rank_geocode(beijing)
        self.assertEqual((place.name, place.latitude, place.longitude, place.confident), ("北京", 39.9075, 116.39723, True))
        # 用中文查外国城市只得到同名村庄:不可信
        tokyo_in_chinese = {"results": [{"name": "东京", "latitude": 32.0, "longitude": 119.0, "feature_code": "PPL"}]}
        self.assertFalse(cards.rank_geocode(tokyo_in_chinese).confident)
        # 县级行政中心可信,人口多的普通居民点也可信
        county = {"results": [{"name": "海淀", "latitude": 39.96, "longitude": 116.29, "feature_code": "PPLA3"}]}
        self.assertTrue(cards.rank_geocode(county).confident)
        town = {"results": [{"name": "x", "latitude": 1, "longitude": 2, "feature_code": "PPL", "population": 80000}]}
        self.assertTrue(cards.rank_geocode(town).confident)
        # 山、机场之类不是城市;坐标缺失的项跳过
        self.assertIsNone(cards.rank_geocode({"results": [
            {"name": "Tokyo Hill", "latitude": 1, "longitude": 2, "feature_code": "MT"},
            {"name": "x", "feature_code": "PPLA"},
        ]}))
        self.assertIsNone(cards.rank_geocode({"generationtime_ms": 0.5}))
        self.assertIsNone(cards.rank_geocode(None))

    def test_geocode_candidates(self):
        self.assertEqual(cards.geocode_candidates("广州市"), ("广州市", "广州"))
        self.assertEqual(cards.geocode_candidates("海淀区"), ("海淀区", "海淀"))
        self.assertEqual(cards.geocode_candidates("沙市"), ("沙市",))
        self.assertEqual(cards.geocode_candidates("Tokyo"), ("Tokyo",))

    def test_urls_escape_names(self):
        self.assertIn("name=%E5%B9%BF%E5%B7%9E", cards.open_meteo_geocode_url("广州"))
        self.assertTrue(cards.wttr_url("New York").startswith("https://wttr.in/New%20York?"))
        self.assertIn("latitude=23.1167&longitude=113.2500", cards.open_meteo_forecast_url(23.11667, 113.25))

    def test_clean_location(self):
        self.assertEqual(cards.clean_location(" 杭州 "), "杭州")
        self.assertEqual(cards.clean_location("北京的天气"), "北京")
        self.assertEqual(cards.clean_location("上海天气怎么样"), "上海")
        self.assertEqual(cards.clean_location(None), "")

    def test_card(self):
        card = cards.weather_card("广州", cards.parse_open_meteo(open_meteo_fixture()), None)
        self.assertEqual(card, {
            "cmd": "weather", "city": "广州", "icon": "rain", "text": "毛毛雨", "temp": 29, "hi": 32, "lo": 24,
            "humidity": 77, "tm_icon": "thunder", "tm_text": "雷阵雨", "tm_hi": 32, "tm_lo": 25, "hold_s": 20,
        })

    def test_card_clamps_and_omits(self):
        obs = {"icon": "sun", "text": "晴", "temp": 75.4, "humidity": None,
               "today": {"icon": "sun", "text": "晴", "hi": 80, "lo": -55}, "tomorrow": None}
        card = cards.weather_card("乌鲁木齐市沙依巴克区", obs, 7)
        self.assertEqual((card["temp"], card["hi"], card["lo"]), (60, 60, -40))
        self.assertEqual(card["city"], "乌鲁木齐市沙")
        self.assertNotIn("humidity", card)
        self.assertNotIn("tm_text", card)
        self.assertEqual(card["hold_s"], 7)
        self.assertEqual(cards.weather_card("", obs)["city"], "当地")

    def test_summary(self):
        text = cards.weather_summary("广州", cards.parse_open_meteo(open_meteo_fixture()))
        self.assertTrue(text.startswith("广州现在毛毛雨,29度,湿度百分之77。今天雷雨冰雹,24到32度。明天雷阵雨,25到32度。"))
        self.assertIn("不要逐项念数字", text)


class Volume(unittest.TestCase):
    def test_level(self):
        self.assertEqual(cards.volume_command(60), ({"cmd": "volume", "value": 60}, "好的，音量调到百分之六十。"))
        self.assertEqual(cards.volume_command("50%")[0], {"cmd": "volume", "value": 50})
        self.assertEqual(cards.volume_command(150), ({"cmd": "volume", "value": 100}, "好的，音量调到最大了。"))
        self.assertEqual(cards.volume_command(-5), ({"cmd": "volume", "value": 0}, "好的，已经静音了。"))
        self.assertEqual(cards.volume_command(30, "down")[0], {"cmd": "volume", "value": 30})   # 数值优先

    def test_change(self):
        self.assertEqual(cards.volume_command(None, "up"), ({"cmd": "volume", "delta": 20}, "好，声音大一点了。"))
        self.assertEqual(cards.volume_command(None, "DOWN")[0], {"cmd": "volume", "delta": -20})
        self.assertEqual(cards.volume_command("abc", "调大")[0], {"cmd": "volume", "delta": 20})
        self.assertEqual(cards.volume_command(None, "小声点")[0], {"cmd": "volume", "delta": -20})
        self.assertEqual(cards.volume_command(None, None), (None, "你想把声音调大还是调小？"))
        self.assertEqual(cards.volume_command(True, "sideways")[0], None)


class Push(unittest.TestCase):
    def test_skips_devices_without_feature(self):
        for features in (None, {}, {"mcp": True}, "xiaodan"):
            conn = FakeConn(features)
            self.assertFalse(asyncio.run(cards.push(conn, {"cmd": "volume", "value": 1})))
            self.assertFalse(asyncio.run(cards.push_emotion(conn)))
            self.assertEqual(conn.websocket.sent, [])

    def test_sends_flat_utf8_json(self):
        conn = FakeConn({"xiaodan": True})
        card = cards.calendar_card(dt.date(2026, 9, 14), "七月廿三")
        self.assertTrue(asyncio.run(cards.push(conn, card)))
        text = conn.websocket.sent[0]
        self.assertIn("七月廿三", text)   # 不转义成 \\u,设备按 UTF-8 直接拷贝
        message = json.loads(text)
        self.assertEqual(message["type"], "xiaodan")
        self.assertEqual(message["cmd"], "calendar")
        self.assertEqual(message["session_id"], "s-1")
        self.assertTrue(all(not isinstance(v, (dict, list)) for v in message.values()), "消息必须是扁平的")
        self.assertNotIn("type", card, "不能改动调用方的字典")

    def test_emotion(self):
        conn = FakeConn({"xiaodan": True})
        self.assertTrue(asyncio.run(cards.push_emotion(conn, "happy")))
        self.assertEqual(json.loads(conn.websocket.sent[0])["emotion"], "happy")
        muted = FakeConn({"xiaodan": True, "emoji": False})
        self.assertFalse(asyncio.run(cards.push_emotion(muted)))

    def test_send_failure_is_swallowed(self):
        conn = FakeConn({"xiaodan": True}, fail=True)
        self.assertFalse(asyncio.run(cards.push(conn, {"cmd": "volume", "delta": 20})))

    def test_plugin_config(self):
        self.assertEqual(cards.plugin_config(FakeConn(plugins={"get_weather": {"hold_s": 9}}), "get_weather"), {"hold_s": 9})
        self.assertEqual(cards.plugin_config(FakeConn(plugins={"get_weather": "{}"}), "get_weather"), {})
        self.assertEqual(cards.plugin_config(object(), "get_weather"), {})


if __name__ == "__main__":
    unittest.main()
