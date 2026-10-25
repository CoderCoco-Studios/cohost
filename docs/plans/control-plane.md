# Control plane: one app to monitor and start/stop cohost services

Status: proposal (planning only, no implementation)
Branch: `control-plane-plan`

## 1. Goal

The owner wants **one application** that shows the health of the whole cohost
bot and can start/stop individual services/modules (chat, salience, affect,
memory, cortex, voice, avatar, eyes, ears, dashboard), including running a
single service in isolation for development.

## 2. Findings (as of `95afa19`)

### 2.1 Does anything already do this? No.

`services/dashboard` is a **bus viewer plus a few chat-level controls**, not a
supervisor.

- Stack: `node:http` + `ws`, one static `public/index.html` (vanilla JS, no
  build). Port `PORT` / `cfg.dashboard.port` (3000).
- Routes (`routes.ts`): `GET /`, `/audio/*` (proxy to voice), `GET|PUT
  /personality`, `POST /control`, `POST /sink`, `/health`.
- Bus use: `bus.tail()` (no consumer group) broadcast to WS `/ws`;
  `bus.recent(60)` replayed on connect.
- UI: raw event feed (300 lines), a `brain.status` pill, avatar preview, say
  box, mute, wipe context, personality editor, audio sink (`?sink=1` for OBS).
- Control surface is only the `control` event enum:
  `mute | unmute | say | forget_context | reload_personality`. Nothing about
  service lifecycle or per-service status.

Side note: the UI reads `s.mouthSmile`, which is not in the `avatar.state`
schema (minor existing bug, out of scope).

### 2.2 How services are launched today

| Mode | How | Notes |
|---|---|---|
| Docker Compose | `docker compose up -d` (`docker-compose.yml`, GPU overlay `docker-compose.gpu.yml`) | Shared `x-ts-service` anchor: `restart: unless-stopped`, `.env`, `depends_on redis: service_healthy`. One `Dockerfile`, build-arg `SERVICE`, `CMD exec node services/${SERVICE}/dist/index.js` (SIGTERM reaches node). |
| Compose profiles | `eyes`, `ears` are profile-gated | Everything else starts by default. |
| pnpm dev | root `pnpm dev` = `pnpm -r --parallel --filter './services/*' dev`; single: `pnpm --filter @cohost/<svc> dev` | Each service: `dev` = `tsx watch src/index.ts`, `start` = `node dist/index.js`. No per-service root script. |
| `install.sh` | installs docker/nvidia/pnpm, pulls models, brings up redis + postgres, writes `COMPOSE_FILE` to `.env` | |

Healthchecks: **only redis and postgres have one.** No app service has a
compose healthcheck. Only `voice` and `dashboard` expose HTTP `/health`.

Known ops wart: `chat` (no `TWITCH_CHANNEL`) and `ears` (no `DISCORD_TOKEN`)
exit 1, and `restart: unless-stopped` loops them forever. A control app should
surface that as "crash-looping".

README mismatch: dev loop starts `stt` (`README.md:237`), `install.sh:139`
does not.

### 2.3 What the bus exposes

`packages/bus`: a single Redis stream `cohost:events` (`MAXLEN ~20_000`),
entries `{type, ts, source, data(JSON)}`, zod-validated on publish and decode
(unknown/invalid events are silently dropped). API: `publish`, `subscribe`
(consumer group per service; drains pending then `>`; handler errors are acked
and logged), `tail` (XREAD, no ack), `recent`, `stop`, `onShutdown`.

Event types: `chat.message`, `vision.summary`, `speech.heard`, `brain.say`,
`brain.status`, `attention.focus`, `affect.state`, `memory.recall.request|reply`,
`memory.viewer`, `voice.utterance`, `voice.playing|done`, `avatar.state`,
`control`.

**There is no heartbeat, health, presence, or lifecycle event.** The only
stand-ins:

| Signal | Source | Limit |
|---|---|---|
| `affect.state` re-published at least every 15 s | affect | one service only |
| `brain.status` | cortex | on change only |
| `avatar.state` at 5 Hz with `connected` | avatar | one service; `connected` is driver state |
| HTTP `/health` | voice, dashboard | two services |
| "online" log line | all | not machine-readable |

Untested inference: `XINFO GROUPS/CONSUMERS cohost:events` would give each
service's consumer idle time and pending count with no code change. Only
services that use `subscribe` have a group (not `chat`, `eyes`, `dashboard`).
Idle time is a weak liveness signal (a quiet service idles legitimately).

