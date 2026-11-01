# Arrow: region-hooks

The `@cohost/modules` runner (`Module<I, O>`) that lets salience, affect and the cortex critic run built-in rules, a chat model, or an operator-run HTTP endpoint, always falling back to rules on failure; plus the example HTTP hook server and its docs.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/region-hooks/region-hooks-design.md

### EARS
- docs/intent/region-hooks/region-hooks-specs.md (31 specs, prefix HOOK)

### Tests
- packages/modules/test/module.test.ts (11 tests; fake HTTP servers for the `http` and OpenAI-compatible `llm` paths)
- Consumer-side coverage lives in `services/salience/test`, `services/affect/test`, `services/cortex/test` (not in this segment)
- No automated test for `examples/modules/server.py`

### Code
- packages/modules/src/index.ts
- packages/modules/package.json, packages/modules/tsconfig.json
- examples/modules/server.py (reference HTTP hook server, Python 3 stdlib)
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

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Kinds and construction | HOOK-KIND-001 to HOOK-KIND-005 | 5 | 0 | 0 |
| LLM kind | HOOK-LLM-001 to HOOK-LLM-005 | 5 | 0 | 0 |
| HTTP kind | HOOK-HTTP-001 to HOOK-HTTP-003 | 3 | 0 | 0 |
| Fallback | HOOK-FALLBACK-001 to HOOK-FALLBACK-006 | 5 | 0 | 1 |
| Warnings | HOOK-WARN-001 to HOOK-WARN-002 | 2 | 0 | 0 |
| Helpers | HOOK-HELP-001 to HOOK-HELP-004 | 3 | 0 | 1 |
| Reference HTTP server | HOOK-EX-001 to HOOK-EX-006 | 5 | 0 | 1 |

**Summary:** 28 of 31 specs observed working; 0 deferred; 3 gaps.

## Key Findings

1. **`extractJson` is greedy** — it spans the first `[`/`{` to the last `]`/`}` (`packages/modules/src/index.ts:98`), contradicting its own comment and OpenSpec ("first JSON object or array"); multi-value or bracket-prefixed replies silently become rules fallbacks (HOOK-HELP-003).
2. **Timeout is enforced twice for `llm`** (`index.ts:67-73`: `AbortSignal.timeout` plus `withTimeout`); the second timer does not cancel the request. Default `timeout_ms` is 1500 (`packages/config/src/schema.ts:17`), which examples/modules/README.md:72-76 says hosted Claude usually exceeds.
3. **Fallbacks are only visible as throttled warnings** (`index.ts:88-93`): one per 30 s per instance, error truncated to 120 chars, no counter or heartbeat surface; a permanently broken hook looks like a working one that is merely noisy once every 30 s.
4. **`impl.rules` is unguarded** (`index.ts:54`, `:62`) so the "never breaks the show" guarantee depends on region rules never throwing (HOOK-FALLBACK-005).
5. **`ModuleConfig` is exported by two packages** (`index.ts:19` and `packages/config/src/schema.ts:27`), derived differently; neither is imported by any consumer.
6. **Reference server defects** — `examples/modules/server.py:93` empty-body `TypeError` (HOOK-EX-006), single-threaded `HTTPServer` (`:112`) serializing all hooks, raw-path routing (`:89`), case-sensitive `http` filter (`:76`), binds `0.0.0.0` without auth. Its toy salience scoring also differs from the built-in rules (`server.py:48-62` vs `services/salience/src/scoring.ts:24-37`).
7. **Mock-backed `llm` hooks always fall back** (`packages/llm/src/mock.ts:16-17` returns `{}`), so isolated runs never exercise the llm-hook success path; hook providers are never pinged.
8. **Contracts are hand-duplicated** across `validate` functions in three services, `examples/modules/README.md` and `server.py`; no test links the Python server to the TypeScript validators. `[inferred]` drift risk.

## Work Required

### Must Fix
1. Nothing blocks operation; the three `[ ]` specs are the gaps (HOOK-HELP-003, HOOK-FALLBACK-005, HOOK-EX-006).

### Should Fix
1. Make `extractJson` return the first balanced JSON value (HOOK-HELP-003, HOOK-LLM-005).
2. Guard `impl.rules` or document that it must not throw (HOOK-FALLBACK-005).
3. Fix the empty-body default in `server.py:93` (HOOK-EX-006).
4. Give operators a way to see fallback rates (counter in the warning or in the region heartbeat `detail`) (HOOK-WARN-001).

### Nice to Have
1. Reconcile or remove the duplicate `ModuleConfig` type.
2. Switch the example server to `ThreadingHTTPServer` and bind loopback by default.
3. Add tests: `validate` throwing (HOOK-FALLBACK-004), non-JSON http body, warn recurrence after 30 s, and a smoke test of `server.py` against the region validators (HOOK-EX-001 to HOOK-EX-005).
