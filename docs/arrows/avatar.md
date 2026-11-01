# Arrow: avatar

Animates an avatar app (VTube Studio, a VMC receiver, or nothing) from bus events: lip-sync from the voice envelope, expression from the brain and mood, idle motion, and a throttled `avatar.state` preview feed.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f). 52 of 57 specs implemented, 33 of them exercised by a test; the 5 gaps are failure handling in the drivers and the bus loop, plus unknown-driver fallback. The service wiring (`index.ts`) has no test. Audit pass complete 2026-11-02, awaiting index update.

## Questions for the user

1. **AVATAR-STATE-001: should `avatar.state` carry `mouthSmile`?** The service passes it (`services/avatar/src/index.ts:26`), but the `avatar.state` schema has no such field, so publish strips it (`packages/bus/src/events.ts:144-156`; checked by parsing a sample payload). The dashboard preview computes its mouth from `s.mouthSmile * 10`, which is `NaN` (`services/dashboard/public/index.html:329`). The spec line now lists the fields the event really carries. Recommended: yes; add `mouthSmile` to the schema (an event-bus change) and restore "every canonical parameter" in the spec.
2. **AVATAR-DRV-004: fail fast or fall back on a bad `AVATAR_DRIVER`?** An unrecognised value makes `loadConfig` throw (`packages/config/src/schema.ts:161`, `packages/config/src/index.ts:98-104`), so the `default:` fallback (`services/avatar/src/drivers/index.ts:23-25`) is dead code. An unset or empty variable fails the same way, because `config/config.example.yaml:134` writes `driver: "${AVATAR_DRIVER}"` and `""` is not in the enum; since every service loads the whole config, that stops every service, not only avatar. Recommended: fail fast on unknown values (drop the gap line and the dead branch), and let a `.env` without avatar settings load by writing `${AVATAR_DRIVER:-null}` in the example YAML and giving `vtube_studio.port` and `vmc.port` schema defaults, which they lack today (`packages/config/src/schema.ts:167,171`; a config change).
3. **AVATAR-VTS-002: what does "startup is not blocked" promise?** `connect()` never rejects, but `main()` waits for the first attempt to end before it starts the engine and the subscription (`index.ts:30-34`): up to 60 s while a first-time token request waits for the operator (`services/avatar/src/drivers/vtube-studio.ts:146`), and for a host that drops packets the OS TCP connect timeout, since `ws` is created with no handshake timeout (`vtube-studio.ts:109`; `[inferred]` from library defaults, not tested). Recommended: read it as "returns within a bounded time": start the engine and subscription without awaiting the first VTS attempt.
4. **Should avatar survive a Redis outage?** The 5 Hz `avatar.state` publish is `void`-ed (`index.ts:26`) and the publisher gives up after three attempts (`packages/bus/src/index.ts:43`), so losing Redis for about a second ends the process with an unhandled rejection (no `unhandledRejection` handler exists in `packages/` or `services/`); compose restarts it (`docker-compose.yml:9`). AVATAR-BUS-008 covers only the subscription, which a dropped connection does not reject (`packages/bus/src/index.ts:124`). Recommended: yes; catch and drop failed `avatar.state` publishes, and add a spec line for it.
5. **AVATAR-BUS-001: should a restart replay events published while avatar was down?** `fromNow` only positions a newly created group (`packages/bus/src/index.ts:126-131`); a compose restart resumes the existing `avatar` group, and only a control-plane `fresh` start resets it (`packages/control/src/manifest.ts:45`). voice has the same behavior. Recommended: no; decide it once in event-bus.
6. **Should avatar lip-sync voice's `virtual` sink?** avatar ignores the `sink` field (`index.ts:50`), so it mouths lines nobody is playing, and with a real sink that starts after voice's 1.5 s window it restarts lip-sync on the second `voice.playing` and can stop on the virtual `voice.done` mid-line (`services/avatar/src/engine.ts:39-49`; voice LLD, Sink Arbitration Protocol). Recommended: keep following `virtual` (it is the only playback signal when no sink is attached) and fix the duplicate lifecycle on the voice side (VOICE-SINK-008).
7. **AVATAR-BUS-007: should every startup failure log `fatal`?** Config, driver creation and expressions load at module level (`index.ts:12-19`), outside `main()`, so their errors end the process without the `fatal` log; inside `main()`, only a malformed VTS address can reject (`vtube-studio.ts:108-109`). Recommended: move the module-level setup into `main()`.
8. **Is `config/.vts-token` meant to stay out of git?** The driver writes the plugin token there (`vtube-studio.ts:104, 148`) and `.gitignore` lists only `config/config.yaml`, `config/personality.md` and `config/expressions.yaml`. Recommended: yes; ignore it (a repo-root change).
9. **Should `capabilities()` gate anything?** Every driver declares it; it is only logged (`index.ts:31`), and the null driver claims all four (`services/avatar/src/drivers/null.ts:8`). Recommended: drop it unless a consumer is planned.

