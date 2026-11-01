---
parent: high-level-design
prefix: EYES
---

# eyes

Segment `eyes` (`services/eyes`, package `@cohost/eyes`). Mapped 2026-10-31 at git `686cc8f`. Describes what the code does today.

## Context and Design Philosophy

`eyes` is the visual sense. It polls a source in OBS through obs-websocket, asks an Ollama vision model for one sentence about what changed, and publishes `vision.summary` (see [HLD](../../high-level-design.md)). The header comment states the stance (`index.ts:2-9`): summaries, not frames, go on the bus because they are cheap and what the brain wants. It runs under the compose profile `eyes` (`docker-compose.yml:145-148`), unlike `chat` which is in the default set.

Design stance (evidence per bullet; `[inferred]` where only the code shows it):

- `[inferred]` Change detection is delegated to the model. The prompt tells it to reply exactly `SAME` when nothing meaningful changed (`eyes.ts:35-37`); the service only parses that word (`eyes.ts:65`). There is no pixel or embedding diff.
- Disabled by default and fully inert when disabled: no OBS connection, no model calls from the loop (`startEyes`, `eyes.ts:86-94`). The service still starts, heartbeats `off`, and still handles image injection. Evidence: commit 463b1bb (fixes #11, eyes connected to OBS while disabled); commit 51d5a9c; add-isolated-backends design D7.
- Logic is separated from I/O by dependency injection: `Eyes` takes `screenshot` and `describe` functions (`eyes.ts:4-11`), `startEyes` takes `connect` and `loop`, the inject handler takes `fetch`, `describe`, `now`. `index.ts` is the untested composition root. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": eyes gained `Eyes.look` / `ollamaDescriber`).
- One shared `describe` function serves both the polling loop and injected images, and it is wrapped by health tracking (`index.ts:56`, `:63`). Evidence: add-test-injection design D8 ("call the same `describe(b64, \"\")`") and the `describe` doc comment in `inject.ts` ("Same describer `Eyes.look()` uses").

## Startup and Gating

`index.ts` constructs `OBSWebSocket`, `EyesHealth`, the heartbeat, the describer and `Eyes` unconditionally (`index.ts:23-57`), subscribes to `inject.request` (`:61-64`), then calls `startEyes` (`:83`).

`startEyes({enabled, log, connect, loop})` (`eyes.ts:86-94`):

- `enabled` false: warn `vision.enabled is false in config.yaml - eyes idle...`, return `false` without calling `connect` or `loop`.
- `enabled` true: `await connect(); await loop();` return `true`. `loop` never returns, so in practice the promise never resolves when enabled.

On `false`, `index.ts:87-90` signals `heartbeat.ready()` (mode `off`), logs an idle warning every 60 s, and registers an `onShutdown` to clear the timer. A rejected startup is `log.error("fatal")` then `process.exit(1)` (`:92`); with the current code the connect loop swallows its own errors, so that path is effectively unreachable.

Config read: `vision.enabled` (default false; env `VISION_ENABLED`), `vision.model` (`VISION_MODEL`), `vision.interval_ms` (default 8000), `vision.obs.{host,port,password,source,width}` (defaults `host.docker.internal`, 4455, empty, `Game Capture`, 896) (`packages/config/src/schema.ts:70-81`); env `OLLAMA_URL` (default `http://127.0.0.1:11434`) and `DASHBOARD_URL` (default `http://127.0.0.1:3000`) via `urls.*` (`packages/config/src/index.ts:159`, `:165`).

## OBS Connection and Look Loop

`connectObs()` (`index.ts:28-41`) loops forever: `obs.connect("ws://host:port", password || undefined)`; on success log version and `heartbeat.ready()` and return; on failure warn and `sleep(10_000)`. No backoff, no cap, no shutdown check.

`screenshot()` (`index.ts:44-53`) calls `GetSourceScreenshot` with `sourceName`, `imageFormat: "jpg"`, `imageWidth: width`, `imageCompressionQuality: 70` and runs the result through `stripDataUrl` (`eyes.ts:15-17`), which removes a `data:image/<word>;base64,` prefix.

`loop()` (`index.ts:67-78`), per iteration:

1. If `cfg.vision.enabled && obs.identified`, `await eyes.look()`.
2. A thrown error is warned as `look failed`; if `!obs.identified` it awaits `connectObs()`.
3. Sleep `max(500, interval_ms - elapsed)`.

`obs.on("ConnectionClosed")` only logs `OBS connection closed` (`index.ts:82`). Because `look()` is skipped while `!obs.identified` (step 1) and reconnect lives only in the `catch` (step 2), a clean close leaves `identified` false, `look()` is never called, nothing throws, and `connectObs` is never re-entered: the service polls forever doing nothing while the heartbeat shows `obs: down`. obs-websocket-js 5.0.8 has no reconnect of its own: its close handler emits `ConnectionClosed` and then clears `identified` (`obs-websocket-js/dist/chunk-MVPOL3ZW.js:341-346`, `:186`).

### `Eyes.look()` (`eyes.ts:54-75`)

`screenshot()` then `describe(b64, previous)`. If the text is empty or matches `/^same\b/i`, log debug and return `false`, leaving `previous` untouched. Otherwise set `previous = text`, publish `vision.summary {text, changed: true}`, log info, return `true`. `changed` is therefore always `true` on the wire although the schema allows false (`packages/bus/src/events.ts:28`). There are no timeouts or overlap guards; the loop is sequential.

### `ollamaDescriber(cfg.vision)` (`eyes.ts:21-51`)

`POST ${urls.ollama()}/api/chat` JSON: `model: cfg.model`, `stream: false`, `keep_alive: "24h"`, `options {temperature: 0.2, num_predict: 60}`, a hard-coded system prompt, and a user message carrying either `Previous description: <previous>\nWhat is happening now?` or `What is happening now?` plus `images: [b64]`. Non-OK responses throw `vision model <status>: <body>`. The reply is `message.content`, trimmed, first line only. All parameters except `model` are hard-coded.

## Test Injection (`inject.ts`)

`createInjectHandler({bus, log, dashboardUrl, describe, fetch?, now?})`, subscribed with group `eyes`, `fromNow: true` (`index.ts:61-64`), wired even when vision is disabled. Flow (`inject.ts:42-67`):

1. `target !== "eyes"` returns silently.
2. Stale (`now() - ev.ts > 60_000`) gives `inject.result {ok:false, detail:"stale"}`.
3. `kind !== "image"` gives `ok:false` with `eyes cannot handle kind '<kind>'`.
4. `uploadUrl(r.url, dashboardUrl)` (`inject.ts:23-34`) must accept: same origin as `urls.dashboard()`, no userinfo, normalised pathname starting with `<dashboard path>/uploads/` and longer than that prefix. Result is `u.href` (query strings pass). Otherwise `ok:false` `url is not an upload of this dashboard`; nothing is fetched.
5. `fetch(target, {redirect: "error"})`; non-OK gives `ok:false` `fetch upload <status>`.
6. Bytes to base64, `describe(b64, "")` (empty previous so the model never needs `SAME`, and `Eyes.look()`'s `previous` is untouched); empty or `SAME` gives `ok:false` `no description`.
7. Publishes `vision.summary {text, changed:true, injected:true, remember}` then `inject.result {ok:true, detail:text}`.
8. Any throw becomes `ok:false` with `String(err)`; a failure to publish that is swallowed.

`uploadUrl` and `INJECT_STALE_MS` are duplicated verbatim in `services/ears/src/inject.ts` (the `ears` segment). There is no response-size cap or fetch timeout. The upload store and HTTP routes belong to `dashboard`; the `inject.*` schemas to `event-bus`.

## Health (`health.ts`)

`EyesHealth(enabled, obsConnected)` exposes `spec` and `track(describe)` (`health.ts:5-20`).

- Mode: `live` when enabled, else `off` (getter).
- Deps: enabled gives `{obs: ok|down from obsConnected(), ollama: ok|down}`; disabled gives `{obs:"n/a", ollama:"n/a"}`.
- `ollama` starts `ok` and flips on each tracked `describe` outcome (`tracked` from `@cohost/bus`). Because the injection handler receives the same tracked function, a failing injected-image describe also flips the `ollama` dep, and vice versa.
- `obsConnected` is `() => obs.identified` (`index.ts:24`), so a permanently closed OBS shows `obs: down`, which the shared heartbeat turns into `degraded` once `ready` (`packages/bus/src/heartbeat.ts:68-70`).
- Heartbeat `ready()` is called on OBS connect when enabled (`index.ts:34`), or immediately when disabled (`:88`). Before the first successful OBS connect the state stays `starting` (not `degraded`), even though `obs` is `down`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Change detection | Ask the model to answer `SAME` (`eyes.ts:35-37`, `:65`) | Pixel/perceptual diff; embedding distance | `[inferred]` Keeps the service tiny and lets the model judge "meaningful"; costs a model call every interval even when nothing changed. |
| Bus payload | One-line text summary, not frames (`index.ts:6-7`) | Publish images | Header comment (`index.ts:6-7`): "Summaries, not frames, go on the bus: cheap and what the brain actually wants." |
| Idle when disabled | `startEyes` gate; service stays up with mode `off` (`eyes.ts:86-94`, `index.ts:87-90`) | Exit; connect to OBS anyway (old behaviour) | A disabled service must not touch OBS (commit 463b1bb, fixes #11) and must stay up rather than look like a crash (commit 51d5a9c; add-isolated-backends design D7: "the OBS connect loop never starts; process idles"). |
| OBS retry | Fixed 10 s infinite retry in `connectObs` (`index.ts:30-39`) | Exponential backoff; give up | `[inferred]` Simplicity; OBS is often started after the stack. |
| Reconnect trigger | Only inside the `look()` catch (`index.ts:74`) | Reconnect on `ConnectionClosed` | `[inferred]` Probably intended to cover drops, but the `obs.identified` guard (`index.ts:71`) prevents it from firing. Not authored intent. |
| Prompt and model options | Hard-coded in source (`eyes.ts:30-37`) | Configurable prompt / options | `[inferred]` Only `model` varies by config; `keep_alive: "24h"` pins the model in VRAM. |
| Injection reuses `describe` | Same tracked describer, empty previous (`index.ts:63`, `inject.ts:57`) | Separate describer; pass `Eyes.previous` | Keeps change tracking untouched and exercises the real model path: doc comment `inject.ts:39-41`; add-test-injection design D8 ("previous = \"\" so injection neither sees SAME nor disturbs the change-tracking `previous`"). |
| SSRF guard | `uploadUrl` + `redirect:"error"` (`inject.ts:23-34`, `:54`) | Allow any URL; allow-list of hosts | Stop the bus being used to make eyes fetch arbitrary URLs: comment at `inject.ts:20-22`; add-test-injection design D2 ("SSRF guard"). `redirect: "error"` has no recorded rationale (`[inferred]`: a redirect would escape the origin check). |
| Helper duplication | `uploadUrl`/`INJECT_STALE_MS` copied into ears | Shared helper in a package | `[inferred]` Both copies arrived with test injection (3fae9f7); no comment explains why they are not shared. |

## Open Questions & Future Decisions

### Deferred / unexplained

1. OBS never reconnects after a close: `loop` skips `look()` while `!obs.identified` (`index.ts:71`), the `catch` is the only caller of `connectObs` (`index.ts:73-74`), and `ConnectionClosed` only logs (`index.ts:82`). obs-websocket-js 5.0.8 clears `identified` on close and does not reconnect itself. Affects EYES-OBS-004. Whether EYES-OBS-004 (reconnect on any close, including a clean one) is the intended behavior is `[inferred]`; the OpenSpec only required a reconnect after a failed look.
2. `connectObs` has no shutdown check and no backoff (`index.ts:30-40`); `disconnect()` in `onShutdown` (`index.ts:94`) does not stop a pending retry loop, though the process exit usually does.
3. `.catch(... process.exit(1))` (`index.ts:92`) is unreachable in practice; the intent of the `fatal` path is unclear.
4. Heartbeat is `starting`, not `degraded`, while OBS is unreachable at boot (`index.ts:37` never calls `heartbeat.degraded`; `heartbeat.ts:69`). add-isolated-backends says it SHOULD report `degraded` with `obs` down. See EYES-HEALTH-006.
5. `ollama` dependency is shared between the loop and injection (`index.ts:56`, `:63`): a bad uploaded image that makes the model error will mark `ollama` down for the live loop's heartbeat until the next success.
6. No timeout or abort on the Ollama `fetch` (`eyes.ts:23`) or the upload `fetch` (`inject.ts:54`), and no size cap on the downloaded upload (`inject.ts:56`). A hung model stalls the loop since `look()` is awaited serially.
7. `changed` is always `true`; the `false` branch of the schema is unused (`eyes.ts:71`).
8. The `SAME` rule is a prefix word match (`/^same\b/i`), so `Same old menu screen` is treated as no change; the test pins `Same as before` and `same.` and that `Samurai attack!` is not (`test/eyes.test.ts:31-36`).
9. Hard-coded system prompt, `num_predict: 60`, `temperature`, `keep_alive: "24h"`, JPEG quality 70 (`eyes.ts:28-37`, `index.ts:50`): not configurable.
10. The chat/ears copies of the stale-window constant and `uploadUrl` can drift (`services/ears/src/inject.ts`).
11. `void bus.subscribe(...)` (`index.ts:61`) has no `.catch`.
12. Config-example comment says vision.enabled `false = eyes idles, never touches OBS` (`config/config.example.yaml:38`), consistent with code. The frozen OpenSpec baseline ("loop never calls look()") is looser than the shipped gate; EYES-ENAB-001 governs.
13. `index.ts` has no test; `startEyes` and the pure pieces are tested, the loop, `connectObs`, `screenshot` are not. 15 of 37 `[x]` specs have no test (see the arrow doc).
14. When vision is disabled the service registers two `onShutdown` handlers: the idle-timer one (`index.ts:90`) and the OBS/bus one (`index.ts:94`). Each awaits the shared pre-shutdown hooks and then calls `process.exit(0)` (`packages/bus/src/index.ts:230-246`). The idle-timer handler reaches exit first, because the heartbeat `stop()` hook it awaits has already been started by the other handler and returns at once, so `bus.stop()` is skipped and the `stopping` heartbeat publish races process exit. EYES-OBS-008 is therefore scoped to `vision.enabled: true`, where only one handler is registered. Found by reading, no test.
15. EYES-INJ-004 (wrong kind) and the redirect half of EYES-INJ-006 have no test; EYES-HEALTH-003's recovery to `ok` after a success is not asserted (the test only drives a failure).

## References

### Files in this segment
- `services/eyes/src/index.ts`, `eyes.ts`, `health.ts`, `inject.ts`
- `services/eyes/test/eyes.test.ts`, `health.test.ts`, `inject.test.ts`
- `services/eyes/package.json`, `services/eyes/tsconfig.json`

### Other segments
- `event-bus` (depends on): `Bus`, `vision.summary`, `inject.request`/`inject.result`.
- `config` (depends on): `loadConfig`, `vision.*`, `urls.ollama()`, `urls.dashboard()`.
- `control-plane` (depends on): `startHeartbeat`, `tracked`, `HeartbeatSpec`.
- `model-backends`: not used; eyes calls Ollama directly with `fetch` rather than the shared `ChatProvider` (observation).
- `dashboard` (called by): serves `/uploads/:id`, publishes `inject.request`, shows `inject.result`.
- `ears` (sibling): duplicates `uploadUrl`.
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
