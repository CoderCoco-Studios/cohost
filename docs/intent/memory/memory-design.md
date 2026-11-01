---
parent: high-level-design
prefix: MEM
---

# memory

Brownfield: this document describes what the code does today, audited against
the code on 2026-11-01. A rationale cell marked `[inferred]` is read from the
code and not confirmed by the owner; any other rationale cell cites the code
comment or commit message that states it.

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
  `pause`, `resume`, `mute` or `forget_context` addressed to it have no effect.
- Writes are best effort. The Postgres `remember` and `recall` swallow errors and
  log a warning (`store.ts:80-82`, `store.ts:99-102`); the cortex tolerates a
  missing or slow memory by timing out (see the cortex segment).
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
writes (`index.ts:62`). Both subscribe with `fromNow: true` (`index.ts:63-64`).
In the bus, `fromNow` only sets where a group starts when the subscription
creates it (`XGROUP CREATE ... $`); a group that already exists resumes after its
last delivered entry (`packages/bus/src/index.ts:17-22`, `126-131`). So:

- on the very first start (no groups yet), events published before the groups are
  created are never seen;
- on any later start the service receives everything published while it was
  down, up to the stream's approximate 20 000-entry cap
  (`packages/bus/src/index.ts:9`), and stores it. Memory's default start mode in
  the control-plane manifest is `resume` (`packages/control/src/manifest.ts:42`);
  a `fresh` start resets both groups to `$` first.

The subscriptions are started with `void` and not awaited, so `heartbeat.ready()`
(`index.ts:65`) can be reported before Redis has created the groups.

Bus handler errors are caught, logged, and the entry is acked
(`packages/bus/src/index.ts:153-159`), so any exception in this handler (for
example `touchViewer` failing) drops that event rather than retrying it.

### Test injection

`skipInjected` (`region.ts:13`) returns true for `injected === true && remember !== true`.
For `chat.message`, `speech.heard` and `brain.say` an injected, not-remembered event
causes no viewer row, no `memory.viewer`, and no memory row (`region.ts:23,35,42`).
`remember` is ignored on events that are not `injected` (`region.test.ts:91-97`).
`memory.recall.request` has no injection flag and is always served.

### Viewers

Every non-skipped chat line upserts `viewers` keyed by `lower(userId ?? user)`
(`store.ts:106-115`). The INSERT names only `user_key` and `display`, so a new row
takes the column default `msg_count` 0 (`store.ts:61`, `store.ts:108`); on conflict
the row's `display` is replaced, `last_seen` refreshed and `msg_count` incremented
(`store.ts:109`). `isNew` is `msg_count <= 1` (`store.ts:114`). With the Postgres
store a viewer's first message therefore reports `msgCount` 0 and the second 1, and
both report `isNew: true`; `msgCount` is one less than the number of messages seen.
The in-memory store counts from 1 (`fake-store.ts:53-56`), so only the first message
is new there. `first_seen` and `last_seen` are selected but unused.

The `notes` column is read and published in `memory.viewer`, but nothing in the
repository writes it (the only `notes` references are reads, `store.ts:62,107-114`,
`fake-store.ts:26,53-56`). It defaults to empty text (`store.ts:62`).

## Stores and embedders

Factories in `services/memory/src/backend.ts`:

- `createMemoryEmbedder(cfg)`: `brain.memory.embedder === "hash"` gives `HashEmbedder`
  from `@cohost/llm` (no network); anything else gives `new Ollama(cfg.llm)`
  regardless of `llm.provider` (`backend.ts:8-10`). This differs from
  `@cohost/llm`'s own `createEmbedder`, which switches to hash when
  `llm.provider === "mock"` (`packages/llm/src/index.ts:60-63`); memory does not
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
  The dimension is therefore fixed when the table is first created; there is no
  check against an existing table (see Open Questions, item 1).
- `remember` embeds `"<who>: <text>"` and inserts the pgvector literal `[a,b,...]`
  (`store.ts:73-83`, `toVector` at `store.ts:140`). Kinds: `chat`, `speech`, `self`,
  `note`; the code only ever writes the first three.
