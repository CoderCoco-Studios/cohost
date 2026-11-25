# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: the React UI (live feed, controls, services screen with gated start/stop/restart and the stack card, test-input injection, the Viewers screen, the schema-driven Settings screen with the personality editor, the Access dialog, the browser audio sink), mouth routing, the secret write and pick-list routes, and the built docs site served at `/cohost/`. It runs as a standalone host process, outside Docker Compose, on two listeners.

## Status

**MAPPED.** 427 specs: 416 implemented, 11 gaps, 0 deferred. The gaps are the renderer page specs that need a real browser or a GPU (DASH-AVP-006, -007, -008, -016, -017, -018, -019, -025, -031, -034, -037, owned by #218 for the manual check). The renderer page (DASH-AVP-003 to 040) was built under issue #218 in `services/dashboard/ui/src/avatar/`. The avatar relay (DASH-AVR-001 to 021 and 030 to 035, with the `/avatar` page and `GET /avatar/renderer`, DASH-AVP-001 and 002, and the relay's share of DASH-HOST-002, DASH-CTRL-005, DASH-HTTP-010 and DASH-HTTP-016) was built under issue #217. The API, feed, stack, injection, upload, host, docs-serving and health specs (HTTP, SINK, FEED, SVC, ROUTE, INJ, UPL, STACK, HEALTH, DOCS) were audited on 2026-11-14; the React UI specs (DASH-UI, DASH-VIEWERS-010 to 023, DASH-ACC, DASH-NAV, DASH-THEME, DASH-A11Y, DASH-SET, DASH-BUILD), the secret write and pick lists (DASH-SECRET, DASH-OPT) and the route and allow-list edits they needed (DASH-HTTP-001, DASH-CTRL-001, DASH-CTRL-005, DASH-HOST-002, DASH-HOST-008 to DASH-HOST-010) are implemented and tested under `services/dashboard/test/ui/` and `services/dashboard/test/`, and were not covered by the 2026-11-14 audit. DASH-DOCS-013, 014, 015 and 016 are docs-page content with no test: the docs build (`mise run docs:build`) checks the pages' links and facts, and the statements were read against the code. Specs with no test annotation are listed under Coverage notes. An audit pass is the next step: the specs are written and implemented, not yet audited against the code; the status moves to AUDITED when it has run.

**Egress marks.** `GET /egress` answers the engine and chat-model destinations of the saved config (DASH-EGR-001 to 004), the Services screen marks the rows that leave the LAN and the Settings screen repeats the note beside the engine keys (DASH-UI-037, DASH-SET-034); `GET /options/voices` is a Kokoro list only (DASH-OPT-001, DASH-OPT-005).

Orientation:

- Design: LLD § The UI (technology, build and serving, theme tokens, structure, screens, access, settings screen, tests), Failure and edge behaviour, Settings routes (secret write, pick lists), Host process and stack control (starting it, listeners, stack routes), Docs site, Feed and health, Test-input injection and uploads, Viewers page; decision docs: [standalone dashboard](../intent/dashboard/decisions/standalone-dashboard.md), [UI rebuild](../intent/dashboard/decisions/dashboard-revamp.md) (options, selections and the audit of the old page).
- Cross-segment edges: stack and lifecycle actions are control-plane's (CTRL-STACK-*, CTRL-LOCK-*), uploads are read by eyes and ears (SHARED-INJ-005), the settings editor's routes, the manifest's pause and test descriptors are module-contract's (MOD-CFG-*, MOD-PAUSE-*, MOD-TEST-*), and the settings screen's presentation metadata and `secrets/secrets.yaml` are the config segment's, and `POST /mouth/routing` feeds mouth (MOUTH-LIVE-*). The served docs are docs-site's build (DOCS-*), rebuilt when they changed by deployment's `mise run dashboard` (DEPLOY-HOST-001); docs-site's live health component reads `GET /services` and keeps the `#the-states` anchor the Services screen links (DOCS-LIVE-*).

## References

### HLD
- docs/high-level-design.md (Segments table, operator: dashboard; Cross-cutting: audio sink arbitration, service health and control, test injection)

### LLD
- docs/intent/dashboard/dashboard-design.md
- docs/intent/dashboard/decisions/standalone-dashboard.md
- docs/intent/dashboard/decisions/dashboard-revamp.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (427 specs, prefix `DASH`: 411 `[x]`, 16 `[ ]`, 0 `[D]`; DASH-DOCS-009, -014, DASH-BUILD-001, -005 and DASH-AVP-001 name the mise tasks of deployment #344 and close with its implementation; DASH-CTRL-006 is retired, and DASH-INJ-007 and DASH-UI-016 are retired placeholders, no number is reused)

### Tests
`@spec DASH-` annotations are in:
- services/dashboard/test/applied-view.test.ts, models.test.ts, models-upload.test.ts, models-applied.test.ts, models-transport.test.ts (the avatar model store, DASH-MDL and the applied view), body.test.ts, control.test.ts, dev-proxy.test.ts, docs-script.test.ts, docs.test.ts, egress.test.ts, feed.test.ts, host-docs.test.ts, host.test.ts, inject-connector.test.ts, inject-event.test.ts, inject.test.ts, options.test.ts, root-scripts.test.ts, routes.test.ts, routing.test.ts, secrets.test.ts, sensitive.test.ts, service.test.ts, stack-lock.test.ts, stack-rebuild.test.ts, stack.test.ts, static.test.ts, uploads.test.ts, viewers.test.ts, ws-origin.test.ts
- services/dashboard/test/ui/*.test.tsx (the React UI on `happy-dom` and Testing Library, and the renderer page's pure modules: `avatar-pose`, `avatar-motion`, `avatar-loader`, `avatar-session`, `notices`, `build`; `access`, `access-dialog`, `api`, `audio`, `components-display`, `components-form`, `dialog`, `egress-note`, `feed`, `live-avatar`, `live-feed`, `live-inject`, `live-say`, `personality`, `pickers`, `routes`, `services`, `services-stack`, `services-test-sheet`, `settings-model`, `settings-page`, `settings-real`, `settings-secrets`, `shell`, `sink`, `stylesheet`, `theme`, `tokens`, `viewers`)
- packages/control/test/derived-lists.test.ts
- Out of segment, cited only: packages/config/test/config.test.ts (DASH-SINK-004 via `urls.voice()`)

### Code
`@spec DASH-` annotations are in:
- services/dashboard/src/applied.ts, model-routes.ts, models.ts (the avatar model store, its routes and the applied view), body.ts, control.ts, docs.ts, egress.ts, feed.ts, health.ts, host.ts, index.ts, inject.ts, options.ts, routes.ts, routing.ts, secrets.ts, sensitive.ts, service.ts, settings.ts, stack.ts, static.ts, uploads.ts, viewers.ts
- services/dashboard/ui/ (the renderer page under `src/avatar/` (pure modules plus the thin WebGL layer in `scene.ts` and the entry `main.ts`), `avatar.html`, `notices.ts` (the third-party notices, used by the Vite plugin), the React app: `src/app` shell and Access dialog, `src/screens` Live, Services, Viewers and Settings, `src/components`, `src/state`, `src/styles`, `index.html`, `vite.config.ts`, `dev-proxy.ts`, `tsconfig.json`)
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
10. `ui/` — the React app built by Vite into `dist-ui/`: shell (header, hash routes, shortcuts, dialogs), Live, Services, Viewers and Settings screens, the Access dialog, the audio sink and sink view, the theme tokens; served through `static.ts`, the static-file helper it shares with `docs.ts`.
11. `docs.ts` — `handleDocs`: serves `docs/.vitepress/dist` under `/cohost/` on the full surface (resolution, path guard, MIME types, caching, not-built page); tests in `test/docs.test.ts`.
12. `secrets.ts`, `options.ts`, `sensitive.ts`, `settings.ts` — `PUT /secrets/:path` and `PUT /secrets`, `GET /options/voices` and `GET /options/models`, the sensitive-key gate, and the settings editor routes.
13. `egress.ts` — `GET /egress`: `egressDestinations` over the config the loader reads per request.
14. `models.ts`, `model-routes.ts`, `applied.ts` — the avatar model store (`<dataDir>/dashboard/avatar-models/`: listing, the glTF head checks and metadata, derived upload names), its HTTP routes (`GET /avatar/model`, `GET`/`POST /avatar/models`, `GET`/`DELETE /avatar/models/<name>`: the streamed upload with its temporary file, idle timer, limits and commit under one lock) and the applied view (the model and framing set at start and after each `renderer` save; `settings.ts` runs the DASH-MDL-037 check and sets the view).
15. `avatar-relay.ts` — the renderer relay: `/avatar/ws` on both listeners (admission with the 503 caps, the frame reader started by the first socket and stopped by the last, one slot per message type per socket with a 5 s stuck-send rule, ping and silence, the state of the Engine's `avatar.state` and frames, the inbound model report from loopback only, the rate limit), `GET /avatar/renderer`, and the applied-view push; its clock is injected. `static.ts` serves `GET`/`HEAD /avatar` with the Content-Security-Policy. Tests: `test/relay-rig.ts`, `relay-socket.test.ts`, `relay-messages.test.ts`, `relay-status.test.ts`, `relay-routes.test.ts`, and `packages/control/test/config.test.ts` for `isLoopbackPeer`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| HTTP routes | DASH-HTTP-001 to DASH-HTTP-017 | 17 | 0 | 0 |
| Audio proxy and sink | DASH-SINK-001 to DASH-SINK-007 | 7 | 0 | 0 |
| WebSocket feed | DASH-FEED-001 to DASH-FEED-012 | 12 | 0 | 0 |
| Control gating | DASH-CTRL-001 to DASH-CTRL-010 (006 retired) | 9 | 0 | 0 |
| Service lifecycle | DASH-SVC-001 to DASH-SVC-004 | 4 | 0 | 0 |
| Mouth routing | DASH-ROUTE-001 to DASH-ROUTE-003 | 3 | 0 | 0 |
| Test-input injection | DASH-INJ-001 to DASH-INJ-012 | 12 | 0 | 0 |
| Upload store (Redis) | DASH-UPL-001 to DASH-UPL-003 | 3 | 0 | 0 |
| Web page | DASH-UI-001 to DASH-UI-037 (016 retired) | 37 | 0 | 0 |
| Streamed lines on the page | DASH-UI-038 to DASH-UI-054 | 17 | 0 | 0 |
| Host process and listeners | DASH-HOST-001 to DASH-HOST-010 | 10 | 0 | 0 |
| Stack control | DASH-STACK-001 to DASH-STACK-010 | 10 | 0 | 0 |
| Docs site | DASH-DOCS-001 to DASH-DOCS-016 | 16 | 0 | 0 |
| Viewers page | DASH-VIEWERS-001 to DASH-VIEWERS-023 | 23 | 0 | 0 |
| Build and serving | DASH-BUILD-001 to DASH-BUILD-011 | 11 | 0 | 0 |
| Secret write | DASH-SECRET-001 to DASH-SECRET-015 | 15 | 0 | 0 |
| Pick lists | DASH-OPT-001 to DASH-OPT-005 | 5 | 0 | 0 |
| Egress marks | DASH-EGR-001 to DASH-EGR-004 | 4 | 0 | 0 |
| Access dialog | DASH-ACC-001 to DASH-ACC-012 | 12 | 0 | 0 |
| Navigation and shortcuts | DASH-NAV-001 to DASH-NAV-004 | 4 | 0 | 0 |
| Theme | DASH-THEME-001 to DASH-THEME-006 | 6 | 0 | 0 |
| Accessibility and layout | DASH-A11Y-001 to DASH-A11Y-008 | 8 | 0 | 0 |
| Settings screen | DASH-SET-001 to DASH-SET-034 | 34 | 0 | 0 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 |
| Tools settings and confirmation | DASH-TOOL-001 to DASH-TOOL-026 | 26 | 0 | 0 |
| Avatar renderer: applied view and relay | DASH-AVR-001 to DASH-AVR-035 (022, 025 absent) | 33 | 0 | 0 |
| Avatar renderer: model files | DASH-MDL-001 to DASH-MDL-037 | 37 | 0 | 0 |
| Avatar renderer: the page | DASH-AVP-001 to DASH-AVP-040 | 29 | 0 | 11 |
| Avatar renderer: settings and visibility | DASH-AVS-001 to DASH-AVS-011 | 11 | 0 | 0 |



**Summary:** 427 specs: 416 implemented, 11 gaps, 0 deferred. The secret route writes `secrets/secrets.yaml` and offers restarts by the manifest `secrets` lists (DASH-SECRET-001, -002, -008, -009, -012, -013; #318; `services/dashboard/src/secrets.ts`). The avatar model store, its routes and the applied view (DASH-MDL-001 to 037, the applied lines DASH-AVR-023, 024, 026 to 029, and DASH-HTTP-015) are implemented in `services/dashboard/src/models.ts`, `model-routes.ts` and `applied.ts`. The avatar relay (`services/dashboard/src/avatar-relay.ts`: DASH-AVR-001 to 021 and 030 to 035, `GET /avatar/renderer`, `GET`/`HEAD /avatar`, and the relay's listener and shutdown steps of DASH-HOST-002, DASH-CTRL-005, DASH-HTTP-010 and -016) is implemented and tested by `services/dashboard/test/relay-*.test.ts`. The renderer page (DASH-AVP-003 to 040) is built under #218 in `services/dashboard/ui/src/avatar/`, and its browser and GPU checks are the owner's manual list. The settings and Live-screen status (DASH-AVS-001 to 011, #219) are implemented in `services/dashboard/ui/src/screens/settings/` (`AvatarRenderer.tsx`, `AvatarModels.tsx`, `AvatarPreview.tsx`, `RendererStatus.tsx`) and `screens/live/AvatarCard.tsx`, tested by `test/ui/settings-avatar.test.tsx` and `live-avatar.test.tsx`; the Settings and Live specs DASH-SET-002, DASH-SET-018 and DASH-UI-054 are implemented under the same issue. The streamed-line page specs (DASH-UI-038 to DASH-UI-054) are implemented. The clause specs of the streamed-speech design (CLAUSE, STREAM, REL and the per-segment streamed-line sections) are gaps. `node scripts/lid-check.mjs` finds no reverse orphans.

## Coverage notes

DASH-AVR-014 is met with a bound: the bus gives no callback for a failed frame read, so the relay cannot observe the failure; it sends no frame, and the state reads `live` for at most 1 s after the last frame and `waiting` or `off` from then on. Implemented without a test `@spec` annotation: the plain-text half of DASH-AVR-017 (the screens show `detail` through `textContent`; the cut at 200 characters is annotated and tested), DASH-SINK-004 (its behaviour is `urls.voice()`, tested in `packages/config/test/config.test.ts`) and DASH-DOCS-013 to 016 (docs-page content, checked by the docs build). Manual checks for what an emulated DOM cannot cover (autoplay, OBS, 320 px layout, keyboard and screen-reader passes) are listed in the LLD's Manual verification and on the docs site's Single-PC checklist (`docs/advanced/testing/single-pc.md`).
