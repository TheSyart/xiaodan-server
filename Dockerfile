# syntax=docker/dockerfile:1
#
# 本文件产出两个镜像,对应运维面板里同一个应用的两个组件:
#
#   target console —— 控制台。一个 Node 进程,既提供接口也托管前端页面。
#                      刻意不引入需要编译的原生模块(数据库用 Node 内置的 node:sqlite),
#                      所以运行镜像里不需要 python3/make/g++,体积和构建时间都省下来。
#   target engine  —— 设备直连的 WebSocket 服务端。基于上游镜像,把原先靠 bind 挂载
#                      注入的两个 provider 与提示词固化进去,并改成非 root 运行。
#
# 为什么要固化而不是继续挂载:面板按 root 批准的策略自己渲染 compose,它能表达的挂载
# 只有"数据目录"一类,代码文件的挂载无处安放。固化进镜像也让"digest 唯一决定行为"
# 这件事真正成立,面板那套来源校验才有意义。

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY console/package.json ./console/
COPY console/web/package.json ./console/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
# 去掉开发依赖(TypeScript、Vite、vue-tsc 这些只在构建期用)
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22.22.0-bookworm-slim AS console
# 运维面板在运行时用 compose 的 user: 覆盖身份,这里的构建期 UID/GID 只用于
# 把 /app/data 的属主设对,让镜像在被指定为任意非 root 用户运行时仍能写数据。
ARG SERVEROPS_UID=1000
ARG SERVEROPS_GID=1000
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8002 \
    XIAODAN_DATA_DIR=/app/data

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/console/package.json ./console/
COPY --from=build /app/console/dist ./console/dist

# 数据目录必须先存在且属主正确:面板生成的 compose 用 create_host_path:false,
# 容器自己创建不了它。
RUN test "$SERVEROPS_UID" -gt 0 && test "$SERVEROPS_GID" -gt 0 \
    && install -d -o "$SERVEROPS_UID" -g "$SERVEROPS_GID" -m 0750 /app/data \
    && node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(':memory:').close()" \
    && node -e "require.resolve('hono');require.resolve('zod');require.resolve('yaml')"

# 不声明 VOLUME:面板的启动前校验会逐个比对容器挂载,匿名卷会多出一项导致校验失败。

USER ${SERVEROPS_UID}:${SERVEROPS_GID}
EXPOSE 8002

# 健康检查与面板用的是同一个端点。间隔给短一些,让容器能在面板的 120 秒
# 就绪预算内变成 healthy。
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "console/dist/server.js"]


# ---------------------------------------------------------------------------
# 设备直连的 WebSocket 服务端
# ---------------------------------------------------------------------------
# 上游镜像 10.5G,其中 pip 那一层就占 6.4G,而绝大部分是为"在本地跑 ASR 模型"
# 准备的:nvidia 的 CUDA 库 2.8G、torch 1.5G、triton 419M,再加 funasr / vosk /
# sherpa_onnx / sklearn / scipy 等。我们的 ASR 走模型网关、VAD 用 onnxruntime 读
# 一个 7.5M 的 onnx,这些一个都用不上 —— 在生产进程的 /proc/<pid>/maps 里确认过,
# torch 与 nvidia 从未被加载。provider 是按名字动态导入的(core/utils/asr.py 的
# create_instance),只有 fun_local / sherpa_onnx_local / vosk 三个文件引用它们,
# 而我们永远走不到那三个。
#
# 分层是累加的,在成品里 rm 掉并不会让它变小,所以这里分两段:先在上游镜像里删,
# 再把删完的结果拷进一个干净的系统层。构建阶段不会被推送。
# 不重新 pip install 是刻意的:包的版本与二进制完全沿用上游那批,只是不带没用的,
# 避免引入"版本不同导致的行为差异"这类无法在构建期发现的风险。
#
# 按 digest 固定上游:tag 会飘,而面板要求"提交 → 镜像 → 运行"整条链路可复核。
# 换上游版本时连同这里一起改,并重跑联调冒烟。
FROM ghcr.io/xinnan-tech/xiaozhi-esp32-server@sha256:1be29c11c8a1971ef93390d9bf383cf8f7a484376a7c691e85cee3fc0666e07a AS engine-prune
WORKDIR /opt/xiaozhi-esp32-server

