"""设备桥:控制塔经引擎内网 HTTP 端口操作设备连接。镜像里复制为 core/xiaodan_bridge.py。

Dockerfile 在上游四处打补丁接入本模块(找不到原文就让构建失败):
  - core/connection.py handle_connection:拿到 device-id 之后 register(self);
  - core/connection.py close():开头 unregister(self);
  - core/http_server.py:建 AppRunner 之前 add_bridge_routes(app, config);
  - core/handle/textHandle.py:消息注册表建好后 install_text_handler(message_registry),接收设备上行的 xiaodan 消息。

所有接口都要 Authorization: Bearer <manager-api.secret>(与控制塔共用那串密钥);端口只在 compose 内网里可达。
接口处理函数跑在引擎唯一的事件循环上,和所有设备的音频收发共用,所以这里不能有阻塞调用。
纯逻辑(登记表、忙闲判断、SSE 解析)在 core/utils/xiaodan_bridge_core.py,有单元测试。
"""

import asyncio
import hashlib
import hmac
import json
import os
import time
import uuid

import httpx
from aiohttp import web

from config.logger import setup_logging
from core.utils import xiaodan_bridge_core as core

TAG = __name__
logger = setup_logging()


def _verified(conn):
    # 控制塔核验过设备身份、配置已经拿到之后,才允许按 MAC 找到它
    event = getattr(conn, "bind_completed_event", None)
    return event is not None and event.is_set() and not getattr(conn, "need_bind", False)


REGISTRY = core.Registry(is_verified=_verified)

# 桥只暴露这几个引擎插件。change_role、play_music、hass_* 等上游插件会改连接状态或访问别的系统,不给控制塔用。
ENGINE_TOOLS = ("show_calendar", "get_weather", "set_volume", "get_lunar")

# 音频缓存放在 /tmp 下:引擎删除 TTS 临时文件的条件是路径以 output_dir("tmp/")开头,绝对路径 /tmp/... 不会被误删
MEDIA_CACHE_DIR = "/tmp/xiaodan-media"
MEDIA_CACHE_BYTES = 200 * 1024 * 1024
MEDIA_MAX_BYTES = 40 * 1024 * 1024
CHIME_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "xiaodan-assets", "chime.wav")


def register(conn):
    try:
        REGISTRY.add(conn)
    except Exception as e:  # 登记失败不能影响对话
        logger.bind(tag=TAG).warning(f"设备桥登记连接失败: {e}")


def unregister(conn):
    try:
        REGISTRY.remove(conn)
    except Exception as e:
        logger.bind(tag=TAG).warning(f"设备桥注销连接失败: {e}")


# ---------------------------------------------------------------- 媒体缓存


def _cache_path(url, ext):
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
    return os.path.join(MEDIA_CACHE_DIR, f"{digest}.{ext}")


def _trim_cache():
    try:
        entries = []
        for name in os.listdir(MEDIA_CACHE_DIR):
            path = os.path.join(MEDIA_CACHE_DIR, name)
            if os.path.isfile(path):
                stat = os.stat(path)
                entries.append((stat.st_atime, stat.st_size, path))
        total = sum(size for _, size, _ in entries)
        for _, size, path in sorted(entries):
            if total <= MEDIA_CACHE_BYTES:
                break
            os.remove(path)
            total -= size
    except OSError:
        pass


def fetch_media_sync(url, ext, secret, timeout=30.0):
    """同步下载控制塔上的音频到缓存,返回本地路径。provider 在对话工作线程里调用。"""
    path = _cache_path(url, ext)
    if os.path.exists(path):
        os.utime(path, None)
        return path
    os.makedirs(MEDIA_CACHE_DIR, exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.part"
    size = 0
    with httpx.Client(trust_env=False, timeout=httpx.Timeout(timeout, connect=3.0)) as client:
        with client.stream("GET", url, headers={"Authorization": f"Bearer {secret}"}) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"下载音频失败 HTTP {resp.status_code}")
            with open(tmp, "wb") as f:
                for chunk in resp.iter_bytes():
                    size += len(chunk)
                    if size > MEDIA_MAX_BYTES:
                        raise RuntimeError("音频文件过大")
                    f.write(chunk)
    os.replace(tmp, path)
    _trim_cache()
    return path


