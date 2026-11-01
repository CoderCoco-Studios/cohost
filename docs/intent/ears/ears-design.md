---
parent: high-level-design
prefix: EARS
---

# ears

> Brownfield LLD, mapped 2026-10-31 at git `686cc8f`. Describes what the code does today. Rationale cells are `[inferred]` until the project owner confirms them. HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

`[inferred]` ears is the co-host's hearing and its Discord mouth. It is one Node process (`services/ears`) that does two jobs which share a single Discord session:

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

`ears.source` is `discord | off` (default `discord`), settable through `EARS_SOURCE` via `config.example.yaml:148` (`packages/config/src/schema.ts:173-177`).

In the two idle plans (`off`, `no-token`) the process:

- subscribes only to `inject.request` (consumer group `ears`, `fromNow`), so `voice.utterance` is ignored and nothing is played (`index.ts:43`);
- in `no-token` repeats `log.warn("DISCORD_TOKEN is not set; ears still idle")` every 60 s (`index.ts:53-55`);
- on shutdown clears that timer and stops the bus (`index.ts:57`).

In the `discord` plan `index.ts` calls `startDiscord({...})` and registers `onShutdown(() => bus.stop())` (`index.ts:36-39`). `startDiscord` itself registers a second `onShutdown` that destroys the voice connection and Discord client (`discord.ts:122`). Each `onShutdown` call registers its own SIGINT/SIGTERM handler that awaits the shared pre-shutdown hooks (the `stopping` heartbeat) and then calls `process.exit(0)` (`packages/bus/src/index.ts:230-246`). The Discord handler is registered first and starts the heartbeat `stop()`; the bus-stop handler's call to the same hook returns at once, so it reaches `process.exit(0)` first and the Discord teardown is not reached (EARS-SESS-008; see Open Questions).

Environment and config read by ears:

| Source | Key | Use |
| --- | --- | --- |
| env | `DISCORD_TOKEN` | plan selection (`index.ts:24`) and login (`discord.ts:121`) |
| env | `DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID` | read with the throwing `env()` helper at join time (`discord.ts:63-64`) |
| env | `STT_URL` | via `urls.stt()`, default `http://127.0.0.1:8000` (`packages/config/src/index.ts:161`) |
| env | `DASHBOARD_URL` | via `urls.dashboard()`; the only origin injected uploads may be fetched from (`index.ts:31`) |
| config | `ears.source`, `ears.silence_ms` (700), `ears.min_speech_ms` (400), `ears.stt_model` (`Systran/faster-whisper-small`) | `packages/config/src/schema.ts:173-183` |
| config | `ears.discord.guild_id`, `ears.discord.voice_channel_id` | **declared in the schema but never read** by ears (see Open Questions) |

## Listening Pipeline

Implemented in `discord.ts` (capture) and `hearing.ts` (STT + publish).

1. **Intents.** The client requests `Guilds`, `GuildVoiceStates` and `GuildMembers` (`discord.ts:28`). `GuildMembers` is privileged; it is used so `guild.members.fetch()` populates display names (`discord.ts:66`; failure of that fetch is swallowed).
2. **Join.** On the client's `ready` event, `join()` fetches the guild and channel, requires a voice-based channel (`"DISCORD_VOICE_CHANNEL_ID is not a voice channel"`), calls `joinVoiceChannel` with `selfDeaf: false, selfMute: false`, and waits up to 20 s for `VoiceConnectionStatus.Ready` (`discord.ts:62-75`). On Ready it subscribes the shared audio player to the connection, sets `voiceReady = true`, and calls `heartbeat.ready()` (`discord.ts:76-79`).
3. **Per-speaker capture.** `connection.receiver.speaking.on("start")` fires `listenTo(userId, channel)` for every user except the bot itself (`discord.ts:82-85`). `listenTo` keeps a `listening` set so a user already being captured is not subscribed twice (`discord.ts:40`). It subscribes to the user's Opus stream with `EndBehaviorType.AfterSilence` and `duration: ears.silence_ms`, pipes it through `prism-media`'s Opus decoder (`48000 Hz, 2 channels, frameSize 960`), and collects PCM chunks (`discord.ts:46-51`). On decoder `end` the user leaves the set and `Hearing.heard(pcm, name, userId)` runs un-awaited (`discord.ts:52-55`); on decoder `error` the user leaves the set and a warning is logged (`discord.ts:56`). The speaker's name is the guild member's `displayName`, falling back to the user id (`discord.ts:43-44`).
4. **Gate, convert, transcribe.** `Hearing.heard` computes `durationMs = bytes / 4 / 48000 * 1000` and drops anything shorter than `ears.min_speech_ms` (`hearing.ts:39-41`). Otherwise it downsamples to 16 kHz mono WAV (`discordPcmToWav16k`, `audio.ts:5-18`: 3:1 decimation that averages 3 frames and both channels, clamped to int16) and calls the transcriber.
5. **STT request.** `sttTranscriber` POSTs multipart form data to `<STT_URL>/v1/audio/transcriptions` with fields `file`, `model` (= `ears.stt_model`), `language` = `"en"` (hard-coded), `response_format` = `json`; a non-2xx throws `stt <status>: <body>`; the result is `json.text.trim()` (`hearing.ts:19-32`). The same function accepts an optional content-type hint so injected uploads keep their container (`hearing.ts:20-23`, extension table at `hearing.ts:13-15`).
6. **Publish.** Text that is empty or matches `/^\W*$/` is dropped silently; otherwise `speech.heard { speaker, speakerId, text, durationMs }` is published (`hearing.ts:44-46`). Any exception becomes a `"transcription failed"` warning (`hearing.ts:47-49`). `speech.heard` is defined at `packages/bus/src/events.ts:35-43`.

