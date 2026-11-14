# Arrow: control-plane

Service manifest, heartbeat contract and health derivation, start/stop/restart controller with the compose runtime, the `cohostctl` CLI and the compose container healthcheck.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 47 specs: 47 implemented, 0 deferred, 0 gaps (CTRL-RUNTIME-009 landed via the `docker-compose.yml` pass-through, DEPLOY-COMPOSE-017). The owner answered the audit questions on 2026-11-01; the decisions are applied below and the control-plane gap fixes are landed. The owner decision of 2026-11-08 removed the host-process runtime; compose is the only runtime. The spec file now holds 61 specs, all `[x]`: the stack controller landed as chunk 1 of the standalone-dashboard build order (see below).

## Listening and speaking split (built)

Build chunk 3 in [mouth.md](mouth.md): CTRL-MANIFEST-001 (15 units, ten app services with `mouth`), CTRL-MANIFEST-002 (group `mouth`, default `fresh`), CTRL-MANIFEST-003 (`mouth` preset `MOUTH_DISCORD_ENABLED=false`) and CTRL-HEALTH-005 (`KNOWN_SERVICES` gains `mouth`) are built and `[x]`, tested in `packages/control/test/manifest.test.ts`. Launch starts mouth only when `COMPOSE_PROFILES` names the `mouth` profile.

## Standalone dashboard: stack controller (built, chunk 1)

Design: LLD § Stack controller; owner decisions in the dashboard LLD § Host process and stack control and its [decision doc](../intent/dashboard/decisions/standalone-dashboard.md). Mechanics confirmed by the owner (recommended defaults).

