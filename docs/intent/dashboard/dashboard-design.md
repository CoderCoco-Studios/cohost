---
parent: high-level-design
prefix: DASH
---

# dashboard

Mapped 2026-10-31 at git `686cc8f`. Describes what the code does today. Decisions are `[inferred]` from code; none has been confirmed by the project owner. See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/dashboard` is the operator's window onto the stack and the one place a human can push things into it. One Node process serves a single static page and a small JSON/HTTP API on port 3000, plus a WebSocket that mirrors the Redis event stream and the service-health stream to the browser. It is also the stack's browser audio sink: the page plays the co-host's voice and reports `voice.playing` / `voice.done` back, so an OBS Browser Source pointed at `/?sink=1` puts the voice on stream without virtual audio cables (`services/dashboard/src/index.ts:1-10`).

The dashboard has almost no logic of its own. It publishes `control`, `voice.playing`, `voice.done`, `inject.request` and perception events onto the bus, proxies audio from `voice`, folds heartbeats through `HealthTracker` from `@cohost/control`, and delegates start/stop/restart to `ServiceController` from the same package (owned by the control-plane segment). This segment owns the HTTP surface, the gating rule, the injection panel and its upload store, the feed, and `public/index.html`.

Security posture is "trusted LAN by default, bearer token when control is enabled": with `CONTROL_ENABLED` unset, every route is open and the server listens on all interfaces; with `CONTROL_ENABLED=1` a shared bearer token guards a defined subset of mutating routes and the server binds to loopback unless told otherwise (`control.ts:20-43`, `routes.ts:24-28`).

## Process wiring

`index.ts` (`services/dashboard/src/index.ts`), in order:

1. `loadConfig()`, `new Bus("dashboard")`, `startHeartbeat(bus, {...dashboardHealth, log})` (`:26-28`). `dashboardHealth` is a constant spec: service `dashboard`, mode `live`, `deps: {}` (`health.ts:4`).
2. `new HealthTracker()`; `PORT` from env `PORT` else `cfg.dashboard.port` (default 3000, `packages/config/src/schema.ts:184`); `VOICE = urls.voice()` (`:29-31`).
3. `setupControl(process.env, bus, log)` reads the `CONTROL_*` env and returns `{control?, bind?}` (`:33`). It throws, aborting startup, when `CONTROL_ENABLED=1` without a token.
4. `public/index.html` is read once at startup from `<dist>/../public` (`:34`); edits need a restart.
5. A single `UploadStore` configured from `INJECT_*` env, with a 60 s unref'd sweep interval (`:36-38`).
6. `http.createServer(createDashboardHandler({...}))` and a `WebSocketServer({server, path: "/ws"})` (`:40-44`); each connection calls `feed.onConnection`, and `feed.start()` begins following the bus (`:45-47`). Neither promise is awaited or caught.
7. `server.listen(PORT, bind?)`; the heartbeat becomes `ready` only once listening (`:49-50`). With control disabled `bind` is undefined, so Node listens on all interfaces; compose publishes `${DASHBOARD_PORT:-3000}:3000` (`docker-compose.yml`, dashboard service).
8. `onShutdown` clears the sweeper, stops the feed, closes the WebSocket and HTTP servers, stops the bus (`:51`).

Environment read by this segment: `PORT`, `VOICE_URL` / `VOICE_PORT` (via `urls.voice()`, `packages/config/src/index.ts:163`), `DASHBOARD_URL` (via `urls.dashboard()`, `:165`, used to build upload URLs), `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_RUNTIME`, `CONTROL_PROCESS_MODE`, `CONTROL_BIND`, `CONTROL_ADVANCED` (`packages/control/src/config.ts:24-37`), `INJECT_MAX_IMAGE_BYTES`, `INJECT_MAX_AUDIO_BYTES`, `INJECT_TTL_MS` (`uploads.ts:166-178`), plus the heartbeat interval env owned by control-plane.

## HTTP surface

All routes are handled by one function, `createDashboardHandler` (`routes.ts:35-123`). Paths are matched in the order below; a thrown error anywhere is logged and answered `500` with the error text (`:118-121`).

| Route | Behavior | Gated when `CONTROL_ENABLED=1`? | Evidence |
|---|---|---|---|
| `GET /` | the page with `__COHOST_NAME__` replaced by `cohost.name` | no | `routes.ts:46, 50-54` |
| `GET /audio/*` | fetch `${voiceUrl}${pathname}` from voice, return its status and content-type (default `audio/wav`), `cache-control: no-store`; the whole body is buffered | no | `:55-60` |
| `GET /uploads/:id` | serve a stored test upload, `404` if unknown or expired | no (capability URL) | `inject.ts:49-56` |
| `POST /inject/text`, `/inject/image`, `/inject/audio` | test-input injection (below) | yes | `inject.ts:57-61`, `routes.ts:37-45` |
| `GET /services` | `{services: ServiceHealth[]}` from the tracker snapshot | no | `:62-66` |
| `GET /services/control` | `{enabled:false}` or `{enabled:true, runtime, advanced}` | no | `:67-71` |
| `POST /services/:id/(start|stop|restart)` | delegate to `ServiceController`; `404` when control is disabled | yes | `:31, 72-90` |
| `GET /personality` | `text/plain` personality file | no | `:91-95` |
| `PUT /personality` | save body, publish `control {cmd: "reload_personality"}`, `204` | yes | `:96-102` |
| `POST /control` | publish `control {cmd, text, target}`, `204`; the event schema validates `cmd` | yes | `:103-109` |
| `POST /sink` | publish `voice.playing` (when `event === "playing"`) or `voice.done` for any other value, with `sink: "dashboard"`, `204` | no | `:110-115` |
| any method `/health` | `200 ok` | no | `:116` |
| anything else | `404 not found` | n/a | `:117` |

Gated routes answer `401` with `www-authenticate: Bearer` on a missing or wrong token; `bearerOk` does a constant-time comparison of SHA-256 digests (`routes.ts:125-128`, `packages/control/src/config.ts:40-47`). When control is disabled there is no token check anywhere. The `/ws` feed is never authenticated.

Request bodies for `/control`, `/personality`, `/sink` and lifecycle posts are read by an unbounded `body()` helper (`routes.ts:142-149`); only `/inject/*` has size caps.

### Service lifecycle routes

When control is enabled, `POST /services/:id/(start|stop|restart)` takes an optional JSON body. Only `mode` (`resume` | `fresh`) and `isolated` (boolean) are read; an empty body is `{}`; a malformed body, non-object, or bad field type is `400` (`routes.ts:130-140`). The controller's result maps to HTTP: refusal `unknown` to 404, `conflict` (the dashboard stopping itself) to 409, `forbidden` (redis/postgres without `CONTROL_ADVANCED=1`) to 403, each with `{ok:false, detail}`; otherwise `200 {ok, detail?}` (`routes.ts:32, 81-89`). The controller (manifest-only ids, consumer-group resets for `fresh`, isolated env) is control-plane's. The dashboard supplies `by: "dashboard"` and an `audit` callback that publishes `service.lifecycle`, logging and swallowing a publish failure (`control.ts:31-40`). `setupControl` warns on a non-loopback `CONTROL_BIND` (token travels in cleartext) and when `CONTROL_ADVANCED=1` (`control.ts:28-29`).

## Feed and health

`createFeed` (`feed.ts:26-61`) is the glue between Redis and the browser.

- `start()`: seeds `HealthTracker` from `bus.recentHealth(500)`, tails the health stream from the last seen id with `bus.tailHealth` into `tracker.ingest`, tails the main stream with `bus.tail` and broadcasts every event as JSON to all OPEN sockets, subscribes `tracker.onChange` to push a `{type:"services", services}` message, and ticks the tracker every 1000 ms (unref'd) so staleness transitions are pushed even without new heartbeats (`feed.ts:43-54`).
- `onConnection(ws)`: sends the current services snapshot, then `bus.recent(60)` oldest-first (`feed.ts:35-40`).
- Heartbeat events are filtered from both paths (`feed.ts:38, 49`). They normally never appear on the main stream, since `publish` refuses them (`packages/bus/src/index.ts`, `publish`); the filter is defensive.
- Everything else on the main stream goes to every browser unfiltered, including event types the page then ignores. There is no per-client subscription and no authentication on `/ws`.

## Test-input injection and uploads

`handleInject` (`inject.ts:48-62`) serves `GET /uploads/:id` and the three `POST /inject/*` routes. It runs after the `/audio` proxy and before the services, personality and control routes (`routes.ts:61`).

`POST /inject/text` (JSON, 64 KiB cap, `inject.ts:10, 64-112`): validated fields are `level` (`service` | `bus`, required), `as` (`chat` default | `speech` | `vision`), `text` (non-blank string), optional `remember`, `user`, `platform` (`twitch` | `youtube` | `discord`), `isMod`, `isSub`. `level: "service"` supports only `as: chat`.

- `level: service` publishes `inject.request {id, target:"chat", kind:"text", text, meta, remember}` with the raw text; chat re-validates and runs its normal path and replies with `inject.result` (`:91-99`).
- `level: bus` publishes the perception event directly with `injected: true` and `remember`: `chat.message` (platform default `twitch`, user default `injected_viewer`, whitespace collapsed; `userId` and `mentionsCohost` omitted, so `mentionsCohost` takes its schema default `false`), `speech.heard` (speaker = user or `injected`, `durationMs: 0`), or `vision.summary` (`changed: true`) (`:100-110`). No `inject.result` follows; the UI says so.
- Response `202 {id}` where `id` is a fresh UUID (`:88, 111`).

`POST /inject/image` and `/inject/audio` (raw body): content-type allowlists (PNG/JPEG/WebP; WAV/x-wav/MPEG/Ogg/WebM/MP4), `?level` must be `service` (`bus` and anything else is 400), size cap per kind, empty body 400. The bytes go into `UploadStore`; the bus only carries `inject.request {target: eyes|ears, kind, url: <urls.dashboard()>/uploads/<id>, meta?, remember}` (`:114-140`). `?user=` and `?remember=1|true` are read from the query.

`UploadStore` (`uploads.ts:185-232`) is an in-memory `Map` keyed by 128-bit random hex ids: per-kind byte caps (default 8 MiB image, 25 MiB audio), TTL (default 10 min), at most 16 entries and 64 MiB total, evicting oldest first, swept lazily on `put`/`get` and every 60 s by the interval in `index.ts`. When the total cap is exceeded the newest entry is always kept (`uploads.ts:204`). `put` throws if an item exceeds its cap, but the route checks the cap first.

## The page (`public/index.html`)

A single static file with inline CSS and JS (no build step, no framework). The server substitutes `__COHOST_NAME__` once at handler creation (`routes.ts:46`).

- Feed: `connect()` opens `ws(s)://<host>/ws`, reconnecting after 2 s (`index.html:333-338`). `onEvent` routes `services`, `inject.result`, `avatar.state`, `brain.status`, `voice.utterance`, then `line(ev)` renders a row for: `chat.message`, `brain.say`, `vision.summary`, `speech.heard`, `brain.status`, `control`, `service.lifecycle`, `inject.request`, `inject.result`, `voice.utterance`, `voice.playing`, `voice.done`. Everything else (`attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`) is dropped (`:292-313`); `avatar.state` is consumed by `drawFace` instead of the feed (`:319`). The feed keeps the last 300 rows and shows "injected" / "remembered" badges (`:310-311`).
- Avatar preview: an SVG face driven by `avatar.state` (`drawFace`, `:324-332`) plus a driver pill showing disconnected state.
- Operator controls: mute/unmute toggle (page-local `muted` flag, not read back from the brain), say box, wipe context; each `POST /control` (`:161-166`). Pause/resume exist in the API but have no UI.
- Personality editor: `GET /personality` on load, `PUT /personality` through `authFetch` on save (`:167-168`).
- Auth: `authFetch` retries once after prompting for a token on a `401`, keeping it in `sessionStorage` (`:146-158`). `GET`s and `/sink` are not gated so they never prompt.
- Services tab: renders the latest `services` message once a second with age extrapolation, dependency colouring, restart counts, and a count of down/crash-looping/stale services on the tab (`:244-257, 287-288`). When `GET /services/control` says enabled, a control column, a start-mode select and an isolated checkbox appear, actions ask `confirm()`, and the dashboard row offers only Start (`:258-286`).
- Test inputs panel: text box with viewer fields, level toggle (bus disables image/audio and shows the `as` selector), `remember` checkbox, image/audio pickers, and optional microphone recording where `MediaRecorder` + `getUserMedia` exist. The status line matches `inject.result` to the HTTP `id` (results that arrive before the HTTP response are cached, last 50) and reports "no response" after 10 s (`:170-232`).
- Audio sink: every `voice.utterance` the page sees is pushed on a queue; `pump()` plays `/audio/<id>.wav` one at a time, posting `playing` on `onplay` and `done` on `ended`/`error` (`:134-145, 321`). `audioOn` starts true only with `?sink=1`; otherwise the operator clicks "enable audio". `?sink=1` adds a CSS class that hides everything but the header (`:41`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| UI technology | One static HTML file with inline JS/CSS, read once at boot | A bundled SPA | `[inferred]` No build step or frontend dependency; `package.json` has only `ws` (`services/dashboard/package.json:17-21`). |
| Access control | Bearer token only on mutating routes, only when `CONTROL_ENABLED=1`; loopback bind then | Always-on auth; auth on every route | `[inferred]` Keeps the existing no-auth LAN workflow unchanged when control is off ("unchanged behaviour while disabled", `control.ts:12-13`; `routes.ts:24-28`). |
| Upload handling | In-memory store, bus carries only a URL, unguessable id as capability | Put bytes on the stream; shared volume | `[inferred]` Comment: "Ids are 128 random bits: the URL is the capability" (`uploads.ts:183`); `inject.request` schema says binaries never ride the stream (`packages/bus/src/events.ts:166-170`). |
| Injection levels | `service` runs the real path through chat/eyes/ears; `bus` publishes the perception event directly (text only) | Single level | `[inferred]` Validation messages and UI labels "service (real pipeline)" / "bus (skip perception)" (`inject.ts:117`, `index.html:81`). |
| Feed transport | One shared `bus.tail` fanned out to all sockets, with a 60-event backfill per client | Per-client consumer groups | `[inferred]` `tail` is a non-group, non-acking live read built for the dashboard (`packages/bus/src/index.ts`, `tail` doc comment). |
| Health in the UI | Server-side `HealthTracker`, pushed as `services` messages and available at `GET /services` | Browser derives state from raw heartbeats | `[inferred]` `feed.ts:20-24` comment: "bus events (never heartbeats) plus `services` snapshots". |
| Audio sink location | Browser page plays audio and reports `voice.playing` / `voice.done` | Server-side playback | `[inferred]` Header comment targets OBS Browser Source with "control audio via OBS" (`index.ts:4-7`). |
| Startup failure on bad control config | `setupControl` throws | Start with control disabled | `[inferred]` Comment: "Throws (so startup fails)" (`control.ts:17-19`); avoids a silently unauthenticated deployment. |

## Open Questions & Future Decisions

1. `__COHOST_NAME__` appears twice in `public/index.html` (`<title>` at line 6, `<h1>` at line 54) but `String.prototype.replace` with a string pattern replaces only the first (`routes.ts:46`). The header shows the literal placeholder in the browser. The unit test uses a one-occurrence fixture (`test/routes.test.ts:22, 34`), so it passes.
2. Audio replay on reconnect: the backfill sent on every WebSocket connect includes recent `voice.utterance` events (`feed.ts:37-40`), and the page queues every `voice.utterance` it receives (`index.html:321`) with no check for age. With audio enabled (always, in `?sink=1` mode), loading or reconnecting the page (it reconnects every 2 s after a drop, `:336`) replays up to the last 60 events' worth of speech and posts `voice.playing` / `voice.done` for those old ids (`:142-143`), which avatar will lip-sync if the id is still among its last 20.
3. The audio queue is unbounded while audio is not enabled: `queue.push` happens regardless of `audioOn` (`index.html:136, 321`); `pump()` returns immediately without draining (`:139`). A long-lived operator tab that never clicked "enable audio" accumulates every utterance. When audio is enabled later, the whole backlog plays.
4. If the browser blocks autoplay, `a.play()` rejects, `audioOn` flips off, and that utterance is dropped from the queue with no `done` posted (`index.html:144`).
5. Two open pages with audio on (for example the operator tab and the OBS source) will both play every utterance and both post `voice.playing`; arbitration is voice's concern (see voice segment).
6. Ungated routes with control enabled: `POST /sink`, `GET /personality`, `GET /services`, `GET /services/control`, `GET /audio/*`, `GET /uploads/:id`, `/health` and the `/ws` feed. `POST /sink` lets anyone who can reach the port publish `voice.playing` / `voice.done` events and so influence avatar lip-sync and voice sink bookkeeping; `GET /personality` discloses the personality file; `/ws` discloses all chat, speech, vision and memory events. OpenSpec only requires gating on the service routes, `POST /control`, `PUT /personality` and `/inject/*`, and explicitly keeps `/uploads` open (`openspec/changes/add-service-control/specs/dashboard/spec.md`, `.../add-test-injection/specs/dashboard/spec.md`).
7. `POST /sink` does not validate `event`: any value other than `"playing"` publishes `voice.done` (`routes.ts:112`).
8. `POST /control` and `PUT /personality` read unbounded bodies (`routes.ts:142-149`) and `PUT /personality` writes any text to disk; `/inject/*` is the only family with caps.
9. A bus-level injected chat message never sets `userId` or `mentionsCohost` (`inject.ts:101-105`; the schema defaults `mentionsCohost` to false, `packages/bus/src/events.ts:18`), so downstream mention logic only sees a mention if salience detects the name itself, unlike the service-level path where chat computes it.
10. Bus-level injection returns an `id` that no published event carries (`inject.ts:88, 100-111`), so it cannot be correlated; the UI special-cases this ("published at bus level (no service result)", `index.html:189`).
11. Service-level text injection sends the raw `b.text` whereas bus-level collapses whitespace (`inject.ts:89, 93`).
12. The page reads `d.detail` on `brain.status` (`index.html:300`) but the event schema field is `notes` (`packages/bus/src/events.ts:59-65`), so status detail never renders.
13. `esc()` does not escape quotes and is used inside the attribute `data-svc="..."` (`index.html:264, 314`); service ids come from heartbeats published by any process with Redis access.
14. A client that connects receives live broadcasts as soon as its socket is in `wss.clients`, while `onConnection` awaits `bus.recent` (`index.ts:46`, `feed.ts:35-40`), so events during the await may arrive before, or be duplicated with, the backfill. No de-duplication on the page.
15. `feed.start()` and `feed.onConnection()` are `void`-ed in `index.ts:45-47`; a Redis failure there is an unhandled rejection.
16. The OpenSpec "Audio sink" requirement says `VOICE_URL` defaults to `http://voice:8700`; the code defaults to `http://127.0.0.1:8700` and relies on compose to set `VOICE_URL` (`packages/config/src/index.ts:163`, `docker-compose.yml:18`).
17. The `isolated` field of the lifecycle body is implemented (`routes.ts:136-139`, UI checkbox `index.html:120`) but absent from every dashboard OpenSpec requirement, which only mentions `mode`.
18. `decodeURIComponent` on the service id (`routes.ts:79`) can throw a `URIError` for malformed escapes, which becomes a `500` rather than a `404`.
19. Test gaps: no test of the `/ws` server wiring, `index.ts`, the page's JavaScript (audio sink, reconnect, token prompt, services tab), the `body()` helpers, or `readBody` limits for text (413).
20. `index.html` carries a duplicated comment on the same CSS line (`:41`) and the pause/resume commands are reachable only by raw `POST /control` (`:161-166`).

## References

Files in segment:
- `services/dashboard/src/index.ts`, `routes.ts`, `feed.ts`, `control.ts`, `inject.ts`, `uploads.ts`, `health.ts`
- `services/dashboard/public/index.html`
- `services/dashboard/test/routes.test.ts`, `feed.test.ts`, `control.test.ts`, `inject.test.ts`, `uploads.test.ts`
- `services/dashboard/package.json`, `services/dashboard/tsconfig.json`

Other segments (direction):
- event-bus: publishes `control`, `voice.playing`, `voice.done`, `inject.request`, `chat.message`, `speech.heard`, `vision.summary`, `service.lifecycle`; reads the whole main stream (`tail`, `recent`) and the health stream (`recentHealth`, `tailHealth`). Schemas in `packages/bus/src/events.ts`.
- control-plane: `HealthTracker`, `ServiceController`, `ComposeRuntime` / `ProcessRuntime`, `loadControlConfig`, `bearerOk`, `isLoopback`; heartbeat contract (`startHeartbeat`, `HeartbeatSpec`).
- config: `loadConfig`, `urls.voice()`, `urls.dashboard()`, `loadPersonality`, `savePersonality`, `cfg.cohost.name`, `cfg.dashboard.port`.
- voice: source of `/audio/<id>.wav` and `voice.utterance`; consumer of `voice.playing` / `voice.done` with `sink: "dashboard"`.
- chat, eyes, ears: handle `inject.request` for `target` chat / eyes / ears and publish `inject.result`; eyes and ears fetch `/uploads/<id>` from this service.
- avatar: publishes `avatar.state` for the preview; consumes the sink's `voice.playing` / `voice.done`.
- cortex, salience, affect: consume `control` (mute, say, forget_context, reload_personality, pause, resume).
- deployment: compose publishes port 3000, sets `VOICE_URL` and `DASHBOARD_URL`.

External: `ws` (WebSocket server); browser APIs `WebSocket`, `Audio`, `MediaRecorder`, `sessionStorage`.

OpenSpec: `openspec/specs/dashboard/spec.md`; `openspec/changes/add-service-health/specs/dashboard/spec.md`; `openspec/changes/add-service-control/specs/dashboard/spec.md`; `openspec/changes/add-test-injection/specs/dashboard/spec.md`.
