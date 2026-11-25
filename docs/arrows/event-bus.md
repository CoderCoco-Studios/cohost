# Arrow: event-bus

The typed Redis Streams bus (`@cohost/bus`) that is the only channel between cohost services, plus the `@cohost/testing` test double for it.

## Status

**AUDITED** (date and commit in `index.yaml`). Spec file: 215 specs, 205 `[x]`, 5 `[ ]`, 5 `[D]`; BUS-NAT-BLD-001, -002, -005, -009 and BUS-NAT-ERR-011 are rewritten for the mise tasks of deployment #344 and close with its implementation. Every `[x]` line is observed in code. Of the 210 `[x]` specs, 202 have an `@spec` annotation in a test file and 8 do not (listed under Work Required; recounted 2026-11-23). A `<!-- test: -->` pointer in the spec file names the test file that carries the annotation. The `[D]` lines are listed under Work Required. The docs site's extension guides added BUS-NAT-EX-001 to BUS-NAT-EX-005 (the Rust example client `cohost-example-bus`); BUS-NAT-EX-001 is verified by a manifest test. BUS-NAT-EX-002 to BUS-NAT-EX-005 are `[x]`: `examples/rust-bus/tests/round_trip.rs` ran against the Redis service of `test.yml` on PR #247 (GitHub Actions run 45095337667, 2026-11-23, log line `RAN round_trip against redis://127.0.0.1:6379`; re-run green on head 65aeab0, run 45096011116), and that file fails, not skips, when `REDIS_URL` is set and Redis is unreachable. `packages/bus/test/example-rust-bus.test.ts` asserts the same under `pnpm test`, and a dedicated `test.yml` step fails on a `SKIP` line. The avatar-frame stream (BUS-AVF-001 to BUS-AVF-012) is built on the frames path (`avatar-frame.ts`, `frames.ts`, the `Bus` facade). Its three Redis-gated tests in `avatar-frames.test.ts` skip without a Redis server; where none ran, they are unproven.

## Native transport: events path native, frames path TypeScript (built)

Design: LLD § Native transport (Rust crate `crates/cohost-bus` behind napi-rs for the events path, `BusTransport` seam; the frames path TypeScript on ioredis behind a `FrameTransport` seam; measurement gate on the events path; design constraints N1 to N3). Follows HLD tenet 12, one language per service. Frames stay TypeScript because one napi crossing per frame measured 1.31x the CPU of TypeScript (LLD § Measurement gate, "The measurement that set the split").

- **Gate.** The events path passed: 8 sources, 3 runs, medians, events x8 TypeScript 11.26% CPU / p99 4.53 ms vs native 9.86% / 2.29 ms (TS baseline built from `6adc350`, quiet machine). Absolute numbers vary between runs; only within-run ratios compare (LLD § Measurement gate, "Gate result"). The gate specs (BUS-NAT-GATE-001, 004, 005, 006) are `[D]`.
- **Wire conventions.** The frame codec, tag grammar and connector protocol constants are TypeScript in `connector.ts`; the audio stream names are built by `audioStreamName` in `frames.ts` (BUS-NAT-RS-006). The crate exports none of the protocol constants and keeps a private registration version (1) for its registration codec (BUS-NAT-RS-004, BUS-NAT-RS-008).
- **Frames path.** Lazy connections: the publish connection opens at the first `appendFrame` or `appendAvatarFrame`, each frame reader at its first `readFrames` or `readAvatarFrames` (BUS-NAT-FRM-005). Failures reject `BUS_REDIS` for a Redis error and `BUS_CONNECTION` for a connection failure (BUS-NAT-FRM-008).
- **Retired, numbers not reused:** BUS-STOP-002 to BUS-STOP-006 (now SHARED-LIFE-001 to SHARED-LIFE-005), BUS-EVT-011, BUS-NAT-BLD-008, BUS-NAT-CI-001, BUS-NAT-CI-003 (superseded by deployment DEPLOY-IMG-001, DEPLOY-CI-001), BUS-NAT-TRN-006, BUS-NAT-TRN-012 (LLD constraints N1, N3), BUS-NAT-GATE-002, BUS-NAT-GATE-003 (frames-path gate conditions).
- **Cross-segment specs of this change:** control-plane CTRL-CHECK-004, CTRL-CLI-017; connections CONN-AUD-002; shared-runtime SHARED-BOOT-005, SHARED-BOOT-006, SHARED-LIFE-001, SHARED-LIFE-004; avatar AVATAR-BUS-008, AVATAR-STATE-002; deployment DEPLOY-IMG-001, DEPLOY-IMG-004, DEPLOY-CI-006.

## Other built areas

