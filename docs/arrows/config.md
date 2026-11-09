# Arrow: config

`@cohost/config`: YAML + env configuration schema and loader, service URL helpers, logger, and the user-owned personality and expressions files, plus the shipped example files.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 53 specs: 51 implemented, 0 deferred, 2 gaps (viewer notes, chunks 2 and 4); at the audit 47 of 47 were implemented. The owner decisions of 2026-11-01 are applied below; the config-segment gap fixes are implemented. With the spoken fallback line designed: 60 specs: 53 implemented, 7 gaps, 0 deferred.

## Spoken fallback line: designed, not built

Design: LLD § Schema key groups, Files table and Decisions (`[proposed]` items marked).

- New gaps: `CFG-DIR-006`, `CFG-DIR-007` (`clipsDir()`, `FALLBACK_CLIPS_DIR`) and `CFG-SCH-018` (`ears.fallback.min_interval_ms`) in build chunk 1; `CFG-SCH-017` (`voice.fallback.lines`) and `CFG-USR-009` (starter list) in chunk 2; `CFG-SCH-019` (`brain.cortex.fallback_ack_chance`, default 0.25) and `CFG-USR-010` in chunk 3.

## Viewer notes: chunk 1 built

The spec file holds 53 specs: 53 `[x]`, 0 `[ ]`.

