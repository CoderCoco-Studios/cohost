## MODIFIED Requirements

### Requirement: Schema initialization and startup
The system SHALL, with `brain.memory.store` `postgres` (default), on `init` probe embedding dimension, create the `vector` extension, tables `memories`, `viewers`, `meta`, and an hnsw cosine index (failure to create the index is only a warning). Startup SHALL wait for Ollama embeddings only when `brain.memory.embedder` is `ollama`, and retry Postgres init every 3 s, giving up after 20 failed attempts, only when the store is `postgres`.

#### Scenario: Postgres not ready
- **WHEN** `init` throws on attempt 21
- **THEN** the process fails fatally

#### Scenario: Redis-only start
- **WHEN** `store` is `memory` and `embedder` is `hash`
- **THEN** the region subscribes and answers immediately with no Ollama ping and no Postgres connection

## ADDED Requirements

### Requirement: In-memory store
With `brain.memory.store: memory` (the in-process fake from `services/memory/src/fake-store.ts`, landed on main) the region SHALL keep memories and viewers in process, with the same bus behavior as the Postgres store (storing rules, viewer announcement, recall ranking by cosine similarity over its own bag-of-words hashed vectors, 2-minute exclusion, `min_similarity` filter, `k` handling). It MUST lose data on exit, MUST NOT contact Ollama or Postgres regardless of `embedder`, and SHALL treat reflection as a logged no-op.

#### Scenario: Recall round trip
- **WHEN** a `chat.message` addressing the co-host is stored and, over 2 minutes later, a `memory.recall.request` with similar text arrives
- **THEN** `memory.recall.reply` contains it

### Requirement: Hash embedder selection
With `brain.memory.embedder: hash` the region SHALL embed with the deterministic hash embedder of the `llm` capability and MUST NOT contact Ollama. The default `ollama` embedder behavior is unchanged.

#### Scenario: No Ollama traffic
- **WHEN** `embedder` is `hash`
- **THEN** no request is made to the Ollama URL

### Requirement: Isolation preset and mode
Setting `MEMORY_STORE=memory` and `MEMORY_EMBEDDER=hash` SHALL make the memory region runnable with only Redis. Its heartbeat `mode` (change `add-service-health`) MUST be `mock` when either is non-default and `live` otherwise.

#### Scenario: Mode
- **WHEN** the store is `memory`
- **THEN** the reported mode is `mock`
