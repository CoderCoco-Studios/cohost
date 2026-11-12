---
parent: high-level-design
prefix: EARS
---

# ears

> Brownfield LLD, mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at `1b57790` with the owner's decisions of 2026-11-01 applied. The listening and speaking split (designed 2026-11-10, built 2026-11-11) narrows ears to listening: the Discord playback sink and the spoken fallback line belong to [mouth](../mouth/mouth-design.md), and ears listens through a Discord bot of its own. Line citations date from the audit and may have drifted. HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

ears is the co-host's hearing. It is one Node process (`services/ears`) with two jobs:

1. **Listen.** A Discord *bot* sits in a voice channel, captures each human speaker as a separate stream, cuts utterances on silence, sends each to an OpenAI-compatible STT server (speaches / faster-whisper), and publishes `speech.heard` carrying the speaker's name (`services/ears/src/index.ts:3-6`).
2. **Transcribe injected audio.** It accepts `inject.request` for uploaded audio, transcribes it through the same STT path, and publishes an injected `speech.heard` (`services/ears/src/inject.ts`; commit 3fae9f7, add-test-injection design D8). This job is independent of the Discord session.

ears does not speak. The co-host's voice reaches Discord through [mouth](../mouth/mouth-design.md), a separate service with a Discord bot of its own; the two bots can sit in the same channel. Why the halves are separate processes with separate bots is argued in [listen-speak-split](decisions/listen-speak-split.md). Discord is the default listening source; `ears.source` selects it, or one of the account-free capture sources `http` and `dir` ([Capture sources](#capture-sources)), or `off`.

Design leanings (evidence per bullet):

- **Pure logic is split from the Discord glue.** `Hearing`, `createInjectHandler`, `EarsHealth`, the session helpers and the audio helpers take their effects as injected functions (`transcribe`, `fetch`, `now`), and the service body (`service.ts`) and the Discord session (`discord.ts`) take their environment, Discord loader and voice session as injected options, so all of it is unit-tested with fakes under `runService` (`services/ears/test/*.test.ts`). `index.ts` is the one line that hands the body to `runService`.
- **Never exit for a configuration gap.** A missing `EARS_DISCORD_TOKEN` or `ears.source: off` leaves the process up and idle with an honest heartbeat rather than crash-looping (`services/ears/src/health.ts:8-12`, `services/ears/src/service.ts:33`, `:95-98`). Evidence: `earsPlan` doc comment (`health.ts:8`); commit 51d5a9c; add-isolated-backends design D7.
- **Discord libraries are only loaded when needed**, via a dynamic `import("./discord.js")` (`services/ears/src/service.ts:28`), so idle plans carry no gateway client. Evidence: `loadDiscord` at `service.ts:28`.
- The bot must be a *bot* account, not a user account: header comment `services/ears/src/index.ts:11-13` ("automating a user account gets it banned").

Ownership notes: `src/health.ts` implements the heartbeat contract owned by [control-plane](../control-plane/control-plane-design.md); `src/inject.ts` is ears' half of test injection (the panel, the Redis upload write and bus-level injection belong to [dashboard](../dashboard/dashboard-design.md); the `inject.*` schemas belong to [event-bus](../event-bus/event-bus-design.md)); the "off" mode belongs here; the join retry loop `createJoiner` is shared with mouth through `@cohost/shared`.

## Startup Plans

At boot `index.ts` hands the service body (`service.ts`) to the shared `runService`, which loads config, creates a `Bus("ears")` and starts the heartbeat (EARS-START-008); the body reads `EARS_DISCORD_TOKEN` (and `DISCORD_TOKEN`, only to compare), and derives a **plan** with the pure function `earsPlan(cfg.ears.source, hasToken)`, where `hasToken` is true when `EARS_DISCORD_TOKEN` is set and differs from `DISCORD_TOKEN` (EARS-START-004):