### 2.4 Per-service summary

| svc | consumes | publishes | external deps | shutdown |
|---|---|---|---|---|
| chat | – | `chat.message` | Twitch IRC | quit + `bus.stop` |
| salience | chat, speech, vision, brain.say/status, affect, control | `brain.say` (reflex), `attention.focus` | none | `bus.stop` |
| affect | chat, speech, vision, brain.say, control | `affect.state` | none | `bus.stop` |
| memory | chat, speech, brain.say; recall requests | `memory.viewer`, `memory.recall.reply` | Ollama (embeddings), Postgres | `bus.stop`, `store.close` |
| cortex | many (see code) | `brain.status`, `memory.recall.request`, `brain.say` | LLM backend | `bus.stop` |
| voice | brain.say, voice.playing | `voice.utterance`, `voice.playing/done` | Kokoro TTS; HTTP 8700 | server close |
| avatar | voice.*, brain.say, affect | `avatar.state` | VTS/VMC optional | driver disconnect |
| eyes | – | `vision.summary` | OBS, Ollama vision | OBS disconnect |
| ears | voice.utterance | `speech.heard`, `voice.playing/done` | Discord, STT | destroy client |
| dashboard | tail | `control`, `voice.playing/done` | none | server close |

The "brain" is four services (salience, affect, memory, cortex), not one.
All handle SIGINT/SIGTERM via `onShutdown`, so graceful stop already works.

### 2.5 Isolated-run support today

Config selects backends via `config.yaml` + env (`${VAR}` substitution).

| Service | Runs with Redis only? |
|---|---|
| salience, affect | yes |
| avatar | yes with `AVATAR_DRIVER=null` (always reports `connected`) |
| dashboard | yes (`/audio` needs voice) |
| voice | stays up; each TTS failure emits `voice.done{sink:"error"}` |
| cortex | **no**: blocks on `llm.ping()`; provider enum has no null/mock |
| memory | **no**: waits for Ollama forever, Postgres gives up after 20 retries |
| chat | **no**: exits 1 without `TWITCH_CHANNEL` |
| eyes | **no**: loops trying OBS even with `vision.enabled=false` |
| ears | **no**: exits 1 without `DISCORD_TOKEN` |

Region hooks (`module.kind` = rules | llm | http) default to `rules` and need
nothing external, so salience/affect/cortex-critic logic is already
dependency-free. Test fakes (`FakeBus`, `testConfig`, ...) live in
`packages/testing` and are test-only. README mentions a "stub TTS" that is
not in the repo.

## 3. Gap analysis

| # | Gap | Needed for |
|---|---|---|
| G1 | No liveness/health contract on the bus | monitoring |
| G2 | No per-service status view (dashboard shows events, not services) | monitoring |
| G3 | No lifecycle control (start/stop/restart one service) | control |
| G4 | Two runtimes (compose containers vs `pnpm dev` processes), no common abstraction | control |
| G5 | No null/mock backends: cortex LLM, memory, TTS, chat, eyes, ears | isolated runs |
| G6 | No app-level compose healthchecks; crash loops are invisible | monitoring |
| G7 | Stop semantics: a stopped service's consumer group keeps accumulating pending entries and replays them on restart (up to `MAXLEN`) | control correctness |
| G8 | A control surface that can stop processes is a privileged endpoint; dashboard `POST /control` currently has no auth | safety |

G7 matters: "stop memory for an hour, start it" would replay an hour of chat
into memory/cortex. Control needs a "start fresh (`fromNow`/reset group)" vs
"resume" choice.

## 4. Design options

All options share the **same bus health contract (section 6)** and the
**same backend work (section 7)**. They differ only in who can start/stop
processes and where the UI lives.

### Option A: Dashboard-embedded supervisor

Extend `services/dashboard` with a `Supervisor` module and a "Services" tab.
Supervisor drives a pluggable `Runtime` adapter: `compose` (shells out to
`docker compose` or talks to the Docker Engine API) and `process` (spawns
`pnpm --filter @cohost/<svc> dev|start`).

- Pros: already the single web app; already has WS fan-out and bus tail; no new
  deployable; OBS/browser-friendly; fits "ONE application".
- Cons: dashboard gains privilege (Docker socket mount or process spawn), so a
  dashboard bug or unauthenticated route becomes remote control of the host;
  the dashboard also has to survive being "stopped" (it must not offer to stop
  itself); in-container dashboard + host-side `pnpm dev` is awkward (needs host
  access).

