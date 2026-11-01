---
parent: high-level-design
prefix: CFG
---

# config

Mapped 2026-10-31 at git `686cc8f`; status MAPPED (not audited). Parent: [high-level-design](../../high-level-design.md). Specs: [config-specs.md](config-specs.md).

## Context and Design Philosophy

`@cohost/config` (`packages/config`) is the dependency root of the workspace: it has no workspace dependencies and every other package and service imports it (`packages/config/package.json:11-15` lists only pino, yaml, zod). It owns three things:

1. The **shape** of `config/config.yaml` and `config/expressions.yaml` (zod schemas in `packages/config/src/schema.ts`), including the nine-value `Emotion` enum that the bus event schemas also import (`schema.ts:3-7`).
2. The **loader**: locate the config directory, seed user-owned files from committed `*.example.*` templates, load `.env`, substitute `${VAR}` placeholders, validate, warn about unknown keys, and cache (`packages/config/src/index.ts`).
3. **Small runtime helpers** every service uses: `env`/`envOr`, the `urls.*` service-address functions, `createLogger`, and the personality read/write pair.

Observed philosophy `[inferred]`: behaviour lives in `config/config.yaml` (git-ignored, seeded from an example), secrets and per-machine values live in `.env`, and the two are joined by `${VAR}` / `${VAR:-default}` placeholders inside the YAML (`config/config.example.yaml:1-4`). Each backend that can be swapped for a mock or off variant is selected by an enum key whose example value is an env placeholder with a default, so operators flip a backend through `.env` without editing `config.yaml` (OpenSpec change `add-isolated-backends`). The schema is lenient about unknown keys (warn, do not fail) and strict about enums and ranges.

## Files, directory resolution and seeding

| File | Where | Role | Seeded from |
| --- | --- | --- | --- |
| `config.yaml` | `<configDir>/config.yaml` | all behaviour; read by `loadConfig` | `config.example.yaml` |
| `personality.md` | `<configDir>/personality.md` | co-host persona prompt; read/written by `loadPersonality` / `savePersonality` | `personality.example.md` |
| `expressions.yaml` | `<configDir>/expressions.yaml` | emotion to avatar-app name map; read by `loadExpressions` | `expressions.example.yaml` |
| `.env` | `<configDir>/../.env` | secrets and per-machine values; loaded by `loadDotEnv` | `.env.example` (copied by `install.sh`, not by code) |

Resolution (`index.ts`):

- `findWorkspaceRoot(start = cwd)` walks parent directories until one contains `pnpm-workspace.yaml`, returning `undefined` at the filesystem root (`index.ts:13-21`). It exists because `pnpm dev` runs each service with its package directory as cwd (comment `index.ts:9-12`).
- `configDir()` = `resolve(CONFIG_DIR ?? join(findWorkspaceRoot() ?? cwd, "config"))` (`index.ts:23-24`). Compose sets `CONFIG_DIR=/app/config` (`docker-compose.yml:20`) and bind-mounts `./config` there (`docker-compose.yml:22`).
- `ensureFromExample(name, example)` returns the real path if it exists; otherwise copies the example, prints `[config] created <file> from <example>` with `console.warn`, and returns the path; if the example is also missing it throws `No <file> and no <example> to seed it from` (`index.ts:121-129`). It is called for all three user files (`index.ts:96,132,137`), so any service that starts first seeds them (README.md:82-84 claims exactly this).
- The `.env` path is always `join(configDir(), "..", ".env")` (`index.ts:61`). It assumes the config directory sits directly under the project root; in a container that resolves to `/app/.env`, which does not exist (it is `.dockerignore`d, `.dockerignore:6`) and does not matter because Compose injects `.env` through `env_file`.

Personality and expressions: `loadPersonality()` reads `personality.md` on every call (no cache) and `savePersonality(text)` overwrites it with a plain `writeFileSync` (`index.ts:136-144`). `loadExpressions()` parses `expressions.yaml` with `ExpressionMapSchema` and treats an empty file as `{}` (`index.ts:131-134`); a schema failure there surfaces as a raw `ZodError`, not the formatted message `loadConfig` produces. The consumers are cortex (loads at start, reloads on `control reload_personality`, `services/cortex/src/cortex.ts:36,92`), dashboard (GET/PUT personality, `services/dashboard/src/routes.ts:93,98`), memory reflection (`services/memory/src/reflect.ts:33,54`) and avatar (expressions, and `configDir()` as the VTube Studio token directory, `services/avatar/src/index.ts:30`).

