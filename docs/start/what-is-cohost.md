---
title: What is cohost?
description: What the cohost AI co-host does on a stream, what it is not, what you need to run it, and which part of the docs to read next.
track: start
---

# What is cohost?

cohost is an AI co-host that lives on your own computer and joins your stream. It reads your Twitch chat, can sit in your Discord voice channel and listen, looks at your game through [OBS](glossary.md#obs), remembers the people and running jokes it meets, and answers out loud through an animated avatar.

If you are a [VTuber](glossary.md#vtuber), or you would like to be one with a very opinionated sidekick, this is for you.

::: aside
Hello. I am the sidekick. You may call me "the co-host", or just "hey you". I will not answer to "bot".
:::

## What it does on a stream

- **Reads chat.** It watches a Twitch channel, one line at a time, and decides which lines deserve an answer. Most do not. A co-host that answers everything is a co-host nobody wants.
- **Listens.** In a Discord voice channel it hears you and your guests, turns the speech into text and treats it like chat that outranks everyone else's.
- **Watches.** With the optional vision service it takes a screenshot of your game every few seconds and describes what changed, so it can react to the screen.
- **Remembers.** It stores what was said, recalls related moments when it answers, keeps a short note about each viewer, and updates its own personality after a stream.
- **Has moods.** Its mood rises and falls with what happens and shows on the avatar's face.
- **Speaks and moves.** Its words become audio, played through the dashboard page, OBS or Discord, while the avatar's mouth follows the sound.

## What it is not

- It is not a hosted service. Nothing runs on our servers: you run it, on your hardware, with your accounts.
- It does not post into Twitch chat. It reads chat and speaks.
- It is not finished software. It is pre-alpha: the whole loop runs end to end with no accounts, but some real integrations (the Discord voice channel, OBS vision, the full Twitch login, [VTube Studio](glossary.md#vtube-studio)) have not yet been run against the real services. The [status page](../project/status.md) says exactly which.

## What you need

- A Linux PC, or a Windows PC with [WSL2](glossary.md#wsl2) (a real Linux inside Windows). Ubuntu and Debian are the tested systems.
- Optionally an NVIDIA graphics card ([GPU](glossary.md#gpu)). Without one everything still works, only more slowly.
- Whichever accounts and apps you want it on: a Twitch channel, a Discord server, OBS, an avatar app. None of them is needed to try it.

The full list, with versions, is on [What you need](../guide/install/prerequisites.md).

## Which way to read

| You want to | Read |
| --- | --- |
| Understand what is going on first | [How it works](how-it-works.md), then the [glossary](glossary.md) when a word is new |
| Get it running and on your stream | [What you need](../guide/install/prerequisites.md), then each page in order |
| Change it, test it or build on it | [Developer setup](../advanced/dev-setup.md) |

The "set it up" pages are written in plain language and go one step per page, each telling you what you should see when it worked. The "build on it" pages assume you finished those and are more precise. The [home page](../index.md) lays out the three paths.
