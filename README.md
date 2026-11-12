# cohost

A locally hosted AI VTuber co-host for your stream. It watches the game through
OBS, reads Twitch chat, sits in your Discord voice channel, remembers people and
running jokes across streams, and drives a 2D (VTube Studio) or 3D (VRM / VMC)
avatar. Every piece is its own container on a Redis bus, so nothing is
monolithic and anything can be swapped.

```
   Twitch ──► chat ─┐                 ┌─────────── brain ───────────┐
   OBS ────► eyes ──┼──► [ redis bus ] ◄──► salience  affect           │ ──► voice ──► (audio) ──► dashboard sink / OBS browser source
   Discord ► ears ──┘        ▲         │    memory    cortex ──► say  │                             └─► Discord (mouth)
                             │         └──────┬──────────────────────┘ ──► avatar ──► VTube Studio / VMC app
                             │                └── postgres (pgvector)
                             └──► dashboard (host process: feed, controls, personality editor, Launch/Stop)
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
| `ears`      | Discord voice → Whisper → `speech.heard` (listens only)      | Discord, speaches (STT)     |
| `mouth`     | `voice.utterance` → her Discord bot, plus a fallback line    | Discord, voice (audio)      |
| `salience`  | when to talk; reflexes → `brain.say` directly, no LLM        | bus only                    |
| `affect`    | mood → `affect.state` (avatar resting face, prompt colour)   | bus only                    |
| `memory`    | embeds + recalls; viewer table; reflection pass              | Ollama (embed), Postgres    |
| `cortex`    | `attention.focus` → LLM → `brain.say`                        | Ollama                      |
| `voice`     | `brain.say` → TTS → audio + lip-sync envelope                | Kokoro (TTS)                |
| `avatar`    | canonical avatar state → app-specific driver                 | VTube Studio / VMC          |
| `dashboard` | runs on the host, not in Compose: live feed, mute/say, audio sink, edit personality, services tab, Launch / Stop for the stack | browser, docker CLI |

Infra containers: `redis`, `postgres` (pgvector), `ollama`, `tts` (Kokoro-FastAPI), `stt` (speaches / faster-whisper).

## Quickstart: mock mode, no accounts

From a clean checkout to a healthy stack with no Twitch, Discord, OBS, avatar app, GPU or API key.
Every external dependency has a mock backend (see [Running one service on its own](#running-one-service-on-its-own-isolated)),
and one block of `.env` lines flips them all:

```bash
git clone <this repo> cohost && cd cohost
pnpm install                       # Node >= 22, pnpm 10 (corepack enable)
cp .env.example .env
sed -i "s/^CONTROL_TOKEN=.*/CONTROL_TOKEN=$(openssl rand -hex 24)/" .env
cat >> .env <<'EOF'
LLM_PROVIDER=mock
MEMORY_STORE=memory
MEMORY_EMBEDDER=hash
VOICE_ENGINE=stub
CHAT_SOURCE=fake
EOF
pnpm dashboard                     # builds and starts the dashboard on the host; prints its URL
```

The lines mean: cortex answers with canned echoes (the viewer-note hooks follow it); memory is an in-process
store with offline embeddings, lost on exit; voice returns silent WAVs with no TTS call; chat publishes a scripted
message every 8 s. `AVATAR_DRIVER=null` is already the default in `.env.example`.

Open <http://localhost:3000>, enter `CONTROL_TOKEN` from `.env`, press **Launch**, and wait for the
Services tab to show every service `up` with mode `mock` (redis, postgres, ollama, tts and stt are
infra and show in the stack panel). Click **enable audio**: the fake viewers talk, salience focuses,
the cortex answers, and the preview face lip-syncs to silence. Chat lines you type into the test panel
take the same path.

- Launch always builds (`up -d --build`): an unchanged image is a quick cache hit, changed code is rebuilt.
- The first Launch pulls the infra images and, through the `models` service, the Ollama models: several GB
  even in mock mode. To skip that, use the Redis-only smoke run under
  [Running one service on its own](#running-one-service-on-its-own-isolated).
- `eyes`, `ears` and `mouth` are optional profiles and stay off. To exercise them without accounts, set
  `EARS_SOURCE=off` or `EARS_STT_ENGINE=stub`, `MOUTH_DISCORD_ENABLED=false` (or `MOUTH_DRYRUN_ENABLED=true`),
  `VISION_ENABLED=false` with `VISION_ENGINE=stub`, and feed them from the dashboard's test inputs.
  `eyes` with `VISION_ENABLED=true` always wants a reachable OBS: its mock covers injected images only.
- Real backends one at a time: delete the matching line and fill in the account (Twitch, Discord, OBS and
  VTube Studio sections of `.env`), then restart that service from the Services tab.
- `GET /services` without the bearer token returns `state: unknown` for every unit; send the control token to see unit details.

**Docker from WSL2.** With Docker Desktop's WSL integration on, `docker` is on the distro's path and nothing
more is needed. Without it, set `COHOST_DOCKER_BIN=docker.exe` in `.env`; the dashboard and `cohostctl` then
run every Compose command through it. For an NVIDIA GPU add the overlay to `COMPOSE_FILE` in `.env`
(`install.sh` does this when it sees a GPU): `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml`. A
Windows `docker.exe` splits that list on `;` rather than `:` unless you also set
`COMPOSE_PATH_SEPARATOR=:` in `.env` (not run with the GPU overlay; the mock stack was run through `docker.exe` on 2026-11-11, see
[docs/plans/live-verification.md](docs/plans/live-verification.md); the step-by-step check is the
[single-PC WSL2 checklist](docs/TESTING.md#single-pc-wsl2-with-docker-desktop)). Isolated starts also reach `docker.exe`:
the control plane lists the preset variables in `WSLENV`, which WSL interop requires. Injected image and audio uploads travel over Redis, so nothing on the host needs to be reachable from containers. The GPU comes from the
Windows NVIDIA driver; nothing to install in Linux except the container toolkit.

## Quick start with real accounts

```bash
git clone <this repo> cohost && cd cohost
./scripts/install.sh          # docker, nvidia toolkit, node, .env, pulls images + models
# edit .env (tokens, OBS password, AVATAR_DRIVER) and config/config.yaml (model, hooks, behaviour)
pnpm dashboard                # start the dashboard on the host (nothing else needs to be running)
open http://localhost:3000    # enter CONTROL_TOKEN from .env when asked, then press Launch
```

The dashboard is the one thing you start. It is a host process, not a Compose
service, so it can bring the stack up before anything else exists: **Launch**
runs `docker compose up -d --build` (core: chat + brain regions + voice avatar + infra; images are rebuilt on every Launch, so they never lag the code),
**Stop** stops it, and a **consolidate** pass is offered after a shutdown.
`install.sh` generates `CONTROL_TOKEN` into `.env` (by hand: `openssl rand -hex 24`).
`PORT` overrides `DASHBOARD_PORT` for the dashboard; its startup log prints the URL
it actually uses. `DASHBOARD_HOST=0.0.0.0` opens the full dashboard to other
machines (it then refuses to start without `CONTROL_ENABLED=1` and a token).

Upgrading from a containerised dashboard: run `docker compose down --remove-orphans`
once, or just press Launch, which removes the orphaned `dashboard` container.

Works on **Ubuntu/Debian** natively and inside **WSL2** (Docker Desktop with WSL
integration, or docker-ce in the distro). On WSL the GPU is provided by the
Windows NVIDIA driver — nothing to install in Linux beyond the container toolkit,
which `install.sh` handles. On a single PC with WSL2 and Docker Desktop (no second
machine), set `COHOST_DOCKER_BIN=docker.exe` in `.env` if `docker` is not on the WSL
path; the step-by-step check is the [single-PC WSL2 checklist](docs/TESTING.md#single-pc-wsl2-with-docker-desktop).

Add the optional pieces when you're ready:

```bash
docker compose --profile eyes up -d   # OBS vision (set vision.enabled: true in config.yaml)
docker compose --profile ears up -d   # Discord listener (hears the voice channel)
docker compose --profile mouth up -d  # Discord speaker (plays her voice there)
```

### Discord: two bots

Listening and speaking are separate optional services with a Discord bot each,
so either can run, restart or be routed without the other. Create two
applications at <https://discord.com/developers> and invite both to your server:

| service | `.env` key | permissions | profile |
|---|---|---|---|
| Discord connector (hears and speaks) | `DISCORD_TOKEN` | Connect, Speak, plus the Server Members intent | `discord` |

One bot serves both halves: the Discord connector logs in, holds the one voice
connection and carries her voice out and the channel's audio in over Redis, so
`ears` (listens) and `mouth` (speaks) hold no Discord client and need no token.
The connector ignores every bot account, so it never hears her own voice.
Set `DISCORD_GUILD_ID` and `DISCORD_VOICE_CHANNEL_ID` in `.env`. To keep the
profiles on across restarts and Launch, list them in `.env`:
`COMPOSE_PROFILES=discord,ears,mouth` (add `eyes` for vision).

**Where her voice goes** is the `mouth.outputs` table in `config/config.yaml`.
Each key is one output; today there is one, `discord`:

```yaml
connections:
  discord:
    enabled: true        # false = the connector idles and holds no connection
    guild_id: "${DISCORD_GUILD_ID}"
    voice_channel_id: "${DISCORD_VOICE_CHANNEL_ID}"
