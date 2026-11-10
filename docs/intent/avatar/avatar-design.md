---
parent: high-level-design
prefix: AVATAR
---

# avatar

Mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at git `1b57790`. Describes the intended design; where the code does not yet match, the text names the gap and its spec ID. A rationale cell cites the code comment, design note or owner decision (2026-11-01) that states the reason; where no such source exists, the cell gives the engineering reason the design rests on. See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/avatar` is the "face" half of the body (the other half is `voice`). It listens to the bus, works out what the avatar should look like at each instant, and pushes that to whatever avatar application the operator runs (VTube Studio for Live2D, a VMC receiver for 3D/VRM, or nothing). It publishes `avatar.state` so the dashboard can draw a stand-in face.

The code states its own philosophy in two comments: "Engine owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`services/avatar/src/engine.ts:6-9`) and "Keep drivers dumb: no timing, no smoothing, no decisions" (`services/avatar/src/types.ts:31-34`). So the design is a canonical-state engine (`AvatarParams`, `types.ts:8-17`) feeding thin per-app translators behind the `AvatarDriver` interface (`types.ts:35-47`). New apps are added by implementing the interface, adding a `case` in `drivers/index.ts:12-26`, extending the `avatar.driver` enum in `packages/config/src/schema.ts:167`, and adding a block to `config/expressions.yaml` (instructions in the comment at `drivers/index.ts:7-11`).

Everything is driven by the bus; the service exposes no HTTP surface and no inbound control other than the five event types it consumes.

## Process wiring and event flow

Startup order. `index.ts` only supplies a `setup` function (steps 1, 2 and 4) to `runAvatar` (`boot.ts:39-87`), which runs every step inside one `try`, so any failure logs `fatal` and exits 1 (AVATAR-BUS-007), and nothing waits for the avatar app.

1. `loadConfig()` then `new Bus("avatar")`.
2. `createDriver(cfg.avatar)` selects the driver. An unknown `avatar.driver` never gets here: config validation rejects it before any service starts, and an unset or empty `AVATAR_DRIVER` loads as `null` (AVATAR-DRV-003, AVATAR-DRV-004).
3. `startHeartbeat(bus, {...avatarHealth(driver), log})`. It publishes `starting` now and `ready` only at step 8.
4. `loadExpressions()[cfg.avatar.driver] ?? { gestures: {} }`, then `gestures` is split from the emotion map. A missing driver block is silently an empty map.
5. The `Engine` is constructed with an `onState` callback (`statePublisher`, `state.ts`) that publishes `avatar.state` at most once per 200 ms; at the default 30 fps that is every 7th frame, about 4.3 Hz. A failed publish drops that state and is logged at most once per 10 s (AVATAR-STATE-002).
6. `onShutdown` stops the engine, disconnects the driver and stops the bus (`boot.ts:49`). `startHeartbeat` registers its own pre-shutdown hook that publishes the `stopping` heartbeat (`packages/bus/src/index.ts`, owned by control-plane).
7. `driver.connect({log, expressions, gestures, stateDir})` is started without being awaited, with a `.catch` that logs `fatal` and exits 1 (a rejecting connect is a startup failure); `engine.start()` follows at once (AVATAR-VTS-002). The VTube Studio driver reports itself disconnected until it authenticates, and the heartbeat shows `degraded` meanwhile.
8. `bus.resetGroup("avatar")` creates the consumer group at the newest entry, then `heartbeat.ready()`: readiness means "can receive events", not "driver connected"; connection state rides in `deps.driver` and can make the state `degraded` (see Health; AVATAR-HEALTH-001). Then the subscription loop starts. The bus has no "subscribed" notification, so boot positions the group itself and `subscribe` positions it again (`latest` resets once more); an event in the few milliseconds between is dropped, which `latest` allows.

A subscription rejection (AVATAR-BUS-008) is the last way the awaited loop can end the service; it takes the same `fatal` path.

### Events

| Direction | Event | Handling | Evidence |
|---|---|---|---|
| in | `brain.say` | `engine.setEmotion(emotion, 6000)`: show the emotion as soon as the brain decides, before any audio exists | `boot.ts` (`brain.say` case) |
| in | `voice.utterance` | `engine.prepare({id, emotion, gesture, envelope, envelopeHz, durationMs})`: remember the audio's mouth envelope | `boot.ts` (`voice.utterance` case) |
| in | `voice.playing` | `engine.play(id)`: any sink may claim it; the `sink` field is ignored | `boot.ts` (`voice.playing` case) |
| in | `voice.done` | `engine.done(id)` | `boot.ts` (`voice.done` case) |
| in | `affect.state` | `engine.setMood(mood)`: the resting face | `boot.ts` (`affect.state` case) |
| out | `avatar.state` | Every canonical `AvatarParams` value (including `mouthSmile`) plus `emotion`, `intensity`, `driver`, `connected`, at most once per 200 ms (AVATAR-STATE-001). The schema carries `mouthSmile` (`packages/bus/src/events.ts:159-172`; BUS-EVT-018), so the dashboard preview, which reads `s.mouthSmile` (`services/dashboard/public/index.html:340`), gets a number | `state.ts:17-32` |

The subscription uses consumer group `avatar` with the event-bus `latest` start mode: the group moves to the newest entry on every start, so a restart never replays stale `brain.say` or `voice.*` events as flashing expressions and lip-sync (AVATAR-BUS-001). This holds for a compose `restart: unless-stopped` restart (`docker-compose.yml:10`) as well as for the control plane's `fresh` start (avatar's manifest default, `packages/control/src/manifest.ts:46`). The bus wrapper acks every entry even when the handler throws (`packages/bus/src/index.ts`).

Bus failures follow the cross-cutting rule: a failed `avatar.state` publish is dropped and logged at a limited rate, and avatar keeps animating (AVATAR-STATE-002); the bus retries a failed subscription read, and a subscription rejection that still escapes is logged and ends the process non-zero (AVATAR-BUS-008). Both calls are handled: the subscription is awaited inside `runAvatar`'s `try` (`boot.ts:60`) and the `avatar.state` publish has a `.catch` (`state.ts:26-30`). Nothing in the workspace handles `unhandledRejection`, so an unhandled failure would end the process on Node 22. They fail differently in a Redis outage: the subscriber connection uses `maxRetriesPerRequest: null` and simply waits for the reconnect (`packages/bus/src/index.ts:131`), while the publisher gives up after three attempts (`maxRetriesPerRequest: 3`, `packages/bus/src/index.ts:44`), so the 5 Hz `avatar.state` publish rejects within about a second of losing Redis.

Lip-sync is deliberately keyed to `voice.playing`, not `voice.utterance`: the envelope is cached on `prepare` and the mouth only starts moving when some sink reports it has actually started playing (`engine.ts:32-45`). The dashboard's browser sink, the Discord sink and voice's own `virtual` sink all report this; avatar does not care which, so it also mouths lines that no sink is playing aloud. Following `virtual` is intended: it is the only playback signal when no sink is attached. When a real sink starts after voice's 1.5 s claim window, avatar sees two `voice.playing` for the id (the second restarts lip-sync from the first envelope value). Voice cancels the pending virtual `voice.done` on such a late claim, so lip-sync ends on the real sink's `voice.done` ([voice LLD](../voice/voice-design.md), Sink Arbitration Protocol; VOICE-SINK-008).

## Engine

`Engine` (`engine.ts:10-115`) is a fixed-rate loop (`setInterval(1000 / cfg.fps)`, `engine.ts:26-29`) over three pieces of state:

- `cur` / `target`: `AvatarParams` current and goal values, both starting at `NEUTRAL` (`engine.ts:11-12`, `types.ts:49`).
- Emotion state: `emotion` (what is shown), `emotionUntil` (hold deadline, epoch ms), and `mood` (the resting face from `affect.state`) (`engine.ts:13-16`).
- Playback state: `known` (a `Map` of up to 20 prepared utterances, oldest-inserted evicted, `engine.ts:33-36`) and `playing` (the utterance and its start time).

Public entry points: `prepare`, `play`, `done`, `setEmotion`, `setMood`, `start`, `stop`.

Emotion rules:

- `setEmotion(e, holdMs=4000)` sets the emotion, the hold deadline, and calls `driver.setExpression(e, 1)` immediately (`engine.ts:51-55`).
- `play(id)` for a known id starts playback, calls `setEmotion(u.emotion, durationMs + 4000)` and fires the utterance's gesture through `driver.trigger` if present (`engine.ts:39-45`). Unknown ids are silently ignored. Note the second `setEmotion` replaces the 6000 ms hold set by `brain.say`; a short utterance therefore shortens the hold.
- `setMood(e)` is a no-op for the same mood; otherwise it stores the mood and, only if no hold is active (`Date.now() > emotionUntil`), shows it immediately at intensity 0.5 (0 for neutral) (`engine.ts:58-65`).
- When a hold expires and `emotion !== mood`, the frame loop falls back to the mood with the same 0.5/0 intensity (`engine.ts:82-85`).
- Reported intensity for `avatar.state` is 0 for neutral, 1 while a hold is active, else 0.5 (`engine.ts:113`). This is computed separately from the intensity passed to `driver.setExpression`, so a held `neutral` emotion is `1` to the driver and `0` in `avatar.state`.

Per-frame pipeline (`engine.ts:67-114`):

1. Mouth: `mouthOpen` target is `envelope[floor(elapsed * envelopeHz)]` while playing, else 0; once the index has run past the envelope, `playing` clears itself when `elapsed > durationMs + 500` (`engine.ts:71-79`). `done(id)` for the playing id clears it at once, so the target drops to 0 on the next frame and the mouth eases shut at the mouth smoothing rate.
2. Emotion decay (above) and `mouthSmile` target: 0.7 for `happy`, `laugh`, `smug`, else 0.15 (`engine.ts:86`).
3. Idle motion, only when `cfg.idle_motion`: slow sines for head yaw/pitch/roll and eyes, with head X/Y gain 1.6 while speaking (`engine.ts:89-96`). When disabled these targets are never written, so they stay at 0.
4. Blink: first blink about 3 s after construction, then every 2.5-6 s, closed for 120 ms (`engine.ts:19, 99-103`).
5. Smoothing: each param moves `rate` of the way to target; `mouthOpen` uses `min(1, smoothing * 3)`, `blink` uses 1, everything else `smoothing` (`engine.ts:105-110`).
6. `driver.setParams(cur)` then `onState(cur, emotion, intensity)` every frame (`engine.ts:112-113`); throttling is the caller's job.

## Drivers

The contract: `name`, `connect(ctx)`, `disconnect()`, `connected()`, `setParams(p)` (every frame), `setExpression(emotion, intensity)` (on change), `trigger(gesture)` (fire and forget). `DriverContext` carries a logger, the emotion-to-app-name map, the gesture map and a `stateDir` for small persisted state (`types.ts:21-29`). A driver that cannot do something (VMC has no gestures) ignores the call; there is no capability declaration (AVATAR-DRV-001).

Selection is by `cfg.avatar.driver` (`drivers/index.ts:12-26`). The config schema restricts the value to `vtube-studio | vmc | null` with default `null` (`packages/config/src/schema.ts:166-178`), and `loadConfig` throws on an invalid value (`packages/config/src/index.ts:103-108`). An unknown driver is a configuration error that fails fast; the factory has no fallback for other names (AVATAR-DRV-003, AVATAR-DRV-004). An unset or empty `AVATAR_DRIVER` selects `null`, so a `.env` without avatar settings still loads; the config side (`${AVATAR_DRIVER:-null}` in the example YAML, a blank-safe driver value, defaults for `vtube_studio.port` and `vmc.port`) is owned by [config](../config/config-design.md).

### expressions.yaml

`config/expressions.example.yaml` has a block per driver name. Each block maps canonical emotions (`neutral happy laugh surprised smug sad angry confused think`, `schema.ts:4-6`) to app-specific strings, plus an optional `gestures` map. The schema is a record of records with `gestures` defaulted to `{}` and a string catch-all for the rest (`schema.ts:197-202`). For VTube Studio the values are hotkey names (or `*.exp3.json` expression files); for VMC they are VRM blendshape names (`expressions.example.yaml:1-34`). The real `config/expressions.yaml` is seeded from the example on first run and is git-ignored (`packages/config/src/index.ts:121-135`, `.gitignore`).

### null (`drivers/null.ts`)

Reports `connected() === true`, ignores params and logs expressions and gestures at debug level (`null.ts:5-14`). It is the default and what the "isolated" start mode selects.

### vtube-studio (`drivers/vtube-studio.ts`)

Speaks the VTube Studio public WebSocket API at `ws://host:port` (default port 8001 via `VTS_HOST`/`VTS_PORT`).

