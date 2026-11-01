# Arrow: working-memory

The in-process rolling window of recent perception events (`Context`), its seen/unseen tracking, the prompt transcript renderer, and the test-injection flag helpers.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. Audit pass complete 2026-11-01, awaiting index update. 26 of 27 specs observed working; 1 gap (transcript line forging).

## Questions for the user

1. **How should `transcript` neutralise newlines (WM-TRANS-008)?** Fields are interpolated raw (`packages/working-memory/src/index.ts:93-96`), and no bus text field is single-line constrained: `chat.message.text`, `speech.heard.text`, `inject.request.text` (`packages/bus/src/events.ts:14`, `:38`, `:176`). Options: flatten `\r`/`\n` to a space in `transcript`, escape them, or reject multi-line text at ingest. Recommended: flatten to a space in `transcript`, the one place lines are built.
2. **Who owns the tag list that the LLM stops mirror?** WM-TRANS-006 here and LLM-STOP-006 in model-backends state the same invariant; the literals are hand-copied (`index.ts:93-95` vs `packages/llm/src/index.ts:45`) and no test imports both packages. Recommended: this segment owns the tags; LLM-STOP-006 cites WM-TRANS-006; one cortex-level test renders a transcript and checks it against the stops. (Same question as model-backends Question 2.)
3. **Should the co-host's own line be a stop?** `<name>: [<emotion>] <text>` (`index.ts:96`) matches no stop, so a model writing a second self line is cut only by the cortex `parseReply` first-line rule (`services/cortex/src/prompt.ts:72`). Recommended: no; the four-stop cap (`packages/llm/src/index.ts:46`) leaves no room and `parseReply` already guards the spoken line. (Same as model-backends Question 3.)
4. **Where should `propagatedFlags` be tested?** WM-FLAG-003/004 are exercised only by salience and cortex region tests (`services/salience/test/salience.region.test.ts:193`, `:202`, `:220`; `services/cortex/test/cortex.region.test.ts:308`, `:318`), which carry no `@spec`; no test passes an `undefined` source, though the test at `salience.region.test.ts:202` names a no-focus case. Recommended: add unit tests in `context.test.ts`, including `undefined` and a stray `remember`.
5. **Should `all()` return a copy?** It returns the live internal array (`index.ts:84-86`); the only outside caller is a salience test (`services/salience/test/salience.region.test.ts:91`). A shallow copy keeps object identity, which `markSeenEvents` needs. Recommended: return `[...this.events]` and say so in WM-WIN-006.
6. **Is it intended that injected events look real in the prompt?** Flags are kept on the entry but never rendered (`index.ts:93-96`, WM-TRANS-007). Recommended: yes, keep it; injection is meant to exercise the real path.
7. **Should affect drop its unused dependency?** `services/affect/package.json:16` and `services/affect/tsconfig.json:8` reference this package; nothing in `services/affect` imports it. Recommended: remove both (affect segment).

## References

### HLD
- docs/high-level-design.md (System Design: brain regions salience and cortex)

### LLD
- docs/intent/working-memory/working-memory-design.md

### EARS
- docs/intent/working-memory/working-memory-specs.md (27 specs: 26 `[x]`, 1 `[ ]`, 0 `[D]`)

### Tests
- packages/working-memory/test/context.test.ts (8 tests, 8 `@spec` lines citing 21 distinct WM IDs; pure, no Redis)
- Indirect coverage of `propagatedFlags` (other segments, no `@spec`): services/salience/test/salience.region.test.ts:193, :202, :210, :220; services/cortex/test/cortex.region.test.ts:308, :318

### Code
- packages/working-memory/src/index.ts (19 `@spec` lines)
- packages/working-memory/package.json, packages/working-memory/tsconfig.json
- Consumers: services/salience/src/salience.ts, services/salience/src/scheduler.ts, services/salience/src/scoring.ts (type only), services/cortex/src/cortex.ts, services/cortex/src/prompt.ts
- Coupled code: packages/llm/src/index.ts:45-47 (`TRANSCRIPT_STOPS`, `REPLY_STOPS`); services/cortex/src/prompt.ts:71-72 (`parseReply`)

### OpenSpec
- openspec/specs/working-memory/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/working-memory/spec.md
- (propagation is specified under openspec/changes/archive/2026-11-01-add-test-injection/specs/salience/spec.md and .../cortex/spec.md)

## Architecture

**Purpose:** Give salience (should I respond?) and cortex (what do I say?) the same bounded view of what has just happened, and render it as the transcript text used in the LLM prompt.

