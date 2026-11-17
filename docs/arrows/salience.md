# Arrow: salience

The attention region: scores incoming senses, decides when the co-host should speak (`attention.focus`), and fires canned reflexes (`brain.say`) without an LLM.

## Status

**AUDITED** (date and commit in `index.yaml`). The spec file holds 103 specs: 71 `[x]`, 31 `[ ]`, 1 `[D]` (SAL-TRIG-010). The gaps are the chat safety work (below). The LLD lists open questions.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **P3** Idle chatter on a fully silent stream → stays silent; idle chatter needs an unseen event (code and config comment win; README corrected; unprompted talk on a dead stream is a deferred goal). Specs: SAL-DECIDE-005 reworded.
2. **B11** Mute/pause during an in-flight scorer decision → re-check muted, paused and busy after the await; publish nothing if any holds. Specs: SAL-FOCUS-005 added.
3. **S31** Reflex self-gating → confirmed as SAL-REFLEX-007 states: start the cooldown and mark `speaking` at publish time, not on the echo. Specs: SAL-REFLEX-007 added.
4. **R1** Tick publish failure → log and continue. Specs: SAL-HEALTH-002.
5. **P8** Restart replay → start mode `latest` (group moved to the tail on every start; at-most-once). Specs: SAL-IN-001 rewritten.
6. **S32** Mute/pause lost on restart → accepted. Specs: SAL-CTRL-006 unchanged.
7. **R3** Startup failures at module load → all setup inside `main()` so `fatal` is logged. Specs: SAL-HEALTH-003 widened.
8. **S33** Thinking valve and `muted` → valve becomes `brain.salience.thinking_timeout_ms` (default 60000); cortex `muted` stays not busy. Specs: SAL-BUSY-001 rewritten; SAL-BUSY-004 reworded.
9. **S34** Reason `mentioned` → only when `reply_on_mention` is true. Specs: SAL-DECIDE-008 added; SAL-DECIDE-003 defers the label to it.
10. **S35** Subscribers in the llm scorer prompt → add a `sub` marker. Specs: SAL-SCORE-008 rewritten.
11. **R3** `ready` timing → after consumer-group creation. Specs: SAL-HEALTH-001 reworded.
12. **P7** Mute ownership (project-level) → only salience and cortex see mute/pause; LLD Decisions row added.

## Barge-in and echo gate

SAL-BARGE-001 to SAL-BARGE-011 are `[x]`: the barge-in publisher, its gates, the cortex-state and cooldown reset, and reflex lines that never interrupt. Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (Segments table; Cross-cutting protocols: Turn-taking, Region hooks)

### LLD
- docs/intent/salience/salience-design.md

### EARS
- docs/intent/salience/salience-specs.md (103 specs, prefix `SAL`: 71 `[x]`, 31 `[ ]`, 1 `[D]`)

### Tests (files carrying `@spec SAL-`)
- services/salience/test/salience.region.test.ts
- services/salience/test/salience.test.ts
- services/salience/test/salience.dispositions.test.ts
- services/salience/test/salience.trigger.test.ts
- services/salience/test/salience.barge.test.ts
- services/salience/test/scorer.test.ts
- services/salience/test/health.test.ts
- services/salience/test/main.test.ts
- services/salience/test/timing.test.ts

### Code (files carrying `@spec SAL-`)
- services/salience/src/salience.ts
- services/salience/src/scheduler.ts
- services/salience/src/scoring.ts
- services/salience/src/main.ts
- services/salience/src/reflex.ts
- services/salience/src/health.ts
- services/salience/src/index.ts, services/salience/package.json, services/salience/tsconfig.json (no annotations)

