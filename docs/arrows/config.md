# Arrow: config

`@cohost/config`: YAML + env configuration schema and loader, service URL helpers, logger, and the user-owned personality and expressions files, plus the shipped example files.

## Status

**#372 settings-store design (docs only, not built):** 268 specs: 236 `[x]`, 32 `[ ]`, 0 `[D]`; the loader reads the unit's projection and the delivered credentials; the YAML and secrets-file specs are retired (still `[ ]` while the code has them) ([settings-store.md](settings-store.md)). The status paragraphs below describe the code before that design.

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): the secrets file (CFG-SEC-*), the presentation table (CFG-PRES-*), the models list (CFG-MODEL-*), the override map (CFG-ISO-006) and the literal-only loader; CFG-ENV-012 is enforced by a test that scans cohost source for environment reads. The specs added since the last audit are not covered by it.

**MAPPED.** 268 specs: 218 implemented, 0 deferred, 50 gaps. The one lock of #370 (CFG-ENV-008, CFG-ENV-012, CFG-SEC-003, CFG-SCH-030, CFG-SCH-039 and CFG-USR-012 rewritten, CFG-SEC-020 added: `ears.http.token` and `CONTROL_ENABLED` retired, ears receives only a derived verifier `ears.http.verifier`, `sensitive` a warning hint only) is built by #375: CFG-SCH-030 and CFG-SCH-039 are `[x]`; the rest (CFG-ENV-008, CFG-ENV-012, CFG-SEC-003, CFG-USR-012, CFG-SEC-020), rewritten again by the settings-store design, are open for #372, as are the other #372 rewrites and retirements listed above (#360 built the structured `ConfigError`, `checkConfig` and the recovery editor, CFG-RCV-001 to 006, in `packages/config/src/errors.ts`, `index.ts`, `editor.ts` and `secrets.ts`; #349 built the logging design: CFG-LOG-002 to CFG-LOG-025, CFG-SCH-113, CFG-SCH-114, CFG-USR-022, CFG-PRES-021, and the rewritten CFG-URL-004 and CFG-ENV-012, in `packages/config/src/logging.ts`, `log-pretty.ts` and `log-file.ts`; #318 built: CFG-SEC-001, `secretsPath()` and `COHOST_SECRETS_FILE`; CFG-SEC-019, `projectSecrets` in `packages/config/src/project.ts`; CFG-ENV-012, the permitted variables). The package is the dependency root of the workspace; the settings editor in `packages/config/src/editor.ts` realizes module-contract MOD-CFG-*. An audit pass is the next step: the specs are written and implemented, not yet audited against the code; the status moves to AUDITED when it has run.

Orientation:

- Design: LLD § Files, directory resolution and seeding; Loading pipeline; Schema key groups; Environment variables; Decisions & Alternatives.
- Keys owned by other segments live in the config schema and are specified here (CFG-SCH-*), but the behaviour that reads them is the reader's: salience (SAL-*), affect (AFF-*), eyes (EYES-*), ears (EARS-*), mouth (MOUTH-*, see [mouth.md](mouth.md)), voice (VOICE-*), model-backends (LLM-*), connections (CONN-*).
- Environment-only values (`CONTROL_*`, `DASHBOARD_HOST`, `HEARTBEAT_INTERVAL_MS`, `VOICE_PORT`) are read by their owning packages and have no schema key (CFG-ENV-008, CFG-ENV-009); every other operator setting is a `config.yaml` key and every credential a `secrets.yaml` key (CFG-ENV-012).

## References

### HLD
- docs/high-level-design.md (Segments table, platform / config)

### LLD
- docs/intent/config/config-design.md

### EARS
- docs/intent/config/config-specs.md (268 specs, prefix `CFG`: 218 `[x]`, 50 `[ ]`, 0 `[D]`; CFG-URL-003 is a retired placeholder, CFG-USR-005 does not exist, and no number is reused)

