"""在真实的引擎镜像里把自写插件跑一遍。CI 冒烟用,不属于单元测试(文件名不以 test 开头,discover 不会收它)。

    docker exec -i <引擎容器> python - < server/tests/smoke_plugins.py

要在已经加载了配置的引擎容器里执行:插件导入时会初始化引擎的日志模块,它要读 data/.config.yaml。
证明的是单元测试证明不了的那部分:按引擎自己的方式导入整个插件目录不报错,注册表里有这几个函数,
日历与音量真的推出了设备收得下的消息,告别不再断开连接,镜像里的农历库能用。
天气要访问外部服务,流水线里只验证它注册成功,不发请求。
"""

import asyncio
import importlib
import json

from plugins_func.loadplugins import auto_import_modules
from plugins_func.register import Action, all_function_registry

auto_import_modules("plugins_func.functions")

for name in ("show_calendar", "get_weather", "set_volume", "handle_exit_intent", "get_lunar"):
    assert name in all_function_registry, f"注册表里没有 {name}"


class Socket:
    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(json.loads(text))


class Conn:
    def __init__(self, features):
        self.features = features
        self.config = {"plugins": {"show_calendar": {"hold_s": "9"}}}
        self.websocket = Socket()
        self.session_id = "smoke"
        self.close_after_chat = False


def cards_of(conn):
    return [message for message in conn.websocket.sent if message.get("type") == "xiaodan"]


conn = Conn({"xiaodan": True})
result = asyncio.run(all_function_registry["show_calendar"].func(conn))
assert result.action == Action.RESPONSE and result.response.startswith("今天是"), result.response
calendar = cards_of(conn)[0]
assert calendar["cmd"] == "calendar" and calendar["hold_s"] == 9, calendar
assert calendar["lunar"], "镜像里的 cnlunar 应该能算出农历"
assert any(message.get("type") == "llm" for message in conn.websocket.sent), "直接回答时应补发情绪"

result = asyncio.run(all_function_registry["set_volume"].func(conn, level=55))
assert result.action == Action.RESPONSE, result.action
assert cards_of(conn)[-1] == {"type": "xiaodan", "cmd": "volume", "value": 55, "session_id": "smoke"}, cards_of(conn)

stock = Conn({"mcp": True})
result = asyncio.run(all_function_registry["set_volume"].func(stock, change="up"))
assert stock.websocket.sent == [] and "按键" in result.response, "原版固件不应收到卡片消息"

result = all_function_registry["handle_exit_intent"].func(conn, say_goodbye="拜拜")
assert result.action == Action.RESPONSE and result.response == "拜拜" and conn.close_after_chat is False

weather = importlib.import_module("plugins_func.functions.get_weather")
behind_proxy = Conn({"xiaodan": True})
behind_proxy.client_ip = "172.18.0.1"   # nginx 没转发 X-Real-IP 时引擎看到的是容器网关
assert asyncio.run(weather._device_city(behind_proxy)) is None, "内网地址不应去查城市"
assert getattr(behind_proxy, weather._SESSION_CITY) is None, "同一会话不应重复判断"

description = all_function_registry["get_weather"].description["function"]
assert "location" in description["parameters"]["properties"] and "lang" not in description["parameters"]["properties"]

print("plugins ok:", calendar["year"], calendar["month"], calendar["day"], calendar["lunar"])
