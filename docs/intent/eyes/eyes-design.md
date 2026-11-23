---
parent: high-level-design
prefix: EYES
---

# eyes

Segment `eyes` (`services/eyes`, package `@cohost/eyes`). Describes the implemented behaviour.

## Context and Design Philosophy

`eyes` is the visual sense. It polls a source in OBS through obs-websocket, asks a vision model for one sentence about what changed, through a chat provider of `@cohost/llm` that takes images (Ollama by default; the provider is an explicit setting, [The describer's provider](#the-describers-provider)), and publishes `vision.summary` (see [HLD](../../high-level-design.md)). The header comment states the stance (the header of `service.ts`): summaries, not frames, go on the bus because they are cheap and what the brain wants. It runs under the compose profile `eyes` (`docker-compose.yml`), unlike `chat` which is in the default set.

Design stance (evidence per bullet):

- Change detection is delegated to the model. The prompt (`vision.prompt`) tells it to reply exactly `SAME` when nothing meaningful changed; the service parses only a clear `SAME` (`isSame`, `eyes.ts`). There is no pixel or embedding diff. "Meaningful" is a judgement about the game, not about pixels, and the model is already looking at the frame to describe it.
- Disabled by default and fully inert when disabled: no OBS connection, no model calls from the loop (`startEyes`, `eyes.ts`; `service.ts`). The service still starts, heartbeats `off`, and still handles image injection. Evidence: commit 463b1bb (fixes #11, eyes connected to OBS while disabled); commit 51d5a9c.
- Logic is separated from I/O by dependency injection: `Eyes` takes `screenshot`, `describe` and a monotonic clock, `startEyes` takes `connect` and `loop`, the inject handler takes `bus` (for `takeUpload`), `describe`, `now`, and `eyesService(deps)` (`service.ts`) takes the OBS client, so a test runs the whole service through `runService` with a fake OBS and no Redis. `index.ts` only builds the real OBS client and calls `runService`.
- One shared `describe` function serves both the polling loop and injected images, and it is wrapped by health tracking (`service.ts`). Evidence: the `describe` doc comment in `inject.ts` ("Same describer `Eyes.look()` uses").

## Startup and Gating

`eyesService(deps).main` (`service.ts`, run by `runService`) builds `EyesHealth` (in `health`, before the heartbeat starts), the OBS link (`createObsLink`, `obs.ts`), the describer and `Eyes`, establishes the `inject.request` subscription (`subscribeInject`, `inject.ts`), then either starts the look loop (vision enabled) or starts the shared idle plan (disabled). The subscription is established before either `ready` signal (OBS connect, or the idle plan), so `ready` never precedes it.

`startEyes({enabled, connect, loop})` (`eyes.ts`):

- `enabled` false: return `false` without calling `connect` or `loop` and without logging; the caller reports the disabled case.
- `enabled` true: `await connect(); await loop();` return `true`. `loop` never returns, so in practice the promise never resolves when enabled.

Disabled, `main` runs `startIdle({kind: "off"})` (SHARED-IDLE-001; EYES-ENAB-002): one warning naming `vision.enabled`, heartbeat mode `off` and `ready`, never a repeated warning. Shutdown is one sequence in both plans (`stopEyes`, `obs.ts`, an `onStop` step; EYES-ENAB-005, EYES-OBS-008; see Shutdown below). A throw out of `main` (including a failure to create the subscription group) is logged `fatal` and exits 1 (`runService`); a rejected start of the loop is logged `fatal` and exits 1 too. The connect loop swallows its own errors, so those paths are reached only by setup failures.

Config read: `vision.enabled` (default false; the isolation override `VISION_ENABLED` can replace it), `vision.model` (a blank value while `vision.enabled` is a configuration gap, not a load failure; CFG-SCH-025), `vision.provider` (`ollama`, `openai`, `anthropic`, `bedrock` or `stub`, default `ollama`; EYES-STUB-*), the credentials and endpoint of a provider from `llm.openai.*`, `llm.claude.*` and `llm.bedrock.*`, `vision.interval_ms` (default 8000), `vision.timeout_ms`, `vision.prompt`, `vision.temperature` (0.2), `vision.num_predict` (60) and `vision.jpeg_quality` (70) (EYES-DESC-007), `vision.obs.{host,port,password,source,width}` (defaults `host.docker.internal`, 4455, empty, `Game Capture`, 896) (`packages/config/src/schema.ts`); env `OLLAMA_URL` (default `http://127.0.0.1:11434`) via `urls.*`, read by the `ollama` provider only.

## OBS Connection and Look Loop

`createObsLink` (`obs.ts`) owns the OBS connection: `connect()` runs `retryWithBackoff` until `obs.connect("ws://host:port", password || undefined)` succeeds, logging the version and calling `heartbeat.ready()`; each failure warns, calls `heartbeat.degraded("OBS not reachable")` (EYES-HEALTH-006) and waits 10 s, doubling per consecutive failure to a cap of 60 s (EYES-OBS-002; OBS is often started after the stack, and a long wait costs only a slower first look). Concurrent `connect()` calls share one loop, and `stop()` ends it.

`screenshot()` (`service.ts`) calls `GetSourceScreenshot` with `sourceName`, `imageFormat: "jpg"`, `imageWidth: width`, `imageCompressionQuality: vision.jpeg_quality` and runs the result through `stripDataUrl` (`eyes.ts`), which removes a `data:image/<word>;base64,` prefix.

`loop()` (`service.ts`), until the shutdown step sets `stopped`, per iteration:

1. If `obs.identified` and `vision.model` is not blank (or the provider is `stub`), `await eyes.look()`. A blank model is a gap the loop does not work through: it makes no describe call at all (EYES-GAP-001).
2. A thrown error is warned as `look failed`; if `!obs.identified` it awaits `link.connect()`.
3. Sleep `nextDelay(interval_ms, elapsed)` = `max(500, interval_ms - elapsed)`, with `elapsed` on a monotonic clock (`performance.now`, injectable for tests).

Any OBS close, clean or not, re-enters the link's `connect()` and the loop resumes looking (EYES-OBS-004): the link listens for `ConnectionClosed` and starts a connect loop unless one is already running (a failed connect attempt emits `ConnectionClosed` too, and the running loop already owns that case) or the link was stopped (shutdown closes the socket, which must not reconnect). obs-websocket-js 5.0.8 has no reconnect of its own: its close handler emits `ConnectionClosed` and then clears `identified` (`obs-websocket-js/dist/chunk-MVPOL3ZW.js`). The loop also calls `link.connect()` from its `catch` when a look throws while OBS is not identified (EYES-OBS-005); the shared loop makes that call harmless beside the close handler.

### `Eyes.look()` (`eyes.ts`)

`screenshot()` then `describe(b64, previous)`. `capturedAt` is stamped (epoch milliseconds) when the screenshot call returns and `describedAt` when the describe call returns (EYES-LOOK-006). Every look logs its describe duration, including looks that end as `SAME` or empty (EYES-LOOK-007), so the vision model's cost is visible even when nothing is published. If `isSame(text)` (empty, or `SAME` in any case followed only by punctuation or whitespace), log debug and return `false`, leaving `previous` untouched. A reply that merely starts with the word (`Same old menu screen`) is a description: otherwise set `previous = text`, publish `vision.summary {text, changed: true, timing: {capturedAt, describedAt}}`, log info, return `true`. Durations in the log are measured on the monotonic clock. `changed` is always `true` on the wire because eyes publishes only changes; the field stays in the schema (`packages/bus/src/events.ts`) as the contract for other vision sources. There are no overlap guards; the loop is sequential, so a hung describe call stalls it until the describe timeout fires (EYES-DESC-006).

### `modelDescriber(cfg.vision, cfg.llm)` and `stubDescriber()` (`eyes.ts`)

`createDescriber(cfg)` picks by `vision.provider`: `stub` is `stubDescriber`; every other value uses the provider `buildVisionProvider(cfg)` builds, once per start (`health(cfg)` makes it and `main` shares it), which calls `createChatProvider({...llm, provider: vision.provider, model: vision.model})`. A gap (below) makes the describer fail every call at once with the reason, without building a request; otherwise it is `modelDescriber`, which asks that provider. The vision model is independent of the cortex's `llm.provider`, and the factory takes no new parameter ([model-backends](../model-backends/model-backends-design.md) Capabilities). The request is non-streamed and carries a system message (`vision.prompt`) and a user message with either `Previous description: <previous>\nWhat is happening now?` or `What is happening now?` and `images: [b64]` (`ChatMessage.images`, LLM-VIS-001), with `temperature: vision.temperature` and `maxTokens: vision.num_predict`; how a provider carries the image, the token cap and the temperature is the provider's (model-backends, How each provider maps streaming, tool calls and images). The reply is trimmed, first line only. The describer owns a ref'd timer of `vision.timeout_ms` (default 30000) that aborts the request through its signal and races the provider's promise, so a provider that ignores the signal still cannot hold the call past the timer; a call unanswered after that long throws `vision model did not answer within <ms> ms` (EYES-DESC-006), which the look loop logs and the injection path reports as `ok:false`, and which marks `vision` down like any failed call. Errors carry the provider's own text (`ollama chat <status>: <body>`, `openai chat <status>: <body>`); a provider without its credentials fails with a `not_configured` error, the same path. A `TypeError` from the model layer (image data in no supported format, LLM-VIS-005) rejects before any request. The `ollama` provider keeps the model resident (`keep_alive` 24h). `stubDescriber` is the stub section below.

### The describer's provider

`vision.provider` chooses which chat provider describes frames. The values are the providers of `llm.provider` that take images, `ollama`, `openai` (any OpenAI-compatible server), `anthropic` and `bedrock`, plus `stub`; blank is `ollama`. `mock` is not offered: the stub is the describer's isolated mode and keeps the deterministic text the look loop and tests rely on.

- **No hosted default.** The default is `ollama`, the local runtime in Compose, and nothing in the schema, the example config or an isolated start selects a hosted provider (HLD tenet 8). A frame leaves the LAN only because the owner set `vision.provider` to `anthropic` or `bedrock`, which are always hosted, or to `openai` with `llm.openai.base_url` at a host outside the LAN. `llm.openai.base_url` defaults to `https://api.openai.com/v1`, a hosted address: choosing `openai` as the vision provider while that default stands is the explicit hosted choice, and the egress list flags it. The Ollama runtime itself is wherever `OLLAMA_URL` says, which Compose pins to its own container.
- **Credentials.** A hosted provider uses the credentials already stored for the chat model (`llm.claude.api_key`, `llm.openai.api_key`, `llm.bedrock.*` in `secrets.yaml`); eyes adds no credential. The same keys may serve both the cortex and the describer, with a different model each (`vision.model`).
- **Marked and gated.** `vision.provider` is a `sensitive` key: it decides where frames, which are private, go, so a save that changes it needs the control token in both control modes ([config](../config/config-design.md) Presentation table). A page that could flip it could send the screen to a provider whose credential is already stored.
- **Shown.** eyes logs one warning at start when frames go to a destination outside the LAN, names the provider and its host in its heartbeat detail, and the dashboard's Services screen marks the row ([dashboard](../dashboard/dashboard-design.md) Egress note). The describer is built whether or not `vision.enabled` is true, and an injected image is described through `vision.provider` in either case, so the egress list names the frames destination whenever a provider other than `stub` is selected, enabled or not. Injected images take the same path and the same marker.
- **A provider that cannot describe.** A model that takes no images fails the call as an ordinary error: eyes stays up, and the loop tries again at its next interval (HLD tenet 5). A 400 or 422 for that frame is a frame fault and leaves `vision` alone; any other failure marks `vision` down (EYES-PROV-006, EYES-PROV-007). The package cannot detect a model that accepts images and ignores them.
- **A configuration gap.** A blank `vision.model` for any provider but `stub`, a hosted provider whose credentials are absent (`llm.claude.api_key`, or `llm.bedrock.*`: region, access key id and secret, all three; the reason text is `notConfiguredReason` from `@cohost/llm`, the model layer's own `not configured` message), or exactly one of `llm.bedrock.access_key_id` and `llm.bedrock.secret_access_key` set (the model layer refuses to construct it, LLM-CLAUDE-016; a missing region is a credential gap, not a construction error), is a gap, not an invalid value: eyes starts; `vision` is `down` with the reason in the heartbeat detail while `vision.enabled` is true (`vision.model is not set`, `not configured: llm.claude.api_key is not set`, `must be set together: only one of them is set`); a blank model makes the look loop skip describe entirely (EYES-GAP-001), while a credential gap lets each look fail at once (EYES-GAP-003, EYES-GAP-006); and test injection still answers `ok:false` with that reason. Only a value that is present and invalid fails the config load.
- **Outage and bad request.** The same classes as the speech engines: a refused or dropped connection, a timeout, a 5xx, a 401, 403, 404 or 429, any other failed status except 400 and 422, and a failure that carries no HTTP status (a dropped socket's `TypeError: terminated` included) mark `vision` down. A frame fault, a 400 or 422 for one frame or an `ImageDataError` (a `TypeError` subclass) from the model layer for image data in no supported format (a BMP or a PDF, for example), drops that frame with a warning, fails that look or injection, and leaves `vision` alone (`isFrameFault`, `health.ts`). While `vision.enabled` is false the dependency is `n/a` whatever an injected image does.

## Test Injection (`inject.ts`)

`createInjectHandler({bus, log, describe, now?, uploadTimeoutMs?, uploadMaxBytes?})`, subscribed with group `eyes` and start mode `latest` through `subscribeInject` (EYES-INJ-014): the group is created first (`Bus.resetGroup`) and then reset to the newest entry on every start, so requests published while eyes was down are never handled. It is wired even when vision is disabled. Flow (`inject.ts`):

1. `target !== "eyes"` returns silently.
2. Stale (`now() - ev.ts > 60_000`) gives `inject.result {ok:false, detail:"stale"}`.
3. `kind !== "image"` gives `ok:false` with `eyes cannot handle kind '<kind>'`.
4. The request must carry an `uploadId` (32 hex digits); otherwise `ok:false` `request carries no upload id`; nothing is read.
5. The shared handler reads the bytes with `Bus.takeUpload(uploadId)` (`GETDEL` of `cohost:upload:<id>`, so the key is gone after use), bounded by `vision.upload_timeout_ms` (default 10000 ms): a read that has not completed in time gives `ok:false` `read upload timed out after <ms> ms` (SHARED-INJ-006); a missing or expired key gives `ok:false` `upload expired or missing` (SHARED-INJ-013); bytes over `vision.upload_max_bytes` (default 8 MiB, the dashboard's image upload cap) give `ok:false` `upload larger than the <n> byte limit` (SHARED-INJ-007). In each case the model is not called.
6. Bytes to base64, `describe(b64, "")` (empty previous so the model never needs `SAME`, and `Eyes.look()`'s `previous` is untouched); empty or a clear `SAME` (`isSame`) gives `ok:false` `no description`.
7. Publishes `vision.summary {text, changed:true, injected:true, remember}` then `inject.result {ok:true, detail:text}`.
8. A describe failure becomes `ok:false` with the error's message (the provider's text, without the `Error:` prefix that `String(err)` adds); any other throw becomes `ok:false` with `String(err)`. A failure to publish that is swallowed.

`INJECT_STALE_MS` and the upload read live in `@cohost/shared` (`packages/shared/src/inject.ts`) and are applied by the shared inject handler that eyes, ears and chat use (SHARED-INJ-008). This LLD owns them as inject plumbing: the shared package is a home for small helpers that more than one service needs, not an arrow segment, so a change to either is a change to this section and SHARED-INJ-004 to SHARED-INJ-013, cascading to the ears and chat LLDs, which only cite them. The upload write belongs to `dashboard`; the `inject.*` schemas and the `putUpload`/`takeUpload` Redis calls to `event-bus`.

## Health (`health.ts`)

`EyesHealth(enabled, obsConnected, provider)` exposes `spec` and `track(describe)` (`health.ts`).

- Mode: `live` when enabled, `mock` when enabled with the stub provider, else `off` (getter).
- Deps: enabled gives `{obs: ok|down from obsConnected(), vision: ok|down}` (`vision: "n/a"` under the stub provider); disabled gives `{obs:"n/a", vision:"n/a"}`. The dependency is named for the role, so it reads the same whichever provider describes.
- `vision` starts `ok`, or `down` under a configuration gap, and flips on each describe outcome through `EyesHealth.track`: a success sets `ok`, an outage-class failure sets `down`, and a frame fault (`isFrameFault`) leaves it as it was. Because the injection handler receives the same tracked function, a failing injected-image describe also flips the `vision` dep, and vice versa.
- Detail: the standing heartbeat detail names the destination (`describerLabel`: `openai at api.openai.com`, `ollama at 127.0.0.1`, or the provider alone for `anthropic` and `bedrock`; none for the stub). `ready()` clears a detail, so under a gap the service sets `degraded("<destination>: <reason>")` at start and again after each OBS `ready()` (through a wrapper of the heartbeat given to the OBS link), so the reason survives the connect (EYES-GAP-002, EYES-GAP-003).
- Egress: one `eyes sends frames to <engine>[ at <host>], which is off the LAN` warning at start for each frames destination off the LAN by `egressDestinations`, enabled or not (EYES-EGR-001 to EYES-EGR-003).
- `obsConnected` is `() => obs.identified` (`service.ts`), so a permanently closed OBS shows `obs: down`, which the shared heartbeat turns into `degraded` once `ready` (SHARED-LIFE-008).
- Heartbeat `ready()` is called on OBS connect when enabled (`createObsLink`), or by the idle plan when disabled. While OBS is unreachable at boot each failed attempt calls `heartbeat.degraded("OBS not reachable")`, so the heartbeat reports `degraded` with `obs: down` (EYES-HEALTH-006) instead of staying `starting`.

## Shutdown

`main` registers one `onStop` step, `stopEyes` (`obs.ts`), in both plans (EYES-ENAB-005, EYES-OBS-008), after setting the loop's `stopped` flag: stop the idle plan if there is one (vision disabled), then stop the OBS link (stop reconnecting, close the socket; harmless when never connected). `runService` then stops the bus. The `stopping` heartbeat is sent by the heartbeat's own pre-shutdown hook before any step runs (SHARED-LIFE-010, SHARED-BOOT-005).

## Stub describer and shared injection

Where `vision.provider` is `stub` (CFG-SCH-021; the isolation preset sets it; owned by this segment), the describer makes no network request, whatever provider was configured: an injected image is described as `stub vision: <n> bytes`, and the look loop gets that text once and `SAME` after, so an isolated eyes with OBS reports a single change. The heartbeat reports mode `mock` (or `off` when vision is disabled) and `deps.vision` `n/a` (EYES-STUB-*). Injection runs through the shared inject handler (shared-runtime SHARED-INJ-*) with eyes' kind and limits (EYES-INJ-016).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Change detection | Ask the model to answer `SAME` (`vision.prompt`; `isSame`, `eyes.ts`) | Pixel/perceptual diff; embedding distance | A game frame changes in pixels almost every interval (animation, HUD, camera), so a pixel or perceptual diff fires on noise, and an embedding distance needs a second model and a tuned threshold. The vision model already sees the frame and the previous description, so it can judge "meaningful" in the same call, and the service stays a few lines of parsing. The cost is one model call every interval even when nothing changed. |
| Bus payload | One-line text summary, not frames | Publish images | Header comment of `service.ts`: "Summaries, not frames, go on the bus: cheap and what the brain actually wants." |
| Idle when disabled | `startEyes` gate; service stays up with mode `off` (`startEyes`, `eyes.ts`; the idle plan, `service.ts`) | Exit; connect to OBS anyway | A disabled service must not touch OBS (commit 463b1bb, fixes #11) and must stay up rather than look like a crash (commit 51d5a9c). |
| OBS retry | `retryWithBackoff`: 10 s doubling to a 60 s cap in `createObsLink` (EYES-OBS-002) | A fixed 10 s retry; give up after N attempts | Owner disposition 2026-11-11: shared backoff. OBS is often started after the stack or restarted mid-session, so eyes must keep trying and recover on its own; giving up would leave a disabled sense that only a restart fixes, against the degrade-and-report posture (heartbeat `degraded`, `obs: down`, EYES-HEALTH-006). The cap keeps the gap before eyes sees again once OBS is back to a minute at most. |
| Reconnect trigger | Reconnect on any `ConnectionClosed`, clean or not (EYES-OBS-004) | Reconnect only after a failed look | Owner decision 2026-11-01: OBS restarts and clean closes must not leave eyes polling forever with `obs: down`; obs-websocket-js 5.0.8 has no reconnect of its own. |
| Boot health while OBS is unreachable | `degraded` with `obs: down` (EYES-HEALTH-006) | Stay `starting` until the first connect | Owner decision 2026-11-01 (project-wide): heartbeat deps reflect runtime state; a sense waiting on its backend is visibly degraded. |
| Shared describer health | One tracked describer for the loop and injection; an injected failure marks `vision` down (EYES-HEALTH-003) | Separate tracking for injection | Owner decision 2026-11-01: both paths use the same backend, so one dependency status is accurate. |
| `changed` field | Always `true`; eyes publishes only changes (EYES-LOOK-001) | Publish every look with `changed: false`; drop the field | Owner decision 2026-11-01: keep the field and state the always-true contract. |
| Shutdown | One shutdown sequence in both plans (EYES-ENAB-005, EYES-OBS-008) | One `onShutdown` per plan branch | Owner decision 2026-11-01 (project-wide): the bus runs every registered callback and exits once, so a second registration must not cut the first short. |
| Outbound timeouts and upload cap | Configured timeout on the describe call and the upload read; configured maximum upload size (EYES-DESC-006, SHARED-INJ-006, SHARED-INJ-007) | No limits | Owner decision 2026-11-01: a hung model or upload read must not stall the serial loop or the injection path. |
| Injection start mode | `latest`: the `eyes` group is reset to the newest entry on every start (EYES-INJ-014) | `resume` | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; delivery across restarts is at-most-once. |
| Prompt and model options | `vision.prompt`, `vision.temperature`, `vision.num_predict` and `vision.jpeg_quality` are config keys with today's values as defaults (EYES-DESC-007); `keep_alive` stays the provider's `24h` | Hard-coded in source; a `vision.keep_alive` key | Owner disposition 2026-11-11: editable in the settings editor. The prompt carries the `SAME` contract the parser relies on, so the key's comment says to keep it; a prompt that drops it makes every reply a change, which is visible, not silent. The provider owns `keep_alive` so a look never pays a cold load, and one shared value for every Ollama caller is simpler than a per-segment key. |
| Describer transport | The chat provider `vision.provider` names, built by `createChatProvider({...llm, provider: vision.provider, model: vision.model})`, with an optional `images` list on `ChatMessage` (LLM-VIS-001) | A raw `fetch` of eyes' own; a second, vision-only provider interface; the describer fixed to Ollama | One client per provider for the project, so timeouts, `keep_alive`, error shapes and mock-ability live in one place, and every provider that takes images describes frames with no eyes code of its own. The error text is the provider's. |
| Describer provider setting | `vision.provider` (`ollama` default, `openai`, `anthropic`, `bedrock`, `stub`), a `sensitive` key; hosted providers use the `llm.*` credentials | Keep `vision.engine` (`ollama` or `stub`) and add the provider beside it; a separate vision credential set; allow `mock` | One key says what describes the frame, and the stub is one of its values as the isolation preset needs. Reusing the `llm.*` credentials adds no credential and no new secret path. A hosted provider is chosen by an explicit setting with a local default, and the key is gated because flipping it sends frames to wherever a stored credential already points (HLD tenet 8, model-backends Frame egress). |
| Health dependency name | `deps.vision` | `deps.ollama`; a dependency per provider | The describer's backend is a role, not a vendor, and the Services screen should read the same for every provider. |
| `SAME` rule | A clear match only: empty, or `SAME` in any case followed by punctuation or whitespace (EYES-LOOK-002) | A prefix word match, `/^same\b/i` | A model that writes `Same old menu, but the cursor moved` has described something; a prefix rule dropped it. The conservative reading of the owner's "exact/clear match" instruction (2026-11-11) is the stricter one; a model that adds words to a true `SAME` costs one extra published line, which the next `SAME` stops. |
| Clock for durations | Monotonic (`performance.now`) for look durations and the wait between looks | Wall clock (`Date.now`) | A wall-clock step (NTP, WSL2 resume) would make a look appear to take hours or negative time, and `max(500, interval - elapsed)` would then skip or stall the wait. |
| Latency stamps | Epoch-millisecond `capturedAt` and `describedAt` on `vision.summary` (EYES-LOOK-006); durations in logs stay on the monotonic clock | Monotonic stamps; stamp only on publish | Stamps are joined across services by `cohostctl latency`, which needs a clock every service shares (HLD, Vision-path latency); a monotonic reading is private to one process. Looks that end as `SAME` publish nothing and so carry no stamp, which is why their describe time is logged (EYES-LOOK-007). Injected images are not frames from the source and carry no stamps (EYES-INJ-017). |
| Idle when disabled, reporting | The shared idle plan, kind `off` (SHARED-IDLE-001): one warning, no reminder | A warning on a repeating timer | Owner disposition 2026-11-11: a configured-off service is not an error; one warning at startup says why, and the heartbeat (mode `off`) says it afterwards. |
| Stub describer | `vision.provider: stub` selects fixed text, mode `mock` (EYES-STUB-*) | A mock provider behind `@cohost/llm` | Isolated runs must not need a vision model; the stub also keeps the OBS path exercisable. The text is deterministic (`stub vision: <n> bytes`, then `SAME`), so a test can assert it. |
| Injection reuses `describe` | Same tracked describer, empty previous (`service.ts`, `inject.ts`) | Separate describer; pass `Eyes.previous` | Keeps change tracking untouched and exercises the real model path: doc comment in `inject.ts`. |
| Upload transport | The upload is read from Redis by id (`Bus.takeUpload`); the event carries no URL | Fetch a URL from the dashboard's listener and document the firewall rule; base64 in the event | No URL means no fetch to guard: the bus cannot make eyes request an arbitrary address, and nothing on the host has to be reachable from the container (dashboard decision on upload transport). |
| Shared inject helpers | `INJECT_STALE_MS` and the upload read in the `@cohost/shared` workspace package, used through the shared inject handler by eyes, ears and chat (SHARED-INJ-008) | A copy in each service; a helper exported from eyes and imported by ears | Owner decision of 2026-11-08: code shared across modules or services belongs in shared packages. One definition means the staleness window and the upload read cannot drift between services. A service importing a sibling service's source would couple deployables; a package keeps the dependency direction service to package. |

## Open Questions & Future Decisions

- **A hosted provider's treatment of the describe options.** The Claude and Bedrock providers send no `temperature` and take their own token budget (model-backends), so `vision.temperature` has no effect on them and a `vision.num_predict` of 60 may leave a thinking model no room for text. Whether `vision.num_predict` needs a floor for those providers is for model-backends to confirm.
- **Cost of a hosted describer.** One frame every `vision.interval_ms` is a billed request each time, including looks that end as `SAME`; the default interval was chosen for a local model.

## References

### Files in this segment
- `services/eyes/src/index.ts`, `service.ts`, `eyes.ts`, `health.ts`, `inject.ts`, `obs.ts`
- `services/eyes/test/eyes.test.ts`, `health.test.ts`, `inject.test.ts`, `obs.test.ts`, `service.test.ts`
- `services/eyes/package.json`, `services/eyes/tsconfig.json`
- `packages/shared/src/inject.ts`, `packages/shared/test/inject-handler.test.ts` (shared inject helpers)

### Other segments
- `event-bus` (depends on): `Bus`, `vision.summary`, `inject.request`/`inject.result`.
- `config` (depends on): `vision.*` (CFG-SCH-021), `llm.openai.*`, `llm.claude.*`, `llm.bedrock.*` for a hosted provider, `urls.ollama()`.
- `shared-runtime` (depends on): `runService`, `startIdle`, `retryWithBackoff`, the inject handler, `tracked`, `HeartbeatSpec`.
- `model-backends` (depends on): the `ChatProvider` of `@cohost/llm` that `vision.provider` names, with `ChatMessage.images` (LLM-VIS-001).
- `dashboard` (called by): stores the upload in Redis, publishes `inject.request`, shows `inject.result`.
- `ears` and `chat` (siblings): use the shared inject handler from `@cohost/shared`.
- `@cohost/shared` (depends on, workspace package): `createInjectHandler`, `subscribeInject`, `INJECT_STALE_MS`; see Test Injection.
- `salience`, `affect` (consumed by): subscribe to `vision.summary` (`services/salience/src/main.ts`, `services/affect/src/main.ts`).
- `deployment`: compose service `eyes`, profile `eyes` (`docker-compose.yml`).

### External
- `obs-websocket-js` (`^5.0.6`), OBS 28+ obs-websocket v5 (`GetSourceScreenshot`).
- Ollama `/api/chat` with a vision model (`vision.model`, e.g. `qwen2.5vl:3b` in `config.example.yaml`), or the chat endpoint of the provider `vision.provider` names.

### Docs
- [HLD](../../high-level-design.md), [specs](eyes-specs.md), [arrow](../../arrows/eyes.md)
