# Arrow: memory

The hippocampus region: the only service that touches Postgres/pgvector. Stores embedded exchanges and viewer records, answers recall requests over the bus, announces viewer familiarity, and ships the offline `reflect` CLI that folds memories into `personality.md`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 53 specs: 43 implemented, 1 deferred, 9 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B5** Vector size vs embedder mismatch → `init` fails loudly with both dimensions named, no retry, fatal exit; migration stays a separate open decision. Specs: `MEM-STORE-002` (reworded).
2. **B6** First viewer message → counts as 1 in both stores. Specs: `MEM-VIEWER-001` (`[x]` → `[ ]`).
3. **B7** More than 600 memories at reflect time → `last_reflection` advances to the newest row read. Specs: `MEM-REFLECT-008` (reworded).
4. **R4** Runtime `deps.postgres` → every pool query wrapped with `tracked()`. Specs: `MEM-HEALTH-005` (reworded).
5. **S26** Writer for `viewers.notes` → deferred until one is chosen. Specs: `MEM-VIEWER-005` (`[ ]` → `[D]`).
6. **B8** Failed viewer upsert → caught and logged, no `memory.viewer`, the mention is still remembered. Specs: `MEM-VIEWER-006` (new).
7. **P8** Restart replay → memory subscribes with start mode `resume` and keeps the backlog; every other subscriber uses `latest`. Specs: `MEM-EVT-001` (`[x]` → `[ ]`, explicit start mode).
8. **S27** Learned block placement → end of the `## Learned` section (low priority). Specs: `MEM-REFLECT-007` (`[x]` → `[ ]`).
9. **R3** Startup waits and readiness → `degraded` with a detail while waiting for Ollama or Postgres; `ready` only once both consumer groups exist. Specs: `MEM-HEALTH-007` (new), `MEM-START-005` (`[x]` → `[ ]`).
10. **B20** Stale comments → fix `services/memory/src/index.ts:8-10` and `services/memory/src/backend.ts:16`; `config/config.example.yaml:18` is fixed with model-backends (S17). No spec change.
11. **P7** Mute and pause → memory stays unaware; only cortex and salience act on them. LLD decision row; no spec change.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/memory/memory-design.md

### EARS
- docs/intent/memory/memory-specs.md (53 specs, prefix `MEM`: 43 `[x]`, 9 `[ ]`, 1 `[D]`)

### Tests (`@spec` lines per file; 29 lines citing 31 distinct IDs)
- services/memory/test/region.test.ts (8)
- services/memory/test/memory.test.ts (9)
- services/memory/test/backend.test.ts (3)
- services/memory/test/fake-store.test.ts (5)
- services/memory/test/health.test.ts (4)

### Code (`@spec` lines per file; 30 lines citing 47 IDs: the 43 implemented plus the 4 former `[x]` lines now `[ ]`)
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

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Event handling | MEM-EVT-001 to MEM-EVT-002 | 1 | 0 | 1 (EVT-001) | 1 |
| Storing memories | MEM-WRITE-001 to MEM-WRITE-005 | 5 | 0 | 0 | 5 |
| Test injection | MEM-INJ-001 to MEM-INJ-003 | 3 | 0 | 0 | 3 |
| Viewers | MEM-VIEWER-001 to MEM-VIEWER-006 | 3 | 1 (VIEWER-005) | 2 (VIEWER-001, 006) | 4 |
| Recall | MEM-RECALL-001 to MEM-RECALL-006 | 6 | 0 | 0 | 6 |
| Stores and schema | MEM-STORE-001 to MEM-STORE-003 | 2 | 0 | 1 (STORE-002) | 2 |
| Backend selection | MEM-BACKEND-001 to MEM-BACKEND-006 | 6 | 0 | 0 | 5 |
| Startup and shutdown | MEM-START-001 to MEM-START-006 | 5 | 0 | 1 (START-005) | 0 |
| Health | MEM-HEALTH-001 to MEM-HEALTH-007 | 5 | 0 | 2 (HEALTH-005, 007) | 3 |
| Reflection | MEM-REFLECT-001 to MEM-REFLECT-009 | 7 | 0 | 2 (REFLECT-007, 008) | 2 |

