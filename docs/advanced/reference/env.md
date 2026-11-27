---
title: Environment and ports
description: Every environment variable cohost reads and every port it publishes, with the default and what it changes.
track: advanced
verified: a86e930
---

# Environment variables and ports

`.env`, which `scripts/install.sh` copies from `.env.example`, holds only non-secret host and Compose variables: what must exist before the settings can be read, and where the dashboard listens. Every operator setting and every credential lives in the [settings store](../../start/glossary.md#settings-store) (see [Configuration](config.md)), and no credential belongs in `.env`. No environment variable overrides a setting, so a value in `.env` or your shell never shadows one. A setting applies at the next start of the units that read it; an edit to `.env` applies when the containers are created or the dashboard is started again.

[Docker Compose](../../start/glossary.md#docker-compose) reads `.env` for its own settings and passes it to each application [container](../../start/glossary.md#container), and services run on the host read it themselves from the workspace root without overriding variables already set in your shell. `COHOST_ENV_FILE` points them at a different file. A variable set in your shell wins over `.env`.

Provider credentials such as `ANTHROPIC_API_KEY` or `AWS_ACCESS_KEY_ID` are not read from the environment. They are credentials of the settings store: `llm.claude.api_key`, `llm.bedrock.access_key_id` and `llm.bedrock.secret_access_key`, among others, set on the Settings screen or with `mise run config:secret -- <path>`. A key left in `.env` cannot keep a provider working.

## Compose

Read by `docker compose` itself, before any container exists.

| Variable | Default | What it does |
| --- | --- | --- |
| `COMPOSE_FILE` | `docker-compose.yml` | Which Compose files to use. The installer adds the GPU overlay when it finds an NVIDIA [GPU](../../start/glossary.md#gpu): `docker-compose.yml:docker-compose.gpu.yml` |
| `COMPOSE_PATH_SEPARATOR` | unset | Set to `:` when a Windows `docker.exe` (see `COHOST_DOCKER_BIN`) would otherwise split `COMPOSE_FILE` on `;` |
| `COMPOSE_PROFILES` | unset | Optional services that stay on across restarts and Launch: `eyes`, `ears`, `mouth` and `discord`, and the speech engine servers `pocket`, `nemotron` and `kyutai`, for example `discord,ears,mouth` |
| `COMPOSE_PROJECT_NAME` | the folder name | The Compose project name. Set it only to run a second stack beside the first |
| `KOKORO_IMAGE` | CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0` | Override the [TTS](../../start/glossary.md#tts) image. The GPU overlay switches the default to the CUDA 12.8 build `ghcr.io/remsky/kokoro-fastapi-gpu:v0.10.0-cu128`; set `ghcr.io/remsky/kokoro-fastapi-gpu:v0.10.0-cu126` where that build does not run |
| `SPEACHES_IMAGE` | CPU image `ghcr.io/speaches-ai/speaches:0.8.3-cpu` | Override the [STT](../../start/glossary.md#stt) image. The GPU overlay switches the default to the CUDA build |

## The dashboard's access controls

The dashboard cannot edit these: a page it serves must not be able to remove its own lock. They are read once, when the dashboard starts. The dashboard's ports are the settings [`dashboard.port`](config.md#dashboard) and `dashboard.lan_port`, not variables, and its startup log prints the URL it actually uses.

| Variable | Default | What it does |
| --- | --- | --- |
| `DASHBOARD_HOST` | `127.0.0.1` | Where the full dashboard listens. `0.0.0.0` opens the full dashboard to other machines: they open it by this PC's IP address, or by a name listed in `dashboard.allowed_hosts`, and need the control token or an unlock link like any browser. It logs a warning. The token, and an unlocked browser's session cookie, travel in cleartext over HTTP. This is the way to reach the dashboard from another machine: never put a port forward or a proxy in front of the loopback port, because it makes every machine that reaches it look local. An `ssh -L` tunnel opened from your own machine is fine |
| `CONTROL_TOKEN` | never in `.env` | cohost's one lock, the [control token](../../start/glossary.md#control-token), which you keep in your password manager: `mise run config:token` sets it (the installer runs it once) and prints it once, and the settings store keeps only its verifier. It is the bearer token every route that changes something requires (an unlocked browser's session cookie counts in its place), and the key the `ears` audio listener checks is derived from it (see [HTTP routes](http.md#ears-capture-endpoint)). The dashboard refuses to start while `.env` or its own environment defines it, and the control plane refuses to start anything, naming the line and never the value. The variable is read only from the environment of the command that needs the token: `mise run dashboard:unlock`, and a script or `curl` that sends it as `Authorization: Bearer <token>`. Export it in that shell from your password manager |
| `COHOST_KEY_FILE` | `$XDG_CONFIG_HOME/cohost/master.key`, else `~/.config/cohost/master.key` | The settings store's [master key](../../start/glossary.md#master-key) file, mode 0600, outside the checkout so a copy of the checkout, of `data/` or of a backup carries no key. It is created the first time a program opens a store that holds no credential, and its text, shown once, is the [recovery key](../../start/glossary.md#recovery-key) to keep in your password manager |
| `XDG_CONFIG_HOME` | `~/.config` | Only where the default master key file lives, when `COHOST_KEY_FILE` is unset |
| `CONTROL_ADVANCED` | `0` | A safety switch, not access: `1` lets a lifecycle action also stop and restart `redis` and `postgres`, which are read-only otherwise. It still needs the token. The dashboard can never stop itself |

## Locating files and tools

Needed before configuration can be read.

| Variable | Default | What it does |
| --- | --- | --- |
| `CONFIG_DIR` | set for each service | The folder holding the unit's projection, `settings.json`: the settings sections and documents it declares, no credential. Compose sets `/app/config`, where `data/projections/<unit>/` is mounted read-only; the unit runner behind `mise run dev:<service>` points it at `data/projections/<unit>/`. You do not set it |
| `COHOST_ENV_FILE` | `.env` at the workspace root | The env file host-run programs (the dashboard, `cohostctl`, the tasks and services) load |
| `COHOST_CREDENTIALS_FD` | unset | Set by the unit runner on a host-run service: the file descriptor (`3`) of the pipe its credentials arrive on. You never set it |
| `COHOST_DATA_DIR` | `data/` under the repository root | Where the settings store lives (`store/cohost.db` and its `store/backups/`), where services keep files that must outlive a restart, such as the fallback clip cache, and where each program writes its log file (`logs/<program>.log`). Projections are always written under the checkout's `data/projections/`, which Compose mounts. Compose pins it to `/app/data` in every container except `tools`, so the containers' log files land in the checkout's `data/logs/` |
| `COHOST_DOCKER_BIN` | `docker` | The [Docker](../../start/glossary.md#docker) executable the dashboard and `cohostctl` run. Set it to `docker.exe` on [WSL2](../../start/glossary.md#wsl2) without Docker Desktop's WSL integration |

## Infrastructure addresses

Where a service finds the other pieces before it can open the bus. Like the other variables on this page, they come from `.env` or the environment, never from the settings store. Compose pins the first six for containers.

| Variable | Default | What it does |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | The [bus](../../start/glossary.md#bus). Compose sets `redis://redis:6379` for containers |
| `DATABASE_URL` | `postgres://cohost:cohost@127.0.0.1:5432/cohost` | Postgres for `memory`. Compose sets the `postgres` host name |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama, for chat and embeddings |
| `TTS_URL` | `http://127.0.0.1:8880` | The TTS server `voice` calls |
| `STT_URL` | `http://127.0.0.1:8000` | The STT server `ears` calls |
| `VOICE_URL` | `http://127.0.0.1:8700` | The `voice` service's public base URL, which ends up in `voice.utterance`. Compose sets `http://voice:8700` |
| `VOICE_PORT` | `8700` | The port `voice` listens on |

## Health and logging

| Variable | Default | What it does |
| --- | --- | --- |
| `HEARTBEAT_INTERVAL_MS` | `5000` | How often each service publishes its [heartbeat](../../start/glossary.md#heartbeat). The Services screen and the Compose health checks derive staleness from it |

The log level, the terminal format and the log files are the `logging` settings section (see [Configuration](config.md#logging)), not variables. Each program's logger reads that section before the rest of the configuration.

## Platform

| Variable | Default | What it does |
| --- | --- | --- |
| `NO_COLOR` | unset | When set to anything non-empty, log lines in a terminal carry no colour ([no-color.org](https://no-color.org)). Colour is only ever used when the output is a terminal, never under `docker compose logs` or a redirect |

## Set by the build

| Variable | Default | What it does |
| --- | --- | --- |
| `COHOST_VERSION` | `dev` | The version each service reports in its heartbeat. The image build sets it |

## `COHOST_ISOLATION`

`COHOST_ISOLATION` is the one variable that can change a setting. It holds a single JSON object from override name to value, such as `{"LLM_PROVIDER":"mock","AVATAR_DRIVER":"null"}`. The control plane sets it on the `docker compose` process for an isolated start of one unit, and Compose passes it to that container; you never write it. The name is reserved for the control plane: do not set it in `.env` or in the shell. The dashboard and `cohostctl` set it on every `docker compose` command they run (empty unless it is an isolated start), so a value in `.env` or in the shell that started them is ignored. A `docker compose up` you run by hand is outside the control plane and nothing checks it: a value there reaches every container it starts, and each applies it as an isolation preset, so the whole stack runs with those overrides (a malformed value stops each service). The loader applies each entry to the config key in the table, so the unit runs with no external backend while the rest of the stack uses the settings as stored. The Settings screen reports a key that a running isolated unit has overridden. See [One service on its own](../testing/isolated.md).

The override names are labels inside that object, not environment variables: a plain `LLM_PROVIDER` in `.env` or the shell is read by nothing. A malformed value, or a name not in the table, stops the service with an error naming `COHOST_ISOLATION`.

| Override name | Config key it selects | Stand-in effect |
| --- | --- | --- |
| `LLM_PROVIDER` | `llm.provider` | `mock` answers with deterministic offline replies |
| `MEMORY_STORE` | `brain.memory.store` | `memory` is an in-process store lost on exit |
| `MEMORY_EMBEDDER` | `brain.memory.embedder` | `hash` makes deterministic, offline [embeddings](../../start/glossary.md#embedding) |
| `VOICE_ENGINE` | `voice.engine` | `stub` returns a silent WAV sized from the text |
| `CHAT_SOURCES` | `chat.sources` | `[fake]` sends scripted or stdin messages with no channel |
| `VISION_ENABLED` | `vision.enabled` | `false` makes `eyes` idle and never touch OBS |
| `VISION_PROVIDER` | `vision.provider` | `stub` answers with fixed text and no model |
| `EARS_SOURCES` | `ears.sources` | A list such as `[http, dir]` listens to those sources only; `[]` idles |
| `EARS_STT_ENGINE` | `ears.stt_engine` | `stub` gives every clip a fixed transcript with no STT server |
| `CONNECTIONS_DISCORD_ENABLED` | `connections.discord.enabled` | `false` makes the Discord [connector](../../start/glossary.md#connector) idle and hold no connection |
| `MOUTH_DISCORD_ENABLED` | `mouth.outputs.discord.enabled` | `false` makes `mouth` play nothing on the `discord` output |
| `MOUTH_DRYRUN_ENABLED` | `mouth.outputs.dryrun.enabled` | `true` adds the `dryrun` output, which accepts every line and plays nothing |
| `AVATAR_DRIVER` | `avatar.driver` | `null` means no avatar app |

## Development and test variables

Set these yourself only to point a script or a test somewhere else. Every test task runs through `scripts/test-env.sh`, which sets `COHOST_DATA_DIR`, `CONFIG_DIR`, `COHOST_ENV_FILE` and `COHOST_KEY_FILE` to temporary paths and `COHOST_TEST_ENV` to `1` (the settings store then has no default key path), so no test opens your settings store, `.env` or master key.

| Variable | Default | What it does |
| --- | --- | --- |
| `STUB_TTS_PORT` | `8880` | The port of the stand-in TTS server (`mise run stub:tts`) |
| `STUB_LLM_PORT` | `11434` | The port of the stand-in Ollama chat server (`mise run stub:llm`) |
| `COHOST_TEST_DATABASE_URL` | unset | A [pgvector](../../start/glossary.md#pgvector) database for the memory store tests. They skip without it |
| `COHOST_LIVE_STACK` | unset | `1` runs the live-stack end-to-end test, which needs Docker |
| `COHOST_LIVE_CLAUDE_MODEL` | unset | A Claude model id that, together with the Claude API key the test reads from `ANTHROPIC_API_KEY`, runs the Claude API smoke test. It is the one place that variable is read, and only by that test |

## Ports

Compose publishes each infrastructure port on `127.0.0.1` only, so nothing is reachable from another machine unless you change the compose file.

| Port | What | Published by | Notes |
| --- | --- | --- | --- |
| `3000` | The full dashboard (page, controls, Launch and Stop) | The host process (`mise run dashboard`) | The setting `dashboard.port`, bound to `DASHBOARD_HOST` |
| `3001` | The LAN listener: the [sink](../../start/glossary.md#sink) page, its audio and the playback report, for a second PC's [OBS](../../start/glossary.md#obs) [Browser Source](../../start/glossary.md#browser-source) | The host process | The setting `dashboard.lan_port`, all interfaces. Must differ from `dashboard.port` |
| `6379` | [Redis](../../start/glossary.md#redis) | `redis` | For `mise run dev` outside Docker |
| `5432` | [Postgres](../../start/glossary.md#postgres) | `postgres` | |
| `11434` | [Ollama](../../start/glossary.md#ollama) | `ollama` | |
| `8880` | The TTS server | `tts` | |
| `8000` | The STT server | `stt` | |
| `8700` | The `voice` service's HTTP: audio, fallback clips, `/health` | `voice` | The host-run dashboard proxies audio from it |
| `8881` | The Pocket voice engine server (profile `pocket`) | `tts-pocket` | Container port 8000 |
| `8081` | The NeMo-Speech.cpp streaming STT server (profile `nemotron`) | `stt-nemotron` | Container port 8080 |
| `8082` | The moshi-server Kyutai STT server (profile `kyutai`) | `stt-kyutai` | Container port 8080 |
| `8765` | `ears`' `http` source | Not published by Compose | `ears.http.port`, local only by default; in Docker bind `0.0.0.0` and publish it yourself |

Both dashboard ports are settings read when the dashboard starts, so a change to `dashboard.port` or `dashboard.lan_port` (on the Settings screen, or `mise run config:set -- dashboard.port 3100`) applies at its next start, and its startup log prints the URL it actually uses. `DASHBOARD_HOST=0.0.0.0` opens the full dashboard to another machine, behind the same control token; the other machine opens it by IP address, or by a name listed in `dashboard.allowed_hosts` (the dashboard answers any other name with `403`).

Ports on the machines cohost connects to, which cohost does not publish, are settings: [obs-websocket](../../start/glossary.md#obs-websocket) on `vision.obs.port` (4455), [VTube Studio](../../start/glossary.md#vtube-studio) on `avatar.vtube_studio.port` (8001) and a [VMC](../../start/glossary.md#vmc) receiver on `avatar.vmc.port` (39539).
