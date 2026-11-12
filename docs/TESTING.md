# Testing the co-host piece by piece

A hands-on guide: run the whole suite, one package, one service on its own,
push fake events onto the bus and watch what comes out, and know which
services need a GPU or an outside account (and what to use instead).

Every command here was run against this repo unless marked **(not verified)**.
Known gaps and breakage are collected in [Known problems](#known-problems).

All commands run from the repo root.

## 1. Prerequisites

| need | version | why |
| ---- | ------- | --- |
| Node | ≥ 22 (tested on 24) | `engines` in `package.json`; built-in `node:test` |
| pnpm | 10 (`packageManager` pins 10.0.0; corepack fetches it) | workspace install |
| Redis | 6.2+ reachable at `redis://127.0.0.1:6379` | the bus. Needed for everything except the unit tests |
| Docker | any recent | easiest way to get Redis (and the real infra later) |
| Python 3 | any | only for `examples/modules/server.py` |

No GPU, Twitch, Discord, OBS or avatar app is needed for anything in this guide: every external dependency has a mock
backend (the presets in [§4](#4-run-one-service-in-isolation)), and §7 lists every way to put an input on the bus by hand.

```bash
pnpm install
cp .env.example .env     # required before running any service, see below
```

`.env` is git-ignored. Services refuse to start without it: `config.yaml`
interpolates `${LLM_MODEL}`, `${AVATAR_DRIVER}` etc., and with those empty
config validation fails (`llm.model: String must contain at least 1
character(s)` …). The defaults in `.env.example` are fine for local testing
(`AVATAR_DRIVER=null`). The first service you start also copies
`config/*.example.*` to `config/config.yaml`, `personality.md` and
`expressions.yaml` (all git-ignored).

### Redis

```bash
docker compose up -d redis      # verified: Redis 7.4, healthy, 127.0.0.1:6379
```

Compose binds it to `127.0.0.1:6379`, which is what the services default to.
No Docker? Any Redis ≥ 6.2 on that port works. This guide was verified against
Redis 6.2 from `pip install redislite` (`<venv>/bin/redis-server --port 6379 --save ""`).

Check it: `docker compose exec redis redis-cli ping` → `PONG` (verified).

The bus is one Redis Stream, `cohost:events`. It survives between runs, so
old events reappear in `bus-tail --replay`. Reset it with
`docker compose exec redis redis-cli DEL cohost:events` (verified) (or restart a throwaway Redis).

## 2. Run the whole suite

```bash
pnpm test            # tsc -b, then every test under packages/*/test and services/*/test
pnpm test:only       # same, without the build step (faster once built)
pnpm typecheck       # tsc -b --noEmit
```

With Redis up (both the compose Redis 7.4 and a standalone 6.2) every test
passes and none is skipped. Without Redis the bus round-trip tests in
`packages/bus/test/bus.test.ts`, each marked `(needs Redis)`, are skipped. A run
with skips is not a full pass.

Everything else is mocked: region logic is tested against `FakeBus` (see §6),
HTTP backends against local stub servers, so the suite needs no network.

## 3. Run one package or one service's tests

There are no per-package `test` scripts; call Node's runner directly. Each
package/service keeps tests in its own `test/` folder:

```bash
node --import tsx --test services/salience/test/*.test.ts       # one service
node --import tsx --test packages/bus/test/*.test.ts            # one package (its round-trip tests need Redis)
node --import tsx --test services/voice/test/wav.test.ts        # one file
node --import tsx --test --test-name-pattern="mention" services/salience/test/*.test.ts   # by test name
```

Tests import sources through `tsx`, so no build is needed for these.
(`pnpm test` runs `tsc -b` first, which is what catches type errors.)

| area | test files |
| ---- | ---------- |
| `packages/bus`, `config`, `llm`, `modules`, `working-memory` | `packages/*/test/` |
| `services/salience`, `affect`, `cortex`, `memory` | the brain regions; `*.region.test.ts` use `FakeBus` |
| `services/voice` | TTS client, WAV parser, envelope, HTTP endpoint, virtual sink |
| `services/avatar` | engine smoothing/idle, drivers (VTS, VMC) against fake sockets |
| `services/ears`, `mouth`, `eyes`, `chat` | transcription/describer logic with fake backends, the connector source and sink against a fake bus, chat filter |
| `packages/shared`, `control` | the shared runtime (bootstrap, lifecycle, idle plan, inject handler, Discord session), the manifest and stack controller |
| `services/dashboard` | HTTP routes, live feed, page script (stub DOM in `node:vm`) |

## 4. Run one service in isolation

Run a service with `node --import tsx` from the **workspace root** (the
entry-point path below is relative to the working directory) or through
`pnpm dev` / `pnpm --filter <svc> dev`:

```bash
node --import tsx services/salience/src/index.ts
```

Config is read from the `config/` directory at the workspace root (the nearest
ancestor directory holding `pnpm-workspace.yaml`), so config lookup does not
depend on the working directory. `.env` is read from the parent of the config
directory: the workspace root by default, but the parent of `CONFIG_DIR` when
that overrides the config directory.
Set `LOG_LEVEL=debug` for more. Stop with ctrl-c.

What each service needs to come up, and what it does if that is missing
(all of these were started with only Redis available):

| service | needs | behaviour with nothing else running |
| ------- | ----- | ------------------------------------ |
| `salience` | Redis | works fully (rules scorer) |
| `affect` | Redis | works fully (rules appraiser) |
| `avatar` | Redis | works with `AVATAR_DRIVER=null`; publishes `avatar.state` at 5 Hz |
| `dashboard` | nothing (host process) | works with Redis down; http://localhost:3000. Audio needs `voice` (`VOICE_URL`, default `http://127.0.0.1:8700`, published by Compose) |
| `voice` | Redis + a TTS server at `TTS_URL` (default `:8880`) | starts; each `brain.say` logs a synth failure and still emits `voice.done`. Use the stub TTS (§5) |
| `cortex` | Redis + a chat model (Ollama by default) | starts, logs `waiting for the model backend` every 3 s until Ollama answers. Use the stub LLM (§5) |
| `memory` | Redis + Ollama (embeddings) + Postgres | logs `waiting for ollama (embeddings)...` forever; **cannot be stubbed** with `stub-llm` (no `/api/embed`). Bring up the real `postgres` + `ollama` (§5b) or leave it out. `cortex` copes without it (see below) |
| `chat` | `TWITCH_CHANNEL` | idles as `degraded` without it (`deps.twitch: down`) instead of exiting, and still accepts injected chat. With only a channel it reads anonymous IRC (**not verified**, needs the internet) |
| `eyes` | OBS + a vision model | idles as `off` with `VISION_ENABLED=false` (default); injected images are still described, by the stub with `VISION_ENGINE=stub`. With `VISION_ENABLED=true` it needs OBS (see [OBS requirements](#obs-requirements)) and waits `degraded` until it answers |
| `ears` | Discord connector (`DISCORD_TOKEN`, profile `discord`) + STT | holds no Discord client; with no connector present `deps.discord` is `down` and it still accepts injected audio; `EARS_SOURCE=off` idles as `off`; `EARS_SOURCE=http` (`curl --data-binary @clip.wav -H 'Content-Type: audio/wav' http://127.0.0.1:8765/audio`) and `EARS_SOURCE=dir` (drop a `.wav` in `ears.dir.path`) feed clips through the live path with no Discord account; `EARS_STT_ENGINE=stub` answers every clip with a fixed transcript and needs no `stt` server. See §5 |
| `mouth` | Redis (and `voice` for audio) | `MOUTH_DISCORD_ENABLED=false` idles as `off`; with no connector the `discord` output is not ready; `MOUTH_DRYRUN_ENABLED=true` adds the `dryrun` output that accepts every `voice.utterance` and plays nothing (mode `mock`), so the whole speaking path above Discord runs |

`cortex` without `memory` still replies: it waits `brain.cortex.recall_timeout_ms`
for `memory.recall.reply`, logs `memory region did not answer in time`, and
answers without memories.

## 5. Services that need hardware or outside accounts

| service | external dependency | GPU? | substitute for testing |
| ------- | ------------------- | ---- | ---------------------- |
| `voice` | Kokoro TTS container (`tts`) | optional (CPU image exists) | `scripts/dev/stub-tts.ts` |
| `cortex`, `salience`/`affect` `llm` hooks, `memory` reflect | Ollama / OpenAI-compatible / Claude | yes for Ollama | `scripts/dev/stub-llm.ts`, or `llm.provider: openai` pointed at any local server |
| `memory` | Ollama `nomic-embed-text` + Postgres (pgvector) | embeddings are light | none; run the real containers (§5b, verified) |
| `eyes` | OBS WebSocket + Ollama vision model | yes | `VISION_ENGINE=stub` (fixed description) and inject an image from the dashboard, or publish `vision.summary` by hand (§7). Leave `vision.enabled: false` unless OBS is up |
| `ears` | Discord listening bot + STT container (faster-whisper) | STT is GPU-friendly | `EARS_STT_ENGINE=stub` and inject audio from the dashboard, or publish `speech.heard` by hand (§7). Its logic is unit tested with fake transcribers and a faked Discord session |
| `mouth` | the Discord connector's sink (the one bot, see [One-bot Discord setup](#5d-one-bot-discord-setup)) + `voice` | no | `MOUTH_DRYRUN_ENABLED=true` (the `dryrun` output) with `MOUTH_DISCORD_ENABLED=false`; the dashboard's `?sink=1` page is a second, independent sink. Its logic is unit tested with a faked Discord session |
| `chat` | Twitch IRC | no | publish `chat.message` by hand (§7) |
| `avatar` | VTube Studio or a VMC receiver | no (the app renders) | `AVATAR_DRIVER=null` (default in `.env.example`); the driver unit tests use fake sockets |

The pattern: each outside-world service is just a publisher/subscriber of
bus events, so to test everything downstream of it, publish the event it
would have produced. To test the service itself, rely on its unit tests; the
network/hardware edge is the only part not covered.

### Null / stub backends

* **Avatar:** `AVATAR_DRIVER=null` (in `.env`). Runs the full engine
  (smoothing, idle motion, lip-sync from `voice.utterance`) and publishes
  `avatar.state`; just doesn't talk to any app. Verified.
* **TTS:** `node --import tsx scripts/dev/stub-tts.ts` serves
  `POST /v1/audio/speech` on `:8880` (override with `STUB_TTS_PORT`) and returns
  a pulsing-tone WAV ~65 ms per character, so the lip-sync envelope moves.
  Then run `voice` (outside compose `VOICE_URL` defaults to
  `http://127.0.0.1:8700`, which ends up in `voice.utterance.audioUrl`;
  compose sets `http://voice:8700`). Verified: `brain.say` → `voice.utterance` →
  `voice.playing` / `voice.done` (sink `virtual`), `GET /audio/<id>.wav` → 200.
* **LLM:** `node --import tsx scripts/dev/stub-llm.ts` impersonates Ollama on
  `:11434` (`/api/tags`, `/api/chat`) and replies `Stub brain here. You said: …`
  (the echo is the tail of the prompt, so it is not a good-looking reply; it is
  proof the loop closes). Verified with `cortex`.
* **Hooks without a model:** `kind: rules` is the default. To exercise the
  `http` hook kind run `python3 examples/modules/server.py` (stdlib only, `:8900`) and
  point `brain.*.module.url` at it. Verified the server answers:

  ```bash
  curl -s -XPOST localhost:8900/salience -d '{"events":[{"kind":"chat","text":"hey Coco?","mention":true}],"arousal":0.2}'
  # {"scores": [1.0]}
  curl -s -XPOST localhost:8900/affect -d '{"source":"chat","who":"a","text":"this is awesome!","mention":false,"valence":0,"arousal":0}'
  # {"valence_delta": 0.0, "arousal_delta": 0.05}
  curl -s -XPOST localhost:8900/critic -d '{"text":"hello","emotion":"happy","reason":"x","transcript":""}'
  # {"ok": true}
  ```

  Wiring it into a running region through `config.yaml` was **not** exercised;
  the `Module` fallback/timeout logic is covered by `packages/modules/test`.

### 5b. Real infra containers, CPU only

Verified; about 1 GB of images plus two small models:

```bash
docker compose up -d redis postgres ollama tts stt     # CPU images (base compose file only)
docker compose ps                                       # postgres/redis report (healthy)
curl -s localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'        # embeddings, 768-dim
curl -s localhost:11434/api/pull -d '{"name":"qwen2.5:0.5b-instruct"}'  # tiny chat model: fast, silly replies
curl -s localhost:8880/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"Hello there","voice":"af_heart","response_format":"wav"}' -o hello.wav   # 200, a WAV
curl -s -o /dev/null -w '%{http_code}\n' localhost:8000/health                                              # 200
```

Then run the services on the host against them (env vars set in the shell
override `.env`):

```bash
export VOICE_URL=http://127.0.0.1:8700 LLM_MODEL=qwen2.5:0.5b-instruct
for s in salience affect memory cortex voice avatar; do node --import tsx services/$s/src/index.ts & done
```

`memory` logs `memory ready` (`dims: 768`) and creates `memories`, `viewers`
and `meta` tables in Postgres. Publishing the Recipe B chat message then gave
a real reply (~1.6 s on the 0.5B model), real Kokoro audio (`voice.utterance`,
5 s), a `memory.viewer` for the new user and an on-time, empty
`memory.recall.reply`. Afterwards
`docker compose exec postgres psql -U cohost -c 'select kind, who, text from memories'`
shows the chat line (`chat`) and the reply (`self`). The 0.5B model is only
for plumbing; use the `LLM_MODEL` from `.env.example` for real quality. The
stub TTS and LLM scripts are not needed in this setup.

Stop everything: `docker compose down` (add `-v` to also drop the Postgres and model volumes).

**Stopping background `node --import tsx …` jobs:** `kill $!` can leave the
tsx child running and holding the port (a stale stub-llm on `:11434` made the
real Ollama pull return `{"error":"not stubbed"}` while writing this). Stop
them with `pkill -f "scripts/dev/"` and `pkill -f "services/.*/src/index.ts"`
typed on their own, then check `ss -ltn`.

### 5c. The services in Docker, GPU overlay, STT, Twitch, VMC

Also verified on the same machine:

* **STT with real audio:** TTS → STT round trip. Download a model into speaches
  once, then transcribe the Kokoro WAV from §5b (same endpoint `ears` uses):

  ```bash
  curl -s -XPOST localhost:8000/v1/models/Systran/faster-whisper-tiny.en     # "downloaded", ~75 MB
  curl -s localhost:8000/v1/audio/transcriptions -F file=@hello.wav -F model=Systran/faster-whisper-tiny.en
  # {"text":"Hello there."}
  ```
  (The default `STT_MODEL` in `.env.example` is `Systran/faster-whisper-small`.)
* **GPU overlay:** `docker run --rm --gpus all ubuntu nvidia-smi -L` sees the card;
  `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d ollama`
  starts with an NVIDIA device request and `ollama ps` reports `100% GPU`.
  The `tts` GPU image was not pulled.
* **Twitch (anonymous, read-only):** `TWITCH_CHANNEL=xqc node --import tsx services/chat/src/index.ts`
  logs `connected to twitch chat` (`authenticated: false`) and publishes real
  `chat.message` events within seconds (pick a busy channel; a quiet one
  just stays quiet). Posting back and the authenticated path were not tested.
* **VMC avatar driver:** `AVATAR_DRIVER=vmc VMC_HOST=127.0.0.1 node --import tsx services/avatar/src/index.ts`
  with a UDP listener on `:39539` received `/VMC/Ext/Blend/Val`, `/Blend/Apply`,
  `/Bone/Pos` and `/OK` packets after a `brain.say`. It's fire-and-forget UDP,
  so it never reports "connected".
* **The services as containers:** `docker compose build` succeeds for all of them
  and the images start (`scripts/compose-smoke.sh` guards that in CI; the
  Dockerfile deliberately does not `pnpm prune --prod`).
  `docker compose up -d redis postgres ollama tts stt salience affect memory cortex voice avatar`
  runs all of them (the dashboard is not a Compose service: start it on the host with
  `pnpm dashboard`). A chat message published with `bus-pub` then went
  salience → cortex → real Ollama → real Kokoro → `voice.done`, and
  `http://localhost:3000/audio/<id>.wav` (host dashboard → voice on `127.0.0.1:8700`) returned the WAV.
  Compose sets `VOICE_URL=http://voice:8700` for the containers itself.
  `chat` was left out: it exits without `TWITCH_CHANNEL` and compose restarts it forever.

### 5d. One-bot Discord setup

One Discord connector holds the bot's login and voice connection; ears (hearing) and mouth (speaking) take audio from it and to it over Redis and hold no Discord client, so any of the three can run, restart or be tested without the others.
This is the setup to verify on the first real Discord run; nothing here can be checked without a guild.

| | Discord connector |
|---|---|
| token in `.env` | `DISCORD_TOKEN` (the only Discord token) |
| bot permissions in the voice channel | Connect, Speak |
| privileged intents | Server Members |
| Compose profile | `discord` (beside `ears` and `mouth`) |
| idles without its token | `degraded`, registers nothing |

Also set `DISCORD_GUILD_ID` and `DISCORD_VOICE_CHANNEL_ID` in `.env` (they reach `connections.discord.*`), and `COMPOSE_PROFILES=discord,ears,mouth` keeps the profiles on across Launch.
Checks, in order:

1. Start only `ears` with no connector: `deps.discord` is `down` (`discord connector not connected`) and injected audio still works. Start the connector: `deps.discord` returns to `ok` without restarting ears.
2. With the connector joined, undeafened and unmuted, speak in the channel: `speech.heard` appears on the feed with your display name and `source` `discord`. This is where the native voice dependencies (`libsodium-wrappers`, `@snazzah/davey`, `opusscript`) are confirmed or found missing.
3. Start `mouth`, send a chat line, hear the reply in the channel. Then stop `voice` and send another: mouth plays its cached fallback line, at most once per `mouth.fallback.min_interval_ms`.
4. The co-host's own voice never becomes `speech.heard` (the connector reads no bot account).
5. Disable the output (`mouth.outputs.discord.enabled: false` in the Settings tab, restart `mouth`): it idles `off` and plays nothing. Kill and restart the connector: it rejoins and both halves resume.
6. Several sources: set `ears.sources: [discord, http]`, post a clip to `http://127.0.0.1:8765/audio`, and see `speech.heard` with `source` `http`; stop the connector and see only `deps.discord` go `down`.

### OBS requirements

Needed only by `eyes` with `vision.enabled: true`, and for the stream itself; every other service ignores OBS.

- OBS 28 or newer (obs-websocket v5 is built in). Tools > WebSocket Server Settings: enable the server, port 4455 (`OBS_PORT`), and set a password (`OBS_PASSWORD`).
- A source named exactly as `OBS_SOURCE` (default `Game Capture`) that can produce a screenshot (`GetSourceScreenshot`).
- Reachable from the `eyes` container: `OBS_HOST=host.docker.internal` for OBS on the same Windows machine as Docker Desktop, the gaming PC's LAN address for two PCs (obs-websocket must listen on the LAN and the firewall must allow 4455).
- A vision model pulled into Ollama (`VISION_MODEL`); `vision.engine: stub` replaces it with fixed text.
- For her voice on stream: a Browser Source with *Control audio via OBS* pointing at the dashboard sink page (`http://localhost:3000/?sink=1`, or `http://<ai-pc>:3001/?sink=1` from a second PC).

Checks: with OBS closed, `eyes` is `degraded` with `obs: down` and keeps retrying (10 s doubling to 60 s); start OBS and it connects without a restart and `vision.summary` events appear when the screen changes; restart OBS mid-run and it reconnects; a changed `OBS_PASSWORD` shows `degraded` with the login error in the log.

## 6. Unit-test helpers: `@cohost/testing`

`packages/testing/src/index.ts`, used by every region test:

| helper | what it is |
| ------ | ---------- |
| `testConfig(overrides?)` | a complete, schema-validated `Config`; `cooldown_ms` and `idle_chatter_ms` zeroed so tests don't wait. Overrides deep-merge |
| `FakeBus` | same `publish` validation as the real bus, records instead of using Redis. `.of(type)` → payloads, `.types()`, `.published`, `.clear()`, `.fail` to inject publish errors |
| `event(type, data, source?)` | a `BusEvent` as a subscriber would get it (defaults applied) |
| `silentLog` / `recordingLog()` | no-op logger / logger that keeps `lines` and `msgs(level)` |
| `waitFor(cond, what?, ms?)` | poll until true, for async regions (cortex) |

A complete test using them (verified; put it in `services/salience/test/`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Salience } from "../src/salience.js";
import { createScorer } from "../src/scoring.js";

test("a mention makes salience publish attention.focus", async () => {
  const cfg = testConfig();
  const bus = new FakeBus();
  const s = new Salience({ cfg, bus, scorer: createScorer(cfg, silentLog), log: silentLog });

  await s.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "hey Coco?", mentionsCohost: true }));
  await s.tick();

  assert.equal(bus.of("attention.focus")[0]?.reason, "mentioned");
});
```

Run it with `node --import tsx --test services/salience/test/<file>.test.ts`.
Existing tests in `services/*/test/*.region.test.ts` are the best templates.

## 7. Inject fake events and watch the results

Two helper scripts in `scripts/dev/` (Redis' own `redis-cli XADD` would skip
payload validation and the `type/ts/source/data` field layout, so they exist
on purpose):

```bash
node --import tsx scripts/dev/bus-pub.ts --list                  # event types
node --import tsx scripts/dev/bus-pub.ts <type> '<json payload>' # validate with zod, then XADD
node --import tsx scripts/dev/bus-tail.ts [--replay N] [--json] [type ...]
```

* `bus-tail` is a non-group `XREAD`, so it never steals events from a service's
  consumer group. Long arrays (the voice envelope) print as `[63 items]`.
* A bad payload is rejected before it hits the bus with the zod issue list and exit 1;
  an unknown type exits 2.
* Payload shapes: `packages/bus/src/events.ts`. Fields with defaults can be omitted.

### Recipe A: one region alone

```bash
# terminal 1
node --import tsx services/salience/src/index.ts
# terminal 2
node --import tsx scripts/dev/bus-tail.ts
# terminal 3
node --import tsx scripts/dev/bus-pub.ts chat.message \
  '{"platform":"twitch","user":"viewer","text":"hey Coco what game is this?","mentionsCohost":true}'
```

Terminal 2 shows (verified):

```
dev-pub    chat.message    {"platform":"twitch","user":"viewer","text":"hey Coco what game is this?",...,"mentionsCohost":true}
salience   attention.focus {"reason":"mentioned","score":1,"focus":{"kind":"chat","who":"viewer",...,"mention":true}}
```

Salience subscribes with start `latest`, so start it **before** publishing, and give it
a second or two to connect. `salience` also needs a `tick_ms` to pass before it emits.

### Recipe B: full talking loop, no GPU, no accounts

Everything except `chat`, `memory`, `eyes`, `ears`. Run these in separate terminals or
background them. Verified end to end:

```bash
node --import tsx scripts/dev/stub-tts.ts &
node --import tsx scripts/dev/stub-llm.ts &
export VOICE_URL=http://127.0.0.1:8700
for s in salience affect cortex voice avatar; do node --import tsx services/$s/src/index.ts & done

node --import tsx scripts/dev/bus-tail.ts attention.focus brain.status brain.say voice.utterance voice.playing voice.done affect.state

# in another shell:
node --import tsx scripts/dev/bus-pub.ts chat.message '{"platform":"twitch","user":"viewer","text":"hey Coco what game is this?","mentionsCohost":true}'
```

Observed sequence (~9 s, most of it the stub TTS "speaking"):

```
chat.message → affect.state (mood: happy)
             → attention.focus (mentioned, 1.0)
             → brain.status thinking → brain.say → brain.status speaking
             → voice.utterance → voice.playing (sink virtual) → voice.done → brain.status idle
```

`cortex` logs `memory region did not answer in time` (no `memory` running);
expected. Add `avatar.state` to the tail filter only if you want the 5 Hz stream
(it floods an unfiltered tail).

Add the dashboard (`pnpm dashboard`, then
http://localhost:3000) to watch the same events in a browser. Its controls are
plain HTTP, handy for scripting: `curl -XPOST localhost:3000/control -H 'content-type: application/json' -d '{"cmd":"say","text":"hi"}'` → 204 and a
`control` event on the bus (verified). The dashboard plays audio only after you
click **enable audio** in the page (browser autoplay rules); I did not drive the
UI itself.

### Recipe C: test a downstream service with a hand-made input

Skip the brain and speak directly:

```bash
node --import tsx scripts/dev/bus-pub.ts brain.say '{"id":"t1","text":"Hello chat!","emotion":"happy"}'
```

with `stub-tts`, `voice` and `avatar` running (verified: `voice.utterance` with
envelope, `avatar.state` going `emotion: happy`, `GET /audio/t1.wav` → 200).

Stand-ins for the services you can't run:

```bash
# chat
bus-pub.ts chat.message '{"platform":"twitch","user":"mod1","text":"welcome in!","isMod":true}'
# eyes
bus-pub.ts vision.summary '{"text":"The player falls into lava and dies.","changed":true}'
# ears
bus-pub.ts speech.heard '{"speaker":"Chris","text":"did you see that?","durationMs":1200}'
# operator
bus-pub.ts control '{"cmd":"mute"}'      # also unmute | say (with "text") | forget_context | reload_personality
```

(`bus-pub.ts` = `node --import tsx scripts/dev/bus-pub.ts`.) These payloads
validate; whether salience picks them up depends on its score vs
`brain.salience.speak_threshold` (mention 1.0, voice 0.9, question 0.55, plain chat 0.15).
To force a spoken line without scoring, use a `reflexes` entry in
`config.yaml` (reflexes go straight to `brain.say`), or publish `brain.say`.

### Injection surfaces

Every way to put a test input in front of a service, from the most realistic to the most direct:

| surface | where | runs | needs |
|---|---|---|---|
| Service-level text, image, audio | dashboard test panel, `POST /inject/text` (`level: service`), `/inject/image`, `/inject/audio` | the real path through `chat`, `eyes` or `ears` (`inject.request`, answered by `inject.result`); the dashboard stores the upload in Redis and the service takes it from there | the target service running; a model or STT unless its stub engine is on |
| Bus-level text | `POST /inject/text` with `level: bus` (`as` chat, speech or vision) | publishes `chat.message`, `speech.heard` or `vision.summary` directly with `injected: true`; no `inject.result` | Redis and the dashboard |
| Any bus event | `scripts/dev/bus-pub.ts <type> '<json>'` | zod-validated `XADD`, source `dev-pub` | Redis only |
| Operator controls | `POST /control` (`say`, `mute`, `unmute`, `forget_context`, `reload_personality`, `pause`, `resume` with an optional `target`) | the `control` event | Redis and the dashboard |
| Per-unit test drawer and `POST /inject/event` | the module contract, MOD-TEST-001 to 007 | one declared input per unit, refused when the unit is not running | see those specs for their implementation state |
| Stub backends | `VISION_ENGINE=stub`, `EARS_STT_ENGINE=stub`, `VOICE_ENGINE=stub`, `LLM_PROVIDER=mock`, `CHAT_SOURCE=fake`, `MOUTH_DRYRUN_ENABLED=true` | the service's own code with the external call replaced | nothing external |

Injected events carry `injected: true`, so they are distinguishable on the feed and `remember` (off by default) decides whether memory keeps them.
`brain.say` is a test input only through the unit-scoped route; the dashboard's `say` control is the operator's.

## Single-PC WSL2 with Docker Desktop

Checklist for one machine, no second PC: the dashboard runs in the WSL distro, Docker
Desktop runs the containers, and a Windows browser and OBS are the clients.

1. In the WSL distro: `./scripts/install.sh --no-pull` (or copy `.env.example` to `.env`) and `pnpm dashboard`.
   If `docker` is not on the WSL path (Docker Desktop's WSL integration is off for this
   distro), set `COHOST_DOCKER_BIN=docker.exe` in `.env` first.
2. In a Windows browser open `http://localhost:3000` (WSL forwards localhost). Enter `CONTROL_TOKEN` from `.env` when asked.
3. Press **Launch** and wait for the stack to reach `up`.
4. Load `http://localhost:3001/?sink=1` in a second browser tab, or add it as an OBS Browser
   Source on the same PC, and click enable audio. Send a chat line and hear a reply.
5. Inject an image from the dashboard and see `eyes` answer (`--profile eyes`), then an audio clip and see `ears` answer. Uploads travel over Redis, so nothing on the host needs to be reachable from containers.
6. Real Discord and OBS, once the mock path above is healthy: follow [One-bot Discord setup](#5d-one-bot-discord-setup) and [OBS requirements](#obs-requirements); that is the only place the native voice dependencies and the OBS WebSocket path are verified.
7. Press **Stop**, then run the consolidation pass (`docker compose run --rm consolidate`).

## Known problems

Found while writing this guide.

1. **Unfiltered `bus-tail` is noisy:** `avatar.state` fires 5×/s.
2. **Bus state persists** in Redis between runs (and `salience` etc. use
   start `latest`, but `bus-tail --replay` will show old traffic).
3. **Not verified here:** the `tts` GPU image, `eyes`, `ears` and `mouth` in Docker, the authenticated Twitch path, VTube Studio against the real app (driver unit tests only), the OBS path, Discord (one bot), and `docker compose` behaviours that need a daemon (the launch end-to-end test skips without one and runs in CI). The README's Status section says the same for the
   real integrations; each is a manual verification item in its segment's LLD.
