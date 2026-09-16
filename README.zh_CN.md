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
它只依赖七个接口,本控制台把它们全部实现了 —— **接口层面服务端一行代码都不用改**(镜像里另有与接口无关的插件和三处修补,见「工具」一节)。

```
设备 ──wss──> 小智服务端 ──HTTP(Bearer)──> 小单控制台 ──> SQLite
                   │                              │
              ASR/LLM/TTS                    浏览器管理页面
```

契约的每个字段都对照过上游 Java 实现与服务端消费它的 Python 代码,
并有 121 个测试守着(`console/test/`)。改动接口前请先读那些测试的注释,
里面写了每条断言对应服务端的哪一行。

## 绑定设备:只有拿着设备的人能绑定

设备的 MAC 在 Wi-Fi 无线帧里是明文,谁都能抓到,不能拿它当身份。本控制台的做法:

1. 设备第一次开机时用硬件随机数生成一把 32 字节密钥存在自己闪存里,之后每次请求都放在 `Client-Id` 头里。
   控制台只存它加前缀的 SHA-256。原版小智固件保存的 UUID 也按同样方式接受。
2. 设备联网后先 `POST /xiaozhi/ota/`。未绑定时返回 `status: unbound` 与六位绑定码,**码只显示在设备屏幕上**。
   码对应的是 (MAC, 密钥) 这一对:冒充者用同一个 MAC 来要,拿到的是另一个码。
3. 在控制台「设备」页输入屏幕上的码完成绑定。页面不列出码,也不能按 MAC 一键绑定;5 分钟内输错 10 次会暂时限流。
4. 绑定之后 OTA 返回 `status: bound` 与对话服务地址。引擎每次取配置都会转来 `clientId`,控制台核对哈希,
   对不上一律回 10041,并在「设备」页记一条身份异常。

身份校验上线前绑定的设备在库里没有哈希,页面标为「需重新配对」:刷入新固件开机后屏幕会显示码,输入即可,
名称与智能体保留。恢复出厂或擦除过闪存的设备会生成新密钥,在页面上解绑后重新输码。

OTA 响应恒为 HTTP 200,结果看顶层 `status`:`bound`、`unbound`、`identity_mismatch`、`invalid_request`、
`rate_limited`、`unavailable`。细节见 `console/src/ota.ts`、`console/src/identity.ts` 与 `console/test/ota.test.ts`。

## 工具:查日期、查天气、调音量

智能体的「工具调用」选「函数调用」后,引擎每轮都把勾选的插件作为工具交给模型。本仓库自写了三个插件
(`server/plugins/`,构建镜像时覆盖进引擎的 `plugins_func/functions/`),它们除了回答,还把画面推给小单设备:

| 插件 | 做什么 | 数据来源 | 回答方式 |
|---|---|---|---|
| `show_calendar` | 日期、星期、农历;屏幕显示当月日历 | 服务器时间,农历用镜像自带的 cnlunar | 直接播报,不再经过模型 |
| `get_weather` | 实时天气与明天预报;屏幕显示天气画面。没说城市时按本次会话设备 IP 所在城市 | Open-Meteo;地点不可信或出错时用 wttr.in;IP 定位用太平洋网络 IP 库。都不需要密钥 | 模型据此口语总结 |
| `set_volume` | 调大、调小或调到某个百分比 | 无 | 直接播报 |

同时覆盖了上游两个同名插件:`get_weather`(上游先查和风再抓网页,靠写死的共享密钥)与 `handle_exit_intent`
(上游道别后断开连接,按键说话的设备随即要重连,几秒内按键没反应)。识别告别与查农历在引擎里永远开启,页面上不列开关。

推给设备的是一条扁平 JSON,只发给在 hello 里声明了 `features.xiaodan` 的设备,原版小智固件收不到:

```json
{"type":"xiaodan","cmd":"calendar","year":2026,"month":9,"day":14,"weekday":1,"first_weekday":2,"days":30,"lunar":"七月廿三","hold_s":20}
{"type":"xiaodan","cmd":"weather","city":"广州","icon":"rain","text":"小雨","temp":27,"hi":30,"lo":22,"humidity":70,"tm_icon":"cloudy","tm_text":"阴","tm_hi":29,"tm_lo":23,"hold_s":20}
{"type":"xiaodan","cmd":"volume","value":60}
{"type":"xiaodan","cmd":"volume","delta":-20}
```

