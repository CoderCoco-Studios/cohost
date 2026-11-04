---
parent: high-level-design
prefix: MEM
---

# memory

Brownfield: this document describes the intended behaviour and, where the code
lags, says so with the spec ID of the gap. It was audited against the code on
2026-11-01 and carries the owner's decisions of 2026-11-01.

## Context and Design Philosophy

memory is the brain's "hippocampus" (`services/memory/src/index.ts:2`):
the only region that touches Postgres/pgvector. It turns what happened on stream
into embedded rows, answers "what do we remember about X" requests over the bus,
and tells the cortex who a viewer is. A separate, offline CLI (`reflect.ts`)
consolidates stored memories into the `## Learned` section of `personality.md`.

Guiding shape, as observed:

- Memory is a bus region like the others: it talks only through events
  (`chat.message`, `speech.heard`, `brain.say`, `memory.recall.request` in;
  `memory.viewer`, `memory.recall.reply` out). The cortex is the usual caller but
  "any region may ask" (`index.ts:10`). Memory does not subscribe to `control`, so
  `pause`, `resume`, `mute` or `forget_context` addressed to it have no effect:
  only cortex and salience act on mute and pause, and memory keeps recording
  while the co-host is muted.
- Writes are best effort. The Postgres `remember` and `recall` swallow errors and
  log a warning (`store.ts:116-118`, `store.ts:135-138`), and a failed viewer upsert
  is logged without losing the mention (`MEM-VIEWER-006`); the cortex tolerates a
  missing or slow memory by timing out (see the cortex segment). A configuration
  error that would make every write fail, a vector-dimension mismatch, fails
  startup instead (`MEM-STORE-002`).
- Memory is the durable region: it is the one subscriber that keeps the backlog
  across a restart (start mode `resume`).
- Backends are swappable by config so the whole service can run on Redis alone
  (`brain.memory.store: memory`, `brain.memory.embedder: hash`), at the price of
  `mode: mock` and no durability.

## Event flow

Handler: `createMemoryHandler` in `services/memory/src/region.ts:18`. One handler
function is shared by both consumer groups (`startup.ts:60-61`).

| Direction | Event | Group | What happens | Evidence |
|-----------|-------|-------|--------------|----------|
| in | `chat.message` | `memory` | `touchViewer(userId ?? user, user)` on every line; if `mentionsCohost`, publish `memory.viewer` then `remember("chat", user, text)` | `region.ts:22-36` |
| in | `speech.heard` | `memory` | `remember("speech", speaker, text)` for every utterance | `region.ts:38-43` |
| in | `brain.say` | `memory` | if `text.length >= 2`, `remember("self", cfg.cohost.name, text)`; any publisher (cortex, reflex, operator) | `region.ts:45-50` |
| in | `memory.recall.request` | `memory-recall` | `store.recall(query, k)` then publish `memory.recall.reply` | `region.ts:52-60` |
| out | `memory.viewer` | | `{user, isNew, msgCount, notes}`; published before the slow embed so the cortex has it when it builds the reply | `region.ts:31-32` |
| out | `memory.recall.reply` | | `{id, memories:[{ts(epoch ms), kind, who, text, similarity}]}` | `region.ts:55-58` |

Two consumer groups exist so a recall never queues behind the embed plus INSERT
writes (`startup.ts:59`). Both subscribe with the bus start mode `resume`
(`MEM-EVT-001`): a group the subscription creates starts at the newest entry
(`XGROUP CREATE ... $`), and a group that already exists resumes after its last
delivered entry. So:

- on the very first start (no groups yet), events published before the groups are
  created are never seen;
- on any later start the service receives everything published while it was
  down, up to the stream's approximate 20 000-entry cap
  (`packages/bus/src/index.ts:9`), and stores it. Every other subscribing service
  uses start mode `latest`, which resets its group to `$` on each start; memory
  is the exception because the backlog is exactly what it exists to keep.

Both subscriptions pass `start: "resume"` (`startup.ts:60-61`). The control-plane
manifest also starts memory in `resume` mode (`packages/control/src/manifest.ts:43`);
a control-plane `fresh` start resets both groups to `$` first.

