# Arrow: working-memory

The in-process rolling window of recent perception events (`Context`), its seen/unseen tracking, the prompt transcript renderer, and the test-injection flag helpers.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 25 of 26 specs observed working; 1 gap (transcript line forging).

## References

### HLD
- docs/high-level-design.md (System Design: brain regions salience and cortex)

### LLD
- docs/intent/working-memory/working-memory-design.md

### EARS
- docs/intent/working-memory/working-memory-specs.md (26 specs: 25 `[x]`, 1 `[ ]`, 0 `[D]`)

### Tests
- packages/working-memory/test/context.test.ts (8 tests, pure, no Redis)
- Indirect coverage of `propagatedFlags`: services/salience/test/salience.region.test.ts:195-222, services/cortex/test/cortex.region.test.ts:310-320

### Code
- packages/working-memory/src/index.ts
- packages/working-memory/package.json, packages/working-memory/tsconfig.json
- Consumers: services/salience/src/salience.ts, services/salience/src/scheduler.ts, services/cortex/src/cortex.ts, services/cortex/src/prompt.ts
- Coupled code: packages/llm/src/index.ts:45-47 (`TRANSCRIPT_STOPS`, `REPLY_STOPS`)

### OpenSpec
- openspec/specs/working-memory/spec.md
- openspec/changes/add-test-injection/specs/working-memory/spec.md
- (propagation is specified under openspec/changes/add-test-injection/specs/salience/spec.md and .../cortex/spec.md)

## Architecture

**Purpose:** Give salience (should I respond?) and cortex (what do I say?) the same bounded view of what has just happened, and render it as the transcript text used in the LLM prompt.

**Key Components:**
1. `Context` — count-bounded array of `ContextEvent` (`chat`, `vision`, `speech`, `self`) with `push`, `pushSelf`, `unseen`, `markSeenEvents`, `markSeen`, `last`, `clear`, `all`, `transcript`, and the public `lastVision`.
2. `InjectionFlags` / `flagsOf` — retain `injected` and `remember` on stored perception events.
3. `propagatedFlags(src)` — copies the flags onto derived bus events only when the source is injected.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Window | WM-WIN-001 to 005 | 5 | 0 | 0 |
| Ingest | WM-PUSH-001 to 006 | 6 | 0 | 0 |
| Seen tracking | WM-SEEN-001 to 003 | 3 | 0 | 0 |
| Transcript | WM-TRANS-001 to 008 | 7 | 0 | 1 |
| Injection flags | WM-FLAG-001 to 004 | 4 | 0 | 0 |

**Summary:** 25 of 26 specs implemented; 0 deferred; 1 gap.

## Key Findings

1. **Transcript tags are coupled to LLM stop strings with no shared constant** — `[chat]`/`[voice]`/`[screen]` at `packages/working-memory/src/index.ts:93-95` versus `TRANSCRIPT_STOPS` at `packages/llm/src/index.ts:45`, reused in `REPLY_STOPS` (`:47`) and sent at `:86` and `:150`. Only a test title (`context.test.ts:79`) records the dependency; renaming either side silently breaks reply truncation. (WM-TRANS-006)
2. **Transcript lines are unescaped** — user, speaker and text are interpolated directly (`index.ts:93-95`); multi-line STT or injected text could forge `[chat]`-style lines in the prompt. (WM-TRANS-008)
3. **Injected events are indistinguishable from real ones in the prompt** — flags are retained on the entry but never rendered (`index.ts:93-96`). `[inferred]` deliberate: injection is meant to exercise the real code path.
4. **Flag propagation lives here but is only tested elsewhere** — `propagatedFlags` (`index.ts:16-20`) is exercised by salience and cortex region tests, not `context.test.ts`; the OpenSpec working-memory delta does not mention it. (WM-FLAG-003, WM-FLAG-004)
5. **Two independent windows** — salience (`services/salience/src/salience.ts:32`) and cortex (`services/cortex/src/cortex.ts:35`) each keep their own `Context`; only cortex records own lines via `pushSelf` (`cortex.ts:49`). `services/affect/package.json:16` declares the dependency but never imports it.
6. **`markSeenEvents` matches by object identity** (`index.ts:70-73`) and `all()` returns the live array (`index.ts:84-86`); salience depends on the identity behavior to leave late arrivals unseen (`salience.ts:97,117`).
7. **Vision slot semantics** — one vision entry, moved to the end on each update (`index.ts:45-48`); `lastVision` survives `clear()` (`index.ts:81-83`, test `context.test.ts:55`). A real update replaces an injected one and vice versa.

## Work Required

### Must Fix
1. None blocking. (WM-TRANS-008 is a latent prompt-integrity risk, not a current failure.)

### Should Fix
2. Escape or flatten newlines in transcript fields, or reject multi-line text at ingest (WM-TRANS-008).
3. Share the tag strings between this package and `packages/llm` (one constant, or a test that renders a transcript and asserts every tag has a stop entry) (WM-TRANS-006).

### Nice to Have
4. Add unit tests for `propagatedFlags` and `last()` in `context.test.ts` (WM-FLAG-003, WM-FLAG-004, WM-WIN-004).
5. Drop the unused `@cohost/working-memory` dependency from `services/affect/package.json` and move `@cohost/bus` / `@cohost/config` to type-only usage in this package's manifest.
6. Return a copy (or frozen view) from `all()`.
