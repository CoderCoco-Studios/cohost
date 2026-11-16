---
title: Single-PC checklist
description: A tick-off checklist for one Windows PC running WSL2 with Docker Desktop and no second machine, from Launch to the consolidation pass.
track: advanced
verified: f126b94
---

# Single-PC checklist for WSL2 with Docker Desktop

A checklist for one machine and no second PC. The [dashboard](../../guide/operate/dashboard.md) runs inside your [WSL2](../../start/glossary.md#wsl2) distro, [Docker](../../start/glossary.md#docker) Desktop runs the [containers](../../start/glossary.md#container), and a Windows browser and [OBS](../../start/glossary.md#obs) are the clients. Work through it in order; each step says what you should see.

## What you need

- Docker Desktop with the WSL2 backend, and WSL integration switched on for your distro (Settings, Resources, WSL integration). Without the integration, `docker` is not on the distro's path; step 1 covers that.
- The workspace built inside the distro, with the pinned Rust toolchain. See [Developer setup](../dev-setup.md) and [What you need](../../guide/install/prerequisites.md).
- For the real Discord and OBS steps, a Discord bot and OBS on the same PC. Do those after the mock path below is healthy.

## The checklist

1. In the distro, run `./scripts/install.sh --no-pull` (or copy `.env.example` to `.env` and the `config/*.example.*` files to their working names), then start the dashboard:

   ```bash
   ./scripts/install.sh --no-pull
   pnpm dashboard
   ```

   If `docker` is not on the distro's path, set `COHOST_DOCKER_BIN=docker.exe` in `.env` first. The dashboard and `cohostctl` then run every [Compose](../../start/glossary.md#docker-compose) command through it.

   You should see the dashboard log the URL it listens on.

2. In a Windows browser open <http://localhost:3000> (`dashboard.port` in `config/config.yaml`). WSL forwards `localhost` to the distro. Enter the `CONTROL_TOKEN` from `.env` when the page asks.

3. Press **Launch** and wait for the stack to reach `up` on the Services tab.

4. Load <http://localhost:3001/?sink=1> (`dashboard.lan_port`) in a second browser tab, or add it as an OBS [Browser Source](../../start/glossary.md#browser-source) on the same PC, and click **enable audio**. Send a chat line from the test panel and hear a reply.

5. Inject an image from the dashboard and see `eyes` answer; it needs the `eyes` [Compose profile](../../start/glossary.md#compose-profile). Then inject an audio clip and see `ears` answer; it needs the `ears` profile. Uploads travel over [Redis](../../start/glossary.md#redis), so nothing on the host has to be reachable from a container.

6. Once the steps above are healthy, bring in real Discord and OBS. [Real hardware and accounts](real-backends.md#discord-one-bot) lists the Discord checks and [the OBS checks](real-backends.md#obs) follow it. That is the only place the native voice dependencies and the OBS WebSocket path are confirmed.

7. Press **Stop**, then run the consolidation pass:

   ```bash
   docker compose run --rm consolidate
   ```

## How you know it worked

- Step 3: every service on the Services tab shows `up`, and the stack panel shows the infrastructure containers running.
- Step 4: the feed shows `brain.say`, `voice.utterance` and `voice.done`, and you hear the reply on the [sink](../../start/glossary.md#sink) page.
- Step 5: `inject.result` answers with `ok: true` for each upload, and the feed shows `vision.summary` and `speech.heard`.
- Step 7: the command exits 0. Viewer notes are tidied; skipping it loses nothing, because `memory` catches up at its next start.

## If it didn't

- **`docker: command not found` in the distro.** Turn on Docker Desktop's WSL integration for this distro, or set `COHOST_DOCKER_BIN=docker.exe`.
- **Windows `docker.exe` and a [GPU](../../start/glossary.md#gpu) overlay.** A Windows `docker.exe` splits `COMPOSE_FILE` on `;`. Set `COMPOSE_PATH_SEPARATOR=:` in `.env` when the list uses `:`, as in `docker-compose.yml:docker-compose.gpu.yml`. The GPU itself comes from the Windows NVIDIA driver; install only the container toolkit in Linux.
- **The browser cannot reach port 3000.** Check the dashboard's startup log for the URL it actually uses: the port is `dashboard.port` in `config/config.yaml`, and the address differs when `DASHBOARD_HOST` is set.
- **Launch hangs.** The first Launch pulls infrastructure images and models, several gigabytes even in [mock mode](../../start/glossary.md#mock-mode). Watch `docker compose ps`.
- **Anything else.** See [Troubleshooting](../../guide/troubleshooting.md).
