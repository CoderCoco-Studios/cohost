## Why

The owner wants one app to monitor and start/stop cohost services (docs/plans/control-plane.md). Monitoring is covered by the sibling change `add-service-health`; this change is the CONTROL half: a `Runtime` abstraction that can start/stop/restart services under docker compose or as host `pnpm` processes, exposed through the dashboard behind strict gating, with an audit event on the bus.

## What Changes

- New capability `service-control` in `packages/control`: `Runtime` interface with `compose` (docker compose CLI) and `process` (fixed-argv `pnpm --filter @cohost/<svc> dev|start`) adapters, start/stop/restart orchestration, consumer-group fresh/resume handling, safety gating.
- **Dependency:** `packages/control` is created by sibling change `add-service-health` (`ServiceRegistry`, `HealthTracker`). This change must land after it and EXTENDS the registry manifest with per-service runtime info (compose service name, pnpm filter, consumer groups, default start mode, `infra`/`self` flags). If health has not landed, the package scaffold task here must be done first and reconciled.
- Dashboard: `POST /services/:id/start|stop|restart`, token gate (`CONTROL_ENABLED=1`, required `CONTROL_TOKEN` bearer), loopback bind default with `CONTROL_BIND` override, UI controls with confirmation. **Behaviour change:** existing unauthenticated `POST /control` (and `PUT /personality`) require the bearer token when control is enabled. Default (disabled) behaviour is unchanged.
- Bus: new `service.lifecycle` audit event; `control` event gains optional `target` and new cmds `pause` / `resume`.
- cortex, salience, affect: honour `control.target` and `pause`/`resume` in-process (idle without exiting).
- Final phase: optional `cohostctl` CLI as a second client of `packages/control`.

## Capabilities affected

- `service-control` (new), `dashboard` (modified), `bus` (modified), `cortex`, `salience`, `affect` (added requirement). Registry manifest from `add-service-health` is extended (not a separate spec; recorded in service-control).

## Bus events changed

- ADDED `service.lifecycle` `{service, action: "start"|"stop"|"restart", by, ok, detail?}`.
- MODIFIED `control`: `target?: string` (undefined = all, back-compat); `cmd` gains `pause`, `resume`.
- Process start/stop itself is NOT a bus event; the bus stays unprivileged.

## Out of scope

- Mock/stub backends and isolation presets (`add-isolated-backends`).
- Heartbeats, health state, monitor UI (`add-service-health`).
- Remote/multi-host orchestration, Kubernetes, auth beyond a static bearer token, log aggregation, Prometheus.
- Docker Engine API adapter (CLI only); pause/resume in voice and avatar (restart them via the runtime; they do not subscribe to `control` today).

## Impact

- Code: `packages/control` (new modules), `packages/bus/src/events.ts`, `services/dashboard/src/{index,routes}.ts` and `public/index.html`, `services/{cortex,salience,affect}/src`, optional `apps/ctl` or `packages/control` bin.
- Docs: README ops section on host-run vs docker-socket opt-in.
- Config/env: `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_BIND`, `CONTROL_RUNTIME` (`compose`|`process`), `CONTROL_ADVANCED` (infra).
