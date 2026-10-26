## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Isolation preset variables
`config/config.example.yaml` SHALL reference one env variable per isolatable backend using `${VAR:-default}` with the current literal as default: `LLM_PROVIDER` (`llm.provider`), `MEMORY_STORE` and `MEMORY_EMBEDDER` (`brain.memory.*`), `VOICE_ENGINE` (`voice.engine`), `CHAT_SOURCE` (`chat.source`), `VISION_ENABLED` (`vision.enabled`), `EARS_SOURCE` (`ears.source`), alongside the existing `AVATAR_DRIVER`. With none of these set, loaded values MUST equal today's defaults.

#### Scenario: Flip by env
- **WHEN** `LLM_PROVIDER=mock` is set and `loadConfig(true)` runs on the seeded example
- **THEN** `llm.provider` is `mock` without editing `config.yaml`

#### Scenario: Unset env
- **WHEN** no preset variable is set
- **THEN** `llm.provider` is `ollama`, `voice.engine` is `kokoro`, `vision.enabled` is false
