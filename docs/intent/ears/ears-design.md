---
parent: high-level-design
prefix: EARS
---

# ears

> Brownfield LLD, mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at `1b57790` with the owner's decisions of 2026-11-01 applied. Describes the implemented behaviour, plus the designed but not yet built spoken fallback line (Fallback Line; `[ ]` specs). HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

ears is the co-host's hearing and its Discord mouth. It is one Node process (`services/ears`) that does two jobs which share a single Discord session:

1. **Listen.** A Discord *bot* sits in a voice channel, captures each speaker as a separate stream, cuts utterances on silence, sends each to an OpenAI-compatible STT server (speaches / faster-whisper), and publishes `speech.heard` carrying the speaker's name (`services/ears/src/index.ts:3-6`).
2. **Speak (sink).** It is one of the *sinks* in the audio-sink arbitration protocol owned by [voice](../voice/voice-design.md): it fetches the WAV a `voice.utterance` points at, plays it into the voice channel, and reports `voice.playing` / `voice.done` with `sink: "discord"` (`services/ears/src/playback.ts:21-53`).

A third job is independent of the Discord session: it accepts `inject.request` for uploaded audio, transcribes it through the same STT path, and publishes an injected `speech.heard` (`services/ears/src/inject.ts:48-78`; commit 3fae9f7, add-test-injection design D8).

Design leanings (evidence per bullet):

- **Pure logic is split from the Discord glue.** `Hearing`, `Playback`, `createInjectHandler`, `EarsHealth` and the audio helpers take their effects as injected functions (`transcribe`, `fetchAudio`, `play`, `fetch`, `now`) so they are unit-tested with fakes (`services/ears/test/*.test.ts`). `discord.ts` and `index.ts` hold all the I/O glue and have **no tests**. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": ears gained the `Playback` queue and `Hearing`).
- **Never exit for a configuration gap.** A missing `DISCORD_TOKEN` or `ears.source: off` leaves the process up and idle with an honest heartbeat rather than crash-looping (`services/ears/src/health.ts:8-12`, `services/ears/src/index.ts:40-58`). Evidence: `earsPlan` doc comment (`health.ts:8`); commit 51d5a9c; add-isolated-backends design D7.
- **Discord libraries are only loaded when needed**, via a dynamic `import("./discord.js")` (`services/ears/src/index.ts:35-37`), so idle plans carry no gateway client. Evidence: comment at `index.ts:35`.
- The bot must be a *bot* account, not a user account: header comment `services/ears/src/index.ts:11-13` ("automating a user account gets it banned").

Ownership notes: `src/health.ts` implements the heartbeat contract owned by [control-plane](../control-plane/control-plane-design.md); `src/inject.ts` is ears' half of test injection (the panel, upload store and bus-level injection belong to [dashboard](../dashboard/dashboard-design.md); the `inject.*` schemas belong to [event-bus](../event-bus/event-bus-design.md)); the "off" mode belongs here.

## Startup Plans

At boot `index.ts` loads config, creates a `Bus("ears")`, reads `process.env.DISCORD_TOKEN`, and derives a **plan** with the pure function `earsPlan(cfg.ears.source, hasToken)` (`services/ears/src/index.ts:21-25`, `services/ears/src/health.ts:9-12`):

| `ears.source` | token | plan | Discord client | Heartbeat |
| --- | --- | --- | --- | --- |
| `off` | any | `off` | none | mode `off`, deps `discord: n/a, stt: n/a`, state `ready` immediately (`index.ts:45-48`) |
| `discord` | unset | `no-token` | none | mode `live`, `discord: down`, state `degraded` with detail `DISCORD_TOKEN is not set` (`index.ts:50-51`) |
| `discord` | set | `discord` | yes | mode `live`; `ready` only after the voice connection is Ready (`discord.ts:77-78`) |

`ears.source` is `discord | off` (default `discord`), settable through `EARS_SOURCE` via `config.example.yaml:148` (`packages/config/src/schema.ts:181`).

In the two idle plans (`off`, `no-token`) the process:

- subscribes only to `inject.request` (consumer group `ears`, `subscribeEars` in `session.ts`), so `voice.utterance` is ignored and nothing is played; `ready` (or `degraded` for `no-token`) is signalled after the subscription is established;
- in `no-token` repeats `log.warn("DISCORD_TOKEN is not set; ears still idle")` every 60 s (`index.ts:53-55`);
- on shutdown clears that timer and stops the bus, as one `stopEars` sequence (EARS-START-005).

In every plan the `ears` consumer group uses the bus start mode `latest`: the group is reset to the newest entry on every start, so utterances and injection requests published while ears was down are neither played nor handled (EARS-START-006). `subscribeEars` creates the group first (`Bus.resetGroup`, so it exists before any `ready` signal) and then starts the read loop with `start: "latest"`.

In the `discord` plan shutdown is one sequence, `stopEars` (`session.ts`), registered once from `index.ts`: destroy the voice connection and the Discord client (`DiscordSession.stop()`), then stop the bus, even if the teardown throws (EARS-SESS-008). The heartbeat's pre-shutdown hook sends `stopping` before any callback runs, and the bus runs every registered callback in order and exits once ([event-bus](../event-bus/event-bus-design.md)).

Environment and config read by ears:

| Source | Key | Use |
| --- | --- | --- |
| env | `DISCORD_TOKEN` | plan selection (`index.ts:24`) and login (`discord.ts:121`) |
| config | `ears.discord.guild_id`, `ears.discord.voice_channel_id` | guild and voice channel to join (EARS-SESS-007), resolved by `voiceTarget` (`session.ts`), which throws `ears.discord.guild_id is not set` / `ears.discord.voice_channel_id is not set` for an empty key; `config.example.yaml:150-151` fills them from `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID`. The environment variables are not read by ears |
| env | `STT_URL` | via `urls.stt()`, default `http://127.0.0.1:8000` (`packages/config/src/index.ts:171`) |
| env | `DASHBOARD_URL` | via `urls.dashboard()`; the only origin injected uploads may be fetched from (`index.ts:31`) |
| config | `ears.source`, `ears.silence_ms` (700), `ears.min_speech_ms` (400), `ears.stt_model` (`Systran/faster-whisper-small`) | `packages/config/src/schema.ts:179-189` |

## Listening Pipeline

Implemented in `discord.ts` (capture) and `hearing.ts` (STT + publish).

1. **Intents.** The client requests `Guilds`, `GuildVoiceStates` and `GuildMembers` (`discord.ts:28`). `GuildMembers` is privileged; it is used so `guild.members.fetch()` populates display names (`discord.ts:66`; failure of that fetch is swallowed).
2. **Join.** On the client's `ready` event, `join()` fetches the guild and channel, requires a voice-based channel (`"ears.discord.voice_channel_id is not a voice channel"`), calls `joinVoiceChannel` with `selfDeaf: false, selfMute: false`, and waits up to 20 s for `VoiceConnectionStatus.Ready`; a connection that does not reach Ready is destroyed so the retry starts clean. On Ready it subscribes the shared audio player to the connection, sets `voiceReady = true`, and calls `heartbeat.ready()`. A failed join (initial or rejoin) is logged, reported as `degraded` with `deps.discord: down` (detail `voice join failed: <error>`), and retried by `createJoiner` (`session.ts`) with a delay that starts at 5 s and doubles to a 60 s cap, until it succeeds (EARS-SESS-006); the bus subscription keeps running throughout. A rejoin after a disconnect waits its first 5 s (EARS-SESS-005) and then follows the same schedule. Concurrent joins share one loop, and shutdown ends it.
3. **Per-speaker capture.** `connection.receiver.speaking.on("start")` fires `listenTo(userId, channel)` for every user except the bot itself (`discord.ts:82-85`). `listenTo` keeps a `listening` set so a user already being captured is not subscribed twice (`discord.ts:40`). It subscribes to the user's Opus stream with `EndBehaviorType.AfterSilence` and `duration: ears.silence_ms`, pipes it through `prism-media`'s Opus decoder (`48000 Hz, 2 channels, frameSize 960`), and collects PCM chunks (`discord.ts:46-51`). On decoder `end` the user leaves the set and `Hearing.heard(pcm, name, userId)` runs un-awaited (`discord.ts:52-55`); on decoder `error` the user leaves the set and a warning is logged (`discord.ts:56`). The speaker's name is the guild member's `displayName`, falling back to the user id (`discord.ts:43-44`).
4. **Gate, convert, transcribe.** `Hearing.heard` computes `durationMs = bytes / 4 / 48000 * 1000` and drops anything shorter than `ears.min_speech_ms` (`hearing.ts:39-41`). Otherwise it downsamples to 16 kHz mono WAV (`discordPcmToWav16k`, `audio.ts:5-18`: 3:1 decimation that averages 3 frames and both channels, clamped to int16) and calls the transcriber.
5. **STT request.** `sttTranscriber` POSTs multipart form data to `<STT_URL>/v1/audio/transcriptions` with fields `file`, `model` (= `ears.stt_model`), `language` = `"en"` (hard-coded), `response_format` = `json`; a non-2xx throws `stt <status>: <body>`; the result is `json.text.trim()` (`hearing.ts:19-32`). The same function accepts an optional content-type hint so injected uploads keep their container (`hearing.ts:20-23`, extension table at `hearing.ts:13-15`).
6. **Publish.** Text that is empty or matches `/^\W*$/` is dropped silently; otherwise `speech.heard { speaker, speakerId, text, durationMs }` is published (`hearing.ts:44-46`). Any exception becomes a `"transcription failed"` warning (`hearing.ts:47-49`). `speech.heard` is defined at `packages/bus/src/events.ts:40-48`.

The transcriber handed to `Hearing` (and to the inject handler) is wrapped by `EarsHealth.track`, so each STT call sets `deps.stt` ok/down (`discord.ts:32`, `index.ts:31`, `health.ts:31-33`).

There is no cap on utterance length (a speaker who never pauses for `silence_ms` is buffered in memory until they do), no VAD beyond Discord's speaking events, no echo suppression of the bot's own playback leaking through other participants' microphones, and no filtering of other bots' audio; only the bot's own user id is ignored (`discord.ts:83`).

## Playback Sink

`Playback` (`playback.ts:22-53`) is a FIFO queue with a single "current" slot:

