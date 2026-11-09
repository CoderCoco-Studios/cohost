# Arrow: memory

The hippocampus region: the only service that touches Postgres/pgvector. Stores embedded exchanges and viewer records, answers recall requests over the bus, announces viewer familiarity, and ships the offline `reflect` CLI that folds memories into `personality.md`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 54 specs: 53 implemented, 1 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are implemented, including `MEM-START-005` (via `SubscribeOptions.onReady`).

## Planned: viewer notes (designed, not built)

Design: LLD § Viewer notes (build order, edge cases, `[proposed]` items). The spec file now holds 107 specs: 49 `[x]`, 58 `[ ]`, 0 `[D]`.

- Retired: `MEM-VIEWER-004` (notes text in `memory.viewer`), `MEM-VIEWER-005` (deferred notes writer, superseded). Numbers not reused.
- Amended to `[ ]`: `MEM-VIEWER-002` (`memory.viewer` carries `regular`, no notes), `MEM-STORE-001` (notes tables and viewer columns), `MEM-BACKEND-005` (in-memory store keeps notes).
- New `[ ]`: `MEM-NOTE-001` to `011`, `MEM-REG-001` to `005`, `MEM-CAPTURE-001` to `011`, `MEM-CONSOL-001` to `016`, `MEM-SURF-001` to `005`, `MEM-ADMIN-001` to `007`.
- Build order: (1) memory core (NOTE, REG, CONSOL, STORE-001, BACKEND-005, with config CFG-SCH-014 to 016 and CFG-USR-007); (2) capture (CAPTURE, with CFG-USR-008); (3) cortex surfacing (SURF, VIEWER-002, with CTX-NOTES-*, CTX-VIEWER-001, CTX-EVT-001, BUS-EVT-010, BUS-EVT-020, DASH-FEED-007); (4) Viewers page (ADMIN, with DASH-VIEWERS-*, BUS-EVT-021, CFG-ENV-009).
- Owner answers of 2026-11-08 applied (access option A, hint-only sensitive notes, no subscriber status in the prompt, local notes models, best-effort shutdown one-shot with guaranteed catch-up, retention and cooldown). Still `[proposed]`: fade numbers, caps, event and route names, classifier slot specifics; capture model deferred to chunk 2.

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
- docs/intent/memory/memory-specs.md (54 specs, prefix `MEM`: 52 `[x]`, 1 `[ ]`, 1 `[D]`)

### Tests (`@spec` lines per file; 50 lines citing 49 distinct IDs)
- services/memory/test/region.test.ts (9)
- services/memory/test/memory.test.ts (13)
- services/memory/test/backend.test.ts (3)
- services/memory/test/fake-store.test.ts (6)
- services/memory/test/health.test.ts (4)
- services/memory/test/reflect.test.ts (9)
- services/memory/test/startup.test.ts (6)

### Code (`@spec` lines per file; 35 lines citing 53 IDs: every spec except the deferred `MEM-VIEWER-005`)
- services/memory/src/index.ts (2)
- services/memory/src/startup.ts (5)
- services/memory/src/region.ts (7)
- services/memory/src/store.ts (8)
- services/memory/src/cursor.ts (1)
- services/memory/src/backend.ts (2)
- services/memory/src/fake-store.ts (4)
- services/memory/src/reflect.ts (1)
- services/memory/src/reflect-run.ts (1)
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
5. `index.ts` + `startup.ts` — wiring, and the injectable startup sequence (Ollama ping, Postgres init retry with no retry on a dimension mismatch, fatal after the 21st failure, `degraded` while waiting, subscriptions with start mode `resume`, heartbeat).
6. `reflect.ts` + `reflect-run.ts` + `cursor.ts` + `learned.ts` — offline reflection CLI (wiring), the injectable reflection pass, the `(ts, id)` cursor, and the pure text helpers.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Event handling | MEM-EVT-001 to MEM-EVT-002 | 2 | 0 | 0 | 2 |
| Storing memories | MEM-WRITE-001 to MEM-WRITE-005 | 5 | 0 | 0 | 5 |
| Test injection | MEM-INJ-001 to MEM-INJ-003 | 3 | 0 | 0 | 3 |
| Viewers | MEM-VIEWER-001 to MEM-VIEWER-006 (004, 005 retired) | 3 | 0 | 1 (VIEWER-002) | 3 |
| Viewer notes (planned) | MEM-NOTE, MEM-REG, MEM-CAPTURE, MEM-CONSOL, MEM-SURF, MEM-ADMIN | 0 | 0 | 55 | 0 |
| Recall | MEM-RECALL-001 to MEM-RECALL-006 | 6 | 0 | 0 | 6 |
| Stores and schema | MEM-STORE-001 to MEM-STORE-003 | 3 | 0 | 0 | 3 |
| Backend selection | MEM-BACKEND-001 to MEM-BACKEND-006 | 6 | 0 | 0 | 5 |
| Startup and shutdown | MEM-START-001 to MEM-START-006 | 6 | 0 | 0 | 5 |
| Health | MEM-HEALTH-001 to MEM-HEALTH-007 | 7 | 0 | 0 | 7 |
| Reflection | MEM-REFLECT-001 to MEM-REFLECT-010 | 10 | 0 | 0 | 9 |

