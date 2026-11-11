---
parent: high-level-design
prefix: CFG
---

# config

Status: AUDITED 2026-11-02 at git `1b57790`. Mapped 2026-10-31 at git `686cc8f`; specs verified against the code and `@spec` annotations added at git `49ba935`; owner decisions of 2026-11-01 applied. Where the code does not yet do what this document intends, the text names the `[ ]` spec line. Parent: [high-level-design](../../high-level-design.md). Specs: [config-specs.md](config-specs.md).

## Context and Design Philosophy

`@cohost/config` (`packages/config`) is the dependency root of the workspace: it has no workspace dependencies and every other package and service imports it (`packages/config/package.json:11-15` lists only pino, yaml, zod). It owns three things:

1. The **shape** of `config/config.yaml` and `config/expressions.yaml` (zod schemas in `packages/config/src/schema.ts`), including the nine-value `Emotion` enum that the bus event schemas also import (`schema.ts:4-8`).
2. The **loader**: locate the config directory, seed user-owned files from committed `*.example.*` templates, load `.env`, substitute `${VAR}` placeholders, validate, warn about unknown keys, and cache (`packages/config/src/index.ts`).
3. **Small runtime helpers** every service uses: `env`/`envOr`, the `urls.*` service-address functions, `createLogger`, and the personality read/write pair.

Design philosophy, as the example files' header comments state it (`config/config.example.yaml:1-4`, `.env.example:1-2`): behaviour lives in `config/config.yaml` (git-ignored, seeded from an example), secrets and per-machine values live in `.env`, and the two are joined by `${VAR}` / `${VAR:-default}` placeholders inside the YAML. Each backend that can be swapped for a mock or off variant is selected by an enum key whose example value is an env placeholder with a default, so operators flip a backend through `.env` without editing `config.yaml`; the mock variants are never the default (commit `51d5a9c`, comment `schema.ts:44`). The schema is lenient about unknown keys (warn, do not fail) and strict about enums and ranges. The shipped example config loads with no `.env` at all: every placeholder it uses either has a `:-default` or lands on a key whose schema default applies (CFG-ISO-005), while a value that is set but invalid, such as an unknown `avatar.driver`, still fails the load.

## Files, directory resolution and seeding

| File | Where | Role | Seeded from |
| --- | --- | --- | --- |
| `config.yaml` | `<configDir>/config.yaml` | all behaviour; read by `loadConfig` | `config.example.yaml` |
| `personality.md` | `<configDir>/personality.md` | co-host persona prompt; read/written by `loadPersonality` / `savePersonality` | `personality.example.md` |
| `expressions.yaml` | `<configDir>/expressions.yaml` | emotion to avatar-app name map; read by `loadExpressions` | `expressions.example.yaml` |
| `.env` | `<configDir>/../.env` | secrets and per-machine values; loaded by `loadDotEnv` | `.env.example` (copied by `install.sh`, not by code) |
| per-service data | `dataDir()`: `COHOST_DATA_DIR`, else `data` under the workspace root (CFG-DIR-006, CFG-DIR-007); each service writes only under `<dataDir()>/<service>/`, such as voice's fallback clip store and ears' clip cache | generated files a service keeps across restarts; not edited by hand and ignored by version control (`data/` in `.gitignore`) | none: services create what they need |

Resolution (`index.ts`):

- `findWorkspaceRoot(start = cwd)` walks parent directories until one contains `pnpm-workspace.yaml`, returning `undefined` at the filesystem root (`index.ts:13-21`). It exists because `pnpm dev` runs each service with its package directory as cwd (comment `index.ts:9-12`).
- `configDir()` = `resolve(CONFIG_DIR ?? join(findWorkspaceRoot() ?? cwd, "config"))` (`index.ts:24-25`). Compose sets `CONFIG_DIR=/app/config` (`docker-compose.yml:20`) and bind-mounts `./config` there (`docker-compose.yml:22`).
- `dataDir()` = `resolve(COHOST_DATA_DIR ?? join(findWorkspaceRoot() ?? cwd, "data"))`, the same resolution as `configDir()` (CFG-DIR-006, CFG-DIR-007). Each service keeps its own files under `<dataDir()>/<service>/` and never reads another service's subdirectory: voice's fallback clip store is `voice/fallback-clips`, ears' clip cache `ears/fallback-clips`. Services exchange those files over HTTP (HLD tenet 1). In a container the workspace root is `/app`, so the default is the container's own `/app/data`, with no volume. The path is a per-machine value, so it is an environment variable with no YAML key (HLD tenet 7).
- `ensureFromExample(name, example)` returns the real path if it exists; otherwise copies the example, prints `[config] created <file> from <example>` with `console.warn`, and returns the path; if the example is also missing it throws `No <file> and no <example> to seed it from` (`index.ts:127-135`). It is called for all three user files (`index.ts:101,139,145`), so any service that starts first seeds them (README.md:82-84 says the same).
- The `.env` path is always `join(configDir(), "..", ".env")` (`index.ts:64`). It assumes the config directory sits directly under the project root; in a container that resolves to `/app/.env`, which does not exist (it is `.dockerignore`d, `.dockerignore:6`) and does not matter because Compose injects `.env` through `env_file`.

