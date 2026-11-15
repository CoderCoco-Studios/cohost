---
title: Install for real
description: Run the installer, fill in .env and config.yaml, start the dashboard and launch the real stack with real models.
track: simple
verified: f126b94
---

# Install for real

By the end of this page you will have the real stack running: a language model answering, real speech, and the dashboard ready for you to plug in Twitch, Discord, OBS and an avatar one at a time.

## What you need

- A working [mock-mode run](first-run.md), or at least a machine that meets [What you need](prerequisites.md).
- If you did the mock run, you will undo its lines in `.env` below.
- Good internet and patience. The installer downloads [container](../../start/glossary.md#container) images and the default models, several gigabytes in all.

## Steps

1. If you have not already, clone the repository and step into it.

   ```bash
   git clone https://github.com/CoderCoco-Studios/cohost.git
   cd cohost
   ```

2. Run the installer without options, so it also pulls the images and the models.

   ```bash
   ./scripts/install.sh
   ```

   This installs [Docker](../../start/glossary.md#docker), Node, pnpm and the Rust toolchain if they are missing, builds the connection to the [bus](../../start/glossary.md#bus) (`pnpm build:native`), writes `.env` and your `config/` files, and downloads the images and models. If it installs Docker, it stops and asks you to log out and back in; do that and run it again. [What you need](prerequisites.md#what-the-installer-does) lists every step. If you skipped the installer on the previous page, you must run `pnpm build:native` yourself before step 5.

3. Open `.env` in an editor. If you came from the mock run, delete the five lines you added at the end (`LLM_PROVIDER`, `MEMORY_STORE`, `MEMORY_EMBEDDER`, `VOICE_ENGINE` and `CHAT_SOURCE`), so the real backends are used. Then look at the other settings:

   | Setting | What it is | When to change it |
   | --- | --- | --- |
   | `CONTROL_TOKEN` | The password the dashboard asks for. The installer fills it in. | If it is empty, make one with `openssl rand -hex 24`. |
   | `LLM_MODEL`, `VISION_MODEL`, `NOTES_MODEL`, `EMBED_MODEL` | The models [Ollama](../../start/glossary.md#ollama) downloads | Size them to your graphics card ([GPU](../../start/glossary.md#gpu)); see [choose a model](../tune/model.md). |
   | `STT_MODEL` | The speech-to-text model name | Rarely. |
   | `TWITCH_*`, `DISCORD_*`, `OBS_*`, `AVATAR_DRIVER`, `VTS_*`, `VMC_*` | Your accounts and apps | Fill each in on its own page under Connect. |
   | `COHOST_DOCKER_BIN` | The Docker program to run | On [WSL2](../../start/glossary.md#wsl2) without Docker Desktop's WSL integration, set it to `docker.exe`. |

   Every variable is listed on the [environment and ports](../../advanced/reference/env.md) page.

4. Open `config/config.yaml`. This is the file for behaviour, and it is yours: the repository does not track it. Set your names near the top:

   ```yaml
   cohost:
     name: "Coco"       # what the co-host calls itself and answers to in chat
     streamer: "Chris"  # your name, as the language model should know it
     timezone: "America/New_York"
   ```

   Everything else has working defaults. [Configuration](../../advanced/reference/config.md) lists every key, and the Tune pages explain the ones you will actually want.

5. Start the dashboard. It is the one program you start yourself.

   ```bash
   pnpm dashboard
   ```

6. Open `http://localhost:3000`, enter `CONTROL_TOKEN` when asked, and press **Launch**. The first Launch pulls anything the installer did not and the models through the `models` service, so it can take a while. Every later Launch rebuilds the images, which is quick when nothing changed.

7. Click **enable audio** so your browser may play sound.

## Optional pieces

Four services are off until you ask. They are [Compose profiles](../../start/glossary.md#compose-profile):

| Profile | What it adds | Page |
| --- | --- | --- |
| `eyes` | Looks at your game through [OBS](../../start/glossary.md#obs) | [OBS and the voice on stream](../connect/obs.md) |
| `ears` | Listens: turns what the [connectors](../../start/glossary.md#connector) hear into text with [speech-to-text](../../start/glossary.md#stt) | [Discord](../connect/discord.md) |
| `mouth` | Speaks into the connectors' outputs | [Discord](../connect/discord.md) |
| `discord` | The one Discord bot | [Discord](../connect/discord.md) |

To keep the ones you want on across restarts and Launch, list them in `.env`:

```dotenv
COMPOSE_PROFILES=discord,ears,mouth
```

Add `eyes` to the list when you turn on vision. You can also start one by hand: `docker compose --profile ears up -d`.

## A graphics card

If the installer found an NVIDIA card it set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, which adds the GPU overlay. You do not need to do anything else.

If you run a Windows `docker.exe` from WSL2, that program splits the list on `;` instead of `:`. Also set `COMPOSE_PATH_SEPARATOR` to `:` in `.env` in that case. The GPU overlay has not been run through `docker.exe`.

## How you know it worked

- The Services tab shows each running service as `up`, with mode `live` (or `off` for a feature you have not enabled).
- Typing a line into the test panel gets a reply from the real model, and the reply is spoken on the dashboard page once you have enabled audio.
- `docker compose ps` lists `redis`, `postgres`, `ollama`, `tts` and `stt` as running.

::: aside
Real model, real voice, real me. Try not to get attached. I will remember it if you do.
:::

## If it didn't

- **Launch fails or `models` exits with an error.** A model download failed, usually the network. Check your connection and press Launch again. A failed download of the viewer-notes model (`NOTES_MODEL`) is only a warning.
- **A service shows `degraded`.** That usually means it is waiting for an account you have not filled in. Fill it in on its Connect page, then restart that service from the Services tab.
- **Replies are very slow.** There is no GPU, or the model is too big for it. Pick a smaller `LLM_MODEL`; see [choose a model](../tune/model.md).
- **The dashboard refuses to start.** If you set `DASHBOARD_HOST=0.0.0.0` it also needs `CONTROL_ENABLED=1` and a `CONTROL_TOKEN`.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Connect your accounts, starting with [Twitch chat](../connect/twitch.md).
