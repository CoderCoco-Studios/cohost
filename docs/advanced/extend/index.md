---
title: Ways to extend cohost
description: The supported ways to swap or add a piece of cohost, what each route gives you, which languages have tested examples, and why a process that is on neither bus client is not one of them.
track: advanced
verified: f126b94
---

# Ways to extend cohost

cohost is built so that any piece can be swapped, because pieces only meet on the [bus](../../start/glossary.md#bus) and in a few HTTP calls. This page lists the routes that are supported, what each one gives you, which languages have a tested example for each task, and what does not count as a route. Each task has its own guide, linked in the tables below.

## What you need

- The [simple track](../../guide/install/prerequisites.md) done, so you have a working co-host to extend.
- [Developer setup](../dev-setup.md) for any route that involves code in this repository.
- The [glossary](../../start/glossary.md) open in another tab if a word is new.

## The supported routes

| You want to | Route | You write | What you get |
| --- | --- | --- | --- |
| Add a service that reads and writes [events](../../start/glossary.md#event) | A TypeScript service on `@cohost/bus`: [Add a TypeScript service](typescript-service.md) | TypeScript, in a folder under `services/` | Every event validated against its schema on publish and on read, a place on the dashboard (configurable, startable, injectable) through the service manifest, and [heartbeat](../../start/glossary.md#heartbeat) health from the shared runtime |
| Add a service that reads and writes events, in Rust | A Rust service on `crates/cohost-bus`: [Rust bus client](rust-bus.md) | Rust, linking the crate | The bus client and a typed codec for the event types it handles. It is a client, not a runtime: you publish your own heartbeats |
| Replace a brain judgement with your own model | A [hook](../../start/glossary.md#hook) server over HTTP: [Brain hooks](hooks.md) | Any language that serves HTTP | cohost calls it, checks the reply, and falls back to the built-in rules if it fails |
| Use a different chat model | Any OpenAI-compatible server: [Your own model server](model-server.md) | Nothing: a few `llm` config lines | The same brain on a model you host or rent |
| Send audio into the listening service | The `http` [audio source](../../start/glossary.md#audio-source) of `ears`: [Send audio to ears](audio-in.md) | A `POST` of a WAV clip from any language | The clip goes through the same [speech-to-text](../../start/glossary.md#stt) and hearing path as Discord audio, with no account |
| Drive a different avatar app | An avatar driver in the avatar service: [Add an avatar driver](avatar-driver.md) | TypeScript, in the repository | The same expressions on your app |
| Put a new judgement behind a hook | A new hook in the repository: [Add a brain hook](new-hook.md) | TypeScript, in the repository | A judgement that can run rules, a model or an HTTP server like the existing five |
| Receive the co-host's voice somewhere else | The `http` output of `mouth` | An HTTP endpoint that accepts `audio/wav` | Each spoken line `POST`ed to your URL, with retries and a bounded queue |
| Carry audio between cohost and an outside system | A [connector](../../start/glossary.md#connector), described in [Connector protocol](connector-protocol.md) | TypeScript on `@cohost/bus` | Audio in or out of a Discord channel or a capture helper. There is no connector SDK outside TypeScript |

The voice-out route is set up with `mouth.outputs.http.enabled` and `mouth.outputs.http.url`: `mouth` sends each spoken clause of a line as its own `POST` with `Content-Type: audio/wav`, the line's id in an `x-cohost-utterance-id` header and the clause's `seq` in an `x-cohost-clause` header, retries with backoff up to `mouth.outputs.http.retries`, and drops the oldest undelivered clause past `mouth.outputs.http.max_queue`.

## What a service gets

A service built on one of the two bus clients, `@cohost/bus` (TypeScript) or `crates/cohost-bus` (Rust), is the supported way to add a service. The TypeScript client comes with the shared runtime, which builds the connection, publishes the heartbeat, handles `control` commands and injection, and stops cleanly. That runtime is how a service meets the module contract: configurable from the dashboard, operable on its own, injectable with no account, and visible on the Services screen. The Rust client gives you the connections and a typed codec, and the rest is yours to write, as the [Rust bus client](rust-bus.md) guide shows.

Here is the whole shape of a TypeScript service, shown from the file the tests run:

<<< @/../examples/service/now-playing.ts#main

## Tested examples

Every guide shows one complete example that a test runs. This table says, for each task, which languages have one. A cell links the guide that shows it, and a dash means there is none. A language other than Python, TypeScript and Rust has no tested example, and uses the contracts and their `curl` scripts: the [hook contracts](hooks.md) with the try-it script that checks a server, the HTTP route of [Send audio to ears](audio-in.md) with its `curl` script, the OpenAI-compatible API with the check in [Your own model server](model-server.md), and the [Connector protocol](connector-protocol.md).

| Task | Python | TypeScript | Rust | Any language with curl |
| --- | --- | --- | --- | --- |
| Serve a brain hook | [Hook server in Python](hook-server-python.md) | [Hook server in TypeScript](hook-server-typescript.md) | [Hook server in Rust](hook-server-rust.md) | [Brain hooks](hooks.md) |
| Check a model server connection | [Your own model server](model-server.md) | [Your own model server](model-server.md) | — | [Your own model server](model-server.md) |
| Send audio to ears | [Send audio to ears](audio-in.md) | [Send audio to ears](audio-in.md) | — | [Send audio to ears](audio-in.md) |
| Add an avatar driver | — | [Add an avatar driver](avatar-driver.md) | — | — |
| Add a brain hook in the repository | — | [Add a brain hook](new-hook.md) | — | — |
| Add a service | — | [Add a TypeScript service](typescript-service.md) | [Rust bus client](rust-bus.md) | — |
| Write a connector | — | — | — | — |

## What is not supported

A process that talks to [Redis](../../start/glossary.md#redis) on its own, using neither `@cohost/bus` nor `crates/cohost-bus`, is not a supported way to add a service. A service written in Python that reads and writes the stream directly is the usual example. Such a process gets no event validation, no dashboard control and no health reporting:

- **No validation.** Nothing checks its payloads against the schemas, so a typo is silently ignored by every subscriber instead of failing at the publisher. The bus also reads each event back through the schema, so a malformed one is skipped.
- **No dashboard control.** It is not in the service manifest, so the dashboard and `cohostctl` cannot start, stop, restart, configure or inject into it, and it is outside the isolation presets.
- **No health reporting.** It does not publish heartbeats, so the Services screen shows it as `unknown` or not at all, and [Compose](../../start/glossary.md#docker-compose) health checks cannot see it.

A hook server, an audio client and a model server are not services, so they are the way another language joins in. They keep cohost in charge of validation and health, and your code in charge of the judgement.

Two more things are not available. A hook server sends no heartbeat of its own: its health is the `hook.<name>` dependency of the service that calls it. And a connector in a language other than TypeScript is not a supported route yet, because the protocol has no SDK, no example and no test outside TypeScript.

::: aside
I do accept applications for new body parts. They just have to go through the front door and wear the right badge.
:::
