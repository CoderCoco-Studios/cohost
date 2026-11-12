# Arrow: avatar

Animates an avatar app (VTube Studio, a VMC receiver, or nothing) from bus events: lip-sync from the voice envelope, expression from the brain and mood, idle motion, and a throttled `avatar.state` preview feed.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 58 specs: 58 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes have landed.

Gap-closure chunk C10 (2026-11-11): AVATAR-ENG-002 (re-prepare moves to newest), AVATAR-ENG-017 (neutral clears), AVATAR-VTS-016 (handshake timeout), monotonic clocks, AVATAR-DEV-001 (tests type-checked); runService; untested specs covered. 61 of 61 specs are `[x]`, 0 deferred, 0 gaps; the LLD has no open questions.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B2** `mouthSmile` in `avatar.state` → yes; the event carries every canonical parameter (schema change in event-bus, BUS-EVT-018). Specs: AVATAR-STATE-001.
2. **B3** Bad or empty `AVATAR_DRIVER` → fail fast on unknown values, drop the dead factory fallback; unset or empty loads as `null` via `${AVATAR_DRIVER:-null}`, a blank-safe driver value and port defaults (config-owned). Specs: AVATAR-DRV-004 rewritten, AVATAR-DRV-003 (`[x]` → `[ ]`).
3. **R3** VTS first attempt → the engine and subscription start without awaiting it. Specs: AVATAR-VTS-002.
4. **R1** Redis outage → a failed `avatar.state` publish is dropped and logged at a limited rate; VTS fire-and-forget calls and the VMC socket `error` are absorbed and logged. Specs: AVATAR-STATE-002 (new); AVATAR-VTS-014, AVATAR-VMC-005 unchanged.
5. **P8** Restart replay → event-bus start mode `latest`. Specs: AVATAR-BUS-001.
6. **B1** Lip-sync on `virtual` → keep following every sink; the late-sink double lifecycle is fixed in voice (VOICE-SINK-008). LLD Decisions row.
7. **R3** Startup failures and readiness → all setup inside `runAvatar`, every failure logs `fatal`; `ready` is reported once the engine runs and the consumer group is positioned, without waiting for the driver. Specs: AVATAR-BUS-007, AVATAR-HEALTH-001 reworded.
8. **B18** `config/.vts-token` → git-ignored (`.gitignore:12`); excluded from the Docker build context too (B25, deployment).
9. **S47** `capabilities()` → drop it from the driver contract. Specs: AVATAR-DRV-001; capability wording removed from AVATAR-DRV-007 and AVATAR-VMC-004.

## References

