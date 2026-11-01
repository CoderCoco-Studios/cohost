---
parent: high-level-design
prefix: MEM
---

# memory

Mapped 2026-10-31 at git `686cc8f`. Brownfield: this document describes what
the code does today. Rationale cells are `[inferred]` from code, not authored.

## Context and Design Philosophy

`[inferred]` memory is the brain's "hippocampus" (`services/memory/src/index.ts:2`):
the only region that touches Postgres/pgvector. It turns what happened on stream
into embedded rows, answers "what do we remember about X" requests over the bus,
and tells the cortex who a viewer is. A separate, offline CLI (`reflect.ts`)
consolidates stored memories into the `## Learned` section of `personality.md`.

Guiding shape, as observed:

- Memory is a bus region like the others: it talks only through events
  (`chat.message`, `speech.heard`, `brain.say` in; `memory.viewer`,
  `memory.recall.reply` out). The cortex is the usual caller but "any region may
  ask" (`index.ts:9`).
- Writes are best effort. The Postgres `remember` and `recall` swallow errors and
  log a warning (`store.ts:78-80`, `store.ts:96-99`); the cortex tolerates a
  missing or slow memory by timing out (see the cortex segment).
- Backends are swappable by config so the whole service can run on Redis alone
  (`brain.memory.store: memory`, `brain.memory.embedder: hash`), at the price of
  `mode: mock` and no durability.

## Event flow

Handler: `createMemoryHandler` in `services/memory/src/region.ts:15`. One handler
function is shared by both consumer groups (`index.ts:58-59`).

| Direction | Event | Group | What happens | Evidence |
|-----------|-------|-------|--------------|----------|
| in | `chat.message` | `memory` | `touchViewer(userId ?? user, user)` on every line; if `mentionsCohost`, publish `memory.viewer` then `remember("chat", user, text)` | `region.ts:18-28` |
| in | `speech.heard` | `memory` | `remember("speech", speaker, text)` for every utterance | `region.ts:29-34` |
| in | `brain.say` | `memory` | if `text.length >= 2`, `remember("self", cfg.cohost.name, text)`; any publisher (cortex, reflex, operator) | `region.ts:35-40` |
| in | `memory.recall.request` | `memory-recall` | `store.recall(query, k)` then publish `memory.recall.reply` | `region.ts:41-49` |
| out | `memory.viewer` | | `{user, isNew, msgCount, notes}`; published before the slow embed so the cortex has it when it builds the reply | `region.ts:23-24` |
| out | `memory.recall.reply` | | `{id, memories:[{ts(epoch ms), kind, who, text, similarity}]}` | `region.ts:44-47` |

Two consumer groups exist so a recall never queues behind the embed plus INSERT
writes (`index.ts:57`). Both are `fromNow: true`, so events published while the
service is down or still starting are never seen (`index.ts:58-59`). Bus handler
errors are caught, logged, and the entry is acked (`packages/bus/src/index.ts:153-159`),
so any exception in this handler (for example `touchViewer` failing) drops that
event rather than retrying it.

### Test injection

`skipInjected` (`region.ts:12`) returns true for `injected === true && remember !== true`.
For `chat.message`, `speech.heard` and `brain.say` an injected, not-remembered event
causes no viewer row, no `memory.viewer`, and no memory row (`region.ts:20,31,37`).
`remember` is ignored on events that are not `injected` (`region.test.ts:83-89`).
`memory.recall.request` has no injection flag and is always served.

### Viewers

Every non-skipped chat line upserts `viewers` keyed by `lower(userId ?? user)`,
incrementing `msg_count` and refreshing `display` and `last_seen`
(`store.ts:102-111`); `isNew` is `msg_count <= 1`. `first_seen` and `last_seen` are
selected but unused. The `notes` column is read and published in `memory.viewer`,
but nothing in the service ever writes it (the only `notes` references are reads,
`store.ts:60,103-110`, `fake-store.ts:26,51-54`). It defaults to empty text.

## Stores and embedders

Factories in `services/memory/src/backend.ts`:

- `createMemoryEmbedder(cfg)`: `brain.memory.embedder === "hash"` gives `HashEmbedder`
  from `@cohost/llm` (no network); anything else gives `new Ollama(cfg.llm)`
  regardless of `llm.provider` (`backend.ts:7-9`). This differs from
  `@cohost/llm`'s own `createEmbedder`, which switches to hash when
  `llm.provider === "mock"` (`packages/llm/src/index.ts:60-63`); memory no longer
  calls `createEmbedder`.
