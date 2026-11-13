# Live verification: README quickstart and the module contract

Run 2026-11-11 on WSL2 (Ubuntu) with Docker Desktop 29.9.2 driven through `docker.exe` (`COHOST_DOCKER_BIN=docker.exe`),
mock mode, no Twitch, Discord, OBS, avatar app, GPU or API key. Evidence is the output of the commands below; the
secret values in `.env` were never printed.

## Setup

`.env` copied from the owner's local `.env`, then appended with the README quickstart mock block and the WSL2 notes:

```
COHOST_DOCKER_BIN=docker.exe
LLM_PROVIDER=mock  MEMORY_STORE=memory  MEMORY_EMBEDDER=hash  VOICE_ENGINE=stub  CHAT_SOURCE=fake  (AVATAR_DRIVER=null already)
EARS_SOURCES=[]  EARS_STT_ENGINE=stub  MOUTH_DISCORD_ENABLED=false  MOUTH_DRYRUN_ENABLED=true
VISION_ENABLED=false  VISION_ENGINE=stub  COMPOSE_PROFILES=eyes,ears,mouth
LLM_MODEL=VISION_MODEL=NOTES_MODEL=qwen2.5:0.5b-instruct   # about 0.7 GB pulled by `models` instead of several GB
```

- `docker.exe info` shows an `nvidia` runtime; the GPU overlay was not used (mock needs none).
- Pulls that were unavoidable: the pinned infra images (ollama 0.40.16, kokoro-fastapi-cpu v0.10.0, speaches 0.8.3-cpu,
  redis, postgres, curl) through `docker compose pull`, and the three small Ollama models above through the `models` service.
- Bind mount: `docker inspect` shows `bind \\wsl.localhost\Ubuntu\home\chris\...\config -> /app/config`, and
  `docker.exe exec c1-shared-salience-1 ls -la /app/config` lists `config.yaml`, `personality.md`, `expressions.yaml`.
  The `\\wsl.localhost` path that CTRL-STACK-012 describes works as written; no workaround was needed.

## Launch (README quickstart)

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
with an empty body as the page's Apply sends, `POST /inject/*`), observing events with `redis-cli XRANGE cohost:events`.
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

Pause and resume (`POST /control`, 204 each; heartbeat `detail` read from `GET /services` 8 s later):

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
   the mock-mode eyes/ears/mouth must have their presets in `.env`, as the README says; with them in `.env` all
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
