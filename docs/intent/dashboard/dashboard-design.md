---
parent: high-level-design
prefix: DASH
---

# dashboard

Describes the intended design and the code that realizes it; where the code lags, the text says so and names the gap spec. Each row in Decisions & Alternatives cites the evidence for its rationale, or gives the engineering reason the design rests on where no recorded source exists. Specs: [dashboard-specs.md](dashboard-specs.md). See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/dashboard` is the operator's window onto the stack and the one place a human can push things into it. It is a standalone program the owner starts on the host, outside Docker Compose, before anything else: once it is up, its Launch button brings up the whole Compose stack, and it can stop the stack and restart all or one of its services (Host process and stack control, below; [decision doc](decisions/standalone-dashboard.md)). One Node process serves a single static page and a small JSON/HTTP API on port 3000, plus a WebSocket that mirrors the Redis event stream, the service-health stream and the stack's state to the browser. It is also the stack's browser audio sink: the page plays the co-host's voice and reports `voice.playing` / `voice.done` back, so an OBS Browser Source pointed at `/?sink=1` puts the voice on stream without virtual audio cables (`services/dashboard/src/index.ts:1-10`).

The dashboard has almost no logic of its own. It publishes `control`, `voice.playing`, `voice.done`, `inject.request` and perception events onto the bus, proxies audio from `voice`, folds heartbeats through `HealthTracker` from `@cohost/control`, delegates start/stop/restart to `ServiceController` and launch/stop-all/restart-all to the stack controller from the same package (owned by the control-plane segment). This segment owns the HTTP surface, the listeners, the gating rule, the stack panel, the injection panel and its upload store, the feed, and `public/index.html`.

Security posture follows the project's trust boundary: the operator's LAN, with a control surface that is host-local by default. The full surface binds to `DASHBOARD_HOST`, else `CONTROL_BIND`, else `127.0.0.1`, in both control modes (DASH-CTRL-003). With `CONTROL_ENABLED` unset, every route except the Viewers routes is open, and the full surface must stay on loopback: a non-loopback address without control mode fails startup (DASH-HOST-007). With `CONTROL_ENABLED=1` a shared bearer token guards the mutating routes, the stack routes included (`control.ts:17-45`, `routes.ts:24-28`). The owner, running cohost on a dedicated PC, sets `DASHBOARD_HOST=0.0.0.0` to open the full dashboard from another machine; the token requirements then hold the stack actions and viewer notes behind their secrets, and the dashboard warns that the tokens cross the network in cleartext. Control mode guards mutations only. Reads (`/ws`, `GET /personality`, `GET /services`, `GET /stack`, `GET /audio/*`) stay open, and so does `POST /sink`, because the OBS Browser Source that serves as the stream's audio sink cannot present a token. A second listener on all interfaces serves only the ungated routes a sink page needs (Listeners, below). Viewer notes are the exception to the open reads: they never travel on `/ws`, and the Viewers page routes need their own token, `VIEWERS_TOKEN`, in both modes (Viewers page).

The dashboard is the only path by which a browser or other player reaches voice's audio: browsers and OBS fetch `/audio/<id>.wav` through the dashboard proxy, the dashboard fetches it from voice's port, which Compose publishes on the host's loopback address only, and in-network sinks such as ears fetch `http://voice:8700` directly.

## Process wiring

`index.ts` (`services/dashboard/src/index.ts`), in order:

1. `loadConfig()`, `new Bus("dashboard")`, `startHeartbeat(bus, {...dashboardHealth, log})` (`:26-29`). `dashboardHealth` is a constant spec: service `dashboard`, mode `live`, `deps: {}` (`health.ts:5`).
2. `new HealthTracker()`; `PORT` from env `PORT`, else `DASHBOARD_PORT` (the `.env` value the installer prints, DASH-HTTP-009; `host.ts` `resolvePorts`), else `cfg.dashboard.port` (default 3000, `packages/config/src/schema.ts:184`); `VOICE = urls.voice()` (`:30-33`).
3. `setupControl(process.env, bus, log)` reads the `CONTROL_*` and `DASHBOARD_HOST` env and returns `{control?, bind}`, where `bind` is the full-surface address: `DASHBOARD_HOST`, else `CONTROL_BIND`, else `127.0.0.1`, each ignored when empty (DASH-CTRL-003). It throws, aborting startup, when `CONTROL_ENABLED=1` without a token, and when the address is not loopback while control mode is off (DASH-HOST-007).
4. `public/index.html` is read once at startup from `<dist>/../public` (`:36`); edits need a restart.
5. The upload limits from `INJECT_*` env (`uploads.ts`); uploads themselves live in Redis, not in the process.
6. A `StackService` (`stack.ts`) holds the stack state: the latest status probe, the one action slot, the last result. Its controller is an `ObservedStackController` (a control-plane `StackController` whose every status read is serialised and reported to the service); the service hands it its phase callback. `createDashboardHandler({...})` builds the routes over the service, and a `WebSocketServer({noServer: true})` is shared by both listeners. Each connection calls `feed.onConnection`, and `feed.start()` begins following the bus. `startFeed` (`feed.ts`) runs `feed.start()` in the background: when the health seed fails because Redis is unreachable, the feed logs a warning, marks the bus `unreachable`, and retries the seed with the bus's backoff (250 ms doubling to 30 s) until it succeeds, while the page, the stack routes and the stack state keep working (DASH-HTTP-012). `serveClient` awaits each connection's replay: when it fails it logs the error and keeps the socket open without the replay, so a page opened while Redis is down still receives the services and stack snapshots and every later push.
7. `startListeners` (`host.ts`) listens on the full-surface address and port and on all interfaces at `DASHBOARD_LAN_PORT` (default 3001), sharing the handler and WebSocket server (DASH-HOST-001); a listener that cannot bind (for example a port still held by a container from an older Compose file) logs `fatal` naming the address and port and exits non-zero (DASH-HOST-003). The heartbeat becomes `ready` only once both listeners are listening (DASH-HTTP-009), and the startup log carries the full-surface URL from the address and port actually bound and the LAN port (DASH-HOST-006).
8. The stack prober (`StackService.start`) runs the stack controller's status at startup, every 5 s and after each action phase, and pushes changes to `/ws` clients (DASH-STACK-007). A launch's readiness wait supplies its own statuses while it polls; the 5 s probe is skipped then, and no two status reads overlap.
9. `onShutdown` stops the feed and the stack prober, closes the WebSocket server and both HTTP listeners, stops the bus. The heartbeat's `stopping` is published by `startHeartbeat`'s own shutdown hook (control-plane). Shutting the dashboard down never stops the stack: a stack left running keeps running, and a restarted dashboard picks its state up again from Compose and the bus.

Environment read by this segment: `PORT`, `DASHBOARD_PORT`, `DASHBOARD_LAN_PORT`, `DASHBOARD_HOST`, `VOICE_URL` / `VOICE_PORT` (via `urls.voice()`, `packages/config/src/index.ts:163`), `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_BIND`, `CONTROL_ADVANCED` (`packages/control/src/config.ts:24-37`), `INJECT_MAX_IMAGE_BYTES`, `INJECT_MAX_AUDIO_BYTES`, `INJECT_TTL_MS` (default 300000; `uploads.ts`), `VIEWERS_TOKEN` (Viewers page; env only), plus the heartbeat interval env owned by control-plane.

## HTTP surface

All routes are handled by one function, `createDashboardHandler` (`routes.ts:36-141`). Paths are matched in the order below; a thrown error anywhere, including a request URL that does not parse, is logged and answered `500` with the error text, or `413` for an oversized body; when response headers were already sent the connection is cut instead of answered (`:133-139`, `sendUnlessStarted`).

| Route | Behavior | Gated when `CONTROL_ENABLED=1`? | Evidence |
|---|---|---|---|
| `GET /` | the page with `__COHOST_NAME__` replaced by `cohost.name` (every occurrence, via split/join) | no | `routes.ts:47, 52-56` |
| `GET /audio/*` | fetch `${voiceUrl}${pathname}` from voice, return its status and content-type (default `audio/wav`), `cache-control: no-store`; the whole upstream body is buffered before the status and headers are written, so a failed read is a `500` (DASH-HTTP-004) | no | `:58-64` |
| `POST /inject/image`, `/inject/audio` | store the upload in Redis and publish `inject.request` with its id | control token in control mode | `inject.ts` |
| `POST /inject/text`, `/inject/image`, `/inject/audio` | test-input injection (below) | yes | `inject.ts:58-62`, `routes.ts:38-46` |
| `GET /services` | `{services: ServiceHealth[]}` from the tracker snapshot | no | `:67-71` |
| `GET /services/control` | `{enabled:false}` or `{enabled:true, runtime, advanced}` | no | `:73-77` |
| `POST /services/:id/(start\|stop\|restart)` | delegate to `ServiceController`; `404` when control is disabled; `409` while another action runs (DASH-STACK-003) | yes | `:31, 78-98` |
| `GET /stack` | the stack state snapshot (DASH-STACK-001) | no | DASH-STACK-001 |
| `POST /stack/(launch\|stop\|restart\|consolidate)` | start a stack action through the stack controller, `202`; `404` when control is disabled (DASH-STACK-002 to 006) | yes, and only on the full-surface listener | DASH-STACK-* |
| `GET /personality` | `text/plain` personality file | no | `:99-104` |
| `PUT /personality` | save body, publish `control {cmd: "reload_personality"}`, `204` | yes | `:105-112` |
| `POST /control` | publish `control {cmd, text, target}`, `204`; the event schema validates `cmd` | yes | `:113-120` |
| `POST /sink` | `event: "playing"` publishes `voice.playing`, `event: "done"` publishes `voice.done`, both with `sink: "dashboard"`, `204`; any other `event` is `400` and publishes nothing (DASH-SINK-003) | no | `:121-128` |
| `GET /viewers*`, `POST /viewers*` | Viewers page (below) | always, by `VIEWERS_TOKEN` | DASH-VIEWERS-* |
| `GET /services/manifest` | the manifest's units and their descriptors (module-contract MOD-MAN-007) | no | MOD-MAN-007 |
| `GET /config/schema`, `GET /config/:section` | the settings editor's reads (module-contract MOD-CFG-001 to 006) | no | MOD-CFG-* |
| `PUT /config/:section` | validate and write one section of `config.yaml` (MOD-CFG-007 to 016) | yes | MOD-CFG-* |
| `POST /inject/event` | publish one declared bus test input for a unit (MOD-TEST-002 to 005) | yes | MOD-TEST-* |
| any method `/health` | `200 ok` | no | `:130` |
| anything else | `404 not found` | n/a | `:132` |

Gated routes answer `401` with `www-authenticate: Bearer` on a missing or wrong token; `bearerOk` does a constant-time comparison of SHA-256 digests (`routes.ts:143-146`, `packages/control/src/config.ts:40-47`). When control is disabled there is no token check anywhere. The `/ws` feed is never authenticated (the sink page needs it).

Request bodies for `/control`, `/personality`, `/sink` and lifecycle posts are capped at 64 KiB (`BODY_LIMIT`, `routes.ts:166`), matching `/inject/text` (DASH-HTTP-011): `body()` stops collecting past the cap, drains the rest and throws `BodyTooLarge`, which the catch-all answers `413` with nothing published, saved or run. `/inject/*` has its own caps (`inject.ts`). A malformed `%` escape in a lifecycle service id is answered `404` like any unknown id, before the body is read (DASH-HTTP-013, `routes.ts:85`).

### Service lifecycle routes

When control is enabled, `POST /services/:id/(start|stop|restart)` takes an optional JSON body. Only `mode` (`resume` | `fresh`) and `isolated` (boolean) are read; an empty body is `{}`; a malformed body, non-object, or bad field type is `400` (`routes.ts:148-158`). The controller's result maps to HTTP: refusal `unknown` to 404 (which includes `dashboard`, not a manifest unit because it is not a Compose service; DASH-SVC-003), `forbidden` (redis/postgres without `CONTROL_ADVANCED=1`) to 403, each with `{ok:false, detail}`; otherwise `200 {ok, detail?}` (`routes.ts:32, 89-97`). The controller has only these two refusals. While a stack action or another lifecycle request holds the action slot, the route answers `409 {ok: false, detail: "busy: <kind> held by dashboard (pid <pid>)"}` (`kind` is `service-start`, `service-stop` or `service-restart` for a lifecycle request) before the controller runs (DASH-STACK-003). The controller (manifest-only ids, consumer-group resets for `fresh`, isolated env) is control-plane's. The dashboard supplies `by: "dashboard"` and an `audit` callback that publishes `service.lifecycle`, logging and swallowing a publish failure (`control.ts:32-42`). `setupControl` warns on a non-loopback `CONTROL_BIND` (token travels in cleartext) and when `CONTROL_ADVANCED=1` (`control.ts:29-30`).

## Settings routes

`GET /config/schema`, `GET /config/:section` and `PUT /config/:section` (`services/dashboard/src/settings.ts`) are the settings editor's surface, specified by module-contract MOD-CFG-001 to 016 and driven by `@cohost/config`'s editor. The reads are ungated; the write is gated like `PUT /personality`, takes at most 64 KiB, reads and compares the file's etag and writes it without an await between, and never starts, stops or restarts a unit or touches `.env`. The Settings tab (MOD-UI-001 to 006) renders any section from its JSON Schema, offers Validate and Save, and, after a save, Apply through the lifecycle routes above. A section that needs a bespoke form registers a renderer in the page's `settingsForms` registry.

## Host process and stack control

The owner's decisions here are settled: the dashboard is a standalone program started on the host, outside Compose, and nothing else has to be running for it to start; Compose has no `dashboard` service; a Launch button brings up the whole stack through the control plane's compose runtime, and the dashboard can stop the stack and restart its services; stack actions sit behind `CONTROL_ENABLED=1` and `CONTROL_TOKEN`; the UI shows the stack's state. The mechanics below are owner decisions too. The [decision doc](decisions/standalone-dashboard.md) weighs where the dashboard runs and how it listens.

### Starting it

The owner runs `pnpm dashboard` from the repository root (deployment DEPLOY-HOST-001). The root script builds the dashboard and the workspace packages it imports (`tsc -b services/dashboard`, incremental, so a second start is quick) and runs `node services/dashboard/dist/index.js` with the repository root as the working directory. Node 22 and pnpm on the host are prerequisites; the installer already provides both. `cohostctl dashboard` is not offered: `@cohost/control` cannot depend on the dashboard (the dashboard depends on it), and a CLI that spawns the dashboard would be the control plane supervising a host process, which it never does.

First run, documented in the README (DEPLOY-HOST-003): run the installer (it seeds `.env`, which ships `CONTROL_ENABLED=1`, and writes a generated `CONTROL_TOKEN` into it, DEPLOY-INST-013), run `pnpm dashboard`, open `http://localhost:3000`, paste the token from `.env` when the page first asks (DASH-UI-006), and press Launch. At startup the dashboard logs both URLs, `http://127.0.0.1:<port>` and the LAN listener's port, and where the token lives, never the token itself (DASH-HOST-006). With control enabled and no token the dashboard refuses to start with an error naming `CONTROL_TOKEN` (DASH-CTRL-002).

### Files and addresses on the host

- **Config.** `loadConfig()` reads `.env` from the repository root into the process environment without overriding what is already set, and `configDir()` resolves to `<repo>/config` (config CFG-DIR-001, CFG-ENV-004). These are the same files Compose bind-mounts into every container at `/app/config`, so `PUT /personality` writes the file cortex re-reads. A `personality.md` first seeded by a container (which runs as root) is root-owned on a Linux host and the save then fails with `500` and the error text (DASH-HTTP-004); the installer seeds the files as the owner, which avoids it.
- **Data.** The dashboard keeps its uploads in Redis for a few minutes (Test-input injection and uploads) and writes nothing under `dataDir()`.
- **Redis.** `urls.redis()` defaults to `redis://127.0.0.1:6379`, the loopback port Compose publishes (deployment DEPLOY-COMPOSE-006). No `.env` change is needed.
- **Voice.** `urls.voice()` defaults to `http://127.0.0.1:8700`; Compose publishes voice's port on `127.0.0.1:8700` for this (deployment DEPLOY-COMPOSE-007). This replaces the earlier rule that host-side players reach voice only through the dashboard: the dashboard is now the host-side player of record, and every browser still goes through its proxy.
- **Postgres.** Never read by the dashboard (HLD tenet 1). Viewer notes arrive over the bus (Viewers page).
- **Containers and the dashboard.** Injected uploads travel over Redis, which the containers already reach on the Compose network, so nothing on the host needs to be reachable from a container for test injection; no URL is advertised (DASH-INJ-005).

### One PC: WSL2 with Docker Desktop

A supported host is WSL2 with Docker Desktop, and it is where the whole design is first tested: everything runs on one PC, with no second machine. The dashboard runs inside the WSL distro (`pnpm dashboard`); the containers run in Docker Desktop.

- **Windows browser to the dashboard.** WSL forwards `localhost` ports from Windows to listeners in the distro, so a Windows browser opens `http://localhost:3000` against the full surface on `127.0.0.1:3000`, and the Host check (DASH-HOST-004) accepts it because the browser sends `Host: localhost:3000`. If forwarding is turned off in the owner's WSL settings, the owner sets `DASHBOARD_HOST=0.0.0.0` instead, which requires control mode (DASH-HOST-007).
- **Same-PC sink.** OBS on Windows, or a second browser tab standing in for it, loads `http://localhost:3001/?sink=1` from the LAN listener (or `http://localhost:3000/?sink=1` from the full surface). Both exercise the same sink page the second-PC setup uses at `http://<ai-pc>:3001/?sink=1`.
- **Dashboard to the containers.** Docker Desktop makes ports published on `127.0.0.1` reachable on `localhost` inside the WSL distro, so the dashboard reaches Redis on `127.0.0.1:6379` and voice on `127.0.0.1:8700` with the same defaults as on native Linux.
- **Containers to the dashboard.** None for test injection: uploads travel over Redis (DASH-INJ-005). The LAN listener serves the sink page and the audio proxy to a browser or OBS, not to containers. Containers reach voice on the Compose network (`http://voice:8700`) on every host.
- **The `docker` binary.** Inside WSL, `docker` is Docker Desktop's WSL integration when that is enabled; otherwise only the Windows `docker.exe` is on the path. The control plane runs `COHOST_DOCKER_BIN` when it is set, else `docker`, else `docker.exe` (control-plane CTRL-STACK-012), so the dashboard and `cohostctl` work either way.

### Listeners

| Listener | Address | Serves |
|---|---|---|
| Full surface | `DASHBOARD_HOST`, else `CONTROL_BIND`, else `127.0.0.1`, in both control modes; a non-loopback address requires control mode (DASH-HOST-007); port `PORT`, else `DASHBOARD_PORT`, else `dashboard.port` (3000) | every route |
| LAN | all interfaces, `DASHBOARD_LAN_PORT` (default 3001) | `GET /`, `/ws`, `GET /audio/*`, `POST /sink`, `/health`; everything else `404` (DASH-HOST-002) |

The LAN listener exists so an OBS Browser Source on a second PC can load `http://<ai-pc>:3001/?sink=1` while every gated route, the stack routes above all, is reachable only from the host. Its handler has no path to a gated route, so host-locality does not depend on a per-route check. A same-PC OBS source keeps using `http://localhost:3000/?sink=1`. Both listeners share one handler instance and one feed.

Two request checks guard the full-surface listener while it is bound to a loopback address (DASH-HOST-004, DASH-HOST-005):

- **Host.** A request whose `Host` names anything other than a loopback name (`localhost`, `127.*`, `[::1]`) is answered `403`. This stops a DNS-rebinding page (a public name that resolves to `127.0.0.1`) from reading `/ws` or `GET /personality` through the owner's browser.
- **Origin.** A state-changing request (`POST`, `PUT`, `DELETE`) that carries an `Origin` header whose host and port differ from its `Host` is answered `403` and nothing runs. Requests without `Origin` (curl, `cohostctl`, OBS) pass. The bearer token already stops a cross-site request, since a page on another origin can neither read the token from this origin's `sessionStorage` nor send an `Authorization` header without a CORS preflight the dashboard never approves; the Origin check is defence in depth for the routes that drive Docker.

The token is accepted only from the `Authorization` header, never from a query string or body, and neither the header nor the token is ever written to the log (DASH-HOST-006).

### Stack routes

`GET /stack` (ungated, like `GET /services`) answers the snapshot the page also receives on `/ws` (DASH-STACK-001):

```
{ state, docker: { ok, detail? }, bus: "connected" | "unreachable",
  action: null | { kind, phase, startedAt },
  last:   null | { kind, ok, detail?, services?, finishedAt },
  services: [ { service, status, health? } ] }
```

`state` is the control plane's stack state (`docker-unavailable`, `down`, `starting`, `up`, `degraded`, `stopping`; control-plane CTRL-STACK-011), `services` lists each Compose container the status probe saw, and `bus` is the dashboard's own Redis reachability (DASH-FEED-009).

With control enabled, `POST /stack/launch`, `/stack/stop`, `/stack/restart` and `/stack/consolidate` start the matching stack-controller action in the background and answer `202 {ok: true, action}` at once (DASH-STACK-002); progress and the result travel on `/ws` and `GET /stack`, because a launch can take many minutes (an image build on first launch) and a consolidation pass up to 30. The routes take no body fields: nothing from the request reaches an argv (control-plane CTRL-STACK-009).

- **One action at a time.** The dashboard holds one action slot for stack actions and per-service lifecycle requests together. While an action runs, every other stack or lifecycle request is answered `409 {ok: false, detail: "busy: <kind> held by dashboard (pid <pid>)"}` and nothing runs (DASH-STACK-003; every busy refusal names its holder in this shape). Launch pressed twice therefore runs once. `cohostctl` is a separate process, so the slot is backed by the control plane's lifecycle lock file (control-plane CTRL-LOCK-001 to 004): the dashboard takes it for every stack or lifecycle request and `cohostctl` takes it for every command but `status`, so an action started from one entry point refuses the other with `409 {ok: false, detail: "busy: <action> held by <by> (pid <pid>)"}` (DASH-STACK-009).
- **Docker unreachable.** When the latest probe found Docker unavailable, a stack `POST` is answered `503 {ok: false, detail}` naming the cause (DASH-STACK-004). The page explains it instead of offering the buttons.
- **Preconditions.** `POST /stack/restart` is refused `409` while the stack is `down` (there is nothing to restart); `POST /stack/consolidate` is refused `409` while the `memory` container is running, so the one-shot never races the memory service's own pass (DASH-STACK-005).
- **Launch.** Runs the control plane's launch: `docker compose up -d --build --remove-orphans` (images are rebuilt on every launch, so they never lag the code), then a wait until every long-running container is running and, where it has a healthcheck, healthy (control-plane CTRL-STACK-002 to 005). Launching while some or all services already run is the same action and converges the stack on the Compose file: stopped services start, a service an isolated start had recreated with a preset is recreated without it, and services already as configured are left alone. A partial failure is reported per service and nothing is rolled back.
- **Stop.** Runs `docker compose stop`: every container of the stack, infrastructure included, stops gracefully (SIGTERM, Compose's grace period, reverse dependency order), so the memory service stops before Postgres and Redis and records `notes.shutdown_run_owed` as it always does on a graceful stop (memory MEM-CONSOL-013). Containers, networks and volumes are kept; `down` is never run. After a successful stop the page offers to run the consolidation one-shot (DASH-UI-019), which is optional: the memory service catches up at its next start.
- **Restart all.** Restarts every running application service through the per-service controller, each in its default mode and audited as its own `service.lifecycle` record; infrastructure is left alone (control-plane CTRL-STACK-007).
- **Audit.** Launch, stop and consolidate publish no bus event: the bus is down before a launch and goes down during a stop. The dashboard logs each action's start and result (DASH-STACK-006). Restart-all is audited per service by the controller.

### Stack state on the page

The page shows a stack panel at the top of the Services tab and a stack badge in the header (DASH-UI-017, DASH-UI-018): the state, the Launch / Stop / Restart-all buttons when control is enabled (each asks for confirmation and is disabled while an action runs), the running action's phase and elapsed time, and the last result with each not-ready service and its status (DASH-UI-020). With Docker unreachable the panel says so and shows the probe's detail; with the stack down it says the stack is down and offers Launch. The per-service rows below stay driven by the heartbeat tracker, as before; the stack panel adds what heartbeats cannot show: whether Docker answers, whether containers exist, and the infrastructure containers that send no heartbeat.

### When Redis is down or restarts

The dashboard starts and serves its page with Redis absent (DASH-HTTP-012). Until the bus answers, the feed reports `bus: unreachable`, the Services tab shows every service `unknown`, routes that publish (`/control`, `/inject/*`, `PUT /personality`) answer `500` with the publish error (DASH-HTTP-004), `/viewers` routes answer `504`, and the dashboard's own heartbeat publishes fail with a logged warning at most once per 60 s (SHARED-LIFE-011). When Redis comes up (by Launch or otherwise), the seed succeeds, the tails resume through the bus's own retry, and the bus reports `connected`.

Restarting Redis or Postgres from the dashboard stays behind `CONTROL_ADVANCED=1` per service (control-plane CTRL-GUARD-003). A Redis restart drops the dashboard's connections for its duration; the tails resume from their last seen ids (stream ids are time-based, so new entries sort after them), the tracker shows services `stale` until fresh heartbeats arrive, and the audit record of the restart itself may be lost (the audit is best effort). Stack actions ignore `CONTROL_ADVANCED`: stopping the whole stack is a deliberate whole-stack act, and Launch has to start Redis and Postgres.

### Upgrading from a containerised dashboard

A stack created by a Compose file that still had a `dashboard` service leaves that container running and holding host port 3000 after the file drops it. Launch removes it (`--remove-orphans`), but the host dashboard has to bind first: if port 3000 is taken it logs `fatal` naming the port and suggesting `docker compose down --remove-orphans` (DASH-HOST-003), and the README's upgrade notes say the same.

## Feed and health

`createFeed` (`feed.ts:26-86`) is the glue between Redis and the browser.

- `start()`: seeds `HealthTracker` from `bus.recentHealth(500)`, tails the health stream from the last seen id with `bus.tailHealth` into `tracker.ingest`, tails the main stream with `bus.tail` and broadcasts every event as JSON to all OPEN sockets, subscribes `tracker.onChange` to push a `{type:"services", services}` message, and ticks the tracker every 1000 ms (unref'd) so staleness transitions are pushed even without new heartbeats (`feed.ts:69-80`).
- `onConnection(ws)`: sends the current services snapshot, then `bus.recent(60)` oldest-first, each event with `replay: true` added (`feed.ts:49-67`; `bus.recent` reverses an `XREVRANGE`, `packages/bus/src/index.ts:190-192`). The socket is already in `wss.clients` when `connection` fires, so the feed registers it in a `replaying` map before its first await: live events for that socket are held there, and after the replay they are sent once, skipping any id the replay already contained (DASH-FEED-001). Other clients get live events immediately. The page also de-duplicates by bus event id and never plays a `replay`-marked utterance (DASH-UI-013). `serveClient` wraps the call so a failed replay affects only that socket, which stays open without the replay (DASH-HTTP-012).
- Stack state (DASH-FEED-008, DASH-FEED-009): a new socket receives a `{type: "stack", ...}` snapshot (the `GET /stack` body) right after the `services` snapshot, and every change of the stack state, a container's status or health, the running action, its phase, the last result or the bus reachability is pushed to every OPEN socket. The feed sets bus reachability `unreachable` when the seed or a tail read fails and `connected` after the next successful read. The stack snapshot is sent before the event replay, so a client that cannot get a replay (Redis down) still gets both snapshots.
- Heartbeat events are filtered from both paths (`feed.ts`). They normally never appear on the main stream, since `publish` refuses them (`packages/bus/src/index.ts`, `publish`); the filter is defensive.
- Everything else on the main stream goes to every browser, including event types the page then ignores, except the viewer-notes events `memory.notes.request`, `memory.notes.reply`, `memory.viewers.request` and `memory.viewers.reply`, which carry note text (including health and family notes) and are never sent on `/ws`, live or in the connect replay (DASH-FEED-007). There is no per-client subscription and no authentication on `/ws`.

## Test-input injection and uploads

The per-unit test drawer, `POST /inject/event`, the refusal of an injection for a unit that is not running (MOD-TEST-005) and the Settings tab are the [module contract](../module-contract/module-contract-design.md)'s; this section describes the inject routes as they stand.

`handleInject` (`inject.ts`) serves the four `POST /inject/*` routes. It runs after the `/audio` proxy and before the services, personality and control routes (`routes.ts`).

`POST /inject/text` (JSON, 64 KiB cap, `inject.ts:10, 66-114`): validated fields are `level` (`service` | `bus`, required), `as` (`chat` default | `speech` | `vision`), `text` (non-blank string), optional `remember`, `user`, `platform` (`twitch` | `youtube` | `discord`), `isMod`, `isSub`. `level: "service"` supports only `as: chat`.

- `level: service` publishes `inject.request {id, target:"chat", kind:"text", text, meta, remember}` with the raw text; chat re-validates and runs its normal path (computing `mentionsCohost`, `services/chat/src/inject.ts:37`) and replies with `inject.result` (`inject.ts:93-101`).
- `level: bus` publishes the perception event directly with `injected: true` and `remember`: `chat.message` (platform default `twitch`, user default `injected_viewer`, whitespace collapsed; `userId` omitted and `mentionsCohost` not computed, so it takes its schema default `false`: mention detection is chat's perception step, which bus level skips, so affect, memory and salience never see a bus-level chat line as a mention), `speech.heard` (speaker = user or `injected`, `durationMs: 0`), or `vision.summary` (`changed: true`) (`:102-112`). The envelope `source` is `dashboard` because the bus was constructed as `new Bus("dashboard")`. No `inject.result` follows; the UI says so.
- Response `202 {id}` where `id` is a fresh UUID (`:90, 113`).

`POST /inject/image` and `/inject/audio` (raw body): content-type allowlists (PNG/JPEG/WebP; WAV/x-wav/MPEG/Ogg/WebM/MP4), `?level` must be `service` (`bus` and anything else is 400), size cap per kind checked on `Content-Length` and while streaming, empty body 400. The bytes go into Redis (`Bus.putUpload`, key `cohost:upload:<id>`, a 128-bit random hex id, TTL `INJECT_TTL_MS`, default 5 min); the event stream only carries `inject.request {target: eyes|ears, kind, uploadId, contentType, meta?, remember}`. `?user=` and `?remember=1|true` are read from the query. The target service reads the bytes through its own Redis connection and deletes the key (shared-runtime SHARED-INJ-005). A Redis write that fails answers 503 and publishes nothing (DASH-UPL-003).

`uploads.ts` holds only the limits: per-kind byte caps (default 8 MiB image, 25 MiB audio, `INJECT_MAX_IMAGE_BYTES` / `INJECT_MAX_AUDIO_BYTES`) and the TTL. Redis expiry replaces the in-memory store's sweep and eviction, so there is no sweeper and no entry-count cap: at most one upload per accepted request exists, each bounded by its kind's cap and dropped by its TTL or by the consumer.

## The page (`public/index.html`)

A single static file with inline CSS and JS (no build step, no framework). The server substitutes every `__COHOST_NAME__` once at handler creation (`routes.ts:47`).

- Feed: `connect()` opens `ws(s)://<host>/ws`, reconnecting after 2 s (`index.html:345-350`). `onEvent` (`:326-333`) first drops any event whose bus `id` it has already handled (a bounded `seen` set, so a live event repeated by a reconnect replay is shown and played once), then routes `services`, `inject.result`, `avatar.state`, `brain.status` (which also sets the header status pill), `voice.utterance`, then `line(ev)` (`:301-322`) renders a row for: `chat.message`, `brain.say`, `vision.summary`, `speech.heard`, `brain.status` (state plus `detail`), `control`, `service.lifecycle`, `inject.request`, `inject.result`, `voice.utterance`, `voice.playing`, `voice.done`. Everything else (`attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`) is dropped; `avatar.state` is consumed by `drawFace` instead of the feed (`:329`). The feed keeps the last 300 rows and shows "injected" / "remembered" badges (`:319-320`).
- Avatar preview: an SVG face driven by `avatar.state` (`drawFace`, `:335-343`) plus a driver pill showing disconnected state.
- Operator controls: mute/unmute toggle (page-local `muted` flag, not read back from the brain), say box, wipe context; each `POST /control` (`:165-171`). Pause/resume exist in the API but have no UI. The mute label flips, and the personality editor reports "saved · brain reloaded", only after a 2xx response; otherwise a failure message appears (`#muteMsg`, `#persMsg`; DASH-UI-015, `:168, 173`).
- Personality editor: `GET /personality` on load, `PUT /personality` through `authFetch` on save (`:172-173`).
- Auth: `authFetch` retries once after prompting for a token on a `401`, keeping it in `sessionStorage` (`:150-162`). Every POST the page makes, including `/sink`, goes through `post()` → `authFetch` (`:164`). `GET`s and `/sink` are not gated, so they never prompt.
- HTML escaping: `esc()` escapes `&<>"'` because its output lands in attributes such as `data-svc` (DASH-UI-016, `:323`, used at `:272`).
- Services tab: renders the latest `services` message once a second with age extrapolation, dependency colouring, restart counts, and a count of down/crash-looping/stale services on the tab (`:250-264, 295-296`). When `GET /services/control` says enabled, a control column, a start-mode select and an isolated checkbox appear, actions ask `confirm()`, and only rows of manifest units carry buttons (DASH-UI-008): the dashboard's own row, and any other service that is not a manifest unit, shows none. The page holds the manifest's unit ids as a constant (`UNITS`), which a test pins to the control plane's manifest. The stack panel sits above the rows (Host process and stack control).
- Test inputs panel: text box with viewer fields, level toggle (bus disables image/audio and shows the `as` selector), `remember` checkbox, image/audio pickers, and optional microphone recording where `MediaRecorder` + `getUserMedia` exist. The status line matches `inject.result` to the HTTP `id` (results that arrive before the HTTP response are cached, last 50) and reports "no response" after 10 s (`:175-238`).
- Audio sink: every live `voice.utterance` the page sees while audio is on is pushed on a queue (not when it is `replay`-marked or audio is off, and turning audio off empties the queue; DASH-UI-014); `pump()` plays `/audio/<id>.wav` one at a time, posting `playing` on `onplay` and `done` on `ended`/`error` (`:136-148, 331`). `audioOn` starts true when the URL has a `sink` query parameter (presence, not value: `?sink=0` also enables it, `:133`); otherwise the operator clicks "enable audio". Sink mode adds a CSS class that hides everything but the header (`:41`). Utterances that arrive in the connect replay are shown but never played or reported (DASH-UI-013). If the browser's autoplay policy refuses `play()`, the page posts `done` for that utterance so the avatar and cortex are not left waiting, turns audio off, and keeps the utterances already queued; they play when the operator clicks "enable audio" (DASH-UI-022). Turning audio off by hand still drops the queue. Two pages with audio on (for example the operator tab and the OBS source) both play every utterance and both post `voice.playing`; voice accepts that (voice segment, Sink Arbitration Protocol).

## Viewers page

The owner's requirements are settled (`DASH-VIEWERS-*`, `DASH-FEED-007`): every stored viewer note is
visible and deletable here, the regular flag is set here, and the layout is
"panel A" below, and every `/viewers` route requires `VIEWERS_TOKEN`.

The co-host keeps short, fading notes about viewers (memory segment, Viewer notes).
This page is how the owner sees and controls them. It satisfies the HLD principle
that nothing the co-host learns is hidden in a table: notes live in Postgres, but
every one of them, and every deletion with its reason, is listed here and can be
deleted or restored.

### Layout ("panel A")

A Viewers tab in `public/index.html`, in the existing theme (the same single static
file, inline CSS and JS, dark navy palette, no new dependency):

- **Left: viewer list.** A search box filters by display name. Each row shows the
  display name, a `REGULAR` badge when the viewer is a regular, "set by you" when
  the owner's flag (not the message count) makes them one, and the message and note
  counts (DASH-VIEWERS-010). A name field above the list marks a viewer as regular
  before they have ever chatted (DASH-VIEWERS-013).
- **Right: detail panel** for the selected viewer: a "Mark as regular" toggle
  (DASH-VIEWERS-013), the notes split into **Core** and **Recent**, each note
  showing its text, a category tag, a strength bar and a delete link
  (DASH-VIEWERS-011, DASH-VIEWERS-012), a "Clear all notes" button
  (DASH-VIEWERS-014), and the viewer's deleted notes with their reasons and an
  undo link (DASH-VIEWERS-015).
- **Voice speakers.** A person who spoke in the voice channel is listed like any
  viewer, with a `VOICE` tag (memory `MEM-VOICE-009`). A voice viewer's panel has a
  "Link to a chat viewer" button that asks for the chat viewer's name and sends the
  link, moving its notes over; a chat viewer's panel lists the Discord ids linked to
  it, each with an unlink link (DASH-VIEWERS-020, DASH-VIEWERS-021).

Delete asks for an optional reason. A reason makes the deletion a rule the co-host
will not re-learn similar notes against; no reason means the topic may come back
weakly if the viewer keeps raising it (memory `MEM-ADMIN-003`, `MEM-CAPTURE-006`,
`MEM-CAPTURE-007`). The page says so next to the reason prompt.

### Routes

The dashboard holds no notes and cannot read Postgres (HLD tenet 1). Each route
publishes `memory.viewers.request {id, op, ...}` and waits up to 3000 ms for the
`memory.viewers.reply` with the same `id`, which it receives from the feed's
existing main-stream tail (DASH-VIEWERS-008).

| Route | `op` sent to memory | Spec |
|---|---|---|
| `GET /viewers?q=` | `list` | DASH-VIEWERS-001 |
| `GET /viewers/:key` | `get` | DASH-VIEWERS-002 |
| `POST /viewers/:key/notes/:id/delete` `{reason?}` | `delete_note` | DASH-VIEWERS-003 |
| `POST /viewers/deletions/:id/restore` | `restore` | DASH-VIEWERS-004 |
| `POST /viewers/:key/clear` `{reason?}` | `clear` | DASH-VIEWERS-005 |
| `POST /viewers/regular` `{key? , name?, regular}` | `set_regular` | DASH-VIEWERS-006 |
| `POST /viewers/links` `{discordId, key? , name?}` | `link_discord` | DASH-VIEWERS-018 |
| `POST /viewers/links/:discordId/delete` | `unlink_discord` | DASH-VIEWERS-019 |

A reply with `ok: true` answers 200 with its `data`; `error: "not_found"` answers
404; any other failure 500; no reply in time answers 504 "memory did not answer"
(DASH-VIEWERS-008). Bodies are capped at 64 KiB like the other JSON routes
(DASH-VIEWERS-009).

### Access protection

Health and family notes must not leak to anyone who can reach the dashboard port.
Two paths would leak them today: the open `/ws` feed (it forwards every bus event)
and any open read route. The design closes both:

1. The feed never forwards the viewer-notes events (DASH-FEED-007). This holds
   whatever option below is chosen.
2. Every `/viewers` route, reads included, requires `Authorization: Bearer
   <VIEWERS_TOKEN>`, a secret in `.env`, independent of control mode; with
   `VIEWERS_TOKEN` unset every `/viewers` route answers 403 with a message telling
   the owner to set it, and publishes nothing (DASH-VIEWERS-007). This is option
   A below, the owner's choice. The page prompts for the token on a 401, as it
   does for the control token, keeping the two in separate `sessionStorage` entries
   (DASH-VIEWERS-016).

The options considered (the owner chose A):

| Option | What it is | Cost |
|---|---|---|
| **A. Dedicated `VIEWERS_TOKEN` on all `/viewers` routes (chosen)** | bearer token on reads and writes, always on, independent of `CONTROL_ENABLED`; page locked until set | one more `.env` secret; the token travels in cleartext over plain HTTP on the LAN, as the control token does; a fresh install shows a locked Viewers page until the owner sets it |
| B. Reuse `CONTROL_TOKEN`, Viewers routes only with control mode on | same mechanism as lifecycle routes | the page would be unusable with control mode off; turning control on also turns on service control the owner may not want; the notes' secrecy would be tied to the token that also drives Docker |
| C. Loopback-only Viewers routes | answer only requests from `127.0.0.1` / `::1` | the owner could not use the page from another machine, which is how an owner on a dedicated PC works |
| D. `/ws` exclusion only, routes open like `GET /personality` | rely on the LAN boundary | anyone on the LAN can read health and family notes with one `curl`; consistent with today's open reads, but those reads expose stream-adjacent text, not viewers' private matters |
| E. Never put notes on the bus; dashboard reads them another way | e.g. the dashboard queries Postgres | breaks HLD tenet 1 (only memory touches Postgres); rejected outright |

A was chosen because it is the only option that protects notes in every
control mode, and its cost is one `.env` line. The Viewers routes are not on
the LAN listener (Listeners), so with control enabled they are host-local as
well. Notes still cross the Redis stream, which the trust boundary already
covers (Compose publishes Redis on the host's loopback only, deployment segment).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Viewer notes on `/ws` | Never forwarded, live or replayed (DASH-FEED-007) | forward like every other event; redact the text fields | Notes include health and family details the open feed must not carry; dropping whole events is simpler and safer than redacting fields of a shape that may grow. The page never rendered `memory.*` events anyway. |
| Viewers page access | `VIEWERS_TOKEN` bearer on every `/viewers` route | reuse `CONTROL_TOKEN`; loopback-only; open like `GET /personality` | Owner decision (option A): the only option that protects notes in every control mode; see Access protection. |
| Viewers page transport | Bus request/reply with memory, correlated by id from the feed tail, 3000 ms timeout | query Postgres; call memory over HTTP | HLD tenet 1. Reusing the feed's tail avoids a second Redis reader. |
| UI technology | One static HTML file with inline JS/CSS, read once at boot | A bundled SPA | The page is one operator panel and one OBS sink view, small enough to need no framework: there is no build step, no frontend dependency (`package.json` has only `ws`, `services/dashboard/package.json:17-21`), and the server serves one file. A bundled SPA would add a toolchain and a build output to ship for no capability the page needs; reading the file once at boot means an edit needs a restart. |
| Where service control lives | In the dashboard process, on a UI-agnostic core (`packages/control`), with the `cohostctl` CLI as a second client | Standalone CLI/TUI only; a compose-API wrapper container | One application that also works in OBS docks; the privilege risk is mitigated by gating. The wrapper container was rejected as compose-only and socket-mounting (`openspec/changes/archive/2026-11-01-add-service-control/design.md`, "Options considered"; commit `1d316ff`). |
| Where the dashboard runs | A standalone host process, started first; Compose has no `dashboard` service | Compose service (monitor-only) plus a host-run copy for control; Compose service with the Docker socket; desktop wrapper | Owner decision: one thing to start, which then starts everything else; no container gets root-equivalent host control. [Decision doc](decisions/standalone-dashboard.md). |
| How it listens | Two listeners: the full surface on `DASHBOARD_HOST` (default `127.0.0.1`, both control modes; a non-loopback address requires control mode) and a LAN listener on `DASHBOARD_LAN_PORT` (3001) serving only the sink routes | one loopback listener; one all-interfaces listener with a loopback-peer check on gated routes; full surface on all interfaces whenever control is off | Owner decision: by default the routes that drive Docker are host-local by construction, while a second-PC OBS source still reaches what it needs; an owner on a dedicated PC opens the full dashboard to other machines with `DASHBOARD_HOST`, and the token requirement keeps the stack actions and viewer notes behind their secrets. [Decision doc](decisions/standalone-dashboard.md). |
| Starting the dashboard | Root script `pnpm dashboard` (build, then run from the repo root) | `pnpm --filter @cohost/dashboard start`; `cohostctl dashboard`; a systemd user unit | One short command from the place the owner already works; running from the root gives `docker compose` the right project directory. `cohostctl` cannot depend on the dashboard and the control plane never spawns host processes. A service unit is a per-machine choice the owner can add on top. |
| Stack actions over HTTP | Asynchronous: `202` at once, progress and result on `/ws` and `GET /stack`; one action slot shared with per-service lifecycle requests | Block the request until the action finishes; allow concurrent actions | A first launch builds images and a consolidation pass can take 30 minutes, longer than a browser or proxy keeps a request open; one slot makes Launch-pressed-twice and launch-during-restart impossible without reasoning about Compose's behaviour under overlap. |
| Stack state source | The control plane's Compose status probe (`docker compose ps`) every 5 s for the stack panel; the heartbeat tracker for per-service rows | Derive the stack state from the heartbeat tracker alone | Heartbeats cannot say whether Docker answers or a container exists, cover no infrastructure container, and are unreadable while Redis is down, which is exactly when the stack panel matters. The Compose healthcheck of every application container is itself heartbeat freshness (control-plane CTRL-CHECK-001), so both views agree. |
| Stack audit | Launch, stop and consolidate are logged, not published; restart-all is audited per service | A `service.lifecycle`-like stack event | The bus does not exist before a launch and disappears during a stop; a new event type would need an event-bus schema change for records that could not be delivered when they matter. |
| Upload transport | Redis key `cohost:upload:<id>` written by the dashboard through its bus connection, read and deleted by eyes/ears through theirs; the event carries `uploadId` and `contentType` | Keep the URL fetch from the dashboard's LAN listener and document the firewall rule; inline base64 in the event; a separate HTTP relay | Live verification showed containers cannot reach the host on WSL2 NAT with the Hyper-V firewall blocking inbound, so the URL fetch fails there (`TypeError: fetch failed`) and a firewall note is a workaround every owner repeats. Redis is the one endpoint host and containers already share. Base64 in the event bloats the 20000-entry stream, every consumer group and every `/ws` backfill. A separate relay is a new listener and a new thing to expose. |
| Access control | Bearer token only on mutating routes, only when `CONTROL_ENABLED=1`; loopback bind then; reads (`/ws`, `GET /personality`, `GET /services`) stay open | Always-on auth; auth on every route; gate reads when control is enabled | Owner decision 2026-11-01: the LAN is the trust boundary and control mode guards mutations only. Off by default, loopback bind and a mandatory token when on; "when disabled, behaviour is exactly today's (binds as before, `/control` open)" (`add-service-control/design.md` Decision 4; comment at `control.ts:12`). |
| `POST /sink` gating | Never gated, also when control is enabled | Gate `/sink` with the bearer token | Owner decision 2026-11-01: an OBS Browser Source cannot answer the page's token prompt (`index.html:145-146, 150-164`), so a gated `/sink` would break the stream's audio sink; the LAN is the trust boundary. |
| `POST /sink` validation | Only `playing` and `done` are accepted; anything else is `400` | Treat every non-`playing` value as `done` | Owner decision 2026-11-01: a typo must not release cortex early; the retired OpenSpec enumerated `playing\|done` (`openspec/specs/dashboard/spec.md:53`). |
| Replay into the audio sink | The page shows replayed events but never plays a replayed utterance, recognising replay by the server's `replay: true` marker and de-duplicating by bus event id | Leave `voice.utterance` out of the server backfill; compare publisher `ts` with the socket-open time | Owner decision 2026-11-01: page-side keeps the feed's history intact; a clock comparison would replay old speech or drop new speech under skew. |
| Request body caps | 64 KiB with `413` on every JSON/text route | Unbounded; per-route limits | Owner decision 2026-11-01: matches `/inject/text` (`inject.ts:10`); one limit is enough for control commands, personality text and sink events. |
| Redis unreachable at startup | Keep running: retry the health seed with the bus backoff, report `bus: unreachable`, serve the page and the stack routes; a failed per-client replay is skipped and the socket stays open | Log `fatal` and exit non-zero; close a socket whose replay fails; unhandled rejection | The dashboard is the program that starts Redis (owner decision: nothing else has to be running), and no supervisor restarts a host process. Closing a socket whose replay failed would, with Redis down, close every page right after its snapshots and leave it in a reconnect loop that never shows the stack state. |
| Bus-level chat mentions | Bus-level `chat.message` keeps `mentionsCohost: false` | Compute mentions in the dashboard | Owner decision 2026-11-01: mention detection is chat's perception step, which bus-level injection skips by design; service-level injection runs it. |
| Sink-mode trigger | Presence of a `sink` query parameter, any value | Read the value (`?sink=1` only) | Owner decision 2026-11-01: presence semantics are simple and the documented `?sink=1` still works. |
| Host-side audio sinks | Browsers and OBS reach voice only through the dashboard `/audio/*` proxy; the host-run dashboard reaches voice on `127.0.0.1:8700`, which Compose publishes on loopback only | Keep voice unpublished (the host dashboard could not reach it); publish voice on all interfaces | The dashboard moved out of the Compose network, so voice has to be reachable from the host; loopback-only keeps it off the LAN, and the loopback `urls.voice()` default already serves host runs (commit `e53badc`). |
| Page test strategy | `test/page.test.ts` reads the inline `<script>` out of `index.html` and runs it in a `node:vm` context with a hand-written stub DOM, `fetch`, `WebSocket` and `Audio`; manual checks in `docs/TESTING.md` for what a stub cannot cover | A browser harness (Playwright); no page tests; moving the script into a separate served file | Owner decision 2026-11-01: no new browser dependency; the page logic (feed routing, sink queue, escaping) is plain JS a stub DOM can drive. Running the inline script unchanged keeps `index.html` as one file and its line references stable. |
| Connect replay ordering | The feed holds live events for a socket while its replay is read, then sends them once, skipping ids the replay held | Add the socket to the client set only after the replay (loses events between the read and the add); dedupe on the page alone (a live event could still render before older replayed ones) | `ws` adds the socket to `wss.clients` before `connection` fires, so the hold has to be server-side to give oldest-first order; the page de-duplicates by id as well, for reconnects. |
| Audio proxy body | Buffer the whole upstream body, then write status and headers | Stream upstream to the browser | A streamed response has already sent its status when the upstream read fails, so it cannot be answered `500`; clips are short (voice already serves whole WAV files). |
| Startup failure on bad control config | `setupControl` throws | Start with control disabled; generate a token and write it to `.env` at startup | "Startup fails fast if enabled without `CONTROL_TOKEN`" (`add-service-control/design.md` Decision 4); comments at `control.ts:18` and `packages/control/src/config.ts:23`. The installer, not the dashboard, writes a generated token into `.env` (deployment DEPLOY-INST-013), so a running program never edits the owner's secrets file. |
| Upload handling | Redis with TTL and delete-on-read; bytes bounded by the existing caps; the event carries an unguessable id | In-memory store behind `GET /uploads/:id`; shared volume or tmp dir | A shared path breaks across containers and hosts and a tmp dir needs crash cleanup; the in-memory store needed the host-reachable HTTP route this change removes. Redis reaches every container and expires its own keys. |
| Binary upload encoding | Raw request body with options in the query string | Multipart; base64 JSON | No multipart parser dependency on plain `node:http`; browser `fetch` and `MediaRecorder` blobs send raw bodies natively; base64 costs 33% (`add-test-injection/design.md` D4). |
| Injection levels | `service` runs the real path through chat/eyes/ears; `bus` publishes the perception event directly, text only | Single level | Bus-level image/audio has no pixels or audio to process, so it is text only; owner-confirmed (`add-test-injection/design.md` D1 and "Owner-confirmed decisions"). |
| Injection result reporting | `202 {id}` immediately; `inject.result` correlated by id on `/ws`; client-side 10 s "no response" | Block the HTTP call; rely on heartbeat deps | Without a per-request result, failures are indistinguishable; heartbeats describe a service, not a request (`add-test-injection/design.md` D5). |
| Feed transport | One shared `bus.tail` fanned out to all sockets, with a 60-event backfill per client | Per-client consumer groups | `tail` is the event-bus "non-group live tail (dashboard). Does not ack, does not replay" (`packages/bus/src/index.ts:229`). Browsers only observe: every socket wants every event, nothing is acked, and nothing must survive a reconnect beyond the 60-event backfill. A consumer group per socket would leave groups and pending entries in Redis after each disconnect and add an ack path for work no one does; one shared read also keeps Redis load constant however many pages are open. |
| Health in the UI | Server-side `HealthTracker`, pushed as `services` messages on change plus a 1 s tick, and available at `GET /services` | Browser derives state from raw heartbeats | Services report facts and thresholds belong to the monitor; the dashboard owns one tracker fed by `tailHealth` and pushes on change and on a 1 s tick (`openspec/changes/archive/2026-11-01-add-service-health/design.md` D3, D6; commit `691b079`). |
| Visual design | The existing theme, reused by the Viewers page | Redesign now | A visual redesign is a separate, later decision by the owner (an owner-deferred goal, not a gap in this design). |
| Bus-level injection id | `POST /inject/event` answers with the published event's own bus id (MOD-TEST-003); the older `/inject/text` bus level keeps a fresh UUID that no event carries, and the UI says no service result is expected | Make every bus-level route return the event's id | Only the unit-scoped route needs correlation with the feed, and the text route's UI never waits for a result. |
| Whitespace in service-level text injection | The dashboard sends the raw text; chat collapses whitespace on its own path, and bus level collapses it in the dashboard | Collapse in the dashboard for both levels | Chat owns normalisation for the path that runs through it, so the outcome is the same either way. |
| Pause and Resume | Buttons on the Services tab for units whose manifest `pause` is true (MOD-PAUSE-001 to 003) | Raw `POST /control` only | The operator should not need curl to idle a region. |
| Heartbeat warnings while the stack is down | The dashboard's own heartbeat failures warn at most once per 60 s (SHARED-LIFE-011) | Silence them while the bus reports `unreachable` | A warning per minute is enough to see the cause and no spam; no special case for the bus state. |
| Images after a code update | Launch always builds (`up -d --build`); the Rebuild action (DASH-STACK-008) stays as an alias | Build only on Rebuild | A Launch that skipped the build served stale images after a code change, an owner-reported bug; an unchanged build context is a cache hit. |
| Audio sink location | Browser page plays audio and reports `voice.playing` / `voice.done` | Server-side playback | An OBS Browser Source with "control audio via OBS" puts the voice on stream "with no virtual cables" (`index.ts:5-7`). |
| Voice URL default | `urls.voice()`: `VOICE_URL`, else `http://127.0.0.1:<VOICE_PORT or 8700>`; Compose sets `VOICE_URL=http://voice:8700` | Hard-coded `http://voice:8700` | Host runs outside Docker could not resolve `voice`; fixed for issue #10 (commit `e53badc`, "default VOICE_URL to loopback outside Docker"). |
| Autoplay refusal | The line that could not start is reported `done`, audio goes back to off, and the lines still queued wait for the operator to switch audio on again (DASH-UI-012) | Clear the whole queue with no `done` | A line dropped without `done` leaves cortex and the avatar waiting on a sink that will never report; the lines behind it are still wanted once the browser allows sound. Chosen by recommendation. |
| Bus-level injection id | `POST /inject/event` answers `202 { id }` with the published event's bus id; the drawer marks replies that carry the injected data's own `id` | A made-up correlation id no event carries | The id is the one thing every observer can see on the stream; replies that echo a request id (`memory.recall.reply`) are matched on that. |
| Pause and Resume | Buttons on the rows of units whose manifest `pause` is true, posting `control { cmd, target }` through `POST /control`; the paused state shown is the heartbeat's own `detail` | Page-local paused flag; raw `POST /control` only | The row must show the real state after a restart or in a second tab (module-contract, Pause state). |
| Request bodies | One reader (`body.ts`): bytes with a cap for the inject routes, text capped at 64 KiB for the JSON routes | A reader per module | The three copies differed only in what they returned; one place for the cap and the drain-on-overflow rule. |

## Open Questions & Future Decisions

None.

## Manual verification

1. **Autoplay in a real browser.** The refusal path (DASH-UI-022) is tested against a stub `Audio`; that a real browser's autoplay policy rejects `play()` the way the stub does is confirmed in the first run that opens the page in a normal tab and in an OBS Browser Source.

## References

Files in segment:
- `services/dashboard/src/index.ts`, `routes.ts`, `feed.ts`, `control.ts`, `inject.ts`, `uploads.ts`, `health.ts`
- Decision doc: [decisions/standalone-dashboard.md](decisions/standalone-dashboard.md)
- `services/dashboard/public/index.html`
- `services/dashboard/test/routes.test.ts`, `feed.test.ts`, `control.test.ts`, `inject.test.ts`, `uploads.test.ts`, `page.test.ts` (the page script under a stub DOM)
- `services/dashboard/package.json`, `services/dashboard/tsconfig.json`

Other segments (direction):
- event-bus: publishes `control`, `voice.playing`, `voice.done`, `inject.request`, `chat.message`, `speech.heard`, `vision.summary`, `service.lifecycle`; reads the whole main stream (`tail`, `recent`) and the health stream (`recentHealth`, `tailHealth`). Schemas in `packages/bus/src/events.ts`.
- control-plane: `HealthTracker`, `ServiceController`, `ComposeRuntime`, the stack controller, `loadControlConfig`, `bearerOk`, `isLoopback`; heartbeat contract (`startHeartbeat`, `HeartbeatSpec`).
- config: `loadConfig`, `urls.voice()`, `loadPersonality`, `savePersonality`, `cfg.cohost.name`, `cfg.dashboard.port`.
- voice: source of `/audio/<id>.wav` and `voice.utterance`; consumer of `voice.playing` / `voice.done` with `sink: "dashboard"`.
- chat, eyes, ears: handle `inject.request` for `target` chat / eyes / ears and publish `inject.result`; eyes and ears read the upload from Redis by `uploadId`.
- avatar: publishes `avatar.state` for the preview; consumes the sink's `voice.playing` / `voice.done`.
- cortex, salience, affect: consume `control` (mute, say, forget_context, reload_personality, pause, resume); cortex publishes `brain.status {state, detail?}`.
- deployment: Compose has no dashboard service; it publishes Redis and voice on loopback for the host-run dashboard, sets the containers' `VOICE_URL`, and the root `pnpm dashboard` script starts the dashboard.
- control-plane (stack): the stack controller (launch, stop-all, restart-all, consolidate, status) and the stack-state derivation (CTRL-STACK-*).
- memory: a graceful stack stop lets memory record `notes.shutdown_run_owed` (MEM-CONSOL-013); the consolidate offer runs the one-shot (MEM-CONSOL-012).

External: `ws` (WebSocket server); browser APIs `WebSocket`, `Audio`, `MediaRecorder`, `sessionStorage`.

Retired OpenSpec (historical): `openspec/specs/dashboard/spec.md`; `openspec/changes/archive/2026-11-01-add-service-health/` (design D3, D6); `openspec/changes/archive/2026-11-01-add-service-control/` (design, Decisions 4, 8, 9); `openspec/changes/archive/2026-11-01-add-test-injection/` (design D1 to D5, D9, D10).
