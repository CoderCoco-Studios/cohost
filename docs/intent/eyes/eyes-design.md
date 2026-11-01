---
parent: high-level-design
prefix: EYES
---

# eyes

Segment `eyes` (`services/eyes`, package `@cohost/eyes`). Mapped 2026-10-31 at git `686cc8f`. Describes what the code does today.

## Context and Design Philosophy

`eyes` is the visual sense. It polls a source in OBS through obs-websocket, asks an Ollama vision model for one sentence about what changed, and publishes `vision.summary` (see [HLD](../../high-level-design.md)). The header comment states the stance (`index.ts:2-9`): summaries, not frames, go on the bus because they are cheap and what the brain wants. It runs under the compose profile `eyes` (`docker-compose.yml:145-148`), unlike `chat` which is in the default set.

Observed design stance (`[inferred]` from code):

- Change detection is delegated to the model. The prompt tells it to reply exactly `SAME` when nothing meaningful changed (`eyes.ts:33-35`); the service only parses that word (`eyes.ts:62`). There is no pixel or embedding diff.
- Disabled by default and fully inert when disabled: no OBS connection, no model calls from the loop (`startEyes`, `eyes.ts:82-90`, fix in commit 463b1bb). The service still starts, heartbeats `off`, and still handles image injection.
- Logic is separated from I/O by dependency injection: `Eyes` takes `screenshot` and `describe` functions (`eyes.ts:4-11`), `startEyes` takes `connect` and `loop`, the inject handler takes `fetch`, `describe`, `now`. `index.ts` is the untested composition root.
- One shared `describe` function serves both the polling loop and injected images, and it is wrapped by health tracking (`index.ts:53`, `:59`).

## Startup and Gating

`index.ts` constructs `OBSWebSocket`, `EyesHealth`, the heartbeat, the describer and `Eyes` unconditionally (`index.ts:23-54`), subscribes to `inject.request` (`:57-60`), then calls `startEyes` (`:78`).

`startEyes({enabled, log, connect, loop})` (`eyes.ts:82-90`):

- `enabled` false: warn `vision.enabled is false in config.yaml - eyes idle...`, return `false` without calling `connect` or `loop`.
- `enabled` true: `await connect(); await loop();` return `true`. `loop` never returns, so in practice the promise never resolves when enabled.

On `false`, `index.ts:81-84` signals `heartbeat.ready()` (mode `off`), logs an idle warning every 60 s, and registers an `onShutdown` to clear the timer. A rejected startup is `log.error("fatal")` then `process.exit(1)` (`:86`); with the current code the connect loop swallows its own errors, so that path is effectively unreachable.

Config read: `vision.enabled` (default false; env `VISION_ENABLED`), `vision.model` (`VISION_MODEL`), `vision.interval_ms` (default 8000), `vision.obs.{host,port,password,source,width}` (defaults `host.docker.internal`, 4455, empty, `Game Capture`, 896) (`packages/config/src/schema.ts:70-81`); env `OLLAMA_URL` (default `http://127.0.0.1:11434`) and `DASHBOARD_URL` (default `http://127.0.0.1:3000`) via `urls.*` (`packages/config/src/index.ts:159`, `:165`).

## OBS Connection and Look Loop

`connectObs()` (`index.ts:27-40`) loops forever: `obs.connect("ws://host:port", password || undefined)`; on success log version and `heartbeat.ready()` and return; on failure warn and `sleep(10_000)`. No backoff, no cap, no shutdown check.

`screenshot()` (`index.ts:42-51`) calls `GetSourceScreenshot` with `sourceName`, `imageFormat: "jpg"`, `imageWidth: width`, `imageCompressionQuality: 70` and runs the result through `stripDataUrl` (`eyes.ts:14-16`), which removes a `data:image/<word>;base64,` prefix.

`loop()` (`index.ts:62-73`), per iteration:

1. If `cfg.vision.enabled && obs.identified`, `await eyes.look()`.
2. A thrown error is warned as `look failed`; if `!obs.identified` it awaits `connectObs()`.
3. Sleep `max(500, interval_ms - elapsed)`.

`obs.on("ConnectionClosed")` only logs `OBS connection closed` (`index.ts:77`). Because `look()` is skipped while `!obs.identified` (step 1) and reconnect lives only in the `catch` (step 2), a clean close leaves `identified` false, `look()` is never called, nothing throws, and `connectObs` is never re-entered: the service polls forever doing nothing while the heartbeat shows `obs: down`. This is the long-standing gap noted in the sweeps.

