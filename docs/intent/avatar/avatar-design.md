---
parent: high-level-design
prefix: AVATAR
---

# avatar

Mapped 2026-10-31 at git `686cc8f`. Describes what the code does today. Decisions are `[inferred]` from code; none has been confirmed by the project owner. See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/avatar` is the "face" half of the body (the other half is `voice`). It listens to the bus, works out what the avatar should look like at each instant, and pushes that to whatever avatar application the operator runs (VTube Studio for Live2D, a VMC receiver for 3D/VRM, or nothing). It publishes `avatar.state` so the dashboard can draw a stand-in face.

The code states its own philosophy in two comments: "Engine owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`services/avatar/src/engine.ts:6-9`) and "Keep drivers dumb: no timing, no smoothing, no decisions" (`services/avatar/src/types.ts:31-34`). So the design is a canonical-state engine (`AvatarParams`, `types.ts:8-17`) feeding thin per-app translators behind the `AvatarDriver` interface (`types.ts:35-47`). New apps are added by implementing the interface, adding a `case` in `drivers/index.ts:12-26`, extending the `avatar.driver` enum in `packages/config/src/schema.ts:161`, and adding a block to `config/expressions.yaml` (instructions in the comment at `drivers/index.ts:7-11`).

Everything is driven by the bus; the service exposes no HTTP surface and no inbound control other than the five event types it consumes.

## Process wiring and event flow

Startup order (`services/avatar/src/index.ts`):

1. `loadConfig()` then `new Bus("avatar")` (`index.ts:12-13`).
2. `createDriver(cfg.avatar)` selects the driver (`index.ts:14`).
3. `startHeartbeat(bus, {...avatarHealth(driver), log})` and an immediate `heartbeat.ready()` (`index.ts:15-16`). Readiness therefore means "driver object chosen", not "driver connected"; connection state rides in `deps.driver` and can make the state `degraded` (see Health).
4. `loadExpressions()[cfg.avatar.driver] ?? { gestures: {} }`, then `gestures` is split from the emotion map (`index.ts:18-19`). A missing driver block is silently an empty map.
5. The `Engine` is constructed with an `onState` callback that publishes `avatar.state` at most once per 200 ms (`index.ts:21-27`).
6. `main()` awaits `driver.connect({log, expressions, gestures, stateDir: configDir()})`, logs the driver, its capabilities and the expression count, starts the engine, then starts the bus subscription (`index.ts:29-54`). A rejection from `main()` logs `fatal` and exits 1 (`index.ts:57`).
7. `onShutdown` stops the engine, disconnects the driver, stops the bus (`index.ts:58`). `startHeartbeat` registers its own pre-shutdown hook that publishes the `stopping` heartbeat (`packages/bus/src/index.ts:230-245`, owned by control-plane).

### Events

| Direction | Event | Handling | Evidence |
|---|---|---|---|
| in | `brain.say` | `engine.setEmotion(emotion, 6000)`: show the emotion as soon as the brain decides, before any audio exists | `index.ts:38-43` |
| in | `voice.utterance` | `engine.prepare({id, emotion, gesture, envelope, envelopeHz, durationMs})`: remember the audio's mouth envelope | `index.ts:44-48` |
| in | `voice.playing` | `engine.play(id)`: any sink may claim it; the `sink` field is ignored | `index.ts:50` |
| in | `voice.done` | `engine.done(id)` | `index.ts:51` |
| in | `affect.state` | `engine.setMood(mood)`: the resting face | `index.ts:49` |
| out | `avatar.state` | all `AvatarParams` plus `emotion`, `intensity`, `driver`, `connected`, throttled to 5 Hz | `index.ts:22-27` |

The subscription uses consumer group `avatar` with `fromNow: true` (`index.ts:35`), so a restart skips any backlog (an animation backlog would be meaningless). The bus wrapper acks every entry even when the handler throws (`packages/bus/src/index.ts:151-159`). The subscribe call is `void`-ed (`index.ts:34`), so a failure of the subscription loop surfaces as an unhandled rejection rather than through `main().catch`.

Lip-sync is deliberately keyed to `voice.playing`, not `voice.utterance`: the envelope is cached on `prepare` and the mouth only starts moving when some sink reports it has actually started playing (`engine.ts:32-45`). The dashboard's browser sink and the Discord sink both report this; avatar does not care which.

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

1. Mouth: `mouthOpen` target is `envelope[floor(elapsed * envelopeHz)]` while playing; `playing` clears itself once `elapsed > durationMs + 500` (`engine.ts:71-79`).
2. Emotion decay (above) and `mouthSmile` target: 0.7 for `happy`, `laugh`, `smug`, else 0.15 (`engine.ts:86`).
3. Idle motion, only when `cfg.idle_motion`: slow sines for head yaw/pitch/roll and eyes, with head X/Y gain 1.6 while speaking (`engine.ts:89-96`). When disabled these targets are never written, so they stay at 0.
4. Blink: first blink about 3 s after construction, then every 2.5-6 s, closed for 120 ms (`engine.ts:19, 99-103`).
5. Smoothing: each param moves `rate` of the way to target; `mouthOpen` uses `min(1, smoothing * 3)`, `blink` uses 1, everything else `smoothing` (`engine.ts:105-110`).
6. `driver.setParams(cur)` then `onState(cur, emotion, intensity)` every frame (`engine.ts:112-113`); throttling is the caller's job.

## Drivers

The contract (`types.ts:35-47`): `name`, `capabilities()`, `connect(ctx)`, `disconnect()`, `connected()`, `setParams(p)` (every frame), `setExpression(emotion, intensity)` (on change), `trigger(gesture)` (fire and forget). `DriverContext` carries a logger, the emotion-to-app-name map, the gesture map and a `stateDir` for small persisted state (`types.ts:21-29`). `capabilities()` (`expressions | params | gestures | lipsync`) is only logged at startup (`index.ts:31`); nothing consumes it for decisions.

Selection is by `cfg.avatar.driver` (`drivers/index.ts:12-26`). The config schema restricts the value to `vtube-studio | vmc | null` with default `null` (`packages/config/src/schema.ts:160-172`), and `loadConfig` throws on an invalid value (`packages/config/src/index.ts:98-104`), so the `default:` fallback to `NullDriver` at `drivers/index.ts:23-25` is unreachable through normal startup.

### expressions.yaml

`config/expressions.example.yaml` has a block per driver name. Each block maps canonical emotions (`neutral happy laugh surprised smug sad angry confused think`, `schema.ts:3-5`) to app-specific strings, plus an optional `gestures` map. The schema is a record of records with `gestures` defaulted to `{}` and a string catch-all for the rest (`schema.ts:190-196`). For VTube Studio the values are hotkey names (or `*.exp3.json` expression files); for VMC they are VRM blendshape names (`expressions.example.yaml:1-34`). The real `config/expressions.yaml` is seeded from the example on first run and is git-ignored (`packages/config/src/index.ts:121-130, 131-134`, `.gitignore`).

### null (`drivers/null.ts`)

Declares all four capabilities, reports `connected() === true`, ignores params and logs expressions and gestures at debug level (`null.ts:5-15`). It is the default and what the "isolated" start mode selects.

### vtube-studio (`drivers/vtube-studio.ts`)

Speaks the VTube Studio public WebSocket API at `ws://host:port` (default port 8001 via `VTS_HOST`/`VTS_PORT`).

