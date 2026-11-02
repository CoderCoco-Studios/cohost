---
parent: high-level-design
prefix: AVATAR
---

# avatar

Mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at git `1b57790`. Describes the intended design; where the code does not yet match, the text names the gap and its spec ID. A rationale cell cites the code comment, design note or owner decision (2026-11-01) that states the reason; cells still marked `[inferred]` have no such source and wait for the project owner. See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/avatar` is the "face" half of the body (the other half is `voice`). It listens to the bus, works out what the avatar should look like at each instant, and pushes that to whatever avatar application the operator runs (VTube Studio for Live2D, a VMC receiver for 3D/VRM, or nothing). It publishes `avatar.state` so the dashboard can draw a stand-in face.

The code states its own philosophy in two comments: "Engine owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`services/avatar/src/engine.ts:6-9`) and "Keep drivers dumb: no timing, no smoothing, no decisions" (`services/avatar/src/types.ts:31-34`). So the design is a canonical-state engine (`AvatarParams`, `types.ts:8-17`) feeding thin per-app translators behind the `AvatarDriver` interface (`types.ts:35-47`). New apps are added by implementing the interface, adding a `case` in `drivers/index.ts:12-26`, extending the `avatar.driver` enum in `packages/config/src/schema.ts:167`, and adding a block to `config/expressions.yaml` (instructions in the comment at `drivers/index.ts:7-11`).

Everything is driven by the bus; the service exposes no HTTP surface and no inbound control other than the five event types it consumes.

## Process wiring and event flow

Intended startup order: every step below runs inside `main()`, so any failure logs `fatal` and exits 1 (AVATAR-BUS-007), and nothing waits for the avatar app.

1. `loadConfig()` then `new Bus("avatar")`.
2. `createDriver(cfg.avatar)` selects the driver. An unknown `avatar.driver` never gets here: config validation rejects it before any service starts, and an unset or empty `AVATAR_DRIVER` loads as `null` (AVATAR-DRV-003, AVATAR-DRV-004).
3. `startHeartbeat(bus, {...avatarHealth(driver), log})` and an immediate `heartbeat.ready()`. Readiness therefore means "driver object chosen", not "driver connected"; connection state rides in `deps.driver` and can make the state `degraded` (see Health).
4. `loadExpressions()[cfg.avatar.driver] ?? { gestures: {} }`, then `gestures` is split from the emotion map. A missing driver block is silently an empty map.
5. The `Engine` is constructed with an `onState` callback that publishes `avatar.state` at most once per 200 ms; at the default 30 fps that is every 7th frame, about 4.3 Hz. A failed publish drops that state and is logged at a limited rate (AVATAR-STATE-002).
6. `driver.connect({log, expressions, gestures, stateDir: configDir()})` is started without being awaited; the engine and the bus subscription start at once (AVATAR-VTS-002). The VTube Studio driver reports itself disconnected until it authenticates, and the heartbeat shows `degraded` meanwhile.
7. `onShutdown` stops the engine, disconnects the driver, stops the bus (`index.ts:58`). `startHeartbeat` registers its own pre-shutdown hook that publishes the `stopping` heartbeat (`packages/bus/src/index.ts:231-257`, owned by control-plane).

The code differs in two places. Steps 1-5 run at module level (`index.ts:12-27`), outside `main()`, so a config or expressions error ends the process through Node's uncaught-exception path without the `fatal` log; only `main()` has the `.catch` (`index.ts:57`), and little inside it can reject (the reachable case is `new WebSocket(url)` throwing on a malformed `ws://host:port`, `vtube-studio.ts:108-109`). And `main()` awaits `driver.connect(...)` before `engine.start()` and the subscription (`index.ts:29-34`), so a first VTS pairing or an unreachable host holds the whole face back (see Drivers).

### Events