`weekday` 以 0 表示星期日;`icon` 取 `sun`、`partly`、`cloudy`、`fog`、`rain`、`thunder`、`snow` 之一;温度为 −40 到 60 的整数;
`hold_s` 是回答说完后画面停留的秒数。字段范围与截断规则见 `server/plugins/xiaodan_cards.py` 开头,固件按同样的范围校验。

提示词模板要求每条回复开头放一个表情符号,引擎据此给设备发情绪消息,并从字幕与语音里去掉它。
镜像还对上游做了三处精确修补,找不到原文就让构建失败:

- `core/connection.py`:请求头日志里的设备密钥换成 `<redacted>`。
- `core/connection.py`:模型经 `direct_answer` 虚拟工具回答时补发情绪消息。开启函数调用后大多数回答走这条路,上游在这里一条情绪都不发。
- `core/providers/llm/openai/openai.py`:模型经常把工具调用写成文本放进正文,见过 DeepSeek 的 DSML(`<｜DSML｜function_calls>` …)、
  `<tool_call>get_weather</tool_call>`、`<tool_calls><tool_name>show_calendar</tool_name></tool_calls>` 等写法,上游只认结构化的 `tool_calls`,
  于是标记被念出来或整轮沉默、工具一个也不执行。提示词模板规定了一种固定写法,解析对其他写法同样宽容,并且只放行本轮提供的工具。provider 外面包了一层(`server/engine/xiaodan_tool_text.py`),
  把这些块转成结构化调用,DSML 里 `direct_answer` 的文字边收边交;不带工具的回复里出现的块直接删掉。每次转换或删除都在引擎日志里记一条警告。

自写的 Omni 语音合成遇到没有字母、数字或汉字的片段时直接给 50 毫秒静音:否则发过去的只剩"逐字朗读"那句指令,模型会把指令本身念出来。

新装的实例默认就是函数调用并勾选这三个插件。已有实例不会被改动:在「智能体」页把工具调用切到「函数调用」并勾选即可。
所用模型必须支持 function calling:OpenAI 的 `tools` 与流式 `tool_calls`,或者上面那些写在正文里的调用文本。

## 智能体大脑(控制塔运行时)

智能体(角色)有两种「大脑」,在智能体页切换,切回即回退:

- **引擎旧路径**:上游引擎按函数调用跑工具,一轮最多递归五层,工具与提示词模板全局共用。
- **控制塔智能体**:一轮对话交给控制塔跑多步循环(模型 → 工具 → 模型 → … → 回答),工具、MCP、技能、提醒、内容库都在控制塔。

```
设备 ─▶ 引擎:ASR → chat()(nointent)→ LLM provider「xiaodan_agent」──POST──▶ 控制塔 /xiaodan/agent/turn
                                         ◀── text/event-stream:text · device · media · close_after_turn · 心跳 · done
      引擎:TTS ◀─ 文字;设备消息直接发给设备;音频文件排进合成队列
      引擎设备桥 :8003 /xiaodan/bridge/* ◀── 控制塔:调用引擎插件(日历/天气/音量)、主动播报、推送画面
```

- 控制塔在 agent-models 里给这类智能体下发 `xiaodan_agent` provider(按设备签发的令牌 `mac.HMAC(secret)`),
  并固定 Intent=nointent、Memory=nomem、不下发插件、`chat_history_conf=0`(对话记录由控制塔自己写,带智能体 ID)。
- 文字边生成边交给引擎,设备立刻开始说;工具并行执行、各有超时;步数到上限后最后一次不给工具强制回答。
  心跳每 2 秒一条,provider 读到心跳就检查用户是否打断;打断时关掉请求,控制塔随之取消模型调用与工具。
- 设备 150 秒空闲就重连一次(新会话),控制塔按设备保留最近 16 轮对话(最近 3 轮带完整工具往来),30 分钟不说话才算新对话。
- 系统提示词按角色组装:能做什么、做不到什么按本轮可用的工具生成,不再写死在模板里;儿童模式追加儿童安全约束。
- 引擎补丁新增三处:连接建立时登记、`close()` 时注销(设备桥按会话与 MAC 找连接),http 服务挂上 `/xiaodan/bridge/*`(manager-api secret 鉴权)。
  两项引擎参数的默认值随之调整(迁移 v3,只改仍是旧默认值的库):退出指令清空(说"关闭"会被当成断线指令),
  无语音断开时间改为 600 秒(设备 150 秒重连,120 到 150 秒之间说话会先念告别语)。