- Connect: `open()` creates the socket; on `open` it runs `authenticate()` then `loadHotkeys()` and only then sets `ready` (`vtube-studio.ts:106-123`). `connected()` returns `ready` (`:37`). `connect()` resolves after the first attempt even if VTS is unreachable or auth failed, so startup never blocks (`:134-137`; test `drivers.test.ts:172`).
- Auth: token read from `<stateDir>/.vts-token` (`:104`, `stateDir = configDir()` from `index.ts:30`). With no token, sends `AuthenticationTokenRequest` with a 60 s timeout (the operator must click Allow in VTS) and writes the token; then `AuthenticationRequest`. A rejected token blanks the file and throws (`:141-155`).
- Failure and reconnect: any auth or hotkey failure logs and closes the socket; the `close` handler rejects all pending requests and, unless `disconnect()` set `closing`, retries `open()` after 5 s (`:125-133`). There is no backoff and no retry cap.
- Params: while `ready`, `setParams` sends `InjectParameterDataRequest` (mode `set`, `faceFound: true`) with 11 values (`MouthOpen`, `MouthSmile`, `FaceAngleX/Y/Z`, `EyeLeft/RightX/Y`, `EyeOpenLeft/Right = 1 - blink`) clamped to VTS ranges, fire-and-forget (`:53-72`).
- Expressions: `setExpression` picks `expressions[emotion]` when `intensity > 0.05` else nothing; if it equals the remembered `activeExpr` it returns; otherwise it deactivates the old and activates the new and records `activeExpr` (`:74-81`). `activate` sends `ExpressionActivationRequest` for `*.exp3.json` names and `HotkeyTriggerRequest` otherwise (`:93-102`). Hotkeys are toggles, so the driver triggers the same hotkey to turn an expression both on and off and relies on `activeExpr` as its only record of what VTS is showing.
- Gestures: `trigger` maps the gesture through `ctx.gestures`, finds the hotkey case-insensitively, warns if absent (`:83-90`).
- Hotkeys are loaded once per successful connect (`:157-161`), keyed by lower-cased name; model changes inside VTS are not observed.
- Requests: `send()` wraps the JSON envelope (`apiName VTubeStudioPublicAPI`, version 1.0, UUID `requestID`) and tracks replies in a `pending` map with a default 5 s timeout; `APIError` replies reject (`:163-188`).