- **Tool timer hash over Redis.** `Bus.putTimer`, `Bus.deleteTimer` and `Bus.listTimers` keep the tools service's pending timers as fields of `<prefix>:tools:timers` (BUS-TIMER-001, BUS-TIMER-002); the transport carries the three calls (BUS-NAT-TRN-001) and `FakeBus` keeps them in memory (BUS-TEST-004).
- **Upload store over Redis.** `Bus.putUpload` / `Bus.takeUpload` (BUS-UPL-001 to BUS-UPL-003); `inject.request` carries `uploadId` and `contentType` (BUS-EVT-006); `FakeBus` mirrors both (BUS-TEST-012).
- **Transport behaviour.** Pending drain batch by batch (BUS-SUB-003), no ack or further handling after `stop()` (BUS-SUB-013), `failFast` (BUS-STREAM-009), `streamPrefix` (BUS-STREAM-008), one `PlaybackReport` shape and ranges on `avatar.state` (BUS-EVT-017, BUS-EVT-018), time-ordered ids in `FakeBus` and `event()` (BUS-TEST-011, BUS-TEST-003, BUS-TEST-006). Design: LLD Decisions & Alternatives.
- **Event catalogue.** 37 payloads built in `EventPayloads` (BUS-EVT-001): 36 event types on the event stream, including `brain.clause` (the clause of a streamed line, BUS-EVT-038 to BUS-EVT-042), the six tool events (`tool.request`, `tool.result`, `tool.catalog`, `tool.timer`, `tool.confirm`, `tool.answer`, BUS-EVT-043 to BUS-EVT-050), and `service.heartbeat` on the health stream. The early-reply events `speech.early`, `speech.retracted` and `attention.resolve`, their members (BUS-EVT-052 to 060) and the `timing` stamps `closedAt`, `confirmedAt`, `heldAt`, `toolStartedAt` and `toolEndedAt` (BUS-EVT-024) are built. `voice.failed` (BUS-EVT-022), the four viewer-notes events (BUS-EVT-020, BUS-EVT-021), `speech.partial` (BUS-EVT-026 to BUS-EVT-029) and `voice.stop` with the interruption and `final` members of `voice.done` (BUS-EVT-030, BUS-EVT-031) are built. Design: LLD § Event catalogue.
- **Restart and delivery.** `subscribe` takes a required `start` (`latest` or `resume`); a missing group is created at `$`, `latest` moves an existing group to `$` before the first read, `resume` keeps it (BUS-SUB-001, 002, 010, 011). Delivery is at most once; a refused ack leaves the entry pending for one redelivery by a later drain, and a second refusal drops it (BUS-SUB-008, BUS-NAT-ACK-003, BUS-NAT-ACK-008, BUS-NAT-ACK-009). `stop()` flushes queued acks within 2 s (BUS-NAT-ACK-005 to 007).
- **Outage behaviour.** The shared connection waits only for its first connect attempt (at most 10 s); afterwards every command rejects `BUS_CONNECTION` at once while it is down, and reconnects in the background (BUS-NAT-CONN-004 to 007). Read loops back off and drain pending entries after a failure (BUS-NAT-CONN-002, 003).
- **Shutdown** lives in shared-runtime (`onShutdown`, `beforeShutdown`, SHARED-LIFE-*); `Bus.stop()` is async and is awaited by that sequence (BUS-STOP-001, SHARED-BOOT-005).

## References

### HLD
- docs/high-level-design.md (System Design; Native layer; tenet 12)

### LLD
- docs/intent/event-bus/event-bus-design.md

### EARS
- docs/intent/event-bus/event-bus-specs.md (215 specs: 205 `[x]`, 5 `[ ]`, 5 `[D]`; retired numbers listed in the spec file are not reused)

### Tests
- packages/bus/test/: early.test.ts, bus.test.ts, clauses.test.ts, tool-events.test.ts, timers.test.ts, resilience.test.ts, native-api.test.ts, native-loops.test.ts, native-binding.test.ts, native-integration.test.ts, native-panic.test.ts, native-build.test.ts, native-bench.test.ts, frames.test.ts, contract.test.ts, connector.test.ts, upload.test.ts, partial.test.ts, timing.test.ts, control-routing.test.ts
- crates/cohost-bus/tests/: transport.rs, connection.rs, contract.rs, workspace.rs
- packages/testing/test/fake-bus.test.ts
- services/salience/test/timing.test.ts, services/cortex/test/timing.test.ts (BUS-EVT-025)

### Code (files carrying `@spec BUS-` annotations)
- packages/bus/src/: index.ts, events.ts, frames.ts, avatar-frame.ts, native.ts, connector.ts
- crates/cohost-bus/src/: codec.rs, consts.rs, error.rs, keys.rs, transport.rs
- crates/cohost-bus-node/src/lib.rs
- packages/testing/src/index.ts
- Also part of the segment: packages/bus/src/transport.ts (`BusTransport`, `FrameTransport`), registrar.ts, Cargo.toml, rust-toolchain.toml, packages/bus/package.json, scripts/dev/bus-bench.ts (the measurement gate; carries `@spec BUS-NAT-GATE-007`)

## Architecture

**Purpose:** Validate-and-forward typed events between services over Redis Streams, with a per-service read position via consumer groups (start mode `latest` or `resume`), a non-group live tail for the dashboard, a separate capped heartbeat stream, and a native (Rust) events-path transport.

