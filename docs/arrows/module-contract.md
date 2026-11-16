# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

Under the one-place configuration design ([decision](../decisions/config-in-one-place.md)) the settings editor reports secrets as set or not set, lists the units that run an isolation override, serves the presentation table with the schema and answers the success and error shapes of MOD-CFG-001 to -021 except the two below. Open: MOD-CFG-007 (the sensitive-key gate and the 64 KiB body cap's gate wording, with the dashboard's DASH-CTRL-009) and MOD-CFG-013 (`?dryRun=1`), which belong to the dashboard's settings screen; MOD-UI-001 to -006 are retired to the dashboard's DASH-SET-* and stay `[ ]` until the old page is removed. Total 57 specs: 49 `[x]`, 8 `[ ]`, 0 `[D]`.

**COMPLETE** for the contract itself: 52 of 52 specs implemented; the last 5 are the example service (below). Built: the manifest declarations and derived lists, every unit entering through `runService` (MOD-MAN-009, enforced by `packages/control/test/derived-lists.test.ts` and each service's `contract.test.ts`; per-unit settings, restart and input checks in MOD-MAN-010), the settings editor and its page (MOD-CFG, MOD-UI), dependents shown `needs` in the Services screen (MOD-LIFE), pause and resume buttons (MOD-PAUSE), the test side sheet and `POST /inject/event` (MOD-TEST-001 to 006). MOD-TEST-007, the isolated stack answering every declared input, runs against the whole stack under Docker (`services/dashboard/test/live-stack.e2e.test.ts`, gated on `COHOST_LIVE_STACK=1`). The docs site's extension guides added MOD-EX-001 to MOD-EX-005 (the `now-playing` example service), implemented and tested, not yet audited; the spec file now holds 52 specs (52 `[x]`, 0 `[ ]`, 0 `[D]`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-012 | 12 | 0 | 0 | 12 |
| Settings editor | MOD-CFG-001 to MOD-CFG-021 | 9 | 0 | 12 | 9 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 3 | 0 | 0 | 3 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 3 | 0 | 0 | 3 |
| Test side sheet and inputs | MOD-TEST-001 to MOD-TEST-007 | 7 | 0 | 0 | 7 |
| Page (retired to DASH-SET-*) | MOD-UI-001 to MOD-UI-006 | 0 | 0 | 6 | 0 |

**Summary:** 49 of 57 specs implemented; 0 deferred; 8 open (MOD-CFG-007, MOD-CFG-013 and the six retired MOD-UI lines). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

None outstanding.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (57 specs: 49 `[x]`, 8 `[ ]`, 0 `[D]`)

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
- Audit the example service (MOD-EX-001..005), cited by the docs site's Extend pages.
