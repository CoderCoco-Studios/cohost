# config Specification

## Purpose
`@cohost/config` loads and validates `config/config.yaml`, expands environment variables, seeds user files from examples, and exposes service URLs and a logger.

## Requirements

### Requirement: Config directory and seeding
The system SHALL read files from `CONFIG_DIR` (default `./config`) and, when `config.yaml`, `expressions.yaml` or `personality.md` is missing, SHALL copy it from the matching `*.example.*` file and warn; if neither exists it MUST throw.

#### Scenario: First run
- **WHEN** `config.yaml` is absent and `config.example.yaml` exists
- **THEN** the example is copied to `config.yaml` and loaded

#### Scenario: Nothing to seed from
- **WHEN** neither the file nor its example exists
- **THEN** an error naming both paths is thrown

### Requirement: Environment substitution
The system SHALL replace `${VAR}` in the YAML text with `process.env.VAR` (empty string if unset) and `${VAR:-default}` with the default when VAR is unset or empty.

#### Scenario: Default used
- **WHEN** `OBS_PORT` is unset and the file contains `${OBS_PORT:-4455}`
- **THEN** the value becomes `4455`

### Requirement: Dotenv loading
The system SHALL load `.env` from the parent of the config dir without overriding variables already set, supporting `KEY=value`, quoted values and `#` comments.

#### Scenario: Existing env wins
- **WHEN** `FOO` is already set and `.env` defines `FOO`
- **THEN** the existing value is kept

### Requirement: Schema validation and defaults
The system SHALL validate the config with `ConfigSchema`, treat null values (from empty substitutions) as absent so defaults apply, and throw `Invalid <file>` listing each issue as `path: message`. Defaults include `llm.provider` ollama (enum `ollama|openai|anthropic|bedrock|mock`), `llm.num_ctx` 8192, `llm.temperature` 0.9, `llm.max_tokens` 120, `brain.working_memory_events` 24, `salience.speak_threshold` 0.6, `voice.engine` kokoro (enum `kokoro|stub`), `voice.voice` af_heart, `brain.memory.store` postgres (enum `postgres|memory`), `brain.memory.embedder` ollama (enum `ollama|hash`), `chat.source` twitch (enum `twitch|fake`), `chat.fake.interval_ms` 8000, `ears.source` discord (enum `discord|off`), `dashboard.port` 3000.

#### Scenario: Invalid value
- **WHEN** `llm.temperature` is above 2
- **THEN** `loadConfig` throws listing `llm.temperature`

#### Scenario: Empty provider
- **WHEN** `llm.provider` is empty
- **THEN** it is treated as `ollama`

#### Scenario: New keys default to live backends
- **WHEN** a config omits `voice.engine`, `brain.memory.store`, `brain.memory.embedder`, `chat.source` and `ears.source`
- **THEN** they resolve to `kokoro`, `postgres`, `ollama`, `twitch` and `discord`

#### Scenario: Invalid source
- **WHEN** `chat.source` is `irc`
- **THEN** `loadConfig` throws listing `chat.source`

### Requirement: Module config rules
The system SHALL accept `ModuleSchema` with `kind` of `rules` (default, also for empty), `llm` or `http`, `timeout_ms` default 1500, and SHALL reject `llm.provider` set without `llm.model`.

#### Scenario: Provider without model
- **WHEN** a hook sets `llm.provider: anthropic` and no `llm.model`
- **THEN** validation fails on `model`

### Requirement: Reflex validation
The system SHALL require each `brain.salience.reflexes[].match` to be a valid regular expression and `say` to be a non-empty list of non-empty strings.

#### Scenario: Bad regex
- **WHEN** a reflex has `match: "("`
- **THEN** validation fails with "not a valid regular expression"

### Requirement: Unknown key warning and caching
The system SHALL warn about keys not in the schema via `unknownKeys` without failing, and SHALL cache the loaded config until `loadConfig(true)`.

#### Scenario: Stray key
- **WHEN** the YAML has `brain.foo`
- **THEN** a warning lists `brain.foo` and loading succeeds

### Requirement: Env helpers and URLs
The system SHALL provide `env(name)` which throws on missing/empty, `envOr(name, fallback)`, and `urls` with defaults `REDIS_URL` redis://127.0.0.1:6379, `DATABASE_URL`, `OLLAMA_URL` http://127.0.0.1:11434, `TTS_URL` http://127.0.0.1:8880, `STT_URL` http://127.0.0.1:8000.

#### Scenario: Missing required var
- **WHEN** `env("X")` is called and X is unset
- **THEN** an error mentioning X and `.env` is thrown

### Requirement: Isolation preset variables
`config/config.example.yaml` SHALL reference one env variable per isolatable backend using `${VAR:-default}` with the current literal as default: `LLM_PROVIDER` (`llm.provider`), `MEMORY_STORE` and `MEMORY_EMBEDDER` (`brain.memory.*`), `VOICE_ENGINE` (`voice.engine`), `CHAT_SOURCE` (`chat.source`), `VISION_ENABLED` (`vision.enabled`), `EARS_SOURCE` (`ears.source`), alongside the existing `AVATAR_DRIVER`. With none of these set, loaded values MUST equal today's defaults.

#### Scenario: Flip by env
- **WHEN** `LLM_PROVIDER=mock` is set and `loadConfig(true)` runs on the seeded example
- **THEN** `llm.provider` is `mock` without editing `config.yaml`

#### Scenario: Unset env
- **WHEN** no preset variable is set
- **THEN** `llm.provider` is `ollama`, `voice.engine` is `kokoro`, `vision.enabled` is false
