---
parent: high-level-design
prefix: CTRL
---

# control-plane

Mapped 2026-10-31 at git `686cc8f`. Status MAPPED (not audited). Everything below describes what the code does today; where intent is a guess it is marked `[inferred]`. Parent: [high-level-design](../../high-level-design.md). Specs: [control-plane-specs.md](control-plane-specs.md).

## Context and Design Philosophy

The control plane is the operator-facing half of "know what is running and change it". It has three parts that share one vocabulary (the service manifest):

1. A **heartbeat contract**: every app service publishes `service.heartbeat` on a separate Redis stream, `cohost:health`. The publisher half lives in `packages/bus/src/heartbeat.ts` (`startHeartbeat`), the consumer half in `packages/control/src/health.ts` (`HealthTracker`).
2. A **controller**: `ServiceController` (`packages/control/src/controller.ts`) turns "start/stop/restart service X, resume or fresh, optionally isolated" into runtime calls, behind a small set of guards, and emits an audit event. Two runtime adapters exist (`ComposeRuntime`, `ProcessRuntime`, `runtime.ts`).
3. Two clients of that core: the dashboard (HTTP routes, `services/dashboard/src/control.ts`, `routes.ts`, `feed.ts`; owned by the dashboard segment) and the `cohostctl` CLI (`packages/control/src/cli.ts`). A third consumer, `healthcheck.ts`, is the docker-compose container healthcheck.

Guiding ideas visible in the code (`[inferred]` from comments and tests):

- **Allow-list, not command passing.** `manifest.ts:1-5` states that nothing from a request reaches an argv except by picking a manifest entry; both runtimes re-check the id against the manifest even though the controller already did (`runtime.ts:56`, `runtime.ts:127`, `runtime.ts:147`).
- **UI-agnostic core.** The controller and tracker know nothing about HTTP or WebSocket; the dashboard and CLI inject the audit callback and the group resetter (`controller.ts:49-52`, `cli.ts:98-105`, `control.ts:31-40`).
- **Monitoring is cheap and safe, control is gated.** The tracker runs unconditionally in the dashboard (`index.ts:29`); control is off unless `CONTROL_ENABLED=1` (`config.ts:25`).
- **Derived states are local.** Tracker states are computed from receive time and never published (`health.ts:42-46`).

The package is `@cohost/control` (`packages/control/package.json`): ESM, AGPL-3.0-only, `bin.cohostctl` is `dist/cli.js`, depends on `@cohost/bus` and `@cohost/config`. No file in `packages/control/src` imports `@cohost/config` (only `@cohost/bus` is imported: `cli.ts:13`, `health.ts:1`, `healthcheck.ts:7`), so that dependency and the tsconfig reference (`tsconfig.json:4`) are unused. `index.ts` re-exports health, manifest, runtime, controller, config and cli but not healthcheck (`index.ts:1-6`), because healthcheck is a script.

## Service manifest

`SERVICE_MANIFEST` (`manifest.ts:38-54`) lists 15 units.

| Unit | Kind | Groups reset on fresh | Default mode | Flags | Isolation preset (`isolatedEnv`) |
|---|---|---|---|---|---|
| chat | pnpm | none | resume | | `CHAT_SOURCE=fake` |
| salience | pnpm | salience | fresh | | none |
| affect | pnpm | affect | fresh | | none |
| memory | pnpm | memory, memory-recall | resume | | `MEMORY_STORE=memory`, `MEMORY_EMBEDDER=hash` |
| cortex | pnpm | cortex | fresh | | `LLM_PROVIDER=mock` |
| voice | pnpm | voice | fresh | | `VOICE_ENGINE=stub` |
| avatar | pnpm | avatar | fresh | | `AVATAR_DRIVER=null` |
| eyes | pnpm | none | resume | | `VISION_ENABLED=false` |
| ears | pnpm | ears | resume | | `EARS_SOURCE=off` |
| dashboard | pnpm | none | resume | `self` | none |
| redis | compose-only | none | resume | `infra` | none |
| postgres | compose-only | none | resume | `infra` | none |
| ollama, tts, stt | compose-only | none | resume | | none |