### Option B: Standalone CLI/TUI (`cohostctl`, new `apps/ctl` or `services/ctl`)

A host-side Node CLI with `status`, `start|stop|restart <svc>`, `logs`, and an
Ink TUI (`cohostctl tui`). Same `Runtime` adapters; reads health from the bus.

- Pros: runs on the host so it can drive both compose and `pnpm dev` without
  mounting the Docker socket into any container; privilege boundary is the
  user's shell; trivial to script; no web attack surface.
- Cons: not a web UI (streamers often want it in a browser/OBS dock); a second
  app next to the dashboard, which fragments the "one app" goal unless the
  dashboard later consumes the same core library; TUI adds a dependency
  (e.g. Ink).

### Option C: Docker-compose API wrapper (small HTTP service + dashboard UI)

A new `services/control` container exposing REST (`GET /services`,
`POST /services/:id/{start,stop,restart}`) that wraps the Docker Engine API
via the mounted socket; dashboard UI calls it.

- Pros: clean API boundary; dashboard stays unprivileged; UI and CLI can both
  be clients.
- Cons: compose-only (no `pnpm dev` story, G4 unsolved); another container
  that mounts `/var/run/docker.sock` (root-equivalent); a service that must
  manage the stack it is part of; most moving parts of the three.

### Trade-off table

| Criterion | A: dashboard-embedded | B: CLI/TUI | C: API wrapper |
|---|---|---|---|
| "ONE app" | best | weakest (alone) | medium |
| Browser/OBS UI | yes | no | yes (via dashboard) |
| Covers compose + `pnpm dev` | yes (adapters, host needed) | yes | compose only |
| Privilege exposure | high unless run on host or gated | lowest | high (socket) |
| New deployables | 0 | 1 (host tool) | 1 (container) |
| Effort | M | M | L |
| Scriptable/headless | via HTTP | best | via HTTP |

## 5. Recommendation

**Option A, built on a UI-agnostic core package, with the privileged part
isolated and off by default.**

1. New package `packages/control` (no UI): `ServiceRegistry` (static manifest
   of services, deps, profiles, isolation presets), `HealthTracker` (folds
   bus heartbeats into per-service state), `Runtime` interface with `compose`
   and `process` adapters.
2. `services/dashboard` embeds `HealthTracker` always (read-only monitoring is
   safe) and enables **lifecycle actions only when `CONTROL_ENABLED=1`**,
   bound to loopback by default, with a bearer token (`CONTROL_TOKEN`) required
   on mutating routes.
3. Recommended deployment: run the dashboard **on the host** (`pnpm --filter
   @cohost/dashboard start`) when control is wanted, so no Docker socket mount
   is needed; the containerised dashboard stays monitor-only. Document the
   socket-mount variant as an explicit opt-in.
4. Because the core is a library, a thin `cohostctl` CLI (Option B) can be
   added later (phase 5) as a second client with no redesign. This gets
   B's scriptability without making it the primary app.

Rationale: the dashboard is already the one place the owner looks; monitoring
(the larger value) needs only bus data and no privilege; control is the risky
half and is gated, loopback-only and host-run by default.

Rejected: C as primary (compose-only, socket-in-container, supervises itself);
B as primary (does not satisfy "one app", no OBS dock).

## 6. Proposed bus events / health contract

Add to `packages/bus/src/events.ts` (zod), following the existing style
(`EventPayloads`, `BusEvent`):

```ts
"service.heartbeat": {
  service: string,            // "cortex", "memory", ...
  instance: string,           // process/container id (hostname-uuid8)
  pid: number,
  version: string,            // package version or git sha
  startedAt: number,          // epoch ms, detects restarts
  state: "starting" | "ready" | "degraded" | "stopping",
  deps: Record<string, "ok" | "down" | "n/a">,  // e.g. { ollama:"down", postgres:"ok" }
  mode: string,               // backend/isolation label: "live" | "null" | "mock"
  detail?: string,
  intervalMs: number          // so the monitor can compute staleness
}
```

Semantics:

- Every service publishes `service.heartbeat` on start (`state: "starting"`),
  when ready (`"ready"`), every `intervalMs` (default 5000), on dependency
  change, and once on graceful shutdown (`"stopping"`).
- **Derived state in `HealthTracker`** (not published): `up` (ready, fresh),
  `degraded`, `stale` (no heartbeat for 3x `intervalMs`), `down` (stopping seen
  or stale past 10x), `unknown` (never seen), `crash-looping` (>=3 distinct
  `startedAt` within 60 s).
