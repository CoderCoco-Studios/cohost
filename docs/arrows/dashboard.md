# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: the React UI (live feed, controls, services screen with gated start/stop/restart and the stack card, test-input injection, the Viewers screen, the schema-driven Settings screen with the personality editor, the Access dialog, the browser audio sink), mouth routing, the secret write and pick-list routes, and the built docs site served at `/cohost/`. It runs as a standalone host process, outside Docker Compose, on two listeners.

## Status

**PARTIAL.** 233 specs: 108 implemented, 125 gaps, 0 deferred. The API, feed, stack, injection, upload, host, docs-serving and health specs (HTTP, SINK, FEED, SVC, ROUTE, INJ, UPL, STACK, HEALTH) are implemented and were audited on 2026-11-14 (the docs-serving specs DASH-DOCS-001 to 014, DASH-UI-024 and DASH-UI-025 were added after that audit and observed end to end on 2026-11-15; DASH-DOCS-013 and 014 are docs-page content with no test). The UI is specified and not yet built: the React UI, theme, access dialog, navigation, accessibility and settings screen (DASH-UI changed or added, DASH-VIEWERS-010 to 023, DASH-ACC, DASH-NAV, DASH-THEME, DASH-A11Y, DASH-SET, DASH-BUILD), the secret write and pick lists (DASH-SECRET, DASH-OPT), the route and allow-list edits they need (DASH-HTTP-001, DASH-CTRL-001, DASH-CTRL-005, DASH-HOST-002, DASH-DOCS-013, 015, 016), the ports and upload limits read from `config.yaml` and the container overrides in the stack snapshot are implemented (DASH-HTTP-009, DASH-HOST-001, DASH-UPL-001, -002, DASH-STACK-010); DASH-FEED-008, the `stack` message on `/ws`, is implemented too. The running page is the single static `public/index.html` until the UI lands; the specs it carries over unchanged keep `[x]`. Specs with no test annotation are listed under Coverage notes.

Orientation:

- Design: LLD § The UI (technology, build and serving, theme tokens, structure, screens, access, settings screen, tests), Failure and edge behaviour, Settings routes (secret write, pick lists), Host process and stack control (starting it, listeners, stack routes), Docs site, Feed and health, Test-input injection and uploads, Viewers page; decision docs: [standalone dashboard](../intent/dashboard/decisions/standalone-dashboard.md), [UI rebuild](../intent/dashboard/decisions/dashboard-revamp.md) (options, selections and the audit of the old page).
- Cross-segment edges: stack and lifecycle actions are control-plane's (CTRL-STACK-*, CTRL-LOCK-*), uploads are read by eyes and ears (SHARED-INJ-005), the settings editor's routes, the manifest's pause and test descriptors are module-contract's (MOD-CFG-*, MOD-PAUSE-*, MOD-TEST-*), and the settings screen's presentation metadata and `config/secrets.yaml` are the config segment's, and `POST /mouth/routing` feeds mouth (MOUTH-LIVE-*). The served docs are docs-site's build (DOCS-*), built at each start by deployment's `pnpm dashboard` (DEPLOY-HOST-001); docs-site's live health component reads `GET /services` and keeps the `#the-states` anchor the Services tab links (DOCS-LIVE-*).

## References

### HLD
- docs/high-level-design.md (Segments table, operator: dashboard; Cross-cutting: audio sink arbitration, service health and control, test injection)

### LLD
- docs/intent/dashboard/dashboard-design.md
- docs/intent/dashboard/decisions/standalone-dashboard.md
- docs/intent/dashboard/decisions/dashboard-revamp.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (233 specs, prefix `DASH`: 108 `[x]`, 125 `[ ]`, 0 `[D]`; DASH-CTRL-006 is retired, and DASH-INJ-007 and DASH-UI-016 are retired placeholders, no number is reused)

