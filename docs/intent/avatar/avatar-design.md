---
parent: high-level-design
prefix: AVATAR
---

# avatar

Describes the intended design. A rationale cell cites the code comment, design note or owner decision (2026-11-01) that states the reason; where no such source exists, the cell gives the engineering reason the design rests on. See the [high-level design](../../high-level-design.md).

## Context and Design Philosophy

`services/avatar` is the "face" half of the body (the other half is `voice`). It listens to the bus, works out what the avatar should look like at each instant, and pushes that to whatever avatar application the operator runs (VTube Studio for Live2D, a VMC receiver for 3D/VRM, or nothing). It publishes `avatar.state` so the dashboard can draw a stand-in face.

The code states its own philosophy in two comments: "Engine owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`services/avatar/src/engine.ts`) and "Keep drivers dumb: no timing, no smoothing, no decisions" (`services/avatar/src/types.ts`). So the design is a canonical-state engine (`AvatarParams`, `types.ts`) feeding thin per-app translators behind the `AvatarDriver` interface (`types.ts`). New apps are added by implementing the interface, adding a `case` in `drivers/index.ts`, extending the `avatar.driver` enum in `packages/config/src/schema.ts`, and adding a block to `config/expressions.yaml` (instructions in the comment at `drivers/index.ts`).

Everything is driven by the bus; the service exposes no HTTP surface and no inbound control other than the five event types it consumes.

## Process wiring and event flow

Startup order. `index.ts` calls `runAvatar()` (`boot.ts`), which runs `avatarMain` on the shared bootstrap `runService`: a failure in any step ends the process with status 1 (AVATAR-BUS-007), a step after the configuration loads logging `fatal`, and nothing waits for the avatar app.

1. The bootstrap loads the configuration, creates `Bus("avatar")` and starts the heartbeat (`starting`) with `avatarHealth(cfg, () => driver)`, which publishes `ready` only at step 8.
2. `createDriver(cfg.avatar)` selects the driver. An unknown `avatar.driver` never gets here: config validation rejects it before any service starts, and an unset or empty `avatar.driver` loads as `null` (AVATAR-DRV-003, AVATAR-DRV-004).
3. The heartbeat reads the driver through a reference `avatarMain` fills at step 2: a real driver that does not exist yet reads as `down`.
4. `expressionsFor(loadExpressions(), cfg.avatar.driver)` takes the driver's block and splits `gestures` from the emotion map. A missing driver block is silently an empty map (AVATAR-DRV-005).
5. The `Engine` is constructed with an `onState` callback (`statePublisher`, `state.ts`) that publishes `avatar.state` at most once per 200 ms; at the default 30 fps that is every 7th frame, about 4.3 Hz. A failed publish drops that state and is logged at most once per 10 s (AVATAR-STATE-002).
6. The teardown step registered with `onStop` stops the engine and disconnects the driver; the bootstrap then stops the bus (`boot.ts`). `startHeartbeat` registers its own pre-shutdown hook that publishes the `stopping` heartbeat (`packages/shared/src/lifecycle.ts`, owned by control-plane).
7. `driver.connect({log, expressions, gestures, stateDir})` is started without being awaited, with a `.catch` that logs `fatal` and exits 1 (a rejecting connect is a startup failure); `engine.start()` follows at once (AVATAR-VTS-002). The VTube Studio driver reports itself disconnected until it authenticates, and the heartbeat shows `degraded` meanwhile.
8. `bus.resetGroup("avatar")` creates the consumer group at the newest entry, then `heartbeat.ready()`: readiness means "can receive events", not "driver connected"; connection state rides in `deps.driver` and can make the state `degraded` (see Health; AVATAR-HEALTH-001). Then the subscription loop starts. The bus has no "subscribed" notification, so boot positions the group itself and `subscribe` positions it again (`latest` resets once more); an event in the few milliseconds between is dropped, which `latest` allows.

A subscription rejection (AVATAR-BUS-008) is the last way the awaited loop can end the service; it takes the same `fatal` path.

