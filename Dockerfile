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
# 按 digest 固定上游镜像:tag 会飘,而面板要求"提交 → 镜像 → 运行"整条链路可复核,
# 基底也必须是确定的一份。换上游版本时连同这里一起改,并重跑联调冒烟。
FROM ghcr.io/xinnan-tech/xiaozhi-esp32-server@sha256:1be29c11c8a1971ef93390d9bf383cf8f7a484376a7c691e85cee3fc0666e07a AS engine
ARG SERVEROPS_UID=1000
ARG SERVEROPS_GID=1000

# 上游镜像的 WORKDIR 就是这里;写全是为了让下面的相对路径一眼可读。
WORKDIR /opt/xiaozhi-esp32-server

# 自写的两个 provider:模型网关只代理 chat 接口,没有转写/合成端点,
# 所以 ASR 与 TTS 都改走 chat/completions。`config_json.type` 按名字映射到这两个文件。
COPY server/providers/gateway_chat.py core/providers/asr/gateway_chat.py
COPY server/providers/gateway_omni_tts.py core/providers/tts/gateway_omni_tts.py
# 上游自带的模板在示例里演示放歌报天气,会让模型承诺它没有的能力,故整份替换。
COPY server/prompts/xiaodan-base-prompt.txt ./xiaodan-base-prompt.txt

RUN set -eux; \
    test "$SERVEROPS_UID" -gt 0; test "$SERVEROPS_GID" -gt 0; \
    groupadd --gid "$SERVEROPS_GID" xiaodan; \
    useradd --uid "$SERVEROPS_UID" --gid "$SERVEROPS_GID" --create-home --shell /usr/sbin/nologin xiaodan; \
    # 运行期要写的三个目录。上游把它们散落在包目录里,而我们以非 root 运行,
    # 必须预先把属主设对 —— 少一个,进程在【导入阶段】就会 PermissionError 退出。
    #   data                       面板挂载进来的数据目录(只有 .config.yaml)
    #   tmp                        ASR/TTS 的音频临时文件与 server.log。留在可写层不挂载:
    #                              docker logs 有同样内容,没必要进每次发布的数据备份
    #   config/assets/wakeup_words 每个设备的唤醒词音频。WakeupWordsConfig 在 import
    #                              core.handle.helloHandle 时就会创建它,躲不过去
    install -d -o "$SERVEROPS_UID" -g "$SERVEROPS_GID" -m 0750 data tmp config/assets/wakeup_words; \
    # 非 root 写不了 __pycache__,预先编译省下每次启动的开销。写不进去时 Python
    # 只是不缓存而非报错,所以这一步失败不该让构建失败。
    python -m compileall -q app.py config core plugins_func || true; \
    # 提前暴露"文件放错位置"这类低级错误,别等到生产才发现。
    python -c "import ast,sys; [ast.parse(open(p,encoding='utf-8').read()) for p in ['core/providers/asr/gateway_chat.py','core/providers/tts/gateway_omni_tts.py']]"; \
    test -s xiaodan-base-prompt.txt

# TZ 让日志时间戳与服务器一致;HOME 是因为某些库会往 ~/.cache 写东西,
# 而 uid 1000 原本在这个镜像里没有家目录。
ENV TZ=Asia/Shanghai \
    HOME=/home/xiaodan

# 同样不声明 VOLUME:面板逐个比对容器挂载,匿名卷会多出一项导致校验失败。

USER ${SERVEROPS_UID}:${SERVEROPS_GID}
EXPOSE 8000

# 8000 是 WebSocket 端口,但它对普通 GET / 回 200,可以当就绪信号。
# 镜像里没有 curl,用 python 的标准库。start-period 给足:实测冷启动约 2 秒,
# 但取不到控制台配置时会重试(6 次 × 10 秒),给它一次完整重试周期的余量。
HEALTHCHECK --interval=10s --timeout=4s --start-period=75s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/', timeout=3).status == 200 else 1)"]

# CMD 沿用上游的 ["python", "app.py"]。面板的启动前校验要求容器的 Cmd/Entrypoint
# 与镜像自身完全一致,这里不要覆盖。
