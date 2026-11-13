---
parent: high-level-design
prefix: EARS
---

# ears

> Brownfield LLD, mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at `1b57790` with the owner's decisions of 2026-11-01 applied. ears is the listening half: the Discord playback sink and the spoken fallback line belong to [mouth](../mouth/mouth-design.md), and Discord itself belongs to the Discord connector in [connections](../connections/connections-design.md): ears holds no Discord client and consumes the audio the connector publishes. Line citations date from the audit and may have drifted. HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

ears is the co-host's hearing. It is one Node process (`services/ears`) with two jobs:

1. **Listen.** It consumes audio from the enabled sources, cuts each speaker's audio into utterances on silence, sends each to an OpenAI-compatible STT server (speaches / faster-whisper), and publishes `speech.heard` carrying the speaker's name. Discord voice is one such source: the Discord connector publishes each human speaker's audio on `audio.in.discord` and ears reads it ([Connector sources](#connector-sources)).
2. **Transcribe injected audio.** It accepts `inject.request` for uploaded audio, transcribes it through the same STT path, and publishes an injected `speech.heard` (`services/ears/src/inject.ts`; commit 3fae9f7, add-test-injection design D8). This job is independent of the Discord session.

ears does not speak and does not talk to Discord. The co-host's voice reaches Discord through [mouth](../mouth/mouth-design.md) and the Discord connector, and Discord's audio reaches ears through the same connector, which holds the one bot and the one voice connection ([connector-protocol](../connections/decisions/connector-protocol.md)). Discord is the default listening source. `ears.sources` lists the sources that are enabled, any number at once: connector sources (`discord`, or any tag a connector registers), the host's desktop audio (`desktop`, which arrives through the HTTP capture path until the helper becomes a connector), and the account-free capture sources `http` and `dir` ([Capture sources](#capture-sources), [Multiple sources](#multiple-sources)); an empty list is `off`.

Design leanings (evidence per bullet):

- **Pure logic is split from the glue.** `Hearing`, `createInjectHandler`, `EarsHealth`, the utterance assembler, the session helpers and the audio helpers take their effects as injected functions (`transcribe`, `fetch`, `now`), and the service body (`service.ts`) takes its environment and the connector client as injected options, so all of it is unit-tested with fakes under `runService` (`services/ears/test/*.test.ts`). `index.ts` is the one line that hands the body to `runService`.
- **Never exit for a configuration gap.** `ears.sources` empty, or only gap sources, leaves the process up and idle with an honest heartbeat rather than crash-looping (`services/ears/src/health.ts`, `services/ears/src/service.ts`). A connector that is not present is a dependency `down`, not an exit. Evidence: `earsPlan` doc comment; commit 51d5a9c; add-isolated-backends design D7.
- **No Discord library in ears.** Discord, Opus decoding and the voice connection live in the Discord connector, so ears carries no gateway client, no native voice dependency and no Discord token.

Ownership notes: `src/health.ts` implements the heartbeat contract owned by [control-plane](../control-plane/control-plane-design.md); `src/inject.ts` is ears' half of test injection (the panel, the Redis upload write and bus-level injection belong to [dashboard](../dashboard/dashboard-design.md); the `inject.*` schemas belong to [event-bus](../event-bus/event-bus-design.md)); the "off" mode belongs here; the connector registry, the `audio.in` stream and the frame format belong to [connections](../connections/connections-design.md).

## Startup Plans

