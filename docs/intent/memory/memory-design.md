---
parent: high-level-design
prefix: MEM
---

# memory

Brownfield: this document describes the intended behaviour and, where the code
lags, says so with the spec ID of the gap. It was audited against the code on
2026-11-01 and carries the owner's decisions of 2026-11-01. A rationale cell
marked `[inferred]` is read from the code and not confirmed by the owner; a cell
marked `owner decision 2026-11-01` was settled by the owner; any other rationale
cell cites the code comment or commit message that states it.

## Context and Design Philosophy

`[inferred]` memory is the brain's "hippocampus" (`services/memory/src/index.ts:2`):
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
  log a warning (`store.ts:80-82`, `store.ts:99-102`), and a failed viewer upsert
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

Handler: `createMemoryHandler` in `services/memory/src/region.ts:17`. One handler
function is shared by both consumer groups (`index.ts:63-64`).

| Direction | Event | Group | What happens | Evidence |
|-----------|-------|-------|--------------|----------|
| in | `chat.message` | `memory` | `touchViewer(userId ?? user, user)` on every line; if `mentionsCohost`, publish `memory.viewer` then `remember("chat", user, text)` | `region.ts:21-31` |
| in | `speech.heard` | `memory` | `remember("speech", speaker, text)` for every utterance | `region.ts:33-38` |
| in | `brain.say` | `memory` | if `text.length >= 2`, `remember("self", cfg.cohost.name, text)`; any publisher (cortex, reflex, operator) | `region.ts:40-45` |
| in | `memory.recall.request` | `memory-recall` | `store.recall(query, k)` then publish `memory.recall.reply` | `region.ts:47-55` |
| out | `memory.viewer` | | `{user, isNew, msgCount, notes}`; published before the slow embed so the cortex has it when it builds the reply | `region.ts:26-27` |
| out | `memory.recall.reply` | | `{id, memories:[{ts(epoch ms), kind, who, text, similarity}]}` | `region.ts:50-53` |

Two consumer groups exist so a recall never queues behind the embed plus INSERT
writes (`index.ts:62`). Both subscribe with the bus start mode `resume`
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

The code passes `fromNow: true` today (`index.ts:63-64`), which behaves as
`resume` (`packages/bus/src/index.ts:133-138`); it moves to the explicit option
when the bus gains it. The control-plane manifest also starts memory in `resume`
mode (`packages/control/src/manifest.ts:43`); a control-plane `fresh` start
resets both groups to `$` first.

`ready` is reported once both consumer groups exist (`MEM-START-005`). The code
starts the subscriptions with `void` and calls `heartbeat.ready()` at once
(`index.ts:65`), so today `ready` can precede group creation.

Bus handler errors are caught, logged, and the entry is acked
(`packages/bus/src/index.ts:160-166`), so an exception in this handler drops
that event rather than retrying it. The handler therefore catches a failed
`touchViewer` itself, logs it, skips `memory.viewer` and still remembers the
mention (`MEM-VIEWER-006`); the code does not yet catch it (`region.ts:24`).

### Test injection

`skipInjected` (`region.ts:13`) returns true for `injected === true && remember !== true`.
For `chat.message`, `speech.heard` and `brain.say` an injected, not-remembered event
causes no viewer row, no `memory.viewer`, and no memory row (`region.ts:23,35,42`).
`remember` is ignored on events that are not `injected` (`region.test.ts:91-97`).
`memory.recall.request` has no injection flag and is always served.

### Viewers

Every non-skipped chat line upserts `viewers` keyed by `lower(userId ?? user)`
(`store.ts:106-115`). A new row starts at `msg_count` 1 and each later message adds
1, so `msgCount` is the number of messages seen and `isNew` (`msg_count <= 1`,
`store.ts:114`) is true for the first message only, in both stores
(`MEM-VIEWER-001`). The in-memory store already counts from 1
(`fake-store.ts:53-56`). The Postgres INSERT names only `user_key` and `display`,
so a new row still takes the column default `msg_count` 0 (`store.ts:61`,
`store.ts:108`); until that is fixed, Postgres reports a viewer new for two
messages and one message low. On conflict the row's `display` is replaced,
`last_seen` refreshed and `msg_count` incremented (`store.ts:109`). `first_seen`
and `last_seen` are selected but unused.

