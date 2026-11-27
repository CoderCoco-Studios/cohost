---
title: Developer setup
description: What a host needs (mise and the system prerequisites), the workspace layout, the build, and the Docker-free loop for working on one service at a time.
track: advanced
verified: f126b94
---

# Developer setup

This page gets a checkout to the point where you can change a service and watch it run. You will install the toolchains, build the workspace, start the infrastructure in [containers](../start/glossary.md#container), and run the TypeScript services on your host, rebuilt and restarted on every saved change.

If you only want to run the co-host, you do not need this page: the [simple track](../guide/install/prerequisites.md) installs everything with one script.

## What you need

A host needs [mise](https://mise.jdx.dev/) and these system prerequisites, nothing more:

| Need | Why |
| --- | --- |
| mise | Installs the project's toolchains and runs every command as a task |
| [Docker](../start/glossary.md#docker) with the Compose plugin (Docker Desktop on WSL2) | Runs [Redis](../start/glossary.md#redis), [Postgres](../start/glossary.md#postgres), [Ollama](../start/glossary.md#ollama) and the speech servers |
| The NVIDIA driver and the NVIDIA container toolkit | Only for a [GPU](../start/glossary.md#gpu), which the containers reach through them |
| `git` and `curl` | Fetch the repository and the downloads |

Node, pnpm, Rust, Zig and Python come from the checkout's `mise.toml` through `mise install`, into mise's own data directory, so they never change a Node or Rust you installed yourself. Install no Node, pnpm, Rust or C toolchain of your own for cohost: Zig from `mise.toml` compiles and links the native code. `mise run doctor` checks the system prerequisites and prints one line per check, with the command that fixes each one that fails.

```bash
mise install
mise run doctor
```

Linux x64 is the only native target: the bus addon is built for `linux-x64-gnu`, and importing `@cohost/bus` on anything else fails with an error that names the platform it looked for. On a Windows PC, work inside [WSL2](../start/glossary.md#wsl2).

`scripts/install.sh` installs mise and the system prerequisites on Ubuntu and Debian. See [Install for real](../guide/install/real-install.md).

## The workspace

cohost is a pnpm workspace (`pnpm-workspace.yaml` lists `packages/*` and `services/*`) beside a Cargo workspace (`crates/*`). Every command is a task in the root `mise.toml`, run as `mise run <task>`; the [Commands](reference/commands.md) page lists them all. Adding or removing a dependency is the one exception: run `pnpm add` or `pnpm remove` for a workspace package, and `cargo add` or `cargo remove` for a crate.

| Path | Holds |
| --- | --- |
| `services/*` | One folder per service. Each is one `src/index.ts` that builds a `Bus` and runs on the shared runtime: `chat`, `eyes`, `ears`, `mouth`, `connector-discord`, `salience`, `affect`, `memory`, `cortex`, `tools`, `voice`, `avatar`, `dashboard` |
| `packages/bus` | `@cohost/bus`: the typed bus client, the zod [event](../start/glossary.md#event) registry (`src/events.ts`) and the loader for the native addon |
| `packages/config` | `@cohost/config`: the config schema (`src/schema.ts`), the loader and the settings editor |
| `packages/control` | `@cohost/control`: the service manifest, the [Compose](../start/glossary.md#docker-compose) runtime, the stack controller, the health tracker and the `cohostctl` command |
| `packages/shared` | `@cohost/shared`: service start-up, shutdown, [heartbeats](../start/glossary.md#heartbeat), retry, the idle plan and the `control` and `inject.request` handlers every service shares |
| `packages/llm`, `modules`, `working-memory` | The model backends, the [hook](../start/glossary.md#hook) runner and the rolling prompt window |
| `packages/testing` | `@cohost/testing`: the test helpers, see [Unit-test helpers](testing/helpers.md) |
| `crates/cohost-bus`, `crates/cohost-bus-node` | The [bus](../start/glossary.md#bus) client in Rust, and the thin napi wrapper that Node loads |
| `config/` | `config.example.yaml`, `personality.example.md`, `expressions.example.yaml`; your own copies are git-ignored |
| `scripts/` | The installer, the programs behind the developer tasks in `scripts/dev/` and the checks CI runs |
| `examples/` | Runnable examples, such as the hook server in `examples/modules/`, each run through an `example:*` task |
| `mise.toml` | The toolchains and every task |

## Build

```bash
mise run build
```

`mise run build` runs three tasks. `build:native` compiles `crates/cohost-bus-node` with `cargo build --release` and copies the result to `packages/bus/native/cohost-bus.linux-x64-gnu.node`. `build:ts` installs the workspace's dependencies (the `install` task) and compiles every package and service with `tsc -b`. `build:ui` builds the dashboard's web UI.

You never run a separate addon build before a host program. `@cohost/bus` loads that `.node` file when it is imported and has no fallback, so every task that starts a host program (`dashboard`, `cohostctl`, `dev` and each `dev:<service>`, the memory passes, the `bus:*` tools and `test`) depends on `build:native` and builds the addon first. `build:native` is skipped while no Rust source changed, so it costs one cargo build after a Rust change and nothing otherwise. The first build compiles Rust from scratch and takes a few minutes.

| Command | What it does |
| --- | --- |
| `mise run build` | The native addon, the TypeScript workspace and the dashboard UI |
| `mise run typecheck` | `tsc -b`, which type-checks every project and writes the build output, then the dashboard UI's type check, then the type check of every test directory |
| `mise run lint` | The type check and oxlint's type-aware rules (`.oxlintrc.json`), then `cargo fmt --check` and Clippy; any finding fails it |
| `mise run test:rust` | The Rust tests |
| `mise run clean` | Removes every `dist/` |

## The Docker-free dev loop

The infrastructure runs in containers; the services run on your host and are rebuilt and restarted when you save a change.

1. Start the infrastructure only:

   ```bash
   mise run infra:up
   ```

   This runs `docker compose up -d redis postgres ollama tts stt`, which starts the containers `redis`, `postgres`, `ollama`, `tts` and `stt`. Compose publishes them on `127.0.0.1` at the ports the services default to: Redis on 6379, Postgres on 5432, Ollama on 11434, the [TTS](../start/glossary.md#tts) server on 8880 and the [STT](../start/glossary.md#stt) server on 8000. The [Environment and ports](reference/env.md) page lists them all. `mise run infra:down` stops them.

2. Create your `.env` and let the first run seed `config/`:

   ```bash
   cp .env.example .env
   ```

   The services read `.env` from the workspace root themselves, without overriding variables already set in your shell. The first service you start copies `config/config.example.yaml`, `personality.example.md` and `expressions.example.yaml` to `config.yaml`, `personality.md` and `expressions.yaml` (all git-ignored). Operator settings are literal keys in `config.yaml`. Credentials go only in `secrets/secrets.yaml`, which you copy from `config/secrets.example.yaml` (`./scripts/install.sh` does that for you); it is git-ignored too. Services you run on your machine read the whole `secrets/secrets.yaml`. Config is read from the `config/` and `secrets/` folders at the workspace root, found by walking up to `pnpm-workspace.yaml`, so it does not depend on the directory you start from. `CONFIG_DIR` moves `config/`, `COHOST_ENV_FILE` moves `.env` and `COHOST_SECRETS_FILE` moves `secrets/secrets.yaml`.

3. Run every service:

   ```bash
   mise run dev
   ```

   This is one `mise watch --restart` over every `dev:<service>` task, each of which runs its service's built `dist/index.js`. A saved change under a service's `src/` or any package's `src/` rebuilds what changed (`build:ts`, and `build:native` after a Rust change) and restarts the services.

   mise puts each task's name in front of its lines, so a log line reads `[dev:chat] 14:03:22.519 INFO  chat: joined channel channel=cocostream`, and the indented lines below an entry (the rest of a long message, an error's stack) carry the same prefix. Each service also writes its full log, one JSON line per entry, to `data/logs/<service>.log` in the checkout (`$COHOST_DATA_DIR/logs` when you set that variable). `logging.level: debug` in `config/config.yaml` shows more; `logging.terminal: json` prints the raw JSON lines instead.

4. Run the dashboard on the host in a second terminal:

   ```bash
   mise run dashboard
   ```

   The [dashboard](../guide/operate/dashboard.md) is a host process. It builds itself, then prints the URL it listens on. Open <http://localhost:3000> (the port is `dashboard.port` in `config.yaml`).

To work on one service, start only that one:

```bash
mise watch --restart dev:salience
```

`mise run dev:salience` starts it once, without watching. A service whose outside dependency is missing idles instead of exiting, so you can start any subset. Which backends can be replaced by stand-ins is on [One service on its own](testing/isolated.md); with `llm.provider: mock`, `brain.memory.store: memory` and `brain.memory.embedder: hash` in your `config/config.yaml` (or `COHOST_ISOLATION='{"LLM_PROVIDER":"mock","MEMORY_STORE":"memory","MEMORY_EMBEDDER":"hash"}'` in the shell) you can work on the brain with no model server and no database.

::: aside
`mise run dev` starts everything at once, including services you have no account for. They sulk in "degraded" and the rest carry on, which is more than I can say for most group projects.
:::

## Adding or changing a service

Every service meets the same four obligations (the [module contract](https://github.com/CoderCoco-Studios/cohost/blob/main/docs/intent/module-contract/module-contract-design.md)): it is configurable from the dashboard, operable on its own, injectable with a test input, and built on the shared runtime. A service declares how it meets them in one entry of `packages/control/src/manifest.ts` and one of `packages/config/src/units.ts` (the settings it reads), and the dashboard and `cohostctl` read those entries. See [Ways to extend cohost](extend/index.md) for the routes that are supported.

## Checks before you push

| Command | What it checks |
| --- | --- |
| `mise run test` | The Rust tests, the build, then every TypeScript test; see [Running the tests](testing/index.md) |
| `mise run lint` | The type check, oxlint, `cargo fmt --check` and Clippy; a warning fails it like an error |
| `mise run lid-check` | Every `@spec` ID in code and tests exists and is defined once |
| `mise run docs:build` | The documentation site, including its link and fact checks |

The TypeScript lint rules are in `.oxlintrc.json` at the repository root. A rule that is wrong for the project is turned off there, with a comment giving the reason; a single line that is a real exception gets `// oxlint-disable-next-line <rule> -- <reason>` above it.

Changes flow through the specs first: [How specs work](../project/spec-driven.md) explains the order.