async def fetch_media_async(url, ext, secret, timeout=30.0):
    path = _cache_path(url, ext)
    if os.path.exists(path):
        os.utime(path, None)
        return path
    os.makedirs(MEDIA_CACHE_DIR, exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.part"
    size = 0
    async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(timeout, connect=3.0)) as client:
        async with client.stream("GET", url, headers={"Authorization": f"Bearer {secret}"}) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"下载音频失败 HTTP {resp.status_code}")
            with open(tmp, "wb") as f:
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > MEDIA_MAX_BYTES:
                        raise RuntimeError("音频文件过大")
                    f.write(chunk)
    os.replace(tmp, path)
    _trim_cache()
    return path


# ---------------------------------------------------------------- 发给设备


async def send_device_message(conn, message):
    if isinstance(message, dict) and message.get("type") == "xiaodan_deck":
        # 单词卡组:读音文字留在引擎,设备点「读」时只报第几个词;发给设备的消息去掉这个字段
        message = dict(message)
        say = message.pop("say", None)
        if not DECKS.put(getattr(conn, "device_id", None), message.get("id"), message.get("i"), message.get("n"), say):
            logger.bind(tag=TAG).warning(f"单词卡组消息不合法: id={message.get('id')} i={message.get('i')} n={message.get('n')}")
    text = core.clamp_device_message(message, conn.session_id)
    if text is None:
        raise ValueError("设备消息不是带 type 的对象,或超过 4096 字节")
    await conn.websocket.send(text)


def _announce_sequence(conn, sentence_id, text, chime_path, title):
    """与上游 intentHandler.speak_txt 同样的队列顺序,只是显式带上新的 sentence_id。"""
    from core.providers.tts.dto.dto import ContentType, SentenceType, TTSMessageDTO

    tts = conn.tts
    tts.store_tts_text(sentence_id, text)
    tts.tts_text_queue.put(TTSMessageDTO(sentence_id=sentence_id, sentence_type=SentenceType.FIRST, content_type=ContentType.ACTION))
    if chime_path:
        if hasattr(tts, "xd_media_titles") and title:
            tts.xd_media_titles[chime_path] = title
        tts.tts_text_queue.put(TTSMessageDTO(
            sentence_id=sentence_id, sentence_type=SentenceType.MIDDLE, content_type=ContentType.FILE,
            content_detail=title, content_file=chime_path,
        ))
    if text:
        tts.tts_one_sentence(conn, ContentType.TEXT, content_detail=text, sentence_id=sentence_id)
    tts.tts_text_queue.put(TTSMessageDTO(sentence_id=sentence_id, sentence_type=SentenceType.LAST, content_type=ContentType.ACTION))
    return sentence_id


async def _speak_now(conn, text, chime_path=None, title=None):
    """不经模型直接说一段话。调用方已经判断过设备空闲,从判断到这里不能再有别的 await。

    先占住会话(新的 sentence_id + 讲话中),其他播报与判断立刻看到忙;
    再发 start:上游 sendAudioMessage 只在句末发 stop 不发 start,设备空闲时要先收到 start 才会进入播放;
    最后入队,保证 start 一定先于音频帧到达设备。
    """
    from core.handle.sendAudioHandle import send_tts_message

    sentence_id = uuid.uuid4().hex
    conn.client_abort = False
    conn.sentence_id = sentence_id
    conn.client_is_speaking = True
    conn.last_activity_time = time.time() * 1000
    await send_tts_message(conn, "start")
    _announce_sequence(conn, sentence_id, text, chime_path, title)
    return sentence_id


# ---------------------------------------------------------------- 设备发上来的 xiaodan 消息(小单协议 3 级)

# 单词卡组的读音文字:控制塔经 xiaodan_agent 发卡组时存进来,设备点「读」时按 (MAC, 卡组 id, 第几个词) 取
DECKS = core.DeckStore()
DEVICE_RATE = core.RateLimit(0.6)
DECK_TURN_WAIT_S = 3.0


async def _deck_busy(conn, deck_id, why):
    try:
        await send_device_message(conn, {"type": "xiaodan", "cmd": "deck_busy", "id": deck_id, "why": why})
    except Exception as e:
        logger.bind(tag=TAG).warning(f"回复设备 deck_busy 失败: {e}")


