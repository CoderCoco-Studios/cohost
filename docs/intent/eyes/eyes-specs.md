# eyes specs

Segment `eyes` (prefix `EYES`). LLD: [eyes-design.md](eyes-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred. A `<!-- test: ... -->` pointer names the test file; paths are relative to the repo root.

## Enablement

- [x] **EYES-ENAB-001**: Where `vision.enabled` is false, the eyes service shall stay running, log one warning that vision is off (the idle plan, SHARED-IDLE-001), make no OBS connection or retry, and never run the look loop. <!-- test: services/eyes/test/eyes.test.ts --> <!-- test: services/eyes/test/service.test.ts --> <!-- openspec: eyes § Enablement -->
- [x] **EYES-ENAB-002**: While `vision.enabled` is false, the eyes service shall run the shared idle plan of kind `off` (SHARED-IDLE-001): one warning naming `vision.enabled`, never repeated, and heartbeat `ready` with mode `off`. <!-- test: services/eyes/test/service.test.ts -->
- [x] **EYES-ENAB-003**: Where `vision.enabled` is true, the eyes service shall connect to OBS and then run the look loop. <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Enablement -->
- [x] **EYES-ENAB-004**: The eyes service shall subscribe to `inject.request` whether or not `vision.enabled` is true. <!-- openspec: eyes § Injected images -->
- [x] **EYES-ENAB-005**: Where `vision.enabled` is false, when the process shuts down, the eyes service shall run one shutdown sequence (the bootstrap's `onStop` steps, SHARED-BOOT-005) that stops the idle plan, closes the OBS link, publishes the `stopping` heartbeat and stops the bus before exiting. <!-- test: services/eyes/test/service.test.ts -->

## OBS connection and capture

- [x] **EYES-OBS-001**: Where `vision.enabled` is true, the eyes service shall connect via obs-websocket to `ws://<vision.obs.host>:<vision.obs.port>`, treating an empty `vision.obs.password` as no password. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-002**: If the OBS connection attempt fails, the eyes service shall log a warning and retry after a delay that starts at 10 seconds and doubles per consecutive failure up to 60 seconds (`retryWithBackoff`, SHARED-RETRY-002), repeating until connected. <!-- test: services/eyes/test/obs.test.ts --> <!-- test: services/eyes/test/service.test.ts -->
- [x] **EYES-OBS-003**: When OBS connects, the eyes service shall log the obs-websocket version and signal heartbeat `ready`. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-004**: When the OBS connection closes for any reason, including a clean close, the eyes service shall reconnect to OBS with the EYES-OBS-002 retry and resume the look loop. <!-- openspec: eyes § OBS connection --> <!-- test: services/eyes/test/obs.test.ts --> <!-- test: services/eyes/test/obs.test.ts -->
- [x] **EYES-OBS-005**: If a look throws, the eyes service shall log `look failed` and, when OBS is no longer identified, reconnect to OBS. Reachable only for a drop during a look; untested. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-006**: When the eyes service captures a frame, it shall call `GetSourceScreenshot` for `vision.obs.source` as `jpg` at `vision.obs.width` with compression quality `vision.jpeg_quality` (default 70). <!-- test: services/eyes/test/service.test.ts -->
- [x] **EYES-OBS-007**: When OBS returns image data with a `data:image/<type>;base64,` prefix, the eyes service shall strip the prefix before sending it to the vision model. <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Screenshot capture -->
- [x] **EYES-OBS-008**: Where `vision.enabled` is true, when the process shuts down, the eyes service shall disconnect from OBS and stop the bus. (The disabled plan's shutdown is EYES-ENAB-005.) <!-- test: services/eyes/test/obs.test.ts -->

## Vision description

- [x] **EYES-DESC-001**: When describing a frame, the eyes service shall ask the chat provider `vision.provider` names, through `@cohost/llm` (never a raw HTTP call of its own), with model `vision.model`, `vision.temperature` (default 0.2), `maxTokens` `vision.num_predict` (default 60) and the base64 image on the user message; for `ollama` that is a `POST` to `<OLLAMA_URL>/api/chat` that is not streamed. <!-- test: services/eyes/test/eyes.test.ts -->
- [x] **EYES-DESC-002**: When a previous description exists, the eyes service shall include it in the user message as `Previous description: <text>`; otherwise it shall ask only `What is happening now?`. <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-003**: The eyes service shall use only the first line of the model reply, trimmed. <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-004**: If the vision model responds with a non-OK status, the eyes service shall throw the provider's error, which names the status and the body (`ollama chat <status>: <body>`). <!-- test: services/eyes/test/eyes.test.ts -->
- [x] **EYES-DESC-005**: The eyes service shall send `vision.prompt` as the system message; its default instructs the model to answer exactly `SAME` when nothing meaningful changed versus the previous description. <!-- test: services/eyes/test/eyes.test.ts -->
- [x] **EYES-DESC-007**: The `vision` section shall define `vision.prompt` (blank to the default of EYES-DESC-005), `vision.temperature` (0 to 2, default 0.2), `vision.num_predict` (positive integer, default 60) and `vision.jpeg_quality` (1 to 100, default 70), so the model options and capture quality are editable without a code change. The prompt carries the `SAME` contract of EYES-LOOK-002: a prompt that drops it makes every reply a change. <!-- test: packages/config/test/config.test.ts -->
- [x] **EYES-DESC-006**: If the vision model has not answered a describe call within `vision.timeout_ms`, whatever the provider, then the eyes service shall abort the request and treat it as a failed describe (a thrown error, so the look loop logs and continues, injection reports `ok:false`, and `deps.vision` goes `down`). <!-- test: services/eyes/test/eyes.test.ts -->

## Describer provider (PROV)

Design: LLD § The describer's provider.

- [x] **EYES-PROV-001**: The eyes service shall accept `vision.provider` values `ollama`, `openai`, `anthropic`, `bedrock` and `stub`, and shall use `ollama` where it is blank or unset.
- [x] **EYES-PROV-002**: Where `vision.provider` is not `stub`, the eyes service shall build its describer's provider with `createChatProvider({...llm, provider: vision.provider, model: vision.model})`.
- [x] **EYES-PROV-003**: The eyes service shall build its describer whether or not `vision.enabled` is true, so that an injected image is described through `vision.provider` in either case.
- [x] **EYES-PROV-004**: Where `vision.provider` is `openai`, the eyes service shall send frames to `llm.openai.base_url`, whose default is `https://api.openai.com/v1`.
- [x] **EYES-PROV-005**: Where `vision.provider` is `openai`, `anthropic` or `bedrock`, the eyes service shall use the credentials stored for the chat model (`llm.openai.api_key`, `llm.claude.api_key`, `llm.bedrock.*`) and shall define no credential of its own.
- [x] **EYES-PROV-006**: If a describe call fails with a refused or dropped connection, a timeout, a 5xx, a 401, 403, 404 or 429, any other failed status except 400 and 422, or a failure that carries no HTTP status, then the eyes service shall set `deps.vision` to `down`; a frame fault (EYES-PROV-007) shall leave `deps.vision` unchanged.
- [x] **EYES-PROV-007**: If a describe call fails with a frame fault, meaning a 400 or 422 from the provider for one frame, or a `TypeError` from the model layer for image data in no supported format (LLM-VIS-005, such as a BMP or a PDF), then the eyes service shall drop that frame with a warning, fail that look or injection with the error's message, and leave `deps.vision` unchanged. <!-- test: services/eyes/test/health.test.ts, services/eyes/test/inject.test.ts -->

## Configuration gaps (GAP)

Design: LLD § The describer's provider, A configuration gap.

- [x] **EYES-GAP-001**: Where `vision.provider` is not `stub` and `vision.model` is blank, the eyes service shall start and shall make no describe call from the look loop.
- [x] **EYES-GAP-002**: While `vision.enabled` is true, `vision.model` is blank and `vision.provider` is not `stub`, the eyes service shall report `deps.vision` `down` with the reason `vision.model is not set` in the heartbeat detail.
- [x] **EYES-GAP-003**: Where `vision.provider` is `anthropic` or `bedrock` and its credentials are absent, the eyes service shall start, fail each describe call at once with a `not configured` error naming the missing key, and report `deps.vision` `down` with that reason.
- [x] **EYES-GAP-004**: If an `inject.request` for an image arrives while `vision.model` is blank and `vision.provider` is not `stub`, then the eyes service shall publish `inject.result {ok:false, detail}` with the detail `vision.model is not set` and no `vision.summary`.
- [x] **EYES-GAP-005**: While `vision.model` is blank, the eyes service shall still handle `inject.request` and shall not exit.
- [x] **EYES-GAP-006**: Where `vision.provider` is `bedrock` and its region and key pair are only partly set, so that the model layer refuses to construct its provider (LLM-CLAUDE-016), the eyes service shall start, fail each describe call at once with that error, and report `deps.vision` `down` with that reason, instead of exiting.

## Egress (EGR)

Design: LLD § The describer's provider, Shown.

- [x] **EYES-EGR-001**: Where `vision.provider` is not `stub` and its destination is off the LAN by the egress rule (config, Egress destinations), the eyes service shall log one warning at start, whether or not `vision.enabled` is true.
- [x] **EYES-EGR-002**: Where `vision.provider` is `anthropic` or `bedrock`, the eyes service shall name the provider, and no host, in that warning and in its heartbeat detail.
- [x] **EYES-EGR-003**: Where `vision.provider` is `openai` and `llm.openai.base_url` is its default, the eyes service shall log the egress warning naming the host `api.openai.com`.
- [x] **EYES-EGR-004**: Where `vision.provider` is not `stub`, the eyes service shall name the provider and the host it talks to in its heartbeat detail.

## Look loop and publication

- [x] **EYES-LOOK-001**: When a look produces a non-empty description that is not a `SAME` reply (EYES-LOOK-002), the eyes service shall publish `vision.summary {text, changed: true}` (eyes publishes only changes, so `changed` is always `true`), remember the text as the next previous description, and report that something new was published. <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Change-only publication -->
- [x] **EYES-LOOK-002**: When the description is empty or is a clear `SAME` reply (the word `SAME` in any case, alone, optionally followed only by punctuation or whitespace, e.g. `same.`), the eyes service shall publish nothing, keep the previous description, and report no change. A reply that merely starts with the word (`Same old menu screen`, `Same as before`, `Samurai attack!`) is a description and is published. <!-- test: services/eyes/test/eyes.test.ts --> <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Change-only publication -->
- [x] **EYES-LOOK-003**: While the loop runs, the eyes service shall wait `vision.interval_ms` minus the time the look took between looks, measured on a monotonic clock, and never less than 500 ms. <!-- test: services/eyes/test/service.test.ts --> <!-- test: services/eyes/test/eyes.test.ts --> <!-- openspec: eyes § Polling cadence -->
- [x] **EYES-LOOK-004**: While OBS is not identified, the eyes service shall skip looks without error (`services/eyes/src/service.ts`); bringing the connection back is EYES-OBS-004's job. <!-- test: services/eyes/test/service.test.ts -->
- [x] **EYES-LOOK-005**: If a look throws, the eyes service shall log a warning and continue the loop. <!-- test: services/eyes/test/service.test.ts -->
- [x] **EYES-LOOK-006**: When a look publishes `vision.summary`, the eyes service shall set `timing.capturedAt` to the epoch-millisecond time the screenshot call returned and `timing.describedAt` to the epoch-millisecond time the describe call returned, with `capturedAt <= describedAt`. <!-- test: services/eyes/test/eyes.test.ts -->
- [x] **EYES-LOOK-007**: When a look completes, the eyes service shall log the describe call's duration in milliseconds, whether the look published a summary, ended as a `SAME` reply, or returned an empty description. <!-- test: services/eyes/test/eyes.test.ts -->

## Test injection

- [x] **EYES-INJ-001**: The eyes service shall subscribe with consumer group `eyes` to `inject.request`. <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-007**: When an uploaded image is read from Redis, the eyes service shall describe its base64 bytes with an empty previous description, publish `vision.summary {text, changed: true, injected: true, remember}`, then publish `inject.result {ok:true, detail:text}`. <!-- test: services/eyes/test/inject.test.ts --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-008**: If the injected image's description is empty or a `SAME` reply (EYES-LOOK-002), the eyes service shall publish `inject.result {ok:false}` and no `vision.summary`. <!-- test: services/eyes/test/inject.test.ts --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-009**: If the vision model call fails for an injected image, the eyes service shall publish `inject.result {ok:false, detail}` containing the error and no `vision.summary`. <!-- test: services/eyes/test/inject.test.ts --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-010**: The eyes service shall not read or change the look loop's previous description when handling an injected image. <!-- test: services/eyes/test/inject.test.ts --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-011**: The eyes service shall handle image injection without an OBS connection, including while `vision.enabled` is false. <!-- test: services/eyes/test/inject.test.ts --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-014**: The eyes service shall subscribe its `inject.request` consumer group `eyes` with start mode `latest`, so the group is reset to the newest entry on every start and no request published while eyes was down is handled. <!-- test: services/eyes/test/obs.test.ts -->
- [x] **EYES-INJ-016**: The eyes service shall handle `inject.request` through the shared inject handler (shared-runtime SHARED-INJ-*) with target `eyes`, the single kind `image`, the byte cap `vision.upload_max_bytes` and the upload read timeout `vision.upload_timeout_ms`, taking the upload through its bus connection (`Bus.takeUpload`). <!-- test: services/eyes/test/service.test.ts --> (EYES-INJ-002 to 006, 012, 013 and 015 are retired, now SHARED-INJ-001 to 008; numbers not reused.)
- [x] **EYES-INJ-017**: When the eyes service publishes `vision.summary` for an injected image, it shall omit `timing`, because the image is not a frame captured from the vision source. <!-- test: services/eyes/test/inject.test.ts -->
- [x] **EYES-INJ-018**: When the eyes service describes an injected image, it shall do so through `vision.provider`, whether or not `vision.enabled` is true.

## Stub describer

- [x] **EYES-STUB-001**: Where `vision.provider` is `stub`, the eyes service shall describe an image without any network request, returning `stub vision: <n> bytes` for an injected image and, in the look loop, that text for the first capture and `SAME` for every later one. <!-- test: services/eyes/test/eyes.test.ts -->
- [x] **EYES-STUB-002**: Where `vision.provider` is `stub`, the eyes heartbeat shall report mode `mock` (or `off` when `vision.enabled` is false) and `deps.vision` `n/a`, and the service shall log a startup warning that descriptions are stubbed. <!-- test: services/eyes/test/health.test.ts --> <!-- test: services/eyes/test/service.test.ts -->
- [x] **EYES-STUB-003**: Where an isolation override sets `vision.provider` to `stub`, the eyes service shall describe with the stub, whatever provider the configuration names.

## Health

- [x] **EYES-HEALTH-001**: Where `vision.enabled` is false, the eyes service shall report heartbeat `mode: "off"` with `deps.obs` and `deps.vision` both `n/a` and state `ready`. <!-- test: services/eyes/test/health.test.ts --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-002**: Where `vision.enabled` is true, the eyes service shall report `mode: "live"` with `deps.obs` `ok` while the OBS websocket is identified and `down` otherwise. <!-- test: services/eyes/test/health.test.ts --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-003**: While `vision.enabled` is true, the eyes service shall set `deps.vision` to `ok` after each successful describe call and `down` after each outage-class failure (EYES-PROV-006), whether the call came from the look loop or an injected image (one tracked describer serves both, so they share one dependency status). <!-- test: services/eyes/test/health.test.ts --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-004**: While a dependency is `down` after the service has signalled ready, the eyes heartbeat state shall be `degraded`. <!-- test: services/eyes/test/health.test.ts --> <!-- openspec: eyes § Isolation preset and mode -->
- [x] **EYES-HEALTH-005**: The eyes service shall signal `ready` once OBS has connected when enabled, or immediately at startup when disabled. <!-- test: services/eyes/test/obs.test.ts --> <!-- test: services/eyes/test/service.test.ts --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-006**: While `vision.enabled` is true and OBS has not yet been reachable, the eyes service shall report `degraded` with `deps.obs` `down`. <!-- openspec: eyes § Isolation preset and mode --> <!-- test: services/eyes/test/obs.test.ts -->
- [x] **EYES-HEALTH-007**: While `vision.enabled` is false, the eyes service shall keep `deps.vision` `n/a` whatever the outcome of an injected image.
