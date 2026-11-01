# memory specs

## Event handling

- [x] **MEM-EVT-001**: The memory service shall consume the bus in two consumer groups that both start from new events only: group `memory` for `chat.message`, `speech.heard` and `brain.say`, and group `memory-recall` for `memory.recall.request`, so that a recall never queues behind a slow embed plus INSERT. <!-- openspec: memory § Event handling and consumer groups --> <!-- test: none (services/memory/src/index.ts:58-59 is untested) -->
- [x] **MEM-EVT-002**: When the memory handler receives an event type it does not act on (for example `affect.state`), the memory service shall do nothing and publish nothing. <!-- test: services/memory/test/region.test.ts:54 -->

## Storing memories

- [x] **MEM-WRITE-001**: When a `chat.message` arrives, the memory service shall remember it as kind `chat` (who = the message `user`) only if `mentionsCohost` is true, and shall store nothing for unaddressed chat. <!-- openspec: memory § Storing memories --> <!-- test: services/memory/test/region.test.ts:30 -->
- [x] **MEM-WRITE-002**: When a `speech.heard` arrives, the memory service shall remember it as kind `speech` with who = the `speaker`. <!-- openspec: memory § Storing memories --> <!-- test: services/memory/test/region.test.ts:38 -->
- [x] **MEM-WRITE-003**: When a `brain.say` arrives from any publisher, the memory service shall remember it as kind `self` (who = `cfg.cohost.name`) only if its text is two or more characters. <!-- openspec: memory § Storing memories --> <!-- test: services/memory/test/region.test.ts:38 -->
- [x] **MEM-WRITE-004**: When the Postgres store remembers a line, it shall embed the string `"<who>: <text>"` and insert `kind`, `who`, `text` and the embedding as a pgvector literal into table `memories`. <!-- openspec: memory § Storing memories --> <!-- test: services/memory/test/memory.test.ts:58 -->
- [x] **MEM-WRITE-005**: If embedding or INSERT throws while remembering, the Postgres store shall log a warning and not propagate the error. <!-- openspec: memory § Storing memories --> <!-- test: services/memory/test/memory.test.ts:66 -->

## Test injection

- [x] **MEM-INJ-001**: When a `chat.message`, `speech.heard` or `brain.say` arrives with `injected` true and `remember` not true, the memory service shall store no memory, touch no viewer row and publish no `memory.viewer`. <!-- openspec: memory § Storing memories; memory § Injected chat and viewers --> <!-- test: services/memory/test/region.test.ts:62 -->
- [x] **MEM-INJ-002**: When a `chat.message`, `speech.heard` or `brain.say` arrives with `injected` true and `remember` true, the memory service shall handle it exactly like a real event. <!-- openspec: memory § Injected chat and viewers --> <!-- test: services/memory/test/region.test.ts:73 -->
- [x] **MEM-INJ-003**: When an event without `injected` true carries `remember` false, the memory service shall ignore the `remember` flag and handle the event normally. <!-- openspec: memory § Storing memories (Flag ignored on real events) --> <!-- test: services/memory/test/region.test.ts:83 -->

## Viewers

- [x] **MEM-VIEWER-001**: When a `chat.message` is handled (mentioning the co-host or not), the memory service shall upsert the viewer row keyed by the lowercased `userId`, or the `user` name when no `userId` is present, incrementing `msg_count` and updating `display`. <!-- openspec: memory § Viewer tracking and announcement --> <!-- test: services/memory/test/region.test.ts:21, services/memory/test/memory.test.ts:101 -->
- [x] **MEM-VIEWER-002**: When a handled `chat.message` mentions the co-host, the memory service shall publish `memory.viewer` with `{user, isNew, msgCount, notes}` before it embeds and stores the message, and shall publish none when it does not mention the co-host. <!-- openspec: memory § Viewer tracking and announcement --> <!-- test: services/memory/test/region.test.ts:30 -->
- [x] **MEM-VIEWER-003**: The memory service shall report a viewer as new (`isNew` true) exactly when the viewer's `msg_count` after the upsert is 1 or less. <!-- openspec: memory § Viewer tracking and announcement --> <!-- test: services/memory/test/memory.test.ts:101 -->
- [x] **MEM-VIEWER-004**: The memory service shall return the stored `notes` text of the viewer row in `memory.viewer`, defaulting to the empty string. <!-- test: services/memory/test/region.test.ts:30 -->
- [ ] **MEM-VIEWER-005**: The memory service shall have a way for viewer `notes` to be written, so that the "Notes:" shown to the cortex for regular viewers can be non-empty. <!-- gap [inferred]: nothing in services/memory/src writes viewers.notes (store.ts:60, 103-110; fake-store.ts:26,51-54); the intended writer (hand-edited SQL, reflection, dashboard) is unknown -->

## Recall