The `notes` column is read and published in `memory.viewer` and defaults to empty
text (`store.ts:62`). Nothing in the repository writes it; choosing a writer
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

Both stores implement `MemoryBackend` (`store.ts:17-26`): `init, remember, recall,
touchViewer, recentSince, getMeta, setMeta, close`. `region.ts:8` types the store as
`Pick<MemoryStore, ...>`, which either backend satisfies structurally.

### Postgres `MemoryStore` (`store.ts:33-138`)

- Pool: `new pg.Pool({ connectionString: urls.database(), max: 4 })`
  (`store.ts:38`); `DATABASE_URL`, default `postgres://cohost:cohost@127.0.0.1:5432/cohost`
  (`packages/config/src/index.ts:158`). The pool is built in the constructor, so
  `reflect` (with the Postgres store) and the unit tests create one.
- `init()` (`store.ts:42-70`): embeds the literal `"hello"` to learn the vector
  dimension, then `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TABLE IF NOT
  EXISTS` for `memories(id, ts, kind, who, text, embedding vector(dims))`,
  `viewers(user_key PK, display, first_seen, last_seen, msg_count, notes)` and
  `meta(k PK, v)`, then an hnsw cosine index whose failure is only a warning.
  The dimension is fixed when the table is first created. `init` compares the
  existing column's dimension with the probed one and fails with an error naming
  both when they differ, and startup does not retry that error, so the service
  ends in its fatal exit instead of running with every write and recall failing
  (`MEM-STORE-002`). The code does not yet make the comparison. Migrating or
  re-embedding an existing table is a separate, open decision (Open Questions).
- `remember` embeds `"<who>: <text>"` and inserts the pgvector literal `[a,b,...]`
  (`store.ts:73-83`, `toVector` at `store.ts:140`). Kinds: `chat`, `speech`, `self`,
  `note`; the code only ever writes the first three.
- `recall` (`store.ts:86-103`): `k <= 0` returns `[]` with no query; otherwise embeds
  the query and selects `1 - (embedding <=> $1) AS similarity` where `ts < now() -
  interval '2 minutes'` ordered by cosine distance, limit `k`, then filters in JS by
  `similarity >= min_similarity`. The 2-minute exclusion keeps the immediate
  conversation out of "memories". `k` defaults to `brain.memory.recall_k` (default 6;
  `min_similarity` default 0.35, `packages/config/src/schema.ts:147-148`).
- `recentSince(ts, limit=400)` and `getMeta/setMeta` back the reflection job
  (`store.ts:118-133`).

### In-memory `InMemoryStore` (`fake-store.ts`)

Same interface, state in JS arrays and maps, lost on exit. It embeds with its own
`hashEmbed` (`fake-store.ts:7-16`): 64 dims, tokens `[\p{L}\p{N}']+`, FNV-style hash,
unsigned counts, L2-normalised, and an all-zero vector for text with no tokens.
`@cohost/llm`'s `HashEmbedder` is a second, different hash embedder (also 64 dims
but signed, tokens `[\p{L}\p{N}]+`, a fixed unit vector for empty text,
`packages/llm/src/mock.ts:26-50`); it is used only when `store=postgres` and
`embedder=hash`. `recall` mirrors the SQL semantics: 2-minute cutoff against an
injectable clock, cosine by dot product, sort, top `k`, `min_similarity` filter
(`fake-store.ts:38-48`). `touchViewer` lowercases the key, counts from 1 and never
returns notes other than `""` (`fake-store.ts:51-57`). `recentSince` returns rows in
insertion order with a default limit of 400, and `meta` is a `Map`
(`fake-store.ts:60-69`).

## Startup, health and shutdown