The transcriber handed to `Hearing` (and to the inject handler) is wrapped by `EarsHealth.track`, so each STT call sets `deps.stt` ok/down (`discord.ts:32`, `index.ts:31`, `health.ts:31-33`).

There is no cap on utterance length (a speaker who never pauses for `silence_ms` is buffered in memory until they do), no VAD beyond Discord's speaking events, no echo suppression of the bot's own playback leaking through other participants' microphones, and no filtering of other bots' audio; only the bot's own user id is ignored (`discord.ts:83`).

## Playback Sink

`Playback` (`playback.ts:22-53`) is a FIFO queue with a single "current" slot:

- `enqueue(id, url)` pushes and calls `pump()`.
- `pump()` returns if something is current or the queue is empty; otherwise it shifts the head, sets `current = id`, fetches the WAV (`httpAudio`: plain `fetch`, throws `fetch audio <status>` on non-2xx, `playback.ts:14-18`), converts it with `wavToDiscordPcm` (any-rate mono/stereo 16-bit WAV to 48 kHz stereo by linear interpolation, `audio.ts:22-41`), calls `play(pcm)` (which becomes `player.play(createAudioResource(Readable.from([pcm]), { inputType: Raw }))`, `discord.ts:33-36`), and **then** publishes `voice.playing { id, sink: "discord" }` (`playback.ts:44-46`).
- If fetch/convert/play throws, it logs `"playback failed"`, clears `current`, and pumps the next item. It publishes **neither** `voice.playing` nor `voice.done` for the failed item (`playback.ts:47-51`; asserted deliberately by `ears.test.ts:44-53`).
- `AudioPlayerStatus.Idle` calls `onIdle()`, which publishes `voice.done { id: current, sink: "discord" }` (fire-and-forget, `void`) and pumps (`playback.ts:34-37`, `discord.ts:104`). Idle with nothing current publishes nothing.
- Player errors are only logged (`discord.ts:106`); the queue is unbounded and the fetch has no timeout.

Subscription (discord plan only): after `join()` resolves inside the client `ready` handler, `bus.subscribe({ group: "ears", types: ["voice.utterance", "inject.request"], fromNow: true }, ...)` starts **one loop for both types**; the comment says two loops with different type filters in the same group would drop each other's events (`discord.ts:108-118`). `voice.utterance` calls `playback.enqueue(d.id, d.audioUrl)` un-awaited; `inject.request` is `await`ed, so STT and upload fetch latency delays reading the next stream entry.

The sink's behavior relative to the protocol: ears always plays every utterance it sees (no gating on mute, source, or whether another sink is also playing). How that interacts with the 1.5 s virtual-sink window is documented in the [voice LLD](../voice/voice-design.md) (Sink Arbitration Protocol).

## Audio Injection

