# Arrow: affect

The mood region: a decaying valence/arousal state nudged by bus events and published as `affect.state`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 37 specs: 37 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes have landed (cascade-audit PR for brain-front).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B4** `forget_context` lands past baseline → apply pending decay first, then land exactly on baseline. Specs: AFF-IN-007 reworded.
2. **S36** Paused affect publishing → keep publishing `affect.state` while paused. Specs: AFF-CTRL-003 reworded (`[x]`).
3. **S37** Queued appraisals on pause/reset → discard the queue on `forget_context`; the worker drops jobs while paused. Specs: AFF-HOOK-008 rewritten.
4. **R1** Publish failure → log and continue. Specs: AFF-PUB-004 added.
5. **P8** Restart replay → start mode `latest` (group moved to the tail on every start; at-most-once). Specs: AFF-IN-001 rewritten.
6. **R3** Startup failures at module load → all setup inside `main()` so `fatal` is logged. Specs: AFF-HEALTH-002 widened.
7. **S38** "No LLM" claim → reword: no model on the default rules path; `llm`/`http` appraisers exist. Specs: none (LLD Context; the `index.ts` header comment is reworded; the README fix is outside this segment).
8. **S39** Resting arousal → new key `brain.affect.baseline_arousal`, default 0.1. Specs: AFF-MOOD-006 added; AFF-MOOD-001, AFF-MOOD-003 reference it.
9. **S40** Prompt vs validator range → +-0.5 is the contract; widen the llm prompt. Specs: AFF-HOOK-009 rewritten.
10. **S41** Self-reinforcing mood loop → intended. Specs: none (LLD Decisions row).
11. **S42** Mention boost for voice lines → none; speech base 0.15 stands in. Specs: AFF-IN-003 reworded (`[x]`).
12. **S43** Single-letter slang `w` / `l` / `f` → intended. Specs: AFF-APPR-002 reworded (`[x]`).
13. **R3** `ready` timing → after consumer-group creation. Specs: AFF-HEALTH-001 reworded.
14. **S25** (working-memory question 7) Unused `@cohost/working-memory` dependency → drop it. Specs: none.

## References

### HLD
- docs/high-level-design.md (Segments table; Cross-cutting protocols: Region hooks)

### LLD
- docs/intent/affect/affect-design.md

