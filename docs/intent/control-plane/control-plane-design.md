---
parent: high-level-design
prefix: CTRL
---

# control-plane

Status: AUDITED 2026-11-02 at git `1b57790`. Mapped 2026-10-31 at git `686cc8f`; specs verified against the code and `@spec` annotations added at git `49ba935`; owner decisions of 2026-11-01 applied. The document describes intended behaviour; where the code does not yet match, the text names the `[ ]` spec line. Parent: [high-level-design](../../high-level-design.md). Specs: [control-plane-specs.md](control-plane-specs.md).

## Context and Design Philosophy

The control plane is the operator-facing half of "know what is running and change it". It has three parts that share one vocabulary (the service manifest):

1. A **heartbeat contract**: every app service publishes `service.heartbeat` on a separate Redis stream, `cohost:health`. The publisher half lives in `packages/bus/src/heartbeat.ts` (`startHeartbeat`), the consumer half in `packages/control/src/health.ts` (`HealthTracker`).
2. A **controller**: `ServiceController` (`packages/control/src/controller.ts`) turns "start/stop/restart service X, resume or fresh, optionally isolated" into runtime calls, behind a small set of guards, and emits an audit event. The one runtime is `ComposeRuntime` (`runtime.ts`): compose is the only runtime, and the control plane never spawns or supervises host processes, so no service handles another service outside the container runtime.
3. A **stack controller** (`packages/control/src/stack.ts`, CTRL-STACK-*): whole-stack actions (launch, stop-all, restart-all, and the consolidate one-shot), a Compose status probe, and the derivation of one stack state from it. The host-run dashboard's Launch button and `cohostctl launch` run the same code (Stack controller, below).
4. Two clients of that core: the dashboard (HTTP routes, `services/dashboard/src/control.ts`, `routes.ts`, `feed.ts`; owned by the dashboard segment), which runs on the host outside Compose, and the `cohostctl` CLI (`packages/control/src/cli.ts`). A third consumer, `healthcheck.ts`, is the docker-compose container healthcheck.

Guiding ideas:

- **Allow-list, not command passing.** `manifest.ts:1-5` states that nothing from a request reaches an argv except by picking a manifest entry; the runtime re-checks the id against the manifest even though the controller already did (`runtime.ts:58`).
- **UI-agnostic core.** The controller and tracker know nothing about HTTP or WebSocket; the dashboard and CLI inject the audit callback and the group resetter (`controller.ts:49-52`, `cli.ts:101-108`, `control.ts:31-41`).
- **Monitoring is cheap and safe, control is gated.** The tracker runs unconditionally in the dashboard (`services/dashboard/src/index.ts:30`); control is off unless `CONTROL_ENABLED=1` (`config.ts:27`).
- **Derived states are local.** Tracker states are computed from receive time and never published (`health.ts:43-47`).

The package is `@cohost/control` (`packages/control/package.json`): ESM, AGPL-3.0-only, `bin.cohostctl` is `dist/cli.js`, depends on `@cohost/bus` and `@cohost/config`. No file in `packages/control/src` imports `@cohost/config` (only `@cohost/bus` is imported: `cli.ts:13`, `health.ts:1`, `healthcheck.ts:7`), so that dependency and the tsconfig reference (`tsconfig.json:4`) are unused. `index.ts` re-exports health, manifest, runtime, controller, config and cli but not healthcheck (`index.ts:1-6`), because healthcheck is a script.

## Service manifest

`SERVICE_MANIFEST` (`manifest.ts:39-55`) lists 15 units: every Compose service the controller may act on. The dashboard is not one: it runs on the host, outside Compose, so there is no container to start, stop or restart, and the `self` flag that protected it from stopping itself is gone with it. CTRL-GUARD-002 (the `self` conflict) is retired.

| Unit | Kind | Groups reset on fresh | Default mode | Flags | Isolation preset (`isolatedEnv`) |
|---|---|---|---|---|---|
| chat | pnpm | chat | fresh | | `CHAT_SOURCE=fake` |
| salience | pnpm | salience | fresh | | none |
| affect | pnpm | affect | fresh | | none |
| memory | pnpm | memory, memory-recall, memory-notes | resume | | `MEMORY_STORE=memory`, `MEMORY_EMBEDDER=hash` |
| cortex | pnpm | cortex | fresh | | `LLM_PROVIDER=mock` |
| voice | pnpm | voice | fresh | | `VOICE_ENGINE=stub` |
| avatar | pnpm | avatar | fresh | | `AVATAR_DRIVER=null` |
| eyes | pnpm | eyes | fresh | | `VISION_ENABLED=false` |
| ears | pnpm | ears | fresh | | `EARS_SOURCE=off` |
| mouth | pnpm | mouth | fresh | | `MOUTH_DISCORD_ENABLED=false` |
| redis | compose-only | none | resume | `infra` | none |
| postgres | compose-only | none | resume | `infra` | none |
| ollama, tts, stt | compose-only | none | resume | | none |

Two small builders (`svc`, `compose`, `manifest.ts:28-36`) fill defaults: `composeName` equals `id`, `pnpmFilter` is `@cohost/<id>` for `svc` and removed for `compose`. The preset variable names are the env spellings introduced by `add-isolated-backends` (`config/config.example.yaml:19,38,49,109,110,128,134,148` interpolate them).

