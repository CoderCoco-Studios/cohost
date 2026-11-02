# Arrow: region-hooks

The `@cohost/modules` runner (`Module<I, O>`) that lets salience, affect and the cortex critic run built-in rules, a chat model, or an operator-run HTTP endpoint, always falling back to rules on failure; plus the example HTTP hook server and its docs.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 33 specs: 29 implemented, 0 deferred, 4 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B15** what `extractJson` returns → the first balanced JSON value, including when prose after it has brackets. Specs: HOOK-HELP-003 widened.
2. **S19** throwing `impl.rules` → a documented precondition on regions; the gap is retired. Specs: HOOK-FALLBACK-005 rewritten as the precondition, `[ ]` → `[x]`.
3. **S20** `examples/modules/server.py` → stays in this segment: add `# @spec` annotations, a smoke test against the region validators, and fix the empty-body default. Specs: HOOK-EX-006 reworded.
4. **S21** visibility of fallbacks → the next warning carries the suppressed count. Specs: HOOK-WARN-003 (new).
5. **B20** `examples/modules/README.md:72` → say 1500 is the default for every hook and mention the example config's 2500 for the critic. Specs: none (docs fix).
6. **R5** mock-backed hooks → never succeed (unchanged); a hook built on mock warns once; explicit `mock` on a hook stays rejected by config. Specs: HOOK-WARN-004 (new), HOOK-FALLBACK-006 reworded; CFG-SCH-009 (config).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/region-hooks/region-hooks-design.md

### EARS
- docs/intent/region-hooks/region-hooks-specs.md (33 specs, prefix HOOK: 29 `[x]`, 4 `[ ]`, 0 `[D]`)

### Tests
- packages/modules/test/module.test.ts (11 tests, 11 `@spec` lines citing 19 distinct HOOK IDs; fake HTTP servers for the `http` and OpenAI-compatible `llm` paths)
- Consumer-side coverage lives in `services/salience/test`, `services/affect/test`, `services/cortex/test` (not in this segment); every test-built `Module` there is `rules` or `http`
- No automated test for `examples/modules/server.py`

### Code
- packages/modules/src/index.ts (16 `@spec` lines)
- packages/llm/src/mock.ts:17 (cites HOOK-FALLBACK-006 alongside LLM-MOCK-002)
- packages/modules/package.json, packages/modules/tsconfig.json
- examples/modules/server.py (reference HTTP hook server, Python 3 stdlib; no `@spec` annotations)
- examples/modules/README.md (operator docs and contracts)

### OpenSpec
- openspec/specs/modules/spec.md (no change delta touches this capability)

## Architecture

**Purpose:** One small runner for the three judgement hooks (`brain.salience.module`, `brain.affect.module`, `brain.cortex.critic`). Regions supply rules, prompt and `validate`; the runner supplies kind dispatch, timeouts, JSON extraction, and the fall-back-to-rules guarantee.

**Key Components:**
1. `ModuleImpl<I, O>` (`index.ts:21-28`) - region-supplied `rules`, optional `llm` and `http` specs.
2. `Module` (`index.ts:30-94`) - constructor checks, `run()` dispatch and fallback, 30 s rate-limited `warn()`.
3. `viaLlm` / `withTimeout` (`index.ts:65-75`, `:103-109`) - one provider built via `@cohost/llm`, double timeout enforcement.
4. `viaHttp` (`index.ts:77-86`) - JSON `POST` with `AbortSignal.timeout`.
5. `extractJson`, `clamp`, `isNum` (`index.ts:96-111`) - helpers used by the regions' `validate` functions.
6. `examples/modules/server.py` - stand-in server documenting the `/salience`, `/affect`, `/critic` contracts.

Consumers: `services/salience/src/scoring.ts:61`, `services/affect/src/appraise.ts:55`, `services/cortex/src/critic.ts:46`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Kinds and construction | HOOK-KIND-001 to HOOK-KIND-005 | 5 | 0 | 0 | 5 | 5 |
| LLM kind | HOOK-LLM-001 to HOOK-LLM-005 | 5 | 0 | 0 | 5 | 5 |
| HTTP kind | HOOK-HTTP-001 to HOOK-HTTP-003 | 3 | 0 | 0 | 3 | 2 |
| Fallback | HOOK-FALLBACK-001 to HOOK-FALLBACK-006 | 6 | 0 | 0 | 5 | 3 |
| Warnings | HOOK-WARN-001 to HOOK-WARN-004 | 2 | 0 | 2 | 2 | 1 |
| Helpers | HOOK-HELP-001 to HOOK-HELP-004 | 3 | 0 | 1 | 3 | 3 |
| Reference HTTP server | HOOK-EX-001 to HOOK-EX-006 | 5 | 0 | 1 | 0 | 0 |

