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
server itself needs no changes at all**.

```
device ──wss──> xiaozhi server ──HTTP (Bearer)──> Xiaodan Console ──> SQLite
                      │                                  │
                 ASR/LLM/TTS                      browser management UI
```

Every field of that contract was checked against the upstream Java implementation and
against the Python code that consumes it, and 56 tests hold it in place
(`console/test/`). Read those test comments before changing an endpoint: each assertion
records which server behaviour it protects.

## Binding codes: where this differs from upstream

Upstream only mints a binding code when a device calls the **OTA endpoint**. Purpose-built
firmware commonly connects straight to the WebSocket and never calls OTA, so the device
never receives a code. The endpoint returns "device not found", the device repeatedly says
"no firmware information found, please configure the OTA address correctly", and following
that instruction does not fix anything.

This console mints the code **when the server asks for an unknown device's configuration**
and records the device in a *pending* list. You bind it with one click in the UI rather
than listening for six spoken digits. The type-in-the-code flow still works too.

## Layout

```
console/            the console (Node + Vue)
  src/
    manager-api.ts    ← the seven endpoints the server calls; the core of the project
    ota.ts            ← device OTA / activation (compatible with stock xiaozhi firmware)
    admin-api.ts      ← management endpoints used by the UI
    catalog.ts        ← provider and plugin catalogue (code constants, not database rows)
    schema.sql        ← all 10 tables
    cli.ts            ← CLI: set a password, import keys from an old config
  web/                frontend
  test/               contract tests
server/             companion files for the xiaozhi server
  providers/          custom gateway ASR / TTS providers
  prompts/            prompt template
  config.api.yaml     API-mode configuration template
```

## Running locally

```bash
npm ci
npm run build
XIAODAN_DATA_DIR=./data node console/dist/server.js
```

Open http://127.0.0.1:8002 and create the administrator on first visit. Registration is
closed afterwards.

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

This imports the models named in `selected_module` along with their keys, attaches them to
the default agent, and carries over the persona and WebSocket address. **Keys never leave
the server** during this.

Then switch the server to API mode:

```bash
cp server/config.api.yaml /opt/xiaodan/data/.config.yaml
# replace the secret with the one shown on the console's settings page
docker compose restart xiaodan-server
```

The server log printing 从API读取配置 confirms it worked. Devices then announce a binding
code, or you bind them directly from the pending list.

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
a clean system layer, landing near 1 GB. Package versions and binaries are exactly
upstream's; nothing is reinstalled, which would introduce version drift that typically
only surfaces on a cold path.

## CLI

```bash
node console/dist/cli.js set-password <username> <password>   # when the password is lost
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

## Tests

```bash
npm test        # 56 tests: API contract, authorisation boundaries, binding flow
npm run check   # typecheck plus tests
```

The contract tests use real request shapes, compared against responses captured from the
running official console, rather than asserting that the code matches its own spec.
