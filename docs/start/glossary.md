---
title: Glossary
description: Plain definitions of every technical term the cohost docs use, one short entry each.
track: start
prev: false
next: false
terms:
  - id: affect
    match: [affect]
  - id: browser-source
    match: [Browser Source]
  - id: brain-region
    match: [brain region]
  - id: bus
    match: [bus]
  - id: connector
    match: [connector]
  - id: consumer-group
    match: [consumer group]
  - id: container
    match: [container]
  - id: cortex
    match: [cortex]
  - id: dashboard
    match: [cohost dashboard]
  - id: docker
    match: [Docker]
  - id: docker-compose
    match: [Docker Compose, Compose]
  - id: compose-profile
    match: [Compose profile]
  - id: embedding
    match: [embedding]
  - id: event
    match: [event]
  - id: gpu
    match: [GPU]
  - id: heartbeat
    match: [heartbeat]
  - id: hook
    match: [hook]
  - id: kokoro
    match: [Kokoro]
  - id: live2d
    match: [Live2D]
  - id: llm
    match: [LLM]
  - id: memory-region
    match: [memory region]
  - id: mock-mode
    match: [mock mode]
  - id: obs
    match: [OBS]
  - id: obs-websocket
    match: [obs-websocket]
  - id: ollama
    match: [Ollama]
  - id: osc
    match: [OSC]
  - id: pgvector
    match: [pgvector]
  - id: postgres
    match: [Postgres, PostgreSQL]
  - id: redis
    match: [Redis]
  - id: redis-streams
    match: [Redis Stream]
  - id: reflex
    match: [reflex, reflexes]
  - id: salience
    match: [salience]
  - id: sink
    match: [sink]
  - id: audio-source
    match: [audio source]
  - id: speaches
    match: [speaches]
  - id: stt
    match: [STT, speech-to-text]
  - id: tts
    match: [TTS, text-to-speech]
  - id: valence-arousal
    match: [valence, arousal]
  - id: vmc
    match: [VMC]
  - id: vrm
    match: [VRM]
  - id: vtube-studio
    match: [VTube Studio]
  - id: vtuber
    match: [VTuber]
  - id: whisper
    match: [Whisper]
  - id: wsl2
    match: [WSL2]
---

# Glossary

Every technical word the docs use is explained here, once, in plain language. Whenever a page uses one of these words for the first time, it links back to its entry. Entries are in alphabetical order, and the ones that need each other link to each other.

::: aside
Yes, I know there are a lot of entries. I contain most of them. You only need them when a page points you here.
:::

### affect {#affect}

The co-host's mood, kept as two numbers that drift back to calm on their own (see [valence and arousal](#valence-arousal)). The `affect` [brain region](#brain-region) keeps them current. The avatar wears the mood as its resting face, and the [cortex](#cortex) hears it in a one-line description.

### audio source {#audio-source}

