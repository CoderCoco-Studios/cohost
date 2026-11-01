# Arrow: salience

The attention region: scores incoming senses, decides when the co-host should speak (`attention.focus`), and fires canned reflexes (`brain.say`) without an LLM.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 47 of 49 specs verified against code; 2 gaps (reflex self-cooldown, unhandled tick rejections). Audit pass complete 2026-11-02, awaiting index update.

## Questions for the user

1. **Should idle chatter fire on a fully silent stream?** `decide` returns `nothing new` (`services/salience/src/scheduler.ts:48`) before the idle branch (`:72`), so idle chatter needs at least one unseen event (SAL-DECIDE-004, SAL-DECIDE-005). `config/config.example.yaml:66` says "and there's fresh context"; `README.md` ("Talkativeness": "pipes up on its own after `idle_chatter_ms` of quiet") reads unconditional. Recommended: keep the code behaviour and correct the README.
2. **Does "while muted / paused, publish no `attention.focus`" cover a decision already in flight?** `tick` reads `muted`, `busy()` and `paused` before awaiting the scorer and never re-checks them (`services/salience/src/salience.ts:110-122`); with an llm/http scorer a `mute` or `pause` arriving mid-await still lets that focus publish (reproduced with a gated scorer). SAL-CTRL-002 and SAL-CTRL-004 are silent on it. Recommended: yes; re-check after the await and record the current behaviour as a gap.
3. **Is SAL-REFLEX-007 the intended reflex behaviour?** The reflex path publishes `brain.say` (`salience.ts:98`) without `noteSpoke()` or setting `speaking`; only the echo does it (`salience.ts:59-64`), leaving a window for a tick or a second rule. Recommended: confirm; start the cooldown and mark `speaking` at publish time.
4. **Log-and-continue, or crash-and-restart, on a tick publish failure?** SAL-HEALTH-002 (gap) asks for log-and-continue; today `void salience.tick()` (`services/salience/src/index.ts:36`) lets a rejection kill the process, compose restarts it, and muted/paused state is lost (SAL-CTRL-006). Recommended: confirm log-and-continue.
5. **Should a crashed salience replay the backlog on restart?** `fromNow` only positions a newly created group (`packages/bus/src/index.ts:126-131`); a compose restart resumes the existing `salience` group, so chat published while down is replayed into reflexes and busy state. Control-plane `fresh` starts skip it (`packages/control/src/manifest.ts:40`). Recommended: decide with the event-bus crash-recovery question; for salience, skipping stale input is the safer default.
6. **Is losing mute / pause on restart acceptable?** Muted and paused live only in memory (SAL-CTRL-006; `salience.ts:22,24`), so a restarted salience speaks again while the dashboard may still show it muted. Recommended: accept for now and document it; revisit if the control plane gains persisted state.
7. **Should SAL-HEALTH-003 cover failures at module load?** `main()` awaits nothing; config, bus, heartbeat and scorer construction run at import time (`services/salience/src/index.ts:20-25`), so for example `module.kind: http` with an empty `url` (`packages/modules/src/index.ts:45-48`) exits via an uncaught exception without the `fatal` log. Recommended: yes; widen the spec and mark it a gap.
8. **Why is the 60 s `thinking` valve hard-coded, and should `brain.status muted` count as busy?** `salience.ts:104` uses a literal while the `speaking` valve reads the cortex's `speaking_timeout_ms` (`salience.ts:105`); `muted` is treated as not busy (`salience.ts:106`). Recommended: make the thinking valve a `brain.salience` key; leave `muted` not busy, since salience has its own mute.
9. **Should the reason `mentioned` depend on `reply_on_mention`?** The reason keys on `focus.mention` alone (`scheduler.ts:68`), so with `reply_on_mention: false` a mention can still be labelled `mentioned` (SAL-DECIDE-003). Recommended: label `mentioned` only when `reply_on_mention` is true.
10. **Should the llm scorer prompt mark subscribers?** The prompt prints mention and mod but not sub (`services/salience/src/scoring.ts:55`, SAL-SCORE-008) while the rules weight subs at 0.35 (`scoring.ts:31`). Recommended: add a `sub` marker.
11. **Should `ready` wait for the subscription?** `heartbeat.ready()` fires right after the un-awaited `bus.subscribe` (`services/salience/src/index.ts:28,37`); the OpenSpec heartbeat requirement says "once its subscriptions are running". SAL-HEALTH-001 now states the observed timing. Recommended: await consumer-group creation before `ready()`.

## References

### HLD
- docs/high-level-design.md (Services table; Cross-cutting protocols: Turn-taking, Region hooks)

### LLD
- docs/intent/salience/salience-design.md

### EARS
- docs/intent/salience/salience-specs.md (49 specs, prefix `SAL`: 47 `[x]`, 2 `[ ]`, 0 `[D]`)

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
| Intake | SAL-IN-001 to SAL-IN-006 | 6 | 0 | 0 | 2 |
| Scoring | SAL-SCORE-001 to SAL-SCORE-008 | 8 | 0 | 0 | 7 |
| Speak decision | SAL-DECIDE-001 to SAL-DECIDE-007 | 7 | 0 | 0 | 6 |
| Focus publication | SAL-FOCUS-001 to SAL-FOCUS-004 | 4 | 0 | 0 | 3 |
| Busy gating | SAL-BUSY-001 to SAL-BUSY-004 | 4 | 0 | 0 | 4 |
| Reflexes | SAL-REFLEX-001 to SAL-REFLEX-007 | 6 | 0 | 1 | 6 |
| Control | SAL-CTRL-001 to SAL-CTRL-006 | 6 | 0 | 0 | 5 |
| Injection flags | SAL-INJ-001 to SAL-INJ-004 | 4 | 0 | 0 | 4 |
| Health and lifecycle | SAL-HEALTH-001 to SAL-HEALTH-003 | 2 | 0 | 1 | 1 |