Two small builders (`svc`, `compose`, `manifest.ts:28-36`) fill defaults: `composeName` equals `id`, `pnpmFilter` is `@cohost/<id>` for `svc` and removed for `compose`. The preset variable names are the env spellings introduced by `add-isolated-backends` (`config/config.example.yaml:19,38,49,109,110,128,134,148` interpolate them).

Drift risk: `KNOWN_SERVICES` in `health.ts:8-10` is a second, hand-kept copy of the ten app ids; `manifest.test.ts:21` asserts it is a subset of the manifest. The dashboard uses `KNOWN_SERVICES` through `HealthTracker`'s default (`services/dashboard/src/index.ts:29`), whereas `cohostctl status` derives its list from the manifest (`cli.ts:107`).

## Runtimes and controller

### Runtime interface

`Runtime` has `name`, `start(id, opts)`, `stop(id)`, `restart(id, opts)` returning `{ ok, detail? }` (`runtime.ts:5-20`). `StartOptions` carries `processMode` (`dev` or `start`, process runtime only) and `env` (the isolation preset). The design note's optional `status?(id)` (`openspec/changes/archive/2026-11-01-add-service-control/design.md` decision 1) was not implemented.

### ComposeRuntime (`runtime.ts:46-73`)

- start: `docker compose up -d <composeName>`; stop: `docker compose stop <composeName>`; restart: `docker compose restart <composeName>`.
- With a non-empty env override, restart becomes `up -d --force-recreate` because a native `restart` keeps the container's environment (comment at `runtime.ts:70`).
- Executed via `execFile` (argv array, no shell), 120 s timeout, `cwd` defaults to the process cwd, so `docker-compose.yml` must be found there (`runtime.ts:28-35`, `runtime.ts:40`). The override env is merged over `process.env` and applied to the `docker` CLI process only (`runtime.ts:59`).
- Failure returns `ok: false` with stderr (else message) truncated to 500 chars (`runtime.ts:63`).

### ProcessRuntime (`runtime.ts:109-170`)

- start: spawns `pnpm --filter <pnpmFilter> dev|start`, `shell: false`, `detached: true`, `stdio: "ignore"`, waits for the child `spawn` or `error` event, tracks the child in an in-memory `Map`, `unref`s it, and clears the entry on `exit`. Script precedence is `opts.processMode`, then constructor `mode`, then `dev` (`runtime.ts:131`). Compose-only units are refused (`runtime.ts:129`); an already tracked id returns `ok: true` with `already running` (`runtime.ts:130`).
- stop: SIGTERM to the process group (`-pid`, falling back to the pid), race against `killTimeoutMs` (default 10 s), then SIGKILL and up to 2 s grace. An id with no tracked child returns `ok: false` (`runtime.ts:149`); a tracked child that already exited returns `ok: true`.
- restart: `stop` then `start`; a failed stop short-circuits (`runtime.ts:165-169`), so restarting something this process did not start fails rather than starts it.
- Because the map is in memory, `cohostctl stop` cannot stop a process started by another invocation, and a restarted dashboard loses its handles. `README.md:331-332` documents this and recommends compose.

### ServiceController (`controller.ts:53-103`)

Guard order (`controller.ts:63-69`):

1. Unknown id: `refused: "unknown"` (HTTP 404 in the dashboard).
2. `self` and action is not `start`: `refused: "conflict"` (409).
3. `infra` and not `advanced`: `refused: "forbidden"` (403); detail names `CONTROL_ADVANCED=1`.

Refusals are returned before anything runs and are not audited.

Mode and orchestration (`controller.ts:71-97`): effective mode is `resume` for infra, otherwise the caller's `mode`, otherwise the manifest default. `fresh` only takes effect when the unit owns groups (`controller.ts:80`).

| Action | Condition | Calls |
|---|---|---|
| stop | always | `runtime.stop` (never resets groups) |
| start | fresh | reset each group, then `runtime.start` |
| start | resume | `runtime.start` |
| restart | resume, no isolation env | `runtime.restart` (native) |
| restart | fresh or isolation env | `runtime.stop`, then (only if ok) reset groups if fresh, then `runtime.start` |

Isolation env is `{ ...def.isolatedEnv }` when `isolated` is set and the unit is not infra, else `undefined` (`controller.ts:78`). Because an empty object is truthy, isolated restarts of salience, affect or dashboard (empty presets) also take the stop-then-start path.