- Connect: `open()` creates the socket; on `open` it runs `authenticate()` then `loadHotkeys()` and only then sets `ready` (`vtube-studio.ts:106-123`). `connected()` returns `ready` (`:37`). `connect()` resolves when the first attempt ends, whether it succeeded, failed auth or could not connect (`:111-137`; test `drivers.test.ts:192`), and never rejects. That first attempt can take long: on first pairing it includes up to 60 s for the operator to click Allow plus the 5 s auth and hotkey requests, and for a host that drops packets it is the operating system's TCP connect timeout, since the `ws` client is created with no handshake timeout (`:109`). The service therefore starts its engine and subscription without awaiting it (AVATAR-VTS-002, `boot.ts:52`).
- Auth: token read from `<stateDir>/.vts-token` (`:104`, `stateDir = configDir()` from `index.ts`); `config/.vts-token` is git-ignored (`.gitignore:12`). With no token, sends `AuthenticationTokenRequest` with a 60 s timeout (the operator must click Allow in VTS) and writes the token; then `AuthenticationRequest`. A rejected token blanks the file and throws (`:141-155`).
- Failure and reconnect: any auth or hotkey failure logs and closes the socket; the `close` handler rejects all pending requests and, unless `disconnect()` set `closing`, retries `open()` after 5 s (`:125-133`). There is no backoff and no retry cap.
- Params: while `ready`, `setParams` sends `InjectParameterDataRequest` (mode `set`, `faceFound: true`) with 11 values (`MouthOpen`, `MouthSmile`, `FaceAngleX/Y/Z`, `EyeLeft/RightX/Y`, `EyeOpenLeft/Right = 1 - blink`) clamped to VTS ranges, fire-and-forget (`:53-72`).
- Expressions: `setExpression` picks `expressions[emotion]` when `intensity > 0.05` else nothing; if it equals the remembered `activeExpr` it returns; otherwise it deactivates the old and activates the new and records `activeExpr` (`:74-81`). `activate` sends `ExpressionActivationRequest` for `*.exp3.json` names and `HotkeyTriggerRequest` otherwise (`:93-102`). Hotkeys are toggles, so the driver triggers the same hotkey to turn an expression both on and off and relies on `activeExpr` as its only record of what VTS is showing. That record is cleared when the socket closes and when a connection opens (AVATAR-VTS-013), because VTS resets its model on a restart; expressions requested while disconnected are dropped, and the engine does not re-send the current one after a reconnect.
- Gestures: `trigger` maps the gesture through `ctx.gestures`, finds the hotkey case-insensitively, warns if absent (`:83-90`).
- Hotkeys are loaded once per successful connect (`:157-161`), keyed by lower-cased name; model changes inside VTS are not observed.
- Fire-and-forget calls (`setParams`, `setExpression`, `trigger`) go through `fire()`, which catches a rejection (APIError, timeout, closed socket) and logs `vts request failed` at most every 5 s per kind, so none is an unhandled rejection (AVATAR-VTS-014).
- Requests: `send()` wraps the JSON envelope (`apiName VTubeStudioPublicAPI`, version 1.0, UUID `requestID`) and tracks replies in a `pending` map with a default 5 s timeout; `APIError` replies reject (`:163-188`).

