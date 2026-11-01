# Arrow: memory

The hippocampus region: the only service that touches Postgres/pgvector. Stores embedded exchanges and viewer records, answers recall requests over the bus, announces viewer familiarity, and ships the offline `reflect` CLI that folds memories into `personality.md`.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/memory/memory-design.md

### EARS
- docs/intent/memory/memory-specs.md (47 specs, prefix `MEM`)

### Tests
- services/memory/test/region.test.ts
- services/memory/test/memory.test.ts
- services/memory/test/backend.test.ts
- services/memory/test/fake-store.test.ts
- services/memory/test/health.test.ts

### Code
- services/memory/src/index.ts
- services/memory/src/region.ts
- services/memory/src/store.ts
- services/memory/src/backend.ts
- services/memory/src/fake-store.ts
- services/memory/src/reflect.ts
- services/memory/src/learned.ts
- services/memory/src/health.ts
- services/memory/package.json
- services/memory/tsconfig.json

### OpenSpec
- openspec/specs/memory/spec.md
- openspec/changes/add-service-health/specs/memory/spec.md
- openspec/changes/add-isolated-backends/specs/memory/spec.md
- openspec/changes/add-test-injection/specs/memory/spec.md

## Architecture

**Purpose:** Persist what happened on stream (addressed chat, speech, the co-host's own lines) as embeddings, serve similarity recall to the cortex, track viewers, and consolidate memories into the personality file between streams.

**Key Components:**
1. `region.ts` — event handler shared by two consumer groups (`memory` writes, `memory-recall` reads); injection filtering via `skipInjected`.
2. `store.ts` — Postgres/pgvector `MemoryStore` (tables `memories`, `viewers`, `meta`; 2-minute recency exclusion; `min_similarity` filter) and the `MemoryBackend` interface.
3. `fake-store.ts` + `backend.ts` — in-process `InMemoryStore` with its own 64-dim hash embedder; config-driven store and embedder factories.
4. `health.ts` — dependency tracker (`postgres`, `ollama`, `n/a` when unused) and mode (`live` only for postgres + ollama).
5. `index.ts` — startup waits (Ollama ping, Postgres init retry x20), subscriptions, heartbeat.
6. `reflect.ts` + `learned.ts` — offline reflection CLI and its pure text helpers.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Event handling | MEM-EVT-001 to MEM-EVT-002 | 2 | 0 | 0 |
| Storing memories | MEM-WRITE-001 to MEM-WRITE-005 | 5 | 0 | 0 |
| Test injection | MEM-INJ-001 to MEM-INJ-003 | 3 | 0 | 0 |
| Viewers | MEM-VIEWER-001 to MEM-VIEWER-005 | 4 | 0 | 1 |
| Recall | MEM-RECALL-001 to MEM-RECALL-006 | 6 | 0 | 0 |
| Stores and schema | MEM-STORE-001 to MEM-STORE-003 | 2 | 0 | 1 |
| Backend selection | MEM-BACKEND-001 to MEM-BACKEND-005 | 5 | 0 | 0 |
| Startup and shutdown | MEM-START-001 to MEM-START-005 | 5 | 0 | 0 |
| Health | MEM-HEALTH-001 to MEM-HEALTH-005 | 4 | 0 | 1 |
| Reflection | MEM-REFLECT-001 to MEM-REFLECT-008 | 7 | 0 | 1 |

**Summary:** 43 of 47 specs observed working; 0 deferred; 4 gaps (`MEM-VIEWER-005`, `MEM-STORE-002`, `MEM-HEALTH-005`, `MEM-REFLECT-008`).

## Key Findings

1. **Vector dimension is frozen and unchecked** — `CREATE TABLE IF NOT EXISTS memories (... embedding vector(dims))` (services/memory/src/store.ts:45-53) with no comparison to an existing table. Changing embed model, or using `embedder=hash` (64 dims) on a database created with Ollama vectors, makes every `remember`/`recall` fail, and both swallow the error as a warning (store.ts:78-80, 96-99) while health stays `ok`.
2. **`deps.postgres` is set once** — only `index.ts:46` calls `setPostgres`; no runtime outage detection (services/memory/src/health.ts:29). Only `ollama` is live-tracked via `tracked()` (health.ts:31-34). OpenSpec `add-service-health` says `ok`/`down` follows the last connection or embedding call.
3. **Reflection loses rows past 600** — `recentSince(since, 600)` returns the oldest 600 (store.ts:115) and `last_reflection` is then set to now (services/memory/src/reflect.ts:27,55). Matches the OpenSpec wording but looks unintended. Reflection also requires a reachable embedder because `init()` embeds `"hello"` (store.ts:43) and takes no lock against the live service.
4. **`viewers.notes` has no writer** — read and forwarded in `memory.viewer` (store.ts:103-110, region.ts:24) but never written anywhere; cortex surfaces it only for viewers above 25 messages. `[inferred]` hand-edited in SQL.
5. **Two hash embedders** — `fake-store.ts:7-16` (unsigned, tokens include apostrophes) vs `packages/llm/src/mock.ts:39-50` (signed). `backend.ts:7-16` uses the llm one only for `store=postgres, embedder=hash`; the fake ignores the supplied embedder (backend.ts:14 comment "main's fake" is a merge leftover). Memory also no longer follows `llm.provider=mock` (that switch lives in `packages/llm/src/index.ts:60-63` and is unused here).
6. **A single failing DB call drops the chat event** — `touchViewer` has no try/catch (store.ts:102); the bus logs and acks (packages/bus/src/index.ts:153-159), so neither `memory.viewer` nor the memory row is produced for that line. `index.ts:5-6` comment says viewers are announced when "new or a regular" but `region.ts:22-24` announces every mention (cortex filters).
7. **Startup heartbeat stays `starting`, not `degraded`, while waiting** for Ollama or Postgres (index.ts:35-53, `ready()` only at index.ts:60); OpenSpec's "Ollama down -> degraded" scenario only holds after ready.
8. **Test gaps** — `index.ts` wiring/retries and the `reflect.ts` main flow are untested; `learned.ts` was split out to make the pure part testable (learned.ts:1).

## Work Required

### Must Fix
1. Detect vector dimension mismatch at `init` and fail loudly rather than silently dropping every write (MEM-STORE-002).
2. Make `reflect` not discard rows beyond the 600 cap, e.g. advance `last_reflection` only to the last reflected row (MEM-REFLECT-008).

### Should Fix
3. Track Postgres health on every query so a post-startup outage shows as `degraded` (MEM-HEALTH-005).
4. Decide who writes `viewers.notes` and implement or document it (MEM-VIEWER-005).
5. Wrap `touchViewer` failures so a DB error does not drop the mention's `memory.viewer` and memory write (finding 6; no spec yet).
6. Add tests for `index.ts` startup retry/ordering and the `reflect` main flow (MEM-START-001, MEM-START-002, MEM-REFLECT-001 to MEM-REFLECT-007).

### Nice to Have
7. Consolidate the two hash embedders or document why the fake keeps its own.
8. Remove the stale "main's fake" comment (backend.ts:14) and the stale "new or a regular" header text (index.ts:5-6).
9. Report `degraded` with a detail while waiting for Ollama/Postgres at startup (MEM-HEALTH-003 context).
