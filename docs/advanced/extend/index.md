---
title: Ways to extend cohost
description: The supported ways to swap or add a piece of cohost, what each route gives you, and why a process that is on neither bus client is not one of them.
track: advanced
verified: f126b94
---

# Ways to extend cohost

cohost is built so that any piece can be swapped, because pieces only meet on the [bus](../../start/glossary.md#bus) and in a few HTTP calls. This page lists the routes that are supported, what each one gives you, and what does not count as one.

## What you need

- The [simple track](../../guide/install/prerequisites.md) done, so you have a working co-host to extend.
- [Developer setup](../dev-setup.md) for any route that involves code in this repository.
- The [glossary](../../start/glossary.md) open in another tab if a word is new.

## The supported routes

| You want to | Route | You write | What you get |
| --- | --- | --- | --- |
| Add a service that reads and writes [events](../../start/glossary.md#event) | A TypeScript service on `@cohost/bus` | TypeScript, in `services/<name>` | Every event validated against its schema on publish and on read, a place on the dashboard (configurable, startable, injectable) through the service manifest, and [heartbeat](../../start/glossary.md#heartbeat) health from the shared runtime |
| Add a service that reads and writes events, in Rust | A Rust service on `crates/cohost-bus` | Rust, linking the crate | The bus client and a typed codec for the event types it handles. Supported, with no example yet |
| Replace a brain judgement with your own model | A [hook](../../start/glossary.md#hook) server over HTTP | Any language that serves HTTP, see [Brain hooks](hooks.md) | cohost calls it, checks the reply, and falls back to the built-in rules if it fails |
| Use a different chat model | Any OpenAI-compatible server | Nothing: set `llm.provider: openai` and `llm.openai.base_url` | The same brain on a model you host or rent. See [Choose a model](../../guide/tune/model.md) |
| Send audio into the listening service | The `http` [audio source](../../start/glossary.md#audio-source) of `ears` | A `POST` of a WAV or raw PCM clip from any language | The clip goes through the same [speech-to-text](../../start/glossary.md#stt) and hearing path as Discord audio, with no account |
| Receive the co-host's voice somewhere else | The `http` output of `mouth` | An HTTP endpoint that accepts `audio/wav` | Each spoken line `POST`ed to your URL, with retries and a bounded queue |

### A TypeScript service

A service is one folder under `services/` with an entry file that calls `runService` from `@cohost/shared`. The shared runtime builds the `Bus`, publishes heartbeats, handles `control` commands and `inject.request`, and shuts down cleanly. Inside it you publish and subscribe with typed events:

```ts
await bus.publish("chat.message", { platform: "twitch", user: "viewer", text: "hello" });
await bus.subscribe({ group: "my-service", types: ["brain.say"], start: "latest" }, async (ev) => {
  // ev.data is typed from the schema for "brain.say"
});
```

`publish` checks the payload against the schema in `packages/bus/src/events.ts` and rejects a bad one. A new event type is one more entry in that file, and then every service sees it typed. Adding a source, a second [text-to-speech](../../start/glossary.md#tts) engine or a new avatar driver never touches the [brain regions](../../start/glossary.md#brain-region); adding a region is the same move in reverse, a new service that subscribes to what it needs and publishes a new event type.

To appear in the dashboard, give the service an entry in `packages/control/src/manifest.ts` that names its config sections, the services it uses, whether it honours `pause`, and its test inputs, and add its [Compose](../../start/glossary.md#docker-compose) service. A service meets the module contract when it is configurable from the dashboard, operable on its own, injectable with no account and built on the shared runtime. [Developer setup](../dev-setup.md) shows the dev loop, and [Bus events](../reference/events.md) lists every event type.

### A Rust service

`crates/cohost-bus` is the same bus client in Rust: it owns the [Redis](../../start/glossary.md#redis) connections, every Redis command the bus issues and the key and stream names. It carries a typed codec for exactly the event types a Rust service publishes or reads, starting with `service.heartbeat` and the [connector](../../start/glossary.md#connector) registration, and a type is added to the codec together with its contract fixtures. The Node addon that TypeScript loads is built on the same crate, so the two clients share one implementation of the Redis side.

There is no example Rust service in the repository yet.

### A hook server

A hook is a spot in the brain where a small judge decides something: how much an event deserves a reaction, how a line moves the mood, whether a reply is fine to say. The built-in judge is a set of rules. You can point a hook at a URL you serve, in any language, and cohost sends it JSON and reads JSON back. [Brain hooks](hooks.md) has the contracts and a runnable Python example.

### Audio in over HTTP

Set `EARS_SOURCES=[http]` (or `ears.sources: [http]`) and `ears` listens on `ears.http` (default `127.0.0.1:8765`) for `POST /audio`. The body is a 16-bit WAV, or raw 16-bit PCM with `Content-Type: audio/L16; rate=16000; channels=1` (rate and channels are optional parameters). Add `?speaker=Name` to name the speaker and `?source=<tag>` to tag the clip with the source name of a connector that takes audio over HTTP (the default is `http`). `ears.http.token` makes the endpoint require `Authorization: Bearer <token>`.

```bash
curl --data-binary @clip.wav -H 'Content-Type: audio/wav' 'http://127.0.0.1:8765/audio?speaker=Chris'
```

The reply says whether the clip was heard and carries its transcript. The [HTTP routes](../reference/http.md) page has the status codes.

### Voice out over HTTP

Set `mouth.outputs.http.enabled: true` and `mouth.outputs.http.url` to an `http` or `https` URL. `mouth` sends each spoken line as a `POST` with `Content-Type: audio/wav` and the line's id in an `x-cohost-utterance-id` header, retries with backoff up to `mouth.outputs.http.retries`, and drops the oldest queued line past `mouth.outputs.http.max_queue`.

## What is not supported

A process that talks to Redis on its own, using neither `@cohost/bus` nor `crates/cohost-bus`, is not a supported way to add a service. A service written in Python that reads and writes the stream directly is the usual example. Such a process gets no event validation, no dashboard control and no health reporting:

- **No validation.** Nothing checks its payloads against the schemas, so a typo is silently ignored by every subscriber instead of failing at the publisher. The bus also reads each event back through the schema, so a malformed one is skipped.
- **No dashboard control.** It is not in the service manifest, so the dashboard and `cohostctl` cannot start, stop, restart, configure or inject into it, and it is outside the isolation presets.
- **No health reporting.** It does not publish heartbeats, so the Services tab shows it as `unknown` or not at all, and Compose health checks cannot see it.

If you want another language in the loop, use the HTTP routes above: a hook server, audio in over HTTP and voice out over HTTP. They keep cohost in charge of validation and health, and your code in charge of the judgement.

::: aside
I do accept applications for new body parts. They just have to go through the front door and wear the right badge.
:::