# 自写的两个 provider:模型网关只代理 chat 接口,没有转写/合成端点,
# 所以 ASR 与 TTS 都改走 chat/completions。`config_json.type` 按名字映射到这两个文件。
COPY server/providers/gateway_chat.py core/providers/asr/gateway_chat.py
COPY server/providers/gateway_omni_tts.py core/providers/tts/gateway_omni_tts.py
# 千问语音(百炼 Qwen-Audio 3.0):识别走同步 HTTP,合成走 CosyVoice 协议的 WebSocket、每句一个任务。
# 纯逻辑(请求体、解析、分段)在 qwen_audio.py,两个 provider 只管联网与线程。为什么不用上游 alibl_stream 见合成 provider 开头。
COPY server/engine/qwen_audio.py core/utils/qwen_audio.py
COPY server/providers/qwen_audio_asr.py core/providers/asr/qwen_audio_asr.py
COPY server/providers/qwen_audio_tts.py core/providers/tts/qwen_audio_tts.py
# 上游自带的模板在示例里演示放歌报天气,会让模型承诺它没有的能力,故整份替换。
COPY server/prompts/xiaodan-base-prompt.txt ./xiaodan-base-prompt.txt

# 自写的服务端插件(server/plugins/):查日期并显示日历、查天气并显示天气卡片、调音量三个工具;
# 另外覆盖上游两个同名插件:get_weather(上游抓网页、靠写死的共享密钥)与 handle_exit_intent(上游道别后断开连接)。
# 引擎启动时自动导入 plugins_func/functions/ 下的全部模块,xiaodan_cards.py 是它们共用的纯逻辑。
COPY server/plugins/xiaodan_cards.py plugins_func/functions/xiaodan_cards.py
COPY server/plugins/show_calendar.py plugins_func/functions/show_calendar.py
COPY server/plugins/get_weather.py plugins_func/functions/get_weather.py
COPY server/plugins/set_volume.py plugins_func/functions/set_volume.py
COPY server/plugins/handle_exit_intent.py plugins_func/functions/handle_exit_intent.py
# DeepSeek 以 DSML 文本给出工具调用时的转换模块,由下面第 3 处修补引用(原理见文件开头)。
COPY server/engine/xiaodan_tool_text.py core/utils/xiaodan_tool_text.py

# 对上游的三处精确修补。每处都要求找到恰好一处原文,找不到就让构建失败:
# 换上游版本后修补悄悄失效,比构建失败危险得多。修补后的代码已在上游同一提交的源码上编译验证。
#
# 1. 上游在每条连接建立时把全部请求头打进 INFO 日志。其中 Client-Id 是设备密钥,控制塔据它核验设备身份;
#    Authorization 是设备令牌 —— 两者都不能进 docker logs 与 tmp/server.log。打印前把这两项换成 <redacted>。
# 2. 开启工具调用(Intent 为 function_call)后,引擎给模型加了一个 direct_answer 虚拟工具,普通回答大多从它的参数里流出。
#    上游只在模型直接输出正文时发情绪消息,走 direct_answer 就一条也不发,设备上的表情永远停在默认值。
#    在提取 direct_answer 文本的地方补上与正文路径相同的一段:一轮只发一次,尊重设备在 hello 里声明的 emoji 开关。
# 3. 模型网关背后的模型会把工具调用写成文本放在正文里(DeepSeek 的 DSML、<tool_call>、<tool_calls><tool_name> 等),
#    而不是 delta.tool_calls。引擎只认后者,于是标记被念出来或整轮沉默,工具一个也没执行。在 openai provider
#    模块末尾把 response_with_functions 包一层,把这些块转成结构化的工具调用(只放行本轮提供的工具);
#    不带工具的 response 同样包一层,只删掉这些块。
RUN python - <<'PY'
import pathlib
import py_compile


def replace_once(text, old, new, what, where="core/connection.py"):
    if text.count(old) != 1:
        raise SystemExit(f"{where} 里找不到恰好一处{what},上游可能改了写法,请重新确认修补方式")
    return text.replace(old, new)


path = pathlib.Path("core/connection.py")
source = path.read_text(encoding="utf-8")

source = replace_once(
    source,
    'f"{self.client_ip} conn - Headers: {self.headers}"',
    ('f"{self.client_ip} conn - Headers: '
     '{ {k: (\'<redacted>\' if k.lower() in (\'client-id\', \'authorization\') else v) for k, v in self.headers.items()} }"'),
    "请求头日志",
)