- `createStore(cfg, embedder, log)`: `brain.memory.store === "memory"` gives
  `InMemoryStore`, which ignores the supplied embedder; anything else gives the
  Postgres `MemoryStore` (`backend.ts:12-16`).

Both stores implement `MemoryBackend` (`store.ts:17-26`): `init, remember, recall,
touchViewer, recentSince, getMeta, setMeta, close`. `region.ts:8` still types the
store as `Pick<MemoryStore, ...>`, which either backend satisfies structurally.

### Postgres `MemoryStore` (`store.ts:33-132`)

- Pool: `new pg.Pool({ connectionString: urls.database(), max: 4 })`
  (`store.ts:38`); `DATABASE_URL`, default `postgres://cohost:cohost@127.0.0.1:5432/cohost`
  (`packages/config/src/index.ts:158`). The pool is built in the constructor, so even
  `reflect` and unit tests create one.
- `init()` (`store.ts:41-69`): embeds the literal `"hello"` to learn the vector
  dimension, then `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TABLE IF NOT
  EXISTS` for `memories(id, ts, kind, who, text, embedding vector(dims))`,
  `viewers(user_key PK, display, first_seen, last_seen, msg_count, notes)` and
  `meta(k PK, v)`, then an hnsw cosine index whose failure is only a warning.
  The dimension is therefore frozen when the table is first created; there is no
  check against an existing table (see Open Questions).
- `remember` embeds `"<who>: <text>"` and inserts the pgvector literal `[a,b,...]`
  (`store.ts:71-81`, `toVector` at `store.ts:134`). Kinds: `chat`, `speech`, `self`,
  `note`; the code only ever writes the first three.
- `recall` (`store.ts:83-100`): `k <= 0` returns `[]` with no query; otherwise embeds
  the query and selects `1 - (embedding <=> $1) AS similarity` where `ts < now() -
  interval '2 minutes'` ordered by cosine distance, limit `k`, then filters in JS by
  `similarity >= min_similarity`. The 2-minute exclusion keeps the immediate
  conversation out of "memories". `k` defaults to `brain.memory.recall_k` (default 6;
  `min_similarity` default 0.35, `packages/config/src/schema.ts:141-142`).
- `recentSince(ts, limit=400)` and `getMeta/setMeta` back the reflection job
  (`store.ts:113-127`).

### In-memory `InMemoryStore` (`fake-store.ts`)

Same interface, state in JS arrays and maps, lost on exit. It embeds with its own
`hashEmbed` (`fake-store.ts:7-16`): 64 dims, tokens `[\p{L}\p{N}']+`, FNV-style hash,
unsigned counts, L2-normalised. `@cohost/llm`'s `HashEmbedder` is a second,
different hash embedder (also 64 dims but signed, tokens `[\p{L}\p{N}]+`, 
`packages/llm/src/mock.ts:26-50`); it is used only when `store=postgres` and
`embedder=hash`. `recall` mirrors the SQL semantics: 2-minute cutoff against an
injectable clock, cosine by dot product, sort, top `k`, `min_similarity` filter
(`fake-store.ts:37-47`). `touchViewer` lowercases the key and never returns notes
other than `""`. `recentSince` returns rows in insertion order (`fake-store.ts:57-62`).

## Startup, health and shutdown

Config read: `brain.memory.{store, embedder, recall_k, min_similarity}` (env
overrides `MEMORY_STORE`, `MEMORY_EMBEDDER` via `config/config.example.yaml:109-110`),
`cohost.name`, `cohost.streamer` (reflect), `llm.*` (Ollama client), `DATABASE_URL`,
`HEARTBEAT_INTERVAL_MS` (heartbeat package).

Startup sequence (`index.ts:31-62`):

1. Start the heartbeat immediately (`index.ts:26`): state `starting`.
2. If store or embedder is non-default, warn `mode mock; data is not durable`.
3. If `store=postgres` and `embedder=ollama`: ping Ollama every 3 s forever; each miss
   sets `deps.ollama=down`, success sets `ok` (`index.ts:35-43`). While waiting, the
   heartbeat state stays `starting` (never `degraded`), because `heartbeat.ready()`
   has not been called.
4. If `store=postgres`: `store.init()` with a retry every 3 s; the 21st failure
   rethrows and the process exits 1 (`index.ts:44-53`, `index.ts:66`). Success sets
   `deps.postgres=ok`. Otherwise a single `store.init()` on the fake.
5. Subscribe both groups, call `heartbeat.ready()`, log `memory online`.

