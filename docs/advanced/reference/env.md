---
title: Environment and ports
description: Every environment variable cohost reads and every port it publishes, with the default and what it changes.
track: advanced
verified: f126b94
---

# Environment variables and ports

`.env`, copied from `.env.example`, holds only what must exist before configuration can be read, plus the dashboard's access controls. Every operator setting is a literal key of `config/config.yaml` (see [Configuration](config.md)), and every credential is a key of `config/secrets.yaml`. No environment variable overrides a config key, so a value in `.env` or your shell never shadows one. A restart of the services that read a setting applies an edit to `config.yaml` or `secrets.yaml`; an edit to `.env` applies when the containers are created or the dashboard is started again.

[Docker Compose](../../start/glossary.md#docker-compose) reads `.env` for its own settings and passes it to each application [container](../../start/glossary.md#container), and services run from source read it themselves from the workspace root without overriding variables already set in your shell. `COHOST_ENV_FILE` points them at a different file. A variable set in your shell wins over `.env`.

Provider credentials such as `ANTHROPIC_API_KEY` or `AWS_ACCESS_KEY_ID` are not read from the environment. They are keys of `secrets.yaml`: `llm.claude.api_key`, `llm.bedrock.access_key_id` and `llm.bedrock.secret_access_key`, among others. A key left in `.env` cannot keep a provider working.

## Compose

Read by `docker compose` itself, before any container exists.

| Variable | Default | What it does |
| --- | --- | --- |
| `COMPOSE_FILE` | `docker-compose.yml` | Which Compose files to use. The installer adds the GPU overlay when it finds an NVIDIA [GPU](../../start/glossary.md#gpu): `docker-compose.yml:docker-compose.gpu.yml` |
| `COMPOSE_PATH_SEPARATOR` | unset | Set to `:` when a Windows `docker.exe` (see `COHOST_DOCKER_BIN`) would otherwise split `COMPOSE_FILE` on `;` |
| `COMPOSE_PROFILES` | unset | Optional services that stay on across restarts and Launch: `eyes`, `ears`, `mouth` and `discord`, for example `discord,ears,mouth` |
| `COMPOSE_PROJECT_NAME` | the folder name | The Compose project name. Set it only to run a second stack beside the first |
| `KOKORO_IMAGE` | CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0` | Override the [TTS](../../start/glossary.md#tts) image. The GPU overlay switches the default to the CUDA build |
| `SPEACHES_IMAGE` | CPU image `ghcr.io/speaches-ai/speaches:0.8.3-cpu` | Override the [STT](../../start/glossary.md#stt) image. The GPU overlay switches the default to the CUDA build |

## The dashboard's access controls

The dashboard cannot edit these: a page it serves must not be able to remove its own lock. They are read once, when the dashboard starts.

| Variable | Default | What it does |
| --- | --- | --- |
| `DASHBOARD_HOST` | `127.0.0.1` | Where the full dashboard listens. `0.0.0.0` opens it to other machines, and then it refuses to start without `CONTROL_ENABLED=1` and `CONTROL_TOKEN`. The token travels in cleartext over HTTP |
| `CONTROL_ENABLED` | `1` | Turns the stack and service control routes on. With it off, `POST /services/<id>/start`, `stop` and `restart` and the `/stack` actions answer 404 |
| `CONTROL_TOKEN` | filled by `install.sh` | The bearer token required on the control routes, `POST /control`, `PUT /personality`, the inject routes and the secrets write while control is on. Make one by hand with `openssl rand -hex 24`. Startup fails when `CONTROL_ENABLED=1` and it is empty |
| `CONTROL_ADVANCED` | `0` | `1` lets the controls also stop and restart `redis` and `postgres`, which are read-only otherwise. The dashboard can never stop itself |
| `VIEWERS_TOKEN` | empty | The bearer token for every `/viewers` route, which show what the co-host remembers about each viewer. Empty leaves the Viewers screen locked and every `/viewers` route answering 403 |

## Locating files and tools

Needed before configuration can be read.

| Variable | Default | What it does |
| --- | --- | --- |
| `CONFIG_DIR` | `config/` at the workspace root | The folder holding `config.yaml`, `secrets.yaml`, `personality.md` and `expressions.yaml`. Compose sets `/app/config` |
| `COHOST_ENV_FILE` | `.env` at the workspace root | The env file services load when run from source |
| `COHOST_DATA_DIR` | `data/` under the repository root | Where services keep files that must outlive a restart, such as the fallback clip cache |
| `COHOST_DOCKER_BIN` | `docker` | The [Docker](../../start/glossary.md#docker) executable the dashboard and `cohostctl` run. Set it to `docker.exe` on [WSL2](../../start/glossary.md#wsl2) without Docker Desktop's WSL integration |

## Infrastructure addresses

Where a service finds the other pieces before it can open the bus. Compose pins the first six for containers.

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
| `LOG_LEVEL` | `info` | The logger's level for every service. `debug` for more. The logger exists before configuration is loaded |

## Set by the build

| Variable | Default | What it does |
| --- | --- | --- |
| `COHOST_VERSION` | `dev` | The version each service reports in its heartbeat. The image build sets it |

## `COHOST_ISOLATION`

`COHOST_ISOLATION` is the one variable that can change a setting. It holds a single JSON object from override name to value, such as `{"LLM_PROVIDER":"mock","AVATAR_DRIVER":"null"}`. The control plane sets it on the `docker compose` process for an isolated start of one unit, and Compose passes it to that container; you never write it. The name is reserved for the control plane: do not set it in `.env` or in the shell. The dashboard and `cohostctl` set it on every `docker compose` command they run (empty unless it is an isolated start), so a value in `.env` or in the shell that started them is ignored. A `docker compose up` you run by hand is outside the control plane and nothing checks it: a value there reaches every container it starts, and each applies it as an isolation preset, so the whole stack runs with those overrides (a malformed value stops each service). The loader applies each entry to the config key in the table, so the unit runs with no external backend while the rest of the stack uses `config.yaml` as saved. The Settings screen reports a key that a running isolated unit has overridden. See [One service on its own](../testing/isolated.md).

The override names are labels inside that object, not environment variables: a plain `LLM_PROVIDER` in `.env` or the shell is read by nothing. A malformed value, or a name not in the table, stops the service with an error naming `COHOST_ISOLATION`.

| Override name | Config key it selects | Stand-in effect |
| --- | --- | --- |
| `LLM_PROVIDER` | `llm.provider` | `mock` answers with deterministic offline replies |
| `MEMORY_STORE` | `brain.memory.store` | `memory` is an in-process store lost on exit |
| `MEMORY_EMBEDDER` | `brain.memory.embedder` | `hash` makes deterministic, offline [embeddings](../../start/glossary.md#embedding) |
| `VOICE_ENGINE` | `voice.engine` | `stub` returns a silent WAV sized from the text |
| `CHAT_SOURCE` | `chat.source` | `fake` sends scripted or stdin messages with no channel |
| `VISION_ENABLED` | `vision.enabled` | `false` makes `eyes` idle and never touch OBS |
| `VISION_ENGINE` | `vision.engine` | `stub` answers with fixed text and no model |
| `EARS_SOURCES` | `ears.sources` | A list such as `[http, dir]` listens to those sources only; `[]` idles |
| `EARS_STT_ENGINE` | `ears.stt_engine` | `stub` gives every clip a fixed transcript with no STT server |
| `CONNECTIONS_DISCORD_ENABLED` | `connections.discord.enabled` | `false` makes the Discord [connector](../../start/glossary.md#connector) idle and hold no connection |
| `MOUTH_DISCORD_ENABLED` | `mouth.outputs.discord.enabled` | `false` makes `mouth` play nothing on the `discord` output |
| `MOUTH_DRYRUN_ENABLED` | `mouth.outputs.dryrun.enabled` | `true` adds the `dryrun` output, which accepts every line and plays nothing |
| `AVATAR_DRIVER` | `avatar.driver` | `null` means no avatar app |

## Development and test variables

Set these yourself only to point a script or a test somewhere else.

| Variable | Default | What it does |
| --- | --- | --- |
| `STUB_TTS_PORT` | `8880` | The port of `scripts/dev/stub-tts.ts` |
| `STUB_LLM_PORT` | `11434` | The port of `scripts/dev/stub-llm.ts` |
| `COHOST_TEST_DATABASE_URL` | unset | A [pgvector](../../start/glossary.md#pgvector) database for the memory store tests. They skip without it |
| `COHOST_LIVE_STACK` | unset | `1` runs the live-stack end-to-end test, which needs Docker |
| `COHOST_LIVE_CLAUDE_MODEL` | unset | A Claude model id that, together with the Claude API key the test reads from `ANTHROPIC_API_KEY`, runs the Claude API smoke test. It is the one place that variable is read, and only by that test |

## Ports

Compose publishes each infrastructure port on `127.0.0.1` only, so nothing is reachable from another machine unless you change the compose file.

| Port | What | Published by | Notes |
| --- | --- | --- | --- |
| `3000` | The full dashboard (page, controls, Launch and Stop) | The host process (`pnpm dashboard`) | The `dashboard.port` key of `config.yaml`, bound to `DASHBOARD_HOST` |
| `3001` | The LAN listener: the [sink](../../start/glossary.md#sink) page, its audio and the playback report, for a second PC's [OBS](../../start/glossary.md#obs) [Browser Source](../../start/glossary.md#browser-source) | The host process | The `dashboard.lan_port` key of `config.yaml`, all interfaces. Must differ from `dashboard.port` |
| `6379` | [Redis](../../start/glossary.md#redis) | `redis` | For `pnpm dev` outside Docker |
| `5432` | [Postgres](../../start/glossary.md#postgres) | `postgres` | |
| `11434` | [Ollama](../../start/glossary.md#ollama) | `ollama` | |
| `8880` | The TTS server | `tts` | |
| `8000` | The STT server | `stt` | |
| `8700` | The `voice` service's HTTP: audio, fallback clips, `/health` | `voice` | The host-run dashboard proxies audio from it |
| `8765` | `ears`' `http` source | Not published by Compose | `ears.http.port`, local only by default; in Docker bind `0.0.0.0` and publish it yourself |

Both dashboard ports are read when the dashboard starts, so an edit to `dashboard.port` or `dashboard.lan_port` applies at its next start, and its startup log prints the URL it actually uses. `DASHBOARD_HOST=0.0.0.0` opens the full dashboard to another machine, and then it needs `CONTROL_ENABLED=1` and `CONTROL_TOKEN`; the other machine opens it by IP address, or by a name listed in `dashboard.allowed_hosts` (the dashboard answers any other name with `403`).

Ports on the machines cohost connects to, which cohost does not publish, are keys of `config.yaml`: [obs-websocket](../../start/glossary.md#obs-websocket) on `vision.obs.port` (4455), [VTube Studio](../../start/glossary.md#vtube-studio) on `avatar.vtube_studio.port` (8001) and a [VMC](../../start/glossary.md#vmc) receiver on `avatar.vmc.port` (39539).
