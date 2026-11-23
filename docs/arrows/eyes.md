# Arrow: eyes

Visual sense: OBS screenshot -> vision model through a chat provider that takes images (`vision.provider`, Ollama by default) -> change-only `vision.summary`, plus uploaded-image test injection and a heartbeat.

## Status

**DRIFTED**: 64 specs: 64 implemented, 0 gaps, 0 deferred. Every spec line is `[x]` and cites a test; the describer, provider selection through `@cohost/llm`, configuration gaps, outage and frame-fault classes, egress notes and the `vision` dependency are built (#189). The arrow has not had its audit pass since this change (last audited 2026-11-14 at `cb06bf3`), so it is not claimed AUDITED.

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/eyes/eyes-design.md

### EARS
- docs/intent/eyes/eyes-specs.md (64 specs: 64 `[x]`, 0 `[ ]`, 0 `[D]`; prefix `EYES`)

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
2. `eyes.ts`: `Eyes.look()` change-only publisher, `createDescriber` (picks the stub, a configuration gap, or `modelDescriber` over the provider `buildVisionProvider` builds through `@cohost/llm`), `modelDescriber` (with its own describe timer), `stubDescriber`, `visionGap` and `describerLabel`, `stripDataUrl`, `startEyes` enablement gate.
3. `inject.ts`: `createInjectHandler` over the shared inject handler (upload read timeout and size cap; the upload comes from Redis through `Bus.takeUpload`, SHARED-INJ-004 to SHARED-INJ-013) and `subscribeInject` (group created first, start mode `latest`); the staleness window `INJECT_STALE_MS` lives in `@cohost/shared`.
4. `obs.ts`: `createObsLink` (connect with backoff, degraded while unreachable, reconnect on any close) and `stopEyes` (the single shutdown sequence).
5. `health.ts`: `EyesHealth` (mode off/live/mock, deps `obs`/`vision`, `track()` wrapper with `isFrameFault` classification) (`EYES-HEALTH-001`, `-003`, `-007`).

Depends on `event-bus`, `config` (including `egressDestinations`), `control-plane` (heartbeat), `model-backends` (the chat provider `vision.provider` names, `ChatError`) and the `@cohost/shared` workspace package (inject helpers; owned by this segment, no segment of its own). Calls OBS directly. Reads uploads from Redis, which `dashboard` writes. Consumed by `salience`, `affect`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Enablement | EYES-ENAB-001 to EYES-ENAB-005 | 5 | 0 | 0 | 5 |
| OBS connection and capture | EYES-OBS-001 to EYES-OBS-008 | 8 | 0 | 0 | 8 |
| Vision description | EYES-DESC-001 to EYES-DESC-007 | 7 | 0 | 0 | 7 |
| Look loop and publication | EYES-LOOK-001 to EYES-LOOK-007 | 7 | 0 | 0 | 7 |
| Test injection | EYES-INJ-001, EYES-INJ-007 to EYES-INJ-011, EYES-INJ-014, EYES-INJ-016 to EYES-INJ-018 | 10 | 0 | 0 | 10 |
| Stub describer | EYES-STUB-001 to EYES-STUB-003 | 3 | 0 | 0 | 3 |
| Health | EYES-HEALTH-001 to EYES-HEALTH-007 | 7 | 0 | 0 | 7 |
| Describer provider | EYES-PROV-001 to EYES-PROV-007 | 7 | 0 | 0 | 7 |
| Configuration gaps | EYES-GAP-001 to EYES-GAP-006 | 6 | 0 | 0 | 6 |
| Egress | EYES-EGR-001 to EYES-EGR-004 | 4 | 0 | 0 | 4 |

**Summary:** 64 of 64 specs implemented; 0 deferred; 0 gaps. Every spec is cited by a test in `services/eyes/test`. `node scripts/lid-check.mjs` reports no problems.

## Key Findings

1. **OBS reconnects after any close.** `createObsLink` (`services/eyes/src/obs.ts`) starts a connect loop on `ConnectionClosed` unless one is already running or the link was stopped (EYES-OBS-004). obs-websocket-js has no reconnect of its own, and a failed connect attempt emits `ConnectionClosed` too, hence the running-loop guard.
2. **The heartbeat is `degraded` (obs down), not `starting`, while OBS is unreachable at boot.** Each failed attempt calls `heartbeat.degraded` (EYES-HEALTH-006).
3. **One shutdown sequence in both plans.** `stopEyes` clears the idle timer, stops the link and the bus; `service.ts` registers a single `onStop` step (EYES-ENAB-005).
4. **Disabled gate.** `startEyes` (`services/eyes/src/eyes.ts`, test `services/eyes/test/eyes.test.ts`) keeps eyes from connecting to OBS with `vision.enabled=false`. Injection still works while disabled.
5. **Change detection is entirely model-driven.** The service trusts a clear `SAME` (`isSame` in `eyes.ts`); every interval costs a model call. `changed` is always `true` by contract (EYES-LOOK-001).
6. **One tracked `describe` is shared by loop and injection.** An outage-class failure of an injected image marks `vision` down for the live heartbeat; a frame fault (400, 422, or an `ImageDataError` for an unsupported image format) drops that frame and leaves `vision` alone (`service.ts`, `health.ts`; EYES-HEALTH-003, EYES-PROV-006, EYES-PROV-007).
7. **Outbound calls are bounded.** The describer's own timer aborts the describe call after `vision.timeout_ms` and rejects even when a provider ignores the signal (EYES-DESC-006); the upload read gives up after `vision.upload_timeout_ms` and an upload past `vision.upload_max_bytes` is refused (SHARED-INJ-006, SHARED-INJ-007). The `inject.request` subscription starts with `latest` after the group is created (EYES-INJ-014).
8. **Inject helpers are shared.** `INJECT_STALE_MS` and the upload read have one definition in `packages/shared/src/inject.ts`, used through the shared inject handler by eyes, ears and chat (SHARED-INJ-008). Uploads travel over Redis (`Bus.takeUpload`), so a request carries no URL.

## Work Required

### Must Fix
1. Run the arrow audit pass over this segment (the status is DRIFTED until it runs; the last audit predates #189).

### Should Fix
1. Live check of `vision.provider` against a local Ollama vision model and one hosted provider, recorded on #189.
2. Claude thinking budget: a Claude or Bedrock describe sends `vision.num_predict` (default 60) as `max_tokens`. A thinking model may spend that budget on thinking and return an empty reply, which reads as `SAME`. Check on the live hosted run and raise the default or a floor for those providers if it does.

### Nice to Have
None.