Health (`health.ts`): `MemoryHealth` builds the `HeartbeatSpec`. `mode` is `live`
only for postgres plus ollama, else `mock`. `deps.postgres` is `n/a` unless the
store is Postgres; `deps.ollama` is `n/a` unless postgres plus ollama. The embedder
handed to the store is wrapped with `tracked()` so each `embed()` success or failure
sets `deps.ollama` (`health.ts:31-34`), giving `degraded` at runtime when Ollama
stops answering. `deps.postgres` is set once, after `init`, and never again, so a
Postgres outage after startup does not appear in the heartbeat (the store swallows
`remember`/`recall` errors, and `touchViewer` errors surface only in the bus
handler log). Heartbeat contract and `degraded` derivation are owned by the
control-plane segment (`packages/bus/src/heartbeat.ts:66-83`).

Shutdown: `onShutdown` stops the bus then closes the store (`index.ts:67`); the
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
   transcript (`reflect.ts:35-48`).
5. `parseBullets` keeps only lines that start with `- ` after trim
   (`learned.ts:6-8`); none: warn and stop without saving.
6. `appendLearned` adds the `## Learned` heading if the text does not contain that
   string, then a `### YYYY-MM-DD` (UTC) block (`learned.ts:11-19`); the result is
   saved with `savePersonality`, `meta.last_reflection` is set to now, and the block
   is printed.
7. Failures set `process.exitCode = 1`; the store is closed in `finally`
   (`reflect.ts:60-62`).

`recentSince` is `ORDER BY ts ASC LIMIT 600`, so with more than 600 new rows the
oldest 600 are summarised and `last_reflection` still jumps to now (`reflect.ts:27,55`).
The running cortex does not learn of the change until a `reload_personality` control.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where vectors live | Postgres with pgvector, hnsw cosine index | in-process index; dedicated vector DB | `[inferred]` single store for rows, viewers and meta; `store.ts:44-67` |
| Embedder for memory | Always local Ollama unless `embedder=hash` | follow `llm.provider` | `[inferred]` keep vector size independent of the chat model; `packages/config/src/schema.ts:36-37`, `backend.ts:6-9` |
| Vector dimension | Probed from a live embedding at first `init` | fixed constant in config | `[inferred]` adapt to whichever embed model is configured; `store.ts:42-43` |
| Two consumer groups | `memory` (writes) and `memory-recall` | one group | `[inferred]` recall must not wait behind embed plus INSERT; comment at `index.ts:57` |
| Announce viewer before embed | publish `memory.viewer` then `remember` | after | `[inferred]` cortex needs viewer context when it builds the reply; `region.ts:23` |
| Recency exclusion | `ts < now() - 2 minutes` | include everything | `[inferred]` keep the live conversation (already in cortex working memory) out of recalled memories; `store.ts:90`, `fake-store.ts:40` |
| Write error handling | `remember`/`recall` swallow and warn; `touchViewer` does not | throw everywhere | `[inferred]` the show must go on without memory; `store.ts:78-80,96-99` |
| Recall k=0 | Short-circuit with no embed or query | query anyway | `[inferred]` `recall_k: 0` is the documented off switch; `store.ts:84`, `config.example.yaml:111` |
| Isolated backend | Separate in-process store with its own 64-dim hash embedder | reuse `HashEmbedder` inside the fake | `[inferred]` fake needs no async embedder and a different tokenisation; `fake-store.ts:7-16`, comment `backend.ts:14` |
| Mode reporting | `mock` if either store or embedder is non-default | per-dependency mode | `[inferred]` `health.ts:23` |
| Reflection placement | Offline CLI, writes personality file | in-service timer; DB-only learned facts | `[inferred]` "run between streams"; `index.ts:12`, `reflect.ts:1-9` |
| Reflection input cap | Oldest 600 rows since last reflection | newest 600; paginate | `[inferred]` bound the prompt size; cursor handling looks accidental; `reflect.ts:27` |
| Pure text helpers split out | `learned.ts` holds bullet parsing and heading logic | inline in reflect.ts | `[inferred]` `reflect.ts` runs `main()` at import and cannot be unit tested; `learned.ts:1`, `memory.test.ts:8-22` |

## Open Questions & Future Decisions

### Resolved
1. None authored. Everything above is observed, not confirmed by the owner.

