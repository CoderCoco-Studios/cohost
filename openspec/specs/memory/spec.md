# memory Specification

## Purpose
The memory region is the only one that touches Postgres (pgvector). It stores embedded exchanges and viewer records, answers recall requests over the bus, and announces viewer familiarity. A `reflect` job consolidates memories into `personality.md`.

## Requirements

### Requirement: Event handling and consumer groups
The system SHALL subscribe with two consumer groups (`fromNow`): `memory` for `chat.message`, `speech.heard`, `brain.say`, and `memory-recall` for `memory.recall.request`, so recalls never queue behind writes.

#### Scenario: Separate groups
- **WHEN** a slow embed+INSERT is in progress in group `memory`
- **THEN** a `memory.recall.request` is still handled by group `memory-recall`

### Requirement: Storing memories
The system SHALL store via `MemoryStore.remember(kind, who, text)` an embedding of `"<who>: <text>"` in table `memories` (kinds `chat`, `speech`, `self`, `note`): chat only when `mentionsCohost` is true, every `speech.heard` (who = speaker), and `brain.say` text of length >= 2 (who = `cfg.cohost.name`, kind `self`). A `chat.message` or `speech.heard` with `injected: true` SHALL be stored only when `remember` is true; with `remember` false or absent it MUST NOT be stored. A `brain.say` with `injected: true` SHALL be stored as kind `self` only when `remember` is true. `remember` has no effect on events without `injected: true`.

#### Scenario: Unaddressed chat
- **WHEN** a chat message does not mention the co-host
- **THEN** it is not stored as a memory, though the viewer row is touched

#### Scenario: Short self line
- **WHEN** `brain.say` text is 1 character
- **THEN** nothing is remembered

#### Scenario: Write failure
- **WHEN** embedding or INSERT throws
- **THEN** a warning is logged and the error is not propagated

#### Scenario: Injected, not remembered
- **WHEN** a `speech.heard` with `injected: true` and `remember: false` arrives
- **THEN** nothing is stored

#### Scenario: Injected, remembered
- **WHEN** a `speech.heard` with `injected: true` and `remember: true` arrives
- **THEN** it is stored as kind `speech` as for a real event

#### Scenario: Reply to injected input
- **WHEN** a `brain.say` with `injected: true` and `remember` false or absent arrives
- **THEN** it is not stored as a `self` memory

#### Scenario: Remembered reply
- **WHEN** a `brain.say` with `injected: true` and `remember: true` arrives
- **THEN** it is stored as kind `self`

#### Scenario: Flag ignored on real events
- **WHEN** a `speech.heard` without `injected` carries `remember: false`
- **THEN** it is stored

### Requirement: Viewer tracking and announcement
The system SHALL upsert every chat message into `viewers` keyed by lowercased `userId ?? user`, incrementing `msg_count`, and for mentioning messages SHALL publish `memory.viewer` `{user,isNew,msgCount,notes}` before the embed; `isNew` is true when `msg_count <= 1`.

#### Scenario: First message
- **WHEN** an unseen viewer mentions the co-host
- **THEN** `memory.viewer` is published with `isNew` true and `msgCount` 1

#### Scenario: No mention
- **WHEN** a viewer chats without mentioning the co-host
- **THEN** no `memory.viewer` event is published

### Requirement: Recall
The system SHALL answer `memory.recall.request` `{id,query,k}` by publishing `memory.recall.reply` `{id, memories:[{ts(ms),kind,who,text,similarity}]}`, ranked by cosine distance, excluding rows newer than 2 minutes, filtering `similarity < brain.memory.min_similarity` (default 0.35). `k` defaults to `brain.memory.recall_k` (default 6).

#### Scenario: Zero k
- **WHEN** `k` is 0 or less
- **THEN** recall returns an empty list without querying

#### Scenario: Failure
- **WHEN** embedding or query fails
- **THEN** an empty list is returned and a warning logged

#### Scenario: Recent rows excluded
- **WHEN** a memory is under 2 minutes old
- **THEN** it is not returned

### Requirement: Schema initialization and startup
The system SHALL, with `brain.memory.store` `postgres` (default), on `init` probe embedding dimension, create the `vector` extension, tables `memories`, `viewers`, `meta`, and an hnsw cosine index (failure to create the index is only a warning). Startup SHALL wait for Ollama embeddings only when `brain.memory.embedder` is `ollama`, and retry Postgres init every 3 s, giving up after 20 failed attempts, only when the store is `postgres`.

#### Scenario: Postgres not ready
- **WHEN** `init` throws on attempt 21
- **THEN** the process fails fatally

#### Scenario: Redis-only start
- **WHEN** `store` is `memory` and `embedder` is `hash`
- **THEN** the region subscribes and answers immediately with no Ollama ping and no Postgres connection

### Requirement: Reflection
The `reflect` job SHALL read memories since meta `last_reflection` (up to 600), skip if fewer than 5, ask the chat LLM for 3-6 bullets, keep only lines beginning `- `, append them under a dated `### <YYYY-MM-DD>` block in the `## Learned` section of personality (adding the heading if absent), and set `last_reflection`.

#### Scenario: Too few memories
- **WHEN** fewer than 5 new memories exist
- **THEN** personality is unchanged

#### Scenario: No bullets
- **WHEN** the reply has no `- ` lines
- **THEN** a warning is logged and nothing is saved

#### Scenario: Preamble stripped
- **WHEN** the reply has prose before bullets
- **THEN** only the bullet lines are appended

### Requirement: Heartbeat
The memory service SHALL publish `service.heartbeat` with `service: "memory"` via `startHeartbeat`: `starting` at boot, `ready` once its Postgres schema is initialised, then every `intervalMs` (default 5000), and `stopping` on graceful shutdown. Its `deps` MUST be `{postgres, ollama}`. Each MUST be `ok` or `down` according to the last successful connection or embedding call.

#### Scenario: Ready
- **WHEN** memory has finished starting
- **THEN** a heartbeat with `service: "memory"`, `state: "ready"` and the deps above is published every 5 s

#### Scenario: Ollama down
- **WHEN** embeddings are unavailable
- **THEN** `deps.ollama` is `down`, `state` is `degraded` and the service keeps heartbeating (whether it waits or idles is governed by add-isolated-backends)

#### Scenario: Shutdown
- **WHEN** memory receives SIGTERM
- **THEN** it publishes one `stopping` heartbeat before exiting 0

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

### Requirement: Injected chat and viewers
A `chat.message` with `injected: true` and `remember` false or absent SHALL NOT touch the `viewers` table and SHALL NOT cause `memory.viewer` to be published. With `remember: true` it SHALL be handled exactly like a real message.

#### Scenario: Not remembered
- **WHEN** an injected mentioning `chat.message` with `remember: false` arrives
- **THEN** no viewer row is upserted, no `memory.viewer` is published and nothing is stored

#### Scenario: Remembered
- **WHEN** an injected mentioning `chat.message` with `remember: true` arrives
- **THEN** the viewer is upserted, `memory.viewer` is published and the message is stored
