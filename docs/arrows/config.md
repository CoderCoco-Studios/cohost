# Arrow: config

`@cohost/config`: YAML + env configuration schema and loader, service URL helpers, logger, and the user-owned personality and expressions files, plus the shipped example files.

## Status

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): the secrets file (CFG-SEC-*), the presentation table (CFG-PRES-*), the models list (CFG-MODEL-*), the override map (CFG-ISO-006) and the literal-only loader; CFG-ENV-012 is enforced by a test that scans cohost source for environment reads. Total 124 specs: 124 `[x]`, 0 `[ ]`, 0 `[D]`. The specs added since the last audit are not covered by it.

**AUDITED.** 124 specs: 124 implemented, 0 deferred, 0 gaps (the audit covered 82 of them). The package is the dependency root of the workspace; the settings editor in `packages/config/src/editor.ts` realizes module-contract MOD-CFG-*.

Orientation:

- Design: LLD § Files, directory resolution and seeding; Loading pipeline; Schema key groups; Environment variables; Decisions & Alternatives.
- Keys owned by other segments live in the config schema and are specified here (CFG-SCH-*), but the behaviour that reads them is the reader's: salience (SAL-*), affect (AFF-*), eyes (EYES-*), ears (EARS-*), mouth (MOUTH-*, see [mouth.md](mouth.md)), voice (VOICE-*), model-backends (LLM-*), connections (CONN-*).
- Environment-only values (`CONTROL_*`, `DASHBOARD_HOST`, `VIEWERS_TOKEN`, `HEARTBEAT_INTERVAL_MS`, `VOICE_PORT`) are read by their owning packages and have no schema key (CFG-ENV-008, CFG-ENV-009); every other operator setting is a `config.yaml` key and every credential a `secrets.yaml` key (CFG-ENV-012).

## References

### HLD
- docs/high-level-design.md (Segments table, platform / config)

### LLD
- docs/intent/config/config-design.md

### EARS
- docs/intent/config/config-specs.md (124 specs, prefix `CFG`: 124 `[x]`, 0 `[ ]`, 0 `[D]`; CFG-URL-003 is a retired placeholder, CFG-USR-005 does not exist, and no number is reused)

### Tests
`@spec CFG-` annotations are in:
- packages/config/test/config.test.ts
- packages/config/test/config-c3.test.ts
- packages/config/test/config-barge-in.test.ts
- packages/config/test/config-connections.test.ts
- packages/config/test/config-ears-sources.test.ts
- packages/config/test/config-ears-vad.test.ts
- packages/config/test/config-mouth-outputs.test.ts
- packages/config/test/config-salience-trigger.test.ts
- packages/config/test/editor.test.ts
- services/dashboard/test/viewers.test.ts (CFG-ENV-009)
- services/voice/test/kokoro-request.test.ts (CFG-SCH-029)

### Code
`@spec CFG-` annotations are in:
- packages/config/src/index.ts (loader, helpers, urls, logger)
- packages/config/src/pipeline.ts (placeholder rejection, null dropping, isolation overrides, `parseConfigText`)
- packages/config/src/schema.ts (zod schemas, `Emotion`)
- services/dashboard/src/service.ts, services/dashboard/src/viewers.ts (CFG-ENV-009)
- packages/config/src/editor.ts, packages/config/package.json, packages/config/tsconfig.json (no `CFG-` annotations)
- config/config.example.yaml, config/expressions.example.yaml, config/personality.example.md, .env.example (realize CFG-ISO-004, CFG-ISO-005, CFG-USR-*; no annotations, since the files are copied into the owner's own files)

## Architecture

**Purpose:** Single place that defines what a valid cohost configuration is and how it is found, seeded, interpolated, validated and cached. Dependency root of the workspace (no workspace deps; everything imports it).

**Key Components:**
1. `configDir()` / `dataDir()` / `findWorkspaceRoot()` — `CONFIG_DIR` and `COHOST_DATA_DIR` overrides, else the nearest `pnpm-workspace.yaml` ancestor's `config/` and `data/`, else the current directory (`index.ts`).
2. `loadConfig()` — `.env` load, seed, placeholder rejection (CFG-ENV-011), null-dropping, secrets merge, isolation overrides by key path from `COHOST_ISOLATION` (CFG-ISO-007), zod validation, unknown-key warning, module cache (`index.ts`, `pipeline.ts`).
3. `ConfigSchema` / `ModuleSchema` / `ExpressionMapSchema` / `Emotion` — shape, defaults, backend-selection enums with blank-to-default preprocessing (`schema.ts`).
4. `ensureFromExample`, `loadPersonality`, `savePersonality`, `loadExpressions` — user-owned files seeded from `*.example.*` (`index.ts`).
5. `env`, `envOr`, `urls.*`, `createLogger`, `setConfigLogger` — runtime helpers used by every service (`index.ts`).
6. `editor.ts` — the settings editor's JSON Schema export, secret marks, section reader and in-place writer.
7. Example files — `config.example.yaml` wires the isolation preset env vars; tests load them as fixtures.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Config directory and seeding | CFG-DIR-001 to CFG-DIR-007 | 7 | 0 | 0 |
| Environment handling | CFG-ENV-001 to CFG-ENV-012 | 12 | 0 | 0 |
| Loading and validation pipeline | CFG-LOAD-001 to CFG-LOAD-007 | 7 | 0 | 0 |
| Secrets file | CFG-SEC-001 to CFG-SEC-015 | 15 | 0 | 0 |
| Presentation table | CFG-PRES-001 to CFG-PRES-011 | 11 | 0 | 0 |
| Models list | CFG-MODEL-001 to CFG-MODEL-002 | 2 | 0 | 0 |
| Schema | CFG-SCH-001 to CFG-SCH-040 | 40 | 0 | 0 |
| Backend selection and isolation presets | CFG-ISO-001 to CFG-ISO-010 | 10 | 0 | 0 |
| Logger | CFG-LOG-001 | 1 | 0 | 0 |
| Service URLs | CFG-URL-001 to CFG-URL-004 | 4 | 0 | 0 |
| User-owned files | CFG-USR-001 to CFG-USR-016 (CFG-USR-005 does not exist) | 15 | 0 | 0 |

**Summary:** 124 of 124 specs implemented; 0 deferred; 0 open. 123 carry a test `<!-- test: -->` pointer; implemented without one: CFG-USR-006 (carried by example-file comments, which are not annotated by design). `node scripts/lid-check.mjs` finds no reverse orphans.

## Coverage notes

Annotated tests that cover only part of their spec line: CFG-SCH-001 (only `cohost.name`), CFG-SCH-004 (regex only), CFG-SCH-005 (only `salience.cooldown_ms`), CFG-SCH-006 (only negative `voice.speed`), CFG-URL-001 (only `urls.redis`), CFG-USR-002 (no empty-file case), CFG-ISO-001 (omitted `chat.fake.interval_ms` not asserted), CFG-ISO-003 (through `ConfigSchema`, not `loadConfig`) and CFG-LOAD-005 (one test exercises `unknownKeys` directly).
