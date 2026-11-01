# Arrow: region-hooks

The `@cohost/modules` runner (`Module<I, O>`) that lets salience, affect and the cortex critic run built-in rules, a chat model, or an operator-run HTTP endpoint, always falling back to rules on failure; plus the example HTTP hook server and its docs.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **What exactly should `extractJson` return?** The comment and OpenSpec say "the first JSON object or array" (`packages/modules/src/index.ts:96`); the regex spans first opener to last closer (`:98`), so two values, bracketed prose before the JSON, or a stray `]`/`}` after it all fall back to rules. HOOK-HELP-003 (`[ ]`) covers only the first two cases. Recommended: "the first balanced JSON value anywhere in the text", and extend HOOK-HELP-003 to trailing brackets.
2. **Must `run()` survive a throwing `impl.rules` (HOOK-FALLBACK-005)?** `impl.rules` is called unguarded (`index.ts:54`, `:62`), and there is no fallback value of type `O` to return if it throws. Recommended: make "rules must not throw" a documented precondition on regions and retire the gap.
3. **Who annotates and tests `examples/modules/server.py`?** HOOK-EX-001 to HOOK-EX-006 live there, but this pass did not edit `examples/`; the server has no test and one known defect (`server.py:93`, `Content-Length: 0` raises `TypeError`, HOOK-EX-006). Recommended: keep HOOK-EX in this segment, add `# @spec` comments and a smoke test against the three region validators, and fix the `or b"{}"` placement.
4. **Is a throttled warning enough to reveal fallbacks (HOOK-WARN-001)?** One warn per 30 s per instance with no count (`index.ts:88-93`); a permanently broken hook looks merely noisy. Recommended: include the suppressed-fallback count in the next warning.
5. **Should `examples/modules/README.md:72` say "default 1500 for every hook"?** It says "default 1500 for salience and affect", but the schema default is 1500 for all three (`packages/config/src/schema.ts:17`, `:108`, `:134`, `:150`); only `config/config.example.yaml:122` sets the critic to 2500. Recommended: yes, and mention the example config's 2500.
6. **Should mock-backed `llm` hooks ever succeed?** The mock answers `{}` (`packages/llm/src/mock.ts:17`), which all three validators reject, so isolated runs never exercise the llm-hook success path (HOOK-FALLBACK-006). Recommended: leave it; isolated runs are for wiring, not hook quality.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/region-hooks/region-hooks-design.md

### EARS
- docs/intent/region-hooks/region-hooks-specs.md (31 specs, prefix HOOK: 28 `[x]`, 3 `[ ]`, 0 `[D]`)

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

Consumers: `services/salience/src/scoring.ts:61`, `services/affect/src/appraise.ts:55`, `services/cortex/src/critic.ts:44`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Kinds and construction | HOOK-KIND-001 to HOOK-KIND-005 | 5 | 0 | 0 | 5 | 5 |
| LLM kind | HOOK-LLM-001 to HOOK-LLM-005 | 5 | 0 | 0 | 5 | 5 |
| HTTP kind | HOOK-HTTP-001 to HOOK-HTTP-003 | 3 | 0 | 0 | 3 | 2 |
| Fallback | HOOK-FALLBACK-001 to HOOK-FALLBACK-006 | 5 | 0 | 1 | 5 | 3 |
| Warnings | HOOK-WARN-001 to HOOK-WARN-002 | 2 | 0 | 0 | 2 | 1 |
| Helpers | HOOK-HELP-001 to HOOK-HELP-004 | 3 | 0 | 1 | 3 | 3 |
| Reference HTTP server | HOOK-EX-001 to HOOK-EX-006 | 5 | 0 | 1 | 0 | 0 |

