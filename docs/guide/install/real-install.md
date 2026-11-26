---
title: Install for real
description: Run the installer, fill in config.yaml, secrets.yaml and .env, start the dashboard and launch the real stack with real models.
track: simple
verified: f126b94
---

# Install for real

By the end of this page you will have the real stack running: a language model answering, real speech, and the dashboard ready for you to plug in Twitch, Discord, OBS and an avatar one at a time.

## What you need

- A working [mock-mode run](first-run.md), or at least a machine that meets [What you need](prerequisites.md).
- If you did the mock run, there is nothing to undo: the real run starts every service without the **Isolated** option, so each one uses its real backend.
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

   This installs [Docker](../../start/glossary.md#docker) and mise if they are missing, installs the project's Node, pnpm, Rust, Zig and Python through mise, builds the code and the connection to the [bus](../../start/glossary.md#bus), writes `.env` and your `config/` files, and downloads the images and models. If it installs Docker, it stops and asks you to log out and back in; do that and run it again. [What you need](prerequisites.md#what-the-installer-does) lists every step.

3. Look at the settings you may want to change. Your accounts and models are keys in `config/config.yaml`, your credentials go in `secrets/secrets.yaml`, and `.env` holds only a few per-machine settings:

   | Where | What it is | When to change it |
   | --- | --- | --- |
   | `CONTROL_TOKEN` in `.env` | The password the dashboard asks for. The installer fills it in. | If it is empty, make one with `openssl rand -hex 24`. |
   | `llm.model`, `llm.embed_model`, `vision.model` in `config/config.yaml` | The models [Ollama](../../start/glossary.md#ollama) downloads | Size them to your graphics card ([GPU](../../start/glossary.md#gpu)); see [choose a model](../tune/model.md). |
   | `ears.stt_model` in `config/config.yaml` | The speech-to-text model name | Rarely. |
   | `chat.twitch.channel`, `connections.discord.*`, `vision.obs.*`, `avatar.*` in `config/config.yaml` | Your accounts and apps | Fill each in on its own page under Connect. |
   | `secrets/secrets.yaml` (copy of `config/secrets.example.yaml`; Git ignores it) | Every credential: tokens, API keys and the OBS password | Edit it on the same Connect pages, or set each credential from the **Settings** screen: its masked field shows **Set** or **Not set**, never the value, and saving needs your control token. |
   | `COHOST_DOCKER_BIN` in `.env` | The Docker program to run | On [WSL2](../../start/glossary.md#wsl2) without Docker Desktop's WSL integration, set it to `docker.exe`. |

   A restart of the service that reads a key applies an edit to either file. The [environment and ports](../../advanced/reference/env.md) page lists everything `.env` holds.

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
   mise run dashboard
   ```

6. Open `http://localhost:3000` (the port is `dashboard.port` in `config/config.yaml`), enter the `CONTROL_TOKEN` from `.env` in the Access dialog when it asks, and press **Launch**. The first Launch pulls anything the installer did not and the models through the `models` service, so it can take a while. Every later Launch rebuilds the images, which is quick when nothing changed.

7. Press **Audio off** in the header (it then reads **Audio on**) so your browser may play sound.

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

The optional speech engine servers have their own profiles: `pocket` (the Pocket voice engine, `voice.engine: pocket`), `nemotron` and `kyutai` (the streaming transcription servers, `ears.stt_engine: nemotron` or `kyutai`). Add the ones you use to `COMPOSE_PROFILES`, select the engine in `config/config.yaml`, and press Launch. Each is built from source on its first use, which takes minutes.

## A graphics card

If the installer found an NVIDIA card it set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, which adds the GPU overlay. You do not need to do anything else.

If you run a Windows `docker.exe` from WSL2, that program splits the list on `;` instead of `:`. Also set `COMPOSE_PATH_SEPARATOR` to `:` in `.env` in that case. The GPU overlay has not been run through `docker.exe`.

## How you know it worked

- The Services screen shows each running service as `up`, with mode `live` (or `off` for a feature you have not enabled).
- Typing a line into **Test inputs** gets a reply from the real model, and the reply is spoken on the dashboard page once audio is on in the header.
- `docker compose ps` lists `redis`, `postgres`, `ollama`, `tts` and `stt` as running.

::: aside
Real model, real voice, real me. Try not to get attached. I will remember it if you do.
:::

## If it didn't

- **Launch fails or `models` exits with an error.** A model download failed, usually the network. Check your connection and press Launch again. The models are the ones `config/config.yaml` names; a failed download of a [hook](../../start/glossary.md#hook) model is only a warning.
- **A service shows `degraded`.** That usually means it is waiting for an account you have not filled in. Fill it in on its Connect page (the **Settings** screen, or `config/config.yaml` for settings and `secrets/secrets.yaml` for credentials), then restart that service from the Services screen.
- **Replies are very slow.** There is no GPU, or the model is too big for it. Pick a smaller `llm.model`; see [choose a model](../tune/model.md).
- **The dashboard refuses to start.** If you set `DASHBOARD_HOST=0.0.0.0` it also needs `CONTROL_ENABLED=1` and a `CONTROL_TOKEN`.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Connect your accounts, starting with [Twitch chat](../connect/twitch.md).
