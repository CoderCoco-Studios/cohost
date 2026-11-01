# Arrow: event-bus

The typed Redis Streams bus (`@cohost/bus`) that is the only channel between cohost services, plus the `@cohost/testing` test double for it.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. 43 of 46 specs observed working; 3 gaps (cross-restart pending recovery, per-kind inject.request completeness, multiple onShutdown registrations).

## References

### HLD
- docs/high-level-design.md (System Design: bus of 19 event types plus `cohost:health`)

### LLD
- docs/intent/event-bus/event-bus-design.md

### EARS
- docs/intent/event-bus/event-bus-specs.md (46 specs: 43 `[x]`, 3 `[ ]`, 0 `[D]`)

### Tests
- packages/bus/test/bus.test.ts (schema tests run without Redis; integration tests skip when no Redis at `REDIS_URL`)
- packages/bus/test/shutdown.fixture.ts (subprocess fixture for the SIGTERM ordering test)
- packages/testing has no tests of its own; exercised indirectly by `services/*/test/*.test.ts`

### Code
- packages/bus/src/index.ts
- packages/bus/src/events.ts
- packages/bus/src/heartbeat.ts (owned by control-plane; exported through this package)
- packages/bus/package.json, packages/bus/tsconfig.json
- packages/testing/src/index.ts, packages/testing/package.json, packages/testing/tsconfig.json

### OpenSpec
- openspec/specs/bus/spec.md
- openspec/changes/add-service-health/specs/bus/spec.md
- openspec/changes/add-service-control/specs/bus/spec.md
- openspec/changes/add-test-injection/specs/bus/spec.md
- (`add-isolated-backends` has no bus delta)

## Architecture

**Purpose:** Validate-and-forward typed events between services over Redis Streams, with replay per service via consumer groups, a non-group live tail for the dashboard, a separate capped heartbeat stream, and shared shutdown helpers.

**Key Components:**
1. `events.ts` — `EventPayloads` zod registry of 19 event types, derived types, `EVENT_TYPES`.
2. `Bus` class in `index.ts` — `publish`, `publishHealth`, `subscribe` (consumer group), `tail`, `tailHealth`, `recent`, `recentHealth`, `resetGroup`, `stop`.
3. `onShutdown` / `beforeShutdown` — signal handling with a 2 s pre-shutdown hook window (the heartbeat `stopping` message rides this).
4. `heartbeat.ts` — `startHeartbeat`, `tracked` (control-plane-owned).
5. `FakeBus`, `testConfig`, `event`, `runHeartbeat`, `waitFor` in `@cohost/testing` — the test double.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Publish and envelope | BUS-STREAM-001 to 006 | 6 | 0 | 0 |
| Event catalogue and schemas | BUS-EVT-001 to 011 | 10 | 0 | 1 |
| Consumer-group subscription | BUS-SUB-001 to 009 | 8 | 0 | 1 |
| Live tail and backfill | BUS-TAIL-001 to 002 | 2 | 0 | 0 |
| Health stream | BUS-HEALTH-001 to 004 | 4 | 0 | 0 |
| Group reset | BUS-GROUP-001 | 1 | 0 | 0 |
| Shutdown | BUS-STOP-001 to 005 | 4 | 0 | 1 |
| Test double | BUS-TEST-001 to 008 | 8 | 0 | 0 |

**Summary:** 43 of 46 specs implemented; 0 deferred; 3 gaps.

## Key Findings

1. **Crash recovery cannot recover across restarts** — `subscribe` drains pending entries for `this.consumer` (`packages/bus/src/index.ts:136-148`) but the consumer name has a random suffix per process (`index.ts:40`) and no `XCLAIM` exists; also a single 50-entry pending batch only (`index.ts:161`). Matches the OpenSpec text, not the comment's intent (`index.ts:135`). (BUS-SUB-008)
2. **Handler failures and undecodable entries are silently dropped** — ack-always at `index.ts:159`; `decode` swallows every parse error with no log (`index.ts:215-217`); the ack-on-failure behavior is pinned by `bus.test.ts:52-77`. A schema mismatch between producer and consumer would lose events invisibly. (BUS-SUB-005, BUS-SUB-007)
3. **Multiple `onShutdown` registrations race to `process.exit(0)`** — each registration has its own `done` flag and exits (`index.ts:230-245`); `services/eyes/src/index.ts:84,87` registers two, chat and ears register several. `finally { process.exit(0) }` also masks a failing shutdown callback. (BUS-STOP-004, BUS-STOP-005)
4. **`tail` / `tailHealth` handlers are unguarded and read errors are rethrown with no backoff** — `index.ts:90,183`, `index.ts:145,176-178`; callers use `void bus.tail(...)` (`services/dashboard/src/feed.ts:47-48`) so failures are unhandled rejections. (BUS-SUB-009)
5. **OpenSpec has drifted** — the merged `add-test-injection` bus delta restates `control.cmd` as five values (copied from baseline) while the code and `add-service-control` accept seven (`events.ts:160`); the bus baseline spec still lists 15 events and none of `publishHealth`, `tailHealth`, `recentHealth`, `resetGroup`, `beforeShutdown` outside the change deltas; `add-isolated-backends` has no bus delta despite the brief naming four.
6. **`inject.request` is under-constrained at the schema level** — no per-`kind` required fields (`events.ts:171-186`); each service's `inject.ts` re-checks. (BUS-EVT-011)
7. **Test coverage is uneven** — no test for pending drain, `types` filter on undecodable entries in `subscribe`, throwing `tail` handler, `beforeShutdown` timeout, or the whole `@cohost/testing` package; integration tests write to production stream keys and leave groups behind (`bus.test.ts:21-43,79-93`). `[inferred]` the shared dev Redis is expected to be disposable.
8. **Process-lifecycle helpers live in the bus package** — `onShutdown`, `beforeShutdown` and `startHeartbeat` import each other in a cycle (`index.ts:247`, `heartbeat.ts:2`); works only because the call is deferred to runtime. `[inferred]` they sit here because every service already imports `@cohost/bus`.

## Work Required

### Must Fix
1. Make cross-restart recovery real or change the comment/spec to say it is not provided (BUS-SUB-008): stable consumer names plus `XAUTOCLAIM`, or drop the drain and document at-most-once semantics.
2. Make multiple `onShutdown` registrations compose (one signal handler, all callbacks run, then exit) and decide the exit code on failure (BUS-STOP-004, BUS-STOP-005).

### Should Fix
3. Guard `tail` / `tailHealth` handlers and surface `subscribe` / `tail` failures to callers (log and retry, or crash deliberately) instead of unhandled rejections (BUS-SUB-009).
4. Log (at least at debug or warn) when `decode` drops an entry (BUS-SUB-007).
5. Reconcile OpenSpec: fix the `control.cmd` list in the `add-test-injection` bus delta, then archive the four changes so the bus baseline covers 19 events, the health stream and shutdown hooks.
6. Add per-`kind` refinement to `inject.request` or document that services own it (BUS-EVT-011).

### Nice to Have
7. Add tests for the pending drain, `beforeShutdown` timeout, throwing tail handlers, and give `@cohost/testing` its own tests (BUS-TEST-001 to 008).
8. Use a test-specific stream key / cleanup groups in bus integration tests; probe Redis once.
9. Add range constraints to `avatar.state`, and move the shutdown/heartbeat helpers out of the bus package if the cycle becomes a problem.