- [x] **MEM-RECALL-001**: When a `memory.recall.request` arrives, the memory service shall publish `memory.recall.reply` carrying the same `id` and the recalled memories as `{ts (epoch ms), kind, who, text, similarity}`; an empty list is a valid answer. <!-- openspec: memory § Recall --> <!-- test: services/memory/test/region.test.ts:46 -->
- [x] **MEM-RECALL-002**: Where a `memory.recall.request` omits `k`, the memory service shall use `brain.memory.recall_k` (default 6). <!-- openspec: memory § Recall --> <!-- test: services/memory/test/memory.test.ts:76 -->
- [x] **MEM-RECALL-003**: When the Postgres store recalls, it shall embed the query and return up to `k` rows ordered by cosine distance, excluding rows whose `ts` is within the last 2 minutes. <!-- openspec: memory § Recall --> <!-- test: services/memory/test/memory.test.ts:76 -->
- [x] **MEM-RECALL-004**: When recalling, the memory service shall drop any result whose similarity is below `brain.memory.min_similarity` (default 0.35), keeping results equal to it. <!-- openspec: memory § Recall --> <!-- test: services/memory/test/memory.test.ts:76 -->
- [x] **MEM-RECALL-005**: If `k` is 0 or less, the memory store shall return an empty list without embedding or querying. <!-- openspec: memory § Recall --> <!-- test: services/memory/test/memory.test.ts:92 -->
- [x] **MEM-RECALL-006**: If embedding or the recall query fails, the Postgres store shall log a warning and return an empty list, so the memory service still publishes a `memory.recall.reply`. <!-- openspec: memory § Recall --> <!-- test: services/memory/test/memory.test.ts:92 -->

## Stores and schema

- [x] **MEM-STORE-001**: When the Postgres store initialises, it shall probe the embedding dimension, create extension `vector`, create tables `memories` (with `embedding vector(dims)`), `viewers` and `meta`, and create an hnsw cosine index, treating failure to create the index as a warning only. <!-- openspec: memory § Schema initialization and startup --> <!-- test: services/memory/test/memory.test.ts:48 -->
- [ ] **MEM-STORE-002**: When the Postgres store initialises against an existing `memories` table, it shall detect a mismatch between the table's vector dimension and the configured embedder's dimension and fail loudly instead of silently dropping every later write and recall. <!-- gap [inferred]: store.ts:45-53 uses CREATE TABLE IF NOT EXISTS with no check, remember/recall swallow the resulting errors (store.ts:78-80, 96-99); intent from packages/config/src/schema.ts:36-37 ("the memory table's vector size never changes") -->
- [x] **MEM-STORE-003**: The Postgres store shall keep key/value metadata in table `meta` with upsert semantics, and shall list memories newer than a timestamp oldest-first with a default limit of 400. <!-- openspec: memory § Reflection (last_reflection meta) --> <!-- test: services/memory/test/memory.test.ts:111 -->

## Backend selection

- [x] **MEM-BACKEND-001**: Where `brain.memory.store` is `memory`, the memory service shall use the in-process `InMemoryStore`, shall not open a Postgres connection, and shall not use the supplied embedder. <!-- openspec: memory § In-memory store --> <!-- test: services/memory/test/backend.test.ts:11 -->
- [x] **MEM-BACKEND-002**: Where `brain.memory.store` is `postgres` (the default), the memory service shall use the Postgres `MemoryStore`. <!-- openspec: memory § Schema initialization and startup --> <!-- test: none -->
- [x] **MEM-BACKEND-003**: Where `brain.memory.embedder` is `hash`, the memory service shall embed with `@cohost/llm`'s `HashEmbedder` and make no network request; otherwise it shall use the Ollama client from `llm` config regardless of `llm.provider`. <!-- openspec: memory § Hash embedder selection --> <!-- test: services/memory/test/backend.test.ts:33 -->
- [x] **MEM-BACKEND-004**: While the in-memory store is active, recall shall rank by cosine similarity over its own hashed bag-of-words vectors, exclude entries newer than 2 minutes, drop results under `min_similarity` and return at most `k`. <!-- openspec: memory § In-memory store --> <!-- test: services/memory/test/fake-store.test.ts:20 -->
- [x] **MEM-BACKEND-005**: While the in-memory store is active, viewer tracking shall count per lowercased key, report `isNew` when the count is 1 or less, always return empty notes, and lose all data on process exit. <!-- openspec: memory § In-memory store --> <!-- test: services/memory/test/fake-store.test.ts:44 -->

## Startup and shutdown