`createInjectHandler` (`inject.ts:52-78`) returns the `inject.request` handler. It is built in `index.ts` for **every** plan (`index.ts:31`) and subscribed directly in the idle plans (`index.ts:43`) or through `startDiscord` in the discord plan (`discord.ts:114`).

Processing order for a request `r` (publishing `inject.result { id, ok, detail? }` on every failure path):

1. `r.target !== "ears"` returns silently with nothing published (`inject.ts:57`).
2. Older than `INJECT_STALE_MS` = 60 000 ms by the event's `ts` returns `ok:false, "stale"` (`inject.ts:6,60`). (Consumer groups resume after a restart, which is why.)
3. `r.kind !== "audio"` returns `ok:false, "ears cannot handle kind '<kind>'"` (`inject.ts:61`).
4. `uploadUrl(r.url, urls.dashboard())` must be same-origin, credential-free, and under `<dashboard path>/uploads/` with a non-empty id; otherwise `ok:false, "url is not an upload of this dashboard"` and nothing is fetched (`inject.ts:21-32,62-63`).
5. `fetch(target, { redirect: "error" })`; non-2xx returns `ok:false, "fetch upload <status>"` (`inject.ts:64-65`).
6. The bytes go **unchanged** to STT with the response content type as a hint (default `audio/wav`); `ears.min_speech_ms` does not apply (`inject.ts:66-67`, `inject.ts:48-51`).
7. Empty/non-word transcript returns `ok:false, "empty transcript"` (`inject.ts:68`).
8. Success publishes `speech.heard { speaker: r.meta?.user || "injected", text, durationMs: wavDurationMs(audio), injected: true, remember: r.remember }` then `inject.result { ok:true, detail: text }` (`inject.ts:69-72`). `wavDurationMs` returns 0 for non-WAV or unreadable input (`inject.ts:36-45`). No `speakerId` is set.
9. Any exception logs `"audio injection failed"` and attempts `inject.result { ok:false, detail: String(err) }` (swallowing a bus failure) (`inject.ts:73-76`).

Caveat against the intent in `add-test-injection`: that spec says injection "MUST work when `ears.source` is `off` or Discord is not connected." True for the `off` and `no-token` plans; in the `discord` plan the subscription only starts after the voice channel is joined (`discord.ts:110-113`), so injection does not work before the join completes, or at all if it never does.

## Health

`EarsHealth` (`health.ts:19-34`) is the `HeartbeatSpec` for `service: "ears"`:

- `mode`: `"off"` for the `off` plan, else `"live"`.
- `deps`: `off` gives `{ discord: "n/a", stt: "n/a" }`; otherwise `discord` is `"ok"` only when the plan is `discord` and `voiceReady()` is true (so `no-token` is always `down`), and `stt` is the outcome of the last transcription (initially `"ok"`).
- `startHeartbeat` (owned by [control-plane](../control-plane/control-plane-design.md)) turns any `down` dep on a `ready` service into state `degraded` (`packages/bus/src/heartbeat.ts:66-70`).
- `voiceReady` is set true on join Ready and false when a disconnect does not recover (`discord.ts:77,94`). `heartbeat.ready()` is called again on each (re)join (`discord.ts:78`).
- In the `discord` plan the state stays `starting` until the first successful join; a login that hangs or a join that fails never reaches `degraded` (a failed login exits 1, `discord.ts:121`).

