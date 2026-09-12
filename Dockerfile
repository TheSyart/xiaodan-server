# syntax=docker/dockerfile:1
#
# 单阶段产物:一个 Node 进程,既提供接口也托管前端页面。
# 刻意不引入需要编译的原生模块(数据库用 Node 内置的 node:sqlite),
# 所以运行镜像里不需要 python3/make/g++,体积和构建时间都省下来。

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
