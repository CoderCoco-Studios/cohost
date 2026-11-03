# Arrow: salience

The attention region: scores incoming senses, decides when the co-host should speak (`attention.focus`), and fires canned reflexes (`brain.say`) without an LLM.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 51 specs: 51 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes have landed (cascade-audit PR for brain-front).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **P3** Idle chatter on a fully silent stream → stays silent; idle chatter needs an unseen event (code and config comment win; README corrected; unprompted talk on a dead stream is a deferred goal). Specs: SAL-DECIDE-005 reworded.
2. **B11** Mute/pause during an in-flight scorer decision → re-check muted, paused and busy after the await; publish nothing if any holds. Specs: SAL-FOCUS-005 added.
3. **S31** Reflex self-gating → confirmed as SAL-REFLEX-007 states: start the cooldown and mark `speaking` at publish time, not on the echo. Specs: SAL-REFLEX-007 added.
4. **R1** Tick publish failure → log and continue. Specs: SAL-HEALTH-002 reworded.
5. **P8** Restart replay → start mode `latest` (group moved to the tail on every start; at-most-once). Specs: SAL-IN-001 rewritten.
6. **S32** Mute/pause lost on restart → accepted. Specs: SAL-CTRL-006 unchanged.
7. **R3** Startup failures at module load → all setup inside `main()` so `fatal` is logged. Specs: SAL-HEALTH-003 widened.
8. **S33** Thinking valve and `muted` → valve becomes `brain.salience.thinking_timeout_ms` (default 60000); cortex `muted` stays not busy. Specs: SAL-BUSY-001 rewritten; SAL-BUSY-004 reworded.
9. **S34** Reason `mentioned` → only when `reply_on_mention` is true. Specs: SAL-DECIDE-008 added; SAL-DECIDE-003 defers the label to it.
10. **S35** Subscribers in the llm scorer prompt → add a `sub` marker. Specs: SAL-SCORE-008 rewritten.
11. **R3** `ready` timing → after consumer-group creation. Specs: SAL-HEALTH-001 reworded.
12. **P7** Mute ownership (project-level) → only salience and cortex see mute/pause; LLD Decisions row added.

## References

### HLD
- docs/high-level-design.md (Segments table; Cross-cutting protocols: Turn-taking, Region hooks)

### LLD
- docs/intent/salience/salience-design.md

