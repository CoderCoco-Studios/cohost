# Arrow: event-bus

The typed Redis Streams bus (`@cohost/bus`) that is the only channel between cohost services, plus the `@cohost/testing` test double for it.

## Status

**AUDITED** — audited 2026-11-14 at git `4319d8d` (native transport closeout); mapped 2026-10-31 (`686cc8f`). Spec file: 165 specs, 150 `[x]`, 15 `[ ]`, 0 `[D]`. Every `[x]` line is observed in code and has a test that carries its `@spec` ID (a `<!-- test: -->` pointer names the file); every `[ ]` line is listed under Work Required with the reason it stays open.

## Native transport: events path native, frames path TypeScript (built)

Design: LLD § Native transport (Rust crate `crates/cohost-bus` behind napi-rs for the events path, `BusTransport` seam; the frames path TypeScript on ioredis behind a `FrameTransport` seam; measurement gate on the events path; design constraints N1 to N3). Follows HLD tenet 12, one language per service. Frames stay TypeScript because one napi crossing per frame measured 1.31x the CPU of TypeScript (LLD § Measurement gate, "The measurement that set the split").

- **Gate.** Passed on the events path: 8 sources, 3 runs, medians, events x8 TypeScript 11.26% CPU / p99 4.53 ms vs native 9.86% / 2.29 ms (TS baseline built from `6adc350`, quiet machine). Absolute numbers vary between runs; only within-run ratios compare (LLD § Measurement gate, "Gate result").
- **Verified at closeout** (`4319d8d`): `pnpm test` and `REDIS_URL=… node --import tsx --test packages/bus/test/*.test.ts` (154 pass against Redis 7.4), `cargo test --workspace` against the same Redis (37 pass). 69 of the 84 `BUS-NAT-*` specs are `[x]`, as are the amended BUS-STREAM-005, BUS-STREAM-009, BUS-SUB-008, BUS-SUB-009 and BUS-STOP-001.
- **Wire conventions.** The frame codec, tag grammar and connector protocol constants are TypeScript in `connector.ts`; the audio stream names are built by `audioStreamName` in `frames.ts` (BUS-NAT-RS-006). The crate exports none of the protocol constants and keeps a private registration version (1) for its registration codec (BUS-NAT-RS-004, BUS-NAT-RS-008).
- **Frames path.** Lazy connections: the publish connection opens at the first `appendFrame`, each frame reader at its first `readFrames` (BUS-NAT-FRM-005). Failures reject `BUS_REDIS` for a Redis error and `BUS_CONNECTION` for a connection failure (BUS-NAT-FRM-008).
- **Retired, numbers not reused:** BUS-NAT-BLD-008, BUS-NAT-CI-001, BUS-NAT-CI-003 (superseded by deployment DEPLOY-IMG-001, DEPLOY-CI-001), BUS-NAT-TRN-006, BUS-NAT-TRN-012 (LLD constraints N1, N3), BUS-NAT-GATE-002, BUS-NAT-GATE-003 (frames-path gate conditions).
- **Cross-segment specs of this change:** `[x]` after verification: control-plane CTRL-CHECK-004, CTRL-CLI-017; connections CONN-AUD-002; shared-runtime SHARED-BOOT-005, SHARED-BOOT-006, SHARED-LIFE-001, SHARED-LIFE-004; avatar AVATAR-BUS-008, AVATAR-STATE-002; deployment DEPLOY-IMG-001, DEPLOY-IMG-004, DEPLOY-CI-006. Still `[ ]` (CI, installer and Docker-in-CI behaviour, not observable from a local run): DEPLOY-CI-001, DEPLOY-CI-002, DEPLOY-CI-007, DEPLOY-INST-007, DEPLOY-INST-014. The voice LLD's prose was corrected with no spec change.

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
- docs/high-level-design.md (System Design; Native layer; tenet 12)

### LLD
- docs/intent/event-bus/event-bus-design.md

### EARS
- docs/intent/event-bus/event-bus-specs.md (165 specs: 150 `[x]`, 15 `[ ]`, 0 `[D]`; retired numbers listed in the spec file are not reused)

