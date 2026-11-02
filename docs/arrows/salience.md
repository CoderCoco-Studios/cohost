# Arrow: salience

The attention region: scores incoming senses, decides when the co-host should speak (`attention.focus`), and fires canned reflexes (`brain.say`) without an LLM.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 51 specs: 42 implemented, 0 deferred, 9 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **P3** Idle chatter on a fully silent stream → stays silent; idle chatter needs an unseen event (code and config comment win; README corrected; unprompted talk on a dead stream is a deferred goal). Specs: SAL-DECIDE-005 reworded.
2. **B11** Mute/pause during an in-flight scorer decision → re-check muted, paused and busy after the await; publish nothing if any holds. Specs: SAL-FOCUS-005 added.
3. **S31** Reflex self-gating → confirmed as SAL-REFLEX-007 states: start the cooldown and mark `speaking` at publish time, not on the echo. Specs: SAL-REFLEX-007 kept as a gap.
4. **R1** Tick publish failure → log and continue. Specs: SAL-HEALTH-002 reworded.
5. **P8** Restart replay → start mode `latest` (group moved to the tail on every start; at-most-once). Specs: SAL-IN-001 rewritten, `[x]` → `[ ]`.
6. **S32** Mute/pause lost on restart → accepted. Specs: SAL-CTRL-006 unchanged.
7. **R3** Startup failures at module load → all setup inside `main()` so `fatal` is logged. Specs: SAL-HEALTH-003 widened, `[x]` → `[ ]`.
8. **S33** Thinking valve and `muted` → valve becomes `brain.salience.thinking_timeout_ms` (default 60000); cortex `muted` stays not busy. Specs: SAL-BUSY-001 `[x]` → `[ ]`; SAL-BUSY-004 reworded.
9. **S34** Reason `mentioned` → only when `reply_on_mention` is true. Specs: SAL-DECIDE-008 added; SAL-DECIDE-003 defers the label to it.
10. **S35** Subscribers in the llm scorer prompt → add a `sub` marker. Specs: SAL-SCORE-008 `[x]` → `[ ]`.
11. **R3** `ready` timing → after consumer-group creation. Specs: SAL-HEALTH-001 `[x]` → `[ ]`.
12. **P7** Mute ownership (project-level) → only salience and cortex see mute/pause; LLD Decisions row added.

## References

### HLD
- docs/high-level-design.md (Segments table; Cross-cutting protocols: Turn-taking, Region hooks)

### LLD
- docs/intent/salience/salience-design.md

### EARS
- docs/intent/salience/salience-specs.md (51 specs, prefix `SAL`: 42 `[x]`, 9 `[ ]`, 0 `[D]`)

### Tests (28 annotated tests, 50 spec citations)
- services/salience/test/salience.region.test.ts (17 annotated: Salience class tick, busy, reflex, control, injection)
- services/salience/test/salience.test.ts (7 annotated: scoring weights, score input, Reflexes, Scheduler)
- services/salience/test/scorer.test.ts (3 annotated: rules/http scorer validation against a local HTTP server)
- services/salience/test/health.test.ts (1 annotated: heartbeat sequence)

### Code (49 annotated lines, 55 spec citations)
- services/salience/src/salience.ts (28: intake, control, reflex gate, busy valves, tick and focus publication)
- services/salience/src/scheduler.ts (9: speak decision, score cache, scorer hook invocation)
- services/salience/src/scoring.ts (5: score input, rule weights, validation, `salience.scorer` module factory and llm prompt)
- services/salience/src/index.ts (5: heartbeat, scorer construction, subscription, tick timer, fatal exit)
- services/salience/src/reflex.ts (1: rule matching and per-rule cooldown)
- services/salience/src/health.ts (1: heartbeat spec)
- services/salience/package.json, services/salience/tsconfig.json (no annotations)

### Region-hooks invocation points
- Construction: `services/salience/src/index.ts:24` → `createScorer` (`scoring.ts:45`, SAL-SCORE-007)
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
5. `index.ts` / `health.ts` — wiring, tick timer, heartbeat spec.

Depends on event-bus, config, working-memory (`Context`, `propagatedFlags`), region-hooks (`Module`), control-plane (heartbeat contract); interacts with cortex (`attention.focus` out, `brain.status` in), affect (`affect.state` in), and the sense segments.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Intake | SAL-IN-001 to SAL-IN-006 | 5 | 0 | 1 (IN-001) | 2 |
| Scoring | SAL-SCORE-001 to SAL-SCORE-008 | 7 | 0 | 1 (SCORE-008) | 7 |
| Speak decision | SAL-DECIDE-001 to SAL-DECIDE-008 | 7 | 0 | 1 (DECIDE-008) | 6 |
| Focus publication | SAL-FOCUS-001 to SAL-FOCUS-005 | 4 | 0 | 1 (FOCUS-005) | 3 |
| Busy gating | SAL-BUSY-001 to SAL-BUSY-004 | 3 | 0 | 1 (BUSY-001) | 4 |
| Reflexes | SAL-REFLEX-001 to SAL-REFLEX-007 | 6 | 0 | 1 (REFLEX-007) | 6 |
| Control | SAL-CTRL-001 to SAL-CTRL-006 | 6 | 0 | 0 | 5 |
| Injection flags | SAL-INJ-001 to SAL-INJ-004 | 4 | 0 | 0 | 4 |
| Health and lifecycle | SAL-HEALTH-001 to SAL-HEALTH-003 | 0 | 0 | 3 (HEALTH-001, 002, 003) | 1 |