`ready` should be reported once both consumer groups exist (`MEM-START-005`, open).
The bus reports no event for group creation, so `startup.ts` starts the
subscriptions with `void` and calls `heartbeat.ready()` at once (`startup.ts:60-62`):
`ready` can precede group creation. Closing the gap needs a bus hook (for example
`onReady` in `SubscribeOptions`, called once the group exists and is positioned,
before the first read) owned by the event-bus segment. Calling `resetGroup` from
memory is not an option: it would move a resumed group to `$` and drop the backlog.

Bus handler errors are caught, logged, and the entry is acked
(`packages/bus/src/index.ts:160-166`), so an exception in this handler drops
that event rather than retrying it. The handler therefore catches a failed
`touchViewer` itself, logs it, skips `memory.viewer` and still remembers the
mention (`MEM-VIEWER-006`, `region.ts:25-29`).

### Test injection

`skipInjected` (`region.ts:14`) returns true for `injected === true && remember !== true`.
For `chat.message`, `speech.heard` and `brain.say` an injected, not-remembered event
causes no viewer row, no `memory.viewer`, and no memory row (`region.ts:24,40,47`).
`remember` is ignored on events that are not `injected` (`region.test.ts:96-102`).
`memory.recall.request` has no injection flag and is always served.

### Viewers

Every non-skipped chat line upserts `viewers` keyed by `lower(userId ?? user)`
(`store.ts:142-152`). A new row starts at `msg_count` 1 (the INSERT sets it
explicitly, `store.ts:144`; the column default is 0, `store.ts:87`) and each later
message adds 1, so `msgCount` is the number of messages seen and `isNew`
(`msg_count <= 1`, `store.ts:150`) is true for the first message only, in both
stores (`MEM-VIEWER-001`, in-memory: `fake-store.ts:54-57`). On conflict the row's
`display` is replaced, `last_seen` refreshed and `msg_count` incremented
(`store.ts:145`). `first_seen`
and `last_seen` are selected but unused.

The `notes` column is read and published in `memory.viewer` and defaults to empty
text (`store.ts:88`). Nothing in the repository writes it; choosing a writer
(reflection, the dashboard, or hand-edited SQL) is deferred (`MEM-VIEWER-005`).

## Stores and embedders

Factories in `services/memory/src/backend.ts`:

- `createMemoryEmbedder(cfg)`: `brain.memory.embedder === "hash"` gives `HashEmbedder`
  from `@cohost/llm` (no network); anything else gives `new Ollama(cfg.llm)`
  regardless of `llm.provider` (`backend.ts:8-10`). This differs from
  `@cohost/llm`'s own `createEmbedder`, which switches to hash when
  `llm.provider === "mock"` (`packages/llm/src/index.ts:60-62`); memory does not
  call `createEmbedder`.
- `createStore(cfg, embedder, log)`: `brain.memory.store === "memory"` gives
  `InMemoryStore`, which ignores the supplied embedder; anything else gives the
  Postgres `MemoryStore` (`backend.ts:14-18`).

Both stores implement `MemoryBackend` (`store.ts:21-30`): `init, remember, recall,
touchViewer, recentSince, getMeta, setMeta, close`. `region.ts:9` types the store as
`Pick<MemoryStore, ...>`, which either backend satisfies structurally.

### Postgres `MemoryStore` (`store.ts:49-175`)

- Pool: `new pg.Pool({ connectionString: urls.database(), max: 4 })`
  (`store.ts:58`); `DATABASE_URL`, default `postgres://cohost:cohost@127.0.0.1:5432/cohost`
  (`packages/config/src/index.ts:158`). The pool is built in the constructor, so
  `reflect` (with the Postgres store) and the unit tests create one.
- Every pool query goes through `MemoryStore.query` (`store.ts:62`), which wraps it
  with `tracked()` and reports the outcome to the `onQuery` callback; the service
  passes `health.setPostgres` (`index.ts:28`), so `deps.postgres` follows the latest
  query (`MEM-HEALTH-005`).
