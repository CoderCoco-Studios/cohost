# Arrow: control-plane

Service manifest, heartbeat contract and health derivation, start/stop/restart controller with two runtimes, the `cohostctl` CLI and the compose container healthcheck.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 50 specs: 49 implemented, 1 deferred (cross-invocation process stop, deliberate), 0 gaps (CTRL-RUNTIME-009 landed via the `docker-compose.yml` pass-through, DEPLOY-COMPOSE-017). The owner answered the audit questions on 2026-11-01; the decisions are applied below and the control-plane gap fixes are landed.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B17** isolation env under compose → pass-through `VAR: ${VAR:-}` entries for every preset variable in the compose `x-ts-service` environment, and compose pins `CONTROL_ENABLED: "0"` for the dashboard container (both deployment changes). Specs: CTRL-RUNTIME-009.
2. **S52** isolated start closure → manifest `requires`, followed transitively, for isolated starts only. Specs: CTRL-GUARD-008.
3. **S53** restart of a stopped or untracked service → it starts the service. Specs: CTRL-RUNTIME-008 (rewritten), CTRL-GUARD-009.
4. **S54** audit `detail` on success → keep. Specs: CTRL-GUARD-007 (unchanged).
5. **S55** invalid `CONTROL_PROCESS_MODE` in `cohostctl` → reject with the dashboard's message, exit 2. Specs: CTRL-CLI-007.
6. **H1** overlap with event-bus → event-bus owns the heartbeat transport and shutdown mechanics; CTRL-HEARTBEAT-007 deleted (number not reused), CTRL-HEARTBEAT-005 narrowed to the heartbeat's `beforeShutdown` registration.
7. **P8** (related) where a restarted service starts reading is its bus start mode (memory `resume`, every other `latest`); the controller's `fresh` / `resume` stays as an operator override; the manifest groups and default modes match the subscriptions (CTRL-MANIFEST-002), recorded in the LLD.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/control-plane/control-plane-design.md

### EARS
- docs/intent/control-plane/control-plane-specs.md (50 specs: 48 `[x]`, 1 `[ ]`, 1 `[D]`; CTRL-HEARTBEAT-007 is retired)

### Tests (`@spec` lines)
- packages/control/test/cli.test.ts (8)
- packages/control/test/config.test.ts (5)
- packages/control/test/controller.test.ts (20)
- packages/control/test/health.test.ts (13)
- packages/control/test/healthcheck.test.ts (4; the CLI case needs Redis and a built `dist`)
- packages/control/test/manifest.test.ts (4)
- packages/control/test/runtime.test.ts (13)
- packages/bus/test/bus.test.ts (6 `CTRL-*` citations: heartbeat, `tracked`, SIGTERM) and packages/bus/test/shutdown.fixture.ts

### Code (`@spec` lines)
- packages/control/src/cli.ts (4), config.ts (4), controller.ts (2), health.ts (5), healthcheck.ts (2), manifest.ts (2), runtime.ts (6); index.ts (re-exports only)
- packages/control/package.json, packages/control/tsconfig.json
- packages/bus/src/heartbeat.ts (2); packages/bus/src/index.ts cites no `CTRL-*` ID
- Consumers (owned elsewhere): services/dashboard/src/control.ts, routes.ts, feed.ts, index.ts; docker-compose.yml:30-35 (realizes CTRL-CHECK-003, not annotated); Dockerfile:20
- Original plan: docs/plans/control-plane.md

### OpenSpec (frozen)
- openspec/specs/service-health/spec.md
- openspec/specs/service-control/spec.md
- openspec/specs/bus/spec.md (health stream, heartbeat helper, `service.lifecycle`)
- openspec/specs/cortex/spec.md (isolation preset and closure)
- openspec/changes/archive/2026-11-01-add-service-health/, openspec/changes/archive/2026-11-01-add-service-control/ (including `design.md`), openspec/changes/archive/2026-11-01-add-isolated-backends/

## Architecture

**Purpose:** Let the operator see per-service health and start, stop or restart services (compose containers or host pnpm processes), safely and with an audit trail, from the dashboard or a CLI.