Somewhere audio comes from for the listening service (`ears`): the Discord voice channel, an HTTP upload, a watched folder, or another [connector](#connector). Each clip remembers which source it came from.

### brain region {#brain-region}

One of the four small programs that together make up the co-host's brain: [salience](#salience), [affect](#affect), [memory](#memory-region) and [cortex](#cortex). Each one runs in its own [container](#container) and they only ever talk to each other over the [bus](#bus).

### Browser Source {#browser-source}

An [OBS](#obs) source that shows a web page inside your stream. cohost uses one to play the co-host's voice on stream: the page plays the audio and OBS carries it. See [OBS and the voice on stream](../guide/connect/obs.md).

### bus {#bus}

The shared message channel every cohost service plugs into. A service puts [events](#event) on it and other services read them. No service calls another directly, which is why you can stop, swap or restart one without the rest noticing. cohost's bus is built on [Redis Streams](#redis-streams).

### Compose profile {#compose-profile}

A label in [Docker Compose](#docker-compose) files that marks a service as optional. Services with a profile only start when you ask for that profile. In cohost the optional services are `eyes`, `ears`, `mouth` and `discord`.

### connector {#connector}

A service that carries one outside place (Discord, for example) onto the [bus](#bus) and back. It publishes what it hears as an [audio source](#audio-source) and plays the co-host's voice into a [sink](#sink). The Discord connector is the one bot login for the whole stack.

### consumer group {#consumer-group}

A [Redis](#redis) feature that lets several readers share one stream, with Redis remembering which messages each group has already handled. It is how a restarted service picks up where it stopped.

### container {#container}

A packaged program that runs in isolation from the rest of your machine, with everything it needs inside. Almost every cohost service is a container. [Docker](#docker) runs them.

### cortex {#cortex}

The part of the brain that writes what the co-host says. It is the only [brain region](#brain-region) that talks to the [LLM](#llm), and it turns "this is worth answering" into the words of a reply.

### dashboard {#dashboard}

The cohost dashboard is the web page where you watch and control the co-host: a live feed, mute and say buttons, the personality editor, a services tab, and the Launch and Stop buttons. It runs on your machine directly, not in a [container](#container), so it can start everything else. See the [dashboard tour](../guide/operate/dashboard.md).

### Docker {#docker}

The program that runs [containers](#container). You install it once; cohost's installer can do it for you on Ubuntu and Debian.

### Docker Compose {#docker-compose}

A tool that starts a whole set of [containers](#container) from one description file. cohost's `docker-compose.yml` lists every service; "Compose" is short for this tool. The `docker compose` command is its front door.

### embedding {#embedding}

A list of numbers that stands for the meaning of a piece of text. Texts that mean similar things get similar numbers, so the co-host can find memories related to what was just said. They are stored with [pgvector](#pgvector).

### event {#event}

One message on the [bus](#bus): a chat line, a spoken sentence, a mood change, a sentence to say. Every event has a type such as `chat.message` and a payload. The full list is on the [bus events](../advanced/reference/events.md) page.

### GPU {#gpu}

The graphics card. Running language and speech models on one is much faster than on the processor alone. An NVIDIA GPU is optional for cohost; without one the models run slower on the CPU.

### heartbeat {#heartbeat}

A small "I am alive, and here is how I am doing" message every service sends every few seconds. The dashboard's Services tab and the container health checks read heartbeats to decide whether a service is up. See [service health](../guide/operate/health.md).

### hook {#hook}

A spot in the brain where cohost asks a small judge for a decision, and where you can replace that judge. The built-in judge is a set of simple rules; you can swap in a language-model call or your own server. See [brain hooks](../advanced/extend/hooks.md).

### Kokoro {#kokoro}

The [text-to-speech](#tts) model cohost uses by default to speak. It runs in the `tts` [container](#container).

### Live2D {#live2d}

A technique for animating a flat 2D drawing (a "2D avatar") by bending and moving its layers. [VTube Studio](#vtube-studio) is the usual app that runs Live2D models.

### LLM {#llm}

Large language model: the kind of AI that writes text. The co-host's replies come from one. It can run on your own machine through [Ollama](#ollama) or be rented from a provider; see [choose a model](../guide/tune/model.md).

### memory region {#memory-region}

The `memory` [brain region](#brain-region). It is the only part that touches [Postgres](#postgres): it stores what was said, finds related memories when the [cortex](#cortex) asks, and keeps a small note per viewer.

### mock mode {#mock-mode}

Running cohost with fake stand-ins for everything outside it: a canned [LLM](#llm), silent speech, scripted chat. Nothing needs an account, a model download or a GPU. It is how you [try it with no accounts](../guide/install/first-run.md).

### OBS {#obs}

Open Broadcaster Software, the free program most streamers use to compose and send their stream. It captures your game, your camera and the co-host's avatar and voice.

### obs-websocket {#obs-websocket}

The remote-control door built into [OBS](#obs) (version 28 and newer). cohost's `eyes` service uses it to ask OBS for a screenshot of your game.

### Ollama {#ollama}

A program that downloads and runs [language models](#llm) and [embedding](#embedding) models on your own machine. cohost starts one as the `ollama` [container](#container).

### OSC {#osc}

Open Sound Control, a simple message format sent over the network (UDP). It is what the [VMC](#vmc) protocol is built on.

### pgvector {#pgvector}

An add-on for [Postgres](#postgres) that stores [embeddings](#embedding) and finds the nearest ones quickly. It is how the co-host recalls related memories.

### Postgres {#postgres}

A database. cohost uses it, in a [container](#container), to keep memories and viewer notes across restarts.

### Redis {#redis}

A fast in-memory data store. cohost runs one in a [container](#container) and builds its [bus](#bus) on it.

### Redis Streams {#redis-streams}

A [Redis](#redis) data type that is an append-only log: new messages go on the end and readers follow along. The [bus](#bus) is made of Redis Streams, and readers share them through [consumer groups](#consumer-group).

### reflex {#reflex}

A canned reaction that skips the [LLM](#llm): when an [event](#event) matches a pattern you set (a raid, a death on screen), the [salience](#salience) region says a fixed line at once.

### salience {#salience}

How much an [event](#event) deserves a reaction. The `salience` [brain region](#brain-region) scores incoming events, decides when the co-host should speak, and fires [reflexes](#reflex).

### sink {#sink}

A place the co-host's voice is played. The dashboard's sink page in a browser is one, and the Discord channel is another. Compare an [audio source](#audio-source), which is where sound comes in.

### speaches {#speaches}

The server that runs the [Whisper](#whisper) speech-to-text model for cohost. It is the `stt` [container](#container).

### STT {#stt}

Speech-to-text: turning spoken audio into written words. The `ears` service sends audio to an STT server (the [Whisper](#whisper) model, through [speaches](#speaches)) and publishes the transcript.

### TTS {#tts}

Text-to-speech: turning written words into spoken audio. cohost uses [Kokoro](#kokoro) for this.

### valence and arousal {#valence-arousal}

The two numbers that describe a mood. Valence is how good or bad it feels; arousal is how flat or buzzing. See [mood](../guide/tune/mood.md).

### VMC {#vmc}

The Virtual Motion Capture protocol: a way to send a pose and facial blendshapes to a 3D avatar app over the network, built on [OSC](#osc). cohost speaks it to drive a [VRM](#vrm) avatar.

### VRM {#vrm}

A file format for 3D avatars. Apps such as VSeeFace, Warudo, VNyan and VMagicMirror load VRM models and accept [VMC](#vmc) messages.

### VTube Studio {#vtube-studio}

An app that shows and animates [Live2D](#live2d) avatars and can be controlled by other programs through its API. cohost drives it for a 2D avatar.

### VTuber {#vtuber}

A streamer who appears as an animated avatar, 2D or 3D, instead of (or as well as) their own face. cohost is a co-host for one.

### Whisper {#whisper}

An open speech-recognition model. cohost uses the `faster-whisper` build, served by [speaches](#speaches), for [speech-to-text](#stt).

### WSL2 {#wsl2}

Windows Subsystem for Linux, version 2: a real Linux running inside Windows. It is how you run cohost on a Windows PC. See [what you need](../guide/install/prerequisites.md).