- `init()` (`store.ts:67-98`): embeds the literal `"hello"` to learn the vector
  dimension, then `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TABLE IF NOT
  EXISTS` for `memories(id, ts, kind, who, text, embedding vector(dims))`,
  `viewers(user_key PK, display, first_seen, last_seen, msg_count, notes)` and
  `meta(k PK, v)`, then an hnsw cosine index whose failure is only a warning.
  The dimension is fixed when the table is first created. `init` compares the
  existing column's dimension (`atttypmod` of `memories.embedding`,
  `checkDimensions`, `store.ts:100-106`) with the probed one and throws
  `DimensionMismatchError` (`store.ts:33-42`, code `MEMORY_DIM_MISMATCH`) naming
  both when they differ. Startup does not retry that error, so the service ends in
  its fatal exit instead of running with every write and recall failing
  (`MEM-STORE-002`). Migrating or re-embedding an existing table is a separate,
  open decision (Open Questions).
- `remember` embeds `"<who>: <text>"` and inserts the pgvector literal `[a,b,...]`
  (`store.ts:109-119`, `toVector` at `store.ts:177`). Kinds: `chat`, `speech`, `self`,
  `note`; the code only ever writes the first three.
- `recall` (`store.ts:122-140`): `k <= 0` returns `[]` with no query; otherwise embeds
  the query and selects `1 - (embedding <=> $1) AS similarity` where `ts < now() -
  interval '2 minutes'` ordered by cosine distance, limit `k`, then filters in JS by
  `similarity >= min_similarity`. The 2-minute exclusion keeps the immediate
  conversation out of "memories". `k` defaults to `brain.memory.recall_k` (default 6;
  `min_similarity` default 0.35, `packages/config/src/schema.ts:147-148`).
- `recentSince(cursor, limit=400)` and `getMeta/setMeta` back the reflection job
  (`store.ts:154-170`). `recentSince` selects `WHERE (ts, id) > ($1::timestamptz, $2)
  ORDER BY ts, id LIMIT $3`, returning `ts` also as microsecond text (`"tsText"`).

### In-memory `InMemoryStore` (`fake-store.ts`)

Same interface, state in JS arrays and maps, lost on exit. It embeds with its own
`hashEmbed` (`fake-store.ts:8-17`): 64 dims, tokens `[\p{L}\p{N}']+`, FNV-style hash,
unsigned counts, L2-normalised, and an all-zero vector for text with no tokens.
`@cohost/llm`'s `HashEmbedder` is a second, different hash embedder (also 64 dims
but signed, tokens `[\p{L}\p{N}]+`, a fixed unit vector for empty text,
`packages/llm/src/mock.ts:26-50`); it is used only when `store=postgres` and
`embedder=hash`. `recall` mirrors the SQL semantics: 2-minute cutoff against an
injectable clock, cosine by dot product, sort, top `k`, `min_similarity` filter
(`fake-store.ts:39-49`). `touchViewer` lowercases the key, counts from 1 and never
returns notes other than `""` (`fake-store.ts:52-58`). `recentSince` returns rows
after the `(ts, id)` cursor in `(ts, id)` order with a default limit of 400, and
`meta` is a `Map` (`fake-store.ts:61-71`).

## Startup, health and shutdown

Config read: `brain.memory.{store, embedder, recall_k, min_similarity}` (env
overrides `MEMORY_STORE`, `MEMORY_EMBEDDER` via `config/config.example.yaml:109-110`),
`cohost.name`, `cohost.streamer` (reflect), `llm.*` (Ollama client), `DATABASE_URL`,
`HEARTBEAT_INTERVAL_MS` (heartbeat package).

Startup sequence (`startMemory` in `services/memory/src/startup.ts`, called from
`index.ts:31`; its dependencies are injected so `startup.test.ts` runs it without
Redis, Ollama or Postgres):