mouth:
  outputs:
    discord:
      enabled: true      # false = mouth plays nothing
      gain_db: 0         # loudness on this output only, -40..12 dB
  fallback:
    min_interval_ms: 20000   # at most one fallback line per 20 s on an output
```

The dashboard's browser page (`?sink=1`, often an OBS Browser Source) is a
separate sink, not an output: open it wherever you want her voice to play. A
routing change takes a restart of `mouth` (the dashboard Services tab, Restart).

**Upgrading from two bots:** remove `EARS_DISCORD_TOKEN`, keep `DISCORD_TOKEN`, add
`discord` to `COMPOSE_PROFILES`, and move `ears.discord.*` and
`mouth.outputs.discord.guild_id` / `voice_channel_id` to `connections.discord.*` in
`config.yaml`.

**Listening sources.** `ears.sources` is a list, so several run at once (default `[discord]`):
`http` and `dir` need no account, and a connector tag such as `desktop` (the host capture
helper) is an open name that a connector registers. `EARS_SOURCE` still sets the legacy
single `ears.source`, which `ears.sources` overrides when both are set. A source with no
connector, token or path is `down` while the others keep running.

## Configuration

| file                       | holds                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `.env`                     | secrets + per-machine stuff (tokens, API keys, hosts, GPU overlay) |
| `config/config.yaml`       | all behaviour: which model answers, brain hooks, timings, voice, driver |
| `config/personality.md`    | who the co-host is; the cortex re-reads it on save from dashboard |
| `config/expressions.yaml`  | canonical emotion → your model's expression/hotkey names         |

The three `config/` files are yours and git-ignored. The committed
`*.example.*` versions seed them: `install.sh` copies them, and any service
that finds one missing copies it on first run.

The dashboard's **Settings** tab edits `config.yaml` from the same schema the
services load with: pick a section, change values, Validate, Save. It keeps
your comments, `${VAR:-default}` placeholders and unknown keys, never shows or
writes secrets (those stay in `.env`), and refuses a stale save if the file
changed under it. Settings take effect when the services that read them
restart; after a save the page offers to restart them (or names the
`cohostctl restart <unit>` commands when stack control is off).

Upgrading the GPU later is `LLM_MODEL=qwen2.5:14b-instruct-q4_K_M` in `.env` and
`docker compose up -d models`. Nothing else changes.

### Talkativeness

`brain.salience.*` in `config.yaml`. The salience region scores unseen events
every `tick_ms`: a mention of its name = 1.0, something said in voice = 0.9, a
question = 0.55, a mod/sub = 0.35, screen change = 0.3, plain chat = 0.15. It
publishes `attention.focus` at ≥ `speak_threshold` (0.6), never within
`cooldown_ms` of the last line, never while the cortex is thinking or the voice
is still playing, and pipes up on its own after `idle_chatter_ms` of quiet when
there is something new it has not reacted to yet; a fully silent stream stays
silent. An excited mood lowers the threshold by up to `arousal_bias`.

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
arousal is high. No database; the built-in `rules` appraiser needs no model,
and an `llm` or `http` appraiser is opt-in through `brain.affect.module`.

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

### Upgrading an existing install

`config.yaml`, `personality.md` and `expressions.yaml` are no longer tracked
(the `*.example.*` versions are). Before pulling, copy your current three files
somewhere safe: git removes the tracked ones, and your `personality.md` holds
whatever the reflection pass learned. After pulling, put them back in `config/`.

Settings that used to sit directly under `brain:` (`tick_ms`, `cooldown_ms`,
`idle_chatter_ms`, `reply_on_mention`, `max_context_events`) moved under
`brain.salience`, and `max_context_events` is now `working_memory_events`.
Unknown keys are ignored, and every service logs a warning naming them at
startup, so a setting that silently reverted to its default shows up there.

## Hooks: regions you can replace with a model

Three regions expose their judgement as a hook that runs one of: `rules` (the
built-in heuristics, default), `llm` (one chat call, JSON answer, optionally
on a smaller model than the cortex), or `http` (POST to a URL you serve — a
model you trained yourself). Pick per hook in `config.yaml`:

| hook                    | asks                                         |
| ----------------------- | -------------------------------------------- |
| `brain.salience.module` | how much does each event deserve a reaction? |
| `brain.affect.module`   | how does this line move my mood?             |
| `brain.cortex.critic`   | is this reply okay to say? (inhibition)      |

```yaml
brain:
  affect:
    module: { kind: llm, llm: { provider: ollama, model: "qwen2.5:3b-instruct" } }
  cortex:
    critic: { kind: http, url: "http://host.docker.internal:8900/critic" }
