# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: live bus feed, controls, personality editor, services tab with gated start/stop/restart, test-input injection, and the browser audio sink.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 61 specs: 61 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are implemented. The server side and the page script (run under a stub DOM, `test/page.test.ts`) are covered by tests; UI-004, 005 and 007 to 011 and the wiring specs HTTP-009, HTTP-010 and CTRL-008 are not.

## Standalone host-run dashboard (chunks 1-3 built)

The spec file holds 99 specs: 99 `[x]`, 0 `[ ]`. Chunk 2 (this segment) is built: `src/host.ts` (the two listeners, LAN allow-list, Host and Origin checks, port resolution), `src/stack.ts` (`StackService`: probe, action slot, `last`; `ObservedStackController`), the `/stack` routes and the shared action slot in `src/routes.ts`, the stack message, bus reachability and seed retry in `src/feed.ts`, `DASHBOARD_HOST` and the off-loopback refusal in `src/control.ts`, the advertised upload base in `src/inject.ts`, the stack panel, header badge and manifest-only lifecycle buttons in `public/index.html`, and the root `pnpm dashboard` script. The dead `conflict` refusal and its 409 mapping are removed. Design: LLD § Host process and stack control, Listeners, Stack routes; [decision doc](../intent/dashboard/decisions/standalone-dashboard.md). Owner decisions (settled): the dashboard is a standalone host program started first; Compose drops its `dashboard` service; Launch brings up the whole stack through the compose runtime; restart of services from the dashboard; stack actions behind `CONTROL_ENABLED=1` + `CONTROL_TOKEN`; stack state in the UI. The mechanics (listeners, routes, timeouts, defaults) are owner-confirmed too.

- New `[ ]`: DASH-HOST-001 to 007 (LAN listener, its route allow-list, bind failure, Host and Origin checks, token never logged, a non-loopback `DASHBOARD_HOST` requires control mode), DASH-STACK-001 to 007 (`GET /stack`, async stack actions, one action slot, Docker-unavailable 503, preconditions, result and audit, probe cadence), DASH-FEED-008, 009 (stack pushes, bus reachability), DASH-UI-017 to 020 (stack panel, state badge, consolidate offer, progress and result).
- Reworded `[ ]`: DASH-HTTP-009 (`DASHBOARD_PORT`), DASH-HTTP-010 (shutdown leaves containers alone), DASH-HTTP-012 (no exit without Redis; a failed replay keeps the socket), DASH-FEED-001 (stack snapshot in the connect sequence), DASH-CTRL-001, 004, 005 (stack routes), DASH-CTRL-003 (`DASHBOARD_HOST`, default `127.0.0.1`, in both modes), DASH-SVC-003 (no 409 self conflict), DASH-INJ-005 (advertised upload base), DASH-UI-008 (buttons on manifest units only).
- Retired: none in this segment (control-plane CTRL-GUARD-002 and deployment DEPLOY-COMPOSE-016 retire with it).

### Build order

Each chunk is one PR, tests first, specs flipped to `[x]` as they land.