**Summary:** 43 of 53 specs implemented and annotated in code; 1 deferred (`MEM-VIEWER-005`); 9 gaps (`MEM-EVT-001`, `MEM-VIEWER-001`, `MEM-VIEWER-006`, `MEM-STORE-002`, `MEM-START-005`, `MEM-HEALTH-005`, `MEM-HEALTH-007`, `MEM-REFLECT-007`, `MEM-REFLECT-008`). Four gaps are former `[x]` lines whose intent changed (`MEM-EVT-001`, `MEM-VIEWER-001`, `MEM-START-005`, `MEM-REFLECT-007`); their existing code annotations stay and the fix lands under the same ID. 31 spec lines have a test annotated with `@spec` (the "With test" column; `MEM-REFLECT-007`'s covers the text append only). Implemented specs with no test: `MEM-BACKEND-002`, `MEM-START-001` to `MEM-START-004`, `MEM-START-006`, `MEM-HEALTH-004`, `MEM-HEALTH-006`, `MEM-REFLECT-001` to `MEM-REFLECT-004`, `MEM-REFLECT-006`, `MEM-REFLECT-009`. No `@spec` annotation cites a missing ID.

## Key Findings

1. **Markers verified at audit** — every `[x]` line had implementing code and every `[ ]` gap was confirmed absent in code (`store.ts:44-54`, `index.ts:49`, `reflect.ts:28,56`, no `notes` writer).
2. **Postgres and in-memory stores disagree on viewer counts** — Postgres reports `msgCount` 0 then 1 for a viewer's first two messages, both `isNew` (`store.ts:61,108-109,114`); the fake reports 1 then 2 (`fake-store.ts:53-56`). The unit test's fake pool returns `msg_count` 1 (`services/memory/test/memory.test.ts:110-111`), so the divergence is untested. B6, `MEM-VIEWER-001`.
3. **Vector dimension is fixed and unchecked** — `CREATE TABLE IF NOT EXISTS memories (... embedding vector(dims))` (`store.ts:46-54`) with no comparison to an existing table. Changing embed model, or `embedder=hash` (64 dims) on a database created with Ollama vectors, makes every `remember`/`recall` fail, both swallow the error as a warning (`store.ts:80-82`, `store.ts:99-102`), and health stays `ok`. B5, `MEM-STORE-002`.
4. **`deps.postgres` is startup-only** — `setPostgres` is called only in the init loop (`index.ts:49,51`); commit `691b079` review notes state "memory `postgres` only flips on init". Only `ollama` is live-tracked via `tracked()` (`health.ts:33-36`). R4, `MEM-HEALTH-005`.
5. **Reflection loses rows past 600** — `recentSince(since, 600)` returns the oldest 600 (`store.ts:118-124`) and `last_reflection` is then set to now (`reflect.ts:28,56`). Reflection also needs a reachable embedder because `init()` embeds `"hello"` (`store.ts:44`), and takes no lock against the live service. B7, `MEM-REFLECT-008`.
6. **`viewers.notes` has no writer** — read and forwarded in `memory.viewer` (`store.ts:106-115`, `region.ts:27`) but never written anywhere; cortex surfaces it only for viewers above 25 messages. S26, `MEM-VIEWER-005` `[D]`.
7. **Restarts replay the backlog, by design** — both groups resume after downtime (`fromNow` behaves as `resume`, `packages/bus/src/index.ts:133-138`; manifest default `resume`, `packages/control/src/manifest.ts:43`); `ready()` is reported before the un-awaited subscriptions have created the groups (`index.ts:63-65`). P8, R3, `MEM-EVT-001`, `MEM-START-005`.
8. **A failing viewer upsert drops the chat event** — `touchViewer` has no `try/catch` (`store.ts:106-115`); the bus logs and acks (`packages/bus/src/index.ts:160-166`), so neither `memory.viewer` nor the memory row is produced. B8, `MEM-VIEWER-006`.
9. **Two hash embedders** — `fake-store.ts:7-16` (unsigned, tokens include apostrophes, zero vector for empty text) vs `packages/llm/src/mock.ts:39-50` (signed, fixed unit vector for empty text). `backend.ts:8-10` uses the llm one only for `store=postgres, embedder=hash`; the fake ignores the supplied embedder. Memory deliberately does not follow `llm.provider=mock` (commit `51d5a9c`).
10. **Startup heartbeat stays `starting`, not `degraded`, while waiting** for Ollama or Postgres (`index.ts:37-56`; `ready()` only at `index.ts:65`). R3, `MEM-HEALTH-007`.
11. **Decision rationale** — the LLD's Decisions table cites a code comment or commit for 8 original rows and records the owner's 2026-11-01 decisions in 9 rows; 4 rows remain `[inferred]` (where vectors live, recency exclusion, isolated backend, mode reporting) and one is partly `[inferred]` (the 600 cap itself).
12. **Test gaps** — `index.ts` wiring/retries and the `reflect.ts` main flow are untested (see Summary); `learned.ts` exists so the pure part is testable (commit `95afa19`).

## Work Required

### Must Fix
1. Fail `init` on a vector-dimension mismatch, without retry (`MEM-STORE-002`, B5).
2. Insert new Postgres viewers at `msg_count` 1 and test the insert path (`MEM-VIEWER-001`, B6).
3. Advance `last_reflection` to the newest row read (`MEM-REFLECT-008`, B7).
4. Catch a failed `touchViewer`, log, skip `memory.viewer`, still remember the mention (`MEM-VIEWER-006`, B8).
5. Track Postgres health on every pool query with `tracked()` (`MEM-HEALTH-005`, R4).
6. Report `degraded` with a detail while waiting for Ollama or Postgres, and `ready` only once both consumer groups exist (`MEM-HEALTH-007`, `MEM-START-005`, R3).
7. Subscribe both groups with the bus's explicit start mode `resume` once event-bus provides it (`MEM-EVT-001`, P8).

### Should Fix
8. Insert the Learned block at the end of the `## Learned` section (`MEM-REFLECT-007`, S27; low priority).
9. Fix the stale comments `services/memory/src/index.ts:8-10` (`memory.viewer` goes on every mention, `region.ts:25-27`) and `services/memory/src/backend.ts:16` ("main's fake") (B20).

### Nice to Have
10. Add tests for `index.ts` startup retry/ordering and the `reflect` main flow (`MEM-START-*`, `MEM-REFLECT-001` to `MEM-REFLECT-004`, `MEM-REFLECT-006`, `MEM-REFLECT-009`).
11. Consolidate the two hash embedders or record why the fake keeps its own.