### Events

| Direction | Event | Handling | Evidence |
|---|---|---|---|
| in | `brain.say` | `engine.setEmotion(emotion, 6000)`: show the emotion as soon as the brain decides, before any audio exists. A streamed reply has one `brain.say`, so this happens once per line; avatar does not subscribe to `brain.clause` | `boot.ts` (`brain.say` case) |
| in | `voice.utterance` | `engine.prepare({id, seq, emotion, gesture, envelope, envelopeHz, durationMs})`: remember the clause's mouth envelope | `boot.ts` (`voice.utterance` case) |
| in | `voice.playing` | `engine.play(id, seq)`: any sink may claim it; the `sink` field is ignored | `boot.ts` (`voice.playing` case) |
| in | `voice.done` | `engine.done(id, seq)` | `boot.ts` (`voice.done` case) |
| in | `affect.state` | `engine.setMood(mood)`: the resting face | `boot.ts` (`affect.state` case) |
| out | `avatar.state` | Every canonical `AvatarParams` value (including `mouthSmile`) plus `emotion`, `intensity`, `driver`, `connected`, at most once per 200 ms (AVATAR-STATE-001). The schema carries `mouthSmile` (`packages/bus/src/events.ts`; BUS-EVT-018), so the dashboard preview, which reads `s.mouthSmile` (`services/dashboard/public/index.html`), gets a number | `state.ts` |

The subscription uses consumer group `avatar` with the event-bus `latest` start mode: the group moves to the newest entry on every start, so a restart never replays stale `brain.say` or `voice.*` events as flashing expressions and lip-sync (AVATAR-BUS-001). This holds for a compose `restart: unless-stopped` restart (`docker-compose.yml`) as well as for the control plane's `fresh` start (avatar's manifest default, `packages/control/src/manifest.ts`). The bus wrapper acks every entry even when the handler throws (`packages/bus/src/index.ts`).

Bus failures follow the cross-cutting rule: a failed `avatar.state` publish is dropped and logged at a limited rate, and avatar keeps animating (AVATAR-STATE-002); the bus retries every failed subscription read with backoff (BUS-SUB-009), so only group creation when the subscription starts can reject it, and that rejection is logged and ends the process non-zero (AVATAR-BUS-008). Both calls are handled: the subscription is awaited inside `runAvatar`'s `try` (`boot.ts`) and the `avatar.state` publish has a `.catch` (`state.ts`). Nothing in the workspace handles `unhandledRejection`, so an unhandled failure would end the process on Node. They fail differently in a Redis outage: a subscription read fails, is logged and is retried after the bus's backoff without rejecting, while each `avatar.state` publish rejects at once for as long as the bus's shared connection is down (BUS-NAT-CONN-005), so the 5 Hz publish fails from the first state after Redis is lost. During the bus's first connect attempt, at most 10 s after boot, a publish and the group creation wait for that attempt instead (BUS-NAT-CONN-006).

**Streamed lines.** A line spoken clause by clause is a run of utterances with the same `id` and ascending `seq` ([event-bus](../event-bus/event-bus-design.md) Streamed lines), each prepared, played and finished on its own: the mouth follows each clause's envelope, closes in the pause between two clauses and opens again on the next `voice.playing`. The emotion is the line's, carried on every clause's utterance, so each clause's `play` sets the hold to the later of its current end and that clause's `durationMs + 4000` from now, and the face holds for as long as the line keeps speaking and for the usual four seconds after its last clause. The gesture is carried by the first clause's utterance only (voice copies it onto clause 0), so it fires once per line: avatar fires it on the first `voice.playing` with `seq` 0 it sees for the line and remembers the line (the newest 50), so a second sink's `voice.playing` for the same clause does not fire it again.