## Loading pipeline

`loadConfig(force = false)` (`index.ts:93-114`):

1. Return the module-level cached `Config` unless `force` (`index.ts:54,94`). There is no file watching: config is read once per process; only personality has a reload path.
2. `loadDotEnv()` (`index.ts:95`). Parses `KEY=value` lines: trims, skips blank and `#` whole-line comments, requires `=` at index 1 or later, strips one layer of matching single or double quotes, and sets `process.env[key]` only when it is `undefined` (`index.ts:66-78`). It does not handle inline `# comment` suffixes.
3. `ensureFromExample("config.yaml", "config.example.yaml")` (`index.ts:96`).
4. `substituteEnv(text)` on the raw file text: regex `\$\{([A-Z0-9_]+)(?::-([^}]*))?\}`; a set non-empty variable wins, otherwise the default, otherwise `""` (`index.ts:32-38`). Substitution happens before YAML parsing, so a value like `port: ${OBS_PORT}` becomes `port:` (null) when unset.
5. `parseYaml`, then `coerceEmptyNumbers` drops every `null`-valued key at any depth (`index.ts:40-52`; the name says numbers but the filter is type-blind) so schema defaults apply.
6. `ConfigSchema.safeParse`. On failure throw `Invalid <file>:` followed by one `  path: message` line per zod issue, plus, when no `.env` exists and `/.dockerenv` does not (`missingDotEnv`, `index.ts:64`), a hint to `cp .env.example .env` (`index.ts:100-103`).
7. `unknownKeys(raw, parsed)` recursively lists dotted paths present in the raw object but missing from the parsed one; non-empty results are reported by one `console.warn` and loading continues (`index.ts:81-91,105-111`). Arrays are not descended into (`index.ts:82`). The warning text hard-codes advice about settings that "used to sit directly under brain" (`index.ts:109`).
8. Cache and return.

All diagnostics use `console.warn`, not the pino logger defined in the same file.

## Schema: key groups

All defaults below are in `packages/config/src/schema.ts`; "consumer" is where the key is read (segment in parentheses).

| Group | Keys (default) | Notes / consumer |
| --- | --- | --- |
| `cohost` | `name`, `streamer` (required, min 1), `timezone` ("UTC") | names in prompts of cortex, affect, salience, memory reflect; timezone in `services/cortex/src/prompt.ts:20` |
| `llm` | `provider` (blank to `ollama`; `ollama\|openai\|anthropic\|bedrock\|mock`), `model`, `embed_model` (required), `num_ctx` 8192, `temperature` 0.9, `max_tokens` 120, `openai{base_url, api_key}`, `claude{api_key, effort low, max_tokens 2048 min 256, fallbacks true}`, `bedrock{region ""}` | `packages/llm` (model-backends); `mock` is opt-in, never default (`schema.ts:40`) |
| `vision` | `enabled` false, `model` (required even when disabled), `interval_ms` 8000, `obs{host, port 4455, password, source, width 896}` | eyes (`services/eyes/src/index.ts:24-79`) |
| `chat` | `source` (blank to `twitch`; `twitch\|fake`), `fake.interval_ms` 8000, `twitch.channel`, `ignore_users` [], `ignore_prefixes` ["!"] | chat (`services/chat/src/index.ts:21,35`, `filter.ts:33`) |
| `brain` | `working_memory_events` 24 | salience and cortex `Context` size |
| `brain.salience` | `tick_ms` 1500, `cooldown_ms` 6000, `idle_chatter_ms` 90000, `reply_on_mention` true, `speak_threshold` 0.6, `arousal_bias` 0.2, `module`, `reflexes` [] | salience |
| `brain.affect` | `publish_ms` 2000, `half_life_ms` 45000, `baseline_valence` 0.15, `module` | affect |
| `brain.memory` | `store` (blank to `postgres`; `postgres\|memory`), `embedder` (blank to `ollama`; `ollama\|hash`), `recall_k` 6, `min_similarity` 0.35 | memory (`services/memory/src/backend.ts:13`) |
| `brain.cortex` | `recall_timeout_ms` 2500, `speaking_timeout_ms` 20000, `critic` | cortex |
| `voice` | `engine` (blank to `kokoro`; `kokoro\|stub`), `voice` "af_heart", `speed` 1, `sample_rate` 24000 | voice; `sample_rate` is read only by the stub synth (`services/voice/src/voice.ts:41-55`) |
| `avatar` | `driver` (`vtube-studio\|vmc\|null`, default null), `fps` 30, `smoothing` 0.25, `idle_motion` true, `vtube_studio{host, port (required), plugin_name, plugin_developer}`, `vmc{host, port}` (required) | avatar |
| `ears` | `source` (blank to `discord`; `discord\|off`), `discord{guild_id, voice_channel_id}`, `silence_ms` 700, `min_speech_ms` 400, `stt_model` "Systran/faster-whisper-small" | ears; the `discord.*` ids are unused (see Open Questions) |
| `dashboard` | `port` 3000 | dashboard, overridden by the `PORT` env var (`services/dashboard/src/index.ts:30`) |