1. `index.ts` starts the heartbeat immediately (`index.ts:26`): state `starting`.
2. If store or embedder is non-default, warn `mode mock; data is not durable`.
3. If `store=postgres` and `embedder=ollama`: ping Ollama every 3 s forever; each miss
   sets `deps.ollama=down` and reports heartbeat `degraded` with the detail
   `waiting for ollama (embeddings)`, as the cortex does while it waits for its
   backend (`MEM-HEALTH-007`); success sets `ok` (`startup.ts:31-39`).
4. If `store=postgres`: `store.init()` with a retry every 3 s; each failure sets
   `deps.postgres=down` and reports `degraded` with a detail naming Postgres
   (`MEM-HEALTH-007`), success sets `ok`, and the 21st failure rethrows so the
   process logs `fatal` and exits 1 (`startup.ts:41-54`, `index.ts:45-46`). A
   `DimensionMismatchError` is rethrown at once, without a retry
   (`MEM-STORE-002`). Otherwise a single `store.init()` on the fake
   (`startup.ts:56`).
5. Start both subscriptions with `start: "resume"`, call `heartbeat.ready()`
   (ideally once both groups exist, `MEM-START-005`), log `memory online`
   (`startup.ts:58-63`).

Health (`health.ts`): `MemoryHealth` builds the `HeartbeatSpec`. `mode` is `live`
only for postgres plus ollama, else `mock`. `deps.postgres` is `n/a` unless the
store is Postgres; `deps.ollama` is `n/a` unless postgres plus ollama. The embedder
handed to the store is wrapped with `tracked()` so each `embed()` success or failure
sets `deps.ollama` (`health.ts:33-36`), giving `degraded` at runtime when Ollama
stops answering. Postgres pool queries are wrapped the same way (`store.ts:54,62`),
so `deps.postgres` follows the latest query and a Postgres outage after startup
shows as `degraded` even though `remember`/`recall` swallow the error
(`MEM-HEALTH-005`). Heartbeat contract and `degraded` derivation are owned by the
control-plane segment (`packages/bus/src/heartbeat.ts:68-85`).

Shutdown: `onShutdown` stops the bus then closes the store (`index.ts:47`); the
`stopping` heartbeat is sent by the heartbeat package's `beforeShutdown` hook.

## Reflection pass (`reflect.ts`, `learned.ts`)

A CLI run between streams (`pnpm reflect` which is `tsx src/reflect.ts`, or
`node services/memory/dist/reflect.js`). It is not a bus region and holds no
mutex against the live service.

1. `store=memory`: log a warning and return (nothing persists across processes).
2. `init()` the store (this embeds `"hello"` so the embedder must be reachable),
   read `meta.last_reflection` (default: before the first row), `recentSince(cursor, 600)`.
3. Fewer than 5 rows: log and return with the cursor unchanged, so those rows are
   read again, together with the ones that arrive later, in a later pass. The final
   batch of a backlog may be partial: 5 to 599 rows reflect normally.
4. Ask the chat LLM (`createChatProvider(cfg.llm)`, `maxTokens 400`, `temperature
   0.5`) for 3 to 6 bullets given the current personality and the `who: text`
   transcript (`reflect-run.ts:41-54`).
5. `parseBullets` keeps only lines that start with `- ` after trim
   (`learned.ts:7-9`); none: warn and stop without saving.
6. The `### YYYY-MM-DD` (UTC) block goes at the end of the `## Learned` section,
   before the next `## ` heading or at the end of the text when `## Learned` is the
   last section; a `## Learned` heading is added at the end when the text has none
   (`MEM-REFLECT-007`, `appendLearned`, `learned.ts:16-27`; only a line that is
   exactly `## Learned` is the heading). The shipped template ends with `## Learned`
   (`config/personality.example.md:26`). The result is saved with
   `savePersonality`, `meta.last_reflection` advances (below), and the block is
   printed (`reflect-run.ts:59-64`).
7. Failures (including an unreachable embedder at `init`) log `reflect failed` and
   set `process.exitCode = 1`; the store is closed in `finally` (`reflect-run.ts:26-29`).

