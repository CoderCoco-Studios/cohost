# Arrow: event-bus

The typed Redis Streams bus (`@cohost/bus`) that is the only channel between cohost services, plus the `@cohost/testing` test double for it.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 61 specs: 61 implemented, 0 deferred, 0 gaps. The owner decisions of 2026-11-01 are applied below and implemented. With the spoken fallback line (build chunk 1): 65 specs: 65 implemented, 0 gaps, 0 deferred. The standalone host-run dashboard (chunk 2) adds BUS-TAIL-005, an optional `onRead` callback on `tail` and `tailHealth` that reports every read's outcome, so the dashboard feed can report whether Redis answers (DASH-FEED-009): 66 specs, 66 implemented.

## Upload store over Redis: built

Owner decision of 2026-11-12: injected test uploads travel as a Redis key beside the stream, not as a URL. `Bus.putUpload` / `Bus.takeUpload` (BUS-UPL-001 to BUS-UPL-003), `inject.request` carries `uploadId` and `contentType` (BUS-EVT-006) and `FakeBus` mirrors both (BUS-TEST-012). 69 specs, all implemented.

## Transport gap closure: built

Design: LLD Decisions & Alternatives (pending drain, stop during a handler, streams for tests, avatar.state and playback shapes, fake ids); the LLD's Open Questions is empty.

- `BUS-SUB-003` (drain pending batch by batch until none remain) and `BUS-SUB-013` (no ack, no further handling after `stop()`): `Bus.subscribe`, pinned by `packages/bus/test/resilience.test.ts`.
- `BUS-STREAM-009`: `BusOptions.failFast` (no reconnect, silent error listener), used by `cohostctl`; `packages/bus/test/failfast.test.ts`.
- `BUS-STREAM-008`: `BusOptions.streamPrefix`; the Redis integration tests each run on a stream pair of their own and delete it in a `finally`.
- `BUS-EVT-017` (one `PlaybackReport` shape) and `BUS-EVT-018` (ranges on `avatar.state`).
- `BUS-TEST-011`, `BUS-TEST-003`, `BUS-TEST-006`: time-ordered ids in `FakeBus` and `event()`, tested in `packages/testing/test/fake-bus.test.ts`.

## Spoken fallback line: built (chunk 1)

Design: LLD § Event catalogue (`voice.failed`); semantics in the voice LLD (Sink Arbitration Protocol rule 8).

- `BUS-EVT-001`: the catalogue is exactly 24 types (25 with `speech.partial`), with `voice.failed`, pinned by `packages/bus/test/bus.test.ts`.
- `BUS-EVT-022`: the `voice.failed` shape (`id`, `sink`, `reason`, optional `fallback { clip, text }`).
- Build chunk 1 (ears LLD § Fallback Line, Build order).

## Viewer notes events (built)

Design: LLD § Event catalogue, "Planned viewer-notes events". The spec file holds 64 specs: 64 `[x]`, 0 `[ ]`.

- Chunk 3: `BUS-EVT-010` (`memory.viewer.regular` replaces `notes`) and `BUS-EVT-020` (`memory.notes.request` / `reply`, `text` optional, no subscriber field).
- Chunk 4: `BUS-EVT-021` (`memory.viewers.request` as a union of the six ops, `memory.viewers.reply`).
- `BUS-EVT-001` is `[x]`: `EventPayloads` holds exactly 23 types, pinned by a test in `bus.test.ts` that lists them.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **P8** delivery and start position across restarts → at most once (BUS-SUB-008 rewritten, `[x]`); every subscription names an explicit start mode, `latest` (reset to `$` on every start; all subscribers except memory) or `resume` (keep the position; memory). Specs: BUS-SUB-001, BUS-SUB-002, BUS-SUB-008, BUS-SUB-010, BUS-SUB-011.
2. **R2** several `onShutdown` registrations → one sequence: every callback runs, errors logged, exit 0 once. Specs: SHARED-LIFE-004.
3. **S51** per-kind `inject.request` completeness → owned by the target services; BUS-EVT-011 deleted.
4. **R1** `subscribe` / `tail` failures → log and retry with a capped, growing delay; tail handlers guarded. Specs: BUS-SUB-009, BUS-TAIL-003, BUS-TAIL-004.
5. **H1** overlap with control-plane → event-bus owns the heartbeat transport (BUS-STREAM-004, BUS-HEALTH-001) and shutdown mechanics (SHARED-LIFE-001); CTRL-HEARTBEAT-007 deleted and SHARED-LIFE-010 narrowed in control-plane.
6. **R2** synchronously throwing `beforeShutdown` hook → treated like a rejection. Specs: SHARED-LIFE-005.
7. **B2** `avatar.state` lacks `mouthSmile` → add the field to the schema. Specs: BUS-EVT-018.

## Barge-in and echo gate: built

