## Context

`cohost:events` is a single stream, `MAXLEN ~20000`, and `decode` silently drops unknown/invalid events, so old services tolerate new types. Services subscribe through per-service consumer groups; `dashboard` uses `tail` and `recent(60)`. All services already use `onShutdown`. See proposal.md for motivation and docs/plans/control-plane.md sections 2, 3, 6, 8.

## Goals / Non-Goals

**Goals:** one uniform, machine-readable liveness/readiness signal per service; heartbeat integration that costs a service about 5 lines; correct derived state (including "never seen", "crash-looping"); zero impact on domain-event retention.

**Non-Goals:** controlling processes, mock backends, auth, persisting health history beyond the capped stream.

## Decisions

### D1. Separate stream `cohost:health` (MAXLEN ~1000)
10 services at 5 s is ~2 events/s; on `cohost:events` that shrinks ~3 h of history to ~2.5 h and pollutes `recent`, the dashboard feed and every consumer group's read loop.
- Alternative: same stream plus filtering. Rejected: eviction of domain events cannot be filtered away, and every group would read and ack heartbeats.
- Consequence: `Bus.publish("service.heartbeat", ...)` is rejected; use `publishHealth`. The event is still registered in `EventPayloads` so `decode` and zod validation are shared. 1000 entries is ~8 min at 2/s, ample for `HealthTracker` seeding and crash-loop windows (60 s).

### D2. Heartbeats in-bus rather than `XINFO GROUPS/CONSUMERS`
- Alternative: infer liveness from consumer idle time and pending counts with no code change. Rejected as primary: chat, eyes and dashboard have no group, a quiet service legitimately idles, and it carries no readiness, deps, mode or `startedAt` (needed for crash-loop detection).
- It stays a possible future fallback; not built here.

### D3. Derived state lives in `HealthTracker`, not on the wire
Services only report facts (`state`, `deps`, `intervalMs`, `startedAt`); thresholds are the monitor's. Rules, with `intervalMs` taken from the latest heartbeat and `age = now - last receive time`:
- `unknown`: never seen (a pre-heartbeat or not-yet-started service is not `down`).
- `down`: last state `stopping`, or `age > 10 x intervalMs`.
- `stale`: `age > 3 x intervalMs` (and not down).
- `crash-looping`: at least 3 distinct `startedAt` values within 60 s; takes precedence over `up`/`degraded`/`stale`/`down`.
- `degraded`: fresh and (`state=degraded`, or any dep `down`).
- `up`: fresh and `state=ready` with no dep `down`.
- A fresh `starting` heartbeat maps to `degraded` (no extra visible state); it becomes `up` on the first `ready`.
Receive time is the tracker's clock (not the publisher's `ts`) so clock skew between containers is irrelevant; the tracker accepts an injectable clock for tests.

### D4. `startHeartbeat` helper in packages/bus
`startHeartbeat(bus, {service, version, mode, deps, getState, intervalMs?})` publishes `starting` immediately, then on interval; `ready()` / `degraded(detail?)` switch state and publish immediately; `deps` is a getter so changes are detected each tick and published at once; `stop()` publishes `stopping` and clears the timer. It registers itself with the shutdown path so `stopping` is sent before `bus.stop()`. `instance` is `bus.consumer`; `startedAt` is captured once per process. Publish failures are logged and never throw into the service.

### D5. Compose healthcheck is heartbeat-freshness, not HTTP
Each app service runs a tiny node check (`node packages/control/dist/healthcheck.js <service>`) that reads `recentHealth` for that service and exits 0 when the newest heartbeat is under 3 x intervalMs old and not `stopping`. Uniform across the 8 services with no HTTP port. `dashboard` and `voice` keep `/health` but use the same check. Alternative: per-service HTTP ports; rejected as 8 new surfaces.

### D6. Dashboard integration
The dashboard owns one `HealthTracker` fed by `tailHealth` (seeded from `recentHealth`). It exposes `GET /services` (JSON) and pushes `{type:"services", services:[...]}` over the existing `/ws` when any derived state changes, plus a periodic 1 s tick so staleness transitions are pushed. The dashboard lists itself via its own heartbeat.

## Risks / Trade-offs

- [Tracker only sees ~8 min of history after a dashboard restart] -> services re-heartbeat every 5 s so convergence takes seconds; services unseen so far show `unknown`.
- [Mixed rollout: some services without heartbeat] -> `unknown`, not `down`.
- [Publishing a heartbeat on every dep change could spam if a dep flaps] -> at most one extra publish per tick-interval minimum spacing of 1 s.
- [Redis down: nothing can heartbeat] -> all services go `stale` then `down` in the monitor; the dashboard itself also cannot read Redis, so this is surfaced as a dashboard connection error, not hidden.

## Migration Plan

Additive. Deploy bus + control package first, then services (any order), then dashboard UI. Rollback: revert; old services ignore the new stream entirely.
