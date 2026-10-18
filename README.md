# cohost

A locally hosted AI VTuber co-host for your stream. It watches the game through
OBS, reads Twitch chat, sits in your Discord voice channel, remembers people and
running jokes across streams, and drives a 2D (VTube Studio) or 3D (VRM / VMC)
avatar. Every piece is its own container on a Redis bus, so nothing is
monolithic and anything can be swapped.

```
   Twitch ──► chat ─┐                               ┌─► voice ──► (audio) ──► dashboard sink / OBS browser source
   OBS ────► eyes ──┼──► [ redis bus ] ──► brain ──┤                              └─► Discord (ears)
   Discord ► ears ──┘        ▲    │                 └─► avatar ──► VTube Studio / VMC app
                             │    └──► dashboard (feed, controls, personality editor)
                        memory (postgres + pgvector)
```

| service     | does                                                         | talks to                    |
| ----------- | ------------------------------------------------------------ | --------------------------- |
| `chat`      | Twitch chat → `chat.message`                                 | Twitch IRC                  |
| `eyes`      | OBS screenshot → vision model → `vision.summary`             | obs-websocket, Ollama       |
| `ears`      | Discord voice → Whisper → `speech.heard`; plays the voice    | Discord, speaches (STT)     |
| `brain`     | decides *when* to talk, asks the LLM *what*, keeps memory    | Ollama, Postgres            |
| `voice`     | `brain.say` → TTS → audio + lip-sync envelope                | Kokoro (TTS)                |
| `avatar`    | canonical avatar state → app-specific driver                 | VTube Studio / VMC          |
| `dashboard` | live feed, mute/say, audio sink, edit personality            | browser                     |

Infra containers: `redis`, `postgres` (pgvector), `ollama`, `tts` (Kokoro-FastAPI), `stt` (speaches / faster-whisper).

## Quick start

```bash
git clone <this repo> cohost && cd cohost
./scripts/install.sh          # docker, nvidia toolkit, node, .env, pulls images + models
# edit .env  (Twitch channel, OBS password, Discord token, AVATAR_DRIVER)
docker compose up -d          # core: chat brain voice avatar dashboard + infra
open http://localhost:3000    # dashboard
```

Works on **Ubuntu/Debian** natively and inside **WSL2** (Docker Desktop with WSL
integration, or docker-ce in the distro). On WSL the GPU is provided by the
Windows NVIDIA driver — nothing to install in Linux beyond the container toolkit,
which `install.sh` handles.

Add the optional pieces when you're ready:

```bash
docker compose --profile eyes up -d   # OBS vision (set vision.enabled: true in config.yaml)
docker compose --profile ears up -d   # Discord voice bot
```

### Minimal first run (no avatar app, no Discord, no OBS)

1. Set `TWITCH_CHANNEL` in `.env`, leave `AVATAR_DRIVER=null`.
2. `docker compose up -d`
3. Open the dashboard, click **enable audio**, type something in chat. You'll see
   the message hit the bus, the brain think, and the reply get spoken, with the
   preview face lip-syncing.

## Configuration

| file                       | holds                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `.env`                     | secrets + per-machine stuff (tokens, hosts, which GPU overlay)   |
| `config/config.yaml`       | all behaviour: models, timings, talkativeness, voice, driver     |
| `config/personality.md`    | who the co-host is; the brain re-reads it on save from dashboard |
| `config/expressions.yaml`  | canonical emotion → your model's expression/hotkey names         |

Upgrading the GPU later is `LLM_MODEL=qwen2.5:14b-instruct-q4_K_M` in `.env` and
`docker compose up -d models`. Nothing else changes.

### Talkativeness

`brain.*` in `config.yaml`. The scheduler scores unseen events every `tick_ms`:
a mention of its name = 1.0, a question = 0.55, a mod/sub = 0.35, screen change
= 0.3, plain chat = 0.15. It speaks at ≥ 0.6, never within `cooldown_ms` of the
last line, and pipes up on its own after `idle_chatter_ms` of quiet.

### Memory

Every message that addresses the co-host, everything said in voice, and
everything it says itself is embedded (`nomic-embed-text`) into Postgres.
Before each reply it recalls the `recall_k` most similar memories. Viewers get a
row with message count so it knows regulars from first-timers.

After a stream, run the reflection pass to let it update its own personality file:

```bash
docker compose run --rm brain node services/brain/dist/reflect.js
# or, in the dev loop:  pnpm reflect
```

It appends a dated block of bullets to `## Learned` in `personality.md`. Edit or
delete whatever you don't like — it's just a file.

## Avatar: 2D or 3D

`AVATAR_DRIVER` picks the driver; the brain never knows which app is running.

| driver          | app(s)                                             | how                                                |
| --------------- | -------------------------------------------------- | -------------------------------------------------- |
| `vtube-studio`  | VTube Studio (Live2D)                              | VTS WebSocket API: param injection + hotkeys       |
| `vmc`           | VSeeFace, Warudo, VNyan, VMagicMirror… (VRM)       | VMC protocol (OSC/UDP) blendshapes + head bone     |
| `null`          | nothing — dashboard preview only                   |                                                    |

Adding an app = one file in `services/avatar/src/drivers/` implementing
`AvatarDriver` (`setParams`, `setExpression`, `trigger`), one case in
`drivers/index.ts`, one block in `expressions.yaml`. Timing, smoothing, idle
motion and lip-sync all live in the engine, so drivers stay ~100 lines.

**VTube Studio:** enable the API (Settings → General → *Start API*). First run
pops an *Allow plugin* dialog; the token is saved to `config/.vts-token`.
Put your expression hotkey names (or `*.exp3.json` files) in `expressions.yaml`.

**VRM apps:** enable a VMC receiver on port 39539 and point `VMC_HOST` at that
machine.

## Getting the voice onto stream

No virtual audio cables: add `http://<ai-pc>:3000/?sink=1` as an OBS **Browser
Source** with *Control audio via OBS* ticked. The page plays every utterance and
reports playback to the bus so the avatar lip-syncs in time. For the avatar
itself, capture the VTS/VRM window (same PC) or send it over NDI (second PC).

## Two-PC setup

Everything in this repo runs on the AI box. The gaming PC only needs:

- OBS with the WebSocket server enabled and reachable on LAN (`OBS_HOST=<gaming-pc-ip>`)
- the avatar app, *or* run it on the AI box and send it to OBS with NDI

## Developing

```bash
docker compose up -d redis postgres ollama tts stt   # infra only
pnpm install
pnpm dev                                              # every service with tsx watch
```

`.env` is loaded automatically in the dev loop. Each service is one `src/index.ts`
with a `Bus` from `@cohost/bus`; event types and payloads are in
`packages/bus/src/events.ts` (zod). Adding a YouTube chat source, a second TTS
engine, or a new avatar driver never touches the brain.

## Status

Scaffold. Built and type-checked; the `chat → brain → voice → avatar → dashboard`
path has been exercised end-to-end against a stub TTS. Not yet run against real
Twitch / VTube Studio / Discord — expect to tune the VTS parameter names and the
Discord receive path on first contact.