async def handle_device_message(conn, msg):
    """设备上行的 {"type":"xiaodan","cmd":...}:读卡组里的词、卡组保活与退出、像素画显示结果。"""
    if not _verified(conn) or core.xiaodan_level(getattr(conn, "features", None)) < 3:
        logger.bind(tag=TAG).info("忽略设备上行的 xiaodan 消息:设备还没核验或固件不支持")
        return
    command = core.parse_device_command(msg)
    if command is None:
        logger.bind(tag=TAG).warning(f"设备上行的 xiaodan 消息不合法: {str(msg)[:120]}")
        return
    mac = core.normalize_mac(getattr(conn, "device_id", None))
    cmd = command["cmd"]
    if cmd == "deck_at":
        # 孩子正在翻卡片:算作有动静,引擎不要因为「长时间没说话」断开
        conn.last_activity_time = time.time() * 1000
        return
    if cmd == "deck_exit":
        DECKS.drop(mac, command["id"] or None)
        DECKS.note_exit(mac, command["id"], command["why"])
        logger.bind(tag=TAG).info(f"{mac} 退出单词卡组 {command['id']} {command['why']}")
        return
    if cmd == "img":
        log = logger.bind(tag=TAG).info if command["ok"] else logger.bind(tag=TAG).warning
        log(f"{mac} 像素画 {command['id']} {'已显示 ' + str(command['w']) + '×' + str(command['w']) if command['ok'] else '没能显示(设备内存不足)'}")
        return

    # deck_say
    deck_id = command["id"]
    if not DEVICE_RATE.allow((mac, "deck_say")):
        await _deck_busy(conn, deck_id, "fast")
        return
    say = DECKS.get(mac, deck_id, command["i"])
    if not say:
        await _deck_busy(conn, deck_id, "gone")
        return
    # 设备点「读」前已经发过 abort;控制塔这一轮要一小会儿才收尾,收尾时的 stop 不能打断新读的词
    waited = 0.0
    while getattr(conn, "_xd_turn_active", False) and waited < DECK_TURN_WAIT_S:
        await asyncio.sleep(0.05)
        waited += 0.05
    if getattr(conn, "_xd_turn_active", False):
        await _deck_busy(conn, deck_id, "turn")
        return
    reason = core.not_ready_reason(conn)
    if reason:
        await _deck_busy(conn, deck_id, reason)
        return
    busy = core.busy_reason(conn)
    if busy in ("recognizing", "listening"):
        await _deck_busy(conn, deck_id, busy)
        return
    if busy == "speaking":
        # 上一个词还没读完:清掉再读新的
        conn.client_abort = True
        conn.clear_queues()
        await asyncio.sleep(0.1)
        busy = core.busy_reason(conn)
        if busy in ("recognizing", "listening") or getattr(conn, "_xd_turn_active", False):
            await _deck_busy(conn, deck_id, busy or "turn")
            return
    await _speak_now(conn, say)
    logger.bind(tag=TAG).info(f"{mac} 读卡组 {deck_id} 第 {command['i'] + 1} 个词: {say[:40]}")


class _XiaodanMessageType:
    value = "xiaodan"


class XiaodanTextMessageHandler:
    """注册进上游 textHandle 的消息注册表(Dockerfile 补丁):注册表只用 message_type.value 作键。"""

    message_type = _XiaodanMessageType()

    async def handle(self, conn, msg_json):
        try:
            await handle_device_message(conn, msg_json)
        except Exception as e:  # 设备上行消息出错不能影响连接
            logger.bind(tag=TAG).error(f"处理设备上行 xiaodan 消息出错: {type(e).__name__}: {e}")


def install_text_handler(registry):
    registry.register_handler(XiaodanTextMessageHandler())
    logger.bind(tag=TAG).info("已注册设备上行 xiaodan 消息处理")


# ---------------------------------------------------------------- 路由


