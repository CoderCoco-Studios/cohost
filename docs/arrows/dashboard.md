# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: live bus feed, controls, personality editor, services tab with gated start/stop/restart, stack panel, test-input injection, mouth routing, the Viewers page, and the browser audio sink. It runs as a standalone host process, outside Docker Compose, on two listeners.

## Status

**AUDITED.** 118 specs: 118 implemented, 0 deferred, 0 gaps. The server side and the page script (run under a stub DOM in `services/dashboard/test/page.test.ts`) are covered by tests; the specs with no test annotation are listed under Coverage notes.

Orientation:

- Design: LLD § Host process and stack control (starting it, listeners, stack routes), Feed and health, Test-input injection and uploads, Viewers page; [decision doc](../intent/dashboard/decisions/standalone-dashboard.md).
- Cross-segment edges: stack and lifecycle actions are control-plane's (CTRL-STACK-*, CTRL-LOCK-*), uploads are read by eyes and ears (SHARED-INJ-005), the settings editor and test drawer are module-contract's (MOD-CFG-*, MOD-TEST-*), and `POST /mouth/routing` feeds mouth (MOUTH-LIVE-*).

## References

### HLD
- docs/high-level-design.md (Segments table, operator: dashboard; Cross-cutting: audio sink arbitration, service health and control, test injection)

### LLD
- docs/intent/dashboard/dashboard-design.md
- docs/intent/dashboard/decisions/standalone-dashboard.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (118 specs, prefix `DASH`: 118 `[x]`, 0 `[ ]`, 0 `[D]`; DASH-CTRL-006 is retired and DASH-INJ-007 is a retired placeholder, neither number is reused)

### Tests
`@spec DASH-` annotations are in:
- services/dashboard/test/body.test.ts
- services/dashboard/test/control.test.ts
- services/dashboard/test/feed.test.ts
- services/dashboard/test/host.test.ts
- services/dashboard/test/inject-event.test.ts
- services/dashboard/test/inject.test.ts
- services/dashboard/test/page.test.ts (the inline script of `public/index.html` run in a `node:vm` context with a stub DOM)
- services/dashboard/test/routes.test.ts
- services/dashboard/test/routing.test.ts
- services/dashboard/test/service.test.ts
- services/dashboard/test/stack-lock.test.ts
- services/dashboard/test/stack-rebuild.test.ts
- services/dashboard/test/stack.test.ts
- services/dashboard/test/unit-contract.test.ts
- services/dashboard/test/uploads.test.ts
- services/dashboard/test/viewers.test.ts
- packages/control/test/derived-lists.test.ts
- Out of segment, cited only: packages/config/test/config.test.ts (DASH-SINK-004 via `urls.voice()`)

### Code
`@spec DASH-` annotations are in:
- services/dashboard/src/body.ts
- services/dashboard/src/control.ts
- services/dashboard/src/feed.ts
- services/dashboard/src/health.ts
- services/dashboard/src/host.ts
- services/dashboard/src/index.ts
- services/dashboard/src/inject.ts
- services/dashboard/src/routes.ts
- services/dashboard/src/routing.ts
- services/dashboard/src/service.ts
- services/dashboard/src/stack.ts
- services/dashboard/src/uploads.ts
- services/dashboard/src/viewers.ts
- services/dashboard/public/index.html
- services/dashboard/package.json, services/dashboard/tsconfig.json (no annotations)

## Architecture

**Purpose:** Give the operator one place to watch the stack, steer it, and feed it test inputs, and let a browser (or OBS Browser Source) play the co-host's voice.

**Key Components:**
1. `index.ts` — one call to the shared bootstrap `runService`; `service.ts` supplies `main`: tracker, control setup, upload limits, the stack service, the feed, both listeners and the shutdown step.
2. `host.ts` — the full-surface and LAN listeners, the LAN allow-list, the Host and Origin checks, port resolution.
3. `routes.ts` — `createDashboardHandler`: all HTTP routes, the bearer gate, the audio proxy, lifecycle body parsing and refusal mapping; `body.ts` is the shared body reader.
4. `feed.ts` — `createFeed`: shared `bus.tail`, 60-event backfill per client, health stream seeding and tailing, `services` and `stack` pushes, the 1 s staleness tick, bus reachability.
5. `stack.ts` — `StackService`: the stack probe, the one action slot, the last result.
6. `control.ts` — `setupControl`: reads `CONTROL_*` and `DASHBOARD_HOST`, builds `ServiceController` (from `@cohost/control`) with a `service.lifecycle` audit publisher.
7. `inject.ts` + `uploads.ts` — `/inject/*`; the upload size caps and TTL, with the bytes written to Redis through `Bus.putUpload`.
8. `routing.ts`, `settings.ts`, `viewers.ts` — `POST /mouth/routing`, the settings editor routes, the `/viewers` routes.
9. `health.ts` — constant heartbeat spec (live, no deps).
10. `public/index.html` — single-file UI: feed, avatar preview, operator controls, personality editor, Services tab with stack panel, test-inputs panel, Viewers tab, audio sink.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| HTTP routes | DASH-HTTP-001 to DASH-HTTP-017 | 17 | 0 | 0 |
| Audio proxy and sink | DASH-SINK-001 to DASH-SINK-004 | 4 | 0 | 0 |
| WebSocket feed | DASH-FEED-001 to DASH-FEED-010 | 10 | 0 | 0 |
| Control gating | DASH-CTRL-001 to DASH-CTRL-008 (006 retired) | 7 | 0 | 0 |
| Service lifecycle | DASH-SVC-001 to DASH-SVC-004 | 4 | 0 | 0 |
| Mouth routing | DASH-ROUTE-001 to DASH-ROUTE-003 | 3 | 0 | 0 |
| Test-input injection | DASH-INJ-001 to DASH-INJ-009 | 9 | 0 | 0 |
| Upload store (Redis) | DASH-UPL-001 to DASH-UPL-003 | 3 | 0 | 0 |
| Web page | DASH-UI-001 to DASH-UI-023 | 23 | 0 | 0 |
| Host process and listeners | DASH-HOST-001 to DASH-HOST-007 | 7 | 0 | 0 |
| Stack control | DASH-STACK-001 to DASH-STACK-009 | 9 | 0 | 0 |
| Viewers page | DASH-VIEWERS-001 to DASH-VIEWERS-021 | 21 | 0 | 0 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 |

**Summary:** 118 of 118 specs implemented; 0 deferred; 0 open. `node scripts/lid-check.mjs` finds no reverse orphans.

## Coverage notes

Implemented without a test `@spec` annotation: DASH-SINK-004 (its behaviour is `urls.voice()`, tested in `packages/config/test/config.test.ts`), DASH-CTRL-008 (the `CONTROL_ADVANCED` startup warning), DASH-UI-004, DASH-UI-005, DASH-UI-007, DASH-UI-009, DASH-UI-010 and DASH-UI-011. The page tests cover parts of DASH-UI-005 (mute, personality save, say) and DASH-UI-011 (sink mode plays without a click); the rest is verified by reading the page script. Manual checks for what a stub DOM cannot cover are in `docs/TESTING.md`.