**Key Components:**
1. `manifest.ts` — allow-list of 15 units (10 pnpm services, 5 compose-only), with consumer groups, default start mode, `infra`/`self` flags, isolation env presets.
2. `runtime.ts` — `ComposeRuntime` (`docker compose up -d|stop|restart`, `--force-recreate` for env overrides) and `ProcessRuntime` (detached `pnpm --filter ... dev|start`, SIGTERM then SIGKILL after 10 s).
3. `controller.ts` — `ServiceController`: guards (unknown, self, infra), fresh/resume orchestration with consumer-group reset to `$`, `service.lifecycle` audit callback.
4. `packages/bus/src/heartbeat.ts` — `startHeartbeat` publisher on `cohost:health` (5 s default, change watcher, `stopping` before shutdown).
5. `health.ts` — `HealthTracker`: up, degraded, stale, down, unknown, crash-looping.
6. `healthcheck.ts` — compose container healthcheck from the newest heartbeat.
7. `cli.ts` — `cohostctl status | start | stop | restart` (exit 0/1/2).
8. `config.ts` — `CONTROL_*` parsing and constant-time bearer check (used by the dashboard).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| Manifest | CTRL-MANIFEST-001 to 005 | 5 | 0 | 0 | 5 |
| Runtime | CTRL-RUNTIME-001 to 009 | 8 | 0 | 1 (RUNTIME-009) | 8 |
| Guards | CTRL-GUARD-001 to 009 | 9 | 0 | 0 | 9 |
| Config | CTRL-CONFIG-001 to 003 | 3 | 0 | 0 | 3 |
| Heartbeat | CTRL-HEARTBEAT-001 to 008 (007 retired) | 7 | 0 | 0 | 6 |
| Health | CTRL-HEALTH-001 to 007 | 7 | 0 | 0 | 7 |
| Healthcheck | CTRL-CHECK-001 to 003 | 3 | 0 | 0 | 2 |
| CLI | CTRL-CLI-001 to 007 | 6 | 1 | 0 | 4 |

**Summary:** 48 of 50 specs implemented ([x]); 1 deferred ([D]); 1 gap ([ ]). 44 of the 48 implemented specs have a test carrying their `@spec` ID. Implemented specs with no test: CTRL-HEARTBEAT-001, CTRL-CHECK-003, CTRL-CLI-004, CTRL-CLI-005. Implemented spec with no code annotation: CTRL-CHECK-003 (lives in `docker-compose.yml`).

## Key Findings

