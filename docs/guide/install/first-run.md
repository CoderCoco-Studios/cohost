---
title: Try it with no accounts
description: Start cohost in mock mode from a fresh checkout and watch a talking co-host on the dashboard, with no Twitch, Discord, OBS, GPU or API key.
track: simple
verified: f126b94
---

# Try it with no accounts

By the end of this page you will have the whole co-host running on your machine, answering scripted fake chat on the dashboard page, with no accounts, no graphics card and no API keys. This is [mock mode](../../start/glossary.md#mock-mode): every outside dependency gets a fake stand-in, so you can see the whole loop work before you connect anything real.

::: aside
Mock mode means my answers are canned echoes and my voice is silence. Think of it as my first day of rehearsal. I am already insufferable.
:::

## What you need

- A machine that meets [What you need](prerequisites.md).
- About half an hour the first time. The first start downloads the infrastructure images and the models, which is several gigabytes even in mock mode.
- [mise](https://mise.jdx.dev/) and the system prerequisites: Docker with [Compose](../../start/glossary.md#docker-compose), the NVIDIA driver and [container](../../start/glossary.md#container) toolkit if you have an NVIDIA [GPU](../../start/glossary.md#gpu), `git` and `curl`. The installer sets these up. Node, pnpm, Rust, Zig and Python come from `mise.toml` through `mise install`, and `mise run doctor` checks the rest. Install no Node, pnpm, Rust or C toolchain of your own.
- A browser on the same machine. On [WSL2](../../start/glossary.md#wsl2), a browser on the Windows side works, because WSL forwards `localhost`. The [Single-PC checklist](../../advanced/testing/single-pc.md) walks the whole run on one WSL2 machine.

## Steps

1. Get the code, and step into it.

   ```bash
   git clone https://github.com/CoderCoco-Studios/cohost.git
   cd cohost
   ```

2. Run the installer. It installs what is missing, including mise and the project's toolchains (see [what the installer does](prerequisites.md#what-the-installer-does)), builds the code and the connection to the [bus](../../start/glossary.md#bus), and writes your `.env`, `config/config.yaml` and `secrets/secrets.yaml` from their examples. If it installs [Docker](../../start/glossary.md#docker) for you, it will ask you to log out and back in and run it again.

   ```bash
   ./scripts/install.sh --no-pull
   ```

   <details>
   <summary>Already have Docker and mise?</summary>

   You can skip the installer. Check the system prerequisites, install the project's toolchains and create your files from their examples:

   ```bash
   mise run doctor
   mise trust
   mise install
   cp .env.example .env
   cp config/config.example.yaml config/config.yaml
   mkdir -m 700 secrets
   cp config/secrets.example.yaml secrets/secrets.yaml
   chmod 600 secrets/secrets.yaml
   ```

   Then add a control token to `.env` (the dashboard's Access dialog asks for it) by putting a long random string after `CONTROL_TOKEN=`. `openssl rand -hex 24` makes one. Run no separate build: the next step installs the packages and builds the bus connection before it starts anything.
   </details>

3. Start the dashboard.

   ```bash
   mise run dashboard
   ```

   It builds itself first, so the first start takes a minute. It prints the address it is listening on and a line `Unlock this browser: http://127.0.0.1:3000/unlock?n=...`.

4. Open that unlock link in your browser. It works once, within 10 minutes, and opens the dashboard with this browser unlocked, so you never paste the control token. If the link has expired, `mise run dashboard:unlock` prints a fresh one. You can instead open `http://localhost:3000` and, when the Access dialog asks for a token, paste the value of `CONTROL_TOKEN` from your `.env`. If you used the installer, it filled one in; find it with `grep ^CONTROL_TOKEN= .env`.

5. Press **Launch**. This builds and starts everything else. Be patient: the first time it downloads images and, through the `models` service, the language models.

6. Switch the outside dependencies to their stand-ins with an isolated start, which edits no file and writes nothing to `.env`. On the Services screen, press **Start** (or **Restart**) on `chat`, `memory`, `cortex` and `voice`, switch on **Isolated** in each dialog and confirm (starting `cortex` isolated also starts `salience` and `affect`). In order, they now run on: scripted fake chat, one message every eight seconds; memory kept in the program and lost when it stops, with simple offline [embeddings](../../start/glossary.md#embedding); canned echo replies from the [LLM](../../start/glossary.md#llm); and a voice that returns silent audio. The avatar is off by default.

7. When the Services screen settles, press **Audio off** in the header (it then reads **Audio on**) so your browser is allowed to play sound.

## How you know it worked

- The Services screen shows every service as `up`, with the mode `mock` on the ones you started isolated. The infrastructure ([Redis](../../start/glossary.md#redis), [Postgres](../../start/glossary.md#postgres), [Ollama](../../start/glossary.md#ollama), [text-to-speech](../../start/glossary.md#tts) and [speech-to-text](../../start/glossary.md#stt)) shows in the **Stack** card rather than the table.
- The live feed starts filling with fake viewers' messages every few seconds, then with the co-host's replies after them.
- The preview face on the dashboard moves its mouth in time with each reply. The audio is silent, so the face is all you get.
- A line you type in **Test inputs** takes the same road and gets an echoed reply.

Optional pieces (`eyes`, `ears`, `mouth` and the Discord [connector](../../start/glossary.md#connector)) are [Compose profiles](../../start/glossary.md#compose-profile), which means they stay off until you ask for them. You do not need them to see a healthy stack.

## If it didn't

- **The installer stopped after installing Docker.** That is expected: it needs you to log out and back in so your user is in the `docker` group. Run it again.
- **`mise run dashboard` says a tool is missing or `mise` is not found.** Open a new terminal so the mise activate line the installer added takes effect, or run `mise install` in the cohost folder. `mise run doctor` lists any system prerequisite that is missing and how to fix it.
- **The dashboard says `docker` is not found on WSL2.** Docker Desktop's WSL integration is probably off for your distribution. Either turn it on in Docker Desktop (Settings, Resources, WSL integration) or put `COHOST_DOCKER_BIN=docker.exe` in `.env` so cohost runs every Docker command through the Windows program.
- **A service stays `degraded` or `down`.** Open the Services screen, read its note, and see [service health](../operate/health.md).
- **The first Launch seems stuck.** It is probably downloading models. That can take a long time on a slow connection.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

When this works, move on to [Install for real](real-install.md).