### Region-hooks invocation points
- Construction: `services/salience/src/main.ts` → `createScorer` in `scoring.ts` (SAL-SCORE-007)
- Invocation: `Scheduler.decide` in `services/salience/src/scheduler.ts` → `scorer.run(...)` (SAL-SCORE-005; fallback owned by region-hooks)

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

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Intake | SAL-IN-001 to SAL-IN-007 | 7 | 0 | 0 |
| Scoring | SAL-SCORE-001 to SAL-SCORE-014 | 8 | 0 | 6 |
| Speak Decision | SAL-DECIDE-001 to SAL-DECIDE-016 | 6 | 0 | 10 |
| Focus Publication | SAL-FOCUS-001 to SAL-FOCUS-006 | 6 | 0 | 0 |
| Speech Trigger | SAL-TRIG-001 to SAL-TRIG-010 | 9 | 1 | 0 |
| Busy Gating | SAL-BUSY-001 to SAL-BUSY-004 | 4 | 0 | 0 |
| Reflexes | SAL-REFLEX-001 to SAL-REFLEX-008 | 8 | 0 | 0 |
| Control | SAL-CTRL-001 to SAL-CTRL-007 | 7 | 0 | 0 |
| Injection Flags | SAL-INJ-001 to SAL-INJ-004 | 4 | 0 | 0 |
| Barge-in | SAL-BARGE-001 to SAL-BARGE-011 | 11 | 0 | 0 |
| Health and Lifecycle | SAL-HEALTH-001 to SAL-HEALTH-005 | 5 | 0 | 0 |

**Summary:** 103 specs: 71 implemented, 31 gaps, 1 deferred. The clause specs of the streamed-speech design (CLAUSE, STREAM, REL and the per-segment streamed-line sections) are gaps. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **A reflex starts the cooldown and marks `speaking` before it publishes** (`Salience.reflex` in `salience.ts`); `Salience.tick()` catches and logs its own failures, so the timer never leaves a rejection unhandled. A failed reflex publish is not fatal, because the bus catches and logs handler errors (`packages/bus/src/index.ts`).
2. **Spec wording matches code where the decision confirmed it.** SAL-FOCUS-003: the bus schema fills a missing `mention` with false (`packages/bus/src/events.ts`). SAL-DECIDE-005: a fully silent stream stays silent. SAL-BUSY-004: cortex `muted` is not busy. SAL-CTRL-006: mute and pause are not persisted.
3. **A decision made before a mute, pause or busy cortex does not publish** (SAL-FOCUS-005). Its events stay unseen, with their scores cached. Only llm/http scorers open the window.
4. **Restart skips the backlog.** `main.ts` names start mode `latest`, so the `salience` group moves to the tail on every start (SAL-IN-001).
5. **Rule weights match the config defaults.** Mention 1.0, voice 0.9, question 0.55, mod/sub 0.35, screen 0.3, plain 0.15, threshold 0.6 are the values of `scoring.ts` and the schema defaults (`packages/config/src/schema.ts`; `config/config.example.yaml`), asserted in `services/salience/test/salience.test.ts`. The total is a sum over all unseen events (`Scheduler.decide`).
6. **Startup runs under the bootstrap and `ready` follows group creation** (SAL-HEALTH-001, SAL-HEALTH-003). `Bus.subscribe` has no readiness signal, so `salienceMain` awaits `bus.resetGroup("salience")` before starting the subscription; a readiness signal in event-bus would make that call unnecessary (Decisions row "Readiness signal").
7. **Decisions cite evidence or an owner decision.** LLD rows are settled by code comments, commit `969f6d7` ("Fix review findings") or the 2026-11-01 owner decisions; two keep a partial `[inferred]` (why sum not max, the 0.1 threshold floor) and the 60 s valve default value is `[inferred]`.

## Work Required

- Viewer identity and forgetting (design 2026-11-16, no code): the burst counter keys a viewer by platform and user id (SAL-DECIDE-011, SAL-DECIDE-012, SAL-DECIDE-017 to SAL-DECIDE-019), the focus carries them (SAL-FOCUS-003), and `chat.removed` is read and forgotten (SAL-IN-001, SAL-IN-008, SAL-IN-009, SAL-FOCUS-007).
### Must Fix
Counting a burst once per viewer and per text, and the guarded `llm` scorer prompt, are specified and not built (SAL-DECIDE-002, SAL-DECIDE-009 to SAL-DECIDE-016, SAL-SCORE-009 to SAL-SCORE-014). The LLD has two open questions: repeated mentions across decisions, and several viewers named `unknown`.

### Should Fix
None.

### Nice to Have
1. Once event-bus offers a readiness signal for `subscribe`, drop the `resetGroup` call that `main.ts` makes only to know the group exists.
