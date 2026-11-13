---
parent: high-level-design
prefix: CONN
---

# connections

> The connector protocol, and the Discord connector that is its first connector. Specs: [connections-specs.md](./connections-specs.md). Decision record: [connector-protocol](decisions/connector-protocol.md). HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

A **connector** is an external process that attaches to the bus dynamically. It speaks to something the rest of cohost should not know how to reach (Discord's gateway and voice servers, a Windows audio API), and it exposes that thing to the stack as audio sources and audio sinks. It registers itself, heartbeats, declares what it offers, and exchanges live audio with the services that use it. ears consumes sources; mouth writes to sinks; neither knows which connector, process or host stands behind a tag.

This segment owns two things:

1. **The protocol**: how a connector registers and stays alive, how source and sink tags are named, which Redis streams carry live audio and in what frame format, and what happens when frames are lost or a peer is gone.
2. **The Discord connector** (`services/connector-discord`): the process that logs in as the co-host's one Discord bot, holds the one voice connection, publishes each human speaker's audio as a source and plays a sink's audio into the channel.

ears and mouth are the protocol's consumers and keep their own segments: ears turns source audio into `speech.heard`, mouth plays `voice.utterance` lines to sinks. Neither holds a Discord client, reads a Discord token, or joins voice.

Design leanings:

- **Audio never rides `cohost:events`.** Live audio is on dedicated capped streams beside it. The event stream stays small, replayable and cheap to tail, which is why the HLD kept binary data off it ([connector-protocol](decisions/connector-protocol.md), Decision Elements).
- **Loss is chosen, not accidental.** Live audio that arrives late is worse than audio that is missing. Producers never wait, consumers read live only, and every gap is counted and visible in health (CONN-BP-*).
- **Presence is a lease.** A connector's registration expires unless refreshed, so a crashed connector disappears from the registry without anyone cleaning up after it.
- **Failure stays where it happens.** A connector going away turns the dependencies that use its tags `down` and nothing else; consumers going away never block the connector (CONN-ISO-*).
- **The protocol is language-neutral.** A connector is anything that can write a Redis key and a Redis stream; the desktop helper does not have to be Node.
- **Same posture as every service.** A missing token idles the Discord connector with an honest heartbeat; a login failure exits 1; a failed join is retried with the shared backoff.

Ownership notes: the Redis key layout and stream names are specified here, and the `<prefix>` of every key and stream is the bus prefix of event-bus BUS-STREAM-008 (default `cohost`), so tests keep their traffic off production keys. The heartbeat contract belongs to [control-plane](../control-plane/control-plane-design.md), the Discord voice session (join loop, rejoin) to [shared-runtime](../shared-runtime/shared-runtime-design.md) (SHARED-DVS-*), the consumers' behaviour to [ears](../ears/ears-design.md) and [mouth](../mouth/mouth-design.md), the manifest unit and Compose service to control-plane and [deployment](../deployment/deployment-design.md), and the `connections` config section's schema to [config](../config/config-design.md).

## Registration and liveness

A connector owns one Redis string, the **registration**, at `<prefix>:connector:<id>`. Its value is JSON:

```json
{
  "v": 1,
  "id": "discord",
  "kind": "discord",
  "version": "0.1.0",
  "instance": "<uuid>",
  "pid": 1234,
  "startedAt": 1731400000000,
  "intervalMs": 5000,
  "state": "ready",
  "detail": "",
  "capabilities": [
    { "cap": "audio-in",  "tag": "discord", "format": { "rate": 16000, "channels": 1 }, "ready": true },
    { "cap": "audio-out", "tag": "discord", "format": { "rate": 48000, "channels": 2 }, "ready": true }
  ]
}
```

- **`id`** names the connector in the registry and in its heartbeat; it matches the tag grammar below and is unique among live connectors. A connector that starts under an `id` that is already registered replaces that registration (a restarted process takes over at once rather than waiting out the old lease); the displaced instance stops registering when it sees a different `instance` under its key.
- **Lease.** The connector writes the key at start and rewrites it every `intervalMs` (default 5000) with an expiry of three intervals. A connector that stops, crashes or loses Redis disappears from the registry within three intervals. On orderly shutdown it deletes its key.
- **Capabilities.** Each entry names a capability (`audio-in`: the connector publishes a source; `audio-out`: the connector plays a sink), the tag it serves, the audio format of the stream, and `ready`: whether audio flows right now (the Discord connector is registered while its voice join is still retrying, with `ready: false`). A consumer that finds an unknown capability ignores it, so the vocabulary can grow (a chat capability is the obvious next one, deferred).
- **Discovery.** There is no registry service. A consumer reads the key space: it lists `<prefix>:connector:*` (`SCAN`) and re-reads on a short period, and treats a tag as available while a live registration offers it with `ready: true`. A consumer never needs to restart to notice a connector coming or going.
- **Health.** The registration answers "is this tag usable"; the connector also publishes the standard `service.heartbeat` on `<prefix>:health` under its `id`, so the Services tab, `cohostctl` and the control plane's health tracker treat it like any service. The two are written by the same timer.

### Tags

A tag names a source (`audio.in.<tag>`) or a sink (`audio.out.<tag>`). Tags are **open**: any connector may register any tag that matches the grammar `[a-z][a-z0-9-]{0,31}` and is not reserved; nothing in cohost enumerates them. Sources and sinks are separate namespaces, so `discord` is both a source and a sink without ambiguity.

- **Reserved tags**, which a connector may not register because they already name something else: `http`, `dir` (ears' in-process capture sources), `dashboard`, `mouth`, `dryrun`, `file` (sink names in voice's arbitration protocol).
- **Ownership.** A tag in one direction is served by one live connector. A registration naming a tag that another live registration (a different `id`) already serves is refused: the connector keeps retrying each interval, reports `degraded` with the conflict in its detail, and offers no capability for that tag meanwhile.
- **Meaning to consumers.** A source tag is what ears' `ears.sources` lists and what `speech.heard.source` carries; a sink tag is a mouth output's name and the `sink` mouth reports in `voice.playing` / `voice.done` (so the Discord sink keeps the name `discord`).

## Audio streams

| Stream | Direction | Producer | Consumer |
| --- | --- | --- | --- |
| `<prefix>:audio.in.<source>` | external world to cohost | the connector serving the source tag | ears (any other reader may also read it) |
| `<prefix>:audio.out.<sink>` | cohost to external world | mouth's output for the sink | the connector serving the sink tag |

Each is a Redis Stream, written with `XADD ... MAXLEN ~ <cap>` and given an expiry that every write refreshes (60 s), so a stream nobody writes to disappears.

**Frame.** One stream entry is one frame, with these fields (all strings except `pcm`, which is binary):

| Field | Direction | Meaning |
| --- | --- | --- |
| `v` | both | Frame format version, `1` |
| `epoch` | both | The producer's start time in ms; a changed epoch means the producer restarted and `seq` began again |
| `seq` | both | Frame counter, starting at 0 within an epoch; a consumer detects loss from gaps |
| `rate`, `ch` | both | Sample rate and channel count of `pcm`; they equal the format in the registration |
| `pcm` | both | Signed 16-bit little-endian interleaved PCM, nominally 20 ms (the producer may send any whole number of sample frames up to 64 KiB) |
| `spk` | in | Speaker id: opaque, stable per speaker within the source (the Discord user id) |
| `name` | in | Speaker display name, for labels only |
| `utt` | out | The `voice.utterance` id the frame belongs to |
| `last` | out | `1` on the final frame of that utterance |

**Formats.** `audio.in` is what speech-to-text takes without further work: 16 kHz mono. `audio.out.discord` is what Discord's player takes: 48 kHz stereo. A connector declares each stream's format in its registration; a producer writes exactly that format and a consumer that meets another rate or channel count drops the frame and counts it (CONN-AUD-003). Conversion belongs to the side that owns the foreign format: the Discord connector decodes Opus and resamples to 16 kHz mono on the way in; mouth converts a line's WAV to the sink's declared format on the way out, with the shared `resample` (SHARED-AUDIO-005, SHARED-AUDIO-006).

**Speakers and utterances.** `audio.in` has no utterance boundary: frames flow only while somebody is transmitting, tagged with `spk`. The consumer owns where an utterance ends, by silence: ears closes a speaker's utterance when no frame from that `spk` has arrived for `ears.silence_ms`, which keeps that setting and its latency trade-off with ears. A source that cannot tell speakers apart uses one constant `spk` and `name`.

### Loss and back-pressure

Live audio cannot be paused, so the policy is to bound memory and to lose the oldest first.

- **Producers never wait.** A write does not depend on any consumer being present or fast. The cap on the stream (`audio.in`: about 3000 entries, a minute of one speaker; `audio.out`: about 1500 entries, thirty seconds) is the entire buffer: past it Redis evicts the oldest frames.
- **Consumers read live.** A consumer starts at the stream's end (`$`) when it connects and never replays: a plain blocking `XREAD`, no consumer group, no acknowledgement. Frames written while a consumer was away are not heard late. Several consumers each see every frame.
- **Gaps are counted.** A consumer compares `seq` within an epoch; each missing frame adds to a loss counter that its heartbeat reports in its detail, and a gap longer than `ears.silence_ms` closes the speaker's utterance like silence does. A new epoch resets the counter's baseline without counting loss.
- **Output is paced.** Eviction would cut the start off a long line written all at once, so mouth writes an utterance's frames at real time with a lead of one second, not as a burst. The connector keeps a short jitter buffer and plays frames in `seq` order; a gap is played as the frames that are there (a click, not a stall). A sink whose connector is not registered `ready` is not ready for mouth (the ordinary skip of MOUTH-ROUTE-003), and frames reaching a connector that has no player are discarded.
- **Malformed frames** (wrong version, rate, channel count, size or no `pcm`) are dropped and counted, never raise.

## Discord connector

`services/connector-discord` is the Discord connector. It reads `DISCORD_TOKEN` (the one token in the stack) and the `connections.discord` config section, and registers as connector `discord` serving source `discord` and sink `discord`.

1. **Login and intents.** `Guilds`, `GuildVoiceStates` and `GuildMembers` (the privileged Server Members intent, for display names). A failed login exits 1; a missing token idles `degraded` with `DISCORD_TOKEN is not set`, through the shared idle plan, and registers nothing.
2. **One voice connection.** On the client's `ready` the connector joins `connections.discord.voice_channel_id` of `connections.discord.guild_id` through the shared Discord voice session, **not self-deafened and not self-muted**: the same connection must hear the channel (ears) and speak into it (mouth), and a deafened connection receives no audio. This is the voice-state setting that lets one bot do both. The bot permissions are Connect and Speak.
3. **Rejoin ownership.** The connector alone joins, rejoins and leaves. A failed join is retried with the shared backoff (5 s doubling to 60 s, SHARED-DVS-004); a disconnect that does not recover within 5 s rejoins (SHARED-DVS-003). Throughout, the registration stays and both capabilities report `ready: false`; ears and mouth do not join, ask for a join or notice anything except that the tags are not ready, and recover without restart when they become ready again.
4. **Listening.** For every speaker that is not a bot account (judged by the user's `bot` flag, fetched when not cached, before any subscription), the connector subscribes to that user's Opus stream, decodes it, converts 48 kHz stereo to 16 kHz mono with the shared `resample`, and writes 20 ms frames to `audio.in.discord` with the speaker's user id as `spk` and the guild display name (user id when unknown) as `name`. Bot accounts' audio is never read, which excludes the co-host itself, a music bot and any other TTS bot. A speaker already being captured is not subscribed twice; a decoder error removes the speaker from the set and logs a warning.
5. **Speaking.** The connector reads `audio.out.discord` live, feeds the frames in order through a short jitter buffer to one audio player subscribed to the connection, and discards frames while it has no ready connection. It has no notion of lines, queues, gain or fallbacks: those are mouth's.
6. **Shutdown.** One sequence: delete the registration, destroy the voice connection and the client, then stop the bus.

The connector publishes no domain event and subscribes to none. It is not a sense: it holds the connection, and ears and mouth decide what the audio means.

One bot means one guild and one channel for listening and speaking together. The earlier arrangement allowed ears and mouth to sit in different channels; that is no longer expressible, and the keys are the connector's (`connections.discord.guild_id`, `connections.discord.voice_channel_id`).

## Failure isolation

| Situation | Effect |
| --- | --- |
| Connector down, restarting or never started | Its registration lapses within three intervals. ears reports `deps.discord` `down` and keeps every other source; mouth's `discord` output is not ready and skips lines (the dashboard sink or the virtual sink covers them); injection, chat, the brain and the avatar are unaffected. After it returns, both resume without restart |
| Discord unreachable or the join failing | The connector is up, registered, `degraded`, capabilities `ready: false`; consumers see the same as above |
| ears down | Frames accumulate to the stream's cap and the oldest are evicted; the connector's memory and behaviour are unchanged; mouth is unaffected |
| mouth down | `audio.out.discord` gets no frames; the connector idles its player; ears is unaffected |
| Redis down | The connector cannot register or move audio; it keeps its Discord connection and retries, like every service on the bus |
| Two connectors claim one tag | The second is refused and reports the conflict; the first is unaffected |
| A connector writes malformed frames | Consumers drop and count them; no consumer exits |

## Health

The Discord connector's `service.heartbeat` has `service` `discord`, mode `live` (or `off` when `connections.discord.enabled` is false, `mock` is not used: there is no stub Discord), and `deps` `discord` (the gateway and voice connection: `ok` only while the voice connection is Ready), `audio-in` and `audio-out` (`ok` while the capability is registered `ready` and, for `audio-in`, the connector is capturing; `down` otherwise). State is `starting` until the first join resolves, `ready` on Ready, `degraded` with a detail while a join fails or a tag conflicts. The detail includes the loss counters of frames it dropped. ears and mouth report the connector as a dependency of their own (`deps.discord`), not by reading the connector's heartbeat: they read the registration.

## Desktop audio helper

The desktop capture helper is a connector with the source tag `desktop` ([ears Desktop audio](../ears/ears-design.md#desktop-audio)). It registers connector `desktop` with an `audio-in` capability (16 kHz mono) and keeps its registration lease fresh like any connector, so its liveness is the registry's, not a request of its own (CONN-DESK-001). A capability carries a `transport`: `stream` (the default) means frames ride `audio.in.<tag>`; `http` means the connector offers presence only and its clips reach ears' HTTP listener, which is how the helper ships first (CONN-DESK-003). The helper then moves to frames on `audio.in.desktop` with `transport` `stream`, and the helper's silence cut and maximum clip length become ears' own silence rule (CONN-DESK-002, deferred). The helper has no code yet, so it is built on the registration from the start; the helper may reach Redis through `--redis-url` or `REDIS_URL`, and Redis is already published on the host loopback (DEPLOY-COMPOSE-006).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Where Discord lives | One connector process holds the bot and the one voice connection; ears and mouth hold none | Two bots; ears and mouth merged; a Discord-only service | Full comparison: [connector-protocol](decisions/connector-protocol.md). One login, independent restarts of ears and mouth, and the same path for non-Discord sources. |
| Segment shape | A leaf with the protocol and the Discord connector together | A leaf for the protocol and a leaf per connector; the protocol inside event-bus | The protocol has one implementation and one connector today, so one leaf is enough. Promote a connector to its own segment when it grows design of its own (the desktop helper is the likely first). Event-bus owns typed events on `cohost:events`; this protocol is deliberately outside them. |
| Presence | A TTL-leased registration key per connector, plus the ordinary heartbeat | A typed `connector.*` event on `cohost:events`; a registry service; the health stream alone | A lease expires on its own after a crash and can be read at any time, which a consumer that restarts needs; a start-mode-`latest` event would be missed by it. The heartbeat stays so the existing health tracker, Services tab and `cohostctl` work unchanged. A registry service would be one more process to fail. |
| Audio transport | Dedicated capped Redis streams, one per tag and direction, outside the event stream | Audio on `cohost:events`; HTTP between services; a WebSocket from the connector | Redis is the one infrastructure every service already reaches and the connector can be remote; HTTP or sockets would add ports and direct service-to-service calls (tenet 1). A separate stream keeps the 20 000-entry event stream replayable and the dashboard feed readable. |
| Delivery semantics | Live only: capped stream, plain `XREAD` from `$`, no group, no acknowledgement | Consumer groups with replay; at-least-once with acknowledgement | Late audio is worse than missing audio, and replaying seconds of old speech after a restart would produce transcripts of a conversation that ended. Plain reads also let several consumers share a stream. |
| Frame format | 16-bit PCM in a binary field, declared rate and channels, 20 ms nominal, `seq` and `epoch`; 16 kHz mono in, 48 kHz stereo out | Opus packets; base64 text; one fixed format for all streams | PCM needs no codec in ears or mouth and lets the desktop helper and any future connector send what it already has. Declaring the format keeps the protocol open without a negotiation round-trip. 16 kHz mono in is what STT consumes, at about a sixth of Discord's decoded size. |
| Utterance boundary | The consumer cuts on silence (a gap in frames); the connector sends frames only while someone transmits | The connector sends end-of-utterance markers; the connector runs a VAD | `ears.silence_ms` stays ears' own latency lever, a source with no notion of an utterance (desktop) fits, and a lost end marker cannot hang an utterance open. |
| Output pacing | mouth writes at real time with a one-second lead | Burst the whole line; a feedback channel from the connector | A burst is evicted by the cap on a long line; real-time writing needs no ack channel. The cost is that `voice.done` is timed from the write schedule, not from the player going idle (open question). |
| Bot accounts | The Discord connector reads no bot account's audio | ears drops bot audio; a configured list of ids | The connector must fetch the account before subscribing anyway, and transporting audio only to discard it wastes the stream. Ignoring bots as a class needs no configuration. |
| Voice state | Undeafened, unmuted | Self-deafened for speaking, self-muted for listening | One connection must do both. |
| Tag namespace | Open grammar with a short reserved list; sources and sinks are separate; one live owner per tag | A closed enum; one namespace for sources and sinks | An enum would make every new connector an edit to cohost; separate namespaces let `discord` be both. The reserved list prevents a connector colliding with names that already mean something (sink names in voice's protocol, ears' in-process sources). |
| Process naming | Directory and Compose service `connector-discord`; the connector's `id`, its heartbeat `service` and its manifest unit are `discord` | `connections` for the process; `discord` for the directory | The segment is named for the protocol and each connector for what it connects; the `id` is what the owner sees in the Services tab, and it equals the tag it serves. |

## Open Questions & Future Decisions

1. **`voice.done` timing for the Discord sink.** With paced writing, mouth times `voice.done` from its own schedule (last frame's scheduled play time). An acknowledgement stream from the connector (`audio.out.<sink>` played-up-to markers) would make it exact. Needs the owner's choice between exactness and a second stream.
2. **Consumer presence.** The connector publishes `audio.in.discord` whether or not ears runs, which costs a bounded stream write rate. Whether consumers should announce themselves so a connector can idle its capture is open.
3. **Where the client library lives.** Registration, tag validation, frame encode and decode and the `XREAD` loop are used by ears, mouth and the connector. Whether they belong to `@cohost/bus`, `@cohost/shared` or a new `@cohost/connector` package decides which segment's specs the code is annotated under.
4. **Heartbeat and registration as one write.** Registration and heartbeat carry overlapping data; folding one into the other (for example the registration key carrying the heartbeat and the health tracker reading keys) removes a duplicate but changes control-plane's contract.
5. **Process, service and profile names** (`connector-discord`, `discord`) and whether ears and mouth in Compose should depend on the connector's profile or stay independent of it.
6. **A bot moved or kicked from the channel.** Discord can move or disconnect a bot administratively. Today it is a disconnect handled by SHARED-DVS-003; whether the connector should rejoin the configured channel when moved elsewhere is undecided.
7. **Several guilds or channels.** One connector, one channel. More than one means more than one connector instance (each with its own `id` and tags) or a multi-channel connector; deferred.
8. **A chat capability.** The capability vocabulary admits it; its design (chat in, chat out, how it meets the `chat` segment) is deferred.
9. **Authentication.** Any process that reaches Redis can register and write audio, consistent with the HLD's trust boundary (the operator's LAN); a connector on another host reaches Redis the way every service does. A per-connector secret is not designed.

## Manual verification

1. **Native dependencies and DAVE.** `@discordjs/voice` loads `libsodium-wrappers`, `@snazzah/davey` (DAVE end-to-end encryption) and `opusscript` itself; the connector carries them without importing them. Whether receive, decode and send work against a real guild is checked by a first run: one bot in the channel, a human speaks and `speech.heard` appears with `source: discord`, a line is spoken and heard, and killing and restarting the connector rejoins with ears and mouth running throughout.
2. **Undeafened voice state.** Confirm in a real channel that the single connection both hears and speaks.

## References

Files in this segment (to be created):

- `services/connector-discord/src/*` (the Discord connector), `services/connector-discord/test/*.test.ts`
- the connector client library (location: Open Questions 3)

Other segments (arrow shows direction):

- connections -> [event-bus](../event-bus/event-bus-design.md): uses the bus prefix (BUS-STREAM-008) for its keys and streams and publishes its heartbeat on the health stream; publishes no domain event.
- connections -> [shared-runtime](../shared-runtime/shared-runtime-design.md): `runService`, `startIdle`, `createDiscordVoiceSession` (the only user), `resample`, `retryWithBackoff`.
- connections -> [config](../config/config-design.md): `loadConfig` (`connections.discord.*`), `env()`.
- connections -> [control-plane](../control-plane/control-plane-design.md): heartbeat contract; manifest unit `discord`.
- connections -> [deployment](../deployment/deployment-design.md): Compose service `connector-discord`, profile `discord`.
- ears -> connections: consumes `audio.in.<source>`; reads registrations ([ears](../ears/ears-design.md)).
- mouth -> connections: writes `audio.out.<sink>`; reads registrations ([mouth](../mouth/mouth-design.md)).
- connections <- [ears](../ears/ears-design.md#desktop-audio): the desktop capture helper becomes a connector.

External: discord.js 14, `@discordjs/voice`, `prism-media` (Opus decode), Redis Streams.

CONN specs: [connections-specs.md](./connections-specs.md).