- `recall` (`store.ts:86-103`): `k <= 0` returns `[]` with no query; otherwise embeds
  the query and selects `1 - (embedding <=> $1) AS similarity` where `ts < now() -
  interval '2 minutes'` ordered by cosine distance, limit `k`, then filters in JS by
  `similarity >= min_similarity`. The 2-minute exclusion keeps the immediate
  conversation out of "memories". `k` defaults to `brain.memory.recall_k` (default 6;
  `min_similarity` default 0.35, `packages/config/src/schema.ts:141-142`).
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
   heartbeat state stays `starting` (never `degraded`), because `heartbeat.ready()`
   has not been called and memory never calls `heartbeat.degraded()`.
4. If `store=postgres`: `store.init()` with a retry every 3 s; each failure sets
   `deps.postgres=down`, success sets `ok`, and the 21st failure rethrows so the
   process logs `fatal` and exits 1 (`index.ts:47-56`, `index.ts:72`). Otherwise a
   single `store.init()` on the fake (`index.ts:59`).
5. Start both subscriptions (not awaited), call `heartbeat.ready()`, log `memory online`.

Health (`health.ts`): `MemoryHealth` builds the `HeartbeatSpec`. `mode` is `live`
only for postgres plus ollama, else `mock`. `deps.postgres` is `n/a` unless the
store is Postgres; `deps.ollama` is `n/a` unless postgres plus ollama. The embedder
handed to the store is wrapped with `tracked()` so each `embed()` success or failure
sets `deps.ollama` (`health.ts:33-36`), giving `degraded` at runtime when Ollama
stops answering. `deps.postgres` is set only during the startup init loop
(`index.ts:49,51`), so a Postgres outage after startup does not appear in the
heartbeat (the store swallows `remember`/`recall` errors, and `touchViewer` errors
surface only in the bus handler log). Heartbeat contract and `degraded` derivation
are owned by the control-plane segment (`packages/bus/src/heartbeat.ts:66-83`).

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
6. `appendLearned` (`learned.ts:18-22`) appends the `### YYYY-MM-DD` (UTC) block at
   the end of the trimmed personality text, first adding a `## Learned` heading
   when the text does not contain the string `## Learned`. The block lands under
   `## Learned` only when that is the last section; the shipped template ends with
   it (`config/personality.example.md:26`). The result is saved with
   `savePersonality`, `meta.last_reflection` is set to now, and the block is printed
   (`reflect.ts:54-58`).
7. Failures (including an unreachable embedder at `init`) log `reflect failed` and
   set `process.exitCode = 1`; the store is closed in `finally` (`reflect.ts:62-64`).

