## MODIFIED Requirements

### Requirement: Provider factory
`createChatProvider(cfg.llm)` SHALL return an `Ollama`, `OpenAICompatible`, `AnthropicProvider`, `BedrockProvider` or `MockProvider` according to `provider` (`ollama`, `openai`, `anthropic`, `bedrock`, `mock`), each exposing `name`, `model`, `chat`, `ping` and `lastError`. `mock` MUST NOT be selected unless configured explicitly.

#### Scenario: Provider selection
- **WHEN** `provider` is `openai`
- **THEN** the returned provider has `name` "openai"

#### Scenario: Mock selection
- **WHEN** `provider` is `mock`
- **THEN** the returned provider has `name` "mock" and no network access is attempted

### Requirement: Embeddings are always Ollama
`createEmbedder` SHALL return an Ollama client using `embed_model` regardless of chat provider, EXCEPT that when `llm.provider` is `mock` it SHALL return the deterministic hash embedder; `embed` on the Ollama client POSTs `/api/embed` and MUST throw on non-OK status or when no vector is returned.

#### Scenario: Missing vector
- **WHEN** Ollama returns no embeddings
- **THEN** `embed` throws "ollama embed returned no vector"

#### Scenario: Mock embedder
- **WHEN** `llm.provider` is `mock`
- **THEN** `createEmbedder` returns the hash embedder and Ollama is never contacted

## ADDED Requirements

### Requirement: Mock provider
The `mock` provider SHALL be deterministic and offline: `chat` returns the same reply for the same messages (a short echo-style line derived from the last user message, using the reply format the cortex parses, including an emotion tag), `ping` returns true with no `lastError`, and `json: true` calls return valid JSON. It MUST ignore `signal`-independent latency (no sleeps beyond zero) and honor an already-aborted `signal` by throwing.

#### Scenario: Determinism
- **WHEN** `chat` is called twice with identical messages
- **THEN** both replies are identical and non-empty

#### Scenario: Ping
- **WHEN** `ping` is called
- **THEN** it returns true

#### Scenario: JSON mode
- **WHEN** `chat` is called with `json: true`
- **THEN** the reply parses as JSON

### Requirement: Hash embedder
The hash embedder SHALL map text to a fixed-length (64) unit vector deterministically from its tokens, so identical text yields identical vectors, texts sharing tokens have higher cosine similarity than unrelated texts, and empty text yields a valid non-throwing vector.

#### Scenario: Similarity ordering
- **WHEN** embedding "dog park walk", "walk the dog", and "quantum physics"
- **THEN** the first two are more similar to each other than either is to the third

### Requirement: Mock is reported, not hidden
Services using the mock provider SHALL log a warning at startup naming it, and their heartbeat `mode` (defined by change `add-service-health`) MUST be `mock`.

#### Scenario: Startup warning
- **WHEN** a service starts with `llm.provider: mock`
- **THEN** a warn-level log states the mock backend is active
