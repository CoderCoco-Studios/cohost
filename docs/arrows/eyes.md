# Arrow: eyes

Visual sense: OBS screenshot -> Ollama vision model -> change-only `vision.summary`, plus uploaded-image test injection and a heartbeat.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 44 specs: 37 implemented, 0 deferred, 7 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S13** Reconnect to OBS → after any close, including a clean one. Specs: EYES-OBS-004 (`[ ]`, reworded), EYES-LOOK-004 (reworded).
2. **R4** Boot health while OBS is unreachable → `degraded` with `obs: down`. Specs: EYES-HEALTH-006 (`[ ]`).
3. **R4** Shared tracked describer → keep; an injected failure marks `ollama` down. Specs: EYES-HEALTH-003 (reworded, `[x]`).
4. **R2** Shutdown with vision disabled → one shutdown sequence that stops the bus and sends `stopping`. Specs: EYES-ENAB-005 (new, `[ ]`); EYES-OBS-008 stays `[x]` for the enabled plan.
5. **R1** Timeouts and upload cap → configured timeouts on the describe call and the upload fetch, configured maximum upload size. Specs: EYES-DESC-006, EYES-INJ-012, EYES-INJ-013 (new, `[ ]`).
6. **S14** `vision.summary.changed` → keep, always `true` because eyes publishes only changes. Specs: EYES-LOOK-001 (reworded).
7. **P8** Restart replay → `inject.request` subscription uses start mode `latest`. Specs: EYES-INJ-014 (new, `[ ]`), EYES-INJ-001 (reworded).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/eyes/eyes-design.md

### EARS
- docs/intent/eyes/eyes-specs.md (44 specs: 37 `[x]`, 7 `[ ]`, 0 `[D]`)

### Tests
- services/eyes/test/eyes.test.ts
- services/eyes/test/inject.test.ts
- services/eyes/test/health.test.ts

17 `@spec` annotations in tests, citing 22 distinct spec IDs.

### Code
- services/eyes/src/index.ts
- services/eyes/src/eyes.ts
- services/eyes/src/inject.ts
- services/eyes/src/health.ts
- services/eyes/package.json, services/eyes/tsconfig.json

14 `@spec` annotations in code, citing all 37 `[x]` spec IDs. No annotation cites a missing or non-`[x]` ID.

### OpenSpec (frozen, historical)
- openspec/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/eyes/spec.md (rationale: `.../add-isolated-backends/design.md` D7)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/eyes/spec.md (rationale: `.../add-test-injection/design.md` D2, D8)

## Architecture

**Purpose:** Every `vision.interval_ms`, capture an OBS source, ask a local vision model for one sentence, and publish it as `vision.summary` only when the model says something changed. Inert (but injectable) when `vision.enabled` is false.

**Key Components:**
1. `index.ts` — composition root: OBS connect/retry loop, screenshot call, polling loop, injection subscription, heartbeat start. Untested.
2. `eyes.ts` — `Eyes.look()` change-only publisher, `ollamaDescriber`, `stripDataUrl`, `startEyes` enablement gate.
3. `inject.ts` — `createInjectHandler` + `uploadUrl` SSRF guard for `inject.request` images (duplicated in ears).
4. `health.ts` — `EyesHealth` (mode off/live, deps `obs`/`ollama`, `track()` wrapper).

Depends on `event-bus`, `config`, `control-plane` (heartbeat). Calls Ollama and OBS directly. Fetches uploads from `dashboard`. Consumed by `salience`, `affect`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Enablement | EYES-ENAB-001 to 005 | 4 | 0 | 1 (ENAB-005) |
| OBS connection and capture | EYES-OBS-001 to 008 | 7 | 0 | 1 (OBS-004) |
| Vision description | EYES-DESC-001 to 006 | 5 | 0 | 1 (DESC-006) |
| Look loop and publication | EYES-LOOK-001 to 005 | 5 | 0 | 0 |
| Test injection | EYES-INJ-001 to 014 | 11 | 0 | 3 (INJ-012 to 014) |
| Health | EYES-HEALTH-001 to 006 | 5 | 0 | 1 (HEALTH-006) |

