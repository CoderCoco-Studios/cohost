# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

**COMPLETE** for the contract itself: 47 of 52 specs implemented; the 5 gaps are the example service (below). Built: the manifest declarations and derived lists, every unit entering through `runService` (MOD-MAN-009, enforced by `packages/control/test/derived-lists.test.ts` and each service's `contract.test.ts`; per-unit settings, restart and input checks in MOD-MAN-010), the settings editor and its page (MOD-CFG, MOD-UI), dependents shown `needs` in the Services tab (MOD-LIFE), pause and resume buttons (MOD-PAUSE), the test drawer and `POST /inject/event` (MOD-TEST-001 to 006). MOD-TEST-007, the isolated stack answering every declared input, runs against the whole stack under Docker (`services/dashboard/test/live-stack.e2e.test.ts`, gated on `COHOST_LIVE_STACK=1`). New gaps from the docs site's extension guides: MOD-EX-001 to MOD-EX-005 (the `now-playing` example service); the spec file now holds 52 specs (47 `[x]`, 5 `[ ]`, 0 `[D]`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-012 | 12 | 0 | 0 | 12 |
| Settings editor | MOD-CFG-001 to MOD-CFG-016 | 16 | 0 | 0 | 16 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 3 | 0 | 0 | 3 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 3 | 0 | 0 | 3 |
| Test drawer and inputs | MOD-TEST-001 to MOD-TEST-007 | 7 | 0 | 0 | 7 |
| Page | MOD-UI-001 to MOD-UI-006 | 6 | 0 | 0 | 6 |

**Summary:** 47 of 47 specs implemented; 0 deferred; 0 open. All 47 carry an `@spec` annotation in code or tests. `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

None outstanding.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (52 specs: 47 `[x]`, 5 `[ ]`, 0 `[D]`)

### Code
- packages/control/src/manifest.ts, health.ts
- packages/testing/src/unit-contract.ts
- packages/config/src/index.ts, schema.ts, editor.ts, pipeline.ts
- services/dashboard/src/routes.ts, inject.ts, settings.ts, services/dashboard/public/index.html

### Tests
- packages/control/test/manifest.test.ts, manifest-contract.test.ts, derived-lists.test.ts, needs.test.ts, independence.test.ts
- packages/config/test/editor.test.ts
- services/dashboard/test/settings.test.ts, page.test.ts, inject-event.test.ts, stack-rebuild.test.ts, unit-contract.test.ts, live-stack.e2e.test.ts
- services/{affect,avatar,chat,connector-discord,cortex,ears,eyes,memory,mouth,salience,voice}/test/contract.test.ts; services/cortex/test/independence.test.ts; services/salience/test/independence.test.ts; services/memory/test/main.test.ts

## Work Required

### Should Fix
- Build and test the example service (MOD-EX-001..005), cited by the docs site's Extend pages (docs-site Extension guides).
