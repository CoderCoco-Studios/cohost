# Arrow: config

`@cohost/config`: YAML + env configuration schema and loader, service URL helpers, logger, and the user-owned personality and expressions files, plus the shipped example files.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`), not yet audited. 36 of 40 specs observed working; 4 gaps (inline `.env` comments, array unknown-keys, blank `AVATAR_DRIVER`, unused `ears.discord.*` ids).

## References

### HLD
- docs/high-level-design.md (Segments table, platform / config)

### LLD
- docs/intent/config/config-design.md

### EARS
- docs/intent/config/config-specs.md (40 specs, prefix `CFG`)

### Tests
- packages/config/test/config.test.ts (293 lines; 31 spec annotations point here)

### Code
- packages/config/src/index.ts (loader, helpers, urls, logger)
- packages/config/src/schema.ts (zod schemas, `Emotion`)
- packages/config/package.json, packages/config/tsconfig.json
- config/config.example.yaml, config/expressions.example.yaml, config/personality.example.md, .env.example

### OpenSpec
- openspec/specs/config/spec.md
- openspec/changes/add-isolated-backends/specs/config/spec.md

## Architecture

**Purpose:** Single place that defines what a valid cohost configuration is and how it is found, seeded, interpolated, validated and cached. Dependency root of the workspace (no workspace deps; everything imports it).

**Key Components:**
1. `configDir()` / `findWorkspaceRoot()` — `CONFIG_DIR` override, else nearest `pnpm-workspace.yaml` ancestor's `config/`, else `cwd/config` (`index.ts:13-24`).
2. `loadConfig()` — `.env` load, seed, `${VAR}` / `${VAR:-default}` substitution, null-dropping, zod validation, unknown-key warning, module cache (`index.ts:93-114`).
3. `ConfigSchema` / `ModuleSchema` / `ExpressionMapSchema` / `Emotion` — shape, defaults, backend-selection enums with blank-to-default preprocessing (`schema.ts`).
4. `ensureFromExample`, `loadPersonality`, `savePersonality`, `loadExpressions` — user-owned files seeded from `*.example.*` (`index.ts:121-144`).
5. `env`, `envOr`, `urls.*`, `createLogger` — runtime helpers used by every service (`index.ts:147-171`).
6. Example files — `config.example.yaml` wires the isolation preset env vars; tests load them as fixtures.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Config directory and seeding | CFG-DIR-001 to 005 | 5 | 0 | 0 |
| Environment handling | CFG-ENV-001 to 008 | 7 | 0 | 1 (ENV-006) |
| Loading and validation pipeline | CFG-LOAD-001 to 006 | 5 | 0 | 1 (LOAD-006) |
| Schema | CFG-SCH-001 to 007 | 7 | 0 | 0 |
| Backend selection and presets | CFG-ISO-001 to 005 | 4 | 0 | 1 (ISO-005) |
| Service URLs and logger | CFG-URL-001 to 004 | 4 | 0 | 0 |
| User-owned files | CFG-USR-001 to 005 | 4 | 0 | 1 (USR-005) |

**Summary:** 36 of 40 specs implemented; 0 deferred; 4 gaps.

## Key Findings

1. **`loadDotEnv` mishandles inline comments** — `.env.example:18-20` ends API-key lines with `# llm.provider: ...`; Compose strips these but `loadDotEnv` only skips whole-line comments (`packages/config/src/index.ts:70-76`), so host-run services get the comment text as the variable value. The shipped-example test checks only `llm.model` (`config.test.ts:84-98`). (CFG-ENV-006)
2. **Config cannot load without `.env`** — `avatar.driver` has no blank-to-default (`schema.ts:161`) and `vtube_studio.port` / `vmc.port` are required (`schema.ts:167,171`) while `config.example.yaml:134,140,145` give no defaults; the `.env` hint (`index.ts:100-103`) papers over it. `[inferred]` unintended. (CFG-ISO-005)
3. **OpenSpec is stale on config dir resolution** — spec says `CONFIG_DIR` default `./config`; code walks to the workspace root (`index.ts:13-24`). `urls.voice` / `urls.dashboard`, the `.env` hint and personality load/save have no spec coverage at all. (CFG-DIR-002, CFG-URL-002/003)
4. **Dead and partially dead keys** — `ears.discord.guild_id` / `voice_channel_id` are defined and populated but never read (ears uses `env("DISCORD_GUILD_ID")`, `services/ears/src/discord.ts:61-62`); `voice.sample_rate` is only used by the stub synth (`services/voice/src/voice.ts:41-55`). (CFG-USR-005)
5. **`unknownKeys` does not descend into arrays** (`index.ts:82`), so typos inside `reflexes[]` entries are silent, and its warning embeds brain-split migration text (`index.ts:109`). (CFG-LOAD-006)
6. **Env-only settings are scattered** — `CONTROL_*`, `HEARTBEAT_INTERVAL_MS`, `INJECT_*`, `PORT`, `VOICE_PORT` are read directly by their owners; `.env.example` lists only `HEARTBEAT_INTERVAL_MS` (commented, line 54). (CFG-ENV-008)
7. **Config load is once-per-process** (module cache, no watcher); only personality has a reload path (`services/cortex/src/cortex.ts:92`). `[inferred]` deliberate.
8. **Test environment coupling** — `config.test.ts:130-133` depends on `/.dockerenv` being absent; `sandbox()` leaks `CONFIG_DIR` (`:62`).

## Work Required

### Must Fix
1. Strip or reject unquoted inline `#` comments in `loadDotEnv`, or fix `.env.example` (CFG-ENV-006).
2. Make `AVATAR_DRIVER` blank-safe and give the avatar host/port blocks defaults, or document `.env` as mandatory (CFG-ISO-005).

### Should Fix
3. Either wire `ears.discord.guild_id` / `voice_channel_id` into ears or remove them from schema and example (CFG-USR-005).
4. Descend into arrays in `unknownKeys` and generalise the warning text (CFG-LOAD-006).
5. Update OpenSpec `config` for the workspace-root default, `urls.voice` / `urls.dashboard`, the `.env` hint and personality helpers (CFG-DIR-002, CFG-URL-002, CFG-URL-003, CFG-USR-001).

### Nice to Have
6. Add tests for blank `llm.provider`, `urls.database/ollama/tts/stt`, `createLogger`, empty/invalid `loadExpressions`, and the container `.env` branch (CFG-SCH-002, CFG-URL-001, CFG-URL-004, CFG-USR-002).
7. Route config diagnostics through the pino logger; format `loadExpressions` errors like `loadConfig`; make `savePersonality` atomic (CFG-LOAD-005, CFG-USR-001).
8. List the isolation presets and `CONTROL_*` in `.env.example`.
