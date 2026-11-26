# Arrow: region-hooks

The `@cohost/modules` runner (`Module<I, O>`) that lets salience, affect, the cortex critic and memory's note hooks run built-in rules, a chat model, or an operator-run HTTP endpoint, always falling back to rules on failure; plus the example HTTP hook server and its docs.

## Status

**AUDITED** (date and commit in `index.yaml`). The spec file holds 51 specs: 51 implemented, 0 deferred, 0 gaps. The LLD has no open questions. The docs site's extension guides added HOOK-EX-011 to HOOK-EX-016 (the TypeScript and Rust reference servers, their port argument, the shared try-it script) and HOOK-EX-017 to HOOK-EX-019 (the `shout` example hook), all implemented and tested; the spec file now holds 60 specs (60 `[x]`, 0 `[ ]`, 0 `[D]`). The new specs have not been audited.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B15** what `extractJson` returns → the first balanced JSON value, including when prose after it has brackets. Specs: HOOK-HELP-003.
2. **S19** throwing `impl.rules` → a documented precondition on regions; the gap is retired. Specs: HOOK-FALLBACK-005 (the precondition is written on `ModuleImpl.rules` and pinned by a test).
3. **S20** `examples/modules/server.py` → stays in this segment: add `# @spec` annotations, a smoke test against the region validators, and fix the empty-body default. Specs: HOOK-EX-006.
4. **S21** visibility of fallbacks → the next warning carries the suppressed count. Specs: HOOK-WARN-003.
5. **B20** the docs site's Brain hooks page (`docs/advanced/extend/hooks.md`) → say 8000 is the default for every hook and mention the example config's 2500 for the critic. Specs: none (docs fix).
6. **R5** mock-backed hooks → never succeed (unchanged); a hook built on mock warns once; explicit `mock` on a hook stays rejected by config. Specs: HOOK-WARN-004, HOOK-FALLBACK-006; CFG-SCH-009 (config).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/region-hooks/region-hooks-design.md

