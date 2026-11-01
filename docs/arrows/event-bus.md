# Arrow: event-bus

The typed Redis Streams bus (`@cohost/bus`) that is the only channel between cohost services, plus the `@cohost/testing` test double for it.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`). Specs verified against the code at git `49ba935`: 53 of 56 specs implemented; 0 deferred; 3 gaps (cross-restart pending recovery, per-kind `inject.request` completeness, multiple `onShutdown` registrations). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **Delivery semantics across a restart: at-least-once or at-most-once?** (BUS-SUB-008) The drain reads only this instance's pending list (`packages/bus/src/index.ts:142-155`) and the consumer name has a random per-process suffix (`index.ts:41`), so a crashed process's unacked entries are never redelivered; handler failures are already acked (`index.ts:166`, BUS-SUB-005). Recommended: declare at-most-once, rewrite BUS-SUB-008 to say so and drop the "crash recovery" drain comment, since nearly every subscriber uses `fromNow` and ack-always.
2. **Should several `onShutdown` registrations compose?** (BUS-STOP-005, BUS-STOP-004) Each registration exits the process on its own (`index.ts:242-257`); eyes (`services/eyes/src/index.ts:84,87`) and ears (`services/ears/src/index.ts:37`, `services/ears/src/discord.ts:114`) register two at once, and a failing callback still exits 0. Recommended: one signal handler that runs every callback to completion, then exits; keep exit code 0 but log callback errors.
3. **Who owns per-kind `inject.request` completeness?** (BUS-EVT-011) The schema accepts a request with neither `url` nor `text` (`packages/bus/src/events.ts:188-203`); each service's `inject.ts` re-checks and replies `inject.result`. Recommended: the services; delete BUS-EVT-011.
4. **Should `subscribe` / `tail` failures reject or retry?** (BUS-SUB-009, LLD Open Questions 2-3) A non-stop read error rejects (`index.ts:152`, `index.ts:184-186`), a throwing tail handler ends the tail (`index.ts:94`, `index.ts:191`), and callers use `void bus.subscribe(...)` / `void bus.tail(...)` (`services/dashboard/src/feed.ts:47-48`). Recommended: log and retry with backoff, and guard tail handlers with try/catch; then rewrite BUS-SUB-009.
5. **Which segment owns the overlapping heartbeat-transport and shutdown specs?** CTRL-HEARTBEAT-007 restates BUS-STREAM-004 + BUS-HEALTH-001, and CTRL-HEARTBEAT-005 restates BUS-STOP-002; `index.ts:47,63,241` carry both IDs. Recommended: event-bus owns the transport and shutdown mechanics; delete CTRL-HEARTBEAT-007 and narrow CTRL-HEARTBEAT-005 to "the heartbeat registers `stop()` as a `beforeShutdown` hook".
6. **Should a synchronously throwing `beforeShutdown` hook be ignored like a rejected one?** (BUS-STOP-002) `shutdownHooks.map((h) => h())` (`index.ts:249`) lets a sync throw skip the service callback. Recommended: yes; wrap each hook so sync throws become rejections.

## References

### HLD
- docs/high-level-design.md (System Design: bus of 19 event types plus `cohost:health`)

### LLD
- docs/intent/event-bus/event-bus-design.md

### EARS
- docs/intent/event-bus/event-bus-specs.md (56 specs: 53 `[x]`, 3 `[ ]`, 0 `[D]`)

### Tests
- packages/bus/test/bus.test.ts (358 lines; 23 `@spec` lines with 29 `BUS-*` and 8 `CTRL-*` citations; schema tests run without Redis, integration tests skip when no Redis at `REDIS_URL`)
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

**Purpose:** Validate-and-forward typed events between services over Redis Streams, with replay per service via consumer groups, a non-group live tail for the dashboard, a separate capped heartbeat stream, and shared shutdown helpers.

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
| Event catalogue and schemas | BUS-EVT-001 to 019 | 18 | 0 | 1 (EVT-011) | 9 |
| Consumer-group subscription | BUS-SUB-001 to 009 | 8 | 0 | 1 (SUB-008) | 4 |
| Live tail and backfill | BUS-TAIL-001 to 002 | 2 | 0 | 0 | 2 |
| Health stream | BUS-HEALTH-001 to 004 | 4 | 0 | 0 | 4 |
| Group reset | BUS-GROUP-001 | 1 | 0 | 0 | 1 |
| Shutdown | BUS-STOP-001 to 005 | 4 | 0 | 1 (STOP-005) | 2 |
| Test double | BUS-TEST-001 to 010 | 10 | 0 | 0 | 0 |

**Summary:** 53 of 56 specs implemented; 0 deferred; 3 gaps. 26 of the 53 implemented specs have a test carrying their `@spec` ID; every implemented spec has a code annotation. Implemented specs with no test: BUS-STREAM-002, BUS-STREAM-005, BUS-EVT-002, BUS-EVT-012 to 019, BUS-SUB-002, BUS-SUB-003, BUS-SUB-006, BUS-SUB-009, BUS-STOP-003, BUS-STOP-004, BUS-TEST-001 to 010.

## Key Findings

1. **Markers hold.** Every `[x]` line was confirmed in code and every `[ ]` gap still reproduces; no marker was flipped.
2. **The event schema specs now match `events.ts` field for field.** BUS-EVT-002, 003, 004, 006, 009 and 010 were completed with the fields they omitted (`chat.message` `user`/`text`/`userId`, `affect.state` `mood`/`cause`, `control.text`, `inject.request.meta` types, `service.heartbeat` field types, the full `attention.focus` and `memory.*` shapes). New lines cover the eight event types that had none and the shared `Emotion` contract: BUS-EVT-012 (`vision.summary`), 013 (`speech.heard`), 014 (`brain.say`), 015 (`brain.status`), 016 (`voice.utterance`), 017 (`voice.playing` / `voice.done`), 018 (`avatar.state`), 019 (`Emotion` fields).
3. **Other spec corrections** (IDs kept): BUS-STREAM-003 (unknown payload keys are stripped), BUS-SUB-003 (one pending batch of up to 50, then new entries), BUS-STOP-002 (only rejected hooks are ignored; a synchronous throw skips the service callback). New lines BUS-TEST-009 (`FakeBus.consumer`) and BUS-TEST-010 (`silentLog`, `recordingLog`).
4. **Crash recovery cannot recover across restarts** — `subscribe` drains pending entries for `this.consumer` (`packages/bus/src/index.ts:143-155`) but the consumer name has a random suffix per process (`index.ts:41`) and no `XCLAIM` exists; also a single 50-entry pending batch only (`index.ts:168`). Matches the OpenSpec text, not the comment's intent (`index.ts:142`). (BUS-SUB-008, Question 1)
5. **Multiple `onShutdown` registrations race to `process.exit(0)`** — each registration has its own `done` flag and exits (`index.ts:242-257`). Two are live at once in eyes with vision disabled (`services/eyes/src/index.ts:84,87`) and in ears under the Discord plan (`services/ears/src/index.ts:37`, `services/ears/src/discord.ts:114`); chat's three sit in exclusive branches. `finally { process.exit(0) }` also masks a failing shutdown callback. (BUS-STOP-004, BUS-STOP-005, Question 2)
6. **Handler failures and undecodable entries are silently dropped** — ack-always at `index.ts:166`; `decode` swallows every parse error with no log (`index.ts:226-228`); the ack-on-failure behavior is pinned by `bus.test.ts:56-81`. A schema mismatch between producer and consumer would lose events invisibly. (BUS-SUB-005, BUS-SUB-007)
7. **`tail` / `tailHealth` handlers are unguarded and read errors are rethrown with no backoff** — `index.ts:94,191`, `index.ts:152,184-186`; callers use `void bus.tail(...)` (`services/dashboard/src/feed.ts:47-48`) so failures are unhandled rejections. (BUS-SUB-009, Question 4)
8. **Overlapping specs with control-plane** — CTRL-HEARTBEAT-005 and CTRL-HEARTBEAT-007 restate BUS-STOP-002, BUS-STREAM-004 and BUS-HEALTH-001. (Question 5)
9. **Test coverage is uneven** — no test for MAXLEN trimming, the consumer name, eight event shapes, group resume, the pending drain, sequential delivery, decode drops inside `subscribe`, a throwing `tail` handler, `beforeShutdown` timeout, `onShutdown` idempotence, or any of `@cohost/testing`. Partial behind annotated tests: BUS-EVT-001 (membership of three types; the count of 19 is not pinned), BUS-EVT-003 (only a high `valence`), BUS-STREAM-006 (`source` and `ts` present, not their defaults), BUS-SUB-007 (`recent` path only). Integration tests write to production stream keys and leave groups behind (`bus.test.ts:23-45,84-98`). `[inferred]` the shared dev Redis is expected to be disposable.
10. **Process-lifecycle helpers live in the bus package** — `onShutdown`, `beforeShutdown` and `startHeartbeat` import each other in a cycle (`index.ts:259`, `heartbeat.ts:2`); works only because the call is deferred to runtime. `[inferred]` they sit here because every service already imports `@cohost/bus`.
11. **The frozen OpenSpec `bus` baseline lists all 19 events and seven `control` commands;** only the archived `add-service-health` delta still lists five (`openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md:8`). The LID specs supersede it.

## Work Required

### Must Fix
1. Decide delivery semantics across restarts and make BUS-SUB-008 match (Question 1): stable consumer names plus `XAUTOCLAIM`, or drop the drain and document at-most-once.
2. Make multiple `onShutdown` registrations compose (one signal handler, all callbacks run, then exit) and decide the exit code on failure (BUS-STOP-004, BUS-STOP-005, Question 2).

### Should Fix
3. Guard `tail` / `tailHealth` handlers and surface `subscribe` / `tail` failures to callers (log and retry, or crash deliberately) instead of unhandled rejections (BUS-SUB-009, Question 4).
4. Log (at least at debug or warn) when `decode` drops an entry (BUS-SUB-007).
5. Settle `inject.request` completeness ownership (BUS-EVT-011, Question 3) and the overlapping control-plane specs (Question 5).
6. Add schema tests for BUS-EVT-002 and BUS-EVT-012 to 019, and pin the 19-type count (BUS-EVT-001).

### Nice to Have
7. Add tests for the pending drain, `beforeShutdown` timeout, throwing tail handlers, and give `@cohost/testing` its own tests (BUS-TEST-001 to 010).
8. Use a test-specific stream key / cleanup groups in bus integration tests; probe Redis once.
9. Add range constraints to `avatar.state`, and move the shutdown/heartbeat helpers out of the bus package if the cycle becomes a problem.
