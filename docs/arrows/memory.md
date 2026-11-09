# Arrow: memory

The hippocampus region: the only service that touches Postgres/pgvector. Stores embedded exchanges and viewer records, answers recall requests over the bus, announces viewer familiarity, and ships the offline `reflect` CLI that folds memories into `personality.md`.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`); viewer-notes build chunks 1 (memory core), 2 (live capture), 3 (cortex surfacing) and 4 (owner operations) added after the audit. 107 specs: 99 implemented, 8 gaps (viewer notes: see below), 0 deferred. At the audit the 54 then-current specs were 53 implemented and 1 deferred. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are implemented, including `MEM-START-005` (via `SubscribeOptions.onReady`).

## Viewer notes: chunks 1 to 4 built (memory core, live capture, cortex surfacing, owner operations)

Design: LLD § Viewer notes (build order, edge cases, `[proposed]` items). The spec file holds 107 specs: 107 `[x]`, 0 `[ ]`, 0 `[D]`.

- Retired: `MEM-VIEWER-004` (notes text in `memory.viewer`), `MEM-VIEWER-005` (deferred notes writer, superseded). Numbers not reused.
- **Chunk 1 built** (notes store, regular flag, decay math, consolidation job and triggers, config): `[x]` `MEM-NOTE-001`, `002`, `003`, `005`, `006`, `007`, `008`, `010`; `MEM-REG-001`, `003`, `004`, `005`; `MEM-CONSOL-002` to `016`; `MEM-STORE-001`; `MEM-BACKEND-005`; with config `CFG-SCH-014` to `016` and `CFG-USR-007`.
- **Chunk 2 built** (live capture, `capture.ts`): `[x]` `MEM-CAPTURE-001` to `011`, `MEM-NOTE-009` (capture and consolidator validation plus a deterministic politics, money and subscriber-status backstop, `mentionsForbiddenTopic`), `MEM-NOTE-011` (the capture hook is built through `notesHookLlm`, as the consolidator is), `MEM-CONSOL-001` (the capture writer calls `ConsolidationScheduler.notifyDirty`); with config `CFG-USR-008`. The store gained `ensureViewer` and `embedText` (shared contract, in-memory always and Postgres under `COHOST_TEST_DATABASE_URL`), and the control-plane manifest gained the `memory-notes` group.
- **Chunk 3 built** (cortex surfacing): `[x]` `MEM-SURF-001` to `005` (`surface.ts`, `memory.notes.request` handled in the `memory-recall` group, store methods `findViewerByDisplay` and `markSurfaced` in the shared store contract), `MEM-VIEWER-002` (`memory.viewer` carries `regular`, no notes text), `MEM-REG-002` (capture and surfacing both built and tested); with `CTX-NOTES-*`, `CTX-VIEWER-001`, `CTX-EVT-001`, `BUS-EVT-010`, `BUS-EVT-020`, `DASH-FEED-007`.
- **Chunk 4 built** (owner operations for the dashboard Viewers page): `[x]` `MEM-ADMIN-001` to `007` (`src/admin.ts` `answerViewersRequest`, wired in `region.ts` for `memory.viewers.request`, consumed in the `memory-recall` group) and `MEM-NOTE-004` (a restored note is a new row at version 1, like any insert). New store methods `listViewers`, `restoreDeletion`, `clearNotes` on `MemoryStore` and `InMemoryStore`, specified by the shared store contract (`test/store-contract.ts`, run against Postgres only when `COHOST_TEST_DATABASE_URL` is set, so the SQL is unrun in CI). Dashboard side: `DASH-VIEWERS-*`, `BUS-EVT-021`, `CFG-ENV-009`.
- Deployment and control-plane follow-ups (not built): a Compose one-shot service and a `cohostctl` subcommand that run `consolidate`. The `models` container pulls `NOTES_MODEL` (DEPLOY-COMPOSE-008); if that pull fails, capture falls back to writing no notes.
- Owner answers of 2026-11-08 applied (access option A, hint-only sensitive notes, no subscriber status in the prompt, local notes models, best-effort shutdown one-shot with guaranteed catch-up, retention and cooldown). Still `[proposed]`: fade numbers, caps, event and route names, classifier slot specifics; the capture model is settled: `gemma3:4b`, 20 s hook timeout (memory LLD Decisions).

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
- docs/intent/memory/memory-specs.md (107 specs, prefix `MEM`: 107 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests (`@spec` lines per file; 132 lines citing 81 distinct `MEM-*` IDs)
- services/memory/test/region.test.ts (11)
- services/memory/test/memory.test.ts (21)
- services/memory/test/backend.test.ts (3)
- services/memory/test/fake-store.test.ts (6)
- services/memory/test/health.test.ts (4)
- services/memory/test/reflect.test.ts (10)
- services/memory/test/startup.test.ts (11)
- services/memory/test/notes.test.ts (4)
- services/memory/test/consolidation.test.ts (34)
- services/memory/test/scheduler.test.ts (12)
- services/memory/test/consolidate-run.test.ts (5)
- services/memory/test/capture.test.ts (21; the capture hook, validation, writer and scheduler hand-off)
- services/memory/test/store-contract.ts (17; the shared store behaviour, run by `notes-store.test.ts` on the in-memory store and by `notes-store.pg.test.ts` on a real Postgres when `COHOST_TEST_DATABASE_URL` is set)

### Code (`@spec` lines per file)
- services/memory/src/index.ts (4)
- services/memory/src/startup.ts (6)
- services/memory/src/region.ts (8)
- services/memory/src/store.ts (14)
- services/memory/src/cursor.ts (1)
- services/memory/src/backend.ts (2)
- services/memory/src/fake-store.ts (10)
- services/memory/src/notes.ts (5)
- services/memory/src/consolidation.ts (5)
- services/memory/src/consolidator.ts (4)
- services/memory/src/scheduler.ts (4)
- services/memory/src/consolidate-run.ts (1)
- services/memory/src/consolidate.ts (1)
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
2. `store.ts` — Postgres/pgvector `MemoryStore` (tables `memories`, `viewers`, `viewer_notes`, `viewer_note_deletions`, `meta`; 2-minute recency exclusion; `min_similarity` filter; per-viewer note commits guarded by note versions; an advisory lock for consolidation) and the `MemoryBackend` interface.
3. `fake-store.ts` + `backend.ts` — in-process `InMemoryStore` with its own 64-dim hash embedder (it now keeps viewer notes, deletion records and the regular and subscriber flags too); config-driven store and embedder factories.
4. `health.ts` — dependency tracker (`postgres`, `ollama`, `n/a` when unused) and mode (`live` only for postgres + ollama).
5. `index.ts` + `startup.ts` — wiring, and the injectable startup sequence (Ollama ping, Postgres init retry with no retry on a dimension mismatch, fatal after the 21st failure, `degraded` while waiting, subscriptions with start mode `resume`, heartbeat).
6. `reflect.ts` + `reflect-run.ts` + `cursor.ts` + `learned.ts` — offline reflection CLI (wiring), the injectable reflection pass, the `(ts, id)` cursor, and the pure text helpers.
7. `notes.ts` — viewer-note types and the shared arithmetic (effective strength, reinforcement, default hints, cosine).
8. `consolidation.ts` + `consolidator.ts` — the consolidation pass (fade, suppression, the `memory.consolidator` hook, versioned per-viewer commit, lock, retention) and the hook's prompt, validation and local-provider rule (`notesHookLlm`).
9. `scheduler.ts` — when a pass runs: dirty threshold, startup catch-up, idle gating from `brain.status`, shutdown flag.
10. `consolidate.ts` + `consolidate-run.ts` — the one-shot `consolidate` command (`pnpm consolidate`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Event handling | MEM-EVT-001 to MEM-EVT-002 | 2 | 0 | 0 | 2 |
| Storing memories | MEM-WRITE-001 to MEM-WRITE-005 | 5 | 0 | 0 | 5 |
| Test injection | MEM-INJ-001 to MEM-INJ-003 | 3 | 0 | 0 | 3 |
| Viewers | MEM-VIEWER-001 to MEM-VIEWER-006 (004, 005 retired) | 4 | 0 | 0 | 4 |
| Viewer notes: notes, regular, consolidation (chunk 1) | MEM-NOTE-001 to 011, MEM-REG-001 to 005, MEM-CONSOL-001 to 016 | 31 | 0 | 1 (NOTE-004, restore, chunk 4) | 31 |
| Viewer notes: surfacing (chunk 3) | MEM-SURF-001 to 005 | 5 | 0 | 0 | 5 |
| Viewer notes: capture (chunk 2) | MEM-CAPTURE-001 to 011 | 11 | 0 | 0 | 11 |
| Viewer notes: owner operations (chunk 4) | MEM-ADMIN-001 to 007 | 0 | 0 | 7 | 0 |
| Recall | MEM-RECALL-001 to MEM-RECALL-006 | 6 | 0 | 0 | 6 |
| Stores and schema | MEM-STORE-001 to MEM-STORE-003 | 3 | 0 | 0 | 3 |
| Backend selection | MEM-BACKEND-001 to MEM-BACKEND-006 | 6 | 0 | 0 | 5 |
| Startup and shutdown | MEM-START-001 to MEM-START-006 | 6 | 0 | 0 | 5 |
| Health | MEM-HEALTH-001 to MEM-HEALTH-007 | 7 | 0 | 0 | 7 |
| Reflection | MEM-REFLECT-001 to MEM-REFLECT-010 | 10 | 0 | 0 | 9 |

**Summary:** 107 of 107 specs implemented and annotated in code (viewer-notes chunks 1 to 4 built); 0 gaps; 0 deferred. Implemented specs with no test: `MEM-BACKEND-002`, `MEM-START-006`, `MEM-REFLECT-009`. `index.ts`, `reflect.ts` and `consolidate.ts` are wiring only and untested; the logic they hold is in `startup.ts`, `reflect-run.ts`, `scheduler.ts` and `consolidate-run.ts`, covered with fakes. No test run here executes against a real Postgres: the chunk-1 store behaviour is covered by the in-memory store and by recorded SQL, and `notes-store.pg.test.ts` runs the same contract against a real Postgres when `COHOST_TEST_DATABASE_URL` is set (not run in CI).

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
