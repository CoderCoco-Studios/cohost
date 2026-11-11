---
parent: high-level-design
prefix: EYES
---

# eyes

Segment `eyes` (`services/eyes`, package `@cohost/eyes`). Mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at `1b57790` with the owner's decisions of 2026-11-01 applied. Describes the implemented behaviour.

## Context and Design Philosophy

`eyes` is the visual sense. It polls a source in OBS through obs-websocket, asks an Ollama vision model for one sentence about what changed, and publishes `vision.summary` (see [HLD](../../high-level-design.md)). The header comment states the stance (`index.ts:2-9`): summaries, not frames, go on the bus because they are cheap and what the brain wants. It runs under the compose profile `eyes` (`docker-compose.yml:145-148`), unlike `chat` which is in the default set.

Design stance (evidence per bullet):

- Change detection is delegated to the model. The prompt tells it to reply exactly `SAME` when nothing meaningful changed (`eyes.ts:51`); the service only parses that word (`eyes.ts:78`). There is no pixel or embedding diff. "Meaningful" is a judgement about the game, not about pixels, and the model is already looking at the frame to describe it.
- Disabled by default and fully inert when disabled: no OBS connection, no model calls from the loop (`startEyes`, `eyes.ts:86-94`). The service still starts, heartbeats `off`, and still handles image injection. Evidence: commit 463b1bb (fixes #11, eyes connected to OBS while disabled); commit 51d5a9c; add-isolated-backends design D7.
- Logic is separated from I/O by dependency injection: `Eyes` takes `screenshot` and `describe` functions (`eyes.ts:4-11`), `startEyes` takes `connect` and `loop`, the inject handler takes `fetch`, `describe`, `now`. `index.ts` is the untested composition root. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": eyes gained `Eyes.look` / `ollamaDescriber`).
- One shared `describe` function serves both the polling loop and injected images, and it is wrapped by health tracking (`index.ts:56`, `:63`). Evidence: add-test-injection design D8 ("call the same `describe(b64, \"\")`") and the `describe` doc comment in `inject.ts` ("Same describer `Eyes.look()` uses").

## Startup and Gating

`index.ts` constructs `OBSWebSocket`, `EyesHealth`, the heartbeat, the OBS link (`createObsLink`, `obs.ts`), the describer and `Eyes` unconditionally, establishes the `inject.request` subscription (`subscribeInject`, `inject.ts`), then calls `startEyes`. The subscription is established before either `ready` signal (OBS connect, or the idle branch), so `ready` never precedes it.

`startEyes({enabled, log, connect, loop})` (`eyes.ts:86-94`):

- `enabled` false: warn `vision.enabled is false in config.yaml - eyes idle...`, return `false` without calling `connect` or `loop`.
- `enabled` true: `await connect(); await loop();` return `true`. `loop` never returns, so in practice the promise never resolves when enabled.

On `false`, `index.ts` signals `heartbeat.ready()` (mode `off`) and logs an idle warning every 60 s. Shutdown is one sequence in both plans (`stopEyes`, `obs.ts`; EYES-ENAB-005, EYES-OBS-008; see Shutdown below). A rejected startup (including a failure to create the subscription group) is `log.error("fatal")` then `process.exit(1)`; the connect loop swallows its own errors, so that path is reached only by those setup failures.

Config read: `vision.enabled` (default false; env `VISION_ENABLED`), `vision.model` (`VISION_MODEL`), `vision.interval_ms` (default 8000), `vision.obs.{host,port,password,source,width}` (defaults `host.docker.internal`, 4455, empty, `Game Capture`, 896) (`packages/config/src/schema.ts:74-85`); env `OLLAMA_URL` (default `http://127.0.0.1:11434`) and `DASHBOARD_URL` (default `http://127.0.0.1:3000`) via `urls.*` (`packages/config/src/index.ts:169`, `:175`).

## OBS Connection and Look Loop

`createObsLink` (`obs.ts`) owns the OBS connection: `connect()` loops until `obs.connect("ws://host:port", password || undefined)` succeeds, logging the version and calling `heartbeat.ready()`; each failure warns, calls `heartbeat.degraded("OBS not reachable")` (EYES-HEALTH-006) and sleeps 10 s. There is no backoff or cap (OBS is often started after the stack). Concurrent `connect()` calls share one loop, and `stop()` ends it.

`screenshot()` (`index.ts:44-53`) calls `GetSourceScreenshot` with `sourceName`, `imageFormat: "jpg"`, `imageWidth: width`, `imageCompressionQuality: 70` and runs the result through `stripDataUrl` (`eyes.ts:15-17`), which removes a `data:image/<word>;base64,` prefix.

`loop()` (`index.ts:67-78`), per iteration:

1. If `cfg.vision.enabled && obs.identified`, `await eyes.look()`.
2. A thrown error is warned as `look failed`; if `!obs.identified` it awaits `connectObs()`.
3. Sleep `max(500, interval_ms - elapsed)`.

Any OBS close, clean or not, re-enters the link's `connect()` and the loop resumes looking (EYES-OBS-004): the link listens for `ConnectionClosed` and starts a connect loop unless one is already running (a failed connect attempt emits `ConnectionClosed` too, and the running loop already owns that case) or the link was stopped (shutdown closes the socket, which must not reconnect). obs-websocket-js 5.0.8 has no reconnect of its own: its close handler emits `ConnectionClosed` and then clears `identified` (`obs-websocket-js/dist/chunk-MVPOL3ZW.js:341-346`, `:186`). The loop also calls `link.connect()` from its `catch` when a look throws while OBS is no longer identified (EYES-OBS-005); the shared loop makes that call harmless beside the close handler.

### `Eyes.look()` (`eyes.ts:54-75`)

`screenshot()` then `describe(b64, previous)`. If the text is empty or matches `/^same\b/i`, log debug and return `false`, leaving `previous` untouched. Otherwise set `previous = text`, publish `vision.summary {text, changed: true}`, log info, return `true`. `changed` is always `true` on the wire because eyes publishes only changes; the field stays in the schema (`packages/bus/src/events.ts:32`) as the contract for other vision sources. There are no overlap guards; the loop is sequential, so a hung describe call stalls it until the describe timeout fires (EYES-DESC-006; no timeout exists yet).

### `ollamaDescriber(cfg.vision)` (`eyes.ts:21-51`)

`POST ${urls.ollama()}/api/chat` JSON: `model: cfg.model`, `stream: false`, `keep_alive: "24h"`, `options {temperature: 0.2, num_predict: 60}`, a hard-coded system prompt, and a user message carrying either `Previous description: <previous>\nWhat is happening now?` or `What is happening now?` plus `images: [b64]`. Non-OK responses throw `vision model <status>: <body>`. The reply is `message.content`, trimmed, first line only. All parameters except `model` are hard-coded. The call carries `AbortSignal.timeout(vision.timeout_ms)` (default 30000); a call unanswered after that long throws `vision model did not answer within <ms> ms` (EYES-DESC-006), which the look loop logs and the injection path reports as `ok:false`, and which marks `ollama` down like any failed call.

## Test Injection (`inject.ts`)

`createInjectHandler({bus, log, dashboardUrl, describe, fetch?, now?, uploadTimeoutMs?, uploadMaxBytes?})`, subscribed with group `eyes` and start mode `latest` through `subscribeInject` (EYES-INJ-014): the group is created first (`Bus.resetGroup`) and then reset to the newest entry on every start, so requests published while eyes was down are never handled. It is wired even when vision is disabled. Flow (`inject.ts`):

1. `target !== "eyes"` returns silently.
2. Stale (`now() - ev.ts > 60_000`) gives `inject.result {ok:false, detail:"stale"}`.
3. `kind !== "image"` gives `ok:false` with `eyes cannot handle kind '<kind>'`.
4. `uploadUrl(r.url, dashboardUrl)` (from `@cohost/shared`, `packages/shared/src/inject.ts`) must accept: same origin as `urls.dashboard()`, no userinfo, normalised pathname starting with `<dashboard path>/uploads/` and longer than that prefix. Result is `u.href` (query strings pass). Otherwise `ok:false` `url is not an upload of this dashboard`; nothing is fetched.
5. `fetch(target, {redirect: "error", signal: AbortSignal.timeout(vision.upload_timeout_ms)})` (default 10000 ms); non-OK gives `ok:false` `fetch upload <status>`. The signal covers the headers and the body read: a fetch that has not completed in time gives `ok:false` `fetch upload timed out after <ms> ms` (SHARED-INJ-006). The body is read in chunks and abandoned as soon as it passes `vision.upload_max_bytes` (default 8 MiB, the dashboard's image upload cap; a declared `content-length` over the limit is refused without reading), giving `ok:false` `upload larger than the <n> byte limit` (SHARED-INJ-007). In both cases the model is not called.
6. Bytes to base64, `describe(b64, "")` (empty previous so the model never needs `SAME`, and `Eyes.look()`'s `previous` is untouched); empty or `SAME` gives `ok:false` `no description`.
7. Publishes `vision.summary {text, changed:true, injected:true, remember}` then `inject.result {ok:true, detail:text}`.
8. Any throw becomes `ok:false` with `String(err)`; a failure to publish that is swallowed.

`uploadUrl` and `INJECT_STALE_MS` live in `@cohost/shared` (`packages/shared/src/inject.ts`) and are imported by eyes, ears and chat (SHARED-INJ-008). This LLD owns them as inject plumbing: the shared package is a home for small helpers that more than one service needs, not an arrow segment, so a change to either helper is a change to this section and SHARED-INJ-004 / SHARED-INJ-008, cascading to the ears and chat LLDs, which only cite them. The upload store and HTTP routes belong to `dashboard`; the `inject.*` schemas to `event-bus`.

## Health (`health.ts`)

`EyesHealth(enabled, obsConnected)` exposes `spec` and `track(describe)` (`health.ts:5-20`).

- Mode: `live` when enabled, else `off` (getter).
- Deps: enabled gives `{obs: ok|down from obsConnected(), ollama: ok|down}`; disabled gives `{obs:"n/a", ollama:"n/a"}`.
- `ollama` starts `ok` and flips on each tracked `describe` outcome (`tracked` from `@cohost/bus`). Because the injection handler receives the same tracked function, a failing injected-image describe also flips the `ollama` dep, and vice versa.
- `obsConnected` is `() => obs.identified` (`index.ts:24`), so a permanently closed OBS shows `obs: down`, which the shared heartbeat turns into `degraded` once `ready` (`packages/bus/src/heartbeat.ts:71`).
- Heartbeat `ready()` is called on OBS connect when enabled (`createObsLink`), or immediately when disabled (`index.ts`). While OBS is unreachable at boot each failed attempt calls `heartbeat.degraded("OBS not reachable")`, so the heartbeat reports `degraded` with `obs: down` (EYES-HEALTH-006) instead of staying `starting`.

## Shutdown

`index.ts` registers exactly one `onShutdown` callback, `stopEyes` (`obs.ts`), in both plans (EYES-ENAB-005, EYES-OBS-008): clear the idle timer if there is one (vision disabled), stop the OBS link (stop reconnecting, close the socket; harmless when never connected), then stop the bus. The `stopping` heartbeat is sent by the heartbeat's own pre-shutdown hook before any callback runs, and the bus runs every registered callback in order and exits once ([event-bus](../event-bus/event-bus-design.md)).

## Stub describer and shared injection

Where `vision.engine` is `stub` (CFG-SCH-021; the isolation preset sets it), the describer makes no network request: an injected image is described as `stub vision: <n> bytes`, and the look loop gets that text once and `SAME` after, so an isolated eyes with OBS reports a single change. The heartbeat reports mode `mock` (or `off` when vision is disabled) and `deps.ollama` `n/a` (EYES-STUB-*). Injection runs through the shared inject handler (shared-runtime SHARED-INJ-*) with eyes' kind and limits (EYES-INJ-016).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Change detection | Ask the model to answer `SAME` (`eyes.ts:51`, `:78`) | Pixel/perceptual diff; embedding distance | A game frame changes in pixels almost every interval (animation, HUD, camera), so a pixel or perceptual diff fires on noise, and an embedding distance needs a second model and a tuned threshold. The vision model already sees the frame and the previous description, so it can judge "meaningful" in the same call, and the service stays a few lines of parsing. The cost is one model call every interval even when nothing changed. |
| Bus payload | One-line text summary, not frames (`index.ts:6-7`) | Publish images | Header comment (`index.ts:6-7`): "Summaries, not frames, go on the bus: cheap and what the brain actually wants." |
| Idle when disabled | `startEyes` gate; service stays up with mode `off` (`eyes.ts:86-94`, `index.ts:87-90`) | Exit; connect to OBS anyway (old behaviour) | A disabled service must not touch OBS (commit 463b1bb, fixes #11) and must stay up rather than look like a crash (commit 51d5a9c; add-isolated-backends design D7: "the OBS connect loop never starts; process idles"). |
| OBS retry | Fixed 10 s retry with no cap in `createObsLink` (`obs.ts:37`, `:57`) | Exponential backoff; give up after N attempts | OBS is often started after the stack or restarted mid-session, so eyes must keep trying and recover on its own; giving up would leave a disabled sense that only a restart fixes, against the degrade-and-report posture (heartbeat `degraded`, `obs: down`, EYES-HEALTH-006). A backoff would only lengthen the gap before eyes sees again once OBS is back; one connection attempt every 10 s to a LAN host costs nothing. |
| Reconnect trigger | Reconnect on any `ConnectionClosed`, clean or not (EYES-OBS-004) | Reconnect only after a failed look (the original code, which the `obs.identified` guard in the loop never reaches) | Owner decision 2026-11-01: OBS restarts and clean closes must not leave eyes polling forever with `obs: down`; obs-websocket-js 5.0.8 has no reconnect of its own. |
| Boot health while OBS is unreachable | `degraded` with `obs: down` (EYES-HEALTH-006) | Stay `starting` until the first connect (the original code) | Owner decision 2026-11-01 (project-wide): heartbeat deps reflect runtime state; a sense waiting on its backend is visibly degraded. add-isolated-backends also said SHOULD. |
| Shared describer health | One tracked describer for the loop and injection; an injected failure marks `ollama` down (EYES-HEALTH-003) | Separate tracking for injection | Owner decision 2026-11-01: both paths use the same backend, so one dependency status is accurate. |
| `changed` field | Always `true`; eyes publishes only changes (EYES-LOOK-001) | Publish every look with `changed: false`; drop the field | Owner decision 2026-11-01: keep the field and state the always-true contract. |
| Shutdown | One shutdown sequence in both plans (EYES-ENAB-005, EYES-OBS-008) | One `onShutdown` per plan branch (the original code) | Owner decision 2026-11-01 (project-wide): the bus runs every registered callback and exits once, so a second registration must not cut the first short. |
| Outbound timeouts and upload cap | Configured timeout on the describe call and the upload fetch; configured maximum upload size (EYES-DESC-006, SHARED-INJ-006, SHARED-INJ-007) | No limits (the original code) | Owner decision 2026-11-01: a hung model or upload must not stall the serial loop or the injection path. |
| Injection start mode | `latest`: the `eyes` group is reset to the newest entry on every start (EYES-INJ-014) | `resume` | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; delivery across restarts is at-most-once. |
| Prompt and model options | Hard-coded in source (`eyes.ts:43-51`) | Configurable prompt / options | Only the model is expected to vary per install (`vision.model`), because it depends on the operator's GPU. The prompt carries the `SAME` contract the parser relies on (`eyes.ts:78`), so an operator-edited prompt could silently break change detection. `num_predict: 60` and `temperature: 0.2` keep the answer to one short, stable sentence; `keep_alive: "24h"` keeps the model resident in VRAM so a look never pays a cold load. |
| Injection reuses `describe` | Same tracked describer, empty previous (`index.ts:63`, `inject.ts:57`) | Separate describer; pass `Eyes.previous` | Keeps change tracking untouched and exercises the real model path: doc comment `inject.ts:39-41`; add-test-injection design D8 ("previous = \"\" so injection neither sees SAME nor disturbs the change-tracking `previous`"). |
| SSRF guard | `uploadUrl` (`@cohost/shared`) + `redirect:"error"` (`inject.ts`) | Allow any URL; allow-list of hosts | Stop the bus being used to make eyes fetch arbitrary URLs: comment at `inject.ts:20-22`; add-test-injection design D2 ("SSRF guard"). The origin and path check applies to the requested URL only; `redirect: "error"` makes the fetch fail instead of following a redirect, which could lead anywhere the check would have refused. |
| Shared inject helpers | `uploadUrl` and `INJECT_STALE_MS` in the `@cohost/shared` workspace package, imported by eyes, ears and chat (SHARED-INJ-008) | A copy in each service (the original arrangement); a helper exported from eyes and imported by ears | Owner decision of 2026-11-08: code shared across modules or services belongs in shared packages. One definition means the SSRF guard and the staleness window cannot drift between services. A service importing a sibling service's source would couple deployables; a package keeps the dependency direction service to package. |

## Open Questions & Future Decisions

### Deferred / unexplained

1. The OBS connect loop has no backoff. `stop()` ends a pending retry loop at its next wake-up; the process exit follows immediately.
2. The `fatal` path (`log.error` then `process.exit(1)`) is reached only by setup failures such as the subscription group not being creatable.
3. The `SAME` rule is a prefix word match (`/^same\b/i`), so `Same old menu screen` is treated as no change; the test pins `Same as before` and `same.` and that `Samurai attack!` is not (`test/eyes.test.ts:31-36`).
4. Hard-coded system prompt, `num_predict: 60`, `temperature`, `keep_alive: "24h"`, JPEG quality 70 (`eyes.ts:28-37`, `index.ts:50`): not configurable.
5. Config-example comment says vision.enabled `false = eyes idles, never touches OBS` (`config/config.example.yaml:38`), consistent with code. The frozen OpenSpec baseline ("loop never calls look()") is looser than the shipped gate; EYES-ENAB-001 governs.
6. `index.ts` has no test; `startEyes` and the pure pieces are tested, the loop, `connectObs`, `screenshot` are not. 15 of 37 `[x]` specs have no test (see the arrow doc).
7. SHARED-INJ-003 (wrong kind) and the redirect half of SHARED-INJ-005 have no test; EYES-HEALTH-003's recovery to `ok` after a success is not asserted (the test only drives a failure).

## References

### Files in this segment
- `services/eyes/src/index.ts`, `eyes.ts`, `health.ts`, `inject.ts`, `obs.ts`
- `services/eyes/test/eyes.test.ts`, `health.test.ts`, `inject.test.ts`, `obs.test.ts`
- `services/eyes/package.json`, `services/eyes/tsconfig.json`
- `packages/shared/src/inject.ts`, `packages/shared/test/inject.test.ts` (shared inject helpers)

### Other segments
- `event-bus` (depends on): `Bus`, `vision.summary`, `inject.request`/`inject.result`.
- `config` (depends on): `loadConfig`, `vision.*`, `urls.ollama()`, `urls.dashboard()`.
- `control-plane` (depends on): `startHeartbeat`, `tracked`, `HeartbeatSpec`.
- `model-backends`: not used; eyes calls Ollama directly with `fetch` rather than the shared `ChatProvider` (observation).
- `dashboard` (called by): serves `/uploads/:id`, publishes `inject.request`, shows `inject.result`.
- `ears` (sibling): imports `uploadUrl` and `INJECT_STALE_MS` from `@cohost/shared`; `chat` imports `INJECT_STALE_MS`.
- `@cohost/shared` (depends on, workspace package): `uploadUrl`, `INJECT_STALE_MS`; owned by this LLD, see Image Injection.
- `salience`, `affect` (consumed by): subscribe to `vision.summary` (`services/salience/src/index.ts:31`, `services/affect/src/index.ts:26`).
- `deployment`: compose service `eyes`, profile `eyes` (`docker-compose.yml:145-148`).

### External
- `obs-websocket-js` (`^5.0.6`), OBS 28+ obs-websocket v5 (`GetSourceScreenshot`).
- Ollama `/api/chat` with a vision model (`VISION_MODEL`, e.g. `qwen2.5vl:3b` in `.env.example:13`).

### OpenSpec
- `openspec/specs/eyes/spec.md`
- `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md` ("add-isolated-backends design", D7 cited above)
- `openspec/changes/archive/2026-11-01-add-test-injection/design.md` ("add-test-injection design", D2 and D8 cited above)
- `openspec/changes/archive/2026-11-01-add-service-health/specs/eyes/spec.md`
- `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/eyes/spec.md`
- `openspec/changes/archive/2026-11-01-add-test-injection/specs/eyes/spec.md`

### Docs
- [HLD](../../high-level-design.md), [specs](eyes-specs.md), [arrow](../../arrows/eyes.md)