`recentSince` is `ORDER BY ts ASC LIMIT 600`, so with more than 600 new rows the
oldest 600 are summarised and `last_reflection` still jumps to now (`reflect.ts:28,56`).
The running cortex does not learn of the change until a `reload_personality` control.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where vectors live | Postgres with pgvector, hnsw cosine index | in-process index; dedicated vector DB | `[inferred]` single store for rows, viewers and meta; `store.ts:45-68` |
| Embedder for memory | Always local Ollama unless `embedder=hash` | follow `llm.provider` | Keeps the vector size independent of the chat model: commit `969f6d7` ("Embeddings always come from local Ollama so the memory table's vector size is independent of the chat model"), `packages/config/src/schema.ts:35-38`. Not following `llm.provider: mock` is deliberate, "avoids silent offline" (commit `51d5a9c` review notes). |
| Vector dimension | Probed from a live embedding at first `init` | fixed constant in config | Comment `store.ts:43`: "Probe embedding size so the table matches whatever model is configured." |
| Two consumer groups | `memory` (writes) and `memory-recall` | one group | Comment `index.ts:62`: "so a recall never queues behind the (embed + INSERT) writes." |
| Announce viewer before embed | publish `memory.viewer` then `remember` | after | Comment `region.ts:26`: "before the slow embed so the cortex has it when the reply is built." |
| Recency exclusion | `ts < now() - 2 minutes` | include everything | `[inferred]` keep the live conversation (already in cortex working memory) out of recalled memories; `store.ts:93`, `fake-store.ts:41` |
| Write error handling | `remember`/`recall` swallow and warn; `touchViewer` does not | throw everywhere | `[inferred]` the show must go on without memory; `store.ts:80-82,99-102` |
| Recall k=0 | Short-circuit with no embed or query | query anyway | `config/config.example.yaml:111` documents `recall_k: 0` as "disables recall"; `store.ts:87`, `fake-store.ts:39` |
| Isolated backend | Separate in-process store with its own 64-dim hash embedder | reuse `HashEmbedder` inside the fake | `[inferred]` the fake needs no async embedder; the fake store (commit `719ce5a`) predates `HashEmbedder` (commit `51d5a9c`), and OpenSpec `add-isolated-backends` accepts the fake's "own bag-of-words hashed vectors"; `fake-store.ts:7-16`, comment `backend.ts:16` |
| Reflection with the in-memory store | Logged no-op | reflect over the fake | Commit `719ce5a`: "`reflect` still uses the Postgres store (it runs in a separate process, so a fake would be empty)"; `reflect.ts:22-25` |
| Mode reporting | `mock` if either store or embedder is non-default | per-dependency mode | `[inferred]` rule stated in `health.ts:7-11` and OpenSpec memory § Isolation preset and mode, reason not stated; `health.ts:24` |
| Reflection placement | Offline CLI, writes personality file | in-service timer; DB-only learned facts | Comments `index.ts:12` ("Consolidation (\"sleep\") is reflect.ts, run between streams") and `reflect.ts:1-9` ("This is how the personality drifts over time instead of resetting every stream. Edit the file by hand whenever you like.") |
| Reflection input cap | Oldest 600 rows since last reflection | newest 600; paginate | `[inferred]` bound the prompt size; cursor handling looks accidental; `reflect.ts:28` |
| Pure text helpers split out | `learned.ts` holds bullet parsing and heading logic | inline in reflect.ts | Extracted so the reflection logic could be tested (`reflect.ts` runs `main()` at import): commit `95afa19` ("reflection merge logic (extracted from reflect.ts into learned.ts, behaviour unchanged)"), `learned.ts:1` |

## Open Questions & Future Decisions

### Resolved
1. None authored. Rationale cells that cite a comment or commit are settled by that
   source; everything marked `[inferred]` is unconfirmed.

### Deferred (observed, unexplained, or technical debt)
1. **Vector dimension is never reconciled (open; not decided here).**
   `CREATE TABLE IF NOT EXISTS` fixes `vector(dims)` from the first embedding
   (`store.ts:46-54`); `dims` is held in memory only (`store.ts:35,44`) and never
   compared with the existing column. Switching embed model, or switching to
   `embedder=hash` (64 dims, `packages/llm/src/mock.ts:26`) on a database created
   with Ollama vectors, makes every later `remember` INSERT and `recall` query fail
   in pgvector, and both errors are swallowed as warnings (`store.ts:80-82,99-102`);
   `deps.postgres` stays `ok` and `deps.ollama` stays `ok` because the embed itself
   succeeded. The config comment states the intent that the size never changes
   (`packages/config/src/schema.ts:35-38`), but nothing enforces it. Possible
   behaviours (fail `init`, report degraded, migrate or re-embed, one table per
   model) are undecided. `MEM-STORE-002`.
2. **`deps.postgres` is only set during startup init.** `setPostgres` is called only
   in the init loop (`index.ts:49,51`). Known when the heartbeat landed: commit
   `691b079` review notes say "memory `postgres` only flips on init". OpenSpec
   `add-service-health` asks for `ok`/`down` "according to the last successful
   connection or embedding call". `MEM-HEALTH-005`.
3. **`viewers.notes` is never written** by any code in the repository; only read
   and forwarded. Presumably hand-edited in SQL; the cortex surfaces it only for
   viewers with more than 25 messages (cortex `memory.viewer` handling). `MEM-VIEWER-005`.
4. **`index.ts:8-10` header says `memory.viewer` is announced when someone is "new or a
   regular"**, but `region.ts:25-27` publishes it for every mention regardless of
   count or novelty; the cortex does the filtering. The comment is stale.