Built with tests (barge-in and echo-gate slice); the deferred dynamic-speech ideal stays `[D]`. BUS-EVT-030 (`voice.stop`) and BUS-EVT-031 (`interrupted`, `spokenText`, `unsaidText` on `voice.done`) are `[x]`, as is BUS-EVT-032 (`meta.source` on `inject.request`, so injected speech can carry a source tag); BUS-EVT-001 (26 types) and BUS-EVT-017 are reworded to match. Spec file totals: 81 specs, 81 `[x]`, 0 `[ ]`, 0 `[D]`. Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (System Design: bus of 19 event types plus `cohost:health`)

### LLD
- docs/intent/event-bus/event-bus-design.md

### EARS
- docs/intent/event-bus/event-bus-specs.md (81 specs: 78 `[x]`, 3 `[ ]`, 0 `[D]`; BUS-EVT-024 and 025, the `timing` schema, and BUS-EVT-026 to 029, `speech.partial`, `utteranceId` and the staleness rule, are built; BUS-EVT-011 is retired and its number not reused)

### Tests
- packages/bus/test/bus.test.ts (366 lines; schema tests run without Redis, integration tests skip when no Redis at `REDIS_URL`)
- packages/bus/test/resilience.test.ts (266 lines; `Bus` against scripted fake Redis connections injected through `BusOptions.connect`: start modes, read retry and backoff, `XACK` failure, tail handlers, publish failure; runs without Redis)
- packages/bus/test/shutdown.test.ts (subprocess tests of the shutdown sequence) with fixtures `shutdown-multi.fixture.ts`, `shutdown-hooks.fixture.ts` and `shutdown.fixture.ts` (no annotations)
- packages/testing has no tests of its own; it is exercised only indirectly by `services/*/test/*.test.ts`

### Code
- packages/bus/src/index.ts (12 `@spec` lines)
- packages/bus/src/events.ts (21 `@spec` lines)
- packages/bus/src/heartbeat.ts (owned by control-plane; exported through this package; 2 `@spec` lines, `CTRL-*`)
- packages/bus/package.json, packages/bus/tsconfig.json
- packages/testing/src/index.ts (10 `@spec` lines), packages/testing/package.json, packages/testing/tsconfig.json

### OpenSpec (frozen)
- openspec/specs/bus/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md
- openspec/changes/archive/2026-11-01-add-service-control/specs/bus/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/bus/spec.md
- (`add-isolated-backends` has no bus delta)

## Architecture

**Purpose:** Validate-and-forward typed events between services over Redis Streams, with a per-service read position via consumer groups (start mode `latest` or `resume`), a non-group live tail for the dashboard, a separate capped heartbeat stream, and shared shutdown helpers.

**Key Components:**
1. `events.ts` — `EventPayloads` zod registry of 19 event types, derived types, `EVENT_TYPES`.
2. `Bus` class in `index.ts` — `publish`, `publishHealth`, `subscribe` (consumer group), `tail`, `tailHealth`, `recent`, `recentHealth`, `resetGroup`, `stop`.
3. `onShutdown` / `beforeShutdown` — signal handling with a 2 s pre-shutdown hook window (the heartbeat `stopping` message rides this).
4. `heartbeat.ts` — `startHeartbeat`, `tracked` (control-plane-owned).
5. `FakeBus`, `testConfig`, `event`, `runHeartbeat`, `waitFor`, `silentLog`, `recordingLog` in `@cohost/testing` — the test double and helpers.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Publish and envelope | BUS-STREAM-001 to BUS-STREAM-009 | 9 | 0 | 0 | 7 |
| Event catalogue and schemas | BUS-EVT-001 to BUS-EVT-022 | 21 | 0 | 0 | 14 |
| Consumer-group subscription | BUS-SUB-001 to BUS-SUB-013 | 13 | 0 | 0 | 12 |
| Live tail and backfill | BUS-TAIL-001 to BUS-TAIL-005 | 5 | 0 | 0 | 5 |
| Health stream and group reset | BUS-HEALTH-001 to BUS-GROUP-001 | 5 | 0 | 0 | 5 |
| Shutdown | BUS-STOP-001 | 1 | 0 | 0 | 1 |
| Test double (packages/testing) | BUS-TEST-001 to BUS-TEST-011 | 11 | 0 | 0 | 11 |

