# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: live bus feed, controls, personality editor, services tab with gated start/stop/restart, test-input injection, and the browser audio sink.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited. Server side is well covered by tests; the browser page has no tests and carries most of the defects found (placeholder substitution, audio replay, unbounded queue).

## References

### HLD
- docs/high-level-design.md (System Design, operator: dashboard)

### LLD
- docs/intent/dashboard/dashboard-design.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (54 specs: 47 `[x]`, 7 `[ ]`)

### Tests
- services/dashboard/test/routes.test.ts
- services/dashboard/test/feed.test.ts
- services/dashboard/test/control.test.ts
- services/dashboard/test/inject.test.ts
- services/dashboard/test/uploads.test.ts

### Code
- services/dashboard/src/index.ts
- services/dashboard/src/routes.ts
- services/dashboard/src/feed.ts
- services/dashboard/src/control.ts
- services/dashboard/src/inject.ts
- services/dashboard/src/uploads.ts
- services/dashboard/src/health.ts
- services/dashboard/public/index.html
- services/dashboard/package.json, services/dashboard/tsconfig.json

### OpenSpec
- openspec/specs/dashboard/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/dashboard/spec.md
- openspec/changes/archive/2026-11-01-add-service-control/specs/dashboard/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/dashboard/spec.md

## Architecture

**Purpose:** Give the operator one place to watch the stack, steer it, and feed it test inputs, and let a browser (or OBS Browser Source) play the co-host's voice.

**Key Components:**
1. `index.ts` — wiring: bus, heartbeat, `HealthTracker`, `setupControl`, `UploadStore` + 60 s sweeper, HTTP server, `/ws` WebSocket server, shutdown.
2. `routes.ts` — `createDashboardHandler`: all HTTP routes, the bearer gate, the audio proxy, lifecycle body parsing and refusal mapping.
3. `feed.ts` — `createFeed`: shared `bus.tail`, 60-event backfill per client, health stream seeding/tailing, `services` pushes and the 1 s staleness tick.
4. `control.ts` — `setupControl`: reads `CONTROL_*`, builds `ServiceController` (from `@cohost/control`, owned by control-plane) with a `service.lifecycle` audit publisher.
5. `inject.ts` + `uploads.ts` — `/inject/*` and `/uploads/:id`; the bounded in-memory upload store.
6. `health.ts` — constant heartbeat spec (live, no deps).
7. `public/index.html` — single-file UI: feed, avatar preview, operator controls, personality editor, services tab, test-inputs panel, audio sink.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| HTTP routes | DASH-HTTP-001 to 009 | 8 | 0 | 1 |
| Audio proxy and sink | DASH-SINK-001 to 004 | 2 | 0 | 2 |
| WebSocket feed | DASH-FEED-001 to 006 | 6 | 0 | 0 |
| Control gating | DASH-CTRL-001 to 006 | 5 | 0 | 1 |
| Service lifecycle | DASH-SVC-001 to 004 | 4 | 0 | 0 |
| Test-input injection | DASH-INJ-001 to 007 | 7 | 0 | 0 |
| Upload store | DASH-UPL-001 to 003 | 3 | 0 | 0 |
| Web page | DASH-UI-001 to 014 | 11 | 0 | 3 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 |

**Summary:** 47 of 54 specs implemented; 0 deferred; 7 gaps. The 14 DASH-UI specs and DASH-HTTP-009 / DASH-FEED wiring in `index.ts` have no automated test.

## Key Findings

1. **`__COHOST_NAME__` replaced only once** — `routes.ts:46` uses `String.replace(string, string)`; the placeholder occurs at `public/index.html:6` (title) and `:54` (heading), so the heading shows the literal text. The test fixture has one occurrence (`test/routes.test.ts:22`). (DASH-HTTP-001)
2. **Backfill replays speech into the sink** — every WebSocket connect sends `recent(60)` (`feed.ts:37-40`); the page queues all `voice.utterance` events (`index.html:321`) and plays them if audio is on (always for `?sink=1`), also posting `voice.playing`/`voice.done` for old ids (`:142-143`). The page reconnects every 2 s (`:336`). (DASH-UI-013)
3. **Unbounded audio queue** — pushes happen while audio is disabled and nothing drains (`index.html:136, 139, 321`). (DASH-UI-014)
4. **Many routes stay open with control enabled** — `POST /sink`, `GET /personality`, `GET /services`, `GET /audio/*`, `/ws` and `GET /uploads/:id` (`routes.ts:50-71, 91-95, 110-115`). Only `/uploads` is deliberate per OpenSpec. `POST /sink` also treats any non-`playing` event as `done` (`routes.ts:112`). (DASH-CTRL-005, DASH-CTRL-006, DASH-SINK-003)
5. **Bus-level chat injection lacks `userId` and `mentionsCohost`** — `inject.ts:101-105`; mentions only register if downstream detection finds the name. The returned `id` matches no event (`:88`). `[inferred]` limitation of "skip perception".
6. **`brain.status` detail never shown** — `index.html:300` reads `d.detail`; the schema field is `notes` (`packages/bus/src/events.ts:59-65`). (DASH-UI-003)
7. **Unbounded request bodies and unhandled feed promises** — `body()` has no cap (`routes.ts:142-149`); `feed.start()`/`onConnection` are `void`-ed (`index.ts:45-47`).
8. **OpenSpec drift** — default `VOICE_URL` (spec `http://voice:8700`, code loopback, `config/src/index.ts:163`); the `isolated` lifecycle body field is implemented but unspecified; the feed also sends a leading `services` message not mentioned in the baseline spec. (DASH-SINK-004)

## Work Required

### Must Fix
1. Replace all occurrences of `__COHOST_NAME__` (`replaceAll` or regex) and extend the test fixture to two occurrences (DASH-HTTP-001).
2. Stop replaying history into the audio sink: ignore `voice.utterance` events that arrive in the backfill (or older than a threshold) (DASH-UI-013).

### Should Fix
3. Bound or disable the audio queue while audio is off (DASH-UI-014).
4. Decide gating for `POST /sink` (and whether `/ws`, `GET /personality` should be gated) and update OpenSpec accordingly (DASH-CTRL-005, DASH-CTRL-006); validate `event` in `POST /sink` (DASH-SINK-003).
5. Render `notes` for `brain.status` (DASH-UI-003).
6. Cap body size for `/control`, `/personality`, `/sink` and lifecycle requests; catch rejections in `feed.start` / `onConnection`.

### Nice to Have
7. Refresh OpenSpec: `VOICE_URL` default, `isolated` body field, `services` message on connect (DASH-SINK-004).
8. Add tests for the `/ws` wiring, page JavaScript (audio sink, reconnect, token prompt), and text-body 413.
9. Escape quotes in `esc()` before using it inside attributes; remove the duplicated CSS comment at `index.html:41`; add pause/resume UI (DASH-HTTP-008).