### vmc (`drivers/vmc.ts`)

Hand-rolled OSC over UDP to a VMC receiver (default port 39539 via `VMC_HOST`/`VMC_PORT`), fire-and-forget (`vmc.ts:1-11, 30-35`). `connected()` is true as soon as the socket exists; there is no handshake and no way to know whether anything is listening (`:28`).

Each `setParams` sends: `/VMC/Ext/Bone/Pos` for `Head` with a quaternion from `eulerToQuat(headY, headX, headZ)`, `/VMC/Ext/Blend/Val` for mouth as both `A` (VRM 0.x) and `aa` (VRM 1.0), blink as both `Blink` and `blink`, the active expression value if any, then `/VMC/Ext/Blend/Apply` and `/VMC/Ext/OK 1` (`:37-51`). `setExpression` zeroes the previous blendshape when the target changes and stores the new name and clamped intensity, which is then re-sent every frame (`:53-60`). `trigger` is a no-op (`:62`). The OSC encoder supports strings, float32, and int32 only for addresses ending in `/OK` (`:65-84`). Eye gaze is not sent. The socket has an `error` listener and every datagram goes through `sendDatagram`, whose callback reports a failure (for example a host that does not resolve) as `vmc send failed`, at most every 10 s measured on the monotonic clock (`performance.now`, so a stepped wall clock does not log again early); the driver keeps running (AVATAR-VMC-005).