### Tests
`@spec CFG-` annotations are in:
- packages/config/test/config-clauses.test.ts
- packages/config/test/config.test.ts
- packages/config/test/config-c3.test.ts
- packages/config/test/config-barge-in.test.ts
- packages/config/test/config-connections.test.ts
- packages/config/test/config-ears-sources.test.ts
- packages/config/test/config-ears-vad.test.ts
- packages/config/test/config-mouth-outputs.test.ts
- packages/config/test/config-salience-trigger.test.ts
- packages/config/test/editor.test.ts
- packages/config/test/config-tools.test.ts (CFG-SCH-075 to CFG-SCH-096, CFG-USR-020)
- packages/config/test/config-renderer.test.ts (CFG-SCH-006, CFG-SCH-097 to CFG-SCH-101, CFG-ISO-005, CFG-ISO-011, CFG-USR-021, CFG-LOAD-008)
- packages/config/test/config-early.test.ts (CFG-SCH-102 to CFG-SCH-112)
- packages/config/test/config-secrets.test.ts (CFG-SEC-016 to CFG-SEC-018, CFG-USR-016)
- services/voice/test/kokoro-request.test.ts (CFG-SCH-029)

### Code
`@spec CFG-` annotations are in:
- packages/config/src/index.ts (loader, `checkConfig`, helpers, urls, logger)
- packages/config/src/errors.ts (`ConfigError`, CFG-RCV-001)
- packages/config/src/pipeline.ts (placeholder rejection, null dropping, isolation overrides, `parseConfigText`)
- packages/config/src/schema.ts (zod schemas, `Emotion`)
- services/dashboard/src/control.ts (CFG-ENV-009)
- packages/config/src/editor.ts, packages/config/package.json, packages/config/tsconfig.json (no `CFG-` annotations)
- config/config.example.yaml, config/expressions.example.yaml, config/personality.example.md, .env.example (realize CFG-ISO-004, CFG-ISO-005, CFG-USR-*; no annotations, since the files are copied into the owner's own files)

## Architecture

**Purpose:** Single place that defines what a valid cohost configuration is and how it is found, seeded, interpolated, validated and cached. Dependency root of the workspace (no workspace deps; everything imports it).

**Key Components:**
1. `configDir()` / `dataDir()` / `findWorkspaceRoot()` — `CONFIG_DIR` and `COHOST_DATA_DIR` overrides, else the nearest `pnpm-workspace.yaml` ancestor's `config/` and `data/`, else the current directory (`paths.ts`).
2. `loadConfig()` — `.env` load, seed, placeholder rejection (CFG-ENV-011), null-dropping, secrets merge, isolation overrides by key path from `COHOST_ISOLATION` (CFG-ISO-007), zod validation, unknown-key warning, module cache (`index.ts`, `pipeline.ts`).
3. `ConfigSchema` / `ModuleSchema` / `ExpressionMapSchema` / `Emotion` — shape, defaults, backend-selection enums with blank-to-default preprocessing (`schema.ts`).
4. `ensureFromExample`, `loadPersonality`, `savePersonality`, `loadExpressions` — user-owned files seeded from `*.example.*` (`index.ts`).
5. `env`, `envOr`, `urls.*`, `createLogger`, `setConfigLogger` — runtime helpers used by every service (`index.ts`, `logging.ts`); `createLogger` builds the process's logging sink: the readable terminal form or JSON on stdout, and the rotated JSON file `data/logs/<program>.log`, from the `logging` section it reads itself (`logging.ts`, `log-pretty.ts`, `log-file.ts`; LLD § Logging). `findWorkspaceRoot`, `configDir`, `dataDir` and `loadDotEnv` live in `paths.ts`.
6. `editor.ts` — the settings editor's JSON Schema export, secret marks, section reader and in-place writer.
7. Example files — `config.example.yaml` wires the isolation preset env vars; tests load them as fixtures.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Config directory and seeding | CFG-DIR-001 to CFG-DIR-007 | 7 | 0 | 0 |
| Environment handling | CFG-ENV-001 to CFG-ENV-012 | 10 | 0 | 2 |
| Loading and validation pipeline | CFG-LOAD-001 to CFG-LOAD-008 | 8 | 0 | 0 |
| Secrets file | CFG-SEC-001 to CFG-SEC-020 | 18 | 0 | 2 |
| Presentation table | CFG-PRES-001 to CFG-PRES-014 | 14 | 0 | 0 |
| Renderer presentation | CFG-PRES-018 to CFG-PRES-020 | 3 | 0 | 0 |
| Tools presentation | CFG-PRES-016 to CFG-PRES-017 | 2 | 0 | 0 |
| Clause settings presentation | CFG-PRES-015 | 1 | 0 | 0 |
| Models list | CFG-MODEL-001 to CFG-MODEL-002 | 2 | 0 | 0 |
| Egress destinations | CFG-EGR-001 to CFG-EGR-013 | 13 | 0 | 0 |
| Tools egress | CFG-EGR-014 to CFG-EGR-016 | 3 | 0 | 0 |
| Schema | CFG-SCH-001 to CFG-SCH-071 | 71 | 0 | 0 |
| Renderer section | CFG-SCH-097 to CFG-SCH-101 | 5 | 0 | 0 |
| Streamed-line clause settings | CFG-SCH-072 to CFG-SCH-074 | 3 | 0 | 0 |
| Tools section and reminder expiry | CFG-SCH-075 to CFG-SCH-096 | 22 | 0 | 0 |
| Backend selection and isolation presets | CFG-ISO-001 to CFG-ISO-011 | 11 | 0 | 0 |
| Logger | CFG-LOG-001 to CFG-LOG-025 | 25 | 0 | 0 |
| Logging settings | CFG-SCH-113, CFG-SCH-114, CFG-USR-022, CFG-PRES-021 | 4 | 0 | 0 |
| Service URLs | CFG-URL-001 to CFG-URL-004 | 4 | 0 | 0 |
| User-owned files | CFG-USR-001 to CFG-USR-021 (CFG-USR-005 does not exist) | 19 | 0 | 1 |
| Early-reply settings | CFG-SCH-102 to CFG-SCH-112 | 11 | 0 | 0 |
| Structured errors and recovery editing | CFG-RCV-001 to CFG-RCV-006 | 6 | 0 | 0 |

**Summary:** 267 specs: 260 implemented, 7 gaps (#370), 0 deferred. The logging design of #349 (readable terminal lines, a rotated JSON log file per program, the `logging` section replacing `LOG_LEVEL`) is built and pinned by packages/config/test/logging.test.ts, with the owner's case (an invalid config.yaml under the dashboard) in services/dashboard/test/logging.test.ts (#318 built: CFG-SEC-001, CFG-SEC-019, CFG-ENV-012). CFG-SEC-018 (a wildcard clear always works) is held by the dashboard's secret route (DASH-SECRET-014); the early-reply settings (CFG-SCH-102 to 112) are built and pinned by packages/config/test/config-early.test.ts. The `live` flag is carried by `sectionPresentation` and the `GET /config/schema` answer only (CFG-PRES-019, MOD-CFG-022).

## Coverage notes

Annotated tests that cover only part of their spec line: CFG-SCH-001 (only `cohost.name`), CFG-SCH-004 (regex only), CFG-SCH-005 (only `salience.cooldown_ms`), CFG-SCH-006 (only negative `voice.speed`), CFG-URL-001 (only `urls.redis`), CFG-USR-002 (no empty-file case), CFG-ISO-001 (omitted `chat.fake.interval_ms` not asserted), CFG-ISO-003 (through `ConfigSchema`, not `loadConfig`) and CFG-LOAD-005 (one test exercises `unknownKeys` directly).

## Work Required

- Chat sources (YouTube chat design 2026-11-16): built for `chat.sources`, the `chat.youtube` section and its ranges, the `CHAT_SOURCES` override, the `chat.youtube.api_key` secret path and the example file (CFG-SCH-010, CFG-SCH-048 to CFG-SCH-054, CFG-ISO-003, CFG-ISO-007, CFG-PRES-006, CFG-USR-018). The `tools.servers.*.token` secret path (CFG-SEC-003) and the fourteen-name override map (CFG-ISO-006) are built; CFG-SEC-018's dashboard clause waits on DASH-SECRET-014.