- 控制塔「试聊」页不接硬件跑同一个循环,并摊开每一步的工具调用;可借用一台在线设备执行引擎里的工具。
- 纯逻辑与测试:`server/engine/xiaodan_bridge_core.py`(单元测试)、`console/src/agent/`(`console/test/agent.test.ts`);
  `server/tests/smoke_agent.py` 在镜像里用真实的 `chat()` 对着假控制塔跑一轮、打断、兜底与设备桥全部接口。

### 控制塔智能体的能力

- **联网搜索**(工具 `web_search`,插件代号 `search`):服务商在「工具与服务」页配置、可切换。默认 DeepSeek 官方联网搜索——
  DeepSeek 的 Chat 与 Responses 接口都不带搜索,但它的 Anthropic 兼容接口支持 `web_search_20250305` 服务端工具
  (deepseek-ai/deepseek-harness 的默认搜索就是这么做的),每个查询一次 Messages 请求,偶尔不触发搜索时重试一次;可沿用对话模型的密钥。另有博查、Tavily。
- **MCP**:自写的最小 Streamable HTTP 客户端(initialize → tools/list 分页 → tools/call,JSON 与 SSE 响应、会话过期重连),
  只接远程 https 服务器;在「MCP」页添加与测试,在智能体页按角色勾选、可逐个工具放行。工具名 `mcp_<服务器>__<工具>`,结果作为外部资料交给模型。
  地址里常带个人令牌,列表只显示域名与路径,令牌不进仓库。
- **技能**:兼容 Agent Skills 的 `SKILL.md`(粘贴、上传 .md 或 .zip,不执行脚本);提示词里只列名字与描述,
  需要时 `load_skill` 读正文(本段对话之后自动带上)、`read_skill_file` 读附带文件。内置 `bedtime-story`、`word-coach`、`ai-news-brief`。
- **定时提醒**(`create_reminder`/`list_reminders`/`cancel_reminder`,插件代号 `reminders`):控制塔每 5 秒扫到期提醒,经设备桥播报
  (提示音 + "提醒你:…" + 新固件的提醒卡片);设备忙 5 秒后重试,不在线每 15 秒重试、3 分钟后记为错过;
  设备下次来取配置时补报 12 小时内错过的提醒。重复提醒(每天/工作日/每周)送达后滚到下一次。

- **讲故事与放音乐**(`list_stories`/`play_story`、`list_music`/`play_music`,插件代号 `stories`、`music`):内容库在「内容库」页管理。
  自带 6 篇原创儿童故事(`media/stories/`,MIT)与 10 首许可逐一核实过的曲目(`media/music/`,公有领域、CC0 或 CC BY,
  来源、许可与署名见 `media/music/LICENSES.md`,CC BY 的署名在内容库页展示),控制塔启动时缺了才补进数据目录。
  故事音频在配好千问合成模型后由后台自动合成(按段落切块逐块合成、拼成一个 mp3);还没有音频的故事交给模型直接讲(放宽输出长度)。
  播放时控制塔发 `media` 事件,引擎从控制塔内网地址下载(secret 鉴权、同源校验、缓存)后排进合成队列,跟在引导语后面播,播文件期间每约 20 秒保活一次。
- **学单词**(`vocab_next`/`vocab_show`/`vocab_answer`/`vocab_progress`,插件代号 `vocab`):自带 300 词原创启蒙词书(`media/vocab/`),
  可导入 CSV/JSON;记忆曲线按 Leitner 盒子(答错 5 分钟后再考,答对依次 1/2/4/7/15 天);新固件显示单词卡;配合技能 `word-coach` 使用。

## 千问语音与音色

语音识别与合成可以直接接百炼(Qwen-Audio 3.0),不经模型网关:

- 识别 `qwen_audio_asr`:松手后整段音频包成 WAV,走同步接口 `qwen-audio-3.0-asr-flash`,可配热词。
- 合成 `qwen_audio_tts`:`qwen-audio-3.0-tts-flash`,CosyVoice 协议的 WebSocket,**每句话一个任务**,收到的 PCM 边到边编码。
  没有沿用上游的 `alibl_stream`:它把整轮开成一个任务,控制塔跑多步工具时文字停顿会让百炼关掉空闲任务;它还把音频文件攒到整轮末尾才播。
  采样率按引擎连接的 `sample_rate`(握手模板里是 24000)请求,与引擎的 Opus 编码器一致。