Config read: `brain.memory.{store, embedder, recall_k, min_similarity}` (env
overrides `MEMORY_STORE`, `MEMORY_EMBEDDER` via `config/config.example.yaml:109-110`),
`cohost.name`, `cohost.streamer` (reflect), `llm.*` (Ollama client), `DATABASE_URL`,
`HEARTBEAT_INTERVAL_MS` (heartbeat package).

Startup sequence (`index.ts:31-67`):

1. Start the heartbeat immediately (`index.ts:26`): state `starting`.
2. If store or embedder is non-default, warn `mode mock; data is not durable`.
3. If `store=postgres` and `embedder=ollama`: ping Ollama every 3 s forever; each miss
   sets `deps.ollama=down`, success sets `ok` (`index.ts:37-45`). While waiting, the
   heartbeat reports `degraded` with a detail naming Ollama, as the cortex does
   while it waits for its backend (`MEM-HEALTH-007`); the code does not yet call
   `heartbeat.degraded()`, so the state stays `starting`.
4. If `store=postgres`: `store.init()` with a retry every 3 s; each failure sets
   `deps.postgres=down` and reports `degraded` with a detail naming Postgres
   (`MEM-HEALTH-007`), success sets `ok`, and the 21st failure rethrows so the
   process logs `fatal` and exits 1 (`index.ts:47-56`, `index.ts:72`). A vector
   dimension mismatch is not retried (`MEM-STORE-002`). Otherwise a single
   `store.init()` on the fake (`index.ts:59`).
5. Start both subscriptions, call `heartbeat.ready()` once both groups exist
   (`MEM-START-005`), log `memory online`.

Health (`health.ts`): `MemoryHealth` builds the `HeartbeatSpec`. `mode` is `live`
only for postgres plus ollama, else `mock`. `deps.postgres` is `n/a` unless the
store is Postgres; `deps.ollama` is `n/a` unless postgres plus ollama. The embedder
handed to the store is wrapped with `tracked()` so each `embed()` success or failure
sets `deps.ollama` (`health.ts:33-36`), giving `degraded` at runtime when Ollama
stops answering. Postgres pool queries are wrapped the same way, so `deps.postgres`
follows the latest query and a Postgres outage after startup shows as `degraded`
(`MEM-HEALTH-005`). The code sets `deps.postgres` only during the startup init loop
(`index.ts:49,51`), and the store swallows `remember`/`recall` errors, so today a
post-startup outage does not appear in the heartbeat. Heartbeat contract and
`degraded` derivation are owned by the control-plane segment
(`packages/bus/src/heartbeat.ts:68-85`).

Shutdown: `onShutdown` stops the bus then closes the store (`index.ts:73`); the
`stopping` heartbeat is sent by the heartbeat package's `beforeShutdown` hook.

## Reflection pass (`reflect.ts`, `learned.ts`)

A CLI run between streams (`pnpm reflect` which is `tsx src/reflect.ts`, or
`node services/memory/dist/reflect.js`). It is not a bus region and holds no
mutex against the live service.

1. `store=memory`: log a warning and return (nothing persists across processes).
2. `init()` the store (this embeds `"hello"` so the embedder must be reachable),
   read `meta.last_reflection` (default `1970-01-01`), `recentSince(since, 600)`.
3. Fewer than 5 rows: log and return.
4. Ask the chat LLM (`createChatProvider(cfg.llm)`, `maxTokens 400`, `temperature
   0.5`) for 3 to 6 bullets given the current personality and the `who: text`
   transcript (`reflect.ts:36-49`).
5. `parseBullets` keeps only lines that start with `- ` after trim
   (`learned.ts:7-9`); none: warn and stop without saving.
6. The `### YYYY-MM-DD` (UTC) block goes at the end of the `## Learned` section,
   before the next `## ` heading or at the end of the text when `## Learned` is the
   last section; a `## Learned` heading is added at the end when the text has none
   (`MEM-REFLECT-007`). The shipped template ends with `## Learned`
   (`config/personality.example.md:26`). `appendLearned` (`learned.ts:18-22`) still
   appends at the end of the file whatever section is last. The result is saved
   with `savePersonality`, `meta.last_reflection` advances (below), and the block
   is printed (`reflect.ts:54-58`).
