# Arrow: working-memory

The in-process rolling window of recent perception events (`Context`), its seen/unseen tracking, the prompt transcript renderer, and the test-injection flag helpers.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 28 specs: 28 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes have landed (platform-models cascade fix).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **S22** newlines in transcript fields → flatten `\r`/`\n` to a space in `transcript`. Specs: WM-TRANS-008.
2. **P10** tag-list ownership → this segment owns the tags and exports them (`TRANSCRIPT_TAGS`); the LLM stops derive from the export; a cortex-level test checks the pair. Specs: WM-TRANS-006, WM-TRANS-009 (cites LLM-STOP-006, LLM-STOP-007).
3. **P10** self line as a stop → no; the stops are a token saver and `parseReply` is the guard. Specs: WM-TRANS-006.
4. **S56** where `propagatedFlags` is tested → unit tests in `packages/working-memory/test/context.test.ts`, including an `undefined` source and a stray `remember`. Specs: none (test work). **H5** adds `@spec WM-FLAG-003` / `WM-FLAG-004` to the salience and cortex region tests that exercise them.
5. **S23** `all()` → returns a shallow copy, elements identical. Specs: WM-WIN-006.
6. **S24** injected events in the prompt → render exactly like real ones. Specs: WM-TRANS-007 (confirmed).
7. **S25** affect's unused dependency → affect drops it (affect segment). Specs: none here.
8. **S29** `forget_context` and `lastVision` (cortex question) → `clear()` also resets `lastVision`. Specs: WM-WIN-003.

## References

### HLD
- docs/high-level-design.md (System Design: brain regions salience and cortex)

### LLD
- docs/intent/working-memory/working-memory-design.md