### EARS
- docs/intent/region-hooks/region-hooks-specs.md (60 specs, prefix HOOK: 58 `[x]`, 2 `[ ]`, 0 `[D]`; HOOK-SCHEMA-003 and HOOK-EX-013 follow the mise tasks of deployment #344)

### Tests
- packages/modules/test/module.test.ts (kinds, fallback, warnings, cool-off, health; fake HTTP servers for the `http` and OpenAI-compatible `llm` paths)
- packages/modules/test/hooks.test.ts
- packages/modules/test/schemas.test.ts (reply schemas against the region validators)
- packages/modules/test/example-server.test.ts (fixture responses through the real region validators; the live `server.py`, on the Python `mise.toml` pins)
- examples/modules/fixtures/contracts.json (recorded request/response pairs for the three endpoints)
- services/affect/test/{affect.region,affect.dispositions,appraiser,main}.test.ts, services/salience/test/main.test.ts (files carrying `@spec HOOK-`)
- Consumer-side coverage lives in `services/salience/test`, `services/affect/test`, `services/cortex/test`, `services/memory/test` (not in this segment)

### Code
- packages/modules/src/index.ts
- packages/modules/src/schemas.ts (`HOOK_REPLY_SCHEMAS`)
- scripts/gen-hook-schemas.mjs (writes `examples/modules/schemas/*.json`)
- packages/llm/src/mock.ts (cites HOOK-FALLBACK-006 alongside LLM-MOCK-002)
- packages/modules/package.json, packages/modules/tsconfig.json
- examples/modules/server.py (reference HTTP hook server, Python 3 stdlib)
- docs/advanced/extend/hooks.md (operator docs and contracts; examples/modules/README.md is the directory guide)
- services/affect/src/{affect,appraise,main}.ts, services/salience/src/main.ts (consumer wiring that carries `@spec HOOK-`)

## Architecture

**Purpose:** One small runner for the five judgement hooks (`salience.scorer`, `affect.appraiser`, `cortex.critic`, `memory.capture`, `memory.consolidator`; config at `brain.salience.module`, `brain.affect.module`, `brain.cortex.critic`, `brain.memory.notes.capture`, `brain.memory.notes.consolidator`). Regions supply rules, prompt and `validate`; the runner supplies kind dispatch, timeouts, JSON extraction, and the fall-back-to-rules guarantee.

**Key Components:**
1. `ModuleImpl<I, O>` (`index.ts`) - region-supplied `rules`, optional `llm` and `http` specs.
2. `Module` (`index.ts`) - constructor checks, `run()` dispatch and fallback, cool-off, 30 s rate-limited `warn()`, `health()` and `ping()`.
3. `viaLlm` / `viaHttp` / `withTimeout` (`index.ts`) - one provider built via `@cohost/llm`; both kinds run under one `AbortController` deadline.
4. `extractJson`, `clamp`, `isNum` (`index.ts`) - helpers used by the regions' `validate` functions.
5. `schemas.ts` and `scripts/gen-hook-schemas.mjs` - the reply JSON Schemas and their generator.
6. `examples/modules/server.py` - stand-in server documenting the `/salience`, `/affect`, `/critic` contracts.

Consumers: `services/salience/src/scoring.ts`, `services/affect/src/appraise.ts`, `services/cortex/src/critic.ts`, `services/memory/src/capture.ts`, `services/memory/src/consolidator.ts`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Kinds and construction | HOOK-KIND-001 to HOOK-KIND-005 | 5 | 0 | 0 |
| LLM kind | HOOK-LLM-001 to HOOK-LLM-006 | 6 | 0 | 0 |
| HTTP kind | HOOK-HTTP-001 to HOOK-HTTP-003 | 3 | 0 | 0 |
| Fallback | HOOK-FALLBACK-001 to HOOK-FALLBACK-006 | 6 | 0 | 0 |
| Warnings | HOOK-WARN-001 to HOOK-WARN-004 | 4 | 0 | 0 |
| Cool-off | HOOK-COOL-001 to HOOK-COOL-003 | 3 | 0 | 0 |
| Health | HOOK-HEALTH-001 to HOOK-HEALTH-005 | 5 | 0 | 0 |
| Configuration | HOOK-CFG-001 to HOOK-CFG-002 | 2 | 0 | 0 |
| Helpers | HOOK-HELP-001 to HOOK-HELP-004 | 4 | 0 | 0 |
| Reference HTTP servers and example hook | HOOK-EX-001 to HOOK-EX-019 | 19 | 0 | 0 |
| Reply schemas | HOOK-SCHEMA-001 to HOOK-SCHEMA-003 | 3 | 0 | 0 |

**Summary:** 60 specs: 58 implemented, 0 deferred, 2 gaps (HOOK-SCHEMA-003, HOOK-EX-013: the mise tasks of deployment #344) (HOOK-EX-011 to HOOK-EX-019 added after the audit and not covered by it).

## Key Findings

1. **Markers.** HOOK-HELP-001 names the bracket-free-prose case the regex handles, and HOOK-FALLBACK-006 describes the only reachable case: a hook cannot select `mock` (the hook provider enum excludes it, `packages/config/src/schema.ts`), it can only inherit it from `llm.provider`. HOOK-FALLBACK-005 is a precondition on regions (S19).
2. **`extractJson` returns the first balanced value** (HOOK-HELP-003, B15): it scans opener by opener, skips brackets inside JSON strings and bracketed prose that is not JSON, and returns the first span `JSON.parse` accepts.
3. **One deadline per call.** `withTimeout` uses a single `AbortController` whose timer both rejects the call and aborts the provider's signal (HOOK-LLM-004). Default `timeout_ms` is 8000 for every hook (HOOK-CFG-002).
4. **Fallbacks are visible as throttled warnings**: one per 30 s per instance, error truncated to 120 chars, carrying the suppressed count (HOOK-WARN-003, S21).
5. **`impl.rules` is unguarded**, so "the show goes on" depends on region rules never throwing (HOOK-FALLBACK-005, S19: regions guarantee it); the precondition is written on `ModuleImpl.rules` and pinned by `module.test.ts`.
6. **`ModuleConfig` has one definition** in `@cohost/config`, re-exported by `@cohost/modules` (HOOK-CFG-001).
7. **Contracts are hand-duplicated** across `validate` functions in three services, the docs site's Brain hooks page (`docs/advanced/extend/hooks.md`), `server.py` and the JSON Schemas; `example-server.test.ts` and `schemas.test.ts` link them: fixture responses go through the real validators, schemas are checked against the validators, and the live server is checked against the fixtures, on the Python `mise.toml` pins. The example-server test imports the services' `createScorer`/`createAppraiser`/`createCritic` from their sources, a package-to-service dependency that exists only in test code.
8. **Annotation placement** - `@spec` comments in `src/` are trailing comments on the entry-point line.

## Work Required

### Must Fix
None.

### Should Fix
- Audit HOOK-EX-011..019 (the TypeScript and Rust reference servers, `try.sh`, the example hook), cited by the docs site's Extend pages.

### Nice to Have
None.
