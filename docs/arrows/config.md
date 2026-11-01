# Arrow: config

`@cohost/config`: YAML + env configuration schema and loader, service URL helpers, logger, and the user-owned personality and expressions files, plus the shipped example files.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`). Specs verified against the code at git `49ba935`: 39 of 43 specs implemented; 0 deferred; 4 gaps (inline `.env` comments, array unknown-keys, blank `AVATAR_DRIVER`, unused `ears.discord.*` ids). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **Must a config load with no `.env`?** (CFG-ISO-005) `config/config.example.yaml:134` has `"${AVATAR_DRIVER}"` with no default, `avatar.driver` has no blank-to-default (`packages/config/src/schema.ts:167`), and `avatar.vtube_studio.port` / `avatar.vmc.port` are required (`schema.ts:173,177`, CFG-SCH-010) while `config.example.yaml:140,145` give no default. Recommended: yes; give `AVATAR_DRIVER`, `VTS_*` and `VMC_*` `:-` defaults in the example and make `avatar.driver` blank-safe, keeping CFG-ISO-005 as the target.
2. **Where should inline `.env` comments be handled?** (CFG-ENV-006) `.env.example:18-20` puts `# ...` after empty values; `loadDotEnv` keeps them as the value (`packages/config/src/index.ts:74-80`) while Compose strips them. Recommended: strip an unquoted ` #...` suffix in `loadDotEnv`, matching Compose.
3. **Wire or delete `ears.discord.guild_id` / `voice_channel_id`?** (CFG-USR-005) Defined at `schema.ts:182-185` and filled at `config.example.yaml:150-151`, but ears reads `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` directly (`services/ears/src/discord.ts:61-62`). Recommended: delete the keys and CFG-USR-005 (env is the only source in practice and the ids are per-machine).
4. **Should the unknown-key warning descend into arrays and drop the region-split text?** (CFG-LOAD-006) `unknownKeys` returns nothing for arrays (`index.ts:86`); the warning hard-codes brain-split advice (`index.ts:114`). Recommended: yes to both.
5. **Should a hook accept an explicit `llm.provider: mock`?** (CFG-SCH-009) The hook enum omits `mock` (`schema.ts:22`) while `llm.provider` accepts it (`schema.ts:45`); commit `51d5a9c` says hooks reach mock by inheriting. Recommended: keep it rejected and keep CFG-SCH-009 as written.
6. **Keep CFG-ENV-008 as a config spec?** It is a boundary statement with no code entry point and no test (LLD Open Question 13). Recommended: keep it and add a test asserting `ConfigSchema.shape` has no control key.

## References

### HLD
- docs/high-level-design.md (Segments table, platform / config)

### LLD
- docs/intent/config/config-design.md