| `ears.source` | token | plan | Discord client | Heartbeat |
| --- | --- | --- | --- | --- |
| `off` | any | `off` | none | mode `off`, deps `discord: n/a, stt: n/a`, state `ready` immediately (EARS-START-001) |
| `discord` | `EARS_DISCORD_TOKEN` unset | `no-token` | none | mode `live`, `discord: down`, state `degraded` with detail `EARS_DISCORD_TOKEN is not set` (EARS-START-002) |
| `discord` | `EARS_DISCORD_TOKEN` equals `DISCORD_TOKEN` | `no-token` | none | as above, with a detail saying ears needs a bot of its own (EARS-START-007) |
| `discord` | set and distinct | `discord` | yes | mode `live`; `ready` only after the voice connection is Ready (EARS-SESS-004) |
| `http` | any | `http` | none | mode `live`; `ready` once the port is listening (EARS-CAP-007) |
| `dir` | any | `dir` | none | mode `live`; `ready` once the directory is being polled (EARS-CAP-008) |
| `dir`, `ears.dir.path` empty | any | `no-dir` | none | mode `live`, state `degraded` with detail `ears.dir.path is not set` (EARS-CAP-010) |

`ears.source` is `discord | off | http | dir` (default `discord`), settable through `EARS_SOURCE` via `config.example.yaml` (`packages/config/src/schema.ts`, CFG-SCH-030). The `http` and `dir` plans need no token and never load `discord.js` (EARS-CAP-003). The source is read at start; changing it takes effect on restart.

In every plan the process reads one event type, `inject.request`, on consumer group `ears` (EARS-START-003). It never reads `voice.utterance` or `voice.playing` and never publishes a `voice.*` event. In the idle plans (`off`, `no-token`, `no-dir`):

- `ready` (or `degraded` for `no-token`) is signalled after the subscription is established;
- both run through the shared idle plan `startIdle`: `off` logs one warning and is `ready` in mode `off`; `no-token` logs an error naming the missing or conflicting token, reports `degraded`, and repeats the warning backing off from 60 s (doubling to one hour, SHARED-IDLE-003, SHARED-IDLE-006) (EARS-START-008);
- on shutdown the idle timer is cleared and the bus stopped, as one `runService` teardown (EARS-START-005).

The `ears` consumer group uses the bus start mode `latest`: the group is reset to the newest entry on every start, so injection requests published while ears was down are not handled (EARS-START-006). `subscribeEars` creates the group first (`Bus.resetGroup`, so it exists before any `ready` signal) and then starts the read loop with `start: "latest"`.

In the `discord` plan shutdown is one sequence, registered once with `runService`'s `onStop`: destroy the voice connection and the Discord client (`DiscordSession.stop()`), then `runService` stops the bus, even if the teardown throws (EARS-SESS-008). A failed Discord login rejects start-up and `runService` ends the process with status 1 (EARS-SESS-001). The heartbeat's pre-shutdown hook sends `stopping` before any callback runs, and the bus runs every registered callback in order and exits once ([event-bus](../event-bus/event-bus-design.md)).

Environment and config read by ears:

| Source | Key | Use |
| --- | --- | --- |
| env | `EARS_DISCORD_TOKEN` | plan selection and login of ears' own listening bot (EARS-START-004, EARS-SESS-009) |
| env | `DISCORD_TOKEN` | read only to refuse the mouth bot's token (EARS-START-007) |
| config | `ears.discord.guild_id`, `ears.discord.voice_channel_id` | guild and voice channel to join (EARS-SESS-007), resolved by `voiceTarget` (`session.ts`), which throws `ears.discord.guild_id is not set` / `ears.discord.voice_channel_id is not set` for an empty key; `config.example.yaml` fills them from `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID`. The environment variables are not read by ears |
| env | `STT_URL` | via `urls.stt()`, default `http://127.0.0.1:8000` (`packages/config/src/index.ts:171`) |
| config | `ears.http.host` (`127.0.0.1`), `ears.http.port` (`8765`), `ears.dir.path` (empty), `ears.dir.poll_ms` (`1000`) | the capture sources below (CFG-SCH-030) |
| config | `ears.source`, `ears.stt_engine` (`speaches` default, or `stub`), `ears.silence_ms` (700), `ears.min_speech_ms` (400), `ears.stt_model` (`Systran/faster-whisper-small`), `ears.drop_phrases` (default empty) | `packages/config/src/schema.ts` |

