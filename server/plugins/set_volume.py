"""音量:让设备调节播放音量,并直接播报结果。

设备收到 {"type":"xiaodan","cmd":"volume"} 后走与实体按键完全相同的路径:立即生效、屏幕短暂提示、
停手约两秒后在不出声时写入闪存。服务端不知道设备当前音量,所以"大声点"只下发一个增量,由设备自己夹取。
没声明支持卡片消息的设备(比如原版小智固件)收不到这条消息,这时如实告诉用户用按键调。
"""

from config.logger import setup_logging
from plugins_func.functions import xiaodan_cards as cards
from plugins_func.register import Action, ActionResponse, ToolType, register_function

TAG = __name__
logger = setup_logging()

SET_VOLUME_FUNCTION_DESC = {
    "type": "function",
    "function": {
        "name": "set_volume",
        "description": "调节设备的播放音量。用户说大声点、小声点、音量调到百分之几、静音时调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "level": {
                    "type": "integer",
                    "description": "目标音量,0 到 100。用户说了具体数值时传",
                },
                "change": {
                    "type": "string",
                    "description": "up 表示调大,down 表示调小。用户没说具体数值时传",
                },
            },
            "required": [],
        },
    },
}


@register_function("set_volume", SET_VOLUME_FUNCTION_DESC, ToolType.SYSTEM_CTL)
async def set_volume(conn, level: int = None, change: str = None, **_ignored):
    payload, speech = cards.volume_command(level, change)
    if payload is None:
        return ActionResponse(Action.RESPONSE, None, speech)
    if not cards.device_supports_cards(conn):
        return ActionResponse(Action.RESPONSE, None, "这台设备还不支持用语音调音量，请按机身上的按键调。")
    if not await cards.push(conn, payload):
        return ActionResponse(Action.RESPONSE, None, "音量没调成，请按机身上的按键调。")
    await cards.push_emotion(conn, "happy")
    logger.bind(tag=TAG).info(f"音量 {payload}")
    return ActionResponse(Action.RESPONSE, None, speech)
