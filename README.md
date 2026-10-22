# cohost

A locally hosted AI VTuber co-host for your stream. It watches the game through
OBS, reads Twitch chat, sits in your Discord voice channel, remembers people and
running jokes across streams, and drives a 2D (VTube Studio) or 3D (VRM / VMC)
avatar. Every piece is its own container on a Redis bus, so nothing is
monolithic and anything can be swapped.

```
   Twitch ──► chat ─┐                 ┌─────────── brain ───────────┐
   OBS ────► eyes ──┼──► [ redis bus ] ◄──► salience  affect           │ ──► voice ──► (audio) ──► dashboard sink / OBS browser source
   Discord ► ears ──┘        ▲         │    memory    cortex ──► say  │                             └─► Discord (ears)
                             │         └──────┬──────────────────────┘ ──► avatar ──► VTube Studio / VMC app
                             │                └── postgres (pgvector)
                             └──► dashboard (feed, controls, personality editor)
```

The brain itself is not one process. It is four small regions that only talk to
each other over the same bus, the way the rest of the stack does:

| region     | plays the part of        | does                                                                   |
| ---------- | ------------------------ | ---------------------------------------------------------------------- |
| `salience` | amygdala / attention     | scores events, decides *when* to speak (`attention.focus`), fires reflexes |
| `affect`   | limbic system / mood     | running valence + arousal that decays on its own (`affect.state`)      |
| `memory`   | hippocampus              | owns Postgres; stores exchanges, answers `memory.recall.request`       |
| `cortex`   | prefrontal / language    | the only one that calls the chat LLM; turns a focus into `brain.say`   |

| service     | does                                                         | talks to                    |
| ----------- | ------------------------------------------------------------ | --------------------------- |
| `chat`      | Twitch chat → `chat.message`                                 | Twitch IRC                  |
| `eyes`      | OBS screenshot → vision model → `vision.summary`             | obs-websocket, Ollama       |
| `ears`      | Discord voice → Whisper → `speech.heard`; plays the voice    | Discord, speaches (STT)     |
| `salience`  | when to talk; reflexes → `brain.say` directly, no LLM        | bus only                    |
| `affect`    | mood → `affect.state` (avatar resting face, prompt colour)   | bus only                    |
| `memory`    | embeds + recalls; viewer table; reflection pass              | Ollama (embed), Postgres    |
| `cortex`    | `attention.focus` → LLM → `brain.say`                        | Ollama                      |
| `voice`     | `brain.say` → TTS → audio + lip-sync envelope                | Kokoro (TTS)                |
| `avatar`    | canonical avatar state → app-specific driver                 | VTube Studio / VMC          |
| `dashboard` | live feed, mute/say, audio sink, edit personality            | browser                     |

Infra containers: `redis`, `postgres` (pgvector), `ollama`, `tts` (Kokoro-FastAPI), `stt` (speaches / faster-whisper).

## Quick start

```bash
git clone <this repo> cohost && cd cohost
./scripts/install.sh          # docker, nvidia toolkit, node, .env, pulls images + models
# edit .env  (Twitch channel, OBS password, Discord token, AVATAR_DRIVER)
docker compose up -d          # core: chat + brain regions + voice avatar dashboard + infra
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
   the message hit the bus, salience focus, the cortex think, and the reply get spoken, with the
   preview face lip-syncing.

## Configuration

| file                       | holds                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `.env`                     | secrets + per-machine stuff (tokens, hosts, which GPU overlay)   |
| `config/config.yaml`       | all behaviour: models, timings, talkativeness, voice, driver     |
| `config/personality.md`    | who the co-host is; the cortex re-reads it on save from dashboard |
| `config/expressions.yaml`  | canonical emotion → your model's expression/hotkey names         |

Upgrading the GPU later is `LLM_MODEL=qwen2.5:14b-instruct-q4_K_M` in `.env` and
`docker compose up -d models`. Nothing else changes.

### Talkativeness

`brain.salience.*` in `config.yaml`. The salience region scores unseen events
every `tick_ms`: a mention of its name = 1.0, something said in voice = 0.9, a
question = 0.55, a mod/sub = 0.35, screen change = 0.3, plain chat = 0.15. It
publishes `attention.focus` at ≥ `speak_threshold` (0.6), never within
`cooldown_ms` of the last line, never while the cortex is thinking or the voice
is still playing, and pipes up on its own after `idle_chatter_ms` of quiet. An
excited mood lowers the threshold by up to `arousal_bias`.

### Reflexes

`brain.salience.reflexes` is a list of `match` regexes with canned `say` lines.
When an event matches, salience publishes `brain.say` itself, instantly, with no
LLM in the loop. Use it for the things that should get a reaction before anyone
has time to think (a death on screen, a raid). Each rule has its own cooldown.

### Mood

`brain.affect.*`. Every event nudges a valence (good/bad) and arousal
(flat/buzzing) pair that relaxes back to `baseline_valence` with
`half_life_ms`. The nearest canonical emotion is published as `affect.state`:
the avatar wears it as its resting face between lines, the cortex gets a
one-line mood description in the prompt, and salience gets chattier when
arousal is high. No LLM, no database.

### Memory

The `memory` region is the only thing that touches Postgres. Every message that
addresses the co-host, everything said in voice, and everything the co-host says
itself is embedded (`nomic-embed-text`) and stored. Before each reply the cortex
asks over the bus (`memory.recall.request` → `memory.recall.reply`) for the
`recall_k` most similar memories, and answers without them if nothing comes back
within `brain.cortex.recall_timeout_ms`. Viewers get a row with message count so
it knows regulars from first-timers (`memory.viewer`).

After a stream, run the reflection pass to let it update its own personality file:

```bash
docker compose run --rm memory node services/memory/dist/reflect.js
# or, in the dev loop:  pnpm reflect
```

It appends a dated block of bullets to `## Learned` in `personality.md`. Edit or
delete whatever you don't like — it's just a file.

