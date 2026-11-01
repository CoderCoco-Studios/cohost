# Arrow: affect

The mood region: a decaying valence/arousal state nudged by bus events and published as `affect.state`.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 33 of 36 specs verified against code; 3 gaps (`forget_context` misses baseline, stale queued appraisals across pause/reset, unhandled publish rejection). Audit pass complete 2026-11-02, awaiting index update.

## Questions for the user

1. **Should `forget_context` land exactly on baseline?** The reset deltas are taken before decay and `nudge` decays first (`services/affect/src/affect.ts:68`, `services/affect/src/mood.ts:31-34`), so the mood ends past baseline by the decay since the last tick (valence 0.135 instead of 0.15 two seconds after a 0.65 peak; -0.09 after 45 s without a tick). AFF-IN-007 is now `[ ]`. Recommended: yes; tick before computing the deltas (or assign directly).
2. **Should a paused affect keep publishing `affect.state`?** Code and comment say yes (`affect.ts:29`, `publish()` at `:101` has no pause check; AFF-CTRL-003); the archived add-service-control design says paused services are "treated like muted for output" (`openspec/changes/archive/2026-11-01-add-service-control/design.md:27`). No test asserts either. Recommended: keep publishing (consumers need a live, decaying mood); the LID spec wins over the retired OpenSpec design.
3. **What should `pause` and `forget_context` do to queued llm/http appraisals?** AFF-HOOK-008 (gap) prescribes discarding the queue; holding it until `resume`, or skipping jobs in `drain` while paused (`affect.ts:94-99`), also satisfies "mood is not nudged while paused". Recommended: discard on `forget_context`, skip (drop) in `drain` while paused.
4. **Log-and-continue, or crash-and-restart, on a publish failure?** AFF-PUB-004 (gap) asks for log-and-continue; today `void this.d.bus.publish(...)` (`affect.ts:110`) lets a Redis error kill the process and compose restarts it at baseline (AFF-CTRL-005). Recommended: confirm log-and-continue.
5. **Should a crashed affect replay the backlog on restart?** `fromNow` only positions a newly created group (`packages/bus/src/index.ts:126-131`); a compose restart resumes the `affect` group and every line published while down nudges the mood at once. Control-plane `fresh` starts skip them (`packages/control/src/manifest.ts:41`). Recommended: decide with the event-bus crash-recovery question; for affect, skipping stale lines matches "a missed line costs less than a stale one" (`affect.ts:17-18`).
6. **Should AFF-HEALTH-002 cover failures at module load?** `main()` awaits nothing; `createAppraiser` and the rest run at import time (`services/affect/src/index.ts:17-22`), so `module.kind: http` with an empty `url` (`packages/modules/src/index.ts:45-48`) exits via an uncaught exception without the `fatal` log. Recommended: yes; widen the spec and mark it a gap.
7. **Is "No LLM" still the claim?** `services/affect/src/index.ts:9` and `README.md` ("Mood": "No LLM, no database") contradict the `llm` appraiser kind (`services/affect/src/appraise.ts:43-51`, AFF-HOOK-009). Recommended: reword to "no LLM unless `brain.affect.module.kind` is `llm`; no database".
8. **Should resting arousal be configurable?** 0.1 is a literal in three places (`mood.ts:14,28`, `affect.ts:68`) while valence has `baseline_valence` (AFF-MOOD-001, AFF-MOOD-003). Recommended: add `brain.affect.baseline_arousal` defaulting to 0.1, or document it as fixed.
9. **Which delta range is the contract: the prompt's or the validator's?** The llm prompt asks for valence -0.3..0.3 and arousal 0..0.3 (`appraise.ts:47`, AFF-HOOK-009) while validation accepts +-0.5 for both (`appraise.ts:37`, AFF-HOOK-002) and the http contract documents +-0.5 (`examples/modules/README.md:110`). Recommended: keep +-0.5 as the contract and widen the prompt text.
10. **Is the self-reinforcing mood loop intended?** The co-host's own `brain.say` emotion nudges its mood (`affect.ts:56-62`, AFF-IN-006), whose label colours the cortex prompt and avatar; only the half-life damps it. Recommended: confirm as intended gain.
11. **Should a voice line addressed to the co-host get the mention boost?** Speech is always appraised with `mention` false (`affect.ts:48`, AFF-IN-003). Recommended: keep; speech already has the higher 0.15 base.
12. **Are single-letter slang tokens intended?** POSITIVE contains `w`; NEGATIVE contains `l` and `f` as whole words (`appraise.ts:19-20`), so a lone "L", "W" or "F" in chat moves the mood. Recommended: confirm (stream slang).
13. **Should `ready` wait for the subscription?** `heartbeat.ready()` fires right after the un-awaited `bus.subscribe` (`services/affect/src/index.ts:25,30`); the OpenSpec heartbeat requirement says "once its subscriptions are running". AFF-HEALTH-001 now states the observed timing. Recommended: await consumer-group creation before `ready()`.

## References

### HLD
- docs/high-level-design.md (Services table; Cross-cutting protocols: Region hooks)

### LLD
- docs/intent/affect/affect-design.md

