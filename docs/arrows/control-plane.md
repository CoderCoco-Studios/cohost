# Arrow: control-plane

Service manifest, heartbeat contract and health derivation, start/stop/restart controller with two runtimes, the `cohostctl` CLI and the compose container healthcheck.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`), not yet audited. 45 of 48 specs observed in code; 2 gaps (compose isolation env, isolated-run closure); 1 deliberate non-feature.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/control-plane/control-plane-design.md

### EARS
- docs/intent/control-plane/control-plane-specs.md (48 specs)

### Tests
- packages/control/test/cli.test.ts
- packages/control/test/config.test.ts
- packages/control/test/controller.test.ts
- packages/control/test/health.test.ts
- packages/control/test/healthcheck.test.ts (CLI case needs Redis and a built `dist`)
- packages/control/test/manifest.test.ts
- packages/control/test/runtime.test.ts
- packages/bus/test/bus.test.ts (lines 128-258: heartbeat, health stream, `tracked`, SIGTERM) and packages/bus/test/shutdown.fixture.ts

### Code
- packages/control/src/index.ts, cli.ts, config.ts, controller.ts, health.ts, healthcheck.ts, manifest.ts, runtime.ts
- packages/control/package.json, packages/control/tsconfig.json
- packages/bus/src/heartbeat.ts
- Consumers (owned elsewhere): services/dashboard/src/control.ts, routes.ts, feed.ts, index.ts; docker-compose.yml:30-35; Dockerfile:20
- Original plan: docs/plans/control-plane.md

### OpenSpec
- No `openspec/specs/service-health/` or `openspec/specs/service-control/` baseline exists; both capabilities live only as unarchived deltas:
- openspec/changes/add-service-health/specs/service-health/spec.md
- openspec/changes/add-service-health/specs/bus/spec.md
- openspec/changes/add-service-control/specs/service-control/spec.md
- openspec/changes/add-service-control/specs/bus/spec.md
- openspec/changes/add-service-control/specs/dashboard/spec.md
- openspec/changes/add-service-control/design.md
- openspec/changes/add-isolated-backends/specs/cortex/spec.md (isolation closure)

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

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Manifest | CTRL-MANIFEST-001 to 004 | 4 | 0 | 0 |
| Runtime | CTRL-RUNTIME-001 to 009 | 8 | 0 | 1 |
| Guards | CTRL-GUARD-001 to 008 | 7 | 0 | 1 |
| Config | CTRL-CONFIG-001 to 003 | 3 | 0 | 0 |
| Heartbeat | CTRL-HEARTBEAT-001 to 008 | 8 | 0 | 0 |
| Health | CTRL-HEALTH-001 to 007 | 7 | 0 | 0 |
| Healthcheck | CTRL-CHECK-001 to 003 | 3 | 0 | 0 |
| CLI | CTRL-CLI-001 to 006 | 5 | 1 | 0 |

**Summary:** 45 of 48 specs implemented ([x]); 1 deferred ([D]); 2 gaps ([ ]).

## Key Findings

1. **Compose isolated starts probably do not reach the container** — the isolation preset is set only on the `docker compose` process env (`packages/control/src/runtime.ts:59`), while `docker-compose.yml:11-21` has a fixed `environment` block and `env_file: .env` with no `${LLM_PROVIDER}`-style interpolation. Tests assert only the exec env (`runtime.test.ts:41`). CTRL-RUNTIME-009.
2. **No isolated-run closure** — the manifest has no `requires`; `controller.ts` starts only the named unit, though `add-isolated-backends` (cortex) and `docs/plans/control-plane.md` §7.2 assume salience and affect come along. CTRL-GUARD-008.
3. **`restart` of an untracked process fails** — `ProcessRuntime.restart` returns the stop failure without starting (`runtime.ts:165-169`), and in-memory pids mean `cohostctl` cannot stop what another invocation started (`README.md:331-332`, CTRL-CLI-006 `[D]`).
4. **Clock semantics differ between consumers** — live `HealthTracker.ingest` uses local receive time (`health.ts:60`), but `seed` and `cohostctl status` pass the publisher-stamped `ts` (`health.ts:75-77`, `cli.ts:109`), and `healthcheck.ts:13` compares bus `ts` with the local clock, so container clock skew affects those two.
5. **Config validation differs between dashboard and CLI** — `loadControlConfig` throws on an invalid `CONTROL_PROCESS_MODE` (`config.ts:31`); `cli.ts:90,103` silently falls back to `dev`. `[inferred]` unintentional.
6. **Entry-point plumbing is fragile** — `index.ts` re-exports `cli.js`, which runs `main()` when `argv[1]` merely ends with `cli.js` (`cli.ts:121`); `cohostctl` therefore only works from the built `dist`. `@cohost/config` is declared and referenced in tsconfig but never imported (`packages/control/package.json:14`), and `heartbeat.ts` and `bus/src/index.ts` import each other (`heartbeat.ts:2`, `index.ts:247`).
7. **`stopping` depends on a graceful `onShutdown`** — a crash or SIGKILL publishes nothing and the service only goes stale (3x) then down (10x) (`heartbeat.ts:109-115`, `bus/src/index.ts:230-243`).
8. **Missing baselines** — `service-health` and `service-control` have no `openspec/specs/` directory, yet `manifest.ts:4` and `health.ts:45` cite them.

## Work Required

### Must Fix
1. Make isolation env reach containers under the compose runtime (CTRL-RUNTIME-009), either by passing variables through `docker-compose.yml` or by another mechanism.

### Should Fix
2. Compute the dependency closure for isolated starts (CTRL-GUARD-008).
3. Decide whether `restart` of a stopped or untracked service should start it (CTRL-RUNTIME-008, CTRL-GUARD-005).
4. Align `CONTROL_PROCESS_MODE` validation between `cli.ts` and `config.ts` (CTRL-CONFIG-002, CTRL-CLI-004).
5. Archive the `service-health` and `service-control` deltas into baselines and fix the stale comment paths (manifest.ts:4, health.ts:45).

### Nice to Have
6. Drop the unused `@cohost/config` dependency or use it; tighten the `cli.js` entry guard (CTRL-CLI-005).
7. Single source for the known-service list instead of `KNOWN_SERVICES` plus the manifest (CTRL-HEALTH-005, CTRL-MANIFEST-001).
8. Tests for `main()`, `isLoopback`, compose `cwd`, and the entry guard.
9. Persist process pids if the process runtime should survive controller restarts (CTRL-CLI-006).
