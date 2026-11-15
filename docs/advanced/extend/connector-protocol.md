---
title: Connector protocol
description: "The wire protocol a connector speaks to cohost, in any language: the registration key, the audio streams, frames, tags, flush, loss and every protocol constant, checked against the contract fixtures."
track: advanced
verified: f126b94
---

# Connector protocol

A [connector](../../start/glossary.md#connector) is a process that carries audio between an outside system (a Discord voice channel, a desktop capture helper) and cohost. This page describes the protocol it speaks. It is a reference, so read it rather than follow it.

The protocol is plain Redis keys and streams, so it does not depend on a language. It does have one implementation today: every connector in this repository is TypeScript built on `@cohost/bus`, the library every connector uses today. There is no SDK in any other language, and `crates/cohost-bus` encodes the registration but has no frame codec or tag grammar and runs no connector. There is no SDK, no example and no test for a connector in another language, so writing one is not a supported route, and no connector in a language other than TypeScript exists yet. This page is here so you can read how the existing ones talk to cohost, and so a future one has a written contract to meet.

The [Ways to extend cohost](index.md) page lists the routes that are supported. If you want another language in the loop today, those are the [HTTP routes](../reference/http.md), not this protocol.

## What the contract is held to

Every value on this page is held to the contract fixtures in [`packages/bus/fixtures/contract`](https://github.com/CoderCoco-Studios/cohost/tree/main/packages/bus/fixtures/contract), a directory of JSON cases that the TypeScript tests check the codecs against. Where a section below says what a frame, a tag or a registration must look like, the fixtures hold the exact valid and invalid cases:

- [`registration/`](https://github.com/CoderCoco-Studios/cohost/tree/main/packages/bus/fixtures/contract/registration) holds registrations, valid and not.
- [`frames/`](https://github.com/CoderCoco-Studios/cohost/tree/main/packages/bus/fixtures/contract/frames) holds audio frames, valid and malformed.
- [`tags/`](https://github.com/CoderCoco-Studios/cohost/tree/main/packages/bus/fixtures/contract/tags) holds tags, valid and not.
- [`constants.json`](https://github.com/CoderCoco-Studios/cohost/blob/main/packages/bus/fixtures/contract/constants.json) holds the constants and a worked example of the names below.

## Names

Everything lives under a key prefix, which is `cohost` unless the instance sets another. The forms are:

- `<prefix>:connector:<id>` is a connector's registration, a Redis key.
- `<prefix>:audio.in.<tag>` is the stream of a source, audio coming into cohost.
- `<prefix>:audio.out.<tag>` is the stream of a sink, audio going out of cohost.

A source tag and a sink tag are separate namespaces, so one tag may be a source and a [sink](../../start/glossary.md#sink) at once. The `<id>` and `<tag>` follow the [tag grammar](#tags).

## The registration

A connector announces itself by writing a JSON value to its registration key. The fields are:

| Field | Meaning |
| --- | --- |
| `v` | The registration version, `1`. |
| `id` | The connector's id, which is also the last part of its key. |
| `kind`, `version` | What kind of connector it is and its own version, as text. |
| `instance` | A unique id for this run. |
| `pid`, `startedAt` | The process id and its start time in milliseconds. |
| `intervalMs` | How often it rewrites the registration. |
| `state`, `detail` | A state word such as `ready` or `degraded` and a short message. |
| `capabilities` | What it offers, one entry for each source or sink. |

Each capability entry has `cap` (`audio-in` for a source, `audio-out` for a sink), `tag`, `format` (`rate` in Hz and `channels`), `ready`, `transport` (`stream` or `http`) and, for a sink, `flush`. A `transport` of `stream` means audio moves as frames on the stream described below; `http` means the connector posts clips to `ears` over HTTP and writes no frames. A consumer ignores a capability whose `cap` it does not know and uses the rest of the registration. A tag is usable only while a live registration offers it with `ready` true.

### The lease

The registration is a lease, not a record. The connector rewrites it every `intervalMs` (the default is in the constants table) and gives the key an expiry of three intervals, so a connector that stops, crashes or loses [Redis](../../start/glossary.md#redis) is gone from the registry within three intervals. On an orderly stop it deletes the key first.

If a connector registers under an `id` that already has a registration from a different `instance`, it replaces that registration at once, and the older instance stops registering when it reads a different `instance` under its key. If another live connector already serves a tag in the same direction, a connector does not register that capability. It reports the state `degraded` with a detail that names the tag and the other connector, and tries again every interval.

A consumer finds connectors by listing the `<prefix>:connector:*` keys and re-reads the list at least every `intervalMs`, so it notices one appearing or disappearing without a restart. While it runs, a connector also publishes a [heartbeat](../../start/glossary.md#heartbeat) on the health stream from the same timer, with `service` set to the name of its process.

## Tags

A source tag or a sink tag matches `[a-z][a-z0-9-]{0,31}`: a lowercase letter, then up to 31 lowercase letters, digits or hyphens. These tags are reserved because they already name something else: `http`, `dir`, `dashboard`, `mouth`, `dryrun` and `file`. A tag that merely starts with a reserved word, such as `mouth-out`, is fine. The `tags/` fixtures hold the edge cases, such as a 32-character tag that is valid and a 33-character one that is not.

## Frames

Audio moves as frames on a [Redis Stream](../../start/glossary.md#redis-streams). A frame is one stream entry whose fields are:

| Field | Meaning |
| --- | --- |
| `v` | The frame version, `1`. |
| `epoch` | The producer's start time in milliseconds. |
| `seq` | The frame's number, from 0 within an epoch. |
| `rate`, `ch` | The sample rate in Hz and the channel count. |
| `pcm` | Binary: signed 16-bit little-endian interleaved samples, at most the maximum frame size. |
| `spk`, `name` | On `audio.in` only: the speaker's stable id within the source and a display label. A source that cannot tell speakers apart uses one constant value for each. |
| `utt`, `last` | On `audio.out` only: the id of the spoken line, and `1` on the line's last frame. |
| `flush` | On `audio.out` only: `1` on a flush frame. |

A producer writes frames in the format its registration declares, without waiting for any consumer, and every write caps the stream's length (about `AUDIO_MAXLEN` entries for the direction) and refreshes the stream's expiry. The `frames/` fixtures hold a good frame and each malformed one: a wrong version, a missing `pcm`, a size over the maximum, an odd byte count, a zero rate and a negative `seq`.

## Flush

A flush frame stops a line that is playing. A producer writes one only to a sink whose registration has `flush` true. It carries the producer's next `seq` in the current epoch, `v`, `rate` and `ch`, `flush` `1` and the stopped line's `utt`, and it has no `pcm`. A consumer that obeys flush stops the audio it is playing and throws away every frame it holds from before the flush, then plays later frames as a new line. A flush frame read while nothing is playing changes nothing, and it is not counted as malformed or lost. A sink without `flush` plays out what was already written: a short tail, at most the producer's one-second lead plus the connector's own buffer.

## Loss and back-pressure

A producer never blocks on a consumer. If one is slow, absent or gone, the stream's length cap drops the oldest frames, and a producer that cannot write a frame now drops it because it would be stale by the time the connection returned.

A consumer starts at the end of the stream with a plain blocking read, with no [consumer group](../../start/glossary.md#consumer-group) and no acknowledgement. It does not replay frames written before it connected, and other consumers' reads are unaffected. It does its own accounting:

- A frame with a `rate` or `ch` other than the registered format is dropped and counted.
- A malformed frame is dropped, counted, and the consumer keeps running.
- A `seq` that jumps by more than one within an epoch adds the gap to a lost-frames count, which a consumer reports in its heartbeat detail. A new `epoch` resets the baseline without counting loss.

A sink connector that has no ready connection discards the `audio.out` frames it reads, and the speaking service treats that output as not ready while its registration is absent or not ready.

## The constants

Every constant of the protocol, with the value held in `constants.json`. The docs check compares this table with that file.

| Constant | Value | What it is |
| --- | --- | --- |
| `FRAME_VERSION` | `1` | The `v` of every frame. |
| `MAX_FRAME_BYTES` | `65536` | The most bytes in one frame's `pcm`. |
| `AUDIO_MAXLEN.in` | `3000` | The approximate length cap of an `audio.in` stream, in entries. |
| `AUDIO_MAXLEN.out` | `1500` | The approximate length cap of an `audio.out` stream, in entries. |
| `AUDIO_STREAM_TTL_MS` | `60000` | The expiry every write refreshes on an audio stream, in milliseconds. |
| `LEASE_INTERVALS` | `3` | How many intervals a registration lives without a rewrite. |
| `REGISTRATION_VERSION` | `1` | The `v` of a registration. |
| `DEFAULT_CONNECTOR_INTERVAL_MS` | `5000` | The default `intervalMs`, in milliseconds. |

The TypeScript source of these values is `packages/bus/src/connector.ts`, which also holds the frame codec and the tag grammar a connector in any language would have to match.
