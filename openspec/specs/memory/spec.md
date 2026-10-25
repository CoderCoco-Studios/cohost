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
The system SHALL store via `MemoryStore.remember(kind, who, text)` an embedding of `"<who>: <text>"` in table `memories` (kinds `chat`, `speech`, `self`, `note`): chat only when `mentionsCohost` is true, every `speech.heard` (who = speaker), and `brain.say` text of length >= 2 (who = `cfg.cohost.name`, kind `self`).

#### Scenario: Unaddressed chat
- **WHEN** a chat message does not mention the co-host
- **THEN** it is not stored as a memory, though the viewer row is touched

#### Scenario: Short self line
- **WHEN** `brain.say` text is 1 character
- **THEN** nothing is remembered

#### Scenario: Write failure
- **WHEN** embedding or INSERT throws
- **THEN** a warning is logged and the error is not propagated

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
The system SHALL on `init` probe embedding dimension, create the `vector` extension, tables `memories`, `viewers`, `meta`, and an hnsw cosine index (failure to create the index is only a warning). Startup SHALL wait for Ollama embeddings and retry Postgres init every 3 s, giving up after 20 failed attempts.

#### Scenario: Postgres not ready
- **WHEN** `init` throws on attempt 21
- **THEN** the process fails fatally

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