### EARS
- docs/intent/config/config-specs.md (43 specs, prefix `CFG`: 39 `[x]`, 4 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/config.test.ts (315 lines; 22 `@spec` lines with 37 spec-ID citations, covering 30 of the 39 implemented specs)

### Code
- packages/config/src/index.ts (loader, helpers, urls, logger; 11 `@spec` lines)
- packages/config/src/schema.ts (zod schemas, `Emotion`; 7 `@spec` lines)
- packages/config/package.json, packages/config/tsconfig.json
- config/config.example.yaml, config/expressions.example.yaml, config/personality.example.md, .env.example (realize CFG-ISO-004, CFG-USR-003, CFG-USR-004; no annotations)

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
| Schema | CFG-SCH-001 to 010 | 10 | 0 | 0 | 5 |
| Backend selection and presets | CFG-ISO-001 to 005 | 4 | 0 | 1 (ISO-005) | 3 |
| Service URLs and logger | CFG-URL-001 to 004 | 4 | 0 | 0 | 3 |
| User-owned files | CFG-USR-001 to 005 | 4 | 0 | 1 (USR-005) | 4 |

**Summary:** 39 of 43 specs implemented; 0 deferred; 4 gaps. 30 of the 39 implemented specs have a test carrying their `@spec` ID. Implemented specs with no test: CFG-ENV-003, CFG-ENV-008, CFG-SCH-002, CFG-SCH-007, CFG-SCH-008, CFG-SCH-009, CFG-SCH-010, CFG-ISO-002, CFG-URL-004. Implemented specs with no code annotation: CFG-ENV-008 (boundary statement), CFG-ISO-004, CFG-USR-003, CFG-USR-004 (realized by the example files).

## Key Findings

1. **Markers hold.** Every `[x]` line was confirmed in code and every `[ ]` gap still reproduces; no marker was flipped.
2. **Spec lines corrected to match the code** (IDs kept): CFG-ENV-001 (empty counts as unset), CFG-ENV-005 (line, key and value trimming), CFG-SCH-002 (`llm.claude.effort` enum), CFG-URL-002 and CFG-URL-003 (an empty override falls back). New lines for behaviour that had none: CFG-SCH-008 (remaining section defaults), CFG-SCH-009 (hook `url` default and provider enum without `mock`), CFG-SCH-010 (required nested objects and avatar host/port).
3. **`loadDotEnv` mishandles inline comments** — `.env.example:18-20` ends API-key lines with `# llm.provider: ...`; Compose strips these but `loadDotEnv` only skips whole-line comments (`packages/config/src/index.ts:74-80`), so host-run services get the comment text as the variable value. The shipped-example test checks only `llm.model` (`config.test.ts:90-104`). (CFG-ENV-006)
4. **Config cannot load without `.env`** — `avatar.driver` has no blank-to-default (`schema.ts:167`) and `vtube_studio.port` / `vmc.port` are required (`schema.ts:173,177`) while `config.example.yaml:134,140,145` give no defaults; the `.env` hint (`index.ts:105-108`) papers over it. (CFG-ISO-005, Question 1)
5. **Dead and partially dead keys** — `ears.discord.guild_id` / `voice_channel_id` are defined and populated but never read (ears uses `env("DISCORD_GUILD_ID")`, `services/ears/src/discord.ts:61-62`); `voice.sample_rate` is only used by the stub synth (`services/voice/src/voice.ts:41-55`). (CFG-USR-005, Question 3)
6. **`unknownKeys` does not descend into arrays** (`index.ts:86`), so typos inside `reflexes[]` entries are silent, and its warning embeds region-split migration text (`index.ts:114`). (CFG-LOAD-006, Question 4)
7. **Partial test coverage behind annotated tests.** CFG-SCH-001 (only `cohost.name`), CFG-SCH-004 (regex only), CFG-SCH-005 (only `salience.cooldown_ms`), CFG-SCH-006 (only negative `voice.speed`), CFG-URL-001 (only `urls.redis`), CFG-USR-002 (no empty-file case), CFG-ISO-001 (omitted `chat.fake.interval_ms` not asserted), CFG-ISO-003 (through `ConfigSchema`, not `loadConfig`) and CFG-LOAD-005 (`config.test.ts:52` exercises `unknownKeys` directly).
8. **Env-only settings are scattered** — `CONTROL_*`, `HEARTBEAT_INTERVAL_MS`, `INJECT_*`, `PORT`, `VOICE_PORT` are read directly by their owners; `.env.example` lists only `HEARTBEAT_INTERVAL_MS` (commented, line 54). (CFG-ENV-008)
9. **The frozen OpenSpec `config` baseline diverges** on the config dir default and the URL list; CFG-DIR-002 and CFG-URL-002/003 supersede it (LLD Open Questions, Resolved 2).
10. **Test environment coupling** — `config.test.ts:140-143` depends on `/.dockerenv` being absent; `sandbox()` leaks `CONFIG_DIR` (`:67`).

## Work Required

### Must Fix
1. Strip or reject unquoted inline `#` comments in `loadDotEnv`, or fix `.env.example` (CFG-ENV-006, Question 2).
2. Make `AVATAR_DRIVER` blank-safe and give the avatar host/port blocks defaults, or document `.env` as mandatory (CFG-ISO-005, Question 1).

### Should Fix
3. Either wire `ears.discord.guild_id` / `voice_channel_id` into ears or remove them from schema and example (CFG-USR-005, Question 3).
4. Descend into arrays in `unknownKeys` and generalise the warning text (CFG-LOAD-006, Question 4).
5. Add tests for the untested implemented specs: CFG-ENV-003, CFG-ENV-008, CFG-SCH-002, CFG-SCH-007 to 010, CFG-ISO-002, CFG-URL-004, and the uncovered halves of the partially tested ones (Key Finding 7).

### Nice to Have
6. Route config diagnostics through the pino logger; format `loadExpressions` errors like `loadConfig`; make `savePersonality` atomic (CFG-LOAD-005, CFG-USR-001).
7. List the isolation presets and `CONTROL_*` in `.env.example`.
8. Annotate the example files with `# @spec` comments for CFG-ISO-004, CFG-USR-003 and CFG-USR-004 (outside `packages/config`).
