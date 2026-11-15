# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: live bus feed, controls, personality editor, services tab with gated start/stop/restart, stack panel, test-input injection, mouth routing, the Viewers page, the browser audio sink, and the built docs site served at `/cohost/`. It runs as a standalone host process, outside Docker Compose, on two listeners.

## Status

**AUDITED** (audit of 2026-11-14; the docs-site serving specs DASH-DOCS-001 to 014, DASH-UI-024, DASH-UI-025 and DASH-CTRL-005's docs entry were added after it and are not covered by it). 135 specs: 135 implemented, 0 deferred, 0 gaps. The docs route is implemented in `services/dashboard/src/docs.ts` and tested in `services/dashboard/test/docs.test.ts`, `host-docs.test.ts` and `page-docs.test.ts`, and was observed end to end on 2026-11-15 (Verification log). DASH-DOCS-013 and 014 are docs-page content with no test; they were verified by reading the pages. The specs with no test annotation are listed under Coverage notes.

Orientation:

- Design: LLD § Host process and stack control (starting it, listeners, stack routes), Docs site, Feed and health, Test-input injection and uploads, Viewers page; [decision doc](../intent/dashboard/decisions/standalone-dashboard.md).
- Cross-segment edges: stack and lifecycle actions are control-plane's (CTRL-STACK-*, CTRL-LOCK-*), uploads are read by eyes and ears (SHARED-INJ-005), the settings editor and test drawer are module-contract's (MOD-CFG-*, MOD-TEST-*), and `POST /mouth/routing` feeds mouth (MOUTH-LIVE-*). The served docs are docs-site's build (DOCS-*), built at each start by deployment's `pnpm dashboard` (DEPLOY-HOST-001); docs-site's live health component reads `GET /services` and keeps the `#the-states` anchor the Services tab links (DOCS-LIVE-*).

## References

### HLD
- docs/high-level-design.md (Segments table, operator: dashboard; Cross-cutting: audio sink arbitration, service health and control, test injection)

### LLD
- docs/intent/dashboard/dashboard-design.md
- docs/intent/dashboard/decisions/standalone-dashboard.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (135 specs, prefix `DASH`: 135 `[x]`, 0 `[ ]`, 0 `[D]`; DASH-CTRL-006 is retired and DASH-INJ-007 is a retired placeholder, neither number is reused)

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
10. `public/index.html` — single-file UI: feed, avatar preview, operator controls, personality editor, Services tab with stack panel, test-inputs panel, Viewers tab, audio sink, links into the docs.
11. `docs.ts` (planned) — `handleDocs`: serves `docs/.vitepress/dist` under `/cohost/` on the full surface (resolution, path guard, MIME types, caching, not-built page); tests in `test/docs.test.ts`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| HTTP routes | DASH-HTTP-001 to DASH-HTTP-017 | 17 | 0 | 0 |
| Audio proxy and sink | DASH-SINK-001 to DASH-SINK-004 | 4 | 0 | 0 |
| WebSocket feed | DASH-FEED-001 to DASH-FEED-010 | 10 | 0 | 0 |
| Control gating | DASH-CTRL-001 to DASH-CTRL-008 (006 retired) | 6 | 0 | 1 |
| Service lifecycle | DASH-SVC-001 to DASH-SVC-004 | 4 | 0 | 0 |
| Mouth routing | DASH-ROUTE-001 to DASH-ROUTE-003 | 3 | 0 | 0 |
| Test-input injection | DASH-INJ-001 to DASH-INJ-010 | 10 | 0 | 0 |
| Upload store (Redis) | DASH-UPL-001 to DASH-UPL-003 | 3 | 0 | 0 |
| Web page | DASH-UI-001 to DASH-UI-025 | 23 | 0 | 2 |
| Host process and listeners | DASH-HOST-001 to DASH-HOST-007 | 7 | 0 | 0 |
| Stack control | DASH-STACK-001 to DASH-STACK-009 | 9 | 0 | 0 |
| Docs site | DASH-DOCS-001 to DASH-DOCS-014 | 0 | 0 | 14 |
| Viewers page | DASH-VIEWERS-001 to DASH-VIEWERS-021 | 21 | 0 | 0 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 |

**Summary:** 135 of 135 specs implemented; 0 deferred; 0 open (the docs-serving specs added after the audit, DASH-DOCS-001 to 014, DASH-UI-024, 025 and DASH-CTRL-005's docs entry, are implemented and not covered by it). `node scripts/lid-check.mjs` finds no reverse orphans.

## Coverage notes

Implemented without a test `@spec` annotation: DASH-SINK-004 (its behaviour is `urls.voice()`, tested in `packages/config/test/config.test.ts`). Manual checks for what a stub DOM cannot cover are on the docs site's Single-PC checklist (`docs/advanced/testing/single-pc.md`).
