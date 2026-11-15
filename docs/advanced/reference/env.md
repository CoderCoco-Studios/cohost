---
title: Environment and ports
description: Every environment variable cohost reads and every port it publishes, with the default and what it changes.
track: advanced
verified: f126b94
---

# Environment variables and ports

Secrets and per-machine settings live in `.env`, copied from `.env.example`; everything about behaviour lives in `config/config.yaml` (see [Configuration](config.md)). [Docker Compose](../../start/glossary.md#docker-compose) reads `.env` for substitution and passes it to each application [container](../../start/glossary.md#container), and services run from source read it themselves from the workspace root without overriding variables already set in your shell. `COHOST_ENV_FILE` points them at a different file.

A value in `.env` reaches `config.yaml` through `${VAR}` placeholders. A variable set in your shell wins over `.env`. The sections below follow `.env.example`, then the variables that are not in it.

## Compose

| Variable | Default | What it does |
| --- | --- | --- |
| `COMPOSE_FILE` | `docker-compose.yml` | Which Compose files to use. The installer adds the GPU overlay when it finds an NVIDIA [GPU](../../start/glossary.md#gpu): `docker-compose.yml:docker-compose.gpu.yml` |
| `COMPOSE_PATH_SEPARATOR` | unset | Set to `:` when a Windows `docker.exe` (see `COHOST_DOCKER_BIN`) would otherwise split `COMPOSE_FILE` on `;` |
| `COMPOSE_PROFILES` | unset | Optional services that stay on across restarts and Launch: `eyes`, `ears`, `mouth` and `discord`, for example `discord,ears,mouth` |
| `KOKORO_IMAGE` | CPU image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0` | Override the [TTS](../../start/glossary.md#tts) image. The GPU overlay switches the default to the CUDA build |
| `SPEACHES_IMAGE` | CPU image `ghcr.io/speaches-ai/speaches:0.8.3-cpu` | Override the [STT](../../start/glossary.md#stt) image. The GPU overlay switches the default to the CUDA build |

## The dashboard and stack control

| Variable | Default | What it does |
| --- | --- | --- |
| `DASHBOARD_PORT` | `3000` | The port of the full dashboard (page, controls, Launch and Stop). `PORT` overrides it, and `dashboard.port` in `config.yaml` is the fallback |
| `PORT` | unset | Overrides `DASHBOARD_PORT` for the dashboard. Its startup log prints the URL it actually uses |
| `DASHBOARD_LAN_PORT` | `3001` | The LAN listener: the [sink](../../start/glossary.md#sink) page, its audio and the playback report, and nothing else. Use it for the second-PC [OBS](../../start/glossary.md#obs) [Browser Source](../../start/glossary.md#browser-source) |
| `DASHBOARD_HOST` | `127.0.0.1` | Where the full dashboard listens. `0.0.0.0` opens it to other machines, and then it refuses to start without `CONTROL_ENABLED=1` and a token. The token travels in cleartext over HTTP |
| `CONTROL_ENABLED` | `1` | Turns the stack and service control routes on. With it off, `POST /services/<id>/start`, `stop` and `restart` and the `/stack` actions answer 404 |
| `CONTROL_TOKEN` | filled by `install.sh` | The bearer token required on the control routes, `POST /control`, `PUT /personality` and the inject routes while control is on. Make one by hand with `openssl rand -hex 24`. Startup fails when `CONTROL_ENABLED=1` and it is empty |
| `CONTROL_ADVANCED` | `0` | `1` lets the controls also stop and restart `redis` and `postgres`, which are read-only otherwise. The dashboard can never stop itself |
| `COHOST_DOCKER_BIN` | `docker` | The [Docker](../../start/glossary.md#docker) executable the dashboard and `cohostctl` run. Set it to `docker.exe` on [WSL2](../../start/glossary.md#wsl2) without Docker Desktop's WSL integration |
| `VIEWERS_TOKEN` | empty | The bearer token for every `/viewers` route, which show what the co-host remembers about each viewer. Empty leaves the Viewers tab locked and every `/viewers` route answering 403. Environment only, never `config.yaml` |

## Test uploads

Limits for the images and audio injected from the dashboard. Unset means the defaults shown.

| Variable | Default | What it does |
| --- | --- | --- |
| `INJECT_MAX_IMAGE_BYTES` | `8388608` | The largest injected image (8 MiB) |
| `INJECT_MAX_AUDIO_BYTES` | `26214400` | The largest injected audio clip (25 MiB) |
| `INJECT_TTL_MS` | `300000` | How long an upload waits in Redis for its service to take it |

## Isolation presets

Each one swaps a backend for a stand-in without editing `config.yaml`, because the example config reads it as `${VAR:-default}`. Unset means the live default shown first. See [One service on its own](../testing/isolated.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `LLM_PROVIDER` | `ollama` | `ollama`, `openai`, `anthropic`, `bedrock` or `mock` |
| `MEMORY_STORE` | `postgres` | `postgres`, or `memory` for an in-process store lost on exit |
| `MEMORY_EMBEDDER` | `ollama` | `ollama`, or `hash` for offline [embeddings](../../start/glossary.md#embedding) |
| `VOICE_ENGINE` | `kokoro` | `kokoro`, or `stub` for silence |
| `CHAT_SOURCE` | `twitch` | `twitch`, or `fake` for scripted messages |
| `VISION_ENABLED` | `false` | `true` starts the describer, which needs `VISION_MODEL` and OBS |
| `VISION_ENGINE` | `ollama` | `ollama`, or `stub` for a fixed description |
| `EARS_SOURCES` | `[discord]` | The listening sources in flow syntax: `[discord, http, dir, <connector tag>]`. `[]` idles |
| `EARS_HTTP_TOKEN` | empty | The bearer token for `ears` `POST /audio`. Empty requires none |
| `EARS_STT_ENGINE` | `speaches` | `speaches`, or `stub` for a fixed transcript |
| `CONNECTIONS_DISCORD_ENABLED` | `true` | `false` makes the Discord [connector](../../start/glossary.md#connector) idle and hold no connection |
| `MOUTH_DISCORD_ENABLED` | `true` | `false` makes `mouth` idle and play nothing on the `discord` output |
| `MOUTH_DRYRUN_ENABLED` | `false` | `true` adds the `dryrun` output, which accepts every line and plays nothing |
| `MOUTH_FILE_ENABLED` | `false` | `true` adds the `file` output, which appends each line's WAV under the data directory |
| `MOUTH_HTTP_ENABLED` | `false` | `true` adds the `http` output, which POSTs each line's WAV to `MOUTH_HTTP_URL` |
| `MOUTH_HTTP_URL` | empty | An `http` or `https` URL for the `http` output. Empty leaves the output down |

## Models

| Variable | Default | What it does |
| --- | --- | --- |
| `LLM_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | The chat model: an Ollama tag the `models` service pulls, or the id for another provider. Reaches `llm.model` |
| `VISION_MODEL` | `qwen2.5vl:3b` | The vision model `eyes` asks. Reaches `vision.model` |
| `NOTES_MODEL` | `gemma3:4b` | The small model that classifies chat lines into viewer notes, on local Ollama. A failed pull is only a warning |
| `EMBED_MODEL` | `nomic-embed-text` | The embedding model. Reaches `llm.embed_model` |
| `STT_MODEL` | `Systran/faster-whisper-small` | The model name `ears` sends to the STT server. The `models` service does not pull it. Reaches `ears.stt_model` |
| `LLM_API_KEY` | empty | The key for `llm.provider: openai` (a vLLM box, OpenRouter, Groq and others) |
| `ANTHROPIC_API_KEY` | empty | The key for `llm.provider: anthropic` |
| `AWS_ACCESS_KEY_ID` | empty | For `llm.provider: bedrock`. Compose mounts no `~/.aws`, so keys go here |
| `AWS_SECRET_ACCESS_KEY` | empty | For `llm.provider: bedrock` |
| `AWS_REGION` | empty | For `llm.provider: bedrock`, used when `llm.bedrock.region` is empty |

## Twitch

Scopes `chat:read chat:edit` from the Twitch developer console.

| Variable | Default | What it does |
| --- | --- | --- |
| `TWITCH_CHANNEL` | empty | The channel to read. Without it `chat` idles as `degraded` |
| `TWITCH_CLIENT_ID` | empty | The application's client id |
| `TWITCH_CLIENT_SECRET` | empty | The application's client secret |
| `TWITCH_ACCESS_TOKEN` | empty | The login token. `chat` keeps its refreshed copy under the data directory |
| `TWITCH_REFRESH_TOKEN` | empty | Required whenever `TWITCH_ACCESS_TOKEN` is set |

## Discord

| Variable | Default | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | empty | The co-host's one Discord bot, used only by the Discord connector. Invite it with Connect and Speak and enable the Server Members intent. `ears` and `mouth` hold no token |
| `DISCORD_GUILD_ID` | empty | The server id. Reaches `connections.discord.guild_id` |
| `DISCORD_VOICE_CHANNEL_ID` | empty | The voice channel id. Reaches `connections.discord.voice_channel_id` |

## OBS and the avatar app

| Variable | Default | What it does |
| --- | --- | --- |
| `OBS_HOST` | `host.docker.internal` | Where [obs-websocket](../../start/glossary.md#obs-websocket) listens: `host.docker.internal` for OBS on the same machine, the LAN address on a second PC |
| `OBS_PORT` | `4455` | The obs-websocket port |
| `OBS_PASSWORD` | empty | The obs-websocket password |
| `OBS_SOURCE` | `Game Capture` | The OBS source to screenshot |
| `AVATAR_DRIVER` | `null` | `vtube-studio`, `vmc` or `null` for no avatar app |
| `VTS_HOST` | `host.docker.internal` | Where [VTube Studio](../../start/glossary.md#vtube-studio) runs |
| `VTS_PORT` | `8001` | The VTube Studio API port |
| `VMC_HOST` | `host.docker.internal` | Where the [VMC](../../start/glossary.md#vmc) receiver runs |
| `VMC_PORT` | `39539` | The VMC receiver's UDP port |

## Health, files and logging

| Variable | Default | What it does |
| --- | --- | --- |
| `HEARTBEAT_INTERVAL_MS` | `5000` | How often each service publishes its [heartbeat](../../start/glossary.md#heartbeat). The Services tab and the Compose health checks derive staleness from it |
| `COHOST_DATA_DIR` | `data/` under the repository root | Where services keep files that must outlive a restart, such as refreshed Twitch tokens and the fallback clip cache |
| `LOG_LEVEL` | `info` | The logger's level for every service. `debug` for more |

## Not in `.env.example`

These are set by Compose, by the loader or by tests. Set them yourself only to point a service somewhere else.

| Variable | Default | What it does |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | The [bus](../../start/glossary.md#bus). Compose sets `redis://redis:6379` for containers |
| `DATABASE_URL` | `postgres://cohost:cohost@127.0.0.1:5432/cohost` | Postgres for `memory`. Compose sets the `postgres` host name |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama, for chat and embeddings |
| `TTS_URL` | `http://127.0.0.1:8880` | The TTS server `voice` calls |
| `STT_URL` | `http://127.0.0.1:8000` | The STT server `ears` calls |
| `VOICE_URL` | `http://127.0.0.1:8700` | The `voice` service's public base URL, which ends up in `voice.utterance`. Compose sets `http://voice:8700` |
| `VOICE_PORT` | `8700` | The port `voice` listens on |
| `CONFIG_DIR` | `config/` at the workspace root | The folder holding `config.yaml`, `personality.md` and `expressions.yaml`. Compose sets `/app/config` |
| `COHOST_ENV_FILE` | `.env` at the workspace root | The env file services load when run from source |
| `COHOST_VERSION` | `dev` | The version each service reports in its heartbeat |
| `STUB_TTS_PORT` | `8880` | The port of `scripts/dev/stub-tts.ts` |
| `STUB_LLM_PORT` | `11434` | The port of `scripts/dev/stub-llm.ts` |
| `COHOST_TEST_DATABASE_URL` | unset | A [pgvector](../../start/glossary.md#pgvector) database for the memory store tests. They skip without it |
| `COHOST_LIVE_STACK` | unset | `1` runs the live-stack end-to-end test, which needs Docker |
| `COHOST_LIVE_CLAUDE_MODEL` | unset | A Claude model id that, with `ANTHROPIC_API_KEY`, runs the Claude API smoke test |

## Ports

Compose publishes each infrastructure port on `127.0.0.1` only, so nothing is reachable from another machine unless you change the compose file.

| Port | What | Published by | Notes |
| --- | --- | --- | --- |
| 3000 | The full dashboard | The host process (`pnpm dashboard`) | `DASHBOARD_PORT`, bound to `DASHBOARD_HOST` |
| 3001 | The LAN listener: sink page, audio and playback report | The host process | `DASHBOARD_LAN_PORT`, all interfaces |
| 6379 | [Redis](../../start/glossary.md#redis) | `redis` | For `pnpm dev` outside Docker |
| 5432 | [Postgres](../../start/glossary.md#postgres) | `postgres` | |
| 11434 | [Ollama](../../start/glossary.md#ollama) | `ollama` | |
| 8880 | The TTS server | `tts` | |
| 8000 | The STT server | `stt` | |
| 8700 | The `voice` service's HTTP: audio, fallback clips, `/health` | `voice` | The host-run dashboard proxies audio from it |
| 8765 | `ears`' `http` source | Not published by Compose | `ears.http.port`, local only by default; in Docker bind `0.0.0.0` and publish it yourself |

Ports on the machines cohost connects to, which cohost does not publish: obs-websocket on `OBS_PORT` (4455), VTube Studio on `VTS_PORT` (8001) and a VMC receiver on `VMC_PORT` (39539).