**Summary:** 29 of 33 specs implemented; 0 deferred; 4 gaps (HOOK-WARN-003, HOOK-WARN-004, HOOK-HELP-003, HOOK-EX-006). 23 specs cited from code, 19 from tests. No reverse orphans. Implemented but without a code annotation: HOOK-FALLBACK-005 (a precondition on the regions' rules) and HOOK-EX-001 to HOOK-EX-005 (`examples/modules/server.py` is not annotated yet). Implemented but without a test annotation: HOOK-HTTP-001, HOOK-FALLBACK-004, HOOK-FALLBACK-005, HOOK-FALLBACK-006, HOOK-WARN-002, and HOOK-EX-001 to HOOK-EX-005.

## Key Findings

1. **Markers.** The audit found no wrong marker. HOOK-HELP-001 names the bracket-free-prose case the regex handles, and HOOK-FALLBACK-006 describes the only reachable case — a hook cannot select `mock` (the hook provider enum excludes it, `packages/config/src/schema.ts:22`), it can only inherit it from `llm.provider`. HOOK-FALLBACK-005 is now a precondition (`[x]`, S19).
2. **`extractJson` is not "first"** — it spans the first `[`/`{` to the last `]`/`}` (`index.ts:98`), contradicting its own comment and OpenSpec; multi-value, bracket-prefixed or bracket-suffixed replies silently become rules fallbacks (HOOK-HELP-003, B15).
3. **Timeout is enforced twice for `llm`** (`index.ts:67-73`): the abort signal (added in commit `969f6d7` so "timeouts abort the in-flight request") plus `withTimeout`, which does not cancel the request. Default `timeout_ms` is 1500 for every hook (`schema.ts:19`), which `examples/modules/README.md:72-76` says hosted Claude usually exceeds.
4. **Fallbacks are only visible as throttled warnings** (`index.ts:88-93`): one per 30 s per instance, error truncated to 120 chars, no counter or heartbeat surface (HOOK-WARN-003, S21).
5. **`impl.rules` is unguarded** (`index.ts:54`, `:62`), so "the show goes on" depends on region rules never throwing (HOOK-FALLBACK-005, S19: regions guarantee it).
6. **`ModuleConfig` is exported by two packages** (`index.ts:19` and `packages/config/src/schema.ts:29`), derived differently; neither is imported anywhere outside its own file.
7. **Reference server defects** — `examples/modules/server.py:93` empty-body `TypeError` (HOOK-EX-006), single-threaded `HTTPServer` (`:112`), raw-path routing (`:89`), case-sensitive `http` filter (`:76`), binds `0.0.0.0` without auth, critic never returns `emotion` although its docstring shows one (`:35`).
8. **Thin tests for several `[x]` lines** — the http test never inspects the request (HOOK-HTTP-001), the warn test ignores the message (HOOK-WARN-002), nothing throws from `validate` (HOOK-FALLBACK-004), the 200-token default and a signal-ignoring provider are not exercised (HOOK-LLM-003, HOOK-LLM-004).
9. **Contracts are hand-duplicated** across `validate` functions in three services, `examples/modules/README.md` and `server.py`; no test links the Python server to the TypeScript validators.
10. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so other segments' citations of `packages/modules/src/index.ts:NN` stay valid.

## Work Required

### Must Fix
1. Make `extractJson` return the first balanced JSON value, and add tests for two values, bracketed prose before, and brackets in prose after (HOOK-HELP-003; B15).
2. Warn once when an `llm`-kind `Module` is built on the mock provider (HOOK-WARN-004; R5).

### Should Fix
1. Carry the suppressed-fallback count in the next warning (HOOK-WARN-003; S21).
2. Fix the empty-body default in `examples/modules/server.py:93`, add `# @spec HOOK-EX-*` annotations, and add a smoke test that runs the server and checks its responses against the salience, affect and critic validators (HOOK-EX-001 to HOOK-EX-006; S20).
3. Correct `examples/modules/README.md:72`: 1500 is the default for every hook; the example config sets the critic to 2500 (B20).

### Nice to Have
1. Reconcile or remove the duplicate `ModuleConfig` type.
2. Switch the example server to `ThreadingHTTPServer` (LLD Open Question 5).
3. Add the tests listed in Key Finding 8 and warn recurrence after 30 s.