| Direction | Event | Handling | Evidence |
|---|---|---|---|
| in | `brain.say` | `engine.setEmotion(emotion, 6000)`: show the emotion as soon as the brain decides, before any audio exists | `index.ts:38-43` |
| in | `voice.utterance` | `engine.prepare({id, emotion, gesture, envelope, envelopeHz, durationMs})`: remember the audio's mouth envelope | `index.ts:44-48` |
| in | `voice.playing` | `engine.play(id)`: any sink may claim it; the `sink` field is ignored | `index.ts:50` |
| in | `voice.done` | `engine.done(id)` | `index.ts:51` |
| in | `affect.state` | `engine.setMood(mood)`: the resting face | `index.ts:49` |
| out | `avatar.state` | Every canonical `AvatarParams` value (including `mouthSmile`) plus `emotion`, `intensity`, `driver`, `connected`, at most once per 200 ms (AVATAR-STATE-001). The schema does not yet carry `mouthSmile` and publish strips it (`packages/bus/src/events.ts:159-171`; BUS-EVT-018), so the dashboard preview, which reads `s.mouthSmile` (`services/dashboard/public/index.html:340`), gets `undefined` | `index.ts:22-27` |

The subscription uses consumer group `avatar` with the event-bus `latest` start mode: the group moves to the newest entry on every start, so a restart never replays stale `brain.say` or `voice.*` events as flashing expressions and lip-sync (AVATAR-BUS-001). The code still passes `fromNow: true` (`index.ts:35`), which positions only a newly created group (`packages/bus/src/index.ts:133-138`); an existing group resumes after its last-delivered entry. Today only the control plane's `fresh` start (avatar's manifest default, `packages/control/src/manifest.ts:46`) resets the group first; a compose `restart: unless-stopped` restart (`docker-compose.yml:10`) does not. The bus wrapper acks every entry even when the handler throws (`packages/bus/src/index.ts:157-167`).

Bus failures follow the cross-cutting rule: a failed `avatar.state` publish is dropped and logged at a limited rate, and avatar keeps animating (AVATAR-STATE-002); the bus retries a failed subscription read, and a subscription rejection that still escapes is logged and ends the process non-zero (AVATAR-BUS-008). Today both calls are `void`-ed with no `.catch`: the subscription (`index.ts:34`) and the `avatar.state` publish (`index.ts:26`). Nothing in the workspace handles `unhandledRejection`, so on Node 22 either failure ends the process. They fail differently in a Redis outage: the subscriber connection uses `maxRetriesPerRequest: null` and simply waits for the reconnect (`packages/bus/src/index.ts:131`), while the publisher gives up after three attempts (`maxRetriesPerRequest: 3`, `packages/bus/src/index.ts:44`), so the 5 Hz `avatar.state` publish rejects within about a second of losing Redis.

Lip-sync is deliberately keyed to `voice.playing`, not `voice.utterance`: the envelope is cached on `prepare` and the mouth only starts moving when some sink reports it has actually started playing (`engine.ts:32-45`). The dashboard's browser sink, the Discord sink and voice's own `virtual` sink all report this; avatar does not care which, so it also mouths lines that no sink is playing aloud. Following `virtual` is intended: it is the only playback signal when no sink is attached. When a real sink starts after voice's 1.5 s claim window, avatar sees two `voice.playing` for the id (the second restarts lip-sync from the first envelope value). Voice cancels the pending virtual `voice.done` on such a late claim, so lip-sync ends on the real sink's `voice.done` ([voice LLD](../voice/voice-design.md), Sink Arbitration Protocol; VOICE-SINK-008); until that lands, the virtual `voice.done` can end lip-sync while the real audio is still playing.

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

The contract: `name`, `connect(ctx)`, `disconnect()`, `connected()`, `setParams(p)` (every frame), `setExpression(emotion, intensity)` (on change), `trigger(gesture)` (fire and forget). `DriverContext` carries a logger, the emotion-to-app-name map, the gesture map and a `stateDir` for small persisted state (`types.ts:21-29`). A driver that cannot do something (VMC has no gestures) ignores the call; there is no capability declaration (AVATAR-DRV-001). The code still declares `capabilities()` (`expressions | params | gestures | lipsync`, `types.ts:37`) on every driver; only the startup log reads it (`index.ts:31`).

