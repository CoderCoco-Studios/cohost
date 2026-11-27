# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

**#372 settings-store:** 65 specs: 50 `[x]`, 15 `[ ]`, 0 `[D]`. The manifest's `documents` and `stateKey` are built (MOD-MAN-016, -017): every unit's settings declarations (`config`, `secrets`, `documents`, `stateKey`, the Compose name) live in `UNIT_SETTINGS` (`packages/config/src/units.ts`), which `SERVICE_MANIFEST` takes them from and the settings store reads too. Open: the settings routes over the store (MOD-CFG-003..017), the seed (MOD-MAN-011) and the per-unit boot test against a projection (MOD-MAN-018), which needs the services to load their configuration from the projection ([settings-store.md](settings-store.md)). The status paragraphs below describe the code before that design.

Under the one-place configuration design ([decision](../decisions/config-in-one-place.md)) the settings editor reports secrets as set or not set, lists the units that run an isolation override, serves the presentation table with the schema and answers the success and error shapes of MOD-CFG-001 to -021, `?dryRun=1` (MOD-CFG-013) included, both realized by the dashboard's Settings screen. MOD-UI-001 to -006 are retired lines whose behaviour is the dashboard's DASH-SET-*, marked `[x]` like the dashboard's other retired lines. The MOD-CFG and MOD-UI specs total 28: 25 `[x]`, 3 `[ ]`, 0 `[D]`.

**MAPPED.** 65 specs: 63 implemented, 0 deferred, 2 gaps (MOD-TEST-007, -008: the live-stack tools run, which needs Docker). The settings routes read and write the settings store (MOD-CFG-003 to -017); the manifest declares each unit's settings, documents, secrets and state key (MOD-MAN-015 to -017); every unit has a contract test against the seed (MOD-MAN-011) and a boot test that runs it through `runService` against a projection of only its declared sections and documents, with fake backends, through one declared test input (MOD-MAN-018, `packages/testing/src/boot-projection.ts`, `services/*/test/boot-projection.test.ts`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-018 | 18 | 0 | 0 |
| Settings editor | MOD-CFG-001 to MOD-CFG-022 | 22 | 0 | 0 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 3 | 0 | 0 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 3 | 0 | 0 |
| Test side sheet and inputs | MOD-TEST-001 to MOD-TEST-008 | 6 | 0 | 2 |
| Page (retired to DASH-SET-*) | MOD-UI-001 to MOD-UI-006 | 6 | 0 | 0 |
| Example service | MOD-EX-001 to MOD-EX-005 | 5 | 0 | 0 |

**Summary:** 63 of 65 specs implemented; 0 deferred; 2 open (MOD-TEST-007, -008). The six MOD-UI lines are retired placeholders and carry no test. `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

- YouTube chat (design 2026-11-16): the twelve secret keys of CFG-SEC-003 (MOD-CFG-002).
- MOD-TEST-007 and MOD-TEST-008 need a live Docker run with the tools unit (the isolated tools unit answers a tool call with `inject.result` and `tool.result`); the owner runs them by hand, as the test is gated on `COHOST_LIVE_STACK=1`.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (65 specs: 63 `[x]`, 2 `[ ]`, 0 `[D]`; MOD-MAN-002 is rewritten for the `logging` section and built, #349; MOD-MAN-015, the manifest `secrets` lists, and MOD-MAN-002, eyes declaring `llm`, are built, #318)

### Code
- packages/control/src/manifest.ts, health.ts
- packages/config/src/units.ts
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