**Key Components:**
1. `Context` — count-bounded array of `ContextEvent` (`chat`, `vision`, `speech`, `self`) with `push`, `pushSelf`, `unseen`, `markSeenEvents`, `markSeen`, `last`, `clear`, `all`, `transcript`, and the public `lastVision`.
2. `InjectionFlags` / `flagsOf` — retain `injected` and `remember` on stored perception events.
3. `propagatedFlags(src)` — copies the flags onto derived bus events only when the source is injected.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Window | WM-WIN-001 to 006 | 6 | 0 | 0 | 5 | 4 |
| Ingest | WM-PUSH-001 to 006 | 6 | 0 | 0 | 6 | 6 |
| Seen tracking | WM-SEEN-001 to 003 | 3 | 0 | 0 | 3 | 3 |
| Transcript | WM-TRANS-001 to 008 | 7 | 0 | 1 | 7 | 6 |
| Injection flags | WM-FLAG-001 to 004 | 4 | 0 | 0 | 4 | 2 |

**Summary:** 26 of 27 specs implemented; 0 deferred; 1 gap (WM-TRANS-008). 25 specs cited from code, 21 from tests. No reverse orphans. Implemented but without a test annotation: WM-WIN-002 (negative property), WM-WIN-005 (implemented in salience/cortex, outside this package), WM-TRANS-006 (cross-package), WM-FLAG-003, WM-FLAG-004 (tested only in other segments).

## Key Findings

1. **No marker was wrong.** One line was added: WM-WIN-006 (`all()` returns the window oldest first), a behavior every test relies on. WM-FLAG-003/004 now say truthy/falsy, matching `if (!e?.injected)` (`index.ts:18`).
2. **The stop-string contract, documented from code** — this package joins lines with `"\n"`, so every entry after the first begins `"\n[chat]"`, `"\n[voice]"` or `"\n[screen]"`, exactly the `TRANSCRIPT_STOPS` (`packages/llm/src/index.ts:45`); Ollama/OpenAI add `"\n\n"` (`:47`), Claude does not, `json: true` calls send none. The cortex primes the model with a closing `<name>:` (`services/cortex/src/prompt.ts:58-67`) and `parseReply` keeps only the first reply line (`prompt.ts:72`). The self line is not a stop. No shared constant, no cross-package test, and the invariant is specified twice (WM-TRANS-006, LLM-STOP-006). Full write-up: model-backends LLD, "Stop sequences and the transcript coupling".
3. **Transcript lines are unescaped** (`index.ts:93-95`); any bus text with a newline can forge a `[chat]`-style line (WM-TRANS-008, Question 1). Chat text is no more constrained than speech text (`packages/bus/src/events.ts:14`, `:38`).
4. **Injected events are indistinguishable from real ones in the prompt** — flags are retained on the entry but never rendered (`index.ts:93-96`; Question 6).
5. **Flag propagation lives here but is only tested elsewhere** — `propagatedFlags` (`index.ts:16-20`) is exercised by salience and cortex region tests, not `context.test.ts`; no test passes an `undefined` source (Question 4).
6. **Two independent windows** — salience (`services/salience/src/salience.ts:32`) and cortex (`services/cortex/src/cortex.ts:35`) each keep their own `Context`; only cortex records own lines via `pushSelf` (`cortex.ts:49`).
7. **`markSeenEvents` matches by object identity** (`index.ts:70-73`) and `all()` returns the live array (`index.ts:84-86`); salience depends on the identity behavior to leave late arrivals unseen (`salience.ts:97,117`).
8. **Vision slot semantics** — one vision entry, moved to the end on each update (`index.ts:45-48`); `lastVision` survives `clear()` (`index.ts:81-83`, test `context.test.ts:60`). A real update replaces an injected one and vice versa.
9. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so other segments' citations of `packages/working-memory/src/index.ts:NN` stay valid.

## Work Required

### Must Fix
1. None blocking. (WM-TRANS-008 is a latent prompt-integrity risk, not a current failure.)

### Should Fix
1. Neutralise newlines in transcript fields (WM-TRANS-008; Question 1).
2. Settle ownership of the tag list and add one cross-package test (WM-TRANS-006; Question 2).

### Nice to Have
1. Add unit tests for `propagatedFlags`, including an `undefined` source, and for `last()` returning the newest event (WM-FLAG-003, WM-FLAG-004, WM-WIN-004; Question 4).
2. Drop the unused `@cohost/working-memory` dependency from affect and move `@cohost/bus` / `@cohost/config` to type-only usage in this package's manifest (Question 7).
3. Return a copy from `all()` (WM-WIN-006; Question 5).