Selection is by `cfg.avatar.driver` (`drivers/index.ts:12-26`). The config schema restricts the value to `vtube-studio | vmc | null` with default `null` (`packages/config/src/schema.ts:166-178`), and `loadConfig` throws on an invalid value (`packages/config/src/index.ts:103-108`). An unknown driver is a configuration error that fails fast; the factory has no fallback for other names (AVATAR-DRV-003, AVATAR-DRV-004). The code still carries an unreachable `default:` fallback to `NullDriver` (`drivers/index.ts:24-25`). An unset or empty `AVATAR_DRIVER` is meant to select `null`, so a `.env` without avatar settings still loads; the config side (`${AVATAR_DRIVER:-null}` in the example YAML, a blank-safe driver value, defaults for `vtube_studio.port` and `vmc.port`) is owned by [config](../config/config-design.md). Today `config/config.example.yaml:134` writes `driver: "${AVATAR_DRIVER}"`, an unset or empty variable substitutes to `""` (`packages/config/src/index.ts:34-39`), and the enum rejects it, so the working default is `AVATAR_DRIVER=null` in `.env.example:45`, and because every service loads the whole config an empty `AVATAR_DRIVER` stops every service from starting.

### expressions.yaml

`config/expressions.example.yaml` has a block per driver name. Each block maps canonical emotions (`neutral happy laugh surprised smug sad angry confused think`, `schema.ts:4-6`) to app-specific strings, plus an optional `gestures` map. The schema is a record of records with `gestures` defaulted to `{}` and a string catch-all for the rest (`schema.ts:197-202`). For VTube Studio the values are hotkey names (or `*.exp3.json` expression files); for VMC they are VRM blendshape names (`expressions.example.yaml:1-34`). The real `config/expressions.yaml` is seeded from the example on first run and is git-ignored (`packages/config/src/index.ts:121-135`, `.gitignore`).

### null (`drivers/null.ts`)

Reports `connected() === true`, ignores params and logs expressions and gestures at debug level (`null.ts:5-15`); it still declares all four capabilities (`null.ts:8`) until `capabilities()` is removed. It is the default and what the "isolated" start mode selects.

### vtube-studio (`drivers/vtube-studio.ts`)

Speaks the VTube Studio public WebSocket API at `ws://host:port` (default port 8001 via `VTS_HOST`/`VTS_PORT`).

