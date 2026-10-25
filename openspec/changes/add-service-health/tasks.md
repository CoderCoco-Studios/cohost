## 1. Bus
- [x] 1.1 Add `service.heartbeat` zod schema to `packages/bus/src/events.ts` and to `EVENT_TYPES`
- [x] 1.2 Add `HEALTH_STREAM = "cohost:health"` (MAXLEN ~1000), `publishHealth`, `tailHealth`, `recentHealth`; make `publish("service.heartbeat")` throw
- [x] 1.3 Add `startHeartbeat` (starting/ready/degraded/stop, deps-change publish, shutdown hook, swallow publish errors)
- [x] 1.4 Tests in `packages/bus/test/` for stream routing, validation, ordering, helper timing, shutdown `stopping`, publish failure
- [x] 1.5 Make `Bus`/`FakeBus` in `packages/testing` support health publish/recent for tests

## 2. Control package (service-health)
- [x] 2.1 Scaffold `packages/control` (package.json via `pnpm`, tsconfig, add to `tsc -b` refs)
- [x] 2.2 Implement `HealthTracker` with injectable clock: unknown/up/degraded/stale/down, `starting` -> degraded
- [x] 2.3 Add crash-loop detection (3 distinct `startedAt` in 60 s) and `restarts` count
- [x] 2.4 Implement snapshot including unseen known services as `unknown`
- [x] 2.5 Tests in `packages/control/test/` covering every scenario in specs/service-health
- [x] 2.6 Add `healthcheck` CLI (`dist/healthcheck.js <service>`) with test for fresh/silent/stopping

## 3. Wire services (one task each; add test under `services/<svc>/test/`)
- [x] 3.1 chat: heartbeat, `mode off` when no `TWITCH_CHANNEL`
- [x] 3.2 salience: heartbeat
- [x] 3.3 affect: heartbeat
- [x] 3.4 memory: heartbeat with postgres/ollama deps
- [x] 3.5 cortex: heartbeat with llm dep
- [x] 3.6 voice: heartbeat with kokoro dep
- [x] 3.7 avatar: heartbeat with driver dep, `off` for null driver
- [x] 3.8 eyes: heartbeat with obs/ollama deps, `off` when vision disabled
- [x] 3.9 ears: heartbeat with discord/stt deps, `off` without `DISCORD_TOKEN`
- [x] 3.10 dashboard: heartbeat

## 4. Dashboard
- [x] 4.1 Instantiate `HealthTracker` fed by `tailHealth` seeded from `recentHealth`
- [x] 4.2 Add `GET /services`; test in `services/dashboard/test/`
- [x] 4.3 Push `services` WS message on connect, on change, and 1 s staleness tick; test
- [x] 4.4 Drop `service.heartbeat` from feed and `recent(60)` replay; test
- [x] 4.5 Services tab in `public/index.html`

## 5. Compose and docs
- [ ] 5.1 Add heartbeat-freshness healthchecks to all app services in `docker-compose.yml`
- [ ] 5.2 Document `HEARTBEAT_INTERVAL_MS` and the Services tab in README
- [ ] 5.3 Run `pnpm test` and `openspec validate add-service-health`