### vmc (`drivers/vmc.ts`)

Hand-rolled OSC over UDP to a VMC receiver (default port 39539 via `VMC_HOST`/`VMC_PORT`), fire-and-forget (`vmc.ts:1-11, 30-35`). `connected()` is true as soon as the socket exists; there is no handshake and no way to know whether anything is listening (`:28`).

Each `setParams` sends: `/VMC/Ext/Bone/Pos` for `Head` with a quaternion from `eulerToQuat(headY, headX, headZ)`, `/VMC/Ext/Blend/Val` for mouth as both `A` (VRM 0.x) and `aa` (VRM 1.0), blink as both `Blink` and `blink`, the active expression value if any, then `/VMC/Ext/Blend/Apply` and `/VMC/Ext/OK 1` (`:37-51`). `setExpression` zeroes the previous blendshape when the target changes and stores the new name and clamped intensity, which is then re-sent every frame (`:53-60`). `trigger` is a no-op and `capabilities()` omits `gestures` (`:25-27, 62`). The OSC encoder supports strings, float32, and int32 only for addresses ending in `/OK` (`:65-84`). Eye gaze is not sent.

## Health

`avatarHealth(driver)` (`health.ts:4-11`) returns a `HeartbeatSpec` for service `avatar`: mode `off` when the driver is `null`, else `live`; `deps` is re-read each tick as `{ driver: "n/a" }` for null, else `ok`/`down` from `driver.connected()`. The heartbeat contract is owned by control-plane; because `ready()` is called before the driver connects, a real driver that is not yet connected shows `degraded` ("dependency down: driver") rather than `starting`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where animation logic lives | One `Engine` computes smoothing, idle motion, blink and lip-sync; drivers translate only | Per-driver animation logic | `[inferred]` Comments say drivers "stay trivial" (`engine.ts:6-9`, `types.ts:31-34`), so one animation implementation serves every app. |
| Lip-sync trigger | Cache envelope on `voice.utterance`, start on `voice.playing` | Start mouth motion on `voice.utterance` | `[inferred]` Playback start is when audio is actually audible, and the sink is not known in advance (`engine.ts:32-45`, `index.ts:44-51`). |
| Early emotion from `brain.say` | Show emotion before audio exists with a 6000 ms hold | Wait for `voice.utterance` | `[inferred]` Comment "feels more alive" (`index.ts:39`). |
| Resting face | `affect.state` mood is the fallback expression at intensity 0.5; held utterance emotions win | Mood overrides immediately | `[inferred]` `setMood` defers while a hold is active (`engine.ts:57-65`; test `engine.test.ts:111`). |
| Connect behavior | VTS `connect()` resolves on error; reconnect every 5 s forever | Fail startup when the app is absent | `[inferred]` Comment "don't block startup; close handler schedules the retry" (`vtube-studio.ts:136`); service is meant to run before the avatar app is open. |
| Token persistence | Plain file `<configDir>/.vts-token` | Env var, Redis | `[inferred]` Comment says the Allow dialog should only appear once (`vtube-studio.ts:3-4`); config dir is already a mounted volume (`docker-compose.yml:20-22`). |
| VMC transport | Own OSC encoder, UDP fire-and-forget | OSC library, TCP | `[inferred]` "minimal OSC encoder ... enough for VMC" (`vmc.ts:65`); no dependency added beyond `ws`. |
| Both VRM 0.x and 1.0 names | Send `A`/`aa` and `Blink`/`blink` every frame | A per-model setting | `[inferred]` Header comment (`vmc.ts:8-10`). |
| Default driver | `null` | Require an explicit choice | `[inferred]` `schema.ts:161`, `.env.example:45`; keeps the stack runnable without an avatar app and is the "isolated" mode target. |
| `avatar.state` rate | Engine emits every frame, service throttles to 5 Hz | Engine throttles | `[inferred]` Comment "5 Hz is plenty for the dashboard preview" (`index.ts:24`). |

