# Arrow: avatar

Animates an avatar app (VTube Studio, a VMC receiver, or nothing) from bus events: lip-sync from the voice envelope, expression from the brain and mood, idle motion, and a throttled `avatar.state` preview feed.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 58 specs: 46 implemented, 0 deferred, 12 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B2** `mouthSmile` in `avatar.state` → yes; the event carries every canonical parameter (schema change in event-bus, BUS-EVT-018). Specs: AVATAR-STATE-001 (`[x]` → `[ ]`).
2. **B3** Bad or empty `AVATAR_DRIVER` → fail fast on unknown values, drop the dead factory fallback; unset or empty loads as `null` via `${AVATAR_DRIVER:-null}`, a blank-safe driver value and port defaults (config-owned). Specs: AVATAR-DRV-004 rewritten, AVATAR-DRV-003 (`[x]` → `[ ]`).
3. **R3** VTS first attempt → the engine and subscription start without awaiting it. Specs: AVATAR-VTS-002 (`[x]` → `[ ]`).
4. **R1** Redis outage → a failed `avatar.state` publish is dropped and logged at a limited rate; VTS fire-and-forget calls and the VMC socket `error` are absorbed and logged. Specs: AVATAR-STATE-002 (new); AVATAR-VTS-014, AVATAR-VMC-005 unchanged.
5. **P8** Restart replay → event-bus start mode `latest`. Specs: AVATAR-BUS-001 (`[x]` → `[ ]`).
6. **B1** Lip-sync on `virtual` → keep following every sink; the late-sink double lifecycle is fixed in voice (VOICE-SINK-008). LLD Decisions row.
7. **R3** Startup failures → all setup inside `main()`, every failure logs `fatal`. Specs: AVATAR-BUS-007 (`[x]` → `[ ]`).
8. **B18** `config/.vts-token` → git-ignored (`.gitignore:12`); excluded from the Docker build context too (B25, deployment).
9. **S47** `capabilities()` → drop it from the driver contract. Specs: AVATAR-DRV-001 (`[x]` → `[ ]`); capability wording removed from AVATAR-DRV-007 and AVATAR-VMC-004.

## References

