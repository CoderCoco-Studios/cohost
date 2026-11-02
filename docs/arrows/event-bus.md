# Arrow: event-bus

The typed Redis Streams bus (`@cohost/bus`) that is the only channel between cohost services, plus the `@cohost/testing` test double for it.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 60 specs: 50 implemented, 0 deferred, 10 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **P8** delivery and start position across restarts → at most once (BUS-SUB-008 rewritten, `[x]`); every subscription names an explicit start mode, `latest` (reset to `$` on every start; all subscribers except memory) or `resume` (keep the position; memory). Specs: BUS-SUB-001, BUS-SUB-002, BUS-SUB-008, BUS-SUB-010, BUS-SUB-011.
2. **R2** several `onShutdown` registrations → one sequence: every callback runs, errors logged, exit 0 once. Specs: BUS-STOP-005.
3. **S51** per-kind `inject.request` completeness → owned by the target services; BUS-EVT-011 deleted.
4. **R1** `subscribe` / `tail` failures → log and retry with a capped, growing delay; tail handlers guarded. Specs: BUS-SUB-009, BUS-TAIL-003, BUS-TAIL-004.
5. **H1** overlap with control-plane → event-bus owns the heartbeat transport (BUS-STREAM-004, BUS-HEALTH-001) and shutdown mechanics (BUS-STOP-002); CTRL-HEARTBEAT-007 deleted and CTRL-HEARTBEAT-005 narrowed in control-plane.
6. **R2** synchronously throwing `beforeShutdown` hook → treated like a rejection. Specs: BUS-STOP-006.
7. **B2** `avatar.state` lacks `mouthSmile` → add the field to the schema. Specs: BUS-EVT-018.

## References

### HLD
- docs/high-level-design.md (System Design: bus of 19 event types plus `cohost:health`)

### LLD
- docs/intent/event-bus/event-bus-design.md

### EARS
- docs/intent/event-bus/event-bus-specs.md (60 specs: 50 `[x]`, 10 `[ ]`, 0 `[D]`; BUS-EVT-011 is retired and its number not reused)

### Tests
- packages/bus/test/bus.test.ts (358 lines; 23 `@spec` lines with 29 `BUS-*` and 6 `CTRL-*` citations; schema tests run without Redis, integration tests skip when no Redis at `REDIS_URL`)
- packages/bus/test/shutdown.fixture.ts (subprocess fixture for the SIGTERM ordering test; no annotations)
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

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Publish and envelope | BUS-STREAM-001 to 006 | 6 | 0 | 0 | 4 |
| Event catalogue and schemas | BUS-EVT-001 to 019 (011 retired) | 17 | 0 | 1 (EVT-018) | 9 |
| Consumer-group subscription | BUS-SUB-001 to 011 | 6 | 0 | 5 (SUB-001, 002, 009, 010, 011) | 3 |
| Live tail and backfill | BUS-TAIL-001 to 004 | 2 | 0 | 2 (TAIL-003, 004) | 2 |
| Health stream | BUS-HEALTH-001 to 004 | 4 | 0 | 0 | 4 |
| Group reset | BUS-GROUP-001 | 1 | 0 | 0 | 1 |
| Shutdown | BUS-STOP-001 to 006 | 4 | 0 | 2 (STOP-005, 006) | 2 |
| Test double | BUS-TEST-001 to 010 | 10 | 0 | 0 | 0 |

**Summary:** 50 of 60 specs implemented; 0 deferred; 10 gaps. 25 of the 50 implemented specs have a test carrying their `@spec` ID; every implemented spec has a code annotation. Implemented specs with no test: BUS-STREAM-002, BUS-STREAM-005, BUS-EVT-002, BUS-EVT-012 to 017, BUS-EVT-019, BUS-SUB-003, BUS-SUB-006, BUS-SUB-008, BUS-STOP-003, BUS-STOP-004, BUS-TEST-001 to 010. Gap lines that already carry a code annotation (the code is the current, superseded behaviour): BUS-SUB-001, BUS-SUB-002, BUS-SUB-009 (`packages/bus/src/index.ts:129`), BUS-EVT-018 (`events.ts:158`); BUS-SUB-001 also has a test (`bus.test.ts:23`).

## Key Findings