## Health

`avatarHealth(driver)` (`health.ts:4-11`) returns a `HeartbeatSpec` for service `avatar`: mode `off` when the driver is `null`, else `live`; `deps` is re-read each tick as `{ driver: "n/a" }` for null, else `ok`/`down` from `driver.connected()`. The heartbeat contract is owned by control-plane; `ready()` is called once the consumer group is positioned, without waiting for the driver, so a real driver that is not yet connected shows `degraded` ("dependency down: driver") rather than `starting`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where animation logic lives | One `Engine` computes smoothing, idle motion, blink and lip-sync; drivers translate only | Per-driver animation logic | Comments: the engine "owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`engine.ts:6-9`); "Keep drivers dumb: no timing, no smoothing, no decisions — the engine does that" (`types.ts:31-34`). |
| Lip-sync trigger | Cache envelope on `voice.utterance`, start on `voice.playing` | Start mouth motion on `voice.utterance` | Comments: `prepare` remembers the audio "so we can lip-sync when a sink starts playing" (`engine.ts:32`); the `voice.playing` schema note says "Avatar syncs to this" (`packages/bus/src/events.ts:139`). A sink can start well after `voice.utterance` (ears queues lines and fetches and converts the audio first), so the `voice.playing` a sink publishes when audio starts is the moment the viewer hears the line; starting on `voice.utterance` would move the mouth before, or without, any sound. |
| Early emotion from `brain.say` | Show emotion before audio exists with a 6000 ms hold | Wait for `voice.utterance` | Comment: "Show the emotion as soon as it decides, before audio exists — feels more alive" (`boot.ts`, `brain.say` case). The 6000 ms hold is a starting value meant to outlast synthesis plus voice's 1.5 s claim window, so the face does not fall back to the mood before the line is heard; `play` then replaces it with the utterance's own `durationMs + 4000` hold. |
| Resting face | `affect.state` mood is the fallback expression at intensity 0.5; held utterance emotions win | Mood overrides immediately | Comment: "Mood changes show up softly, and only when no utterance is holding the face" (`engine.ts:57`); test `engine.test.ts:110`. |
| Connect behavior | VTS `connect()` resolves on error and is not awaited by startup; the engine and subscription start at once; reconnect every 5 s forever | Fail startup when the app is absent; await the first attempt (bounded or not) | Comment: "don't block startup; close handler schedules the retry" (`vtube-studio.ts:136`). Owner decision 2026-11-01: "not blocked" means the face and the subscription run while VTS is pairing or unreachable. Failures degrade and are reported (the heartbeat shows `degraded`), never end the service, so retrying never stops: the operator may start VTS at any point in a stream. VTS is a local LAN app, so a reconnect attempt is cheap, and a fixed 5 s interval means the face returns within 5 s of VTS starting, where a backoff would make a late start wait longer. |
| Token persistence | Plain file `<configDir>/.vts-token`, git-ignored and kept out of the image build context | Env var, Redis | Header comment: the token "is saved to <config>/.vts-token so it only happens once" (`vtube-studio.ts:3-4`). Owner decision 2026-11-01: the token is a secret and stays out of git and the build context (`.gitignore:12`; `.dockerignore` is deployment's). VTS issues the token at runtime, after the operator clicks Allow, so the service must write it itself: an env var cannot be written back, and Redis is the event bus, not durable secret storage. The config dir is already a host-mounted volume (`docker-compose.yml:21-22`), so a file there survives container rebuilds. |
| VMC transport | Own OSC encoder, UDP fire-and-forget | OSC library, TCP | Comment: "minimal OSC encoder (strings, int32, float32) — enough for VMC" (`vmc.ts:65`); UDP is what VMC receivers accept (`vmc.ts:1-3`). VMC needs three OSC argument types, which a few dozen lines encode, so the driver adds no dependency; TCP is not an option VMC receivers offer. |
| Both VRM 0.x and 1.0 names | Send `A`/`aa` and `Blink`/`blink` every frame | A per-model setting | Header comment: VRM 1.0 uses lowercase names, "so the driver sends mouth as both "A" and "aa" and blink as both "Blink"/"blink"" (`vmc.ts:8-10`). |
| Default driver | `null`, also for an unset or empty `AVATAR_DRIVER` | Require an explicit choice | Comment: "null = no avatar app, dashboard only" (`.env.example:44`); isolated starts force it (`packages/control/src/manifest.ts:46`; `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md`, D2). Owner decision 2026-11-01: a `.env` without avatar settings must load (config writes `${AVATAR_DRIVER:-null}`). |
| Unknown driver name | Fail fast: config validation rejects it; the factory has no fallback | Fall back to the null driver (the frozen OpenSpec's "Null driver" scenario) | Owner decision 2026-11-01: a typo in `AVATAR_DRIVER` is a configuration error the operator should see at once, not a silently missing avatar. |
| Capability declaration | None; a driver ignores calls it cannot honour | `capabilities()` on every driver | Owner decision 2026-11-01: nothing consumes it; it was only logged. |
| Lip-sync source | Follow every `voice.playing` / `voice.done`, including voice's `virtual` sink | Ignore `virtual`; follow only real sinks | Owner decision 2026-11-01: `virtual` is the only playback signal when no sink is attached; the late-sink double lifecycle is fixed in voice (VOICE-SINK-008). |
| Restart replay | Event-bus start mode `latest` (newest entry on every start) | Resume the backlog | Owner decision 2026-11-01: replayed `brain.say` and `voice.*` events would flash stale expressions and lip-sync. |
| Bus failures | Drop a failed `avatar.state` publish and log at a limited rate; a subscription rejection that survives the bus retry exits non-zero | Crash on any failure | Owner decision 2026-11-01 (cross-cutting): a lost preview frame must never end the face; a dead subscription is a clear, restartable failure. |
| Startup errors | All setup inside `main()`; any failure logs `fatal` and exits 1 | Module-level setup | Owner decision 2026-11-01 (cross-cutting): every startup failure is reported with the same log line. |
| `avatar.state` rate | Engine emits every frame, service throttles to at most once per 200 ms | Engine throttles | Comment: "5 Hz is plenty for the dashboard preview" (`state.ts:12`). |
| Readiness | `ready` once the engine runs and the `avatar` group is positioned with `resetGroup`; the driver may still be connecting (`deps.driver` shows it) | `ready` as soon as the driver object exists; `ready` only after the driver connects; a "subscribed" hook in event-bus | Owner decision 2026-11-01 (R3): ready means "can receive events", and the avatar app being absent is a dependency state, not an unready service. The bus has no hook that fires when `subscribe` has created the group and `subscribe` resolves only at stop, so boot positions the group itself; a hook would remove the duplicate positioning but needs an event-bus change. |
| Rejecting `driver.connect` | `fatal` and exit 1, though connect is not awaited | Ignore it; log and carry on | A rejection is a startup failure (AVATAR-BUS-007). The VTube Studio driver never rejects, so this reaches only a malformed host URL or a future driver's bug. |

## Open Questions & Future Decisions

1. `known` eviction uses `Map` insertion order (`engine.ts:35`): re-preparing an existing id does not move it to the newest slot, so a re-sent id can be evicted early.
2. Neutral handling differs by path: a held `neutral` emotion (from `brain.say`) calls `driver.setExpression("neutral", 1)`, so VTS toggles `expressions.neutral`; returning to a neutral mood calls it with intensity 0, which VTS treats as "clear" (`intensity > 0.05` check, `vtube-studio.ts:76`) and VMC treats as value 0 (`vmc.ts:59`). `avatar.state` reports intensity 0 for neutral in both cases (`engine.ts:113`).
3. Utterances interrupted by a new `voice.playing` for another id are replaced without a `done` (`engine.ts:42`); there is no explicit handling of overlapping sinks. The dashboard sink and Discord sink arbitration is a voice concern.
4. `services/avatar/tsconfig.json` has `include: ["src"]` and references only config and bus (`tsconfig.json:4-5`), so tests are not type-checked by `tsc -b`; they run through tsx only.
5. Boot wiring is tested through `runAvatar` with an injected setup, bus, driver, shutdown and exit (`services/avatar/test/boot.test.ts`); real signal handling and process exit are not exercised. Still untested: the VTS 5 s reconnect and its cancellation (AVATAR-VTS-007), the request timeout (AVATAR-VTS-006), the expression-not-found warning (AVATAR-VTS-015), the auto-clear of a playing utterance (AVATAR-ENG-006), and `loadExpressions` in `index.ts` (AVATAR-DRV-005). The non-blocking VTS start (AVATAR-VTS-002) is untested for a host that drops packets; for such a host the first attempt lasts the operating system's TCP connect timeout, because the `ws` client is created with no handshake timeout (`vtube-studio.ts:118`).

## References

Files in segment:
- `services/avatar/src/index.ts`, `boot.ts`, `state.ts`, `engine.ts`, `types.ts`, `health.ts`
- `services/avatar/src/drivers/index.ts`, `null.ts`, `vmc.ts`, `vtube-studio.ts`
- `services/avatar/test/boot.test.ts`, `state.test.ts`, `engine.test.ts`, `drivers.test.ts`, `health.test.ts`
- `services/avatar/package.json`, `services/avatar/tsconfig.json`
- `config/expressions.example.yaml`

Other segments (direction):
- event-bus: consumes `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; produces `avatar.state` (schemas at `packages/bus/src/events.ts:52, 95, 139, 154-155, 159`).
- config: reads `Config["avatar"]`, `loadExpressions`, `configDir`, `Emotion` (`packages/config/src/schema.ts:4-8, 166-178, 197-202`); owns the `avatar.driver` blank-safe default and the port defaults.
- control-plane: heartbeat contract (`startHeartbeat`, `HeartbeatSpec`), health tracking, healthcheck, and the `AVATAR_DRIVER=null` isolated start (manifest).
- voice: produces `voice.utterance` (envelope) and arbitrates sinks that emit `voice.playing` / `voice.done`.
- affect: produces `affect.state` mood.
- cortex: produces `brain.say` (via the bus).
- dashboard: consumes `avatar.state` for the preview and emits `voice.playing`/`voice.done` as sink "dashboard".

External: `ws` (VTube Studio WebSocket), Node `dgram` (UDP), VTube Studio public API, VMC protocol.

OpenSpec: `openspec/specs/avatar/spec.md`; `openspec/changes/archive/2026-11-01-add-service-health/specs/avatar/spec.md`.