```

Any failure falls back to `rules`. Contracts, prompts, a runnable stand-in
server and yaml recipes for each kind are in [`examples/modules/`](examples/modules/).

## Stronger model (rented GPUs, hosted APIs)

The regions never see the model backend, so a bigger brain is a `config.yaml`
change: `llm.provider` picks it, `llm.model` is the id as that provider names
it, and only the API key lives in `.env`. Embeddings always stay on local
Ollama, so swapping the chat model never changes the vector size of the memory
table.

| provider    | what it is                                                        | config.yaml                                              | .env                        |
| ----------- | ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- |
| `ollama`    | local GPU (default)                                               | `provider: ollama`                                       | `LLM_MODEL=` (tag to pull)  |
| `openai`    | any OpenAI-compatible endpoint: vLLM on a box you rent by the hour, OpenRouter, Groq, Together ... | `provider: openai`, `model:`, `openai.base_url:` | `LLM_API_KEY=`   |
| `anthropic` | Claude via the Claude API                                         | `provider: anthropic`, `model: claude-opus-5-5`          | `ANTHROPIC_API_KEY=`        |
| `bedrock`   | Claude via Amazon Bedrock, billed to your AWS account             | `provider: bedrock`, `model: anthropic.claude-opus-5-5`, `bedrock.region:` | `AWS_*` credentials |

Then `docker compose up -d cortex memory salience affect` (salience and affect load
`llm.*` and the hooks too; the reflection pass uses the same chat model). Full recipes per provider: [`examples/providers/`](examples/providers/).
`llm.claude.*` tunes the Claude paths: `effort` (thinking depth; `low` suits
one-line replies), a roomier `max_tokens` because thinking and the reply share
it, and `fallbacks`, which retries on another Claude model if a safety
classifier declines (Claude API only; on Bedrock a decline just means it says
nothing that turn).

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

No virtual audio cables: add an OBS **Browser Source** with *Control audio via OBS*
ticked. On the same PC as the dashboard use `http://localhost:3000/?sink=1` (the
`DASHBOARD_PORT`); from a second PC use `http://<ai-pc>:3001/?sink=1` (the
`DASHBOARD_LAN_PORT`, a listener that serves only the sink page, audio and test
uploads, never the controls). The page plays every utterance and
reports playback to the bus so the avatar lip-syncs in time. For the avatar
itself, capture the VTS/VRM window (same PC) or send it over NDI (second PC).