### `Eyes.look()` (`eyes.ts:52-72`)

`screenshot()` then `describe(b64, previous)`. If the text is empty or matches `/^same\b/i`, log debug and return `false`, leaving `previous` untouched. Otherwise set `previous = text`, publish `vision.summary {text, changed: true}`, log info, return `true`. `changed` is therefore always `true` on the wire although the schema allows false (`packages/bus/src/events.ts:28`). There are no timeouts or overlap guards; the loop is sequential.

### `ollamaDescriber(cfg.vision)` (`eyes.ts:19-49`)

`POST ${urls.ollama()}/api/chat` JSON: `model: cfg.model`, `stream: false`, `keep_alive: "24h"`, `options {temperature: 0.2, num_predict: 60}`, a hard-coded system prompt, and a user message carrying either `Previous description: <previous>\nWhat is happening now?` or `What is happening now?` plus `images: [b64]`. Non-OK responses throw `vision model <status>: <body>`. The reply is `message.content`, trimmed, first line only. All parameters except `model` are hard-coded.

## Test Injection (`inject.ts`)

`createInjectHandler({bus, log, dashboardUrl, describe, fetch?, now?})`, subscribed with group `eyes`, `fromNow: true` (`index.ts:57-60`), wired even when vision is disabled. Flow (`inject.ts:40-65`):