Personality and expressions: `loadPersonality()` reads `personality.md` on every call (no cache) and `savePersonality(text)` overwrites it with a plain `writeFileSync` (`index.ts:144-152`). `loadExpressions()` parses `expressions.yaml` with `ExpressionMapSchema` and treats an empty file as `{}` (`index.ts:138-141`); a schema failure there surfaces as a raw `ZodError`, not the formatted message `loadConfig` produces. The consumers are cortex (loads at start, reloads on `control reload_personality`, `services/cortex/src/cortex.ts:36,104`), dashboard (GET/PUT personality, `services/dashboard/src/routes.ts:100,106`), memory reflection (`services/memory/src/reflect.ts:34,55`) and avatar (expressions, and `configDir()` as the VTube Studio token directory, `services/avatar/src/index.ts:30`).

## Loading pipeline

`loadConfig(force = false)` (`index.ts:98-119`):

1. Return the module-level cached `Config` unless `force` (`index.ts:57,99`). There is no file watching: config is read once per process; only personality has a reload path.
2. `loadDotEnv()` (`index.ts:100`). Parses `KEY=value` lines: trims each line, skips blank and `#` whole-line comments, requires `=` at index 1 or later, trims key and value, strips one layer of matching single or double quotes, and sets `process.env[key]` only when it is `undefined` (`index.ts:70-86`). Comments follow Compose's `env_file` rules (CFG-ENV-006): an unquoted value loses a whitespace-then-`#` suffix (`KEY= # note` is empty), a quoted value may be followed by a comment and keeps any `#` inside the quotes, and a `#` with no preceding whitespace (`a#b`) is part of the value.
3. `ensureFromExample("config.yaml", "config.example.yaml")` (`index.ts:101`).
4. `substituteEnv(text)` on the raw file text: regex `\$\{([A-Z0-9_]+)(?::-([^}]*))?\}`; a set non-empty variable wins, otherwise the default, otherwise `""` (`index.ts:34-40`). Substitution happens before YAML parsing, so a value like `port: ${OBS_PORT}` becomes `port:` (null) when unset.
5. `parseYaml`, then `coerceEmptyNumbers` drops every `null`-valued key at any depth (`index.ts:43-55`; the name says numbers but the filter is type-blind; `null` array elements are kept) so schema defaults apply.
6. `ConfigSchema.safeParse`. On failure throw `Invalid <file>:` followed by one `  path: message` line per zod issue, plus, when no `.env` exists and `/.dockerenv` does not (`missingDotEnv`, `index.ts:67`), a hint to `cp .env.example .env` (`index.ts:105-108`).
7. `unknownKeys(raw, parsed)` recursively lists dotted paths present in the raw object but missing from the parsed one; non-empty results are reported by one `console.warn` that names only the ignored keys, and loading continues. The walk descends into array entries and reports them as `path[index].key`, so a typo inside a reflex shows up as `brain.salience.reflexes[0].cooldwn_ms` (CFG-LOAD-006).
8. Cache and return.

All diagnostics use `console.warn`, not the pino logger defined in the same file.

## Schema: key groups

All defaults below are in `packages/config/src/schema.ts`; "consumer" is where the key is read (segment in parentheses).

