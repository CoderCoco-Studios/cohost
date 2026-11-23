---
title: One service on its own
description: Isolation overrides, the mock backends, and how to start a single service from the dashboard, cohostctl or source with only Redis running.
track: advanced
verified: f126b94
---

# Run one service on its own

Every service can run with only [Redis](../../start/glossary.md#redis) beside it: no accounts, no [GPU](../../start/glossary.md#gpu), no API keys. Each outside backend has an isolation override that swaps it for a stand-in. This page lists the overrides, three ways to start a service with them, and what each service does when something it depends on is missing.

## What you need

- A built workspace and Redis on `127.0.0.1:6379`. See [Developer setup](../dev-setup.md) and run `docker compose up -d redis`.
- A `config/config.yaml`, which the first service you start copies from `config/config.example.yaml` when it is missing. Every key is a literal value with a default, so the example file is fine for local runs.

## The overrides

An isolation override is one entry in `COHOST_ISOLATION`, a JSON object in the environment that maps an override name to a value. The control plane sets it for an isolated start of one unit, and each name selects one `config.yaml` key for that process. The names are labels inside the JSON object, not environment variables: a plain `LLM_PROVIDER=mock` in `.env` or the shell is read by nothing. You never edit `config.yaml` to use one, and a start without **isolated** gets the live backends. A service on a stand-in logs a warning at start and reports its [heartbeat](../../start/glossary.md#heartbeat) mode as `mock` or `off`. A service missing a config value, such as an empty `chat.twitch.channel` or no `connections.discord.token` in `config/secrets.yaml`, idles as `degraded` instead of exiting.

| Service | Override (key it selects) | Result (mode) |
| --- | --- | --- |
| `cortex`, and the `salience`, `affect` and notes [hooks](../../start/glossary.md#hook) that inherit its model | `LLM_PROVIDER=mock` (`llm.provider`) | Deterministic echo replies and hash [embeddings](../../start/glossary.md#embedding) (`mock`) |
| `memory` | `MEMORY_STORE=memory` and `MEMORY_EMBEDDER=hash` (`brain.memory.store`, `brain.memory.embedder`) | An in-process store with offline embeddings, lost on exit (`mock`). Needs no [Postgres](../../start/glossary.md#postgres) and no [Ollama](../../start/glossary.md#ollama) |
| `voice` | `VOICE_ENGINE=stub` (`voice.engine`) | A silent WAV of 60 ms per character (400 ms minimum), no [TTS](../../start/glossary.md#tts) call (`mock`) |
| `chat` | `CHAT_SOURCES=[fake]` (`chat.sources`) | Scripted or stdin messages, no Twitch (`mock`) |
| `chat` | none, with `chat.twitch.channel` empty | Idles `degraded` (`deps.twitch: down`) and still accepts injected chat |
| `eyes` | `VISION_ENABLED=false` (`vision.enabled`, the default) | Idles and never touches [OBS](../../start/glossary.md#obs) (`off`); injected images are still described |
| `eyes` | `VISION_ENGINE=stub` (`vision.engine`) | A fixed description and no vision model (`mock`); with `vision.enabled: true` it still needs OBS |
| `ears` | `EARS_SOURCES=[]` (`ears.sources`) | Idles with no Discord client; injected audio is still transcribed |
| `ears` | `EARS_SOURCES=[http]` | Listens on `ears.http` (default `127.0.0.1:8765`) for `POST /audio` clips; no account |
| `ears` | `EARS_SOURCES=[dir]` | Hears `.wav` files dropped in `ears.dir.path`, then renames them; no account |
| `ears` | `EARS_STT_ENGINE=stub` (`ears.stt_engine`) | A fixed transcript and no `stt` server (`mock`) |
| `mouth` | `MOUTH_DISCORD_ENABLED=false` (`mouth.outputs.discord.enabled`) | Idles and plays nothing (`off`) |
| `mouth` | `MOUTH_DRYRUN_ENABLED=true` (`mouth.outputs.dryrun.enabled`) | The `dryrun` output accepts every line and plays nothing (`mock`) |
| `connector-discord` | `CONNECTIONS_DISCORD_ENABLED=false` (`connections.discord.enabled`) | Holds no Discord connection (`off`); an injected clip is still answered |
| `avatar` | `AVATAR_DRIVER=null` (`avatar.driver`) | No avatar app; the full engine runs and publishes `avatar.state` |
| `salience`, `affect`, `dashboard` | none | Already need only Redis |

`EARS_SOURCES`, `VISION_ENABLED`, `CONNECTIONS_DISCORD_ENABLED`, `MOUTH_DISCORD_ENABLED` and `MOUTH_DRYRUN_ENABLED` take YAML flow syntax (`[http, dir]`, `true`); every other value is a plain string. Each unit's isolated start applies the overrides in its row above (the `cortex` unit gets `LLM_PROVIDER=mock`, `mouth` gets both `MOUTH_` overrides, and so on).

## Three ways to start one service

**From the dashboard.** With stack control on, each service's row on the Services screen has **Start** (or **Restart**) with an **Isolated** switch in its dialog. It sets that service's overrides for you, and it also starts the services it needs (`cortex` brings up `salience` and `affect`). See the [dashboard tour](../../guide/operate/dashboard.md).

**From `cohostctl`.** The same control path from a shell. It runs services through [Docker](../../start/glossary.md#docker) [Compose](../../start/glossary.md#docker-compose):

```bash
pnpm cohostctl start cortex --isolated
pnpm cohostctl restart cortex --mode fresh
```

`--mode fresh` resets the service's [consumer groups](../../start/glossary.md#consumer-group) so it ignores [events](../../start/glossary.md#event) published while it was away; `--mode resume` keeps its place. Application services default to `fresh`, except `memory`, which resumes.

**From source.** Run the service on the host, from the workspace root so `config/` and `.env` are found. Choose a stand-in either by the real config key (for example `llm.provider: mock` in `config/config.yaml`) or by `COHOST_ISOLATION` in the shell:

```bash
node --import tsx services/salience/src/index.ts
COHOST_ISOLATION='{"LLM_PROVIDER":"mock"}' node --import tsx services/cortex/src/index.ts
```

`pnpm --filter @cohost/salience dev` does the same with file watching. Set `LOG_LEVEL=debug` for more output; stop with ctrl-c. A variable you set in the shell wins over the same variable in `.env`.

## What each service needs

Each was started with only Redis available:

| Service | Needs | With nothing else running |
| --- | --- | --- |
| `salience` | Redis | Works fully with its rules scorer |
| `affect` | Redis | Works fully with its rules appraiser |
| `avatar` | Redis | Works with `avatar.driver: "null"` (the isolated start); publishes `avatar.state` at 5 Hz |
| `dashboard` | Nothing (a host process) | Works with Redis down at <http://localhost:3000> (`dashboard.port`). Audio needs `voice` |
| `voice` | Redis and a TTS server at `TTS_URL` | With `voice.engine: stub` (the isolated start) it needs no TTS server. Otherwise each `brain.say` logs a synthesis failure and still emits `voice.done` |
| `cortex` | Redis and a chat model | With `llm.provider: mock` (the isolated start) it answers by itself. Otherwise it logs `waiting for the model backend` every 3 seconds until the model answers |
| `memory` | Redis, and Postgres plus Ollama unless stubbed | With `brain.memory.store: memory` and `brain.memory.embedder: hash` (the isolated start) it needs neither. Without them it logs `waiting for ollama (embeddings)...` until Ollama answers |
| `chat` | `chat.twitch.channel` for the real source | Idles `degraded` without a channel and still accepts injected chat |
| `eyes` | OBS and a vision model, only with `vision.enabled: true` | Idles `off` by default; injected images are described by the stub with `vision.engine: stub` |
| `ears` | The Discord [connector](../../start/glossary.md#connector), for the `discord` source, and an [STT](../../start/glossary.md#stt) server | With the connector absent, `deps.discord` is `down` and injected audio still works; `ears.stt_engine: stub` needs no STT server |
| `mouth` | Redis, and `voice` for audio | `mouth.outputs.dryrun.enabled: true` runs the whole speaking path above Discord with no sound |

`cortex` without `memory` still replies. It waits `brain.cortex.recall_timeout_ms` for `memory.recall.reply`, logs `memory region did not answer in time`, and answers without memories.

## Stand-in servers

Two scripts in `scripts/dev/` impersonate the servers that need a model, for runs where you want the real service code but not the real model.

| Script | Stands in for | Listens on | Behaviour |
| --- | --- | --- | --- |
| `scripts/dev/stub-tts.ts` | The [Kokoro](../../start/glossary.md#kokoro) TTS server | `STUB_TTS_PORT`, default 8880 | Answers `POST /v1/audio/speech` with a pulsing-tone WAV of about 65 ms per character, so the lip-sync envelope moves |
| `scripts/dev/stub-llm.ts` | Ollama's chat API | `STUB_LLM_PORT`, default 11434 | Serves `GET /api/tags` and `POST /api/chat`; replies `Stub brain here. You said: ...`. It has no `/api/embed`, so use the `memory` override above instead |

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
COHOST_ISOLATION='{"LLM_PROVIDER":"mock"}' pnpm --filter @cohost/cortex exec tsx src/index.ts &
pnpm --filter @cohost/salience exec tsx src/index.ts &
pnpm --filter @cohost/affect exec tsx src/index.ts &
COHOST_ISOLATION='{"CHAT_SOURCES":"[fake]"}' pnpm --filter @cohost/chat exec tsx src/index.ts &
COHOST_ISOLATION='{"VOICE_ENGINE":"stub"}' pnpm --filter @cohost/voice exec tsx src/index.ts &
```

Watch the Services screen (or `GET /services`) for `mock` modes, and `brain.say` and `voice.utterance` on the event feed. In-memory data is gone when a process exits. The next page, [Fake inputs](inject.md), shows how to put your own events in.