- 顺带修了上游基类两处:中途插入音频文件后后面的文字被跳过(`processed_chars` 累加错误);
  播放音频文件时每约 20 秒插一条 `sentence_start`,免得设备 60 秒的播放看门狗把长音乐、长故事截断。
- 两个 provider 的纯逻辑在 `server/engine/qwen_audio.py`(单元测试),联网部分由 `server/tests/smoke_qwen_audio.py` 在镜像里对着假的百炼服务端跑一遍。

「音色」页管理挂在千问合成模型下的音色:导入 12 个有名字的系统音色(含 3 个儿童音色)、试听、**声音设计**(文字描述生成)、
**声音复刻**(10–20 秒录音,须勾选已获授权)。设计与复刻的音色要等百炼审核通过才会下发给设备,之前设备用模型默认音色。
复刻样本先试百炼的临时上传(`oss://`);不行就由控制塔在 `/xiaozhi/ota/voice-sample/<令牌>` 提供一个 10 分钟有效的一次性链接
(这个前缀在 nginx 上不走统一鉴权,百炼取得到),创建请求结束即作废。智能体可以单独调语速、音调、音量与语气指令。

## 目录

```
console/            控制台(Node + Vue)
  src/
    manager-api.ts    ← 服务端调的七个接口,项目的核心
    ota.ts            ← 设备 OTA / 激活(兼容原版小智固件)
    admin-api.ts      ← 页面用的管理接口
    identity.ts       ← 设备身份:密钥哈希、绑定码、身份异常
    catalog.ts        ← 供应商与插件目录(代码常量,不是数据库表)
    schema.sql        ← 表结构的 v0 基线
    migrations.ts     ← 之后的表结构变化,按 PRAGMA user_version 顺序执行
    voice/            ← 音色:百炼试听、声音设计与复刻、系统音色表、复刻样本的一次性链接
    agent/            ← 智能体运行时:对话接口、多步循环、提示词、上下文、工具注册、设备桥客户端
    cli.ts            ← 命令行:设密码、从旧配置导入密钥
  web/                前端页面:设备、智能体、音色、试聊、模型、对话记录、读音替换、设置;浅色与深色主题,
                      不引外部资源(响应带同源内容安全策略)
  test/               契约测试
server/             小智服务端的配套文件
  providers/          自写的 ASR / TTS provider:模型网关(chat 接口)与千问语音(百炼)
  engine/             补进引擎的模块:工具调用文本转结构化调用、千问语音的纯逻辑、设备桥与 xiaodan_agent provider
  assets/             提醒提示音
media/              内容素材:原创故事、许可核实过的曲库、单词书(打进控制塔镜像,启动时导入)
  plugins/            自写的插件:日历、天气、音量,以及覆盖上游的天气与告别插件
  tests/              插件、工具调用文本转换、千问语音的单元测试(只用标准库)与三个镜像冒烟脚本
  prompts/            提示词模板
  config.api.yaml     api 模式的配置模板
```

## 本地运行

```bash
npm ci
npm run build
XIAODAN_DATA_DIR=./data node console/dist/server.js
```

打开 http://127.0.0.1:8002。默认是 proxy 鉴权模式,控制台不做登录检查(见下面「鉴权」);
本地想要登录页就加上 `XIAODAN_AUTH_MODE=local`,第一次打开会让你设置管理员账号,之后不再开放注册。

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

服务端日志出现「从API读取配置」即成功。设备开机后屏幕会显示六位绑定码,
在控制台「设备」页输入即可。

回滚就是把 `.config.yaml` 换回单模块那份再重启,控制台可以继续开着。

## 接入 ServerOps 面板

本仓库产出两个镜像,对应面板里同一个应用的两个组件:

| 组件 | 镜像 | 容器端口 | 健康检查 | 数据目录 |
|---|---|---|---|---|
| `console` | `ghcr.io/thesyart/xiaodan-server-console` | 8002 | `/health` | `/app/data` |
| `engine` | `ghcr.io/thesyart/xiaodan-server-engine` | 8000 | `/` | `/opt/xiaozhi-esp32-server/data` |

