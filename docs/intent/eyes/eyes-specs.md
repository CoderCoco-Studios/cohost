# eyes specs

Segment `eyes` (prefix `EYES`). Mapped 2026-10-31 at git `686cc8f`; verified against the code in the audit pass of 2026-11-01. Owner decisions of 2026-11-01 applied at git `1b57790`. LLD: [eyes-design.md](eyes-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred.

## Enablement

- [x] **EYES-ENAB-001**: Where `vision.enabled` is false, the eyes service shall stay running, log one warning that vision is off (the idle plan, SHARED-IDLE-001), make no OBS connection or retry, and never run the look loop. <!-- test: services/eyes/test/eyes.test.ts --> <!-- test: services/eyes/test/service.test.ts --> <!-- openspec: eyes § Enablement -->
- [ ] **EYES-ENAB-002**: While `vision.enabled` is false, the eyes service shall run the shared idle plan of kind `off` (SHARED-IDLE-001): one warning naming `vision.enabled`, never repeated, and heartbeat `ready` with mode `off`.
- [x] **EYES-ENAB-003**: Where `vision.enabled` is true, the eyes service shall connect to OBS and then run the look loop. <!-- test: services/eyes/test/eyes.test.ts:83 --> <!-- openspec: eyes § Enablement -->
- [x] **EYES-ENAB-004**: The eyes service shall subscribe to `inject.request` whether or not `vision.enabled` is true. <!-- openspec: eyes § Injected images -->
- [x] **EYES-ENAB-005**: Where `vision.enabled` is false, when the process shuts down, the eyes service shall run one shutdown sequence (the bootstrap's `onStop` steps, SHARED-BOOT-005) that stops the idle plan, closes the OBS link, publishes the `stopping` heartbeat and stops the bus before exiting. <!-- test: services/eyes/test/service.test.ts -->

## OBS connection and capture

- [x] **EYES-OBS-001**: Where `vision.enabled` is true, the eyes service shall connect via obs-websocket to `ws://<vision.obs.host>:<vision.obs.port>`, treating an empty `vision.obs.password` as no password. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-002**: If the OBS connection attempt fails, the eyes service shall log a warning and retry after a delay that starts at 10 seconds and doubles per consecutive failure up to 60 seconds (`retryWithBackoff`, SHARED-RETRY-002), repeating until connected. <!-- openspec: eyes § OBS connection --> <!-- test: services/eyes/test/obs.test.ts:35 -->
- [x] **EYES-OBS-003**: When OBS connects, the eyes service shall log the obs-websocket version and signal heartbeat `ready`. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-004**: When the OBS connection closes for any reason, including a clean close, the eyes service shall reconnect to OBS with the EYES-OBS-002 retry and resume the look loop. <!-- openspec: eyes § OBS connection --> <!-- test: services/eyes/test/obs.test.ts:63 --> <!-- test: services/eyes/test/obs.test.ts:74 -->
- [x] **EYES-OBS-005**: If a look throws, the eyes service shall log `look failed` and, when OBS is no longer identified, reconnect to OBS. Reachable only for a drop during a look; untested. <!-- openspec: eyes § OBS connection -->
- [ ] **EYES-OBS-006**: When the eyes service captures a frame, it shall call `GetSourceScreenshot` for `vision.obs.source` as `jpg` at `vision.obs.width` with compression quality `vision.jpeg_quality` (default 70). <!-- openspec: eyes § Screenshot capture -->
- [x] **EYES-OBS-007**: When OBS returns image data with a `data:image/<type>;base64,` prefix, the eyes service shall strip the prefix before sending it to the vision model. <!-- test: services/eyes/test/eyes.test.ts:39 --> <!-- openspec: eyes § Screenshot capture -->
- [x] **EYES-OBS-008**: Where `vision.enabled` is true, when the process shuts down, the eyes service shall disconnect from OBS and stop the bus. (The disabled plan's shutdown is EYES-ENAB-005.) <!-- test: services/eyes/test/obs.test.ts:82,93 -->

## Vision description

- [ ] **EYES-DESC-001**: Where `vision.engine` is `ollama`, when describing a frame, the eyes service shall ask the `ollama` provider of `@cohost/llm` (never a raw HTTP call of its own) with model `vision.model`, `vision.temperature` (default 0.2), `maxTokens` `vision.num_predict` (default 60) and the base64 image on the user message, which is a `POST` to `<OLLAMA_URL>/api/chat` that is not streamed.
- [x] **EYES-DESC-002**: When a previous description exists, the eyes service shall include it in the user message as `Previous description: <text>`; otherwise it shall ask only `What is happening now?`. <!-- test: services/eyes/test/eyes.test.ts:46 --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-003**: The eyes service shall use only the first line of the model reply, trimmed. <!-- test: services/eyes/test/eyes.test.ts:46 --> <!-- openspec: eyes § Vision description -->
- [ ] **EYES-DESC-004**: If the vision model responds with a non-OK status, the eyes service shall throw the provider's error, which names the status and the body (`ollama chat <status>: <body>`).
- [ ] **EYES-DESC-005**: The eyes service shall send `vision.prompt` as the system message; its default instructs the model to answer exactly `SAME` when nothing meaningful changed versus the previous description.
- [ ] **EYES-DESC-007**: The `vision` section shall define `vision.prompt` (blank to the default of EYES-DESC-005), `vision.temperature` (0 to 2, default 0.2), `vision.num_predict` (positive integer, default 60) and `vision.jpeg_quality` (1 to 100, default 70), so the model options and capture quality are editable without a code change. The prompt carries the `SAME` contract of EYES-LOOK-002: a prompt that drops it makes every reply a change.
- [x] **EYES-DESC-006**: If the vision model has not answered a describe call within `vision.timeout_ms`, then the eyes service shall abort the request and treat it as a failed describe (a thrown error, so the look loop logs and continues, injection reports `ok:false`, and `deps.ollama` goes `down`). <!-- test: services/eyes/test/eyes.test.ts -->

## Look loop and publication

- [x] **EYES-LOOK-001**: When a look produces a non-empty description that is not a `SAME` reply (EYES-LOOK-002), the eyes service shall publish `vision.summary {text, changed: true}` (eyes publishes only changes, so `changed` is always `true`), remember the text as the next previous description, and report that something new was published. <!-- test: services/eyes/test/eyes.test.ts:19 --> <!-- openspec: eyes § Change-only publication -->
- [ ] **EYES-LOOK-002**: When the description is empty or is a clear `SAME` reply (the word `SAME` in any case, alone, optionally followed only by punctuation or whitespace, e.g. `same.`), the eyes service shall publish nothing, keep the previous description, and report no change. A reply that merely starts with the word (`Same old menu screen`, `Same as before`, `Samurai attack!`) is a description and is published. <!-- test: services/eyes/test/eyes.test.ts:31 --> <!-- openspec: eyes § Change-only publication -->
- [ ] **EYES-LOOK-003**: While the loop runs, the eyes service shall wait `vision.interval_ms` minus the time the look took between looks, measured on a monotonic clock, and never less than 500 ms. <!-- openspec: eyes § Polling cadence -->
- [x] **EYES-LOOK-004**: While OBS is not identified, the eyes service shall skip looks without error (`services/eyes/src/index.ts:71`); bringing the connection back is EYES-OBS-004's job.
- [ ] **EYES-LOOK-005**: If a look throws, the eyes service shall log a warning and continue the loop. <!-- test: services/eyes/test/service.test.ts -->

## Test injection

- [x] **EYES-INJ-001**: The eyes service shall subscribe with consumer group `eyes` to `inject.request`. <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-007**: When an uploaded image is fetched, the eyes service shall describe its base64 bytes with an empty previous description, publish `vision.summary {text, changed: true, injected: true, remember}`, then publish `inject.result {ok:true, detail:text}`. <!-- test: services/eyes/test/inject.test.ts:26,36 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-008**: If the injected image's description is empty or a `SAME` reply (EYES-LOOK-002), the eyes service shall publish `inject.result {ok:false}` and no `vision.summary`. <!-- test: services/eyes/test/inject.test.ts:43 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-009**: If the vision model call fails for an injected image, the eyes service shall publish `inject.result {ok:false, detail}` containing the error and no `vision.summary`. <!-- test: services/eyes/test/inject.test.ts:53 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-010**: The eyes service shall not read or change the look loop's previous description when handling an injected image. <!-- test: services/eyes/test/inject.test.ts:93 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-011**: The eyes service shall handle image injection without an OBS connection, including while `vision.enabled` is false. <!-- test: services/eyes/test/inject.test.ts:93 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-014**: The eyes service shall subscribe its `inject.request` consumer group `eyes` with start mode `latest`, so the group is reset to the newest entry on every start and no request published while eyes was down is handled. <!-- test: services/eyes/test/obs.test.ts:108 -->
- [ ] **EYES-INJ-016**: The eyes service shall handle `inject.request` through the shared inject handler (shared-runtime SHARED-INJ-*) with target `eyes`, the single kind `image`, the byte cap `vision.upload_max_bytes` and the fetch timeout `vision.upload_timeout_ms`. <!-- test: services/eyes/test/service.test.ts --> (EYES-INJ-002 to 006, 012, 013 and 015 are retired, now SHARED-INJ-001 to 008; numbers not reused.)

## Stub describer

- [ ] **EYES-STUB-001**: Where `vision.engine` is `stub`, the eyes service shall describe an image without any network request, returning `stub vision: <n> bytes` for an injected image and, in the look loop, that text for the first capture and `SAME` for every later one.
- [ ] **EYES-STUB-002**: Where `vision.engine` is `stub`, the eyes heartbeat shall report mode `mock` (or `off` when `vision.enabled` is false) and `deps.ollama` `n/a`, and the service shall log a startup warning that descriptions are stubbed.

## Health

- [x] **EYES-HEALTH-001**: Where `vision.enabled` is false, the eyes service shall report heartbeat `mode: "off"` with `deps.obs` and `deps.ollama` both `n/a` and state `ready`. <!-- test: services/eyes/test/health.test.ts:7 --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-002**: Where `vision.enabled` is true, the eyes service shall report `mode: "live"` with `deps.obs` `ok` while the OBS websocket is identified and `down` otherwise. <!-- test: services/eyes/test/health.test.ts:15 --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-003**: The eyes service shall set `deps.ollama` to `ok` after each successful describe call and `down` after each failed one, whether the call came from the look loop or an injected image (one tracked describer serves both, so they share one dependency status). <!-- test: services/eyes/test/health.test.ts:15 --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-004**: While a dependency is `down` after the service has signalled ready, the eyes heartbeat state shall be `degraded`. <!-- test: services/eyes/test/health.test.ts:15 --> <!-- openspec: eyes § Isolation preset and mode -->
- [x] **EYES-HEALTH-005**: The eyes service shall signal `ready` once OBS has connected when enabled, or immediately at startup when disabled. <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-006**: While `vision.enabled` is true and OBS has not yet been reachable, the eyes service shall report `degraded` with `deps.obs` `down`. <!-- openspec: eyes § Isolation preset and mode --> <!-- test: services/eyes/test/obs.test.ts:46 -->