- [x] **MEM-START-001**: Where the store is `postgres` and the embedder is `ollama`, the memory service shall ping Ollama every 3 seconds until it answers before initialising the store, marking `deps.ollama` down while it waits. <!-- openspec: memory § Schema initialization and startup --> <!-- test: none (index.ts:35-43 is untested) -->
- [x] **MEM-START-002**: Where the store is `postgres`, the memory service shall retry store initialisation every 3 seconds and exit fatally when the 21st attempt fails. <!-- openspec: memory § Schema initialization and startup --> <!-- test: none (index.ts:44-53 is untested) -->
- [x] **MEM-START-003**: Where the store is `memory`, the memory service shall initialise once with no Ollama ping, no Postgres connection and no retry loop. <!-- openspec: memory § Schema initialization and startup (Redis-only start) --> <!-- test: none -->
- [x] **MEM-START-004**: Where either `brain.memory.store` or `brain.memory.embedder` is non-default, the memory service shall log a warning that it runs in mode mock with non-durable data. <!-- openspec: memory § Isolation preset and mode --> <!-- test: none -->
- [x] **MEM-START-005**: When the memory service has finished starting, it shall subscribe both consumer groups and then report `ready` in its heartbeat. <!-- openspec: memory § Heartbeat --> <!-- test: none (index.ts:58-60 is untested) -->

## Health

- [x] **MEM-HEALTH-001**: The memory heartbeat shall report service `memory` with mode `live` only when the store is `postgres` and the embedder is `ollama`, and mode `mock` otherwise. <!-- openspec: memory § Isolation preset and mode --> <!-- test: services/memory/test/health.test.ts:39 -->
- [x] **MEM-HEALTH-002**: The memory heartbeat shall report `deps.postgres` as `n/a` unless the store is `postgres`, and `deps.ollama` as `n/a` unless the store is `postgres` and the embedder is `ollama`. <!-- openspec: memory § Heartbeat (deps), § Isolation preset and mode --> <!-- test: services/memory/test/health.test.ts:31 -->
- [x] **MEM-HEALTH-003**: While the Ollama embedder is tracked, a failed `embed` shall set `deps.ollama` to `down` (state `degraded` once ready) and the next successful `embed` shall restore it to `ok`. <!-- openspec: memory § Heartbeat (Ollama down) --> <!-- test: services/memory/test/health.test.ts:16 -->
- [x] **MEM-HEALTH-004**: When the Postgres store initialisation succeeds, the memory service shall set `deps.postgres` to `ok`. <!-- openspec: memory § Heartbeat --> <!-- test: services/memory/test/health.test.ts:6 -->
- [ ] **MEM-HEALTH-005**: While the Postgres store is in use, `deps.postgres` shall follow the outcome of the latest Postgres call, becoming `down` when queries fail after startup and `ok` again when they succeed. <!-- gap: health.ts:29 setPostgres has one caller, index.ts:46; OpenSpec add-service-health "ok or down according to the last successful connection or embedding call"; store.remember/recall swallow errors (store.ts:78-80, 96-99) -->

## Reflection

- [x] **MEM-REFLECT-001**: When `reflect` runs with `brain.memory.store` set to `memory`, it shall log a warning and exit without reading memories or changing personality. <!-- openspec: memory § In-memory store (reflection is a logged no-op) --> <!-- test: none (reflect.ts runs main() at import) -->
- [x] **MEM-REFLECT-002**: When `reflect` runs, it shall read at most 600 memories oldest-first whose timestamp is after `meta.last_reflection` (default 1970-01-01). <!-- openspec: memory § Reflection --> <!-- test: services/memory/test/memory.test.ts:111 covers recentSince only -->
- [x] **MEM-REFLECT-003**: If fewer than 5 new memories exist, `reflect` shall log and exit without calling the LLM or changing personality. <!-- openspec: memory § Reflection (Too few memories) --> <!-- test: none -->
- [x] **MEM-REFLECT-004**: When enough memories exist, `reflect` shall ask the chat LLM (max 400 tokens, temperature 0.5) for 3 to 6 bullet points given the current personality and a `who: text` transcript. <!-- openspec: memory § Reflection --> <!-- test: none -->
- [x] **MEM-REFLECT-005**: The reflection parser shall keep only reply lines that start with `- ` after trimming, discarding preamble and other bullet styles. <!-- openspec: memory § Reflection (Preamble stripped) --> <!-- test: services/memory/test/memory.test.ts:8 -->
- [x] **MEM-REFLECT-006**: If the LLM reply contains no bullet lines, `reflect` shall log a warning and neither save personality nor update `last_reflection`. <!-- openspec: memory § Reflection (No bullets) --> <!-- test: none -->
- [x] **MEM-REFLECT-007**: When bullets are produced, `reflect` shall append them as a `### YYYY-MM-DD` block under the `## Learned` heading of personality (adding the heading if absent), set `meta.last_reflection` to the current time and print the block. <!-- openspec: memory § Reflection --> <!-- test: services/memory/test/memory.test.ts:14 covers the text append only -->
- [ ] **MEM-REFLECT-008**: When more than 600 memories are newer than `last_reflection`, `reflect` shall not permanently skip the rows beyond the first 600. <!-- gap [inferred]: reflect.ts:27 reads the oldest 600 then reflect.ts:55 sets last_reflection to now; OpenSpec memory § Reflection describes the same cap without addressing the loss -->
