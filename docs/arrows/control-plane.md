# Arrow: control-plane

Service manifest, heartbeat contract and health derivation, start/stop/restart controller with the compose runtime, the stack controller (launch, rebuild, stop-all, restart-all), the lifecycle lock, the `cohostctl` CLI with its latency report, and the compose container healthcheck.

## Status

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): isolation presets are delivered as `COHOST_ISOLATION` and the stack status reports each running container's overrides (CTRL-STACK-014, -016). Total 117 specs: 113 `[x]`, 2 `[ ]`, 2 `[D]`.

**MAPPED**: 117 specs: 113 implemented, 2 deferred (CTRL-LAT-009, CTRL-LAT-010), 2 gaps (CTRL-CONFIG-001 and -002, rewritten for the one lock of #370: `CONTROL_TOKEN` always required, `CONTROL_ENABLED` retired, `CONTROL_ADVANCED` a safety switch; CTRL-RUNTIME-016, `data/logs` created before Compose, is built in `packages/control/src/logs-dir.ts`, #349); CTRL-LAT-030 and -031 run through the `perf:baseline` task of deployment #344. The last audit pass (at cb06bf3) covered the other 111 (all but CTRL-RUNTIME-014 and -015, which are verified by their tests), and the status returns to AUDITED when an audit pass re-verifies the segment. CTRL-RUNTIME-014 and -015 (the secrets projection before compose actions, and its command-line entry; #318) are built in `packages/control/src/secrets.ts` and `project-secrets.ts`. The early-reply latency specs (CTRL-LAT-003 to 005, 018 to 033) are implemented. The `CHAT_SOURCES` preset is built (CTRL-RUNTIME-009).

## Orientation

- Design: LLD § Service manifest, Runtime, Controller, Stack controller, Lifecycle lock, Health derivation, Container healthcheck, `cohostctl`, Latency report.
- The manifest has 20 units: twelve pnpm application services (`connector-discord` and `tools` among them) and eight compose-only units. The host-run dashboard is not a unit.
- The heartbeat publisher is `startHeartbeat` in `packages/shared/src/lifecycle.ts`, called from `packages/shared/src/boot.ts`; its mechanics are SHARED-LIFE-006 to SHARED-LIFE-014 ([shared-runtime.md](shared-runtime.md)). What a published state means to an observer is CTRL-HEALTH-*.
- Compose side: the `x-ts-service` anchor in `docker-compose.yml` realizes CTRL-CHECK-003 and passes the isolation preset through (CTRL-RUNTIME-009); the `Dockerfile` bakes `SERVICE` into the image. Both belong to [deployment.md](deployment.md) (DEPLOY-HC-001, DEPLOY-COMPOSE-017).
- The dashboard consumes the stack controller (DASH-STACK-*, [dashboard.md](dashboard.md)); the readiness wait relies on the Compose healthcheck.
- Original proposal, superseded by the LLD: docs/plans/control-plane.md.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/control-plane/control-plane-design.md

### EARS
- docs/intent/control-plane/control-plane-specs.md (117 specs, prefix `CTRL`: 113 `[x]`, 2 `[ ]`, 2 `[D]`; CTRL-LAT-030 and -031 name the `perf:baseline` task of deployment #344)

### Tests
- packages/control/test/cli.test.ts
- packages/control/test/cli-main.test.ts
- packages/control/test/compose.test.ts
- packages/control/test/config.test.ts
- packages/control/test/controller.test.ts
- packages/control/test/health.test.ts
- packages/control/test/health-clock.test.ts
- packages/control/test/healthcheck.test.ts
- packages/control/test/latency.test.ts
- packages/control/test/latency-early.test.ts
- packages/control/test/perf-baseline.test.ts
- packages/control/test/launch.e2e.test.ts
- packages/control/test/lock.test.ts
- packages/control/test/manifest.test.ts
- packages/control/test/runtime.test.ts
- packages/control/test/stack.test.ts
- packages/control/test/stack-rebuild.test.ts

### Code
- packages/control/src/cli.ts, config-gate.ts, config.ts, controller.ts, docker.ts, health.ts, healthcheck.ts, latency.ts, lock.ts, manifest.ts, runtime.ts, stack.ts
- scripts/dev/perf-baseline.sh, scripts/dev/perf-connector.ts (connector mode, CTRL-LAT-030, -031)
- packages/bus/src/index.ts (`Bus.serverTime`, CTRL-CHECK-004), crates/cohost-bus/src/transport.rs (CTRL-CHECK-004)
- Consumers (owned elsewhere): services/dashboard/src/control.ts, routes.ts, stack.ts; docker-compose.yml (`x-ts-service`, realizes CTRL-CHECK-003, not annotated); Dockerfile

## Architecture

**Purpose:** Let the operator see per-service health and start, stop or restart services (compose containers), safely and with an audit trail, from the dashboard or a CLI.

**Key Components:**
1. `manifest.ts` — allow-list of 20 units (12 pnpm services, 8 compose-only), with consumer groups, default start mode, `infra` flag, `requires`, isolation env presets.
2. `runtime.ts` — `ComposeRuntime` (`docker compose up -d|stop|restart`, `--force-recreate` for env overrides, the `consolidate` and `reembed` one-shots), the only runtime; `docker.ts` resolves the Docker executable.
3. `controller.ts` — `ServiceController`: guards (unknown, infra), fresh/resume orchestration with consumer-group reset to `$`, the `requires` closure for isolated starts, `service.lifecycle` audit callback.
4. `stack.ts` — `StackController`: launch, rebuild, stop-all, restart-all, status with restart counts, derived stack state.
5. `lock.ts` — `LifecycleLock` on `data/control.lock` (taken by `cohostctl` for every command but `status` and `latency`).
6. `health.ts` — `HealthTracker`: up, degraded, stale, down, unknown, crash-looping, on a monotonic clock; `withContainerRestarts` overlay.
7. `healthcheck.ts` — compose container healthcheck from the newest heartbeat.
8. `cli.ts` — `cohostctl status | start | stop | restart | latency | consolidate | reembed | launch | rebuild | stop-all | restart-all` (exit 0/1/2).
9. `latency.ts` — speech-path and vision-path latency report from bus history.
10. `config.ts` — `CONTROL_*` parsing and constant-time bearer check (used by the dashboard).

## Spec Coverage

| Category | Spec IDs | Specs | Implemented | Deferred | Gaps |
|----------|----------|-------|-------------|----------|------|
| Service manifest | CTRL-MANIFEST-001 to CTRL-MANIFEST-006 | 6 | 6 | 0 | 0 |
| Runtime adapters | CTRL-RUNTIME-001 to -004, CTRL-RUNTIME-009 to -016 | 12 | 12 | 0 | 0 |
| Controller guards and orchestration | CTRL-GUARD-001, -003 to -008 | 7 | 7 | 0 | 0 |
| Stack controller | CTRL-STACK-001 to CTRL-STACK-019 | 19 | 19 | 0 | 0 |
| Lifecycle lock | CTRL-LOCK-001 to CTRL-LOCK-004 | 4 | 4 | 0 | 0 |
| Control configuration | CTRL-CONFIG-001 to CTRL-CONFIG-003 | 3 | 3 | 0 | 0 |
| Health derivation | CTRL-HEALTH-001 to CTRL-HEALTH-011 | 11 | 11 | 0 | 0 |
| Container healthcheck | CTRL-CHECK-001 to CTRL-CHECK-004 | 4 | 4 | 0 | 0 |
| cohostctl command line | CTRL-CLI-001 to -005, -008 to -018 | 16 | 16 | 0 | 0 |
| Config gate | CTRL-GATE-001 to CTRL-GATE-002 | 2 | 2 | 0 | 0 |
| Latency report | CTRL-LAT-001 to CTRL-LAT-014 | 14 | 12 | 2 | 0 |
| Early-reply latency | CTRL-LAT-018 to CTRL-LAT-033 | 16 | 16 | 0 | 0 |
| Streamed-line latency | CTRL-LAT-015 to CTRL-LAT-017 | 3 | 3 | 0 | 0 |

**Summary:** 117 specs: 113 implemented, 2 gaps (CTRL-CONFIG-001, -002, #370), 2 deferred (CTRL-RUNTIME-016 built, #349). The early-reply latency specs (CTRL-LAT-018 to 033, with CTRL-LAT-003 to 005 revised) are implemented. `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **Partial test coverage behind annotated tests** — CTRL-MANIFEST-001 (field shapes, not every id), CTRL-RUNTIME-001 (argv, not timeout or `cwd`), CTRL-HEALTH-007 (no-overwrite on replay untested).
2. **`stopping` depends on a graceful shutdown** — a crash or SIGKILL publishes nothing and the service only goes stale (3x) then down (10x) (SHARED-LIFE-006 to -014).
3. **Single ownership with the bus and shared runtime** — the heartbeat transport and shutdown mechanics are BUS-STREAM-004, BUS-HEALTH-001 and SHARED-LIFE-*; this segment owns what the states mean (CTRL-HEALTH-*) and the healthcheck (CTRL-CHECK-*).
4. **Manifest groups match the subscriptions** — chat and eyes own groups of their own name and chat, eyes and ears default to `fresh`, as every `latest` subscriber does; memory alone is `resume`; `connector-discord` owns none (CTRL-MANIFEST-002).

## Work Required

- Speech engine servers (design 2026-11-16, built in #190): three compose-only units (CTRL-MANIFEST-006), Launch with engine profiles (CTRL-STACK-018) and the Pocket token file (CTRL-STACK-019).
- The chat isolation preset `CHAT_SOURCES=[fake]` is built (CTRL-RUNTIME-009).
### Must Fix
None.

### Should Fix
None.

### Nice to Have
1. Tests for `isLoopback` and the partial gaps in Key Finding 1.