### HLD
- docs/high-level-design.md (System Design, body: voice + avatar; Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/avatar/avatar-design.md

### EARS
- docs/intent/avatar/avatar-specs.md (58 specs: 58 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- services/avatar/test/boot.test.ts (boot wiring: subscription options, event routing, readiness, non-blocking driver start, fatal paths, shutdown)
- services/avatar/test/state.test.ts (`avatar.state` content, throttle, publish failures)
- services/avatar/test/engine.test.ts (12 tests, mocked timers)
- services/avatar/test/drivers.test.ts (null, VMC over a real UDP socket, VTS against an in-process WebSocket server)
- services/avatar/test/health.test.ts

41 `@spec` annotations in tests, citing 51 distinct IDs: every spec except AVATAR-ENG-006, AVATAR-DRV-001 (held by the type checker), AVATAR-DRV-004 (tested in `packages/config/test/config.test.ts`), AVATAR-DRV-005, AVATAR-VTS-006, AVATAR-VTS-007 and AVATAR-VTS-015.

### Code
- services/avatar/src/index.ts
- services/avatar/src/boot.ts
- services/avatar/src/state.ts
- services/avatar/src/engine.ts
- services/avatar/src/types.ts
- services/avatar/src/health.ts
- services/avatar/src/drivers/index.ts
- services/avatar/src/drivers/null.ts
- services/avatar/src/drivers/vmc.ts
- services/avatar/src/drivers/vtube-studio.ts
- services/avatar/package.json, services/avatar/tsconfig.json
- config/expressions.example.yaml

54 `@spec` annotations in code, citing every spec ID except AVATAR-DRV-004 (config-owned). No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/design.md (D2: `AVATAR_DRIVER=null` as the isolated preset)

## Architecture

**Purpose:** Turn bus events into a smooth stream of canonical avatar parameters and hand them to a thin per-app driver, while publishing a throttled copy for the dashboard preview.

**Key Components:**
1. `index.ts` — supplies the real setup (config, `Bus`, driver, expressions) to `runAvatar`.
   `boot.ts` — `runAvatar`: heartbeat, engine, non-blocking `driver.connect`, group positioning, `ready`, subscription (group `avatar`, `latest`) to `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; every failure logs `fatal` and exits 1.
   `state.ts` — `statePublisher`: throttles `avatar.state` to at most once per 200 ms and drops a failed publish with a rate-limited log.
2. `Engine` (`engine.ts`) — fixed-rate loop owning smoothing, blink, idle motion, lip-sync playback, emotion hold and decay to the mood.
3. `AvatarDriver` (`types.ts`) — contract: `setParams` per frame, `setExpression` on change, `trigger` for gestures (no capability declaration).
4. `VTubeStudioDriver` — VTS WebSocket API, plugin token in `<configDir>/.vts-token`, parameter injection, hotkey toggling, 5 s reconnect.
5. `VmcDriver` — hand-rolled OSC over UDP (head quaternion, `A`/`aa` mouth, `Blink`/`blink`, expression blendshape).
6. `NullDriver` — does nothing and reports connected; the default (also for an unset or empty `AVATAR_DRIVER`) and the isolated-mode choice.
7. `health.ts` — `off` with the null driver, else `live` with `deps.driver` ok/down.
8. `config/expressions.example.yaml` — per-driver emotion-to-expression/hotkey map and gesture map.

## Spec Coverage

| Category | Spec IDs | Implemented | Tested | Deferred | Gaps |
|----------|----------|-------------|--------|----------|------|
| Bus wiring | AVATAR-BUS-001 to 008 | 8 | 8 | 0 | 0 |
| Animation engine | AVATAR-ENG-001 to 016 | 16 | 15 | 0 | 0 |
| Driver contract and selection | AVATAR-DRV-001 to 007 | 7 | 5 | 0 | 0 |
| VTube Studio driver | AVATAR-VTS-001 to 015 | 15 | 12 | 0 | 0 |
| VMC driver | AVATAR-VMC-001 to 006 | 6 | 6 | 0 | 0 |
| State publication | AVATAR-STATE-001 to 002 | 2 | 2 | 0 | 0 |
| Health | AVATAR-HEALTH-001 to 004 | 4 | 4 | 0 | 0 |

**Summary:** 58 of 58 specs implemented; 0 deferred; 0 gaps. Implemented but untested: AVATAR-ENG-006 (auto-clear of a playing utterance), AVATAR-DRV-001 (held by the type checker), AVATAR-DRV-005 (`loadExpressions` in `index.ts`), AVATAR-VTS-006 (request timeout), AVATAR-VTS-007 (5 s reconnect and its cancellation), AVATAR-VTS-015 (expression-not-found warning); AVATAR-DRV-004 is tested in config. Process exit and signal handling are injected in the boot tests.

## Key Findings

1. **`avatar.state` carries `mouthSmile` (fixed).** The bus schema has the field (BUS-EVT-018) and `statePublisher` sends it, so the dashboard preview reads a number. (AVATAR-STATE-001, B2)
2. **Fire-and-forget failures are absorbed (fixed).** VTS requests go through `fire()` and VMC datagrams through `sendDatagram`, both logging at a limited rate; the `avatar.state` publish has a `.catch`. (AVATAR-VTS-014, AVATAR-VMC-005, AVATAR-STATE-002, R1)
3. **Startup is inside `runAvatar` (fixed).** Config, driver, expressions, heartbeat and a rejecting `driver.connect` all end in a `fatal` log and exit 1; the subscription is awaited in the same `try`. (AVATAR-BUS-007, AVATAR-BUS-008, R3)
4. **Restart replay (fixed).** The group moves to the newest entry on every start (`start: "latest"`). (AVATAR-BUS-001, P8)
5. **The first VTS pairing no longer holds up startup (fixed).** `driver.connect` is started without being awaited, so the engine and subscription run while a token prompt (up to 60 s, `vtube-studio.ts`) or an unreachable host is pending. (AVATAR-VTS-002, R3)
6. **`ready` means "can receive events".** It follows the group positioning, not the driver connection; `deps.driver` carries the connection and makes the state `degraded`. The bus has no "subscribed" hook, so boot positions the group itself and `subscribe` positions it again (cross-segment follow-up in event-bus). (AVATAR-HEALTH-001, R3)
7. **VTS `activeExpr` is cleared on close and on connect (fixed).** Expressions requested while disconnected are still dropped, and the engine does not re-send the current expression after a reconnect. (AVATAR-VTS-013)
8. **`capabilities()` is gone** from the driver contract and every driver; the `AVATAR-VMC-004` annotation sits on `VmcDriver.trigger`. (AVATAR-DRV-001, S47)
9. **Lip-sync follows every sink, including `virtual` and late duplicates** (`boot.ts`, `engine.ts:39-49`); voice cancels its pending virtual `voice.done` on a late real claim (VOICE-SINK-008), so the mouth no longer closes while a real sink plays.
10. **An unset or empty `AVATAR_DRIVER` loads as `null`** (config: `${AVATAR_DRIVER:-null}`, a blank-safe driver value); the factory has no fallback for other names. (AVATAR-DRV-003, AVATAR-DRV-004)

## Work Required

### Must Fix
None.

### Should Fix
1. Add an event-bus "subscribed" hook so boot does not need the duplicate `resetGroup` call (event-bus segment).
2. Re-apply the current expression after a VTS reconnect (the driver now forgets its record; the engine does not re-send).

### Nice to Have
3. Tests for AVATAR-VTS-006, AVATAR-VTS-007, AVATAR-VTS-015, AVATAR-ENG-006 and the `loadExpressions` step (AVATAR-DRV-005).
4. Type-check the tests (`tsconfig.json` has `include: ["src"]`).