engine 在项目网络里用组件名访问控制台,所以 `.config.yaml` 的
`manager-api.url` 要写 `http://console:8002/xiaozhi`。8003 不再对外发布:
OTA 由控制台提供,视觉分析接口本来就没有 nginx 路由。

引擎按 `X-Real-IP` → `X-Forwarded-For` → 对端地址取设备 IP,天气插件据此定位城市。nginx 的站点配置里要有
`proxy_set_header X-Real-IP $remote_addr;`,否则引擎只看到容器网关的内网地址,日志会提示"不是公网 IP",天气退回默认城市。

**面板不读本仓库的 `compose.yaml`**。它按 root 批准的策略自己渲染一份,固定为
非 root、`cap_drop: ALL`、`no-new-privileges`、默认 seccomp、仅回环端口、
bind 挂载 `create_host_path:false`,没有内存上限也没有 `depends_on`。
上游编排里那条 `seccomp:unconfined` 面板无法表达 —— 实测也不需要,
默认 seccomp 下音频链路全部正常。

engine 的启动顺序不靠 `depends_on`:取不到控制台时它会重试六次(每次 10 秒)
后退出,由 `restart: unless-stopped` 拉起来重来。

### 服务器侧需要 root 先批准的东西

```
/etc/serverops/image-policies/<应用UUID>.json   端口、UID/GID、env 文件、数据目录
/etc/serverops/apps/xiaodan-server-console.env  root 0600,内容 XIAODAN_AUTH_MODE=proxy
/srv/serverops/data/xiaodan/{console,engine}    1000:1000 0750,父目录 root 0750
```

数据目录必须**在第一次发布之前**就存在且属主正确:面板拉镜像那一步就会校验,
远早于任何切换。helper 的 unit 还要把 `/srv/serverops/data/xiaodan` 加进
`ReadWritePaths`,否则它做不了停机备份与失败恢复。compose 项目网络需要预先建好,
带上 `com.docker.compose.project` 与 `com.docker.compose.network` 两个标签。

### 首次接管

常规发布要求已经存在一份确认过的旧版本,所以第一次必须走 root 本地的 adopt:
维护页 → 停旧容器 → 一致性备份 → 拷数据 → 用面板渲染的 compose 起容器 →
验就绪 → 恢复入口 → 停 helper → `node helper/dist/image-bootstrap.js adopt …` → 起 helper。
之后"更新并上线"就是一键的了。

### 关于引擎镜像的体积

上游镜像 10.5G,其中 pip 层的 6.4G 几乎全是本地跑 ASR 模型用的
(nvidia CUDA 2.8G、torch 1.5G、triton 419M 等)。我们 ASR 走网关、
VAD 只读一个 7.5M 的 onnx,这些从未被加载 —— 在生产进程的
`/proc/<pid>/maps` 里确认过。所以 Dockerfile 分两段:先在上游镜像里删,
再把结果拷进干净的系统层,成品 1.86G。包的版本与二进制完全沿用上游那批,
不重新 `pip install`,避免引入版本差异带来的、往往只在冷路径上才暴露的风险。

## 命令行

```bash
node console/dist/cli.js set-password <用户名> <密码>     # 设置管理员(仅 local 模式需要)
node console/dist/cli.js clear-local-admin                # 清除本地账号与会话(切到 proxy 后用)
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

### 接入面板后(2026-09-14)

整套改走 ServerOps 的镜像发布通道之后,在同一台服务器上测得:

| 项 | 结果 |
| --- | --- |
| 引擎镜像 | 10.5GB 降到 1.86GB |
| 控制台内存 | 37MB |
| 引擎内存 | 365MB |
| 运行身份 | 两个容器都是 UID 1000,不再以 root 运行 |
| 切换时新容器就绪 | 6 秒 |

上游编排里写死的 `seccomp:unconfined` 实测并不需要:默认 seccomp 下
Opus 解码和 onnxruntime 都工作正常。

## 测试

```bash
npm test        # 121 个测试:接口契约、权限边界、设备身份与绑定、数据库迁移
npm run check   # 类型检查 + 测试
python3 -m unittest discover -s server/tests -v   # 29 个插件测试:卡片字段、天气解析、日期与音量(只用标准库)
```

契约测试断言的是服务端真正消费的响应形状,每条都在注释里写明对应服务端的哪段代码,
不是"我写的代码符合我写的规格"那种自证。
