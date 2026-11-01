# Arrow: memory

The hippocampus region: the only service that touches Postgres/pgvector. Stores embedded exchanges and viewer records, answers recall requests over the bus, announces viewer familiarity, and ships the offline `reflect` CLI that folds memories into `personality.md`.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet marked audited in `index.yaml`. Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **What should happen when the stored vector size and the embedder disagree?** (`MEM-STORE-002`, known open question, not decided here.) `init` creates `vector(dims)` only if the table is missing and never compares it with the live embedder (`services/memory/src/store.ts:44-55`); afterwards every INSERT and recall fails inside the swallowed `catch` (`store.ts:80-82`, `store.ts:99-102`) while health reports `ok`. The config comment promises the size never changes (`packages/config/src/schema.ts:35-38`). Recommended: fail `init` loudly (so the retry loop ends in exit 1), and leave migration/re-embedding to a separate decision.
2. **Should a viewer's first message count as 1?** The Postgres INSERT leaves `msg_count` at its default 0 (`store.ts:61`, `store.ts:108-109`), so `isNew` is true for two messages and `msgCount` lags by one; the in-memory store counts from 1 (`services/memory/src/fake-store.ts:53-56`), and OpenSpec's "First message" scenario expects `msgCount` 1. Recommended: yes; insert with `msg_count` 1 in a follow-up change.
3. **How should `reflect` handle more than 600 new memories?** It reads the oldest 600 then sets `last_reflection` to now, skipping the rest forever (`services/memory/src/reflect.ts:28`, `reflect.ts:56`; `MEM-REFLECT-008`). Recommended: set `last_reflection` to the timestamp of the last row reflected on.
4. **Is `deps.postgres` meant to track runtime health?** It is set only in the startup init loop (`services/memory/src/index.ts:49`, `index.ts:51`); commit `691b079` noted this at merge, OpenSpec `add-service-health` asks for the last call's outcome (`MEM-HEALTH-005`). Recommended: yes; wrap pool queries with `tracked()` like the embedder.
5. **Who writes `viewers.notes`?** Nothing in the repository does (`store.ts:62`, `store.ts:107-114`); the cortex shows notes only for regulars (`MEM-VIEWER-005`). Recommended: mark `MEM-VIEWER-005` deferred `[D]` until a writer (reflection, dashboard, or hand-edited SQL) is chosen.
6. **Should a failed viewer upsert drop the whole chat event?** `touchViewer` has no `try/catch` (`store.ts:106-115`), so a DB error skips both `memory.viewer` and the memory row (`services/memory/src/region.ts:24-28`); no spec line covers it. Recommended: catch in the handler, log, and still remember the mention.
7. **Should memory replay events published while it was down?** With `fromNow`, an existing group resumes after its last delivered entry (`packages/bus/src/index.ts:126-131`); memory's default start mode is `resume` (`packages/control/src/manifest.ts:42`), so backlog is stored after a restart, while a first-ever start drops pre-subscribe events (`MEM-EVT-001`). Recommended: yes, keep the replay (memory is the durable region) and record it as a decision.
8. **Must reflection insert under `## Learned` when that is not the last section?** `appendLearned` appends at the end of the file (`services/memory/src/learned.ts:18-22`; `MEM-REFLECT-007`); the shipped template ends with `## Learned` (`config/personality.example.md:26`). Recommended: yes, insert at the end of the `## Learned` section; low priority.
9. **Should memory report `degraded` while it waits for Ollama or Postgres at startup?** It stays `starting` with the dependency `down` (`index.ts:37-56`), whereas the cortex calls `heartbeat.degraded()` while waiting. Recommended: yes; call `heartbeat.degraded(detail)` in both wait loops.
10. **Fix the stale comments?** `index.ts:8-10` says `memory.viewer` goes only to new or regular viewers (it goes on every mention, `region.ts:25-27`); `services/memory/src/backend.ts:16` says "main's fake"; `config/config.example.yaml:18` says the mock provider brings hash embeddings, which memory ignores by design (commit `51d5a9c`). Recommended: yes, comment-only changes (the yaml is outside this segment).

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/memory/memory-design.md

### EARS
- docs/intent/memory/memory-specs.md (51 specs, prefix `MEM`: 47 `[x]`, 4 `[ ]`, 0 `[D]`)

### Tests (`@spec` lines per file; 29 lines citing 31 distinct IDs)
- services/memory/test/region.test.ts (8)
- services/memory/test/memory.test.ts (9)
- services/memory/test/backend.test.ts (3)
- services/memory/test/fake-store.test.ts (5)
- services/memory/test/health.test.ts (4)

