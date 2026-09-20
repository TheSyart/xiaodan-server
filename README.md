<p align="right">
  <a href="README.zh_CN.md">简体中文</a> · <strong>English</strong>
</p>

# Xiaodan Console

A small console for the `xiaozhi-esp32-server` voice assistant backend, replacing its
official "智控台" management application.

One Node process, one SQLite file. No MySQL, no Redis, no Java.

## Why rewrite it

The official console is Spring Boot plus Vue and needs MySQL and Redis to run. It creates
30 tables through more than a hundred changelogs and ships multi-tenant registration, SMS
verification codes, SM2 encryption, a knowledge base, voiceprints, voice cloning, MCP
endpoint management and OTA firmware distribution.

What this deployment actually needs is six things: **bind a device, edit the persona,
switch models and keys, pick a voice, toggle plugins, read conversation logs**. Three
containers and 630 MB of memory is a poor trade for that. More decisively, that Compose
shape (bind mounts, `command`, `env_file`) can never be managed by the operations panel
running on this server.

| | Official console | This console |
| --- | --- | --- |
| Containers | 3 (Java + MySQL + Redis) | 1 |
| Memory | 665 MB measured | **21.8 MB** measured |
| Tables | 30 | 10 |
| Backup | needs mysqldump | copy one file |
| Panel-manageable | no | yes |

It also fixes one upstream design problem; see **Binding codes** below.

## Relationship with the server

In **API mode** the xiaozhi server takes its configuration over HTTP instead of from a
local YAML file. It depends on exactly seven endpoints, all implemented here, so **the
server needs no code changes for the configuration interface** (the image separately carries plugins and three
patches unrelated to it; see the tools section).

```
device ──wss──> xiaozhi server ──HTTP (Bearer)──> Xiaodan Console ──> SQLite
                      │                                  │
                 ASR/LLM/TTS                      browser management UI
```

Every field of that contract was checked against the upstream Java implementation and
against the Python code that consumes it, and 240 tests hold it in place
(`console/test/`). Read those test comments before changing an endpoint: each assertion
records which server behaviour it protects.

## Binding a device: only whoever holds it can bind it

A device's MAC travels in clear text in Wi-Fi frames, so anyone nearby can read it. It cannot
serve as an identity. This console works as follows:

1. On first boot the device generates a 32-byte secret from the hardware random number
   generator, keeps it in flash, and sends it in the `Client-Id` header on every request. The
   console stores only a prefixed SHA-256 of it. The UUID that stock xiaozhi firmware saves is
   accepted the same way.
2. Once online, the device calls `POST /xiaozhi/ota/` first. While unbound the reply is
   `status: unbound` with a six-digit binding code, and **the code is shown only on the
   device's screen**. The code belongs to the (MAC, secret) pair: an impostor asking with the
   same MAC receives a different code.
3. Type the code from the screen into the console's Devices page. The page never lists codes
   and cannot bind by MAC; ten wrong codes within five minutes trigger a temporary limit.
4. After binding, OTA replies `status: bound` with the conversation service address. The
   engine forwards `clientId` each time it fetches configuration and the console checks the
   hash. A mismatch always returns 10041 and records an identity event on the Devices page.

Devices bound before identity checks existed have no hash and are marked *needs re-pairing*:
flash the new firmware, boot, and type the code the screen shows. Name and agent are kept.
A device that was factory-reset or had its flash erased generates a new secret; unbind it on
the page and enter its new code.

OTA always answers HTTP 200 with a top-level `status`: `bound`, `unbound`,
`identity_mismatch`, `invalid_request`, `rate_limited` or `unavailable`. See
`console/src/ota.ts`, `console/src/identity.ts` and `console/test/ota.test.ts`.

## Tools: date, weather and volume

This repository ships three plugins of its own (`server/plugins/`, copied over the engine's `plugins_func/functions/` when
the image is built). They run inside the engine; when an agent has the matching capability ticked, the console brain calls
them through the device bridge (see "Agent brain"). Besides answering, they push a screen to the Xiaodan device:

| Plugin | What it does | Data source | How it answers |
|---|---|---|---|
| `show_calendar` | date, weekday and lunar date; shows this month's calendar | server clock, lunar date from the bundled cnlunar | spoken directly, no second model call |
| `get_weather` | current weather and tomorrow's forecast; shows a weather screen; without a named city it uses the city of the device's IP for the session | Open-Meteo, or wttr.in when the place is uncertain or the call fails; IP lookup via the pconline IP database; none needs a key | the model summarises it |
| `set_volume` | louder, quieter, or a given percentage | none | spoken directly |

`get_weather` also replaces the upstream plugin of the same name (upstream queries QWeather and then scrapes a web page with a
hard-coded shared key). The function descriptions the model sees come from the console (`console/src/agent/engine-tools.ts`);
the engine plugins are only called by name through the device bridge, and settings such as how long a screen stays or the
default city live on the console's Tools page and travel with each call.

The device receives one flat JSON message, and only if its hello declared `features.xiaodan`; stock xiaozhi firmware
never sees it:

