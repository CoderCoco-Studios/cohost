# Arrow: affect

The mood region: a decaying valence/arousal state nudged by bus events and published as `affect.state`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 37 specs: 29 implemented, 0 deferred, 8 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B4** `forget_context` lands past baseline → apply pending decay first, then land exactly on baseline. Specs: AFF-IN-007 reworded (gap).
2. **S36** Paused affect publishing → keep publishing `affect.state` while paused. Specs: AFF-CTRL-003 reworded (`[x]`).
3. **S37** Queued appraisals on pause/reset → discard the queue on `forget_context`; the worker drops jobs while paused. Specs: AFF-HOOK-008 rewritten (gap).
4. **R1** Publish failure → log and continue. Specs: AFF-PUB-004 (gap).
5. **P8** Restart replay → start mode `latest` (group moved to the tail on every start; at-most-once). Specs: AFF-IN-001 rewritten, `[x]` → `[ ]`.
6. **R3** Startup failures at module load → all setup inside `main()` so `fatal` is logged. Specs: AFF-HEALTH-002 widened, `[x]` → `[ ]`.
7. **S38** "No LLM" claim → reword: no model on the default rules path; `llm`/`http` appraisers exist. Specs: none (LLD Context; code comment and README fix).
8. **S39** Resting arousal → new key `brain.affect.baseline_arousal`, default 0.1. Specs: AFF-MOOD-006 added; AFF-MOOD-001, AFF-MOOD-003 reference it.
9. **S40** Prompt vs validator range → +-0.5 is the contract; widen the llm prompt. Specs: AFF-HOOK-009 `[x]` → `[ ]`.
10. **S41** Self-reinforcing mood loop → intended. Specs: none (LLD Decisions row).
11. **S42** Mention boost for voice lines → none; speech base 0.15 stands in. Specs: AFF-IN-003 reworded (`[x]`).
12. **S43** Single-letter slang `w` / `l` / `f` → intended. Specs: AFF-APPR-002 reworded (`[x]`).
13. **R3** `ready` timing → after consumer-group creation. Specs: AFF-HEALTH-001 `[x]` → `[ ]`.
14. **S25** (working-memory question 7) Unused `@cohost/working-memory` dependency → drop it. Specs: none.

## References

### HLD
- docs/high-level-design.md (Segments table; Cross-cutting protocols: Region hooks)

### LLD
- docs/intent/affect/affect-design.md

### EARS
- docs/intent/affect/affect-specs.md (37 specs, prefix `AFF`: 29 `[x]`, 8 `[ ]`, 0 `[D]`)

### Tests (18 annotated tests, 32 spec citations)
- services/affect/test/affect.region.test.ts (9 annotated: Affect class nudges, reset, publish gating, llm/http queue, pause)
- services/affect/test/affect.test.ts (5 annotated: appraiseRules, label, Mood decay and state, emoji regression)
- services/affect/test/appraiser.test.ts (3 annotated: http appraiser validation against a local HTTP server, mixed tone)
- services/affect/test/health.test.ts (1 annotated: heartbeat sequence)

### Code (33 annotated lines, 40 spec citations)
- services/affect/src/affect.ts (16: event-to-nudge mapping, control, inline vs queued appraisal, publish gating)
- services/affect/src/appraise.ts (6: word lists, rules, validation, `affect.appraiser` module factory and llm prompt)
- services/affect/src/mood.ts (5: initial state, decay, clamping, state, label)
- services/affect/src/index.ts (5: heartbeat, appraiser construction, subscription, publish timer, fatal exit)
- services/affect/src/health.ts (1: heartbeat spec)
- services/affect/package.json, services/affect/tsconfig.json (no annotations)

### Region-hooks invocation points
- Construction: `services/affect/src/index.ts:21` → `createAppraiser` (`appraise.ts:40`, AFF-HOOK-001)
- Kind check: `services/affect/src/affect.ts:85` (`appraiser.kind === "rules"` decides inline vs queued; AFF-HOOK-004, AFF-HOOK-007)
- Invocation: `services/affect/src/affect.ts:96` → `appraiser.run(...)` (AFF-HOOK-003, AFF-HOOK-005; fallback owned by region-hooks)

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
4. `index.ts` / `health.ts` — wiring, `publish_ms` timer, heartbeat spec.

Depends on event-bus, config, region-hooks (`Module`), control-plane (heartbeat contract). Consumed by salience, cortex, avatar and dashboard via `affect.state`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Event intake | AFF-IN-001 to AFF-IN-007 | 5 | 0 | 2 (IN-001, IN-007) | 6 |
| Mood model | AFF-MOOD-001 to AFF-MOOD-006 | 5 | 0 | 1 (MOOD-006) | 5 |
| Rule appraisal | AFF-APPR-001 to AFF-APPR-004 | 4 | 0 | 0 | 4 |
| Appraiser hook and queue | AFF-HOOK-001 to AFF-HOOK-009 | 7 | 0 | 2 (HOOK-008, HOOK-009) | 7 |
| Publishing | AFF-PUB-001 to AFF-PUB-004 | 3 | 0 | 1 (PUB-004) | 3 |
| Control | AFF-CTRL-001 to AFF-CTRL-005 | 5 | 0 | 0 | 4 |
| Health and lifecycle | AFF-HEALTH-001 to AFF-HEALTH-002 | 0 | 0 | 2 (HEALTH-001, HEALTH-002) | 1 |

