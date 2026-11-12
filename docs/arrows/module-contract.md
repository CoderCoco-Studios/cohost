# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

**PARTIAL**, 2026-11-11: C3 built the settings editor (MOD-CFG-001 to 016, MOD-UI-001 to 006) and the manifest declarations (MOD-MAN-001 to 005); MOD-MAN-006 to 009, MOD-LIFE, MOD-PAUSE and MOD-TEST are still `[ ]`. Original mapping: LLD drafted ([module-contract-design.md](../intent/module-contract/module-contract-design.md)); EARS specs written, all `[ ]`. Parts exist today in other segments: the manifest, controller and per-service lifecycle (control-plane), service-level injection for chat, eyes and ears and the personality editor (dashboard). Missing: the manifest's `config`, `uses`, `pause` and `test` fields, the settings editor routes and page, the derived dependents-degraded state, pause/resume buttons, bus-level per-unit test inputs, and the derived service lists (the page's `UNITS` constant and `KNOWN_SERVICES` are still hand-kept).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service descriptor and derived lists | MOD-MAN-001 to MOD-MAN-009 | 6 | 0 | 3 | 5 |
| Settings editor | MOD-CFG-001 to MOD-CFG-016 | 16 | 0 | 0 | 16 |
| Lifecycle and health | MOD-LIFE-001 to MOD-LIFE-003 | 0 | 0 | 3 | 0 |
| Pause and resume | MOD-PAUSE-001 to MOD-PAUSE-003 | 0 | 0 | 3 | 0 |
| Test drawer and inputs | MOD-TEST-001 to MOD-TEST-007 | 0 | 0 | 7 | 0 |
| Page | MOD-UI-001 to MOD-UI-006 | 6 | 0 | 0 | 6 |

**Summary:** 28 of 44 specs implemented; 0 deferred; 16 open. 27 carry a test `@spec` annotation; implemented without one: MOD-MAN-006 (verified by glue, configuration or a test that cites a neighbouring ID). `node scripts/lid-check.mjs` finds no reverse orphans.

## Work required

1. MOD-MAN-007 to 009 (the manifest route's wording, the manifest-versus-Compose test, `runService` as the only entry-file call): gap-closure chunk C2.
2. MOD-LIFE-001 to 003 (dependents shown `needs` in the Services tab, units keep running when a dependency stops): chunk C2.
3. MOD-PAUSE-001 to 003 (Pause and Resume buttons) and MOD-TEST-001 to 007 (test drawer, `POST /inject/event`, the refusal for a unit that is not running, the isolated-start end-to-end check): chunk C4.

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (44 specs: 28 `[x]`, 16 `[ ]`, 0 `[D]`)

### Code
- packages/control/src/{manifest,health,cli}.ts
- packages/config/src/{index,schema}.ts
- services/dashboard/src/{routes,inject}.ts, services/dashboard/public/index.html