```json
{"type":"xiaodan","cmd":"calendar","year":2026,"month":9,"day":14,"weekday":1,"first_weekday":2,"days":30,"lunar":"<lunar date>","hold_s":20}
{"type":"xiaodan","cmd":"weather","city":"<city>","icon":"rain","text":"<condition>","temp":27,"hi":30,"lo":22,"humidity":70,"tm_icon":"cloudy","tm_text":"<condition>","tm_hi":29,"tm_lo":23,"hold_s":20}
{"type":"xiaodan","cmd":"volume","value":60}
{"type":"xiaodan","cmd":"volume","delta":-20}
```

`weekday` counts Sunday as 0; `icon` is one of `sun`, `partly`, `cloudy`, `fog`, `rain`, `thunder`, `snow`;
temperatures are integers from -40 to 60; `hold_s` is how long the screen stays after the answer ends. Ranges and
truncation rules are documented at the top of `server/plugins/xiaodan_cards.py`, and the firmware validates the same ranges.

The prompt template asks for one emoji at the start of every reply. The engine turns it into an emotion message for the
device and strips it from subtitles and speech. The image also carries three exact patches to upstream code, and the
build fails if any anchor is missing:

- `core/connection.py`: the device secret in the header log line becomes `<redacted>`.
- `core/connection.py`: replies that come through the `direct_answer` virtual tool now send an emotion message. When the
  engine runs function calling itself, most replies take that path, and upstream sends no emotion there at all.
- `core/providers/llm/openai/openai.py`: models sometimes write tool calls as text inside the reply instead of structured
  `tool_calls`. Forms seen so far include DeepSeek DSML (`<｜DSML｜function_calls>` ...), `<tool_call>get_weather</tool_call>` and
  `<tool_calls><tool_name>show_calendar</tool_name></tool_calls>`; upstream spoke the markup or stayed silent and ran no tool. The
  prompt template prescribes one fixed form, the parser stays tolerant of the others, and only tools offered in the turn pass. The provider is
  wrapped (`server/engine/xiaodan_tool_text.py`): such blocks become structured calls and DSML `direct_answer`
  text streams as it arrives, while such blocks in replies without tools are removed. Each conversion or removal logs a
  warning.

The last two patches serve the removed engine path (the engine running function calls itself). They stay in the image, along with
the model gateway provider files, until the production database is confirmed clean after migration.

New agents have these three tools switched on. Which tools a role uses is decided on the Agents page; the Models page no longer has
a *tool calling* setting. The chat model must support function calling: OpenAI `tools` with streamed `tool_calls`. When a model writes
a call as one of the text forms above, the console recognises and runs it as well.

## Agent brain (console runtime)

Every agent (role) has its brain in the console: each turn is handed to the console, which runs a multi-step loop
(model → tools → model → … → answer). Tools, MCP, skills, reminders and the content library all live in the console. The engine
only listens (VAD, ASR), speaks (TTS) and runs the few plugins that must run inside it. The old engine path (the engine running
function calls itself) was removed in migration v8, together with the Intent, Memory and vision model types.

```
device ─▶ engine: ASR → chat() (nointent) → LLM provider "xiaodan_agent" ──POST──▶ console /xiaodan/agent/turn
                                               ◀── text/event-stream: text · device · media · close_after_turn · heartbeat · done
          engine: TTS ◀─ text; device messages go straight to the device; audio files are queued for playback
          engine device bridge :8003 /xiaodan/bridge/* ◀── console: call engine plugins (calendar/weather/volume), announcements, screen pushes
```

