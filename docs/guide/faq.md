---
title: FAQ
description: Short answers to the questions that come up most, from whether you need a graphics card to what leaves your machine.
track: simple
verified: f126b94
---

# Frequently asked questions

Short answers, with a link to the page that has the rest. If something is broken rather than unclear, try [Troubleshooting](troubleshooting.md).

## Do I need a graphics card?

No, but it helps. The models that write, hear and speak run much faster on an NVIDIA [GPU](../start/glossary.md#gpu). Without one, run on the processor, which is slower, or [choose a hosted model](tune/model.md) for the writing and keep the rest local. [What you need](install/prerequisites.md) has the details.

## Does it cost money?

cohost itself is free software. Running models on your own PC costs only electricity. A rented GPU box or a hosted model such as Claude is billed by that provider; see [Choose a model](tune/model.md).

## Which computers does it run on?

Linux, including Ubuntu and Debian, or Windows through [WSL2](../start/glossary.md#wsl2), which is Linux inside Windows. The compiled part of its message system is built for 64-bit Linux only. [What you need](install/prerequisites.md) covers the rest.

## Can I try it before I set up accounts?

Yes. [Try it with no accounts](install/first-run.md) runs the whole thing in [mock mode](../start/glossary.md#mock-mode): a pretend language model, voice and chat, so you can see the dashboard working without any account or download.

## What leaves my computer?

By default, only what you connect on purpose, such as Twitch chat and the Discord voice channel. The models run locally, the memory lives in your own database, and the full dashboard listens only on your own PC. If you pick a hosted model, the prompts the co-host writes (recent chat, memories, its personality) go to that provider, and so does the reflection pass after a stream. [Embeddings](../start/glossary.md#embedding) and the small model that writes viewer notes stay local unless you point them elsewhere. See [Choose a model](tune/model.md).

## Which chat platforms work?

Twitch chat, or scripted fake messages for testing. Voice comes from a Discord voice channel, or from audio you send in directly. See [Twitch chat](connect/twitch.md) and [Discord](connect/discord.md).

## Does it need Discord?

No. Discord is one way to carry voice in and out. For a stream you can use the dashboard's [sink](../start/glossary.md#sink) page in an [OBS](../start/glossary.md#obs) [Browser Source](../start/glossary.md#browser-source) instead; see [OBS and the voice on stream](connect/obs.md).

## Can I give it a different voice?

Yes. Set `voice.voice` in `config/config.yaml` to another voice name and restart the voice service; the speed is `voice.speed`. Everything about its character, as opposed to its sound, lives in the [personality file](tune/personality.md).

## Can I rename it, or change what it calls me?

Yes: `cohost.name` and `cohost.streamer` in `config/config.yaml`.

## Does it remember viewers between streams?

Yes, with the database running. It remembers who is a regular and keeps short, fading notes, and you can read, correct and delete all of it on the Viewers screen. See [Memory and viewer notes](tune/memory.md). In mock mode nothing is kept.

## How do I make it talk less, or more?

Raise or lower `speak_threshold`, `cooldown_ms` and `idle_chatter_ms`. See [When it talks](tune/talkativeness.md).

## Can it see my game?

Yes, with the optional screenshot sense, which looks at a source in OBS every few seconds and describes it. See [OBS and the voice on stream](connect/obs.md).

## Why is it slow to answer?

Each reply passes through hearing, deciding, writing and speaking, and the writing step dominates. A bigger model or a slower GPU takes longer. `mise run cohostctl latency` prints how long each stage took over recent history, which shows where the time goes. A smaller or hosted model is the usual cure; see [Choose a model](tune/model.md).

## Is it safe to open the dashboard to other computers?

Only the sink page (the audio for a second PC's OBS) listens on the network, on `dashboard.lan_port` (3001 by default). The full dashboard listens on your own PC unless you change `DASHBOARD_HOST`. Either listener answers only requests that address it by IP address, `localhost` or a name you list in `dashboard.allowed_hosts`. If you open the full dashboard to the network, `CONTROL_TOKEN` guards it as it always does, and the token travels over plain HTTP, so do it only on a network you trust. To reach the dashboard from another machine, set `DASHBOARD_HOST`; never put a port forward or a proxy in front of the dashboard's port on your own PC, because that makes every machine that reaches it look local to the dashboard. An `ssh -L` tunnel opened from your own machine is fine.

## Where are my files?

- `config/config.yaml`, `config/personality.md` and `config/expressions.yaml`: your settings, personality and avatar expressions. Git ignores them.
- `secrets/secrets.yaml`: your credentials (tokens, API keys, the OBS password). Git ignores it. Never share it.
- `.env`: the dashboard's access tokens and a few per-machine settings. Never share it.
- `data/`: files the co-host must remember between runs, such as refreshed Twitch tokens. `COHOST_DATA_DIR` moves it.

## What has been tested against the real services?

The [Status page](../project/status.md) says which real accounts and apps it has run against and which it has not, and the [Verification log](../project/verification-log.md) has the dated records.

## Can I change how it works or add to it?

Yes. The [Advanced track](../advanced/dev-setup.md) shows how it is built and how to extend it, and the [Brain hooks page](../advanced/extend/hooks.md) shows how to put your own model in its decision-making.

::: aside
You can ask me anything. I will answer in character, and you will regret it exactly as often as you deserve.
:::