**Key Components:**
1. `events.ts`: `EventPayloads` zod registry of 37 payloads (36 event types and the heartbeat), all built; `EVENT_TYPES` is derived from it.
2. `Bus` class in `index.ts`: `publish`, `publishHealth`, `subscribe` (consumer group), `tail`, `tailHealth`, `recent`, `recentHealth`, `resetGroup`, `stop`, plus uploads, registrations, audio frames and the avatar-frame stream.
3. `native.ts` and `crates/cohost-bus`, `crates/cohost-bus-node`: the events-path transport; `frames.ts`: the ioredis frame transport.
4. `FakeBus`, `testConfig`, `event`, `runHeartbeat`, `waitFor`, `silentLog`, `recordingLog` in `@cohost/testing`: the test double and helpers.

## Spec Coverage

| Category | Spec IDs | `[x]` | `[ ]` | `[D]` |
|----------|----------|-------|-------|-------|
| Publish and envelope | BUS-STREAM-001 to 009 | 9 | 0 | 0 |
| Connector audio streams | BUS-AUD-001, 002 | 2 | 0 | 0 |
| Upload store | BUS-UPL-001 to 003 | 3 | 0 | 0 |
| Event catalogue and schemas | BUS-EVT-001 to 032 (011 retired) | 31 | 0 | 0 |
| Chat removal | BUS-EVT-033 to 036 | 4 | 0 | 0 |
| Streamed lines | BUS-EVT-037 to 042 | 6 | 0 | 0 |
| Tool events | BUS-EVT-043 to 051 | 9 | 0 | 0 |
| Early reply | BUS-EVT-052 to 060 | 9 | 0 | 0 |
| Speaker id on notes | BUS-EVT-061 | 1 | 0 | 0 |
| Consumer-group subscription | BUS-SUB-001 to 013 | 13 | 0 | 0 |
| Live tail and backfill | BUS-TAIL-001 to 005 | 5 | 0 | 0 |
| Health stream | BUS-HEALTH-001 to 004 | 4 | 0 | 0 |
| Group reset | BUS-GROUP-001 | 1 | 0 | 0 |
| Shutdown | BUS-STOP-001 | 1 | 0 | 0 |
| Native: facade API | BUS-NAT-API-001 to 011 | 11 | 0 | 0 |
| Native: examples | BUS-NAT-EX-001 to 005 | 5 | 0 | 0 |
| Native: transport | BUS-NAT-TRN-001 to 014 (006, 012 retired) | 12 | 0 | 0 |
| Native: acks | BUS-NAT-ACK-001 to 009 | 9 | 0 | 0 |
| Native: connections | BUS-NAT-CONN-001 to 008 | 8 | 0 | 0 |
| Native: errors | BUS-NAT-ERR-001 to 011 | 11 | 0 | 0 |
| Native: frames | BUS-NAT-FRM-001 to 008 | 8 | 0 | 0 |
| Avatar frames | BUS-AVF-001 to 012 | 12 | 0 | 0 |
| Native: crate | BUS-NAT-RS-001 to 009 | 8 | 0 | 1 |
| Native: contract fixtures | BUS-NAT-FIX-001 to 004 | 4 | 0 | 0 |
| Native: build | BUS-NAT-BLD-001 to 009 (008 retired) | 8 | 0 | 0 |
| Native: CI | BUS-NAT-CI-002 (001, 003 retired) | 1 | 0 | 0 |
| Native: measurement gate | BUS-NAT-GATE-001, 004 to 007 (002, 003 retired) | 1 | 0 | 4 |
| Test double | BUS-TEST-001 to 012 | 12 | 0 | 0 |
| Tool timer hash | BUS-TIMER-001 to 002 | 2 | 0 | 0 |

**Summary:** 215 specs: 210 implemented, 0 gaps, 5 deferred. The early-reply specs (BUS-EVT-052 to 060) and the 37-payload catalogue (BUS-EVT-001) are built. `node scripts/lid-check.mjs` finds no reverse orphans.

## Work Required

- `attention.resolve` (BUS-EVT-056 to 057) is a discriminated union, so it has no `.shape`. `services/dashboard/src/inject.ts` (`:91`) would not mark an injected confirm. No unit declares it as an input yet; #225 (cortex) must handle this before one does.
### Should Fix

### Deferred (`[D]`)
- BUS-NAT-GATE-001, 004, 005, 006 (merge gate): a one-time procedure; the measured events-path result is recorded in LLD § Measurement gate. BUS-NAT-RS-009 (add a Rust codec type with its fixtures): a procedure for future work, with no Rust service yet.

### `[x]` specs with no annotated test

BUS-STREAM-002, BUS-EVT-012, 014, 015, 019, BUS-SUB-006, BUS-NAT-ERR-001, BUS-NAT-RS-008. Their code matches the spec; a schema or behaviour test per spec would close each.