1. **Markers.** Every `[x]` line was confirmed in code at `49ba935`; CTRL-CLI-006 stays `[D]` (commit `1d316ff` names compose as the intended CLI runtime). The owner decisions rewrote CTRL-RUNTIME-008 (restart of an untracked service starts it), added CTRL-GUARD-009 and CTRL-CLI-007, narrowed CTRL-HEARTBEAT-005 and retired CTRL-HEARTBEAT-007; CTRL-RUNTIME-008, CTRL-GUARD-008, CTRL-GUARD-009 and CTRL-CLI-007 are now implemented and tested, and CTRL-MANIFEST-002 lists the chat and eyes groups and the `fresh` defaults for chat, eyes and ears.
2. **Spec lines corrected to match the code** (IDs kept): CTRL-RUNTIME-007 (an already-exited tracked child resolves `ok: true`, `already exited`), CTRL-GUARD-005 (a failed reset during a fresh restart returns without starting), CTRL-GUARD-007 (the audit carries `detail` whenever the runtime returned one, success included; S54), CTRL-CLI-002 (the named-service check runs against the whole snapshot), CTRL-CLI-003 (exact output strings), CTRL-HEARTBEAT-006 (the warning needs a supplied logger). CTRL-MANIFEST-005 pins the `KNOWN_SERVICES` ⊆ manifest invariant that `manifest.test.ts:23` tests.
3. **Compose isolated starts do not reach the container** — the isolation preset is set only on the `docker compose` process env (`packages/control/src/runtime.ts:61`), while `docker-compose.yml:11-20` has a fixed `environment` block and `env_file: .env` with no pass-through. Tests assert only the exec env (`runtime.test.ts:44`). (CTRL-RUNTIME-009, B17)
4. **Isolated starts start the `requires` closure** — the manifest has an optional `requires` field (cortex: salience, affect) and an isolated start runs the closure first, depth-first, each unit in its own default mode and audited separately (CTRL-GUARD-008, S52).
5. **Restart of a stopped or untracked service starts it** — `ProcessRuntime.stop` marks an untracked id `notRunning`, `ProcessRuntime.restart` and the controller's fresh/isolated stop-then-start path continue as a start for that signal only; in-memory pids still mean `cohostctl` cannot stop what another invocation started (`README.md:331-332`, CTRL-CLI-006 `[D]`). (CTRL-RUNTIME-008, CTRL-GUARD-009, S53)
6. **Clock semantics differ between consumers** — live `HealthTracker.ingest` uses local receive time (`health.ts:61`), but `seed` and `cohostctl status` pass the publisher-stamped `ts` (`health.ts:77-79`, `cli.ts:112`), and `healthcheck.ts:14` compares bus `ts` with the local clock, so container clock skew affects those two.
7. **Config validation is shared** — `parseProcessMode` (`config.ts`) backs both `loadControlConfig` and `cohostctl`, which rejects an invalid `CONTROL_PROCESS_MODE` before creating the bus (exit 2). (CTRL-CLI-007, S55)
8. **Entry-point plumbing is fragile and untested** — `index.ts` re-exports `cli.js`, which runs `main()` when `argv[1]` merely ends with `cli.js` (`cli.ts:125`); `cohostctl` therefore only works from the built `dist`. No test reaches `main()`, so CTRL-CLI-004 and CTRL-CLI-005 are untested (`cli.test.ts` builds its own controller). `@cohost/config` is declared and referenced in tsconfig but never imported (`packages/control/package.json:14`), and `heartbeat.ts` and `packages/bus/src/index.ts` import each other (`heartbeat.ts:2`, `packages/bus/src/index.ts:259`).
9. **Partial test coverage behind annotated tests** — CTRL-MANIFEST-001 (field shapes, not the 15 ids), CTRL-MANIFEST-003 (flags; presets only through `controller.test.ts:63`), CTRL-RUNTIME-001 (argv, not timeout or `cwd`), CTRL-CONFIG-002 (`isLoopback` untested), CTRL-HEARTBEAT-004 (ignoring `ready()` after `stop()` untested), CTRL-HEALTH-007 (no-overwrite on replay untested).
10. **`stopping` depends on a graceful `onShutdown`** — a crash or SIGKILL publishes nothing and the service only goes stale (3x) then down (10x) (`heartbeat.ts:111-117`, `packages/bus/src/index.ts:242-257`).
11. **Single ownership with event-bus** — the heartbeat transport and shutdown mechanics are BUS-STREAM-004, BUS-HEALTH-001 and BUS-STOP-002 only; `packages/bus/src/index.ts` and the transport tests cite only `BUS-*` IDs, and CTRL-HEARTBEAT-005 is cited at `heartbeat.ts:60` and on the SIGTERM test (`bus.test.ts:256`). (H1)
12. **Manifest groups match the subscriptions** — chat and eyes own groups of their own name and chat, eyes and ears default to `fresh`, as every `latest` subscriber does; memory alone is `resume` (CTRL-MANIFEST-002).
13. **OpenSpec baselines exist and are frozen** — `openspec/specs/service-health/` and `openspec/specs/service-control/` hold the archived capabilities; the code comments that cite intent (`manifest.ts:4`, `health.ts:46`) point at this segment's specs.

## Work Required

### Must Fix
1. Make isolation env reach containers under the compose runtime through pass-through entries in `docker-compose.yml`, and pin `CONTROL_ENABLED: "0"` for the dashboard container (deployment change; B17; CTRL-RUNTIME-009). Control-plane code and tests are ready; the spec stays `[ ]` until the compose entries exist.

### Nice to Have
2. Drop the unused `@cohost/config` dependency or use it; tighten the `cli.js` entry guard (CTRL-CLI-005).
3. Single source for the known-service list instead of `KNOWN_SERVICES` plus the manifest (CTRL-HEALTH-005, CTRL-MANIFEST-001, CTRL-MANIFEST-005).
4. Tests for `main()` wiring (CTRL-CLI-004, CTRL-CLI-005), the heartbeat payload fields (CTRL-HEARTBEAT-001), `isLoopback`, compose `cwd`, the entry guard, and the partial gaps in Key Finding 9.
5. Persist process pids if the process runtime should survive controller restarts (CTRL-CLI-006).
6. Annotate the compose healthcheck wiring (`docker-compose.yml:30-35`) for CTRL-CHECK-003 in a deployment pass.