### EARS
- docs/intent/affect/affect-specs.md (36 specs, prefix `AFF`: 33 `[x]`, 3 `[ ]`, 0 `[D]`)

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
| Event intake | AFF-IN-001 to AFF-IN-007 | 6 | 0 | 1 | 6 |
| Mood model | AFF-MOOD-001 to AFF-MOOD-005 | 5 | 0 | 0 | 5 |
| Rule appraisal | AFF-APPR-001 to AFF-APPR-004 | 4 | 0 | 0 | 4 |
| Appraiser hook and queue | AFF-HOOK-001 to AFF-HOOK-009 | 8 | 0 | 1 | 7 |
| Publishing | AFF-PUB-001 to AFF-PUB-004 | 3 | 0 | 1 | 3 |
| Control | AFF-CTRL-001 to AFF-CTRL-005 | 5 | 0 | 0 | 4 |
| Health and lifecycle | AFF-HEALTH-001 to AFF-HEALTH-002 | 2 | 0 | 0 | 1 |

**Summary:** 33 of 36 specs implemented; 0 deferred; 3 gaps (AFF-IN-007, AFF-HOOK-008, AFF-PUB-004). Every implemented spec has a code `@spec` annotation, and so does AFF-IN-007, whose code exists but misses its target; 30 spec lines have a test annotation. Implemented specs with no test: AFF-IN-001, AFF-HOOK-009, AFF-CTRL-005, AFF-HEALTH-002. No reverse orphans (every `AFF-*` ID cited in code or tests exists in the spec file).

## Key Findings

1. **AFF-IN-007 flipped `[x]` → `[ ]`.** `forget_context` computes its deltas before `nudge` applies the pending decay (`affect.ts:68`, `mood.ts:31-34`), so the mood lands past baseline by the decay since the last tick. Reproduced against the current code: valence 0.135 / arousal 0.085 two seconds after a 0.65 / 0.6 peak (defaults), valence -0.09 / arousal 0 after 45 s without a tick. The existing test uses a 10 000 000 ms half-life, which hides it. Question 1.
2. **The other two gaps are real.** AFF-HOOK-008: neither `pause` nor `forget_context` touches the queue, and `drain` never checks `paused` (`affect.ts:36-38,68,94-99`). AFF-PUB-004: `void this.d.bus.publish(...)` (`affect.ts:110`) is uncaught. The `drain()` chain (`affect.ts:91`) is not a practical crash path: `Module.run` catches every module failure and the `rules` kind is never queued.
3. **Spec wording corrected to match code.** AFF-IN-001: `fromNow` positions only a newly created group (`packages/bus/src/index.ts:126-131`). AFF-APPR-003: only ASCII capitals count (`/[A-Z]{5,}/`, `appraise.ts:29`). AFF-HEALTH-001: `ready` follows the *started* subscription. AFF-HEALTH-002: scoped to `main()` rejecting.
4. **Two behaviours had no spec line; now AFF-HOOK-009 and AFF-CTRL-005.** The llm prompt contents (with ranges narrower than validation), and mood/paused state held only in memory.
5. **Two documents disagree on paused output.** Code and `affect.ts:29` keep publishing while paused (AFF-CTRL-003); the archived add-service-control design says paused services are "treated like muted for output". Question 2.
6. **README and header still say "No LLM".** `services/affect/src/index.ts:9` and `README.md` ("Mood"), against the `llm` appraiser kind (`appraise.ts:43-51`). Question 7.
7. **Spec numbers match OpenSpec.** Rule deltas, nudge sizes, label thresholds, queue cap 8, 4-char short-line cutoff and the 15 s republish all agree with `openspec/specs/affect/spec.md`; the OpenSpec worked examples (`lol nice` → 0.12/0.08, mention + trash → -0.15/0.31) reproduce from `appraise.ts:23-32`, though no test asserts those exact values.
8. **Hygiene.** Unused `@cohost/working-memory` dependency (`package.json:16`, `tsconfig.json:8`; no import in `src` or `test`); a local `clamp` (`mood.ts:55`) duplicates the one `appraise.ts:1` imports from `@cohost/modules`.
9. **Decisions now cite evidence.** 6 of 11 LLD decision rows are settled by code comments, a test assertion, commit `969f6d7` or the OpenSpec docs; 3 are settled in part (queue cap 8, publish-key precision and 15 s period, why +-0.5); 2 stay `[inferred]` (lazy decay, fixed resting arousal).
10. **Test gaps.** Four implemented specs have no test (listed in the summary). Several annotated tests check direction or cause rather than the specified sizes: AFF-IN-004, AFF-IN-006 (arousal), AFF-APPR-001..003 (only the net -0.03 is exact), AFF-CTRL-003 (publishing while paused unasserted).

## Work Required

### Must Fix
1. Catch and log `affect.state` publish failures so a transient Redis error does not crash the service (AFF-PUB-004; Question 4).

### Should Fix
2. Make `forget_context` land exactly on baseline (AFF-IN-007; Question 1).
3. Settle and implement queued-appraisal handling on `pause` and `forget_context` (AFF-HOOK-008; Question 3).
4. Correct the stale "No LLM" wording in `index.ts:9` and the README Mood section (Question 7).
5. Remove the unused `@cohost/working-memory` dependency and the duplicated local `clamp` (no spec; hygiene).

### Nice to Have
6. Make resting arousal configurable or document it as fixed (AFF-MOOD-003; Question 8).
7. Align the llm prompt's delta ranges with the validator's +-0.5 (AFF-HOOK-009; Question 9).
8. Add tests for the four untested specs, exact rule deltas, label boundary equalities and the queue/pause interaction.
9. Move the misplaced queue docblock (`affect.ts:14-19`) onto the class, and clear the publish timer on shutdown (AFF-PUB-001).