**Summary:** 28 of 31 specs implemented; 0 deferred; 3 gaps (HOOK-FALLBACK-005, HOOK-HELP-003, HOOK-EX-006). 23 specs cited from code, 19 from tests. No reverse orphans. Implemented but without a test annotation: HOOK-HTTP-001, HOOK-FALLBACK-004, HOOK-FALLBACK-006, HOOK-WARN-002, and HOOK-EX-001 to HOOK-EX-005 (not annotated: `examples/` was outside this pass).

## Key Findings

1. **No marker was wrong.** Two lines were reworded to match code: HOOK-HELP-001 now names the bracket-free-prose case the regex handles, and HOOK-FALLBACK-006 now describes the only reachable case — a hook cannot select `mock` (the hook provider enum excludes it, `packages/config/src/schema.ts:20`), it can only inherit it from `llm.provider`.
2. **`extractJson` is not "first"** — it spans the first `[`/`{` to the last `]`/`}` (`index.ts:98`), contradicting its own comment and OpenSpec; multi-value, bracket-prefixed or bracket-suffixed replies silently become rules fallbacks (HOOK-HELP-003, Question 1).
3. **Timeout is enforced twice for `llm`** (`index.ts:67-73`): the abort signal (added in commit `969f6d7` so "timeouts abort the in-flight request") plus `withTimeout`, which does not cancel the request. Default `timeout_ms` is 1500 for every hook (`schema.ts:17`), which `examples/modules/README.md:72-76` says hosted Claude usually exceeds.
4. **Fallbacks are only visible as throttled warnings** (`index.ts:88-93`): one per 30 s per instance, error truncated to 120 chars, no counter or heartbeat surface (Question 4).
5. **`impl.rules` is unguarded** (`index.ts:54`, `:62`), so "the show goes on" depends on region rules never throwing (HOOK-FALLBACK-005, Question 2).
6. **`ModuleConfig` is exported by two packages** (`index.ts:19` and `packages/config/src/schema.ts:27`), derived differently; neither is imported anywhere outside its own file.
7. **Reference server defects** — `examples/modules/server.py:93` empty-body `TypeError` (HOOK-EX-006), single-threaded `HTTPServer` (`:112`), raw-path routing (`:89`), case-sensitive `http` filter (`:76`), binds `0.0.0.0` without auth, critic never returns `emotion` although its docstring shows one (`:35`).
8. **Thin tests for several `[x]` lines** — the http test never inspects the request (HOOK-HTTP-001), the warn test ignores the message (HOOK-WARN-002), nothing throws from `validate` (HOOK-FALLBACK-004), the 200-token default and a signal-ignoring provider are not exercised (HOOK-LLM-003, HOOK-LLM-004).
9. **Contracts are hand-duplicated** across `validate` functions in three services, `examples/modules/README.md` and `server.py`; no test links the Python server to the TypeScript validators.
10. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so other segments' citations of `packages/modules/src/index.ts:NN` stay valid. (`docs/intent/config/config-design.md:146` cites `index.ts:230` for `ModuleConfig`; the real line is `:19`.)

## Work Required

### Must Fix
1. Nothing blocks operation; the three `[ ]` specs are the gaps (HOOK-HELP-003, HOOK-FALLBACK-005, HOOK-EX-006).

### Should Fix
1. Make `extractJson` return the first balanced JSON value (HOOK-HELP-003, HOOK-LLM-005; Question 1).
2. Guard `impl.rules` or document that it must not throw (HOOK-FALLBACK-005; Question 2).
3. Fix the empty-body default in `server.py:93` and annotate the server (HOOK-EX-006; Question 3).
4. Give operators a way to see fallback rates (HOOK-WARN-001; Question 4).

### Nice to Have
1. Reconcile or remove the duplicate `ModuleConfig` type.
2. Switch the example server to `ThreadingHTTPServer` and bind loopback by default.
3. Add the tests listed in Key Finding 8, warn recurrence after 30 s, and a smoke test of `server.py` against the region validators (HOOK-EX-001 to HOOK-EX-005).
4. Correct `examples/modules/README.md:72` (Question 5).