### Deferred (observed, unexplained, or technical debt)
1. **Vector dimension is never reconciled.** `CREATE TABLE IF NOT EXISTS` fixes
   `vector(dims)` from the first embedding (`store.ts:45-53`). Switching embed model
   or switching to `embedder=hash` (64 dims, `packages/llm/src/mock.ts:26`) on an
   existing database makes every later `remember`/`recall` fail at the INSERT/SELECT,
   and those errors are swallowed as warnings (`store.ts:78-80,96-99`); health stays
   `ok`. See `MEM-STORE-002`.
2. **`deps.postgres` is write-once.** Set true only after init (`index.ts:46`); no
   later call to `setPostgres` exists. `MEM-HEALTH-005`.
3. **`viewers.notes` is never written** by any code in the repo's services; only read
   and forwarded. Presumably hand-edited in SQL; the cortex surfaces it only for
   viewers with more than 25 messages (cortex `memory.viewer` handling). `MEM-VIEWER-005`.
4. **`index.ts:5-6` header says `memory.viewer` is announced when someone is "new or a
   regular"**, but `region.ts:22-24` publishes it for every mention regardless of
   count or novelty; the cortex does the filtering. Comment or code is stale.
5. **Reflection drops rows beyond 600.** `recentSince(since, 600)` is oldest-first and
   `last_reflection` is set to now (`reflect.ts:27,55`), so later rows are never
   reflected on. The baseline OpenSpec says "(up to 600)" and "set `last_reflection`"
   (`openspec/specs/memory/spec.md`, Requirement "Reflection"), so this matches the
   spec but looks unintended. `MEM-REFLECT-008`.
6. **Reflection needs a reachable embedder** because `init()` embeds `"hello"`
   (`store.ts:43`) even though reflect only reads. It also runs without any lock
   alongside the live service and `learned.ts:17` detects the heading with
   `includes("## Learned")`, which also matches `### Learned...`.
7. **`touchViewer` failure drops the whole chat event.** It has no try/catch
   (`store.ts:102`); the bus logs `handler failed` and acks (`bus/src/index.ts:153-159`),
   so neither `memory.viewer` nor the memory row is produced for that message.
8. **Startup heartbeat state.** While waiting for Ollama or Postgres the state is
   `starting` with dep `down`, not `degraded` (`index.ts:35-53`); the OpenSpec
   "Ollama down" scenario speaks of `degraded`. Only post-ready embedding failures
   produce `degraded`.
9. **Two hash embedders.** `fake-store.ts:hashEmbed` and `@cohost/llm` `HashEmbedder`
   differ in tokenisation and sign handling; both 64 dims. The comment
   `backend.ts:14` ("main's fake") is a merge-history leftover. `config/config.example.yaml:18` still describes the `mock` LLM provider as
   "+ hash embeddings", which memory no longer follows (it reads `brain.memory.embedder`).
   OpenSpec `add-isolated-backends` explicitly accepts the fake's "own bag-of-words hashed vectors".
10. **Kind `note` is declared but never written** (`store.ts:5`).
11. **Recall request validation:** the bus schema makes `k` positive (`events.ts:98-102 (k at 101)`),
    so `k=0` can only occur through config (`recall_k=0`, where the cortex does not
    send a request) even though the store handles it.
12. **Test gaps.** `index.ts` (startup waits, retries, subscription wiring) and
    `reflect.ts` main flow have no tests; the 600 cap, dimension mismatch and Postgres
    outage after startup are untested.

## References

- Code: `services/memory/src/{index,region,store,backend,fake-store,reflect,learned,health}.ts`,
  `services/memory/package.json`, `services/memory/tsconfig.json`
- Tests: `services/memory/test/{backend,fake-store,health,memory,region}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (events `chat.message`, `speech.heard`, `brain.say`,
  `memory.*`, `Bus.subscribe/publish`), config (`loadConfig`, `urls.database`,
  `loadPersonality/savePersonality`, `brain.memory.*`), model-backends (`Ollama`,
  `HashEmbedder`, `createChatProvider`), control-plane (heartbeat contract,
  `startHeartbeat`, `tracked`)
- Depended on by: cortex (sends `memory.recall.request`, consumes `memory.recall.reply`
  and `memory.viewer`), dashboard (test injection of chat and speech reaches memory
  with `injected`/`remember` flags), deployment (compose service `memory`, reflect
  invocation)
- External: PostgreSQL with the pgvector extension (`pg` ^8.13), Ollama embeddings, Redis streams
- OpenSpec: `openspec/specs/memory/spec.md`; deltas
  `openspec/changes/archive/2026-11-01-add-service-health/specs/memory/spec.md`,
  `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/memory/spec.md`,
  `openspec/changes/archive/2026-11-01-add-test-injection/specs/memory/spec.md`
