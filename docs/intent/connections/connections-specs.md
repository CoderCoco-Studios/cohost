# connections specs

Segment `connections` (prefix `CONN`). LLD: [connections-design.md](connections-design.md); decision record: [connector-protocol](decisions/connector-protocol.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred. `<prefix>` is the bus prefix of event-bus BUS-STREAM-008 (default `cohost`).

## Registration and liveness

- [x] **CONN-REG-001**: When a connector starts, it shall write the JSON registration `{ v, id, kind, version, instance, pid, startedAt, intervalMs, state, detail, capabilities }` to the Redis key `<prefix>:connector:<id>`, with `v` `1`, an `id` matching `[a-z][a-z0-9-]{0,31}` and one `capabilities` entry `{ cap, tag, format: { rate, channels }, ready, transport }` per capability it offers, where `transport` is `stream` (the default: frames ride `audio.in.<tag>` or `audio.out.<tag>`) or `http` (only for `audio-in`: the connector holds a liveness lease and the clips reach ears over its HTTP listener, CONN-DESK-001). <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-REG-002**: While a connector runs, it shall rewrite its registration every `intervalMs` (default 5000) with an expiry of three intervals, so that a connector that stops, crashes or loses Redis is absent from the registry within three intervals. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-REG-003**: When a connector shuts down in an orderly way, it shall delete its registration key before it stops its bus connection. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-REG-004**: When a connector registers under an `id` that already has a registration with a different `instance`, it shall replace that registration at once, and the displaced instance shall stop registering when it reads a different `instance` under its key. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-REG-005**: Where a registration lists a capability other than `audio-in` or `audio-out`, a consumer shall ignore that capability and use the rest of the registration. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-REG-006**: A consumer of a source or sink tag shall find the tag's connector by listing the `<prefix>:connector:*` keys, shall treat the tag as available only while a live registration offers it with `ready` true, shall re-read the registry at least every `intervalMs`, and shall notice a connector appearing or disappearing without restarting. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-REG-007**: While a connector runs, it shall publish `service.heartbeat` on `<prefix>:health` with `service` set to its `id`, driven by the same timer as its registration. <!-- test: packages/bus/test/connector.test.ts -->

## Tags

- [x] **CONN-TAG-001**: A source tag and a sink tag shall match `[a-z][a-z0-9-]{0,31}`; a connector shall not register a capability whose tag does not. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-TAG-002**: A connector shall not register a capability with the tag `http`, `dir`, `dashboard`, `mouth`, `dryrun` or `file`. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-TAG-003**: Where a live registration with a different `id` already serves a tag in a direction (`audio-in` or `audio-out`), a connector shall not register a capability for that tag in that direction; it shall retry every interval, report heartbeat state `degraded` with a detail naming the tag and the other connector, and offer no capability for the tag meanwhile. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-TAG-004**: Source tags and sink tags shall be independent namespaces: one tag may be a source and a sink at once. <!-- test: packages/bus/test/connector.test.ts -->

## Audio streams and frames

- [x] **CONN-AUD-001**: A connector serving a source shall write its audio to the Redis stream `<prefix>:audio.in.<source>`, and mouth shall write audio for a sink to `<prefix>:audio.out.<sink>`; every write shall use `MAXLEN ~` with the stream's cap (about 3000 entries for `audio.in`, 1500 for `audio.out`) and shall refresh a 60 s expiry on the stream. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-AUD-002**: A frame shall be one stream entry with the string fields `v` (`1`), `epoch` (the producer's start time in ms), `seq` (from 0 within an epoch), `rate`, `ch`, and the binary field `pcm` of signed 16-bit little-endian interleaved samples of at most 64 KiB; an `audio.in` frame shall also carry `spk` and `name`, and an `audio.out` frame `utt` and, on the last frame of an utterance, `last` `1`. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-AUD-003**: A producer shall write frames in the format its registration declares for the stream (the Discord connector: `audio.in.discord` 16000 Hz, 1 channel; `audio.out.discord` 48000 Hz, 2 channels), and a consumer that reads a frame whose `rate` or `ch` differs from that format shall drop it and count it. <!-- test: packages/bus/test/connector.test.ts -->
- [ ] **CONN-AUD-004**: When a consumer reads `audio.in` frames, it shall treat `spk` as the speaker's stable id within the source and `name` as a display label, and a source that cannot tell speakers apart shall use one constant `spk` and `name`.
- [ ] **CONN-AUD-005**: When mouth writes an utterance to a sink stream, it shall convert the line's audio to the sink's declared format with the shared `resample` (SHARED-AUDIO-005, SHARED-AUDIO-006), tag every frame with the utterance id as `utt`, and mark the last frame `last` `1`.

