---
title: What you need
description: The computer, operating system, tools and optional accounts cohost needs, and what the installer puts on your machine for you.
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

The installer on the next pages can put all of these on an Ubuntu or Debian machine, so you do not need to install them first. You do need to know they exist.

| Tool | Why cohost needs it |
| --- | --- |
| [Docker](../../start/glossary.md#docker) with the Compose plugin | Almost every cohost service runs in a [container](../../start/glossary.md#container). Docker runs them and [Docker Compose](../../start/glossary.md#docker-compose) starts the whole set. On WSL2 you can use Docker Desktop for Windows with its WSL integration turned on for your distribution, or Docker installed inside the distribution. |
| NVIDIA container toolkit | Only if you have an NVIDIA GPU: it lets containers use the card. |
| Node 26 or newer | The dashboard and the command line tools run on your machine directly, as Node programs. |
| pnpm 12 | The package manager the project uses. The installer installs corepack with npm and enables pnpm through it. |
| The Rust toolchain | cohost's connection to the shared message channel (the [bus](../../start/glossary.md#bus)) is a small compiled program. The project pins the exact Rust version in `rust-toolchain.toml` and the installer installs that one through rustup, along with a C compiler (`build-essential`). |
| Python 3 (optional) | Only for the example server in the brain-hooks guide (a [hook](../../start/glossary.md#hook) is a spot where you can swap in your own server). |

Rust is required before any program that runs on your machine will start, that is the dashboard, `cohostctl` and the development loop. Those programs load the compiled bus connection and have no fallback if it is missing. The command that builds it is `pnpm build:native`; the next pages tell you exactly when to run it.

## What the installer does

`scripts/install.sh` is the one script that sets up an Ubuntu, Debian or WSL2 machine. In order, it:

1. Detects WSL2 and whether you have an NVIDIA GPU.
2. Installs Docker if it is missing. If it had to install Docker, it stops and asks you to log out and back in, then run it again.
3. Installs the NVIDIA container toolkit when it finds a GPU.
4. Installs Node 26 if Node is missing or older, and enables pnpm.
5. Creates `.env` from `.env.example`, creates your personal files in `config/` (`config.yaml`, `personality.md` and `expressions.yaml`) and your credentials file `secrets/secrets.yaml`, switches on the GPU settings if there is a GPU, and fills in the dashboard's control token.
6. Installs a C compiler if there is none, then rustup and the pinned Rust toolchain.
7. Runs `pnpm install --frozen-lockfile`, then `pnpm build:native`, then a type check, then copies each service's credentials from `secrets/secrets.yaml` into its own file under `secrets/units/`.
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