- Heartbeats must not flood the feed: `bus.recent`, dashboard feed and
  `memory` must ignore/filter `service.heartbeat`. With ~10 services at 5 s
  this is ~2 events/s against a 20k `MAXLEN`, i.e. ~3 h of history shrinks to
  ~2.5 h; consider a separate capped stream `cohost:health` (`MAXLEN ~1000`)
  to avoid evicting domain events. **Recommendation: separate stream**,
  added as a second constant in `packages/bus` with a `publishHealth`/
  `tailHealth` pair.
- Control commands: extend the `control` enum **only for in-process module
  actions** (e.g. `pause`/`resume` with a `target` field so a service can
  idle without exiting). Process start/stop is *not* a bus event: the bus
  stays unprivileged, and the supervisor acts through the `Runtime` adapter.
  Add `target?: string` to `control` (undefined = all, preserves current
  behaviour).
- Lifecycle audit: supervisor publishes `service.lifecycle`
  `{service, action: "start"|"stop"|"restart", by, ok, detail?}` so the
  dashboard feed shows who stopped what.
- Backwards compatibility: `decode` drops unknown events, so old services
  ignore the new types; a service without heartbeats shows `unknown`, not
  `down`. Fallbacks while rolling out: HTTP `/health` (voice, dashboard) and
  `XINFO CONSUMERS` idle time.

Helper: `packages/bus` gains `startHeartbeat(bus, {service, version, mode,
deps, getState})` returning `{ready(), degraded(), stop()}` so each service
adds ~5 lines. It hooks into the existing `onShutdown`.

## 7. Per-service isolated-run story

Goal: `cohostctl`/dashboard action "run only X (with its minimum
dependencies)" works with no external accounts, GPU or API keys.

### 7.1 Isolation presets

Registry manifest per service: `requires` (hard bus-level deps),
`externals` (non-bus deps), `isolationEnv` (env flipping it to a null/mock
backend), `mode` reported in heartbeat.

| Service | Today | Needed null/mock | Env / config |
|---|---|---|---|
| salience | OK | none | – |
| affect | OK | none | – |
| avatar | OK | none | `AVATAR_DRIVER=null` (exists) |
| dashboard | OK | none | – |
| voice | up but errors per utterance | `voice.engine: stub`: emit silent audio + envelope sized from text | `VOICE_ENGINE=stub` (new) |
| cortex | blocked on `llm.ping()` | `llm.provider: mock`: deterministic canned/echo reply, `ping()` true | `LLM_PROVIDER=mock` (new) |
| memory | blocked on Ollama/Postgres | `memory.store: inmemory` + `embedder: hash` (cheap deterministic embedding) | `MEMORY_STORE=inmemory` (new) |
| chat | exits without channel | `chat.source: fake`: scripted/stdin messages | `CHAT_SOURCE=fake` (new) |
| eyes | loops on OBS | respect `vision.enabled=false` (idle, heartbeat `mode: "off"`); optional `fake` source | fix existing |
| ears | exits without token | `ears.source: off` heartbeat `mode: "off"`, or file-based `speech.heard` injector | `EARS_SOURCE=off` (new) |

Design rules:

- A null/mock backend is a normal provider behind the existing seam
  (`createChatProvider`, avatar driver registry, voice engine) selected by
  config. It must report `mode: "mock"` in the heartbeat so the UI never shows
  a mock service as live. Mock is never the default.
- "Isolated run" must not require editing `config.yaml`: the supervisor passes
  the preset env to the child/container.
- Services that cannot function with Redis alone must **idle and report
  `degraded`/`off` rather than exit or block**, so supervisors don't mask
  crash loops and the dashboard can show why (`deps: {twitch: "down"}`).
- Test fakes stay in `packages/testing`; mock providers are production code
  (small, in the owning package) and reuse the same canned fixtures where
  possible.

### 7.2 Single-service dev recipe (target)

```bash
docker compose up -d redis          # bus only
cohostctl run cortex --isolated     # starts cortex with LLM_PROVIDER=mock
# or from the dashboard: Services tab -> cortex -> "Start (isolated)"
```

Dependent closure: for "isolated" the supervisor starts only the target plus
its `requires` (e.g. cortex + salience + affect) in mock mode, never the
whole stack.

## 8. Stop/start semantics (G7)

- Stop = SIGTERM (compose `stop`, or process signal); service already exits
  cleanly via `onShutdown`.