### EARS
- docs/intent/working-memory/working-memory-specs.md (28 specs: 28 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- packages/working-memory/test/context.test.ts (14 tests, 14 `@spec` lines citing 26 distinct WM IDs; pure, no Redis)
- Further coverage of `propagatedFlags` (other segments; the unit tests above are the primary coverage): services/salience/test/salience.region.test.ts:193, :202, :210, :220; services/cortex/test/cortex.region.test.ts:332, :343

### Code
- packages/working-memory/src/index.ts (21 `@spec` lines)
- packages/working-memory/package.json, packages/working-memory/tsconfig.json
- Consumers: services/salience/src/salience.ts, services/salience/src/scheduler.ts, services/salience/src/scoring.ts (type only), services/cortex/src/cortex.ts, services/cortex/src/prompt.ts
- Coupled code: packages/llm/src/index.ts:47-49 (`TRANSCRIPT_STOPS`, `REPLY_STOPS`, derived from `TRANSCRIPT_TAGS` once LLM-STOP-007 lands); services/cortex/src/prompt.ts:75-76 (`parseReply`)

### OpenSpec
- openspec/specs/working-memory/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/working-memory/spec.md
- (propagation is specified under openspec/changes/archive/2026-11-01-add-test-injection/specs/salience/spec.md and .../cortex/spec.md)

## Architecture

**Purpose:** Give salience (should I respond?) and cortex (what do I say?) the same bounded view of what has just happened, and render it as the transcript text used in the LLM prompt.

**Key Components:**
1. `Context` — count-bounded array of `ContextEvent` (`chat`, `vision`, `speech`, `self`) with `push`, `pushSelf`, `unseen`, `markSeenEvents`, `markSeen`, `last`, `clear`, `all`, `transcript`, and the public `lastVision`.
2. `InjectionFlags` / `flagsOf` — retain `injected` and `remember` on stored perception events.
3. `TRANSCRIPT_TAGS` — the exported tag list (`[chat]`, `[voice]`, `[screen]`) that `transcript` renders and the LLM layer derives its stops from.
4. `propagatedFlags(src)` — copies the flags onto derived bus events only when the source is injected.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Window | WM-WIN-001 to 006 | 6 | 0 | 0 | 5 | 4 |
| Ingest | WM-PUSH-001 to 006 | 6 | 0 | 0 | 6 | 6 |
| Seen tracking | WM-SEEN-001 to 003 | 3 | 0 | 0 | 3 | 3 |
| Transcript | WM-TRANS-001 to 009 | 9 | 0 | 0 | 9 | 9 |
| Injection flags | WM-FLAG-001 to 004 | 4 | 0 | 0 | 4 | 4 |

**Summary:** 28 of 28 specs implemented; 0 deferred; 0 gaps. 27 specs cited from code, 26 from tests. No reverse orphans. Implemented but without a test annotation: WM-WIN-002 (negative property), WM-WIN-005 (implemented in salience/cortex, outside this package).

## Key Findings

1. **Markers.** The audit found no wrong marker; two lines changed intent by owner decision (WM-WIN-003, WM-WIN-006) and are now implemented. One line was added by the audit: WM-WIN-006 (`all()` returns the window oldest first), a behavior every test relies on. WM-TRANS-009 (the exported tag list) was added with the P10 fix. WM-FLAG-003/004 now say truthy/falsy, matching `if (!e?.injected)` (`index.ts:18`).
2. **The stop-string contract, documented from code** — this package joins lines with `"\n"`, so every entry after the first begins `"\n[chat]"`, `"\n[voice]"` or `"\n[screen]"`, exactly the `TRANSCRIPT_STOPS` (`packages/llm/src/index.ts:47`); Ollama/OpenAI add `"\n\n"` (`:47`), Claude does not, `json: true` calls send none. The cortex primes the model with a closing `<name>:` (`services/cortex/src/prompt.ts:61-69`) and `parseReply` keeps only the first reply line (`prompt.ts:76`). The self line is not a stop, by decision (P10). This segment owns the tags (WM-TRANS-006) and exports them as `TRANSCRIPT_TAGS` (WM-TRANS-009); LLM-STOP-006 / LLM-STOP-007 derive the stops from the export; the cortex-level check of the pair is still to come. Full write-up: model-backends LLD, "Stop sequences and the transcript coupling".
3. **Transcript lines are one line each** — `transcript` flattens `\r`/`\n` in user, speaker and text to a space (`oneLine`, WM-TRANS-008), so bus text cannot forge a `[chat]`-style line; no bus text field is constrained to one line (`packages/bus/src/events.ts:17`, `:43`).
4. **Injected events are indistinguishable from real ones in the prompt** — flags are retained on the entry but never rendered (`index.ts:93-96`; intended, S24).
5. **Flag propagation lives here and is tested here** — `propagatedFlags` (`index.ts:16-20`) has unit tests in `context.test.ts` (undefined source, stray `remember`; WM-FLAG-003/004) as well as the salience and cortex region tests.
6. **Two independent windows** — salience (`services/salience/src/salience.ts:32`) and cortex (`services/cortex/src/cortex.ts:35`) each keep their own `Context`; only cortex records own lines via `pushSelf` (`cortex.ts:51`).
7. **`markSeenEvents` matches by object identity** (`index.ts:70-73`) and `all()` returns a shallow copy whose elements are the window's own objects (WM-WIN-006); salience depends on the identity behavior to leave late arrivals unseen (`salience.ts:97,117`).
8. **Vision slot semantics** — one vision entry, moved to the end on each update (`index.ts:45-48`); `clear()` resets `lastVision` (WM-WIN-003; test `context.test.ts:60`). A real update replaces an injected one and vice versa.
9. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so other segments' citations of `packages/working-memory/src/index.ts:NN` stay valid.

## Work Required

### Must Fix
None.

### Should Fix
1. Add `@spec WM-FLAG-003` / `WM-FLAG-004` to the salience and cortex region tests that exercise propagation (`services/salience/test/salience.region.test.ts:193`, `:202`, `:220`; `services/cortex/test/cortex.region.test.ts:332`, `:343`) (H5; other segments' files).

### Nice to Have
1. Move `@cohost/bus` / `@cohost/config` to type-only usage in this package's manifest (LLD Open Question 3).
2. The cross-package stop/tag test (WM-TRANS-006, LLM-STOP-006) is owned by the cortex segment.