`ModuleSchema` (`schema.ts:13-26`) is the shared hook config for the three region hooks: `kind` (blank to `rules`; `rules|llm|http`), `url`, `timeout_ms` 1500, and `llm{provider?, model?}` where both blank values mean "inherit" and a provider without a model is rejected via `superRefine` (`schema.ts:22-25`). The whole object `.default({})`s. Hook behaviour itself belongs to region-hooks.

Required-ness is uneven: `brain.*` regions and `llm.openai/claude/bedrock` default to `{}`, but the nine top-level sections themselves, plus `vision.obs`, `chat.twitch`, `avatar.vtube_studio`, `avatar.vmc` and `ears.discord`, are required objects with no `.default({})`, and `avatar.vtube_studio.host/port` and `avatar.vmc.host/port` are required fields. A usable config therefore needs every section present (an empty `{}` suffices for `brain`, `voice`, `dashboard`), which the example provides.

Blank handling is also uneven. Enum keys added for isolation wrap `z.enum` in `z.preprocess((v) => v || default, ...)` (`schema.ts:14,20,21,41,84,138,140,155,175`), but `avatar.driver` and `llm.claude.effort` do not, so an empty substitution fails them. Plain `z.string()` keys accept `""` silently (for example `ears.stt_model`, `avatar.vtube_studio.plugin_developer`, `llm.openai.api_key`); only `.min(1)` keys (`llm.model`, `embed_model`, `vision.model`, names) turn a missing variable into a validation error.

## Environment variables

Three tiers, none of which is validated by `ConfigSchema`.

**Placeholders in `config/config.example.yaml`** (flow through `substituteEnv`; the example line is in parentheses). With a `:-default` the variable is optional; without, an empty value reaches the schema as `""` or null.

| Variable | Key | Default in example |
| --- | --- | --- |
| `LLM_PROVIDER` (:19) | `llm.provider` | `ollama` |
| `LLM_MODEL` (:20), `EMBED_MODEL` (:25) | `llm.model`, `llm.embed_model` | none (required) |
| `LLM_API_KEY` (:28), `ANTHROPIC_API_KEY` (:30) | `llm.openai.api_key`, `llm.claude.api_key` | none |
| `VISION_ENABLED` (:38), `VISION_MODEL` (:39) | `vision.enabled`, `vision.model` | `false`; none |
| `OBS_HOST/PORT/PASSWORD/SOURCE` (:42-45) | `vision.obs.*` | none (port null falls to 4455) |
| `CHAT_SOURCE` (:49), `TWITCH_CHANNEL` (:53, :142) | `chat.source`, `chat.twitch.channel`, `avatar.vtube_studio.plugin_developer` | `twitch`; none |
| `MEMORY_STORE` (:109), `MEMORY_EMBEDDER` (:110) | `brain.memory.*` | `postgres`, `ollama` |
| `VOICE_ENGINE` (:128) | `voice.engine` | `kokoro` |
| `AVATAR_DRIVER` (:134), `VTS_HOST/PORT` (:139-140), `VMC_HOST/PORT` (:144-145) | `avatar.*` | none (see Open Questions) |
| `EARS_SOURCE` (:148), `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` (:150-151), `STT_MODEL` (:154) | `ears.source`, `ears.discord.*`, `ears.stt_model` | `discord`; none; none |