- Connect: `open()` creates the socket; on `open` it runs `authenticate()` then `loadHotkeys()` and only then sets `ready` (`vtube-studio.ts:106-123`). `connected()` returns `ready` (`:37`). `connect()` resolves when the first attempt ends, whether it succeeded, failed auth or could not connect (`:111-137`; test `drivers.test.ts:172`), and never rejects. That first attempt can take long: on first pairing it includes up to 60 s for the operator to click Allow plus the 5 s auth and hotkey requests, and for a host that drops packets it is the operating system's TCP connect timeout, since the `ws` client is created with no handshake timeout (`:109`). The service therefore starts its engine and subscription without awaiting it (AVATAR-VTS-002); the code still awaits it in `main()` (`index.ts:30-34`).
- Auth: token read from `<stateDir>/.vts-token` (`:104`, `stateDir = configDir()` from `index.ts:30`); `config/.vts-token` is git-ignored (`.gitignore:12`). With no token, sends `AuthenticationTokenRequest` with a 60 s timeout (the operator must click Allow in VTS) and writes the token; then `AuthenticationRequest`. A rejected token blanks the file and throws (`:141-155`).
- Failure and reconnect: any auth or hotkey failure logs and closes the socket; the `close` handler rejects all pending requests and, unless `disconnect()` set `closing`, retries `open()` after 5 s (`:125-133`). There is no backoff and no retry cap.
- Params: while `ready`, `setParams` sends `InjectParameterDataRequest` (mode `set`, `faceFound: true`) with 11 values (`MouthOpen`, `MouthSmile`, `FaceAngleX/Y/Z`, `EyeLeft/RightX/Y`, `EyeOpenLeft/Right = 1 - blink`) clamped to VTS ranges, fire-and-forget (`:53-72`).
- Expressions: `setExpression` picks `expressions[emotion]` when `intensity > 0.05` else nothing; if it equals the remembered `activeExpr` it returns; otherwise it deactivates the old and activates the new and records `activeExpr` (`:74-81`). `activate` sends `ExpressionActivationRequest` for `*.exp3.json` names and `HotkeyTriggerRequest` otherwise (`:93-102`). Hotkeys are toggles, so the driver triggers the same hotkey to turn an expression both on and off and relies on `activeExpr` as its only record of what VTS is showing.
- Gestures: `trigger` maps the gesture through `ctx.gestures`, finds the hotkey case-insensitively, warns if absent (`:83-90`).
- Hotkeys are loaded once per successful connect (`:157-161`), keyed by lower-cased name; model changes inside VTS are not observed.
- Requests: `send()` wraps the JSON envelope (`apiName VTubeStudioPublicAPI`, version 1.0, UUID `requestID`) and tracks replies in a `pending` map with a default 5 s timeout; `APIError` replies reject (`:163-188`).

### vmc (`drivers/vmc.ts`)

Hand-rolled OSC over UDP to a VMC receiver (default port 39539 via `VMC_HOST`/`VMC_PORT`), fire-and-forget (`vmc.ts:1-11, 30-35`). `connected()` is true as soon as the socket exists; there is no handshake and no way to know whether anything is listening (`:28`).

Each `setParams` sends: `/VMC/Ext/Bone/Pos` for `Head` with a quaternion from `eulerToQuat(headY, headX, headZ)`, `/VMC/Ext/Blend/Val` for mouth as both `A` (VRM 0.x) and `aa` (VRM 1.0), blink as both `Blink` and `blink`, the active expression value if any, then `/VMC/Ext/Blend/Apply` and `/VMC/Ext/OK 1` (`:37-51`). `setExpression` zeroes the previous blendshape when the target changes and stores the new name and clamped intensity, which is then re-sent every frame (`:53-60`). `trigger` is a no-op (`:62`). The OSC encoder supports strings, float32, and int32 only for addresses ending in `/OK` (`:65-84`). Eye gaze is not sent.

## Health