The consumer-group reset is `Bus.resetGroup` (`packages/bus/src/index.ts:109-121`, event-bus segment): `XGROUP SETID cohost:events <group> $`, creating the group with `MKSTREAM` at `$` when missing and ignoring `BUSYGROUP`. `resetConsumerGroups` runs groups in manifest order and stops at the first failure with detail `consumer group reset failed: ...` (`controller.ts:40-47`). A failed reset aborts the start (tested, `controller.test.ts:48`).

Audit (`controller.ts:93-96`): after any executed attempt the controller calls `audit({ service, action, by, ok, detail? })` inside a try/catch that swallows errors ("the audit is best effort, e.g. bus down while stopping redis"). Both clients wire it to `bus.publish("service.lifecycle", rec)` (`cli.ts:104`, `control.ts:37-39`, the latter also swallowing and logging). The `service.lifecycle` schema is in `packages/bus/src/events.ts:196-205` (event-bus segment); the event is published on `cohost:events`, not on the health stream.

## Heartbeat contract and health derivation

### Publisher (`packages/bus/src/heartbeat.ts`)

`startHeartbeat(bus, { service, version?, mode, deps, intervalMs?, log? })` returns `{ ready(), degraded(detail?), stop() }`.

- Payload fields: `service`, `instance` (the bus consumer name, `hostname-uuid8`), `pid`, `version` (option, else `COHOST_VERSION`, else `dev`), `startedAt` (`processStartedAt`, the module-load time, `heartbeat.ts:46`), `state` (`starting`, `ready`, `degraded`, `stopping`), `deps` (`ok`, `down`, `n/a` per name), `mode` (`live`, `mock`, `off` by convention, a free string in the schema), optional `detail`, `intervalMs` (`heartbeat.ts:66-83`).
- Cadence: one `starting` publish at call time, a steady `setInterval` of `intervalMs`, an immediate publish on `ready()` or `degraded()`, and a watcher at `min(1000, intervalMs)` that republishes if `[state, deps, mode, detail]` changed (`heartbeat.ts:96-107`). Both timers are `unref`ed.
- `intervalMs` is `HEARTBEAT_INTERVAL_MS` floored when positive and finite, else 5000 (`heartbeat.ts:48-51`; `.env.example:53-54`).
- Dependency-derived degradation: if the base is `ready` and any dep is `down`, the published state is `degraded` with detail `dependency down: a, b`, unless an explicit detail was given (`heartbeat.ts:68-70`). An explicit `degraded(detail)` keeps its own detail. A service that is still `starting` stays `starting` even with a dep down.
- Shutdown: `stop()` is registered with `beforeShutdown` (`heartbeat.ts:115`). `onShutdown` (`packages/bus/src/index.ts:230-243`) awaits all registered hooks, capped at 2 s, and then runs the service's own callback and `process.exit(0)`. So the `stopping` heartbeat is only sent if the service calls `onShutdown`; there is no handling of other exit paths (crash, `process.exit`, SIGKILL).
- Failure: a rejected `publishHealth` is logged at warn and swallowed (`heartbeat.ts:85-88`).
- `tracked(fn, set)` wraps an async call to feed dep status (`heartbeat.ts:32-37`).
- Transport: `Bus.publishHealth` validates against the zod schema and `XADD`s to `cohost:health` with `MAXLEN ~ 1000`; `Bus.publish("service.heartbeat")` throws (`packages/bus/src/index.ts:47,61-72`). `Bus.tailHealth` is a non-group `XREAD` tail; `Bus.recentHealth(n)` is `XREVRANGE` reversed to oldest-first.
- `heartbeat.ts` and `index.ts` import each other (`heartbeat.ts:2`, `index.ts:247`). It works because `beforeShutdown` is only called at runtime, not at module evaluation.

Every app service owns a `src/health.ts` exporting a `HeartbeatSpec` (service, mode, deps) and calls `startHeartbeat` itself; those files belong to each service's segment. The dashboard's own heartbeat is in `services/dashboard/src/index.ts:28`.

### HealthTracker (`packages/control/src/health.ts`)

State precedence in `derive` (`health.ts:98-112`), evaluated with the tracker's own clock (`Date.now` by default):

