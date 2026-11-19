# Arrow: avatar

Animates an avatar app (VTube Studio, a VMC receiver, the browser renderer, or nothing) from bus events: lip-sync from the voice envelope, expression from the brain and mood, idle motion, and a throttled `avatar.state` preview feed.

## Status

Total 91 specs: 57 `[x]`, 34 `[ ]`, 0 `[D]`. The gaps are AVATAR-BUS-003 to AVATAR-BUS-005 and AVATAR-BUS-009, AVATAR-ENG-002 to AVATAR-ENG-004 and AVATAR-ENG-007 (the streamed-speech clause specs, among them), AVATAR-ENG-019 to AVATAR-ENG-021, AVATAR-DRV-002 to AVATAR-DRV-004 (the driver set now includes `browser`), AVATAR-VMC-007, AVATAR-VTS-018, AVATAR-DIR-001 to AVATAR-DIR-005 and AVATAR-BRW-001 to AVATAR-BRW-013. The VTube Studio plugin developer is the literal `avatar.vtube_studio.plugin_developer` ([decision](../decisions/config-in-one-place.md); AVATAR-VTS-017). The example driver (AVATAR-EX-001 to AVATAR-EX-004) is implemented and tested, and cited by the docs site's Extend pages.

The `browser` driver is specified (AVATAR-BRW-*) and not built: its frame contents, expression block, health meaning and the page's share of animation are in the LLD's browser section, and the stream, relay and renderer page are in the event-bus (BUS-AVF-*) and dashboard (DASH-AVR-*, DASH-MDL-*, DASH-AVP-*, DASH-AVS-*) specs.

## References

### HLD
- docs/high-level-design.md (System Design, body: voice + avatar; Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/avatar/avatar-design.md

### EARS
- docs/intent/avatar/avatar-specs.md (91 specs: 57 `[x]`, 34 `[ ]`, 0 `[D]`; prefix `AVATAR`)

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
6. `NullDriver`: does nothing and reports connected; the default (also for an unset or empty `avatar.driver`) and the isolated-mode choice.
7. `BrowserDriver` (`drivers/browser.ts`, specified, not built): writes each Engine tick's canonical parameters, emotion, intensity and resolved VRM expression name to the avatar-frame stream; gestures are ignored; `connected()` means the latest write succeeded.
8. `health.ts`: `off` with the null driver, else `live` with `deps.driver` ok/down.
9. `config/expressions.example.yaml`: per-driver emotion-to-expression/hotkey map and gesture map; the `browser` block holds VRM expression names.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Bus wiring | AVATAR-BUS-001 to AVATAR-BUS-009 | 5 | 0 | 4 | 5 |
| Animation engine | AVATAR-ENG-001 to AVATAR-ENG-021 | 14 | 0 | 7 | 14 |
| Driver contract and selection | AVATAR-DRV-001 to AVATAR-DRV-007 | 4 | 0 | 3 | 4 |
| VTube Studio driver | AVATAR-VTS-001 to AVATAR-VTS-018 | 17 | 0 | 1 | 17 |
| VMC driver | AVATAR-VMC-001 to AVATAR-VMC-007 | 6 | 0 | 1 | 6 |
| Direction of the parameters | AVATAR-DIR-001 to AVATAR-DIR-005 | 0 | 0 | 5 | 0 |
| Browser driver | AVATAR-BRW-001 to AVATAR-BRW-013 | 0 | 0 | 13 | 0 |
| State publication | AVATAR-STATE-001 to AVATAR-STATE-002 | 2 | 0 | 0 | 2 |
| Health | AVATAR-HEALTH-001 to AVATAR-HEALTH-004 | 4 | 0 | 0 | 4 |
| Development | AVATAR-DEV-001 | 1 | 0 | 0 | 1 |
| Example driver | AVATAR-EX-001 to AVATAR-EX-004 | 4 | 0 | 0 | 4 |

**Summary:** 91 specs: 57 implemented, 34 gaps, 0 deferred. The gaps are the streamed-speech clause specs, the driver-set revisions and the browser driver. `node scripts/lid-check.mjs` finds no reverse orphans. The Test-annotated column counts specs that name a test (`<!-- test: ... -->`).

## Key Findings

1. **`ready` means "can receive events".** It follows the group positioning, not the driver connection; `deps.driver` carries the connection and makes the state `degraded`. The bus has no "subscribed" hook, so boot positions the group itself and `subscribe` positions it again (cross-segment follow-up in event-bus). (AVATAR-HEALTH-001)
2. **The first VTS pairing does not hold up startup.** `driver.connect` is started without being awaited, so the engine and subscription run while a token prompt (up to 60 s) or an unreachable host is pending. (AVATAR-VTS-002, AVATAR-VTS-016)
3. **VTS `activeExpr` is cleared on close and on connect.** Expressions requested while disconnected are dropped, and the engine does not re-send the current expression after a reconnect. (AVATAR-VTS-013)
4. **Lip-sync follows every sink, including `virtual` and late duplicates** (`boot.ts`, `Engine.play`); voice cancels its pending virtual `voice.done` on a late real claim (VOICE-SINK-008), so the mouth stays open while a real sink plays.
5. **An unset or empty `avatar.driver` loads as `null`** (config: the literal `"null"`, a blank-safe driver value); the factory has no fallback for other names. (AVATAR-DRV-003, AVATAR-DRV-004)

## Work Required

### Must Fix
None.

### Should Fix
- Build the browser driver (AVATAR-BRW-001 to AVATAR-BRW-013) with a driver test over a fake frame writer, and move the shared `eulerToQuat` into `@cohost/shared/head-rotation` for the VMC driver (AVATAR-VMC-007).
1. Add an event-bus "subscribed" hook so boot does not need the duplicate `resetGroup` call (event-bus segment).
2. Re-apply the current expression after a VTS reconnect (the driver forgets its record; the engine does not re-send).

### Nice to Have
None.