| Group | Keys (default) | Notes / consumer |
| --- | --- | --- |
| `cohost` | `name`, `streamer` (required, min 1), `timezone` ("UTC") | names in prompts of cortex, affect, salience, memory reflect; timezone in `services/cortex/src/prompt.ts:21` |
| `llm` | `provider` (blank to `ollama`; `ollama\|openai\|anthropic\|bedrock\|mock`), `model`, `embed_model` (required), `num_ctx` 8192, `temperature` 0.9, `max_tokens` 120, `openai{base_url, api_key}`, `claude{api_key, effort low, max_tokens 2048 min 256, fallbacks true}`, `bedrock{region ""}`, `timeout_ms` 60000 (CFG-SCH-013) | `packages/llm` (model-backends); `mock` is opt-in, never default (`schema.ts:44`) |
| `vision` | `enabled` false, `model` (required even when disabled), `interval_ms` 8000, `timeout_ms` 30000, `upload_timeout_ms` 10000, `upload_max_bytes` 8388608, `obs{host, port 4455, password, source, width 896}` | eyes (`services/eyes/src/index.ts:24-83`); the three timeout/size keys are describe-call timeout, injected-upload fetch timeout and injected-image size cap (CFG-SCH-012) |
| `chat` | `source` (blank to `twitch`; `twitch\|fake`), `fake.interval_ms` 8000, `twitch.channel`, `ignore_users` [], `ignore_prefixes` ["!"] | chat (`services/chat/src/index.ts:20-22,43`, `filter.ts:33`) |
| `brain` | `working_memory_events` 24 | salience and cortex `Context` size |
| `brain.salience` | `tick_ms` 1500, `cooldown_ms` 6000, `thinking_timeout_ms` 60000 (how long a `thinking` cortex counts as busy), `idle_chatter_ms` 90000, `reply_on_mention` true, `speak_threshold` 0.6, `arousal_bias` 0.2, `module`, `reflexes []` (CFG-SCH-011) | salience |
| `brain.affect` | `publish_ms` 2000, `half_life_ms` 45000, `baseline_valence` 0.15, `baseline_arousal` 0.1 (0..1, resting arousal), `module` (CFG-SCH-011) | affect |
| `brain.memory` | `store` (blank to `postgres`; `postgres\|memory`), `embedder` (blank to `ollama`; `ollama\|hash`), `recall_k` 6, `min_similarity` 0.35 | memory (`services/memory/src/backend.ts:15`) |
| `brain.memory` (viewer notes, gap) | `regular_messages` 25 (CFG-SCH-014); `notes{dirty_threshold 20, recent_half_life_days 7, core_half_life_days 60, reinforce 0.6, promote_mentions 3, demote_below 0.3, drop_below 0.1, returning_strength 0.3, suppress_similarity 0.8, capture_min_chars 8, max_notes_per_viewer 5, max_notes_total 15, sensitive_cooldown_hours 24, deleted_retention_days 30}` (CFG-SCH-015); `notes.capture`, `notes.consolidator` (`ModuleSchema`, CFG-SCH-016) | memory viewer notes (memory segment, Viewer notes). The two threshold defaults, `sensitive_cooldown_hours` 24 and `deleted_retention_days` 30 are owner decisions; every other default is |
| `brain.cortex` | `recall_timeout_ms` 2500, `speaking_timeout_ms` 20000, `critic`; `fallback_ack_chance` 0.25 (CFG-SCH-019) | cortex; `fallback_ack_chance` is the base chance stated in the acknowledgement hint after a fallback line (cortex CTX-FALL-*) |
| `voice` | `engine` (blank to `kokoro`; `kokoro\|stub`), `voice` "af_heart", `speed` 1, `sample_rate` 24000; `fallback.lines` [] (CFG-SCH-017) | voice; `sample_rate` is read only by the stub synth (`services/voice/src/voice.ts:41-55`); `fallback.lines` is the spoken fallback phrase list voice turns into clips (voice VOICE-CLIP-*) |
| `avatar` | `driver` (`vtube-studio\|vmc\|null`; blank means `null`, CFG-ISO-005), `fps` 30, `smoothing` 0.25, `idle_motion` true, `vtube_studio{host, port 8001, plugin_name, plugin_developer}`, `vmc{host, port 39539}` (CFG-ISO-005) | avatar |
| `ears` | `source` (blank to `discord`; `discord\|off`), `discord{guild_id, voice_channel_id}`, `silence_ms` 700, `min_speech_ms` 400, `stt_model` "Systran/faster-whisper-small"; `fallback.min_interval_ms` 20000 (CFG-SCH-018) | ears; the `discord.*` ids are the source of the guild and voice channel ears joins (CFG-USR-005, EARS-SESS-007); `fallback.min_interval_ms` is the storm limit between two fallback clips (EARS-FALL-007) |
| `dashboard` | `port` 3000 | dashboard, overridden by the `PORT` env var (`services/dashboard/src/index.ts:31`) |

