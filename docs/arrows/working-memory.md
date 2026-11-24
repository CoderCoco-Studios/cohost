# Arrow: working-memory

The in-process rolling window of recent perception events (`Context`), its seen/unseen tracking, the prompt transcript renderer, and the test-injection flag helpers.

## Status

**PARTIAL**: 74 specs: 73 implemented (`[x]`), 0 gaps (`[ ]`), 1 deferred (`[D]`: WM-STACK-001, the interrupted-thought stack of the deferred dynamic-speech ideal). The LLD has no open questions. The unfinished line (WM-UNF-001 to 006) and the streamed-line specs (extendSelf, markFallback with a `seq`, the later-clause transcript note) are implemented. Design: the LLD's Fallback lines section and the HLD's Barge-in and echo gate protocol and Future / ideal state sections.

## References

### HLD
- docs/high-level-design.md (System Design: brain regions salience and cortex)

### LLD
- docs/intent/working-memory/working-memory-design.md

### EARS
- docs/intent/working-memory/working-memory-specs.md (74 specs: 73 `[x]`, 0 `[ ]`, 1 `[D]`)

### Tests
- packages/working-memory/test/context.test.ts (pure, no Redis)
- packages/working-memory/test/fallback.test.ts
- packages/working-memory/test/extend.test.ts (streamed lines: extendSelf, markFallback with a seq, later-clause transcript note)
- packages/working-memory/test/package.test.ts
- packages/working-memory/test/timing.test.ts
- packages/working-memory/test/window.test.ts
- services/salience/test/salience.dispositions.test.ts (WM-WIN-005)
- services/cortex/test/cortex.dispositions.test.ts (WM-WIN-005)
- Cross-package stop/tag check (WM-TRANS-006 with LLM-STOP-006/007): services/cortex/test/transcript-stops.test.ts

### Code
- packages/working-memory/src/index.ts
- packages/working-memory/package.json, packages/working-memory/tsconfig.json
- Consumers: services/salience/src/salience.ts, services/salience/src/scheduler.ts, services/salience/src/scoring.ts (type only), services/cortex/src/cortex.ts, services/cortex/src/prompt.ts
- Coupled code: packages/llm/src/index.ts (`TRANSCRIPT_STOPS`, `REPLY_STOPS`, derived from `TRANSCRIPT_TAGS`, LLM-STOP-007); services/cortex/src/prompt.ts (`parseReply`)

## Architecture

**Purpose:** Give salience (should I respond?) and cortex (what do I say?) the same bounded view of what has just happened, and render it as the transcript text used in the LLM prompt.

**Key Components:**
1. `Context` — count-bounded array of `ContextEvent` (`chat`, `vision`, `speech`, `self`) with `push`, `pushUnfinished`, `pushSelf`, `extendSelf`, `markFallback`, `unseen`, `markSeenEvents`, `markSeen`, `last`, `clear`, `all`, `transcript`, and the public `lastVision`.
2. `InjectionFlags` / `flagsOf` — retain `injected` and `remember` on stored perception events.
3. `TRANSCRIPT_TAGS` — the exported tag list (`[chat]`, `[voice]`, `[screen]`) that `transcript` renders and the LLM layer derives its stops from.
4. `propagatedFlags(src)` — copies the flags onto derived bus events only when the source is injected.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Window | WM-WIN-001 to WM-WIN-012 | 12 | 0 | 0 | 11 (WM-WIN-005 is annotated in the salience and cortex service tests) |
| Ingest | WM-PUSH-001 to WM-PUSH-025 | 25 | 0 | 0 | 25 |
| Seen tracking | WM-SEEN-001 to WM-SEEN-004 | 4 | 0 | 0 | 4 |
| Package | WM-PKG-001 | 1 | 0 | 0 | 1 |
| Transcript | WM-TRANS-001 to WM-TRANS-015 | 15 | 0 | 0 | 15 |
| Injection flags | WM-FLAG-001 to WM-FLAG-004 | 4 | 0 | 0 | 4 |
| Forgetting | WM-FORGET-001 to WM-FORGET-006 | 6 | 0 | 0 | 6 |
| Unfinished lines | WM-UNF-001 to WM-UNF-006 | 6 | 0 | 0 | 6 |
| Interrupted thoughts | WM-STACK-001 | 0 | 1 | 0 | 0 |

**Summary:** 74 specs: 73 implemented, 0 gaps, 1 deferred. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **The stop-string contract** — this package joins lines with `"\n"`, so every entry after the first begins `"\n[chat]"`, `"\n[voice]"` or `"\n[screen]"`, exactly the `TRANSCRIPT_STOPS` in `packages/llm/src/index.ts`; Ollama/OpenAI add `"\n\n"`, Claude does not, `json: true` calls send none. The cortex primes the model with a closing `<name>:` and `parseReply` keeps only the first reply line. The self line is not a stop, by decision. This segment owns the tags (WM-TRANS-006) and exports them as `TRANSCRIPT_TAGS` (WM-TRANS-009); LLM-STOP-006 / LLM-STOP-007 derive the stops from the export; `services/cortex/test/transcript-stops.test.ts` checks the pair. Full write-up: model-backends LLD, "Stop sequences and the transcript coupling".
2. **Transcript lines are one line each** — `transcript` flattens `\r`/`\n` to a space in speech text, vision and self lines (`oneLine`, WM-TRANS-008, WM-TRANS-011), and chat lines render the label via `speakerLabel` and the text via `quoteUntrusted` from `@cohost/shared/untrusted` (WM-TRANS-002, WM-TRANS-014), so bus text cannot forge a `[chat]`-style line; no bus text field is constrained to one line (`packages/bus/src/events.ts`). Speech speakers render through `speakerLabel` as well (WM-TRANS-003).
3. **Injected events are indistinguishable from real ones in the prompt** — flags are retained on the entry but never rendered (intended, WM-TRANS-007).
4. **Flag propagation lives here and is tested here** — `propagatedFlags` has unit tests in `context.test.ts` (undefined source, stray `remember`; WM-FLAG-003/004).
5. **Two independent windows** — salience and cortex each keep their own `Context`, built by `Context.forBrain` (WM-WIN-005, WM-WIN-008); only cortex records own lines via `pushSelf`.
6. **`markSeenEvents` matches by event id** (WM-SEEN-002), and `all()` returns a shallow copy whose elements are the window's own objects (WM-WIN-006); salience depends on id matching to leave late arrivals unseen.
7. **Vision slot semantics** — one vision entry, moved to the end on each update; `clear()` resets `lastVision` (WM-WIN-003). A real update replaces an injected one and vice versa.

## Work Required

- Platform, user id and forgetting: the chat entry carries `platform`, `userId` (when present) and `messageId` (when present) (WM-PUSH-001), and `forget` removes chat for a `chat.removed` (WM-FORGET-001 to WM-FORGET-006), returning the count removed. Consumers that call `forget` and key viewers by `viewerKey` are other segments' work.
### Must Fix
None.

### Should Fix
1. Add `@spec WM-FLAG-003` / `WM-FLAG-004` to the salience and cortex region tests that exercise propagation (other segments' files).

### Nice to Have
None.