**Read directly from `process.env` / `env()`** (not config keys): `CONFIG_DIR` (`index.ts:24`), `LOG_LEVEL` (`index.ts:169`), `REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `VOICE_PORT`, `DASHBOARD_URL` (all via `urls.*`, `index.ts:156-166`; Compose overrides the first six and `DASHBOARD_URL` with in-network hostnames, `docker-compose.yml:13-20`); `PORT` (dashboard), `VOICE_PORT` (voice server, `services/voice/src/index.ts:21`); `TWITCH_CLIENT_ID/SECRET/ACCESS_TOKEN/REFRESH_TOKEN` (`services/chat/src/index.ts:59`); `DISCORD_TOKEN` (`services/ears/src/index.ts:24`) and `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` via `env()` (`services/ears/src/discord.ts:61-62`); `ANTHROPIC_API_KEY` and the `AWS_*` chain through the Anthropic/Bedrock SDKs (`packages/llm`).

**Env-only control and ops settings** (deliberately not in YAML): `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_BIND`, `CONTROL_RUNTIME`, `CONTROL_PROCESS_MODE`, `CONTROL_ADVANCED` (`packages/control/src/config.ts:25-36`, owned by control-plane); `HEARTBEAT_INTERVAL_MS` (`packages/bus/src/heartbeat.ts:48-51`, default 5000) and `COHOST_VERSION` (`heartbeat.ts:75`); `INJECT_MAX_IMAGE_BYTES`, `INJECT_MAX_AUDIO_BYTES`, `INJECT_TTL_MS` (`services/dashboard/src/uploads.ts:32-34`). `.env.example` lists `HEARTBEAT_INTERVAL_MS` (commented, line 54) but none of `CONTROL_*`, the isolation presets, or `INJECT_*`; README.md documents `CONTROL_*` and the presets. Compose-level variables (`COMPOSE_FILE`, `DASHBOARD_PORT`, `KOKORO_IMAGE`, `SPEACHES_IMAGE`, and `LLM_MODEL` / `VISION_MODEL` / `EMBED_MODEL` for the `models` container) belong to deployment.

## Service URLs and logger

`urls` is an object of functions, each calling `envOr` at call time so tests and late-loaded `.env` values take effect (`index.ts:156-166`). `urls.voice()` defaults to loopback built from `VOICE_PORT` and `urls.dashboard()` to `http://127.0.0.1:3000`; both were added after the base sweep so host-run (`pnpm dev`) services work outside Compose. `createLogger(service)` returns `pino({ name, level: LOG_LEVEL || "info" })` and `Logger` is its type (`index.ts:168-171`); packages' tests cast fake loggers to `never`.

## Tests

`packages/config/test/config.test.ts` (293 lines) covers: substitution forms (`:9`), seeding (`:19`), reflex regex validation (`:34`), hook provider/model rule (`:40`), `unknownKeys` (`:47`), shipped examples loading clean and mapping every emotion (`:84,100`), env substitution/null defaults/caching (`:111`), invalid-config message and `.env` hint (`:125-138`), unknown-key warning (`:140`), `loadDotEnv` (`:147`), personality round trip (`:161`), `env`/`envOr`/`urls.redis` (`:168`), `configDir` workspace walk (`:182`), `urls.voice` and `urls.dashboard` (`:207,231`), memory store enum (`:223`), and the isolation presets (`:256-293`). Not covered: `urls.database/ollama/tts/stt`, `createLogger`, blank-to-default for `llm.provider`, `loadExpressions` on an empty or invalid file, inline `.env` comments, and the `/.dockerenv` branch of `missingDotEnv`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Config format | YAML file with `${VAR}` / `${VAR:-default}` text substitution before parsing | env vars only; JSON; schema-aware per-key env overrides | `[inferred]` secrets stay in `.env` and behaviour in YAML, per header comment `config/config.example.yaml:1-4`; substitution is a plain regex (`index.ts:32-38`) |
| `:-default` form | Literal default kept in `config.yaml`, overridable from `.env` | only `${VAR}` | `[inferred]` doc comment `index.ts:26-31` ("lets config.yaml hold the normal value literally while still allowing a per-machine override"); used by every isolation preset (`config.example.yaml:19,38,49,109,110,128,148`) |
| Blank enum values | `z.preprocess((v) => v \|\| default, z.enum(...))` | `.default()` only; `.catch()` | `[inferred]` empty substitution yields `""` (not undefined) so `.default()` would not apply; pattern at `schema.ts:14,41,84,138,140,155,175` |
| Null handling | Drop all null keys at any depth before validation | per-key coercion; treat empty as error | `[inferred]` comment `index.ts:41` ("`port: ${OBS_PORT}` becomes null ... leave it to defaults"); test `config.test.ts:111-116` |
| Unknown keys | Warn once, load anyway | fail validation (`.strict()`) | `[inferred]` zod default strips unknown keys; warning added for the brain-split migration (`index.ts:80,109`); test `config.test.ts:140` |
| First-run files | Services copy the example if the real file is missing, in addition to `install.sh` | installer-only seeding | `[inferred]` comment `index.ts:116-120` says install.sh "does the same copy"; makes `pnpm dev` and containers work without the installer |
| Config dir | Env override, else nearest `pnpm-workspace.yaml` ancestor, else cwd | cwd only (previous behaviour) | `[inferred]` comment `index.ts:9-12`; fixes TESTING.md known problem 1; test `config.test.ts:182` |
| `.env` loading in code | `loadDotEnv` for the dev loop, never overriding real env | rely on Compose / shell only; a dotenv library | `[inferred]` comment `index.ts:56-60`; hand-written parser keeps `@cohost/config` dependencies to pino, yaml, zod (`package.json:11-15`) |
| Caching | Module-level cache with `force` escape hatch | reload on each call; file watcher | `[inferred]` `index.ts:54,94`; tests rely on identity (`config.test.ts:119`) |
| Backend selection | Enum keys in YAML plus preset env vars with live defaults | separate "mock mode" flag; separate config files | `[inferred]` OpenSpec `add-isolated-backends` requirement "Isolation preset variables"; tests `config.test.ts:256-280` |
| `Emotion` enum home | Defined in `@cohost/config`, imported by bus | define in bus | `[inferred]` `schema.ts:3-7` is imported by `packages/bus/src/events.ts` (sweep-1); keeps reflex `emotion` and expression-map validation in one place |
| Service control settings | Env-only (`CONTROL_*`), no YAML keys | YAML section | `[inferred]` `packages/control/src/config.ts:25-36` reads env directly; secrets (the token) must not live in a committed-adjacent file |
| URL helpers | Functions that read env on every call | constants evaluated at import | `[inferred]` `index.ts:156-166`; tests mutate env between calls (`config.test.ts:174-179,207-221`) |