At boot `index.ts` hands the service body (`service.ts`) to the shared `runService`, which loads config, creates a `Bus("ears")` and starts the heartbeat (EARS-START-008); the body derives a **plan** per enabled source with the pure function `earsPlan(sources, hasDirPath)`, which returns the set of sources to start ([Multiple sources](#multiple-sources)); the table below is the plan of each source taken alone, which is the whole plan when one source is enabled:

| single enabled source | plan | Discord client | Heartbeat |
| --- | --- | --- | --- |
| `off` | `off` | none | mode `off`, deps `discord: n/a, stt: n/a`, state `ready` immediately (EARS-START-001) |
| `discord` (or another connector tag) | `discord` | none | mode `live`; `ready` once subscribed; `deps.discord` `ok` while the connector is present and `ready` (EARS-CON-005) |
| `http` | `http` | none | mode `live`; `ready` once the port is listening (EARS-CAP-007) |
| `dir` | `dir` | none | mode `live`; `ready` once the directory is being polled (EARS-CAP-008) |
| `dir`, `ears.dir.path` empty | `no-dir` | none | mode `live`, state `degraded` with detail `ears.dir.path is not set` (EARS-CAP-010) |

`ears.sources` is a list of source names: `http`, `dir`, or a connector source tag, an open set that connectors register (default `[discord]`; empty is `off`; `desktop` is such a tag); `EARS_SOURCES` overrides the list through `config.example.yaml` in flow syntax such as `[http, dir]` or `[]` (`packages/config/src/schema.ts`, CFG-SCH-030). Only `dir` can be a configuration gap; a connector source with no connector is `down`, and the plan never depends on a token. The sources are read at start; changing them takes effect on restart.

In every plan the process reads one event type, `inject.request`, on consumer group `ears` (EARS-START-003), and it creates no Discord client whatever the plan (EARS-CON-002). It never reads `voice.utterance` or `voice.playing` and never publishes a `voice.*` event. In the idle plans (`off`, `no-dir`):

- `ready` (or `degraded` for `no-token`) is signalled after the subscription is established;
- both run through the shared idle plan `startIdle`: `off` logs one warning and is `ready` in mode `off`; `no-dir` logs an error naming the missing key, reports `degraded`, and repeats the warning backing off from 60 s (doubling to one hour, SHARED-IDLE-003, SHARED-IDLE-006) (EARS-START-008);
- on shutdown the idle timer is cleared and the bus stopped, as one `runService` teardown (EARS-START-005).

The `ears` consumer group uses the bus start mode `latest`: the group is reset to the newest entry on every start, so injection requests published while ears was down are not handled (EARS-START-006). `subscribeEars` creates the group first (`Bus.resetGroup`, so it exists before any `ready` signal) and then starts the read loop with `start: "latest"`.

Shutdown is one sequence registered once with `runService`'s `onStop`: stop each source independently, then `runService` stops the bus, even if a stop throws (EARS-SRC-004). The heartbeat's pre-shutdown hook sends `stopping` before any callback runs, and the bus runs every registered callback in order and exits once ([event-bus](../event-bus/event-bus-design.md)).

Environment and config read by ears:

| Source | Key | Use |
| --- | --- | --- |
| config | `ears.silence_ms` (700) | the gap that closes a speaker's utterance (EARS-HEAR-001) |
| env | `STT_URL` | via `urls.stt()`, default `http://127.0.0.1:8000` (`packages/config/src/index.ts:171`) |
| config | `ears.http.host` (`127.0.0.1`), `ears.http.port` (`8765`), `ears.dir.path` (empty), `ears.dir.poll_ms` (`1000`) | the capture sources below (CFG-SCH-030) |
| config | `ears.sources`, `ears.stt_engine` (`speaches` default, or `stub`), `ears.silence_ms` (700), `ears.min_speech_ms` (400), `ears.stt_model` (`Systran/faster-whisper-small`), `ears.drop_phrases` (default empty) | `packages/config/src/schema.ts` |

ears needs no Discord permission, intent or token: the Discord connector's bot needs Connect and Speak in the channel and the privileged Server Members intent ([connections](../connections/connections-design.md#discord-connector)).

## Listening Pipeline

Implemented in `connector-source.ts` (consume and assemble) and `hearing.ts` (STT + publish).

1. **Consume.** For a connector source, ears reads `audio.in.<tag>` with a plain blocking `XREAD` from the end of the stream, never replaying older frames, and keeps one reader per enabled connector source ([Connector sources](#connector-sources)).
2. **Assemble per speaker.** Frames carry `spk` and `name`. ears appends each frame to the open buffer of its `spk` and closes that buffer when no frame from that `spk` has arrived for `ears.silence_ms` (EARS-HEAR-001): a shorter window sends speech to STT sooner but splits sentences at pauses. The closed buffer is 16 kHz mono PCM already, so it goes to `Hearing.heardClip` with the source tag, drops anything shorter than `ears.min_speech_ms`, and is wrapped as a 16 kHz mono WAV with the shared `wavWrap`. The speaker's name is the frames' `name`.
3. **STT request.** `sttTranscriber` POSTs multipart form data to `<STT_URL>/v1/audio/transcriptions` with fields `file`, `model` (= `ears.stt_model`), `language` = `"en"` (hard-coded), `response_format` = `json`; a non-2xx throws `stt <status>: <body>`; the result is `json.text.trim()` (`hearing.ts:19-32`). The same function accepts an optional content-type hint so injected uploads keep their container (`hearing.ts:20-23`, extension table at `hearing.ts:13-15`).
4. **Publish.** Text with no word character (a Unicode letter or number in any script, EARS-HEAR-007) is dropped silently, as is a transcript equal to an `ears.drop_phrases` entry (EARS-HEAR-010; compared case-insensitively with whitespace collapsed and leading and trailing punctuation ignored, so `Thank you.` matches `thank you`; the list is empty by default and `config.example.yaml` shows Whisper's common silence phrases); otherwise `speech.heard { speaker, speakerId, text, durationMs }` is published, where `speakerId` is the speaker id the source gave, for Discord the user id, unmodified (EARS-HEAR-011) and the identity [memory](../memory/memory-design.md#voice-speakers) keeps notes under; ears holds no identity mapping (`hearing.ts:44-46`). Any exception becomes a `"transcription failed"` warning (`hearing.ts:47-49`). `speech.heard` is defined at `packages/bus/src/events.ts:40-48`.

The transcriber handed to `Hearing` (and to the inject handler) is wrapped by `EarsHealth.track`, so each STT call sets `deps.stt` ok/down .

There is no cap on utterance length (a speaker who never pauses for `silence_ms` is buffered in memory until they do) and no VAD of ears' own. Echo suppression of the co-host's voice leaking through a human participant's microphone does not exist; the co-host's own audio and every other bot's never reaches ears, because the Discord connector reads no bot account (CONN-DISC-007).

## Connector sources

A connector source is a source name that is not `http` or `dir`: the Discord connector serves `discord` today, and any connector may register another tag ([connections](../connections/connections-design.md)). ears does not know what stands behind a tag.

- **Availability.** ears reads the connector registry (CONN-REG-006). The source's dependency is `ok` while a live registration offers `audio-in` for the tag with `ready` true and ears is reading the stream, and `down` with the detail `<tag> connector not connected` otherwise (EARS-CON-005). A connector that restarts, or is started after ears, is picked up without restarting ears.
- **Format.** `audio.in` frames are 16 kHz mono, so ears performs no resampling for them (CONN-AUD-003); a frame of another format or a malformed frame is dropped and counted, and missing frames are counted from `seq` gaps; both counts go in the heartbeat detail (EARS-CON-003).
- **Loss.** ears reads live and never replays: audio from while ears was down is lost by design, and if ears is slower than the producer the stream's cap evicts the oldest frames (CONN-BP-001 to CONN-BP-003).
- **Isolation.** A connector source failing marks only its own dependency `down`; the other sources, injection and the heartbeat keep running (EARS-SRC-004, CONN-ISO-001). A speaker whose connector disappears mid-utterance is closed by the silence rule (EARS-CON-004).
- **No Discord in ears.** The bot login, the voice connection, the rejoin loop, Opus decoding, the bot-account filter and the resampling from 48 kHz stereo all belong to the Discord connector (CONN-DISC-*).

## Capture sources

A capture source is an adapter that hands finished audio clips to the one `Hearing` path (`hearing.ts`); it owns how audio arrives and nothing else. `capture.ts` defines the contract: `CaptureAdapter { name; start(): Promise<void>; stop(): Promise<void> }` and `decodeClip`, which turns uploaded bytes into 16-bit PCM with its rate and channel count. Discord is the adapter that cuts utterances per speaker from a voice channel; `desktop` is the `http` adapter's listener serving the desktop capture helper ([Desktop audio](#desktop-audio)); `http` and `dir` are the adapters that need no account, so ears can be run, tested and used in mock mode (`ears.stt_engine: stub`) with nothing but a terminal.

`Hearing.heardClip(clip, speaker, source)` is the shared path. It resamples the clip to 16 kHz mono with the shared `resample`, drops it when shorter than `ears.min_speech_ms`, transcribes it, drops a transcript with no word character or equal to an `ears.drop_phrases` entry, and otherwise publishes `speech.heard { speaker, text, durationMs, source }` (a live transcript: not `injected`, no `speakerId`; `source` is the adapter's name). It returns the outcome (`heard`, or the reason nothing was published: `too-short`, `empty`, `drop-phrase`, `stt-error`), which the adapters report back to the caller. `Hearing.heard` (Discord PCM) is the same path after its own 48 kHz stereo conversion.

**`http`.** ears listens on `ears.http.host:ears.http.port` (default `127.0.0.1:8765`; port 0 picks a free one for tests). `POST /audio` carries one clip: a WAV (`audio/wav`, `audio/x-wav`, `audio/wave`, parsed by the shared `parseWav`, 16-bit only) or raw little-endian 16-bit PCM (`audio/L16` or `audio/pcm`, with `rate` and `channels` content-type parameters defaulting to 16000 and 1). The optional `speaker` query parameter names the speaker (default `http`). The reply is JSON `{ heard, text?, reason? }` with status 200 once the clip has been through the path. The listener is bounded with the inject limits (the byte cap and timeout of EARS-INJ-010, the queue length `INJECT_QUEUE_LIMIT` of `@cohost/shared`): a body over `INJECT_MAX_BYTES` (25 MiB) is refused 413 as soon as it is known to exceed the cap, a body that takes longer than `INJECT_READ_TIMEOUT_MS` to arrive is cut off, clips are processed one at a time, and more than `INJECT_QUEUE_LIMIT` waiting clips are refused 503. Other statuses: 404 (path), 405 (method), 415 (content type), 400 (audio that does not decode), 502 (speech-to-text failed). A port that cannot be bound leaves the process up with `deps.http` down and a `degraded` heartbeat, the configuration-gap posture.

**`dir`.** ears polls `ears.dir.path` every `ears.dir.poll_ms` (default 1000; the directory is created when missing). A regular file whose name ends in `.wav` (any case) and whose size is the same on two consecutive polls (so a file still being copied in is left alone) is processed once: it goes through `heardClip` with speaker `dir`, then is renamed with a suffix recording the outcome (`.done`, `.rejected` for a file over the byte cap or not decodable, `.failed` when speech-to-text failed). If the rename fails the name is remembered in memory and the file is not read again. At most `INJECT_QUEUE_LIMIT` files are taken per poll, in name order, one at a time. Polling instead of `fs.watch` keeps behaviour identical across WSL, Docker bind mounts and network shares.

Both adapters transcribe through the same `EarsHealth.track`-wrapped transcriber as connector sources and injection, so `deps.stt` follows them too, and every source shares the same filters, so a stub-engine clip ("stub transcript (n ms)") flows through the same drop-phrase and word checks.

## Speaking

ears does not play audio. The Discord playback sink, the spoken fallback line and its clip cache are [mouth](../mouth/mouth-design.md)'s. ears never hears the co-host's own voice from Discord, because the Discord connector reads no bot account's audio (CONN-DISC-007).

ears does not subscribe to `control`: it publishes `speech.heard` whatever the mute or pause state, which cortex and salience enforce upstream (EARS-HEAR-009).

## Audio Injection

`createInjectHandler` (`inject.ts`) returns the `inject.request` handler. It is built in `service.ts` for **every** plan and is the only handler on the `ears` loop in every plan (EARS-START-003). The shared handler queues a request and returns at once, so the loop reads the next `inject.request` while STT is still working on the last one; requests are answered in order, and a ninth waiting request is answered `busy` (EARS-INJ-011, SHARED-INJ-*).

Processing order for a request `r` (publishing `inject.result { id, ok, detail? }` on every failure path):

1. `r.target !== "ears"` returns silently with nothing published (`inject.ts:57`).
2. Older than `INJECT_STALE_MS` = 60 000 ms by the event's `ts` returns `ok:false, "stale"` (`INJECT_STALE_MS` from `@cohost/shared`, SHARED-INJ-008). (Consumer groups resume after a restart, which is why.)
3. `r.kind !== "audio"` returns `ok:false, "ears cannot handle kind '<kind>'"` (`inject.ts:61`).
4. The request must carry an `uploadId` (32 hex digits); otherwise `ok:false, "request carries no upload id"` and nothing is read.
5. The shared handler reads the bytes with `Bus.takeUpload(uploadId)` (`GETDEL` of `cohost:upload:<id>`), bounded by 30 s and 26214400 bytes; a missing or expired key returns `ok:false, "upload expired or missing"` (SHARED-INJ-013), a timeout or oversize returns `ok:false` with a detail naming it (SHARED-INJ-006, SHARED-INJ-007).
6. The bytes go **unchanged** to STT with the request's `contentType` as a hint (default `audio/wav`); `ears.min_speech_ms` does not apply (`inject.ts:66-67`, `inject.ts:48-51`).
7. A transcript with no word character (Unicode letter or number) returns `ok:false, "empty transcript"` (`inject.ts:68`).
8. Success publishes `speech.heard { speaker: r.meta?.user || "injected", text, durationMs: wavDurationMs(audio), injected: true, remember: r.remember }` then `inject.result { ok:true, detail: text }` (`inject.ts:69-72`). `wavDurationMs` returns 0 for non-WAV or unreadable input (`inject.ts:36-45`). No `speakerId` is set.
9. Any exception logs `"audio injection failed"` and attempts `inject.result { ok:false, detail: String(err) }` (swallowing a bus failure) (`inject.ts:73-76`).

Injection works in every plan whether or not any source is available (it must work when `ears.sources` is empty or Discord is not connected). The `off` plan and every plan with sources subscribe at startup, before any source starts, and keep handling injection whatever the sources do (EARS-CAP-003, EARS-INJ-009).

## Multiple sources

ears runs every enabled source at the same time. `ears.sources` is a list of source names: `http`, `dir` or a connector source tag such as `discord` or `desktop`, where the tags are an open set registered by connectors and ears holds no list of them; the default is `[discord]`, which is the behaviour of a single-source install. An empty list means `off`. `EARS_SOURCES` overrides the list in flow syntax; the Compose file passes it through as an isolation preset.

**One adapter per source.** `earsPlan` returns the set of sources to start, each with its own state: `runnable`, or a configuration gap (the `dir` source with an empty `ears.dir.path`, EARS-CAP-010; a listener-fed source whose listener cannot bind is not a gap but a failure, EARS-SRC-004). The service starts each runnable source as a `CaptureAdapter` and stops each one independently. Starting is isolated: a source whose `start()` rejects, whose listener cannot bind, or whose connector is absent marks only its own dependency `down` and does not stop, restart or delay the others. A source that is a configuration gap does not exit the process; it logs an error and reports itself `down` with the reason, and the other sources run. When no source is runnable (the `off` plan, or every enabled source is a gap) the service takes the shared idle plan, with the reason text of the gap or gaps, exactly as a single-source install does today (EARS-START-008). Injection (`inject.request`) is handled whatever the sources.

**Per-source health.** The heartbeat carries one dependency per enabled source, named for it (a connector tag such as `discord` or `desktop`, `http`, `dir`), `ok` while that source is delivering (the connector present and ready, the listener bound, the directory polled) and `down` otherwise; a `down` dependency makes a `ready` service `degraded` through the shared heartbeat, naming it. A source that is not enabled shows `n/a`. `stt` stays shared, since every source transcribes through the one health-tracked transcriber.

**Source tag.** Each adapter passes its own name to the shared path, so `Hearing.heardClip` publishes `speech.heard` with an optional string `source` (a connector tag, `http` or `dir`). The field is optional and additive: consumers that ignore it are unaffected, an event from before the field existed has none, and an injected transcript (`injected: true`) carries none because it did not come from a listening source. The bus event schema owns the field ([event-bus](../event-bus/event-bus-design.md)). Every source passes the same filters: minimum duration, word character and drop phrases (EARS-CAP-001).

**Speaker labels.** A source that cannot tell speakers apart names the speaker by source: a source published as `desktop` uses speaker `desktop` unless the helper names one (the `http` and `dir` default labels are `http` and `dir`, as today). Discord keeps its per-speaker display names and `speakerId`. The source tag and the speaker are separate fields, so a downstream consumer can tell "the desktop audio" from "a person called desktop".

## Desktop audio

ears runs in Docker or WSL and cannot see the host's audio devices, so desktop audio (the game, a browser, OBS's own output: OBS is one program playing into it) does not enter ears through a device adapter. A small bundled **capture helper** runs on the host that owns the audio, and the helper is a connector serving the source tag `desktop` ([connections](../connections/connections-design.md#desktop-audio-helper)). It registers and keeps its registration fresh through the connector protocol (CONN-DESK-001), and until it writes frames its clips ride the existing `http` capture adapter: its capability declares `transport` `http`, so ears serves the `desktop` source through the `http` listener and reads no stream for it. ears gains no audio-device dependency. Moving the clips onto `audio.in.desktop` is deferred (CONN-DESK-002, EARS-SRC-016): the HTTP clip path described here is the interim path, and the registration and liveness do not change when it migrates.

**Helper platforms.** One cross-platform helper, with a backend per host: on Windows it records the default render device through WASAPI loopback, and on Linux it records the PulseAudio or PipeWire monitor source of the default sink (selectable by device or source name). On an unsupported host, or when the device cannot be opened, the helper exits non-zero with a message and posts nothing.

**Cutting clips.** The helper, not ears, turns the continuous feed into clips, because it holds the raw stream: it converts to 16 kHz mono 16-bit PCM, closes a clip after a configurable run of silence (`--silence-ms`) and at a configurable maximum clip length (`--max-clip-ms`), drops a clip with no audible sample above a level threshold (`--silence-level`), and POSTs each as `audio/L16` (`rate=16000`, `channels=1`) with the source tag `desktop`. The maximum clip length keeps every body under `INJECT_MAX_BYTES`, so a feed that never pauses still produces clips. ears applies its own minimum-duration and drop-phrase filters (EARS-SRC-007) on top, so the helper's cut is a transport concern and the `http` adapter stays the single place clips enter `Hearing`.

**Addressing and authentication.** The helper posts to the `ears.http` listener (default `http://127.0.0.1:8765`, overridable with `--url`). The Compose file publishes that port on the host's loopback only (the HLD's deployment posture), which a Windows host reaches through WSL2's localhost forwarding, so no port opens to the LAN. The operator's loopback is the trust boundary, as for the rest of `http`. Where the owner binds the listener beyond loopback, or wants a shared secret regardless, `ears.http.token` (set through `EARS_HTTP_TOKEN`) makes `POST /audio` require `Authorization: Bearer <token>` and answer 401 otherwise; the helper reads the same value from `--token` or `EARS_HTTP_TOKEN`. With no token set the listener behaves as before.

**Source tag.** The helper names the source with the optional `source` query parameter on `POST /audio` (`/audio?source=desktop`). The accepted values are `http` (the default when the parameter is absent) and the tag of an enabled source whose live registration declares `transport` `http`, which today is `desktop`. A value that names a source that is not enabled, is served by a stream, has no live registration, or is any other value, is refused 400, so a mistyped tag cannot invent a source. The adapter passes the tag to `Hearing.heardClip` as its `source` argument, which is how `speech.heard.source` reaches the bus, and the default speaker label is the tag (an explicit `speaker` parameter still wins).

**Liveness.** A desktop feed can be silent for minutes, so the absence of clips does not mean the helper is gone. The helper therefore holds a connector registration (`audio-in` for `desktop`, `transport` `http`) that it rewrites every `intervalMs` and deletes on an orderly stop, and `deps.desktop` is `ok` while the listener is bound and that registration is live and `ready` (EARS-SRC-012, CONN-REG-006). With the helper absent, stopped or unable to reach Redis the `desktop` dependency is `down` (the service is `degraded`, naming it) while every other source keeps running; the helper retries with increasing delay when ears or Redis is unreachable, and the dependency returns to `ok` when the registration reappears, without a restart of ears. ears has no `POST /ping` route.

**Testing.** The helper's clip cutting runs against a fake feed (a synthetic PCM stream), and the `desktop` source is tested by a test client that writes a registration and posts tagged clips to the listener, so neither needs a sound device, OBS or an account.

## Health

`EarsHealth` (`health.ts:19-34`) is the `HeartbeatSpec` for `service: "ears"`:

- `mode`: `"off"` for the `off` plan, `"mock"` with the stub engine, else `"live"`.
- `deps`: `off` gives `{ discord: "n/a", stt: "n/a" }`; otherwise `stt` is the outcome of the last transcription (initially `"ok"`) and each enabled source has its own dependency (`discord` or another connector tag, `desktop`, `http`, `dir`), `ok` while that source is delivering and `down` otherwise, and a source that is not enabled is `n/a` (EARS-SRC-005, EARS-HLTH-002, EARS-CON-005); taken alone, the `http` and `dir` plans add `http` and `dir` (EARS-CAP-011). The heartbeat detail carries the dropped and missing frame counts of the connector sources (EARS-CON-003).
- `startHeartbeat` (owned by [control-plane](../control-plane/control-plane-design.md)) turns any `down` dep on a `ready` service into state `degraded` (`packages/shared/src/lifecycle.ts:142`).
- A connector source's `ok` comes from the registry read and the stream reader, not from a Discord connection; ears has none.
- A connector coming back after an outage returns its dependency to `ok` without a restart of ears (CONN-ISO-001).


## Stub transcriber and shared modules

Where `ears.stt_engine` is `stub` (CFG-SCH-022; the isolation preset sets it), the transcriber makes no network request and returns `stub transcript (<n> ms)` for every captured or injected clip; the heartbeat reports mode `mock` (or `off` with source `off`) and `deps.stt` `n/a` (EARS-STUB-*). Injection runs through the shared inject handler with kind `audio`, 25 MiB and 30 s (EARS-INJ-010).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Listening and speaking | ears only listens; speaking (the Discord playback sink and the spoken fallback line) is the separate service [mouth](../mouth/mouth-design.md) | One process with both jobs (the original ears); one process holding a shared Discord session for two modules; speaking folded into voice | Owner direction: listening and speaking are separate modules, so audio sources and outputs can be tuned and routed separately and either half restarts without the other. Full comparison: [listen-speak-split](decisions/listen-speak-split.md) (the Discord-identity part superseded by [connector-protocol](../connections/decisions/connector-protocol.md)).
| Service name | Keep `ears` for the listening half | `hearing`; `listen`; `stt` | Once speaking leaves, `ears` names exactly what the service does, and keeping it leaves the `EARS` spec prefix, the heartbeat name, the consumer group, the Compose profile, the manifest id and the `inject.request` target `ears` unchanged. |
| Speaker identity | `speakerId` is the Discord user id, published unmodified; ears keeps no identity mapping (EARS-HEAR-011) | Map Discord ids to chat viewers in ears; publish only the display name | The id is stable and unique, and the display name is neither; the viewer-identity mapping belongs to memory, which owns viewers and notes, so voice speakers accrue notes there ([Voice speakers](../memory/memory-design.md#voice-speakers)). |
| Discord | ears holds no Discord client; Discord is a connector source (`audio.in.discord`) served by the Discord connector, which holds the one bot, the one voice connection and the one token ([connections](../connections/connections-design.md)) | Two bots, one per service (the earlier choice); ears and mouth merged into one process; a Discord-only service | Owner direction: one bot login. The connector gives one login, independent restarts of ears and mouth, and the same path for the desktop helper. Full comparison: [connector-protocol](../connections/decisions/connector-protocol.md). The bot-account filter, Opus decoding and the voice-state settings moved with the connection (CONN-DISC-*). |
| Source off / dir path unset / connector absent | Stay up idle (or run the other sources), report `degraded` (or `off`), never exit | Exit non-zero | `earsPlan` doc comment: "never exits for a configuration gap"; commit 51d5a9c; add-isolated-backends design D7. A connector that is absent is a dependency `down`, not a gap, since it may start later. |
| Utterance boundary | ears closes a speaker's utterance when no frame from that speaker has arrived for `ears.silence_ms` (EARS-HEAR-001) | Discord `AfterSilence` end behavior in the capture; end markers from the connector; own VAD | The connector sends frames only while a speaker transmits, so a gap in frames is where the speaker stopped, with no second VAD to tune and no marker that a lost frame could hang open. `ears.silence_ms` stays ears' latency lever: a shorter window sends speech to STT sooner but splits sentences at pauses. A source with no notion of an utterance (desktop audio) fits the same rule. ears has never run against real Discord, so this boundary is current intent pending first contact. |
| Per-speaker streams | One Opus subscription and one STT call per speaker per utterance | Mixed channel audio | Header comment: "so the brain knows who said what" (`index.ts:4-6`). |
| Resampling | None for connector sources: `audio.in` is 16 kHz mono (CONN-AUD-003) | Resample in ears from the source's rate | The producer owns the foreign format: the Discord connector decodes Opus and converts 48 kHz stereo to 16 kHz mono with the shared `resample`, so ears needs no conversion code for connector sources. |
| STT language | Hard-coded `en` | `ears` config key | The co-host speaks and is prompted in English, and naming the language skips Whisper's language detection, which is unreliable on the short clips a voice channel produces (EARS-HEAR-005, `hearing.ts:25`). There is no config key for the STT language. |
| Shutdown | One shutdown sequence: stop each source independently, then stop the bus (EARS-SRC-004) | Separate `onShutdown` registrations (the original code) | Owner decision 2026-11-01 (project-wide): the bus runs every registered callback and exits once. |
| Mute and pause | ears does not subscribe to `control` and publishes `speech.heard` whatever the mute or pause state (EARS-HEAR-009) | Stop listening while muted | Owner decision 2026-11-01 (project-wide): only cortex and salience see mute and pause; a muted co-host still hears what is said, so her next reply has the context. |
| Start mode | `latest`: the `ears` group is reset to the newest entry on every start (EARS-START-006) | `resume` (handle a backlog of stale injection requests) | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; delivery across restarts is at-most-once. |
| Injection upload transport | The upload is read from Redis by id (`Bus.takeUpload`); the event carries no URL | Fetch a URL from the dashboard's listener and document the firewall rule; base64 in the event | No URL means no fetch to guard and nothing on the host that a container must reach (dashboard decision on upload transport). The key is deleted on read and expires on its own if ears is down. |
| Stale injected requests | Drop after 60 s | Process all backlog | Consumer groups resume after a restart: `INJECT_STALE_MS` in `@cohost/shared` (shared with eyes and chat, SHARED-INJ-008); add-test-injection design D8 ("Staleness"). |
| Injected clips skip `min_speech_ms` | No minimum duration | Apply the gate | add-test-injection design D8: "`min_speech_ms` does not apply (that gates Discord PCM)"; doc comment `inject.ts:50`; test `inject.test.ts:36-43`. |
| More listening sources | Capture adapters feeding the one `Hearing` path, selected by `ears.sources` (`discord`, `http`, `dir`, a connector tag; empty is off); `http` takes POSTed 16-bit PCM or WAV on a local port and `dir` takes WAV files dropped in a polled directory, both bounded by the shared inject limits and both working with the stub transcriber and no account (EARS-CAP-*) | Defer all new sources; a per-source map `ears.sources.<name>` with `enabled`, so several run at once; `fs.watch` for `dir`; a local microphone or OBS audio source first | The HLD's deferred goals do not forbid a listening source, and an account-free source is the missing way to run and test ears without Discord. One active source at a time was enough while Discord voice and a scripted feed were alternatives, not companions (see row "Several sources at once"). Polling is the portable choice across WSL, bind mounts and network shares. A microphone source needs a native capture dependency and its own account-free test story, so it is a later adapter behind the same contract; the OBS source and running several sources together are the next step (row "Several sources at once"). |
| Several sources at once | `ears.sources` is a list of enabled sources; each is a `CaptureAdapter` started and stopped independently, a failing or misconfigured one marks only its own dependency `down`, each clip carries a `source` tag (EARS-SRC-*) | Keep the single `ears.source` enum (the earlier choice: one active source, Discord and a scripted feed as alternatives); a per-source map `ears.sources.<name>.enabled`; a separate ears process per source; a mixer that merges all feeds into one stream before STT; one failing source stops the service | The owner streams with Discord voice and OBS or desktop audio together (game and stream audio beside the talkers), so sources are companions and one enum cannot express it. A list keeps the simple case simple, where a per-source map would add a nested block per source before any needs per-source options beyond the ones each adapter already has (`ears.http.*`, `ears.dir.*`). Separate processes would each need their own consumer group, health and bus connection for no isolation the in-process adapters do not already give. Merging feeds would lose who said what, which the per-speaker Discord capture exists to keep. Isolated failure is the HLD's failure posture: one dead source must not silence the others. The earlier enum row ("More listening sources") stands for the adapters it introduced. |
| Source tag on `speech.heard` | An optional string `source` naming the adapter, absent on injected transcripts and on events from before the field | A required field; encode the source in `speaker`; a separate event per source | An optional additive field keeps every consumer and stored event valid. Overloading `speaker` would corrupt the names that memory keys viewer notes on. Injected transcripts did not come from a source. |
| Desktop and OBS audio path | The existing `http` capture adapter is the ingestion path, fed by a bundled cross-platform capture helper on the host that owns the audio (WASAPI loopback on Windows, the PulseAudio or PipeWire monitor source on Linux); the helper registers as connector `desktop`, cuts clips and tags them `desktop` (EARS-SRC-009 to EARS-SRC-016) | A closed set of source names in ears with a helper `POST /ping` route of its own; a direct WSL PulseAudio device adapter inside ears; an OBS WebSocket adapter; a native capture dependency in ears | ears runs in Docker or WSL and cannot see host audio devices; reaching them from WSL means PulseAudio bridging (WSLg) that is fragile, Windows-only in practice and breaks in a container, and it would put a native audio dependency in ears for a source the owner's setup does not need in-process. OBS's WebSocket protocol exposes sources, mute state and volume meters but does not stream raw audio, so it cannot carry the feed. OBS is one program among those playing into desktop audio, so capturing the desktop mix covers it without OBS-specific code. The `http` path already has bounds, health and a stub-engine test story, so the helper is the only new component. Sources are an open set registered through the connector protocol so that adding one needs no ears change, and the helper's liveness is its registration rather than a route only it uses; its clips stay on the `http` path until they move to a stream. |
| Where the helper cuts clips | In the helper, which holds the raw stream: silence cut and maximum clip length are helper flags | In an ears-side adapter that accepts a continuous stream; a long-lived streaming connection from the helper | The `http` adapter takes whole clips with bounded bodies (EARS-CAP-006); a continuous-stream endpoint would need a new framing, backpressure and reconnect protocol for no gain, and the helper already needs a level meter to avoid posting silence. |
| Tuning the co-host's voice | Owned by the [voice](../voice/voice-design.md) segment | A listening-side knob | The voice knobs (speed and whatever the TTS engine exposes) act on synthesis, not on hearing. |
| Inject loop and STT | The `ears` loop hands each `inject.request` to the shared inject handler's queue and returns (EARS-INJ-011) | Await the handler in the loop (the original code) | A slow STT call or upload fetch should not delay reading the next request. |
| Word characters | A word character is a Unicode letter or number in any script (EARS-HEAR-007) | ASCII `\w` (the original code) | STT is forced to `en` today, but a transcript of non-ASCII letters or digits is still speech, and a language setting would otherwise silently drop it. |
| `readWavHeader` bit depth | `readWavHeader` is a thin adapter over the shared `parseWav`, which rejects input that is not 16-bit PCM; an unreadable header reads as `bad wav` and as duration 0 | Parse the header locally | One parser for every service; 8- and 24-bit input is refused instead of misread. |
| Whisper silence hallucinations | An `ears.drop_phrases` list (default empty, whole-transcript match) applied to live captures only (EARS-HEAR-010) | A built-in phrase list; fuzzy or substring matching; filtering injected clips too | Which phrases are hallucinations depends on the model and the room, so the owner lists them and the example config shows Whisper's usual ones. Whole-transcript matching never drops a sentence that merely contains "thank you". An injected clip is chosen by the owner, so it is transcribed as given. |

## Open Questions & Future Decisions

- **Event schema owner.** The optional `source` field on `speech.heard` is specified here (EARS-SRC-006) and is added to the event schema's own spec, BUS-EVT-013, which belongs to the event-bus segment.

## Manual verification

1. **Connector source.** Checked with the Discord connector against a real guild ([connections](../connections/connections-design.md#manual-verification)): a human speaks and `speech.heard` appears with `source: discord`; the connector is killed and restarted and ears' `deps.discord` goes `down` and back to `ok` without restarting ears.

## References

Files in this segment:

- `services/ears/src/index.ts`, `service.ts`, `connector-source.ts` (consume and assemble `audio.in`), `session.ts`, `hearing.ts`, `transcript.ts`, `audio.ts`, `inject.ts`, `health.ts` (`playback.ts`, `fallback.ts` and the playback half of `audio.ts` move to `services/mouth`)
- `services/ears/test/audio.test.ts`, `ears.test.ts`, `filter.test.ts`, `transcript.test.ts`, `stub.test.ts`, `loop.test.ts`, `service.test.ts`, `connector-source.test.ts`, `health.test.ts`, `inject.test.ts`, `inject-limits.test.ts`, `session.test.ts` (`fallback.test.ts` and the playback cases of `ears.test.ts` move to `services/mouth/test`)
- `services/ears/package.json`, `services/ears/tsconfig.json`

Other segments (arrow shows direction):

- ears -> [event-bus](../event-bus/event-bus-design.md): publishes `speech.heard`, `inject.result`, heartbeats; consumes `inject.request` (group `ears`).
- ears -> `@cohost/shared` (workspace package): `createInjectHandler`, `INJECT_STALE_MS`, owned by the [eyes LLD](../eyes/eyes-design.md) (Image Injection).
- ears -> [config](../config/config-design.md): `loadConfig`, `urls.stt()`, `env()`.
- ears <- [dashboard](../dashboard/dashboard-design.md): sends `inject.request` and stores the upload in Redis.
- ears -> [salience](../salience/salience-design.md) / [cortex](../cortex/cortex-design.md) / [memory](../memory/memory-design.md): consumers of `speech.heard` (not touched by ears).
- ears -> [control-plane](../control-plane/control-plane-design.md): heartbeat contract (`startHeartbeat`, `tracked`).
- ears -> [deployment](../deployment/deployment-design.md): compose profile `ears`, depends on `stt` (`docker-compose.yml`).
- ears <- [connections](../connections/connections-design.md): consumes `audio.in.<source>` and reads connector registrations; the Discord connector serves `discord`. Decision doc: [connector-protocol](../connections/decisions/connector-protocol.md).
- ears <-> [mouth](../mouth/mouth-design.md): no runtime link; both reach Discord through the connector. Earlier decision doc: [listen-speak-split](decisions/listen-speak-split.md).

External: Redis Streams (the connector's `audio.in` stream), speaches / faster-whisper STT (OpenAI-compatible `/v1/audio/transcriptions`).

OpenSpec: `openspec/specs/ears/spec.md`; designs cited above: `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md` ("add-isolated-backends design"), `openspec/changes/archive/2026-11-01-add-test-injection/design.md` ("add-test-injection design"); deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md`, `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md`, `openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md`.

EARS specs: [ears-specs.md](./ears-specs.md).