## Open Questions & Future Decisions

1. VTS `activeExpr` is never reset when the socket closes or reconnects (`vtube-studio.ts:28`, `:125-133`, `:106-123`). If VTS restarts, the model resets, but the driver still believes an expression is on: the next `setExpression` to the same target is skipped (`:77`) and the next change toggles the old hotkey (turning it on). Hotkey toggle state is also lost if the operator changes expressions in VTS by hand. The engine does not re-send the current expression after a reconnect either, so expressions requested while disconnected are dropped (`:75`).
2. Fire-and-forget VTS calls are `void`-ed with no `.catch`: `setParams` (`vtube-studio.ts:55`), `setExpression` (`:78-79`), `trigger` (`:89`). `send()` rejects when the socket is not open, on `APIError`, and after the 5 s timeout (`:166, :170, :184-186`). A single `APIError` (for example a missing `.exp3.json`) or timeout becomes an unhandled promise rejection; no `unhandledRejection` handler exists anywhere in `packages/` or `services/`, so on current Node the process would exit. No test covers this.
3. The VMC driver attaches no `error` listener to its UDP socket and calls `send` without a callback (`vmc.ts:32, 50, 56`). A name-resolution failure emits an unhandled `error` event on the socket. Verified with a stand-alone `dgram` snippet that sending to an unresolvable host crashes the process. The default `.env.example` host is `host.docker.internal` (`.env.example:46, 48`), which only resolves under Docker or with `extra_hosts` (`docker-compose.yml:23-24`).
4. `AVATAR_DRIVER` with an unrecognised value makes `loadConfig` throw (`schema.ts:161`, `packages/config/src/index.ts:98-104`). OpenSpec (`openspec/specs/avatar/spec.md`, "Null driver" scenario) says an unrecognised driver falls back to the null driver, and the `default:` branch exists (`drivers/index.ts:23-25`), but it can only be reached by calling `createDriver` directly.
5. `openspec/changes/add-service-health/specs/avatar/spec.md` says a real driver is `vts` or `vmc`; the actual enum value is `vtube-studio` (`schema.ts:161`, `.env.example:44`).
6. `config/.vts-token` is written into the config directory but is not covered by `.gitignore` (only `config.yaml`, `personality.md`, `expressions.yaml` are listed); a blank file is written on rejection (`vtube-studio.ts:152`). Whether the token is meant to stay out of version control is not stated.
7. `heartbeat.ready()` fires before the driver connects (`index.ts:16`). The OpenSpec scenario "once its driver is selected" matches, but it means `ready` conveys nothing about the avatar app; only `deps.driver` does.
8. `capabilities()` is declared by every driver but only logged (`index.ts:31`). The null driver claims all four (`null.ts:8`). It is unclear whether it is meant to gate behavior later.
9. `known` eviction uses `Map` insertion order (`engine.ts:35`): re-preparing an existing id does not move it to the newest slot, so a re-sent id can be evicted early.
10. Neutral handling differs by path: a held `neutral` emotion (from `brain.say`) calls `driver.setExpression("neutral", 1)`, so VTS toggles `expressions.neutral`; returning to a neutral mood calls it with intensity 0, which VTS treats as "clear" (`intensity > 0.05` check, `vtube-studio.ts:76`) and VMC treats as value 0 (`vmc.ts:59`). `avatar.state` reports intensity 0 for neutral in both cases (`engine.ts:113`).
11. Utterances interrupted by a new `voice.playing` for another id are replaced without a `done` (`engine.ts:42`); there is no explicit handling of overlapping sinks. The dashboard sink and Discord sink arbitration is a voice concern.
12. The `package.json` devDependency on `@cohost/testing` is now present (`services/avatar/package.json:20`); the earlier sweep noted it missing. `tsconfig.json` has `include: ["src"]` and references only config and bus (`tsconfig.json:4-5`), so tests are type-checked only by the editor, not by `tsc -b`.
13. No automated test covers `index.ts` wiring (event routing, the 5 Hz throttle, `main` failure), the VTS 5 s reconnect, request timeout, or expression-not-found warnings.

