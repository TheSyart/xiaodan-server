"""告别:只道别,不断开连接。覆盖上游同名插件。

引擎把这个函数设为永远开启(plugin_executor.py 的 necessary_functions),用户说"拜拜"时模型就会调它。
上游版本会置 close_after_chat,播完告别语就关闭 WebSocket。按键说话的设备随即进入断线重连,
几秒内按键没有反应,用户还以为设备坏了;而连接空闲本来就会按 close_connection_no_voice_time 自动关闭。
所以这里保留同名、同描述、同参数(引擎注入的 few-shot 示例用的就是它),只去掉断开连接这一步。
"""

from config.logger import setup_logging
from plugins_func.register import Action, ActionResponse, ToolType, register_function

TAG = __name__
logger = setup_logging()

handle_exit_intent_function_desc = {
    "type": "function",
    "function": {
        "name": "handle_exit_intent",
        "description": "当用户想结束对话或需要退出系统时调用",
        "parameters": {
            "type": "object",
            "properties": {
                "say_goodbye": {
                    "type": "string",
                    "description": "和用户友好结束对话的告别语",
                }
            },
            "required": ["say_goodbye"],
        },
    },
}


@register_function("handle_exit_intent", handle_exit_intent_function_desc, ToolType.SYSTEM_CTL)
def handle_exit_intent(conn, say_goodbye: str = None, **_ignored):
    goodbye = (say_goodbye or "").strip() or "好的，下次再聊。"
    logger.bind(tag=TAG).info("告别意图已处理,连接保持")
    return ActionResponse(action=Action.RESPONSE, result="已道别", response=goodbye)
