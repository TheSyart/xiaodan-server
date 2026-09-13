<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# 小单控制台

给小智服务端(`xiaozhi-esp32-server`)配套的轻量控制台,替代它官方的"智控台"。

一个 Node 进程,一个 SQLite 文件。没有 MySQL,没有 Redis,没有 Java。

## 为什么重写

官方智控台是 Spring Boot + Vue,要配 MySQL 和 Redis 才能跑,建 30 张表、执行
100 多个 changelog,带着多租户注册、短信验证码、SM2 加密、知识库、声纹、
声音克隆、MCP 接入点管理、OTA 固件分发一整套东西。

而我们真正需要的只有六件事:**给设备绑定、改人设、切模型换密钥、选音色、
开关插件、看对话记录**。为这六件事付出三个容器、630MB 内存不划算;更要紧的是,
那套 compose 结构(bind mount、command、env_file)永远进不了我们服务器上那个
运维面板的管理范围。

| | 官方智控台 | 本控制台 |
| --- | --- | --- |
| 容器数 | 3(Java + MySQL + Redis) | 1 |
| 内存 | 665MB(实测) | **21.8MB**(实测) |
| 数据表 | 30 | 10 |
| 备份 | 需 mysqldump | 拷一个文件 |
| 运维面板可纳管 | 否 | 是 |

还顺手修掉了官方的一处设计问题,见下面「绑定码」一节。

## 与服务端的关系

小智服务端在 **api 模式**下会把配置来源从本地 YAML 切换到 HTTP 接口。
它只依赖七个接口,本控制台把它们全部实现了 —— **服务端一行代码都不用改**。

```
设备 ──wss──> 小智服务端 ──HTTP(Bearer)──> 小单控制台 ──> SQLite
                   │                              │
              ASR/LLM/TTS                    浏览器管理页面
```

契约的每个字段都对照过上游 Java 实现与服务端消费它的 Python 代码,
并有 56 个测试守着(`console/test/`)。改动接口前请先读那些测试的注释,
里面写了每条断言对应服务端的哪一行。

## 绑定码:与官方不同的地方

官方只在设备调用 **OTA 接口**时才生成绑定码。而自研固件通常直接连 WebSocket、
从不调 OTA —— 于是设备永远拿不到码,接口返回的是"设备不存在",
设备会反复念"没有找到该设备的版本信息,请正确配置 OTA 地址",
而用户照着提示去配 OTA 也解决不了。

本控制台改成:**服务端为未知设备取配置时就地生成绑定码**,并把这台设备记进
「等待绑定」列表。用户在页面上直接点「绑定」即可,不必去听设备念那六位数字。
原来的输码流程也保留,两条路都能走。

## 目录

```
console/            控制台(Node + Vue)
  src/
    manager-api.ts    ← 服务端调的七个接口,项目的核心
    ota.ts            ← 设备 OTA / 激活(兼容原版小智固件)
    admin-api.ts      ← 页面用的管理接口
    catalog.ts        ← 供应商与插件目录(代码常量,不是数据库表)
    schema.sql        ← 全部 10 张表
    cli.ts            ← 命令行:设密码、从旧配置导入密钥
  web/                前端页面
  test/               契约测试
server/             小智服务端的配套文件
  providers/          自写的网关 ASR / TTS provider
  prompts/            提示词模板
  config.api.yaml     api 模式的配置模板
```

## 本地运行

```bash
npm ci
npm run build
XIAODAN_DATA_DIR=./data node console/dist/server.js
```

打开 http://127.0.0.1:8002,第一次会让你设置管理员账号。之后不再开放注册。

开发时前后端分开跑:

```bash
npm run dev --workspace=@xiaodan/console       # 后端,8002
npm run dev --workspace=@xiaodan/console-web   # 前端,5173,已配代理
```

## 从现有单模块部署迁移

如果服务端此前是"单模块"模式(配置写在 `data/.config.yaml` 里),
不必手工把密钥抄一遍:

```bash
node console/dist/cli.js import-single-config /路径/.config.yaml
```

它会把 `selected_module` 选中的那几个模型连同密钥导入,挂到默认智能体上,
顺带搬走人设和 WebSocket 地址。**密钥全程只在服务器上流动**,不经过剪贴板。

然后把服务端切到 api 模式:

```bash
cp server/config.api.yaml /opt/xiaodan/data/.config.yaml
# 把里面的 secret 换成控制台「设置」页里的那一串
docker compose restart xiaodan-server
```

服务端日志出现「从API读取配置」即成功。设备连上来后会念出绑定码,
或者直接在控制台的「等待绑定」列表里点绑定。

回滚就是把 `.config.yaml` 换回单模块那份再重启,控制台可以继续开着。

## 命令行

```bash
node console/dist/cli.js set-password <用户名> <密码>     # 忘记密码时用
node console/dist/cli.js import-single-config <配置路径>  # 导入旧配置与密钥
node console/dist/cli.js show-secret                      # 打印服务端接入密钥
node console/dist/cli.js set <参数名> <值>                # 改一个系统参数
```

## 鉴权

控制台默认**不自己管账号**(`XIAODAN_AUTH_MODE=proxy`),鉴权交给前面的运维面板:
它在 nginx 层用 `auth_request` 拦截,未登录的请求根本到不了这里。一套凭据比两套好记,
也少一处可以被撞库的入口。

这个模式的安全前提有两条,缺一不可:

1. 控制台只发布回环端口(compose 里是 `127.0.0.1:8002`);
2. nginx 是唯一公网入口,且该站点已被面板接管并启用统一 Auth。

**第 2 条没满足时,前面必须有别的东西挡着**(例如 nginx 的 Basic Auth),
否则任何能到达该端口的请求都能管理这个控制台。启动日志会把当前模式和前提打出来。

需要控制台自管账号时(还没接进面板、或本地开发),设 `XIAODAN_AUTH_MODE=local`,
再用 `cli set-password` 建一个管理员。反过来切到 proxy 后,用
`cli clear-local-admin` 把残留的账号与会话擦掉,别留第二套凭据。

**给服务端用的 Bearer 鉴权不受模式影响** —— proxy 放行的只是浏览器来的管理请求。
否则任何能碰到这个端口的东西都能读出全部模型密钥。

## 数据与备份

所有状态都在 `$XIAODAN_DATA_DIR/console.db` 一个文件里。备份就是拷贝它。

进程收到 `SIGTERM` 时会先停止接受连接再做 WAL checkpoint,确保停机瞬间打包
数据目录不会丢掉最后几笔写入。

**里面存有模型密钥**,请不要把数据目录提交到版本库(`.gitignore` 已排除)。

## 生产实测(2026-09-13)

在已有部署上完成了替换,数据来自真实服务器:

| 项 | 替换前 | 替换后 |
| --- | --- | --- |
| 控制台内存 | 473MB(Java)+ 179MB(MySQL)+ 13MB(Redis) | 21.8MB |
| 容器数 | 3 | 1 |
| 数据目录 | MySQL 数据卷 | 124KB 的一个文件 |
| 服务端取差异化配置 | — | **8 毫秒** |

链路验证:设备用真实 MAC 连上 → 返回绑定码 → 在控制台绑定 → 重连拿到完整配置
(音色注入、VAD/ASR 按需省略、人设、密钥都正确)→ 服务端日志出现
「大模型收到用户消息」。

## 测试

```bash
npm test        # 56 个测试:接口契约、权限边界、绑定流程
npm run check   # 类型检查 + 测试
```

契约测试用的是真实的请求形状(从运行中的官方智控台抓取比对过),
不是"我写的代码符合我写的规格"那种自证。