The pass itself is `runReflect` in `reflect-run.ts`, with the config, chat provider,
store, personality load/save and clock injected; `reflect.ts` is the wiring that
runs it at load. When the chat provider is the mock backend (`name === "mock"`),
`runReflect` logs one warning naming it before reading any memory
(`MEM-REFLECT-010`, `LLM-MOCK-005`), so canned bullets are never mistaken for a real
reflection.

`recentSince` reads at most 600 rows, which bounds the prompt. The reflection
cursor is the pair `(ts, id)` of the newest row read: after a successful save
`meta.last_reflection` stores it as `<ISO ts>#<id>` (`cursor.ts`), where the timestamp is the
exact text Postgres produced (microsecond precision, selected as `"tsText"` by
`recentSince`) and is passed back as `$1::timestamptz`, and the next
pass reads rows strictly after it in `(ts, id)` order, so with more than 600 new
rows the remainder is reflected on in the next pass, and rows sharing the last
row's timestamp are not skipped (`MEM-REFLECT-008`). A timestamp-only cursor would
skip such rows because `ts > $1` excludes them. A plain ISO timestamp left in
`meta.last_reflection` by an earlier version is read as that timestamp with the
lowest id.
The running cortex does not learn of the change until a `reload_personality` control.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where vectors live | Postgres with pgvector, hnsw cosine index | in-process index; dedicated vector DB | One durable store holds memories, viewers and the reflection cursor (`meta`), so a vector search, a viewer update and the cursor share one dependency and one backup; pgvector's hnsw index gives approximate cosine search without running a separate vector service, and an in-process index would not survive a restart; `store.ts:71-98` |
| Embedder for memory | Always local Ollama unless `embedder=hash` | follow `llm.provider` | Keeps the vector size independent of the chat model: commit `969f6d7` ("Embeddings always come from local Ollama so the memory table's vector size is independent of the chat model"), `packages/config/src/schema.ts:38-41`. Not following `llm.provider: mock` is deliberate, "avoids silent offline" (commit `51d5a9c` review notes). |
| Vector dimension | Probed from a live embedding at first `init` | fixed constant in config | Comment `store.ts:68`: "Probe embedding size so the table matches whatever model is configured." |
| Two consumer groups | `memory` (writes) and `memory-recall` | one group | Comment `startup.ts:59`: "so a recall never queues behind the (embed + INSERT) writes." |
| Announce viewer before embed | publish `memory.viewer` then `remember` | after | Comment `region.ts:31`: "before the slow embed so the cortex has it when the reply is built." |
| Recency exclusion | `ts < now() - 2 minutes` | include everything | Keeps the live conversation, which the cortex already has in its working-memory transcript, out of recalled memories, so a reply does not "remember" what was said a moment ago. The window is a fixed time span while the cortex window is a count of events (`brain.working_memory_events`), so the two are an approximation of each other, not an exact match; `store.ts:129`, `fake-store.ts:42` |
| Write error handling | `remember`/`recall` swallow and warn; a failed `touchViewer` is caught, logged, and the mention is still remembered | throw everywhere; let the bus drop the whole event | owner decision 2026-11-01: the show goes on without memory, and a viewer-table error must not lose the memory itself; `store.ts:116-118,135-138`, `MEM-VIEWER-006` |
| Vector dimension mismatch | Fail `init` loudly, no retry, fatal exit | silently keep running; report degraded; migrate or re-embed | owner decision 2026-11-01: a mismatch makes every write and recall fail while health says `ok`, so it must stop startup; migration is decided separately; `MEM-STORE-002` |
| Restart start mode | `resume` for both groups: the backlog published while memory was down is stored | `latest` (reset to `$` each start) like every other subscriber | owner decision 2026-11-01: memory is the durable region and wants the backlog; delivery is still at-most-once across a crash (event-bus); `MEM-EVT-001` |
| Mute and pause | Memory never reads `control`; it records while the co-host is muted | honour mute/pause | owner decision 2026-11-01: only the services that act on mute and pause (cortex, salience) see them |
| Viewer count | A new viewer row starts at `msg_count` 1 in both stores | keep Postgres at 0 | owner decision 2026-11-01: `isNew` once and `msgCount` equal to messages seen, matching the in-memory store; `MEM-VIEWER-001` |
| Viewer notes writer | Deferred | reflection; dashboard; hand-edited SQL | owner decision 2026-11-01: no writer until one is chosen; `MEM-VIEWER-005` `[D]` |
| Postgres health | Every pool query feeds `deps.postgres` through `tracked()`; `degraded` with a detail while waiting for Ollama or Postgres at startup | startup-only flag; stay `starting` while waiting | owner decision 2026-11-01: the heartbeat reflects runtime dependency state, as the cortex does; `MEM-HEALTH-005`, `MEM-HEALTH-007` |
| Recall k=0 | Short-circuit with no embed or query | query anyway | `config/config.example.yaml:111` documents `recall_k: 0` as "disables recall"; `store.ts:123`, `fake-store.ts:40` |
| Isolated backend | Separate in-process store with its own 64-dim hash embedder | reuse `HashEmbedder` inside the fake | the fake is self-contained and ignores `brain.memory.embedder`; its unsigned counts keep similarity scores non-negative, so `min_similarity` stays meaningful for plain word overlap; it needs no async embedder; the fake store (commit `719ce5a`) predates `HashEmbedder` (commit `51d5a9c`), and OpenSpec `add-isolated-backends` accepts the fake's "own bag-of-words hashed vectors"; `fake-store.ts:8-17`, comment `backend.ts:16` |
| Reflection with the in-memory store | Logged no-op | reflect over the fake | Commit `719ce5a`: "`reflect` still uses the Postgres store (it runs in a separate process, so a fake would be empty)"; `reflect.ts:22-25` |
| Mode reporting | `mock` if either store or embedder is non-default | per-dependency mode | `live` means memory as a real stream needs it: persistent rows and semantic recall. Either substitute (the in-process store forgets on restart; the hash embedder matches words, not meaning) means recall is not real, so the mode says `mock`; which dependency is substituted is already visible per dependency as `n/a` in `deps`; `health.ts:7-11,24` |
| Reflection placement | Offline CLI, writes personality file | in-service timer; DB-only learned facts | Comments `index.ts:12` ("Consolidation (\"sleep\") is reflect.ts, run between streams") and `reflect.ts:1-9` ("This is how the personality drifts over time instead of resetting every stream. Edit the file by hand whenever you like.") |
| Reflection input cap | Oldest 600 rows since last reflection; the cursor `(ts, id)` advances to the newest row read; fewer than 5 rows leaves it unchanged | newest 600; jump the cursor to now; timestamp-only cursor; paginate within one run | Cap: 600 rows bounds the size of one reflection prompt; rows beyond it are read in the next pass. The cap is a row count, not a token budget, so whether 600 rows fit depends on line length and the model's context (`llm.num_ctx`) (`reflect-run.ts:19,32`). Cursor: owner decision 2026-11-01, so no memory is skipped permanently; `MEM-REFLECT-008` |
| Cursor timestamp representation | The exact microsecond ISO text Postgres returns (`to_char(ts AT TIME ZONE 'UTC', ...US"Z"')`), compared as `$1::timestamptz` | the JS `Date` of the row's `ts` | A `Date` keeps milliseconds, so the cursor would round down and the newest row read would be read again every pass, inflating the "fewer than 5" count (`MEM-REFLECT-003`) and re-feeding a row to the LLM; `MEM-REFLECT-008` |
| Learned block placement | End of the `## Learned` section | end of file | owner decision 2026-11-01 (low priority: the shipped template ends with `## Learned`); `MEM-REFLECT-007` |
| Pure text helpers split out | `learned.ts` holds bullet parsing and heading logic | inline in reflect.ts | Extracted so the reflection logic could be tested (`reflect.ts` runs at import): commit `95afa19` ("reflection merge logic (extracted from reflect.ts into learned.ts, behaviour unchanged)"), `learned.ts:1` |
| Testable reflection and startup | `runReflect` (`reflect-run.ts`) and `startMemory` (`startup.ts`) take their dependencies as arguments; `reflect.ts` and `index.ts` only wire them | keep the logic at module load | Both entry files run at import, which made the cursor, readiness, retry and subscription behaviour untestable; `MEM-REFLECT-008`, `MEM-HEALTH-007`, `MEM-EVT-001` |
| Startup readiness vs group creation | `ready` is reported right after the subscriptions are started | call `resetGroup` first; raw Redis `XGROUP CREATE`; wait with a timer | `resetGroup` would move a resumed group to `$`, and raw Redis access would bypass the bus; the correct fix is a bus `onReady` hook (open, `MEM-START-005`) |

