---
title: One service on its own
description: Isolation presets, the mock backends, and how to start a single service from the dashboard, cohostctl or source with only Redis running.
track: advanced
verified: f126b94
---

# Run one service on its own

Every service can run with only [Redis](../../start/glossary.md#redis) beside it: no accounts, no [GPU](../../start/glossary.md#gpu), no API keys. Each outside backend has a preset, an environment variable that swaps it for a stand-in. This page lists the presets, three ways to start a service with them, and what each service does when something it depends on is missing.

## What you need

- A built workspace and Redis on `127.0.0.1:6379`. See [Developer setup](../dev-setup.md) and run `docker compose up -d redis`.
- A `.env` made from `.env.example`. Services read `config/config.yaml`, which interpolates variables such as `${LLM_MODEL}`; with `.env` missing those come out empty and validation fails with errors such as `llm.model: String must contain at least 1 character(s)`. The defaults in `.env.example` are fine for local runs.

## The presets

Each preset is wired into `config/config.example.yaml` as `${VAR:-default}`, so you never edit `config.yaml` to use one. With none set you get the live backends. A service on a stand-in logs a warning at start and reports its [heartbeat](../../start/glossary.md#heartbeat) mode as `mock` or `off`. A service missing a config value, such as no `TWITCH_CHANNEL` or no `DISCORD_TOKEN`, idles as `degraded` instead of exiting.

| Service | Preset | Result (mode) |
| --- | --- | --- |
| `cortex`, and the `salience`, `affect` and notes [hooks](../../start/glossary.md#hook) that inherit its model | `LLM_PROVIDER=mock` | Deterministic echo replies and hash [embeddings](../../start/glossary.md#embedding) (`mock`) |
| `memory` | `MEMORY_STORE=memory MEMORY_EMBEDDER=hash` | An in-process store with offline embeddings, lost on exit (`mock`). Needs no [Postgres](../../start/glossary.md#postgres) and no [Ollama](../../start/glossary.md#ollama) |
| `voice` | `VOICE_ENGINE=stub` | A silent WAV of 60 ms per character (400 ms minimum), no [TTS](../../start/glossary.md#tts) call (`mock`) |
| `chat` | `CHAT_SOURCE=fake` | Scripted or stdin messages, no Twitch (`mock`) |
| `chat` | none set, no `TWITCH_CHANNEL` | Idles `degraded` (`deps.twitch: down`) and still accepts injected chat |
| `eyes` | `VISION_ENABLED=false` (the default) | Idles and never touches [OBS](../../start/glossary.md#obs) (`off`); injected images are still described |
| `eyes` | `VISION_ENGINE=stub` | A fixed description and no vision model (`mock`); with `VISION_ENABLED=true` it still needs OBS |
| `ears` | `EARS_SOURCES=[]` | Idles with no Discord client; injected audio is still transcribed |
| `ears` | `EARS_SOURCES=[http]` | Listens on `ears.http` (default `127.0.0.1:8765`) for `POST /audio` clips; no account |
| `ears` | `EARS_SOURCES=[dir]` | Hears `.wav` files dropped in `ears.dir.path`, then renames them; no account |
| `ears` | `EARS_STT_ENGINE=stub` | A fixed transcript and no `stt` server (`mock`) |
| `mouth` | `MOUTH_DISCORD_ENABLED=false` | Idles and plays nothing (`off`) |
| `mouth` | `MOUTH_DRYRUN_ENABLED=true` | The `dryrun` output accepts every line and plays nothing (`mock`) |
| `connector-discord` | `CONNECTIONS_DISCORD_ENABLED=false` | Holds no Discord connection (`off`); an injected clip is still answered |
| `avatar` | `AVATAR_DRIVER=null` | No avatar app; the full engine runs and publishes `avatar.state` |
| `salience`, `affect`, `dashboard` | none | Already need only Redis |

`EARS_SOURCES` takes YAML flow syntax, such as `[http, dir]`. The `.env.example` file lists every preset with its live default first.

## Three ways to start one service

**From the dashboard.** With stack control on, each service's row on the Services tab opens a test drawer that offers an isolated start. It sets that service's presets for you, and it also starts the services it needs (`cortex` brings up `salience` and `affect`). See the [dashboard tour](../../guide/operate/dashboard.md).

**From `cohostctl`.** The same control path from a shell. It runs services through [Docker](../../start/glossary.md#docker) [Compose](../../start/glossary.md#docker-compose):

```bash
pnpm cohostctl start cortex --isolated
pnpm cohostctl restart cortex --mode fresh
```

`--mode fresh` resets the service's [consumer groups](../../start/glossary.md#consumer-group) so it ignores [events](../../start/glossary.md#event) published while it was away; `--mode resume` keeps its place. Application services default to `fresh`, except `memory`, which resumes.

**From source.** Run the service on the host, from the workspace root so config and `.env` are found:

```bash
node --import tsx services/salience/src/index.ts
```

`pnpm --filter @cohost/salience dev` does the same with file watching. Set `LOG_LEVEL=debug` for more output; stop with ctrl-c. Variables you set in the shell win over `.env`.

## What each service needs

Each was started with only Redis available:

| Service | Needs | With nothing else running |
| --- | --- | --- |
| `salience` | Redis | Works fully with its rules scorer |
| `affect` | Redis | Works fully with its rules appraiser |
| `avatar` | Redis | Works with `AVATAR_DRIVER=null`; publishes `avatar.state` at 5 Hz |
| `dashboard` | Nothing (a host process) | Works with Redis down at <http://localhost:3000>. Audio needs `voice` |
| `voice` | Redis and a TTS server at `TTS_URL` | With `VOICE_ENGINE=stub` it needs no TTS server. Otherwise each `brain.say` logs a synthesis failure and still emits `voice.done` |
| `cortex` | Redis and a chat model | With `LLM_PROVIDER=mock` it answers by itself. Otherwise it logs `waiting for the model backend` every 3 seconds until the model answers |
| `memory` | Redis, and Postgres plus Ollama unless stubbed | With `MEMORY_STORE=memory MEMORY_EMBEDDER=hash` it needs neither. Without them it logs `waiting for ollama (embeddings)...` until Ollama answers |
| `chat` | `TWITCH_CHANNEL` for the real source | Idles `degraded` without a channel and still accepts injected chat |
| `eyes` | OBS and a vision model, only with `VISION_ENABLED=true` | Idles `off` by default; injected images are described by the stub with `VISION_ENGINE=stub` |
| `ears` | The Discord [connector](../../start/glossary.md#connector), for the `discord` source, and an [STT](../../start/glossary.md#stt) server | With the connector absent, `deps.discord` is `down` and injected audio still works; `EARS_STT_ENGINE=stub` needs no STT server |
| `mouth` | Redis, and `voice` for audio | `MOUTH_DRYRUN_ENABLED=true` runs the whole speaking path above Discord with no sound |

`cortex` without `memory` still replies. It waits `brain.cortex.recall_timeout_ms` for `memory.recall.reply`, logs `memory region did not answer in time`, and answers without memories.

## Stand-in servers

Two scripts in `scripts/dev/` impersonate the servers that need a model, for runs where you want the real service code but not the real model.

| Script | Stands in for | Listens on | Behaviour |
| --- | --- | --- | --- |
| `scripts/dev/stub-tts.ts` | The [Kokoro](../../start/glossary.md#kokoro) TTS server | `STUB_TTS_PORT`, default 8880 | Answers `POST /v1/audio/speech` with a pulsing-tone WAV of about 65 ms per character, so the lip-sync envelope moves |
| `scripts/dev/stub-llm.ts` | Ollama's chat API | `STUB_LLM_PORT`, default 11434 | Serves `GET /api/tags` and `POST /api/chat`; replies `Stub brain here. You said: ...`. It has no `/api/embed`, so use the `memory` preset above instead |

```bash
node --import tsx scripts/dev/stub-tts.ts &
node --import tsx scripts/dev/stub-llm.ts &
```

`voice` outside Compose defaults `VOICE_URL` to `http://127.0.0.1:8700`, the address it publishes in `voice.utterance`; Compose sets `http://voice:8700` for [containers](../../start/glossary.md#container).

When you are done, stop background `node --import tsx ...` jobs with `pkill -f "scripts/dev/"` and `pkill -f "services/.*/src/index.ts"`, each typed on its own, and check `ss -ltn`. A plain `kill $!` can leave the `tsx` child holding the port.

## A smoke run

[Cortex](../../start/glossary.md#cortex) answering with the mock model. Cortex needs `salience` and `affect` beside it; `memory` is optional.

```bash
docker compose up -d redis
pnpm install && pnpm build
export REDIS_URL=redis://localhost:6379
LLM_PROVIDER=mock pnpm --filter @cohost/cortex exec tsx src/index.ts &
pnpm --filter @cohost/salience exec tsx src/index.ts &
pnpm --filter @cohost/affect exec tsx src/index.ts &
CHAT_SOURCE=fake pnpm --filter @cohost/chat exec tsx src/index.ts &
VOICE_ENGINE=stub pnpm --filter @cohost/voice exec tsx src/index.ts &
```

Watch the Services tab (or `GET /services`) for `mock` modes, and `brain.say` and `voice.utterance` on the event feed. In-memory data is gone when a process exits. The next page, [Fake inputs](inject.md), shows how to put your own events in.