### EARS
- docs/intent/salience/salience-specs.md (51 specs, prefix `SAL`: 51 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests (39 annotated tests, 62 spec citations)
- services/salience/test/salience.region.test.ts (24 annotated: Salience class tick, in-flight decision re-check, busy valves, reflex and its self-gating, tick failure, control, injection)
- services/salience/test/salience.test.ts (7 annotated: scoring weights, score input, Reflexes, Scheduler)
- services/salience/test/scorer.test.ts (4 annotated: rules/http scorer validation against a local HTTP server, llm prompt against a fake OpenAI-compatible server)
- services/salience/test/health.test.ts (1 annotated: heartbeat sequence)
- services/salience/test/main.test.ts (3 annotated: startup wiring against a fake bus: start mode, `ready` after group creation, tick timer, `fatal` exit)

### Code (53 annotated lines, 59 spec citations)
- services/salience/src/salience.ts (31: intake, control, reflex gate and self-gating, busy valves, tick, failure handling and focus publication)
- services/salience/src/scheduler.ts (10: speak decision, reason label, score cache, scorer hook invocation)
- services/salience/src/scoring.ts (5: score input, rule weights, validation, `salience.scorer` module factory and llm prompt)
- services/salience/src/main.ts (5: heartbeat, scorer construction, subscription, tick timer, fatal exit)
- services/salience/src/reflex.ts (1: rule matching and per-rule cooldown)
- services/salience/src/health.ts (1: heartbeat spec)
- services/salience/src/index.ts, services/salience/package.json, services/salience/tsconfig.json (no annotations)

### Region-hooks invocation points
- Construction: `services/salience/src/main.ts` → `createScorer` (`scoring.ts:45`, SAL-SCORE-007)
- Invocation: `services/salience/src/scheduler.ts:54` → `scorer.run(...)` (SAL-SCORE-005; fallback owned by region-hooks)

### OpenSpec (retired, historical)
- openspec/specs/salience/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/salience/spec.md
- openspec/changes/archive/2026-11-01-add-service-control/specs/salience/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/salience/spec.md

## Architecture

**Purpose:** Decide when the co-host speaks, based on weighted scores of chat, voice and screen events, the cortex's busy state, a cooldown and the current mood; and short-circuit canned reactions around the LLM.

**Key Components:**
1. `Salience` (`salience.ts`) — event intake, cortex-state tracking, reflex gate, tick that publishes `attention.focus`.
2. `Scheduler` (`scheduler.ts`) — ordered speak/no-speak decision: muted, busy, cooldown, nothing new, threshold (arousal-adjusted), idle chatter; score cache.
3. `scoring.ts` — rule weights and the `salience.scorer` module factory (rules / llm / http, region-hooks).
4. `Reflexes` (`reflex.ts`) — regex rules with per-rule cooldown.
5. `index.ts` / `main.ts` / `health.ts` — entry point, startup wiring (`main`), tick timer, heartbeat spec.

Depends on event-bus, config, working-memory (`Context`, `propagatedFlags`), region-hooks (`Module`), control-plane (heartbeat contract); interacts with cortex (`attention.focus` out, `brain.status` in), affect (`affect.state` in), and the sense segments.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Intake | SAL-IN-001 to SAL-IN-006 | 6 | 0 | 0 | 3 |
| Scoring | SAL-SCORE-001 to SAL-SCORE-008 | 8 | 0 | 0 | 8 |
| Speak decision | SAL-DECIDE-001 to SAL-DECIDE-008 | 8 | 0 | 0 | 7 |
| Focus publication | SAL-FOCUS-001 to SAL-FOCUS-005 | 5 | 0 | 0 | 5 |
| Busy gating | SAL-BUSY-001 to SAL-BUSY-004 | 4 | 0 | 0 | 4 |
| Reflexes | SAL-REFLEX-001 to SAL-REFLEX-007 | 7 | 0 | 0 | 7 |
| Control | SAL-CTRL-001 to SAL-CTRL-006 | 6 | 0 | 0 | 5 |
| Injection flags | SAL-INJ-001 to SAL-INJ-004 | 4 | 0 | 0 | 4 |
| Health and lifecycle | SAL-HEALTH-001 to SAL-HEALTH-003 | 3 | 0 | 0 | 3 |

**Summary:** 51 of 51 specs implemented; 0 deferred; 0 gaps. 46 spec lines have a test annotation. Implemented specs with no test: SAL-IN-002, SAL-IN-003, SAL-IN-006, SAL-DECIDE-005, SAL-CTRL-006. No reverse orphans (every `SAL-*` ID cited in code or tests exists in the spec file).

## Key Findings

1. **Markers hold against the code.** All 51 lines are implemented as written. A reflex now starts the cooldown and marks `speaking` before it publishes (`salience.ts:99-101`); `Salience.tick()` catches and logs its own failures, so the timer never leaves a rejection unhandled. A failed reflex publish is not fatal, because the bus catches and logs handler errors (`packages/bus/src/index.ts`).
2. **Spec wording matches code where the decision confirmed it.** SAL-FOCUS-003: the bus schema fills a missing `mention` with false (`packages/bus/src/events.ts:85`; asserted at `test/salience.region.test.ts:44,49`). SAL-DECIDE-005: a fully silent stream stays silent. SAL-BUSY-004: cortex `muted` is not busy. SAL-CTRL-006: mute and pause are not persisted.
3. **A decision made before a mute, pause or busy cortex does not publish** (SAL-FOCUS-005; `salience.ts:127`). Its events stay unseen, with their scores cached. Only llm/http scorers open the window.
4. **Restart skips the backlog.** `main.ts` names start mode `latest`, so the `salience` group moves to the tail on every start (SAL-IN-001; P8).
5. **README weights match the code.** `README.md` ("Talkativeness") and `config/config.example.yaml:68` quote mention 1.0, voice 0.9, question 0.55, mod/sub 0.35, screen 0.3, plain 0.15, threshold 0.6; these equal `scoring.ts:27-34` and the schema defaults (`packages/config/src/schema.ts:103-111`), asserted in `test/salience.test.ts:34`. The README does not say the total is a sum over all unseen events (`scheduler.ts:57-64`), and its idle-chatter sentence reads unconditional (P3; README is outside this segment).
6. **Startup runs inside `main()` and `ready` follows group creation** (SAL-HEALTH-001, SAL-HEALTH-003; R3). `Bus.subscribe` has no readiness signal, so `main()` awaits `bus.resetGroup("salience")` before starting the subscription; a readiness signal in event-bus would make that call unnecessary (Decisions row "Readiness signal").
7. **Decisions cite evidence or an owner decision.** LLD rows are settled by code comments, commit `969f6d7` ("Fix review findings"), the archived OpenSpec designs or the 2026-11-01 owner decisions; two keep a partial `[inferred]` (why sum not max, the 0.1 threshold floor) and the 60 s valve default value is `[inferred]`.
8. **Test gaps.** Five implemented specs have no test (listed in the summary). Some annotated tests cover only part of their line: SAL-REFLEX-003 (rule order), SAL-REFLEX-005 (rule cooldown not spent), SAL-INJ-002 (no-focus case), SAL-DECIDE-006 (reason text), SAL-BUSY-004 (`muted`).

## Work Required

### Must Fix
None.

### Should Fix
None.

### Nice to Have
1. Add tests for the five untested implemented specs and the partial cases in Key Finding 8.
2. Remove the duplicated cooldown check in `Scheduler.decide` (`scheduler.ts:45` vs `cooling()` at `:34-36`).
3. Once event-bus offers a readiness signal for `subscribe`, drop the `resetGroup` call that `main.ts` makes only to know the group exists.