## Two-PC setup

Everything in this repo runs on the AI box. The gaming PC only needs:

- OBS with the WebSocket server enabled and reachable on LAN (`OBS_HOST=<gaming-pc-ip>`)
- the avatar app, *or* run it on the AI box and send it to OBS with NDI

## Service health

Every service publishes a `service.heartbeat` on a separate capped stream
(`cohost:health`, so it never crowds out the event feed): `starting` at boot,
`ready` once serving, `degraded` when a dependency is down, `stopping` on
shutdown, and a repeat every `HEARTBEAT_INTERVAL_MS` (default `5000`, set it in
`.env`). The dashboard's **services** tab (and `GET /services`) shows each
service as `up`, `degraded`, `stale` (no heartbeat for 3 intervals), `down`
(silent for 10 intervals or stopped), `crash-looping` (3 restarts in 60 s) or
`unknown` (never seen), with its mode (`live`, `mock`, `off`) and dependencies.
`docker compose ps` reflects the same signal: each app container's healthcheck
passes only while its heartbeat is fresh.

## Running one service on its own (isolated)

Every service can run with only Redis: no accounts, GPU or API keys. Each backend
has an opt-in preset env var (wired into `config/config.example.yaml` as
`${VAR:-default}`, so nobody edits `config.yaml`; copy a fresh example if yours
predates them). Defaults are unchanged: with none set you get the live backends.
A service on a mock/off backend logs a warning at startup and reports heartbeat
mode `mock` or `off`; a missing config value (no `TWITCH_CHANNEL`, no
`DISCORD_TOKEN`) idles as `degraded` instead of exiting.