1. **Markers.** Every `[x]` line was confirmed in code at `49ba935`. The owner decisions turned four implemented lines into gaps because the intended behaviour changed (BUS-SUB-001 and BUS-SUB-002 for the start mode, BUS-SUB-009 for retry, BUS-EVT-018 for `mouthSmile`), turned BUS-SUB-008 from a gap into an implemented at-most-once statement, and retired BUS-EVT-011.
2. **The event schema specs match `events.ts` field for field.** BUS-EVT-002, 003, 004, 006, 009 and 010 list every field; BUS-EVT-012 (`vision.summary`), 013 (`speech.heard`), 014 (`brain.say`), 015 (`brain.status`), 016 (`voice.utterance`), 017 (`voice.playing` / `voice.done`), 018 (`avatar.state`) and 019 (`Emotion` fields) cover the rest. BUS-EVT-018 additionally requires `mouthSmile`, which the schema lacks today (B2).
3. **Other spec corrections** (IDs kept): BUS-STREAM-003 (unknown payload keys are stripped), BUS-SUB-003 (one pending batch of up to 50, then new entries), BUS-STOP-002 (rejected hooks are ignored; synchronous throws are BUS-STOP-006). BUS-TEST-009 (`FakeBus.consumer`) and BUS-TEST-010 (`silentLog`, `recordingLog`) cover the remaining test helpers.
4. **Restart behaviour today** — every subscriber passes `fromNow: true`, which only positions a newly created group; an existing group resumes (`packages/bus/src/index.ts:133-138`), so a compose or crash restart replays the backlog to every service, and only a control-plane `fresh` start skips it. The intended `latest` / `resume` modes are BUS-SUB-001, 002, 010, 011 (P8). The in-process pending drain is one 50-entry batch (`index.ts:168`), and the "crash recovery" comment (`index.ts:142`) overstates it: delivery is at most once (BUS-SUB-008).
5. **Multiple `onShutdown` registrations race to `process.exit(0)`** — each registration has its own `done` flag and exits (`index.ts:242-257`). Two are live at once in eyes (`services/eyes/src/index.ts:90,94`) and in ears under the Discord plan (`services/ears/src/index.ts:39`, `services/ears/src/discord.ts:122`); chat's three sit in exclusive branches. `finally { process.exit(0) }` also hides a failing shutdown callback. (BUS-STOP-005, R2)
6. **Handler failures and undecodable entries are silently dropped** — ack-always at `index.ts:166`; `decode` swallows every parse error with no log (`index.ts:226-228`); the ack-on-failure behaviour is pinned by `bus.test.ts:56-81`. A schema mismatch between producer and consumer would lose events invisibly. (BUS-SUB-005, BUS-SUB-007)
7. **`tail` / `tailHealth` handlers are unguarded and read errors are rethrown with no backoff** — `index.ts:94,191`, `index.ts:86-89,183-186`; callers use `void bus.tail(...)` (`services/dashboard/src/feed.ts:49-50`), so failures are unhandled rejections. (BUS-SUB-009, BUS-TAIL-003, BUS-TAIL-004, R1)
8. **Single ownership with control-plane** — the heartbeat transport and shutdown mechanics are event-bus lines only; the code entry points (`index.ts:47,63,241`) and tests (`bus.test.ts:144,154`) cite only `BUS-*` IDs for them, and CTRL-HEARTBEAT-005 (the heartbeat's `beforeShutdown` registration) is cited at `heartbeat.ts:60` and on the SIGTERM test (`bus.test.ts:256`). (H1)
9. **Test coverage is uneven** — no test for MAXLEN trimming, the consumer name, eight event shapes, group resume, the pending drain, sequential delivery, decode drops inside `subscribe`, a throwing `tail` handler, `beforeShutdown` timeout, `onShutdown` idempotence, or any of `@cohost/testing`. Partial behind annotated tests: BUS-EVT-001 (membership of three types; the count of 19 is not pinned), BUS-EVT-003 (only a high `valence`), BUS-STREAM-006 (`source` and `ts` present, not their defaults), BUS-SUB-007 (`recent` path only). Integration tests write to production stream keys and leave groups behind (`bus.test.ts:23-45,84-98`). `[inferred]` the shared dev Redis is expected to be disposable.
10. **Process-lifecycle helpers live in the bus package** — `onShutdown`, `beforeShutdown` and `startHeartbeat` import each other in a cycle (`index.ts:259`, `heartbeat.ts:2`); works only because the call is deferred to runtime. `[inferred]` they sit here because every service already imports `@cohost/bus`.
11. **The frozen OpenSpec `bus` baseline lists all 19 events and seven `control` commands;** only the archived `add-service-health` delta still lists five (`openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md:8`). The LID specs supersede it.

## Work Required

### Must Fix
1. Add the explicit start mode to `subscribe`: `latest` resets the group to `$` on every start, `resume` keeps it, a missing group is created at `$` in both; replace `fromNow` (P8; BUS-SUB-001, BUS-SUB-002, BUS-SUB-010, BUS-SUB-011). Each subscribing service then selects its mode in its own segment (memory `resume`, every other `latest`). Fix the "crash recovery" comment at `index.ts:142` to match BUS-SUB-008.
2. Retry `subscribe`, `tail` and `tailHealth` reads with a capped, growing delay and guard tail handlers (R1; BUS-SUB-009, BUS-TAIL-003, BUS-TAIL-004).
3. Compose `onShutdown` registrations into one sequence that runs every callback, logs failures and exits 0 once; treat a synchronously throwing `beforeShutdown` hook like a rejection (R2; BUS-STOP-005, BUS-STOP-006).
4. Add `mouthSmile` (number) to the `avatar.state` schema (B2; BUS-EVT-018); avatar and dashboard consume it in their segments.

### Should Fix
5. Log (at least at debug or warn) when `decode` drops an entry (BUS-SUB-007).
6. Add schema tests for BUS-EVT-002 and BUS-EVT-012 to 019, and pin the 19-type count (BUS-EVT-001).

### Nice to Have
7. Add tests for the pending drain, `beforeShutdown` timeout and `onShutdown` idempotence, and give `@cohost/testing` its own tests (BUS-TEST-001 to 010).
8. Use a test-specific stream key / clean up groups in bus integration tests; probe Redis once.
9. Add range constraints to `avatar.state`, and move the shutdown/heartbeat helpers out of the bus package if the cycle becomes a problem.
