"""天气:查 Open-Meteo 或 wttr.in,在设备屏幕上显示天气卡片,再让模型口语总结。

覆盖上游同名插件。上游版本先调和风的城市查询接口再抓取网页,靠一个写死的共享密钥,
网页一改版就失效;不说城市时按客户端 IP 定位,又要调第三方 whois 接口,而我们的 nginx 并不透传真实 IP。
这里两个数据源都不需要密钥,没说城市时用插件参数里的默认城市。解析与文案在 xiaodan_cards.py,那里有单元测试。

选源规则(2026-09-14 实测后定的):
  - Open-Meteo 为主:结构化 JSON,含逐日预报。但它的中文地名库只认中国地名,"广州市"要去掉"市"才查得到,
    "东京"只会得到江苏的一个同名村子。所以地理编码结果不可信(不是县级以上行政中心、人口也不多)时先试 wttr.in。
  - wttr.in 兜底:能按中文名认出外国城市,找不到地点时回 HTTP 500;但它是个人维护的服务,从国内访问时快时慢。
卡片与回答里的地名一律用用户说的原话:接口返回的名字可能是繁体或英文,设备字库显示不了。

插件运行在引擎的事件循环里(插件执行器直接 await 它),所以网络请求必须用 httpx 的异步客户端:
换成 requests,查天气的几秒钟里这台服务器上所有设备的对话都会卡住。

上游的提示词管理器在模板里用到 {{weather_info}} 时也会调这个函数(带 lang 参数)。
我们的模板没用它,签名仍保持兼容。
"""

import httpx

from config.logger import setup_logging
from plugins_func.functions import xiaodan_cards as cards
from plugins_func.register import Action, ActionResponse, ToolType, register_function

TAG = __name__
logger = setup_logging()

GET_WEATHER_FUNCTION_DESC = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": (
            "查询天气,并在设备屏幕上显示天气画面。用户问天气、气温、会不会下雨、要不要带伞、穿什么时调用。"
            "用户没说地点时不要传 location,会用默认城市。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "地点。中国的城市或区县用中文,例如杭州、海淀;外国城市用英文,例如 Tokyo。用户没说就不传",
                },
            },
            "required": [],
        },
    },
}

_TIMEOUT = httpx.Timeout(6.0, connect=4.0)
_HEADERS = {"User-Agent": "xiaodan-server/1.0"}
# 地点坐标几乎不变,缓存久一些;十分钟内反复问同一个地方的天气不再请求。
_GEOCODE_CACHE = cards.TtlCache(ttl_s=30 * 86400, max_items=256)
_WEATHER_CACHE = cards.TtlCache(ttl_s=600, max_items=128)
_NOT_FOUND = object()


async def _get_json(client: httpx.AsyncClient, url: str):
    response = await client.get(url, headers=_HEADERS)
    response.raise_for_status()
    return response.json()


async def _geocode(client: httpx.AsyncClient, city: str):
    for name in cards.geocode_candidates(city):
        place = _GEOCODE_CACHE.get(name)
        if place is None:
            place = cards.rank_geocode(await _get_json(client, cards.open_meteo_geocode_url(name)))
            if place is not None:
                _GEOCODE_CACHE.put(name, place)
        if place is not None:
            return place
    return None


async def _from_open_meteo(client: httpx.AsyncClient, city: str, place: cards.Place):
    data = await _get_json(client, cards.open_meteo_forecast_url(place.latitude, place.longitude))
    return city, cards.parse_open_meteo(data)


async def _from_wttr(client: httpx.AsyncClient, city: str):
    return city, cards.parse_wttr(await _get_json(client, cards.wttr_url(city)))


async def _lookup(city: str):
    """返回 (地名, 观测数据);确认没有这个地方时返回 _NOT_FOUND;两个源都连不上时抛异常。"""
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        place = None
        open_meteo_ok = True
        try:
            place = await _geocode(client, city)
        except Exception as exc:
            open_meteo_ok = False
            logger.bind(tag=TAG).warning(f"Open-Meteo 查地点「{city}」失败: {exc!r}")

        if place is not None and place.confident:
            try:
                return await _from_open_meteo(client, city, place)
            except Exception as exc:
                open_meteo_ok = False
                logger.bind(tag=TAG).warning(f"Open-Meteo 查天气「{city}」失败: {exc!r}")

        try:
            return await _from_wttr(client, city)
        except Exception as exc:
            logger.bind(tag=TAG).warning(f"wttr.in 查「{city}」失败: {exc!r}")

        if open_meteo_ok and place is not None:
            # 不太可信的同名地点,总比什么都没有好
            return await _from_open_meteo(client, city, place)
        if open_meteo_ok:
            return _NOT_FOUND
        raise RuntimeError("Open-Meteo 与 wttr.in 都不可用")


@register_function("get_weather", GET_WEATHER_FUNCTION_DESC, ToolType.SYSTEM_CTL)
async def get_weather(conn, location: str = None, **_ignored):
    config = cards.plugin_config(conn, "get_weather")
    city = cards.clean_location(location) or cards.clean_location(config.get("default_location")) or "广州"

    result = _WEATHER_CACHE.get(city)
    if result is None:
        try:
            result = await _lookup(city)
        except Exception as exc:
            logger.bind(tag=TAG).error(f"查询「{city}」天气失败: {exc!r}")
            return ActionResponse(Action.REQLLM, cards.WEATHER_UNAVAILABLE, None)
        if result is _NOT_FOUND:
            return ActionResponse(Action.REQLLM, cards.weather_not_found(city), None)
        _WEATHER_CACHE.put(city, result)

    name, observation = result
    shown = await cards.push(conn, cards.weather_card(name, observation, config.get("hold_s")))
    logger.bind(tag=TAG).info(f"天气「{name}」来自 {observation['source']},卡片{'已推送' if shown else '未推送'}")
    return ActionResponse(Action.REQLLM, cards.weather_summary(name, observation, shown), None)