**Summary:** 29 of 37 specs implemented; 0 deferred; 8 gaps (AFF-IN-001, AFF-IN-007, AFF-MOOD-006, AFF-HOOK-008, AFF-HOOK-009, AFF-PUB-004, AFF-HEALTH-001, AFF-HEALTH-002). 30 spec lines have a test annotation. Five gaps (AFF-IN-001, AFF-IN-007, AFF-HOOK-009, AFF-HEALTH-001, AFF-HEALTH-002) carry code annotations on the current implementation, which misses the decided behaviour; the fix lands under the same ID. Implemented specs with no test: AFF-CTRL-005. No reverse orphans (every `AFF-*` ID cited in code or tests exists in the spec file).

## Key Findings

1. **`forget_context` misses baseline** (AFF-IN-007). It computes its deltas before `nudge` applies the pending decay (`affect.ts:68`, `mood.ts:31-34`), so the mood lands past baseline by the decay since the last tick. Reproduced against the current code: valence 0.135 / arousal 0.085 two seconds after a 0.65 / 0.6 peak (defaults), valence -0.09 / arousal 0 after 45 s without a tick. The existing test uses a 10 000 000 ms half-life, which hides it.
2. **The queue and publish gaps are real.** AFF-HOOK-008: neither `pause` nor `forget_context` touches the queue, and `drain` never checks `paused` (`affect.ts:38,68,94-99`). AFF-PUB-004: `void this.d.bus.publish(...)` (`affect.ts:110`) is uncaught. The `drain()` chain (`affect.ts:91`) is not a practical crash path: `Module.run` catches every module failure and the `rules` kind is never queued.
3. **Spec wording matches code where the decision confirmed it.** AFF-APPR-003: only ASCII capitals count (`/[A-Z]{5,}/`, `appraise.ts:29`). AFF-APPR-002 names the single-letter slang tokens. AFF-IN-003 states the absent mention boost for speech. AFF-CTRL-003: publishing continues while paused.
4. **Restart replays the backlog.** A compose restart resumes the `affect` group (`packages/bus/src/index.ts:133-138`); only control-plane `fresh` starts (`packages/control/src/manifest.ts:42`) skip it. AFF-IN-001 (P8).
5. **Startup failures bypass the `fatal` handler, and `ready` precedes the subscription.** Construction runs at module load (`index.ts:17-22`); `ready()` follows the un-awaited `bus.subscribe` (`index.ts:25,30`). AFF-HEALTH-001, AFF-HEALTH-002 (R3).
6. **README and header still say "No LLM".** `services/affect/src/index.ts:9` and `README.md` ("Mood"), against the `llm` appraiser kind (`appraise.ts:43-51`). S38.
7. **Spec numbers match OpenSpec.** Rule deltas, nudge sizes, label thresholds, queue cap 8, 4-char short-line cutoff and the 15 s republish all agree with `openspec/specs/affect/spec.md`; the OpenSpec worked examples (`lol nice` → 0.12/0.08, mention + trash → -0.15/0.31) reproduce from `appraise.ts:23-32`, though no test asserts those exact values.
8. **Hygiene.** Unused `@cohost/working-memory` dependency (`package.json:16`, `tsconfig.json:8`; no import in `src` or `test`); a local `clamp` (`mood.ts:55`) duplicates the one `appraise.ts:1` imports from `@cohost/modules`.
9. **Decisions cite evidence or an owner decision.** LLD rows are settled by code comments, a test assertion, commit `969f6d7`, the OpenSpec docs or the 2026-11-01 owner decisions; three keep a partial `[inferred]` (queue cap 8, publish-key precision and 15 s period) and one stays `[inferred]` (lazy decay).
10. **Test gaps.** No test for AFF-CTRL-005 or the `index.ts` wiring. Several annotated tests check direction or cause rather than the specified sizes: AFF-IN-004, AFF-IN-006 (arousal), AFF-APPR-001..003 (only the net -0.03 is exact), AFF-CTRL-003 (publishing while paused unasserted).

## Work Required

### Must Fix
1. Make `forget_context` apply the pending decay before resetting, so the mood lands exactly on baseline (AFF-IN-007; B4).
2. Catch and log `affect.state` publish failures (AFF-PUB-004; R1).
3. Subscribe in start mode `latest` once event-bus provides it (AFF-IN-001; P8).
4. Move all startup into `main()` and signal `ready` after the consumer group exists (AFF-HEALTH-002, AFF-HEALTH-001; R3).

### Should Fix
5. Discard queued appraisals on `forget_context` and drop them in `drain` while paused (AFF-HOOK-008; S37).
6. Add `brain.affect.baseline_arousal` (default 0.1) and use it in `mood.ts` and the reset (AFF-MOOD-006; S39; the schema key is a config-segment change).
7. Widen the llm prompt's delta ranges to +-0.5 (AFF-HOOK-009; S40).
8. Reword the "No LLM" claim in `services/affect/src/index.ts:9` and the README "Mood" section (S38; README is outside this segment).
9. Remove the unused `@cohost/working-memory` dependency from `services/affect/package.json` and `tsconfig.json` (S25), and the duplicated local `clamp`.

### Nice to Have
10. Add tests for the `index.ts` wiring, AFF-CTRL-005, exact rule deltas, label boundary equalities, the queue/pause interaction and a realistic half-life for the reset.
11. Move the misplaced queue docblock (`affect.ts:14-19`) onto the class, and clear the publish timer on shutdown (AFF-PUB-001).