- For every agent, agent-models sends the `xiaodan_agent` provider with a per-device token (`mac.HMAC(secret)`), fixes
  Intent=nointent and Memory=nomem, sends no plugins and sets `chat_history_conf=0` (the console writes chat history itself, tagged
  with the agent ID; nothing is written when the agent's chat history setting is off).
- **Images**: once a chat model has *supports images* switched on in the Models page, the Playground accepts image attachments
  (at most 3, shrunk to 1024 px in the browser) and images returned by MCP tools are passed to the model. Without it there is no
  image understanding: the prompt says so, and a turn with images carries a note that the model cannot see them.
- Text streams to the engine as it is generated, so the device starts speaking immediately; tools run in parallel with
  individual timeouts; when the step budget is used up, a final call without tools forces an answer. A heartbeat every
  2 seconds lets the provider notice interruptions; interrupting closes the request and the console cancels the model call and tools.
- The device reconnects (new session) after 150 idle seconds, so the console keeps the last 16 turns per device (the last 3 with
  full tool exchanges); a new conversation starts after 30 silent minutes.
- The system prompt is assembled per role: what it can and cannot do is generated from the tools available in the turn instead of
  being hard-coded in a template; child mode adds child-safety rules.
- Three more engine patches: register the connection when it is established, unregister in `close()` (the bridge finds connections by
  session and MAC), and mount `/xiaodan/bridge/*` on the http server (manager-api secret auth). Two engine settings change their
  defaults (migration v3, only where still at the old default): exit commands are cleared (saying "关闭" closed the connection), and the
  no-voice disconnect becomes 600 s (with a 150 s device reconnect, speaking between 120 and 150 s triggered a goodbye first).
- The console's Playground page runs the same loop without hardware and shows every tool step; it can borrow an online device to run
  the engine-side tools.
- Pure logic and tests: `server/engine/xiaodan_bridge_core.py` (unit tests), `console/src/agent/` (`console/test/agent.test.ts`);
  `server/tests/smoke_agent.py` drives the real `chat()` inside the image against a fake console, including interruption,
  fallbacks and every bridge endpoint.

### Console agent capabilities

Capabilities come in three kinds, each managed on its own page. The Agents page only decides which ones each role uses and holds
no capability settings; migration v10 merged the per-role settings into one global copy:

| Kind | What it is | What its page does | Where settings live |
|---|---|---|---|
| Tool | a function implemented in the server code (the items below) | view the description and the functions the model sees, edit settings; tools cannot be created or deleted | `tool_settings`, shared by all roles |
| Skill | a `SKILL.md` playbook you write yourself; none are built in | create, import, edit, delete; shows the tools it needs and the roles using it | `skills` |
| MCP | an external tool server | add, import JSON, edit, delete, test; choose which of its tools it offers and write its usage notes | `mcp_servers` |

Each capability belongs to exactly one kind. Storytelling and vocabulary are tools, and how to tell a story or run a lesson is
written in their descriptions and results (it only enters the context when used). AI news is an MCP server, and how to use it is
written in the server's usage notes (they enter the prompt when a role has the server on). Skills are only for your own playbooks
that combine several things; when a role switches on a skill whose tools are off, the Agents page says so and can switch them on
in one click. Migration v11 removed the three former built-in skills (unchanged ones are deleted, edited ones are kept as your own).

- **Web search** (tool `web_search`, code `search`): providers are configured and switched under web search on the Tools page.
  The default is DeepSeek's official web search: neither DeepSeek's Chat nor Responses API offers search, but its Anthropic-compatible
  API supports the `web_search_20250305` server tool (the default search in deepseek-ai/deepseek-harness). One Messages request per query,
  retried once when the model does not trigger a search; the chat model's key can be reused. Bocha and Tavily are also available.
- **MCP**: a minimal Streamable HTTP client written here (initialize → paginated tools/list → tools/call, JSON and SSE responses,
  re-initialising expired sessions), remote https servers only; add and test servers on the MCP page, choose there which of each
  server's tools it offers and write its usage notes (added to the prompt when a role has the server on); the Agents page only
  switches servers on or off. Tools are named `mcp_<server>__<tool>` and results are
  handed to the model as external data.
  Server URLs may carry tokens, so lists only show the origin and path.
  - **Built in: AIHOT (AI热点资讯)**. `https://aihot.news/api/mcp` is anonymous and read-only (no token) and offers 5 tools: latest
    news, search, hot topics, story timelines and the daily report. On first start the console adds it, with usage notes saying which
    tool answers which question and how to present the news, and enables it for every existing agent. After that it never re-adds
    it or changes its links or notes, so deleting, unticking or editing it sticks. The 小单 and AI资讯官
    templates link it automatically. Personal non-commercial use is free; external commercial products need AIHOT's written consent.
  - **Paste JSON import**: the MCP page accepts the `{"mcpServers": {...}}` config used by Claude, Cursor and Codex, several servers at
    once. The entry's name becomes the server id, each imported server is tested straight away, and it can be enabled for every
    agent. Local command (stdio) servers and the legacy SSE transport are skipped with a reason, and an endpoint that already
    exists is not added twice.
- **Skills**: Agent Skills-compatible `SKILL.md` (paste, or upload .md or .zip; scripts are never executed). The prompt lists only names
  and descriptions; `load_skill` reads the body when needed (kept for the rest of the conversation) and `read_skill_file` reads attached files.
  None are built in.
- **Timed reminders** (`create_reminder`/`list_reminders`/`cancel_reminder`, plugin code `reminders`): the console scans due reminders every
  5 seconds and announces them through the device bridge (chime + "提醒你:…" + a reminder card on new firmware). A busy device is retried after
  5 s; an offline one every 15 s and marked missed after 3 minutes; missed reminders from the last 12 hours are announced when the device next
  fetches its configuration. Repeating reminders (daily, weekdays, weekly) roll forward after delivery.

- **Stories and music** (`list_stories`/`play_story`, `list_music`/`play_music`, plugin codes `stories`, `music`): managed on the
  Content page. Ships 6 original children's stories (`media/stories/`, MIT) and 10 tracks whose recording licences were verified one by one
  (`media/music/`, public domain, CC0 or CC BY; sources, licences and attributions in `media/music/LICENSES.md`, CC BY credits shown on the
  Content page), copied into the data directory on startup when missing. Story audio is synthesised in the background once a Qwen TTS model
  is configured (paragraph chunks joined into one mp3); stories without audio are told by the model directly (with a larger output limit).
  Playback sends a `media` event; the engine downloads the file from the console's internal address (secret auth, same-origin check, cache),
  queues it after the spoken introduction and sends a keepalive about every 20 s while it plays.
  Level-3 firmware (`features.xiaodan >= 3`) also gets a story/music card: the console first sends `{"cmd":"media","k","t","s","a","cps","hold_s"}`.
  Story synthesis records each chunk's measured duration (`timing_json`, migration v9; older audio is measured by scanning the file's frames at
  play time). The story text is cut into short cues with an estimated narration time, and the engine inserts each cue into the audio stream when
  that many frames have played (`sentence_start` text starting with U+001E). The device types it out and scrolls after two lines.
