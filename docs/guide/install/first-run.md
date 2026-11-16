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
- The Rust toolchain that `rust-toolchain.toml` pins. The installer installs it; if you skip the installer, install that exact version yourself, because the programs that run on your machine cannot start without the compiled bus connection.
- A browser on the same machine. On [WSL2](../../start/glossary.md#wsl2), a browser on the Windows side works, because WSL forwards `localhost`. The [Single-PC checklist](../../advanced/testing/single-pc.md) walks the whole run on one WSL2 machine.

## Steps

1. Get the code, and step into it.

   ```bash
   git clone https://github.com/CoderCoco-Studios/cohost.git
   cd cohost
   ```

2. Run the installer. It installs what is missing (see [what the installer does](prerequisites.md#what-the-installer-does)), builds the connection to the [bus](../../start/glossary.md#bus) and writes your `.env`. If it installs [Docker](../../start/glossary.md#docker) for you, it will ask you to log out and back in and run it again.

   ```bash
   ./scripts/install.sh --no-pull
   ```

   <details>
   <summary>Already have Docker, Node 26, pnpm 12 and Rust?</summary>

   You can skip the installer. Build the bus connection yourself before any program on your machine starts, because those programs cannot run without it:

   ```bash
   pnpm install
   pnpm build:native
   cp .env.example .env
   ```

   Then add a control token to `.env` (the dashboard asks for it) by putting a long random string after `CONTROL_TOKEN=`. `openssl rand -hex 24` makes one.
   </details>

3. Switch every outside dependency to its stand-in by adding these lines to the end of `.env`:

   ```bash
   cat >> .env <<'EOF'
   LLM_PROVIDER=mock
   MEMORY_STORE=memory
   MEMORY_EMBEDDER=hash
   VOICE_ENGINE=stub
   CHAT_SOURCE=fake
   EOF
   ```

   In order, these mean: the [LLM](../../start/glossary.md#llm) answers with canned echoes, memory is kept in the program and lost when it stops, memories use simple offline [embeddings](../../start/glossary.md#embedding), the voice returns silent audio, and chat is a scripted message every eight seconds. The avatar setting is already off in `.env.example`.

4. Start the dashboard.

   ```bash
   pnpm dashboard
   ```

   It builds itself first, so the first start takes a minute. It prints the address it is listening on.

5. Open `http://localhost:3000` in your browser. When it asks for a token, paste the value of `CONTROL_TOKEN` from your `.env`. If you used the installer, it filled one in; find it with `grep CONTROL_TOKEN .env`.

6. Press **Launch**. This builds and starts everything else. Be patient: the first time it downloads images and, through the `models` service, the language models.

7. When the Services tab settles, click **enable audio** so your browser is allowed to play sound.

## How you know it worked

- The Services tab shows every service as `up`, with the mode `mock`. The infrastructure ([Redis](../../start/glossary.md#redis), [Postgres](../../start/glossary.md#postgres), [Ollama](../../start/glossary.md#ollama), [text-to-speech](../../start/glossary.md#tts) and [speech-to-text](../../start/glossary.md#stt)) shows in the stack panel rather than the table.
- The live feed starts filling with fake viewers' messages every few seconds, then with the co-host's replies after them.
- The preview face on the dashboard moves its mouth in time with each reply. The audio is silent, so the face is all you get.
- A line you type in the test panel takes the same road and gets an echoed reply.

Optional pieces (`eyes`, `ears`, `mouth` and the Discord [connector](../../start/glossary.md#connector)) are [Compose profiles](../../start/glossary.md#compose-profile), which means they stay off until you ask for them. You do not need them to see a healthy stack.

## If it didn't

- **The installer stopped after installing Docker.** That is expected: it needs you to log out and back in so your user is in the `docker` group. Run it again.
- **`pnpm dashboard` fails to find the bus addon.** The bus connection was not built. Run `pnpm build:native`, then start the dashboard again.
- **The dashboard says `docker` is not found on WSL2.** Docker Desktop's WSL integration is probably off for your distribution. Either turn it on in Docker Desktop (Settings, Resources, WSL integration) or put `COHOST_DOCKER_BIN=docker.exe` in `.env` so cohost runs every Docker command through the Windows program.
- **A service stays `degraded` or `down`.** Open the Services tab, read its note, and see [service health](../operate/health.md).
- **The first Launch seems stuck.** It is probably downloading models. That can take a long time on a slow connection.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

When this works, move on to [Install for real](real-install.md).
