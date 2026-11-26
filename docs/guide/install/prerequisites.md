---
title: What you need
description: The computer, operating system, system prerequisites and optional accounts cohost needs, and what the installer puts on your machine for you.
track: simple
---

# What you need

Before you install anything, check that your machine and your accounts line up with this page. It is short, and it will save you an evening.

## The machine

| Need | Details |
| --- | --- |
| A 64-bit Linux system | Ubuntu or Debian is what cohost is tested on and what the installer is written for. The build step produces a Linux x64 file, so macOS and native Windows are out. |
| Or Windows with [WSL2](../../start/glossary.md#wsl2) | WSL2 is a real Linux that runs inside Windows. Install an Ubuntu distribution in it and do everything below inside that distribution. |
| Disk space | Room for several gigabytes of downloads. The first start pulls the infrastructure images and the language, vision and [embedding](../../start/glossary.md#embedding) models, even in the no-accounts try-out. |
| An NVIDIA graphics card (optional) | A [GPU](../../start/glossary.md#gpu) makes the models much faster. Without one the installer warns you and cohost runs on the processor, slowly but correctly. |

::: aside
I run best with a graphics card. I run adequately without one. I am very good at pretending the pause is a dramatic beat.
:::

On WSL2 the GPU comes from the normal NVIDIA Windows driver, which exposes it to Linux. You do not install a GPU driver inside Linux. The installer only adds the container toolkit.

## The tools

Your machine needs only a few things of its own, the system prerequisites. Everything else comes from the project.

| Tool | Why cohost needs it |
| --- | --- |
| [mise](https://mise.jdx.dev/) | The tool manager and task runner. It installs the exact versions of Node, pnpm, Rust, Zig and Python that `mise.toml` names, for this project only, with `mise install`, and every cohost command is a mise task: `mise run <task>`. The installer installs it for you. |
| [Docker](../../start/glossary.md#docker) with the Compose plugin | Almost every cohost service runs in a [container](../../start/glossary.md#container). Docker runs them and [Docker Compose](../../start/glossary.md#docker-compose) starts the whole set. On WSL2 you can use Docker Desktop for Windows with its WSL integration turned on for your distribution, or Docker installed inside the distribution. |
| The NVIDIA driver and container toolkit | Only if you have an NVIDIA GPU: the driver runs the card and the toolkit lets containers use it. |
| `git` and `curl` | To get the code and to download mise. |

Node, pnpm, Rust, Zig and Python come from `mise.toml` through `mise install`; `mise run doctor` checks the rest and prints the command that fixes anything missing. Install no Node, pnpm, Rust or C toolchain of your own: the project's versions live in their own directory and never touch, or depend on, any you already have.

cohost's connection to the shared message channel (the [bus](../../start/glossary.md#bus)) is a small compiled program. You never build it as a separate step: every task that starts a program on your machine (the dashboard, `cohostctl`, the development loop) builds it first when it is missing or out of date.

## What the installer does

`scripts/install.sh` is the one script that sets up an Ubuntu, Debian or WSL2 machine. In order, it:

1. Detects WSL2 and whether you have an NVIDIA GPU.
2. Installs Docker if it is missing. If it had to install Docker, it stops and asks you to log out and back in, then run it again.
3. Installs the NVIDIA container toolkit when it finds a GPU.
4. Installs `curl`, `gnupg` and the CA certificates if any is missing, then mise itself, to `~/.local/bin/mise`, checking its signature and checksum.
5. Runs `mise install`, which installs the project's Node, pnpm, Rust, Zig and Python, and adds the mise activate line to your shell's startup file so a new terminal has them.
6. Creates `.env` from `.env.example`, creates your personal files in `config/` (`config.yaml`, `personality.md` and `expressions.yaml`) and your credentials file `secrets/secrets.yaml`, switches on the GPU settings if there is a GPU, and fills in the dashboard's control token.
7. Runs `mise run build` (the packages, the bus connection, the code and the dashboard page), then `mise run secrets:project`, which copies each service's credentials from `secrets/secrets.yaml` into its own file under `secrets/units/`, then `mise run docs:build`, which builds this documentation for the dashboard to serve.
8. Unless you pass `--no-pull`, downloads the container images and the models.
9. Starts [Redis](../../start/glossary.md#redis) and [Postgres](../../start/glossary.md#postgres) and checks they answer.
10. Prints what to do next.

It is safe to run more than once: it keeps the `.env` and `config/` files you already have. The only line it rewrites in `.env` is `COMPOSE_FILE`, which it sets from whether it finds a GPU.

## Accounts and apps

None of these is needed to try cohost. You add each one later, on its own page, when you want it.

| Account or app | Used for | Page |
| --- | --- | --- |
| Twitch channel | Reading your chat. Reading needs no login. | [Twitch chat](../connect/twitch.md) |
| Discord server and a bot | Hearing a voice channel and speaking in it | [Discord](../connect/discord.md) |
| [OBS](../../start/glossary.md#obs) 28 or newer | Putting the voice on stream, and optionally letting the co-host see your game | [OBS and the voice on stream](../connect/obs.md) |
| [VTube Studio](../../start/glossary.md#vtube-studio) or a [VRM](../../start/glossary.md#vrm) app | Showing an avatar | [Avatar](../connect/avatar.md) |

## Next

Try cohost with no accounts first. If that works, everything after it is just plugging things in: [Try it with no accounts](first-run.md).