- Built: `CFG-SCH-014` (`brain.memory.regular_messages`), `CFG-SCH-015` (`brain.memory.notes` numbers), `CFG-SCH-016` (`capture` and `consolidator` hooks), `CFG-USR-007` (the example's consolidator on the cortex's model via ollama, and the keys listed with their defaults). Tests: `packages/config/test/config.test.ts`.
- Chunk 2 built: `CFG-USR-008` (the example's capture hook on `${NOTES_MODEL:-gemma3:4b}` via ollama, `.env.example` documents `NOTES_MODEL`).
- Chunk 4 built: `CFG-ENV-009`. `VIEWERS_TOKEN` has no schema key (pinned by a `config.test.ts` test; a YAML key for it is reported unknown) and the dashboard reads it from `process.env` (`viewersTokenFromEnv`); `.env.example` documents it.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B3** config must load with no `.env` → blank `avatar.driver` means `null`, `${AVATAR_DRIVER:-null}` in the example, avatar port defaults 8001 / 39539; an unknown non-blank driver still fails the load. Specs: CFG-ISO-005 (rewritten), CFG-SCH-010 (port moved to ISO-005).
2. **S48** inline `.env` comments → `loadDotEnv` strips an unquoted ` # ...` suffix like Compose. Specs: CFG-ENV-006.
3. **B19** `ears.discord.guild_id` / `voice_channel_id` → keep and wire (config keys win over direct env reads). Specs: CFG-USR-005; ears side EARS-SESS-007.
4. **S49** unknown keys inside arrays → descend into arrays, drop the region-split text. Specs: CFG-LOAD-006.
5. **R5** explicit `llm.provider: mock` on a hook → keep rejecting it. Specs: CFG-SCH-009 (unchanged, wording clarified).
6. **S50** CFG-ENV-008 → keep, add a test that `ConfigSchema.shape` has no control key (Work Required).
7. **B20 / S17** stale example comment: `config/config.example.yaml:18` says mock brings hash embeddings; memory's `MEMORY_EMBEDDER` decides. Specs: CFG-USR-006.
8. New keys requested by other segments' decisions: `brain.salience.thinking_timeout_ms`, `brain.affect.baseline_arousal` (S33, S39) and `vision.timeout_ms`, `vision.upload_timeout_ms`, `vision.upload_max_bytes` (R1 eyes timeouts) and `llm.timeout_ms` (R1 model-backends timeouts). Specs: CFG-SCH-011, CFG-SCH-012, CFG-SCH-013.

## References

### HLD
- docs/high-level-design.md (Segments table, platform / config)

### LLD
- docs/intent/config/config-design.md

### EARS
- docs/intent/config/config-specs.md (47 specs, prefix `CFG`: 46 `[x]`, 1 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/config.test.ts (453 lines; 33 `@spec` lines, covering 37 of the 46 implemented specs)

### Code
- packages/config/src/index.ts (loader, helpers, urls, logger; 11 `@spec` lines)
- packages/config/src/schema.ts (zod schemas, `Emotion`; 7 `@spec` lines)
- packages/config/package.json, packages/config/tsconfig.json
- config/config.example.yaml, config/expressions.example.yaml, config/personality.example.md, .env.example (realize CFG-ISO-004, CFG-ISO-005, CFG-USR-003, CFG-USR-004, CFG-USR-006; no annotations)

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
| Config directory and seeding | CFG-DIR-001 to 007 | 5 | 0 | 2 (DIR-006, DIR-007: clip directory) | 5 |
| Environment handling | CFG-ENV-001 to 008 | 8 | 0 | 0 | 7 |
| Loading and validation pipeline | CFG-LOAD-001 to 006 | 6 | 0 | 0 | 6 |
| Schema | CFG-SCH-001 to 019 | 16 | 0 | 3 (SCH-017 to 019: fallback line) | 12 |
| Backend selection and presets | CFG-ISO-001 to 005 | 5 | 0 | 0 | 4 |
| Service URLs and logger | CFG-URL-001 to 004 | 4 | 0 | 0 | 3 |
| User-owned files | CFG-USR-001 to 010 | 8 | 0 | 2 (USR-009, USR-010: fallback line) | 6 |

**Summary:** 53 of 53 specs implemented (47 at the audit, plus CFG-SCH-014 to 016 and CFG-USR-007 from viewer-notes chunk 1 CFG-USR-008 from chunk 2 and CFG-ENV-009 from chunk 4); 0 deferred; 0 gaps. 37 of the 46 implemented specs have a test carrying their `@spec` ID. Implemented specs with no test: CFG-ENV-003, CFG-SCH-002, CFG-SCH-007, CFG-SCH-008, CFG-SCH-010, CFG-ISO-002, CFG-URL-004, CFG-USR-006 (comment-only). Implemented specs with no code annotation: CFG-ENV-008 (boundary statement), CFG-ISO-004, CFG-USR-003, CFG-USR-004, CFG-USR-006 (realized by the example files).

## Key Findings

1. **Markers hold.** Every `[x]` line was confirmed in code at `49ba935`. The owner decisions reworded CFG-ISO-005 (no-`.env` load, port defaults, fail fast on an unknown driver), CFG-ENV-006, CFG-LOAD-006 and CFG-USR-005, narrowed CFG-SCH-010 (port requirement moved to ISO-005) and added CFG-SCH-011, CFG-SCH-012 and CFG-USR-006.
2. **Spec lines corrected to match the code** (IDs kept): CFG-ENV-001 (empty counts as unset), CFG-ENV-005 (line, key and value trimming), CFG-SCH-002 (`llm.claude.effort` enum), CFG-URL-002 and CFG-URL-003 (an empty override falls back). CFG-SCH-008 (remaining section defaults), CFG-SCH-009 (hook `url` default and provider enum without `mock`) and CFG-SCH-010 (required nested objects and avatar hosts) cover behaviour that had no line.
3. **Inline `.env` comments** — `.env.example:18-20` ends API-key lines with `# llm.provider: ...`; `loadDotEnv` strips an unquoted whitespace-then-`#` suffix like Compose, so host-run services read those variables as empty (CFG-ENV-006, S48).
4. **Config loads without `.env`** — every service loads the whole config, so the shipped example must not depend on avatar or model variables: model placeholders carry `:-` defaults, `avatar.driver` is blank-safe and the avatar ports default (CFG-ISO-005, B3).
5. **Dead and partially dead keys** — `voice.sample_rate` is only used by the stub synth (`services/voice/src/voice.ts:41-55`).
6. **`unknownKeys` descends into arrays**, so typos inside `reflexes[]` entries are reported as `path[index].key` (CFG-LOAD-006, S49).
7. **Partial test coverage behind annotated tests.** CFG-SCH-001 (only `cohost.name`), CFG-SCH-004 (regex only), CFG-SCH-005 (only `salience.cooldown_ms`), CFG-SCH-006 (only negative `voice.speed`), CFG-URL-001 (only `urls.redis`), CFG-USR-002 (no empty-file case), CFG-ISO-001 (omitted `chat.fake.interval_ms` not asserted), CFG-ISO-003 (through `ConfigSchema`, not `loadConfig`) and CFG-LOAD-005 (`config.test.ts:52` exercises `unknownKeys` directly).
8. **Env-only settings are scattered** — `CONTROL_*`, `HEARTBEAT_INTERVAL_MS`, `INJECT_*`, `PORT`, `VOICE_PORT` are read directly by their owners; `.env.example` lists only `HEARTBEAT_INTERVAL_MS` (commented, line 54). (CFG-ENV-008)
9. **The frozen OpenSpec `config` baseline diverges** on the config dir default and the URL list; CFG-DIR-002 and CFG-URL-002/003 supersede it (LLD Open Questions, Resolved 2).
10. **Test environment coupling** — `config.test.ts:140-143` depends on `/.dockerenv` being absent; `sandbox()` leaks `CONFIG_DIR` (`:67`).

## Work Required

### Must Fix
None outstanding in this segment. Implemented: no-`.env` load (CFG-ISO-005) and inline `.env` comment stripping (CFG-ENV-006).

### Should Fix
1. Consumers read the new schema keys (the keys exist and default; nothing reads them yet): salience `brain.salience.thinking_timeout_ms` (SAL-BUSY-001), affect `brain.affect.baseline_arousal` (AFF-MOOD-006), eyes `vision.timeout_ms` / `upload_timeout_ms` / `upload_max_bytes` (EYES-DESC-006, EYES-INJ-012, EYES-INJ-013), model-backends `llm.timeout_ms` (LLM-CHAT-008). Owned by those segments.
2. Add tests for the remaining untested implemented specs: CFG-ENV-003, CFG-SCH-002, CFG-SCH-007, CFG-SCH-008, CFG-SCH-010, CFG-ISO-002, CFG-URL-004, and the uncovered halves of the partially tested ones (Key Finding 7).

### Nice to Have
4. Route config diagnostics through the pino logger; format `loadExpressions` errors like `loadConfig`; make `savePersonality` atomic (CFG-LOAD-005, CFG-USR-001).
5. List the isolation presets and `CONTROL_*` in `.env.example`.
6. Annotate the example files with `# @spec` comments for CFG-ISO-004, CFG-USR-003, CFG-USR-004 and CFG-USR-006 (outside `packages/config`).