5. **Reflection drops rows beyond 600.** `recentSince(since, 600)` is oldest-first and
   `last_reflection` is set to now (`reflect.ts:28,56`), so later rows are never
   reflected on. The baseline OpenSpec says "(up to 600)" and "set `last_reflection`"
   (`openspec/specs/memory/spec.md`, Requirement "Reflection"), so this matches that
   text but looks unintended. `MEM-REFLECT-008`.
6. **Reflection needs a reachable embedder** because `init()` embeds `"hello"`
   (`store.ts:44`) even though reflect only reads. It also runs without any lock
   alongside the live service, and `learned.ts:19` detects the heading with
   `includes("## Learned")`, which also matches `### Learned...`.
7. **`touchViewer` failure drops the whole chat event.** It has no try/catch
   (`store.ts:106-115`); the bus logs `handler failed` and acks
   (`packages/bus/src/index.ts:153-159`), so neither `memory.viewer` nor the memory
   row is produced for that message. No spec line covers this failure mode.
8. **Startup heartbeat state.** While waiting for Ollama or Postgres the state is
   `starting` with the dependency `down`, not `degraded` (`index.ts:37-56`); the
   OpenSpec "Ollama down" scenario speaks of `degraded`, and the cortex reports
   `degraded` while it waits for its backend. Only post-ready embedding failures
   produce `degraded` here.
9. **Two hash embedders.** `fake-store.ts:hashEmbed` and `@cohost/llm` `HashEmbedder`
   differ in tokenisation, sign handling and empty-text output; both 64 dims. The
   comment `backend.ts:16` ("main's fake") refers to the fake store landing on
   `main` before the isolated-backends work (commit `719ce5a`) and reads as stale.
   `config/config.example.yaml:18` describes the `mock` LLM provider as "+ hash
   embeddings", which memory does not follow (it reads `brain.memory.embedder`;
   commit `51d5a9c` calls this deliberate).
10. **Kind `note` is declared but never written** (`store.ts:5`).
11. **Recall request validation:** the bus schema makes `k` positive (`events.ts:98-102 (k at 101)`),
    so `k=0` can only occur through config (`recall_k=0`, where the cortex does not
    send a request) even though the store handles it.
12. **Test gaps.** `index.ts` (startup waits, retries, subscription wiring) and the
    `reflect.ts` main flow have no tests; the 600 cap, dimension mismatch, the
    Postgres insert-at-0 viewer count and a Postgres outage after startup are
    untested.
13. **Postgres viewer count starts at 0.** `MEM-VIEWER-001` describes the code: a new
    row keeps `msg_count` 0 (`store.ts:61,108`), so with Postgres a viewer is `isNew`
    for two messages and `msgCount` lags the true count by one, while the in-memory
    store counts from 1 (`fake-store.ts:53-56`). The earlier wording ("incrementing
    `msg_count`") and the OpenSpec scenario "First message ... `isNew` true and
    `msgCount` 1" may describe the intended behaviour. The unit test's fake pool
    returns `msg_count` 1 (`memory.test.ts:110-111`), so the two stores' divergence is
    not caught.
14. **Reflection appends at the end of the file.** `MEM-REFLECT-007` describes the
    code (`learned.ts:18-22`). The earlier wording ("under the `## Learned` heading")
    and OpenSpec ("in the `## Learned` section") may describe the intended behaviour
    for a personality file whose last section is not `## Learned`.
15. **Restarts replay the backlog.** `MEM-EVT-001` describes `fromNow` as the bus
    implements it (`packages/bus/src/index.ts:126-131`): after downtime the memory
    groups resume and store everything published meanwhile, while a first-ever start
    loses events published before the groups exist. The earlier wording ("start from
    new events only") may describe the intended behaviour; whether memory should
    replay is not stated anywhere.

## References

- Code: `services/memory/src/{index,region,store,backend,fake-store,reflect,learned,health}.ts`,
  `services/memory/package.json`, `services/memory/tsconfig.json`
- Tests: `services/memory/test/{backend,fake-store,health,memory,region}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (events `chat.message`, `speech.heard`, `brain.say`,
  `memory.*`, `Bus.subscribe/publish`, `fromNow` group semantics), config
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
