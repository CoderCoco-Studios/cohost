# Arrow: eyes

Visual sense: OBS screenshot -> Ollama vision model -> change-only `vision.summary`, plus uploaded-image test injection and a heartbeat.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 44 specs: 44 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and every scheduled gap fix has landed.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S13** Reconnect to OBS → after any close, including a clean one. Specs: EYES-OBS-004 (`[x]`, reworded), EYES-LOOK-004 (reworded).
2. **R4** Boot health while OBS is unreachable → `degraded` with `obs: down`. Specs: EYES-HEALTH-006 (`[x]`).
3. **R4** Shared tracked describer → keep; an injected failure marks `ollama` down. Specs: EYES-HEALTH-003 (reworded, `[x]`).
4. **R2** Shutdown with vision disabled → one shutdown sequence that stops the bus and sends `stopping`. Specs: EYES-ENAB-005 (new, `[x]`); EYES-OBS-008 stays `[x]` for the enabled plan.
5. **R1** Timeouts and upload cap → configured timeouts on the describe call and the upload fetch, configured maximum upload size. Specs: EYES-DESC-006, SHARED-INJ-006, SHARED-INJ-007 (new, `[x]`).
6. **S14** `vision.summary.changed` → keep, always `true` because eyes publishes only changes. Specs: EYES-LOOK-001 (reworded).
7. **P8** Restart replay → `inject.request` subscription uses start mode `latest`. Specs: EYES-INJ-014 (new, `[x]`), EYES-INJ-001 (reworded).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/eyes/eyes-design.md

### EARS
- docs/intent/eyes/eyes-specs.md (41 specs: 41 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- services/eyes/test/eyes.test.ts
- services/eyes/test/inject.test.ts
- services/eyes/test/health.test.ts
- services/eyes/test/obs.test.ts
- packages/shared/test/inject.test.ts

29 `@spec` annotations in tests, citing 32 distinct spec IDs.

### Code
- services/eyes/src/index.ts
- services/eyes/src/eyes.ts
- services/eyes/src/inject.ts
- services/eyes/src/health.ts
- services/eyes/src/obs.ts
- services/eyes/package.json, services/eyes/tsconfig.json

17 `@spec` annotations in code, citing all 44 spec IDs. No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/eyes/spec.md (rationale: `.../add-isolated-backends/design.md` D7)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/eyes/spec.md (rationale: `.../add-test-injection/design.md` D2, D8)

## Architecture

**Purpose:** Every `vision.interval_ms`, capture an OBS source, ask a local vision model for one sentence, and publish it as `vision.summary` only when the model says something changed. Inert (but injectable) when `vision.enabled` is false.

**Key Components:**
1. `index.ts` — composition root: screenshot call, polling loop, subscription establishment, heartbeat start, the one shutdown registration. Untested.
2. `eyes.ts` — `Eyes.look()` change-only publisher, `ollamaDescriber` (with the describe timeout), `stripDataUrl`, `startEyes` enablement gate.
3. `inject.ts` — `createInjectHandler` (upload timeout and size cap) + `uploadUrl` SSRF guard and `INJECT_STALE_MS` imported from `@cohost/shared` (shared with ears and chat), and `subscribeInject` (group created first, start mode `latest`).
4. `obs.ts` — `createObsLink` (connect with retry, degraded while unreachable, reconnect on any close) and `stopEyes` (the single shutdown sequence).
5. `health.ts` — `EyesHealth` (mode off/live, deps `obs`/`ollama`, `track()` wrapper).

Depends on `event-bus`, `config`, `control-plane` (heartbeat) and the `@cohost/shared` workspace package (inject helpers; owned by this segment, no segment of its own). Calls Ollama and OBS directly. Fetches uploads from `dashboard`. Consumed by `salience`, `affect`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Enablement | EYES-ENAB-001 to EYES-ENAB-005 | 5 | 0 | 0 | 5 |
| OBS connection and capture | EYES-OBS-001 to EYES-OBS-008 | 8 | 0 | 0 | 8 |
| Vision description | EYES-DESC-001 to EYES-DESC-006 | 7 | 0 | 0 | 7 |
| Look loop and publication | EYES-LOOK-001 to EYES-LOOK-005 | 5 | 0 | 0 | 4 |
| Test injection | EYES-INJ-001 to EYES-INJ-016 | 8 | 0 | 0 | 8 |
| Stub describer | EYES-STUB-001 to EYES-STUB-002 | 2 | 0 | 0 | 2 |
| Health | EYES-HEALTH-001 to EYES-HEALTH-006 | 6 | 0 | 0 | 5 |

**Summary:** 41 of 41 specs implemented; 0 deferred; 0 open. 39 carry a test `@spec` annotation; implemented without one: EYES-LOOK-004, EYES-HEALTH-005 (verified by glue, configuration or a test that cites a neighbouring ID). `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **OBS reconnects after any close** — `createObsLink` (`services/eyes/src/obs.ts`) starts a connect loop on `ConnectionClosed` unless one is already running or the link was stopped (EYES-OBS-004). obs-websocket-js 5.0.8 clears `identified` on close and has no reconnect of its own, and a failed connect attempt emits `ConnectionClosed` too, hence the running-loop guard.
2. **The heartbeat is `degraded` (obs down), not `starting`, while OBS is unreachable at boot** — each failed attempt calls `heartbeat.degraded` (EYES-HEALTH-006, R4).
3. **One shutdown sequence in both plans** — `stopEyes` clears the idle timer, stops the link and the bus; `index.ts` registers a single `onShutdown` (EYES-ENAB-005, R2).
4. **Disabled gate is correct and tested** — `startEyes` (`eyes.ts:86-94`, test `test/eyes.test.ts:70`) fixed the earlier bug where eyes connected to OBS with `vision.enabled=false` (463b1bb). Injection still works while disabled.
5. **Change detection is entirely model-driven** — the service trusts the literal word `SAME` (`eyes.ts:65`, prompt at `:35-37`); every interval costs a model call. `changed` is always `true` (`eyes.ts:71`) by contract (S14).
6. **One tracked `describe` is shared by loop and injection** — a bad injected image marks `ollama` down for the live heartbeat (`index.ts:56`, `:63`; `health.ts:17-19`); kept by decision (R4).
7. **Outbound calls are bounded** — the Ollama call aborts after `vision.timeout_ms` (EYES-DESC-006); the upload fetch aborts after `vision.upload_timeout_ms` and the body is cut off past `vision.upload_max_bytes` (SHARED-INJ-006, SHARED-INJ-007; R1). The `inject.request` subscription starts with `latest` after the group is created (EYES-INJ-014).
8. **`uploadUrl`/`INJECT_STALE_MS` shared** — one definition in `packages/shared/src/inject.ts`, imported by eyes, ears and chat (SHARED-INJ-008, owner decision of 2026-11-08); the former copies are deleted.
9. **Decisions evidenced** — LLD Decisions rows cite a comment, commit (463b1bb, 51d5a9c), archived OpenSpec design or the owner decision of 2026-11-01; change detection, OBS retry, prompt options and stay `[inferred]`; the shared-helper row cites the owner decision of 2026-11-08.

## Work Required

### Must Fix
None: all seven gap specs are implemented.

### Should Fix
None.

### Nice to Have
1. Add tests for the loop wiring, cadence, wrong-kind injection and redirect refusal (EYES-LOOK-003, SHARED-INJ-003, SHARED-INJ-005).
2. Make the system prompt, `num_predict`, `keep_alive` and JPEG quality configurable (EYES-DESC-001).
3. Add backoff to the OBS connect retries (EYES-OBS-002).