- **Vocabulary** (`vocab_answer`/`vocab_progress`, plus `vocab_deck` for level-3 firmware or `vocab_next`/`vocab_show` for older firmware, code `vocab`): ships an original 300-word starter book
  (`media/vocab/`), accepts CSV/JSON imports, schedules reviews with Leitner boxes (a wrong answer comes back after 5 minutes, correct answers
  after 1/2/4/7/15 days), shows word cards on new firmware. Asking how many words to learn, not explaining each word, and how to run the quiz are written in the tool descriptions and results.
  Level-3 firmware gets a word deck, `vocab_deck`: the model first asks how many words to learn, then sends one
  `{"type":"xiaodan_deck","id","i","n","w","m","e","say"}` per word. The engine stores `say` (word, meaning, example) by MAC and deck id and
  strips it before forwarding. The child flips words with the up and down keys; clicking OK sends `{"type":"xiaodan","cmd":"deck_say","id","i"}`,
  which the engine speaks straight through TTS without the model (Dockerfile patch 7 registers the handler in `textHandle`), answering
  `deck_busy` when busy or when the deck has expired.

- **Drawing** (`generate_image`, plugin code `image`): text-to-image models are configured on the Models page, Qwen (Model Studio) only:
  - `qwen-image-3.0-pro` (recommended), `qwen-image-2.0` and `z-image-turbo` use the synchronous `multimodal-generation/generation` endpoint;
  - `wan2.7-image` and `wan2.7-image-pro` run as async tasks, polled every 2 seconds for at most 110 seconds, and can be interrupted.
  - A new image model is prefilled with the key and workspace of an existing Qwen model; "Draw a test image" on the Models page shows a pixel-art preview.
  - The image model is chosen under drawing on the Tools page (shared by all roles); otherwise the default model from the Models page is used.

  The prompt gets a small-screen style suffix (centred subject, flat colours; child mode adds child-safety wording) and the original goes to the Gallery.
  A worker thread crops to a square, area-averages to 128×128, picks 16 colours by median cut, applies Floyd–Steinberg dithering and packs
  4 bits per pixel (8192 bytes), sent as 16 chunks of `{"type":"xiaodan_img","id","seq","n","w","h","pal","d"}` to devices with
  `features.xiaodan ≥ 2`. Each chunk carries 512 bytes, so a whole message stays under the firmware's 1024-byte receive buffer. The
  Gallery page compares the original with the pixel art and can resend it to a device.

- **Role templates**: "Create from template" on the Agents page builds a ready-made role. There are four templates:
  - 小单: a general assistant.
  - 童童: a children's companion with child safety rules and a child voice.
  - 英语老师: an English tutor.
  - AI资讯官: an AI news presenter that links an MCP server whose name contains `aihot`.

  Each template fills in the persona, tools, skills, greeting and voice. Models are copied from the default agent. A template can
  carry voice settings (童童: rate 0.95, gentle, storytelling and a set of emotion tags); when they differ from the system voice's
  settings, a variant is created (「龙泡泡·童童」) and reused the next time the same settings are needed. The result is an ordinary agent; anything missing, such as the aihot MCP server, is listed after
  creation.
- **Switching roles by voice** (`list_roles`/`switch_role`, plugin code `roles`): saying "换童童来陪我" rebinds the device.
  - Persona, tools and memory rules come from the console, so they apply from the next turn.
  - Voice, recognition and other engine-side settings are fixed when the connection opens. When those differ, the console closes
    the connection after the turn; the device reconnects, fetches the new configuration and the new role greets in its own voice.
  - The device page's "Switchable roles" dialog can restrict which roles a device may switch to. Without a restriction, every
    role is allowed.