| Service | Preset | Result (mode) |
|---|---|---|
| cortex (and the salience/affect/notes hooks that inherit it) | `LLM_PROVIDER=mock` | deterministic echo replies, hash embeddings (`mock`) |
| memory | `MEMORY_STORE=memory MEMORY_EMBEDDER=hash` | in-process store, lost on exit (`mock`) |
| voice | `VOICE_ENGINE=stub` | silent WAV, 60 ms per character (min 400 ms), no TTS call (`mock`) |
| chat | `CHAT_SOURCE=fake` | scripted or stdin messages, no Twitch (`mock`) |
| eyes | `VISION_ENABLED=false` (default) | idles, never touches OBS (`off`); injected images are still described |
| eyes | `VISION_ENGINE=stub` | fixed description, no vision model (`mock`); with `VISION_ENABLED=true` it still needs OBS |
| ears | `EARS_SOURCE=off` | idles, no Discord client (`off`); injected audio is still transcribed |
| ears | `EARS_SOURCE=http` | listens on `ears.http` (default `127.0.0.1:8765`) for `POST /audio` WAV or 16-bit PCM clips; no Discord account |
| ears | `EARS_SOURCE=dir` | hears `.wav` files dropped in `ears.dir.path`, then renames them `.done`; no Discord account |
| ears | `EARS_STT_ENGINE=stub` | fixed transcript, no `stt` server (`mock`) |
| mouth | `MOUTH_DISCORD_ENABLED=false` | idles, plays nothing (`off`) |
| mouth | `MOUTH_DRYRUN_ENABLED=true` | the `dryrun` output accepts every line and plays nothing (`mock`) |
| avatar | `AVATAR_DRIVER=null` | no app needed |
| salience, affect, dashboard | none | already Redis-only |

Smoke run (cortex answering with the mock model; cortex needs salience and affect
alongside it, memory is optional because cortex answers without recall after
`brain.cortex.recall_timeout_ms`):

```bash
docker compose up -d redis
pnpm install && pnpm build
export REDIS_URL=redis://localhost:6379
LLM_PROVIDER=mock pnpm --filter @cohost/cortex exec tsx src/index.ts &
pnpm --filter @cohost/salience exec tsx src/index.ts &
pnpm --filter @cohost/affect exec tsx src/index.ts &
CHAT_SOURCE=fake pnpm --filter @cohost/chat exec tsx src/index.ts &   # or type lines into its stdin
VOICE_ENGINE=stub pnpm --filter @cohost/voice exec tsx src/index.ts &
```

Watch the **services** tab (or `GET /services`) for `mock` modes, and
`brain.say` / `voice.utterance` on the event feed. In-memory data is gone when the
process exits.

## Starting and stopping services (service control)

The host-run dashboard has stack and service controls on by default (`CONTROL_ENABLED=1`
in `.env.example`): **Launch**, **Stop**, **restart all**, and per-service Start / Stop /
Restart buttons (each asks for confirmation); `cohostctl` offers the same from a shell.
The dashboard and `cohostctl` share a lock file (`data/control.lock`): while one runs a stack or
service action, the other refuses with `busy: <action> held by <who> (pid N)` (HTTP 409 from the
dashboard, exit 1 from `cohostctl`); a lock left by a crashed process is cleared automatically.
Startup fails if `CONTROL_ENABLED=1` has no `CONTROL_TOKEN`.