7. Failures (including an unreachable embedder at `init`) log `reflect failed` and
   set `process.exitCode = 1`; the store is closed in `finally` (`reflect.ts:62-64`).

`recentSince` is `ORDER BY ts ASC LIMIT 600`, which bounds the prompt. After a
successful save `meta.last_reflection` is set to the timestamp of the newest row
read, so with more than 600 new rows the remainder is reflected on in the next
pass (`MEM-REFLECT-008`). The code sets it to the current time
(`reflect.ts:28,56`), which skips the remainder permanently.
The running cortex does not learn of the change until a `reload_personality` control.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where vectors live | Postgres with pgvector, hnsw cosine index | in-process index; dedicated vector DB | `[inferred]` single store for rows, viewers and meta; `store.ts:45-68` |
| Embedder for memory | Always local Ollama unless `embedder=hash` | follow `llm.provider` | Keeps the vector size independent of the chat model: commit `969f6d7` ("Embeddings always come from local Ollama so the memory table's vector size is independent of the chat model"), `packages/config/src/schema.ts:38-41`. Not following `llm.provider: mock` is deliberate, "avoids silent offline" (commit `51d5a9c` review notes). |
| Vector dimension | Probed from a live embedding at first `init` | fixed constant in config | Comment `store.ts:43`: "Probe embedding size so the table matches whatever model is configured." |
| Two consumer groups | `memory` (writes) and `memory-recall` | one group | Comment `index.ts:62`: "so a recall never queues behind the (embed + INSERT) writes." |
| Announce viewer before embed | publish `memory.viewer` then `remember` | after | Comment `region.ts:26`: "before the slow embed so the cortex has it when the reply is built." |
| Recency exclusion | `ts < now() - 2 minutes` | include everything | `[inferred]` keep the live conversation (already in cortex working memory) out of recalled memories; `store.ts:93`, `fake-store.ts:41` |
| Write error handling | `remember`/`recall` swallow and warn; a failed `touchViewer` is caught, logged, and the mention is still remembered | throw everywhere; let the bus drop the whole event | owner decision 2026-11-01: the show goes on without memory, and a viewer-table error must not lose the memory itself; `store.ts:80-82,99-102`, `MEM-VIEWER-006` |
| Vector dimension mismatch | Fail `init` loudly, no retry, fatal exit | silently keep running; report degraded; migrate or re-embed | owner decision 2026-11-01: a mismatch makes every write and recall fail while health says `ok`, so it must stop startup; migration is decided separately; `MEM-STORE-002` |
| Restart start mode | `resume` for both groups: the backlog published while memory was down is stored | `latest` (reset to `$` each start) like every other subscriber | owner decision 2026-11-01: memory is the durable region and wants the backlog; delivery is still at-most-once across a crash (event-bus); `MEM-EVT-001` |
| Mute and pause | Memory never reads `control`; it records while the co-host is muted | honour mute/pause | owner decision 2026-11-01: only the services that act on mute and pause (cortex, salience) see them |
| Viewer count | A new viewer row starts at `msg_count` 1 in both stores | keep Postgres at 0 | owner decision 2026-11-01: `isNew` once and `msgCount` equal to messages seen, matching the in-memory store; `MEM-VIEWER-001` |
| Viewer notes writer | Deferred | reflection; dashboard; hand-edited SQL | owner decision 2026-11-01: no writer until one is chosen; `MEM-VIEWER-005` `[D]` |
| Postgres health | Every pool query feeds `deps.postgres` through `tracked()`; `degraded` with a detail while waiting for Ollama or Postgres at startup | startup-only flag; stay `starting` while waiting | owner decision 2026-11-01: the heartbeat reflects runtime dependency state, as the cortex does; `MEM-HEALTH-005`, `MEM-HEALTH-007` |
| Recall k=0 | Short-circuit with no embed or query | query anyway | `config/config.example.yaml:111` documents `recall_k: 0` as "disables recall"; `store.ts:87`, `fake-store.ts:39` |
| Isolated backend | Separate in-process store with its own 64-dim hash embedder | reuse `HashEmbedder` inside the fake | `[inferred]` the fake needs no async embedder; the fake store (commit `719ce5a`) predates `HashEmbedder` (commit `51d5a9c`), and OpenSpec `add-isolated-backends` accepts the fake's "own bag-of-words hashed vectors"; `fake-store.ts:7-16`, comment `backend.ts:16` |
| Reflection with the in-memory store | Logged no-op | reflect over the fake | Commit `719ce5a`: "`reflect` still uses the Postgres store (it runs in a separate process, so a fake would be empty)"; `reflect.ts:22-25` |
| Mode reporting | `mock` if either store or embedder is non-default | per-dependency mode | `[inferred]` rule stated in `health.ts:7-11` and OpenSpec memory § Isolation preset and mode, reason not stated; `health.ts:24` |
| Reflection placement | Offline CLI, writes personality file | in-service timer; DB-only learned facts | Comments `index.ts:12` ("Consolidation (\"sleep\") is reflect.ts, run between streams") and `reflect.ts:1-9` ("This is how the personality drifts over time instead of resetting every stream. Edit the file by hand whenever you like.") |
| Reflection input cap | Oldest 600 rows since last reflection; the cursor advances to the newest row read | newest 600; jump the cursor to now; paginate within one run | Cap: `[inferred]` bounds the prompt size (`reflect.ts:28`). Cursor: owner decision 2026-11-01, so no memory is skipped permanently; `MEM-REFLECT-008` |
| Learned block placement | End of the `## Learned` section | end of file | owner decision 2026-11-01 (low priority: the shipped template ends with `## Learned`); `MEM-REFLECT-007` |
| Pure text helpers split out | `learned.ts` holds bullet parsing and heading logic | inline in reflect.ts | Extracted so the reflection logic could be tested (`reflect.ts` runs `main()` at import): commit `95afa19` ("reflection merge logic (extracted from reflect.ts into learned.ts, behaviour unchanged)"), `learned.ts:1` |