**Summary:** 37 of 44 specs implemented; 7 gaps (EYES-ENAB-005, EYES-OBS-004, EYES-DESC-006, EYES-INJ-012, EYES-INJ-013, EYES-INJ-014, EYES-HEALTH-006); 0 deferred. 22 of the 37 implemented specs have a test citing them. The 15 without a test are the `index.ts` wiring (EYES-ENAB-002, EYES-ENAB-004, EYES-OBS-001 to 003, EYES-OBS-005, EYES-OBS-006, EYES-OBS-008, EYES-LOOK-003 to 005, EYES-INJ-001, EYES-HEALTH-005) plus EYES-DESC-005 (prompt text) and EYES-INJ-004 (wrong kind). The redirect half of EYES-INJ-006 is also untested.

## Key Findings

1. **OBS never reconnects after a close** — `ConnectionClosed` only logs (`services/eyes/src/index.ts:82`); `loop` calls `look()` only while `obs.identified` (`:71`); the only reconnect is in the `catch` (`:73-74`), which cannot fire when `look()` is never called. obs-websocket-js 5.0.8 clears `identified` on close and has no reconnect. The service then polls forever doing nothing; the only signal is `obs: down` in the heartbeat. (EYES-OBS-004, S13)
2. **Heartbeat is `starting`, not `degraded`, while OBS is unreachable at boot** — `connectObs` only logs (`index.ts:36-38`); `degraded` is derived only after `ready` (`packages/bus/src/heartbeat.ts:71`). (EYES-HEALTH-006, R4)
3. **Shutdown with vision disabled skips `bus.stop()`** — two `onShutdown` handlers (`index.ts:90`, `:94`) each exit the process (`packages/bus/src/index.ts:242-256`); the idle-timer one exits first. Found by reading; no test. EYES-OBS-008 covers the enabled plan; EYES-ENAB-005 is the disabled-plan gap. (R2)
4. **Disabled gate is correct and tested** — `startEyes` (`eyes.ts:86-94`, test `test/eyes.test.ts:70`) fixed the earlier bug where eyes connected to OBS with `vision.enabled=false` (463b1bb). Injection still works while disabled (`index.ts:61-64`).
5. **Change detection is entirely model-driven** — the service trusts the literal word `SAME` (`eyes.ts:65`, prompt at `:35-37`); every interval costs a model call. `changed` is always `true` (`eyes.ts:71`) by contract (S14).
6. **One tracked `describe` is shared by loop and injection** — a bad injected image marks `ollama` down for the live heartbeat (`index.ts:56`, `:63`; `health.ts:17-19`); kept by decision (R4).
7. **No timeouts or size limits on outbound fetches** — Ollama call (`eyes.ts:23`), upload fetch and `arrayBuffer` (`inject.ts:54-56`); a hung model blocks the serial loop. (EYES-DESC-006, EYES-INJ-012, EYES-INJ-013; R1)
8. **`uploadUrl`/`INJECT_STALE_MS` duplicated in ears** — `services/eyes/src/inject.ts:5,23` and `services/ears/src/inject.ts:6,21`; no comment or commit explains the copy.
9. **Decisions evidenced** — LLD Decisions rows cite a comment, commit (463b1bb, 51d5a9c), archived OpenSpec design or the owner decision of 2026-11-01; change detection, OBS retry, prompt options and helper duplication stay `[inferred]`.

## Work Required

### Must Fix
1. Reconnect to OBS when the connection closes: trigger `connectObs` from `ConnectionClosed` or from the loop when `!obs.identified` (EYES-OBS-004, S13).
2. Add a configured timeout to the Ollama describe call and the upload fetch, and a configured maximum upload size (EYES-DESC-006, EYES-INJ-012, EYES-INJ-013, R1); the config keys need a config-segment line.
3. One shutdown sequence in the disabled plan, relying on the bus's composed `onShutdown` (EYES-ENAB-005, R2).
4. Report `degraded` with `obs` down while OBS is unreachable at boot (EYES-HEALTH-006, R4).
5. Subscribe `inject.request` with start mode `latest` once the bus offers it (EYES-INJ-014, P8).

### Should Fix
6. Extract `uploadUrl` and the stale constant shared with ears into a common module (EYES-INJ-005).

### Nice to Have
7. Add tests for the loop/connect wiring, reconnect, cadence, wrong-kind injection and redirect refusal (EYES-OBS-004, EYES-LOOK-003, EYES-INJ-004, EYES-INJ-006).
8. Make the system prompt, `num_predict`, `keep_alive` and JPEG quality configurable (EYES-DESC-001).
9. Add backoff and a shutdown check to `connectObs` retries (EYES-OBS-002).
