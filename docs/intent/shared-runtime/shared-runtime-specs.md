# shared-runtime specs

Segment `shared-runtime` (prefix `SHARED`). LLD: [shared-runtime-design.md](shared-runtime-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred.

The modules exist in `@cohost/shared`; a `[ ]` line is behaviour the native bus transport (event-bus, Native transport) needs that the code does not have yet. Lines marked "moved from" restate behaviour that lived at another location under the retired ID named; the code moved and its `@spec` annotations were rewritten. The retired IDs are not reused.

Terms: "the service" is the service that calls the module; "the bootstrap" is `runService`; "the session" is a Discord voice session created by `createDiscordVoiceSession`; "the inject handler" is a handler created by `createInjectHandler`.

## Service bootstrap (SHARED-BOOT)

- [x] **SHARED-BOOT-001**: When `runService({ service, health, main })` is called, the bootstrap shall create the service logger, load the configuration, create a bus whose source is `service`, start the heartbeat in state `starting` with `health(cfg)`, and then call `main` with `{ cfg, bus, log, heartbeat, onStop }`, in that order.
- [x] **SHARED-BOOT-002**: If loading the configuration fails, then the bootstrap shall log the loader's message, create no bus and no heartbeat, and end the process with status 1.
- [x] **SHARED-BOOT-003**: If `main` throws or rejects, then the bootstrap shall log the error with message `fatal` and end the process with status 1.
- [x] **SHARED-BOOT-004**: The bootstrap shall never call `heartbeat.ready()` or `heartbeat.degraded()` itself; the service's `main` or its idle plan decides readiness.
- [ ] **SHARED-BOOT-005**: When the process receives SIGINT or SIGTERM, the bootstrap shall run the lifecycle shutdown sequence (SHARED-LIFE-001) whose callback runs every step registered with `onStop` in reverse registration order, each awaited, logging and skipping a step that throws or rejects, then calls `bus.stop()` and awaits the promise it returns.
- [ ] **SHARED-BOOT-006**: If the steps registered with `onStop` have not all settled within 5000 ms of the first one starting, then the bootstrap shall stop waiting for them, call `bus.stop()`, await the promise it returns (which resolves within about 2 s, BUS-NAT-ACK-007) and let the process exit with code 0.
- [x] **SHARED-BOOT-007**: When a shutdown signal arrives before `main` has resolved, the bootstrap shall run only the `onStop` steps registered so far, and a step registered after the shutdown sequence has started shall not run.
- [x] **SHARED-BOOT-008**: The bootstrap shall accept replacements for its configuration loader, bus factory, shutdown registrar, process exit and logger, so a test runs `main` with no Redis, no signal handling and no process exit.

## Lifecycle: shutdown and heartbeat (SHARED-LIFE)

- [ ] **SHARED-LIFE-001**: When a process that has called `onShutdown(fn)` receives SIGINT or SIGTERM, the system shall run every function registered with `beforeShutdown` concurrently (waiting at most 2000 ms for them to settle and ignoring rejections), then run the registered callbacks, awaiting the promise each returns (so an asynchronous `Bus.stop()` inside a callback completes), then exit the process with code 0. Moved from BUS-STOP-002.
- [x] **SHARED-LIFE-002**: When the process receives a second SIGINT or SIGTERM after the shutdown sequence has started, the system shall ignore it (the sequence runs at most once). Moved from BUS-STOP-003.
- [x] **SHARED-LIFE-003**: If a callback passed to `onShutdown` throws or rejects, then the system shall still exit the process with code 0. Moved from BUS-STOP-004.
- [ ] **SHARED-LIFE-004**: When a process that has registered more than one `onShutdown` callback receives SIGINT or SIGTERM, the system shall run the `beforeShutdown` hooks once, then run every registered callback to completion (awaiting the promise each returns, an asynchronous `Bus.stop()` included), logging (and otherwise ignoring) any callback that throws or rejects so the others still run, and then exit the process once with code 0. Moved from BUS-STOP-005.
- [x] **SHARED-LIFE-005**: If a function registered with `beforeShutdown` throws synchronously, then the system shall treat it like a rejected hook: ignore it, still wait for the other hooks within the 2000 ms window, and still run the `onShutdown` callbacks. Moved from BUS-STOP-006.
- [x] **SHARED-LIFE-006**: When `startHeartbeat` builds a heartbeat, the system shall set `service` from the options, `instance` to the bus consumer name, `pid` to the process pid, `version` to the option, else `COHOST_VERSION`, else `dev`, `startedAt` to the load time of the shared lifecycle module (constant for the process), `state` from the `starting`/`ready`/`degraded` base, `deps`, `mode`, optional `detail` and `intervalMs`. Moved from CTRL-HEARTBEAT-001.
- [x] **SHARED-LIFE-007**: When `startHeartbeat` is called, the system shall publish a `starting` heartbeat immediately, publish immediately on every `ready()` or `degraded(detail?)` call, and republish every `intervalMs`, where `intervalMs` is `HEARTBEAT_INTERVAL_MS` floored when it is a positive finite number and otherwise 5000. Moved from CTRL-HEARTBEAT-002.
- [x] **SHARED-LIFE-008**: While a heartbeat is running, the system shall re-read `deps` and `mode` (each may be a getter) at least once per second (every `min(1000, intervalMs)` ms) and republish at once when the state, deps, mode or detail differs from the last publication; when the base state is `ready` and any dep is `down` it shall publish `degraded` with detail `dependency down: <names>`. Moved from CTRL-HEARTBEAT-003.
- [x] **SHARED-LIFE-009**: When the heartbeat's `stop()` is called, the system shall publish exactly one heartbeat with `state: "stopping"`, cancel both timers, ignore later `ready()`/`degraded()` publications, and make repeated `stop()` calls no-ops. Moved from CTRL-HEARTBEAT-004.
- [x] **SHARED-LIFE-010**: When `startHeartbeat` is called, the system shall register the heartbeat's `stop()` as a `beforeShutdown` hook, so that a SIGINT or SIGTERM handled through `onShutdown` publishes the `stopping` heartbeat before the service's own shutdown callback runs (SHARED-LIFE-001). Moved from CTRL-HEARTBEAT-005.
- [x] **SHARED-LIFE-011**: If publishing a heartbeat fails, then the system shall keep running without throwing into the service and, when a logger was supplied, log a warning at most once per 60 s for that heartbeat, counting the publishes that failed since the last warning. Moved from CTRL-HEARTBEAT-006 (the rate limit is new).
- [x] **SHARED-LIFE-012**: The system shall provide `tracked(fn, set)` which wraps an async call so `set(true)` follows a success and `set(false)` follows a failure while the error still propagates, so a service can feed a dependency status from real call outcomes. Moved from CTRL-HEARTBEAT-008.
- [x] **SHARED-LIFE-013**: Where `startHeartbeat` is given a standing `detail`, the system shall publish it as the heartbeat `detail` in every state, including `starting` and after `ready()`, unless an explicit `degraded(detail)` or the derived `dependency down: ...` detail applies, which take precedence in that order. Moved from CTRL-HEARTBEAT-009.
- [x] **SHARED-LIFE-014**: The heartbeat shall provide `setDetail(detail | undefined)`, which replaces the standing detail of SHARED-LIFE-013 and is published by the change watcher of SHARED-LIFE-008.
- [x] **SHARED-LIFE-015**: `@cohost/shared` shall export `onShutdown`, `beforeShutdown`, `startHeartbeat` and `tracked`, and `@cohost/bus` shall export none of them.

## Retry with backoff (SHARED-RETRY)

- [x] **SHARED-RETRY-001**: When `retryWithBackoff(attempt, opts)` is called, the system shall wait `firstDelayMs` (default 0), then call `attempt()` until it resolves, and resolve with its value.
- [x] **SHARED-RETRY-002**: When the n-th consecutive call of `attempt()` fails, the system shall call `onFailure(err, n, delayMs)` and then wait `delayMs = min(maxMs, baseMs * factor^(n-1))` (factor default 2) before the next call.
- [x] **SHARED-RETRY-003**: When `isStopped()` returns true at one of its checks (before every attempt and after every wait), the system shall resolve `undefined` without calling `attempt()` again.
- [x] **SHARED-RETRY-004**: If `isFatal(err)` returns true for a failure, then the system shall reject with that error at once, without calling `onFailure` or waiting.
- [x] **SHARED-RETRY-005**: If `onFailure` throws, then the system shall treat the throw as logged-and-ignored and continue retrying.
- [x] **SHARED-RETRY-006**: The system shall provide `singleFlight(fn)` returning a function whose concurrent calls share one running call of `fn` and whose next call after it settles starts a new one.
- [x] **SHARED-RETRY-007**: `retryWithBackoff` shall take its `sleep` as an option (default a timer), so a test drives it without real time.

## Missing-credentials idle plan (SHARED-IDLE)

- [x] **SHARED-IDLE-001**: When `startIdle({ kind: "off", reason })` is called, the system shall log one warning containing `reason` (and no repeated warning while off), set the heartbeat mode to `off`, call `heartbeat.ready()`, and schedule no reminder.
- [x] **SHARED-IDLE-002**: When `startIdle({ kind: "degraded", reason })` is called, the system shall log one error containing `reason` and call `heartbeat.degraded(reason)`.
- [x] **SHARED-IDLE-003**: While a `degraded` idle plan is running, the system shall log the warning `<reason>; still idle` first after `warnEveryMs` (default 60000) and then after a delay that doubles each time, so the reminders come at 60 s, 120 s, 240 s and so on.
- [x] **SHARED-IDLE-006**: While a `degraded` idle plan is running, the system shall never wait longer than `maxWarnEveryMs` (default 3600000, one hour) between reminders and never less than the previous wait, so the reminder rate is bounded at one per hour and the cause stays in the log of a container that runs for days.
- [x] **SHARED-IDLE-004**: When the idle plan's `stop()` is called, the system shall cancel the reminder; a second `stop()` does nothing.
- [x] **SHARED-IDLE-005**: The idle plan shall subscribe to no bus event and publish nothing but through the heartbeat; a service that handles test injection while idle subscribes its inject handler itself.

## Control handling (SHARED-CTRL)

- [x] **SHARED-CTRL-001**: When a `control` event reaches `controlFor(service, handlers).handle(ev)` with no `target` or with `target` equal to `service`, the system shall apply it; with any other `target` it shall apply nothing; in both cases `handle` shall return true, and for any non-`control` event it shall return false.
- [x] **SHARED-CTRL-002**: The control reader shall start every process with `paused` and `muted` false and `epoch` 0.
- [x] **SHARED-CTRL-003**: When the reader applies `pause`, `resume`, `mute` or `unmute`, it shall set `paused` or `muted` accordingly before calling the service's matching handler, if any.
- [x] **SHARED-CTRL-004**: When the reader applies `pause` or `forget_context`, it shall increase `epoch` by one before calling the service's handler.
- [x] **SHARED-CTRL-005**: When the reader applies `forget_context`, `reload_personality` or `say`, it shall call the service's matching handler, if any, with the event's data, and do nothing else for a command the service gave no handler for; `set_routing` is likewise handed to the service's `set_routing` handler and changes no reader state.
- [x] **SHARED-CTRL-006**: If a service handler throws or rejects, then the reader shall log the error and keep its state as already updated.
- [x] **SHARED-CTRL-007**: Where `controlFor` is given the service's heartbeat, the reader shall set the heartbeat's standing detail to `paused` while `paused` is true and clear it on `resume` (SHARED-LIFE-014).
- [x] **SHARED-CTRL-008**: The salience, cortex, affect and mouth services shall read `control` only through `controlFor`, and no other service shall call it.

## Test injection (SHARED-INJ)

- [x] **SHARED-INJ-001**: When an `inject.request` whose `target` differs from the handler's target arrives, the inject handler shall ignore it and publish nothing. Moved from EARS-INJ-001 and EYES-INJ-002.
- [x] **SHARED-INJ-002**: If an `inject.request` for the handler's target is older than `INJECT_STALE_MS` by its event timestamp when it is taken from the queue, then the inject handler shall publish `inject.result` with `ok` false and detail `stale`, reading nothing and calling no kind function. Moved from EARS-INJ-002 and EYES-INJ-003.
- [x] **SHARED-INJ-003**: If an `inject.request` has a `kind` the handler was given no function for, then the inject handler shall publish `inject.result` with `ok` false and detail "<target> cannot handle kind '<kind>'". Moved from EARS-INJ-003 and EYES-INJ-004.
- [x] **SHARED-INJ-004**: If an `image` or `audio` request carries no `uploadId`, or one that is not 32 lowercase hex digits, then the inject handler shall read nothing and publish `inject.result` with `ok` false and detail "request carries no upload id". (The URL guard of earlier versions is retired: a request names an upload by id, never by URL.) <!-- test: packages/shared/test/inject-handler.test.ts -->
- [x] **SHARED-INJ-005**: When an `image` or `audio` request carries an upload id, the inject handler shall take the bytes from Redis with the service's `takeUpload` (which deletes the key, BUS-UPL-002) and call the kind function with them and `{ contentType }` from the request, and the key shall be gone afterwards whether the kind function succeeds or fails. (The redirect and non-2xx handling of the HTTP fetch is retired.) <!-- test: packages/shared/test/inject-handler.test.ts -->
- [x] **SHARED-INJ-006**: If taking an upload has not completed within the handler's `readTimeoutMs`, then the inject handler shall stop waiting and publish `inject.result` with `ok` false and a detail naming the timeout, without calling the kind function. Moved from EYES-INJ-012. <!-- test: packages/shared/test/inject-handler.test.ts -->
- [x] **SHARED-INJ-007**: If an upload's bytes exceed the handler's byte cap for its kind, then the inject handler shall publish `inject.result` with `ok` false and a detail naming the limit, without calling the kind function. Moved from EYES-INJ-013. <!-- test: packages/shared/test/inject-handler.test.ts -->
- [x] **SHARED-INJ-008**: Every inject handler shall judge staleness against the one `INJECT_STALE_MS` (60000 ms) exported by `@cohost/shared`; `uploadUrl` no longer exists. Moved from EYES-INJ-015.
- [x] **SHARED-INJ-009**: When an `inject.request` for the handler's target arrives, the handler's subscription callback shall queue it and return without awaiting it, and the handler shall process queued requests one at a time in arrival order.
- [x] **SHARED-INJ-010**: If a request arrives while 8 requests are waiting in the queue (not counting the one being processed), then the inject handler shall publish `inject.result` with `ok` false and detail `busy` for it and not queue it. The limit is exported as `INJECT_QUEUE_LIMIT` so other bounded input paths (ears' `http` and `dir` capture sources) share it.
- [x] **SHARED-INJ-011**: When a kind function returns, the inject handler shall publish `inject.result` with the request's `id`, `ok` true and the function's detail; if the function throws or rejects, it shall publish `ok` false with the error text as detail.
- [x] **SHARED-INJ-012**: If publishing an `inject.result` fails, then the inject handler shall log a warning and continue with the next queued request.
- [x] **SHARED-INJ-013**: If the upload named by an `image` or `audio` request is missing from Redis (never stored, already taken or expired), then the inject handler shall publish `inject.result` with `ok` false and detail "upload expired or missing", without calling the kind function. <!-- test: packages/shared/test/inject-handler.test.ts -->

## Audio (SHARED-AUDIO)

- [x] **SHARED-AUDIO-001**: When `parseWav(buf, { requireRiff })` is called, the system shall (unless `requireRiff` is false) require a `RIFF`/`WAVE` header, walk the chunks skipping unknown and odd-sized ones, read channels, sample rate and bit depth from `fmt `, clamp the data length to the bytes present, and return sample rate, channels, bits per sample, data offset and length, and duration in milliseconds from the frame count. Moved from VOICE-ENV-001 and EARS-AUD-003.
- [x] **SHARED-AUDIO-002**: If a buffer is not RIFF/WAVE (when required) or has no data chunk, then `parseWav` shall throw "not a RIFF/WAVE file" or "no data chunk" respectively. Moved from VOICE-ENV-002.
- [x] **SHARED-AUDIO-003**: If the `fmt ` chunk is missing or follows the `data` chunk, its format tag is neither PCM (1) nor extensible with a PCM subformat, its channel count or sample rate is 0, or its bit depth is not 16, then `parseWav` shall throw "unsupported wav: <cause>".
- [x] **SHARED-AUDIO-004**: When `wavWrap(pcm, rate, channels)` is called, the system shall prepend a canonical 44-byte PCM16 header carrying the given sample rate and channel count, with byte rate, block align and RIFF and data lengths derived from them, so that `parseWav` reads the same rate, channels, data span and duration back. Moved from EARS-AUD-004.
- [x] **SHARED-AUDIO-005**: When `resample` converts by an integer downsampling ratio r, it shall output each frame as the average of r consecutive input frames (after channel mix-down), clamped to the int16 range, dropping a trailing partial group; 48 kHz stereo to 16 kHz mono therefore averages each group of 3 frames and both channels. Moved from EARS-AUD-001.
- [x] **SHARED-AUDIO-006**: When `resample` converts by any ratio that is not an integer downsampling ratio, it shall interpolate linearly between neighbouring input frames, producing `floor(inFrames * toRate / fromRate)` frames, so a mono or stereo 16-bit WAV of any rate becomes 48 kHz stereo s16le PCM with its duration preserved. Moved from MOUTH-AUD-001.
- [x] **SHARED-AUDIO-007**: When `resample` changes the channel count, it shall mix down by averaging the input channels and mix up by copying the first channel, and it shall round every output sample and clamp it to the int16 range.
- [x] **SHARED-AUDIO-008**: If `resample` is given an empty buffer, or a buffer whose length is not a whole number of input frames, then it shall convert the whole frames present and ignore the trailing bytes; a buffer with no whole frame yields an empty output.

## Discord voice session (SHARED-DVS)

The session's only user is the Discord connector ([connections](../connections/connections-specs.md), CONN-DISC-003); ears and mouth hold no Discord client.

- [x] **SHARED-DVS-001**: The Discord voice session shall be exported only from the `@cohost/shared/discord-voice` entry point, and `@cohost/shared`'s main entry point shall not load `discord.js` or `@discordjs/voice`.
- [x] **SHARED-DVS-002**: When `start()` is called, the session shall log in with the given token and, once the client is ready, join the given guild and voice channel with the given self-mute and self-deaf flags and wait up to 20 s for the connection to reach Ready; if the login fails, `start()` shall reject with the login error.
- [x] **SHARED-DVS-003**: When the session's voice connection is Disconnected and does not enter Signalling or Connecting within 5 s, the session shall set `isReady()` false, call `onDisconnected`, destroy the connection and start the join loop of SHARED-DVS-004 with a first delay of 5 s and its attempt count back at 1. Moved from EARS-SESS-005 and MOUTH-SESS-005.
- [x] **SHARED-DVS-004**: If a join attempt fails (the initial join or a rejoin), then the session shall destroy the half-open connection, call `onJoinFailed(err, attempt)`, and retry after a delay that starts at the configured base (5 s) and doubles up to the configured cap (60 s) until a join succeeds or the session stops. Moved from EARS-SESS-006 and MOUTH-SESS-006.
- [x] **SHARED-DVS-005**: When the connection reaches Ready, the session shall set `isReady()` true and call `onConnected(connection)`.
- [x] **SHARED-DVS-006**: Concurrent calls that start the join loop (the initial join and a rejoin) shall share one running loop.
- [x] **SHARED-DVS-007**: When `stop()` is called, the session shall end the join loop, destroy the voice connection and the client, and resolve; a second `stop()` shall do nothing.

## Behaviour that stays in a service (SHARED-BOUND)

- [x] **SHARED-BOUND-001**: A behaviour shall be moved into `@cohost/shared` only when a second service needs it; voice's lip-sync envelope, mouth's output gain and fallback clip handling, and ears' speaker capture stay in their services.
- [x] **SHARED-BOUND-002**: `@cohost/shared` shall depend on `@cohost/config` and `@cohost/bus` only among workspace packages, and `@cohost/bus` shall not depend on `@cohost/shared`.
