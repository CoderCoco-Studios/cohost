# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

Under the one-place configuration design ([decision](../decisions/config-in-one-place.md)) the settings editor reports secrets as set or not set, lists the units that run an isolation override, serves the presentation table with the schema and answers the success and error shapes of MOD-CFG-001 to -021, the sensitive-key gate (MOD-CFG-007) and `?dryRun=1` (MOD-CFG-013) included, both realized by the dashboard's Settings screen. MOD-UI-001 to -006 are retired lines whose behaviour is the dashboard's DASH-SET-*, marked `[x]` like the dashboard's other retired lines. The MOD-CFG and MOD-UI specs total 28: 25 `[x]`, 3 `[ ]`, 0 `[D]`.

**MAPPED.** 50 of 61 specs implemented, 11 gaps (MOD-MAN-002, -003, -005, -008, -010, MOD-CFG-001, -021, -022, MOD-TEST-005, -007, -008); MOD-MAN-013 and -014 (the engine units) are built in #190. Built: the manifest declarations and derived lists, every unit entering through `runService` (MOD-MAN-009, enforced by `packages/control/test/derived-lists.test.ts` and each service's `contract.test.ts`; per-unit settings, restart and input checks in MOD-MAN-010), the settings editor and its Settings screen (MOD-CFG; MOD-UI is retired to the dashboard's DASH-SET-*), dependents shown `needs` in the Services screen (MOD-LIFE), pause and resume buttons (MOD-PAUSE), the test side sheet and `POST /inject/event` (MOD-TEST-001 to 006). MOD-TEST-007, the isolated stack answering every declared input, runs against the whole stack under Docker (`services/dashboard/test/live-stack.e2e.test.ts`, gated on `COHOST_LIVE_STACK=1`). The docs site's extension guides added MOD-EX-001 to MOD-EX-005 (the `now-playing` example service), implemented and tested, not yet audited. An audit pass is the next step: the specs are written and implemented, not yet audited against the code; the status moves to AUDITED when it has run.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-014 | 7 | 0 | 7 |
| Settings editor | MOD-CFG-001 to MOD-CFG-022 | 18 | 0 | 4 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 3 | 0 | 0 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 3 | 0 | 0 |
| Test side sheet and inputs | MOD-TEST-001 to MOD-TEST-008 | 5 | 0 | 3 |
| Page (retired to DASH-SET-*) | MOD-UI-001 to MOD-UI-006 | 6 | 0 | 0 |
| Example service | MOD-EX-001 to MOD-EX-005 | 5 | 0 | 0 |

**Summary:** 50 of 61 specs implemented; 0 deferred; 11 open (MOD-MAN-002, -003, -005, -008, -010, MOD-CFG-001, -021, -022 for the `renderer` section, MOD-TEST-005, -007, -008). The six MOD-UI lines are retired placeholders and carry no test. `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

- YouTube chat (design 2026-11-16): the twelve secret keys of CFG-SEC-003 (MOD-CFG-002).
None outstanding.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (61 specs: 50 `[x]`, 11 `[ ]`, 0 `[D]`)

### Code
- packages/control/src/manifest.ts, health.ts
- packages/testing/src/unit-contract.ts
- packages/config/src/index.ts, schema.ts, editor.ts, pipeline.ts
- services/dashboard/src/routes.ts, inject.ts, settings.ts, services/dashboard/ui/src/screens/services/, services/dashboard/ui/src/screens/settings/

### Tests
- packages/control/test/manifest.test.ts, manifest-contract.test.ts, derived-lists.test.ts, needs.test.ts, independence.test.ts
- packages/config/test/editor.test.ts
- services/dashboard/test/settings.test.ts, inject-event.test.ts, stack-rebuild.test.ts, unit-contract.test.ts, live-stack.e2e.test.ts
- services/dashboard/test/ui/services.test.tsx, services-test-sheet.test.tsx
- services/{affect,avatar,chat,connector-discord,cortex,ears,eyes,memory,mouth,salience,voice}/test/contract.test.ts; services/cortex/test/independence.test.ts; services/salience/test/independence.test.ts; services/memory/test/main.test.ts

## Work Required

### Should Fix
- Audit the example service (MOD-EX-001..005), cited by the docs site's Extend pages.
