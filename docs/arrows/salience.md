# Arrow: salience

The attention region: scores incoming senses, decides when the co-host should speak (`attention.focus`), and fires canned reflexes (`brain.say`) without an LLM.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 43 of 45 specs observed working; 2 gaps recorded (reflex self-cooldown, unhandled rejections).

## References

### HLD
- docs/high-level-design.md (Services table; Cross-cutting protocols: Turn-taking, Region hooks)

### LLD
- docs/intent/salience/salience-design.md

### EARS
- docs/intent/salience/salience-specs.md (45 specs, prefix `SAL`)

### Tests
- services/salience/test/salience.test.ts (scoring weights, Reflexes, Scheduler)
- services/salience/test/salience.region.test.ts (Salience class: tick, busy, reflex, control, injection)
- services/salience/test/scorer.test.ts (llm/http scorer validation against a local HTTP server)
- services/salience/test/health.test.ts (heartbeat sequence)

### Code
- services/salience/src/index.ts
- services/salience/src/salience.ts
- services/salience/src/scheduler.ts
- services/salience/src/scoring.ts
- services/salience/src/reflex.ts
- services/salience/src/health.ts
- services/salience/package.json, services/salience/tsconfig.json

### OpenSpec
- openspec/specs/salience/spec.md
- openspec/changes/add-service-health/specs/salience/spec.md
- openspec/changes/add-service-control/specs/salience/spec.md
- openspec/changes/add-test-injection/specs/salience/spec.md

## Architecture

**Purpose:** Decide when the co-host speaks, based on weighted scores of chat, voice and screen events, the cortex's busy state, a cooldown and the current mood; and short-circuit canned reactions around the LLM.

**Key Components:**
1. `Salience` (`salience.ts`) — event intake, cortex-state tracking, reflex gate, tick that publishes `attention.focus`.
2. `Scheduler` (`scheduler.ts`) — ordered speak/no-speak decision: muted, busy, cooldown, nothing new, threshold (arousal-adjusted), idle chatter; score cache.
3. `scoring.ts` — rule weights and the `salience.scorer` module factory (rules / llm / http, region-hooks).
4. `Reflexes` (`reflex.ts`) — regex rules with per-rule cooldown.
5. `index.ts` / `health.ts` — wiring, tick timer, heartbeat spec.

Depends on event-bus, config, working-memory (`Context`, `propagatedFlags`), region-hooks (`Module`), control-plane (heartbeat contract); interacts with cortex (`attention.focus` out, `brain.status` in), affect (`affect.state` in), and the sense segments.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Intake | SAL-IN-001 to SAL-IN-005 | 5 | 0 | 0 |
| Scoring | SAL-SCORE-001 to SAL-SCORE-006 | 6 | 0 | 0 |
| Speak decision | SAL-DECIDE-001 to SAL-DECIDE-007 | 7 | 0 | 0 |
| Focus publication | SAL-FOCUS-001 to SAL-FOCUS-004 | 4 | 0 | 0 |
| Busy gating | SAL-BUSY-001 to SAL-BUSY-004 | 4 | 0 | 0 |
| Reflexes | SAL-REFLEX-001 to SAL-REFLEX-007 | 6 | 0 | 1 |
| Control | SAL-CTRL-001 to SAL-CTRL-005 | 5 | 0 | 0 |
| Injection flags | SAL-INJ-001 to SAL-INJ-004 | 4 | 0 | 0 |
| Health and lifecycle | SAL-HEALTH-001 to SAL-HEALTH-003 | 2 | 0 | 1 |

**Summary:** 43 of 45 specs implemented; 0 deferred; 2 gaps (SAL-REFLEX-007, SAL-HEALTH-002).

## Key Findings

1. **README weights match the code.** `README.md` ("Talkativeness") and `config.example.yaml:68` quote mention 1.0, voice 0.9, question 0.55, mod/sub 0.35, screen 0.3, plain 0.15, threshold 0.6; these equal `scoring.ts:27-34` and the schema defaults (`packages/config/src/schema.ts:98-110`), asserted in `test/salience.test.ts:34`. Total is a SUM over all unseen events (`scheduler.ts:57-65`), which the README does not say.
2. **Idle chatter requires fresh context.** `scheduler.ts:47-48` returns `nothing new` before the idle branch at `:71-73`, so a silent stream never triggers it. `config.example.yaml:66` documents "and there's fresh context", README reads unconditional. Recorded as an open question, not a bug (SAL-DECIDE-005).
3. **Reflex path does not record its own line locally.** `salience.ts:98` publishes `brain.say` without `noteSpoke()` / cortex `speaking`; both only happen when the echo is consumed (`salience.ts:59-64`), leaving a small window for a tick or second rule to fire (SAL-REFLEX-007).
4. **Unhandled rejections and uncleared timer.** `void salience.tick()` and `void bus.subscribe(...)` (`index.ts:28,36`) discard promises; there is no `unhandledRejection` handler in the repo, so a Redis blip can kill the process and lose in-memory state (muted/paused/score cache) until compose restarts it. The `setInterval` is never cleared (`index.ts:36,42`) but `onShutdown` ends in `process.exit(0)` so it is cosmetic (SAL-HEALTH-002).
5. **Cross-region config coupling and a hard-coded valve.** `busy()` hard-codes 60 s for `thinking` (`salience.ts:104`) and reads the cortex's `speaking_timeout_ms` for `speaking` (`salience.ts:105`). `brain.status muted` is treated as not busy (`salience.ts:104-106`). Salience does not subscribe to `voice.playing` / `voice.done`.
6. **Pause/mute are silent and in-memory.** No status is published on pause or mute (`salience.ts:74-83`); on resume the first decision scores everything that accumulated during the pause. State is not persisted across restarts.
7. **LLM scorer prompt drops `isSub`** (`scoring.ts:55`) though the rules treat subs as 0.35 (`scoring.ts:31`) `[inferred]` oversight.
8. **Test gaps.** No test for the 60 s thinking valve, arousal forwarded to the scorer, `index.ts` wiring, or the llm prompt text; region tests use real timers.

## Work Required

### Must Fix
1. Handle rejections from the tick timer and the un-awaited `bus.subscribe` so a transient publish/Redis failure does not take the service down (SAL-HEALTH-002).

### Should Fix
2. Have the reflex path start the cooldown and mark the voice busy locally at publish time (SAL-REFLEX-007).
3. Decide and document the idle-chatter-on-silence behavior (README vs `config.example.yaml:66` vs code) (SAL-DECIDE-004, SAL-DECIDE-005).
4. Make the 60 s `thinking` valve configurable or document it; decide whether `brain.status muted` should gate (SAL-BUSY-001, SAL-BUSY-004).

### Nice to Have
5. Clear the tick `setInterval` in the shutdown callback (SAL-FOCUS-001).
6. Add `isSub` to the llm scorer prompt; add tests for the 60 s valve and index wiring (SAL-SCORE-001, SAL-BUSY-001, SAL-IN-001).
7. Remove the duplicated cooldown check in `Scheduler.decide` (SAL-DECIDE-001).
