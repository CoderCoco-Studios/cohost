---
title: Real hardware and accounts
description: Which services need a GPU or an outside account, what stands in for each in tests, and how to bring each real backend in one at a time.
track: advanced
verified: f126b94
---

# Real hardware and accounts

The earlier testing pages run on stand-ins. This page is for the step after: swapping one stand-in at a time for the real thing, so that when something breaks you know which swap did it.

The pattern: run the services from [One service on its own](isolated.md) with every stand-in on, then remove one stand-in (start the unit without **Isolated**, or restore the real key), start that backend, and watch the service's mode go from `mock` to `live` on the Services screen.

## What you need

- The mock path from [One service on its own](isolated.md) working first.
- [Docker](../../start/glossary.md#docker) for the infrastructure [containers](../../start/glossary.md#container). A [GPU](../../start/glossary.md#gpu) is optional: every image has a CPU build.
- Whatever account the backend needs: a Twitch channel, a Discord bot, OBS, an avatar app. The [simple track's Connect pages](../../guide/connect/twitch.md) walk through creating each.

## What needs what

| Service | Outside dependency | GPU | Substitute while testing |
| --- | --- | --- | --- |
| `voice` | The [Kokoro](../../start/glossary.md#kokoro) [TTS](../../start/glossary.md#tts) container (`tts`) | Optional; a CPU image exists | `scripts/dev/stub-tts.ts`, or an isolated start (`voice.engine: stub`) |
| `cortex`, the `salience` and `affect` `llm` [hooks](../../start/glossary.md#hook), `memory` reflection | [Ollama](../../start/glossary.md#ollama), an OpenAI-compatible server or Claude | Yes for Ollama | `scripts/dev/stub-llm.ts`, an isolated start of `cortex` (`llm.provider: mock`), or `llm.provider: openai` pointed at any local server |
| `memory` | Ollama's `nomic-embed-text` and [Postgres](../../start/glossary.md#postgres) with [pgvector](../../start/glossary.md#pgvector) | [Embeddings](../../start/glossary.md#embedding) are light | An isolated start of `memory` (`brain.memory.store: memory`, `brain.memory.embedder: hash`), or the real containers below |
| `eyes` | [OBS](../../start/glossary.md#obs) over [obs-websocket](../../start/glossary.md#obs-websocket) and a vision model | Yes | An isolated start of `eyes` (`vision.engine: stub`) with an image injected from the dashboard, or a hand-published `vision.summary`. Leave `vision.enabled: false` unless OBS is up |
| `ears` | The Discord [connector](../../start/glossary.md#connector) and an [STT](../../start/glossary.md#stt) container ([faster-whisper](../../start/glossary.md#whisper)) | STT is GPU-friendly | An isolated start of `ears` (`ears.stt_engine: stub`) with audio injected from the dashboard, or a hand-published `speech.heard`; the `http` and `dir` sources need no account |
| `mouth` | The Discord connector's [sink](../../start/glossary.md#sink) and `voice` | No | An isolated start of `mouth` (`mouth.outputs.dryrun.enabled: true` with `mouth.outputs.discord.enabled: false`). The dashboard's `?sink=1` page is a second, independent sink |
| `connector-discord` | The one Discord bot (`connections.discord.token` in `config/secrets.yaml`) | No | An isolated start of `connector-discord` (`connections.discord.enabled: false`); an injected clip is still answered |
| `chat` | Twitch IRC | No | An isolated start of `chat` (`chat.source: fake`), or a hand-published `chat.message` |
| `avatar` | [VTube Studio](../../start/glossary.md#vtube-studio) or a [VMC](../../start/glossary.md#vmc) receiver | No; the app renders | An isolated start of `avatar` (`avatar.driver: "null"`, also the default in `config.example.yaml`) |

To test the service itself, rely on its unit tests; the network and hardware edge is the only part they do not cover.

## The infrastructure containers, CPU only

About 1 GB of images plus two small models. The base [compose](../../start/glossary.md#docker-compose) file has CPU images.

```bash
docker compose up -d redis postgres ollama tts stt
docker compose ps
curl -s localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'
curl -s localhost:11434/api/pull -d '{"name":"qwen2.5:0.5b-instruct"}'
curl -s localhost:8880/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"Hello there","voice":"af_heart","response_format":"wav"}' -o hello.wav
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/health
```

`docker compose ps` should show Postgres and [Redis](../../start/glossary.md#redis) `healthy`. The first pull is the 768-dimension embedding model; the second is a tiny chat model that answers fast and says silly things. It is for checking the plumbing; use the `llm.model` from `config.example.yaml` for real quality. The speech request should return a WAV, and the health check should print `200`.

Then run the services on the host against them. Set `llm.model: "qwen2.5:0.5b-instruct"` in `config/config.yaml` first. A variable you set in the shell overrides the same variable in `.env`:

```bash
export VOICE_URL=http://127.0.0.1:8700
for s in salience affect memory cortex voice avatar; do node --import tsx services/$s/src/index.ts & done
```

`memory` logs `memory ready` with `dims: 768` and creates its tables (`memories`, `viewers`, `viewer_notes`, `viewer_note_deletions`, `viewer_links` and `meta`) in Postgres. Publish the chat message from [Recipe B](inject.md#recipe-b-the-full-talking-loop-no-gpu-no-accounts) and you get a real reply, real Kokoro audio in `voice.utterance`, a `memory.viewer` for the new user and an on-time, empty `memory.recall.reply`. Afterwards the exchange is in the database:

```bash
docker compose exec postgres psql -U cohost -c 'select kind, who, text from memories'
```

It shows the chat line (kind `chat`) and the reply (kind `self`).

Stop everything with `docker compose down`; add `-v` to drop the Postgres and model volumes too. Stop the host jobs as described on [One service on its own](isolated.md#stand-in-servers).

### Speech to text with real audio

A text-to-speech to speech-to-text round trip, through the endpoint `ears` uses. Download a model into the STT container once, then transcribe the WAV from above:

```bash
curl -s -XPOST localhost:8000/v1/models/Systran/faster-whisper-tiny.en
curl -s localhost:8000/v1/audio/transcriptions -F file=@hello.wav -F model=Systran/faster-whisper-tiny.en
```

The transcription should come back as `{"text":"Hello there."}`. The default `ears.stt_model` in `config.example.yaml` is `Systran/faster-whisper-small`.

### The GPU overlay

With the NVIDIA container toolkit installed, `docker run --rm --gpus all ubuntu nvidia-smi -L` lists the card. Start Ollama with the GPU overlay and check that it uses it:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d ollama
docker compose exec ollama ollama ps
```

`ollama ps` reports the loaded model's processor, `100% GPU` when it fits. Setting `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env` makes a plain `docker compose up -d` use both files, and the installer does that when it sees a GPU. The overlay also switches the `tts` and `stt` images to their CUDA builds.

### The services as containers

`docker compose build` builds every service image, and `scripts/compose-smoke.sh` (run in CI) checks that `salience`, `affect` and `avatar` come up healthy. The Dockerfile deliberately does not run `pnpm prune --prod`. To run the talking path in containers:

```bash
docker compose up -d redis postgres ollama tts stt salience affect memory cortex voice avatar
```

Publish a chat message with `bus-pub` and it should travel `salience`, `cortex`, Ollama, Kokoro and `voice.done`. The dashboard is not a Compose service: start it on the host with `pnpm dashboard`, and `http://localhost:<dashboard.port>/audio/<id>.wav` returns the WAV through the voice service on `127.0.0.1:8700`. Compose sets `VOICE_URL=http://voice:8700` for the containers itself. Leave `chat` out unless you set `chat.twitch.channel` or `chat.source: fake`.

## Twitch

Reading a channel needs only its name, with no login. Set `chat.twitch.channel: "somechannel"` in `config/config.yaml`, then run:

```bash
node --import tsx services/chat/src/index.ts
```

`chat` logs `connected to twitch chat` with `authenticated: false` and publishes `chat.message` [events](../../start/glossary.md#event) as people talk, so pick a busy channel. With `chat.twitch.channel` empty it idles `degraded` instead of exiting. Posting back and the authenticated path need the `chat.twitch` credentials in `config/secrets.yaml`; see [Twitch chat](../../guide/connect/twitch.md).

## VMC avatar driver

Point the `vmc` driver at a UDP listener to see its packets without an avatar app. Set `avatar.driver: vmc` and `avatar.vmc.host: "127.0.0.1"` in `config/config.yaml`, then run:

```bash
node --import tsx services/avatar/src/index.ts
```

With a listener on UDP port 39539, a `brain.say` produces `/VMC/Ext/Blend/Val`, `/VMC/Ext/Blend/Apply`, `/VMC/Ext/Bone/Pos` and `/VMC/Ext/OK` messages. It is fire-and-forget UDP over [OSC](../../start/glossary.md#osc), so the driver never reports "connected". For a real 3D avatar, enable a receiver in the app; see [Avatar](../../guide/connect/avatar.md).

## OBS

Needed only by `eyes` with `vision.enabled: true`, and for the stream itself; every other service ignores OBS.

- OBS 28 or newer, where obs-websocket v5 is built in. Under Tools, WebSocket Server Settings, enable the server on port 4455 (`vision.obs.port`) and set a password (`vision.obs.password` in `config/secrets.yaml`).
- A source named exactly as `vision.obs.source` (default `Game Capture`) that can produce a screenshot.
- Reachable from the `eyes` container: `vision.obs.host: host.docker.internal` for OBS on the same Windows PC as Docker Desktop, or the gaming PC's LAN address for two PCs, with obs-websocket listening on the LAN and the firewall open on 4455.
- A vision model pulled into Ollama (`vision.model`); `vision.engine: stub` replaces it with fixed text.
- For the voice on stream: a [Browser Source](../../start/glossary.md#browser-source) with Control audio via OBS pointing at the dashboard's sink page, `http://localhost:<dashboard.port>/?sink=1` on the same PC or `http://<ai-pc-ip>:<dashboard.lan_port>/?sink=1` from a second PC (by IP address, not a machine name).

Checks:

1. With OBS closed, `eyes` is `degraded` with `obs: down` and retries every 10 seconds, doubling up to 60.
2. Start OBS: `eyes` connects without a restart, and `vision.summary` events appear when the screen changes.
3. Restart OBS mid-run: `eyes` reconnects.
4. Change `vision.obs.password` in `config/secrets.yaml` and restart `eyes`: `eyes` shows `degraded` and the log carries the login error.

## Discord: one bot

One Discord connector holds the bot's login and its voice connection. `ears` (hearing) and `mouth` (speaking) take audio from it and give audio to it over Redis and hold no Discord client, so any of the three can run, restart or be tested without the others.

| | Discord connector |
| --- | --- |
| Token in `config/secrets.yaml` | `connections.discord.token`, the only Discord token |
| Bot permissions in the voice channel | Connect and Speak |
| Privileged intents | Server Members |
| [Compose profile](../../start/glossary.md#compose-profile) | `discord`, beside `ears` and `mouth` |
| Without its token | `degraded`; it registers nothing |

Also set `connections.discord.guild_id` and `connections.discord.voice_channel_id` in `config/config.yaml` (ids go in quotes), and `COMPOSE_PROFILES=discord,ears,mouth` keeps the profiles on across Launch. Checks, in order:

1. Start only `ears`, with no connector: `deps.discord` is `down` (`discord connector not connected`) and injected audio still works. Start the connector and `deps.discord` returns to `ok` without restarting `ears`.
2. With the connector joined, undeafened and unmuted, speak in the channel. `speech.heard` appears on the feed with your display name and `source` `discord`. This is where the native voice dependencies (`libsodium-wrappers`, `@snazzah/davey`, `opusscript`) are confirmed or found missing.
3. Start `mouth`, send a chat line and hear the reply in the channel. Then stop `voice` and send another: `mouth` plays its cached fallback line, at most once per `mouth.fallback.min_interval_ms`.
4. The co-host's own voice never becomes `speech.heard`; the connector ignores every bot account.
5. Set `mouth.outputs.discord.enabled: false` in the Settings screen and restart `mouth`: it idles `off` and plays nothing. Kill and restart the connector: it rejoins and both halves resume.
6. Set `ears.sources: [discord, http]`, post a clip to `http://127.0.0.1:8765/audio` and see `speech.heard` with `source` `http`. Stop the connector and see only `deps.discord` go `down`.

## What has not been run

The `tts` GPU image, `eyes`, `ears` and `mouth` in Docker, the authenticated Twitch path, VTube Studio against the real app (only its driver tests run), the OBS path and the Discord bot all need a real account or hardware, and the automated suite does not cover them. [Status](../../project/status.md) records which have been run, and each is a manual verification item in its segment's design.
