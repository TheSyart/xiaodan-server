"""日历:在设备屏幕上显示当月日历,并直接播报日期、星期与农历。

不联网,也不需要模型再组织一次语言:结果用 Action.RESPONSE 直接交给语音合成,比让模型复述快一整轮。
上游没有查公历日期的函数(get_time.py 里只注册了农历的 get_lunar),日期原本靠提示词里的变量,
模型会直接口答,屏幕上什么也看不到。所以提示词与本函数的描述都要求问日期时必须调用它。
"""

import datetime

from config.logger import setup_logging
from plugins_func.functions import xiaodan_cards as cards
from plugins_func.register import Action, ActionResponse, ToolType, register_function

TAG = __name__
logger = setup_logging()

SHOW_CALENDAR_FUNCTION_DESC = {
    "type": "function",
    "function": {
        "name": "show_calendar",
        "description": (
            "查日期并在设备屏幕上显示日历。用户问今天或某一天是几号、星期几、农历几号,或者想看日历时,"
            "必须调用本工具,由它显示并播报,不要自己口头回答日期。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "要查的日期,格式 YYYY-MM-DD。问今天时不传",
                },
                "offset_days": {
                    "type": "integer",
                    "description": "相对今天的天数:明天 1,后天 2,昨天 -1。与 date 二选一",
                },
            },
            "required": [],
        },
    },
}


@register_function("show_calendar", SHOW_CALENDAR_FUNCTION_DESC, ToolType.SYSTEM_CTL)
async def show_calendar(conn, date: str = None, offset_days: int = None, **_ignored):
    # 镜像设置了 TZ=Asia/Shanghai,本地日期就是用户的日期
    today = datetime.date.today()
    day, error = cards.resolve_day(today, date, offset_days)
    if day is None:
        return ActionResponse(Action.REQLLM, error, None)

    lunar = cards.lunar_text(day)
    config = cards.plugin_config(conn, "show_calendar")
    await cards.push(conn, cards.calendar_card(day, lunar, config.get("hold_s")))
    await cards.push_emotion(conn, "happy")
    speech = cards.calendar_speech(day, today, lunar)
    logger.bind(tag=TAG).info(f"日历 {day.isoformat()}")
    return ActionResponse(Action.RESPONSE, None, speech)
