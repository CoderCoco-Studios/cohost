# Arrow: eyes

Visual sense: OBS screenshot -> Ollama vision model -> change-only `vision.summary`, plus uploaded-image test injection and a heartbeat.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **EYES-OBS-004: should eyes reconnect to OBS after any close, including a clean one?** Today a close leaves `obs.identified` false, `loop` skips `look()` (`services/eyes/src/index.ts:71`), the only reconnect is in the look `catch` (`:74`), and `ConnectionClosed` only logs (`:82`); obs-websocket-js 5.0.8 does not reconnect by itself. The OpenSpec only required a reconnect after a failed look, so the broader intent is `[inferred]`. Recommended: yes, reconnect on `ConnectionClosed`.
2. **EYES-HEALTH-006: should eyes report `degraded` with `obs: down` while OBS is unreachable at boot?** It stays `starting` because `connectObs` never calls `heartbeat.degraded` (`services/eyes/src/index.ts:36-38`) and the shared heartbeat derives `degraded` only after `ready` (`packages/bus/src/heartbeat.ts:69`). add-isolated-backends said SHOULD. Recommended: yes.
3. **EYES-HEALTH-003: should a failed injected-image describe mark the live `ollama` dependency down?** The loop and the inject handler share one tracked describer (`services/eyes/src/index.ts:56`, `:63`). Recommended: keep it shared (same backend) and leave the spec as written.
4. **EYES-OBS-008: should shutdown with `vision.enabled: false` stop the bus and reliably send `stopping`?** That plan registers two `onShutdown` handlers (`services/eyes/src/index.ts:90`, `:94`); the idle-timer one exits first, skipping `bus.stop()` and racing the `stopping` heartbeat (`packages/bus/src/index.ts:230-246`). EYES-OBS-008 is now scoped to `vision.enabled: true`. Recommended: yes; use a single shutdown handler and widen the spec back.
5. **Should outbound fetches get timeouts and a size cap?** Neither the Ollama call (`services/eyes/src/eyes.ts:23`) nor the upload fetch (`services/eyes/src/inject.ts:54-56`) has a timeout, and uploads have no size cap; a hung model stalls the serial loop. No spec covers this. Recommended: yes, add spec lines for both.
6. **Is `vision.summary.changed` meant to carry information?** Eyes always sends `changed: true` (`services/eyes/src/eyes.ts:71`). Recommended: keep the field and state in the spec that eyes only publishes changes.

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/eyes/eyes-design.md

### EARS
- docs/intent/eyes/eyes-specs.md (39 specs: 37 `[x]`, 2 `[ ]`, 0 `[D]`)

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
| Enablement | EYES-ENAB-001 to 004 | 4 | 0 | 0 |
| OBS connection and capture | EYES-OBS-001 to 008 | 7 | 0 | 1 |
| Vision description | EYES-DESC-001 to 005 | 5 | 0 | 0 |
| Look loop and publication | EYES-LOOK-001 to 005 | 5 | 0 | 0 |
| Test injection | EYES-INJ-001 to 011 | 11 | 0 | 0 |
| Health | EYES-HEALTH-001 to 006 | 5 | 0 | 1 |

**Summary:** 37 of 39 specs implemented; 2 gaps (EYES-OBS-004, EYES-HEALTH-006); 0 deferred. 22 of the 37 implemented specs have a test citing them. The 15 without a test are the `index.ts` wiring (EYES-ENAB-002, EYES-ENAB-004, EYES-OBS-001 to 003, EYES-OBS-005, EYES-OBS-006, EYES-OBS-008, EYES-LOOK-003 to 005, EYES-INJ-001, EYES-HEALTH-005) plus EYES-DESC-005 (prompt text) and EYES-INJ-004 (wrong kind). The redirect half of EYES-INJ-006 is also untested.

## Key Findings

