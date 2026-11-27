---
title: Commands
description: The project's mise tasks, the settings tasks, every cohostctl command, and the Docker Compose profiles and one-shot jobs.
track: advanced
verified: a86e930
---

# Commands

Three families of commands: the tasks in the root `mise.toml`, `cohostctl` (a command-line twin of the dashboard's stack controls), and the `docker compose` profiles and one-shot jobs that both of them drive. Run everything from the repository root.

## mise tasks

Every command of the project is a task in `mise.toml`, run as `mise run <task>`. A task runs what it needs first (its `depends`), and a task with `sources` and `outputs` is skipped while nothing it reads has changed, so no command has a manual first step. `mise run --force <task>` runs a task and its dependencies regardless. Arguments after the task name reach the program the task runs:

```bash
mise run cohostctl -- status
mise run bus:tail -- --replay 20
```

Adding or removing a dependency is the one thing that is not a task: run `pnpm add` or `pnpm remove` for a workspace package, and `cargo add` or `cargo remove` for a crate. `mise tasks` lists every task with its description.

### Install and build

| Task | What it does |
| --- | --- |
| `install` | `pnpm install --frozen-lockfile`; skipped while `pnpm-lock.yaml` and the `package.json` files are unchanged |
| `build:native` | Builds `crates/cohost-bus-node` with `cargo build --release` and copies the library to `packages/bus/native/cohost-bus.linux-x64-gnu.node`. `@cohost/bus` cannot be imported without it, so every task that starts a host program depends on it. Skipped while no Rust source changed |
| `build:ts` | `install`, then `tsc -b`: every package and service, incrementally |
| `build:ui` | `build:ts` (the UI imports `@cohost/shared/head-rotation`, which resolves to the built `packages/shared/dist/`), then the dashboard's web UI into `services/dashboard/dist-ui/`; skipped while `services/dashboard/ui` and `packages/shared/src` are unchanged |
| `build` | `build:native`, `build:ts` and `build:ui` |
| `clean` | Removes every `dist/` and `services/dashboard/dist-ui` |

### Lint and test

| Task | What it does |
| --- | --- |
| `typecheck` | `tsc -b`, which type-checks every project and writes the build output, then the dashboard UI's type check, then the type check of every test directory |
| `lint:ts` | `typecheck`, then `oxlint --type-aware --deny-warnings` with the rules in `.oxlintrc.json`; any finding fails it |
| `lint:rust` | `cargo fmt --check`, then Clippy over the workspace with warnings denied |
| `lint` | `lint:ts` and `lint:rust` |
| `test:rust` | `cargo test --workspace`, then the desktop audio helper's Windows check |
| `test` | `test:rust` and `build`, then every `test/*.test.ts` under `packages/*` and `services/*` (and the dashboard UI's `.test.tsx` files) with Node's runner through `tsx` |
| `test:only` | The same TypeScript tests with no build first |
| `test:file` | Builds, then runs the test files given after the task name (`mise run test:file -- services/voice/test/wav.test.ts`); runner flags such as `--test-name-pattern` go before the files |
| `test:launch` | `build` and `doctor:docker`, then the launch end-to-end test against Docker |
| `test:rust-example` | The Rust bus example's round trip against Redis; fails when the round trip is skipped |
| `lid-check` | Every `@spec` ID in code and tests exists and is defined once |
| `cla` | The `cla` workflow's CLA signature check; it needs the workflow's event and `GITHUB_TOKEN`, so it does not run locally |
| `smoke` | `doctor:docker`, then builds the service images and checks that a few services come up healthy in Compose |

### Run on the host

| Task | What it does |
| --- | --- |
| `dashboard` | Rebuilds the documentation site when the docs changed (`docs:build`), then builds `services/dashboard` and runs it on the host, so the docs it serves match your checkout. If the docs build fails, it says so and the dashboard still starts, without fresh docs; only a failed dashboard build stops it. It refuses to start while the settings store holds no control token (set one with `mise run config:token`) or while `.env` or its environment defines `CONTROL_TOKEN`. At start it prints a one-time unlock link to the terminal (`Unlock this browser: http://127.0.0.1:3000/unlock?n=...`), delivers credentials to every running unit that waits for them, and, when the settings store cannot be used, serves the config recovery screen instead of exiting. It is the one thing you start by hand |
| `dashboard:unlock` | Prints a fresh one-time unlock link (`http://127.0.0.1:3000/unlock?n=...`) for the running dashboard, as `mise run dashboard` prints at start. It takes the control token from `CONTROL_TOKEN` in its own environment (export it in that shell from your password manager), or else asks for it without echo; it reads `DASHBOARD_HOST` from the environment and `.env` and the port from the setting `dashboard.port` (the default when the store cannot be read), and asks the dashboard through `POST /unlock/link`. It exits 1 and says why when no token is given, the dashboard is not running at that address, or the token is refused. See [HTTP routes](http.md#dashboard-unlock) |
| `dashboard:ui` | The dashboard UI's Vite dev server |
| `cohostctl` | Builds `packages/control`, then runs `cohostctl` with the arguments after `--` (see below) |
| `reflect` | The reflection pass of `memory`, through the unit runner: appends a dated block of bullets to `## Learned` in the personality, which the runner saves to the settings store when the pass exits cleanly |
| `consolidate` | The viewer-note consolidation pass of `memory`, on the host, through the unit runner |
| `reembed` | Re-embeds every stored memory vector on the host, through the unit runner, after an embedder change |
| `deliver` | Runs `cohostctl deliver`: delivers credentials to every running unit that waits for them. After a reboot the containers wait, reporting `waiting for credentials`, until the dashboard starts or this runs |
| `infra:up` | `doctor:docker`, then `docker compose up -d redis postgres ollama tts stt`: the infrastructure for the dev loop, from [Compose](../../start/glossary.md#docker-compose) |
| `infra:down` | Stops those containers |
| `dev:<service>` | Builds what changed, then runs one service through the unit runner (`packages/control/dist/run-unit.js`), which writes the unit's projection, points `CONFIG_DIR` at it and passes the unit's credentials on a pipe (`dev:salience`, `dev:cortex`, and so on for each folder under `services/` except `dashboard`). `mise watch --restart dev:<service>` rebuilds and restarts it on every saved change |
| `dev` | Every `dev:<service>` task under one `mise watch --restart`, against the infrastructure from `infra:up`; see [Developer setup](../dev-setup.md) |

### Settings

Every task opens the [settings store](../../start/glossary.md#settings-store) and takes its arguments after `--`. The [Configuration](config.md#the-config-tasks) page describes each in full.

```bash
mise run config:set -- logging.level debug
mise run config:secret -- connections.discord.token
mise run config:key -- --show
```

| Task | What it does |
| --- | --- |
| `config:get` | Prints the effective value of a setting; a credential prints `set` or `not set` |
| `config:set` | Sets one setting: `config:set -- <path> <yaml value>` |
| `config:reset` | Removes one setting so its default applies: `config:reset -- <path>` |
| `config:secret` | Sets a credential read without echo, or clears it: `config:secret -- <path> [--clear]` |
| `config:personality` | Prints the personality, or edits it in `$EDITOR` with `--edit` |
| `config:token` | Sets the control token: a generated one, printed once, or your own with `--stdin` |
| `config:key` | The master key: `--show`, `--confirm`, `--rotate` or `--restore` |
| `config:reset-credentials` | Deletes every stored credential and generated key after a typed confirmation, and makes a new master key |
| `config:export` | Exports the settings as YAML: `config:export -- [file] [--secrets]` |
| `config:import` | Imports an export, or parts (`--settings`, `--personality`, `--expressions`, `--secrets`); `--dry-run` writes nothing |
| `config:backup` | Takes a backup of the settings store |
| `config:restore` | Restores a backup: `config:restore -- <file>` |
| `config:check` | Lists every problem that stops the settings store's use; prints `ok` when there is none |
| `config:project` | Writes every unit's projection (no credentials) under `data/projections/` |

### Developer tools

| Task | What it does |
| --- | --- |
| `bus:pub` | Publishes one zod-validated event onto the [bus](../../start/glossary.md#bus); see [Fake inputs](../testing/inject.md) |
| `bus:tail` | Prints bus events as they arrive |
| `bus:bench` | Benchmarks the bus, the TypeScript client against the native one |
| `perf:connector` | Plays a clip into `ears` as a test connector |
| `perf:baseline` | Measures the end-to-end latency baseline against the running stack |
| `stub:llm` | A stand-in for Ollama's chat API on port 11434; see [One service on its own](../testing/isolated.md) |
| `stub:tts` | A stand-in for the [Kokoro](../../start/glossary.md#kokoro) TTS server on port 8880 |
| `hooks:schemas` | Regenerates the [hook](../../start/glossary.md#hook) reply JSON Schemas in `examples/modules/schemas/` |

### Examples

Each program under `examples/` that a page tells you to run has a task; the [Extend](../extend/index.md) pages use them.

| Task | What it runs |
| --- | --- |
| `example:hook-server:py`, `example:hook-server:ts`, `example:hook-server:rust` | The example hook server on port 8900, in Python, TypeScript or Rust |
| `example:hook-try` | One request to each hook of a running hook server |
| `example:model-stub:py`, `example:model-stub:ts` | The example model server stub on port 8901 |
| `example:model-try` | The example requests against a running model server (its base URL after `--`) |
| `example:audio-send:sh`, `example:audio-send:py`, `example:audio-send:ts` | Sends a WAV clip to the `http` source of `ears` |
| `example:audio-wav:sox`, `example:audio-wav:ffmpeg` | Converts a recording to the WAV `ears` expects |
| `example:rust-bus` | The Rust bus example |
| `example:now-playing` | The example TypeScript service |
| `example:typecheck` | Type-checks the TypeScript examples |

### Docs site and host checks

| Task | What it does |
| --- | --- |
| `docs:build` | Checks and builds the documentation site; skipped while its sources are unchanged |
| `docs:dev` | Starts the documentation site's dev server |
| `docs:preview` | Serves the built site |
| `doctor` | Checks the host's system prerequisites (Docker with Compose, the NVIDIA runtime when a GPU is present, `git`, `curl`, `libatomic1`, and the glibc floor), printing the fix for each that fails; installs nothing |
| `doctor:docker`, `doctor:gpu`, `doctor:fetch`, `doctor:libatomic`, `doctor:glibc` | One of those checks each |

## cohostctl

`cohostctl` drives services through [Docker](../../start/glossary.md#docker) Compose, using the same controller as the [dashboard](../../guide/operate/dashboard.md). It runs as you, with your access to the settings store and the master key, so the control token, which gates the dashboard's HTTP routes, does not apply to it; it refuses to start anything while `.env` or its environment defines `CONTROL_TOKEN`. Before each start it writes the projections, and after it delivers the started units' credentials. It honours `CONTROL_ADVANCED` and `REDIS_URL`.

```bash
mise run cohostctl -- status
mise run cohostctl -- restart cortex --mode fresh
```

| Command | What it does |
| --- | --- |
| `status [service]` | One line per service: name, state (`up`, `degraded`, `stale`, `down`, `crash-looping` or `unknown`), mode (`live`, `mock` or `off`) and the age of its last [heartbeat](../../start/glossary.md#heartbeat) |
| `start <service> [--mode resume\|fresh] [--isolated]` | Starts one service. `fresh` resets its [consumer groups](../../start/glossary.md#consumer-group) so it ignores [events](../../start/glossary.md#event) published while it was away, and `resume` keeps its place. `--isolated` sets the isolation presets and also starts the services it needs |
| `stop <service>` | Stops one service. Takes no options |
| `restart <service> [--mode resume\|fresh] [--isolated]` | Stops and starts one service |
| `latency [--count N]` | Per-stage p50 and p95 latency of the speech and vision paths, from the last N events on the [bus](../../start/glossary.md#bus) (default 5000). Read-only. A streamed reply is one sample: `tts`, `sink` and `total` are measured on its clause 0 (the earliest non-virtual `voice.playing` with `seq` 0, else the earliest one with `seq` 0), and `llm` ends at the `brain.say`'s `llmEndedAt`. The speech path starts with `endpoint` (the end-of-speech wait, `audioEndedAt` to `closedAt`, `0` when no `closedAt`) and `stt` from `closedAt`. A reply released from a prepared think is cut at its `confirmedAt`, so its stages still add up to `total`; `think` (focus to the end of the provisional think) is printed after `total` and is not in the sum. Lines marked `interjected` or `injected` are not samples. After the speech rows, an `early transcripts:` line counts published, retracted, reused, released, interjected and still-running early transcripts (absent when all are zero), and an `early stt` row gives the count, p50 and p95 of their speech-to-text time. To measure the connector path, run `mise run perf:baseline -- --mode connector` (the default `--mode http` posts whole clips and has no `endpoint` row) |
| `consolidate` | The viewer-note consolidation one-shot. Works with the stack down. Exit 0 ok, 1 failed |
| `reembed` | Re-embeds stored memory vectors after an embedder change. Stop `memory` first. Exit 0 ok, 1 failed |
| `launch` | Builds the images, brings the whole stack up and waits until it is ready |
| `rebuild` | The same as `launch` |
| `stop-all` | Stops every [container](../../start/glossary.md#container) of the stack without removing any, then suggests `cohostctl consolidate` |
| `restart-all` | Restarts every running application service |
| `deliver` | Delivers credentials to every running unit that reports `waiting for credentials` or was started since its last delivery, printing one line per unit; exits 1 naming each unit whose delivery failed. Without Redis it warns and judges by the containers' start times alone. Also `mise run deliver` |

Exit codes: 0 for success, 1 for a failure or a refusal, 2 for a usage error. Every command except `status` and `latency` takes a lock shared with the dashboard (`data/control.lock`): while one runs an action, the other refuses with a message naming the action and who holds it, and a lock left by a crashed process is cleared automatically. `launch`, `rebuild`, `start`, `restart`, `restart-all`, `deliver`, `consolidate` and `reembed` check the settings store first and refuse, printing why and suggesting `mise run config:check`, when it cannot be used; `stop`, `stop-all`, `status` and `latency` never open it. `launch`, `rebuild`, `stop-all` and `consolidate` never open the bus, so they work when [Redis](../../start/glossary.md#redis) is stopped. Every start, stop and restart is recorded as a `service.lifecycle` event with `by` set to `cohostctl`.

## Docker Compose

`docker compose up -d` starts the core stack. The dashboard is not a Compose service: it runs on the host and its Launch button runs Compose for you, writing each unit's projection first and delivering each started unit's credentials after. A hand-run `docker compose up` or `restart` does neither: run `mise run config:project` first, and the services wait, reporting `waiting for credentials`, until the dashboard delivers them or you run `mise run deliver`.

| Profile | Services | Why it is optional |
| --- | --- | --- |
| none (always started) | `redis`, `postgres`, `ollama`, `models`, `tts`, `stt`, `chat`, `salience`, `affect`, `memory`, `cortex`, `tools`, `voice`, `avatar` | The core talking path and its infrastructure. `models` pulls the [Ollama](../../start/glossary.md#ollama) models once and exits |
| `eyes` | `eyes` | [OBS](../../start/glossary.md#obs) vision; needs `vision.enabled: true` |
| `ears` | `ears` | The listener; reads what [connectors](../../start/glossary.md#connector) publish |
| `mouth` | `mouth` | The speaker; writes the co-host's voice to its outputs |
| `discord` | `connector-discord` | The Discord connector: the one bot login, with source and [sink](../../start/glossary.md#sink) `discord` |
| `maintenance` | `consolidate`, `reembed` | One-shot jobs that never start with `up` |

```bash
docker compose --profile eyes up -d                       # add OBS vision
docker compose --profile ears --profile mouth up -d       # add the listener and the speaker
docker compose --profile discord up -d                    # add the Discord connector
docker compose up -d --build                              # everything, rebuilding the service images first
docker compose up -d chat salience affect memory cortex voice avatar   # the minimal talking path
```

Setting `COMPOSE_PROFILES=discord,ears,mouth` in `.env` keeps those profiles on across restarts and Launch; see [Environment and ports](env.md).

### One-shot jobs

Run them through `cohostctl` or the tasks, which write the projection and deliver the credentials the job waits for.

| Command | What it does |
| --- | --- |
| `mise run cohostctl -- consolidate` | The viewer-note consolidation pass in its container (`docker compose run` of the `consolidate` service), with its credentials delivered. Best-effort: `memory` catches up at its next start if you never run it. It starts `postgres` and `ollama` if they are down and leaves them running |
| `mise run cohostctl -- reembed` | Re-embeds every stored memory, viewer note and deletion record after you change the embedder to one with another vector size. `memory` refuses to start until you do, and an interrupted run changes nothing, so a rerun resumes |
| `mise run reflect` | The reflection pass, on the host through the unit runner |

### The GPU overlay

`docker-compose.gpu.yml` adds an NVIDIA device request to `ollama`, `tts` and `stt`, and switches the [TTS](../../start/glossary.md#tts) and [STT](../../start/glossary.md#stt) images to their CUDA builds. Layer it in `COMPOSE_FILE` (`docker-compose.yml:docker-compose.gpu.yml`), which the installer does when it finds a [GPU](../../start/glossary.md#gpu), or pass both files with `-f`.
