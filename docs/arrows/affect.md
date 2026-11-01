# Arrow: affect

The mood region: a decaying valence/arousal state nudged by bus events and published as `affect.state`.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 32 of 34 specs observed working; 2 gaps recorded (stale-queue behavior across pause/reset, unhandled publish rejection).

## References

### HLD
- docs/high-level-design.md (Services table; Cross-cutting protocols: Region hooks)

### LLD
- docs/intent/affect/affect-design.md

### EARS
- docs/intent/affect/affect-specs.md (34 specs, prefix `AFF`)

### Tests
- services/affect/test/affect.test.ts (appraiseRules, label, Mood decay, emoji regression)
- services/affect/test/affect.region.test.ts (Affect class: nudges, reset, publish gating, llm/http queue, pause)
- services/affect/test/appraiser.test.ts (http appraiser validation against a local HTTP server)
- services/affect/test/health.test.ts (heartbeat sequence)

### Code
- services/affect/src/index.ts
- services/affect/src/affect.ts
- services/affect/src/mood.ts
- services/affect/src/appraise.ts
- services/affect/src/health.ts
- services/affect/package.json, services/affect/tsconfig.json

### OpenSpec
- openspec/specs/affect/spec.md
- openspec/changes/add-service-health/specs/affect/spec.md
- openspec/changes/add-service-control/specs/affect/spec.md

## Architecture

**Purpose:** Keep a cheap, continuous model of the co-host's mood that colours the cortex prompt, the avatar's resting face and salience's willingness to speak.

**Key Components:**
1. `Affect` (`affect.ts`) — event-to-nudge mapping, inline vs queued appraisal, change-gated publishing, pause.
2. `Mood` (`mood.ts`) — valence/arousal state, lazy exponential decay, clamping, emotion label.
3. `appraise.ts` — word-list rules and the `affect.appraiser` module factory (rules / llm / http, region-hooks).
4. `index.ts` / `health.ts` — wiring, `publish_ms` timer, heartbeat spec.

Depends on event-bus, config, region-hooks (`Module`), control-plane (heartbeat contract). Consumed by salience, cortex, avatar and dashboard via `affect.state`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Event intake | AFF-IN-001 to AFF-IN-007 | 7 | 0 | 0 |
| Mood model | AFF-MOOD-001 to AFF-MOOD-005 | 5 | 0 | 0 |
| Rule appraisal | AFF-APPR-001 to AFF-APPR-004 | 4 | 0 | 0 |
| Appraiser hook and queue | AFF-HOOK-001 to AFF-HOOK-008 | 7 | 0 | 1 |
| Publishing | AFF-PUB-001 to AFF-PUB-004 | 3 | 0 | 1 |
| Control | AFF-CTRL-001 to AFF-CTRL-004 | 4 | 0 | 0 |
| Health and lifecycle | AFF-HEALTH-001 to AFF-HEALTH-002 | 2 | 0 | 0 |

**Summary:** 32 of 34 specs implemented; 0 deferred; 2 gaps (AFF-HOOK-008, AFF-PUB-004).

## Key Findings

1. **README and header still say "No LLM".** `services/affect/src/index.ts:9` and `README.md` ("Mood") say no LLM, but `affect.appraiser` can be `llm` kind (`appraise.ts:43-54`) and the queue exists precisely for slow model calls (`affect.ts:14-20`). OpenSpec only promises no database.
2. **Unused `@cohost/working-memory` dependency.** Listed in `package.json:16` and `tsconfig.json:8`; no import in `src` or `test`. Trivial cleanup.
3. **Duplicated `clamp`.** `mood.ts:55` redefines what `appraise.ts:1` already imports from `@cohost/modules` (`packages/modules/src/index.ts:110`).
4. **Spec numbers match OpenSpec.** Rule deltas, nudge sizes, label thresholds, queue cap 8, 4-char short-line cutoff and 15 s heartbeat all agree with `openspec/specs/affect/spec.md`; the OpenSpec worked examples (`lol nice` -> 0.12/0.08, mention + trash -> -0.15/0.31) reproduce from `appraise.ts:23-32`.
5. **Queued appraisal can outlive pause and reset.** `pause` / `forget_context` neither clear the queue nor does `drain` check `paused` (`affect.ts:36-38,68,94-99`), so a pre-pause llm/http job can still nudge the mood (AFF-HOOK-008).
6. **Publish rejection is unhandled.** `void this.d.bus.publish(...)` (`affect.ts:110`) and the un-caught `drain()` chain (`affect.ts:91`) rely on Node's default crash plus compose's `restart: unless-stopped` (AFF-PUB-004). The `setInterval` is never cleared (`index.ts:29,35`) but `onShutdown` exits the process anyway.
7. **Publish gating is coarser than the state.** Key uses 2-decimal valence/arousal and omits `cause` (`affect.ts:104`) while the published state is 3-decimal (`mood.ts:44`); small or cause-only changes wait for the 15 s heartbeat. `[inferred]` intentional to cut chatter.
8. **Hard-coded tuning.** Resting arousal 0.1 appears three times (`mood.ts:14,28`, `affect.ts:68`); nudge sizes, emotion lists, queue cap and heartbeat period are literals. LLM prompt asks for -0.3..0.3 / 0..0.3 but validation allows +-0.5 (`appraise.ts:47` vs `:37`).

## Work Required

### Must Fix
1. Catch and log `affect.state` publish and appraisal-drain failures so a transient Redis error does not crash the service (AFF-PUB-004).

### Should Fix
2. Clear (or skip) queued appraisal jobs on `pause` and `forget_context` (AFF-HOOK-008, AFF-CTRL-002, AFF-IN-007).
3. Correct the stale "No LLM" wording in `index.ts:9` and the README Mood section (AFF-HOOK-001).
4. Remove the unused `@cohost/working-memory` dependency and reference, and the duplicated local `clamp` (no spec; hygiene).

### Nice to Have
5. Make resting arousal (and possibly the nudge sizes) configurable, or document them as fixed (AFF-MOOD-003).
6. Align the llm prompt's stated delta ranges with the validator's +-0.5 (AFF-HOOK-002).
7. Add tests for `index.ts` wiring, label boundary equalities and the queue/pause interaction (AFF-IN-001, AFF-MOOD-004, AFF-HOOK-008).
8. Move the misplaced queue docblock (`affect.ts:14-19`) onto the class, and clear the publish timer on shutdown (AFF-PUB-001).