- Start options: **resume** (keep consumer group; replays backlog) vs **fresh**
  (`XGROUP SETID <group> $` before start). Default for chat-reactive services
  (salience, affect, cortex, voice, avatar) is **fresh**; for memory,
  **resume** (it should not lose history, bounded by `MAXLEN`).
- Supervisor never stops `redis`/`postgres` from the UI by default (stopping
  them takes everything down); infra shown read-only, controllable behind an
  "advanced" flag.
- Dashboard cannot stop itself; the service list marks it `self`.

## 9. Security

- Monitor-only by default; lifecycle behind `CONTROL_ENABLED=1`.
- Mutating routes require `Authorization: Bearer $CONTROL_TOKEN`; refuse to
  enable control without a token set.
- Bind `127.0.0.1` when control is enabled unless `CONTROL_BIND` overrides.
- Only manifest-listed service ids are accepted (no arbitrary commands).
  `process` adapter runs fixed argv, never a shell string.
- Docker socket mount documented as opt-in, with the root-equivalence caveat.
- Existing `POST /control` is unauthenticated; apply the same token gate when
  `CONTROL_ENABLED=1` (call out as a behaviour change).

## 10. Phased task breakdown

Sizes: S <= half day, M ~ 1-2 days, L ~ 3-5 days.

| Phase | Task | Size | Depends |
|---|---|---|---|
| **1. Health contract** | 1.1 Add `service.heartbeat` schema + `cohost:health` stream + `startHeartbeat` helper in `packages/bus`, with tests | M | – |
| | 1.2 Wire heartbeat into all 10 services (`starting/ready/degraded/stopping`, deps) | M | 1.1 |
| | 1.3 Filter heartbeats from dashboard feed/memory; add compose healthchecks for app services (`/health` or heartbeat probe) | S | 1.1 |
| **2. Monitor UI** | 2.1 `packages/control`: `ServiceRegistry` manifest + `HealthTracker` (derived states, crash-loop detection) with tests | M | 1.1 |
| | 2.2 Dashboard: `GET /services` + WS `services` snapshot; "Services" tab (state, uptime, mode, deps, last beat) | M | 2.1 |
| | 2.3 Surface compose restart loops (read `docker compose ps` if available) | S | 2.2 |
| **3. Control** | 3.1 `Runtime` interface + `process` adapter (fixed argv, signal stop) | M | 2.1 |
| | 3.2 `compose` adapter (CLI first; Engine API later if needed) | M | 2.1 |
| | 3.3 Start/stop/restart routes, token auth, loopback bind, `service.lifecycle` audit event, fresh/resume group reset | M | 3.1, 3.2 |
| | 3.4 UI controls + confirmations; `control.target` for in-process pause/resume | M | 3.3 |
| **4. Isolation** | 4.1 `llm.provider: mock` + zero-dep cortex start | M | – |
| | 4.2 Memory `inmemory` store + hash embedder | M | – |
| | 4.3 `voice.engine: stub` | S | – |
| | 4.4 chat `fake` source; eyes respects `vision.enabled=false`; ears `off` | M | – |
| | 4.5 Isolation presets in registry + "Start (isolated)" with dependency closure | M | 3.3, 4.1-4.4 |
| **5. Polish** | 5.1 `cohostctl` CLI on `packages/control` (status/start/stop/logs/run --isolated) | M | 3.3 |
| | 5.2 Docs: README ops section, `docs/` runbook, fix `stt` README/install.sh mismatch | S | all |

Phases 1-2 deliver the monitoring half and are shippable alone (read-only,
unprivileged). Phase 4 tasks are independent of 1-3 and can run in parallel.
Rough total: 1-2 about 1 week, 3 about 1 week, 4 about 1 week, 5 about 2 days.

## 11. Open questions for the owner

1. Is the primary runtime compose, `pnpm dev`, or both? (Plan assumes both;
   process adapter is droppable if compose-only.)
2. OK to run the control-enabled dashboard on the host (no socket mount)?
3. Separate `cohost:health` stream (recommended) vs same stream?
4. Should this become an OpenSpec change? A sibling worktree
   (`spec-driven-setup`) has an uncommitted OpenSpec scaffold that requires
   bus-event changes to update the bus spec and all producer/consumer specs;
   this doc is standalone until that lands.
5. Should mock backends ship in production images, or behind a dev-only build
   flag?

## 12. Out of scope

Authn beyond a static bearer token, remote/multi-host orchestration,
Kubernetes, log aggregation beyond tail, metrics/Prometheus export, and
fixing the avatar `mouthSmile` UI bug.
