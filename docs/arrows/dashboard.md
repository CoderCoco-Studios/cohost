# Arrow: dashboard

The operator's web UI and HTTP/WebSocket API: live bus feed, controls, personality editor, services tab with gated start/stop/restart, test-input injection, and the browser audio sink.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f). Audit pass complete 2026-11-01, awaiting index update. 52 of 57 specs implemented, 5 gaps, 0 deferred; 37 specs exercised by an annotated test. The server side is well covered; the page (`public/index.html`) has no automated tests and holds two of the three confirmed defects (audio replay, unbounded queue).

## Questions for the user

1. **`POST /sink` with an unknown `event`.** DASH-SINK-002 (`[x]`) says any non-`playing` value publishes `voice.done`; DASH-SINK-003 (`[ ]`) says reject with 400. Evidence: `services/dashboard/src/routes.ts:122`; the retired OpenSpec requirement enumerated `{event: "playing"|"done"}` (`openspec/specs/dashboard/spec.md:53`). Recommended: adopt DASH-SINK-003 and narrow DASH-SINK-002's second clause to `event: "done"`.
2. **Gate `POST /sink` when control is enabled?** DASH-CTRL-005 (`[x]`, ungated) contradicts DASH-CTRL-006 (`[ ]`, gated). Evidence: `routes.ts:120-125`; the page posts `/sink` through `authFetch`, whose 401 path is a `prompt()` (`public/index.html:145-146, 150-164`) that an OBS Browser Source cannot answer. Recommended: keep `/sink` ungated, mark DASH-CTRL-006 `[D]`, and record the OBS constraint as a Decisions row.
3. **Read-only disclosure with control enabled.** `/ws` (all chat, speech, vision and memory events), `GET /personality` and `GET /services` stay open under `CONTROL_ENABLED=1` (DASH-CTRL-005; `routes.ts:66-76, 98-102`, `index.ts:47`). Is "control mode guards mutations only" the intended posture? Recommended: yes; confirm it as a Decisions row (the sink page needs `/ws`, and control mode already binds to loopback).
4. **Which fix does DASH-UI-013 mean?** "Do not play utterances published before the connection" can be met page-side (ignore backfilled `voice.utterance`) or server-side (leave `voice.utterance` out of the backfill). Evidence: `feed.ts:36-41`, `index.html:331`. Recommended: page-side, skipping utterances whose `ts` predates the socket's open, so the feed still shows history.
5. **Bus-level chat injection and mentions.** Bus-level `chat.message` never computes `mentionsCohost` (`inject.ts:103-107`), so affect (`services/affect/src/affect.ts:42`), memory viewer tracking (`services/memory/src/region.ts:22`) and salience (`packages/working-memory/src/index.ts:39`) never see a mention; service level computes it in chat (`services/chat/src/inject.ts:37`). Is that part of "skip perception"? Recommended: accept as-is (mention detection is chat's perception step); DASH-INJ-002 now states it.
6. **Request body caps.** `POST /control`, `PUT /personality`, `POST /sink` and lifecycle bodies are read without a limit (`routes.ts:155-162`); only `/inject/*` is capped (`inject.ts:10`). No spec bounds them. Recommended: add a DASH-HTTP line capping these bodies at 64 KiB with 413, matching `/inject/text`.
7. **Redis unreachable at startup.** `feed.start()` and `feed.onConnection()` are `void`-ed (`index.ts:49-50`), so a Redis failure is an unhandled rejection; no spec says what should happen. Recommended: log and exit non-zero so Compose's `restart: unless-stopped` retries; add a spec line.
8. **Sink mode trigger.** Sink mode keys on the presence of a `sink` query parameter, so `?sink=0` also enables it (`index.html:133`); docs and `index.ts:5` mention only `?sink=1`. DASH-UI-011 now records presence semantics. Recommended: accept presence semantics.
9. **Unspecified page and route defects: promote to `[ ]` spec lines?** (a) personality save reports "saved · brain reloaded" after any response, and the mute button flips without checking the response (`index.html:168, 173`); (b) `esc()` does not escape quotes but is used inside `data-svc="..."` (`index.html:272, 323`); (c) a malformed `%` escape in a lifecycle id throws `URIError` and answers 500, not 404 (`routes.ts:85`). Recommended: yes, add one `[ ]` line for each.
10. **Test strategy for the page.** DASH-UI-001 to DASH-UI-012 (and DASH-HTTP-009, DASH-HTTP-010, DASH-CTRL-008) have no automated test, and the package has no browser harness (`services/dashboard/package.json:17-26`). Recommended: move the page script into a module that `node:test` can load with a stub DOM, or record manual verification steps in `docs/TESTING.md`.

## References

### HLD
- docs/high-level-design.md (Segments table, operator: dashboard; Cross-cutting: audio sink arbitration, service health and control, test injection)

### LLD
- docs/intent/dashboard/dashboard-design.md

### EARS
- docs/intent/dashboard/dashboard-specs.md (57 specs: 52 `[x]`, 5 `[ ]`, 0 `[D]`)

### Tests
`@spec` annotations in tests: 42.
- services/dashboard/test/routes.test.ts (7)
- services/dashboard/test/feed.test.ts (6)
- services/dashboard/test/control.test.ts (12)
- services/dashboard/test/inject.test.ts (10)
- services/dashboard/test/uploads.test.ts (7)
- Out of segment, cited only: packages/config/test/config.test.ts:207 (DASH-SINK-004 via `urls.voice()`)

### Code
`@spec` annotations in code: 40.
- services/dashboard/src/routes.ts (13)
- services/dashboard/src/index.ts (5)
- services/dashboard/src/inject.ts (3)
- services/dashboard/src/control.ts (2)
- services/dashboard/src/feed.ts (2)
- services/dashboard/src/uploads.ts (2)
- services/dashboard/src/health.ts (1)
- services/dashboard/public/index.html (12)
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
| HTTP routes | DASH-HTTP-001 to 010 | 9 | 0 | 1 (001) | 8 |
| Audio proxy and sink | DASH-SINK-001 to 004 | 3 | 0 | 1 (003) | 2 (+004 via config) |
| WebSocket feed | DASH-FEED-001 to 006 | 6 | 0 | 0 | 6 |
| Control gating | DASH-CTRL-001 to 008 | 7 | 0 | 1 (006) | 6 |
| Service lifecycle | DASH-SVC-001 to 004 | 4 | 0 | 0 | 4 |
| Test-input injection | DASH-INJ-001 to 007 | 7 | 0 | 0 | 7 |
| Upload store | DASH-UPL-001 to 003 | 3 | 0 | 0 | 3 |
| Web page | DASH-UI-001 to 014 | 12 | 0 | 2 (013, 014) | 0 |
| Health | DASH-HEALTH-001 | 1 | 0 | 0 | 1 |

**Summary:** 52 of 57 specs implemented; 0 deferred; 5 gaps. 37 specs carry a dashboard test annotation. Implemented but untested: DASH-HTTP-009, DASH-HTTP-010, DASH-CTRL-008, DASH-UI-001 to 012 (DASH-SINK-004 is tested only through the config package). Every implemented spec has a code annotation; the five gaps (DASH-HTTP-001 excepted, which annotates the partial implementation) have none.

## Key Findings

1. **Two markers flipped to `[x]`.** DASH-SINK-004: the loopback default is intended; commit `e53badc` ("default VOICE_URL to loopback outside Docker", fixes #10) moved it deliberately, and the line now states the loopback default instead of the retired OpenSpec `http://voice:8700`. DASH-UI-003: the `brain.status` schema field is `detail` (`packages/bus/src/events.ts:59-62`), cortex publishes it (`services/cortex/src/cortex.ts:138`, e.g. `"paused"` and the focus reason) and the page renders it (`index.html:309`); the mapped line confused it with `memory.viewer.notes`.
2. **Two spec pairs contradict each other** — DASH-SINK-002 / DASH-SINK-003 (unknown `/sink` event) and DASH-CTRL-005 / DASH-CTRL-006 (`/sink` gating). Gating `/sink` as the page stands would break the OBS sink page, because the page's `/sink` posts go through the token prompt (`index.html:145-146, 150-164`). Questions 1 and 2.
3. **Three confirmed gaps remain** — `__COHOST_NAME__` replaced once (`routes.ts:47`; title `index.html:6`, heading `:54`; fixture `test/routes.test.ts:22` has one occurrence) (DASH-HTTP-001); backfill replays speech into the sink (`feed.ts:36-41`, `index.html:331, 145-146`) (DASH-UI-013); unbounded audio queue while audio is off (`index.html:142, 331`) (DASH-UI-014).
4. **Lines reworded to match code** — DASH-HTTP-004 (the throw examples: `/inject/text` answers invalid JSON with 400, not 500); DASH-INJ-002 (the published event carries `mentionsCohost: false` from the schema default, which `test/inject.test.ts:34` asserts); DASH-UI-011 (any `sink` query parameter); DASH-UPL-002 (expiry also runs on every `put`).
5. **Specs added for unspecified behavior** — DASH-HTTP-010 (graceful shutdown, `index.ts:56`), DASH-CTRL-007 (`GET /services/control` when enabled, `routes.ts:72-76`), DASH-CTRL-008 (`CONTROL_ADVANCED` warning, `control.ts:30`).
6. **Decisions now carry evidence** — 10 of 12 Decisions & Alternatives rows cite the archived OpenSpec design records (`add-service-control`, `add-test-injection`, `add-service-health`), code comments or commits; UI technology and feed transport remain `[inferred]`. The mapped LLD's `uploads.ts` line references pointed past the end of the file and have been corrected.
7. **Robustness gaps with no spec** — unbounded request bodies (`routes.ts:155-162`), unhandled feed promises (`index.ts:49-50`), `esc()` quoting (`index.html:272, 323`), `URIError` as 500 (`routes.ts:85`), success messages that ignore the response (`index.html:168, 173`). Questions 6, 7 and 9.

## Work Required

### Must Fix
1. Replace all occurrences of `__COHOST_NAME__` and extend the test fixture to two occurrences (DASH-HTTP-001).
2. Stop replaying history into the audio sink (DASH-UI-013; approach per question 4).

### Should Fix
3. Bound or disable the audio queue while audio is off (DASH-UI-014).
4. Resolve the `/sink` contradictions (DASH-SINK-002/003, DASH-CTRL-005/006; questions 1 and 2).
5. Cap request bodies and handle feed startup failures once specified (questions 6 and 7).

### Nice to Have
6. Add tests for the `/ws` wiring, shutdown, and the page's JavaScript (question 10).
7. Promote and fix the small page and route defects (question 9); remove the duplicated CSS comment at `index.html:41`; add pause/resume UI (DASH-HTTP-008).
