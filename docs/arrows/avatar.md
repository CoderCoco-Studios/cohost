# Arrow: avatar

Animates an avatar app (VTube Studio, a VMC receiver, or nothing) from bus events: lip-sync from the voice envelope, expression from the brain and mood, idle motion, and a 5 Hz `avatar.state` preview feed.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. Engine and drivers work and are well unit-tested; five gaps are mostly failure-handling in the drivers and an OpenSpec mismatch on unknown drivers.

## References

### HLD
- docs/high-level-design.md (System Design, body: voice + avatar)

### LLD
- docs/intent/avatar/avatar-design.md

### EARS
- docs/intent/avatar/avatar-specs.md (54 specs: 49 `[x]`, 5 `[ ]`)

### Tests
- services/avatar/test/engine.test.ts (12 tests, mocked timers)
- services/avatar/test/drivers.test.ts (null, VMC over a real UDP socket, VTS against an in-process WebSocket server)
- services/avatar/test/health.test.ts

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

### OpenSpec
- openspec/specs/avatar/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/avatar/spec.md

## Architecture

**Purpose:** Turn bus events into a smooth stream of canonical avatar parameters and hand them to a thin per-app driver, while publishing a throttled copy for the dashboard preview.

**Key Components:**
1. `index.ts` — wiring: config, driver, heartbeat, subscription (group `avatar`, from now) to `brain.say`, `voice.utterance`, `voice.playing`, `voice.done`, `affect.state`; throttles `avatar.state` to 5 Hz.
2. `Engine` (`engine.ts`) — fixed-rate loop owning smoothing, blink, idle motion, lip-sync playback, emotion hold and decay to the mood.
3. `AvatarDriver` (`types.ts`) — contract: `setParams` per frame, `setExpression` on change, `trigger` for gestures, `capabilities` (informational only).
4. `VTubeStudioDriver` — VTS WebSocket API, plugin token in `<configDir>/.vts-token`, parameter injection, hotkey toggling, 5 s reconnect.
5. `VmcDriver` — hand-rolled OSC over UDP (head quaternion, `A`/`aa` mouth, `Blink`/`blink`, expression blendshape).
6. `NullDriver` — declares every capability, does nothing; the default and the isolated-mode choice.
7. `health.ts` — `off` with the null driver, else `live` with `deps.driver` ok/down.
8. `config/expressions.example.yaml` — per-driver emotion-to-expression/hotkey map and gesture map.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Bus wiring | AVATAR-BUS-001 to 008 | 7 | 0 | 1 |
| Animation engine | AVATAR-ENG-001 to 016 | 16 | 0 | 0 |
| Driver contract and selection | AVATAR-DRV-001 to 007 | 6 | 0 | 1 |
| VTube Studio driver | AVATAR-VTS-001 to 014 | 12 | 0 | 2 |
| VMC driver | AVATAR-VMC-001 to 005 | 4 | 0 | 1 |
| State publication | AVATAR-STATE-001 | 1 | 0 | 0 |
| Health | AVATAR-HEALTH-001 to 003 | 3 | 0 | 0 |

**Summary:** 49 of 54 specs implemented; 0 deferred; 5 gaps. Untested implemented specs: AVATAR-BUS-001 to 007 and STATE-001 (no test of `index.ts`), VTS-006 and VTS-007 (timeout and reconnect timer), ENG-006, ENG-008.

## Key Findings

1. **Unhandled rejections from VTS fire-and-forget calls** — `void this.send/activate` at `services/avatar/src/drivers/vtube-studio.ts:55, 78-79, 89` rejects on APIError, timeout or closed socket (`:166, :170, :184-186`). No `unhandledRejection` handler exists in the repo, so Node's default would terminate the process. (AVATAR-VTS-014)
2. **VMC UDP socket has no `error` handler** — `services/avatar/src/drivers/vmc.ts:32, 50, 56`. Verified by a stand-alone `dgram` snippet that an unresolvable host raises an unhandled `error` and kills the process; the default host is `host.docker.internal` (`.env.example:48`). (AVATAR-VMC-005)
3. **VTS `activeExpr` survives disconnects** — `vtube-studio.ts:28` is never cleared; hotkeys are toggles, so a stale value inverts the next expression change after a VTS restart, and expressions requested while disconnected are dropped with no replay (`:75`). (AVATAR-VTS-013)
4. **Unknown driver does not fall back to null at service level** — `drivers/index.ts:23-25` has a `default:` branch, but the config enum (`packages/config/src/schema.ts:161`) makes `loadConfig` throw first; OpenSpec says it falls back. `add-service-health` also names the value `vts` rather than `vtube-studio`. (AVATAR-DRV-004)
5. **Subscription errors escape `main().catch`** — `index.ts:34` `void bus.subscribe(...)`. (AVATAR-BUS-008)
6. **`.vts-token` is not git-ignored** — `.gitignore` lists `config/config.yaml`, `personality.md`, `expressions.yaml` only; the driver writes the VTS plugin token to `config/.vts-token` (`vtube-studio.ts:104, 148`). `[inferred]` unintended.
7. **`ready` is reported before the driver connects** — `index.ts:16`; real drivers show `degraded` until connected, so `ready` means "driver selected" only (AVATAR-HEALTH-001).
8. **Previously flagged `@cohost/testing` devDependency is now present** (`services/avatar/package.json:20`), but `tsconfig.json` includes only `src`, so tests are not type-checked by `tsc -b`.

## Work Required

### Must Fix
1. Catch and log failures of fire-and-forget VTS requests (AVATAR-VTS-014).
2. Attach an `error` listener / send callback to the VMC UDP socket (AVATAR-VMC-005).

### Should Fix
3. Reset `activeExpr` on close/reconnect and re-apply the current expression after reconnect (AVATAR-VTS-013).
4. Decide the unknown-driver behavior: either fail fast (update OpenSpec and delete the dead `default:`) or relax the schema (AVATAR-DRV-004).
5. Handle failure of the bus subscription loop (AVATAR-BUS-008).
6. Add `config/.vts-token` to `.gitignore`.

### Nice to Have
7. Tests for `index.ts` routing and the 5 Hz throttle (AVATAR-BUS-001 to 007, STATE-001), the VTS reconnect/timeout paths (AVATAR-VTS-006, 007), and the `playing` auto-clear (AVATAR-ENG-006).
8. Fix `add-service-health` wording `vts` to `vtube-studio`; consider backoff for the 5 s VTS reconnect.
9. Give `capabilities()` a consumer or drop it; add `tsconfig` coverage for tests.
