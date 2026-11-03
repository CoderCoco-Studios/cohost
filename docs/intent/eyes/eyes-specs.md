# eyes specs

Segment `eyes` (prefix `EYES`). Mapped 2026-10-31 at git `686cc8f`; verified against the code in the audit pass of 2026-11-01. Owner decisions of 2026-11-01 applied at git `1b57790`. LLD: [eyes-design.md](eyes-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred.

## Enablement

- [x] **EYES-ENAB-001**: Where `vision.enabled` is false, the eyes service shall stay running, log a startup warning, make no OBS connection or retry, and never run the look loop. <!-- test: services/eyes/test/eyes.test.ts:70 --> <!-- openspec: eyes § Enablement -->
- [x] **EYES-ENAB-002**: While `vision.enabled` is false, the eyes service shall log an idle warning every 60 seconds and report heartbeat `ready` with mode `off`. <!-- openspec: eyes § Isolation preset and mode -->
- [x] **EYES-ENAB-003**: Where `vision.enabled` is true, the eyes service shall connect to OBS and then run the look loop. <!-- test: services/eyes/test/eyes.test.ts:83 --> <!-- openspec: eyes § Enablement -->
- [x] **EYES-ENAB-004**: The eyes service shall subscribe to `inject.request` whether or not `vision.enabled` is true. <!-- openspec: eyes § Injected images -->
- [x] **EYES-ENAB-005**: Where `vision.enabled` is false, when the process shuts down, the eyes service shall run one shutdown sequence that clears the idle warning timer, publishes the `stopping` heartbeat and stops the bus before exiting. <!-- test: services/eyes/test/obs.test.ts:93 -->

## OBS connection and capture

- [x] **EYES-OBS-001**: Where `vision.enabled` is true, the eyes service shall connect via obs-websocket to `ws://<vision.obs.host>:<vision.obs.port>`, treating an empty `vision.obs.password` as no password. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-002**: If the OBS connection attempt fails, the eyes service shall log a warning and retry after 10 seconds, repeating until connected. <!-- openspec: eyes § OBS connection --> <!-- test: services/eyes/test/obs.test.ts:35 -->
- [x] **EYES-OBS-003**: When OBS connects, the eyes service shall log the obs-websocket version and signal heartbeat `ready`. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-004**: When the OBS connection closes for any reason, including a clean close, the eyes service shall reconnect to OBS with the EYES-OBS-002 retry and resume the look loop. <!-- openspec: eyes § OBS connection --> <!-- test: services/eyes/test/obs.test.ts:63 --> <!-- test: services/eyes/test/obs.test.ts:74 -->
- [x] **EYES-OBS-005**: If a look throws, the eyes service shall log `look failed` and, when OBS is no longer identified, reconnect to OBS. Reachable only for a drop during a look; untested. <!-- openspec: eyes § OBS connection -->
- [x] **EYES-OBS-006**: When the eyes service captures a frame, it shall call `GetSourceScreenshot` for `vision.obs.source` as `jpg` at `vision.obs.width` with compression quality 70. <!-- openspec: eyes § Screenshot capture -->
- [x] **EYES-OBS-007**: When OBS returns image data with a `data:image/<type>;base64,` prefix, the eyes service shall strip the prefix before sending it to the vision model. <!-- test: services/eyes/test/eyes.test.ts:39 --> <!-- openspec: eyes § Screenshot capture -->
- [x] **EYES-OBS-008**: Where `vision.enabled` is true, when the process shuts down, the eyes service shall disconnect from OBS and stop the bus. (The disabled plan's shutdown is EYES-ENAB-005.) <!-- test: services/eyes/test/obs.test.ts:82,93 -->

## Vision description

- [x] **EYES-DESC-001**: When describing a frame, the eyes service shall POST to `<OLLAMA_URL>/api/chat` with `vision.model`, `stream: false`, `keep_alive: "24h"`, temperature 0.2, `num_predict` 60 and the base64 image. <!-- test: services/eyes/test/eyes.test.ts:46 --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-002**: When a previous description exists, the eyes service shall include it in the user message as `Previous description: <text>`; otherwise it shall ask only `What is happening now?`. <!-- test: services/eyes/test/eyes.test.ts:46 --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-003**: The eyes service shall use only the first line of the model reply, trimmed. <!-- test: services/eyes/test/eyes.test.ts:46 --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-004**: If the vision model responds with a non-OK status, the eyes service shall throw an error `vision model <status>: <body>`. <!-- test: services/eyes/test/eyes.test.ts:46 --> <!-- openspec: eyes § Vision description -->
- [x] **EYES-DESC-005**: The eyes service shall instruct the model to answer exactly `SAME` when nothing meaningful changed versus the previous description (hard-coded system prompt, `services/eyes/src/eyes.ts:35-37`). Untested.
- [x] **EYES-DESC-006**: If the vision model has not answered a describe call within `vision.timeout_ms`, then the eyes service shall abort the request and treat it as a failed describe (a thrown error, so the look loop logs and continues, injection reports `ok:false`, and `deps.ollama` goes `down`). <!-- test: services/eyes/test/eyes.test.ts:95 -->

## Look loop and publication

- [x] **EYES-LOOK-001**: When a look produces a non-empty description that does not start with the word `SAME`, the eyes service shall publish `vision.summary {text, changed: true}` (eyes publishes only changes, so `changed` is always `true`), remember the text as the next previous description, and report that something new was published. <!-- test: services/eyes/test/eyes.test.ts:19 --> <!-- openspec: eyes § Change-only publication -->
- [x] **EYES-LOOK-002**: When the description is empty or starts with the word `SAME` (any case, e.g. `same.` or `Same as before`, but not `Samurai`), the eyes service shall publish nothing, keep the previous description, and report no change. <!-- test: services/eyes/test/eyes.test.ts:31 --> <!-- openspec: eyes § Change-only publication -->
- [x] **EYES-LOOK-003**: While the loop runs, the eyes service shall wait `vision.interval_ms` minus the time the look took between looks, and never less than 500 ms. Untested. <!-- openspec: eyes § Polling cadence -->
- [x] **EYES-LOOK-004**: While OBS is not identified, the eyes service shall skip looks without error (`services/eyes/src/index.ts:71`); bringing the connection back is EYES-OBS-004's job.
- [x] **EYES-LOOK-005**: If a look throws, the eyes service shall log a warning and continue the loop. Untested.

## Test injection

- [x] **EYES-INJ-001**: The eyes service shall subscribe with consumer group `eyes` to `inject.request`. <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-002**: When an `inject.request` targets a service other than `eyes`, the eyes service shall ignore it and publish nothing. <!-- test: services/eyes/test/inject.test.ts:82 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-003**: If an `inject.request` is more than 60 seconds old when handled, the eyes service shall publish `inject.result {ok:false, detail:"stale"}` without fetching or calling the model. <!-- test: services/eyes/test/inject.test.ts:82 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-004**: If an eyes `inject.request` has a kind other than `image`, the eyes service shall publish `inject.result {ok:false}` naming the unsupported kind. Untested; no test sends a wrong kind to eyes. <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-005**: If the request URL is not on the same origin as `DASHBOARD_URL`, carries credentials, or does not point under `/uploads/<id>`, the eyes service shall fetch nothing and publish `inject.result {ok:false}`. <!-- test: services/eyes/test/inject.test.ts:63,107 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-006**: When fetching an injected upload, the eyes service shall refuse redirects, and if the fetch returns a non-OK status it shall publish `inject.result {ok:false, detail:"fetch upload <status>"}` without calling the model. <!-- test: services/eyes/test/inject.test.ts:74 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-007**: When an uploaded image is fetched, the eyes service shall describe its base64 bytes with an empty previous description, publish `vision.summary {text, changed: true, injected: true, remember}`, then publish `inject.result {ok:true, detail:text}`. <!-- test: services/eyes/test/inject.test.ts:26,36 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-008**: If the injected image's description is empty or starts with `SAME`, the eyes service shall publish `inject.result {ok:false}` and no `vision.summary`. <!-- test: services/eyes/test/inject.test.ts:43 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-009**: If the vision model call fails for an injected image, the eyes service shall publish `inject.result {ok:false, detail}` containing the error and no `vision.summary`. <!-- test: services/eyes/test/inject.test.ts:53 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-010**: The eyes service shall not read or change the look loop's previous description when handling an injected image. <!-- test: services/eyes/test/inject.test.ts:93 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-011**: The eyes service shall handle image injection without an OBS connection, including while `vision.enabled` is false. <!-- test: services/eyes/test/inject.test.ts:93 --> <!-- openspec: eyes § Injected images -->
- [x] **EYES-INJ-012**: If fetching an injected upload has not completed within `vision.upload_timeout_ms`, then the eyes service shall abort the fetch and publish `inject.result {ok:false}` with a detail naming the timeout, without calling the model. <!-- test: services/eyes/test/inject.test.ts:115 --> <!-- test: services/eyes/test/inject.test.ts:129 -->
- [x] **EYES-INJ-013**: If an injected upload's body is larger than `vision.upload_max_bytes`, then the eyes service shall stop reading it and publish `inject.result {ok:false}` with a detail naming the size limit, without calling the model. <!-- test: services/eyes/test/inject.test.ts:143 --> <!-- test: services/eyes/test/inject.test.ts:164 -->
- [x] **EYES-INJ-014**: The eyes service shall subscribe its `inject.request` consumer group `eyes` with start mode `latest`, so the group is reset to the newest entry on every start and no request published while eyes was down is handled. <!-- test: services/eyes/test/obs.test.ts:108 -->

## Health

- [x] **EYES-HEALTH-001**: Where `vision.enabled` is false, the eyes service shall report heartbeat `mode: "off"` with `deps.obs` and `deps.ollama` both `n/a` and state `ready`. <!-- test: services/eyes/test/health.test.ts:7 --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-002**: Where `vision.enabled` is true, the eyes service shall report `mode: "live"` with `deps.obs` `ok` while the OBS websocket is identified and `down` otherwise. <!-- test: services/eyes/test/health.test.ts:15 --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-003**: The eyes service shall set `deps.ollama` to `ok` after each successful describe call and `down` after each failed one, whether the call came from the look loop or an injected image (one tracked describer serves both, so they share one dependency status). <!-- test: services/eyes/test/health.test.ts:15 --> <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-004**: While a dependency is `down` after the service has signalled ready, the eyes heartbeat state shall be `degraded`. <!-- test: services/eyes/test/health.test.ts:15 --> <!-- openspec: eyes § Isolation preset and mode -->
- [x] **EYES-HEALTH-005**: The eyes service shall signal `ready` once OBS has connected when enabled, or immediately at startup when disabled. <!-- openspec: eyes § Heartbeat -->
- [x] **EYES-HEALTH-006**: While `vision.enabled` is true and OBS has not yet been reachable, the eyes service shall report `degraded` with `deps.obs` `down`. <!-- openspec: eyes § Isolation preset and mode --> <!-- test: services/eyes/test/obs.test.ts:46 -->
