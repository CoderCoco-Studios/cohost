# Arrow: eyes

Visual sense: OBS screenshot -> Ollama vision model -> change-only `vision.summary`, plus uploaded-image test injection and a heartbeat.

## Status

**AUDITED**: 44 specs: 44 implemented, 0 deferred, 0 gaps.

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/eyes/eyes-design.md

### EARS
- docs/intent/eyes/eyes-specs.md (44 specs: 44 `[x]`, 0 `[ ]`, 0 `[D]`; prefix `EYES`)

### Tests
Files with `@spec EYES-` annotations:
- services/eyes/test/eyes.test.ts
- services/eyes/test/service.test.ts
- services/eyes/test/inject.test.ts
- services/eyes/test/health.test.ts
- services/eyes/test/obs.test.ts
- packages/config/test/config.test.ts

The shared inject helpers are tested in packages/shared/test/inject-handler.test.ts (cited through SHARED-INJ IDs).

### Code
Files with `@spec EYES-` annotations:
- services/eyes/src/service.ts
- services/eyes/src/eyes.ts
- services/eyes/src/inject.ts
- services/eyes/src/health.ts
- services/eyes/src/obs.ts

Also: services/eyes/src/index.ts, services/eyes/package.json, services/eyes/tsconfig.json.

## Architecture

**Purpose:** Every `vision.interval_ms`, capture an OBS source, ask a local vision model for one sentence, and publish it as `vision.summary` only when the model says something changed. Inert (but injectable) when `vision.enabled` is false.

**Key Components:**
1. `index.ts`: builds the real OBS client and hands `eyesService` to the shared `runService` bootstrap.
   `service.ts`: `eyesService`: screenshot call, polling loop, subscription establishment, heartbeat start, the one `onStop` shutdown step. Tested by `service.test.ts` with a fake OBS.
2. `eyes.ts`: `Eyes.look()` change-only publisher, `modelDescriber` (with the describe timeout) and `stubDescriber`, `stripDataUrl`, `startEyes` enablement gate.
3. `inject.ts`: `createInjectHandler` over the shared inject handler (upload read timeout and size cap; the upload comes from Redis through `Bus.takeUpload`, SHARED-INJ-004 to SHARED-INJ-013) and `subscribeInject` (group created first, start mode `latest`); the staleness window `INJECT_STALE_MS` lives in `@cohost/shared`.
4. `obs.ts`: `createObsLink` (connect with backoff, degraded while unreachable, reconnect on any close) and `stopEyes` (the single shutdown sequence).
5. `health.ts`: `EyesHealth` (mode off/live/mock, deps `obs`/`ollama`, `track()` wrapper).

Depends on `event-bus`, `config`, `control-plane` (heartbeat), `model-backends` (the `ollama` provider) and the `@cohost/shared` workspace package (inject helpers; owned by this segment, no segment of its own). Calls OBS directly. Reads uploads from Redis, which `dashboard` writes. Consumed by `salience`, `affect`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Enablement | EYES-ENAB-001 to EYES-ENAB-005 | 5 | 0 | 0 | 5 |
| OBS connection and capture | EYES-OBS-001 to EYES-OBS-008 | 8 | 0 | 0 | 8 |
| Vision description | EYES-DESC-001 to EYES-DESC-007 | 7 | 0 | 0 | 7 |
| Look loop and publication | EYES-LOOK-001 to EYES-LOOK-007 | 7 | 0 | 0 | 7 |
| Test injection | EYES-INJ-001, EYES-INJ-007 to EYES-INJ-011, EYES-INJ-014, EYES-INJ-016, EYES-INJ-017 | 9 | 0 | 0 | 9 |
| Stub describer | EYES-STUB-001 to EYES-STUB-002 | 2 | 0 | 0 | 2 |
| Health | EYES-HEALTH-001 to EYES-HEALTH-006 | 6 | 0 | 0 | 6 |

**Summary:** 44 of 44 specs implemented; 0 deferred; 0 open. 44 carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **OBS reconnects after any close.** `createObsLink` (`services/eyes/src/obs.ts`) starts a connect loop on `ConnectionClosed` unless one is already running or the link was stopped (EYES-OBS-004). obs-websocket-js has no reconnect of its own, and a failed connect attempt emits `ConnectionClosed` too, hence the running-loop guard.
2. **The heartbeat is `degraded` (obs down), not `starting`, while OBS is unreachable at boot.** Each failed attempt calls `heartbeat.degraded` (EYES-HEALTH-006).
3. **One shutdown sequence in both plans.** `stopEyes` clears the idle timer, stops the link and the bus; `service.ts` registers a single `onStop` step (EYES-ENAB-005).
4. **Disabled gate.** `startEyes` (`services/eyes/src/eyes.ts`, test `services/eyes/test/eyes.test.ts`) keeps eyes from connecting to OBS with `vision.enabled=false`. Injection still works while disabled.
5. **Change detection is entirely model-driven.** The service trusts a clear `SAME` (`isSame` in `eyes.ts`); every interval costs a model call. `changed` is always `true` by contract (EYES-LOOK-001).
6. **One tracked `describe` is shared by loop and injection.** A bad injected image marks `ollama` down for the live heartbeat (`service.ts`, `health.ts`; EYES-HEALTH-003).
7. **Outbound calls are bounded.** The describe call aborts after `vision.timeout_ms` (EYES-DESC-006); the upload read gives up after `vision.upload_timeout_ms` and an upload past `vision.upload_max_bytes` is refused (SHARED-INJ-006, SHARED-INJ-007). The `inject.request` subscription starts with `latest` after the group is created (EYES-INJ-014).
8. **Inject helpers are shared.** `INJECT_STALE_MS` and the upload read have one definition in `packages/shared/src/inject.ts`, used through the shared inject handler by eyes, ears and chat (SHARED-INJ-008). Uploads travel over Redis (`Bus.takeUpload`), so a request carries no URL.

## Work Required

### Must Fix
None.

### Should Fix
None.

### Nice to Have
None.
