---
title: Verification log
description: Dated records of live runs of cohost, with the commands and what they showed.
track: project
glossary-skip: [container, salience, stt, tts, affect, cortex, sink, consumer-group, docker-compose, hook, llm]
verified: f126b949cf41b503f28c7935d3c8522bb7b659d6
---

# Verification log: quickstart and the module contract

Run 2026-11-11 on [WSL2](../start/glossary.md#wsl2) (Ubuntu) with [Docker](../start/glossary.md#docker) Desktop 29.9.2 driven through `docker.exe` (`COHOST_DOCKER_BIN=docker.exe`),
[mock mode](../start/glossary.md#mock-mode), no Twitch, Discord, [OBS](../start/glossary.md#obs), avatar app, [GPU](../start/glossary.md#gpu) or API key. Evidence is the output of the commands below; the
secret values in `.env` were never printed.

## Setup

`.env` copied from the owner's local `.env`, then appended with the quickstart mock block and the WSL2 notes:

```
COHOST_DOCKER_BIN=docker.exe
LLM_PROVIDER=mock  MEMORY_STORE=memory  MEMORY_EMBEDDER=hash  VOICE_ENGINE=stub  CHAT_SOURCE=fake  (AVATAR_DRIVER=null already)
EARS_SOURCES=[]  EARS_STT_ENGINE=stub  MOUTH_DISCORD_ENABLED=false  MOUTH_DRYRUN_ENABLED=true
VISION_ENABLED=false  VISION_ENGINE=stub  COMPOSE_PROFILES=eyes,ears,mouth
LLM_MODEL=VISION_MODEL=NOTES_MODEL=qwen2.5:0.5b-instruct   # about 0.7 GB pulled by `models` instead of several GB
```

- `docker.exe info` shows an `nvidia` runtime; the GPU overlay was not used (mock needs none).
- Pulls that were unavoidable: the pinned infra images ([Ollama](../start/glossary.md#ollama) 0.40.16, [Kokoro](../start/glossary.md#kokoro) (kokoro-fastapi-cpu v0.10.0), [speaches](../start/glossary.md#speaches) 0.8.3-cpu,
  [Redis](../start/glossary.md#redis), [Postgres](../start/glossary.md#postgres), curl) through `docker compose pull`, and the three small Ollama models above through the `models` service.
- Bind mount: `docker inspect` shows `bind \\wsl.localhost\Ubuntu\home\chris\...\config -> /app/config`, and
  `docker.exe exec c1-shared-salience-1 ls -la /app/config` lists `config.yaml`, `personality.md`, `expressions.yaml`.
  The `\\wsl.localhost` path that CTRL-STACK-012 describes works as written; no workaround was needed.

## Launch (quickstart)

```
pnpm install --frozen-lockfile && pnpm build      # clean
pnpm dashboard                                    # background
curl -XPOST -H "authorization: Bearer $CONTROL_TOKEN" localhost:3000/stack/launch   -> {"ok":true,"action":"launch"}
GET /stack -> up connected  {"kind":"launch","ok":true}
```

Final `GET /stack` and `GET /services` (13 s from `launch` to `up`, images already pulled):

| container | status | health | unit | state | mode |
| --- | --- | --- | --- | --- | --- |
| redis, postgres | running | healthy | chat | up | mock |
| ollama, tts, stt | running | none | salience | up | live |
| models | exited 0 (pull success) | | affect | up | live |
| chat salience affect memory cortex voice avatar eyes ears mouth | running | healthy | memory | up | mock |
| | | | cortex | up | mock |
| | | | voice | up | mock |
| | | | avatar | up | off (null driver) |
| | | | eyes / ears | up | off |
| | | | mouth | up | mock (dryrun) |

## Module contract, per unit

Harness: a script driving only the dashboard HTTP API (`GET/PUT /config/:section` with etag, `POST /services/:id/restart`
with an empty body as the page's Apply sends, `POST /inject/*`), observing [events](../start/glossary.md#event) with `redis-cli XRANGE cohost:events`.
Each unit: PUT one literal key, GET back the new value, repeat the old etag (409), restart only that unit, compare
every other unit's `state/instance` before and after, inject, and read the answering event. Every unit showed
`other units changed (state/instance): none`.

| unit | section edited | restart (instance changes, back `up`) | injection | observed |
| --- | --- | --- | --- | --- |
| chat | chat `fake.interval_ms` 6000 to 6001, 200 | pass | `/inject/text` service level, 202 | `chat.message` injected, `inject.result ok:true` |
| eyes | vision `jpeg_quality` 71 to 72 | pass | `/inject/image`, 202 | `vision.summary "stub vision: 70 bytes"`, `inject.result ok:true` |
| ears | ears `silence_ms` 701 to 702 | pass | `/inject/audio`, 202 | `speech.heard "stub transcript (300 ms)"`, `inject.result ok:true` |
| salience | brain.salience `tick_ms` 1600 to 1601 | pass | `/inject/event chat.message`, 202 | `attention.focus` for `live_verify`, score 1.15 |
| affect | brain.affect `publish_ms` 2100 to 2101 | pass | `/inject/event chat.message` | `affect.state` cause `chat: live_verify` |
| memory | brain.memory `recall_k` 7 to 8 | pass | `/inject/event memory.recall.request` | `memory.recall.reply` id `lv-recall-1` |
| cortex | brain.cortex `fallback_ack_chance` 0.3 to 0.35 | pass | `/inject/event attention.focus` | `brain.status` thinking, `brain.say` injected, status speaking |
| voice | voice `speed` 1.1 to 1.15 | pass | `/inject/event brain.say` | `voice.utterance` id `lv-voice-1`, `audioUrl` http://voice:8700/... |
| mouth | mouth `outputs.discord.gain_db` 1 to 2 | pass | `/inject/event brain.say` | `voice.playing` sink `dryrun` |
| avatar | avatar `fps` 31 to 32 | pass | `/inject/event affect.state` angry | `avatar.state` emotion `angry` |

All 10 units: config pass, restart pass, inject pass. The table is the final complete run, made after the fixes
below; earlier partial runs hit findings 1 and 3.

Pause and resume (`POST /control`, 204 each; [heartbeat](../start/glossary.md#heartbeat) `detail` read from `GET /services` 8 s later):

```
pause salience -> detail=paused   resume salience -> detail=None
pause cortex   -> detail=paused   resume cortex   -> detail=None
pause affect   -> detail=paused   resume affect   -> detail=None
```

409 refusal (MOD-TEST-005): `POST /services/ears/stop` -> unit `down`; then
`POST /inject/audio?level=service` -> `{"ok":false,"detail":"service not running: ears"} -> HTTP 409`; `start` brought it back `up`.

## Findings and fixes

1. **Isolation presets never reached a `docker.exe` start (bug, fixed, CTRL-RUNTIME-012).** After an isolated start of
   `ears` and `mouth` the containers still had `EARS_SOURCES=`, `MOUTH_DISCORD_ENABLED=` empty and ran `degraded`
   (`EARS_DISCORD_TOKEN is not set`). WSL interop passes only the variables named in `WSLENV` to a Windows process, so
   the preset set on the `docker compose` environment (CTRL-RUNTIME-009) was dropped. Fix: `dockerEnv` in
   `packages/control/src/docker.ts` appends the preset names to `WSLENV` when the binary ends in `.exe`; spec
   CTRL-RUNTIME-012, test `packages/control/test/runtime.test.ts`. Re-verified: the recreated containers show
   `EARS_SOURCES=[]`, `EARS_STT_ENGINE=stub`, `MOUTH_DRYRUN_ENABLED=true`, `MOUTH_DISCORD_ENABLED=false`, and the
   units report `up`.
2. **A plain restart drops an isolated start (by design, documented).** `POST /services/ears/restart` with no body after an
   *isolated* start recreated the container without the preset (`ears degraded`). The page's Apply sends no body, so
   the mock-mode eyes/ears/mouth must have their presets in `.env`, as the Install pages say; with them in `.env` all
   three passed restart. No change.
3. **Upload fetch from eyes/ears (resolved).** With the default `host.docker.internal:3001` the injected image and audio failed
   (`inject.result ok:false "TypeError: fetch failed"`, ECONNREFUSED 192.168.65.254:3001), and on WSL NAT the Hyper-V firewall
   blocks inbound connections from containers altogether. Fixed by carrying uploads over Redis (dashboard DASH-INJ-005,
   shared-runtime SHARED-INJ-005): the dashboard stores the bytes in `cohost:upload:<id>` and the service takes them, so no host
   network path is involved.
4. The stack's `up -d` of the three profile units only happens with `COMPOSE_PROFILES` in `.env`; launching without it
   leaves eyes, ears and mouth `unknown` until started from the Services tab.

## Specs

| spec | result |
| --- | --- |
| CTRL-STACK-015 | `COHOST_DOCKER_BIN=docker.exe node --import tsx --test packages/control/test/launch.e2e.test.ts` -> pass 1, fail 0, 4.5 s. Now `[x]`. |
| DEPLOY-CI-007 | the `compose-smoke` workflow already runs that test; the precondition (a pass on a Docker host) is met. Now `[x]`. |
| MOD-TEST-007 | new `services/dashboard/test/live-stack.e2e.test.ts` (`@spec MOD-TEST-007`): starts a dashboard, launches the stack if it is not up, waits for every unit `up`, injects into all ten units and asserts each answering event. Run with `COHOST_LIVE_STACK=1` and the `.env` exported: pass 1, fail 0 (32 s). Skips otherwise. Now `[x]`. |

## Cleanup

`docker.exe compose stop` (the dashboard was already stopped by the final test run); no container or dashboard process remains. Containers, volumes and images remain
(Docker Desktop) for the next run; `docker.exe compose down -v` removes the volumes.

## Docs site theme review (2026-11-15)

Run against commit `f126b949cf41b503f28c7935d3c8522bb7b659d6` (the base on `main`) plus the uncommitted theme work of the `docs/site-theme` branch (DOCS-THEME-049). The site was built with `npx vitepress build docs` and served with `npx vitepress preview docs --port 4173`. Headless Chrome was driven over its debugging protocol, which set the colour scheme, the reduced-motion setting and print media and took the screenshots; the screenshots were read by eye.

### What was reviewed

| Check | How | Result |
| --- | --- | --- |
| Horizontal page scroll at 360px | `scrollWidth` minus `clientWidth` of the page on all seven pages, in light and dark | 0 on every page, after the fixes below |
| Dark mode | `prefers-color-scheme: dark` emulated; the page's `<html>` carried the `dark` class in every dark shot | Confirmed, and the dark screenshots show the plum palette |
| Pages, 1280px and 360px, light and dark | Home, Try it with no accounts (a Simple step page), the glossary, the Configuration reference (a wide table), System Design (the diagram), the `affect` segment page, and a missing address (the 404 page) | All 28 shots were taken; the ones read by eye are listed under the table |
| Diagram legibility | System Design at 1280px, scrolled to the diagram | The diagram is drawn at its natural 1770px width inside a figure that scrolls on its own; labels are readable and the page does not scroll |
| Wide table | The Configuration reference at 360px (dark) and 1280px (light) | The table scrolls inside its own wrapper at 360px; at 1280px every column is readable |
| Print | Print media at 800px wide on the Try it with no accounts page | Nav, sidebar, outline and pager are gone; the track badge prints; the light palette is used |
| Keyboard | Nine Tab presses on the Try it with no accounts page at 1280px | The focused element (a nav link) had a 2px solid outline in the focus colour |
| Reduced motion | `prefers-reduced-motion: reduce` emulated on the home page; the shot was taken | See "Not reviewed" |

Read by eye: home at 1280px light and dark and at 360px light; Try it with no accounts at 1280px light and in print; System Design's diagram at 1280px light; the Configuration reference table at 360px dark and 1280px light; the `affect` page at 360px light; the 404 page at 360px dark (before and after the fix).

### Defects found and fixed

1. **Wide diagrams were illegible.** The System Design diagram (1770px wide) was drawn at the column width, which made its labels about 5px tall. The theme now draws a diagram at its natural width inside a figure with `overflow-x: auto` (DOCS-THEME-031).
2. **The 404 page had no side gutter at 360px.** The co-host bubble touched the screen edges and the text ran to them. The page now has a 16px side padding.
3. **The 404 page's links looked like plain text.** They are now in the link colour and underlined, with the hover colour on hover.
4. **The outline aside could still show in print.** VitePress's own rule for `.VPDocAside` outranked the print override at some widths, so the printed output depends on its container `.aside` also being hidden. `.VPDoc .aside` is now hidden in print too (DOCS-THEME-046).

### Not reviewed

- Every shot not listed under "Read by eye", among them the glossary at both widths and the System Design page at 360px, was checked for page scroll and the dark class by script only.
- The reduced-motion home shot was taken but not read, so the talking mark's animation (DOCS-THEME-036) was not watched in a live browser; it rests on the docs check's CSS rules.
- Print was checked with emulated print media at one width, not in a browser's print preview dialog and not as a PDF. The printed URL after each external link (DOCS-THEME-054) was not looked for.
- Tabbing went through nine stops on one page. Focus outlines on every other kind of element (cards, buttons, the diagram figure, the search box) were not walked through.
- The mark's three expressions were seen at hero size (talking) and 404 size (lost) and in the nav (idle); the favicon file was not opened in a browser tab.
- Only Chrome was used. No Firefox or Safari, no real phone.

## Dashboard serves the docs, end to end (2026-11-15)

Run against commit `f126b949cf41b503f28c7935d3c8522bb7b659d6` (the base on `main`) plus the uncommitted work of the `docs/dashboard-docs` branch (DASH-DOCS-001 to 014, DASH-UI-024, 025, DEPLOY-HOST-001, 006, DOCS-LIVE-001 to 013). There was no Redis and no Docker on the machine, so the [bus](../start/glossary.md#bus) connection was refused and the stack pill read `docker unavailable`; every service was therefore `unknown`.

| Check | How | Result |
| --- | --- | --- |
| The real script | `PORT=47311 DASHBOARD_LAN_PORT=47312 pnpm dashboard` | The script ran `pnpm docs:build` first (docs check source pass, `vitepress build`, `docs-check --dist`, 0 problems), then built and started the dashboard, which listened. |
| Docs served | `GET /cohost/guide/operate/health` on the full-surface port | 200. |
| Live table | Headless Chrome at 1280px loaded the Service health page; the page's network log showed one request, to `http://127.0.0.1:47311/services` | The status line read "Live from your dashboard." under the caption "Your services right now, from your dashboard"; the table listed all 11 services, each `unknown`, with `needs <service> (unknown)` lines under the services that have dependencies and "never" and 0 in the heartbeat and restart columns. The screenshot was read by eye. |
| Dashboard page | `/` at 1280px, then the Services tab | The header holds a `docs` link to `/cohost/` after the `settings` tab; the Services tab shows `how to read this` beside its heading, linking to `/cohost/guide/operate/health#the-states`. Both screenshots were read by eye. |
| Not built | `docs/.vitepress/dist` was renamed away while the dashboard ran, then restored | `GET /cohost/` answered 503 with the "Docs not built" page naming `pnpm docs:build`; after the restore it answered 200. |

Screenshots are in the session scratchpad and are not committed.

### Not checked

- A live table with real states: with no bus, every service was `unknown`, so the `down` and `stale` rows, the failure-after-success note and the refresh interval were exercised only by the unit tests.
- The `pnpm dashboard` stderr notice after a failed docs build was not run for real; the script's text and a stubbed run are covered by `services/dashboard/test/docs-script.test.ts`.
- The LAN listener (port 47312) was not requested for a docs path; it is covered by `services/dashboard/test/host-docs.test.ts`.
- Only Chrome, only at 1280px, only the dark dashboard page.

## Extension guides and their examples (2026-11-15)

Run against commit `f126b949cf41b503f28c7935d3c8522bb7b659d6` (the base on `main`) plus the uncommitted work of the `docs/extension-guides` branch (DOCS-GUIDE-001 to 026, DOCS-EX-002, 005, DOCS-PAGE-006, and the example specs HOOK-EX-011 to 019, LLM-EX-001 to 006, EARS-EX-001 to 007, AVATAR-EX-001 to 004, MOD-EX-001 to 005, BUS-NAT-EX-001). There was no [Redis](../start/glossary.md#redis), no Docker and no `ffmpeg` on the machine.

| Check | How | Result |
| --- | --- | --- |
| Docs check | `node scripts/docs-check.mjs`, then `npx vitepress build docs && node scripts/docs-check.mjs --dist` | 0 problems for the source pass and for the built site; the build completed. |
| Example tests | `node --import tsx --test` over `packages/modules/test`, `packages/llm/test/example-stub.test.ts`, `services/ears/test/example-clients.test.ts`, `services/avatar/test/example-driver.test.ts`, `packages/testing/test/example-service.test.ts`, `packages/bus/test/example-rust-bus.test.ts` and the two docs-check test files | 267 tests, 266 passed, 0 failed, 1 skipped (the `ffmpeg` converter). |
| Whole suite | `pnpm test:only` after `pnpm build` | 2298 tests, 2267 passed, 0 failed, 31 skipped. |
| Types | `pnpm build` (`tsc -b`) and `npx tsc -p examples/tsconfig.json --noEmit` | Both clean. |
| Servers and scripts | The tests start the Python, TypeScript and Rust hook servers, both model stubs and the `ears` listener, and run `try.sh`, `send.sh`, the Python and TypeScript clients and the `sox` converter against them | Passed. |
| Rust examples build | `cargo test --manifest-path examples/Cargo.toml -p cohost-example-bus` | Compiled; the one round-trip test printed `SKIP` and passed without Redis, so it checked nothing. |
| Mutation check | A stub's reply text, `send.sh`'s HTTP method and the shout hook's validator were each broken, the matching test file run, then the file restored | Each test file failed (3, 3 and 1 tests); restored, they pass. |

### Not checked

- The Rust bus example at run time: its heartbeat, consumer group, `<type> from <source>` lines and the `stopping` heartbeat (BUS-NAT-EX-002 to 005) need Redis and have not run. Those specs stay open; CI's `test.yml` provides Redis.
- `to-wav-ffmpeg.sh` (EARS-EX-007's `ffmpeg` half): the test skips where `ffmpeg` is absent.
- No page was walked end to end on a real stack. The dashboard Services tab was not viewed with the example service, the Rust program, the avatar driver or a hook server running, so what the pages say about the Services tab comes from reading `packages/control/src/health.ts`, `packages/modules/src/index.ts` and `services/dashboard/public/index.html`: a running service shows as `up` or `degraded`, a stopped one as `down`, and a hook shows as `hook.<name>` in the deps column only for the kinds `http` and `llm`.
- The avatar driver was run against a UDP socket in a test, not against an avatar app. The three registration edits the page describes were not made and run.
- The service example's three-file module registration (folder, manifest entry, Compose service) was described from the existing services and not built.
- The model-server page's `llm` settings were checked against the provider code and the stub, not against vLLM, llama.cpp or OpenRouter.

## Rust bus example round trip against Redis (2026-11-23)

Run in CI (`test.yml`, job `test`, which has a Redis service and a job-wide `REDIS_URL`) on pull request 247, issue 229.

| Check | How | Result |
| --- | --- | --- |
| Round trip | `cargo test --manifest-path examples/Cargo.toml -p cohost-example-bus -- --nocapture`, in its own `test.yml` step | GitHub Actions run 45095337667: `RAN round_trip against redis://127.0.0.1:6379`, the test `heartbeats_reads_by_envelope_and_stops_with_a_stopping_heartbeat ... ok`, no `SKIP` line. |
| Same, at head `65aeab0` | the same step | Run 45096011116: `test` job passed. |
| Hardened guard, head `e961447` | the same step with `pipefail` and an explicit `exit 1` on a `SKIP` line | Run 45096715521: `RAN round_trip against redis://127.0.0.1:6379` in that step and again under `pnpm test`; `test` job passed. |
| Skip guard | the test run with `REDIS_URL=redis://127.0.0.1:1` locally | The test fails ("refusing to skip the round trip") rather than skipping. |
| Under `pnpm test` | `example-rust-bus.test.ts` with `REDIS_URL` set | Passed in the same runs: it requires the `RAN` line and no `SKIP`. |

BUS-NAT-EX-002 to 005 are verified by these runs.