The listening bot needs the Connect permission in the channel and the privileged Server Members intent (for display names); it needs no Speak permission.

## Listening Pipeline

Implemented in `discord.ts` (capture) and `hearing.ts` (STT + publish).

1. **Intents.** The client requests `Guilds`, `GuildVoiceStates` and `GuildMembers` (`discord.ts:28`). `GuildMembers` is privileged; it is used so `guild.members.fetch()` populates display names (`discord.ts:66`; failure of that fetch is swallowed).
2. **Join.** On the client's `ready` event, `join()` fetches the guild and channel, requires a voice-based channel (`"ears.discord.voice_channel_id is not a voice channel"`), calls `joinVoiceChannel` with `selfDeaf: false, selfMute: true` (ears never speaks; EARS-SESS-002), and waits up to 20 s for `VoiceConnectionStatus.Ready`; a connection that does not reach Ready is destroyed so the retry starts clean. On Ready it sets `voiceReady = true` and calls `heartbeat.ready()` (EARS-SESS-004). A failed join (initial or rejoin) is logged, reported as `degraded` with `deps.discord: down` (detail `voice join failed: <error>`), and retried by `createJoiner` (`@cohost/shared`, `packages/shared/src/join.ts`) with a delay that starts at 5 s and doubles to a 60 s cap, until it succeeds (SHARED-DVS-004); the bus subscription keeps running throughout. A rejoin after a disconnect waits its first 5 s (SHARED-DVS-003) and then follows the same schedule. Concurrent joins share one loop, and shutdown ends it.
3. **Per-speaker capture.** `connection.receiver.speaking.on("start")` fires `listenTo(userId, channel)` for every user that is not a bot account (EARS-HEAR-001). That excludes ears' own bot and the co-host's speaking bot in [mouth](../mouth/mouth-design.md), so her own lines are never transcribed as a human's speech, and it excludes other bots in the channel (a music bot, another TTS bot). ears decides this from the speaker's user record (the cached `bot` flag, else one fetch), before it opens the speaker's stream; a speaker whose account cannot be fetched is skipped. `listenTo` keeps a `listening` set so a user already being captured is not subscribed twice (`discord.ts:40`). It subscribes to the user's Opus stream with `EndBehaviorType.AfterSilence` and `duration: ears.silence_ms`, pipes it through `prism-media`'s Opus decoder (`48000 Hz, 2 channels, frameSize 960`), and collects PCM chunks (`discord.ts:46-51`). On decoder `end` the user leaves the set and `Hearing.heard(pcm, name, userId)` runs un-awaited (`discord.ts:52-55`); on decoder `error` the user leaves the set and a warning is logged (`discord.ts:56`). The speaker's name is the guild member's `displayName`, falling back to the user id (`discord.ts:43-44`).
4. **Gate, convert, transcribe.** `Hearing.heard` computes `durationMs = bytes / 4 / 48000 * 1000` and drops anything shorter than `ears.min_speech_ms` (`hearing.ts:39-41`). Otherwise it downsamples to 16 kHz mono WAV (`discordPcmToWav16k`, `audio.ts:5-18`: 3:1 decimation that averages 3 frames and both channels, clamped to int16) and calls the transcriber.
5. **STT request.** `sttTranscriber` POSTs multipart form data to `<STT_URL>/v1/audio/transcriptions` with fields `file`, `model` (= `ears.stt_model`), `language` = `"en"` (hard-coded), `response_format` = `json`; a non-2xx throws `stt <status>: <body>`; the result is `json.text.trim()` (`hearing.ts:19-32`). The same function accepts an optional content-type hint so injected uploads keep their container (`hearing.ts:20-23`, extension table at `hearing.ts:13-15`).
6. **Publish.** Text with no word character (a Unicode letter or number in any script, EARS-HEAR-007) is dropped silently, as is a transcript equal to an `ears.drop_phrases` entry (EARS-HEAR-010; compared case-insensitively with whitespace collapsed and leading and trailing punctuation ignored, so `Thank you.` matches `thank you`; the list is empty by default and `config.example.yaml` shows Whisper's common silence phrases); otherwise `speech.heard { speaker, speakerId, text, durationMs }` is published, where `speakerId` is the speaker's Discord user id unmodified (EARS-HEAR-011) and the identity [memory](../memory/memory-design.md#voice-speakers) keeps notes under; ears holds no identity mapping (`hearing.ts:44-46`). Any exception becomes a `"transcription failed"` warning (`hearing.ts:47-49`). `speech.heard` is defined at `packages/bus/src/events.ts:40-48`.

The transcriber handed to `Hearing` (and to the inject handler) is wrapped by `EarsHealth.track`, so each STT call sets `deps.stt` ok/down (`discord.ts:32`, `index.ts:31`, `health.ts:31-33`).

There is no cap on utterance length (a speaker who never pauses for `silence_ms` is buffered in memory until they do), no VAD beyond Discord's speaking events, and no echo suppression of the co-host's voice leaking through a human participant's microphone; bot accounts are ignored as a class (EARS-HEAR-001).

## Capture sources

A capture source is an adapter that hands finished audio clips to the one `Hearing` path (`hearing.ts`); it owns how audio arrives and nothing else. `capture.ts` defines the contract: `CaptureAdapter { name; start(): Promise<void>; stop(): Promise<void> }` and `decodeClip`, which turns uploaded bytes into 16-bit PCM with its rate and channel count. Discord is the adapter that cuts utterances per speaker from a voice channel; `http` and `dir` are the adapters that need no account, so ears can be run, tested and used in mock mode (`ears.stt_engine: stub`) with nothing but a terminal.

`Hearing.heardClip(clip, speaker)` is the shared path. It resamples the clip to 16 kHz mono with the shared `resample`, drops it when shorter than `ears.min_speech_ms`, transcribes it, drops a transcript with no word character or equal to an `ears.drop_phrases` entry, and otherwise publishes `speech.heard { speaker, text, durationMs }` (a live transcript: not `injected`, no `speakerId`). It returns the outcome (`heard`, or the reason nothing was published: `too-short`, `empty`, `drop-phrase`, `stt-error`), which the adapters report back to the caller. `Hearing.heard` (Discord PCM) is the same path after its own 48 kHz stereo conversion.

**`http`.** ears listens on `ears.http.host:ears.http.port` (default `127.0.0.1:8765`; port 0 picks a free one for tests). `POST /audio` carries one clip: a WAV (`audio/wav`, `audio/x-wav`, `audio/wave`, parsed by the shared `parseWav`, 16-bit only) or raw little-endian 16-bit PCM (`audio/L16` or `audio/pcm`, with `rate` and `channels` content-type parameters defaulting to 16000 and 1). The optional `speaker` query parameter names the speaker (default `http`). The reply is JSON `{ heard, text?, reason? }` with status 200 once the clip has been through the path. The listener is bounded with the inject limits (the byte cap and timeout of EARS-INJ-010, the queue length `INJECT_QUEUE_LIMIT` of `@cohost/shared`): a body over `INJECT_MAX_BYTES` (25 MiB) is refused 413 as soon as it is known to exceed the cap, a body that takes longer than `INJECT_READ_TIMEOUT_MS` to arrive is cut off, clips are processed one at a time, and more than `INJECT_QUEUE_LIMIT` waiting clips are refused 503. Other statuses: 404 (path), 405 (method), 415 (content type), 400 (audio that does not decode), 502 (speech-to-text failed). A port that cannot be bound leaves the process up with `deps.http` down and a `degraded` heartbeat, the configuration-gap posture.

**`dir`.** ears polls `ears.dir.path` every `ears.dir.poll_ms` (default 1000; the directory is created when missing). A regular file whose name ends in `.wav` (any case) and whose size is the same on two consecutive polls (so a file still being copied in is left alone) is processed once: it goes through `heardClip` with speaker `dir`, then is renamed with a suffix recording the outcome (`.done`, `.rejected` for a file over the byte cap or not decodable, `.failed` when speech-to-text failed). If the rename fails the name is remembered in memory and the file is not read again. At most `INJECT_QUEUE_LIMIT` files are taken per poll, in name order, one at a time. Polling instead of `fs.watch` keeps behaviour identical across WSL, Docker bind mounts and network shares.

Both adapters transcribe through the same `EarsHealth.track`-wrapped transcriber as Discord and injection, so `deps.stt` follows them too, and both share the Discord path's filters, so a stub-engine clip ("stub transcript (n ms)") flows through the same drop-phrase and word checks.

## Speaking

ears does not play audio. The Discord playback sink, the spoken fallback line and its clip cache are [mouth](../mouth/mouth-design.md)'s. ears meets the co-host's voice only as audio in the channel: when both bots share a channel, ears receives mouth's bot audio and drops it with every other bot's (EARS-HEAR-001).

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

Injection works in every plan whether or not Discord is connected (add-test-injection: "MUST work when `ears.source` is `off` or Discord is not connected"). The `off` and `no-token` plans subscribe at startup; the `discord` plan subscribes before the Discord login and keeps handling injection whether or not the join succeeds (EARS-INJ-007).

## Health

`EarsHealth` (`health.ts:19-34`) is the `HeartbeatSpec` for `service: "ears"`:

- `mode`: `"off"` for the `off` plan, `"mock"` with the stub engine, else `"live"`.
- `deps`: `off` gives `{ discord: "n/a", stt: "n/a" }`; otherwise `discord` is `"ok"` only when the plan is `discord` and `voiceReady()` is true (so `no-token` is always `down`; `n/a` for the `http` and `dir` plans), and `stt` is the outcome of the last transcription (initially `"ok"`). The `http` plan adds `http` and the `dir` plan adds `dir`, each `ok` while the listener is bound or the directory is being polled and `down` otherwise (EARS-CAP-011).
- `startHeartbeat` (owned by [control-plane](../control-plane/control-plane-design.md)) turns any `down` dep on a `ready` service into state `degraded` (`packages/shared/src/lifecycle.ts:142`).
- `voiceReady` is set true on join Ready and false when a disconnect does not recover (`discord.ts:77,94`). `heartbeat.ready()` is called again on each (re)join (`discord.ts:78`).
- In the `discord` plan a failed join reports `degraded` with `deps.discord: down` while the join is retried (SHARED-DVS-004); the state is `starting` until the first join attempt resolves. A failed login exits 1.

Discrepancy: the `add-service-health` delta says no token means `mode: "off"` and `discord: "n/a"`; the later `add-isolated-backends` delta, the code, and `health.test.ts:7-12` say `mode: "live"`, `discord: "down"`, `degraded`. The code follows the later delta.

## Stub transcriber and shared modules

Where `ears.stt_engine` is `stub` (CFG-SCH-022; the isolation preset sets it), the transcriber makes no network request and returns `stub transcript (<n> ms)` for every captured or injected clip; the heartbeat reports mode `mock` (or `off` with source `off`) and `deps.stt` `n/a` (EARS-STUB-*). The Discord connection runs through the shared Discord voice session (EARS-SESS-010), injection through the shared inject handler with kind `audio`, 25 MiB and 30 s (EARS-INJ-010), and conversion through the shared audio module (EARS-AUD-005).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Listening and speaking | ears only listens; speaking (the Discord playback sink and the spoken fallback line) is the separate service [mouth](../mouth/mouth-design.md) | One process with both jobs (the original ears); one process holding a shared Discord session for two modules; speaking folded into voice | Owner direction: listening and speaking are separate modules, so audio sources and outputs can be tuned and routed separately and either half restarts without the other. Full comparison: [listen-speak-split](decisions/listen-speak-split.md). |
| Service name | Keep `ears` for the listening half | `hearing`; `listen`; `stt` | Once speaking leaves, `ears` names exactly what the service does, and keeping it leaves the `EARS` spec prefix, the heartbeat name, the consumer group, the Compose profile, the manifest id and the `inject.request` target `ears` unchanged. |
| Bots in the channel | Ignore the audio of every bot account (EARS-HEAR-001) | Ignore only ears' own bot (the original code); ignore a configured list of user ids | With mouth speaking through its own bot, ears would otherwise transcribe the co-host's own lines as a human's speech. Ignoring bots as a class needs no configuration and also drops music and TTS bots, whose audio is not a person talking to the co-host. |
| Speaker identity | `speakerId` is the Discord user id, published unmodified; ears keeps no identity mapping (EARS-HEAR-011) | Map Discord ids to chat viewers in ears; publish only the display name | The id is stable and unique, and the display name is neither; the viewer-identity mapping belongs to memory, which owns viewers and notes, so voice speakers accrue notes there ([Voice speakers](../memory/memory-design.md#voice-speakers)). |
| Self-mute | ears joins self-muted (EARS-SESS-002) | Join unmuted, as when ears also played audio | ears never plays audio; self-muted, the channel shows the listening bot never speaks. |
| The same token twice | An `EARS_DISCORD_TOKEN` equal to `DISCORD_TOKEN` idles ears with a message (EARS-START-007) | Log in anyway; exit | Logging in twice as one bot would make each process's voice join displace the other's, so speaking and listening would both flap. Idling with a clear detail is the configuration-gap posture (HLD Failure posture). |
| Discord identity | A bot account of ears' own, logged in with `EARS_DISCORD_TOKEN`; the co-host's speaking bot (`DISCORD_TOKEN`) belongs to [mouth](../mouth/mouth-design.md) | Self-bot / user account; share `DISCORD_TOKEN` with mouth | Header comment: automating a user account gets it banned (`index.ts:11-13`). Discord holds one voice connection per bot per guild, so ears and mouth, as separate processes, need a bot each ([listen-speak-split](decisions/listen-speak-split.md)). |
| Missing token / source off | Stay up idle, report `degraded` (or `off`), never exit | Exit non-zero like login failure | `earsPlan` doc comment: "never exits for a configuration gap" (`health.ts:8`); commit 51d5a9c; add-isolated-backends design D7 (no token idles `degraded` rather than `exit(1)`). |
| Login failure | `process.exit(1)` | Retry with backoff | add-isolated-backends design D7: "Login failure with a token present keeps current exit(1) behavior (real error, supervisor should see it)" (`discord.ts:121`). |
| Library loading | Dynamic import of `discord.js` only in the `discord` plan | Static import | Comment: "only loaded when a session will actually be opened" (`index.ts:35`). |
| Utterance boundary | Discord `AfterSilence` end behavior with `ears.silence_ms` | Own VAD / fixed windows | The Discord receiver already delivers one stream per speaker and Discord only transmits while that speaker's client detects voice or push-to-talk, so ending the subscription after `ears.silence_ms` of silence (`discord.ts:58`) cuts an utterance where the speaker stopped, with no second VAD to tune. `ears.silence_ms` is the latency lever: a shorter window sends speech to STT sooner but splits sentences at pauses. ears has never run against real Discord, so this boundary is current intent pending first contact. |
| Per-speaker streams | One Opus subscription and one STT call per speaker per utterance | Mixed channel audio | Header comment: "so the brain knows who said what" (`index.ts:4-6`). |
| Resampling | Hand-written 3:1 averaging decimation from 48 kHz stereo to 16 kHz mono | Library resampler, ffmpeg | The conversion has fixed endpoints (Discord's 48 kHz stereo, Whisper's 16 kHz mono), so a few lines of code need no native dependency or child process. Speech needs no studio-grade filter: averaging three samples is a crude low-pass that keeps the speech band (`audio.test.ts:85-95`). |
| STT language | Hard-coded `en` | `ears` config key | The co-host speaks and is prompted in English, and naming the language skips Whisper's language detection, which is unreliable on the short clips a voice channel produces (EARS-HEAR-005, `hearing.ts:25`). There is no config key for the STT language. |
| Failed voice join | Log, report `degraded` / `discord: down`, keep the subscription, retry with increasing delay (SHARED-DVS-004) | Exit and let the supervisor restart (the original behaviour, via an unhandled rejection) | Owner decision 2026-11-01: a missing or wrong channel is an operational fault, not a reason to crash-loop; injection and health must keep working. Login failure still exits 1 (row above). |
| Injection before join | Start the `ears` loop before the voice join (EARS-INJ-007) | Subscribe after the join (the original code) | Owner decision 2026-11-01: add-test-injection requires injection to work when Discord is not connected. |
| Guild and channel source | Config keys `ears.discord.guild_id` / `voice_channel_id` (EARS-SESS-007) | Read `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` directly (the original code); delete the keys | Owner decision 2026-11-01: config keys beat env vars; the example YAML already fills them from the env vars. |
| Shutdown | One shutdown sequence: destroy the voice connection and client, then stop the bus (EARS-SESS-008) | Separate `onShutdown` registrations (the original code) | Owner decision 2026-11-01 (project-wide): the bus runs every registered callback and exits once. |
| Mute and pause | ears does not subscribe to `control` and publishes `speech.heard` whatever the mute or pause state (EARS-HEAR-009) | Stop listening while muted | Owner decision 2026-11-01 (project-wide): only cortex and salience see mute and pause; a muted co-host still hears what is said, so her next reply has the context. |
| Start mode | `latest`: the `ears` group is reset to the newest entry on every start (EARS-START-006) | `resume` (handle a backlog of stale injection requests) | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; delivery across restarts is at-most-once. |
| Injection upload transport | The upload is read from Redis by id (`Bus.takeUpload`); the event carries no URL | Fetch a URL from the dashboard's listener and document the firewall rule; base64 in the event | No URL means no fetch to guard and nothing on the host that a container must reach (dashboard decision on upload transport). The key is deleted on read and expires on its own if ears is down. |
| Stale injected requests | Drop after 60 s | Process all backlog | Consumer groups resume after a restart: `INJECT_STALE_MS` in `@cohost/shared` (shared with eyes and chat, SHARED-INJ-008); add-test-injection design D8 ("Staleness"). |
| Injected clips skip `min_speech_ms` | No minimum duration | Apply the gate | add-test-injection design D8: "`min_speech_ms` does not apply (that gates Discord PCM)"; doc comment `inject.ts:50`; test `inject.test.ts:36-43`. |
| More listening sources | Capture adapters feeding the one `Hearing` path, selected by `ears.source` (`discord`, `off`, `http`, `dir`); `http` takes POSTed 16-bit PCM or WAV on a local port and `dir` takes WAV files dropped in a polled directory, both bounded by the shared inject limits and both working with the stub transcriber and no account (EARS-CAP-*) | Defer all new sources; a per-source map `ears.sources.<name>` with `enabled`, so several run at once; `fs.watch` for `dir`; a local microphone or OBS audio source first | The HLD's deferred goals do not forbid a listening source, and an account-free source is the missing way to run and test ears without Discord. One enum keeps every existing config valid and matches the other services' `source` switches (`chat.source`); one active source at a time is enough because Discord voice and a scripted feed are alternatives, not companions. Polling is the portable choice across WSL, bind mounts and network shares. A microphone or OBS source needs a native capture dependency and its own account-free test story, so it is a later adapter behind the same contract. |
| Tuning the co-host's voice | Owned by the [voice](../voice/voice-design.md) segment | A listening-side knob | The voice knobs (speed and whatever the TTS engine exposes) act on synthesis, not on hearing. |
| Inject loop and STT | The `ears` loop hands each `inject.request` to the shared inject handler's queue and returns (EARS-INJ-011) | Await the handler in the loop (the original code) | A slow STT call or upload fetch should not delay reading the next request. |
| Word characters | A word character is a Unicode letter or number in any script (EARS-HEAR-007) | ASCII `\w` (the original code) | STT is forced to `en` today, but a transcript of non-ASCII letters or digits is still speech, and a language setting would otherwise silently drop it. |
| `readWavHeader` bit depth | `readWavHeader` is a thin adapter over the shared `parseWav`, which rejects input that is not 16-bit PCM; an unreadable header reads as `bad wav` and as duration 0 | Parse the header locally | One parser for every service; 8- and 24-bit input is refused instead of misread. |
| Whisper silence hallucinations | An `ears.drop_phrases` list (default empty, whole-transcript match) applied to live captures only (EARS-HEAR-010) | A built-in phrase list; fuzzy or substring matching; filtering injected clips too | Which phrases are hallucinations depends on the model and the room, so the owner lists them and the example config shows Whisper's usual ones. Whole-transcript matching never drops a sentence that merely contains "thank you". An injected clip is chosen by the owner, so it is transcribed as given. |

## Open Questions & Future Decisions

None.

## Manual verification

1. **Native dependencies.** `@discordjs/voice` loads `libsodium-wrappers` (transport encryption), `@snazzah/davey` (DAVE end-to-end encryption) and `opusscript` (Opus codec) itself; ears carries them without importing them. Whether this set is sufficient is checked by a first run against a real Discord guild and voice channel (receive and decode a human speaker).

## References

Files in this segment:

- `services/ears/src/index.ts`, `service.ts`, `discord.ts`, `session.ts`, `hearing.ts`, `transcript.ts`, `audio.ts`, `inject.ts`, `health.ts` (`playback.ts`, `fallback.ts` and the playback half of `audio.ts` move to `services/mouth`)
- `services/ears/test/audio.test.ts`, `ears.test.ts`, `filter.test.ts`, `transcript.test.ts`, `stub.test.ts`, `loop.test.ts`, `service.test.ts`, `discord.test.ts`, `health.test.ts`, `inject.test.ts`, `inject-limits.test.ts`, `session.test.ts` (`fallback.test.ts` and the playback cases of `ears.test.ts` move to `services/mouth/test`)
- `services/ears/package.json`, `services/ears/tsconfig.json`

Other segments (arrow shows direction):

- ears -> [event-bus](../event-bus/event-bus-design.md): publishes `speech.heard`, `inject.result`, heartbeats; consumes `inject.request` (group `ears`).
- ears -> `@cohost/shared` (workspace package): `createInjectHandler`, `INJECT_STALE_MS`, owned by the [eyes LLD](../eyes/eyes-design.md) (Image Injection); `createJoiner`, shared with mouth.
- ears -> [config](../config/config-design.md): `loadConfig`, `urls.stt()`, `env()`.
- ears <- [dashboard](../dashboard/dashboard-design.md): sends `inject.request` and stores the upload in Redis.
- ears -> [salience](../salience/salience-design.md) / [cortex](../cortex/cortex-design.md) / [memory](../memory/memory-design.md): consumers of `speech.heard` (not touched by ears).
- ears -> [control-plane](../control-plane/control-plane-design.md): heartbeat contract (`startHeartbeat`, `tracked`).
- ears -> [deployment](../deployment/deployment-design.md): compose profile `ears`, depends on `stt` (`docker-compose.yml`).
- ears <-> [mouth](../mouth/mouth-design.md): no runtime link; mouth's bot is one of the bots ears ignores. Decision doc: [listen-speak-split](decisions/listen-speak-split.md).

External: discord.js 14, `@discordjs/voice`, `prism-media` (Opus decode), speaches / faster-whisper STT (OpenAI-compatible `/v1/audio/transcriptions`).

OpenSpec: `openspec/specs/ears/spec.md`; designs cited above: `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md` ("add-isolated-backends design"), `openspec/changes/archive/2026-11-01-add-test-injection/design.md` ("add-test-injection design"); deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md`, `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md`, `openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md`.

EARS specs: [ears-specs.md](./ears-specs.md).