## Open Questions & Future Decisions

### Resolved by observation

1. Where the VTube Studio token lives: avatar passes `stateDir: configDir()` (`services/avatar/src/index.ts:30`), so `config/.vts-token`, matching README.md:214. (sweep-4 and sweep-7 called this a mismatch; at 686cc8f it is not. The real gap is that `.gitignore` does not ignore it; see deployment.)

### Observed, unexplained, or debt

1. **OpenSpec drift on config dir.** OpenSpec `config § Config directory and seeding` says files are read from `CONFIG_DIR` "(default `./config`)"; code defaults to `<workspace root>/config` (`index.ts:23-24`). The spec is stale (CFG-DIR-002 follows the code). The URL list in `config § Env helpers and URLs` also omits `urls.voice` and `urls.dashboard`, and there is no OpenSpec coverage of `findWorkspaceRoot`, the `.env` hint, or personality load/save.
2. **`loadDotEnv` and inline comments** (CFG-ENV-006). `.env.example` lines 18-20 are `LLM_API_KEY=                 # llm.provider: openai ...`, `ANTHROPIC_API_KEY=  # ...`, `AWS_ACCESS_KEY_ID=  # ...`. Compose's `env_file` parser strips unquoted inline comments; `loadDotEnv` only skips lines starting with `#` (`index.ts:70`), so in the dev loop (`pnpm dev`, `.env` copied verbatim) the comment text becomes the variable's value (`index.ts:73-76`). The test that loads `.env.example` (`config.test.ts:84-98`) checks only `llm.model`. `[inferred]` effect: a non-empty bogus `llm.openai.api_key` / `claude.api_key` / `AWS_ACCESS_KEY_ID` in host runs; masked by the fact that most operators set a real key on that line.
3. **`AVATAR_DRIVER` and the required avatar blocks** (CFG-ISO-005). `config.example.yaml:134` has no default and `avatar.driver` is a plain enum with a default of `"null"` (`schema.ts:161`) that does not apply to `""`; `vtube_studio.port`/`vmc.port` (`schema.ts:167,171`) are required while their placeholders (`:140,:145`) have no default. With no `.env` the config cannot load whichever driver is chosen. TESTING.md:29-35 and the `.env` hint (`index.ts:102`) are the workaround, not a fix. Intent unconfirmed.
4. **Silent empties in plain string keys.** `ears.stt_model: "${STT_MODEL}"` becomes `""` if unset (the `"Systran/faster-whisper-small"` default only applies to a missing key, `schema.ts:182`); same for `plugin_developer` (`config.example.yaml:142`) and `openai.api_key`.
5. **`unknownKeys` gaps** (CFG-LOAD-006): arrays are skipped (`index.ts:82`), so typos inside `reflexes[]` entries pass silently; the warning text embeds historical migration advice (`index.ts:109`) that is wrong for any other kind of stray key.
6. **Dead keys** (CFG-USR-005): `ears.discord.guild_id` and `voice_channel_id` are defined (`schema.ts:176-179`) and populated by the example (`config.example.yaml:150-151`) but unread; `services/ears/src/discord.ts:61-62` uses `env("DISCORD_GUILD_ID")` / `env("DISCORD_VOICE_CHANNEL_ID")`. `voice.sample_rate` is read only by `stubSynth` (`services/voice/src/voice.ts:41-55`); the Kokoro path does not consult it (grep of `services/*/src`). `dashboard.port` is overridden by `PORT` and Compose publishes a fixed container port 3000 (`docker-compose.yml:143`), so editing the key alone breaks the published port.
7. **`vision.model` is required even when `vision.enabled` is false** (`schema.ts:72`); `.env.example` supplies `VISION_MODEL` so the issue is latent.
8. **`.env` path assumption.** `<configDir>/../.env` (`index.ts:61`) is only correct when `config/` is a direct child of the project root; a custom `CONFIG_DIR` elsewhere silently changes where `.env` is looked for. `missingDotEnv` also treats any container as exempt via `/.dockerenv` (`index.ts:64`), which makes test `config.test.ts:130-133` environment-dependent: it would fail when run inside a container.
9. **`loadExpressions` error shape** differs from `loadConfig` (raw `ZodError`, `index.ts:133`); `savePersonality` is a non-atomic overwrite (`index.ts:143`); `loadPersonality` / `loadExpressions` are uncached by design or accident (unknown).
10. **Diagnostics via `console.warn`** (`index.ts:107,127`) rather than the pino logger from the same file; they carry no service name or structure.
11. **Duplicate type name.** `ModuleConfig` is exported here (`schema.ts:27`) and re-declared with a different derivation in `packages/modules/src/index.ts:230` (region-hooks).
12. **Test hygiene.** `sandbox()` sets `process.env.CONFIG_DIR` and never restores it (`config.test.ts:62`); one test replaces `process.env` wholesale (`:96`); a second import statement appears mid-file (`:32`); the reflex test reaches into zod internals via `removeDefault()` (`:35`); `config.test.ts` depends on repo-root files (`config/config.example.yaml`, `.env.example`, `config/expressions.example.yaml`).
13. **`.env.example` incompleteness.** The isolation presets, `CONTROL_*` and `INJECT_*` appear only in README.md and OpenSpec; `AWS_PROFILE` is mentioned only in a comment (`.env.example:20`) and in `examples/providers/README.md:86` (compose mounts no `~/.aws`; deployment). `STT_MODEL` sits under a heading "Ollama models (pulled by the `models` service)" (`.env.example:9-15`) although it is neither an Ollama model nor pulled (deployment).