**Summary:** 53 of 54 specs implemented and annotated in code; 1 deferred (`MEM-VIEWER-005`); no gaps (`MEM-START-005` is closed: `ready` follows both groups' `onReady`). 49 spec lines have a test annotated with `@spec` (the "With test" column). Implemented specs with no test: `MEM-BACKEND-002`, `MEM-START-006`, `MEM-REFLECT-009`. `index.ts` and `reflect.ts` are wiring only and untested; the logic they used to hold is in `startup.ts` and `reflect-run.ts`, covered with fakes (no test runs against a real Postgres).

## Key Findings

1. **Viewer counts agree across stores** — the Postgres INSERT sets `msg_count` 1 (`store.ts:144`), as the fake counts from 1 (`fake-store.ts:54-57`); the insert SQL is asserted in `memory.test.ts:154`. B6, `MEM-VIEWER-001`.
2. **Vector dimension is checked** — `init` reads `atttypmod` of `memories.embedding` and throws `DimensionMismatchError` on a mismatch (`store.ts:100-106`); `startup.ts:48` rethrows it without retrying, so the service exits through `MEM-START-006`. B5, `MEM-STORE-002`. Migrating a table to a new dimension stays an open decision.
3. **`deps.postgres` follows the latest query** — every pool query goes through `MemoryStore.query` (`store.ts:54,62`), which reports to `health.setPostgres` (`index.ts:28`). R4, `MEM-HEALTH-005`.
4. **Reflection reads a `(ts, id)` cursor** — `meta.last_reflection` is `<ISO ts>#<id>` of the newest row read (`cursor.ts`, `reflect-run.ts:62`); `recentSince` reads `WHERE (ts, id) > ($1, $2) ORDER BY ts, id` (`store.ts:154-161`); a legacy plain timestamp is accepted; fewer than 5 rows leave the cursor alone. Reflection still needs a reachable embedder (`init()` embeds `"hello"`, `store.ts:69`) and takes no lock against the live service. The cursor timestamp is the exact microsecond text from Postgres (`"tsText"`), so no row is re-read. B7, `MEM-REFLECT-008`, `MEM-REFLECT-003`.
5. **Learned block placement** — `appendLearned` inserts at the end of the `## Learned` section (`learned.ts:16-27`). S27, `MEM-REFLECT-007`.
6. **Reflect announces the mock backend** — `runReflect` warns once when the chat provider is `mock` (`reflect-run.ts:25`). `MEM-REFLECT-010`, `LLM-MOCK-005` (that spec line lives in model-backends).
7. **`viewers.notes` has no writer** — read and forwarded in `memory.viewer` (`store.ts:142-152`, `region.ts:32`) but never written anywhere; cortex surfaces it only for viewers above 25 messages. Superseded by the viewer-notes design (Planned section above): `MEM-VIEWER-004` and `MEM-VIEWER-005` are retired and the column is left unread.
8. **Restarts replay the backlog, by design** — both groups subscribe with `start: "resume"` (`startup.ts:60-61`, asserted in `startup.test.ts:28`); manifest default `resume` (`packages/control/src/manifest.ts:43`). P8, `MEM-EVT-001`.
9. **`ready` waits for both consumer groups (resolved)** — `SubscribeOptions.onReady` fires after the group exists and is positioned; `startup.ts` reports `ready` once both fire. R3, `MEM-START-005`.
10. **A failing viewer upsert no longer drops the chat event** — `region.ts:25-29` catches, logs a warning, skips `memory.viewer` and still remembers the mention. B8, `MEM-VIEWER-006`.
11. **Startup reports `degraded` while waiting** for Ollama or Postgres (`startup.ts:35,49`). R3, `MEM-HEALTH-007`.
12. **Two hash embedders** — `fake-store.ts:8-17` (unsigned, tokens include apostrophes, zero vector for empty text) vs `packages/llm/src/mock.ts:39-50` (signed, fixed unit vector for empty text). `backend.ts:8-10` uses the llm one only for `store=postgres, embedder=hash`; the fake ignores the supplied embedder. Memory deliberately does not follow `llm.provider=mock` (commit `51d5a9c`).
13. **Decision rationale** — the LLD's Decisions table cites a code comment or commit for 8 original rows and records the owner's 2026-11-01 decisions in 9 rows plus two rows for the testable-startup/reflection split and the readiness limitation; 4 rows remain `[inferred]` (where vectors live, recency exclusion, isolated backend, mode reporting) and one is partly `[inferred]` (the 600 cap itself).
14. **Test coverage** — `startup.ts` and `reflect-run.ts` are tested with injected fakes; `index.ts` and `reflect.ts` are wiring only. No test runs against a real Postgres (the `atttypmod` query and the row comparison are checked as recorded SQL).

## Work Required

### Must Fix
1. (done) `MEM-START-005`: bus `onReady` hook plus `startup.ts` wait.

### Should Fix
2. Fix the stale comments `services/memory/src/index.ts:8-10` (`memory.viewer` goes on every mention, `region.ts:30-33`) and `services/memory/src/backend.ts:16` ("main's fake") (B20).
3. Flip `LLM-MOCK-005` to `[x]` in docs/intent/model-backends (model-backends segment) with test pointer `services/memory/test/reflect.test.ts:127`.

### Nice to Have
4. Add a test that runs `init`, `touchViewer` and `recentSince` against a real Postgres with pgvector.
5. Consolidate the two hash embedders or record why the fake keeps its own.