## Open Questions & Future Decisions

### Resolved
1. The owner's decisions of 2026-11-01 (start mode, dimension mismatch, viewer
   count, notes writer, Postgres health, startup `degraded`, viewer-upsert
   failures, reflection cursor and placement) are recorded in the Decisions table
   and the spec lines they cite.

### Deferred (observed, unexplained, or technical debt)
1. **Migrating a table to a new vector dimension.** `MEM-STORE-002` stops startup
   on a mismatch; what an operator does next (re-embed, a table per model, drop and
   start over) is not decided. `dims` is held in memory only (`store.ts:51,69`).
2. **Reflection needs a reachable embedder** because `init()` embeds `"hello"`
   (`store.ts:69`) even though reflect only reads. It also runs without any lock
   alongside the live service.
3. **Two hash embedders.** `fake-store.ts:hashEmbed` and `@cohost/llm` `HashEmbedder`
   differ in tokenisation, sign handling and empty-text output; both 64 dims. The
   fake keeps its own: it is self-contained and its non-negative scores suit
   `min_similarity` (it also predates `HashEmbedder`, commit `719ce5a`).
4. **Kind `note` is declared but never written** (`store.ts:7`).
5. **Recall request validation:** the bus schema makes `k` positive
   (`packages/bus/src/events.ts:108-112`, `k` at 111), so `k=0` can only occur
   through config (`recall_k=0`, where the cortex does not send a request) even
   though the store handles it.
