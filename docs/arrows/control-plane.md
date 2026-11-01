# Arrow: control-plane

Service manifest, heartbeat contract and health derivation, start/stop/restart controller with two runtimes, the `cohostctl` CLI and the compose container healthcheck.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA `686cc8f`). Specs verified against the code at git `49ba935`: 46 of 49 specs implemented; 1 deferred (cross-invocation process stop, deliberate); 2 gaps (compose isolation env, isolated-run closure). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **How should isolation env reach compose containers?** (CTRL-RUNTIME-009) The preset is set only on the `docker compose` CLI process (`packages/control/src/runtime.ts:61`); `docker-compose.yml:11-21` has a fixed `environment` block and `env_file: .env` with no pass-through. Recommended: add pass-through entries such as `LLM_PROVIDER: ${LLM_PROVIDER:-}` to the `x-ts-service` environment block (deployment segment), so an unset variable still falls to the `${VAR:-default}` in `config.example.yaml`.
2. **Should an isolated start bring its bus-level requirements along?** (CTRL-GUARD-008) `openspec/specs/cortex/spec.md:111-112` and `docs/plans/control-plane.md` §7.2 say an isolated cortex run includes salience and affect; the manifest has no `requires` (`packages/control/src/manifest.ts:39-55`) and the controller starts one unit (`packages/control/src/controller.ts:73-99`). Recommended: yes; add `requires` to the manifest and start the closure only for isolated starts.
3. **Should `restart` of a stopped or untracked process start it?** Under `ProcessRuntime`, restart returns the stop failure (`runtime.ts:171-175`, CTRL-RUNTIME-008) and a fresh restart never reaches the group reset (`controller.ts:88-93`). Recommended: when nothing is tracked, treat restart as start.
4. **Should the audit record carry `detail` on success?** (CTRL-GUARD-007) The controller copies any runtime `detail` into the `service.lifecycle` record (`controller.ts:96`), so a successful process start records `pid <n>`. Recommended: keep it (useful audit data); CTRL-GUARD-007 now says so.
5. **Should `cohostctl` reject an invalid `CONTROL_PROCESS_MODE` like the dashboard does?** `loadControlConfig` throws (`config.ts:33`); `cli.ts:92,106` silently use `dev`. Recommended: yes; exit 2 with the same message.
6. **Which segment owns the overlapping heartbeat-transport and shutdown specs?** CTRL-HEARTBEAT-007 restates BUS-STREAM-004 + BUS-HEALTH-001, CTRL-HEARTBEAT-005 restates BUS-STOP-002 (`packages/bus/src/index.ts:47,63,241` carry both IDs). Recommended: event-bus; delete CTRL-HEARTBEAT-007 and narrow CTRL-HEARTBEAT-005 to the heartbeat registering `stop()` as a `beforeShutdown` hook.

## References

### HLD
- docs/high-level-design.md

### LLD
- docs/intent/control-plane/control-plane-design.md

### EARS
- docs/intent/control-plane/control-plane-specs.md (49 specs: 46 `[x]`, 2 `[ ]`, 1 `[D]`)

### Tests (`@spec` lines)
- packages/control/test/cli.test.ts (6)
- packages/control/test/config.test.ts (5)
- packages/control/test/controller.test.ts (12)
- packages/control/test/health.test.ts (13)
- packages/control/test/healthcheck.test.ts (4; the CLI case needs Redis and a built `dist`)
- packages/control/test/manifest.test.ts (4)
- packages/control/test/runtime.test.ts (12)
- packages/bus/test/bus.test.ts (8 `CTRL-*` citations: heartbeat, health stream, `tracked`, SIGTERM) and packages/bus/test/shutdown.fixture.ts

### Code (`@spec` lines)
- packages/control/src/cli.ts (4), config.ts (3), controller.ts (2), health.ts (5), healthcheck.ts (2), manifest.ts (2), runtime.ts (6); index.ts (re-exports only)
- packages/control/package.json, packages/control/tsconfig.json
- packages/bus/src/heartbeat.ts (2); packages/bus/src/index.ts (3 lines also cite `CTRL-*`)
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
| Guards | CTRL-GUARD-001 to 008 | 7 | 0 | 1 (GUARD-008) | 7 |
| Config | CTRL-CONFIG-001 to 003 | 3 | 0 | 0 | 3 |
| Heartbeat | CTRL-HEARTBEAT-001 to 008 | 8 | 0 | 0 | 7 |
| Health | CTRL-HEALTH-001 to 007 | 7 | 0 | 0 | 7 |
| Healthcheck | CTRL-CHECK-001 to 003 | 3 | 0 | 0 | 2 |
| CLI | CTRL-CLI-001 to 006 | 5 | 1 | 0 | 3 |

**Summary:** 46 of 49 specs implemented ([x]); 1 deferred ([D]); 2 gaps ([ ]). 42 of the 46 implemented specs have a test carrying their `@spec` ID. Implemented specs with no test: CTRL-HEARTBEAT-001, CTRL-CHECK-003, CTRL-CLI-004, CTRL-CLI-005. Implemented spec with no code annotation: CTRL-CHECK-003 (lives in `docker-compose.yml`).

## Key Findings