```bash
pnpm dashboard     # tsc -b services/dashboard, then runs it on the host; it drives Compose with the docker CLI
```

| Env | Meaning |
|---|---|
| `CONTROL_ENABLED=1` | turns the routes on; otherwise `POST /services/:id/*` is 404 |
| `CONTROL_TOKEN` | bearer token, required on `POST /services/:id/start\|stop\|restart`, `POST /control` and `PUT /personality` while enabled (the UI prompts once per tab) |
| `DASHBOARD_HOST` | where the full surface listens; `127.0.0.1` by default (`CONTROL_BIND` is the older name). A non-loopback value needs `CONTROL_ENABLED=1` with a token and logs a warning: the token is sent in cleartext HTTP, front it with a reverse proxy or SSH tunnel |
| `DASHBOARD_LAN_PORT` | the second listener (default 3001, all interfaces): sink page and audio only |
| `COHOST_DOCKER_BIN` | the docker executable to run; unset uses `docker`, else `docker.exe` (WSL2 without Docker Desktop's integration) |
| `CONTROL_ADVANCED=1` | also allow `redis` and `postgres` (otherwise 403). The dashboard can never stop itself (409) |

Only service ids in the manifest (`packages/control/src/manifest.ts`) are accepted
and argv is built from it alone, with no shell. Body `{"mode":"resume"|"fresh","isolated":true}`:
`fresh` stops the service, runs `XGROUP SETID cohost:events <group> $` for each of its
consumer groups, then starts it (default for salience, affect, cortex, voice, avatar;
memory resumes). `isolated` starts it with the isolation presets from the previous
section. Every attempt is published as `service.lifecycle {service, action, by, ok, detail?}`.
`POST /control` also takes `pause` / `resume` and an optional `target`
(`{"cmd":"pause","target":"affect"}`), which idles salience, affect or cortex in place.

```bash
curl -X POST -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"fresh","isolated":true}' http://127.0.0.1:3000/services/cortex/restart
pnpm cohostctl status
pnpm cohostctl restart cortex --mode fresh
```

Tidy the viewer notes after shutting the AI down (optional; the memory service
also catches up at its next start, so skipping it loses nothing):

```bash
docker compose run --rm consolidate                          # the one-shot, any shutdown route
pnpm cohostctl consolidate     # the same through cohostctl (exit 0 ok, 1 failed)
```

`consolidate` is in the `tools` profile, so a plain `docker compose up -d` never
starts it. It starts `postgres` and `ollama` if they are down and leaves them running.

Changing the embedder to one with another vector size (for example `nomic-embed-text` to
`mxbai-embed-large`) makes the memory service refuse to start, because the stored vectors no longer
fit. Stop memory, then re-embed every stored row (memories, viewer notes and deletion records) in place:

```bash
docker compose run --rm reembed                              # the one-shot (profile tools)
pnpm cohostctl reembed         # the same through cohostctl (exit 0 ok, 1 failed)
```

An interrupted run changes nothing and a rerun resumes where it stopped.

The dashboard runs on the host so it needs no privilege beyond your own `docker` access;
no container gets the Docker socket. Compose is the only
runtime; the control plane never starts host processes (run services directly with `pnpm dev`).

## Viewer notes (Viewers tab)

The co-host keeps short, fading notes about viewers. The dashboard's **viewers** tab
lists every viewer and every stored note (core and recent, with a strength bar), lets
you delete a note (with an optional reason: a reason stops the co-host re-learning
similar notes), undo a deletion, clear all of a viewer's notes, and mark someone as a
regular, even before they have chatted. Notes never travel on the `/ws` feed; the tab
reads them through `/viewers` routes that always need a token, whatever
`CONTROL_ENABLED` says:

| Env | Meaning |
|---|---|
| `VIEWERS_TOKEN` | bearer token required on every `/viewers` route (the page prompts once per tab). Unset or empty: the tab is locked and every `/viewers` route answers 403. Put it in `.env`; Compose passes it to the dashboard. Env only, never `config.yaml`. |

```bash
echo "VIEWERS_TOKEN=$(openssl rand -hex 24)" >> .env   # then restart the dashboard
```

The token travels in cleartext over plain HTTP like `CONTROL_TOKEN`, so keep the
dashboard on a trusted LAN or behind a reverse proxy.

## Developing

```bash
docker compose up -d redis postgres ollama tts stt   # infra only
pnpm install
pnpm dev                                              # every service with tsx watch
```

| script | does |
|---|---|
| `pnpm build` / `pnpm typecheck` (`pnpm lint` is the same check) | `tsc -b`, with and without emitting |
| `pnpm test` | build, then every `test/*.test.ts` under `packages/*` and `services/*` (Node's runner via `tsx`) |
| `pnpm test:only` | the same without the build |
| `pnpm dashboard` | build and run the host dashboard |
| `pnpm dev` | every service with `tsx watch` (infra from Compose) |
| `pnpm reflect` / `pnpm consolidate` / `pnpm reembed` | the memory one-shots on the host (Compose and `cohostctl` run the same code, see above) |
| `pnpm docs:dev` / `docs:build` / `docs:preview` | the VitePress site built from `docs/` and this README |
| `pnpm clean` | remove every `dist/` |
| `node scripts/lid-check.mjs` | the linked-intent check CI runs: every `@spec` ID exists, every ID is defined once |

`pnpm test` skips the bus round-trip tests, each marked `(needs Redis)`, unless a Redis answers on `REDIS_URL`.

Testing one piece at a time (single services, fake bus events, stub TTS/LLM, what needs a GPU): [`docs/TESTING.md`](docs/TESTING.md).

`.env` is loaded automatically in the dev loop. Each service is one `src/index.ts`
with a `Bus` from `@cohost/bus`; event types and payloads are in
`packages/bus/src/events.ts` (zod). Adding a YouTube chat source, a second TTS
engine, or a new avatar driver never touches the brain regions. Adding a region
is the same move in reverse: a new service that subscribes to what it needs and
publishes a new event type.

## Status

All services are built, type-checked and covered by unit and glue tests; the loop
`chat → salience → cortex → voice → avatar → dashboard` runs end to end in mock mode, and
every service can boot alone with only Redis (each external dependency has a mock backend).

| piece | state |
|---|---|
| brain (salience, affect, memory, cortex), voice, avatar (null driver), dashboard, control plane | built and exercised against the stub voice, mock LLM and in-process memory; the real Ollama, Kokoro and Postgres containers were run on a CPU box |
| `mouth` (speaks in Discord on her own bot) | built, with a stuck-playback guard, a spoken fallback line and a test-only `dryrun` output; never run against a real Discord server |
| `ears` (listens in Discord on its own bot) | built; the Discord receive path and the native voice dependencies (`libsodium-wrappers`, `@snazzah/davey`, `opusscript`) are unverified against real Discord |
| `eyes` (OBS vision) | built; the OBS WebSocket path has not been run against a real OBS, and the vision model needs a GPU for good latency |
| `chat` (Twitch) | built; anonymous read-only chat was run against Twitch, the authenticated path and token refresh persistence were not |
| avatar drivers | VMC was run against a UDP listener; VTube Studio only against a fake socket, so expect to tune parameter names on first contact |
| Compose and installer | read and parsed; a Docker-gated end-to-end Launch test runs in CI, the full real stack awaits the single-PC checklist |

What is left is a first run with real accounts and apps: Discord (two bots), Twitch, OBS and VTube Studio.
The hands-on list, with what to look for at each step, is the
[single-PC WSL2 checklist](docs/TESTING.md#single-pc-wsl2-with-docker-desktop); the
[OBS requirements](docs/TESTING.md#obs-requirements) and
[two-bot Discord setup](docs/TESTING.md#two-bot-discord-setup) are in [`docs/TESTING.md`](docs/TESTING.md).

## License

cohost is dual licensed. Copyright © CoderCoco.

- To the public under the [GNU Affero General Public License v3.0](LICENSE)
  (`AGPL-3.0-only`). The AGPL permits commercial use, including running
  cohost as a service. If remote users interact with your modified version,
  you must offer them its source (section 13); if you distribute it, sections
  4-6 apply. Running a modified copy privately obliges nothing.
- Under a separate commercial licence from CoderCoco, for uses the AGPL does
  not allow, such as a closed-source product or a hosted fork whose source you do not offer to its users.
  See [Commercial licensing](COMMERCIAL.md).

Contributions are accepted under AGPL-3.0-only from contributors who have
signed the [Contributor License Agreement](CLA.md); see
[Contributing](CONTRIBUTING.md).
