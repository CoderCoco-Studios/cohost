---
title: How it works
description: Follow one Twitch chat line from your viewer's keyboard to the co-host's voice and avatar, and meet the creature metaphor the docs use.
track: start
next:
  text: What you need
  link: /guide/install/prerequisites
---

# How it works

The easiest way to understand cohost is to follow one chat line from end to end. A viewer types "what game is this?". A couple of seconds later, the co-host answers out loud and its avatar moves its mouth. Here is what happened in between.

## The creature metaphor

cohost is built like a small creature, and the docs borrow its body parts:

| Part | What it is | In cohost |
| --- | --- | --- |
| Senses | How it notices the world | Chat (Twitch), ears (what is said in Discord), eyes (screenshots from [OBS](glossary.md#obs)) |
| Brain | How it decides and thinks | Four small [brain regions](glossary.md#brain-region): [salience](glossary.md#salience), [affect](glossary.md#affect), memory, [cortex](glossary.md#cortex) |
| Body | How it shows itself | Voice (speech), the avatar, the Discord and browser outputs |
| Operator | You | The [dashboard](glossary.md#dashboard), where you watch, mute, edit and start and stop |

Every piece is its own program, usually in its own [container](glossary.md#container), and they never call each other. They all talk through one shared channel, the [bus](glossary.md#bus), by putting [events](glossary.md#event) on it and reading the ones they care about. That is why you can switch one piece off, or swap it, and the rest keep going.

## One line's journey

| Step | Who | What happens | What goes on the bus |
| --- | --- | --- | --- |
| 1 | `chat` | Reads the viewer's line from Twitch, drops bots and `!commands`, and announces it | `chat.message` |
| 2 | `salience` | Scores the line: a question or a mention of the co-host's name scores high, plain chatter low. If the score is high enough, and the co-host is not busy or too soon after its last line, it decides to speak. A matching [reflex](glossary.md#reflex) skips the thinking and speaks at once | `attention.focus` |
| 3 | `memory` | The `cortex` asks it for similar past moments; it looks them up and answers (it is the only part that touches the database) | `memory.recall.request`, then `memory.recall.reply` |
| 4 | `cortex` | Builds a prompt from the personality, the recent events, the mood and the recalled memories, asks the [LLM](glossary.md#llm), and gets a short reply | `brain.say` |
| 5 | `voice` | Turns the reply into audio with [text-to-speech](glossary.md#tts) and works out how the mouth should move | `voice.utterance` |
| 6 | Dashboard [sink](glossary.md#sink) or Discord | The sink page in a browser (often an OBS [Browser Source](glossary.md#browser-source)) plays the audio, or the Discord [connector](glossary.md#connector) plays it into the voice channel, and the player reports that it is playing | `voice.playing`, `voice.done` |
| 7 | `avatar` | Moves the avatar's mouth in time with the sound and shows the current mood on its face | `avatar.state` |

Meanwhile `affect` has nudged the mood after the chat line and published it as `affect.state`, and `memory` has stored the exchange and a note about the viewer. The next reply will remember it.

::: aside
Step 2 is the step I am proudest of. Knowing when to keep quiet is the hard part of being a co-host.
:::

## The same journey for speech

Speech from a Discord voice channel takes the same road with a shorter start. The Discord connector publishes the audio, `ears` turns it into text with [speech-to-text](glossary.md#stt) and publishes `speech.heard`, and from step 2 on nothing changes. Something said out loud scores higher than chat, so the co-host answers you more eagerly than it answers viewers.

## Where the data lives

- Messages between programs live on the bus, which is built on [Redis](glossary.md#redis).
- Memories and viewer notes live in [Postgres](glossary.md#postgres).
- The language, speech and vision models run on [Ollama](glossary.md#ollama), a text-to-speech server and a speech-to-text server, all on your own machine. If you choose a hosted model instead, only the brain's chat call and the after-stream reflection leave your machine.
- Your settings, the co-host's personality, the avatar's expressions and every credential live in one database file, the [settings store](glossary.md#settings-store), changed on the dashboard's Settings screen. The credentials in it are encrypted with a [master key](glossary.md#master-key) kept in your home folder, outside the checkout. `.env` holds only a few per-machine settings and no password or key.

## Where to go next

If you want to try it right now, [What you need](../guide/install/prerequisites.md) is the first page of the set-up path. The [glossary](glossary.md) explains every word above that you were not sure about.