## References

### HLD
- docs/high-level-design.md (System Design, body: voice + avatar; Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/avatar/avatar-design.md

### EARS
- docs/intent/avatar/avatar-specs.md (57 specs: 52 `[x]`, 5 `[ ]`, 0 `[D]`)

### Tests
- services/avatar/test/engine.test.ts (12 tests, mocked timers)
- services/avatar/test/drivers.test.ts (null, VMC over a real UDP socket, VTS against an in-process WebSocket server)
- services/avatar/test/health.test.ts

25 `@spec` annotations in tests, citing 33 distinct spec IDs.

### Code
- services/avatar/src/index.ts
- services/avatar/src/engine.ts
- services/avatar/src/types.ts
- services/avatar/src/health.ts
- services/avatar/src/drivers/index.ts
- services/avatar/src/drivers/null.ts
- services/avatar/src/drivers/vmc.ts
- services/avatar/src/drivers/vtube-studio.ts
- services/avatar/package.json, services/avatar/tsconfig.json
- config/expressions.example.yaml

50 `@spec` annotations in code, citing all 52 `[x]` spec IDs. No annotation cites a missing or non-`[x]` ID.

### OpenSpec (frozen, historical)
- openspec/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/design.md (D2: `AVATAR_DRIVER=null` as the isolated preset)

## Architecture

**Purpose:** Turn bus events into a smooth stream of canonical avatar parameters and hand them to a thin per-app driver, while publishing a throttled copy for the dashboard preview.

**Key Components:**
1. `index.ts` — wiring: config, driver, heartbeat, subscription (group `avatar`) to `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; throttles `avatar.state` to at most once per 200 ms.
2. `Engine` (`engine.ts`) — fixed-rate loop owning smoothing, blink, idle motion, lip-sync playback, emotion hold and decay to the mood.
3. `AvatarDriver` (`types.ts`) — contract: `setParams` per frame, `setExpression` on change, `trigger` for gestures, `capabilities` (informational only).
4. `VTubeStudioDriver` — VTS WebSocket API, plugin token in `<configDir>/.vts-token`, parameter injection, hotkey toggling, 5 s reconnect.
5. `VmcDriver` — hand-rolled OSC over UDP (head quaternion, `A`/`aa` mouth, `Blink`/`blink`, expression blendshape).
6. `NullDriver` — declares every capability, does nothing; the `.env.example` default and the isolated-mode choice.
7. `health.ts` — `off` with the null driver, else `live` with `deps.driver` ok/down.
8. `config/expressions.example.yaml` — per-driver emotion-to-expression/hotkey map and gesture map.

## Spec Coverage

| Category | Spec IDs | Implemented | Tested | Deferred | Gaps |
|----------|----------|-------------|--------|----------|------|
| Bus wiring | AVATAR-BUS-001 to 008 | 7 | 0 | 0 | 1 |
| Animation engine | AVATAR-ENG-001 to 016 | 16 | 15 | 0 | 0 |
| Driver contract and selection | AVATAR-DRV-001 to 007 | 6 | 2 | 0 | 1 |
| VTube Studio driver | AVATAR-VTS-001 to 015 | 13 | 10 | 0 | 2 |
| VMC driver | AVATAR-VMC-001 to 006 | 5 | 4 | 0 | 1 |
| State publication | AVATAR-STATE-001 | 1 | 0 | 0 | 0 |
| Health | AVATAR-HEALTH-001 to 004 | 4 | 2 | 0 | 0 |

**Summary:** 52 of 57 specs implemented; 0 deferred; 5 gaps (AVATAR-BUS-008, AVATAR-DRV-004, AVATAR-VTS-013, AVATAR-VTS-014, AVATAR-VMC-005). Implemented but untested: AVATAR-BUS-001 to 007, AVATAR-STATE-001, AVATAR-HEALTH-001, AVATAR-HEALTH-004, AVATAR-DRV-003, AVATAR-DRV-005, AVATAR-DRV-006 (all `index.ts` or the `createDriver` fallback), AVATAR-ENG-006, AVATAR-VTS-006, AVATAR-VTS-007, AVATAR-VTS-015, AVATAR-VMC-004. AVATAR-DRV-001 is held by the type checker (`implements AvatarDriver`), not a test.

## Key Findings

1. **`avatar.state` drops `mouthSmile`.** The `avatar.state` schema omits it, publish strips it (`packages/bus/src/events.ts:144-156`, checked by parsing a sample payload), and the dashboard preview reads it and gets `NaN` (`services/dashboard/public/index.html:329`). AVATAR-STATE-001 was reworded to the fields actually carried.
2. **Unhandled rejections from VTS fire-and-forget calls** — `void this.send/activate` at `services/avatar/src/drivers/vtube-studio.ts:55, 78-79, 89` rejects on APIError, timeout or closed socket (`:166, :170, :184-186`). No `unhandledRejection` handler exists in the repo, so on Node 22 the process ends. (AVATAR-VTS-014)
3. **VMC UDP socket has no `error` handler** — `services/avatar/src/drivers/vmc.ts:32, 50, 56`. A stand-alone `dgram` probe confirms that sending to an unresolvable host raises an unhandled `error` and exits the process; the default host is `host.docker.internal` (`.env.example:48`). (AVATAR-VMC-005)
4. **A Redis outage ends avatar through the state publish, not the subscription.** The `void bus.publish("avatar.state")` at `index.ts:26` rejects once the publisher's three retries run out (`packages/bus/src/index.ts:43`); the subscriber waits for the reconnect instead (`packages/bus/src/index.ts:124`). AVATAR-BUS-008's example was corrected to a failure that does reject the loop. (AVATAR-BUS-008)
5. **An unset or empty `AVATAR_DRIVER` fails config for every service.** `config/config.example.yaml:134` substitutes it to `""`, which the enum rejects (checked against the schema); the schema's `null` default only applies when the key is absent. Unknown values fail the same way, so the `createDriver` fallback is dead (AVATAR-DRV-003, AVATAR-DRV-004).
6. **VTS `activeExpr` survives disconnects** — `vtube-studio.ts:28` is never cleared; hotkeys are toggles, so a stale value inverts the next expression change after a VTS restart, and expressions requested while disconnected are dropped with no replay (`:75`). (AVATAR-VTS-013)
7. **A restart can replay stale events.** `fromNow` applies only when the `avatar` group is created (`packages/bus/src/index.ts:126-131`); only the control plane's `fresh` start resets it. AVATAR-BUS-001 was reworded to say so.
8. **First VTS pairing holds up startup.** `main()` awaits the first VTS attempt, including up to 60 s for the token prompt (`vtube-studio.ts:146`), before starting the engine and subscription (`index.ts:30-34`). AVATAR-VTS-002 holds only in the sense that `connect()` never rejects.
9. **Lip-sync follows every sink, including `virtual` and late duplicates** (`index.ts:50`, `engine.ts:39-49`), so voice's late-sink double lifecycle (VOICE-SINK-008) shows up as a restarted or cut-short mouth.
10. **`.vts-token` is not git-ignored, and `ready` precedes the driver connection** — the token is written to `config/.vts-token` (`vtube-studio.ts:104, 148`); `heartbeat.ready()` runs before `connect` (`index.ts:16`), so `ready` means "driver selected" and real drivers show `degraded` until connected (AVATAR-HEALTH-001).
11. **Spec changes in this pass.** No `[x]`/`[ ]` marker was wrong. Reworded to match the code: AVATAR-BUS-001 (group creation), AVATAR-BUS-007 (log message, scope of `main()`), AVATAR-BUS-008 (failure example), AVATAR-ENG-002 (eviction order on re-prepare), AVATAR-ENG-006 (clears only after the envelope runs out), AVATAR-ENG-007 (target, not instant close), AVATAR-VTS-009 (unmapped emotions), AVATAR-STATE-001 (fields carried). Added: AVATAR-VTS-015 (missing expression hotkey warns), AVATAR-VMC-006 (disconnect), AVATAR-HEALTH-004 (shutdown). AVATAR-VTS-007 lost a test pointer to a test that does not assert the reconnect.

## Work Required

### Must Fix
1. Catch and log failures of fire-and-forget VTS requests (AVATAR-VTS-014).
2. Attach an `error` listener / send callback to the VMC UDP socket (AVATAR-VMC-005).
3. Decide whether `avatar.state` carries `mouthSmile` and align the schema, spec and dashboard (AVATAR-STATE-001).

### Should Fix
4. Catch failed `avatar.state` publishes; handle failure of the bus subscription loop (AVATAR-BUS-008).
5. Reset `activeExpr` on close/reconnect and re-apply the current expression after reconnect (AVATAR-VTS-013).
6. Decide the unknown and empty `AVATAR_DRIVER` behavior (AVATAR-DRV-003, AVATAR-DRV-004).
7. Decide whether startup should wait for the first VTS attempt (AVATAR-VTS-002).
8. Add `config/.vts-token` to `.gitignore`.

### Nice to Have
9. Tests for `index.ts` routing, the 200 ms throttle and shutdown (AVATAR-BUS-001 to 007, AVATAR-STATE-001, AVATAR-HEALTH-001, AVATAR-HEALTH-004), the VTS reconnect/timeout paths (AVATAR-VTS-006, AVATAR-VTS-007), the missing-hotkey warning (AVATAR-VTS-015), and the `playing` auto-clear (AVATAR-ENG-006); consider backoff for the 5 s VTS reconnect.
10. Give `capabilities()` a consumer or drop it; add `tsconfig` coverage for tests.