1. **OBS never reconnects after a close (gap confirmed against the library)** — `ConnectionClosed` only logs (`services/eyes/src/index.ts:82`); `loop` calls `look()` only while `obs.identified` (`:71`); the only reconnect is in the `catch` (`:73-74`), which cannot fire when `look()` is never called. obs-websocket-js 5.0.8 clears `identified` on close and has no reconnect. The service then polls forever doing nothing; the only signal is `obs: down` in the heartbeat. (EYES-OBS-004, EYES-LOOK-004; Question 1)
2. **Heartbeat is `starting`, not `degraded`, while OBS is unreachable at boot** — `connectObs` only logs (`index.ts:36-38`); `degraded` is derived only after `ready` (`packages/bus/src/heartbeat.ts:69`). (EYES-HEALTH-006; Question 2)
3. **EYES-OBS-008 narrowed to `vision.enabled: true`** — with vision disabled, two `onShutdown` handlers race (`index.ts:90`, `:94`) and the idle-timer one exits before `bus.stop()` runs. Found by reading `packages/bus/src/index.ts:230-246`; no test. No marker flipped. (Question 4)
4. **Disabled gate is correct and tested** — `startEyes` (`eyes.ts:86-94`, test `test/eyes.test.ts:70`) fixed the earlier bug where eyes connected to OBS with `vision.enabled=false` (463b1bb). Injection still works while disabled (`index.ts:61-64`).
5. **Change detection is entirely model-driven** — the service trusts the literal word `SAME` (`eyes.ts:65`, prompt at `:35-37`); `changed` is always `true` (`eyes.ts:71`); every interval costs a model call. `[inferred]`
6. **One tracked `describe` is shared by loop and injection** — a bad injected image can mark `ollama` down for the live heartbeat (`index.ts:56`, `:63`; `health.ts:17-19`). (Question 3)
7. **No timeouts or size limits on outbound fetches** — Ollama call (`eyes.ts:23`), upload fetch and `arrayBuffer` (`inject.ts:54-56`); a hung model blocks the serial loop. (Question 5)
8. **`uploadUrl`/`INJECT_STALE_MS` duplicated in ears** — `services/eyes/src/inject.ts:5,23` and `services/ears/src/inject.ts:6,21`; no comment or commit explains the copy.
9. **Decisions evidenced; stale external references** — four of nine LLD Decisions rows now cite a comment, commit (463b1bb, 51d5a9c) or archived OpenSpec design instead of `[inferred]`. The `@spec` lines shift `services/eyes/src/index.ts` and `eyes.ts`; references owned by other segments need a refresh: `docs/intent/config/config-design.md:61`, `docs/intent/event-bus/event-bus-design.md:159,173`, `docs/intent/event-bus/event-bus-specs.md:59`, `docs/intent/deployment/deployment-specs.md:77`, `docs/arrows/event-bus.md:69`.

## Work Required

### Must Fix
1. Reconnect to OBS when the connection closes: trigger `connectObs` from `ConnectionClosed` or from the loop when `!obs.identified` (EYES-OBS-004, EYES-LOOK-004), once Question 1 is answered.

### Should Fix
1. Report `degraded` with `obs` down while OBS is unreachable at boot (EYES-HEALTH-006).
2. Add timeouts (and a body-size cap for uploads) to the Ollama and upload fetches (EYES-DESC-001, EYES-INJ-006).
3. Use one `onShutdown` handler in both plans so `bus.stop()` and the `stopping` heartbeat are not cut off (EYES-OBS-008).
4. Extract `uploadUrl` and the stale constant shared with ears into a common module (EYES-INJ-005).
5. Add tests for the loop/connect wiring, cadence, wrong-kind injection and redirect refusal (EYES-LOOK-003, EYES-INJ-004, EYES-INJ-006).

### Nice to Have
1. Make the system prompt, `num_predict`, `keep_alive` and JPEG quality configurable (EYES-DESC-001).
2. Make `changed` meaningful or drop it from the payload (EYES-LOOK-001).
3. Add backoff and a shutdown check to `connectObs` retries (EYES-OBS-002).
