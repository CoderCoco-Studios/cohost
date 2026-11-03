# Arrow: region-hooks

The `@cohost/modules` runner (`Module<I, O>`) that lets salience, affect and the cortex critic run built-in rules, a chat model, or an operator-run HTTP endpoint, always falling back to rules on failure; plus the example HTTP hook server and its docs.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 33 specs: 33 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes have landed (platform-models cascade fix).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B15** what `extractJson` returns → the first balanced JSON value, including when prose after it has brackets. Specs: HOOK-HELP-003.
2. **S19** throwing `impl.rules` → a documented precondition on regions; the gap is retired. Specs: HOOK-FALLBACK-005 (the precondition is written on `ModuleImpl.rules` and pinned by a test).
3. **S20** `examples/modules/server.py` → stays in this segment: add `# @spec` annotations, a smoke test against the region validators, and fix the empty-body default. Specs: HOOK-EX-006.
4. **S21** visibility of fallbacks → the next warning carries the suppressed count. Specs: HOOK-WARN-003.
5. **B20** `examples/modules/README.md:72` → say 1500 is the default for every hook and mention the example config's 2500 for the critic. Specs: none (docs fix).
6. **R5** mock-backed hooks → never succeed (unchanged); a hook built on mock warns once; explicit `mock` on a hook stays rejected by config. Specs: HOOK-WARN-004, HOOK-FALLBACK-006; CFG-SCH-009 (config).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/region-hooks/region-hooks-design.md