Lip-sync is deliberately keyed to `voice.playing`, not `voice.utterance`: the envelope is cached on `prepare` and the mouth only starts moving when some sink reports it has actually started playing (`engine.ts`). The dashboard's browser sink, the Discord sink and voice's own `virtual` sink all report this; avatar does not care which, so it also mouths lines that no sink is playing aloud. Following `virtual` is intended: it is the only playback signal when no sink is attached. When a real sink starts after voice's 1.5 s claim window, avatar sees two `voice.playing` for the id (the second restarts lip-sync from the first envelope value). Voice cancels the pending virtual `voice.done` on such a late claim, so lip-sync ends on the real sink's `voice.done` ([voice LLD](../voice/voice-design.md), Sink Arbitration Protocol; VOICE-SINK-008).

## Engine

`Engine` (`engine.ts`) is a fixed-rate loop (`setInterval(1000 / cfg.fps)`, `engine.ts`) over three pieces of state. Every time it reads (lip-sync position, emotion holds, blinks, idle motion) comes from one monotonic millisecond clock, the constructor's optional `now` (default `performance.now`), so a wall clock stepped by NTP or VM time sync neither jumps the mouth through an envelope nor ends a hold early; tests inject the mocked clock. The three pieces of state:

- `cur` / `target`: `AvatarParams` current and goal values, both starting at `NEUTRAL` (`engine.ts`, `types.ts`).
- Emotion state: `emotion` (what is shown), `emotionUntil` (hold deadline, epoch ms), and `mood` (the resting face from `affect.state`) (`engine.ts`).
- Playback state: `known` (a `Map` of up to 50 prepared utterances, keyed by clause (`id` and `seq`), the least recently prepared evicted, and a re-prepared clause becomes the newest, AVATAR-ENG-002) and `playing` (the utterance and its start time). The bound is in clauses, so it holds several replies' worth.

Public entry points: `prepare`, `play`, `done`, `setEmotion`, `setMood`, `start`, `stop`.

Emotion rules:

- `setEmotion(e, holdMs=4000)` sets the emotion, the hold deadline, and calls `driver.setExpression(e, 1)` immediately (`engine.ts`).
- `play(id, seq)` for a known clause starts playback, calls `setEmotion(u.emotion, durationMs + 4000)` and fires the utterance's gesture through `driver.trigger` if present (`engine.ts`); only a line's first clause carries a gesture. Unknown clauses are silently ignored. Note the second `setEmotion` replaces the 6000 ms hold set by `brain.say`; a short utterance therefore shortens the hold, and each later clause of a line sets the hold again from its own start.
- `setMood(e)` is a no-op for the same mood; otherwise it stores the mood and, only if no hold is active (`now() > emotionUntil`), shows it immediately at intensity 0.5 (0 for neutral) (`engine.ts`).
- When a hold expires and `emotion !== mood`, the frame loop falls back to the mood with the same 0.5/0 intensity (`engine.ts`).
- Reported intensity for `avatar.state` is 0 for neutral, 1 while a hold is active, else 0.5 (`engine.ts`). `neutral` means no expression: the engine asks the driver for `neutral` only at intensity 0, held or resting, so VTube Studio deactivates its active expression and VMC sends the blendshape at 0, and `avatar.state` agrees (AVATAR-ENG-017).

Per-frame pipeline (`engine.ts`):

1. Mouth: `mouthOpen` target is `envelope[floor(elapsed * envelopeHz)]` while playing, else 0; once the index has run past the envelope, `playing` clears itself when `elapsed > durationMs + 500` (`engine.ts`). `done(id, seq)` for the playing clause clears it at once, so the target drops to 0 on the next frame and the mouth eases shut at the mouth smoothing rate.
2. Emotion decay (above) and `mouthSmile` target: 0.7 for `happy`, `laugh`, `smug`, else 0.15 (`engine.ts`).
3. Idle motion, only when `cfg.idle_motion`: slow sines for head yaw/pitch/roll and eyes, with head X/Y gain 1.6 while speaking (`engine.ts`). When disabled these targets are never written, so they stay at 0.
4. Blink: first blink about 3 s after construction, then every 2.5-6 s, closed for 120 ms (`engine.ts`).
5. Smoothing: each param moves `rate` of the way to target; `mouthOpen` uses `min(1, smoothing * 3)`, `blink` uses 1, everything else `smoothing` (`engine.ts`).
6. `driver.setParams(cur)` then `onState(cur, emotion, intensity)` every frame (`engine.ts`); throttling is the caller's job.

