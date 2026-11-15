# Arrow: memory

The hippocampus region: the only service that touches Postgres/pgvector. Stores embedded exchanges and viewer records, answers recall requests over the bus, announces viewer familiarity, and ships the offline `reflect` CLI that folds memories into `personality.md`.

## Status

**AUDITED** — 129 specs: 129 implemented (`[x]`), 0 gaps (`[ ]`), 0 deferred (`[D]`). Retired: `MEM-VIEWER-004` and `MEM-VIEWER-005`; numbers are not reused. Design: the LLD, including its Viewer notes sections and edge cases.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/memory/memory-design.md

### EARS
- docs/intent/memory/memory-specs.md (129 specs, prefix `MEM`: 129 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- services/memory/test/admin.test.ts
- services/memory/test/backend.test.ts
- services/memory/test/capture.test.ts
- services/memory/test/consolidate-run.test.ts
- services/memory/test/consolidation.test.ts
- services/memory/test/fake-store.test.ts
- services/memory/test/health.test.ts
- services/memory/test/main.test.ts
- services/memory/test/memory.test.ts
- services/memory/test/notes-store.pg.test.ts
- services/memory/test/notes.test.ts
- services/memory/test/reembed.test.ts
- services/memory/test/reflect.test.ts
- services/memory/test/region.test.ts
- services/memory/test/scheduler.test.ts
- services/memory/test/startup.test.ts
- services/memory/test/store-contract.ts (the shared store behaviour, run by `notes-store.test.ts` on the in-memory store and by `notes-store.pg.test.ts` on a real Postgres when `COHOST_TEST_DATABASE_URL` is set)
- services/memory/test/surface.test.ts
- packages/bus/test/resilience.test.ts

### Code
- services/memory/src/admin.ts
- services/memory/src/backend.ts
- services/memory/src/capture.ts
- services/memory/src/consolidate-run.ts
- services/memory/src/consolidate.ts
- services/memory/src/consolidation.ts
- services/memory/src/consolidator.ts
- services/memory/src/cursor.ts
- services/memory/src/fake-store.ts
- services/memory/src/health.ts
- services/memory/src/learned.ts
- services/memory/src/main.ts
- services/memory/src/notes.ts
- services/memory/src/reembed-run.ts
- services/memory/src/reembed.ts
- services/memory/src/reflect-run.ts
- services/memory/src/reflect.ts
- services/memory/src/region.ts
- services/memory/src/scheduler.ts
- services/memory/src/startup.ts
- services/memory/src/store.ts
- services/memory/src/surface.ts
- services/memory/package.json
- services/memory/tsconfig.json

## Architecture

**Purpose:** Persist what happened on stream (addressed chat, speech, the co-host's own lines) as embeddings, serve similarity recall to the cortex, track viewers, and consolidate memories into the personality file between streams.

**Key Components:**
1. `region.ts` — event handler shared by the `memory` (writes) and `memory-recall` (reads) consumer groups; injection filtering via `skipInjected`. The third group, `memory-notes`, has its own handler in `capture.ts`.
2. `store.ts` — Postgres/pgvector `MemoryStore` (tables `memories`, `viewers`, `viewer_notes`, `viewer_note_deletions`, `viewer_links`, `meta`; 2-minute recency exclusion; `min_similarity` filter; per-viewer note commits guarded by note versions; an advisory lock for consolidation) and the `MemoryBackend` interface.
3. `fake-store.ts` + `backend.ts` — in-process `InMemoryStore` (it keeps viewer notes, deletion records and the regular and subscriber flags too, and embeds with `@cohost/llm`'s `HashEmbedder`); config-driven store and embedder factories.
4. `health.ts` — dependency tracker (`postgres`, `ollama`, `n/a` when unused), the notes hooks' `hook.memory.*` dependencies (`attachHooks`) and mode (`live` only for postgres + ollama and no hook on the mock provider).
5. `index.ts` + `startup.ts` — wiring, and the injectable startup sequence (Ollama ping, Postgres init retry with no retry on a dimension mismatch, fatal after the 21st failure, `degraded` while waiting, subscriptions with start mode `resume`, heartbeat).
6. `reflect.ts` + `reflect-run.ts` + `cursor.ts` + `learned.ts` — offline reflection CLI (wiring), the injectable reflection pass, the `(ts, id)` cursor, and the pure text helpers.
7. `notes.ts` — viewer-note types and the shared arithmetic (effective strength, reinforcement, default hints, cosine).
8. `consolidation.ts` + `consolidator.ts` — the consolidation pass (fade, suppression, the `memory.consolidator` hook, versioned per-viewer commit, lock, retention) and the hook's prompt, validation and local-provider rule (`notesHookLlm`).
9. `scheduler.ts` — when a pass runs: dirty threshold, startup catch-up, idle gating from `brain.status`, shutdown flag.
10. `consolidate.ts` + `consolidate-run.ts` — the one-shot `consolidate` command (`pnpm consolidate`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Event handling | MEM-EVT-001 to MEM-EVT-002 | 2 | 0 | 0 | 2 |
| Storing memories | MEM-WRITE-001 to MEM-WRITE-005 | 5 | 0 | 0 | 5 |
| Test injection | MEM-INJ-001 to MEM-INJ-003 | 3 | 0 | 0 | 3 |
| Viewers | MEM-VIEWER-001 to MEM-VIEWER-006 (004, 005 retired) | 4 | 0 | 0 | 4 |
| Recall | MEM-RECALL-001 to MEM-RECALL-006 | 6 | 0 | 0 | 6 |
| Stores and schema | MEM-STORE-001 to MEM-STORE-003 | 3 | 0 | 0 | 3 |
| Re-embedding | MEM-REEMBED-001 to MEM-REEMBED-006 | 6 | 0 | 0 | 6 |
| Backend selection | MEM-BACKEND-001 to MEM-BACKEND-006 | 6 | 0 | 0 | 5 |
| Startup and shutdown | MEM-START-001 to MEM-START-006 | 6 | 0 | 0 | 6 |
| Health | MEM-HEALTH-001 to MEM-HEALTH-009 | 9 | 0 | 0 | 9 |
| Reflection | MEM-REFLECT-001 to MEM-REFLECT-012 | 12 | 0 | 0 | 11 |
| Viewer notes: notes and strength | MEM-NOTE-001 to MEM-NOTE-012 | 12 | 0 | 0 | 12 |
| Viewer notes: regular status and viewer row | MEM-REG-001 to MEM-REG-005 | 5 | 0 | 0 | 5 |
| Viewer notes: live capture | MEM-CAPTURE-001 to MEM-CAPTURE-011 | 11 | 0 | 0 | 11 |
| Viewer notes: consolidation | MEM-CONSOL-001 to MEM-CONSOL-017 | 17 | 0 | 0 | 17 |
| Viewer notes: surfacing to the cortex | MEM-SURF-001 to MEM-SURF-005 | 5 | 0 | 0 | 5 |
| Viewer notes: owner operations | MEM-ADMIN-001 to MEM-ADMIN-007 | 7 | 0 | 0 | 7 |
| Viewer notes: voice speakers | MEM-VOICE-001 to MEM-VOICE-010 | 10 | 0 | 0 | 9 |

**Summary:** 129 of 129 specs implemented; 0 deferred; 0 gaps. 126 carry a test `@spec` annotation; implemented without one: MEM-BACKEND-002, MEM-REFLECT-009, MEM-VOICE-010 (verified by glue, configuration or a test that cites a neighbouring ID).

## Key Findings

1. **Viewer counts agree across stores** — the Postgres INSERT sets `msg_count` 1, as the fake counts from 1; the insert SQL is asserted in `memory.test.ts` (`MEM-VIEWER-001`).
2. **Vector dimension is checked** — `init` reads `atttypmod` of `memories.embedding` and throws `DimensionMismatchError` on a mismatch; `startup.ts` rethrows it without retrying, so the service exits through `MEM-START-006` (`MEM-STORE-002`). Migrating a table to a new dimension is the `reembed` one-shot (`MEM-REEMBED-001` to `006`).
3. **`deps.postgres` follows the latest query** — every pool query goes through `MemoryStore.query`, which reports to `health.setPostgres` (`MEM-HEALTH-005`).
4. **Reflection reads a `(ts, id)` cursor** — `meta.last_reflection` is `<ISO ts>#<id>` of the newest row read (`cursor.ts`, `reflect-run.ts`); `recentSince` reads `WHERE (ts, id) > ($1, $2) ORDER BY ts, id`; fewer than 5 rows leave the cursor alone. `reflect` connects without DDL or an embedder call and holds the consolidation lock (`MEM-REFLECT-011`, `MEM-REFLECT-012`). The cursor timestamp is the exact microsecond text from Postgres (`"tsText"`), so no row is re-read (`MEM-REFLECT-008`, `MEM-REFLECT-003`).
5. **Reflect announces the mock backend** — `runReflect` warns once when the chat provider is `mock` (`MEM-REFLECT-010`, `LLM-MOCK-005`).
6. **Restarts replay the backlog, by design** — all three groups (`memory`, `memory-recall`, `memory-notes`) subscribe with `start: "resume"` (asserted in `startup.test.ts`); the manifest default is `resume` (`MEM-EVT-001`).
7. **`ready` waits for every consumer group** — `SubscribeOptions.onReady` fires after a group exists and is positioned; `startup.ts` reports `ready` once all fire (`MEM-START-005`).
8. **A failing viewer upsert does not drop the chat event** — `region.ts` catches, logs a warning, skips `memory.viewer` and still remembers the mention (`MEM-VIEWER-006`).
9. **Startup reports `degraded` while waiting** for Ollama or Postgres (`MEM-HEALTH-007`).
10. **One hash embedder** — `InMemoryStore` and `store=postgres, embedder=hash` both embed with `@cohost/llm`'s `HashEmbedder`; memory does not follow `llm.provider=mock` (LLD Decisions).
11. **Test coverage** — `startup.ts` and `reflect-run.ts` are tested with injected fakes; `index.ts` and `reflect.ts` are wiring only. The store contract and the Postgres-specific checks run against pgvector in CI (`notes-store.pg.test.ts`).

## Work Required

### Must Fix
None.

### Should Fix
None.

### Nice to Have
None.