- **Long-term memory** (`remember`/`forget`/`list_memories`, plugin code `memory`, with its own "Memory" page): roles with this tool
  record facts about the user, one short sentence each. Facts are stored per device and shared across roles; the agent page decides
  which roles may use memory, while the content is managed on the memory page.
  - Every fact is filed under one category: name and identity, family, contact details, home and frequented places, likes, what the
    user is learning, health notes, daily routine. The recording scope is editable on the memory page and the same text goes into the
    `remember` function description, so live recording and later tidying follow one rule.
  - **Addresses and contact details are recorded but marked private**: masked on the page, and the prompt only states that they exist
    and can be fetched when needed, never the text itself. Passwords, payment details, card and ID numbers are never recorded.
  - A fact that contains or is contained in an existing one updates it instead of piling up. Each device keeps at most 60 facts of up
    to 90 characters, and the oldest automatic one makes room; facts added by hand are never pushed out.
  - Every record, edit and deletion leaves a trail on the memory page and can be undone with one click.
  - **Conversation arcs (cold memory)**: about ten minutes after a conversation settles, a background job turns it into one record
    (title, one-sentence summary, a few bullets, keywords). The transcript stays in the database and can be expanded turn by turn on
    the page. The former "Chat history" page was folded into this one.
    - Segments are cut on time gaps (a pause longer than 30 minutes starts a new one), not on connections: the device reconnects
      every 150 idle seconds, so cutting on connections would shatter one evening into a dozen fragments.
    - Tidying up and correcting or adding hot memory happen in the same model call, never a second one. At most three memory changes
      are accepted per arc, and the category and the hard limits are decided server-side.
    - When tidying fails (model error, unparsable answer) it backs off and retries three times, then falls back to a plain title. The
      transcript stays readable and the page offers a manual retry.
    - The migration writes a watermark: conversations from before it are not tidied retroactively and are listed under "Not tidied yet".
    - The model calls `recall_memory` to find arcs by keyword or date and then pulls one arc's transcript by id. A short index of what
      was discussed before stays in the system prompt.
    - Transcripts are kept forever by default; set a retention in days on the memory page and tidied transcripts are cleared while the
      summaries remain.
  - Unbinding a device deletes its memory.

## Device location

**Off by default, enabled per device** (the "Location" column on the device page). Only the latest fix is stored; turning the
feature off deletes it, and so does unbinding the device.