Discrepancy: the `add-service-health` delta says no token means `mode: "off"` and `discord: "n/a"`; the later `add-isolated-backends` delta, the code, and `health.test.ts:7-12` say `mode: "live"`, `discord: "down"`, `degraded`. The code follows the later delta.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Discord identity | Bot account via `DISCORD_TOKEN` | Self-bot / user account | Header comment: automating a user account gets it banned (`index.ts:11-13`). |
| Missing token / source off | Stay up idle, report `degraded` (or `off`), never exit | Exit non-zero like login failure | `earsPlan` doc comment: "never exits for a configuration gap" (`health.ts:8`); commit 51d5a9c; add-isolated-backends design D7 (no token idles `degraded` rather than `exit(1)`). |
| Login failure | `process.exit(1)` | Retry with backoff | add-isolated-backends design D7: "Login failure with a token present keeps current exit(1) behavior (real error, supervisor should see it)" (`discord.ts:121`). |
| One bus loop for `voice.utterance` and `inject.request` | Single `subscribe` with both types | Two loops, one per type | Comment at `discord.ts:111`: two loops with different type filters would drop each other's events. Confirmed by `Bus.subscribe`, which XACKs every entry it reads, including ones its type filter skips (`packages/bus/src/index.ts:159`). |
| Library loading | Dynamic import of `discord.js` only in the `discord` plan | Static import | Comment: "only loaded when a session will actually be opened" (`index.ts:35`). |
| Utterance boundary | Discord `AfterSilence` end behavior with `ears.silence_ms` | Own VAD / fixed windows | `[inferred]` simplest use of the Discord receiver API (`discord.ts:47`). |
| Per-speaker streams | One Opus subscription and one STT call per speaker per utterance | Mixed channel audio | Header comment: "so the brain knows who said what" (`index.ts:4-6`). |
| Resampling | Hand-written 3:1 averaging decimation down, linear interpolation up | Library resampler, ffmpeg | `[inferred]` zero extra dependencies; tests show a 200 Hz tone survives (`audio.test.ts:85-95`). |
| STT language | Hard-coded `en` | `ears` config key | `[inferred]` no config key exists (`hearing.ts:25`). |
| Playback format | Convert WAV to 48 kHz stereo s16le and feed as `StreamType.Raw` | Opus-encode / ffmpeg | `[inferred]` Discord expects 48k stereo; avoids an encoder pipeline (`audio.ts:21`, `discord.ts:35`). |
| Failed playback | Skip silently with no `voice.done` | Report done/error | Deliberate per the test assertion message "the skipped line never played, so no done for it" (`ears.test.ts:51`). Reliance on voice's 1.5 s virtual sink to time the line is `[inferred]`; see EARS-PLAY-006. |
| Injection URL trust | Same origin as `urls.dashboard()`, under `/uploads/`, no redirects | Fetch any URL | SSRF guard: add-test-injection design D2 ("eyes/ears ... MUST only fetch URLs under `urls.dashboard()` + `/uploads/`"); doc comment on `dashboardUrl` (`inject.ts:11-12`). `redirect: "error"` (`inject.ts:64`) has no recorded rationale (`[inferred]`: a redirect would escape the origin check). |
| Stale injected requests | Drop after 60 s | Process all backlog | Consumer groups resume after a restart: comment at `inject.ts:5`; add-test-injection design D8 ("Staleness"). |
| Injected clips skip `min_speech_ms` | No minimum duration | Apply the gate | add-test-injection design D8: "`min_speech_ms` does not apply (that gates Discord PCM)"; doc comment `inject.ts:50`; test `inject.test.ts:36-43`. |

## Open Questions & Future Decisions

Behaviors and debt observed but not explained by the code or specs. Each needs an owner decision.