anchor = '                            da_text = self._extract_direct_answer_response(tc["arguments"])\n'
source = replace_once(
    source,
    anchor,
    anchor
    + '                            if emotion_flag and da_text and da_text.strip():\n'
    + '                                if (self.features or {}).get("emoji", True):\n'
    + '                                    asyncio.run_coroutine_threadsafe(\n'
    + '                                        textUtils.get_emotion(self, da_text), self.loop\n'
    + '                                    )\n'
    + '                                emotion_flag = False\n',
    " direct_answer 文本提取",
)

path.write_text(source, encoding="utf-8")
py_compile.compile(str(path), doraise=True)

provider_path = pathlib.Path("core/providers/llm/openai/openai.py")
provider = provider_path.read_text(encoding="utf-8")
for needle, what in (
    ("\nclass LLMProvider(", "LLMProvider 类"),
    ("\n    def response_with_functions(self", "response_with_functions 方法"),
    ("\n    def response(self", "response 方法"),
    ("\nTAG = __name__\n", "模块级 TAG"),
    ("\nlogger = setup_logging()\n", "模块级 logger"),
):
    replace_once(provider, needle, needle, what, where=str(provider_path))
if "_xd_patched_response" in provider:
    raise SystemExit(f"{provider_path} 已经修补过,不应重复修补")
provider += '''

# ---- xiaodan-server 追加:DeepSeek 以 DSML 文本给出的工具调用转成结构化调用(见 core/utils/xiaodan_tool_text.py) ----
import functools as _xd_functools

from core.utils.xiaodan_tool_text import strip_text_stream as _xd_strip, wrap_function_stream as _xd_wrap

_xd_response_with_functions = LLMProvider.response_with_functions
_xd_response = LLMProvider.response


def _xd_log(message):
    logger.bind(tag=TAG).warning(message)


@_xd_functools.wraps(_xd_response_with_functions)
def _xd_patched_response_with_functions(self, *args, **kwargs):
    # 本轮交给模型的工具列表,只放行其中的函数名。签名是 (session_id, dialogue, functions=None, **kwargs)
    tools = kwargs.get("functions", args[2] if len(args) > 2 else None)
    return _xd_wrap(_xd_response_with_functions(self, *args, **kwargs), log=_xd_log, tools=tools)


@_xd_functools.wraps(_xd_response)
def _xd_patched_response(self, *args, **kwargs):
    return _xd_strip(_xd_response(self, *args, **kwargs), log=_xd_log)


_xd_patched_response_with_functions.xiaodan_dsml = True
_xd_patched_response.xiaodan_dsml = True
LLMProvider.response_with_functions = _xd_patched_response_with_functions
LLMProvider.response = _xd_patched_response
'''
provider_path.write_text(provider, encoding="utf-8")
py_compile.compile(str(provider_path), doraise=True)
PY

RUN set -eux; \
    cd /usr/local/lib/python3.10/site-packages; \
    # 删之前先确认这些包确实只被那三个用不到的 provider 引用。漏掉一个依赖会在
    # 运行期才炸,而下面的联调冒烟未必覆盖得到,所以在构建期就断言一次。
    for module in torch funasr modelscope sherpa_onnx vosk numba sklearn scipy jieba; do \
      ! grep -rl --include='*.py' -E "^[[:space:]]*(import|from)[[:space:]]+${module}\b" \
        /opt/xiaozhi-esp32-server/core /opt/xiaozhi-esp32-server/config \
        /opt/xiaozhi-esp32-server/plugins_func /opt/xiaozhi-esp32-server/app.py \
        | grep -vE "providers/asr/(fun_local|sherpa_onnx_local|vosk)\.py$" | grep -q . \
        || { echo "还有代码依赖 ${module},不能删"; exit 1; }; \
    done; \
    rm -rf nvidia torch torchaudio torchgen functorch torch_complex triton llvmlite numba \
           sympy funasr modelscope sherpa_onnx vosk jieba sklearn scipy \
           nvidia_* torch-* torchaudio-* triton-* llvmlite-* numba-* sympy-* \
           funasr-* modelscope-* sherpa_onnx-* vosk-* jieba-* scikit_learn-* scipy-*; \
    # __pycache__ 要在这里清掉再重新生成:成品里以非 root 运行,写不进去。
    find /opt/xiaozhi-esp32-server -name __pycache__ -type d -prune -exec rm -rf {} +; \
    python -m compileall -q /opt/xiaozhi-esp32-server/app.py /opt/xiaozhi-esp32-server/config \
      /opt/xiaozhi-esp32-server/core /opt/xiaozhi-esp32-server/plugins_func || true; \
    python -c "import ast; [ast.parse(open(p,encoding='utf-8').read()) for p in ['/opt/xiaozhi-esp32-server/core/providers/asr/gateway_chat.py','/opt/xiaozhi-esp32-server/core/providers/tts/gateway_omni_tts.py','/opt/xiaozhi-esp32-server/core/utils/xiaodan_tool_text.py','/opt/xiaozhi-esp32-server/core/utils/qwen_audio.py','/opt/xiaozhi-esp32-server/core/providers/asr/qwen_audio_asr.py','/opt/xiaozhi-esp32-server/core/providers/tts/qwen_audio_tts.py']]"; \
    test -s /opt/xiaozhi-esp32-server/xiaodan-base-prompt.txt

