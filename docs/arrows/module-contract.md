# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

**PARTIAL**, 2026-11-11: 43 of 44 specs implemented. Built: the manifest declarations and derived lists, every unit entering through `runService` (MOD-MAN-009, enforced by `packages/control/test/derived-lists.test.ts`), the settings editor and its page (MOD-CFG, MOD-UI), dependents shown `needs` in the Services tab (MOD-LIFE), pause and resume buttons (MOD-PAUSE), the test drawer and `POST /inject/event` (MOD-TEST-001 to 006). Open: MOD-TEST-007, the isolated stack answering every declared input, which needs the whole stack running under Docker (the first real run of the deployment checklist).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-009 | 9 | 0 | 0 | 8 |
| Settings editor | MOD-CFG-001 to MOD-CFG-016 | 16 | 0 | 0 | 16 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 3 | 0 | 0 | 3 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 3 | 0 | 0 | 3 |
| Test drawer and inputs | MOD-TEST-001 to MOD-TEST-007 | 6 | 0 | 1 | 6 |
| Page | MOD-UI-001 to MOD-UI-006 | 6 | 0 | 0 | 6 |

**Summary:** 43 of 44 specs implemented; 0 deferred; 1 open. 42 carry a test `@spec` annotation; implemented without one: MOD-MAN-006 (verified by glue, configuration or a test that cites a neighbouring ID). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

1. MOD-TEST-007: with every unit started with its isolation preset, each declared input is answered with no Twitch, Discord, OBS, avatar app, model server or speech server running. It is checked in the first real run on Docker (docs/TESTING.md).

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (44 specs: 43 `[x]`, 1 `[ ]`, 0 `[D]`)

### Code
- packages/control/src/{manifest,health,cli}.ts
- packages/config/src/{index,schema}.ts
- services/dashboard/src/{routes,inject}.ts, services/dashboard/public/index.html