## References

**Files in this segment**
- `packages/config/src/index.ts`, `packages/config/src/schema.ts`, `packages/config/test/config.test.ts`, `packages/config/package.json`, `packages/config/tsconfig.json`
- `config/config.example.yaml`, `config/expressions.example.yaml`, `config/personality.example.md`, `.env.example`

**Other segments (direction)**
- Depended on by every segment (config is the dependency root). `event-bus` imports `Emotion` from `schema.ts`; `region-hooks` and `model-backends` consume `ModuleSchema` / `llm.*`; `control-plane` reads `CONTROL_*` and `HEARTBEAT_INTERVAL_MS` itself (env-only, outside this schema); `voice`, `chat`, `memory`, `ears`, `eyes`, `avatar`, `dashboard` read their sections; `deployment` owns Compose-level variables and `install.sh` seeding.
- Depends on: none within the workspace.

**External libraries**: `zod` (schemas), `yaml` (parser), `pino` (logger). Node `fs`, `path`.

**OpenSpec**
- `openspec/specs/config/spec.md` (8 requirements, baseline)
- `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/config/spec.md` (MODIFIED "Schema validation and defaults", ADDED "Isolation preset variables")

**Docs**: README.md "Configuration" section (lines 73-87), `docs/TESTING.md` section 1 (known problems 1-3 there are resolved by this package's workspace walk, `.env` hint and `urls.voice`).