### EARS
- docs/intent/region-hooks/region-hooks-specs.md (33 specs, prefix HOOK: 33 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- packages/modules/test/module.test.ts (15 tests, 15 `@spec` lines; fake HTTP servers for the `http` and OpenAI-compatible `llm` paths)
- packages/modules/test/example-server.test.ts (2 tests, 2 `@spec` lines: fixture responses through the real region validators; the live `server.py` when `python3` is installed). 30 distinct HOOK IDs across both files.
- examples/modules/fixtures/contracts.json (recorded request/response pairs for the three endpoints)
- Consumer-side coverage lives in `services/salience/test`, `services/affect/test`, `services/cortex/test` (not in this segment); every test-built `Module` there is `rules` or `http`

### Code
- packages/modules/src/index.ts (18 `@spec` lines)
- packages/llm/src/mock.ts:17 (cites HOOK-FALLBACK-006 alongside LLM-MOCK-002)
- packages/modules/package.json, packages/modules/tsconfig.json
- examples/modules/server.py (reference HTTP hook server, Python 3 stdlib; 7 `@spec` lines)
- examples/modules/README.md (operator docs and contracts)

### OpenSpec
- openspec/specs/modules/spec.md (no change delta touches this capability)

## Architecture

**Purpose:** One small runner for the three judgement hooks (`brain.salience.module`, `brain.affect.module`, `brain.cortex.critic`). Regions supply rules, prompt and `validate`; the runner supplies kind dispatch, timeouts, JSON extraction, and the fall-back-to-rules guarantee.

**Key Components:**
1. `ModuleImpl<I, O>` (`index.ts:25-32`) - region-supplied `rules`, optional `llm` and `http` specs.
2. `Module` (`index.ts:34-102`) - constructor checks, `run()` dispatch and fallback, 30 s rate-limited `warn()`.
3. `viaLlm` / `withTimeout` (`index.ts:71-81`, `:141-146`) - one provider built via `@cohost/llm`, double timeout enforcement.
4. `viaHttp` (`index.ts:83-92`) - JSON `POST` with `AbortSignal.timeout`.
5. `extractJson`, `clamp`, `isNum` (`index.ts:104-149`) - helpers used by the regions' `validate` functions.
6. `examples/modules/server.py` - stand-in server documenting the `/salience`, `/affect`, `/critic` contracts.

Consumers: `services/salience/src/scoring.ts:61`, `services/affect/src/appraise.ts:55`, `services/cortex/src/critic.ts:46`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Code `@spec` | Test `@spec` |
|----------|----------|-------------|----------|------|--------------|--------------|
| Kinds and construction | HOOK-KIND-001 to HOOK-KIND-005 | 5 | 0 | 0 | 5 | 5 |
| LLM kind | HOOK-LLM-001 to HOOK-LLM-005 | 5 | 0 | 0 | 5 | 5 |
| HTTP kind | HOOK-HTTP-001 to HOOK-HTTP-003 | 3 | 0 | 0 | 3 | 2 |
| Fallback | HOOK-FALLBACK-001 to HOOK-FALLBACK-006 | 6 | 0 | 0 | 6 | 5 |
| Warnings | HOOK-WARN-001 to HOOK-WARN-004 | 4 | 0 | 0 | 4 | 3 |
| Helpers | HOOK-HELP-001 to HOOK-HELP-004 | 4 | 0 | 0 | 4 | 4 |
| Reference HTTP server | HOOK-EX-001 to HOOK-EX-006 | 6 | 0 | 0 | 6 | 6 |

**Summary:** 33 of 33 specs implemented; 0 deferred; 0 gaps. 33 specs cited from code (including `packages/llm/src/mock.ts` and `examples/modules/server.py`), 30 from tests. No reverse orphans. Without a test annotation: HOOK-HTTP-001 (the test never inspects the request), HOOK-FALLBACK-004 (no test throws from `validate`), HOOK-WARN-002 (the warn test ignores the message).

## Key Findings

1. **Markers.** The audit found no wrong marker. HOOK-HELP-001 names the bracket-free-prose case the regex handles, and HOOK-FALLBACK-006 describes the only reachable case — a hook cannot select `mock` (the hook provider enum excludes it, `packages/config/src/schema.ts:22`), it can only inherit it from `llm.provider`. HOOK-FALLBACK-005 is now a precondition (`[x]`, S19).
2. **`extractJson` returns the first balanced value** (`index.ts:104-139`, HOOK-HELP-003, B15): it scans opener by opener, skips brackets inside JSON strings and bracketed prose that is not JSON, and returns the first span `JSON.parse` accepts.
3. **Timeout is enforced twice for `llm`** (`index.ts:73-79`): the abort signal (added in commit `969f6d7` so "timeouts abort the in-flight request") plus `withTimeout`, which does not cancel the request. Default `timeout_ms` is 1500 for every hook (`schema.ts:19`), which `examples/modules/README.md:72-76` says hosted Claude usually exceeds.
4. **Fallbacks are only visible as throttled warnings** (`index.ts:94-101`): one per 30 s per instance, error truncated to 120 chars, no counter or heartbeat surface (HOOK-WARN-003, S21).
5. **`impl.rules` is unguarded** (`index.ts:60`, `:68`), so "the show goes on" depends on region rules never throwing (HOOK-FALLBACK-005, S19: regions guarantee it); the precondition is written on `ModuleImpl.rules` and pinned by `module.test.ts:186`.
6. **`ModuleConfig` is exported by two packages** (`index.ts:23` and `packages/config/src/schema.ts:29`), derived differently; neither is imported anywhere outside its own file.
7. **Reference server defects** — the empty-body `TypeError` is fixed (`server.py:93-95`, HOOK-EX-006); remaining: single-threaded `HTTPServer` (`:114`), raw-path routing (`:89`), case-sensitive `http` filter (`:76`), binds `0.0.0.0` without auth, critic never returns `emotion` although its docstring shows one (`:35`).
8. **Thin tests for several `[x]` lines** — the http test never inspects the request (HOOK-HTTP-001), the warn test ignores the message (HOOK-WARN-002), nothing throws from `validate` (HOOK-FALLBACK-004), the 200-token default and a signal-ignoring provider are not exercised (HOOK-LLM-003, HOOK-LLM-004). The mock-backed hook (HOOK-FALLBACK-006, HOOK-WARN-004), warn recurrence after 30 s (HOOK-WARN-001, HOOK-WARN-003) and a throwing `rules` (HOOK-FALLBACK-005) are now tested.
9. **Contracts are hand-duplicated** across `validate` functions in three services, `examples/modules/README.md` and `server.py`; `example-server.test.ts` links them: fixture responses go through the real validators, and the live server is checked against the fixtures when `python3` is installed. The test imports the services' `createScorer`/`createAppraiser`/`createCritic` from their sources, a package-to-service dependency that exists only in test code.
10. **Annotation placement** — `@spec` comments in `src/` are trailing comments on the entry-point line, so other segments' citations of `packages/modules/src/index.ts:NN` stay valid. The platform-models fix added about 40 lines to `index.ts`, so citations from other segments' docs (salience, affect, cortex, config) are stale by a few lines to 38 lines.

## Work Required

### Must Fix
None.

### Should Fix
1. Refresh the `packages/modules/src/index.ts:NN` citations in the salience, affect, cortex and config docs (other segments' files).

### Nice to Have
1. Reconcile or remove the duplicate `ModuleConfig` type.
2. Switch the example server to `ThreadingHTTPServer` (LLD Open Question 5).
3. Add tests for the remaining thin lines: the http request body and header (HOOK-HTTP-001), the warning message text (HOOK-WARN-002), a throwing `validate` (HOOK-FALLBACK-004), the 200-token default (HOOK-LLM-003), a provider that ignores `signal` (HOOK-LLM-004).