Drift risk: `KNOWN_SERVICES` in `health.ts:9-11` is a second, hand-kept copy of the app ids (ten services with `mouth`, CTRL-HEALTH-005; the dashboard's own heartbeat still shows in every snapshot as a service that has sent one); `manifest.test.ts:23` asserts it is a subset of the manifest. The dashboard uses `KNOWN_SERVICES` through `HealthTracker`'s default (`services/dashboard/src/index.ts:30`), whereas `cohostctl status` derives its list from the manifest (`cli.ts:110`).

**Start modes and the bus.** Where a restarted service starts reading is decided by the service itself: every subscription names a bus start mode, `latest` (reset the group to `$` on every start) or `resume` (keep the stored position); memory subscribes with `resume`, every other service with `latest` (event-bus BUS-SUB-010, BUS-SUB-011). The controller's `fresh` / `resume` mode is an operator override on top of that: `fresh` resets the unit's manifest groups before the start, which matters for `resume` subscribers (memory) and is redundant for `latest` ones; `resume` leaves the groups alone, so a `latest` service still skips its backlog. The manifest defaults agree with the bus modes for every unit: `fresh` for each service that owns groups except memory (the `latest` subscribers), `resume` for memory and the compose-only units. Each pnpm service that subscribes owns a group of its own name (memory also `memory-recall` and `memory-notes`), so a `fresh` start resets exactly the groups the service reads under.

**Isolated starts and requirements.** The manifest `requires` field lists the units a unit needs on the bus (cortex requires salience and affect). An isolated start of a unit first starts its `requires` closure, followed transitively, depth-first in list order, each unit once, then the named unit. Each required unit starts with its own isolation preset and its own default mode, and is audited as its own start. A required unit that fails to start ends the start: the named unit is not started and the result is `ok: false`, naming the failed unit. A non-isolated start, and every restart and stop, act on the named unit only (CTRL-GUARD-008).

## Runtimes and controller

### Runtime interface

`Runtime` has `name` (always `compose`), `start(id, opts)`, `stop(id)`, `restart(id, opts)` returning `{ ok, detail? }` (`runtime.ts:5-25`). `StartOptions` carries `env` (the isolation preset). `ServiceController` and both clients construct `ComposeRuntime` unconditionally (CTRL-CLI-004, DASH-CTRL-001); there is no runtime selection, and the `Runtime` interface remains so tests can inject a fake. The retired CTRL-RUNTIME-005 to 008, CTRL-GUARD-009, CTRL-CLI-006 and CTRL-CLI-007 are not reused. The design note's optional `status?(id)` (`openspec/changes/archive/2026-11-01-add-service-control/design.md` decision 1) was not implemented.

### ComposeRuntime (`runtime.ts:47-76`)

- start: `docker compose up -d <composeName>`; stop: `docker compose stop <composeName>`; restart: `docker compose restart <composeName>`.
- With a non-empty env override, restart becomes `up -d --force-recreate` because a native `restart` keeps the container's environment (comment at `runtime.ts:73`).
- Executed via `execFile` (argv array, no shell), 120 s timeout, `cwd` defaults to the process cwd, so `docker-compose.yml` must be found there (`runtime.ts:28-35`, `runtime.ts:40`). Both clients construct it with `cwd` set to the workspace root (`findWorkspaceRoot()` from `@cohost/config`, else the process cwd), so Compose finds the file, `.env` and the project name however the client was started (CTRL-STACK-001). The override env is merged over `process.env` and applied to the `docker` CLI process (`runtime.ts:61`).
- Isolation env reaches the container through pass-through entries in the compose `x-ts-service` environment, one per preset variable, each written `VAR: ${VAR:-}` so an unset variable leaves the `${VAR:-default}` in `config.yaml` in charge (CTRL-RUNTIME-009): `CHAT_SOURCE`, `MEMORY_STORE`, `MEMORY_EMBEDDER`, `LLM_PROVIDER`, `VOICE_ENGINE`, `AVATAR_DRIVER`, `VISION_ENABLED`, `EARS_SOURCE`. The entries belong to `docker-compose.yml` (deployment segment); without them an isolated compose start would set the preset only in the `docker compose` CLI's own environment and nothing would reach the container.
- The compose runtime is driven from the host: by the dashboard, which always runs on the host outside Compose, and by `cohostctl`. Both use the host's own `docker` CLI and the owner's access to it; no container receives the Docker socket.
- Failure returns `ok: false` with stderr (else message) truncated to 500 chars (`runtime.ts:65`).

### ServiceController (`controller.ts:53-105`)

Guard order (`controller.ts:64-70`):

1. Unknown id: `refused: "unknown"` (HTTP 404 in the dashboard). `dashboard` is an unknown id.
2. `infra` and not `advanced`: `refused: "forbidden"` (403); detail names `CONTROL_ADVANCED=1`.

There is no third refusal: the manifest has no `self` flag, so nothing is refused as a conflict; CTRL-GUARD-002 is retired.

Refusals are returned before anything runs and are not audited, by design (commit `1d316ff`).

Mode and orchestration (`controller.ts:73-99`): effective mode is `resume` for infra, otherwise the caller's `mode`, otherwise the manifest default. `fresh` only takes effect when the unit owns groups (`controller.ts:82`).

| Action | Condition | Calls |
|---|---|---|
| stop | always | `runtime.stop` (never resets groups) |
| start | fresh | reset each group, then `runtime.start` |
| start | resume | `runtime.start` |
| start | isolated, unit has `requires` | the closure first (each required unit as an isolated start in its own default mode, audited separately), then the named unit's start as above |
| restart | resume, no isolation env | `runtime.restart` (native) |
| restart | fresh or isolation env | `runtime.stop`, then (only if it resolved ok) reset groups if fresh, then `runtime.start` |

Isolation env is `{ ...def.isolatedEnv }` when `isolated` is set and the unit is not infra, else `undefined` (`controller.ts:80`). Because an empty object is truthy, isolated restarts of salience or affect (empty presets) also take the stop-then-start path.

The consumer-group reset is `Bus.resetGroup` (`packages/bus/src/index.ts:115-127`, event-bus segment): `XGROUP SETID cohost:events <group> $`, creating the group with `MKSTREAM` at `$` when missing and ignoring `BUSYGROUP`. `resetConsumerGroups` runs groups in manifest order and stops at the first failure with detail `consumer group reset failed: ...` (`controller.ts:40-47`). A failed reset aborts the start (tested, `controller.test.ts:53`).

Audit (`controller.ts:95-98`): after any executed attempt the controller calls `audit({ service, action, by, ok, detail? })`, with `detail` present whenever the runtime returned one (on success too, which is useful audit data), inside a try/catch that swallows errors ("the audit is best effort, e.g. bus down while stopping redis"). Both clients wire it to `bus.publish("service.lifecycle", rec)` (`cli.ts:107`, `control.ts:39-41`, the latter also swallowing and logging). The `service.lifecycle` schema is in `packages/bus/src/events.ts:215-224` (event-bus segment); the event is published on `cohost:events`, not on the health stream.

## Stack controller

The owner's decisions are settled: the host-run dashboard has a Launch button that brings up the whole application through the compose runtime, it can stop the stack and restart its services, and the stack actions live in this package so the dashboard and `cohostctl` share one implementation. The mechanics below are owner-confirmed (CTRL-STACK-001 to 012, CTRL-CLI-010 to 012).

`StackController` wraps the same injected exec as `ComposeRuntime` (argv array, no shell, the workspace root as `cwd`, the caller's environment) and takes no caller input that reaches an argv: every command is fixed (CTRL-STACK-001, CTRL-STACK-009). It reports progress through an optional `onPhase(kind, phase)` callback and returns a result `{ ok, detail?, services? }`, where `services` is the last status the action saw.

| Action | Commands | Phases | Timeout |
|---|---|---|---|
| `status()` | `docker compose ps --all --format json` | none | 10 s |
| `launch()` | `docker compose up -d --remove-orphans`, then `status()` every 2 s until ready | `compose-up`, `waiting` | 30 min for `up` (a first launch builds images); 180 s for readiness |
| `stopAll()` | `docker compose stop` | `stopping` | 300 s |
| `restartAll(controller)` | `status()`, then `ServiceController.restart` per running application unit | `restarting <id>` | per restart, 120 s (CTRL-RUNTIME-001) |
| `consolidate()` | `ComposeRuntime.consolidate` (CTRL-RUNTIME-010) | `running` | 30 min |

- **Status** (CTRL-STACK-008). Parses the JSON Compose prints (a JSON array, or one object per line, depending on the Compose version) into `{service, status, health?, exitCode?}` per container of the project. It never throws: a missing `docker` binary, a daemon that does not answer, or unparsable output yields `docker: {ok: false, detail}` with the stderr or message cut to 500 characters. A project with no containers is a successful status with an empty list.
- **Launch** (CTRL-STACK-002 to 005). `up -d` with no service names starts every service Compose would start for a plain `up`: profile-gated services (`eyes`, `ears`, `mouth`, `consolidate`) join only when `COMPOSE_PROFILES` in `.env` names them, and `COMPOSE_FILE` in `.env` keeps the GPU overlay. `--remove-orphans` removes containers of services the Compose file no longer defines, such as a `dashboard` container left by an older file that would otherwise hold the dashboard's host port. Images are built only when missing; `--build` is not passed. After `up` succeeds, the controller polls until every long-running container (every container except the one-shots `models` and `consolidate`) is `running` and either `healthy` or without a healthcheck (ollama, tts, stt), and then resolves `ok: true`. If that does not happen within the readiness timeout, it resolves `ok: false` naming each container that is not ready with its status and health; it stops nothing (no rollback), so a partial stack stays up for the owner to inspect. A one-shot that exited non-zero (a failed model pull) is appended to `detail` as a warning without making the launch fail, matching DEPLOY-COMPOSE-011. Launching an already-running stack is the same command: Compose leaves services that match the file alone, starts stopped ones and recreates any whose configuration differs (for example one that an isolated start recreated with a preset).
- **Stop-all** (CTRL-STACK-006). `docker compose stop` stops every container of the project, infrastructure included, in reverse dependency order with Compose's grace period, so every service shuts down through `onShutdown` (memory records `notes.shutdown_run_owed`, MEM-CONSOL-013). It never runs `down` and never removes volumes, containers or networks.
- **Restart-all** (CTRL-STACK-007). Restarts, in manifest order, every manifest unit that is an application service (a unit with a `pnpmFilter`) whose container the status shows `running`, each through `ServiceController.restart` in its default mode and not isolated, so each is guarded and audited like a single restart. Infrastructure and the compose-only units (`ollama`, `tts`, `stt`) are left alone. A failed restart does not stop the rest; the result is `ok` only when every restart succeeded, and `detail` names each failure.
- **Docker binary** (CTRL-STACK-012). Every command, the per-unit runtime's included, runs `COHOST_DOCKER_BIN` when set, else `docker`, else `docker.exe`. On WSL2 with Docker Desktop and no WSL integration only the Windows `docker.exe` is on the path; it is started from the distro with the workspace root as its working directory, which Windows sees as a `\\wsl.localhost\...` path, so the `./config` bind mount and `.env` resolve through that path. The single-PC test checklist (deployment DEPLOY-HOST-004) exercises Launch this way.
- **Guards** (CTRL-STACK-010). Stack actions do not go through the per-unit guards: they need no `CONTROL_ADVANCED`, because Launch must start Redis and Postgres and stop-all is a deliberate whole-stack act. Restart-all goes through the controller and so never touches infrastructure.
- **Stack state** (CTRL-STACK-011). A pure function maps a status and the running action (if any) to one of `docker-unavailable`, `stopping`, `starting`, `down`, `up`, `degraded`, in that precedence: Docker not answering; a stop running; a launch running; no long-running container `running`; every long-running container ready; some long-running container still `starting` its healthcheck with none exited, restarting or unhealthy; otherwise `degraded`. The dashboard shows it; `cohostctl launch` uses the same readiness test.

The stack state is computed from Compose, not from the heartbeat tracker, because only Compose can say whether Docker answers and which containers exist, infrastructure included, and because it works while Redis is down. The tracker keeps the per-service detail; the Compose healthcheck of each application container is itself heartbeat freshness (CTRL-CHECK-001), so the two views agree.

## Heartbeat contract and health derivation

### Publisher (`packages/bus/src/heartbeat.ts`)

`startHeartbeat(bus, { service, version?, mode, deps, detail?, intervalMs?, log? })` returns `{ ready(), degraded(detail?), stop() }`.

- Payload fields: `service`, `instance` (the bus consumer name, `hostname-uuid8`), `pid`, `version` (option, else `COHOST_VERSION`, else `dev`), `startedAt` (`processStartedAt`, the module-load time, `heartbeat.ts:47`), `state` (`starting`, `ready`, `degraded`, `stopping`), `deps` (`ok`, `down`, `n/a` per name), `mode` (`live`, `mock`, `off` by convention, a free string in the schema), optional `detail`, `intervalMs` (`heartbeat.ts:68-85`).
- Cadence: one `starting` publish at call time, a steady `setInterval` of `intervalMs`, an immediate publish on `ready()` or `degraded()`, and a watcher at `min(1000, intervalMs)` that republishes if `[state, deps, mode, detail]` changed (`heartbeat.ts:98-109`). Both timers are `unref`ed.
- A standing `detail` option is published in every state, including `starting` and after `ready()`. Precedence: explicit `degraded(detail)`, then `dependency down: ...`, then the standing detail (CTRL-HEARTBEAT-009).
- `intervalMs` is `HEARTBEAT_INTERVAL_MS` floored when positive and finite, else 5000 (`heartbeat.ts:49-52`; `.env.example:53-54`).
- Dependency-derived degradation: if the base is `ready` and any dep is `down`, the published state is `degraded` with detail `dependency down: a, b`, unless an explicit detail was given (`heartbeat.ts:70-72`). An explicit `degraded(detail)` keeps its own detail. A service that is still `starting` stays `starting` even with a dep down.
- Shutdown: `stop()` is registered with `beforeShutdown` (`heartbeat.ts:117`, CTRL-HEARTBEAT-005). The shutdown sequence itself is event-bus's: `onShutdown` (`packages/bus/src/index.ts:242-257`) awaits all registered hooks, capped at 2 s, and then runs the service's own callback and `process.exit(0)` (BUS-STOP-002). So the `stopping` heartbeat is only sent if the service calls `onShutdown`; there is no handling of other exit paths (crash, `process.exit`, SIGKILL).
- Failure: a rejected `publishHealth` is logged at warn and swallowed (`heartbeat.ts:87-90`).
- `tracked(fn, set)` wraps an async call to feed dep status (`heartbeat.ts:33-38`).
- Transport (owned and specified by event-bus, BUS-STREAM-004 and BUS-HEALTH-001 to 004): `Bus.publishHealth` validates against the zod schema and `XADD`s to `cohost:health` with `MAXLEN ~ 1000`; `Bus.publish("service.heartbeat")` throws (`packages/bus/src/index.ts:49,64-74`). `Bus.tailHealth` is a non-group `XREAD` tail; `Bus.recentHealth(n)` is `XREVRANGE` reversed to oldest-first.
- `heartbeat.ts` and `index.ts` import each other (`heartbeat.ts:2`, `index.ts:259`). It works because `beforeShutdown` is only called at runtime, not at module evaluation.

Every app service owns a `src/health.ts` exporting a `HeartbeatSpec` (service, mode, deps) and calls `startHeartbeat` itself; those files belong to each service's segment. The dashboard's own heartbeat is in `services/dashboard/src/index.ts:29`.

### HealthTracker (`packages/control/src/health.ts`)

State precedence in `derive` (`health.ts:102-116`), evaluated with the tracker's own clock (`Date.now` by default):

1. `unknown` if no heartbeat has ever been seen for a known name.
2. `crash-looping` if at least 3 distinct `startedAt` values were first seen within the last 60 s (`CRASH_LOOP_RESTARTS = 3`, `CRASH_LOOP_WINDOW_MS = 60000`); this beats everything else, including silence.
3. `down` if the last heartbeat is `stopping` or its age exceeds `10 x intervalMs` (`DOWN_FACTOR`).
4. `stale` if age exceeds `3 x intervalMs` (`STALE_FACTOR`).
5. `degraded` if the last heartbeat state is `degraded` or `starting`, or any dep is `down`.
6. `up` otherwise.

Details worth knowing:

- Age is `now - receivedAt`, where `receivedAt` is the local time of ingest for live heartbeats. `ingest(hb, at = now())` takes `at` as a parameter, and `seed(history)` passes each record's `ts` (the publisher's bus-stamped time) as `at` (`health.ts:61,77-79`). So clock skew is irrelevant only for live ingest; seeded history inherits any skew between the publishing and observing hosts. The comment "its own receive-time clock (so clock skew between containers is irrelevant)" (`health.ts:44-45`) is accurate for the live path only.
- A replayed older heartbeat does not overwrite a newer one (`health.ts:68`); start history is trimmed to the 60 s window except for the current process's start (`health.ts:66-70`). Consequently a long-running service reports `restarts: 0`, and a service with exactly one start inside the window reports `restarts: 1`.
- `snapshot()` returns the known list (default `KNOWN_SERVICES`) plus any other name that has sent a heartbeat. `onChange` listeners are called only when the per-service key (derived state, restarts, heartbeat state, mode, detail, deps, instance) changes; `tick()` re-derives time-based transitions (`health.ts:81-82,119-129`). `lastSeenAgeMs` is deliberately not in the key.
- The dashboard feeds it with `recentHealth(500)` then `tailHealth` and runs `tick()` every second (`services/dashboard/src/feed.ts:44-55`); `GET /services` returns the snapshot (`routes.ts:66-70`) and WebSocket clients get a `services` message on change.

### Container healthcheck (`healthcheck.ts`)

`isHealthy(service, recent, now)` takes the newest heartbeat for the service from the list and is true iff it exists, is not `stopping`, and `now - latest.ts < 3 x intervalMs` (`healthcheck.ts:11-15`). The script reads `recentHealth(200)`, exits 0 or 1, exits 2 without an argument, and hard-exits 1 after 4 s (`healthcheck.ts:18-33`). It is wired as `node packages/control/dist/healthcheck.js $$SERVICE` in the `x-ts-service` anchor (`docker-compose.yml:30-35`, interval 10 s, timeout 5 s, retries 3, start period 30 s); `SERVICE` is baked in by the Dockerfile (`Dockerfile:20`).

Unlike the tracker, the healthcheck compares the heartbeat's bus-side `ts` (publisher time) with the local clock, so container clock skew matters here. With roughly ten services beating every 5 s, 200 records covers about 100 s, comfortably more than the 15 s freshness bound; a much shorter `HEARTBEAT_INTERVAL_MS` would shrink that window.

## cohostctl and configuration

CLI (`cli.ts`): `cohostctl status [service]`, `cohostctl start|restart <service> [--mode resume|fresh] [--isolated]`, `cohostctl stop <service>` (no options), `cohostctl consolidate`, and the stack commands `cohostctl launch`, `cohostctl stop-all` and `cohostctl restart-all` (CTRL-CLI-001, CTRL-CLI-010 to 012). The stack commands take no arguments or options; `launch` and `stop-all` never open the bus (the bus is not up before a launch and goes down during a stop), print the phases and the final per-container status, and exit 0 or 1; `stop-all` ends with a hint that `cohostctl consolidate` can tidy viewer notes; `restart-all` opens the bus to audit each restart with `by: "cohostctl"`. Parsing uses `node:util.parseArgs` (`cli.ts:30-55`); any parse problem raises `UsageError` and exit code 2 with the usage text. Exit codes: 0 success, 1 refusal or failure (`cli.ts:64`), 2 usage.

- `status` builds a throwaway `HealthTracker` with known = manifest entries that are not infra and have a `pnpmFilter`, seeds it from `bus.recentHealth(200)` and prints `service  state  mode  Ns ago` per row (`cli.ts:72-81,109-114`). Because the known list excludes infra and compose-only units, `cohostctl status redis` reports `unknown service` and exits 1.
- `main()` constructs `new Bus("cohostctl")` lazily, on first use by `status`, `start`, `stop` or `restart` (never for `consolidate`), always builds a `ComposeRuntime` (no runtime selection and no `CONTROL_RUNTIME` or `CONTROL_PROCESS_MODE` setting exists), passes `by: "cohostctl"` and `advanced` from `CONTROL_ADVANCED === "1"`. It stops the bus in `finally` when it was opened.
- `consolidate` runs the Compose `consolidate` one-shot (deployment DEPLOY-COMPOSE-018; the memory service's viewer-note pass, `MEM-CONSOL-012`) through `ComposeRuntime.consolidate`, which executes `docker compose run --rm -T consolidate` and waits for it (CTRL-RUNTIME-010, CTRL-CLI-008). It is a job, not a service: it is not in the manifest, takes no service name or options, and bypasses `ServiceController`, so it has no guards, no consolidator-group reset and no `service.lifecycle` audit record. It also never opens the bus, so it works after the owner has stopped the whole stack (`docker compose down`, `cohostctl stop-all`, the dashboard's Stop button), which is when it is useful (CTRL-CLI-009). Because it can take minutes (one model call per consolidated batch), its exec timeout is 30 minutes instead of the 120 s the lifecycle verbs use. The pass is best-effort: the memory service catches up at its next start (`MEM-CONSOL-013`), so a failure is reported (exit 1) and nothing else changes. `docker compose run` starts `postgres` and `ollama` if they are down and leaves them running.
- It runs as the invoking user and does not read `CONTROL_ENABLED` or `CONTROL_TOKEN` (those only gate the dashboard's HTTP surface).
- `main()` runs only when `process.argv[1]` ends with `cli.js` (`cli.ts:125`). Since `index.ts` re-exports `cli.js`, importing the package from another entry script runs nothing, but the check is a suffix match, so any other entry script named `cli.js` that imports `@cohost/control` would also start the CLI. Running the TypeScript source under tsx does not trigger it either (the suffix would be `cli.ts`), so `cohostctl` only works from the built `dist`; the README invokes it as `pnpm --filter @cohost/control exec cohostctl` (`README.md:321-322`).

Configuration (`config.ts`): `loadControlConfig(env)` is used by the dashboard. `CONTROL_ENABLED` must be exactly `1`; otherwise `{ enabled: false }`. Enabled requires a non-blank `CONTROL_TOKEN`. Defaults are `CONTROL_BIND` unset means `127.0.0.1` with `bindExplicit: false`, `CONTROL_ADVANCED` off. The config carries no runtime choice. `bearerOk(header, token)` compares SHA-256 digests with `timingSafeEqual` (`config.ts:43-50`). `isLoopback` accepts `localhost`, `::1`, and anything starting with `127.` (`config.ts:20-22`).

| Env var | Read by | Meaning |
|---|---|---|
| `CONTROL_ENABLED` | `loadControlConfig` (dashboard) | `1` turns the lifecycle routes and token gate on |
| `CONTROL_TOKEN` | `loadControlConfig` | required bearer secret when enabled |
| `CONTROL_BIND` | `loadControlConfig`, dashboard `index.ts:50` | listen address; loopback default only when enabled |
| `CONTROL_ADVANCED` | both | `1` allows redis and postgres mutations |
| `REDIS_URL` | `Bus` (via `@cohost/config` `urls.redis()`), CLI, healthcheck | bus address |
| `HEARTBEAT_INTERVAL_MS`, `COHOST_VERSION` | `heartbeat.ts` | beat interval (default 5000) and reported version (default `dev`) |

Consumers of this segment: dashboard `control.ts` (`setupControl`, warns on non-loopback bind and on `CONTROL_ADVANCED`), `routes.ts` (404 when disabled, 401 without a bearer, body parsing of `mode` and `isolated`, refusal-to-status map unknown 404 / forbidden 403, and the stack routes), `feed.ts`, `index.ts`; and the compose healthcheck. Those files are specified in the dashboard segment; this segment owns the semantics they delegate to. The bearer gate guards mutations only: the LAN is the trust boundary, so health reads (`GET /services`, the WebSocket feed) stay open.

## Divergence from the original plan

Compared with `docs/plans/control-plane.md` (written at `95afa19`), what landed:

| Plan | Landed | Note |
|---|---|---|
| Option A: dashboard-embedded supervisor on a UI-agnostic core, `cohostctl` later (§5) | Same | `packages/control` plus dashboard plus `cohostctl` |
| `ServiceRegistry` with `requires`, `externals`, `isolationEnv` (§5, §7.1) | Flat `SERVICE_MANIFEST` with `groups`, `defaultMode`, `infra`, `self`, `isolatedEnv` and an optional `requires`; no `externals` | `requires` applies to isolated starts only (CTRL-GUARD-008); `externals` is not provided |
| Compose-only units not discussed as controllable | `ollama`, `tts`, `stt` added as manifest units | |
| `service.heartbeat` schema, `startHeartbeat` returning `ready/degraded/stop`, separate `cohost:health` stream (§6) | Same; options take `mode` and `deps` as values or getters instead of `getState` | `HEARTBEAT_INTERVAL_MS` env added |
| `mode` label examples `live`, `null`, `mock` | Convention is `live`, `mock`, `off` | schema accepts any string |
| Derived states and 3x/10x/60 s thresholds (§6) | Identical | `starting` counts as degraded |
| Filter heartbeats from dashboard feed and memory (task 1.3) | Unnecessary: heartbeats are on their own stream | |
| Compose healthchecks for app services (G6, task 1.3) | Landed (`docker-compose.yml:30-35`) | |
| Surface compose restart loops by reading `docker compose ps` (task 2.3) | Not implemented | crash-loop is inferred from `startedAt` only |
| `Runtime.status?(id)` (design.md) | Not implemented | health comes only from heartbeats |
| `cohostctl status/start/stop/logs/run --isolated`, optional Ink TUI (§4B, task 5.1) | `status`, `start`, `stop`, `restart` with `--isolated` flag, plus `consolidate` (a one-shot job, not a service action); no `logs`, no `run`, no TUI | |
| "Start (isolated)" with dependency closure (§7.2) | Isolation flag only; no closure | closure intended (CTRL-GUARD-008) |
| `POST /control` token gate, loopback bind, manifest-only ids, fixed argv (§9) | Landed | gate wiring is in dashboard |
| `control` event `pause`/`resume` with `target` (§6) | Landed in bus (other segments consume) | not part of this segment's code |

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where heartbeats travel | Separate stream `cohost:health`, `MAXLEN ~1000`, `publish` refuses `service.heartbeat` | Same `cohost:events` stream | Comment `packages/bus/src/index.ts:10`: heartbeats live on their own capped stream "so they never evict domain events" (20k cap); `publish` refuses the type at `index.ts:49`; commit `691b079`; `docs/plans/control-plane.md` §6. |
| Where the tracker's derived states live | Computed locally in each observer, never published | Supervisor publishes status events | Comment `health.ts:43-47` states derived states are never published. Raw heartbeats are the single source of truth; every observer (dashboard tracker, `cohostctl status`) derives states from them with its own clock, so no observer has to be running for another to work, and no derived-state event can be fed back into the stream it was derived from. |
| Staleness clock | Observer's receive time for live ingest; publisher `ts` only for seeding history and in the healthcheck | Trust publisher `startedAt`/`ts` throughout | Comment `health.ts:43-45`: the tracker uses "its own receive-time clock (so clock skew between containers is irrelevant)"; `health.ts:61,77`. The seeding and healthcheck exceptions are Open Questions 2 and 3. |
| Crash-loop signal | 3 distinct `startedAt` in 60 s, outranks all other states | Parse `docker compose ps` restart counts | Uses only what heartbeats already carry: a new `startedAt` means a new process, whichever runtime (compose, process runtime, a manual `pnpm dev`) restarted it, and the observer needs no Docker access. Outranking every other state keeps a service that keeps coming back `ready` from looking healthy. `health.ts:13-16,107-110`. Reading `docker compose ps` restart counts is deferred (below). |
| Controller as UI-agnostic class with injected runtime, group resetter, audit | `ServiceController` | Logic inside dashboard routes | Comments `controller.ts:49-52` ("UI-agnostic: the dashboard and cohostctl share it") and `cli.ts:3` ("a second client of the same ServiceController the dashboard uses"). |
| Command construction | Manifest-only ids, `execFile`/`spawn` with fixed argv, `shell: false`; id re-checked in each runtime | Accept arbitrary service names; shell strings | Comments `manifest.ts:1-5` (nothing from a request reaches an argv except by picking a manifest entry), `runtime.ts:30` and `runtime.ts:91` (no shell, fixed argv); `add-service-control/design.md` decision 2. Each runtime re-checks the id against its manifest because the runtimes are exported from `@cohost/control` and can be called without the controller; the argv guarantee then holds at the point where the argv is built, not only at the controller (defence in depth; `runtime.ts:63,136,157`). |
| Fresh vs resume | `fresh` resets groups to `$` after stop, before start; default fresh for every service that owns groups except memory, resume for memory | Always resume; reset via `fromNow` subscribe option | Mechanism and defaults per `add-service-control/design.md` decision 3. Owner decision 2026-11-01: a restarted co-host must not act on stale backlog, while memory keeps what it missed; `controller.ts:82-93`, `manifest.ts:41-46`. |
| Who decides where a restarted service reads from | The service's bus start mode (`latest` for every service except memory, `resume` for memory); the controller's `fresh` / `resume` is an operator override that changes behaviour only for `resume` subscribers | Controller `fresh` start as the only way to skip backlog | Owner decision 2026-11-01: a compose or crash restart bypasses the controller, so the skip has to live in the subscription (event-bus BUS-SUB-010, BUS-SUB-011). |
| Isolated start closure | Manifest `requires`, followed transitively, only for isolated starts (CTRL-GUARD-008) | No closure (start only the named unit); closure for every start | Owner decision 2026-11-01: an isolated cortex is useless without salience and affect on the bus (`openspec/specs/cortex/spec.md:111-112`, plan §7.2); a normal start must not pull in services the operator did not ask for. |
| Isolation env under compose | Pass-through `VAR: ${VAR:-}` entries for each preset variable in the compose `x-ts-service` environment (CTRL-RUNTIME-009) | Bake presets into separate compose services or override files | Owner decision 2026-11-01: pass-through keeps one service definition and lets an unset variable fall to the `config.yaml` default. |
| Ownership of heartbeat transport and shutdown mechanics | event-bus owns the `cohost:health` transport and the `onShutdown` sequence (BUS-STREAM-004, BUS-HEALTH-001, BUS-STOP-002); this segment owns heartbeat meaning and the heartbeat's `beforeShutdown` registration (CTRL-HEARTBEAT-005). CTRL-HEARTBEAT-007 is retired; the number is not reused. | Restate the transport and shutdown statements here | Owner decision 2026-11-01: one spec line per behaviour. |
| Infra handling | `redis`, `postgres` refused unless `CONTROL_ADVANCED=1`, always resume | Never controllable; always controllable | Behaviour per comment `manifest.ts:20` and commit `1d316ff`. Stopping Redis takes the whole bus down, including the dashboard's feed and the audit event for the action itself, and stopping Postgres takes memory's store away; those are deliberate operator acts, so they need an explicit opt-in. Infra owns no consumer groups, so it always starts in `resume`. `controller.ts:68,77`. |
| The dashboard in the manifest | Not a unit: the dashboard runs on the host outside Compose, so the manifest has no `dashboard` entry and no `self` flag (CTRL-GUARD-002 retired) | Keep it as a `self` unit that can only be started | Owner decision: Compose has no dashboard service, so `docker compose up -d dashboard` has nothing to start; the controller never spawns host processes. |
| Where stack actions live | `StackController` in this package, used by the dashboard and `cohostctl` | Written in the dashboard routes; a shell script | Owner decision: one implementation for both clients, beside the per-unit controller and the compose runtime it builds on. |
| Launch command | `docker compose up -d --remove-orphans`, then a readiness wait on `docker compose ps` | `up -d --wait` (Compose's own wait); start the manifest units one by one through `ServiceController`; `up --build` | `--wait` also waits on the `models` one-shot, which exits by design, and how it treats an exited one-shot has differed between Compose releases; a controller-side wait reports each service that is not ready and needs no particular Compose release; unit-by-unit starts would skip infrastructure and the one-shots and reimplement Compose's dependency order; `--build` would rebuild every image on every launch. `--remove-orphans` clears a container left by a service the file no longer defines. |
| Readiness signal | Container state and Compose healthcheck from `docker compose ps` | The heartbeat tracker | Works with Redis still coming up and covers infrastructure, which sends no heartbeat; the application healthcheck is heartbeat freshness, so the signals agree. This takes up part of the deferred "compose restart counts from `docker compose ps`" item: container status and health are read, restart counts are not. |
| Stop-all command | `docker compose stop` | `docker compose down`; stop only application services | `stop` keeps containers, networks and volumes, so the next launch is quick and nothing is lost; every service still shuts down gracefully, which memory needs to record `notes.shutdown_run_owed`. Stopping infrastructure too frees the GPU memory Ollama holds while the owner is not streaming. |
| Restart-all scope | Running application units only, one by one through `ServiceController` in default modes | `docker compose restart` (every container) | A whole-project restart would bounce Redis (and with it every bus connection and the dashboard feed) and Ollama (a slow model reload) for no gain; going through the controller keeps fresh-mode group resets and one audit record per service. |
| Stack actions and `CONTROL_ADVANCED` | Not required | Require it for launch and stop-all, which touch Redis and Postgres | `CONTROL_ADVANCED` guards stopping one piece of infrastructure under a running stack; a whole-stack launch or stop is the purpose of the button, and requiring the flag would make Launch unusable by default. |
| Docker binary | `COHOST_DOCKER_BIN`, else `docker`, else `docker.exe` on `PATH` | Always `docker`; ask the owner to symlink `docker.exe` | The owner's first test machine is WSL2 with Docker Desktop, where `docker` may be missing and the Windows CLI is the only one; a lookup order keeps native Linux unchanged and needs no shell setup. The argv stays fixed, so the allow-list guarantee is unchanged. |
| Compose working directory | The workspace root for both clients | The process cwd | The dashboard and `cohostctl` can be started from any directory (`pnpm --filter` runs in the package directory); Compose's file, `.env` (`COMPOSE_FILE`, `COMPOSE_PROFILES`) and project name all hang off the directory. |
| Audit is best effort | Swallow audit errors | Fail the action when audit fails | Comment `controller.ts:97`: "the audit is best effort (e.g. bus down while stopping redis)". |
| Audit `detail` on success | Copy any runtime `detail` into the audit record, success included (CTRL-GUARD-007) | `detail` only on failure | Owner decision 2026-11-01: success details such as `pid <n>` are useful audit data. |
| Runtimes | Compose is the only runtime; no selection setting | A host-process runtime (`pnpm --filter ... dev|start`) selectable by `CONTROL_RUNTIME` | Owner decision 2026-11-08: "no service should be handling other services". A host-process runtime kept its pids in the memory of the controlling process, so another `cohostctl` invocation or a restarted dashboard could not stop what it had started; compose owns process lifetime and state. Local development runs services directly with `pnpm dev` and does not use the control plane. |
| Compose runtime via CLI | `docker compose` through `execFile` | Docker Engine API | `add-service-control/design.md` decision 1: "CLI first; Engine API deferred". |
| Healthcheck as a Node script reading the bus | `healthcheck.js` | HTTP `/health` per service | Only voice and the dashboard run an HTTP server, and the heartbeat already says whether a service is alive and not stopping, so one script reading `cohost:health` serves every app service with no per-service endpoint. `docker-compose.yml:41-42`, plan §2.2. |
| Heartbeat timers | One steady interval plus a faster change watcher (at most 1 s) | Publish on every dep mutation | Comments `heartbeat.ts:19` (deps are "re-read every check so changes publish immediately") and `heartbeat.ts:106` (one timer for the beat, one at most 1 s for changes). Polling `mode` and `deps` (values or getters) keeps the contract to one `startHeartbeat` call per service: a service changes state by changing what its getter returns, with no change notifications wired through its code, and the watcher bounds the delay to at most 1 s. |

## Open Questions & Future Decisions

### Resolved
1. Separate health stream rather than the events stream (plan §11 question 3): resolved as separate, `packages/bus/src/index.ts:10-12`.
2. Runtimes (plan §11 question 1): compose only; the host-process runtime was removed by owner decision 2026-11-08.
3. The code comments that name this segment's intent (`manifest.ts:4`, `health.ts:46`) point at `docs/intent/control-plane/control-plane-specs.md`.

### Observed, unexplained, or debt
1. **CLI creates a `Bus` before parsing arguments** (`cli.ts:98`, parse happens at `cli.ts:115`), so even usage errors open a Redis connection first.
2. **Seeding uses publisher timestamps.** `seed` and `cohostctl status` pass `h.ts` (bus-stamped on the publisher) as receive time (`health.ts:77-79`, `cli.ts:112`), so skew shifts reported ages right after a dashboard start, and `status` is only a snapshot of the last ~200 heartbeats rather than a live subscription.
3. **Healthcheck skew sensitivity** (`healthcheck.ts:14`): compares bus `ts` with local `Date.now()`. A container with a clock more than about 15 s off its Redis publisher host would flap unhealthy.
4. **`stopping` heartbeat depends on a clean `onShutdown`.** Crashes, `process.exit` or SIGKILL publish nothing; those cases rely on staleness (3x then 10x interval) to turn `down`. Crash-looping services restarted fast also show `crash-looping` only after 3 starts.
5. **`@cohost/config` is a declared dependency and tsconfig reference of `packages/control` but is never imported** (`package.json:14`, `tsconfig.json:4`). `heartbeat.ts` in `packages/bus` imports only the `Logger` type from it. The stack controller's workspace-root `cwd` (CTRL-STACK-001) is its first real use.
6. **Circular import** between `packages/bus/src/index.ts:259` and `heartbeat.ts:2`; safe only while `beforeShutdown` is called at runtime.
7. **Duplicate service lists.** `KNOWN_SERVICES` (`health.ts:9`) versus manifest-derived list (`cli.ts:110`); only a unit test ties them (`manifest.test.ts:23`, CTRL-MANIFEST-005).
8. **Test coverage gaps.** No test for `cli.ts` `main()` or the entry guard (CTRL-CLI-004, CTRL-CLI-005; `cli.test.ts` builds its own controller with `by: "cohostctl"`, so the CLI's audit wiring is unexercised), for the heartbeat payload fields `version`, `startedAt`, `pid` and `instance` (CTRL-HEARTBEAT-001), for `isLoopback` (part of CTRL-CONFIG-002), for the compose `cwd`/timeout (part of CTRL-RUNTIME-001), for a replayed older heartbeat during `seed` (part of CTRL-HEALTH-007), or for a healthcheck against a stale-but-not-yet-down service end to end; `healthcheck.test.ts:40` needs a built `dist` and Redis and is skipped without Redis.
9. **Heartbeat state published by the helper is already `degraded` for a down dep**, so the tracker's own "any dep down" rule (`health.ts:113`) is redundant for helper users and only matters for heartbeats hand-published by other publishers.
10. **CTRL-CHECK-003 lives in `docker-compose.yml`** (deployment). It has no test, and the compose file carries no `@spec` annotation.

### Deferred
1. Docker Engine API instead of the CLI (deferred in `add-service-control/design.md`).
2. Surfacing compose restart counts from `docker compose ps` (plan task 2.3). The stack controller reads container status and health from `docker compose ps`, not restart counts.
3. Coordination between a dashboard and a concurrent `cohostctl` stack command. The dashboard serialises its own actions; a second process is not locked out, and Compose's behaviour under two overlapping commands decides the outcome.

## References

Files in this segment (git `49ba935`):
- `packages/control/src/index.ts`, `cli.ts`, `config.ts`, `controller.ts`, `health.ts`, `healthcheck.ts`, `manifest.ts`, `runtime.ts`, `docker.ts`, `stack.ts`
- `packages/control/test/cli.test.ts`, `config.test.ts`, `controller.test.ts`, `health.test.ts`, `healthcheck.test.ts`, `manifest.test.ts`, `runtime.test.ts`
- `packages/control/package.json`, `packages/control/tsconfig.json`
- `packages/bus/src/heartbeat.ts` (tests: `packages/bus/test/bus.test.ts:136-275`, `packages/bus/test/shutdown.fixture.ts`)
- `docs/plans/control-plane.md` (original plan, compared above)

Other segments (direction):
- event-bus: this segment depends on `Bus.publishHealth`, `tailHealth`, `recentHealth`, `resetGroup`, `onShutdown`/`beforeShutdown`, and the `service.heartbeat` and `service.lifecycle` schemas in `packages/bus/src/events.ts`; event-bus documents the schema and points here for semantics.
- config: `heartbeat.ts` imports the `Logger` type; `Bus` takes its Redis URL from `urls.redis()`. `@cohost/config` is otherwise unused here. Presets rely on `${VAR:-default}` keys in `config/config.example.yaml`.
- dashboard: consumes `HealthTracker`, `ServiceController`, runtimes, `loadControlConfig`, `bearerOk`, `isLoopback` (`services/dashboard/src/control.ts`, `routes.ts`, `feed.ts`, `index.ts`); dashboard owns the HTTP routes, token prompt and UI.
- chat, eyes, ears, mouth, salience, affect, memory, cortex, voice, avatar: each owns `src/health.ts` and its `startHeartbeat` call; their isolation presets (`CHAT_SOURCE`, `VISION_ENABLED`, `EARS_SOURCE`, `MOUTH_DISCORD_ENABLED`, `MEMORY_STORE`/`MEMORY_EMBEDDER`, `LLM_PROVIDER`, `VOICE_ENGINE`, `AVATAR_DRIVER`) are named in this segment's manifest but implemented by the backends' segments (model-backends, memory, voice, chat, ears, eyes, avatar). salience, affect and cortex also consume `control` `pause`/`resume` (not part of this segment).
- deployment: `docker-compose.yml:30-35` and `Dockerfile:20` wire the healthcheck and `SERVICE`.

External: Redis Streams (`cohost:events`, `cohost:health`), `docker compose` CLI, `pnpm`, Node `child_process`, `util.parseArgs`, `crypto`.

OpenSpec (frozen, historical; the LID specs here supersede it per `CLAUDE.md` § Specs):
- `openspec/specs/service-health/spec.md` (baseline, 5 requirements: heartbeat contract, derived states, crash-loop, snapshot, compose healthcheck)
- `openspec/specs/service-control/spec.md` (baseline, 7 requirements: runtime adapters, manifest-only ids, start modes, protected services, gating, audit event, `cohostctl`)
- `openspec/specs/bus/spec.md` (health stream, heartbeat helper, `service.lifecycle` in the catalogue)
- `openspec/specs/cortex/spec.md` (isolation preset and closure)
- Archived changes: `openspec/changes/archive/2026-11-01-add-service-health/`, `openspec/changes/archive/2026-11-01-add-service-control/` (including `design.md`), `openspec/changes/archive/2026-11-01-add-isolated-backends/`

Spec-to-OpenSpec mismatches were captured as specs CTRL-RUNTIME-009 and CTRL-GUARD-008.