### Tests
- packages/bus/test/bus.test.ts (schemas without Redis; integration tests skip when no Redis at `REDIS_URL`)
- packages/bus/test/resilience.test.ts (`Bus` loops against a scripted fake `BusTransport` through `BusOptions.transport`; runs without Redis)
- packages/bus/test/native-api.test.ts, native-loops.test.ts (facade over fake transports), native-binding.test.ts (the addon's exports), native-integration.test.ts (the addon against a real Redis, with `native-failfast.fixture.ts` in a subprocess)
- packages/bus/test/frames.test.ts (the ioredis frame transport), contract.test.ts (contract fixtures), connector.test.ts, upload.test.ts, partial.test.ts, timing.test.ts, control-routing.test.ts
- crates/cohost-bus/tests/transport.rs, connection.rs, contract.rs, workspace.rs, and unit tests in crates/cohost-bus/src/{codec,consts,error,keys}.rs
- packages/testing/test/fake-bus.test.ts

### Code
- packages/bus/src/index.ts (the `Bus` facade), events.ts (the registry), transport.ts (`BusTransport`, `FrameTransport`), native.ts (the addon adapter), frames.ts (ioredis frame transport, audio stream names), connector.ts, registrar.ts
- crates/cohost-bus (transport, keys, consts, codec, error), crates/cohost-bus-node (napi-rs binding)
- Cargo.toml, rust-toolchain.toml, packages/bus/package.json
- packages/testing/src/index.ts, fake-transport.ts
- scripts/dev/bus-bench.ts (the measurement gate)

## Architecture

**Purpose:** Validate-and-forward typed events between services over Redis Streams, with a per-service read position via consumer groups (start mode `latest` or `resume`), a non-group live tail for the dashboard, a separate capped heartbeat stream, and shared shutdown helpers.

**Key Components:**
1. `events.ts` — `EventPayloads` zod registry of 19 event types, derived types, `EVENT_TYPES`.
2. `Bus` class in `index.ts` — `publish`, `publishHealth`, `subscribe` (consumer group), `tail`, `tailHealth`, `recent`, `recentHealth`, `resetGroup`, `stop`.
3. `onShutdown` / `beforeShutdown` — signal handling with a 2 s pre-shutdown hook window (the heartbeat `stopping` message rides this).
4. `heartbeat.ts` — `startHeartbeat`, `tracked` (control-plane-owned).
5. `FakeBus`, `testConfig`, `event`, `runHeartbeat`, `waitFor`, `silentLog`, `recordingLog` in `@cohost/testing` — the test double and helpers.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Publish and envelope | BUS-STREAM-001 to 009 | 9 | 0 | 0 |
| Connector audio, registry, uploads | BUS-AUD-001, 002, BUS-UPL-001 to 003 | 5 | 0 | 0 |
| Event catalogue and schemas | BUS-EVT-001 to 032 (011 retired) | 31 | 0 | 0 |
| Consumer-group subscription | BUS-SUB-001 to 013 | 13 | 0 | 0 |
| Live tail and backfill | BUS-TAIL-001 to 005 | 5 | 0 | 0 |
| Health stream and group reset | BUS-HEALTH-001 to 004, BUS-GROUP-001 | 5 | 0 | 0 |
| Shutdown | BUS-STOP-001 | 1 | 0 | 0 |
| Native: facade API | BUS-NAT-API-001 to 011 | 11 | 0 | 0 |
| Native: transport | BUS-NAT-TRN-* (12) | 11 | 0 | 1 |
| Native: acks, connections | BUS-NAT-ACK-001 to 008, BUS-NAT-CONN-001 to 007 | 15 | 0 | 0 |
| Native: errors | BUS-NAT-ERR-001 to 011 | 10 | 0 | 1 |
| Native: frames | BUS-NAT-FRM-001 to 008 | 7 | 0 | 1 |
| Native: crate, fixtures | BUS-NAT-RS-001 to 009, BUS-NAT-FIX-001 to 004 | 11 | 0 | 2 |
| Native: build, CI, gate | BUS-NAT-BLD-* (8), BUS-NAT-CI-002, BUS-NAT-GATE-* (5) | 4 | 0 | 10 |
| Test double | BUS-TEST-001 to 012 | 12 | 0 | 0 |

**Summary:** 165 specs, 150 implemented, 15 open, 0 deferred. `node scripts/lid-check.mjs`: 0 problems.

## Key Findings

1. **Markers.** Every `[x]` line is observed in code and has a test carrying its `@spec` ID. The open lines are listed under Work Required.
2. **The event schema specs match `events.ts` field for field.** BUS-EVT-002, 003, 004, 006, 009 and 010 list every field; BUS-EVT-012 (`vision.summary`), 013 (`speech.heard`), 014 (`brain.say`), 015 (`brain.status`), 016 (`voice.utterance`), 017 (`voice.playing` / `voice.done`), 018 (`avatar.state`) and 019 (`Emotion` fields) cover the rest. BUS-EVT-018 requires `mouthSmile` and bounds every `avatar.state` number; BUS-EVT-017 gives `voice.playing` and `voice.done` one shared shape.
3. **Other spec corrections** (IDs kept): BUS-STREAM-003 (unknown payload keys are stripped), BUS-SUB-003 (the pending drain reads batch by batch until none remain, then new entries), SHARED-LIFE-001 (rejected hooks are ignored; synchronous throws are SHARED-LIFE-005). BUS-TEST-009 (`FakeBus.consumer`) and BUS-TEST-010 (`silentLog`, `recordingLog`) cover the remaining test helpers.
4. **Restart behaviour.** `subscribe` takes a required `start` (`latest` or `resume`); a missing group is created at `$`, `latest` moves an existing group to `$` before the first read, `resume` keeps it (BUS-SUB-001, 002, 010). `fromNow` is removed; every service caller names `start` (memory `resume`, the rest `latest`) (BUS-SUB-011). Delivery is at most once (BUS-SUB-008).
5. **Delivery stays at most once on the native transport.** Acks are queued and sent ahead of the next `XREADGROUP` (BUS-NAT-ACK-001); a refused ack leaves the entry pending for one redelivery by a later drain, and a second refusal drops it (BUS-SUB-008, BUS-NAT-ACK-003, BUS-NAT-ACK-008). `stop()` flushes queued acks within 2 s (BUS-NAT-ACK-005 to 007).
6. **Handler failures and undecodable entries are acknowledged and dropped without a log** (BUS-SUB-005, BUS-SUB-007); a schema mismatch between producer and consumer loses events silently.
7. **Outage behaviour.** The shared connection waits only for its first connect attempt (at most 10 s); afterwards every command rejects `BUS_CONNECTION` at once while it is down, and reconnects in the background (BUS-NAT-CONN-004 to 007). Read loops back off and drain pending entries after a failure (BUS-NAT-CONN-002, 003).
8. **Process shutdown lives in shared-runtime** (`onShutdown`, `beforeShutdown`, SHARED-LIFE-*); `Bus.stop()` is async and is awaited by that sequence (BUS-STOP-001, SHARED-BOOT-005).
9. **Tests are isolated from production streams** by `streamPrefix` (BUS-STREAM-008) in TypeScript and by a per-test prefix in the Rust integration tests (BUS-NAT-CI-002).

## Work Required

### Open specs (implemented or procedural, but not closable from a local test)
1. BUS-NAT-TRN-011 (native layer never writes to stdout/stderr): implemented (no print in either crate; the panic hook is silenced), no test annotated with it; the failfast subprocess test checks empty stdout/stderr but cites other IDs.
2. BUS-NAT-ERR-006 (a panic rejects `BUS_INTERNAL`): implemented (`catch_unwind` in the binding, `panic = "unwind"`), but no test builds with `test-panic` and calls `testPanic`.
3. BUS-NAT-FRM-008 (frame transport codes): `toBusError` in `frames.ts` maps `ReplyError` to `BUS_REDIS` and the rest to `BUS_CONNECTION`; only the `BUS_CONNECTION` half is tested.
4. BUS-NAT-RS-002 (binding holds no logic): structural, no test. BUS-NAT-RS-009 (add a type with its fixtures): a procedure for future work.
5. BUS-NAT-BLD-002 (`pnpm build`/`test` run `build:native`), BUS-NAT-BLD-004, BUS-NAT-BLD-005 (addon location and load error), BUS-NAT-BLD-006 (linux-x64-gnu only): implemented in `package.json` and `native.ts`, no annotated test.
6. BUS-NAT-CI-002 (Rust tests use their own prefix): `tests/common/mod.rs` does, with a comment but no `@spec`-annotated test.
7. BUS-NAT-GATE-001, 004, 005, 006 (merge gate): a procedure, not a test; the measured result satisfies 004 and 005 (LLD § Measurement gate). BUS-NAT-GATE-007 (`--runs`, `--json` on the bench): implemented, no test.

### Should Fix
1. Log (at least at debug) when `decode` drops an entry (BUS-SUB-007).
2. Add schema tests for BUS-EVT-002 and BUS-EVT-012 to 016.
