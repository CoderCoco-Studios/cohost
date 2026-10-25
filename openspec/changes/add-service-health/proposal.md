## Why

Nothing in cohost reports whether a service is alive. Only redis and postgres have compose healthchecks, only voice and dashboard expose `/health`, and crash loops (`chat` without `TWITCH_CHANNEL`, `ears` without `DISCORD_TOKEN`, under `restart: unless-stopped`) are invisible. The control-plane plan (docs/plans/control-plane.md, gaps G1, G2, G6) needs a machine-readable health contract before any lifecycle control can be built on it.

## What Changes

- New bus event `service.heartbeat` carried on a **separate capped stream `cohost:health`** (MAXLEN ~1000), not `cohost:events`.
- `@cohost/bus` gains the health stream constant, `publishHealth` / `tailHealth` / `recentHealth`, and a `startHeartbeat(bus, {service, version, mode, deps, getState})` helper returning `{ready(), degraded(), stop()}`, wired into `onShutdown`.
- All 10 services (chat, salience, affect, memory, cortex, voice, avatar, eyes, ears, dashboard) publish heartbeats: `starting` on boot, `ready`, every `intervalMs` (default 5000), on dependency change, and `stopping` on graceful shutdown.
- New package `packages/control` with a `HealthTracker` that derives `up | degraded | stale | down | unknown | crash-looping` per service from heartbeats (never published).
- Compose: app-service healthchecks (heartbeat-freshness based) so crash loops and hangs show in `docker compose ps`.
- Dashboard: `GET /services`, a `services` snapshot message on the existing `/ws`, a Services tab in the UI; heartbeats never appear in the event feed.
- Services that cannot reach an external dependency report `degraded` / `mode: "off"` in their heartbeat instead of being treated as exited. The behaviour change that makes them idle instead of exit/block is delivered by `add-isolated-backends`; this change only specifies how it is reported.

## Capabilities

### New Capabilities
- `service-health`: heartbeat contract semantics, `startHeartbeat` lifecycle, and `HealthTracker` derived states (`packages/control`).

### Modified Capabilities
- `bus`: add `service.heartbeat` to the catalogue, the `cohost:health` stream and its publish/tail/recent API.
- `dashboard`: `GET /services`, WS services snapshot, Services tab, heartbeat excluded from feed.
- `chat`, `salience`, `affect`, `memory`, `cortex`, `voice`, `avatar`, `eyes`, `ears`: each gains a `Heartbeat` requirement (service name, deps, mode).

## Bus events changed

- Added: `service.heartbeat` `{service, instance, pid, version, startedAt, state: starting|ready|degraded|stopping, deps: Record<string, ok|down|n/a>, mode: string, detail?, intervalMs}`.
- Unchanged: every existing event type and the `control` enum. No `service.lifecycle` or `control.target` here (see add-service-control).

## Cross-change dependencies

- `add-isolated-backends` (depends on this): relies on `mode` (`live|mock|off`) and `degraded` reporting defined here; it changes services so a missing dependency idles instead of exiting/blocking.
- `add-service-control` (depends on this): consumes `HealthTracker` and `packages/control`.
- This change is independently shippable: until isolated-backends lands, a service that exits on a missing dependency simply shows `down` / `crash-looping`.

## Out of scope

- Any start/stop/restart/lifecycle control, `Runtime` adapters, `service.lifecycle`, `control.target` (add-service-control).
- Mock/null backends and idle-instead-of-exit behaviour changes (add-isolated-backends).
- Auth on dashboard endpoints (plan G8) and `XINFO`-based fallbacks.

## Impact

- Code: `packages/bus/src/{index,events}.ts`, new `packages/control`, `services/*/src/index.ts` (one start call + deps updates each), `services/dashboard/src/{index,routes}.ts` and `public/index.html`, `docker-compose.yml`.
- Config: optional `health.interval_ms` (default 5000) read from env `HEARTBEAT_INTERVAL_MS` / config; no required changes.
- Load: ~10 services at 5 s is ~2 events/s on `cohost:health`; `cohost:events` retention is unaffected.
