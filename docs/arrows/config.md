# Arrow: config

`@cohost/config`: YAML + env configuration schema and loader, service URL helpers, logger, and the user-owned personality and expressions files, plus the shipped example files.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 46 specs: 39 implemented, 0 deferred, 7 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B3** config must load with no `.env` → blank `avatar.driver` means `null`, `${AVATAR_DRIVER:-null}` in the example, avatar port defaults 8001 / 39539; an unknown non-blank driver still fails the load. Specs: CFG-ISO-005 (rewritten), CFG-SCH-010 (port moved to ISO-005).
2. **S48** inline `.env` comments → `loadDotEnv` strips an unquoted ` # ...` suffix like Compose. Specs: CFG-ENV-006.
3. **B19** `ears.discord.guild_id` / `voice_channel_id` → keep and wire (config keys win over direct env reads). Specs: CFG-USR-005; ears side EARS-SESS-007.
4. **S49** unknown keys inside arrays → descend into arrays, drop the region-split text. Specs: CFG-LOAD-006.
5. **R5** explicit `llm.provider: mock` on a hook → keep rejecting it. Specs: CFG-SCH-009 (unchanged, wording clarified).
6. **S50** CFG-ENV-008 → keep, add a test that `ConfigSchema.shape` has no control key (Work Required).
7. **B20 / S17** stale example comment: `config/config.example.yaml:18` says mock brings hash embeddings; memory's `MEMORY_EMBEDDER` decides. Specs: CFG-USR-006.
8. New keys requested by other segments' decisions: `brain.salience.thinking_timeout_ms`, `brain.affect.baseline_arousal` (S33, S39) and `vision.timeout_ms`, `vision.upload_timeout_ms`, `vision.upload_max_bytes` (R1 eyes timeouts). Specs: CFG-SCH-011, CFG-SCH-012.

## References

### HLD
- docs/high-level-design.md (Segments table, platform / config)

### LLD
- docs/intent/config/config-design.md

