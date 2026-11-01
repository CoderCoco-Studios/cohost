# Arrow: eyes

Visual sense: OBS screenshot -> Ollama vision model -> change-only `vision.summary`, plus uploaded-image test injection and a heartbeat.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited.

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/eyes/eyes-design.md

### EARS
- docs/intent/eyes/eyes-specs.md (39 specs: 37 `[x]`, 2 `[ ]`)

### Tests
- services/eyes/test/eyes.test.ts
- services/eyes/test/inject.test.ts
- services/eyes/test/health.test.ts

### Code
- services/eyes/src/index.ts
- services/eyes/src/eyes.ts
- services/eyes/src/inject.ts
- services/eyes/src/health.ts
- services/eyes/package.json, services/eyes/tsconfig.json

### OpenSpec
- openspec/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/eyes/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/eyes/spec.md

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
| Enablement | EYES-ENAB-001 to 004 | 4 | 0 | 0 |
| OBS connection and capture | EYES-OBS-001 to 008 | 7 | 0 | 1 |
| Vision description | EYES-DESC-001 to 005 | 5 | 0 | 0 |
| Look loop and publication | EYES-LOOK-001 to 005 | 5 | 0 | 0 |
| Test injection | EYES-INJ-001 to 011 | 11 | 0 | 0 |
| Health | EYES-HEALTH-001 to 006 | 5 | 0 | 1 |

**Summary:** 37 of 39 specs observed working; 2 gaps; 0 deferred. Untested: the whole loop/connect path (`index.ts`), polling cadence (LOOK-003), wrong-kind injection (INJ-004), redirect refusal (INJ-006 second half).

## Key Findings

1. **OBS never reconnects after a clean close** — `ConnectionClosed` only logs (`services/eyes/src/index.ts:77`); `loop` calls `look()` only while `obs.identified` (`:66`), and the sole reconnect is in the `catch` (`:68-69`), which cannot fire when `look()` is never called. The service then polls forever doing nothing; the only signal is `obs: down` in the heartbeat. Still present at 686cc8f. (EYES-OBS-004, EYES-LOOK-004)
2. **Heartbeat is `starting`, not `degraded`, while OBS is unreachable at boot** — `connectObs` only logs (`index.ts:35-37`); `degraded` is derived only after `ready` (`packages/bus/src/heartbeat.ts:69`). add-isolated-backends says SHOULD be `degraded` with `obs` down. (EYES-HEALTH-006)
3. **Disabled gate is correct and tested** — `startEyes` (`eyes.ts:82-90`, test `test/eyes.test.ts:65`) fixed the earlier bug where eyes connected to OBS with `vision.enabled=false` (463b1bb). Injection still works while disabled (`index.ts:57-60`).
4. **Change detection is entirely model-driven** — the service trusts the literal word `SAME` (`eyes.ts:62`, prompt at `:33-35`); `changed` is always `true` (`eyes.ts:68`); every interval costs a model call. `[inferred]`
5. **One tracked `describe` is shared by loop and injection** — a bad injected image can mark `ollama` down for the live heartbeat (`index.ts:53`, `:59`; `health.ts:16-18`).
6. **No timeouts or size limits on outbound fetches** — Ollama call (`eyes.ts:21`), upload fetch and `arrayBuffer` (`inject.ts:52-54`); a hung model blocks the serial loop.
7. **`uploadUrl`/`INJECT_STALE_MS` duplicated in ears** — `services/eyes/src/inject.ts:5,22` and `services/ears/src/inject.ts:6,20`. Candidate for a shared helper (`[inferred]`: SSRF-sensitive code should not drift).
8. **Hard-coded prompt and model options** — `eyes.ts:26-35`, JPEG quality 70 at `index.ts:48`; only `vision.model`, `interval_ms`, `obs.width` are configurable.

## Work Required

### Must Fix
1. Reconnect to OBS when the connection closes: trigger `connectObs` from `ConnectionClosed` or from the loop when `!obs.identified` (EYES-OBS-004, EYES-LOOK-004).

### Should Fix
1. Report `degraded` with `obs` down while OBS is unreachable at boot (EYES-HEALTH-006).
2. Add timeouts (and a body-size cap for uploads) to the Ollama and upload fetches (EYES-DESC-001, EYES-INJ-006).
3. Give injected describes their own health accounting, or document that they share `ollama` status (EYES-HEALTH-003).
4. Extract `uploadUrl` and the stale constant shared with ears into a common module (EYES-INJ-005).
5. Add tests for the loop/connect wiring, cadence, wrong-kind injection and redirect refusal (EYES-LOOK-003, EYES-INJ-004, EYES-INJ-006).

### Nice to Have
1. Make the system prompt, `num_predict`, `keep_alive` and JPEG quality configurable (EYES-DESC-001).
2. Make `changed` meaningful or drop it from the payload (EYES-LOOK-001).
3. Add backoff and a shutdown check to `connectObs` retries (EYES-OBS-002).
