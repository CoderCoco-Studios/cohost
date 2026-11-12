# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

**COMPLETE**, 2026-11-11: 46 of 46 specs implemented. Built: the manifest declarations and derived lists, every unit entering through `runService` (MOD-MAN-009, enforced by `packages/control/test/derived-lists.test.ts` and each service's `contract.test.ts`; per-unit settings, restart and input checks in MOD-MAN-010), the settings editor and its page (MOD-CFG, MOD-UI), dependents shown `needs` in the Services tab (MOD-LIFE), pause and resume buttons (MOD-PAUSE), the test drawer and `POST /inject/event` (MOD-TEST-001 to 006). MOD-TEST-007, the isolated stack answering every declared input, passed against the whole stack under Docker (`services/dashboard/test/live-stack.e2e.test.ts`, gated on `COHOST_LIVE_STACK=1`; evidence in docs/plans/live-verification.md).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-011 | 11 | 0 | 0 | 10 |
| Settings editor | MOD-CFG-001 to MOD-CFG-016 | 16 | 0 | 0 | 16 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 3 | 0 | 0 | 3 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 3 | 0 | 0 | 3 |
| Test drawer and inputs | MOD-TEST-001 to MOD-TEST-007 | 7 | 0 | 0 | 7 |
| Page | MOD-UI-001 to MOD-UI-006 | 6 | 0 | 0 | 6 |

**Summary:** 46 of 46 specs implemented; 0 deferred; 0 open. 45 carry a test `@spec` annotation; implemented without one: MOD-MAN-006 (verified by glue, configuration or a test that cites a neighbouring ID). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

None outstanding.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (46 specs: 46 `[x]`, 0 `[ ]`, 0 `[D]`)

### Code
- packages/control/src/{manifest,health,cli}.ts
- packages/config/src/{index,schema}.ts
- services/dashboard/src/{routes,inject}.ts, services/dashboard/public/index.html
