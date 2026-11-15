---
title: Commands
description: The root pnpm scripts, every cohostctl command, and the Docker Compose profiles and one-shot jobs.
track: advanced
verified: f126b94
---

# Commands

Three families of commands: the `pnpm` scripts in the root `package.json`, `cohostctl` (a command-line twin of the dashboard's stack controls), and the `docker compose` profiles and one-shot jobs that both of them drive. Run everything from the repository root.

## pnpm scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | `pnpm build:native`, then `tsc -b` |
| `pnpm build:native` | Builds `crates/cohost-bus-node` with `cargo build --release` and copies the library to `packages/bus/native/cohost-bus.linux-x64-gnu.node`. `@cohost/bus` cannot be imported without it |
| `pnpm typecheck` | `tsc -b --noEmit`. `pnpm lint` runs the same check |
| `pnpm test` | `pnpm build:native`, `tsc -b`, then every `test/*.test.ts` under `packages/*` and `services/*` with Node's runner through `tsx` |
| `pnpm test:only` | The same tests without the build |
| `pnpm dashboard` | Builds `services/dashboard`, then runs it on the host. It is the one thing you start by hand |
| `pnpm cohostctl <command>` | Builds `packages/control`, then runs `cohostctl` with your arguments (see below) |
| `pnpm dev` | Every service with `tsx watch`, against infrastructure from [Compose](../../start/glossary.md#docker-compose) |
| `pnpm reflect` | The reflection pass of `memory`: appends a dated block of bullets to `## Learned` in `personality.md` |
| `pnpm consolidate` | The viewer-note consolidation pass of `memory`, on the host |
| `pnpm reembed` | Re-embeds every stored memory vector on the host, after an embedder change |
| `pnpm docs:dev` | Starts the documentation site's dev server |
| `pnpm docs:build` | Builds the documentation site and runs its checks |
| `pnpm docs:preview` | Serves the built site |
| `pnpm clean` | Removes every `dist/` |

Other commands worth knowing, which are not `pnpm` scripts: `node scripts/lid-check.mjs` (every `@spec` ID exists and is defined once), `node scripts/gen-hook-schemas.mjs` (regenerates the [hook](../../start/glossary.md#hook) reply JSON Schemas) and `scripts/compose-smoke.sh` (builds the service images and checks they come up healthy). The dev helpers `bus-pub.ts`, `bus-tail.ts`, `stub-tts.ts` and `stub-llm.ts` are on [Fake inputs](../testing/inject.md) and [One service on its own](../testing/isolated.md).

## cohostctl

`cohostctl` drives services through [Docker](../../start/glossary.md#docker) Compose, using the same controller as the [dashboard](../../guide/operate/dashboard.md). It runs as you, so `CONTROL_ENABLED` and `CONTROL_TOKEN`, which gate the dashboard's HTTP routes, do not apply. It honours `CONTROL_ADVANCED` and `REDIS_URL`.

```bash
pnpm cohostctl status
pnpm cohostctl restart cortex --mode fresh
```

| Command | What it does |
| --- | --- |
| `status [service]` | One line per service: name, state (`up`, `degraded`, `stale`, `down`, `crash-looping` or `unknown`), mode (`live`, `mock` or `off`) and the age of its last [heartbeat](../../start/glossary.md#heartbeat) |
| `start <service> [--mode resume\|fresh] [--isolated]` | Starts one service. `fresh` resets its [consumer groups](../../start/glossary.md#consumer-group) so it ignores [events](../../start/glossary.md#event) published while it was away, and `resume` keeps its place. `--isolated` sets the isolation presets and also starts the services it needs |
| `stop <service>` | Stops one service. Takes no options |
| `restart <service> [--mode resume\|fresh] [--isolated]` | Stops and starts one service |
| `latency [--count N]` | Per-stage p50 and p95 latency of the speech and vision paths, from the last N events on the [bus](../../start/glossary.md#bus) (default 5000). Read-only |
| `consolidate` | The viewer-note consolidation one-shot. Works with the stack down. Exit 0 ok, 1 failed |
| `reembed` | Re-embeds stored memory vectors after an embedder change. Stop `memory` first. Exit 0 ok, 1 failed |
| `launch` | Builds the images, brings the whole stack up and waits until it is ready |
| `rebuild` | The same as `launch` |
| `stop-all` | Stops every [container](../../start/glossary.md#container) of the stack without removing any, then suggests `cohostctl consolidate` |
| `restart-all` | Restarts every running application service |

Exit codes: 0 for success, 1 for a failure or a refusal, 2 for a usage error. Every command except `status` and `latency` takes a lock shared with the dashboard (`data/control.lock`): while one runs an action, the other refuses with a message naming the action and who holds it, and a lock left by a crashed process is cleared automatically. `launch`, `rebuild`, `stop-all` and `consolidate` never open the bus, so they work when [Redis](../../start/glossary.md#redis) is stopped. Every start, stop and restart is recorded as a `service.lifecycle` event with `by` set to `cohostctl`.

## Docker Compose

`docker compose up -d` starts the core stack. The dashboard is not a Compose service: it runs on the host and its Launch button runs Compose for you.

| Profile | Services | Why it is optional |
| --- | --- | --- |
| none (always started) | `redis`, `postgres`, `ollama`, `models`, `tts`, `stt`, `chat`, `salience`, `affect`, `memory`, `cortex`, `voice`, `avatar` | The core talking path and its infrastructure. `models` pulls the [Ollama](../../start/glossary.md#ollama) models once and exits |
| `eyes` | `eyes` | [OBS](../../start/glossary.md#obs) vision; needs `vision.enabled: true` |
| `ears` | `ears` | The listener; reads what [connectors](../../start/glossary.md#connector) publish |
| `mouth` | `mouth` | The speaker; writes the co-host's voice to its outputs |
| `discord` | `connector-discord` | The Discord connector: the one bot login, with source and [sink](../../start/glossary.md#sink) `discord` |
| `tools` | `consolidate`, `reembed` | One-shot jobs that never start with `up` |

```bash
docker compose --profile eyes up -d                       # add OBS vision
docker compose --profile ears --profile mouth up -d       # add the listener and the speaker
docker compose --profile discord up -d                    # add the Discord connector
docker compose up -d --build                              # everything, rebuilding the service images first
docker compose up -d chat salience affect memory cortex voice avatar   # the minimal talking path
```

Setting `COMPOSE_PROFILES=discord,ears,mouth` in `.env` keeps those profiles on across restarts and Launch; see [Environment and ports](env.md).

### One-shot jobs

| Command | What it does |
| --- | --- |
| `docker compose run --rm consolidate` | The viewer-note consolidation pass, the same as `cohostctl consolidate`. Best-effort: `memory` catches up at its next start if you never run it. It starts `postgres` and `ollama` if they are down and leaves them running |
| `docker compose run --rm reembed` | Re-embeds every stored memory, viewer note and deletion record after you change the embedder to one with another vector size. `memory` refuses to start until you do, and an interrupted run changes nothing, so a rerun resumes |
| `docker compose run --rm memory node services/memory/dist/reflect.js` | The reflection pass, the same as `pnpm reflect` |

### The GPU overlay

`docker-compose.gpu.yml` adds an NVIDIA device request to `ollama`, `tts` and `stt`, and switches the [TTS](../../start/glossary.md#tts) and [STT](../../start/glossary.md#stt) images to their CUDA builds. Layer it in `COMPOSE_FILE` (`docker-compose.yml:docker-compose.gpu.yml`), which the installer does when it finds a [GPU](../../start/glossary.md#gpu), or pass both files with `-f`.