- New `[x]`: CTRL-STACK-001 to 012 (`StackController`: workspace-root cwd, launch with readiness wait, stop-all, restart-all, status probe, stack state, `COHOST_DOCKER_BIN` / `docker` / `docker.exe`), CTRL-CLI-010 to 012 (`cohostctl launch`, `stop-all`, `restart-all`).
- Reworded `[x]`: CTRL-MANIFEST-001, 002, 003 (`dashboard` leaves the manifest, no `self` flag), CTRL-HEALTH-005 (ten known services), CTRL-CLI-001 (parse; `stop` takes no options), CTRL-CLI-009 (bus only for status/start/stop/restart/restart-all).
- Built in `packages/control/src/stack.ts` (`StackController`, `stackState`) and `docker.ts` (`resolveDockerBin`, shared by `ComposeRuntime`); `cohostctl launch`, `stop-all` and `restart-all` in `cli.ts`. `restart-all` returns per-unit outcomes in `restarts` beside the `{ok, detail?, services?}` result so the CLI can print one line per unit.
- Cross-segment test edit: three dashboard-service tests (DASH-SVC-003, DASH-FEED-001, DASH-FEED-006) follow the manifest and known-list change (404 for `dashboard`, nine known services); the dashboard service code is untouched.
- Cross-segment: the dashboard consumes the controller (DASH-STACK-*); the readiness wait relies on the Compose healthcheck (CTRL-CHECK-003, deployment DEPLOY-HC-001).
- Build: chunk 1 (done) of the order in [dashboard.md](dashboard.md#standalone-host-run-dashboard-designed-not-built).

## Reopened: Launch builds, lifecycle lock (built)

- Reworded `[x]`: CTRL-STACK-002 (launch runs `up -d --build --remove-orphans`, phase `compose-build`), CTRL-STACK-013 (rebuild is the same command under kind `rebuild`).
- New `[x]`: CTRL-LOCK-001 to 004 (`LifecycleLock` in `packages/control/src/lock.ts`, `data/control.lock` with stale-pid detection; `cohostctl` takes it for every command but `status`). Dashboard side: DASH-STACK-009.
- Docker Engine API stays dropped, now with the concrete reason in the LLD Decisions table (Compose project model, profiles, `--project` handling and `build:` exist only in the Compose CLI). The restart-count overlay (CTRL-STACK-014) stays.
- Tests: `packages/control/test/lock.test.ts`, `cli-main.test.ts`, `stack.test.ts`, `stack-rebuild.test.ts`; dashboard `stack-lock.test.ts`, `page.test.ts`.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B17** isolation env under compose → pass-through `VAR: ${VAR:-}` entries for every preset variable in the compose `x-ts-service` environment. Specs: CTRL-RUNTIME-009.
2. **S52** isolated start closure → manifest `requires`, followed transitively, for isolated starts only. Specs: CTRL-GUARD-008.
4. **S54** audit `detail` on success → keep. Specs: CTRL-GUARD-007 (unchanged).
6. **H1** overlap with event-bus → event-bus owns the heartbeat transport and shutdown mechanics; SHARED-LIFE-010 narrowed to the heartbeat's `beforeShutdown` registration.
8. **R1** remove the host-process runtime: compose is the only runtime ("no service should be handling other services"); amended: CTRL-RUNTIME-004, CTRL-GUARD-005, CTRL-CONFIG-002, CTRL-CLI-004.
7. **P8** (related) where a restarted service starts reading is its bus start mode (memory `resume`, every other `latest`); the controller's `fresh` / `resume` stays as an operator override; the manifest groups and default modes match the subscriptions (CTRL-MANIFEST-002), recorded in the LLD.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/control-plane/control-plane-design.md

### EARS
- docs/intent/control-plane/control-plane-specs.md (86 specs: 84 `[x]`, 0 `[ ]`, 2 `[D]`; CTRL-LAT-001 to 008 and 011 to 014 are built and CTRL-LAT-009 and 010 are deferred, the `cohostctl latency` report with its speech-path and vision-path sections)

### Tests (`@spec` lines)
- packages/control/test/cli.test.ts (16)
- packages/control/test/config.test.ts (5)
- packages/control/test/controller.test.ts (17)
- packages/control/test/health.test.ts (13)
- packages/control/test/healthcheck.test.ts (4; the CLI case needs Redis and a built `dist`)
- packages/control/test/manifest.test.ts (5)
- packages/control/test/runtime.test.ts (9)
- packages/control/test/stack.test.ts (18)
- packages/bus/test/bus.test.ts (6 `CTRL-*` citations: heartbeat, `tracked`, SIGTERM) and packages/bus/test/shutdown.fixture.ts

### Code (`@spec` lines)
- packages/control/src/cli.ts (4), config.ts (3), controller.ts (2), docker.ts (1), health.ts (5), healthcheck.ts (2), manifest.ts (2), runtime.ts (4), stack.ts (7); index.ts (re-exports only)
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

**Purpose:** Let the operator see per-service health and start, stop or restart services (compose containers), safely and with an audit trail, from the dashboard or a CLI.

**Key Components:**
1. `manifest.ts` — allow-list of 15 units (10 pnpm services, 5 compose-only), with consumer groups, default start mode, `infra`/`self` flags, isolation env presets.
2. `runtime.ts` — `ComposeRuntime` (`docker compose up -d|stop|restart`, `--force-recreate` for env overrides), the only runtime.
3. `controller.ts` — `ServiceController`: guards (unknown, self, infra), fresh/resume orchestration with consumer-group reset to `$`, `service.lifecycle` audit callback.
4. `packages/bus/src/heartbeat.ts` — `startHeartbeat` publisher on `cohost:health` (5 s default, change watcher, `stopping` before shutdown).
5. `health.ts` — `HealthTracker`: up, degraded, stale, down, unknown, crash-looping.
6. `healthcheck.ts` — compose container healthcheck from the newest heartbeat.
7. `cli.ts` — `cohostctl status | start | stop | restart` (exit 0/1/2).
8. `config.ts` — `CONTROL_*` parsing and constant-time bearer check (used by the dashboard).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Service manifest | CTRL-MANIFEST-001 to CTRL-MANIFEST-005 | 5 | 0 | 0 | 5 |
| Runtime adapters | CTRL-RUNTIME-001 to CTRL-RUNTIME-012 | 8 | 0 | 0 | 8 |
| Controller guards and orchestration | CTRL-GUARD-001 to CTRL-GUARD-008 | 7 | 0 | 0 | 7 |
| Stack controller | CTRL-STACK-001 to CTRL-STACK-015 | 15 | 0 | 0 | 15 |
| Control configuration | CTRL-CONFIG-001 to CTRL-CONFIG-003 | 3 | 0 | 0 | 3 |
| Health derivation | CTRL-HEALTH-001 to CTRL-HEALTH-011 | 11 | 0 | 0 | 11 |
| Container healthcheck | CTRL-CHECK-001 to CTRL-CHECK-004 | 4 | 0 | 0 | 4 |
| cohostctl command line | CTRL-CLI-001 to CTRL-CLI-017 | 15 | 0 | 0 | 15 |

**Summary:** 64 of 65 specs implemented; 0 deferred; 1 open. 65 carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **Markers.** Every `[x]` line was confirmed in code at `49ba935`. The owner decisions narrowed SHARED-LIFE-010; CTRL-GUARD-008 is implemented and tested, and CTRL-MANIFEST-002 lists the chat and eyes groups and the `fresh` defaults for chat, eyes and ears.
2. **Spec lines corrected to match the code** (IDs kept): CTRL-GUARD-005 (a failed reset during a fresh restart returns without starting), CTRL-GUARD-007 (the audit carries `detail` whenever the runtime returned one, success included; S54), CTRL-CLI-002 (the named-service check runs against the whole snapshot), CTRL-CLI-003 (exact output strings), SHARED-LIFE-011 (the warning needs a supplied logger). CTRL-MANIFEST-005 pins the `KNOWN_SERVICES` ⊆ manifest invariant that `manifest.test.ts:23` tests.
3. **Compose isolated starts do not reach the container** — the isolation preset is set only on the `docker compose` process env (`packages/control/src/runtime.ts:61`), while `docker-compose.yml:11-20` has a fixed `environment` block and `env_file: .env` with no pass-through. Tests assert only the exec env (`runtime.test.ts:44`). (CTRL-RUNTIME-009, B17)
4. **Isolated starts start the `requires` closure** — the manifest has an optional `requires` field (cortex: salience, affect) and an isolated start runs the closure first, depth-first, each unit in its own default mode and audited separately (CTRL-GUARD-008, S52).
5. **Compose is the only runtime** — the host-process runtime (in-memory pids, `notRunning` stop signal) is removed; the controller, `cohostctl` and the dashboard always build `ComposeRuntime`. (R1)
6. **Clock semantics differ between consumers** — live `HealthTracker.ingest` uses local receive time (`health.ts:61`), but `seed` and `cohostctl status` pass the publisher-stamped `ts` (`health.ts:77-79`, `cli.ts:112`), and `healthcheck.ts:14` compares bus `ts` with the local clock, so container clock skew affects those two.
7. **No runtime selection** — `loadControlConfig` and `cohostctl` read no `CONTROL_RUNTIME` or `CONTROL_PROCESS_MODE`; stale values in `.env` are ignored. (CTRL-CLI-004, CTRL-CONFIG-002)
8. **Entry-point plumbing is fragile and untested** — `index.ts` re-exports `cli.js`, which runs `main()` when `argv[1]` merely ends with `cli.js` (`cli.ts:125`); `cohostctl` therefore only works from the built `dist`. No test reaches `main()`, so CTRL-CLI-005 is untested; CTRL-CLI-004 is tested through `buildRuntime`. `@cohost/config` is declared and referenced in tsconfig but never imported (`packages/control/package.json:14`), and `heartbeat.ts` and `packages/bus/src/index.ts` import each other (`heartbeat.ts:2`, `packages/bus/src/index.ts:259`).
9. **Partial test coverage behind annotated tests** — CTRL-MANIFEST-001 (field shapes, not the 15 ids), CTRL-MANIFEST-003 (flags; presets only through `controller.test.ts:63`), CTRL-RUNTIME-001 (argv, not timeout or `cwd`), CTRL-CONFIG-002 (`isLoopback` untested), SHARED-LIFE-009 (ignoring `ready()` after `stop()` untested), CTRL-HEALTH-007 (no-overwrite on replay untested).
10. **`stopping` depends on a graceful `onShutdown`** — a crash or SIGKILL publishes nothing and the service only goes stale (3x) then down (10x) (`heartbeat.ts:111-117`, `packages/bus/src/index.ts:242-257`).
11. **Single ownership with event-bus** — the heartbeat transport and shutdown mechanics are BUS-STREAM-004, BUS-HEALTH-001 and SHARED-LIFE-001 only; `packages/bus/src/index.ts` and the transport tests cite only `BUS-*` IDs, and SHARED-LIFE-010 is cited at `heartbeat.ts:60` and on the SIGTERM test (`bus.test.ts:256`). (H1)
12. **Manifest groups match the subscriptions** — chat and eyes own groups of their own name and chat, eyes and ears default to `fresh`, as every `latest` subscriber does; memory alone is `resume` (CTRL-MANIFEST-002).
13. **OpenSpec baselines exist and are frozen** — `openspec/specs/service-health/` and `openspec/specs/service-control/` hold the archived capabilities; the code comments that cite intent (`manifest.ts:4`, `health.ts:46`) point at this segment's specs.

## Work Required

### Must Fix
None outstanding: the isolation pass-through entries are in `docker-compose.yml` (CTRL-RUNTIME-009, DEPLOY-COMPOSE-017).

### Should Fix
- Build the stack controller and the `cohostctl` stack commands (CTRL-STACK-*, CTRL-CLI-010 to 012) and remove `dashboard` from the manifest (CTRL-MANIFEST-001 to 003, CTRL-HEALTH-005).

### Nice to Have
2. Drop the unused `@cohost/config` dependency or use it (the stack controller's workspace-root cwd, CTRL-STACK-001, uses it); tighten the `cli.js` entry guard (CTRL-CLI-005).
3. Single source for the known-service list instead of `KNOWN_SERVICES` plus the manifest (CTRL-HEALTH-005, CTRL-MANIFEST-001, CTRL-MANIFEST-005).
4. Tests for `main()` wiring (CTRL-CLI-005), the heartbeat payload fields (SHARED-LIFE-006), `isLoopback`, compose `cwd`, the entry guard, and the partial gaps in Key Finding 9.
5. Annotate the compose healthcheck wiring (`docker-compose.yml:30-35`) for CTRL-CHECK-003 in a deployment pass.