### EARS
- docs/intent/affect/affect-specs.md (37 specs, prefix `AFF`: 37 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests (26 annotated tests, 41 spec citations)
- services/affect/test/affect.region.test.ts (13 annotated: Affect class nudges, reset with a realistic half-life, baseline arousal, publish gating and failure, llm/http queue, pause and reset against the queue)
- services/affect/test/affect.test.ts (5 annotated: appraiseRules, label, Mood decay and state, emoji regression)
- services/affect/test/appraiser.test.ts (4 annotated: http appraiser validation against a local HTTP server, mixed tone, llm prompt against a fake OpenAI-compatible server)
- services/affect/test/health.test.ts (1 annotated: heartbeat sequence)
- services/affect/test/main.test.ts (3 annotated: startup wiring against a fake bus: start mode, `ready` after group creation, publish timer, `fatal` exit)

### Code (40 annotated lines, 49 spec citations)
- services/affect/src/affect.ts (20: event-to-nudge mapping, control, inline vs queued appraisal and staleness, publish gating and failure handling)
- services/affect/src/appraise.ts (6: word lists, rules, validation, `affect.appraiser` module factory and llm prompt)
- services/affect/src/mood.ts (8: initial state, decay, clamping, reset, state, label)
- services/affect/src/main.ts (5: heartbeat, appraiser construction, subscription, publish timer, fatal exit)
- services/affect/src/health.ts (1: heartbeat spec)
- services/affect/src/index.ts, services/affect/package.json, services/affect/tsconfig.json (no annotations)

### Region-hooks invocation points
- Construction: `services/affect/src/main.ts` → `createAppraiser` (`appraise.ts:40`, AFF-HOOK-001)
- Kind check: `services/affect/src/affect.ts:91` (`appraiser.kind === "rules"` decides inline vs queued; AFF-HOOK-004, AFF-HOOK-007)
- Invocation: `services/affect/src/affect.ts:103` → `appraiser.run(...)` (AFF-HOOK-003, AFF-HOOK-005; fallback owned by region-hooks)

### OpenSpec (retired, historical)
- openspec/specs/affect/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/affect/spec.md
- openspec/changes/archive/2026-11-01-add-service-control/specs/affect/spec.md

## Architecture

**Purpose:** Keep a cheap, continuous model of the co-host's mood that colours the cortex prompt, the avatar's resting face and salience's willingness to speak.

**Key Components:**
1. `Affect` (`affect.ts`) — event-to-nudge mapping, inline vs queued appraisal, change-gated publishing, pause.
2. `Mood` (`mood.ts`) — valence/arousal state, lazy exponential decay, clamping, emotion label.
3. `appraise.ts` — word-list rules and the `affect.appraiser` module factory (rules / llm / http, region-hooks).
4. `index.ts` / `main.ts` / `health.ts` — entry point, startup wiring (`main`), `publish_ms` timer, heartbeat spec.

Depends on event-bus, config, region-hooks (`Module`), control-plane (heartbeat contract). Consumed by salience, cortex, avatar and dashboard via `affect.state`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Event intake | AFF-IN-001 to AFF-IN-007 | 7 | 0 | 0 | 7 |
| Mood model | AFF-MOOD-001 to AFF-MOOD-006 | 6 | 0 | 0 | 6 |
| Rule appraisal | AFF-APPR-001 to AFF-APPR-004 | 4 | 0 | 0 | 4 |
| Appraiser hook and queue | AFF-HOOK-001 to AFF-HOOK-009 | 9 | 0 | 0 | 9 |
| Publishing | AFF-PUB-001 to AFF-PUB-004 | 4 | 0 | 0 | 4 |
| Control | AFF-CTRL-001 to AFF-CTRL-005 | 5 | 0 | 0 | 4 |
| Health and lifecycle | AFF-HEALTH-001 to AFF-HEALTH-002 | 2 | 0 | 0 | 2 |

**Summary:** 37 of 37 specs implemented; 0 deferred; 0 gaps. 36 spec lines have a test annotation. Implemented specs with no test: AFF-CTRL-005. No reverse orphans (every `AFF-*` ID cited in code or tests exists in the spec file).

## Key Findings

1. **`forget_context` lands exactly on baseline** (AFF-IN-007). `Mood.reset` applies the pending decay and then assigns the resting values; the test uses the default 45 s half-life with a mocked clock and a 2 s gap, where the old delta-based reset left valence about 0.135.
2. **A pause or reset voids queued and in-flight appraisals** (AFF-HOOK-008) through an epoch counter checked before and after the appraiser runs. AFF-PUB-004: the `affect.state` publish has a rejection handler that logs a warning. The `drain()` chain (`affect.ts:97`) is still not a practical crash path: `Module.run` catches every module failure and the `rules` kind is never queued.
3. **Spec wording matches code where the decision confirmed it.** AFF-APPR-003: only ASCII capitals count (`/[A-Z]{5,}/`, `appraise.ts:29`). AFF-APPR-002 names the single-letter slang tokens. AFF-IN-003 states the absent mention boost for speech. AFF-CTRL-003: publishing continues while paused.
4. **Restart skips the backlog.** `main.ts` names start mode `latest`, so the `affect` group moves to the tail on every start (AFF-IN-001; P8).
5. **Startup runs inside `main()` and `ready` follows group creation** (AFF-HEALTH-001, AFF-HEALTH-002; R3). `Bus.subscribe` has no readiness signal, so `main()` awaits `bus.resetGroup("affect")` before starting the subscription; a readiness signal in event-bus would make that call unnecessary (Decisions row "Readiness signal").
6. **README still says "No LLM".** The `services/affect/src/index.ts` header is reworded (S38); `README.md` ("Mood") is outside this segment and still reads unconditionally.
7. **Spec numbers match OpenSpec.** Rule deltas, nudge sizes, label thresholds, queue cap 8, 4-char short-line cutoff and the 15 s republish all agree with `openspec/specs/affect/spec.md`; the OpenSpec worked examples (`lol nice` → 0.12/0.08, mention + trash → -0.15/0.31) reproduce from `appraise.ts:23-32`, though no test asserts those exact values.
8. **Hygiene.** The unused `@cohost/working-memory` dependency is removed from `package.json` and `tsconfig.json`, with the matching importer entry in `pnpm-lock.yaml`; the local `clamp` in `mood.ts` is replaced by the one `@cohost/modules` exports.
9. **Decisions cite evidence or an owner decision.** LLD rows are settled by code comments, a test assertion, commit `969f6d7`, the OpenSpec docs or the 2026-11-01 owner decisions; three keep a partial `[inferred]` (queue cap 8, publish-key precision and 15 s period) and one stays `[inferred]` (lazy decay).
10. **Test gaps.** No test for AFF-CTRL-005. Several annotated tests check direction or cause rather than the specified sizes: AFF-IN-004, AFF-IN-006 (arousal), AFF-APPR-001..003 (only the net -0.03 is exact), AFF-CTRL-003 (publishing while paused unasserted).

## Work Required

### Must Fix
None.

### Should Fix
1. Reword the "No LLM" claim in the README "Mood" section (S38; README is outside this segment).

### Nice to Have
2. Add tests for AFF-CTRL-005, exact rule deltas and label boundary equalities.
3. Move the misplaced queue docblock (`affect.ts:14-19`) onto the class.
4. Once event-bus offers a readiness signal for `subscribe`, drop the `resetGroup` call that `main.ts` makes only to know the group exists.