`avatarHealth(driver)` (`health.ts:4-11`) returns a `HeartbeatSpec` for service `avatar`: mode `off` when the driver is `null`, else `live`; `deps` is re-read each tick as `{ driver: "n/a" }` for null, else `ok`/`down` from `driver.connected()`. The heartbeat contract is owned by control-plane; because `ready()` is called before the driver connects, a real driver that is not yet connected shows `degraded` ("dependency down: driver") rather than `starting`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where animation logic lives | One `Engine` computes smoothing, idle motion, blink and lip-sync; drivers translate only | Per-driver animation logic | Comments: the engine "owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`engine.ts:6-9`); "Keep drivers dumb: no timing, no smoothing, no decisions — the engine does that" (`types.ts:31-34`). |
| Lip-sync trigger | Cache envelope on `voice.utterance`, start on `voice.playing` | Start mouth motion on `voice.utterance` | Comments: `prepare` remembers the audio "so we can lip-sync when a sink starts playing" (`engine.ts:32`); the `voice.playing` schema note says "Avatar syncs to this" (`packages/bus/src/events.ts:139`). That playback start is the audible moment is `[inferred]`. |
| Early emotion from `brain.say` | Show emotion before audio exists with a 6000 ms hold | Wait for `voice.utterance` | Comment: "Show the emotion as soon as it decides, before audio exists — feels more alive" (`index.ts:39`). The 6000 ms figure is `[inferred]`. |
| Resting face | `affect.state` mood is the fallback expression at intensity 0.5; held utterance emotions win | Mood overrides immediately | Comment: "Mood changes show up softly, and only when no utterance is holding the face" (`engine.ts:57`); test `engine.test.ts:111`. |
| Connect behavior | VTS `connect()` resolves on error and is not awaited by startup; the engine and subscription start at once; reconnect every 5 s forever | Fail startup when the app is absent; await the first attempt (bounded or not) | Comment: "don't block startup; close handler schedules the retry" (`vtube-studio.ts:136`). Owner decision 2026-11-01: "not blocked" means the face and the subscription run while VTS is pairing or unreachable. The fixed 5 s interval with no backoff or cap is `[inferred]`. |
| Token persistence | Plain file `<configDir>/.vts-token`, git-ignored and kept out of the image build context | Env var, Redis | Header comment: the token "is saved to <config>/.vts-token so it only happens once" (`vtube-studio.ts:3-4`). Owner decision 2026-11-01: the token is a secret and stays out of git and the build context (`.gitignore:12`; `.dockerignore` is deployment's). Choosing a file over the alternatives is `[inferred]`; the config dir is already a mounted volume (`docker-compose.yml:21-22`). |
| VMC transport | Own OSC encoder, UDP fire-and-forget | OSC library, TCP | Comment: "minimal OSC encoder (strings, int32, float32) — enough for VMC" (`vmc.ts:65`); UDP is what VMC receivers accept (`vmc.ts:1-3`). Avoiding a dependency is `[inferred]`. |
| Both VRM 0.x and 1.0 names | Send `A`/`aa` and `Blink`/`blink` every frame | A per-model setting | Header comment: VRM 1.0 uses lowercase names, "so the driver sends mouth as both "A" and "aa" and blink as both "Blink"/"blink"" (`vmc.ts:8-10`). |
| Default driver | `null`, also for an unset or empty `AVATAR_DRIVER` | Require an explicit choice | Comment: "null = no avatar app, dashboard only" (`.env.example:44`); isolated starts force it (`packages/control/src/manifest.ts:46`; `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md`, D2). Owner decision 2026-11-01: a `.env` without avatar settings must load (config writes `${AVATAR_DRIVER:-null}`). |
| Unknown driver name | Fail fast: config validation rejects it; the factory has no fallback | Fall back to the null driver (the frozen OpenSpec's "Null driver" scenario) | Owner decision 2026-11-01: a typo in `AVATAR_DRIVER` is a configuration error the operator should see at once, not a silently missing avatar. |
| Capability declaration | None; a driver ignores calls it cannot honour | `capabilities()` on every driver | Owner decision 2026-11-01: nothing consumes it; it was only logged. |
| Lip-sync source | Follow every `voice.playing` / `voice.done`, including voice's `virtual` sink | Ignore `virtual`; follow only real sinks | Owner decision 2026-11-01: `virtual` is the only playback signal when no sink is attached; the late-sink double lifecycle is fixed in voice (VOICE-SINK-008). |
| Restart replay | Event-bus start mode `latest` (newest entry on every start) | Resume the backlog | Owner decision 2026-11-01: replayed `brain.say` and `voice.*` events would flash stale expressions and lip-sync. |
| Bus failures | Drop a failed `avatar.state` publish and log at a limited rate; a subscription rejection that survives the bus retry exits non-zero | Crash on any failure | Owner decision 2026-11-01 (cross-cutting): a lost preview frame must never end the face; a dead subscription is a clear, restartable failure. |
| Startup errors | All setup inside `main()`; any failure logs `fatal` and exits 1 | Module-level setup | Owner decision 2026-11-01 (cross-cutting): every startup failure is reported with the same log line. |
| `avatar.state` rate | Engine emits every frame, service throttles to at most once per 200 ms | Engine throttles | Comment: "5 Hz is plenty for the dashboard preview" (`index.ts:24`). |

## Open Questions & Future Decisions

1. VTS `activeExpr` is never reset when the socket closes or reconnects (`vtube-studio.ts:28`, `:125-133`, `:106-123`). If VTS restarts, the model resets, but the driver still believes an expression is on: the next `setExpression` to the same target is skipped (`:77`) and the next change toggles the old hotkey (turning it on). Hotkey toggle state is also lost if the operator changes expressions in VTS by hand. The engine does not re-send the current expression after a reconnect either, so expressions requested while disconnected are dropped (`:75`). (AVATAR-VTS-013)
2. Fire-and-forget VTS calls are `void`-ed with no `.catch`: `setParams` (`vtube-studio.ts:55`), `setExpression` (`:78-79`), `trigger` (`:89`). `send()` rejects when the socket is not open, on `APIError`, and after the 5 s timeout (`:166, :170, :184-186`). A single `APIError` (for example a missing `.exp3.json`) or timeout becomes an unhandled promise rejection; no `unhandledRejection` handler exists anywhere in `packages/` or `services/`, so on current Node the process would exit. No test covers this. (AVATAR-VTS-014)
3. The VMC driver attaches no `error` listener to its UDP socket and calls `send` without a callback (`vmc.ts:32, 50, 56`). A name-resolution failure emits an unhandled `error` event on the socket. Verified with a stand-alone `dgram` snippet that sending to an unresolvable host crashes the process. The default `.env.example` host is `host.docker.internal` (`.env.example:48`), which only resolves under Docker or with `extra_hosts` (`docker-compose.yml:23-24`). (AVATAR-VMC-005)
4. `heartbeat.ready()` fires before the driver connects (`index.ts:16`). The OpenSpec scenario "once its driver is selected" matches, but it means `ready` conveys nothing about the avatar app; only `deps.driver` does.
5. `known` eviction uses `Map` insertion order (`engine.ts:35`): re-preparing an existing id does not move it to the newest slot, so a re-sent id can be evicted early.
6. Neutral handling differs by path: a held `neutral` emotion (from `brain.say`) calls `driver.setExpression("neutral", 1)`, so VTS toggles `expressions.neutral`; returning to a neutral mood calls it with intensity 0, which VTS treats as "clear" (`intensity > 0.05` check, `vtube-studio.ts:76`) and VMC treats as value 0 (`vmc.ts:59`). `avatar.state` reports intensity 0 for neutral in both cases (`engine.ts:113`).
7. Utterances interrupted by a new `voice.playing` for another id are replaced without a `done` (`engine.ts:42`); there is no explicit handling of overlapping sinks. The dashboard sink and Discord sink arbitration is a voice concern.
8. `services/avatar/tsconfig.json` has `include: ["src"]` and references only config and bus (`tsconfig.json:4-5`), so tests are not type-checked by `tsc -b`; they run through tsx only.
9. No automated test covers `index.ts` wiring (event routing, the 200 ms throttle, `main` failure, shutdown: AVATAR-BUS-001 to 007, AVATAR-DRV-005, AVATAR-DRV-006, AVATAR-STATE-001, AVATAR-STATE-002, AVATAR-HEALTH-001, AVATAR-HEALTH-004), the VTS 5 s reconnect and its cancellation (AVATAR-VTS-007), the request timeout (AVATAR-VTS-006), the expression-not-found warning (AVATAR-VTS-015), the auto-clear of a playing utterance (AVATAR-ENG-006) or VMC's lack of gestures (AVATAR-VMC-004). The non-blocking VTS start (AVATAR-VTS-002) is untested for a host that drops packets; that case is `[inferred]` from the `ws` defaults.

## References

Files in segment:
- `services/avatar/src/index.ts`, `engine.ts`, `types.ts`, `health.ts`
- `services/avatar/src/drivers/index.ts`, `null.ts`, `vmc.ts`, `vtube-studio.ts`
- `services/avatar/test/engine.test.ts`, `drivers.test.ts`, `health.test.ts`
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