Every viewer-notes number is a config value: the dirty-note threshold that triggers consolidation, the regular-viewer message threshold (previously a literal in the cortex), the fade half-lives, the reinforcement and promotion rule, the note caps and the rest of the `brain.memory.notes` keys above. The shipped example configures the two notes hooks with `kind: llm` on the local `ollama` provider: the capture hook on a small model from `${NOTES_MODEL:-gemma3:4b}` and the consolidator on `${LLM_MODEL:-qwen2.5:7b-instruct-q4_K_M}` (the cortex's model), so a fresh install captures notes with no `.env` change (CFG-USR-007, CFG-USR-008). The consolidator on the cortex's model is the owner's decision. The capture model is a small, non-reasoning instruct model (`gemma3:4b`) that follows the capture JSON schema, so it can classify every chat line beside the cortex's model; the owner can swap it with `NOTES_MODEL`. The capture hook's `timeout_ms` is 20000 in the example because the first call after Ollama loads the model takes about 13 s on CPU and later calls 2 to 4 s. With the schema default (`kind: rules`) capture writes nothing and consolidation does arithmetic only.

Spoken fallback line keys: `voice.fallback.lines` is the list of lines the co-host says when a line fails to play (CFG-SCH-017), `ears.fallback.min_interval_ms` the minimum time between two fallback lines (CFG-SCH-018; owner decision, default 20000), and `brain.cortex.fallback_ack_chance` the base chance stated to the model after a fallback (CFG-SCH-019; owner decision, default 0.25). The schema default for the list is empty, which turns the feature off; the shipped example carries a starter list for the owner to edit (CFG-USR-009) and the chance with a comment that it is a nudge, not an enforced rate (CFG-USR-010). The example gains a key no earlier than its schema, because the example must load with no unknown-key warning (CFG-USR-003). Starter list (no line names the persona, and numbers are spelled out so TTS reads them as words):

```yaml
voice:
  fallback:
    # Said aloud when a line fails to play. Edit freely; voice regenerates the clips on its next start.
    lines:
      - "Error: unable to play line."
      - "Sorry, that thought got lost somewhere between my brain and my mouth."
      - "Uh. I had something really good there. It's gone now."
      - "Line not found. Please insert witty remark and try again."
      - "My voice just blue-screened. Pretend I said something clever."
      - "Buffering. Buffering. Nope."
      - "That was going to be hilarious. You'll have to trust me."
      - "Packet loss. Emotional packet loss."
      - "Hold on, my mouth is still loading."
      - "I swear I was talking. The audio was not."
      - "Speech module has left the chat."
      - "Insert profound statement here."
      - "Well, that line went straight into the void."
      - "Technical difficulties. Please enjoy this awkward pause."
      - "Error four oh four: words not found."
ears:
  fallback:
    min_interval_ms: 20000   # at most one fallback line per 20 s when many lines fail at once
brain:
  cortex:
    fallback_ack_chance: 0.25  # base chance stated to the model after a fallback line; a nudge, not an enforced rate
```

`ModuleSchema` (`schema.ts:15-28`) is the shared hook config for the three region hooks (five once the memory notes hooks land): `kind` (blank to `rules`; `rules|llm|http`), `url` (default `""`), `timeout_ms` 1500, and `llm{provider?, model?}` where both blank values mean "inherit" and a provider without a model is rejected via `superRefine` (`schema.ts:24-27`). The override provider enum is `ollama|openai|anthropic|bedrock`: `mock` cannot be named on a hook, though a hook that inherits reaches the mock provider when `llm.provider` is `mock` (CFG-SCH-009). The whole object `.default({})`s. Hook behaviour itself belongs to region-hooks.

Required-ness is uneven: `brain.*` regions and `llm.openai/claude/bedrock` default to `{}`, but the nine top-level sections themselves, plus `vision.obs`, `chat.twitch`, `avatar.vtube_studio`, `avatar.vmc` and `ears.discord`, are required objects with no `.default({})`, and `avatar.vtube_studio.host` and `avatar.vmc.host` are required fields (CFG-SCH-001, CFG-SCH-010); the two avatar ports default to 8001 and 39539 (CFG-ISO-005). A usable config therefore needs every section present (an empty `{}` suffices for `brain`, `voice`, `dashboard`), which the example provides.

Blank handling is also uneven. Enum keys added for isolation wrap `z.enum` in `z.preprocess((v) => v || default, ...)` (`schema.ts`), including `avatar.driver` (blank means `null`; a non-empty unknown value still fails, CFG-ISO-005), but `llm.claude.effort` does not, so an empty substitution fails it. Plain `z.string()` keys accept `""` silently (for example `ears.stt_model`, `avatar.vtube_studio.plugin_developer`, `llm.openai.api_key`); only `.min(1)` keys (`llm.model`, `embed_model`, `vision.model`, names) turn a missing variable into a validation error.

## Environment variables

Three tiers, none of which is validated by `ConfigSchema`.

**Placeholders in `config/config.example.yaml`** (flow through `substituteEnv`; the example line is in parentheses). With a `:-default` the variable is optional; without, an empty value reaches the schema as `""` or null (which the schema default or a `.min(1)` check then handles).

| Variable | Key | Default in example |
| --- | --- | --- |
| `LLM_PROVIDER` (:20) | `llm.provider` | `ollama` |
| `LLM_MODEL` (:21), `EMBED_MODEL` (:27) | `llm.model`, `llm.embed_model` | `qwen2.5:7b-instruct-q4_K_M`, `nomic-embed-text` (the `.env.example` values) |
| `LLM_API_KEY` (:30), `ANTHROPIC_API_KEY` (:32) | `llm.openai.api_key`, `llm.claude.api_key` | none |
| `VISION_ENABLED` (:40), `VISION_MODEL` (:41) | `vision.enabled`, `vision.model` | `false`; `qwen2.5vl:3b` |
| `OBS_HOST/PORT/PASSWORD/SOURCE` (:47-50) | `vision.obs.*` | none (port null falls to 4455) |
| `CHAT_SOURCE` (:54), `TWITCH_CHANNEL` (:58, :149) | `chat.source`, `chat.twitch.channel`, `avatar.vtube_studio.plugin_developer` | `twitch`; none |
| `MEMORY_STORE` (:116), `MEMORY_EMBEDDER` (:117) | `brain.memory.*` | `postgres`, `ollama` |
| `VOICE_ENGINE` (:135) | `voice.engine` | `kokoro` |
| `AVATAR_DRIVER` (:141), `VTS_HOST/PORT` (:146-147), `VMC_HOST/PORT` (:151-152) | `avatar.*` | `${AVATAR_DRIVER:-null}`; host none; a null port falls to the schema default 8001 / 39539 (CFG-ISO-005) |
| `EARS_SOURCE` (:155), `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` (:157-158), `STT_MODEL` (:161) | `ears.source`, `ears.discord.*`, `ears.stt_model` | `discord`; none; none |

**Read directly from `process.env` / `env()`** (not config keys): `CONFIG_DIR` (`index.ts:25`), `COHOST_DATA_DIR` (`dataDir()`, CFG-DIR-006), `LOG_LEVEL` (`index.ts:180`), `REDIS_URL`, `DATABASE_URL`, `OLLAMA_URL`, `TTS_URL`, `STT_URL`, `VOICE_URL`, `VOICE_PORT`, `DASHBOARD_URL` (all via `urls.*`, `index.ts:166-176`; Compose overrides the first six and `DASHBOARD_URL` with in-network hostnames, `docker-compose.yml:13-20`); `PORT` (dashboard), `VOICE_PORT` (voice server, `services/voice/src/index.ts:21`); `TWITCH_CLIENT_ID/SECRET/ACCESS_TOKEN/REFRESH_TOKEN` (`services/chat/src/index.ts:67`); `DISCORD_TOKEN` (`services/ears/src/index.ts:24`) (ears reads the guild and voice channel from `ears.discord.*`, EARS-SESS-007); `ANTHROPIC_API_KEY` and the `AWS_*` chain through the Anthropic/Bedrock SDKs (`packages/llm`).

**Env-only control and ops settings** (deliberately not in YAML): `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_BIND`, `CONTROL_ADVANCED` (`packages/control/src/config.ts:27-38`, owned by control-plane); `HEARTBEAT_INTERVAL_MS` (`packages/bus/src/heartbeat.ts:49-52`, default 5000; env-only with no config key per commit `691b079`) and `COHOST_VERSION` (`heartbeat.ts:75`); `INJECT_MAX_IMAGE_BYTES`, `INJECT_MAX_AUDIO_BYTES`, `INJECT_TTL_MS` (`services/dashboard/src/uploads.ts:33-35`). `.env.example` lists `HEARTBEAT_INTERVAL_MS` (commented, line 54) but none of `CONTROL_*`, the isolation presets, or `INJECT_*`; README.md documents `CONTROL_*` and the presets. Compose-level variables (`COMPOSE_FILE`, `DASHBOARD_PORT`, `KOKORO_IMAGE`, `SPEACHES_IMAGE`, and `LLM_MODEL` / `VISION_MODEL` / `EMBED_MODEL` for the `models` container) belong to deployment.

## Service URLs and logger

`urls` is an object of functions, each calling `envOr` at call time so tests and late-loaded `.env` values take effect (`index.ts:166-176`). `urls.voice()` defaults to loopback built from `VOICE_PORT` and `urls.dashboard()` to `http://127.0.0.1:3000`, so host-run (`pnpm dev`) services work outside Compose, where `docker-compose.yml:18-19` sets `VOICE_URL` and `DASHBOARD_URL` to in-network hostnames. `createLogger(service)` returns `pino({ name, level: LOG_LEVEL || "info" })` and `Logger` is its type (`index.ts:179-182`); packages' tests cast fake loggers to `never`.

## Tests

`packages/config/test/config.test.ts` (453 lines) carries an `@spec` annotation on every test; the arrow doc's Spec Coverage table is generated from them. The file covers: substitution forms (`:10`), seeding (`:21`), reflex regex validation (`:37`), hook provider/model rule (`:44`), `unknownKeys` (`:52`), shipped examples loading clean and mapping every emotion (`:90,107`), env substitution/null defaults/caching (`:119`), invalid-config message and `.env` hint (`:134-149`), unknown-key warning (`:152`), `loadDotEnv` (`:160`), personality round trip (`:175`), `env`/`envOr`/`urls.redis` (`:183`), `configDir` workspace walk (`:198`), `urls.voice` and `urls.dashboard` (`:224,250`), memory store enum (`:241`), the isolation presets (`:276-315`), the shipped example loading with no `.env` (`:334,347`), inline `.env` comments (`:353`), unknown keys inside arrays (`:369,376`), the `ConfigSchema` env-only boundary (`:386`), the hook `mock` rejection (`:401`) and the new timeout/arousal keys (`:410-446`).

Not covered by any test: lower-case placeholder names (CFG-ENV-003), the `llm` defaults and blank `llm.provider` (CFG-SCH-002), blank-to-default for every backend key (CFG-ISO-002), the `Emotion` list and `ExpressionMapSchema` itself (CFG-SCH-007), the remaining section defaults, nested required objects (CFG-SCH-008, CFG-SCH-010), `createLogger` (CFG-URL-004), `urls.database/ollama/tts/stt`, `loadExpressions` on an empty or invalid file, and the `/.dockerenv` branch of `missingDotEnv`. Several annotated tests cover only part of their spec line; the arrow doc lists them.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Config format | YAML file with `${VAR}` / `${VAR:-default}` text substitution before parsing | env vars only; JSON; schema-aware per-key env overrides | Secrets and per-machine values stay in `.env`, everything behavioural in YAML: header comments `config/config.example.yaml:1-4` and `.env.example:1-2`. Substitution is a plain regex over the file text before YAML parsing (`index.ts:34-40`), so it works the same for every key with no schema knowledge, and the YAML itself shows which values come from the environment. Per-key env overrides would need a naming scheme mapped onto the schema tree and would hide the env dependency from a reader of `config.yaml`. |
| `:-default` form | Literal default kept in `config.yaml`, overridable from `.env` | only `${VAR}` | Doc comment `index.ts:27-32`: "lets config.yaml hold the normal value literally while still allowing a per-machine override"; used by every isolation preset (`config.example.yaml:20,40,54,116,117,135,155`; commit `51d5a9c`). |
| Blank enum values | `z.preprocess((v) => v \|\| default, z.enum(...))` | `.default()` only; `.catch()` | The shipped example quotes its enum placeholders (`source: "${CHAT_SOURCE:-twitch}"`), and a quoted placeholder whose variable is unset or empty (with no `:-` default, or with an empty one) substitutes to `""`, not to null, so the null-dropping step does not remove it and `.default()` would not apply. The preprocess maps the blank string to the default before the enum check; blank values map to the default (CFG-ISO-002), while `.catch()` would also swallow a genuine typo, which must fail the load (see `Unknown avatar.driver value` below). Pattern at `schema.ts:16,45,96,156,158,173,180,194`. |
| Null handling | Drop all null keys at any depth before validation | per-key coercion; treat empty as error | Comment `index.ts:44`: "YAML like `port: ${OBS_PORT}` becomes `port: ` (null) when the var is unset. Leave it to defaults."; test `config.test.ts:119`. |
| Unknown keys | Warn once, load anyway | fail validation (`.strict()`) | Comment `index.ts:84` names the purpose: catch "typos, or settings from before the region split"; the region split (commit `969f6d7`) moved `brain.*` keys, so existing configs keep loading. Test `config.test.ts:152`. |
| First-run files | Services copy the example if the real file is missing, in addition to `install.sh` | installer-only seeding | Comment `index.ts:121-125`: the real files are the user's and git-ignored, the committed examples seed them on first run, and `install.sh` "does the same copy". |
| Config dir | Env override, else nearest `pnpm-workspace.yaml` ancestor, else cwd | cwd only | Commit `2cf3a93` (fixes #8): pnpm runs scripts in the package dir, so the walk finds `<root>/config`; `CONFIG_DIR` still wins and cwd remains the fallback when no workspace file exists (Docker images). Comment `index.ts:9-12`; test `config.test.ts:198`. |
| `.env` loading in code | `loadDotEnv` for the dev loop, never overriding real env | rely on Compose / shell only; a dotenv library | Comment `index.ts:59-63`: a dev convenience that loads `.env` next to the config dir without overriding anything already set, because Compose injects env itself. The parser is hand-written rather than a dotenv library: it keeps `@cohost/config` dependencies to pino, yaml and zod (`package.json:11-15`), and it must read `.env` the way Compose's `env_file` does (inline comments, CFG-ENV-006), which a general-purpose library would not guarantee. |
| Caching | Module-level cache with `force` escape hatch | reload on each call; file watcher | Every module of a service calls `loadConfig()`; the cache gives them one parse, one object and one unknown-key warning per process (`index.ts:57,104-123`). Config is read at start only: changing `config.yaml` takes a service restart, and no file watcher exists. `force` exists for tests that rewrite the file or env between loads (`config.test.ts:123-129`). |
| Backend selection | Enum keys in YAML plus preset env vars with live defaults | separate "mock mode" flag; separate config files | Commit `51d5a9c` (`add-isolated-backends`): env flips via `${VAR:-default}` in `config.example.yaml`, and mock is never the default (also comment `schema.ts:44`); OpenSpec `config § Isolation preset variables`; tests `config.test.ts:276-301`. |
| `Emotion` enum home | Defined in `@cohost/config`, imported by bus | define in bus | Config validates emotions itself (reflex `emotion`, the expression map), and `@cohost/bus` already depends on `@cohost/config` (`urls`, `Logger`), so the enum lives at the bottom of the dependency graph: `schema.ts:4-8`, imported by `packages/bus/src/events.ts:3`. Defining it in bus would make config depend on bus and create a cycle. |
| Service control settings | Env-only (`CONTROL_*`, `HEARTBEAT_INTERVAL_MS`), no YAML keys | YAML section | Commit `691b079` review note: the heartbeat interval is env-only with no config key. `CONTROL_TOKEN` is a secret and the other `CONTROL_*` values (enable flag, bind address, runtime, process mode, advanced flag) are per-machine deployment settings; `.env.example:1-2` puts both kinds in `.env`, not in the behavioural YAML. `packages/control/src/config.ts:34-46` reads them from env directly. |
| Config with no `.env` | The shipped example loads with every variable unset: the three model placeholders carry the `.env.example` values as `:-` defaults, blank `avatar.driver` means `null`, avatar ports have schema defaults (CFG-ISO-005) | `.env` mandatory, with the `.env` hint as the only guidance | Owner decision 2026-11-01: every service loads the whole config, so one missing avatar variable stopped all of them. |
| Unknown `avatar.driver` value | Fails validation at load (fail fast) | Fall back to `null` at driver creation | Owner decision 2026-11-01: a typo should be reported at once, not hidden behind a silently idle avatar; the driver factory's fallback is dead code (avatar segment). |
| Inline `.env` comments | `loadDotEnv` strips an unquoted ` # ...` suffix, as Compose does (CFG-ENV-006) | Fix only `.env.example`; reject inline comments | Owner decision 2026-11-01: the dev loop and Compose must read the same `.env` the same way. |
| `ears.discord.guild_id` / `voice_channel_id` | Keep the keys; ears reads them (CFG-USR-005, EARS-SESS-007) | Delete the keys and read only `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` | Owner decision 2026-11-01: behaviour is configured in `config.yaml`; the env variables still reach the keys through the example's placeholders. |
| Unknown keys inside arrays | The warning descends into array entries and carries no migration advice (CFG-LOAD-006) | Leave arrays unchecked | Owner decision 2026-11-01: a typo inside a reflex entry is the most likely silent mistake. |
| Hook `llm.provider: mock` | Rejected on a hook; a hook reaches mock only by inheriting (CFG-SCH-009) | Accept `mock` as an explicit hook override | Owner decision 2026-11-01: mock is an isolation mode for the whole process, not a per-hook choice (commit `51d5a9c`). |
| Env-only boundary (CFG-ENV-008) | Kept as a config spec, pinned by a test that `ConfigSchema.shape` has no control key (`config.test.ts:386`) | Drop the line | Owner decision 2026-11-01: the boundary is part of config's contract even though no single function implements it. |
| Viewer-notes settings | Behaviour keys under `brain.memory.regular_messages` and `brain.memory.notes.*`; the two model hooks reuse `ModuleSchema` | env variables; a new top-level `notes` section; a bespoke model block | Owner decision: every number is tunable. They are behaviour, so they live in YAML (HLD tenet 7); memory reads them, so they sit under `brain.memory`; `ModuleSchema` already gives a hook its own provider, model, timeout and rules fallback. Key names and non-owner defaults are. CFG-SCH-014 to CFG-SCH-016 |
| Spoken fallback line settings | The phrase list under `voice.fallback.lines` (read by voice, which generates the clips); the storm interval under `ears.fallback.min_interval_ms` (read by ears, which plays them); the acknowledgement chance under `brain.cortex.fallback_ack_chance` (read by cortex) | One `fallback` section shared by all three; env variables | Each key sits under the service that reads it, as every other key does, so a service's section is all it needs. The list and the chance are behaviour, so they live in YAML (HLD tenet 7). The chance and its 0.25 default are the owner's decision; the key names, and the 200-character phrase cap are; the 20000 ms interval is the owner's. CFG-SCH-017 to CFG-SCH-019 |
| Per-service data directory | `COHOST_DATA_DIR`, defaulting to `data` under the workspace root, resolved like `configDir()`, one subdirectory per service | A YAML key; a fixed `/app/...` path; a directory shared by voice and ears | A filesystem path is a per-machine value (tenet 7). Resolving against the workspace root works in Compose and on the host with no setting. One subdirectory per service keeps files owned by one service, as tenet 1 requires; the clips reach ears over HTTP. CFG-DIR-006, CFG-DIR-007 |
| `VIEWERS_TOKEN` | Env-only secret read by the dashboard, no schema key | YAML key | A secret never goes in `config.yaml` (HLD tenet 7); same pattern as `CONTROL_TOKEN`. CFG-ENV-009 |
| URL helpers | Functions that read env on every call | constants evaluated at import | `loadDotEnv` fills `process.env` during `loadConfig()`, after modules have been imported, so a URL captured as a constant at import time would miss a `.env` value in the dev loop; reading on every call always sees the current environment (`index.ts:171-181`). Tests rely on the same property when they change env between calls (`config.test.ts:189-194,224-238`). |

## Open Questions & Future Decisions

### Resolved by observation

1. Where the VTube Studio token lives: avatar passes `stateDir: configDir()` (`services/avatar/src/index.ts:30`), so `config/.vts-token`, matching README.md:216. The file is git-ignored with the other user-owned files (`.gitignore`, deployment).
2. OpenSpec divergence. The frozen OpenSpec `config` baseline says files are read from `CONFIG_DIR` "(default `./config`)", lists only five URLs, and has no requirement for `findWorkspaceRoot`, the `.env` hint or personality load/save. CFG-DIR-002, CFG-URL-002, CFG-URL-003, CFG-LOAD-004 and CFG-USR-001 describe the code and supersede it (`CLAUDE.md` § Specs: the LID spec wins).

### Observed, unexplained, or debt

1. **Silent empties in plain string keys.** `ears.stt_model: "${STT_MODEL}"` becomes `""` if unset (the `"Systran/faster-whisper-small"` default only applies to a missing key, `schema.ts:188`); same for `plugin_developer` (`config.example.yaml:149`) and `openai.api_key`.
2. **Partially dead keys.** `voice.sample_rate` is read only by `stubSynth` (`services/voice/src/voice.ts:41-55`); the Kokoro path does not consult it (grep of `services/*/src`). `dashboard.port` is overridden by `PORT` and Compose publishes a fixed container port 3000 (`docker-compose.yml:143`), so editing the key alone breaks the published port.
3. **`vision.model` is required even when `vision.enabled` is false** (`schema.ts:76`); `.env.example` supplies `VISION_MODEL` so the issue is latent.
4. **`.env` path assumption.** `<configDir>/../.env` (`index.ts:64`) is only correct when `config/` is a direct child of the project root; a custom `CONFIG_DIR` elsewhere silently changes where `.env` is looked for. `missingDotEnv` also treats any container as exempt via `/.dockerenv` (`index.ts:67`), which makes test `config.test.ts:140-143` environment-dependent: it would fail when run inside a container.
5. **`loadExpressions` error shape** differs from `loadConfig` (raw `ZodError`, `index.ts:140`); `savePersonality` is a non-atomic overwrite (`index.ts:151`); whether `loadPersonality` / `loadExpressions` are uncached by design is unknown.
6. **Diagnostics via `console.warn`** (`index.ts:112,133`) rather than the pino logger from the same file; they carry no service name or structure.
7. **Duplicate type name.** `ModuleConfig` is exported here (`schema.ts:29`) and re-declared with a different derivation in `packages/modules/src/index.ts:19` (region-hooks).
8. **Test hygiene.** `sandbox()` sets `process.env.CONFIG_DIR` and never restores it (`config.test.ts:67`); one test replaces `process.env` wholesale (`:102`); a second import statement appears mid-file (`:34`); the reflex test reaches into zod internals via `removeDefault()` (`:38`); `config.test.ts` depends on repo-root files (`config/config.example.yaml`, `.env.example`, `config/expressions.example.yaml`).
9. **`.env.example` incompleteness.** The isolation presets, `CONTROL_*` and `INJECT_*` appear only in README.md and OpenSpec; `AWS_PROFILE` is mentioned only in a comment (`.env.example:20`) and in `examples/providers/README.md:86` (compose mounts no `~/.aws`; deployment). `STT_MODEL` sits under a heading "Ollama models (pulled by the `models` service)" (`.env.example:9-15`) although it is neither an Ollama model nor pulled (deployment).
10. **Specs realized by files outside `packages/config`.** CFG-ISO-004, CFG-USR-003, CFG-USR-004 and CFG-USR-006 are properties of `config/config.example.yaml`, `.env.example` and `config/expressions.example.yaml`. Their tests carry `@spec` annotations; the example files carry none.

## References

**Files in this segment**
- `packages/config/src/index.ts`, `packages/config/src/schema.ts`, `packages/config/test/config.test.ts`, `packages/config/package.json`, `packages/config/tsconfig.json`
- `config/config.example.yaml`, `config/expressions.example.yaml`, `config/personality.example.md`, `.env.example`

**Other segments (direction)**
- Depended on by every segment (config is the dependency root). `event-bus` imports `Emotion` from `schema.ts`; `region-hooks` and `model-backends` consume `ModuleSchema` / `llm.*`; `control-plane` reads `CONTROL_*` and `HEARTBEAT_INTERVAL_MS` itself (env-only, outside this schema); `voice`, `chat`, `memory`, `ears`, `eyes`, `avatar`, `dashboard` read their sections; `deployment` owns Compose-level variables and `install.sh` seeding.
- Depends on: none within the workspace.

**External libraries**: `zod` (schemas), `yaml` (parser), `pino` (logger). Node `fs`, `path`.

**OpenSpec** (frozen, historical)
- `openspec/specs/config/spec.md` (9 requirements, including the archived `add-isolated-backends` delta)
- `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/config/spec.md` (MODIFIED "Schema validation and defaults", ADDED "Isolation preset variables")

**Docs**: README.md "Configuration" section (lines 73-149), `docs/TESTING.md` section 1 (known problems 1-3 there are resolved by this package's workspace walk, `.env` hint and `urls.voice`).
