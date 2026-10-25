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

No GPU, Twitch, Discord, OBS or avatar app is needed for anything in this guide.

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

Verified result with Redis up (both the compose Redis 7.4 and a standalone 6.2): **206 tests, 206 pass, 0 skipped** (~7 s).
Without Redis: 200 pass, **6 skipped**; the skipped ones are the bus round-trip
tests in `packages/bus/test/bus.test.ts`, each marked `(needs Redis)`. A run
with skips is not a full pass.

Everything else is mocked: region logic is tested against `FakeBus` (see §6),
HTTP backends against local stub servers, so the suite needs no network.

## 3. Run one package or one service's tests

There are no per-package `test` scripts; call Node's runner directly. Each
package/service keeps tests in its own `test/` folder:

```bash
node --import tsx --test services/salience/test/*.test.ts       # one service (22 tests)
node --import tsx --test packages/bus/test/*.test.ts            # one package (needs Redis for 6 of 7)
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
| `services/ears`, `eyes`, `chat` | transcription/describer logic with fake backends, chat filter |
| `services/dashboard` | HTTP routes |

## 4. Run one service in isolation

Run a service from the **repo root**, not via `pnpm --filter … dev` (see
[Known problems](#known-problems) #1):

```bash
node --import tsx services/salience/src/index.ts
```

Config is read from `./config` and `./.env` relative to the working directory.
Set `LOG_LEVEL=debug` for more. Stop with ctrl-c.

What each service needs to come up, and what it does if that is missing
(all of these were started with only Redis available):

| service | needs | behaviour with nothing else running |
| ------- | ----- | ------------------------------------ |
| `salience` | Redis | works fully (rules scorer) |
| `affect` | Redis | works fully (rules appraiser) |
| `avatar` | Redis | works with `AVATAR_DRIVER=null`; publishes `avatar.state` at 5 Hz |
| `dashboard` | Redis | works; http://localhost:3000. Audio needs `voice` (`VOICE_URL`) |
| `voice` | Redis + a TTS server at `TTS_URL` (default `:8880`) | starts; each `brain.say` logs a synth failure and still emits `voice.done`. Use the stub TTS (§5) |
| `cortex` | Redis + a chat model (Ollama by default) | starts, logs `waiting for the model backend` every 3 s until Ollama answers. Use the stub LLM (§5) |
| `memory` | Redis + Ollama (embeddings) + Postgres | logs `waiting for ollama (embeddings)...` forever; **cannot be stubbed** with `stub-llm` (no `/api/embed`). Bring up the real `postgres` + `ollama` (§5b) or leave it out. `cortex` copes without it (see below) |
| `chat` | `TWITCH_CHANNEL` | exits 1 without it. With only a channel it reads anonymous IRC (**not verified**, needs the internet) |
| `eyes` | OBS + a vision model | see §5 |
| `ears` | Discord bot token + STT | exits immediately without `DISCORD_TOKEN`. See §5 |

`cortex` without `memory` still replies: it waits `brain.cortex.recall_timeout_ms`
for `memory.recall.reply`, logs `memory region did not answer in time`, and
answers without memories.

## 5. Services that need hardware or outside accounts

| service | external dependency | GPU? | substitute for testing |
| ------- | ------------------- | ---- | ---------------------- |
| `voice` | Kokoro TTS container (`tts`) | optional (CPU image exists) | `scripts/dev/stub-tts.ts` |
| `cortex`, `salience`/`affect` `llm` hooks, `memory` reflect | Ollama / OpenAI-compatible / Claude | yes for Ollama | `scripts/dev/stub-llm.ts`, or `llm.provider: openai` pointed at any local server |
| `memory` | Ollama `nomic-embed-text` + Postgres (pgvector) | embeddings are light | none; run the real containers (§5b, verified) |
| `eyes` | OBS WebSocket + Ollama vision model | yes | publish `vision.summary` by hand (§7). Leave `vision.enabled: false` |
| `ears` | Discord bot + STT container (faster-whisper) | STT is GPU-friendly | publish `speech.heard` by hand (§7). Its logic is unit tested with fake transcribers/players |
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
  Then run `voice` with `VOICE_URL=http://127.0.0.1:8700` (the default
  `http://voice:8700` only resolves inside compose, and it ends up in
  `voice.utterance.audioUrl`). Verified: `brain.say` → `voice.utterance` →
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

Salience subscribes `fromNow`, so start it **before** publishing, and give it
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

Add the dashboard (`node --import tsx services/dashboard/src/index.ts`, then
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

## Known problems

Found while writing this guide. Not fixed here (out of scope: docs and helper scripts only).

1. **`pnpm dev` / `pnpm --filter <svc> dev` can't find the config.** pnpm runs the
   script with the service directory as cwd, and `configDir()` defaults to
   `./config`, so it throws `No …/services/salience/config/config.yaml and no
   …/config.example.yaml to seed it from`. Verified. Workaround: set
   `CONFIG_DIR=$PWD/config` (also makes `.env` load from the repo root), or run
   `node --import tsx services/<svc>/src/index.ts` from the root as in this guide.
   The README's "Developing" section (`pnpm dev`) currently doesn't work as written.
2. **A fresh clone can't start any service without `.env`.** The error is a list
   of empty-string schema failures, not "copy .env.example". `scripts/install.sh` does the copy; manual setup doesn't.
3. **`VOICE_URL` defaults to `http://voice:8700`**, a compose hostname. Outside
   Docker `voice.utterance.audioUrl` and the dashboard's audio proxy point
   nowhere until you set `VOICE_URL=http://127.0.0.1:8700`.
4. **`memory` cannot run without real Ollama *and* Postgres**, and there is no
   in-memory/fake mode (it works fine against the real containers, §5b).
5. **`eyes` with `vision.enabled: false`** still tries to connect to OBS (it
   retries every 10 s) instead of idling quietly; the "eyes idle" warning is misleading.
6. **Unfiltered `bus-tail` is noisy:** `avatar.state` fires 5×/s.
7. **Bus state persists** in Redis between runs (and `salience` etc. use
   `fromNow`, but `bus-tail --replay` will show old traffic).
8. **Not verified here:** the `stt` container beyond `GET /health` (no audio sent), the GPU overlay, the services' own Docker images (`docker compose build`/`up` of `chat`, `salience` …), Twitch IRC, OBS,
   Discord, VTube Studio and VMC against real apps, GPU overlay. The README's
   own Status section says the same for the real integrations.