1. `unknown` if no heartbeat has ever been seen for a known name.
2. `crash-looping` if at least 3 distinct `startedAt` values were first seen within the last 60 s (`CRASH_LOOP_RESTARTS = 3`, `CRASH_LOOP_WINDOW_MS = 60000`); this beats everything else, including silence.
3. `down` if the last heartbeat is `stopping` or its age exceeds `10 x intervalMs` (`DOWN_FACTOR`).
4. `stale` if age exceeds `3 x intervalMs` (`STALE_FACTOR`).
5. `degraded` if the last heartbeat state is `degraded` or `starting`, or any dep is `down`.
6. `up` otherwise.

Details worth knowing:

- Age is `now - receivedAt`, where `receivedAt` is the local time of ingest for live heartbeats. `ingest(hb, at = now())` takes `at` as a parameter, and `seed(history)` passes each record's `ts` (the publisher's bus-stamped time) as `at` (`health.ts:60,75-77`). So clock skew is irrelevant only for live ingest; seeded history inherits any skew between the publishing and observing hosts. The comment "its own receive-time clock (so clock skew between containers is irrelevant)" (`health.ts:43-44`) is accurate for the live path only.
- A replayed older heartbeat does not overwrite a newer one (`health.ts:67`); start history is trimmed to the 60 s window except for the current process's start (`health.ts:65-69`). Consequently a long-running service reports `restarts: 0`, and a service with exactly one start inside the window reports `restarts: 1`.
- `snapshot()` returns the known list (default `KNOWN_SERVICES`) plus any other name that has sent a heartbeat. `onChange` listeners are called only when the per-service key (derived state, restarts, heartbeat state, mode, detail, deps, instance) changes; `tick()` re-derives time-based transitions (`health.ts:79-80,114-124`). `lastSeenAgeMs` is deliberately not in the key.
- The dashboard feeds it with `recentHealth(500)` then `tailHealth` and runs `tick()` every second (`services/dashboard/src/feed.ts:44-52`); `GET /services` returns the snapshot (`routes.ts:62-66`) and WebSocket clients get a `services` message on change.

### Container healthcheck (`healthcheck.ts`)

`isHealthy(service, recent, now)` takes the newest heartbeat for the service from the list and is true iff it exists, is not `stopping`, and `now - latest.ts < 3 x intervalMs` (`healthcheck.ts:10-14`). The script reads `recentHealth(200)`, exits 0 or 1, exits 2 without an argument, and hard-exits 1 after 4 s (`healthcheck.ts:16-31`). It is wired as `node packages/control/dist/healthcheck.js $$SERVICE` in the `x-ts-service` anchor (`docker-compose.yml:30-35`, interval 10 s, timeout 5 s, retries 3, start period 30 s); `SERVICE` is baked in by the Dockerfile (`Dockerfile:20`).

Unlike the tracker, the healthcheck compares the heartbeat's bus-side `ts` (publisher time) with the local clock, so container clock skew matters here. With roughly ten services beating every 5 s, 200 records covers about 100 s, comfortably more than the 15 s freshness bound; a much shorter `HEARTBEAT_INTERVAL_MS` would shrink that window.

## cohostctl and configuration

CLI (`cli.ts`): `cohostctl status [service]` and `cohostctl start|stop|restart <service> [--mode resume|fresh] [--isolated]`. Parsing uses `node:util.parseArgs` (`cli.ts:29-54`); any parse problem raises `UsageError` and exit code 2 with the usage text. Exit codes: 0 success, 1 refusal or failure (`cli.ts:63`), 2 usage.