## Open Questions & Future Decisions

### Resolved
1. The owner's decisions of 2026-11-01 (start mode, dimension mismatch, viewer
   count, notes writer, Postgres health, startup `degraded`, viewer-upsert
   failures, reflection cursor and placement) are recorded in the Decisions table
   and the spec lines they cite.

### Deferred (observed, unexplained, or technical debt)
1. **Migrating a table to a new vector dimension.** `MEM-STORE-002` stops startup
   on a mismatch; what an operator does next (re-embed, a table per model, drop and
   start over) is not decided. `dims` is held in memory only (`store.ts:35,44`).
2. **Reflection needs a reachable embedder** because `init()` embeds `"hello"`
   (`store.ts:44`) even though reflect only reads. It also runs without any lock
   alongside the live service, and `learned.ts:19` detects the heading with
   `includes("## Learned")`, which also matches `### Learned...`.
3. **Two hash embedders.** `fake-store.ts:hashEmbed` and `@cohost/llm` `HashEmbedder`
   differ in tokenisation, sign handling and empty-text output; both 64 dims. The
   fake keeps its own because it predates `HashEmbedder` (commit `719ce5a`).
4. **Kind `note` is declared but never written** (`store.ts:5`).
5. **Recall request validation:** the bus schema makes `k` positive
   (`packages/bus/src/events.ts:108-112`, `k` at 111), so `k=0` can only occur
   through config (`recall_k=0`, where the cortex does not send a request) even
   though the store handles it.
6. **Test gaps.** `index.ts` (startup waits, retries, subscription wiring) and the
   `reflect.ts` main flow have no tests; the 600 cap, dimension mismatch, the
   Postgres viewer insert and a Postgres outage after startup are untested.

## References

- Code: `services/memory/src/{index,region,store,backend,fake-store,reflect,learned,health}.ts`,
  `services/memory/package.json`, `services/memory/tsconfig.json`
- Tests: `services/memory/test/{backend,fake-store,health,memory,region}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (events `chat.message`, `speech.heard`, `brain.say`,
  `memory.*`, `Bus.subscribe/publish`, start mode `resume`), config
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