**Summary:** 70 of 70 specs implemented; 0 deferred; 0 open. 54 carry a test `@spec` annotation; implemented without one: BUS-STREAM-002, BUS-STREAM-005, BUS-EVT-002, BUS-EVT-012, BUS-EVT-013, BUS-EVT-014, BUS-EVT-015, BUS-EVT-016, BUS-EVT-019, BUS-SUB-006 (verified by glue, configuration or a test that cites a neighbouring ID). `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **Markers.** Every `[x]` line is observed in code and carries an `@spec` annotation. No `[ ]` lines remain.
2. **The event schema specs match `events.ts` field for field.** BUS-EVT-002, 003, 004, 006, 009 and 010 list every field; BUS-EVT-012 (`vision.summary`), 013 (`speech.heard`), 014 (`brain.say`), 015 (`brain.status`), 016 (`voice.utterance`), 017 (`voice.playing` / `voice.done`), 018 (`avatar.state`) and 019 (`Emotion` fields) cover the rest. BUS-EVT-018 requires `mouthSmile` and bounds every `avatar.state` number; BUS-EVT-017 gives `voice.playing` and `voice.done` one shared shape.
3. **Other spec corrections** (IDs kept): BUS-STREAM-003 (unknown payload keys are stripped), BUS-SUB-003 (the pending drain reads batch by batch until none remain, then new entries), SHARED-LIFE-001 (rejected hooks are ignored; synchronous throws are SHARED-LIFE-005). BUS-TEST-009 (`FakeBus.consumer`) and BUS-TEST-010 (`silentLog`, `recordingLog`) cover the remaining test helpers.
4. **Restart behaviour.** `subscribe` takes a required `start` (`latest` or `resume`); a missing group is created at `$`, `latest` moves an existing group to `$` before the first read, `resume` keeps it (BUS-SUB-001, 002, 010). `fromNow` is removed; every service caller names `start` (memory `resume`, the rest `latest`) (BUS-SUB-011). Delivery is at most once (BUS-SUB-008).
5. **Several `onShutdown` registrations share one sequence** (`runShutdown`, `index.ts:320-345`): hooks once, every callback in registration order, failures logged (to the registration's optional logger or `console.error`), one `exit(0)`. Eyes and ears register more than one callback. (SHARED-LIFE-004, 006)
6. **Handler failures and undecodable entries are silently dropped** — ack-always at `index.ts:166`; `decode` swallows every parse error with no log (`index.ts:226-228`); the ack-on-failure behaviour is pinned by `bus.test.ts:56-81`. A schema mismatch between producer and consumer would lose events invisibly. (BUS-SUB-005, BUS-SUB-007)
7. **Read failures retry with a capped, growing delay and tail handlers are guarded** (`index.ts:261-281`); a Redis outage at subscribe time before the group exists still rejects `subscribe` (group creation is not retried), and callers use `void bus.subscribe(...)` with no `.catch`. (BUS-SUB-009, BUS-TAIL-003, BUS-TAIL-004, BUS-SUB-001)
8. **Single ownership with control-plane** — the heartbeat transport and shutdown mechanics are event-bus lines only; the code entry points (`index.ts:47,63,241`) and tests (`bus.test.ts:144,154`) cite only `BUS-*` IDs for them, and SHARED-LIFE-010 (the heartbeat's `beforeShutdown` registration) is cited at `heartbeat.ts:60` and on the SIGTERM test (`bus.test.ts:256`). (H1)
9. **Test coverage is uneven** — no test for MAXLEN trimming, the consumer name, eight event shapes, sequential delivery, decode drops inside `subscribe`, the `beforeShutdown` timeout, or any of `@cohost/testing`. Start modes, read retry, `XACK` failure, tail handlers, publish failure and the shutdown sequence are covered without Redis through injected fake connections and subprocess fixtures. Partial behind annotated tests: BUS-EVT-001 (membership of three types; the count of 19 is not pinned), BUS-EVT-003 (only a high `valence`), BUS-STREAM-006 (`source` and `ts` present, not their defaults), BUS-SUB-007 (`recent` path only). Integration tests write to production stream keys and leave groups behind (`bus.test.ts:23-45,84-98`). `[inferred]` the shared dev Redis is expected to be disposable.
10. **Process-lifecycle helpers live in the bus package** — `onShutdown`, `beforeShutdown` and `startHeartbeat` import each other in a cycle (`index.ts:259`, `heartbeat.ts:2`); works only because the call is deferred to runtime. `[inferred]` they sit here because every service already imports `@cohost/bus`.
11. **The frozen OpenSpec `bus` baseline lists all 19 events and seven `control` commands;** only the archived `add-service-health` delta still lists five (`openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md:8`). The LID specs supersede it.

## Work Required

### Must Fix
1. Every `Bus.subscribe` caller names `start` (memory `resume`, every other service `latest`), then `start` becomes required and `fromNow` is removed (BUS-SUB-011). Each service does this in its own segment.

### Should Fix
3. Log (at least at debug or warn) when `decode` drops an entry (BUS-SUB-007).
4. Add schema tests for BUS-EVT-002 and BUS-EVT-012 to 019, and pin the 19-type count (BUS-EVT-001).

### Nice to Have
5. Add tests for sequential delivery and the `beforeShutdown` timeout, and cover the remaining `@cohost/testing` helpers (BUS-TEST-001 to 010).
6. Use a test-specific stream key / clean up groups in bus integration tests; probe Redis once.
7. Add range constraints to `avatar.state`, and move the shutdown/heartbeat helpers out of the bus package if the cycle becomes a problem.