**Summary:** 47 of 49 specs implemented; 0 deferred; 2 gaps (SAL-REFLEX-007, SAL-HEALTH-002). Every implemented spec has a code `@spec` annotation; 38 have a test annotation. Implemented specs with no test: SAL-IN-001, SAL-IN-002, SAL-IN-003, SAL-IN-006, SAL-SCORE-008, SAL-DECIDE-005, SAL-FOCUS-001, SAL-CTRL-006, SAL-HEALTH-003. No reverse orphans (every `SAL-*` ID cited in code or tests exists in the spec file).

## Key Findings

1. **Markers hold.** All 47 `[x]` lines are implemented as written (after the wording corrections below), and both `[ ]` gaps are real: the reflex path never calls `noteSpoke()` (`salience.ts:98`), and `void salience.tick()` (`index.ts:36`) leaves publish rejections unhandled. A failed reflex publish is not fatal, because the bus catches and logs handler errors (`packages/bus/src/index.ts:153-159`).
2. **Spec wording corrected to match code.** SAL-IN-001: `fromNow` positions only a newly created group; an existing group resumes after its last delivered entry (`packages/bus/src/index.ts:126-131`). SAL-FOCUS-003: the bus schema fills a missing `mention` with false (`packages/bus/src/events.ts:77`; asserted at `test/salience.region.test.ts:44,49`). SAL-HEALTH-001: `ready` follows the *started*, not established, subscription. SAL-HEALTH-003: scoped to `main()` rejecting, which is all the code handles.
3. **Four behaviours had no spec line; now SAL-IN-006, SAL-SCORE-007, SAL-SCORE-008, SAL-CTRL-006.** Initial arousal 0 and cortex `idle`; scorer construction as module `salience.scorer`; the llm prompt contents (no `sub` marker); muted/paused held only in memory.
4. **Mute or pause during an async decision does not stop it.** `tick` does not re-check `muted` / `paused` / `busy()` after awaiting the scorer (`salience.ts:110-122`); reproduced with a gated scorer. Only llm/http scorers open the window. Question 2.
5. **A crash restart replays the backlog.** Compose restarts resume the `salience` consumer group; only control-plane `fresh` starts skip input published while down (`packages/control/src/manifest.ts:40`). Question 5.
6. **README weights match the code.** `README.md` ("Talkativeness") and `config/config.example.yaml:68` quote mention 1.0, voice 0.9, question 0.55, mod/sub 0.35, screen 0.3, plain 0.15, threshold 0.6; these equal `scoring.ts:27-34` and the schema defaults (`packages/config/src/schema.ts:98-106`), asserted in `test/salience.test.ts:34`. The README does not say the total is a sum over all unseen events (`scheduler.ts:57-64`).
7. **Idle chatter requires an unseen event.** Unchanged; README vs config wording conflict. Question 1.
8. **Startup failures bypass the `fatal` handler.** Construction runs at module load (`index.ts:20-25`), outside `main().catch`. Question 7.
9. **Decisions now cite evidence.** 9 of 12 LLD decision rows are settled by code comments, commit `969f6d7` ("Fix review findings") or the archived OpenSpec designs; 3 keep a partial `[inferred]` (why sum not max, the 0.1 threshold floor, the 60 s valve value).
10. **Test gaps.** Nine implemented specs have no test (listed in the summary). Some annotated tests cover only part of their line: SAL-BUSY-001 (60 s expiry untested), SAL-REFLEX-003 (rule order), SAL-REFLEX-005 (rule cooldown not spent), SAL-INJ-002 (no-focus case), SAL-DECIDE-006 (reason text), SAL-BUSY-004 (`muted`).
11. **Doc references fixed.** `config.example.yaml` lives at `config/config.example.yaml`; the module `timeout_ms` default is `packages/config/src/schema.ts:17`; the `stopping` heartbeat comes from a `beforeShutdown` hook (`packages/bus/src/heartbeat.ts:115`).

## Work Required

### Must Fix
1. Handle rejections from the tick timer and the un-awaited `bus.subscribe` so a transient publish/Redis failure does not take the service down (SAL-HEALTH-002; Question 4).

### Should Fix
2. Have the reflex path start the cooldown and mark the voice busy locally at publish time (SAL-REFLEX-007; Question 3).
3. Decide and document the idle-chatter-on-silence behaviour (SAL-DECIDE-004, SAL-DECIDE-005; Question 1).
4. Decide whether mute/pause must stop an in-flight decision (SAL-CTRL-002, SAL-CTRL-004; Question 2).
5. Make the 60 s `thinking` valve configurable or document it (SAL-BUSY-001; Question 8).

### Nice to Have
6. Clear the tick `setInterval` in the shutdown callback (SAL-FOCUS-001).
7. Add `sub` to the llm scorer prompt (SAL-SCORE-008; Question 10).
8. Add tests for the nine untested specs and the partial cases in Key Finding 10.
9. Remove the duplicated cooldown check in `Scheduler.decide` (`scheduler.ts:45` vs `cooling()` at `:34-36`).