### EARS
- docs/intent/config/config-specs.md (46 specs, prefix `CFG`: 39 `[x]`, 7 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/config.test.ts (315 lines; 22 `@spec` lines with 37 spec-ID citations, covering 30 of the 39 implemented specs)

### Code
- packages/config/src/index.ts (loader, helpers, urls, logger; 11 `@spec` lines)
- packages/config/src/schema.ts (zod schemas, `Emotion`; 7 `@spec` lines)
- packages/config/package.json, packages/config/tsconfig.json
- config/config.example.yaml, config/expressions.example.yaml, config/personality.example.md, .env.example (realize CFG-ISO-004, CFG-USR-003, CFG-USR-004, CFG-USR-006; no annotations)

### OpenSpec (frozen)
- openspec/specs/config/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/config/spec.md

## Architecture

**Purpose:** Single place that defines what a valid cohost configuration is and how it is found, seeded, interpolated, validated and cached. Dependency root of the workspace (no workspace deps; everything imports it).

**Key Components:**
1. `configDir()` / `findWorkspaceRoot()` — `CONFIG_DIR` override, else nearest `pnpm-workspace.yaml` ancestor's `config/`, else `cwd/config` (`index.ts:13-25`).
2. `loadConfig()` — `.env` load, seed, `${VAR}` / `${VAR:-default}` substitution, null-dropping, zod validation, unknown-key warning, module cache (`index.ts:98-119`).
3. `ConfigSchema` / `ModuleSchema` / `ExpressionMapSchema` / `Emotion` — shape, defaults, backend-selection enums with blank-to-default preprocessing (`schema.ts`).
4. `ensureFromExample`, `loadPersonality`, `savePersonality`, `loadExpressions` — user-owned files seeded from `*.example.*` (`index.ts:127-152`).
5. `env`, `envOr`, `urls.*`, `createLogger` — runtime helpers used by every service (`index.ts:156-182`).
6. Example files — `config.example.yaml` wires the isolation preset env vars; tests load them as fixtures.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Config directory and seeding | CFG-DIR-001 to 005 | 5 | 0 | 0 | 5 |
| Environment handling | CFG-ENV-001 to 008 | 7 | 0 | 1 (ENV-006) | 5 |
| Loading and validation pipeline | CFG-LOAD-001 to 006 | 5 | 0 | 1 (LOAD-006) | 5 |
| Schema | CFG-SCH-001 to 012 | 10 | 0 | 2 (SCH-011, 012) | 5 |
| Backend selection and presets | CFG-ISO-001 to 005 | 4 | 0 | 1 (ISO-005) | 3 |
| Service URLs and logger | CFG-URL-001 to 004 | 4 | 0 | 0 | 3 |
| User-owned files | CFG-USR-001 to 006 | 4 | 0 | 2 (USR-005, 006) | 4 |

**Summary:** 39 of 46 specs implemented; 0 deferred; 7 gaps. 30 of the 39 implemented specs have a test carrying their `@spec` ID. Implemented specs with no test: CFG-ENV-003, CFG-ENV-008, CFG-SCH-002, CFG-SCH-007, CFG-SCH-008, CFG-SCH-009, CFG-SCH-010, CFG-ISO-002, CFG-URL-004. Implemented specs with no code annotation: CFG-ENV-008 (boundary statement), CFG-ISO-004, CFG-USR-003, CFG-USR-004 (realized by the example files).

## Key Findings

1. **Markers hold.** Every `[x]` line was confirmed in code at `49ba935` and every audit gap still reproduces; no `[x]` line was flipped. The owner decisions reworded CFG-ISO-005 (no-`.env` load, port defaults, fail fast on an unknown driver), CFG-ENV-006, CFG-LOAD-006 and CFG-USR-005, narrowed CFG-SCH-010 (port requirement moved to ISO-005) and added CFG-SCH-011, CFG-SCH-012 and CFG-USR-006.
2. **Spec lines corrected to match the code** (IDs kept): CFG-ENV-001 (empty counts as unset), CFG-ENV-005 (line, key and value trimming), CFG-SCH-002 (`llm.claude.effort` enum), CFG-URL-002 and CFG-URL-003 (an empty override falls back). CFG-SCH-008 (remaining section defaults), CFG-SCH-009 (hook `url` default and provider enum without `mock`) and CFG-SCH-010 (required nested objects and avatar hosts) cover behaviour that had no line.
3. **`loadDotEnv` mishandles inline comments** — `.env.example:18-20` ends API-key lines with `# llm.provider: ...`; Compose strips these but `loadDotEnv` only skips whole-line comments (`packages/config/src/index.ts:74-80`), so host-run services get the comment text as the variable value. The shipped-example test checks only `llm.model` (`config.test.ts:90-104`). (CFG-ENV-006, S48)
4. **Config cannot load without `.env`** — `avatar.driver` has no blank-to-default (`schema.ts:167`) and `vtube_studio.port` / `vmc.port` are required (`schema.ts:173,177`) while `config.example.yaml:134,140,145` give no defaults; every service loads the whole config, so all of them stop. The `.env` hint (`index.ts:105-108`) papers over it. (CFG-ISO-005, B3)
5. **Dead and partially dead keys** — `ears.discord.guild_id` / `voice_channel_id` are defined and populated but not yet read (ears uses `env("DISCORD_GUILD_ID")`, `services/ears/src/discord.ts:63-64`; CFG-USR-005, B19); `voice.sample_rate` is only used by the stub synth (`services/voice/src/voice.ts:41-55`).
6. **`unknownKeys` does not descend into arrays** (`index.ts:86`), so typos inside `reflexes[]` entries are silent, and its warning embeds region-split migration text (`index.ts:114`). (CFG-LOAD-006, S49)
7. **Partial test coverage behind annotated tests.** CFG-SCH-001 (only `cohost.name`), CFG-SCH-004 (regex only), CFG-SCH-005 (only `salience.cooldown_ms`), CFG-SCH-006 (only negative `voice.speed`), CFG-URL-001 (only `urls.redis`), CFG-USR-002 (no empty-file case), CFG-ISO-001 (omitted `chat.fake.interval_ms` not asserted), CFG-ISO-003 (through `ConfigSchema`, not `loadConfig`) and CFG-LOAD-005 (`config.test.ts:52` exercises `unknownKeys` directly).
8. **Env-only settings are scattered** — `CONTROL_*`, `HEARTBEAT_INTERVAL_MS`, `INJECT_*`, `PORT`, `VOICE_PORT` are read directly by their owners; `.env.example` lists only `HEARTBEAT_INTERVAL_MS` (commented, line 54). (CFG-ENV-008)
9. **The frozen OpenSpec `config` baseline diverges** on the config dir default and the URL list; CFG-DIR-002 and CFG-URL-002/003 supersede it (LLD Open Questions, Resolved 2).
10. **Test environment coupling** — `config.test.ts:140-143` depends on `/.dockerenv` being absent; `sandbox()` leaks `CONFIG_DIR` (`:67`).

## Work Required

### Must Fix
1. Make the shipped config load with no `.env`: blank-safe `avatar.driver`, `${AVATAR_DRIVER:-null}` in `config.example.yaml`, schema defaults 8001 / 39539 for the avatar ports; an unknown driver still fails (B3; CFG-ISO-005, CFG-SCH-010).
2. Strip unquoted inline ` # ...` comments in `loadDotEnv` (S48; CFG-ENV-006).

### Should Fix
3. Ears reads `ears.discord.guild_id` / `voice_channel_id` (B19; CFG-USR-005, ears EARS-SESS-007).
4. Descend into arrays in `unknownKeys` and drop the region-split text (S49; CFG-LOAD-006).
5. Fix the mock/hash-embedder comment at `config/config.example.yaml:18` (B20, S17; CFG-USR-006).
6. Add the schema keys other segments' fixes read: `brain.salience.thinking_timeout_ms`, `brain.affect.baseline_arousal` (CFG-SCH-011) and `vision.timeout_ms`, `vision.upload_timeout_ms`, `vision.upload_max_bytes` (CFG-SCH-012).
7. Add a test that `ConfigSchema.shape` has no control key (S50; CFG-ENV-008), and tests for the other untested implemented specs: CFG-ENV-003, CFG-SCH-002, CFG-SCH-007 to 010, CFG-ISO-002, CFG-URL-004, and the uncovered halves of the partially tested ones (Key Finding 7).

### Nice to Have
8. Route config diagnostics through the pino logger; format `loadExpressions` errors like `loadConfig`; make `savePersonality` atomic (CFG-LOAD-005, CFG-USR-001).
9. List the isolation presets and `CONTROL_*` in `.env.example`.
10. Annotate the example files with `# @spec` comments for CFG-ISO-004, CFG-USR-003, CFG-USR-004 and CFG-USR-006 (outside `packages/config`).
