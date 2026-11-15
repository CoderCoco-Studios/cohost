# Arrow: avatar

Animates an avatar app (VTube Studio, a VMC receiver, or nothing) from bus events: lip-sync from the voice envelope, expression from the brain and mood, idle motion, and a throttled `avatar.state` preview feed.

## Status

**AUDITED**: 62 specs: 62 implemented, 0 deferred, 0 gaps. The LLD has no open questions. The docs site's extension guides added AVATAR-EX-001 to AVATAR-EX-004 (the UDP JSON example driver), implemented and tested, not yet audited; the spec file now holds 66 specs (66 `[x]`, 0 `[ ]`, 0 `[D]`).

## References

### HLD
- docs/high-level-design.md (System Design, body: voice + avatar; Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/avatar/avatar-design.md

### EARS
- docs/intent/avatar/avatar-specs.md (66 specs: 66 `[x]`, 0 `[ ]`, 0 `[D]`; prefix `AVATAR`)

### Tests
Files with `@spec AVATAR-` annotations:
- services/avatar/test/boot.test.ts
- services/avatar/test/state.test.ts
- services/avatar/test/engine.test.ts
- services/avatar/test/drivers.test.ts
- services/avatar/test/drivers.vts.test.ts
- services/avatar/test/health.test.ts
- services/avatar/test/typecheck.test.ts

Also in the segment: services/avatar/test/contract.test.ts (no `@spec` annotation).

### Code
Files with `@spec AVATAR-` annotations:
- services/avatar/src/boot.ts
- services/avatar/src/state.ts
- services/avatar/src/engine.ts
- services/avatar/src/types.ts
- services/avatar/src/health.ts
- services/avatar/src/drivers/index.ts
- services/avatar/src/drivers/null.ts
- services/avatar/src/drivers/vmc.ts
- services/avatar/src/drivers/vtube-studio.ts

Also: services/avatar/src/index.ts, services/avatar/package.json, services/avatar/tsconfig.json, config/expressions.example.yaml.

## Architecture

**Purpose:** Turn bus events into a smooth stream of canonical avatar parameters and hand them to a thin per-app driver, while publishing a throttled copy for the dashboard preview.

**Key Components:**
1. `index.ts`: supplies the real setup (config, `Bus`, driver, expressions) to `runAvatar`.
   `boot.ts`: `runAvatar`: heartbeat, engine, non-blocking `driver.connect`, group positioning, `ready`, subscription (group `avatar`, `latest`) to `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; a startup failure after the configuration loads, a rejecting `driver.connect` or a rejecting subscription logs `fatal` and exits 1.
   `state.ts`: `statePublisher`: throttles `avatar.state` to at most once per 200 ms and drops a failed publish with a rate-limited log.
2. `Engine` (`engine.ts`): fixed-rate loop owning smoothing, blink, idle motion, lip-sync playback, emotion hold and decay to the mood.
3. `AvatarDriver` (`types.ts`): contract: `setParams` per frame, `setExpression` on change, `trigger` for gestures (no capability declaration).
4. `VTubeStudioDriver`: VTS WebSocket API, plugin token in `<configDir>/.vts-token`, parameter injection, hotkey toggling, 5 s reconnect.
5. `VmcDriver`: hand-rolled OSC over UDP (head quaternion, `A`/`aa` mouth, `Blink`/`blink`, expression blendshape).
6. `NullDriver`: does nothing and reports connected; the default (also for an unset or empty `AVATAR_DRIVER`) and the isolated-mode choice.
7. `health.ts`: `off` with the null driver, else `live` with `deps.driver` ok/down.
8. `config/expressions.example.yaml`: per-driver emotion-to-expression/hotkey map and gesture map.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Bus wiring | AVATAR-BUS-001 to AVATAR-BUS-008 | 8 | 0 | 0 | 8 |
| Animation engine | AVATAR-ENG-001 to AVATAR-ENG-018 | 18 | 0 | 0 | 18 |
| Driver contract and selection | AVATAR-DRV-001 to AVATAR-DRV-007 | 7 | 0 | 0 | 7 |
| VTube Studio driver | AVATAR-VTS-001 to AVATAR-VTS-016 | 16 | 0 | 0 | 16 |
| VMC driver | AVATAR-VMC-001 to AVATAR-VMC-006 | 6 | 0 | 0 | 6 |
| State publication | AVATAR-STATE-001 to AVATAR-STATE-002 | 2 | 0 | 0 | 2 |
| Health | AVATAR-HEALTH-001 to AVATAR-HEALTH-004 | 4 | 0 | 0 | 4 |
| Development | AVATAR-DEV-001 | 1 | 0 | 0 | 1 |

**Summary:** 62 of 62 specs implemented; 0 deferred; 0 open. 62 carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **`ready` means "can receive events".** It follows the group positioning, not the driver connection; `deps.driver` carries the connection and makes the state `degraded`. The bus has no "subscribed" hook, so boot positions the group itself and `subscribe` positions it again (cross-segment follow-up in event-bus). (AVATAR-HEALTH-001)
2. **The first VTS pairing does not hold up startup.** `driver.connect` is started without being awaited, so the engine and subscription run while a token prompt (up to 60 s) or an unreachable host is pending. (AVATAR-VTS-002, AVATAR-VTS-016)
3. **VTS `activeExpr` is cleared on close and on connect.** Expressions requested while disconnected are dropped, and the engine does not re-send the current expression after a reconnect. (AVATAR-VTS-013)
4. **Lip-sync follows every sink, including `virtual` and late duplicates** (`boot.ts`, `Engine.play`); voice cancels its pending virtual `voice.done` on a late real claim (VOICE-SINK-008), so the mouth stays open while a real sink plays.
5. **An unset or empty `AVATAR_DRIVER` loads as `null`** (config: `${AVATAR_DRIVER:-null}`, a blank-safe driver value); the factory has no fallback for other names. (AVATAR-DRV-003, AVATAR-DRV-004)

## Work Required

### Must Fix
None.

### Should Fix
- Audit the example driver (AVATAR-EX-001..004), cited by the docs site's Extend pages.
1. Add an event-bus "subscribed" hook so boot does not need the duplicate `resetGroup` call (event-bus segment).
2. Re-apply the current expression after a VTS reconnect (the driver forgets its record; the engine does not re-send).

### Nice to Have
None.