def add_bridge_routes(app, config):
    secret = str((config.get("manager-api") or {}).get("secret") or "")

    def authorized(request):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        return bool(secret) and bool(token) and hmac.compare_digest(token.encode(), secret.encode())

    def guard(handler):
        async def wrapped(request):
            if not authorized(request):
                return web.json_response({"error": "unauthorized"}, status=401)
            try:
                return await handler(request)
            except web.HTTPException:
                raise
            except Exception as e:
                logger.bind(tag=TAG).error(f"设备桥 {request.path} 出错: {type(e).__name__}: {e}")
                return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)
        return wrapped

    async def body_json(request, limit=64 * 1024):
        if request.content_length and request.content_length > limit:
            raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=request.content_length)
        try:
            data = await request.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text='{"error":"body must be a JSON object"}', content_type="application/json")
        return data

    async def health(_request):
        return web.json_response({"ok": True, "connections": len(REGISTRY)})

    async def call_tool(request):
        from core.providers.tools.server_plugins.plugin_executor import ServerPluginExecutor
        from plugins_func.register import Action

        data = await body_json(request)
        name = data.get("name")
        if name not in ENGINE_TOOLS:
            return web.json_response({"error": f"不允许调用 {name}"}, status=404)
        conn = REGISTRY.by_session(str(data.get("session_id") or ""))
        if conn is None or not _verified(conn):
            return web.json_response({"error": "session gone"}, status=410)
        turn_id = data.get("turn_id")
        if conn.client_abort or (turn_id and conn.sentence_id != turn_id):
            return web.json_response({"error": "turn superseded"}, status=409)
        arguments = data.get("arguments") if isinstance(data.get("arguments"), dict) else {}
        plugin_config = data.get("plugin_config") if isinstance(data.get("plugin_config"), dict) else {}
        # nointent 模式下引擎不会把插件参数装进 conn.config,插件读不到默认城市等配置,这里补上
        conn.config.setdefault("plugins", {})[name] = plugin_config
        try:
            result = await asyncio.wait_for(ServerPluginExecutor(conn).execute(conn, name, arguments), timeout=30)
        except asyncio.TimeoutError:
            return web.json_response({"action": "ERROR", "result": None, "response": "工具执行超时"})
        action = getattr(result, "action", Action.ERROR)
        return web.json_response({
            "action": action.name if hasattr(action, "name") else str(action),
            "result": None if result is None or result.result is None else str(result.result),
            "response": None if result is None or result.response is None else str(result.response),
        })

    async def device_info(request):
        conn = REGISTRY.by_mac(request.match_info["mac"])
        if conn is None:
            return web.json_response({"online": False})
        not_ready = core.not_ready_reason(conn)
        busy = not_ready or core.busy_reason(conn)
        return web.json_response({
            "online": True,
            "session_id": conn.session_id,
            "busy": bool(busy),
            "reason": busy,
            "client_ip": conn.client_ip,
            "features": conn.features or {},
        })

    async def announce(request):
        data = await body_json(request)
        conn = REGISTRY.by_mac(request.match_info["mac"])
        if conn is None:
            return web.json_response({"error": "offline"}, status=404)
        text = str(data.get("text") or "").strip()[:500]
        title = str(data.get("title") or "")[:40] or None
        chime = data.get("chime")
        chime_path = None
        if chime is True and os.path.exists(CHIME_FILE):
            chime_path = CHIME_FILE
        elif isinstance(chime, str) and chime:
            ext = core.media_extension(data.get("chime_ext") or chime.rsplit(".", 1)[-1])
            if ext:
                chime_path = await fetch_media_async(chime, ext, secret)
        if not text and not chime_path:
            return web.json_response({"error": "nothing to say"}, status=400)
        # 忙闲判断之后到入队之间不能有 await,否则判断会过期
        reason = core.not_ready_reason(conn)
        if reason:
            return web.json_response({"error": "not_ready", "reason": reason}, status=409)
        reason = core.busy_reason(conn)
        if reason:
            return web.json_response({"error": "busy", "reason": reason}, status=409)
        sentence_id = await _speak_now(conn, text, chime_path, title)
        for message in data.get("device_msgs") or []:
            try:
                await send_device_message(conn, message)
            except Exception as e:
                logger.bind(tag=TAG).warning(f"主动播报附带的设备消息发送失败: {e}")
        logger.bind(tag=TAG).info(f"主动播报 {conn.device_id}: {text[:40]}")
        return web.json_response({"session_id": conn.session_id, "sentence_id": sentence_id}, status=202)

    async def send(request):
        data = await body_json(request)
        conn = REGISTRY.by_mac(request.match_info["mac"])
        if conn is None:
            return web.json_response({"error": "offline"}, status=404)
        messages = data.get("messages") if isinstance(data.get("messages"), list) else [data.get("msg")]
        for message in messages:
            await send_device_message(conn, message)
        return web.json_response({"ok": True, "session_id": conn.session_id})

    app.add_routes([
        web.get("/xiaodan/bridge/health", guard(health)),
        web.post("/xiaodan/bridge/tool", guard(call_tool)),
        web.get("/xiaodan/bridge/devices/{mac}", guard(device_info)),
        web.post("/xiaodan/bridge/devices/{mac}/announce", guard(announce)),
        web.post("/xiaodan/bridge/devices/{mac}/send", guard(send)),
    ])
    logger.bind(tag=TAG).info("设备桥接口已挂载 /xiaodan/bridge/*")