### Tests
`@spec DASH-` annotations are in:
- services/dashboard/test/body.test.ts
- services/dashboard/test/control.test.ts
- services/dashboard/test/feed.test.ts
- services/dashboard/test/host.test.ts
- services/dashboard/test/inject-event.test.ts
- services/dashboard/test/inject.test.ts
- services/dashboard/test/page.test.ts, page-docs.test.ts, page-connector.test.ts (the inline script of `public/index.html` run in a `node:vm` context with a stub DOM; replaced by `services/dashboard/test/ui/*.test.tsx` on `happy-dom` and Testing Library when the UI lands)
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
- services/dashboard/public/index.html (until the UI lands)
- services/dashboard/ui/ (planned: the React app, `vite.config.ts`, `tsconfig.json`)
- services/dashboard/src/secrets.ts, options.ts (planned: the secret write and the pick lists)
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
10. `ui/` (planned; today `public/index.html`) — the React app built by Vite into `dist-ui/`: shell (header, hash routes, shortcuts, dialogs), Live, Services, Viewers and Settings screens, the Access dialog, the audio sink and sink view, the theme tokens; served through the static-file helper it shares with `docs.ts`.
12. `secrets.ts`, `options.ts` (planned) — `PUT /secrets/:path` and `GET /options/voices`, `GET /options/models`.
11. `docs.ts` (planned) — `handleDocs`: serves `docs/.vitepress/dist` under `/cohost/` on the full surface (resolution, path guard, MIME types, caching, not-built page); tests in `test/docs.test.ts`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| HTTP routes | DASH-HTTP-001 to DASH-HTTP-017 | 15 | 0 | 2 |
| Audio proxy and sink | DASH-SINK-001 to DASH-SINK-004 | 4 | 0 | 0 |
| WebSocket feed | DASH-FEED-001 to DASH-FEED-010 | 9 | 0 | 1 |
| Control gating | DASH-CTRL-001 to DASH-CTRL-008 (006 retired) | 5 | 0 | 2 |
| Service lifecycle | DASH-SVC-001 to DASH-SVC-004 | 4 | 0 | 0 |
| Mouth routing | DASH-ROUTE-001 to DASH-ROUTE-003 | 3 | 0 | 0 |
| Test-input injection | DASH-INJ-001 to DASH-INJ-010 | 10 | 0 | 0 |
| Upload store (Redis) | DASH-UPL-001 to DASH-UPL-003 | 1 | 0 | 2 |
| Web page | DASH-UI-001 to DASH-UI-033 (016 retired) | 11 | 0 | 22 |
| Host process and listeners | DASH-HOST-001 to DASH-HOST-007 | 4 | 0 | 3 |
| Stack control | DASH-STACK-001 to DASH-STACK-010 | 9 | 0 | 1 |
| Docs site | DASH-DOCS-001 to DASH-DOCS-016 | 13 | 0 | 3 |
| Viewers page | DASH-VIEWERS-001 to DASH-VIEWERS-023 | 12 | 0 | 11 |
| Build and serving | DASH-BUILD-001 to DASH-BUILD-008 | 0 | 0 | 8 |
| Secret write | DASH-SECRET-001 to DASH-SECRET-010 | 0 | 0 | 10 |
| Pick lists | DASH-OPT-001 to DASH-OPT-004 | 0 | 0 | 4 |
| Access dialog | DASH-ACC-001 to DASH-ACC-012 | 0 | 0 | 12 |
| Navigation and shortcuts | DASH-NAV-001 to DASH-NAV-004 | 0 | 0 | 4 |
| Theme | DASH-THEME-001 to DASH-THEME-006 | 0 | 0 | 6 |
| Accessibility and layout | DASH-A11Y-001 to DASH-A11Y-008 | 0 | 0 | 8 |
| Settings screen | DASH-SET-001 to DASH-SET-027 | 0 | 0 | 27 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 |

**Summary:** 108 of 233 specs implemented; 0 deferred; 125 open: the UI, the secret write and pick lists, and the route edits they need. `node scripts/lid-check.mjs` finds no reverse orphans.

## Coverage notes

Implemented without a test `@spec` annotation: DASH-SINK-004 (its behaviour is `urls.voice()`, tested in `packages/config/test/config.test.ts`). Manual checks for what an emulated DOM cannot cover (autoplay, OBS, 320 px layout, keyboard and screen-reader passes) are listed in the LLD's Manual verification and on the docs site's Single-PC checklist (`docs/advanced/testing/single-pc.md`). The UI's test annotations are `services/dashboard/test/ui/*.test.tsx`, added with each spec that lands. DASH-UI-024 and DASH-UI-025 are tested in `page-docs.test.ts` until the UI replaces the page.