## Drivers

The contract: `name`, `connect(ctx)`, `disconnect()`, `connected()`, `setParams(p)` (every frame), `setExpression(emotion, intensity)` (on change), `trigger(gesture)` (fire and forget). `DriverContext` carries a logger, the emotion-to-app-name map, the gesture map and a `stateDir` for small persisted state (`types.ts`). A driver that cannot do something (VMC has no gestures) ignores the call; there is no capability declaration (AVATAR-DRV-001).

Selection is by `cfg.avatar.driver` (`drivers/index.ts`). The config schema restricts the value to `vtube-studio | vmc | null` with default `null` (`packages/config/src/schema.ts`), and `loadConfig` throws on an invalid value (`packages/config/src/index.ts`). An unknown driver is a configuration error that fails fast; the factory has no fallback for other names (AVATAR-DRV-003, AVATAR-DRV-004). An unset or empty `avatar.driver` selects `null`, so a config without avatar settings still loads; the config side (the literal `"null"` in the example YAML, a blank-safe driver value, defaults for `vtube_studio.port` and `vmc.port`) is owned by [config](../config/config-design.md).

### Example driver (`examples/avatar-driver/udp-json.ts`)

The docs site's Add an avatar driver page teaches the contract with a driver for an app cohost does not ship: `UdpJsonDriver` sends each call as one JSON datagram over UDP to a host and port, so any program that can read a UDP socket can animate a model (AVATAR-EX-001 to AVATAR-EX-004). It maps emotions and gestures through `ctx.expressions` and `ctx.gestures` as the real drivers do, so the page can show the `expressions.yaml` block it reads, and it never throws from a per-frame call, as the engine calls `setParams` at frame rate. The file is in the examples TypeScript project, which `tsc -p examples/tsconfig.json` checks during `pnpm test` (docs-site DOCS-GUIDE-025), so it is checked against `AvatarDriver`; `services/avatar/test/example-driver.test.ts` runs it against a UDP socket. It is not registered in `drivers/index.ts` and not a value of `avatar.driver`: the page walks those edits (a case in `createDriver`, a value in the config schema's `avatar.driver` enum, a block in `config/expressions.example.yaml`), which is the path a reader's own driver takes.

### expressions.yaml

`config/expressions.example.yaml` has a block per driver name. Each block maps canonical emotions (`neutral happy laugh surprised smug sad angry confused think`, `schema.ts`) to app-specific strings, plus an optional `gestures` map. The schema is a record of records with `gestures` defaulted to `{}` and a string catch-all for the rest (`schema.ts`). For VTube Studio the values are hotkey names (or `*.exp3.json` expression files); for VMC they are VRM blendshape names (`expressions.example.yaml`). The real `config/expressions.yaml` is seeded from the example on first run and is git-ignored (`packages/config/src/index.ts`, `.gitignore`).

### null (`drivers/null.ts`)

Reports `connected() === true`, ignores params and logs expressions and gestures at debug level (`null.ts`). It is the default and what the "isolated" start mode selects.

### vtube-studio (`drivers/vtube-studio.ts`)

Speaks the VTube Studio public WebSocket API at `ws://host:port` (`avatar.vtube_studio.host` and `port`, defaults `host.docker.internal` and 8001). It registers as the plugin `avatar.vtube_studio.plugin_name` by developer `avatar.vtube_studio.plugin_developer` (both default `cohost`); VTube Studio ties its saved plugin token to that pair, so the developer is a literal and never derived from the Twitch channel (AVATAR-VTS-017).

