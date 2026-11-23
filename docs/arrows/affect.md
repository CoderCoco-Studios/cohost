# Arrow: affect

The mood region: a decaying valence/arousal state nudged by bus events and published as `affect.state`.

## Status

**OK** (date and commit in `index.yaml`). The spec file holds 57 specs: 57 implemented, 0 deferred, 0 gaps. The LLD has no open questions.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B4** `forget_context` lands past baseline → apply pending decay first, then land exactly on baseline. Specs: AFF-IN-007 reworded.
2. **S36** Paused affect publishing → keep publishing `affect.state` while paused. Specs: AFF-CTRL-003 reworded (`[x]`).
3. **S37** Queued appraisals on pause/reset → discard the queue on `forget_context`; the worker drops jobs while paused. Specs: AFF-HOOK-008 rewritten.
4. **R1** Publish failure → log and continue. Specs: AFF-PUB-004 added.
5. **P8** Restart replay → start mode `latest` (group moved to the tail on every start; at-most-once). Specs: AFF-IN-001 rewritten.
6. **R3** Startup failures at module load → all setup under `runService` or inside `affectMain` so `fatal` is logged. Specs: AFF-HEALTH-002 widened.
7. **S38** "No LLM" claim → reword: no model on the default rules path; `llm`/`http` appraisers exist. Specs: none (LLD Context; the `index.ts` header comment and the README "Mood" section state it).
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
- docs/intent/affect/affect-specs.md (57 specs, prefix `AFF`: 57 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests (files carrying `@spec AFF-`)
- services/affect/test/affect.region.test.ts
- services/affect/test/affect.dispositions.test.ts
- services/affect/test/affect.test.ts
- services/affect/test/appraiser.test.ts
- services/affect/test/health.test.ts
- services/affect/test/main.test.ts

### Code (files carrying `@spec AFF-`)
- services/affect/src/affect.ts
- services/affect/src/appraise.ts
- services/affect/src/mood.ts
- services/affect/src/main.ts
- services/affect/src/health.ts
- services/affect/src/index.ts, services/affect/package.json, services/affect/tsconfig.json (no annotations)

### Region-hooks invocation points
- Construction: `services/affect/src/main.ts` → `createAppraiser` in `appraise.ts` (AFF-HOOK-001)
- Kind check: `Affect.appraise` in `services/affect/src/affect.ts` (`appraiser.kind === "rules"` decides inline vs queued; AFF-HOOK-004, AFF-HOOK-007)
- Invocation: the queue worker in `services/affect/src/affect.ts` → `appraiser.run(...)` (AFF-HOOK-003, AFF-HOOK-005; fallback owned by region-hooks)

## Architecture

**Purpose:** Keep a cheap, continuous model of the co-host's mood that colours the cortex prompt, the avatar's resting face and salience's willingness to speak.

**Key Components:**
1. `Affect` (`affect.ts`) — event-to-nudge mapping, inline vs queued appraisal, change-gated publishing, pause.
2. `Mood` (`mood.ts`) — valence/arousal state, lazy exponential decay, clamping, emotion label.
3. `appraise.ts` — word-list rules and the `affect.appraiser` module factory (rules / llm / http, region-hooks).
4. `index.ts` / `main.ts` / `health.ts` — entry point, startup wiring (`runAffect`, `affectMain`), `publish_ms` timer, heartbeat spec.

Depends on event-bus, config, region-hooks (`Module`), control-plane (heartbeat contract). Consumed by salience, cortex, avatar and dashboard via `affect.state`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Event Intake | AFF-IN-001 to AFF-IN-020 | 20 | 0 | 0 |
| Mood Model | AFF-MOOD-001 to AFF-MOOD-006 | 6 | 0 | 0 |
| Rule Appraisal | AFF-APPR-001 to AFF-APPR-004 | 4 | 0 | 0 |
| Appraiser Hook and Queue | AFF-HOOK-001 to AFF-HOOK-014 | 14 | 0 | 0 |
| Publishing | AFF-PUB-001 to AFF-PUB-004 | 4 | 0 | 0 |
| Control | AFF-CTRL-001 to AFF-CTRL-005 | 5 | 0 | 0 |
| Health and Lifecycle | AFF-HEALTH-001 to AFF-HEALTH-004 | 4 | 0 | 0 |

**Summary:** 57 specs: 57 implemented, 0 deferred, 0 gaps.

## Key Findings

1. **`forget_context` lands exactly on baseline** (AFF-IN-007). `Mood.reset` applies the pending decay and then assigns the resting values.
2. **A pause or reset voids queued and in-flight appraisals** (AFF-HOOK-008) through an epoch counter checked before and after the appraiser runs. AFF-PUB-004: the `affect.state` publish has a rejection handler that logs a warning. The `drain()` chain in `affect.ts` is not a practical crash path: `Module.run` catches every module failure and the `rules` kind is never queued.
3. **Spec wording matches code where the decision confirmed it.** AFF-APPR-003: only ASCII capitals count (`/[A-Z]{5,}/` in `appraise.ts`). AFF-APPR-002 names the single-letter slang tokens. AFF-IN-003 states the absent mention boost for speech. AFF-CTRL-003: publishing continues while paused.
4. **Chat is counted once, before any job is queued.** AFF-IN-008..016: chat text and names are bounded first; `Affect` admits each chat line through one `createOnceCounter` (`brain.affect.count_window_ms`, created at start, replaced on `forget_context`) keyed by `viewerKey` and the normalised text, at the handler's receipt time. A refused line changes neither the mood, the cause nor the counter. Speech never reaches the counter. The llm prompt quotes chat once and labels the speaker (AFF-HOOK-010..014).
5. **Restart skips the backlog.** `main.ts` names start mode `latest`, so the `affect` group moves to the tail on every start (AFF-IN-001).
6. **Startup runs under the bootstrap and `ready` follows group creation** (AFF-HEALTH-001, AFF-HEALTH-002). `Bus.subscribe` has no readiness signal, so `affectMain` awaits `bus.resetGroup("affect")` before starting the subscription; a readiness signal in event-bus would make that call unnecessary (Decisions row "Readiness signal").
7. **Decisions cite evidence or an owner decision.** LLD rows are settled by code comments, a test assertion, commit `969f6d7` or the 2026-11-01 owner decisions; three keep a partial `[inferred]` (queue cap 8, publish-key precision and 15 s period) and one stays `[inferred]` (lazy decay).
8. **A removal drops only queued chat.** `chat.removed` filters the queue by `platform` and `messageId`, `userId` or `all` (AFF-IN-017). Mood, cause, counter keys and the epoch are untouched (AFF-IN-018), and a running job finishes (AFF-IN-019). Viewer identity is the shared `viewerKey` at receipt (AFF-IN-011, AFF-IN-020).

## Work Required

### Must Fix
None from the chat-safety work: bounded intake, chat counted once per window, and the guarded appraiser prompt are built (AFF-IN-002 to AFF-IN-016, AFF-HOOK-010 to AFF-HOOK-014).

### Should Fix
None.

### Nice to Have
1. Once event-bus offers a readiness signal for `subscribe`, drop the `resetGroup` call that `main.ts` makes only to know the group exists.