6. **Test gaps.** `index.ts` and `reflect.ts` (wiring only) have no tests;
   `startup.ts` and `reflect-run.ts` are tested with fakes, so no test runs
   against a real Postgres: the `atttypmod` dimension query and the
   `(ts, id)` row comparison are exercised only against recorded SQL.
7. **Consumer-group readiness.** `MEM-START-005` waits on a bus hook that does not
   exist yet.

## References

- Code: `services/memory/src/{index,startup,region,store,cursor,backend,fake-store,reflect,reflect-run,learned,health}.ts`,
  `services/memory/package.json`, `services/memory/tsconfig.json`
- Tests: `services/memory/test/{backend,fake-store,health,memory,region,reflect,startup}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (events `chat.message`, `speech.heard`, `brain.say`,
  `memory.*`, `Bus.subscribe/publish`, start mode `resume`, a future group-ready hook), config
  (`loadConfig`, `urls.database`, `loadPersonality/savePersonality`,
  `brain.memory.*`), model-backends (`Ollama`, `HashEmbedder`, `createChatProvider`),
  control-plane (heartbeat contract, `startHeartbeat`, `tracked`, manifest start
  mode `resume` and groups `memory`, `memory-recall`)
- Depended on by: cortex (sends `memory.recall.request`, consumes `memory.recall.reply`
  and `memory.viewer`), dashboard (test injection of chat and speech reaches memory
  with `injected`/`remember` flags), deployment (compose service `memory`, reflect
  invocation)
- External: PostgreSQL with the pgvector extension (`pg` ^8.13), Ollama embeddings, Redis streams
- OpenSpec: `openspec/specs/memory/spec.md`; deltas
  `openspec/changes/archive/2026-11-01-add-service-health/specs/memory/spec.md`,
  `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/memory/spec.md`,
  `openspec/changes/archive/2026-11-01-add-test-injection/specs/memory/spec.md`