FROM debian:trixie-slim AS engine
ARG SERVEROPS_UID=1000
ARG SERVEROPS_GID=1000

# 系统层只留运行真正需要的:libopus 解设备音频,ffmpeg 是 pydub 的后端而且
# core/utils/util.py 启动时会执行 `ffmpeg -version` 检查,缺了直接抛错。
# locale 沿用上游的 zh_CN.UTF-8,免得日志与文本处理出现编码差异。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends libopus0 ffmpeg locales ca-certificates tzdata; \
    sed -i 's/^# *\(zh_CN.UTF-8\)/\1/' /etc/locale.gen; \
    locale-gen; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --gid "$SERVEROPS_GID" xiaodan; \
    useradd --uid "$SERVEROPS_UID" --gid "$SERVEROPS_GID" --create-home --shell /usr/sbin/nologin xiaodan

# 整个 /usr/local 搬过来:Python 3.10.20 本身就装在这里(含 libpython3.10.so)。
# 不换解释器是关键 —— 站点包里有几十个编译好的扩展,重新找一个"版本相近"的
# Python 会把 ABI 风险引进来,而那种问题往往只在运行期的某条冷路径上才暴露。
COPY --from=engine-prune /usr/local /usr/local
COPY --from=engine-prune /opt/xiaozhi-esp32-server /opt/xiaozhi-esp32-server
RUN ldconfig

WORKDIR /opt/xiaozhi-esp32-server

RUN set -eux; \
    test "$SERVEROPS_UID" -gt 0; test "$SERVEROPS_GID" -gt 0; \
    # 运行期要写的三个目录。上游把它们散落在包目录里,而我们以非 root 运行,
    # 必须预先把属主设对 —— 少一个,进程在【导入阶段】就会 PermissionError 退出。
    #   data                       面板挂载进来的数据目录(只有 .config.yaml)
    #   tmp                        ASR/TTS 的音频临时文件与 server.log。留在可写层不挂载:
    #                              docker logs 有同样内容,没必要进每次发布的数据备份
    #   config/assets/wakeup_words 每个设备的唤醒词音频。WakeupWordsConfig 在 import
    #                              core.handle.helloHandle 时就会创建它,躲不过去
    install -d -o "$SERVEROPS_UID" -g "$SERVEROPS_GID" -m 0750 data tmp config/assets/wakeup_words; \
    # 换了系统层,先确认解释器与那批编译扩展在新 glibc 上仍然能用。
    python -c "import onnxruntime, opuslib_next, numpy, aiohttp, websockets, openai; print('runtime ok')"

# TZ 让日志时间戳与服务器一致;LANG 沿用上游;HOME 是因为某些库会往 ~/.cache 写东西,
# 而 uid 1000 原本在这个镜像里没有家目录。
ENV TZ=Asia/Shanghai \
    LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    HOME=/home/xiaodan

# 同样不声明 VOLUME:面板逐个比对容器挂载,匿名卷会多出一项导致校验失败。

USER ${SERVEROPS_UID}:${SERVEROPS_GID}
EXPOSE 8000

# 8000 是 WebSocket 端口,但它对普通 GET / 回 200,可以当就绪信号。
# 镜像里没有 curl,用 python 的标准库。start-period 给足:实测冷启动约 2 秒,
# 但取不到控制台配置时会重试(6 次 × 10 秒),给它一次完整重试周期的余量。
HEALTHCHECK --interval=10s --timeout=4s --start-period=75s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/', timeout=3).status == 200 else 1)"]

# 换了系统层就继承不到上游的 CMD 了,这里补回原样。面板的启动前校验要求容器的
# Cmd/Entrypoint 与镜像自身完全一致,所以编排里不要覆盖它。
CMD ["python", "app.py"]

# CMD 沿用上游的 ["python", "app.py"]。面板的启动前校验要求容器的 Cmd/Entrypoint
# 与镜像自身完全一致,这里不要覆盖。
