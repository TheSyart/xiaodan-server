"""小单设备的日历、天气、音量卡片:纯逻辑与推送。

本文件被复制到引擎镜像的 plugins_func/functions/ 下,由 show_calendar.py、get_weather.py、
set_volume.py 三个插件共用。它刻意【不】导入引擎的任何模块,也不依赖第三方库(农历库按需导入),
所以能在仓库里直接用标准库跑单元测试(server/tests/)。引擎启动时会自动导入这个目录下的所有模块;
本模块不注册任何函数,被导入没有副作用。

与设备的约定(固件 main/xd_proto.c 按同样的范围校验,越界的整条丢弃):
  {"type":"xiaodan","cmd":"calendar","year","month","day","weekday","first_weekday","days","lunar","hold_s"}
  {"type":"xiaodan","cmd":"weather","city","icon","text","temp","hi","lo","humidity",
                     "tm_icon","tm_text","tm_hi","tm_lo","hold_s"}
  {"type":"xiaodan","cmd":"volume","value"}  或  {"type":"xiaodan","cmd":"volume","delta"}
weekday 以 0 表示星期日。字符串按 UTF-8 字节数截断在字符边界上:设备屏幕一行只放得下六七个汉字。
只推给在 hello 里声明了 features.xiaodan 的设备,原版小智固件不会收到它不认识的消息。
"""

import calendar as _calendar
import datetime as _dt
import json
import math
import re
import time
from typing import Callable, NamedTuple, Optional, Tuple
from urllib.parse import quote

HOLD_DEFAULT_S = 20
HOLD_MIN_S = 5
HOLD_MAX_S = 60
TEMP_MIN = -40
TEMP_MAX = 60
CITY_MAX_BYTES = 18    # 设备缓冲 19 字节:六个汉字
TEXT_MAX_BYTES = 18
LUNAR_MAX_BYTES = 24   # 八个汉字
YEAR_MIN = 1970
YEAR_MAX = 2199
VOLUME_STEP = 20

ICONS = ("sun", "partly", "cloudy", "fog", "rain", "thunder", "snow")
UNKNOWN_WEATHER = ("cloudy", "未知")

WEATHER_UNAVAILABLE = "天气服务暂时连不上,没有查到。请告诉用户稍后再试。"