1. **Failed initial `join()` is unhandled and silently disables the bus subscription.** `join()` is awaited bare in the `ready` listener; any throw (wrong channel id, missing env, 20 s Ready timeout, guild fetch failure) is an unhandled rejection and `bus.subscribe` on the next line never runs (`discord.ts:108-113`). No `unhandledRejection` handler exists in the workspace, so Node terminates the process; under compose `restart: unless-stopped` that is a crash loop and the heartbeat never leaves `starting`. Neither the `degraded` heartbeat nor a clear error is produced. (EARS-SESS-006)
2. **Rejoin gives up after one failure.** After a disconnect that does not recover, `join()` is retried once after 5 s; if that fails it logs `"rejoin failed"` and never retries (`discord.ts:97`). Each rejoin also re-runs `heartbeat.ready()` and re-registers listeners on the new connection. (EARS-SESS-005)
3. **`inject.request` is not consumed until Discord is joined.** Contradicts `add-test-injection` ("MUST work ... when Discord is not connected") in the `discord` plan (`discord.ts:110-117`). Also, the awaited inject handler blocks the shared loop, delaying `voice.utterance` entries behind a slow STT call (`discord.ts:114`). (EARS-INJ-007)
4. **Playback failure sends no `voice.done`.** The OpenSpec scenario only says no `voice.playing`; the test pins no `voice.done` (`ears.test.ts:51`). Recovery depends entirely on voice's virtual sink. Related: `onIdle` publishes `voice.done` with `void`, so a bus error is an unhandled rejection (`playback.ts:35`). (EARS-PLAY-006)
5. **Guild and channel come from env, not config.** `ears.discord.guild_id` / `voice_channel_id` are in the schema and `config.example.yaml:150-151` (which fills them from the same env vars) but ears reads `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` directly with `env()` (`discord.ts:63-64`). Editing the YAML keys has no effect. The baseline OpenSpec also names the env vars. (EARS-SESS-007)
6. **`control` events (mute, pause) are ignored.** ears does not subscribe to `control`; a muted co-host still plays any `voice.utterance` that was already produced and still publishes `speech.heard`. Whether ears should stop listening when muted is not specified anywhere.
7. **No stuck-playback guard.** The queue is unbounded, `httpAudio` has no timeout, and `current` is only cleared by the player's Idle event or an exception (`playback.ts:14-18,39-52`). A hung fetch blocks the queue and every later utterance; a player that never reaches Idle (e.g. connection lost mid-clip) does the same. cortex has its own `speaking_timeout_ms` backstop but ears does not.
8. **Two shutdown handlers race.** `index.ts:39` and `discord.ts:122` each call `onShutdown`; both await the shared pre-shutdown hooks and end in `process.exit(0)` (`packages/bus/src/index.ts:230-246`). The bus-stop handler's hooks return at once (the heartbeat `stop()` is already running for the Discord handler), so it exits first: the voice connection and Discord client are not destroyed, and the `stopping` heartbeat publish races process exit. Found by reading, no test. (EARS-SESS-008)
9. **Transcript filter is ASCII-only.** `/^\W*$/` treats every non-ASCII letter as non-word, so a transcript consisting only of such characters is dropped (`hearing.ts:44`, `inject.ts:68`). STT is forced to `en`, which masks it.
10. **Duplicate WAV code.** `audio.ts:44-55` `readWavHeader` and `services/voice/src/wav.ts:12-34` `parseWav` are near-duplicates (the voice one validates RIFF/WAVE and reports bit depth; the ears one throws `bad wav` and ignores bit depth, so 8- or 24-bit input is misread silently). `inject.ts:36-37` re-adds the RIFF check on top. voice's stub also hand-builds a WAV header (`voice.ts:41-62`) beside ears' `wavWrap` (`audio.ts:57-64`). `voice/test/voice.test.ts:5` imports `../../ears/src/audio.js` just to build test WAVs. (Tracked in the voice LLD.)
11. **Untested glue.** `discord.ts` and `index.ts` have no tests: session lifecycle, capture, rejoin, plan wiring, shutdown. Only the injected-function classes are covered.
12. **Stale docs.** `docs/TESTING.md:119` says ears "exits immediately without DISCORD_TOKEN"; the code idles degraded (README.md:255 is correct).
13. **Dependencies of unclear role.** `@snazzah/davey`, `libsodium-wrappers` and `opusscript` are in `services/ears/package.json:16-20` but never imported from `src/`; `[inferred]` they satisfy `@discordjs/voice` runtime requirements (encryption / DAVE / Opus fallback).
14. **Hallucinated transcripts.** There is no filter for known Whisper silence hallucinations ("Thank you.") other than the empty/punctuation check.
15. **EARS-START-001 wording.** In the `off` plan ears still publishes injected `speech.heard` (EARS-INJ-009), so EARS-START-001 excludes only non-injected `speech.heard`. The OpenSpec "Off source" scenario said no `speech.heard` at all; owner to confirm that injected events are the intended exception.
16. **Untested `[x]` specs.** 14 of 38 `[x]` specs have no test, all in the untested glue (`discord.ts`, `index.ts`) plus EARS-INJ-003 (wrong kind). EARS-INJ-004's redirect refusal and non-2xx paths are untested in ears (eyes tests the 404 path for its copy). EARS-HLTH-003's recovery to `ok` after a success is not asserted.

## References

Files in this segment:

- `services/ears/src/index.ts`, `discord.ts`, `hearing.ts`, `playback.ts`, `audio.ts`, `inject.ts`, `health.ts`
- `services/ears/test/audio.test.ts`, `ears.test.ts`, `health.test.ts`, `inject.test.ts`
- `services/ears/package.json`, `services/ears/tsconfig.json`

Other segments (arrow shows direction):

- ears -> [event-bus](../event-bus/event-bus-design.md): publishes `speech.heard`, `voice.playing`, `voice.done`, `inject.result`, heartbeats; consumes `voice.utterance`, `inject.request` (group `ears`).
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