**Summary:** 42 of 51 specs implemented; 0 deferred; 9 gaps (SAL-IN-001, SAL-SCORE-008, SAL-DECIDE-008, SAL-FOCUS-005, SAL-BUSY-001, SAL-REFLEX-007, SAL-HEALTH-001, SAL-HEALTH-002, SAL-HEALTH-003). 38 spec lines have a test annotation. Five gaps (SAL-IN-001, SAL-SCORE-008, SAL-BUSY-001, SAL-HEALTH-001, SAL-HEALTH-003) are earlier `[x]` lines rewritten to the decided behaviour; their code annotations stay on the current implementation until the fix lands under the same ID. Implemented specs with no test: SAL-IN-002, SAL-IN-003, SAL-IN-006, SAL-DECIDE-005, SAL-FOCUS-001, SAL-CTRL-006. No reverse orphans (every `SAL-*` ID cited in code or tests exists in the spec file).

## Key Findings

1. **Markers hold against the code.** All 42 `[x]` lines are implemented as written; the nine gaps are real today: the reflex path never calls `noteSpoke()` (`salience.ts:98`), `void salience.tick()` (`index.ts:36`) leaves publish rejections unhandled, and the five rewritten lines describe decided behaviour the code does not have yet. A failed reflex publish is not fatal, because the bus catches and logs handler errors (`packages/bus/src/index.ts:160-166`).
2. **Spec wording matches code where the decision confirmed it.** SAL-FOCUS-003: the bus schema fills a missing `mention` with false (`packages/bus/src/events.ts:85`; asserted at `test/salience.region.test.ts:44,49`). SAL-DECIDE-005: a fully silent stream stays silent. SAL-BUSY-004: cortex `muted` is not busy. SAL-CTRL-006: mute and pause are not persisted.
3. **Mute or pause during an async decision does not stop it** (`salience.ts:110-131`); reproduced with a gated scorer. Only llm/http scorers open the window. SAL-FOCUS-005 (B11).
4. **A crash restart replays the backlog.** Compose restarts resume the `salience` consumer group; only control-plane `fresh` starts (`packages/control/src/manifest.ts:41`) skip input published while down. SAL-IN-001 (P8).
5. **README weights match the code.** `README.md` ("Talkativeness") and `config/config.example.yaml:68` quote mention 1.0, voice 0.9, question 0.55, mod/sub 0.35, screen 0.3, plain 0.15, threshold 0.6; these equal `scoring.ts:27-34` and the schema defaults (`packages/config/src/schema.ts:103-111`), asserted in `test/salience.test.ts:34`. The README does not say the total is a sum over all unseen events (`scheduler.ts:57-64`), and its idle-chatter sentence reads unconditional (P3; README is outside this segment).
6. **Startup failures bypass the `fatal` handler.** Construction runs at module load (`index.ts:20-25`), outside `main().catch`. SAL-HEALTH-003 (R3).
7. **Decisions cite evidence or an owner decision.** LLD rows are settled by code comments, commit `969f6d7` ("Fix review findings"), the archived OpenSpec designs or the 2026-11-01 owner decisions; two keep a partial `[inferred]` (why sum not max, the 0.1 threshold floor) and the 60 s valve default value is `[inferred]`.
8. **Test gaps.** Six implemented specs have no test (listed in the summary). Some annotated tests cover only part of their line: SAL-BUSY-001 (60 s expiry untested), SAL-REFLEX-003 (rule order), SAL-REFLEX-005 (rule cooldown not spent), SAL-INJ-002 (no-focus case), SAL-DECIDE-006 (reason text), SAL-BUSY-004 (`muted`).

## Work Required

### Must Fix
1. Log and continue on a failed tick or `attention.focus` publish (SAL-HEALTH-002; R1).
2. Re-check muted, paused and busy after the scorer returns and drop the focus if any holds (SAL-FOCUS-005; B11).
3. Subscribe in start mode `latest` once event-bus provides it (SAL-IN-001; P8).
4. Move all startup into `main()` and signal `ready` after the consumer group exists (SAL-HEALTH-003, SAL-HEALTH-001; R3).

### Should Fix
5. Start the cooldown and mark `speaking` locally when a reflex publishes (SAL-REFLEX-007; S31).
6. Add `brain.salience.thinking_timeout_ms` (default 60000) and read it for the thinking valve (SAL-BUSY-001; S33; the schema key is a config-segment change).
7. Label `mentioned` only when `reply_on_mention` is true (SAL-DECIDE-008; S34).
8. Add a `sub` marker to the llm scorer prompt (SAL-SCORE-008; S35).

### Nice to Have
9. Add tests for the six untested implemented specs, the new gap lines as they land, and the partial cases in Key Finding 8.
10. Clear the tick `setInterval` in the shutdown callback (SAL-FOCUS-001).
11. Remove the duplicated cooldown check in `Scheduler.decide` (`scheduler.ts:45` vs `cooling()` at `:34-36`), and correct the "never talks to the LLM" header comment (`index.ts:5`).
