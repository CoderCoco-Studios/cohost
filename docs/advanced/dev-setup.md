---
title: Developer setup
description: The workspace layout, the build (native bus addon first, then tsc), and the Docker-free loop for working on one service at a time.
track: advanced
verified: f126b94
---

# Developer setup

This page gets a checkout to the point where you can change a service and watch it run. You will build the workspace, start the infrastructure in [containers](../start/glossary.md#container), and run the TypeScript services straight from source with file watching.

If you only want to run the co-host, you do not need this page: the [simple track](../guide/install/prerequisites.md) installs everything with one script.

## What you need

| Need | Version | Why |
| --- | --- | --- |
| Node | 26 or newer (`engines` in `package.json`) | Runs every service and the built-in `node:test` runner |
| pnpm | 12 (`packageManager` in `package.json` pins it; Node 26 does not bundle corepack, so `npm install -g corepack && corepack enable` fetches it) | Installs the workspace |
| Rust toolchain | The exact version `rust-toolchain.toml` pins, with `rustfmt` and `clippy` | Builds the native [bus](../start/glossary.md#bus) addon |
| A C compiler | Any (`build-essential` on Debian and Ubuntu) | The Rust linker calls it |
| [Docker](../start/glossary.md#docker) | Any recent version | Runs [Redis](../start/glossary.md#redis), [Postgres](../start/glossary.md#postgres), [Ollama](../start/glossary.md#ollama) and the speech servers |

Linux x64 is the only native target: the bus addon is built for `linux-x64-gnu`, and importing `@cohost/bus` on anything else fails with an error that names the platform it looked for. On a Windows PC, work inside [WSL2](../start/glossary.md#wsl2).

`scripts/install.sh` installs all of the above on Ubuntu and Debian, including the pinned Rust toolchain through `rustup`. See [Install for real](../guide/install/real-install.md).

## The workspace

cohost is a pnpm workspace (`pnpm-workspace.yaml` lists `packages/*` and `services/*`) beside a Cargo workspace (`crates/*`).

| Path | Holds |
| --- | --- |
| `services/*` | One folder per service. Each is one `src/index.ts` that builds a `Bus` and runs on the shared runtime: `chat`, `eyes`, `ears`, `mouth`, `connector-discord`, `salience`, `affect`, `memory`, `cortex`, `voice`, `avatar`, `dashboard` |
| `packages/bus` | `@cohost/bus`: the typed bus client, the zod [event](../start/glossary.md#event) registry (`src/events.ts`) and the loader for the native addon |
| `packages/config` | `@cohost/config`: the config schema (`src/schema.ts`), the loader and the settings editor |
| `packages/control` | `@cohost/control`: the service manifest, the [Compose](../start/glossary.md#docker-compose) runtime, the stack controller, the health tracker and the `cohostctl` command |
| `packages/shared` | `@cohost/shared`: service start-up, shutdown, [heartbeats](../start/glossary.md#heartbeat), retry, the idle plan and the `control` and `inject.request` handlers every service shares |
| `packages/llm`, `modules`, `working-memory` | The model backends, the [hook](../start/glossary.md#hook) runner and the rolling prompt window |
| `packages/testing` | `@cohost/testing`: the test helpers, see [Unit-test helpers](testing/helpers.md) |
| `crates/cohost-bus`, `crates/cohost-bus-node` | The bus client in Rust, and the thin napi wrapper that Node loads |
| `config/` | `config.example.yaml`, `personality.example.md`, `expressions.example.yaml`; your own copies are git-ignored |
| `scripts/` | The installer, the dev helpers in `scripts/dev/` and the checks CI runs |
| `examples/` | Runnable examples, such as the hook server in `examples/modules/` |

## Build

```bash
pnpm install
pnpm build
```

`pnpm build` runs two steps in order. First `pnpm build:native` compiles `crates/cohost-bus-node` with `cargo build --release` and copies the result to `packages/bus/native/cohost-bus.linux-x64-gnu.node`. Then `tsc -b` compiles every package and service.

The order matters. `@cohost/bus` loads that `.node` file when it is imported and has no fallback, so any host program started before the addon exists (`pnpm dashboard`, `pnpm cohostctl`, `pnpm dev`, a test) fails at import time with a message that says to run `pnpm build:native`. The first build compiles Rust from scratch and takes a few minutes; later builds are incremental.

| Command | What it does |
| --- | --- |
| `pnpm build` | The native addon, then `tsc -b` |
| `pnpm typecheck` | `tsc -b --noEmit`; `pnpm lint` runs the same check |
| `pnpm clean` | Removes every `dist/` |
| `cargo test --workspace` | The Rust tests (CI also runs `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`) |

## The Docker-free dev loop

The infrastructure still runs in containers; the services run on your host from source.

1. Start the infrastructure only:

   ```bash
   docker compose up -d redis postgres ollama tts stt
   ```

   Compose publishes these on `127.0.0.1` at the ports the services default to: Redis on 6379, Postgres on 5432, Ollama on 11434, the [TTS](../start/glossary.md#tts) server on 8880 and the [STT](../start/glossary.md#stt) server on 8000. The [Environment and ports](reference/env.md) page lists them all.

2. Create your `.env` and let the first run seed `config/`:

   ```bash
   cp .env.example .env
   ```

   The services read `.env` from the workspace root themselves, without overriding variables already set in your shell. The first service you start copies `config/config.example.yaml`, `personality.example.md` and `expressions.example.yaml` to `config.yaml`, `personality.md` and `expressions.yaml` (all git-ignored). Config is read from the `config/` folder at the workspace root, found by walking up to `pnpm-workspace.yaml`, so it does not depend on the directory you start from. `CONFIG_DIR` and `COHOST_ENV_FILE` move them.

3. Run every service with file watching:

   ```bash
   pnpm dev
   ```

   This runs `pnpm -r --parallel --filter './services/*' dev`, which is `tsx watch src/index.ts` in each service folder. A saved change restarts that service.

4. Run the dashboard on the host in a second terminal:

   ```bash
   pnpm dashboard
   ```

   The [dashboard](../guide/operate/dashboard.md) is a host process. It builds itself, then prints the URL it listens on. Open <http://localhost:3000>.

To work on one service, start only that one, from the workspace root:

```bash
pnpm --filter @cohost/salience dev
```

A service whose outside dependency is missing idles instead of exiting, so you can start any subset. Which backends can be replaced by stand-ins is on [One service on its own](testing/isolated.md); with `LLM_PROVIDER=mock`, `MEMORY_STORE=memory` and `MEMORY_EMBEDDER=hash` in your `.env` you can work on the brain with no model server and no database.

::: aside
`pnpm dev` starts everything at once, including services you have no account for. They sulk in "degraded" and the rest carry on, which is more than I can say for most group projects.
:::

## Adding or changing a service

Every service meets the same four obligations (the [module contract](https://github.com/CoderCoco-Studios/cohost/blob/main/docs/intent/module-contract/module-contract-design.md)): it is configurable from the dashboard, operable on its own, injectable with a test input, and built on the shared runtime. A service declares how it meets them in one entry of `packages/control/src/manifest.ts`, and the dashboard and `cohostctl` read that entry. See [Ways to extend cohost](extend/index.md) for the routes that are supported.

## Checks before you push

| Command | What it checks |
| --- | --- |
| `pnpm test` | Builds, then runs every test; see [Running the tests](testing/index.md) |
| `node scripts/lid-check.mjs` | Every `@spec` ID in code and tests exists and is defined once |
| `pnpm docs:build` | The documentation site, including its link and fact checks |

Changes flow through the specs first: [How specs work](../project/spec-driven.md) explains the order.