- **From nearby Wi-Fi access points** (tens of metres in a city): while idle the device scans for access points and reports their
  BSSIDs and signal strengths; a location service turns that into coordinates. The provider is configured under "Location service"
  on the settings page (Amap's hardware location API, which needs a Web service key). **At least two access points** are required.
  This tier needs firmware that can scan.
- **Public IP as a fallback** (city level, 3-20 km): the `client_ip` that comes with every turn, no key required. It needs nginx to
  forward `X-Real-IP`; otherwise only a private address is visible and the lookup is skipped rather than returning the server's own
  location.
- Coordinates are in **GCJ-02** (Amap's system), labelled as such and never converted. No map SDK is embedded — the content
  security policy blocks external scripts — just a link that opens the point in Amap's web map.
- **No BSSID is ever written to the database**: scan results live in memory only until they are resolved, and IPs and BSSIDs are
  masked in the logs.
- A failed fix records the reason and never overwrites the previous location.

## Qwen speech and voices

Speech recognition, speech synthesis and text-to-image all use Alibaba Cloud Model Studio (Qwen) directly, without the model gateway;
the Models page only offers Qwen for these three types.

Every model can use the same workspace address `https://<workspace>.cn-beijing.maas.aliyuncs.com/api/v1` and the same API key.
Recognition, synthesis and text-to-image use the native API; chat models use the same workspace's compatible mode, and an address
entered as `/api/v1` or as the bare host is rewritten to `/compatible-mode/v1`. A new model is prefilled with the key and address of
an existing one. Synthesis and image results sit in an OSS result bucket and Model Studio returns http URLs; the console upgrades
http URLs on `*.aliyuncs.com` to https and refuses every other http URL.

- Recognition `qwen_audio_asr`: after the button is released the whole clip is wrapped as WAV and sent to the synchronous
  `qwen-audio-3.0-asr-flash` endpoint, with optional hot words.
- Synthesis `qwen_audio_tts`: `qwen-audio-3.0-tts-flash` or `qwen-audio-3.0-tts-plus` (their system voices differ and cannot be mixed,
  so switching is refused while agents use the model's voices), over the CosyVoice WebSocket protocol, **one task per sentence**,
  encoding PCM as it arrives. Upstream `alibl_stream` is not reused: it opens one task per turn, so pauses while the console runs
  multi-step tools let the service close the idle task, and it holds audio files until the end of the turn.
  The sample rate follows the engine connection's `sample_rate` (24000 in the handshake template), matching the engine's Opus encoder.
- Two upstream base-class problems are fixed on the way: text after an audio file inserted mid-turn was skipped (a wrong
  `processed_chars` increment), and audio-file playback now inserts a `sentence_start` about every 20 seconds so the device's
  60-second playback watchdog does not cut long music or stories.
- The pure logic of both providers lives in `server/engine/qwen_audio.py` (unit tests); `server/tests/smoke_qwen_audio.py` runs the
  networking parts inside the image against fake Model Studio servers.

The same two models are also reachable through a self-hosted OpenAI-compatible gateway, as `gateway_asr` and `gateway_tts`. Both
**inherit the providers above and replace only the transport**, so sentence splitting, subtitles, inline emotion tags, playback
keepalive and the base-class fixes are shared rather than duplicated. Recognition is standard multipart
`/v1/audio/transcriptions`; synthesis is `/v1/audio/speech` with `stream: true` and `response_format: "pcm"`, one request per
sentence, first chunk in about 390 ms regardless of sentence length. Two traps are guarded in code: `sample_rate` must be an
**integer** or the gateway silently falls back to 22050 and the voice comes out high and fast without any error, so the rate is
read back from the response `Content-Type` and mismatches are logged; and `qwen3-tts` models silently return WAV when asked for
pcm, so only the `qwen-audio-3.0` family is offered. Hot words only work on the `qwen-audio-3.0-asr` family, and only when the
clip runs longer than about two seconds. **Voice design and cloning stay on the direct Model Studio provider** — they use a
Model Studio-only endpoint the gateway does not proxy. Pure logic in `server/engine/gateway_audio.py` (unit tests);
`server/tests/smoke_gateway_audio.py` runs both providers in the image against a fake gateway.

### Voices

Each agent picks exactly one voice, and the voice decides the synthesis model. A voice belongs to a Qwen synthesis model and carries
its own speaking settings, configured on the Voices page:

| Setting | How it takes effect |
|---|---|
| Language | Model Studio has no synthesis language parameter: the language decides which language the model replies in (via the prompt) and the preview text |
| Dialect | 20 dialects, only when the language is Chinese; written into the tone instruction as 「请用四川话表达」, and the model's wording picks up a little of the dialect |
| Volume, rate, pitch | synthesis parameters `volume` (0–100), `rate` (0.5–2), `pitch` (0.5–2) |
| Fixed tone | tick gentle, lively, a bit slower… plus one free-text note; combined with the dialect into `instruction`, capped at 100 units (a Chinese character counts 2), and settings over the cap cannot be saved |
| Emotion tags | the Model Studio tags the model may insert: emotion tags (`[excited]`, `[whispers]`…, at the start of a sentence) and sound tags (`[laughing]`, `[sighing]`…, where the sound happens) |

- **System voices**: opening the Voices page fills in the set for each synthesis model (12 for flash, 2 for plus); nothing to import.
  The 500-odd base voices can be added by ID.
- **Voice design** (from a text description) and **voice cloning** (10–20 seconds of speech, consent checkbox required): the voice is only
  sent to devices after Model Studio approves it; until then devices use the default voice. Cloning samples go through Model Studio's
  temporary upload (`oss://`) first; if that fails the console serves a one-time link valid for 10 minutes at
  `/xiaozhi/ota/voice-sample/<token>` (nginx does not apply unified auth to that prefix, so Model Studio can fetch it), revoked as soon as
  the create request returns.
- **Duplicate as new voice**: the same Model Studio voice with another set of settings (a variant). Deleting a variant only deletes it
  locally; refreshing the review status updates all variants.
- **Preview**: unsaved settings in the settings dialog can be previewed directly, through Model Studio's non-streaming synthesis endpoint.

How emotion tags flow:

1. When the voice allows tags, the prompt gains a "voice expression" section listing them; otherwise that section is absent and
   bracketed stage directions are forbidden.
2. A reply such as `😆[excited]哇,你做到啦![laughing]` goes to the engine unchanged; the console strips the tags before writing chat
   history, and the Playground shows them on a separate line under the bubble.
3. The engine's Qwen synthesis provider removes tags that are not allowed and keeps allowed ones in the text to speak. Subtitles sent to
   the device have every tag removed, and a fragment that is only tags is carried into the next one. Upstream's post-split trimming strips
   square brackets, so the provider overrides that step (`qwen_audio.trim_segment`), and segments are never split inside a tag.

## Layout

```
console/            the console (Node + Vue)
  src/
    manager-api.ts    ← the seven endpoints the server calls; the core of the project
    ota.ts            ← device OTA / activation (compatible with stock xiaozhi firmware)
    admin-api.ts      ← management endpoints used by the UI
    identity.ts       ← device identity: secret hashes, binding codes, identity events
    catalog.ts        ← provider and plugin catalogue (code constants, not database rows)
    schema.sql        ← v0 baseline schema
    migrations.ts     ← later schema changes, applied in order via PRAGMA user_version; long ones live in migrations/
    voice/            ← voices: speaking settings (pure functions), system voice list and sync, Model Studio preview, voice design and cloning, one-time sample links
    agent/            ← agent runtime: turn endpoint, multi-step loop, prompts, context, tool registry, device-bridge client;
                        one subdirectory per capability (search, mcp, skills, reminders, media, vocab, image, roles, memory)
    cli.ts            ← CLI: set a password, import keys from an old config
  web/                frontend: devices, agents, voices, playground, models, chat logs, pronunciation fixes, settings;
                      light and dark themes, no external assets (same-origin Content-Security-Policy)
  test/               contract tests
server/             companion files for the xiaozhi server
  providers/          custom ASR / TTS providers: model gateway (chat endpoint) and Qwen speech (Model Studio)
  engine/             modules added to the engine: tool-call text conversion, pure logic for Qwen speech, device bridge and the xiaodan_agent provider
  assets/             reminder chime
  plugins/            custom plugins: calendar, weather, volume, plus replacements for upstream weather and goodbye
  tests/              unit tests for the plugins, tool-call text conversion and Qwen speech (standard library only) and three image smoke scripts
  prompts/            prompt template
  config.api.yaml     API-mode configuration template
media/              content: original stories, licence-verified music, word books (baked into the console image, imported on startup)
```

## Running locally

```bash
npm ci
npm run build
XIAODAN_DATA_DIR=./data node console/dist/server.js
```

Open http://127.0.0.1:8002. The default authentication mode is proxy, in which the console
performs no login check (see **Authentication** below). For a local login page add
`XIAODAN_AUTH_MODE=local`: the first visit asks you to create the administrator, and
registration is closed afterwards.

For development, run the two halves separately:

```bash
npm run dev --workspace=@xiaodan/console       # backend on 8002
npm run dev --workspace=@xiaodan/console-web   # frontend on 5173, proxy preconfigured
```

## Migrating from a single-module deployment

If the server previously ran in "single module" mode with its configuration in
`data/.config.yaml`, the keys do not need to be copied by hand:

```bash
node console/dist/cli.js import-single-config /path/to/.config.yaml
```

This imports the ASR, LLM, TTS and VAD models named in `selected_module` along with their keys,
attaches them to the default agent, and carries over the persona and WebSocket address. After a
Qwen synthesis model is imported, its system voices are filled in and the default agent gets the
default voice. **Keys never leave the server** during this.

Then switch the server to API mode:

```bash
cp server/config.api.yaml /opt/xiaodan/data/.config.yaml
# replace the secret with the one shown on the console's settings page
docker compose restart xiaodan-server
```

The server log printing 从API读取配置 confirms it worked. Each device then shows a six-digit
binding code on its screen; enter it on the console's Devices page.

Rolling back is swapping `.config.yaml` back to the single-module version and restarting;
the console can keep running.

## Onboarding into the ServerOps panel

This repository publishes two images, the two components of one panel application:

| Component | Image | Container port | Health | Data |
|---|---|---|---|---|
| `console` | `ghcr.io/thesyart/xiaodan-server-console` | 8002 | `/health` | `/app/data` |
| `engine` | `ghcr.io/thesyart/xiaodan-server-engine` | 8000 | `/` | `/opt/xiaozhi-esp32-server/data` |

The engine reaches the console by component name on the project network, so
`manager-api.url` in `.config.yaml` must be `http://console:8002/xiaozhi`. Port 8003
is no longer published: the console serves OTA, and the vision endpoint never had an
nginx route.

The engine takes the device address from `X-Real-IP`, then `X-Forwarded-For`, then the peer address, and the
weather plugin locates the city from it. The nginx site needs `proxy_set_header X-Real-IP $remote_addr;`;
without it the engine only sees the container gateway, the log says the address is not public, and weather
falls back to the default city.

**The panel does not read this repository's `compose.yaml`.** It renders its own from a
root-approved policy, always as a non-root user with `cap_drop: ALL`,
`no-new-privileges`, the default seccomp profile, loopback-only ports and bind mounts
with `create_host_path:false` — no memory limit and no `depends_on`. Upstream's
`seccomp:unconfined` cannot be expressed there, and measurement says it is not needed:
the whole audio path works under the default profile.

Startup ordering does not rely on `depends_on`. With the console unreachable the engine
retries six times ten seconds apart and then exits, and `restart: unless-stopped`
brings it back.

### What root has to approve on the server

```
/etc/serverops/image-policies/<application UUID>.json   ports, UID/GID, env files, data dirs
/etc/serverops/apps/xiaodan-server-console.env          root 0600, XIAODAN_AUTH_MODE=proxy
/srv/serverops/data/xiaodan/{console,engine}            1000:1000 0750, parent root 0750
```

The data directories must exist with the right owner **before the first release**: the
pull step verifies ownership, long before any cutover. The helper unit also needs
`/srv/serverops/data/xiaodan` in `ReadWritePaths`, or it cannot take the stop-the-world
backup or restore a failed switch. Pre-create the compose project network with the
`com.docker.compose.project` and `com.docker.compose.network` labels.

### First adoption

An ordinary release refuses to activate without a previously confirmed version, so the
first one goes through the root-local adopt command: maintenance page, stop the old
containers, consistent backup, copy the data, start the panel-rendered compose, verify
readiness, restore the ingress, stop the helper, run
`node helper/dist/image-bootstrap.js adopt …`, start the helper. After that, updating is
one click.

### About the engine image size

The upstream image is 10.5 GB, and 6.4 GB of that single pip layer exists to run ASR
models locally: 2.8 GB of nvidia CUDA libraries, 1.5 GB of torch, 419 MB of triton and
so on. Our ASR goes through the model gateway and the VAD reads one 7.5 MB onnx file, so
none of it is ever loaded — confirmed by reading `/proc/<pid>/maps` of the production
process. The Dockerfile therefore prunes inside a build stage and copies the result into
a clean system layer, landing at 1.86 GB. Package versions and binaries are exactly
upstream's; nothing is reinstalled, which would introduce version drift that typically
only surfaces on a cold path.

## CLI

```bash
node console/dist/cli.js set-password <username> <password>   # create the administrator (local mode only)
node console/dist/cli.js clear-local-admin                     # wipe local account and sessions (after switching to proxy)
node console/dist/cli.js import-single-config <config path>   # import old config and keys
node console/dist/cli.js show-secret                          # print the server API secret
node console/dist/cli.js set <key> <value>                    # change one system setting
```

## Authentication

By default the console **does not manage its own accounts** (`XIAODAN_AUTH_MODE=proxy`):
authentication belongs to the operations panel in front of it, which intercepts at the
nginx layer with `auth_request` so unauthenticated requests never arrive here. One set of
credentials is easier to keep track of than two, and it removes a login form that nobody
would remember to rotate.

This mode rests on two preconditions, both required:

1. the console publishes a loopback port only (`127.0.0.1:8002` in the compose file);
2. nginx is the only public entrance, and the site is managed by the panel with unified
   auth enabled.

**If the second does not hold, something else must stand in front** (such as nginx basic
auth); otherwise anything that can reach the port can administer the console. The startup
log prints the current mode and these preconditions.

Set `XIAODAN_AUTH_MODE=local` when the console must manage its own account (not yet
onboarded, or local development), then create an administrator with `cli set-password`.
Going the other way, run `cli clear-local-admin` after switching to proxy so no second set
of credentials is left behind.

**The Bearer authentication used by the server is unaffected by the mode** — proxy mode
only waives the check for browser-originated management requests. Otherwise anything
reaching this port could read every model API key.

## Data and backups

All state lives in a single file, `$XIAODAN_DATA_DIR/console.db`. Backing up means copying
it.

On `SIGTERM` the process stops accepting connections and then checkpoints the WAL, so
archiving the data directory at shutdown cannot lose the last few writes.

**It contains model API keys.** Do not commit the data directory; `.gitignore` excludes it.

**Migrations only go forward.** A new version upgrades the database on its first start, and an older build refuses to start on a
newer database. Rolling back the image therefore also means restoring the data backup taken before the upgrade, and changes made
after the upgrade are lost. Migration v8 (Qwen-only speech, voices carrying their own settings, removal of the engine path) is the
largest so far, so take a data backup in the panel before deploying it. It:
- deletes vision, Intent and Memory models and non-Qwen image services (Qwen ones become text-to-image models);
- once Qwen recognition or synthesis is configured, points agents at Qwen and deletes other synthesis models with their voices and
  unused other recognition models;
- moves each agent's synthesis parameters onto its voice, splitting off variants where agents sharing a voice used different settings.

Migration v10 (capabilities split into tool, skill and MCP pages) also deserves a backup first. It:
- merges the per-role tool settings (default weather city, screen hold seconds, word book) and the image model into one global copy,
  taking the default agent's values where roles disagree;
- moves the MCP "only these tools" choice from roles to servers, again taking the default agent's choice;
- removes skills and MCP servers that were globally disabled from every role, then drops the disabled state (the effect is unchanged).

Migration v11 removes the three built-in skills `bedtime-story`, `word-coach` and `ai-news-brief`, whose guidance now lives in the
storytelling and vocabulary tools and in AIHOT's usage notes. Unedited ones are deleted together with their ticks on roles; edited
ones are kept as your own skills. It also adds a usage-notes column to MCP servers.

## Measured in production (2026-09-13)

The replacement was carried out on the existing deployment; these numbers are from the
real server:

| | Before | After |
| --- | --- | --- |
| Console memory | 473 MB (Java) + 179 MB (MySQL) + 13 MB (Redis) | 21.8 MB |
| Containers | 3 | 1 |
| Data directory | a MySQL volume | a single 124 KB file |
| Server fetching per-device config | — | **8 ms** |

Chain verified end to end: a device with its real MAC connected, received a binding code,
was bound from the console, reconnected and received its full configuration (voice
injection, VAD/ASR elision, persona and keys all correct), and the server logged
"大模型收到用户消息".

### After moving to the panel (2026-09-14)

With the whole deployment on ServerOps' image release channel, measured on the same
server:

| | Result |
| --- | --- |
| Engine image | 10.5 GB down to 1.86 GB |
| Console memory | 37 MB |
| Engine memory | 365 MB |
| Runtime identity | both containers run as UID 1000, no longer as root |
| New containers ready during cutover | 6 s |

Upstream's hard-coded `seccomp:unconfined` turned out to be unnecessary: Opus decoding
and onnxruntime both work under the default profile.

## Tests

```bash
npm test        # 240 tests: API contract, authorisation boundaries, device identity and binding, migrations, voices, agent runtime
npm run check   # typecheck plus tests
python3 -m unittest discover -s server/tests -v   # 116 unit tests: plugin cards, weather parsing, tool-call text, Qwen speech and emotion tags
```

The contract tests assert the response shapes the server actually consumes, and each one
notes in a comment which server code it protects, rather than asserting that the code
matches its own spec.
