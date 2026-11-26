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
- mise inside the distro, with the toolchains from `mise install`; `mise run dashboard` builds the workspace itself. See [Developer setup](../dev-setup.md) and [What you need](../../guide/install/prerequisites.md).
- For the real Discord and OBS steps, a Discord bot and OBS on the same PC. Do those after the mock path below is healthy.

## The checklist

1. In the distro, run `./scripts/install.sh --no-pull` (or copy `.env.example` to `.env` and the `config/*.example.*` files to their working names), then start the dashboard:

   ```bash
   ./scripts/install.sh --no-pull
   mise run dashboard
   ```

   If `docker` is not on the distro's path, set `COHOST_DOCKER_BIN=docker.exe` in `.env` first. The dashboard and `cohostctl` then run every [Compose](../../start/glossary.md#docker-compose) command through it.

   You should see the dashboard log the URL it listens on.

2. In a Windows browser open <http://localhost:3000> (`dashboard.port` in `config/config.yaml`). WSL forwards `localhost` to the distro. Enter the `CONTROL_TOKEN` from `.env` when the page asks.

3. Press **Launch** and wait for the stack to reach `up` on the Services screen.

4. Load <http://localhost:3001/?sink=1> (`dashboard.lan_port`) in a second browser tab, or add it as an OBS [Browser Source](../../start/glossary.md#browser-source) on the same PC, and press **Turn audio on** if the page says audio is off. Send a chat line from **Test inputs** on the **Live** screen and hear a reply.

5. Inject an image from the dashboard and see `eyes` answer; it needs the `eyes` [Compose profile](../../start/glossary.md#compose-profile). Then inject an audio clip and see `ears` answer; it needs the `ears` profile. Uploads travel over [Redis](../../start/glossary.md#redis), so nothing on the host has to be reachable from a container.

6. Once the steps above are healthy, bring in real Discord and OBS. [Real hardware and accounts](real-backends.md#discord-one-bot) lists the Discord checks and [the OBS checks](real-backends.md#obs) follow it. That is the only place the native voice dependencies and the OBS WebSocket path are confirmed.

7. Press **Stop**, then run the consolidation pass:

   ```bash
   docker compose run --rm consolidate
   ```

8. Check the reach of the tool service. `tools` sits on a network that holds only Redis, so it should not reach the other containers. Start the stack, then from inside `tools` try the address of the [Postgres](../../start/glossary.md#postgres) container (a container on the default network only):

   ```bash
   pg=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q postgres)")
   docker compose exec -T tools node -e 'const s=require("node:net").connect(5432,process.argv[1]);s.on("connect",()=>{console.log("reachable");process.exit(0)});s.on("error",()=>{console.log("not reachable");process.exit(1)});setTimeout(()=>{console.log("not reachable");process.exit(1)},3000)' "$pg"
   ```

   It should print `not reachable`. Then, with the same command against `host.docker.internal` and each port Compose publishes on `127.0.0.1` (Redis 6379, Postgres 5432, [Ollama](../../start/glossary.md#ollama) 11434, voice 8700, [TTS](../../start/glossary.md#tts) 8880, [STT](../../start/glossary.md#stt) 8000) and the dashboard's two ports, write down which answer. The host gateway is not filtered, so some of those may be reachable; the point is to record which. Repeat the whole step on a native Linux Docker Engine if you have one. This is the manual check DEPLOY-NET-006 holds (tracked in [#330](https://github.com/CoderCoco-Studios/cohost/issues/330)).

## Optional: the speech engine servers

Run these after step 7 with the `pocket` profile, or `nemotron` or `kyutai`, enabled in `COMPOSE_PROFILES` and selected in `config/config.yaml`. The first build of an enabled profile takes minutes.

| Check | You should see |
| --- | --- |
| Press **Launch** while the engine is still downloading its weights (first start, or a cleared cache) and it has not passed its healthcheck within the 180 s readiness wait | Launch reports the engine not ready by name (for example `tts-pocket (running, starting)`). Nothing is stopped or restarted: `docker compose ps` still shows the container, and it turns `healthy` when the download ends (DEPLOY-ENG-018). |
| The same window | `voice` (for `pocket`) or `ears` (for `nemotron` or `kyutai`) is `up` and reports `deps.tts` or `deps.stt` `down` until the engine serves; neither is restarted (DEPLOY-ENG-020). |

## How you know it worked

- Step 3: every service on the Services screen shows `up`, and the **Stack** card shows the infrastructure containers running.
- Step 4: the feed shows `brain.say`, `voice.utterance` and `voice.done`, and you hear the reply on the [sink](../../start/glossary.md#sink) page.
- Step 5: `inject.result` answers with `ok: true` for each upload, and the feed shows `vision.summary` and `speech.heard`.
- Step 7: the command exits 0. Viewer notes are tidied; skipping it loses nothing, because `memory` catches up at its next start.
- Step 8: the Postgres address prints `not reachable` from inside `tools`, and you have a written list of what `host.docker.internal` reaches.

## If it didn't

- **`docker: command not found` in the distro.** Turn on Docker Desktop's WSL integration for this distro, or set `COHOST_DOCKER_BIN=docker.exe`.
- **Windows `docker.exe` and a [GPU](../../start/glossary.md#gpu) overlay.** A Windows `docker.exe` splits `COMPOSE_FILE` on `;`. Set `COMPOSE_PATH_SEPARATOR=:` in `.env` when the list uses `:`, as in `docker-compose.yml:docker-compose.gpu.yml`. The GPU itself comes from the Windows NVIDIA driver; install only the container toolkit in Linux.
- **The browser cannot reach port 3000.** Check the dashboard's startup log for the URL it actually uses: the port is `dashboard.port` in `config/config.yaml`, and the address differs when `DASHBOARD_HOST` is set.
- **Launch hangs.** The first Launch pulls infrastructure images and models, several gigabytes even in [mock mode](../../start/glossary.md#mock-mode). Watch `docker compose ps`.
- **Anything else.** See [Troubleshooting](../../guide/troubleshooting.md).