- `enqueue(id, url)` pushes and calls `pump()`.
- `pump()` returns if something is current or the queue is empty; otherwise it shifts the head, sets `current = id`, fetches the WAV (`httpAudio`: plain `fetch`, throws `fetch audio <status>` on non-2xx, `playback.ts:14-18`), converts it with `wavToDiscordPcm` (any-rate mono/stereo 16-bit WAV to 48 kHz stereo by linear interpolation, `audio.ts:22-41`), calls `play(pcm)` (which becomes `player.play(createAudioResource(Readable.from([pcm]), { inputType: Raw }))`, `discord.ts:33-36`), and **then** publishes `voice.playing { id, sink: "discord" }` (`playback.ts:44-46`).
- If fetch/convert/play throws, it logs `"playback failed"`, clears `current`, and pumps the next item. It publishes **neither** `voice.playing` nor `voice.done` for the failed item (`playback.ts:47-51`; asserted deliberately by `ears.test.ts:44-53`). The intended behaviour replaces this silent skip: ears gives up on the utterance, reports it on the bus, and says a spoken fallback line in its place (see Fallback Line below; EARS-PLAY-005, EARS-PLAY-006 and EARS-FALL-*, gaps).
- `AudioPlayerStatus.Idle` calls `onIdle()`, which publishes `voice.done { id: current, sink: "discord" }` and pumps (`Playback.onIdle`). Idle with nothing current publishes nothing. A failed `voice.done` publish is caught, logged as a warning (`voice.done publish failed`) and the queue continues (EARS-PLAY-009); `onIdle` awaits the publish so `voice.done` precedes the next `voice.playing`.
- Player errors are only logged (`discord.ts:106`); the queue is unbounded and the fetch has no timeout.

Subscription (discord plan only): `startDiscord` establishes `subscribeEars(bus, ["voice.utterance", "inject.request"], handler)` (group `ears`, start mode `latest`) **before** the client logs in and before any voice join, so injection works while Discord is not connected and whether or not the join succeeds (EARS-INJ-007). It is **one loop for both types**: two loops with different type filters in the same group would drop each other's events. The handler (`createEarsHandler`, `session.ts`) passes `inject.request` to the injection handler (`await`ed, so STT and upload fetch latency delays reading the next stream entry) and queues a `voice.utterance` with `playback.enqueue(d.id, d.audioUrl)` (un-awaited) only while the voice connection is ready; while it is not, the utterance is skipped (debug log, no queue, no `voice.playing`) so voice's virtual sink covers it rather than ears claiming a line it cannot play.

The sink's behavior relative to the protocol: ears always plays every utterance it sees (no gating on mute, source, or whether another sink is also playing). ears never subscribes to `control`: `mute` and `pause` are enforced upstream by cortex and salience, which stop producing `brain.say`, so ears needs no mute state of its own (EARS-PLAY-008). How that interacts with the 1.5 s virtual-sink window is documented in the [voice LLD](../voice/voice-design.md) (Sink Arbitration Protocol). The one place ears looks at another sink is the fallback line: before it plays a fallback clip it checks whether another real sink already claimed the utterance (EARS-FALL-009).

## Fallback Line

When ears cannot play a line, the co-host says something funny aloud instead of going silent: a short line such as "Error: unable to play line.", picked at random from a list the owner edits in `config.yaml`. The lines are **spoken**: voice pre-generates one audio clip per line with the co-host's TTS voice and stores them as local files, so playing one does not depend on the fetch and convert path that just failed. ears only reads and plays those files; it never synthesizes or writes them. The co-host's transcript records the fallback as something she said, with a note that the line she meant failed to play, and her next reply gets a hint inviting her to riff on the glitch in character. All of this is a gap today; the specs are `[ ]`.

Owner decisions: the fallback is said aloud, chosen at random from a configurable list; clips are generated ahead of time by voice with the TTS voice and stored as local files that ears plays; clips regenerate automatically when the list or the voice settings change; the transcript keeps the fallback as her line plus a note that the intended line failed; her next reply gets a hint with a base chance of 1 in 4 (`brain.cortex.fallback_ack_chance`, default 0.25) and the model decides in character whether to acknowledge; ears reports on the bus that it gave up on the utterance id, claims the id with `voice.playing` (sink `discord`) when the fallback starts and publishes `voice.done` when it ends; the feature stays in ears. Items marked `[proposed]` below are design choices awaiting the owner's confirmation; everything else is settled.

Ownership across segments:

| Part | Segment |
| --- | --- |
| Giving up, choosing and playing a clip, the storm limit | ears (this section; EARS-PLAY-005, EARS-PLAY-006, EARS-FALL-*) |
| `voice.failed` semantics within sink arbitration; clip generation, fingerprint and store layout | [voice](../voice/voice-design.md) (Sink Arbitration Protocol; Fallback Clips; VOICE-SINK-010 to 013, VOICE-CLIP-*) |
| `voice.failed` payload schema and the catalogue count | [event-bus](../event-bus/event-bus-design.md) (BUS-EVT-001, BUS-EVT-022) |
| Phrase list, storm interval, acknowledgement chance, clip directory | [config](../config/config-design.md) (CFG-SCH-017 to 019, CFG-USR-009, CFG-USR-010, CFG-DIR-006, CFG-DIR-007) |
| Transcript entry for a fallback | [working-memory](../working-memory/working-memory-design.md) (WM-PUSH-007, WM-PUSH-008, WM-WIN-007, WM-TRANS-010) |
| Acknowledgement hint | [cortex](../cortex/cortex-design.md) (CTX-EVT-008, CTX-FALL-*) |
| Shared clip directory in Compose | [deployment](../deployment/deployment-design.md) (DEPLOY-COMPOSE-018) |

### Giving up