### HLD
- docs/high-level-design.md (System Design, body: voice + avatar; Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/avatar/avatar-design.md

### EARS
- docs/intent/avatar/avatar-specs.md (58 specs: 46 `[x]`, 12 `[ ]`, 0 `[D]`)

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

50 `@spec` annotations in code, citing all 46 `[x]` spec IDs plus six that are now gaps (AVATAR-BUS-001, AVATAR-BUS-007, AVATAR-DRV-001, AVATAR-DRV-003, AVATAR-VTS-002, AVATAR-STATE-001); those annotations mark the code the scheduled fixes change. No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/design.md (D2: `AVATAR_DRIVER=null` as the isolated preset)

## Architecture

**Purpose:** Turn bus events into a smooth stream of canonical avatar parameters and hand them to a thin per-app driver, while publishing a throttled copy for the dashboard preview.

**Key Components:**
1. `index.ts` — wiring: config, driver, heartbeat, subscription (group `avatar`) to `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; throttles `avatar.state` to at most once per 200 ms.
2. `Engine` (`engine.ts`) — fixed-rate loop owning smoothing, blink, idle motion, lip-sync playback, emotion hold and decay to the mood.
3. `AvatarDriver` (`types.ts`) — contract: `setParams` per frame, `setExpression` on change, `trigger` for gestures (the informational `capabilities()` is scheduled for removal).
4. `VTubeStudioDriver` — VTS WebSocket API, plugin token in `<configDir>/.vts-token`, parameter injection, hotkey toggling, 5 s reconnect.
5. `VmcDriver` — hand-rolled OSC over UDP (head quaternion, `A`/`aa` mouth, `Blink`/`blink`, expression blendshape).
6. `NullDriver` — does nothing and reports connected; the default (also for an unset or empty `AVATAR_DRIVER`, once config lands the default) and the isolated-mode choice.
7. `health.ts` — `off` with the null driver, else `live` with `deps.driver` ok/down.
8. `config/expressions.example.yaml` — per-driver emotion-to-expression/hotkey map and gesture map.

## Spec Coverage

| Category | Spec IDs | Implemented | Tested | Deferred | Gaps |
|----------|----------|-------------|--------|----------|------|
| Bus wiring | AVATAR-BUS-001 to 008 | 5 | 0 | 0 | 3 |
| Animation engine | AVATAR-ENG-001 to 016 | 16 | 15 | 0 | 0 |
| Driver contract and selection | AVATAR-DRV-001 to 007 | 4 | 2 | 0 | 3 |
| VTube Studio driver | AVATAR-VTS-001 to 015 | 12 | 9 | 0 | 3 |
| VMC driver | AVATAR-VMC-001 to 006 | 5 | 4 | 0 | 1 |
| State publication | AVATAR-STATE-001 to 002 | 0 | 0 | 0 | 2 |
| Health | AVATAR-HEALTH-001 to 004 | 4 | 2 | 0 | 0 |

**Summary:** 46 of 58 specs implemented; 0 deferred; 12 gaps (AVATAR-BUS-001, AVATAR-BUS-007, AVATAR-BUS-008, AVATAR-DRV-001, AVATAR-DRV-003, AVATAR-DRV-004, AVATAR-VTS-002, AVATAR-VTS-013, AVATAR-VTS-014, AVATAR-VMC-005, AVATAR-STATE-001, AVATAR-STATE-002). Implemented but untested: AVATAR-BUS-002 to 006, AVATAR-HEALTH-001, AVATAR-HEALTH-004, AVATAR-DRV-005, AVATAR-DRV-006 (all `index.ts`), AVATAR-ENG-006, AVATAR-VTS-006, AVATAR-VTS-007, AVATAR-VTS-015, AVATAR-VMC-004. AVATAR-VTS-002's test (`drivers.test.ts:172`) covers only `connect` resolving on a refused connection.

## Key Findings

1. **`avatar.state` drops `mouthSmile`.** The `avatar.state` schema omits it, publish strips it (`packages/bus/src/events.ts:159-171`, checked by parsing a sample payload), and the dashboard preview reads it and gets `NaN` (`services/dashboard/public/index.html:340`). (AVATAR-STATE-001, BUS-EVT-018, B2)
2. **Unhandled rejections from VTS fire-and-forget calls** — `void this.send/activate` at `services/avatar/src/drivers/vtube-studio.ts:55, 78-79, 89` rejects on APIError, timeout or closed socket (`:166, :170, :184-186`). No `unhandledRejection` handler exists in the repo, so on Node 22 the process ends. (AVATAR-VTS-014)
3. **VMC UDP socket has no `error` handler** — `services/avatar/src/drivers/vmc.ts:32, 50, 56`. A stand-alone `dgram` probe confirms that sending to an unresolvable host raises an unhandled `error` and exits the process; the default host is `host.docker.internal` (`.env.example:48`). (AVATAR-VMC-005)
4. **A Redis outage ends avatar through the state publish, not the subscription.** The `void bus.publish("avatar.state")` at `index.ts:26` rejects once the publisher's three retries run out (`packages/bus/src/index.ts:44`); the subscriber waits for the reconnect instead (`packages/bus/src/index.ts:131`). (AVATAR-STATE-002, AVATAR-BUS-008, R1)
5. **An unset or empty `AVATAR_DRIVER` fails config for every service.** `config/config.example.yaml:134` substitutes it to `""`, which the enum rejects (checked against the schema); the schema's `null` default only applies when the key is absent. Unknown values fail the same way, so the `createDriver` fallback is dead. (AVATAR-DRV-003, AVATAR-DRV-004, B3)
6. **VTS `activeExpr` survives disconnects** — `vtube-studio.ts:28` is never cleared; hotkeys are toggles, so a stale value inverts the next expression change after a VTS restart, and expressions requested while disconnected are dropped with no replay (`:75`). (AVATAR-VTS-013)
7. **A restart can replay stale events.** `fromNow` applies only when the `avatar` group is created (`packages/bus/src/index.ts:133-138`); only the control plane's `fresh` start resets it. (AVATAR-BUS-001, P8)
8. **First VTS pairing holds up startup.** `main()` awaits the first VTS attempt, including up to 60 s for the token prompt (`vtube-studio.ts:146`), before starting the engine and subscription (`index.ts:30-34`). (AVATAR-VTS-002, R3)
9. **Lip-sync follows every sink, including `virtual` and late duplicates** (`index.ts:50`, `engine.ts:39-49`), so voice's late-sink double lifecycle shows up as a restarted or cut-short mouth; the fix is in voice (VOICE-SINK-008, B1).
10. **Module-level setup skips the `fatal` log, and `ready` precedes the driver connection** — config, driver and expressions load outside `main()` (`index.ts:12-19`); `heartbeat.ready()` runs before `connect` (`index.ts:16`), so `ready` means "driver selected" and real drivers show `degraded` until connected (AVATAR-BUS-007, AVATAR-HEALTH-001).
11. **`capabilities()` gates nothing** — declared by every driver, read only by the startup log (`index.ts:31`); the null driver claims all four (`drivers/null.ts:8`). (AVATAR-DRV-001, S47)

## Work Required

### Must Fix
1. Add `mouthSmile` to `avatar.state` once BUS-EVT-018 lands, and confirm the dashboard preview renders it (AVATAR-STATE-001, B2).
2. Drop failed `avatar.state` publishes with a rate-limited log (AVATAR-STATE-002, R1).
3. Catch and log failures of fire-and-forget VTS requests (AVATAR-VTS-014, R1).
4. Attach an `error` listener / send callback to the VMC UDP socket (AVATAR-VMC-005, R1).
5. Start the engine and subscription without awaiting the first VTS attempt (AVATAR-VTS-002, R3).
6. Move config, driver creation, heartbeat and expressions setup into `main()` (AVATAR-BUS-007, R3).
7. Remove the unreachable `default:` branch in `createDriver` (AVATAR-DRV-003, B3); the empty-`AVATAR_DRIVER` fix itself is config's (AVATAR-DRV-004).
8. Subscribe with the event-bus `latest` start mode once BUS-SUB-010 lands (AVATAR-BUS-001, P8); log `fatal` and exit non-zero when the subscription rejects after the bus's retry (AVATAR-BUS-008).

### Should Fix
9. Drop `capabilities()` and the `Capability` type from the driver contract and every driver; move the `AVATAR-VMC-004` annotation from `vmc.ts:25` to `trigger` (AVATAR-DRV-001, S47).
10. Reset `activeExpr` on close/reconnect and re-apply the current expression after reconnect (AVATAR-VTS-013).

### Nice to Have
11. Tests for `index.ts` routing, the 200 ms throttle, the publish-failure drop and shutdown (AVATAR-BUS-001 to 008, AVATAR-STATE-001, AVATAR-STATE-002, AVATAR-HEALTH-001, AVATAR-HEALTH-004), the non-blocking VTS start (AVATAR-VTS-002), the VTS reconnect/timeout paths (AVATAR-VTS-006, AVATAR-VTS-007), the missing-hotkey warning (AVATAR-VTS-015), and the `playing` auto-clear (AVATAR-ENG-006); consider backoff for the 5 s VTS reconnect; add `tsconfig` coverage for tests.