- Connect: `open()` creates the socket; on `open` it runs `authenticate()` then `loadHotkeys()` and only then sets `ready` (`vtube-studio.ts`). `connected()` returns `ready`. `connect()` resolves when the first attempt ends, whether it succeeded, failed auth or could not connect (test `drivers.test.ts`), and never rejects. That first attempt can take long: on first pairing it includes up to 60 s for the operator to click Allow plus the 5 s auth and hotkey requests, and for a host that drops packets it is bounded by the 5 s handshake timeout (AVATAR-VTS-016). The service therefore starts its engine and subscription without awaiting it (AVATAR-VTS-002, `boot.ts`).
- Auth: token read from `<stateDir>/.vts-token` (`stateDir = configDir()` from `index.ts`); `config/.vts-token` is git-ignored (`.gitignore`). With no token, sends `AuthenticationTokenRequest` with a 60 s timeout (the operator must click Allow in VTS) and writes the token; then `AuthenticationRequest`. A rejected token blanks the file and throws.
- Failure and reconnect: any auth or hotkey failure logs and closes the socket; the `close` handler rejects all pending requests and, unless `disconnect()` set `closing`, retries `open()` after 5 s, repeating every 5 s (AVATAR-VTS-007). There is no backoff and no retry cap. A WebSocket handshake not completed within 5 s is abandoned and counts as a failed attempt (AVATAR-VTS-016); the three timings (handshake, reconnect, request) are driver options defaulting to 5 s.
- Params: while `ready`, `setParams` sends `InjectParameterDataRequest` (mode `set`, `faceFound: true`) with 11 values (`MouthOpen`, `MouthSmile`, `FaceAngleX/Y/Z`, `EyeLeft/RightX/Y`, `EyeOpenLeft/Right = 1 - blink`) clamped to VTS ranges, fire-and-forget.
- Expressions: `setExpression` picks `expressions[emotion]` when `intensity > 0.05` else nothing; if it equals the remembered `activeExpr` it returns; otherwise it deactivates the old and activates the new and records `activeExpr`. `activate` sends `ExpressionActivationRequest` for `*.exp3.json` names and `HotkeyTriggerRequest` otherwise. Hotkeys are toggles, so the driver triggers the same hotkey to turn an expression both on and off and relies on `activeExpr` as its only record of what VTS is showing. That record is cleared when the socket closes and when a connection opens (AVATAR-VTS-013), because VTS resets its model on a restart; expressions requested while disconnected are dropped, and the engine does not re-send the current one after a reconnect.
- Gestures: `trigger` maps the gesture through `ctx.gestures`, finds the hotkey case-insensitively, warns if absent.
- Hotkeys are loaded once per successful connect, keyed by lower-cased name; model changes inside VTS are not observed.
- Fire-and-forget calls (`setParams`, `setExpression`, `trigger`) go through `fire()`, which catches a rejection (APIError, timeout, closed socket) and logs `vts request failed` at most every 5 s per kind, so none is an unhandled rejection (AVATAR-VTS-014).
- Requests: `send()` wraps the JSON envelope (`apiName VTubeStudioPublicAPI`, version 1.0, UUID `requestID`) and tracks replies in a `pending` map with a default 5 s timeout; `APIError` replies reject.

### vmc (`drivers/vmc.ts`)

Hand-rolled OSC over UDP to a VMC receiver (`avatar.vmc.host` and `port`, defaults `host.docker.internal` and 39539), fire-and-forget (`vmc.ts`). `connected()` is true as soon as the socket exists; there is no handshake and no way to know whether anything is listening.

Each `setParams` sends: `/VMC/Ext/Bone/Pos` for `Head` with a quaternion from `eulerToQuat(headY, headX, headZ)`, `/VMC/Ext/Blend/Val` for mouth as both `A` (VRM 0.x) and `aa` (VRM 1.0), blink as both `Blink` and `blink`, the active expression value if any, then `/VMC/Ext/Blend/Apply` and `/VMC/Ext/OK 1`. `setExpression` zeroes the previous blendshape when the target changes and stores the new name and clamped intensity, which is then re-sent every frame. `trigger` is a no-op. The OSC encoder supports strings, float32, and int32 only for addresses ending in `/OK`. Eye gaze is not sent. The socket has an `error` listener and every datagram goes through `sendDatagram`, whose callback reports a failure (for example a host that does not resolve) as `vmc send failed`, at most every 10 s measured on the monotonic clock (`performance.now`, so a stepped wall clock does not log again early); the driver keeps running (AVATAR-VMC-005).