1. `target !== "eyes"` returns silently.
2. Stale (`now() - ev.ts > 60_000`) gives `inject.result {ok:false, detail:"stale"}`.
3. `kind !== "image"` gives `ok:false` with `eyes cannot handle kind '<kind>'`.
4. `uploadUrl(r.url, dashboardUrl)` (`inject.ts:22-33`) must accept: same origin as `urls.dashboard()`, no userinfo, normalised pathname starting with `<dashboard path>/uploads/` and longer than that prefix. Result is `u.href` (query strings pass). Otherwise `ok:false` `url is not an upload of this dashboard`; nothing is fetched.
5. `fetch(target, {redirect: "error"})`; non-OK gives `ok:false` `fetch upload <status>`.
6. Bytes to base64, `describe(b64, "")` (empty previous so the model never needs `SAME`, and `Eyes.look()`'s `previous` is untouched); empty or `SAME` gives `ok:false` `no description`.
7. Publishes `vision.summary {text, changed:true, injected:true, remember}` then `inject.result {ok:true, detail:text}`.
8. Any throw becomes `ok:false` with `String(err)`; a failure to publish that is swallowed.

`uploadUrl` and `INJECT_STALE_MS` are duplicated verbatim in `services/ears/src/inject.ts` (the `ears` segment). There is no response-size cap or fetch timeout. The upload store and HTTP routes belong to `dashboard`; the `inject.*` schemas to `event-bus`.

## Health (`health.ts`)

`EyesHealth(enabled, obsConnected)` exposes `spec` and `track(describe)` (`health.ts:4-19`).

- Mode: `live` when enabled, else `off` (getter).
- Deps: enabled gives `{obs: ok|down from obsConnected(), ollama: ok|down}`; disabled gives `{obs:"n/a", ollama:"n/a"}`.
- `ollama` starts `ok` and flips on each tracked `describe` outcome (`tracked` from `@cohost/bus`). Because the injection handler receives the same tracked function, a failing injected-image describe also flips the `ollama` dep, and vice versa.
- `obsConnected` is `() => obs.identified` (`index.ts:24`), so a permanently closed OBS shows `obs: down`, which the shared heartbeat turns into `degraded` once `ready` (`packages/bus/src/heartbeat.ts:68-70`).
- Heartbeat `ready()` is called on OBS connect when enabled (`index.ts:33`), or immediately when disabled (`:82`). Before the first successful OBS connect the state stays `starting` (not `degraded`), even though `obs` is `down`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Change detection | Ask the model to answer `SAME` (`eyes.ts:33-35`, `:62`) | Pixel/perceptual diff; embedding distance | `[inferred]` Keeps the service tiny and lets the model judge "meaningful"; costs a model call every interval even when nothing changed. |
| Bus payload | One-line text summary, not frames (`index.ts:7-8`) | Publish images | `[inferred]` Header comment: cheap and what the brain wants. |
| Idle when disabled | `startEyes` gate; service stays up with mode `off` (`eyes.ts:82-90`, `index.ts:81-84`) | Exit; connect to OBS anyway (old behaviour) | `[inferred]` Fix 463b1bb (#17) and the isolated-backends change: a disabled service must not touch OBS and must not look like a crash. |
| OBS retry | Fixed 10 s infinite retry in `connectObs` (`index.ts:29-38`) | Exponential backoff; give up | `[inferred]` Simplicity; OBS is often started after the stack. |
| Reconnect trigger | Only inside the `look()` catch (`index.ts:69`) | Reconnect on `ConnectionClosed` | `[inferred]` Probably intended to cover drops, but the `obs.identified` guard (`index.ts:66`) prevents it from firing. Not authored intent. |
| Prompt and model options | Hard-coded in source (`eyes.ts:28-35`) | Configurable prompt / options | `[inferred]` Only `model` varies by config; `keep_alive: "24h"` pins the model in VRAM. |
| Injection reuses `describe` | Same tracked describer, empty previous (`index.ts:59`, `inject.ts:55`) | Separate describer; pass `Eyes.previous` | `[inferred]` Keeps change tracking untouched and exercises the real model path (`inject.ts:37-39`). |
| SSRF guard | `uploadUrl` + `redirect:"error"` (`inject.ts:22-33`, `:52`) | Allow any URL; allow-list of hosts | `[inferred]` Comment at `inject.ts:19-21`: stop the bus being used to make eyes fetch arbitrary URLs. |
| Helper duplication | `uploadUrl`/`INJECT_STALE_MS` copied into ears | Shared helper in a package | `[inferred]` Both copies arrived with test injection (3fae9f7); no comment explains why they are not shared. |

## Open Questions & Future Decisions

### Deferred / unexplained

1. OBS never reconnects after a clean close: `loop` skips `look()` while `!obs.identified` (`index.ts:66`), the `catch` is the only caller of `connectObs` (`index.ts:68-69`), and `ConnectionClosed` only logs (`index.ts:77`). Still true at 686cc8f. Affects EYES-OBS-004. (`obs.identified` semantics from obs-websocket-js not verified; `node_modules` not installed at mapping.)
2. `connectObs` has no shutdown check and no backoff (`index.ts:29-39`); `disconnect()` in `onShutdown` (`index.ts:87`) does not stop a pending retry loop, though the process exit usually does.
3. `.catch(... process.exit(1))` (`index.ts:86`) is unreachable in practice; the intent of the `fatal` path is unclear.
4. Heartbeat is `starting`, not `degraded`, while OBS is unreachable at boot (`index.ts:36` never calls `heartbeat.degraded`; `heartbeat.ts:69`). add-isolated-backends says it SHOULD report `degraded` with `obs` down. See EYES-HEALTH-006.
5. `ollama` dependency is shared between the loop and injection (`index.ts:53`, `:59`): a bad uploaded image that makes the model error will mark `ollama` down for the live loop's heartbeat until the next success.
6. No timeout or abort on the Ollama `fetch` (`eyes.ts:21`) or the upload `fetch` (`inject.ts:52`), and no size cap on the downloaded upload (`inject.ts:54`). A hung model stalls the loop since `look()` is awaited serially.
7. `changed` is always `true`; the `false` branch of the schema is unused (`eyes.ts:68`).
8. The `SAME` rule is a prefix word match (`/^same\b/i`), so `Same old menu screen` is treated as no change; the test pins `Same as before` and `same.` and that `Samurai attack!` is not (`test/eyes.test.ts:29-34`).
9. Hard-coded system prompt, `num_predict: 60`, `temperature`, `keep_alive: "24h"`, JPEG quality 70 (`eyes.ts:26-35`, `index.ts:48`): not configurable.
10. The chat/ears copies of the stale-window constant and `uploadUrl` can drift (`services/ears/src/inject.ts`).
11. `void bus.subscribe(...)` (`index.ts:57`) has no `.catch`.
12. Config-example comment says vision.enabled `false = eyes idles, never touches OBS` (`config/config.example.yaml:38`), consistent with code. Old baseline OpenSpec text ("loop never calls look()") is looser than the shipped gate; baseline is superseded by the isolated-backends delta.
13. `index.ts` has no test; `startEyes` and the pure pieces are tested, the loop, `connectObs`, `screenshot` are not.

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
- `openspec/changes/archive/2026-11-01-add-service-health/specs/eyes/spec.md`
- `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/eyes/spec.md`
- `openspec/changes/archive/2026-11-01-add-test-injection/specs/eyes/spec.md`

### Docs
- [HLD](../../high-level-design.md), [specs](eyes-specs.md), [arrow](../../arrows/eyes.md)