_WEEKDAY_SPOKEN = ("星期天", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六")
_DIGITS = "零一二三四五六七八九"

# 天气文案只用 GB2312 一级汉字:设备字库只收了这些,二级字(比如"雾凇"的凇)会显示成方块。
# WMO 天气码,Open-Meteo 使用:https://open-meteo.com/en/docs 的 "WMO Weather interpretation codes"
_WMO = {
    0: ("sun", "晴"), 1: ("sun", "晴"), 2: ("partly", "多云"), 3: ("cloudy", "阴"),
    45: ("fog", "雾"), 48: ("fog", "雾"),
    51: ("rain", "毛毛雨"), 53: ("rain", "毛毛雨"), 55: ("rain", "毛毛雨"),
    56: ("rain", "冻雨"), 57: ("rain", "冻雨"),
    61: ("rain", "小雨"), 63: ("rain", "中雨"), 65: ("rain", "大雨"),
    66: ("rain", "冻雨"), 67: ("rain", "冻雨"),
    71: ("snow", "小雪"), 73: ("snow", "中雪"), 75: ("snow", "大雪"), 77: ("snow", "雪粒"),
    80: ("rain", "阵雨"), 81: ("rain", "阵雨"), 82: ("rain", "强阵雨"),
    85: ("snow", "阵雪"), 86: ("snow", "强阵雪"),
    95: ("thunder", "雷阵雨"), 96: ("thunder", "雷雨冰雹"), 99: ("thunder", "雷雨冰雹"),
}

# WWO 天气码,wttr.in 使用(源自 World Weather Online)。
_WWO = {
    113: ("sun", "晴"), 116: ("partly", "多云"), 119: ("cloudy", "多云"), 122: ("cloudy", "阴"),
    143: ("fog", "薄雾"), 248: ("fog", "雾"), 260: ("fog", "冻雾"),
    176: ("rain", "零星小雨"), 263: ("rain", "毛毛雨"), 266: ("rain", "毛毛雨"),
    293: ("rain", "小雨"), 296: ("rain", "小雨"), 299: ("rain", "中雨"), 302: ("rain", "中雨"),
    305: ("rain", "大雨"), 308: ("rain", "暴雨"), 353: ("rain", "小阵雨"), 356: ("rain", "阵雨"),
    359: ("rain", "暴雨"),
    185: ("rain", "冻雨"), 281: ("rain", "冻雨"), 284: ("rain", "冻雨"), 311: ("rain", "冻雨"),
    314: ("rain", "冻雨"),
    179: ("snow", "零星小雪"), 182: ("snow", "雨夹雪"), 317: ("snow", "雨夹雪"), 320: ("snow", "雨夹雪"),
    362: ("snow", "雨夹雪"), 365: ("snow", "雨夹雪"), 227: ("snow", "风雪"), 230: ("snow", "暴风雪"),
    323: ("snow", "小雪"), 326: ("snow", "小雪"), 329: ("snow", "中雪"), 332: ("snow", "中雪"),
    335: ("snow", "大雪"), 338: ("snow", "大雪"), 350: ("snow", "冰粒"), 368: ("snow", "小阵雪"),
    371: ("snow", "阵雪"), 374: ("snow", "冰粒"), 377: ("snow", "冰粒"),
    200: ("thunder", "雷阵雨"), 386: ("thunder", "雷阵雨"), 389: ("thunder", "雷雨"),
    392: ("thunder", "雷阵雪"), 395: ("thunder", "雷阵雪"),
}


# ---------------------------------------------------------------- 通用小工具

def truncate_utf8(text, max_bytes: int) -> str:
    """按 UTF-8 字节数截断,只在字符边界上断开。"""
    out = []
    used = 0
    for ch in str(text or ""):
        size = len(ch.encode("utf-8"))
        if used + size > max_bytes:
            break
        out.append(ch)
        used += size
    return "".join(out)


def to_number(value) -> Optional[float]:
    """模型给的参数可能是数字、数字字符串或带百分号的字符串;布尔值与无穷大一律不算数。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip().rstrip("%").strip()
        try:
            number = float(text)
        except ValueError:
            return None
    return number if math.isfinite(number) else None


def round_half_up(number: float) -> int:
    """四舍五入。内置 round 是银行家舍入,27.5 会变成 28 而 26.5 变成 26。"""
    return int(math.floor(number + 0.5))


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def clamp_hold(value) -> int:
    """卡片停留秒数。缺省、非数字或不为正都用默认值。"""
    number = to_number(value)
    if number is None or number <= 0:
        return HOLD_DEFAULT_S
    return clamp(round_half_up(number), HOLD_MIN_S, HOLD_MAX_S)


def cn_int(number: int) -> str:
    """0 到 100 的口语读法:14 读作十四,20 读作二十。超出范围给阿拉伯数字。"""
    if number < 0 or number > 100:
        return str(number)
    if number == 100:
        return "一百"
    if number < 10:
        return _DIGITS[number]
    tens, ones = divmod(number, 10)
    head = "十" if tens == 1 else _DIGITS[tens] + "十"
    return head + (_DIGITS[ones] if ones else "")


def cn_digits(number: int) -> str:
    """年份逐位读:2026 读作二零二六。"""
    return "".join(_DIGITS[int(ch)] for ch in str(abs(int(number))))


class TtlCache:
    """带过期时间的小缓存。引擎是单进程,多条连接共用;满了淘汰最早过期的一项。"""

    def __init__(self, ttl_s: float, max_items: int = 128, clock: Callable[[], float] = time.monotonic):
        self._ttl_s = ttl_s
        self._max_items = max_items
        self._clock = clock
        self._items = {}

    def get(self, key):
        entry = self._items.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if self._clock() >= expires_at:
            del self._items[key]
            return None
        return value

    def put(self, key, value) -> None:
        if key not in self._items and len(self._items) >= self._max_items:
            oldest = min(self._items, key=lambda k: self._items[k][0])
            del self._items[oldest]
        self._items[key] = (self._clock() + self._ttl_s, value)


# ---------------------------------------------------------------- 推送

def plugin_config(conn, name: str) -> dict:
    """控制塔下发的插件参数。引擎已经把 JSON 字符串解析成字典。"""
    config = getattr(conn, "config", None)
    plugins = config.get("plugins") if isinstance(config, dict) else None
    value = plugins.get(name) if isinstance(plugins, dict) else None
    return value if isinstance(value, dict) else {}


def _features(conn) -> dict:
    features = getattr(conn, "features", None)
    return features if isinstance(features, dict) else {}


def device_supports_cards(conn) -> bool:
    return bool(_features(conn).get("xiaodan"))


def _warn(conn, text: str) -> None:
    logger = getattr(conn, "logger", None)
    try:
        logger.bind(tag=__name__).warning(text)
    except Exception:
        pass


async def _send(conn, message: dict) -> bool:
    session_id = getattr(conn, "session_id", None)
    if session_id:
        message["session_id"] = session_id
    try:
        await conn.websocket.send(json.dumps(message, ensure_ascii=False))
        return True
    except Exception as exc:  # 连接刚断之类:卡片只是锦上添花,语音回答照常
        _warn(conn, f"推送 {message.get('type')}/{message.get('cmd', '')} 失败: {exc}")
        return False


def _info(conn, text: str) -> None:
    logger = getattr(conn, "logger", None)
    try:
        logger.bind(tag=__name__).info(text)
    except Exception:
        pass


async def push(conn, payload: dict) -> bool:
    """把一张卡片推给设备。设备没声明支持时什么都不发,返回 False。

    两种结果都写日志:卡片没出现在屏幕上时,先看引擎日志里是"已推送"还是"设备没声明",
    就能分清是服务端没发,还是设备收到后没显示。
    """
    cmd = payload.get("cmd", "")
    if not device_supports_cards(conn):
        declared = sorted(_features(conn).keys())
        _warn(conn, f"设备没有声明 features.xiaodan,不推送 {cmd} 卡片(设备声明的特性: {declared})")
        return False
    message = {"type": "xiaodan"}
    message.update(payload)
    sent = await _send(conn, message)
    if sent:
        _info(conn, f"已向设备推送 {cmd} 卡片")
    return sent


_EMOTION_EMOJI = {"happy": "🙂", "neutral": "😶", "thinking": "🤔"}


async def push_emotion(conn, emotion: str = "happy") -> bool:
    """工具直接给出回答(不再经过模型)时,引擎不会发情绪消息,由插件补一条,设备表情才不会停在"思考"。"""
    if not device_supports_cards(conn) or _features(conn).get("emoji", True) is False:
        return False
    return await _send(conn, {"type": "llm", "text": _EMOTION_EMOJI.get(emotion, "🙂"), "emotion": emotion})


# ---------------------------------------------------------------- 日历

_DATE_RE = re.compile(r"^\s*(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?\s*$")


def weekday_sun0(day: _dt.date) -> int:
    """0 = 星期日。Python 的 weekday() 以星期一为 0。"""
    return (day.weekday() + 1) % 7


def parse_date(text: str, today: _dt.date) -> Optional[_dt.date]:
    """接受 2026-10-01、2026/10/1、2026年10月1日、10-01、10月1号;没写年份就是今年。"""
    match = _DATE_RE.match(str(text))
    if not match:
        return None
    year = int(match.group(1)) if match.group(1) else today.year
    try:
        day = _dt.date(year, int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None
    return day if YEAR_MIN <= day.year <= YEAR_MAX else None


def resolve_day(today: _dt.date, date_text=None, offset_days=None) -> Tuple[Optional[_dt.date], str]:
    """返回 (日期, 错误说明)。date 优先于 offset_days;两个都没给就是今天。"""
    if date_text not in (None, ""):
        day = parse_date(str(date_text), today)
        if day is None:
            return None, f"没能识别日期「{date_text}」。请让用户换个说法,比如说几月几号。"
        return day, ""
    if offset_days not in (None, ""):
        number = to_number(offset_days)
        if number is None or number != int(number) or abs(number) > 3660:
            return None, "没能识别要查哪一天。请让用户换个说法,比如说几月几号。"
        day = today + _dt.timedelta(days=int(number))
        if not YEAR_MIN <= day.year <= YEAR_MAX:
            return None, "这一天超出了能查的范围。"
        return day, ""
    return today, ""


def lunar_text(day: _dt.date) -> str:
    """农历月日,如"七月廿三"。引擎镜像里有 cnlunar(上游 get_lunar 插件在用);缺库或出错时返回空串。"""
    try:
        import cnlunar

        lunar = cnlunar.Lunar(_dt.datetime(day.year, day.month, day.day, 12), godType="8char")
        month = str(lunar.lunarMonthCn)
        if month[-1:] in ("大", "小"):   # "七月小" 表示小月
            month = month[:-1]
        return truncate_utf8(month + str(lunar.lunarDayCn), LUNAR_MAX_BYTES)
    except Exception:
        return ""


def lunar_for_speech(lunar: str) -> str:
    """"廿""卅"交给语音合成容易读错,换成普通数字写法。"""
    return str(lunar or "").replace("廿", "二十").replace("卅", "三十")


def calendar_card(day: _dt.date, lunar: str = "", hold_s=HOLD_DEFAULT_S) -> dict:
    return {
        "cmd": "calendar",
        "year": day.year,
        "month": day.month,
        "day": day.day,
        "weekday": weekday_sun0(day),
        "first_weekday": weekday_sun0(day.replace(day=1)),
        "days": _calendar.monthrange(day.year, day.month)[1],
        "lunar": truncate_utf8(lunar, LUNAR_MAX_BYTES),
        "hold_s": clamp_hold(hold_s),
    }


def calendar_speech(day: _dt.date, today: _dt.date, lunar: str = "") -> str:
    """直接播报的一句话。数字写成汉字,语音合成不会把"9月14号"念成"九一四"。"""
    words = f"{cn_int(day.month)}月{cn_int(day.day)}号"
    if day.year != today.year:
        words = f"{cn_digits(day.year)}年{words}"
    weekday = _WEEKDAY_SPOKEN[weekday_sun0(day)]
    named = {0: "今天", 1: "明天", 2: "后天", -1: "昨天", -2: "前天"}.get((day - today).days)
    text = f"{named}是{words}，{weekday}" if named else f"{words}是{weekday}"
    spoken_lunar = lunar_for_speech(lunar)
    if spoken_lunar:
        text += f"，农历{spoken_lunar}"
    return text + "。"


# ---------------------------------------------------------------- 天气

def wmo_to_card(code) -> Tuple[str, str]:
    number = to_number(code)
    return _WMO.get(int(number), UNKNOWN_WEATHER) if number is not None else UNKNOWN_WEATHER


def wwo_to_card(code) -> Tuple[str, str]:
    number = to_number(code)
    return _WWO.get(int(number), UNKNOWN_WEATHER) if number is not None else UNKNOWN_WEATHER


def clean_location(text) -> str:
    """去掉模型偶尔带进参数里的"天气""的天气"等尾巴与空白。"""
    value = re.sub(r"\s+", "", str(text or ""))
    value = re.sub(r"(的)?(天气|气温|温度)(预报|怎么样|如何)?$", "", value)
    return value


def open_meteo_geocode_url(name: str) -> str:
    return ("https://geocoding-api.open-meteo.com/v1/search?name=" + quote(name)
            + "&count=10&language=zh&format=json")


def open_meteo_forecast_url(latitude: float, longitude: float) -> str:
    return ("https://api.open-meteo.com/v1/forecast"
            f"?latitude={latitude:.4f}&longitude={longitude:.4f}"
            "&current=temperature_2m,relative_humidity_2m,weather_code"
            "&daily=weather_code,temperature_2m_max,temperature_2m_min"
            "&timezone=auto&forecast_days=2")


def wttr_url(name: str) -> str:
    return f"https://wttr.in/{quote(name)}?format=j1&lang=zh"


def geocode_candidates(city: str) -> Tuple[str, ...]:
    """Open-Meteo 的中文地名不带行政区划后缀:"广州市"查不到,"广州"查得到。"""
    names = [city]
    if len(city) > 2 and city[-1] in "市区县省":
        names.append(city[:-1])
    return tuple(names)


class Place(NamedTuple):
    name: str
    latitude: float
    longitude: float
    confident: bool


# 地物类型:首都、省级、地级、县级、乡级行政中心;其余居民点排在后面,山、机场、公园不算城市。
_FEATURE_RANK = {"PPLC": 0, "PPLA": 1, "PPLA2": 2, "PPLA3": 3, "PPLA4": 4}
_CONFIDENT_POPULATION = 50000


def rank_geocode(data) -> Optional[Place]:
    """从地理编码结果里挑最像城市的一个,没有返回 None。

    用中文名查外国城市时,Open-Meteo 只会返回同名的中国村庄("东京"得到江苏的一个村,"纽约"什么也没有)。
    所以只有县级以上行政中心或人口过五万的地方才算可信;不可信时调用方先试能认中文外国地名的 wttr.in。
    """
    results = data.get("results") if isinstance(data, dict) else None
    best = None
    for index, item in enumerate(results or []):
        if not isinstance(item, dict):
            continue
        feature = str(item.get("feature_code") or "")
        if not feature.startswith("PPL"):
            continue
        try:
            latitude = float(item["latitude"])
            longitude = float(item["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        population = to_number(item.get("population")) or 0
        rank = _FEATURE_RANK.get(feature, 5)
        key = (rank, -population, index)
        if best is None or key < best[0]:
            confident = rank <= 3 or population >= _CONFIDENT_POPULATION
            best = (key, Place(str(item.get("name") or ""), latitude, longitude, confident))
    return best[1] if best else None


def _humidity(value) -> Optional[int]:
    number = to_number(value)
    if number is None:
        return None
    humidity = round_half_up(number)
    return humidity if 0 <= humidity <= 100 else None


def _day(icon_text: Tuple[str, str], high, low) -> dict:
    hi = to_number(high)
    lo = to_number(low)
    if hi is None or lo is None:
        raise ValueError("缺少最高或最低气温")
    if hi < lo:
        hi, lo = lo, hi
    return {"icon": icon_text[0], "text": icon_text[1], "hi": hi, "lo": lo}


def _optional_day(build) -> Optional[dict]:
    try:
        return build()
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def parse_open_meteo(data) -> dict:
    """把 Open-Meteo 的 forecast 响应整理成统一形状。今天或当前数据缺失时抛 ValueError,调用方转用备用源。"""
    try:
        current = data["current"]
        daily = data["daily"]
        temp = to_number(current["temperature_2m"])
        if temp is None:
            raise ValueError("缺少当前气温")
        icon, text = wmo_to_card(current["weather_code"])
        codes = daily["weather_code"]
        highs = daily["temperature_2m_max"]
        lows = daily["temperature_2m_min"]
        today = _day(wmo_to_card(codes[0]), highs[0], lows[0])
        tomorrow = _optional_day(lambda: _day(wmo_to_card(codes[1]), highs[1], lows[1]))
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ValueError(f"Open-Meteo 响应格式不对: {exc!r}") from exc
    return {
        "source": "open-meteo",
        "temp": temp,
        "humidity": _humidity(current.get("relative_humidity_2m")),
        "icon": icon,
        "text": text,
        "today": today,
        "tomorrow": tomorrow,
    }


def _wttr_day(day: dict) -> dict:
    hourly = day.get("hourly") or []
    # 一天 8 个三小时时段,取中午那段的天气代表全天
    icon_text = wwo_to_card(hourly[min(4, len(hourly) - 1)].get("weatherCode")) if hourly else UNKNOWN_WEATHER
    return _day(icon_text, day.get("maxtempC"), day.get("mintempC"))


def parse_wttr(data) -> dict:
    """把 wttr.in 的 format=j1 响应整理成与 parse_open_meteo 相同的形状。"""
    try:
        current = data["current_condition"][0]
        temp = to_number(current["temp_C"])
        if temp is None:
            raise ValueError("缺少当前气温")
        icon, text = wwo_to_card(current.get("weatherCode"))
        days = data["weather"]
        today = _wttr_day(days[0])
        tomorrow = _optional_day(lambda: _wttr_day(days[1]))
    except (KeyError, IndexError, TypeError, ValueError, AttributeError) as exc:
        raise ValueError(f"wttr.in 响应格式不对: {exc!r}") from exc
    return {
        "source": "wttr",
        "temp": temp,
        "humidity": _humidity(current.get("humidity")),
        "icon": icon,
        "text": text,
        "today": today,
        "tomorrow": tomorrow,
    }


def temp_int(value: float) -> int:
    return clamp(round_half_up(value), TEMP_MIN, TEMP_MAX)


def weather_card(city: str, obs: dict, hold_s=HOLD_DEFAULT_S) -> dict:
    today = obs["today"]
    card = {
        "cmd": "weather",
        "city": truncate_utf8(city, CITY_MAX_BYTES) or "当地",
        "icon": obs["icon"],
        "text": truncate_utf8(obs["text"], TEXT_MAX_BYTES),
        "temp": temp_int(obs["temp"]),
        "hi": temp_int(today["hi"]),
        "lo": temp_int(today["lo"]),
    }
    if obs.get("humidity") is not None:
        card["humidity"] = obs["humidity"]
    tomorrow = obs.get("tomorrow")
    if tomorrow:
        card["tm_icon"] = tomorrow["icon"]
        card["tm_text"] = truncate_utf8(tomorrow["text"], TEXT_MAX_BYTES)
        card["tm_hi"] = temp_int(tomorrow["hi"])
        card["tm_lo"] = temp_int(tomorrow["lo"])
    card["hold_s"] = clamp_hold(hold_s)
    return card


def weather_summary(city: str, obs: dict, shown: bool = True) -> str:
    """交给模型的工具结果。给足事实,让它自己组织成一两句口语。

    shown 是卡片是否真的推给了设备。没推成功时不能告诉模型"屏幕上已经显示",
    否则它会对着一块什么都没有的屏幕说"已经显示在屏幕上了"。
    """
    now = f"{city}现在{obs['text']},{temp_int(obs['temp'])}度"
    if obs.get("humidity") is not None:
        now += f",湿度百分之{obs['humidity']}"
    today = obs["today"]
    parts = [now, f"今天{today['text']},{temp_int(today['lo'])}到{temp_int(today['hi'])}度"]
    tomorrow = obs.get("tomorrow")
    if tomorrow:
        parts.append(f"明天{tomorrow['text']},{temp_int(tomorrow['lo'])}到{temp_int(tomorrow['hi'])}度")
    screen = "设备屏幕上已经显示了这些数据。" if shown else ""
    return ("。".join(parts) + "。" + screen +
            "请用一两句口语回答用户的问题,需要时提醒带伞或添减衣服;不要逐项念数字,不要提到工具,也不要说屏幕上显示了什么。")


def weather_not_found(city: str) -> str:
    return f"没有找到叫「{city}」的地方。请让用户说一个城市的名字。"


# ---------------------------------------------------------------- 音量

_UP_WORDS = ("up", "louder", "increase", "大", "高", "加", "响")
_DOWN_WORDS = ("down", "quieter", "decrease", "lower", "小", "低", "减", "轻")


def _direction(change) -> int:
    text = str(change or "").strip().lower()
    if not text:
        return 0
    if any(word in text for word in _DOWN_WORDS):
        return -1
    if any(word in text for word in _UP_WORDS):
        return 1
    return 0


def volume_command(level=None, change=None) -> Tuple[Optional[dict], str]:
    """返回 (推给设备的内容, 播报的话)。给了具体数值就按数值;否则按调大调小走一档;都没有就反问。"""
    number = to_number(level)
    if number is not None:
        value = clamp(round_half_up(number), 0, 100)
        if value == 0:
            speech = "好的，已经静音了。"
        elif value == 100:
            speech = "好的，音量调到最大了。"
        else:
            speech = f"好的，音量调到百分之{cn_int(value)}。"
        return {"cmd": "volume", "value": value}, speech
    direction = _direction(change)
    if direction > 0:
        return {"cmd": "volume", "delta": VOLUME_STEP}, "好，声音大一点了。"
    if direction < 0:
        return {"cmd": "volume", "delta": -VOLUME_STEP}, "好，声音小一点了。"
    return None, "你想把声音调大还是调小？"