## Health

`avatarHealth(cfg, driver)` (`health.ts`) returns a `HeartbeatSpec` for service `avatar`: mode `off` when `avatar.driver` is `null`, else `live`; `deps` is re-read each tick as `{ driver: "n/a" }` for null, else `ok`/`down` from `driver.connected()`. The heartbeat contract is owned by control-plane; `ready()` is called once the consumer group is positioned, without waiting for the driver, so a real driver that is not yet connected shows `degraded` ("dependency down: driver") rather than `starting`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Example driver | A UDP JSON driver in `examples/`, type-checked against `AvatarDriver` and tested with a socket, not registered as a driver | A worked copy of the VMC driver; registering `udp-json` as a fourth shipped driver | VMC's OSC encoding hides the contract behind a protocol; JSON over UDP shows only the contract. Shipping it would add a config value and a code path no streamer asked for; as an example it costs nothing at run time and stays compiled. |
| Where animation logic lives | One `Engine` computes smoothing, idle motion, blink and lip-sync; drivers translate only | Per-driver animation logic | Comments: the engine "owns timing, smoothing, idle motion and lip-sync playback so drivers stay trivial" (`engine.ts`); "Keep drivers dumb: no timing, no smoothing, no decisions — the engine does that" (`types.ts`). |
| Lip-sync trigger | Cache envelope on `voice.utterance`, start on `voice.playing` | Start mouth motion on `voice.utterance` | Comments: `prepare` remembers the audio "so we can lip-sync when a sink starts playing" (`engine.ts`); the `voice.playing` schema note says "Avatar syncs to this" (`packages/bus/src/events.ts`). A sink can start well after `voice.utterance` (mouth queues lines and fetches and converts the audio first), so the `voice.playing` a sink publishes when audio starts is the moment the viewer hears the line; starting on `voice.utterance` would move the mouth before, or without, any sound. |
| Early emotion from `brain.say` | Show emotion before audio exists with a 6000 ms hold | Wait for `voice.utterance` | Comment: "Show the emotion as soon as it decides, before audio exists — feels more alive" (`boot.ts`, `brain.say` case). The 6000 ms hold is a starting value meant to outlast synthesis plus voice's 1.5 s claim window, so the face does not fall back to the mood before the line is heard; `play` then replaces it with the utterance's own `durationMs + 4000` hold. |
| Resting face | `affect.state` mood is the fallback expression at intensity 0.5; held utterance emotions win | Mood overrides immediately | Comment: "Mood changes show up softly, and only when no utterance is holding the face" (`engine.ts`); test `engine.test.ts`. |
| Gesture and emotion across clauses | The gesture fires once per line, on the first clause's utterance, which alone carries it; each clause extends the emotion hold from its own `play` | Fire the gesture on every clause; hold the emotion for the whole line from `brain.say`; subscribe to `brain.clause` | A gesture is a flourish of the line, and one per clause would repeat it every few seconds. The emotion is read from each utterance and the hold is already `durationMs + 4000` per play, so the line stays held with no new rule. `brain.say` stays the one event that decides the line's face, so avatar never reads `brain.clause`. |
| Neutral | `neutral` means no expression: every path asks the driver for it at intensity 0 | Toggle `expressions.neutral` for a held neutral line; leave drivers to decide | Owner delegated the choice (take the recommendation, 2026-11-11): the resting mood already clears at intensity 0 and `avatar.state` reports intensity 0 for neutral, so a held `neutral` line is the only path that differed. Clearing is also the one meaning that needs no `neutral` entry in `expressions.yaml`. |
| Interrupted utterance | A newer `voice.playing` replaces the playing utterance without a `done` for the old one | Track overlapping utterances | The avatar follows the newest playing clause by design; overlap between sinks is voice's documented non-exclusivity. |
| Utterance eviction | The least recently prepared clause is evicted from a map of 50; a re-sent clause becomes the newest | Insertion order only; a bound in lines | A re-sent clause is a live one: evicting it early drops the lip-sync of a clause about to play. The bound is in clauses because each clause is prepared on its own. |
| Tests in the build | `services/avatar/test` is a project of the root `tsc -b`, emitting under `dist/test-build` | Type-check tests only in an editor | A type error in a test fails the build like one in the source (AVATAR-DEV-001). |
| Bootstrap | `runService` from `@cohost/shared`; `avatarMain` holds the service, `runAvatar` wires it with replaceable collaborators | A hand-written `runAvatar` with its own `fatal` handling | One bootstrap gives every service the same logger, config failure, heartbeat, shutdown and `fatal` path; the driver is created in `main`, so the heartbeat reads it by reference. |
| Connect behavior | VTS `connect()` resolves on error and is not awaited by startup; the engine and subscription start at once; reconnect every 5 s forever | Fail startup when the app is absent; await the first attempt (bounded or not) | Comment: "don't block startup; close handler schedules the retry" (`vtube-studio.ts`). Owner decision 2026-11-01: "not blocked" means the face and the subscription run while VTS is pairing or unreachable. Failures degrade and are reported (the heartbeat shows `degraded`), never end the service, so retrying never stops: the operator may start VTS at any point in a stream. VTS is a local LAN app, so a reconnect attempt is cheap, and a fixed 5 s interval means the face returns within 5 s of VTS starting, where a backoff would make a late start wait longer. |
| Token persistence | Plain file `<configDir>/.vts-token`, git-ignored and kept out of the image build context | Env var, Redis | Header comment: the token "is saved to <config>/.vts-token so it only happens once" (`vtube-studio.ts`). Owner decision 2026-11-01: the token is a secret and stays out of git and the build context (`.gitignore`; `.dockerignore` is deployment's). VTS issues the token at runtime, after the operator clicks Allow, so the service must write it itself: an env var cannot be written back, and Redis is the event bus, not durable secret storage. The config dir is already a host-mounted volume (`docker-compose.yml`), so a file there survives container rebuilds. |
| VMC transport | Own OSC encoder, UDP fire-and-forget | OSC library, TCP | Comment: "minimal OSC encoder (strings, int32, float32) — enough for VMC" (`vmc.ts`); UDP is what VMC receivers accept (`vmc.ts`). VMC needs three OSC argument types, which a few dozen lines encode, so the driver adds no dependency; TCP is not an option VMC receivers offer. |
| Both VRM 0.x and 1.0 names | Send `A`/`aa` and `Blink`/`blink` every frame | A per-model setting | Header comment: VRM 1.0 uses lowercase names, "so the driver sends mouth as both "A" and "aa" and blink as both "Blink"/"blink"" (`vmc.ts`). |
| Default driver | `null`, also for an empty `avatar.driver` | Require an explicit choice | Comment: "null = no avatar app, dashboard only" (`config.example.yaml`); isolated starts force it through the `AVATAR_DRIVER` isolation override (`packages/control/src/manifest.ts`, applied by key path from `COHOST_ISOLATION`, config CFG-ISO-007). Owner decision 2026-11-01: a config with no avatar settings must load (config writes the literal `"null"`). |
| Unknown driver name | Fail fast: config validation rejects it; the factory has no fallback | Fall back to the null driver (the null driver as the catch-all) | Owner decision 2026-11-01: a typo in `avatar.driver` is a configuration error the operator should see at once, not a silently missing avatar. |
| Capability declaration | None; a driver ignores calls it cannot honour | `capabilities()` on every driver | Owner decision 2026-11-01: nothing consumes it; it was only logged. |
| Lip-sync source | Follow every `voice.playing` / `voice.done`, including voice's `virtual` sink | Ignore `virtual`; follow only real sinks | Owner decision 2026-11-01: `virtual` is the only playback signal when no sink is attached; the late-sink double lifecycle is fixed in voice (VOICE-SINK-008). |
| Restart replay | Event-bus start mode `latest` (newest entry on every start) | Resume the backlog | Owner decision 2026-11-01: replayed `brain.say` and `voice.*` events would flash stale expressions and lip-sync. |
| Bus failures | Drop a failed `avatar.state` publish and log at a limited rate; a subscription rejection that survives the bus retry exits non-zero | Crash on any failure | Owner decision 2026-11-01 (cross-cutting): a lost preview frame must never end the face; a dead subscription is a clear, restartable failure. |
| Startup errors | All setup inside `main()`; any failure logs `fatal` and exits 1 | Module-level setup | Owner decision 2026-11-01 (cross-cutting): every startup failure is reported with the same log line. |
| `avatar.state` rate | Engine emits every frame, service throttles to at most once per 200 ms | Engine throttles | Comment: "5 Hz is plenty for the dashboard preview" (`state.ts`). |
| Readiness | `ready` once the engine runs and the `avatar` group is positioned with `resetGroup`; the driver may still be connecting (`deps.driver` shows it) | `ready` as soon as the driver object exists; `ready` only after the driver connects; a "subscribed" hook in event-bus | Owner decision 2026-11-01 (R3): ready means "can receive events", and the avatar app being absent is a dependency state, not an unready service. The bus has no hook that fires when `subscribe` has created the group and `subscribe` resolves only at stop, so boot positions the group itself; a hook would remove the duplicate positioning but needs an event-bus change. |
| Rejecting `driver.connect` | `fatal` and exit 1, though connect is not awaited | Ignore it; log and carry on | A rejection is a startup failure (AVATAR-BUS-007). The VTube Studio driver never rejects, so this reaches only a malformed host URL or a future driver's bug. |

## Open Questions & Future Decisions

None.

## References

Files in segment:
- `services/avatar/src/index.ts`, `boot.ts`, `state.ts`, `engine.ts`, `types.ts`, `health.ts`
- `services/avatar/src/drivers/index.ts`, `null.ts`, `vmc.ts`, `vtube-studio.ts`
- `services/avatar/test/boot.test.ts`, `state.test.ts`, `engine.test.ts`, `drivers.test.ts`, `drivers.vts.test.ts`, `health.test.ts`, `typecheck.test.ts`, `contract.test.ts`
- `services/avatar/package.json`, `services/avatar/tsconfig.json`, `services/avatar/test/tsconfig.json`
- `config/expressions.example.yaml`
- `examples/avatar-driver/udp-json.ts`, `examples/avatar-driver/README.md`, `services/avatar/test/example-driver.test.ts`; the docs site's Add an avatar driver page (`docs/advanced/extend/avatar-driver.md`) imports the driver

Other segments (direction):
- event-bus: consumes `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; produces `avatar.state` (schemas at `packages/bus/src/events.ts`).
- config: reads `Config["avatar"]`, `loadExpressions`, `configDir`, `Emotion` (`packages/config/src/schema.ts`); owns the `avatar.driver` blank-safe default and the port defaults.
- control-plane: heartbeat contract (`startHeartbeat`, `HeartbeatSpec`), health tracking, healthcheck, and the `AVATAR_DRIVER=null` isolated start (manifest).
- voice: produces `voice.utterance` (envelope) and arbitrates sinks that emit `voice.playing` / `voice.done`.
- affect: produces `affect.state` mood.
- cortex: produces `brain.say` (via the bus).
- dashboard: consumes `avatar.state` for the preview and emits `voice.playing`/`voice.done` as sink "dashboard".

External: `ws` (VTube Studio WebSocket), Node `dgram` (UDP), VTube Studio public API, VMC protocol.