### Code (`@spec` lines per file; 30 lines citing all 47 implemented IDs)
- services/memory/src/index.ts (6)
- services/memory/src/region.ts (6)
- services/memory/src/store.ts (6)
- services/memory/src/backend.ts (2)
- services/memory/src/fake-store.ts (4)
- services/memory/src/reflect.ts (2)
- services/memory/src/learned.ts (2)
- services/memory/src/health.ts (2)
- services/memory/package.json
- services/memory/tsconfig.json

### OpenSpec (retired, reference only)
- openspec/specs/memory/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/memory/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/memory/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/memory/spec.md

## Architecture

**Purpose:** Persist what happened on stream (addressed chat, speech, the co-host's own lines) as embeddings, serve similarity recall to the cortex, track viewers, and consolidate memories into the personality file between streams.

**Key Components:**
1. `region.ts` — event handler shared by two consumer groups (`memory` writes, `memory-recall` reads); injection filtering via `skipInjected`.
2. `store.ts` — Postgres/pgvector `MemoryStore` (tables `memories`, `viewers`, `meta`; 2-minute recency exclusion; `min_similarity` filter) and the `MemoryBackend` interface.
3. `fake-store.ts` + `backend.ts` — in-process `InMemoryStore` with its own 64-dim hash embedder; config-driven store and embedder factories.
4. `health.ts` — dependency tracker (`postgres`, `ollama`, `n/a` when unused) and mode (`live` only for postgres + ollama).
5. `index.ts` — startup waits (Ollama ping, Postgres init retry, fatal after the 21st failure), subscriptions, heartbeat.
6. `reflect.ts` + `learned.ts` — offline reflection CLI and its pure text helpers.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Tested |
|----------|----------|-------------|----------|------|--------|
| Event handling | MEM-EVT-001 to MEM-EVT-002 | 2 | 0 | 0 | 1 |
| Storing memories | MEM-WRITE-001 to MEM-WRITE-005 | 5 | 0 | 0 | 5 |
| Test injection | MEM-INJ-001 to MEM-INJ-003 | 3 | 0 | 0 | 3 |
| Viewers | MEM-VIEWER-001 to MEM-VIEWER-005 | 4 | 0 | 1 | 4 |
| Recall | MEM-RECALL-001 to MEM-RECALL-006 | 6 | 0 | 0 | 6 |
| Stores and schema | MEM-STORE-001 to MEM-STORE-003 | 2 | 0 | 1 | 2 |
| Backend selection | MEM-BACKEND-001 to MEM-BACKEND-006 | 6 | 0 | 0 | 5 |
| Startup and shutdown | MEM-START-001 to MEM-START-006 | 6 | 0 | 0 | 0 |
| Health | MEM-HEALTH-001 to MEM-HEALTH-006 | 5 | 0 | 1 | 3 |
| Reflection | MEM-REFLECT-001 to MEM-REFLECT-009 | 8 | 0 | 1 | 2 |

**Summary:** 47 of 51 specs implemented and annotated in code; 0 deferred; 4 gaps (`MEM-VIEWER-005`, `MEM-STORE-002`, `MEM-HEALTH-005`, `MEM-REFLECT-008`). 31 of the 47 implemented specs have a test annotated with `@spec`; the 16 without one are `MEM-EVT-001`, `MEM-BACKEND-002`, `MEM-START-001` to `MEM-START-006`, `MEM-HEALTH-004`, `MEM-HEALTH-006`, `MEM-REFLECT-001` to `MEM-REFLECT-004`, `MEM-REFLECT-006` and `MEM-REFLECT-009` (all in `index.ts` wiring or the `reflect.ts` main flow, which runs at import). No `@spec` annotation cites a missing ID.

## Key Findings

1. **Markers verified, none flipped** — every `[x]` line has implementing code, and the four `[ ]` gaps are confirmed absent in code (`store.ts:46-55`, `index.ts:49`, `reflect.ts:28,56`, no `notes` writer).
2. **Spec lines corrected to match the code** — `MEM-EVT-001` (`fromNow` only applies when a group is created, `packages/bus/src/index.ts:126-131`), `MEM-VIEWER-001` (Postgres rows start at `msg_count` 0, `store.ts:61,108`), `MEM-REFLECT-007` (block appended at end of file, `learned.ts:18-22`), and test references for `MEM-HEALTH-004` (no test exercises the init→`ok` wiring). LLD Open Questions 13 to 15 record that the earlier wording may have been the intent.
3. **New spec lines for observed behaviour** — `MEM-BACKEND-006` (in-memory `meta`/`recentSince`, `fake-store.ts:60-69`), `MEM-START-006` (fatal exit and shutdown order, `index.ts:72-73`), `MEM-HEALTH-006` (`deps.postgres` down during init retries, `index.ts:51`), `MEM-REFLECT-009` (`reflect failed`, exit code 1, store closed, `reflect.ts:62-64`).
4. **Postgres and in-memory stores disagree on viewer counts** — Postgres reports `msgCount` 0 then 1 for a viewer's first two messages, both `isNew` (`store.ts:61,108-109,114`); the fake reports 1 then 2 (`fake-store.ts:53-56`). The unit test's fake pool returns `msg_count` 1 (`services/memory/test/memory.test.ts:110-111`), so the divergence is untested. Question 2.
5. **Vector dimension is fixed and unchecked** — `CREATE TABLE IF NOT EXISTS memories (... embedding vector(dims))` (`store.ts:46-54`) with no comparison to an existing table. Changing embed model, or `embedder=hash` (64 dims) on a database created with Ollama vectors, makes every `remember`/`recall` fail, both swallow the error as a warning (`store.ts:80-82`, `store.ts:99-102`), and health stays `ok`. Question 1.
6. **`deps.postgres` is startup-only** — `setPostgres` is called only in the init loop (`index.ts:49,51`); commit `691b079` review notes state "memory `postgres` only flips on init". Only `ollama` is live-tracked via `tracked()` (`health.ts:33-36`). Question 4.
7. **Reflection loses rows past 600** — `recentSince(since, 600)` returns the oldest 600 (`store.ts:118-124`) and `last_reflection` is then set to now (`reflect.ts:28,56`). Reflection also needs a reachable embedder because `init()` embeds `"hello"` (`store.ts:44`), and takes no lock against the live service. Question 3.
8. **`viewers.notes` has no writer** — read and forwarded in `memory.viewer` (`store.ts:107-114`, `region.ts:27`) but never written anywhere; cortex surfaces it only for viewers above 25 messages. Question 5.
9. **Restarts replay the backlog** — both groups resume after downtime (default start mode `resume`, `packages/control/src/manifest.ts:42`); `ready()` is reported before the un-awaited subscriptions have created the groups (`index.ts:63-65`). Question 7.
10. **A failing viewer upsert drops the chat event** — `touchViewer` has no `try/catch` (`store.ts:106-115`); the bus logs and acks (`packages/bus/src/index.ts:153-159`), so neither `memory.viewer` nor the memory row is produced. Question 6.
11. **Two hash embedders** — `fake-store.ts:7-16` (unsigned, tokens include apostrophes, zero vector for empty text) vs `packages/llm/src/mock.ts:39-50` (signed, fixed unit vector for empty text). `backend.ts:8-10` uses the llm one only for `store=postgres, embedder=hash`; the fake ignores the supplied embedder. Memory deliberately does not follow `llm.provider=mock` (commit `51d5a9c`).
12. **Startup heartbeat stays `starting`, not `degraded`, while waiting** for Ollama or Postgres (`index.ts:37-56`; `ready()` only at `index.ts:65`). Question 9.
13. **Decision rationale** — 8 of the 14 LLD decision rows cite the code comment or commit that states their rationale (`969f6d7`, `51d5a9c`, `719ce5a`, `95afa19`, comments at `store.ts:43`, `index.ts:12,62`, `region.ts:26`, `reflect.ts:1-9`, `config/config.example.yaml:111`); 6 remain `[inferred]` (where vectors live, recency exclusion, write error handling, isolated backend, mode reporting, reflection input cap).
14. **Test gaps** — `index.ts` wiring/retries and the `reflect.ts` main flow are untested (16 implemented specs, see Summary); `learned.ts` exists so the pure part is testable (commit `95afa19`).

## Work Required

### Must Fix
1. Decide and implement vector-dimension handling at `init` (`MEM-STORE-002`, question 1).
2. Make `reflect` not discard rows beyond the 600 cap (`MEM-REFLECT-008`, question 3).
3. Decide the Postgres viewer count (question 2) and align `MEM-VIEWER-001`/`MEM-VIEWER-003`, the store and a test that covers the insert path.

### Should Fix
4. Track Postgres health on every query so a post-startup outage shows as `degraded` (`MEM-HEALTH-005`).
5. Decide who writes `viewers.notes` and implement, or defer (`MEM-VIEWER-005`).
6. Decide `touchViewer` failure handling (question 6) and add a spec line for it.
7. Add tests for `index.ts` startup retry/ordering and the `reflect` main flow (`MEM-START-*`, `MEM-REFLECT-001` to `MEM-REFLECT-004`, `MEM-REFLECT-006`, `MEM-REFLECT-009`).

### Nice to Have
8. Consolidate the two hash embedders or record why the fake keeps its own.
9. Fix the stale comments (question 10).
10. Report `degraded` with a detail while waiting for Ollama/Postgres at startup (question 9).