- `status` builds a throwaway `HealthTracker` with known = manifest entries that are not infra and have a `pnpmFilter`, seeds it from `bus.recentHealth(200)` and prints `service  state  mode  Ns ago` per row (`cli.ts:70-79,106-111`). Because the known list excludes infra and compose-only units, `cohostctl status redis` reports `unknown service` and exits 1.
- `main()` constructs `new Bus("cohostctl")`, builds the runtime from `CONTROL_RUNTIME` (default `compose`; any other value than `compose` or `process` is a `UsageError`, exit 2), passes `by: "cohostctl"`, `advanced` from `CONTROL_ADVANCED === "1"`, and `processMode` from `CONTROL_PROCESS_MODE === "start" ? "start" : "dev"` (`cli.ts:87-104`). It always calls `bus.stop()` in `finally`.
- It runs as the invoking user and does not read `CONTROL_ENABLED` or `CONTROL_TOKEN` (those only gate the dashboard's HTTP surface).
- `main()` runs only when `process.argv[1]` ends with `cli.js` (`cli.ts:121`). Since `index.ts` re-exports `cli.js`, importing the package from another entry script runs nothing, but the check is a suffix match, so any other entry script named `cli.js` that imports `@cohost/control` would also start the CLI. Running the TypeScript source under tsx does not trigger it either (the suffix would be `cli.ts`), so `cohostctl` only works from the built `dist`; the README invokes it as `pnpm --filter @cohost/control exec cohostctl` (`README.md:321-322`).

Configuration (`config.ts`): `loadControlConfig(env)` is used by the dashboard. `CONTROL_ENABLED` must be exactly `1`; otherwise `{ enabled: false }`. Enabled requires a non-blank `CONTROL_TOKEN`. Defaults are `CONTROL_BIND` unset means `127.0.0.1` with `bindExplicit: false`, `CONTROL_RUNTIME` compose, `CONTROL_PROCESS_MODE` dev, `CONTROL_ADVANCED` off. Unknown runtime or process mode throws. `bearerOk(header, token)` compares SHA-256 digests with `timingSafeEqual` (`config.ts:40-47`). `isLoopback` accepts `localhost`, `::1`, and anything starting with `127.` (`config.ts:19-21`).

| Env var | Read by | Meaning |
|---|---|---|
| `CONTROL_ENABLED` | `loadControlConfig` (dashboard) | `1` turns the lifecycle routes and token gate on |
| `CONTROL_TOKEN` | `loadControlConfig` | required bearer secret when enabled |
| `CONTROL_BIND` | `loadControlConfig`, dashboard `index.ts:50` | listen address; loopback default only when enabled |
| `CONTROL_RUNTIME` | `loadControlConfig`, `cli.ts:88` | `compose` (default) or `process` |
| `CONTROL_PROCESS_MODE` | both | `dev` (default) or `start`; the CLI silently maps any other value to `dev` |
| `CONTROL_ADVANCED` | both | `1` allows redis and postgres mutations |
| `REDIS_URL` | `Bus` (via `@cohost/config` `urls.redis()`), CLI, healthcheck | bus address |
| `HEARTBEAT_INTERVAL_MS`, `COHOST_VERSION` | `heartbeat.ts` | beat interval (default 5000) and reported version (default `dev`) |

Consumers of this segment: dashboard `control.ts` (`setupControl`, warns on non-loopback bind and on `CONTROL_ADVANCED`), `routes.ts` (404 when disabled, 401 without a bearer, body parsing of `mode` and `isolated`, refusal-to-status map unknown 404 / conflict 409 / forbidden 403 at `routes.ts:32`), `feed.ts`, `index.ts`; and the compose healthcheck. Those files are specified in the dashboard segment; this segment owns the semantics they delegate to.

## Divergence from the original plan

Compared with `docs/plans/control-plane.md` (written at `95afa19`), what landed:

| Plan | Landed | Note |
|---|---|---|
| Option A: dashboard-embedded supervisor on a UI-agnostic core, `cohostctl` later (§5) | Same | `packages/control` plus dashboard plus `cohostctl` |
| `ServiceRegistry` with `requires`, `externals`, `isolationEnv` (§5, §7.1) | Flat `SERVICE_MANIFEST` with `groups`, `defaultMode`, `infra`, `self`, `isolatedEnv`; no `requires` or `externals` | no dependency closure for isolated runs (see Open Questions) |
| Compose-only units not discussed as controllable | `ollama`, `tts`, `stt` added as manifest units | compose runtime only |
| `service.heartbeat` schema, `startHeartbeat` returning `ready/degraded/stop`, separate `cohost:health` stream (§6) | Same; options take `mode` and `deps` as values or getters instead of `getState` | `HEARTBEAT_INTERVAL_MS` env added |
| `mode` label examples `live`, `null`, `mock` | Convention is `live`, `mock`, `off` | schema accepts any string |
| Derived states and 3x/10x/60 s thresholds (§6) | Identical | `starting` counts as degraded |
| Filter heartbeats from dashboard feed and memory (task 1.3) | Unnecessary: heartbeats are on their own stream | |
| Compose healthchecks for app services (G6, task 1.3) | Landed (`docker-compose.yml:30-35`) | |
| Surface compose restart loops by reading `docker compose ps` (task 2.3) | Not implemented | crash-loop is inferred from `startedAt` only |
| `Runtime.status?(id)` (design.md) | Not implemented | health comes only from heartbeats |
| `cohostctl status/start/stop/logs/run --isolated`, optional Ink TUI (§4B, task 5.1) | `status`, `start`, `stop`, `restart` with `--isolated` flag; no `logs`, no `run`, no TUI | |
| "Start (isolated)" with dependency closure (§7.2) | Isolation flag only; no closure | |
| `POST /control` token gate, loopback bind, manifest-only ids, fixed argv (§9) | Landed | gate wiring is in dashboard |
| `control` event `pause`/`resume` with `target` (§6) | Landed in bus (other segments consume) | not part of this segment's code |

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where heartbeats travel | Separate stream `cohost:health`, `MAXLEN ~1000`, `publish` refuses `service.heartbeat` | Same `cohost:events` stream | `[inferred]` keep high-rate liveness from evicting domain events (20k cap); `packages/bus/src/index.ts:10-12,47`, `docs/plans/control-plane.md` §6 |
| Where the tracker's derived states live | Computed locally in each observer, never published | Supervisor publishes status events | `[inferred]` one source of truth (raw heartbeats), no feedback loop; `health.ts:42-46` |
| Staleness clock | Observer's receive time for live ingest; publisher `ts` only for seeding history and in the healthcheck | Trust publisher `startedAt`/`ts` throughout | `[inferred]` containers can have skewed clocks; `health.ts:42-44,60,75` |
| Crash-loop signal | 3 distinct `startedAt` in 60 s, outranks all other states | Parse `docker compose ps` restart counts | `[inferred]` works for compose and pnpm runtimes alike with no extra access; `health.ts:12-15,103-106` |
| Controller as UI-agnostic class with injected runtime, group resetter, audit | `ServiceController` | Logic inside dashboard routes | `[inferred]` two clients (dashboard, CLI) share it; `controller.ts:49-52`, `cli.ts:98` |
| Command construction | Manifest-only ids, `execFile`/`spawn` with fixed argv, `shell: false`; id re-checked in each runtime | Accept arbitrary service names; shell strings | `[inferred]` limit blast radius of a privileged endpoint; `manifest.ts:1-5`, `runtime.ts:30,88` |
| Fresh vs resume | `fresh` resets groups to `$` after stop, before start; default fresh for chat-reactive brain/body services, resume for memory | Always resume; reset via `fromNow` subscribe option | `[inferred]` avoid replaying hours of backlog after a stop; `controller.ts:80-91`, `manifest.ts:40-45` |
| Infra handling | `redis`, `postgres` refused unless `CONTROL_ADVANCED=1`, always resume | Never controllable; always controllable | `[inferred]` stopping infra takes everything down; `controller.ts:67,75` |
| Self protection | `dashboard` can start but not stop/restart (409) | Allow, rely on operator | `[inferred]` the process serving the request would kill itself; `controller.ts:66` |
| Audit is best effort | Swallow audit errors | Fail the action when audit fails | `[inferred]` stopping redis would make the audit unpublishable; `controller.ts:95` |
| Process runtime | Detached children with in-memory pid map; SIGTERM to the process group then SIGKILL after 10 s | Persist pids to disk; run attached | `[inferred]` services should outlive the controller and pnpm spawns a tree; `runtime.ts:87-94,111,120` |
| Compose runtime via CLI | `docker compose` through `execFile` | Docker Engine API | `[inferred]` simplest first step; Engine API deferred in `add-service-control/design.md` decision 1 |
| Healthcheck as a Node script reading the bus | `healthcheck.js` | HTTP `/health` per service | `[inferred]` only voice and dashboard have HTTP endpoints; `docker-compose.yml:28-31`, plan §2.2 |
| Heartbeat timers | One steady interval plus a faster change watcher (at most 1 s) | Publish on every dep mutation | `[inferred]` deps are read through getters, so polling detects changes without hooks in every service; `heartbeat.ts:96-107` |

## Open Questions & Future Decisions

### Resolved
1. Separate health stream rather than the events stream (plan §11 question 3): resolved as separate, `packages/bus/src/index.ts:10-12`.
2. Both runtimes shipped (plan §11 question 1): compose and process, selected by `CONTROL_RUNTIME`.

### Observed, unexplained, or debt
1. **Compose isolation env probably never reaches the container** (`runtime.ts:59`). The preset env is set on the `docker compose` process, but `docker-compose.yml:11-21` uses `env_file: .env` and a fixed `environment` block with no `${LLM_PROVIDER}` style references, so `up -d` or `--force-recreate` does not forward them. Tests only assert the exec env (`runtime.test.ts:41`). Isolated start under compose may be a no-op for the container. Specified as gap CTRL-RUNTIME-009.
2. **No dependency closure for isolated runs.** `add-isolated-backends` cortex § "Isolation preset and closure" says the controller computes it (cortex needs salience and affect); the manifest has no `requires` field and `controller.ts` starts only the named unit. Specified as gap CTRL-GUARD-008.
3. **`restart` on a stopped or untracked process fails** (`runtime.ts:165-169`, `controller.ts:86-91`). Under `ProcessRuntime` a restart (native or fresh/isolated) returns `ok: false` with `not running under this process runtime` instead of starting the service, and a fresh restart never reaches the group reset. Whether restart should degrade to start is undecided.
4. **`cohostctl` and the dashboard can disagree on config validation.** `loadControlConfig` throws on an invalid `CONTROL_PROCESS_MODE` (`config.ts:31`); the CLI silently treats anything other than `start` as `dev` (`cli.ts:90,103`). Invalid `CONTROL_RUNTIME` throws in both, but as `UsageError` (exit 2) in the CLI.
5. **CLI creates a `Bus` before parsing arguments** (`cli.ts:95`, parse happens at `cli.ts:112`), so even usage errors open a Redis connection first.
6. **Seeding uses publisher timestamps.** `seed` and `cohostctl status` pass `h.ts` (bus-stamped on the publisher) as receive time (`health.ts:75-77`, `cli.ts:109`), so skew shifts reported ages right after a dashboard start, and `status` is only a snapshot of the last ~200 heartbeats rather than a live subscription.
7. **Healthcheck skew sensitivity** (`healthcheck.ts:13`): compares bus `ts` with local `Date.now()`. A container with a clock more than about 15 s off its Redis publisher host would flap unhealthy.
8. **`stopping` heartbeat depends on a clean `onShutdown`.** Crashes, `process.exit` or SIGKILL publish nothing; those cases rely on staleness (3x then 10x interval) to turn `down`. Crash-looping services restarted fast also show `crash-looping` only after 3 starts.
9. **`@cohost/config` is a declared dependency and tsconfig reference of `packages/control` but is never imported** (`package.json:14`, `tsconfig.json:4`). `heartbeat.ts` in `packages/bus` imports only the `Logger` type from it.
10. **Circular import** between `packages/bus/src/index.ts:247` and `heartbeat.ts:2`; safe only while `beforeShutdown` is called at runtime.
11. **Duplicate service lists.** `KNOWN_SERVICES` (`health.ts:8`) versus manifest-derived list (`cli.ts:107`); only a unit test ties them (`manifest.test.ts:21`).
12. **Comments point at nonexistent baselines.** `manifest.ts:4` cites `openspec/specs/service-control` and `health.ts:45` cites `openspec/specs/service-health`; neither directory exists (see References).
13. **`ProcessRuntime` mode precedence is split**: the controller passes `processMode` on every start (`controller.ts:77`) and the runtime also has a constructor `mode`; both come from the same env today (`cli.ts:90,103`; `control.ts:30,36`) so they cannot differ in practice.
14. **Test coverage gaps**: no test for `cli.ts` `main()` or the entry guard, none for `isLoopback`, none for the compose `cwd`/timeout, none for a healthcheck against a stale-but-not-yet-down service end to end; `healthcheck.test.ts:36` needs a built `dist` and Redis and is skipped without Redis.
15. **Heartbeat state published by the helper is already `degraded` for a down dep**, so the tracker's own "any dep down" rule (`health.ts:109`) is redundant for helper users and only matters for heartbeats hand-published by other publishers.

### Deferred
1. Persisting process pids across controller restarts (README documents the limitation; CTRL-CLI-006 is `[D]`).
2. Docker Engine API instead of the CLI (deferred in `add-service-control/design.md`).
3. Surfacing compose restart counts from `docker compose ps` (plan task 2.3).

## References

Files in this segment (git `686cc8f`):
- `packages/control/src/index.ts`, `cli.ts`, `config.ts`, `controller.ts`, `health.ts`, `healthcheck.ts`, `manifest.ts`, `runtime.ts`
- `packages/control/test/cli.test.ts`, `config.test.ts`, `controller.test.ts`, `health.test.ts`, `healthcheck.test.ts`, `manifest.test.ts`, `runtime.test.ts`
- `packages/control/package.json`, `packages/control/tsconfig.json`
- `packages/bus/src/heartbeat.ts` (tests: `packages/bus/test/bus.test.ts:128-258`, `packages/bus/test/shutdown.fixture.ts`)
- `docs/plans/control-plane.md` (original plan, compared above)

Other segments (direction):
- event-bus: this segment depends on `Bus.publishHealth`, `tailHealth`, `recentHealth`, `resetGroup`, `onShutdown`/`beforeShutdown`, and the `service.heartbeat` and `service.lifecycle` schemas in `packages/bus/src/events.ts`; event-bus documents the schema and points here for semantics.
- config: `heartbeat.ts` imports the `Logger` type; `Bus` takes its Redis URL from `urls.redis()`. `@cohost/config` is otherwise unused here. Presets rely on `${VAR:-default}` keys in `config/config.example.yaml`.
- dashboard: consumes `HealthTracker`, `ServiceController`, runtimes, `loadControlConfig`, `bearerOk`, `isLoopback` (`services/dashboard/src/control.ts`, `routes.ts`, `feed.ts`, `index.ts`); dashboard owns the HTTP routes, token prompt and UI.
- chat, eyes, ears, salience, affect, memory, cortex, voice, avatar: each owns `src/health.ts` and its `startHeartbeat` call; their isolation presets (`CHAT_SOURCE`, `VISION_ENABLED`, `EARS_SOURCE`, `MEMORY_STORE`/`MEMORY_EMBEDDER`, `LLM_PROVIDER`, `VOICE_ENGINE`, `AVATAR_DRIVER`) are named in this segment's manifest but implemented by the backends' segments (model-backends, memory, voice, chat, ears, eyes, avatar). salience, affect and cortex also consume `control` `pause`/`resume` (not part of this segment).
- deployment: `docker-compose.yml:30-35` and `Dockerfile:20` wire the healthcheck and `SERVICE`.

External: Redis Streams (`cohost:events`, `cohost:health`), `docker compose` CLI, `pnpm`, Node `child_process`, `util.parseArgs`, `crypto`.

OpenSpec: the capabilities `service-health` and `service-control` exist ONLY as unarchived deltas. There is no `openspec/specs/service-health/` or `openspec/specs/service-control/` baseline directory (the comments at `manifest.ts:4` and `health.ts:45` point at paths that do not exist), so these files are the only written source of intent:
- `openspec/changes/archive/2026-11-01-add-service-health/specs/service-health/spec.md` (heartbeat contract, derived states, crash-loop, snapshot, compose healthcheck)
- `openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md` (health stream, heartbeat helper, catalogue)
- `openspec/changes/archive/2026-11-01-add-service-health/specs/dashboard/spec.md` and the per-service `Heartbeat` deltas
- `openspec/changes/archive/2026-11-01-add-service-control/specs/service-control/spec.md` (runtime adapters, manifest-only ids, start modes, protected services, gating, audit event, `cohostctl`)
- `openspec/changes/archive/2026-11-01-add-service-control/specs/bus/spec.md` (`service.lifecycle`), `.../dashboard/spec.md` (routes, token), `openspec/changes/archive/2026-11-01-add-service-control/design.md`
- `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/*` (isolation presets and the cortex closure requirement)

Spec-to-OpenSpec mismatches are captured as `[ ]` specs CTRL-RUNTIME-009 and CTRL-GUARD-008. The two catalogue deltas in `bus` list different sets (health lists `service.heartbeat` but not `service.lifecycle`; control lists `service.lifecycle` but not `service.heartbeat`); event-bus owns reconciling those.
