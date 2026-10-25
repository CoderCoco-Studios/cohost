## 1. Bus
- [x] 1.1 Add `service.heartbeat` zod schema to `packages/bus/src/events.ts` and to `EVENT_TYPES`
- [x] 1.2 Add `HEALTH_STREAM = "cohost:health"` (MAXLEN ~1000), `publishHealth`, `tailHealth`, `recentHealth`; make `publish("service.heartbeat")` throw
- [x] 1.3 Add `startHeartbeat` (starting/ready/degraded/stop, deps-change publish, shutdown hook, swallow publish errors)
- [x] 1.4 Tests in `packages/bus/test/` for stream routing, validation, ordering, helper timing, shutdown `stopping`, publish failure
- [x] 1.5 Make `Bus`/`FakeBus` in `packages/testing` support health publish/recent for tests

## 2. Control package (service-health)
- [ ] 2.1 Scaffold `packages/control` (package.json via `pnpm`, tsconfig, add to `tsc -b` refs)
- [ ] 2.2 Implement `HealthTracker` with injectable clock: unknown/up/degraded/stale/down, `starting` -> degraded
- [ ] 2.3 Add crash-loop detection (3 distinct `startedAt` in 60 s) and `restarts` count
- [ ] 2.4 Implement snapshot including unseen known services as `unknown`
- [ ] 2.5 Tests in `packages/control/test/` covering every scenario in specs/service-health
- [ ] 2.6 Add `healthcheck` CLI (`dist/healthcheck.js <service>`) with test for fresh/silent/stopping

## 3. Wire services (one task each; add test under `services/<svc>/test/`)
- [ ] 3.1 chat: heartbeat, `mode off` when no `TWITCH_CHANNEL`
- [ ] 3.2 salience: heartbeat
- [ ] 3.3 affect: heartbeat
- [ ] 3.4 memory: heartbeat with postgres/ollama deps
- [ ] 3.5 cortex: heartbeat with llm dep
- [ ] 3.6 voice: heartbeat with kokoro dep
- [ ] 3.7 avatar: heartbeat with driver dep, `off` for null driver
- [ ] 3.8 eyes: heartbeat with obs/ollama deps, `off` when vision disabled
- [ ] 3.9 ears: heartbeat with discord/stt deps, `off` without `DISCORD_TOKEN`
- [ ] 3.10 dashboard: heartbeat

## 4. Dashboard
- [ ] 4.1 Instantiate `HealthTracker` fed by `tailHealth` seeded from `recentHealth`
- [ ] 4.2 Add `GET /services`; test in `services/dashboard/test/`
- [ ] 4.3 Push `services` WS message on connect, on change, and 1 s staleness tick; test
- [ ] 4.4 Drop `service.heartbeat` from feed and `recent(60)` replay; test
- [ ] 4.5 Services tab in `public/index.html`

## 5. Compose and docs
- [ ] 5.1 Add heartbeat-freshness healthchecks to all app services in `docker-compose.yml`
- [ ] 5.2 Document `HEARTBEAT_INTERVAL_MS` and the Services tab in README
- [ ] 5.3 Run `pnpm test` and `openspec validate add-service-health`