## Hooks: regions you can replace with a model

Three regions expose their judgement as a hook that runs one of: `rules` (the
built-in heuristics, default), `llm` (one chat call, JSON answer, optionally
on a smaller model than the cortex), or `http` (POST to a URL you serve — a
model you trained yourself).

| hook              | asks                                         | `.env`                                   |
| ----------------- | -------------------------------------------- | ---------------------------------------- |
| `salience.module` | how much does each event deserve a reaction? | `SALIENCE_MODULE=rules\|llm\|http`       |
| `affect.module`   | how does this line move my mood?             | `AFFECT_MODULE=rules\|llm\|http`         |
| `cortex.critic`   | is this reply okay to say? (inhibition)      | `CORTEX_CRITIC=rules\|llm\|http`         |

Any failure falls back to `rules`. Contracts, prompts, a runnable stand-in
server and `.env` recipes for each kind are in [`examples/modules/`](examples/modules/).

## Stronger model (rented GPUs, hosted APIs)

The regions never see the model backend, so a bigger brain is a `.env` change.
`LLM_PROVIDER` picks it; `LLM_MODEL` is the id as that provider names it.
Embeddings always stay on local Ollama, so swapping the chat model never
changes the vector size of the memory table.

| provider    | what it is                                                        | `.env`                                                    |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `ollama`    | local GPU (default)                                               | `LLM_MODEL=qwen2.5:14b-instruct-q4_K_M`                   |
| `openai`    | any OpenAI-compatible endpoint: vLLM on a box you rent by the hour, OpenRouter, Groq, Together ... | `LLM_BASE_URL=http://my-box:8000/v1` `LLM_API_KEY=...` `LLM_MODEL=...` |
| `anthropic` | Claude via the Claude API                                         | `ANTHROPIC_API_KEY=...` `LLM_MODEL=claude-opus-5-5`        |
| `bedrock`   | Claude via Amazon Bedrock, billed to your AWS account             | `AWS_REGION=us-east-1` + the usual `AWS_*` credentials, `LLM_MODEL=anthropic.claude-opus-5-5` |

Then `docker compose up -d cortex` (and `memory`, since the reflection pass
uses the same chat model). Full `.env` recipes per provider: [`examples/providers/`](examples/providers/). `llm.claude.*` in `config.yaml` tunes the Claude
paths: `effort` (thinking depth; `low` suits one-line replies), a roomier
`max_tokens` because thinking and the reply share it, and `fallbacks`, which
retries on another Claude model if a safety classifier declines (Claude API
only; on Bedrock a decline just means it says nothing that turn).

Everything else — eyes, ears, voice, the avatar, Postgres — stays local.
Only the cortex's chat call and the reflection pass leave the machine.

## Avatar: 2D or 3D

`AVATAR_DRIVER` picks the driver; the brain regions never know which app is running.

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
engine, or a new avatar driver never touches the brain regions. Adding a region
is the same move in reverse: a new service that subscribes to what it needs and
publishes a new event type.

## Status

Scaffold. Built and type-checked; the `chat → salience → cortex → voice → avatar → dashboard`
path has been exercised end-to-end against a stub TTS. Not yet run against real
Twitch / VTube Studio / Discord — expect to tune the VTS parameter names and the
Discord receive path on first contact.