ears gives up on a queued utterance when fetching or converting its audio fails, or when handing it to the Discord player throws (EARS-PLAY-005). It logs `playback failed` as today. It then publishes exactly one `voice.failed` for that utterance id with `sink: "discord"` and a `reason` (the error text) (EARS-PLAY-006); the event carries a `fallback` object (clip file name and phrase text) exactly when a fallback clip is playing for that id (EARS-FALL-011) `[proposed]`. The give-up report is what the deferred intent of EARS-PLAY-006 asked for: voice, avatar and cortex learn that the line will not play instead of waiting on the virtual sink's timer. How voice uses the report to release cortex early when nothing plays is the voice LLD's (VOICE-SINK-011, VOICE-SINK-012).

An utterance ears never took is not given up: while the voice connection is not ready ears skips `voice.utterance` without queueing it (EARS-INJ-007) and publishes no `voice.failed` for it (EARS-FALL-013); voice's virtual sink covers it as today. In the `off` and `no-token` plans ears does not read `voice.utterance` at all (EARS-START-003).

### Choosing and playing a clip

On a give-up, in the same queue slot and before the next queued utterance:

1. **Another sink already has it.** ears reads `voice.playing` on its `ears` loop alongside `voice.utterance` and `inject.request` and remembers, for the newest 50 utterance ids, which ones a real sink other than `discord` (today the dashboard) claimed (EARS-FALL-010) `[proposed]`. If the given-up id is among them, the line is already being heard elsewhere, so ears plays no fallback (EARS-FALL-009). This keeps a stream that captures both the dashboard sink and the Discord channel from hearing the real line and a fallback at once. A dashboard claim that arrives after the fallback started does not stop it: both play, as two sinks already do for any line (voice LLD, Decisions: sink exclusivity).
2. **Storm limit.** If ears started a fallback clip less than `ears.fallback.min_interval_ms` ago (default 20000) `[proposed]`, it plays none (EARS-FALL-007). When voice's HTTP server is down every queued line fails within milliseconds; without the limit a backlog of failures would become a run of fallback lines. Failures inside the interval still publish `voice.failed`, so the brain is released for each.
3. **Read the store.** ears reads `manifest.json` from the clip directory (`clipsDir()`, config CFG-DIR-006, CFG-DIR-007) at that moment (EARS-FALL-004) `[proposed]`. Reading on each give-up costs one small file read on a rare path and picks up a regenerated set with no signal or restart. No directory, no manifest, an unreadable manifest or a manifest with no clips means no fallback (EARS-FALL-005): the line is skipped silently as before, and `voice.failed` still goes out.
4. **Pick.** Uniformly at random among the listed clips, excluding the clip ears played last when more than one is listed, and excluding clips marked bad (step 5) (EARS-FALL-006) `[proposed]`.
5. **Load and play.** ears reads the whole clip file into memory, converts it exactly as an utterance (EARS-AUD-002) and hands it to the Discord player. A missing, empty or unparseable clip file, or a throw from the player, means no fallback for this give-up; ears logs a warning naming the clip and marks it bad until the manifest's fingerprint changes (EARS-FALL-008) `[proposed]`. It does not try a second clip: one failure path per give-up keeps the queue moving.
6. **Report.** Once the player has the clip, ears publishes `voice.playing { id, sink: "discord" }` for the given-up id, then `voice.failed` with `fallback` (EARS-FALL-002). The claim goes first so it reaches voice as early as possible inside the 1.5 s window. The clip is then the current item: when the player goes idle ears publishes `voice.done { id, sink: "discord" }` and moves on (EARS-FALL-003, EARS-PLAY-004), which releases cortex after the fallback rather than after the line that never played.

ears only reads the clip directory, never writes it (EARS-FALL-012); in Compose it is mounted read-only into ears (DEPLOY-COMPOSE-018). Bad-clip marks and the last-played clip live in memory and reset on restart.

The fallback replaces a line that already passed the speaking gates (HLD tenet 4): it is not a new `brain.say`, carries the given-up utterance's id, and occupies that utterance's place in turn-taking.

### Edge cases

| Case | Handling | Spec |
| --- | --- | --- |
| Clip store empty or never generated (fresh install, voice in `stub`, empty phrase list) | no fallback; `voice.failed` without `fallback`; the line is skipped silently and voice releases cortex early | EARS-FALL-005, VOICE-SINK-011 |
| Clip file missing, zero-length or corrupt | no fallback for that give-up; warning naming the clip; the clip is not picked again until the set changes | EARS-FALL-008 |
| Regeneration while a fallback is playing | the playing clip is already in memory; voice swaps the manifest atomically and keeps the previous set's files until the next commit, so a read between manifest and file finds the file | EARS-FALL-004, VOICE-CLIP-004, VOICE-CLIP-007 |
| Phrase list edited to remove the clip that is playing | same as regeneration: the clip plays to the end from memory; the next pick reads the new manifest | VOICE-CLIP-007 |
| The fallback clip itself fails to play | no `voice.playing`; `voice.failed` without `fallback`; voice releases cortex early. A player error after start ends in Idle, so `voice.done` follows as for any line | EARS-FALL-008, EARS-PLAY-007 |
| ears not in the voice channel | the utterance is skipped, not given up; no `voice.failed`, no fallback; the virtual sink covers it | EARS-FALL-013, EARS-INJ-007 |
| Failure storm (voice down, every queued line fails) | at most one fallback per `ears.fallback.min_interval_ms`; every failure still publishes `voice.failed` | EARS-FALL-007, EARS-PLAY-006 |
| Fallback claim arrives after the 1.5 s window | voice's late-claim rule cancels the pending virtual `voice.done` while voice still stores the utterance's audio (VOICE-SINK-008). If the audio was evicted (the failure was a `404 gone`), voice records no claim and its virtual `voice.done` can release cortex while the fallback still plays; the next reply then queues behind the fallback in ears, so nothing overlaps in Discord | VOICE-SINK-007, VOICE-SINK-008 |
| Dashboard sink already claimed the id | no fallback; `voice.failed` without `fallback`; the line is heard on the dashboard sink | EARS-FALL-009 |
| Dashboard sink claims after the fallback started | both play (sinks are not exclusive) | voice LLD Decisions |
| Avatar during a fallback | avatar lip-syncs the given-up utterance's envelope, emotion and gesture from the `voice.playing` claim and stops on `voice.done`; the mouth follows the wrong audio for the clip's length `[proposed]` accepted | Open item below |
| Hung fetch | no give-up ever happens, because `httpAudio` has no timeout (Open Question 2); the fetch timeout that would turn a hang into a give-up is separate work | — |