## References

Files in segment:
- `services/avatar/src/index.ts`, `engine.ts`, `types.ts`, `health.ts`
- `services/avatar/src/drivers/index.ts`, `null.ts`, `vmc.ts`, `vtube-studio.ts`
- `services/avatar/test/engine.test.ts`, `drivers.test.ts`, `health.test.ts`
- `services/avatar/package.json`, `services/avatar/tsconfig.json`
- `config/expressions.example.yaml`

Other segments (direction):
- event-bus: consumes `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; produces `avatar.state` (schemas at `packages/bus/src/events.ts:46, 86, 126, 140-141, 144`).
- config: reads `Config["avatar"]`, `loadExpressions`, `configDir`, `Emotion` (`packages/config/src/schema.ts:3-7, 160-172, 190-196`).
- control-plane: heartbeat contract (`startHeartbeat`, `HeartbeatSpec`), health tracking, healthcheck, and the `AVATAR_DRIVER=null` isolated start (manifest).
- voice: produces `voice.utterance` (envelope) and arbitrates sinks that emit `voice.playing` / `voice.done`.
- affect: produces `affect.state` mood.
- cortex: produces `brain.say` (via the bus).
- dashboard: consumes `avatar.state` for the preview and emits `voice.playing`/`voice.done` as sink "dashboard".

External: `ws` (VTube Studio WebSocket), Node `dgram` (UDP), VTube Studio public API, VMC protocol.

OpenSpec: `openspec/specs/avatar/spec.md`; `openspec/changes/add-service-health/specs/avatar/spec.md`.