## Back-pressure and loss

- [x] **CONN-BP-001**: A producer shall write a frame without waiting for any consumer, and shall not block, buffer beyond the stream's cap or fail because a consumer is slow, absent or gone. <!-- test: packages/bus/test/connector.test.ts -->
- [x] **CONN-BP-002**: When a consumer connects to an audio stream, it shall start reading at the end of the stream (`$`) with a plain blocking `XREAD` (no consumer group, no acknowledgement), shall not replay frames written before it connected, and shall leave other consumers' reads unaffected. <!-- test: packages/bus/test/connector.test.ts -->
- [ ] **CONN-BP-003**: When a consumer reads a frame whose `seq` is greater than the previous `seq` plus one within the same `epoch`, it shall add the difference to a loss counter and report the counter in its heartbeat detail; a changed `epoch` shall reset the baseline without counting loss.
- [ ] **CONN-BP-004**: When mouth writes an utterance to a sink stream, it shall write the frames no faster than real time plus a lead of one second, not as a burst.
- [ ] **CONN-BP-005**: While a sink's registration is absent or not `ready`, mouth shall treat that output as not ready (MOUTH-ROUTE-003), and a connector that has no ready connection shall discard the `audio.out` frames it reads.
- [x] **CONN-BP-006**: When a consumer reads a malformed frame (a version other than `1`, no `pcm`, a size over 64 KiB, an odd byte count), it shall drop it, count it with the lost frames and keep running. <!-- test: packages/bus/test/connector.test.ts -->

## Discord connector

