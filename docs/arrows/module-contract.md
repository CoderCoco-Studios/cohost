# Arrow: module-contract

The four obligations every application service meets (dashboard-configurable through one schema-driven settings editor, independently operable with per-service health and dependents shown degraded, test-injectable with no platform account, built on the shared runtime), and the manifest as the one list of services.

## Status

**MAPPED**, 2026-11-11: LLD drafted ([module-contract-design.md](../intent/module-contract/module-contract-design.md)); EARS specs written, all `[ ]`. Parts exist today in other segments: the manifest, controller and per-service lifecycle (control-plane), service-level injection for chat, eyes and ears and the personality editor (dashboard). Missing: the manifest's `config`, `uses`, `pause` and `test` fields, the settings editor routes and page, the derived dependents-degraded state, pause/resume buttons, bus-level per-unit test inputs, and the derived service lists (the page's `UNITS` constant and `KNOWN_SERVICES` are still hand-kept).

## Work required

1. Owner review of the LLD (phase 2 stop), including its Open questions (model-free eyes/ears injection, mouth dry-run output, direct `brain.say` test input, validation environment).
2. EARS specs: MOD-MAN, MOD-CFG, MOD-LIFE, MOD-PAUSE, MOD-TEST, MOD-UI.
3. Cascades: control-plane (manifest fields, derived service lists, dependents degraded in `HealthTracker`), config (JSON Schema export, secret marking, section read/write keeping comments), dashboard (routes `GET /config/schema`, `GET`/`PUT /config/:section`, `GET /services/manifest`, `POST /inject/event`; Settings tab; test drawer; pause buttons).
4. Gap-closure chunks C2 to C4 ([gap-closure dispositions](../plans/gap-closure-dispositions.md)).

## References

### HLD
- docs/high-level-design.md (System Design: Module contract; Key Design Decisions: Module contract, Applying an edited setting)

### LLD
- docs/intent/module-contract/module-contract-design.md

### EARS
- docs/intent/module-contract/module-contract-specs.md (44 specs: 0 `[x]`, 44 `[ ]`, 0 `[D]`)

### Code
- packages/control/src/{manifest,health,cli}.ts
- packages/config/src/{index,schema}.ts
- services/dashboard/src/{routes,inject}.ts, services/dashboard/public/index.html
