---
title: Install for real
description: Run the installer, save the recovery key and control token, start the dashboard, enter your settings and credentials on its Settings screen and launch the real stack with real models.
track: simple
verified: a86e930
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

   This installs [Docker](../../start/glossary.md#docker) and mise if they are missing, installs the project's Node, pnpm, Rust, Zig and Python through mise, builds the code and the connection to the [bus](../../start/glossary.md#bus), and downloads the images and models. If it installs Docker, it stops and asks you to log out and back in; do that and run it again. [What you need](prerequisites.md#what-the-installer-does) lists every step. Along the way it sets up four things you need to know about:

   - **`.env`**, copied from `.env.example`. It holds only a few per-machine settings (which optional services to run, the Docker program, image tags) and never a password or key. The [environment and ports](../../advanced/reference/env.md) page lists them.
   - **The [settings store](../../start/glossary.md#settings-store)**, `data/store/cohost.db`, seeded with the default settings, personality and avatar expressions from the examples in `config/`. Every setting and credential lives here; you change them on the dashboard, never by editing a file.
   - **The [master key](../../start/glossary.md#master-key)**, which encrypts your credentials in the store. It lives in your home folder, outside the checkout. When it is made, the installer prints its [recovery key](../../start/glossary.md#recovery-key) once. Save it in your password manager: it is the only way to get your credentials back if the key file is lost. See [the recovery key](../operate/settings.md#the-recovery-key).
   - **The [control token](../../start/glossary.md#control-token)**, cohost's one lock: the password the dashboard asks for. The installer makes one and prints it once. Save it in your password manager too; the store keeps only a check value, so no file on the machine holds it. If you lose it, `mise run config:token` makes a new one.

   Running the installer again keeps the store, the key and the token you have, and prints neither again. Backups of the store, moving to a new machine and bringing in settings files from an older install are on [Settings, backups and recovery](../operate/settings.md) ([bringing in settings files from an older install](../operate/settings.md#bringing-in-settings-files-from-an-older-install)).

3. Start the dashboard. It is the one program you start yourself, and you start it before anything else.

   ```bash
   mise run dashboard
   ```

4. Open the dashboard at `http://localhost:<dashboard.port>`: `http://localhost:3000` unless you changed the `dashboard.port` setting. The quickest way in is the [unlock link](../../start/glossary.md#unlock-link) the terminal prints (`Unlock this browser: http://127.0.0.1:3000/unlock?n=...`; it works once, within 10 minutes), which opens the dashboard with this browser unlocked, so it never asks for the token. If you open the address yourself, enter the control token from your password manager when the Access dialog asks. `mise run dashboard:unlock` prints a fresh link while the dashboard runs.

5. Enter your settings on the **Settings** screen. Everything has working defaults; these are the ones you will usually look at first:

   | Setting | Settings section | What it is | When to change it |
   | --- | --- | --- | --- |
   | `cohost.name`, `cohost.streamer`, `cohost.timezone` | Identity | What the co-host calls itself, what it calls you, and your time zone | Now. |
   | `llm.model`, `llm.embed_model`, `vision.model` | Language model, Vision | The models [Ollama](../../start/glossary.md#ollama) downloads | Size them to your graphics card ([GPU](../../start/glossary.md#gpu)); see [choose a model](../tune/model.md). |
   | `ears.stt_model` | Hearing | The speech-to-text model name | Rarely. |
   | `chat.twitch.channel`, `connections.discord.*`, `vision.obs.*`, `avatar.*` | Chat, Discord, Vision, Avatar | Your accounts and apps | Fill each in on its own page under Connect. |

   Each section has a Save button, and a value you saved is marked `saved`. Credentials (tokens, API keys, the OBS password) sit in the same sections as write-only fields: each shows **Set** or **Not set**, never the value, and is kept encrypted in the store. The Connect pages say which ones each account needs. From a shell, `mise run config:set -- cohost.name Coco` sets a setting and `mise run config:secret -- <path>` asks for a credential without showing it; [Settings, backups and recovery](../operate/settings.md) has every command.

   [Configuration](../../advanced/reference/config.md) lists every setting, and the Tune pages explain the ones you will actually want.

6. Press **Launch**. The first Launch pulls anything the installer did not and the models through the `models` service, so it can take a while. Every later Launch rebuilds the images, which is quick when nothing changed. A setting you change later applies when the service that reads it next starts: the Settings screen names those services and offers to restart them.

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

The optional speech engine servers have their own profiles: `pocket` (the Pocket voice engine, `voice.engine: pocket`), `nemotron` and `kyutai` (the streaming transcription servers, `ears.stt_engine: nemotron` or `kyutai`). Add the ones you use to `COMPOSE_PROFILES`, select the engine on the **Settings** screen (Voice or Hearing), and press Launch. Each is built from source on its first use, which takes minutes.

## A graphics card

If the installer found an NVIDIA card it set `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` in `.env`, which adds the GPU overlay. You do not need to do anything else.

The GPU overlay runs the [TTS](../../start/glossary.md#tts) engine, [Kokoro](../../start/glossary.md#kokoro), from its CUDA 12.8 build, `ghcr.io/remsky/kokoro-fastapi-gpu:v0.10.0-cu128`. That build is the one RTX 50-series cards need, and it needs an NVIDIA driver of the R570 series or newer (on [WSL2](../../start/glossary.md#wsl2), the Windows driver). If `docker compose ps` shows `tts` restarting, or its log says "no kernel image is available" or names an unsupported driver, update the driver, or switch to the CUDA 12.6 build by adding this line to `.env` and pressing Launch again. Use the CUDA 12.6 build from the start on a GTX 9xx or 10xx card (Maxwell or Pascal), which the CUDA 12.8 build does not support, or on an arm64 host, for which the CUDA 12.8 build is not published:

```sh
KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-gpu:v0.10.0-cu126
```

The CUDA 12.6 build does not run on RTX 50-series cards.

If you run a Windows `docker.exe` from WSL2, that program splits the list on `;` instead of `:`. Also set `COMPOSE_PATH_SEPARATOR` to `:` in `.env` in that case. The GPU overlay has not been run through `docker.exe`.

## How you know it worked

- The Services screen shows each running service as `up`, with mode `live` (or `off` for a feature you have not enabled).
- Typing a line into **Test inputs** gets a reply from the real model, and the reply is spoken on the dashboard page once audio is on in the header.
- `docker compose ps` lists `redis`, `postgres`, `ollama`, `tts` and `stt` as running.

::: aside
Real model, real voice, real me. Try not to get attached. I will remember it if you do.
:::

## If it didn't

- **Launch fails or `models` exits with an error.** A model download failed, usually the network. Check your connection and press Launch again. The models are the ones the `llm.model`, `llm.embed_model` and `vision.model` settings name; a failed download of a [hook](../../start/glossary.md#hook) model is only a warning.
- **A service shows `degraded`.** That usually means it is waiting for an account you have not filled in. Fill it in on its Connect page (the setting or credential on the **Settings** screen), then restart that service from the Services screen.
- **Replies are very slow.** There is no GPU, or the model is too big for it. Pick a smaller `llm.model`; see [choose a model](../tune/model.md).
- **The dashboard refuses to start, naming `CONTROL_TOKEN`.** Either no control token is set, so run `mise run config:token` and save the token it prints, or `.env` or your shell defines `CONTROL_TOKEN`, which the dashboard refuses: the token belongs only in your password manager, so remove that line or variable. See [troubleshooting](../troubleshooting.md#the-dashboard-will-not-start-mentioning-control-token).
- **Services show `waiting for credentials` after a reboot.** Docker restarted them, and they wait until the dashboard hands them their credentials. Start the dashboard, or run `mise run deliver`. See [after a reboot](../operate/settings.md#after-a-reboot).

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Connect your accounts, starting with [Twitch chat](../connect/twitch.md).
