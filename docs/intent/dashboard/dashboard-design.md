---
parent: high-level-design
prefix: DASH
---

# dashboard

Describes the intended design and the code that realizes it; where the code lags, the text says so and names the gap spec. Each row in Decisions & Alternatives cites the evidence for its rationale, or gives the engineering reason the design rests on where no recorded source exists. Specs: [dashboard-specs.md](dashboard-specs.md). See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/dashboard` is the operator's window onto the stack and the one place a human can push things into it. One Node process serves a single static page and a small JSON/HTTP API on port 3000, plus a WebSocket that mirrors the Redis event stream and the service-health stream to the browser. It is also the stack's browser audio sink: the page plays the co-host's voice and reports `voice.playing` / `voice.done` back, so an OBS Browser Source pointed at `/?sink=1` puts the voice on stream without virtual audio cables (`services/dashboard/src/index.ts:1-10`).

The dashboard has almost no logic of its own. It publishes `control`, `voice.playing`, `voice.done`, `inject.request` and perception events onto the bus, proxies audio from `voice`, folds heartbeats through `HealthTracker` from `@cohost/control`, and delegates start/stop/restart to `ServiceController` from the same package (owned by the control-plane segment). This segment owns the HTTP surface, the gating rule, the injection panel and its upload store, the feed, and `public/index.html`.

Security posture follows the project's trust boundary, which is the operator's LAN: with `CONTROL_ENABLED` unset, every route is open and the server listens on all interfaces; with `CONTROL_ENABLED=1` a shared bearer token guards the mutating routes and the server binds to loopback unless told otherwise (`control.ts:17-45`, `routes.ts:24-28`). Control mode guards mutations only. Reads (`/ws`, `GET /personality`, `GET /services`, `GET /audio/*`) stay open, and so does `POST /sink`, because the OBS Browser Source that serves as the stream's audio sink cannot present a token. A non-loopback `CONTROL_BIND` therefore exposes the read routes and `/sink` to the LAN; that is accepted under the LAN boundary.

The dashboard is also the only path by which a player on the host (outside the Compose network) reaches voice's audio: Compose does not publish voice's port, so browsers and other host-side sinks fetch `/audio/<id>.wav` through the dashboard proxy, while in-network sinks such as ears fetch `http://voice:8700` directly.

## Process wiring

`index.ts` (`services/dashboard/src/index.ts`), in order:

1. `loadConfig()`, `new Bus("dashboard")`, `startHeartbeat(bus, {...dashboardHealth, log})` (`:26-29`). `dashboardHealth` is a constant spec: service `dashboard`, mode `live`, `deps: {}` (`health.ts:5`).
2. `new HealthTracker()`; `PORT` from env `PORT` else `cfg.dashboard.port` (default 3000, `packages/config/src/schema.ts:184`); `VOICE = urls.voice()` (`:30-33`).
3. `setupControl(process.env, bus, log)` reads the `CONTROL_*` env and returns `{control?, bind?}` (`:35`). It throws, aborting startup, when `CONTROL_ENABLED=1` without a token.
4. `public/index.html` is read once at startup from `<dist>/../public` (`:36`); edits need a restart.
5. A single `UploadStore` configured from `INJECT_*` env, with a 60 s unref'd sweep interval (`:38-41`).
6. `http.createServer(createDashboardHandler({...}))` and a `WebSocketServer({server, path: "/ws"})` (`:43-47`); each connection calls `feed.onConnection`, and `feed.start()` begins following the bus (`:49-50`). `startFeed` (`feed.ts`) awaits `feed.start()`: when it rejects (Redis unreachable at startup) it logs `fatal` and exits non-zero so Compose restarts the container. `serveClient` awaits each connection's replay: when it fails it logs the error and closes only that socket (DASH-HTTP-012).
7. `server.listen(PORT, bind?)`; the heartbeat becomes `ready` only once listening (`:53-54`). With control disabled `bind` is undefined, so Node listens on all interfaces; compose publishes `${DASHBOARD_PORT:-3000}:3000` (`docker-compose.yml`, dashboard service).
8. `onShutdown` clears the sweeper, stops the feed, closes the WebSocket and HTTP servers, stops the bus (`:56`). The heartbeat's `stopping` is published by `startHeartbeat`'s own shutdown hook (control-plane).

Environment read by this segment: `PORT`, `VOICE_URL` / `VOICE_PORT` (via `urls.voice()`, `packages/config/src/index.ts:163`), `DASHBOARD_URL` (via `urls.dashboard()`, `:165`, used to build upload URLs), `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_RUNTIME`, `CONTROL_PROCESS_MODE`, `CONTROL_BIND`, `CONTROL_ADVANCED` (`packages/control/src/config.ts:24-37`), `INJECT_MAX_IMAGE_BYTES`, `INJECT_MAX_AUDIO_BYTES`, `INJECT_TTL_MS` (`uploads.ts:27-39`), plus the heartbeat interval env owned by control-plane.

## HTTP surface

All routes are handled by one function, `createDashboardHandler` (`routes.ts:36-141`). Paths are matched in the order below; a thrown error anywhere, including a request URL that does not parse, is logged and answered `500` with the error text, or `413` for an oversized body; when response headers were already sent the connection is cut instead of answered (`:133-139`, `sendUnlessStarted`).

| Route | Behavior | Gated when `CONTROL_ENABLED=1`? | Evidence |
|---|---|---|---|
| `GET /` | the page with `__COHOST_NAME__` replaced by `cohost.name` (every occurrence, via split/join) | no | `routes.ts:47, 52-56` |
| `GET /audio/*` | fetch `${voiceUrl}${pathname}` from voice, return its status and content-type (default `audio/wav`), `cache-control: no-store`; the whole upstream body is buffered before the status and headers are written, so a failed read is a `500` (DASH-HTTP-004) | no | `:58-64` |
| `GET /uploads/:id` | serve a stored test upload, `404` if unknown or expired | no (capability URL) | `inject.ts:50-57` |
| `POST /inject/text`, `/inject/image`, `/inject/audio` | test-input injection (below) | yes | `inject.ts:58-62`, `routes.ts:38-46` |
| `GET /services` | `{services: ServiceHealth[]}` from the tracker snapshot | no | `:67-71` |
| `GET /services/control` | `{enabled:false}` or `{enabled:true, runtime, advanced}` | no | `:73-77` |
| `POST /services/:id/(start\|stop\|restart)` | delegate to `ServiceController`; `404` when control is disabled | yes | `:31, 78-98` |
| `GET /personality` | `text/plain` personality file | no | `:99-104` |
| `PUT /personality` | save body, publish `control {cmd: "reload_personality"}`, `204` | yes | `:105-112` |
| `POST /control` | publish `control {cmd, text, target}`, `204`; the event schema validates `cmd` | yes | `:113-120` |
| `POST /sink` | `event: "playing"` publishes `voice.playing`, `event: "done"` publishes `voice.done`, both with `sink: "dashboard"`, `204`; any other `event` is `400` and publishes nothing (DASH-SINK-003) | no | `:121-128` |
| any method `/health` | `200 ok` | no | `:130` |
| anything else | `404 not found` | n/a | `:132` |

Gated routes answer `401` with `www-authenticate: Bearer` on a missing or wrong token; `bearerOk` does a constant-time comparison of SHA-256 digests (`routes.ts:143-146`, `packages/control/src/config.ts:40-47`). When control is disabled there is no token check anywhere. The `/ws` feed is never authenticated (the sink page needs it).

Request bodies for `/control`, `/personality`, `/sink` and lifecycle posts are capped at 64 KiB (`BODY_LIMIT`, `routes.ts:166`), matching `/inject/text` (DASH-HTTP-011): `body()` stops collecting past the cap, drains the rest and throws `BodyTooLarge`, which the catch-all answers `413` with nothing published, saved or run. `/inject/*` has its own caps (`inject.ts`). A malformed `%` escape in a lifecycle service id is answered `404` like any unknown id, before the body is read (DASH-HTTP-013, `routes.ts:85`).

### Service lifecycle routes

When control is enabled, `POST /services/:id/(start|stop|restart)` takes an optional JSON body. Only `mode` (`resume` | `fresh`) and `isolated` (boolean) are read; an empty body is `{}`; a malformed body, non-object, or bad field type is `400` (`routes.ts:148-158`). The controller's result maps to HTTP: refusal `unknown` to 404, `conflict` (the dashboard stopping itself) to 409, `forbidden` (redis/postgres without `CONTROL_ADVANCED=1`) to 403, each with `{ok:false, detail}`; otherwise `200 {ok, detail?}` (`routes.ts:32, 89-97`). The controller (manifest-only ids, consumer-group resets for `fresh`, isolated env) is control-plane's. The dashboard supplies `by: "dashboard"` and an `audit` callback that publishes `service.lifecycle`, logging and swallowing a publish failure (`control.ts:32-42`). `setupControl` warns on a non-loopback `CONTROL_BIND` (token travels in cleartext) and when `CONTROL_ADVANCED=1` (`control.ts:29-30`).

## Feed and health

`createFeed` (`feed.ts:26-86`) is the glue between Redis and the browser.

- `start()`: seeds `HealthTracker` from `bus.recentHealth(500)`, tails the health stream from the last seen id with `bus.tailHealth` into `tracker.ingest`, tails the main stream with `bus.tail` and broadcasts every event as JSON to all OPEN sockets, subscribes `tracker.onChange` to push a `{type:"services", services}` message, and ticks the tracker every 1000 ms (unref'd) so staleness transitions are pushed even without new heartbeats (`feed.ts:69-80`).
- `onConnection(ws)`: sends the current services snapshot, then `bus.recent(60)` oldest-first, each event with `replay: true` added (`feed.ts:49-67`; `bus.recent` reverses an `XREVRANGE`, `packages/bus/src/index.ts:190-192`). The socket is already in `wss.clients` when `connection` fires, so the feed registers it in a `replaying` map before its first await: live events for that socket are held there, and after the replay they are sent once, skipping any id the replay already contained (DASH-FEED-001). Other clients get live events immediately. The page also de-duplicates by bus event id and never plays a `replay`-marked utterance (DASH-UI-013). `serveClient` wraps the call so a failed replay closes only that socket (DASH-HTTP-012).
- Heartbeat events are filtered from both paths (`feed.ts`). They normally never appear on the main stream, since `publish` refuses them (`packages/bus/src/index.ts`, `publish`); the filter is defensive.
- Everything else on the main stream goes to every browser unfiltered, including event types the page then ignores. There is no per-client subscription and no authentication on `/ws`.

## Test-input injection and uploads

`handleInject` (`inject.ts:48-63`) serves `GET /uploads/:id` and the three `POST /inject/*` routes. It runs after the `/audio` proxy and before the services, personality and control routes (`routes.ts:64`).

`POST /inject/text` (JSON, 64 KiB cap, `inject.ts:10, 66-114`): validated fields are `level` (`service` | `bus`, required), `as` (`chat` default | `speech` | `vision`), `text` (non-blank string), optional `remember`, `user`, `platform` (`twitch` | `youtube` | `discord`), `isMod`, `isSub`. `level: "service"` supports only `as: chat`.

- `level: service` publishes `inject.request {id, target:"chat", kind:"text", text, meta, remember}` with the raw text; chat re-validates and runs its normal path (computing `mentionsCohost`, `services/chat/src/inject.ts:37`) and replies with `inject.result` (`inject.ts:93-101`).
- `level: bus` publishes the perception event directly with `injected: true` and `remember`: `chat.message` (platform default `twitch`, user default `injected_viewer`, whitespace collapsed; `userId` omitted and `mentionsCohost` not computed, so it takes its schema default `false`: mention detection is chat's perception step, which bus level skips, so affect, memory and salience never see a bus-level chat line as a mention), `speech.heard` (speaker = user or `injected`, `durationMs: 0`), or `vision.summary` (`changed: true`) (`:102-112`). The envelope `source` is `dashboard` because the bus was constructed as `new Bus("dashboard")`. No `inject.result` follows; the UI says so.
- Response `202 {id}` where `id` is a fresh UUID (`:90, 113`).

`POST /inject/image` and `/inject/audio` (raw body): content-type allowlists (PNG/JPEG/WebP; WAV/x-wav/MPEG/Ogg/WebM/MP4), `?level` must be `service` (`bus` and anything else is 400), size cap per kind checked on `Content-Length` and while streaming, empty body 400. The bytes go into `UploadStore`; the bus only carries `inject.request {target: eyes|ears, kind, url: <urls.dashboard()>/uploads/<id>, meta?, remember}` (`:117-143`). `?user=` and `?remember=1|true` are read from the query.

`UploadStore` (`uploads.ts:47-94`) is an in-memory `Map` keyed by 128-bit random hex ids: per-kind byte caps (default 8 MiB image, 25 MiB audio), TTL (default 10 min), at most 16 entries and 64 MiB total, evicting oldest first, swept on `put`, checked on `get`, and swept every 60 s by the interval in `index.ts`. When the total cap is exceeded the newest entry is always kept (`uploads.ts:66`). `put` throws if an item exceeds its cap, but the route checks the cap first.

## The page (`public/index.html`)

A single static file with inline CSS and JS (no build step, no framework). The server substitutes every `__COHOST_NAME__` once at handler creation (`routes.ts:47`).

- Feed: `connect()` opens `ws(s)://<host>/ws`, reconnecting after 2 s (`index.html:345-350`). `onEvent` (`:326-333`) first drops any event whose bus `id` it has already handled (a bounded `seen` set, so a live event repeated by a reconnect replay is shown and played once), then routes `services`, `inject.result`, `avatar.state`, `brain.status` (which also sets the header status pill), `voice.utterance`, then `line(ev)` (`:301-322`) renders a row for: `chat.message`, `brain.say`, `vision.summary`, `speech.heard`, `brain.status` (state plus `detail`), `control`, `service.lifecycle`, `inject.request`, `inject.result`, `voice.utterance`, `voice.playing`, `voice.done`. Everything else (`attention.focus`, `affect.state`, `memory.recall.request`, `memory.recall.reply`, `memory.viewer`) is dropped; `avatar.state` is consumed by `drawFace` instead of the feed (`:329`). The feed keeps the last 300 rows and shows "injected" / "remembered" badges (`:319-320`).
- Avatar preview: an SVG face driven by `avatar.state` (`drawFace`, `:335-343`) plus a driver pill showing disconnected state.
- Operator controls: mute/unmute toggle (page-local `muted` flag, not read back from the brain), say box, wipe context; each `POST /control` (`:165-171`). Pause/resume exist in the API but have no UI. The mute label flips, and the personality editor reports "saved · brain reloaded", only after a 2xx response; otherwise a failure message appears (`#muteMsg`, `#persMsg`; DASH-UI-015, `:168, 173`).
- Personality editor: `GET /personality` on load, `PUT /personality` through `authFetch` on save (`:172-173`).
- Auth: `authFetch` retries once after prompting for a token on a `401`, keeping it in `sessionStorage` (`:150-162`). Every POST the page makes, including `/sink`, goes through `post()` → `authFetch` (`:164`). `GET`s and `/sink` are not gated, so they never prompt.
- HTML escaping: `esc()` escapes `&<>"'` because its output lands in attributes such as `data-svc` (DASH-UI-016, `:323`, used at `:272`).
- Services tab: renders the latest `services` message once a second with age extrapolation, dependency colouring, restart counts, and a count of down/crash-looping/stale services on the tab (`:250-264, 295-296`). When `GET /services/control` says enabled, a control column, a start-mode select and an isolated checkbox appear, actions ask `confirm()`, and the dashboard row offers only Start (`:265-294`).
- Test inputs panel: text box with viewer fields, level toggle (bus disables image/audio and shows the `as` selector), `remember` checkbox, image/audio pickers, and optional microphone recording where `MediaRecorder` + `getUserMedia` exist. The status line matches `inject.result` to the HTTP `id` (results that arrive before the HTTP response are cached, last 50) and reports "no response" after 10 s (`:175-238`).
- Audio sink: every live `voice.utterance` the page sees while audio is on is pushed on a queue (not when it is `replay`-marked or audio is off, and turning audio off empties the queue; DASH-UI-014); `pump()` plays `/audio/<id>.wav` one at a time, posting `playing` on `onplay` and `done` on `ended`/`error` (`:136-148, 331`). `audioOn` starts true when the URL has a `sink` query parameter (presence, not value: `?sink=0` also enables it, `:133`); otherwise the operator clicks "enable audio". Sink mode adds a CSS class that hides everything but the header (`:41`). Utterances that arrive in the connect replay are shown but never played or reported (DASH-UI-013). Two pages with audio on (for example the operator tab and the OBS source) both play every utterance and both post `voice.playing`; voice accepts that (voice segment, Sink Arbitration Protocol).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| UI technology | One static HTML file with inline JS/CSS, read once at boot | A bundled SPA | The page is one operator panel and one OBS sink view, small enough to need no framework: there is no build step, no frontend dependency (`package.json` has only `ws`, `services/dashboard/package.json:17-21`), and the server serves one file. A bundled SPA would add a toolchain and a build output to ship for no capability the page needs; reading the file once at boot means an edit needs a restart. |
| Where service control lives | In the dashboard process, on a UI-agnostic core (`packages/control`), with the `cohostctl` CLI as a second client | Standalone CLI/TUI only; a compose-API wrapper container | One application that also works in OBS docks; the privilege risk is mitigated by gating. The wrapper container was rejected as compose-only and socket-mounting (`openspec/changes/archive/2026-11-01-add-service-control/design.md`, "Options considered"; commit `1d316ff`). |
| Access control | Bearer token only on mutating routes, only when `CONTROL_ENABLED=1`; loopback bind then; reads (`/ws`, `GET /personality`, `GET /services`) stay open | Always-on auth; auth on every route; gate reads when control is enabled | Owner decision 2026-11-01: the LAN is the trust boundary and control mode guards mutations only. Off by default, loopback bind and a mandatory token when on; "when disabled, behaviour is exactly today's (binds as before, `/control` open)" (`add-service-control/design.md` Decision 4; comment at `control.ts:12`). |
| `POST /sink` gating | Never gated, also when control is enabled | Gate `/sink` with the bearer token | Owner decision 2026-11-01: an OBS Browser Source cannot answer the page's token prompt (`index.html:145-146, 150-164`), so a gated `/sink` would break the stream's audio sink; the LAN is the trust boundary. |
| `POST /sink` validation | Only `playing` and `done` are accepted; anything else is `400` | Treat every non-`playing` value as `done` | Owner decision 2026-11-01: a typo must not release cortex early; the retired OpenSpec enumerated `playing\|done` (`openspec/specs/dashboard/spec.md:53`). |
| Replay into the audio sink | The page shows replayed events but never plays a replayed utterance, recognising replay by the server's `replay: true` marker and de-duplicating by bus event id | Leave `voice.utterance` out of the server backfill; compare publisher `ts` with the socket-open time | Owner decision 2026-11-01: page-side keeps the feed's history intact; a clock comparison would replay old speech or drop new speech under skew. |
| Request body caps | 64 KiB with `413` on every JSON/text route | Unbounded; per-route limits | Owner decision 2026-11-01: matches `/inject/text` (`inject.ts:10`); one limit is enough for control commands, personality text and sink events. |
| Redis unreachable at startup | Log `fatal` and exit non-zero; a failed per-client replay closes only that socket | Keep running without a feed; unhandled rejection | Owner decision 2026-11-01: the bus is not an optional dependency of the dashboard; exiting lets Compose's `restart: unless-stopped` retry with the cause in the log. |
| Bus-level chat mentions | Bus-level `chat.message` keeps `mentionsCohost: false` | Compute mentions in the dashboard | Owner decision 2026-11-01: mention detection is chat's perception step, which bus-level injection skips by design; service-level injection runs it. |
| Sink-mode trigger | Presence of a `sink` query parameter, any value | Read the value (`?sink=1` only) | Owner decision 2026-11-01: presence semantics are simple and the documented `?sink=1` still works. |
| Host-side audio sinks | Reach voice only through the dashboard `/audio/*` proxy | Publish voice's port 8700 | Owner decision 2026-11-01: Compose keeps voice internal; the loopback `urls.voice()` default serves host runs (commit `e53badc`). |
| Page test strategy | `test/page.test.ts` reads the inline `<script>` out of `index.html` and runs it in a `node:vm` context with a hand-written stub DOM, `fetch`, `WebSocket` and `Audio`; manual checks in `docs/TESTING.md` for what a stub cannot cover | A browser harness (Playwright); no page tests; moving the script into a separate served file | Owner decision 2026-11-01: no new browser dependency; the page logic (feed routing, sink queue, escaping) is plain JS a stub DOM can drive. Running the inline script unchanged keeps `index.html` as one file and its line references stable. |
| Connect replay ordering | The feed holds live events for a socket while its replay is read, then sends them once, skipping ids the replay held | Add the socket to the client set only after the replay (loses events between the read and the add); dedupe on the page alone (a live event could still render before older replayed ones) | `ws` adds the socket to `wss.clients` before `connection` fires, so the hold has to be server-side to give oldest-first order; the page de-duplicates by id as well, for reconnects. |
| Audio proxy body | Buffer the whole upstream body, then write status and headers | Stream upstream to the browser | A streamed response has already sent its status when the upstream read fails, so it cannot be answered `500`; clips are short (voice already serves whole WAV files). |
| Startup failure on bad control config | `setupControl` throws | Start with control disabled | "Startup fails fast if enabled without `CONTROL_TOKEN`" (`add-service-control/design.md` Decision 4); comments at `control.ts:18` and `packages/control/src/config.ts:23`. |
| Upload handling | In-memory store, bus carries only a URL, unguessable id as capability; `/uploads/:id` unauthenticated | Base64 in the event; shared volume or tmp dir | Base64 bloats the capped stream, every consumer group and every WebSocket backfill; a shared path breaks across containers and hosts; a tmp dir needs crash cleanup; services hold no token, so the 128-bit id is the capability (`openspec/changes/archive/2026-11-01-add-test-injection/design.md` D2, D3; comment at `uploads.ts:45`; commit `3fae9f7`). |
| Binary upload encoding | Raw request body with options in the query string | Multipart; base64 JSON | No multipart parser dependency on plain `node:http`; browser `fetch` and `MediaRecorder` blobs send raw bodies natively; base64 costs 33% (`add-test-injection/design.md` D4). |
| Injection levels | `service` runs the real path through chat/eyes/ears; `bus` publishes the perception event directly, text only | Single level | Bus-level image/audio has no pixels or audio to process, so it is text only; owner-confirmed (`add-test-injection/design.md` D1 and "Owner-confirmed decisions"). |
| Injection result reporting | `202 {id}` immediately; `inject.result` correlated by id on `/ws`; client-side 10 s "no response" | Block the HTTP call; rely on heartbeat deps | Without a per-request result, failures are indistinguishable; heartbeats describe a service, not a request (`add-test-injection/design.md` D5). |
| Feed transport | One shared `bus.tail` fanned out to all sockets, with a 60-event backfill per client | Per-client consumer groups | `tail` is the event-bus "non-group live tail (dashboard). Does not ack, does not replay" (`packages/bus/src/index.ts:229`). Browsers only observe: every socket wants every event, nothing is acked, and nothing must survive a reconnect beyond the 60-event backfill. A consumer group per socket would leave groups and pending entries in Redis after each disconnect and add an ack path for work no one does; one shared read also keeps Redis load constant however many pages are open. |
| Health in the UI | Server-side `HealthTracker`, pushed as `services` messages on change plus a 1 s tick, and available at `GET /services` | Browser derives state from raw heartbeats | Services report facts and thresholds belong to the monitor; the dashboard owns one tracker fed by `tailHealth` and pushes on change and on a 1 s tick (`openspec/changes/archive/2026-11-01-add-service-health/design.md` D3, D6; commit `691b079`). |
| Audio sink location | Browser page plays audio and reports `voice.playing` / `voice.done` | Server-side playback | An OBS Browser Source with "control audio via OBS" puts the voice on stream "with no virtual cables" (`index.ts:5-7`). |
| Voice URL default | `urls.voice()`: `VOICE_URL`, else `http://127.0.0.1:<VOICE_PORT or 8700>`; Compose sets `VOICE_URL=http://voice:8700` | Hard-coded `http://voice:8700` | Host runs outside Docker could not resolve `voice`; fixed for issue #10 (commit `e53badc`, "default VOICE_URL to loopback outside Docker"). |

## Open Questions & Future Decisions

1. If the browser blocks autoplay, `a.play()` rejects, `audioOn` flips off, that utterance is dropped from the queue and the rest of the queue is cleared, with no `done` posted (`index.html:147`).
2. Bus-level injection returns an `id` that no published event carries (`inject.ts:90, 102-113`), so it cannot be correlated; the UI special-cases this ("published at bus level (no service result)", `index.html:195`).
3. Service-level text injection sends the raw `b.text` whereas bus-level collapses whitespace (`inject.ts:91, 95`); chat normalises whitespace on the service path itself.
4. `index.html` carries a duplicated comment on the same CSS line (`:41`) and the pause/resume commands are reachable only by raw `POST /control` (`:165-171`).

## References

Files in segment:
- `services/dashboard/src/index.ts`, `routes.ts`, `feed.ts`, `control.ts`, `inject.ts`, `uploads.ts`, `health.ts`
- `services/dashboard/public/index.html`
- `services/dashboard/test/routes.test.ts`, `feed.test.ts`, `control.test.ts`, `inject.test.ts`, `uploads.test.ts`, `page.test.ts` (the page script under a stub DOM)
- `services/dashboard/package.json`, `services/dashboard/tsconfig.json`

Other segments (direction):
- event-bus: publishes `control`, `voice.playing`, `voice.done`, `inject.request`, `chat.message`, `speech.heard`, `vision.summary`, `service.lifecycle`; reads the whole main stream (`tail`, `recent`) and the health stream (`recentHealth`, `tailHealth`). Schemas in `packages/bus/src/events.ts`.
- control-plane: `HealthTracker`, `ServiceController`, `ComposeRuntime` / `ProcessRuntime`, `loadControlConfig`, `bearerOk`, `isLoopback`; heartbeat contract (`startHeartbeat`, `HeartbeatSpec`).
- config: `loadConfig`, `urls.voice()`, `urls.dashboard()`, `loadPersonality`, `savePersonality`, `cfg.cohost.name`, `cfg.dashboard.port`.
- voice: source of `/audio/<id>.wav` and `voice.utterance`; consumer of `voice.playing` / `voice.done` with `sink: "dashboard"`.
- chat, eyes, ears: handle `inject.request` for `target` chat / eyes / ears and publish `inject.result`; eyes and ears fetch `/uploads/<id>` from this service.
- avatar: publishes `avatar.state` for the preview; consumes the sink's `voice.playing` / `voice.done`.
- cortex, salience, affect: consume `control` (mute, say, forget_context, reload_personality, pause, resume); cortex publishes `brain.status {state, detail?}`.
- deployment: compose publishes port 3000, sets `VOICE_URL` and `DASHBOARD_URL`.

External: `ws` (WebSocket server); browser APIs `WebSocket`, `Audio`, `MediaRecorder`, `sessionStorage`.

Retired OpenSpec (historical): `openspec/specs/dashboard/spec.md`; `openspec/changes/archive/2026-11-01-add-service-health/` (design D3, D6); `openspec/changes/archive/2026-11-01-add-service-control/` (design, Decisions 4, 8, 9); `openspec/changes/archive/2026-11-01-add-test-injection/` (design D1 to D5, D9, D10).
