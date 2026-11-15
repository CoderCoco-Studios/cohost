---
layout: home
title: cohost
description: An AI co-host for your stream that runs on your own computer. Start here to learn what it is, set it up, or build on it.
track: start
hero:
  name: cohost
  text: An AI co-host that lives on your computer
  tagline: It reads your chat, listens in Discord, remembers your regulars and answers out loud through an avatar. Nothing is hosted for you, and you can swap any piece.
  actions:
    - theme: brand
      text: What is cohost?
      link: /start/what-is-cohost
    - theme: alt
      text: Set it up
      link: /guide/install/prerequisites
    - theme: alt
      text: Build on it
      link: /advanced/dev-setup
features:
  - title: Start here
    details: Never heard of a VTuber co-host? Learn what cohost does, what it is not and how one chat line becomes speech.
    link: /start/what-is-cohost
    linkText: What is cohost?
  - title: Set it up
    details: A step-by-step path in plain language, from checking your machine to a co-host on your stream. Every step says what you will see when it worked.
    link: /guide/install/prerequisites
    linkText: What you need
  - title: Build on it
    details: The architecture, every setting and event, how to test one service alone, and how to extend cohost.
    link: /advanced/dev-setup
    linkText: Developer setup
---

## How a chat line becomes speech

Somebody types a message. A moment later your co-host answers out loud. In between, six small steps happen, one after another.

::: flow
1. **Chat** hears the line. A viewer types in your Twitch chat, or says something in Discord.
2. **[Salience](start/glossary.md#salience)** decides it is worth answering. Not every line gets a reply, and that is on purpose.
3. **[Cortex](start/glossary.md#cortex)** remembers who is talking and writes a reply.
4. **Voice** turns the reply into speech.
5. **The [sink](start/glossary.md#sink) or Discord** plays it, on your stream or in your voice channel.
6. **The avatar** moves its mouth in time with the words.

Want the whole journey, one line at a time? Read [How it works](start/how-it-works.md).
:::

## What to do first

1. Read [What is cohost?](start/what-is-cohost.md) for two minutes, so you know what you are about to install.
2. Skim [How it works](start/how-it-works.md). It follows one chat line from a viewer's keyboard to the co-host's voice.
3. Follow [What you need](guide/install/prerequisites.md), then [Try it with no accounts](guide/install/first-run.md). In half an hour you will have a talking co-host on a web page, with no accounts and no graphics card.

Unfamiliar word? Every technical term is explained in the [glossary](start/glossary.md), and each page links the first use.

::: aside
Welcome. I have been told I should say something warm here. Consider it said. Now go and install me.
:::