1. **Markers hold.** Every `[x]` line was confirmed in code, both `[ ]` gaps still reproduce, and CTRL-CLI-006 stays `[D]` (commit `1d316ff` names compose as the intended CLI runtime); no marker was flipped.
2. **Spec lines corrected to match the code** (IDs kept): CTRL-RUNTIME-007 (an already-exited tracked child resolves `ok: true`, `already exited`), CTRL-GUARD-005 (a failed reset during a fresh restart returns without starting), CTRL-GUARD-007 (the audit carries `detail` whenever the runtime returned one, success included; Question 4), CTRL-CLI-002 (the named-service check runs against the whole snapshot), CTRL-CLI-003 (exact output strings), CTRL-HEARTBEAT-006 (the warning needs a supplied logger). New line CTRL-MANIFEST-005 pins the `KNOWN_SERVICES` ⊆ manifest invariant that `manifest.test.ts:23` already tests.
3. **Compose isolated starts probably do not reach the container** — the isolation preset is set only on the `docker compose` process env (`packages/control/src/runtime.ts:61`), while `docker-compose.yml:11-21` has a fixed `environment` block and `env_file: .env` with no `${LLM_PROVIDER}`-style interpolation. Tests assert only the exec env (`runtime.test.ts:44`). (CTRL-RUNTIME-009, Question 1)
4. **No isolated-run closure** — the manifest has no `requires`; `controller.ts` starts only the named unit, though the OpenSpec cortex requirement (`openspec/specs/cortex/spec.md:111-112`) and `docs/plans/control-plane.md` §7.2 assume salience and affect come along. (CTRL-GUARD-008, Question 2)
5. **`restart` of an untracked process fails** — `ProcessRuntime.restart` returns the stop failure without starting (`runtime.ts:171-175`), and in-memory pids mean `cohostctl` cannot stop what another invocation started (`README.md:331-332`, CTRL-CLI-006 `[D]`). (Question 3)
6. **Clock semantics differ between consumers** — live `HealthTracker.ingest` uses local receive time (`health.ts:61`), but `seed` and `cohostctl status` pass the publisher-stamped `ts` (`health.ts:77-79`, `cli.ts:112`), and `healthcheck.ts:14` compares bus `ts` with the local clock, so container clock skew affects those two.
7. **Config validation differs between dashboard and CLI** — `loadControlConfig` throws on an invalid `CONTROL_PROCESS_MODE` (`config.ts:33`); `cli.ts:92,106` silently fall back to `dev`. `[inferred]` unintentional. (Question 5)
8. **Entry-point plumbing is fragile and untested** — `index.ts` re-exports `cli.js`, which runs `main()` when `argv[1]` merely ends with `cli.js` (`cli.ts:125`); `cohostctl` therefore only works from the built `dist`. No test reaches `main()`, so CTRL-CLI-004 and CTRL-CLI-005 are untested (`cli.test.ts` builds its own controller). `@cohost/config` is declared and referenced in tsconfig but never imported (`packages/control/package.json:14`), and `heartbeat.ts` and `packages/bus/src/index.ts` import each other (`heartbeat.ts:2`, `packages/bus/src/index.ts:259`).
9. **Partial test coverage behind annotated tests** — CTRL-MANIFEST-001 (field shapes, not the 15 ids), CTRL-MANIFEST-003 (flags; presets only through `controller.test.ts:63`), CTRL-RUNTIME-001 (argv, not timeout or `cwd`), CTRL-RUNTIME-008 (success path only), CTRL-CONFIG-002 (`isLoopback` untested), CTRL-HEARTBEAT-004 (ignoring `ready()` after `stop()` untested), CTRL-HEALTH-007 (no-overwrite on replay untested).
10. **`stopping` depends on a graceful `onShutdown`** — a crash or SIGKILL publishes nothing and the service only goes stale (3x) then down (10x) (`heartbeat.ts:111-117`, `packages/bus/src/index.ts:242-255`).
11. **Overlapping specs with event-bus** — CTRL-HEARTBEAT-005 and CTRL-HEARTBEAT-007 restate BUS-STOP-002, BUS-STREAM-004 and BUS-HEALTH-001. (Question 6)
12. **OpenSpec baselines exist and are frozen** — `openspec/specs/service-health/` and `openspec/specs/service-control/` hold the archived capabilities; the code comments that cite intent (`manifest.ts:4`, `health.ts:46`) point at this segment's specs.

## Work Required

### Must Fix
1. Make isolation env reach containers under the compose runtime (CTRL-RUNTIME-009, Question 1), either by passing variables through `docker-compose.yml` or by another mechanism.

### Should Fix
2. Compute the dependency closure for isolated starts (CTRL-GUARD-008, Question 2).
3. Decide whether `restart` of a stopped or untracked service should start it (CTRL-RUNTIME-008, CTRL-GUARD-005, Question 3).
4. Align `CONTROL_PROCESS_MODE` validation between `cli.ts` and `config.ts` (CTRL-CONFIG-002, CTRL-CLI-004, Question 5).
5. Settle ownership of the specs that overlap event-bus (Question 6).

### Nice to Have
6. Drop the unused `@cohost/config` dependency or use it; tighten the `cli.js` entry guard (CTRL-CLI-005).
7. Single source for the known-service list instead of `KNOWN_SERVICES` plus the manifest (CTRL-HEALTH-005, CTRL-MANIFEST-001, CTRL-MANIFEST-005).
8. Tests for `main()` (CTRL-CLI-004, CTRL-CLI-005), the heartbeat payload fields (CTRL-HEARTBEAT-001), `isLoopback`, compose `cwd`, the entry guard, and the partial gaps in Key Finding 9.
9. Persist process pids if the process runtime should survive controller restarts (CTRL-CLI-006).
10. Annotate the compose healthcheck wiring (`docker-compose.yml:30-35`) for CTRL-CHECK-003 in a deployment pass.