- [ ] **CONN-DISC-001**: The Discord connector shall log in with the token in `DISCORD_TOKEN` and no other Discord token variable, shall request the intents `Guilds`, `GuildVoiceStates` and `GuildMembers`, and shall log the error and exit with code 1 if the login fails.
- [ ] **CONN-DISC-002**: Where `DISCORD_TOKEN` is unset or empty, the Discord connector shall not exit, shall create no Discord client and register nothing, shall log an error at startup and then the shared idle reminder warning (first after 60 s, backing off to a one-hour cap, SHARED-IDLE-003, SHARED-IDLE-006), and shall report heartbeat state `degraded` with detail `DISCORD_TOKEN is not set`.
- [ ] **CONN-DISC-003**: When the Discord client is ready, the Discord connector shall join the voice channel `connections.discord.voice_channel_id` of guild `connections.discord.guild_id` through the shared Discord voice session (SHARED-DVS-*), not self-deafened and not self-muted, and shall hold the only voice connection of the bot; an empty guild or channel key or a channel that is not voice-based shall fail the join with an error naming the key, handled as a failed join.
- [ ] **CONN-DISC-004**: The Discord connector alone shall join, rejoin and leave the voice channel: while a join is failing or the connection is recovering, it shall stay registered with both capabilities `ready` false and heartbeat `degraded`, and when the connection is Ready again it shall set both capabilities `ready` true without any request from ears or mouth.
- [ ] **CONN-DISC-005**: The Discord connector shall register connector `discord` with an `audio-in` capability for source `discord` (16000 Hz, 1 channel) and an `audio-out` capability for sink `discord` (48000 Hz, 2 channels).
- [ ] **CONN-DISC-006**: When a user whose Discord account is not a bot account (judged by the user's `bot` flag, fetched from Discord before any subscription when the user is not cached) starts speaking in the channel and is not already being captured, the Discord connector shall subscribe to that user's Opus stream, decode it, convert it to 16 kHz mono with the shared `resample` (SHARED-AUDIO-005), and write 20 ms frames to `audio.in.discord` with `spk` the user id and `name` the guild display name (the user id when unknown).
- [ ] **CONN-DISC-007**: The Discord connector shall read no audio from any bot account, including its own, and shall not open a second subscription to a speaker already being captured; if an Opus decoder errors, it shall remove the speaker from the capture set and log the warning "decoder error".
- [ ] **CONN-DISC-008**: While the voice connection is Ready, the Discord connector shall read `audio.out.discord` live (CONN-BP-002), play the frames in `seq` order through one audio player subscribed to the connection, and play a gap as the frames present without stalling.
- [ ] **CONN-DISC-009**: When the process receives a shutdown signal, the Discord connector shall run one shutdown sequence that deletes its registration, destroys the voice connection and the Discord client, and then stops the bus before exiting.
- [ ] **CONN-DISC-010**: The Discord connector shall publish no domain event on `<prefix>:events` and shall subscribe to none.
- [ ] **CONN-DISC-011**: Where `connections.discord.enabled` is false, the Discord connector shall create no Discord client, register nothing and stay running idle with heartbeat mode `off` and state `ready`.

## Failure isolation

- [ ] **CONN-ISO-001**: While no live registration offers a tag, the consumer of that tag shall report its dependency for the tag `down`, keep running and keep every other source and output, and when a registration offering the tag with `ready` true appears it shall resume without a restart.
- [ ] **CONN-ISO-002**: While a connector's consumers are absent, slow or restarting, the connector shall keep its connection and its registration and its memory use shall stay bounded by the stream caps.
- [ ] **CONN-ISO-003**: If a connector's registration lapses or the connector restarts, ears' other sources, mouth's other outputs, injection and every other service shall continue unaffected.

## Health

- [ ] **CONN-HLTH-001**: The Discord connector shall publish heartbeats with `service` `discord`, mode `live` (`off` under CONN-DISC-011) and `deps` `discord`, `audio-in` and `audio-out`: `discord` `ok` only while the voice connection is Ready, and each audio dependency `ok` while its capability is registered `ready` (and, for `audio-in`, capture is running), `down` otherwise.
- [ ] **CONN-HLTH-002**: The Discord connector's heartbeat state shall be `starting` until its first join attempt resolves, `ready` when the voice connection is Ready, and `degraded` with a detail while a join fails or a tag conflicts (CONN-TAG-003); its detail shall include the count of frames it dropped.

## Desktop audio helper

- [ ] **CONN-DESK-001**: Where the desktop capture helper runs, it shall register connector `desktop` with an `audio-in` capability for source `desktop` (16000 Hz, 1 channel, `transport` `http`, `ready` true while it is capturing), rewrite that registration every `intervalMs` (CONN-REG-002), delete it on an orderly stop (CONN-REG-003) and publish no other liveness signal, and ears shall not accept `POST /ping`.
- [D] **CONN-DESK-002**: Where the desktop capture helper writes frames, it shall register `audio-in` for `desktop` with `transport` `stream` and write them to `audio.in.desktop` in place of posting clips to ears' HTTP listener, and ears shall consume it like any connector source and apply `ears.silence_ms` to cut its utterances (CONN-AUD-002, EARS-CON-001).
- [ ] **CONN-DESK-003**: Where a live registration offers `audio-in` for a tag with `transport` `http`, a consumer shall read no stream for that tag and shall treat the registration as the tag's liveness only; ears accepts that tag's clips on `POST /audio?source=<tag>` (EARS-SRC-010).
