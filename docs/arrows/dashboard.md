# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: live bus feed, controls, personality editor, services tab with gated start/stop/restart, test-input injection, and the browser audio sink.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 61 specs: 61 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are implemented. The server side and the page script (run under a stub DOM, `test/page.test.ts`) are covered by tests; UI-004, 005 and 007 to 011 and the wiring specs HTTP-009, HTTP-010 and CTRL-008 are not.

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
- docs/intent/dashboard/dashboard-specs.md (61 specs: 61 `[x]`, 0 `[ ]`, 0 `[D]`)

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

| Category | Spec IDs | Implemented | Deferred | Gaps | With test |
|----------|----------|-------------|----------|------|-----------|
| HTTP routes | DASH-HTTP-001 to 013 | 13 | 0 | 0 | 11 |
| Audio proxy and sink | DASH-SINK-001 to 004 | 4 | 0 | 0 | 3 (+004 via config) |
| WebSocket feed | DASH-FEED-001 to 006 | 6 | 0 | 0 | 6 |
| Control gating | DASH-CTRL-001 to 008 (006 retired) | 7 | 0 | 0 | 6 |
| Service lifecycle | DASH-SVC-001 to 004 | 4 | 0 | 0 | 4 |
| Test-input injection | DASH-INJ-001 to 007 | 7 | 0 | 0 | 7 |
| Upload store | DASH-UPL-001 to 003 | 3 | 0 | 0 | 3 |
| Web page | DASH-UI-001 to 016 | 16 | 0 | 0 | 9 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 | 1 |

**Summary:** 61 of 61 specs implemented; 0 deferred; 0 gaps. 50 specs carry a dashboard test annotation. Implemented but untested: DASH-HTTP-009, DASH-HTTP-010, DASH-CTRL-008, DASH-UI-004, DASH-UI-005, DASH-UI-007 to DASH-UI-011 (DASH-SINK-004 is tested only through the config package). Every spec has a code annotation. DASH-CTRL-006 is retired; its number is not reused.

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