### Build order

The feature lands in three pull requests, in this order, so each spec maps to one:

| # | Chunk | Specs |
| --- | --- | --- |
| 1 | Give-up signal, event schema and fallback playback in ears, reading clips from the fixed clip directory (tests use fixture directories; a fresh install has no clips yet, so the visible change is the early release) | ears `EARS-PLAY-005`, `EARS-PLAY-006`, `EARS-FALL-001` to `013`; event-bus `BUS-EVT-001`, `BUS-EVT-022`; voice `VOICE-SINK-010` to `013`; config `CFG-SCH-018`, `CFG-DIR-006`, `CFG-DIR-007`; deployment `DEPLOY-COMPOSE-018` |
| 2 | Clip generation, fingerprint and storage in voice; the phrase list and the starter list | voice `VOICE-CLIP-001` to `010`; config `CFG-SCH-017`, `CFG-USR-009` |
| 3 | Transcript entry and acknowledgement hint | working-memory `WM-PUSH-007`, `WM-PUSH-008`, `WM-WIN-007`, `WM-TRANS-010`; cortex `CTX-EVT-008`, `CTX-FALL-001` to `007`; config `CFG-SCH-019`, `CFG-USR-010` |

Chunk 1 gives the dashboard feed `voice.failed` with no dashboard change (DASH-FEED-002 forwards every type but heartbeats and viewer notes). Chunk 3 depends on chunk 1's event; chunk 2 is independent of chunk 3.

## Audio Injection

`createInjectHandler` (`inject.ts:52-78`) returns the `inject.request` handler. It is built in `index.ts` for **every** plan (`index.ts:31`) and subscribed directly in the idle plans (`index.ts:43`) or through `startDiscord` in the discord plan (`discord.ts:114`).

Processing order for a request `r` (publishing `inject.result { id, ok, detail? }` on every failure path):

1. `r.target !== "ears"` returns silently with nothing published (`inject.ts:57`).
2. Older than `INJECT_STALE_MS` = 60 000 ms by the event's `ts` returns `ok:false, "stale"` (`INJECT_STALE_MS` from `@cohost/shared`, EYES-INJ-015). (Consumer groups resume after a restart, which is why.)
3. `r.kind !== "audio"` returns `ok:false, "ears cannot handle kind '<kind>'"` (`inject.ts:61`).
4. `uploadUrl(r.url, urls.dashboard())` (from `@cohost/shared`; the eyes LLD owns it, EYES-INJ-015) must be same-origin, credential-free, and under `<dashboard path>/uploads/` with a non-empty id; otherwise `ok:false, "url is not an upload of this dashboard"` and nothing is fetched (`inject.ts:21-32,62-63`).
5. `fetch(target, { redirect: "error" })`; non-2xx returns `ok:false, "fetch upload <status>"` (`inject.ts:64-65`).
6. The bytes go **unchanged** to STT with the response content type as a hint (default `audio/wav`); `ears.min_speech_ms` does not apply (`inject.ts:66-67`, `inject.ts:48-51`).
7. Empty/non-word transcript returns `ok:false, "empty transcript"` (`inject.ts:68`).
8. Success publishes `speech.heard { speaker: r.meta?.user || "injected", text, durationMs: wavDurationMs(audio), injected: true, remember: r.remember }` then `inject.result { ok:true, detail: text }` (`inject.ts:69-72`). `wavDurationMs` returns 0 for non-WAV or unreadable input (`inject.ts:36-45`). No `speakerId` is set.
9. Any exception logs `"audio injection failed"` and attempts `inject.result { ok:false, detail: String(err) }` (swallowing a bus failure) (`inject.ts:73-76`).

Injection works in every plan whether or not Discord is connected (add-test-injection: "MUST work when `ears.source` is `off` or Discord is not connected"). The `off` and `no-token` plans subscribe at startup; the `discord` plan subscribes before the voice join and keeps handling injection whether or not the join succeeds (EARS-INJ-007).

## Health

`EarsHealth` (`health.ts:19-34`) is the `HeartbeatSpec` for `service: "ears"`:

- `mode`: `"off"` for the `off` plan, else `"live"`.
- `deps`: `off` gives `{ discord: "n/a", stt: "n/a" }`; otherwise `discord` is `"ok"` only when the plan is `discord` and `voiceReady()` is true (so `no-token` is always `down`), and `stt` is the outcome of the last transcription (initially `"ok"`).
- `startHeartbeat` (owned by [control-plane](../control-plane/control-plane-design.md)) turns any `down` dep on a `ready` service into state `degraded` (`packages/bus/src/heartbeat.ts:71`).
- `voiceReady` is set true on join Ready and false when a disconnect does not recover (`discord.ts:77,94`). `heartbeat.ready()` is called again on each (re)join (`discord.ts:78`).
- In the `discord` plan a failed join reports `degraded` with `deps.discord: down` while the join is retried (EARS-SESS-006); the state is `starting` until the first join attempt resolves. A failed login exits 1.

Discrepancy: the `add-service-health` delta says no token means `mode: "off"` and `discord: "n/a"`; the later `add-isolated-backends` delta, the code, and `health.test.ts:7-12` say `mode: "live"`, `discord: "down"`, `degraded`. The code follows the later delta.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Discord identity | Bot account via `DISCORD_TOKEN` | Self-bot / user account | Header comment: automating a user account gets it banned (`index.ts:11-13`). |
| Missing token / source off | Stay up idle, report `degraded` (or `off`), never exit | Exit non-zero like login failure | `earsPlan` doc comment: "never exits for a configuration gap" (`health.ts:8`); commit 51d5a9c; add-isolated-backends design D7 (no token idles `degraded` rather than `exit(1)`). |
| Login failure | `process.exit(1)` | Retry with backoff | add-isolated-backends design D7: "Login failure with a token present keeps current exit(1) behavior (real error, supervisor should see it)" (`discord.ts:121`). |
| One bus loop for `voice.utterance` and `inject.request` | Single `subscribe` with both types | Two loops, one per type | Comment at `discord.ts:111`: two loops with different type filters would drop each other's events. Confirmed by `Bus.subscribe`, which XACKs every entry it reads, including ones its type filter skips (`packages/bus/src/index.ts:166`). |
| Library loading | Dynamic import of `discord.js` only in the `discord` plan | Static import | Comment: "only loaded when a session will actually be opened" (`index.ts:35`). |
| Utterance boundary | Discord `AfterSilence` end behavior with `ears.silence_ms` | Own VAD / fixed windows | The Discord receiver already delivers one stream per speaker and Discord only transmits while that speaker's client detects voice or push-to-talk, so ending the subscription after `ears.silence_ms` of silence (`discord.ts:58`) cuts an utterance where the speaker stopped, with no second VAD to tune. `ears.silence_ms` is the latency lever: a shorter window sends speech to STT sooner but splits sentences at pauses. ears has never run against real Discord, so this boundary is current intent pending first contact. |
| Per-speaker streams | One Opus subscription and one STT call per speaker per utterance | Mixed channel audio | Header comment: "so the brain knows who said what" (`index.ts:4-6`). |
| Resampling | Hand-written 3:1 averaging decimation down, linear interpolation up | Library resampler, ffmpeg | Both conversions have fixed endpoints (Discord's 48 kHz stereo, Whisper's 16 kHz mono), so a few lines of code need no native dependency or child process. Speech needs no studio-grade filter: averaging three samples is a crude low-pass that keeps the speech band, and tests show a 200 Hz tone survives the round trip (`audio.test.ts:85-95`). |
| STT language | Hard-coded `en` | `ears` config key | The co-host speaks and is prompted in English, and naming the language skips Whisper's language detection, which is unreliable on the short clips a voice channel produces (EARS-HEAR-005, `hearing.ts:25`). There is no config key for the STT language. |
| Playback format | Convert WAV to 48 kHz stereo s16le and feed as `StreamType.Raw` | Opus-encode / ffmpeg | `@discordjs/voice` takes raw 48 kHz stereo s16le PCM (`StreamType.Raw`) and Opus-encodes it itself, so ears only resamples (`audio.ts:21`, `discord.ts:46`) and needs no ffmpeg or separate encoder process. ears has never run against real Discord, so this path is current intent pending first contact. |
| Failed playback | Give up: report `voice.failed` and say a pre-generated fallback line in the line's place (EARS-PLAY-005, EARS-PLAY-006, EARS-FALL-*) | Skip silently and let voice's 1.5 s virtual sink time the line (the implemented behaviour); report `voice.done` with an error sink and say nothing | Owner decision: silence after a glitch is dead air on stream, and a funny line turns the glitch into a moment; the give-up report lets voice, avatar and cortex stop waiting on a line that will not play. |
| Where fallback audio comes from | Clips pre-generated by voice with the TTS voice and stored as local files that ears reads | Synthesize the fallback when the failure happens; a canned WAV shipped in the repo; fetch the clips from voice over HTTP and cache them in ears | Owner decision: playback must not depend on the path that just failed (voice's HTTP server or TTS), and the clips must sound like the co-host's current voice. Synthesizing on failure goes through TTS and voice, which are the likely causes; a shipped WAV is not the co-host's voice; an HTTP prefetch would stay inside HLD tenet 1 but adds a cache-refresh protocol to ears for the same result as a shared read-only directory. |
| Fallback text source | Clip manifest written by voice (file, phrase text, duration) | ears reads `voice.fallback.lines` from config itself | ears plays what voice generated, so the text it reports always matches the audio, even while a regeneration is pending or after it failed. |
| When ears reads the store | On every give-up `[proposed]` | Load once at startup; watch the directory | Give-ups are rare and the manifest is small; reading on demand needs no watcher and picks up a new set without a restart or a bus signal. |
| Clip choice | Uniform random, never the clip played last when there is a choice `[proposed]` | Round-robin; weighted | Random keeps it fresh; avoiding the previous line stops the same joke twice in a row, the repetition viewers notice most. |
| Failure storms | At most one fallback per `ears.fallback.min_interval_ms` (default 20000), every failure still reported `[proposed]` | One fallback per failure; a counter per minute; a fallback only for the first failure until a success | When voice is down every queued line fails at once; a minimum interval bounds the noise with one knob, and reporting every failure keeps the brain released. |
| Another sink already playing the line | No fallback when a real sink other than `discord` claimed the id before the give-up `[proposed]` | Always play the fallback in Discord; make sinks exclusive | Owner decision: no double audio. A stream that captures both the dashboard sink and the Discord channel must not hear the real line and a fallback together; making sinks exclusive would change the arbitration protocol for every line. |
| A bad clip | Skip this give-up, mark the clip bad until the set changes, no second try `[proposed]` | Try the next clip; mark bad forever | One attempt keeps the queue moving; marks reset when voice regenerates, which is the likely fix. |
| Failed voice join | Log, report `degraded` / `discord: down`, keep the subscription, retry with increasing delay (EARS-SESS-006) | Exit and let the supervisor restart (the original behaviour, via an unhandled rejection) | Owner decision 2026-11-01: a missing or wrong channel is an operational fault, not a reason to crash-loop; injection and health must keep working. Login failure still exits 1 (row above). |
| Injection before join | Start the `ears` loop before the voice join (EARS-INJ-007) | Subscribe after the join (the original code) | Owner decision 2026-11-01: add-test-injection requires injection to work when Discord is not connected. |
| Guild and channel source | Config keys `ears.discord.guild_id` / `voice_channel_id` (EARS-SESS-007) | Read `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` directly (the original code); delete the keys | Owner decision 2026-11-01: config keys beat env vars; the example YAML already fills them from the env vars. |
| Shutdown | One shutdown sequence: destroy the voice connection and client, then stop the bus (EARS-SESS-008) | Separate `onShutdown` registrations (the original code) | Owner decision 2026-11-01 (project-wide): the bus runs every registered callback and exits once. |
| Mute and pause | ears does not subscribe to `control` and plays every utterance (EARS-PLAY-008) | Stop listening or playing while muted | Owner decision 2026-11-01 (project-wide): only cortex and salience see mute and pause; voice and ears stay unaware. |
| Start mode | `latest`: the `ears` group is reset to the newest entry on every start (EARS-START-006) | `resume` (play a backlog of stale utterances) | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; delivery across restarts is at-most-once. |
| Publish failures | Log and continue (EARS-PLAY-009) | Unhandled rejection (the original `voice.done` publish) | Owner decision 2026-11-01 (project-wide): a failed bus publish is logged and the service continues. |
| Injection URL trust | Same origin as `urls.dashboard()`, under `/uploads/`, no redirects | Fetch any URL | SSRF guard: add-test-injection design D2 ("eyes/ears ... MUST only fetch URLs under `urls.dashboard()` + `/uploads/`"); doc comment on `dashboardUrl` (`inject.ts:11-12`). The origin and path check applies to the requested URL only; `redirect: "error"` (`inject.ts:64`) makes the fetch fail instead of following a redirect, which could lead anywhere the check would have refused. |
| Stale injected requests | Drop after 60 s | Process all backlog | Consumer groups resume after a restart: `INJECT_STALE_MS` in `@cohost/shared` (shared with eyes and chat, EYES-INJ-015); add-test-injection design D8 ("Staleness"). |
| Injected clips skip `min_speech_ms` | No minimum duration | Apply the gate | add-test-injection design D8: "`min_speech_ms` does not apply (that gates Discord PCM)"; doc comment `inject.ts:50`; test `inject.test.ts:36-43`. |

## Open Questions & Future Decisions

Behaviors and debt observed but not explained by the code or specs.

1. **The shared loop awaits the inject handler.** A slow STT call or upload fetch for an injected clip delays reading the next `voice.utterance` (`discord.ts:114`).
2. **No stuck-playback guard.** The queue is unbounded, `httpAudio` has no timeout, and `current` is only cleared by the player's Idle event or an exception (`playback.ts:14-18,39-52`). A hung fetch blocks the queue and every later utterance; a player that never reaches Idle (e.g. connection lost mid-clip) does the same. cortex has its own `speaking_timeout_ms` backstop but ears does not.
3. **Transcript filter is ASCII-only.** `/^\W*$/` treats every non-ASCII letter as non-word, so a transcript consisting only of such characters is dropped (`hearing.ts:44`, `inject.ts:68`). STT is forced to `en`, which masks it.
4. **`readWavHeader` bit depth.** `readWavHeader` ignores bit depth, so 8- or 24-bit input is misread silently; `inject.ts` re-adds the RIFF check on top.
5. **Untested glue.** `discord.ts` and `index.ts` have no tests: session lifecycle, capture, rejoin, plan wiring, shutdown. Only the injected-function classes are covered.
6. **Dependencies of unclear role.** `@snazzah/davey`, `libsodium-wrappers` and `opusscript` are in `services/ears/package.json:16-20` but never imported from `src/`. They are runtime requirements that `@discordjs/voice` and `prism-media` load themselves: `libsodium-wrappers` for voice transport encryption, `@snazzah/davey` for Discord's DAVE end-to-end encryption protocol, and `opusscript` as the pure-JS Opus codec used to decode received audio and encode playback. Whether this set is sufficient is unverified until ears first runs against real Discord.
7. **Hallucinated transcripts.** There is no filter for known Whisper silence hallucinations ("Thank you.") other than the empty/punctuation check.
8. **Avatar during a fallback clip.** avatar lip-syncs from the `voice.playing` claim using the given-up utterance's envelope, emotion and gesture, so the mouth follows the wrong audio while the clip plays. Accepting the mismatch keeps avatar unchanged `[proposed]`; a matching envelope would need the clip's envelope on the bus and an avatar change.
9. **Long-term memory keeps the intended line.** memory stores every `brain.say` as the co-host's own line when it is published, so a line that failed to play is remembered as said; only the working-memory transcript records the fallback.
10. **Untested `[x]` specs.** 15 of 39 `[x]` specs have no test, all in the untested glue (`discord.ts`, `index.ts`) plus EARS-INJ-003 (wrong kind) and EARS-PLAY-008 (a boundary statement with no code entry point). EARS-INJ-004's redirect refusal and non-2xx paths are untested in ears (eyes tests the 404 path for its copy). EARS-HLTH-003's recovery to `ok` after a success is not asserted.

### Deferred decisions

1. **Separate listening and speaking modules.** ears does two jobs on one Discord session: listening (capture, STT, `speech.heard`) and speaking (the `discord` playback sink, including the fallback line). The owner's direction is to separate them into a source-agnostic listening module and a source-agnostic speaking module, with audio routing the owner can tune and define: listening will take audio from more sources than Discord, and the co-host's voice will be able to go to outputs beyond today's sinks. The name `ears` no longer fits both jobs. The split is deferred and out of scope for the fallback line, which stays in ears' playback path. It is a large refactor because both jobs share one Discord client, one voice connection and one join/rejoin lifecycle (Discord allows a bot one voice connection per guild), so the speaking side cannot become a separate process without either a second bot identity or a shared session broker; the `ears` heartbeat, Compose profile, manifest entry and consumer group are also one unit today. HLD: Deferred goals.
2. **Tuning the co-host's voice.** Owner-facing voice knobs (speed and whatever else the TTS engine exposes) belong to the [voice](../voice/voice-design.md) segment and are deferred there. Fallback clips use whatever voice settings are active and regenerate when they change (VOICE-CLIP-001).

## References

Files in this segment:

- `services/ears/src/index.ts`, `discord.ts`, `session.ts`, `hearing.ts`, `playback.ts`, `audio.ts`, `inject.ts`, `health.ts`
- `services/ears/test/audio.test.ts`, `ears.test.ts`, `health.test.ts`, `inject.test.ts`, `session.test.ts`
- `services/ears/package.json`, `services/ears/tsconfig.json`

Other segments (arrow shows direction):

- ears -> [event-bus](../event-bus/event-bus-design.md): publishes `speech.heard`, `voice.playing`, `voice.done`, `inject.result`, heartbeats, and (fallback line) `voice.failed`; consumes `voice.utterance`, `inject.request`, and (fallback line) `voice.playing` (group `ears`).
- ears <- [voice](../voice/voice-design.md) clip store: reads the fallback clips and manifest voice writes under `clipsDir()` ([config](../config/config-design.md)), mounted read-only in Compose ([deployment](../deployment/deployment-design.md)).
- ears -> `@cohost/shared` (workspace package): `uploadUrl`, `INJECT_STALE_MS`, owned by the [eyes LLD](../eyes/eyes-design.md) (Image Injection).
- ears -> [config](../config/config-design.md): `loadConfig`, `urls.stt()`, `urls.dashboard()`, `env()`.
- ears <- [voice](../voice/voice-design.md): owns the sink arbitration protocol; ears is a `discord` sink and fetches `audioUrl` from voice's HTTP server.
- ears <- [dashboard](../dashboard/dashboard-design.md): sends `inject.request` and serves `/uploads/<id>`; the other sink (`sink: "dashboard"`).
- ears -> [salience](../salience/salience-design.md) / [cortex](../cortex/cortex-design.md) / [memory](../memory/memory-design.md): consumers of `speech.heard` (not touched by ears).
- ears -> [control-plane](../control-plane/control-plane-design.md): heartbeat contract (`startHeartbeat`, `tracked`).
- ears -> [deployment](../deployment/deployment-design.md): compose profile `ears`, depends on `stt` (`docker-compose.yml:150-156`).
- ears -> [avatar](../avatar/avatar-design.md): lip-syncs from the `voice.playing` ears publishes.

External: discord.js 14, `@discordjs/voice`, `prism-media` (Opus decode), speaches / faster-whisper STT (OpenAI-compatible `/v1/audio/transcriptions`).

OpenSpec: `openspec/specs/ears/spec.md`; designs cited above: `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md` ("add-isolated-backends design"), `openspec/changes/archive/2026-11-01-add-test-injection/design.md` ("add-test-injection design"); deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md`, `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md`, `openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md`.

EARS specs: [ears-specs.md](./ears-specs.md).