| Chunk | Segment(s) | Specs | Notes |
|---|---|---|---|
| 1. Stack controller and CLI (built) | control-plane (+ one dashboard test) | CTRL-STACK-001 to 012, CTRL-CLI-001, 009, 010, 011, 012, CTRL-MANIFEST-001 to 003, CTRL-HEALTH-005; retire CTRL-GUARD-002; DASH-SVC-003 | Removing `dashboard` from the manifest changes the dashboard's 409 path to 404, so the DASH-SVC-003 test moves with it. Usable at once from `cohostctl` against today's Compose file. |
| 2. Host dashboard (built; DEPLOY-HOST-001 and DEPLOY-REPO-002 are the root `pnpm dashboard` script, whose spec lines are deployment's) | dashboard, deployment (start script) | DASH-HOST-001 to 007, DASH-STACK-001 to 007, DASH-FEED-001, 008, 009, DASH-HTTP-009, 010, 012, DASH-CTRL-001, 003, 004, 005, DASH-INJ-005, DASH-UI-008, 017 to 020; DEPLOY-HOST-001, DEPLOY-REPO-002 | Works beside today's Compose file only if the containerised dashboard is stopped first or `PORT`/`DASHBOARD_LAN_PORT` avoid 3000/3001; land chunk 3 right after. |
| 3. Compose and docs (built) | deployment | DEPLOY-COMPOSE-001, 002, 003, 006, 007, DEPLOY-CI-002, DEPLOY-INST-008, 013, DEPLOY-HOST-002, 003, 004; retire DEPLOY-COMPOSE-016; README, `docs/TESTING.md`, `.env.example`, `scripts/install.sh`, `scripts/compose-smoke.sh` | Removes the `dashboard` service and the `CONTROL_ENABLED` pin, publishes voice on loopback, points containers' `DASHBOARD_URL` at the host gateway. |

### Edge audit (cross-spec, cross-segment)

Resolved in the specs:

1. **A page opened while Redis is down.** DASH-FEED-008 sends the stack snapshot before the replay, but the audited DASH-HTTP-012 closed a socket whose replay failed, so every page would be closed right after its snapshots and loop on reconnect. DASH-HTTP-012 now keeps the socket open without the replay (it reverses part of the 2026-11-01 decision R1; owner question).
2. **Upload URL agreement.** DASH-INJ-005 (what the dashboard advertises) and DEPLOY-COMPOSE-002 (what eyes and ears accept, SHARED-INJ-004, SHARED-INJ-004) share one default, `http://host.docker.internal:${DASHBOARD_LAN_PORT:-3001}`, and one override, `DASHBOARD_URL`. Host-run eyes or ears under `pnpm dev` keep the `urls.dashboard()` loopback default (CFG-URL-003) and need `DASHBOARD_URL` set to match; accepted for the dev loop.
3. **The `dashboard` id.** CTRL-MANIFEST-001 drops it, so DASH-SVC-003 answers 404 (not 409) and DASH-UI-008 shows no buttons on its row; CTRL-HEALTH-005 still shows the dashboard's own heartbeat as "another service".
4. **One action at a time.** DASH-STACK-003 covers per-service lifecycle requests too, so a restart cannot interleave with a launch or stop in one dashboard; `cohostctl` in another process is not locked out (control-plane LLD Deferred 3).
5. **Infrastructure guards.** CTRL-STACK-010: launch and stop-all ignore `CONTROL_ADVANCED`; restart-all goes through the controller and never restarts infrastructure; per-service Redis/Postgres actions keep CTRL-GUARD-003.
6. **Graceful stop and viewer notes.** CTRL-STACK-006 uses `stop` (reverse dependency order, SIGTERM), so memory stops before Postgres and sets `notes.shutdown_run_owed` (MEM-CONSOL-013); DASH-STACK-005 refuses the consolidate route while memory runs, while `cohostctl consolidate` (CTRL-CLI-008) still runs any time.
7. **Host and Origin checks vs control off.** DASH-HOST-004 applies only while the full surface is on loopback; DASH-HOST-005 applies always on the full surface. A reverse proxy that rewrites `Host` without `Origin` would be refused by DASH-HOST-005; no proxy is part of the design.
8. **The LAN listener serves the page.** DASH-HOST-002 serves `GET /`, but the page's other reads (`/services/control`, `/personality`, `/stack`) answer 404 there; the LAN listener is for the `?sink=1` view, which hides everything but the header.
9. **Voice on loopback with CORS `*`.** DEPLOY-COMPOSE-007 makes voice's audio and clip routes readable by any page in the owner's browser that guesses an id; ids are not guessable and the HLD accepts CORS `*` inside the boundary.
10. **Launch converges.** CTRL-STACK-002: a Launch after an isolated start recreates that service without its preset, and `--remove-orphans` removes the old `dashboard` container; profile services start only when `COMPOSE_PROFILES` names them.

11. **Blind divergence probe.** A reader given only the spec lines found forks that are now narrowed in the lines themselves: the `kind` wire values and the refusal order (DASH-STACK-002), no probe yet means 503 (DASH-STACK-004), one probe at a time including the launch wait (DASH-STACK-007), `ready` after both listeners (DASH-HTTP-009), shutdown never kills a running `docker compose` (DASH-HTTP-010), IPv6 `Host` parsing (DASH-HOST-004), `Origin: null` (DASH-HOST-005), what a successful read is (DASH-FEED-009), container comparison ignoring order (DASH-FEED-008), long-running means present in the status (CTRL-STACK-003, 011), CLI status lines on failure too (CTRL-CLI-010), what an empty token is (DEPLOY-INST-013). Two more are narrowed on the owner's instruction: CTRL-CLI-001 now gives `stop <service>` without options, and the installer and README say the dashboard's startup log carries the URL it actually uses when `PORT` or `DASHBOARD_HOST` is set (DEPLOY-INST-008, DEPLOY-HOST-003, DASH-HOST-006).

12. **Full dashboard from another machine.** `DASHBOARD_HOST` (DASH-CTRL-003) opens the full surface; DASH-HOST-007 refuses a non-loopback address without control mode, so DASH-CTRL-004 and DASH-VIEWERS-007 always guard the stack actions and viewer notes there; the Host check (DASH-HOST-004) applies only on loopback.
13. **One PC: WSL2 with Docker Desktop.** The Windows browser and a same-PC sink reach the distro through WSL localhost forwarding (`http://localhost:3000`, `http://localhost:3001/?sink=1`); containers reach the LAN listener through `host.docker.internal`, with `DASHBOARD_URL` as the fallback (DEPLOY-COMPOSE-003); the control plane falls back to `docker.exe` (CTRL-STACK-012); DEPLOY-HOST-004 is the checklist.

Owner answers recorded: every question in the PR is settled (owner's answers and recommended defaults).

## Viewer notes: Viewers page built (chunk 4)

Design: LLD § Viewers page (layout "panel A", routes, Access protection options A to E). The spec file holds 79 specs: 79 `[x]`, 0 `[ ]`.

- Built: `DASH-VIEWERS-001` to `017` (`src/viewers.ts`: `ViewersClient` request/reply over the bus with a 3000 ms timeout, `handleViewers` routes and `VIEWERS_TOKEN` gate; the Viewers tab in `public/index.html`), and `DASH-FEED-001`, `002`, `007` (`feed.ts` `WITHHELD`: the four viewer-notes events never reach `/ws`, live or in the replay; `memory.viewers.reply` is handed to the `ViewersClient` instead). The `memory.notes.*` names are filtered by name, so the filter already holds when cortex surfacing (chunk 3) puts them on the bus.
- Tests: `test/viewers.test.ts` (routes, token gate, reply mapping, timeout, body caps), `test/feed.test.ts`, `test/page.test.ts` (page script under the stub DOM). The page was also driven once in headless Chrome against the real handler and memory admin (list, search, select, delete with reason, undo, regular toggle, name field, clear, token prompt); that check is not part of the suite.
- Access: option A, a dedicated `VIEWERS_TOKEN` on every `/viewers` route (owner decision), env only (`CFG-ENV-009`). Open item: dashboard visual design to be revisited later (LLD Open Questions 5).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B22** `POST /sink` with an unknown `event` → `400`, publish nothing; DASH-SINK-002 narrowed to `playing` / `done`. Specs: DASH-SINK-002 (reworded, `[x]`), DASH-SINK-003 (`[x]`).
2. **P4** Gate `POST /sink` when control is enabled → no, never: an OBS Browser Source cannot authenticate and the LAN is the trust boundary. DASH-CTRL-006 is retired (deleted; the number is not reused); DASH-CTRL-005 states the reason.
3. **P4** Read-only disclosure with control enabled → control mode guards mutations only; `/ws`, `GET /personality`, `GET /services` stay open. Specs: DASH-CTRL-005 (reworded); Decisions row.
4. **S1** Replay into the audio sink → page-side: show replayed events, never play a replayed utterance; recognise replay by marker or bus event id, not by clock. **B24** connect-replay race fixed with it. Specs: DASH-UI-013, DASH-FEED-001 (both `[x]`, reworded).
5. **S2** Bus-level chat never computes `mentionsCohost` → accepted (chat's perception step is skipped by design). Specs: DASH-INJ-002 (unchanged, `[x]`); Decisions row.
6. **R6** Request body caps → 64 KiB, `413`. Specs: DASH-HTTP-011 (new `[x]`).
7. **R1** Redis unreachable at startup → log `fatal`, exit non-zero; a failed per-client replay closes that socket. Specs: DASH-HTTP-012 (new `[x]`).
8. **S3** `?sink=0` still enables sink mode → accepted (presence semantics). Specs: DASH-UI-011 (reworded, `[x]`).
9. **B16** Three page/route defects → fix. Specs: DASH-UI-015 (save/mute check the response), DASH-UI-016 (`esc()` quotes), DASH-HTTP-013 (malformed `%` → 404), all new `[x]`.
10. **S56** Page test strategy → make the page script loadable by `node:test` with a stub DOM; manual checks in `docs/TESTING.md` for the rest. Work Required item.
- **B23** (from review) the audio proxy buffers the upstream body before choosing the status. Specs: DASH-HTTP-004 (`[x]`, reworded).
- **P4** Host-side sinks reach voice only through the dashboard `/audio/*` proxy. LLD Context and Decisions row.

## References

### HLD
- docs/high-level-design.md (Segments table, operator: dashboard; Cross-cutting: audio sink arbitration, service health and control, test injection)

### LLD
- docs/intent/dashboard/dashboard-design.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (110 specs: 110 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
`@spec` annotations in tests: 62.
- services/dashboard/test/routes.test.ts (10)
- services/dashboard/test/feed.test.ts (10)
- services/dashboard/test/control.test.ts (14)
- services/dashboard/test/inject.test.ts (10)
- services/dashboard/test/uploads.test.ts (7)
- services/dashboard/test/page.test.ts (11; the inline script of `public/index.html` run in a `node:vm` context with a stub DOM)
- Out of segment, cited only: packages/config/test/config.test.ts:207 (DASH-SINK-004 via `urls.voice()`)

### Code
`@spec` annotations in code: 52.
- services/dashboard/src/routes.ts (16)
- services/dashboard/src/index.ts (7)
- services/dashboard/src/inject.ts (3)
- services/dashboard/src/control.ts (2)
- services/dashboard/src/feed.ts (4)
- services/dashboard/src/uploads.ts (2)
- services/dashboard/src/health.ts (1)
- services/dashboard/public/index.html (17)
- services/dashboard/package.json, services/dashboard/tsconfig.json (no annotations)

### Retired OpenSpec (historical)
- openspec/specs/dashboard/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/ (design.md D3, D6)
- openspec/changes/archive/2026-11-01-add-service-control/ (design.md Options, Decisions 4, 8, 9)
- openspec/changes/archive/2026-11-01-add-test-injection/ (design.md D1 to D5, D9, D10)

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

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| HTTP routes | DASH-HTTP-001 to DASH-HTTP-015 | 15 | 0 | 0 | 15 |
| Audio proxy and sink | DASH-SINK-001 to DASH-SINK-004 | 4 | 0 | 0 | 3 |
| WebSocket feed | DASH-FEED-001 to DASH-FEED-007 | 10 | 0 | 0 | 10 |
| Control gating | DASH-CTRL-001 to DASH-CTRL-008 | 7 | 0 | 0 | 6 |
| Service lifecycle | DASH-SVC-001 to DASH-SVC-004 | 4 | 0 | 0 | 4 |
| Test-input injection | DASH-INJ-001 to DASH-INJ-008 | 8 | 0 | 0 | 8 |
| Upload store | DASH-UPL-001 to DASH-UPL-003 | 3 | 0 | 0 | 3 |
| Web page | DASH-UI-001 to DASH-UI-022 | 22 | 0 | 0 | 16 |
| Host process and listeners | DASH-HOST-001 to DASH-HOST-007 | 7 | 0 | 0 | 7 |
| Stack control | DASH-STACK-001 to DASH-STACK-008 | 8 | 0 | 0 | 8 |
| Viewers page | DASH-VIEWERS-001 to DASH-VIEWERS-021 | 21 | 0 | 0 | 21 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 | 1 |

**Summary:** 110 of 110 specs implemented; 0 deferred; 0 open. 102 carry a test `@spec` annotation; implemented without one: DASH-SINK-004, DASH-CTRL-008, DASH-UI-004, DASH-UI-005, DASH-UI-007, DASH-UI-009, DASH-UI-010, DASH-UI-011 (verified by glue, configuration or a test that cites a neighbouring ID). `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **Two markers flipped to `[x]`.** DASH-SINK-004: the loopback default is intended; commit `e53badc` ("default VOICE_URL to loopback outside Docker", fixes #10) moved it deliberately, and the line now states the loopback default instead of the retired OpenSpec `http://voice:8700`. DASH-UI-003: the `brain.status` schema field is `detail` (`packages/bus/src/events.ts:59-62`), cortex publishes it (`services/cortex/src/cortex.ts:138`, e.g. `"paused"` and the focus reason) and the page renders it (`index.html:309`); the mapped line confused it with `memory.viewer.notes`.
2. **The two spec contradictions are resolved** — DASH-SINK-002 now covers only `playing` / `done` and DASH-SINK-003 rejects anything else (B22); `/sink` stays ungated (DASH-CTRL-005) and DASH-CTRL-006 is retired, because the page's `/sink` posts go through the token prompt (`index.html:145-146, 150-164`) that an OBS Browser Source cannot answer (P4).
3. **Five confirmed gaps, all closed** — `__COHOST_NAME__` replaced once (`routes.ts:47`; title `index.html:6`, heading `:54`; fixture `test/routes.test.ts:22` has one occurrence) (DASH-HTTP-001); backfill replays speech into the sink (`feed.ts:36-41`, `index.html:331, 145-146`) (DASH-UI-013); unbounded audio queue while audio is off (`index.html:142, 331`) (DASH-UI-014); the audio proxy writes headers before reading the upstream body, so a failed body read re-enters `writeHead(500)` after headers are sent (`routes.ts:58-62, 130-133`) (DASH-HTTP-004); `onConnection` awaits `bus.recent()` after the socket is already in `wss.clients`, so a live event can precede or duplicate the replay (`index.ts:49`, `feed.ts:36-41`) (DASH-FEED-001).
4. **Lines reworded to match code** — DASH-HTTP-004 (the throw examples: `/inject/text` answers invalid JSON with 400, not 500); DASH-INJ-002 (the published event carries `mentionsCohost: false` from the schema default, which `test/inject.test.ts:34` asserts); DASH-UI-011 (any `sink` query parameter); DASH-UPL-002 (expiry also runs on every `put`).
5. **Specs added for unspecified behavior** — DASH-HTTP-010 (graceful shutdown, `index.ts:56`), DASH-CTRL-007 (`GET /services/control` when enabled, `routes.ts:72-76`), DASH-CTRL-008 (`CONTROL_ADVANCED` warning, `control.ts:30`).
6. **Decisions now carry evidence** — 10 of 12 Decisions & Alternatives rows cite the archived OpenSpec design records (`add-service-control`, `add-test-injection`, `add-service-health`), code comments or commits; UI technology and feed transport remain `[inferred]`. The mapped LLD's `uploads.ts` line references pointed past the end of the file and have been corrected.
7. **Robustness gaps, now closed** — unbounded request bodies (`routes.ts:155-162`, DASH-HTTP-011), unhandled feed promises (`index.ts:49-50`, DASH-HTTP-012), `URIError` as 500 (`routes.ts:85`, DASH-HTTP-013), success messages that ignore the response (`index.html:168, 173`, DASH-UI-015), `esc()` quoting (`index.html:272, 323`, DASH-UI-016).

## Work Required

### Must Fix
None outstanding. The owner-decided fixes are implemented: unknown `/sink` events `400` (DASH-SINK-003), replay marker plus page-side de-duplication and the held live events during replay (DASH-UI-013, DASH-FEED-001), buffered audio proxy body (DASH-HTTP-004), `fatal` exit on a failed feed start and per-socket replay failure handling (DASH-HTTP-012), 64 KiB body cap (DASH-HTTP-011), response-checked save and mute, quote-safe `esc()` and malformed `%` to `404` (DASH-UI-015, DASH-UI-016, DASH-HTTP-013), every `__COHOST_NAME__` replaced (DASH-HTTP-001) and no audio queue while audio is off (DASH-UI-014).

### Nice to Have
1. Extend the stub-DOM page tests to DASH-UI-004, 005, 007 to 011; record manual checks for what a stub cannot cover in `docs/TESTING.md` (S56). Add tests for the `/ws` wiring and shutdown (DASH-HTTP-009, DASH-HTTP-010, DASH-CTRL-008).
2. Remove the duplicated CSS comment at `index.html:41`; add pause/resume UI (DASH-HTTP-008).
