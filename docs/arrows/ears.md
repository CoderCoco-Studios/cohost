# Arrow: ears

The listening half of the co-host: it consumes connector audio sources (`discord`, `desktop` and any other tag a connector registers), the account-free `http` and `dir` capture sources and audio-upload injection, transcribes each utterance and publishes `speech.heard`. ears holds no Discord client or token and plays nothing; Discord audio in and out is the [connections](connections.md) segment, speaking is [mouth](mouth.md).

## Status

**PARTIAL**, 2026-11-23: the STT engine contract is built (`services/ears/src/engines.ts`, `stt.ts`, `health.ts`): batch engines `speaches`, `openai` and `stub`, engine selection and the batch fallback, streaming sessions with the batch fallback, streamed partials and the engine-aware `deps.stt` (EARS-ENG-001 to 012, EARS-SES-001 to 013, EARS-HLTH-003 to 012). The Nemotron and Kyutai adapters are built (`services/ears/src/nemotron.ts`, `kyutai.ts`; wired by `buildEngines`), with the Kyutai end of turn closing an utterance in `connector-source.ts` (EARS-NEM-001 to 007, EARS-KYU-001 to 014 `[x]`, tested against local fake servers; the live run against `stt-nemotron` and `stt-kyutai` is manual, #190). The spec file holds 195 specs: 161 `[x]`, 32 `[ ]`, 2 `[D]`. The echo gate (EARS-ECHO-001 to 009) is implemented, with each streamed clause its own entry. The open specs are the early-reply specs, EARS-HEAR-012, EARS-PART-009 and the desktop helper gaps. EARS-SES-003 is `[ ]` and skipped: its buffered-start acknowledgement is not observable through `SttSession.push`. The desktop capture helper is built in `crates/cohost-desktop-audio`: clip cutting, delivery and retry, token, usage exits and CI are tested (EARS-SRC-015, 017, 020, 021, 023). Its capture back ends (PulseAudio monitor, WASAPI loopback), default-device reopen and stop path are compiled but not verified on hardware (EARS-SRC-014, 018, 019, 022). Earlier: `ears.http.token` is read from `secrets.yaml` and ears uses no Discord token (EARS-SRC-013, EARS-CON-002).

**AUDITED**, 2026-11-12: 93 specs, 89 implemented (`[x]`), 2 gaps (`[ ]`: the desktop capture helper, EARS-SRC-014 and 015, with CONN-DESK-001), 2 deferred (`[D]`: EARS-PART-015, EARS-SRC-016, the helper writing frames to `audio.in.desktop`, CONN-DESK-002). Open work is the helper alone. The docs site's extension guides added EARS-EX-001 to EARS-EX-007 (the example audio clients, the `curl` script and the conversion scripts), implemented and tested (the `ffmpeg` converter's test skips where `ffmpeg` is absent), not yet audited; the spec file now holds 100 specs (96 `[x]`, 2 `[ ]`, 2 `[D]`).

## Design

LLD: [ears-design.md](../intent/ears/ears-design.md) (Startup plans, Capture sources, Multiple sources, Connector sources, Decisions). Decision records: [listen-speak-split](../intent/ears/decisions/listen-speak-split.md), [connector-protocol](../intent/connections/decisions/connector-protocol.md).

- `ears.sources` is a list (default `[discord]`; empty is `off`), every entry started concurrently as its own `CaptureAdapter` with its own `deps.<source>` health (EARS-SRC-001 to 008, CFG-SCH-030). the isolation override `EARS_SOURCES` replaces it by key path (a flow-syntax value such as `[http, dir]` or `[]`, CFG-ISO-007).
- A connector source consumes `audio.in.<source>` frames and cuts utterances with the endpointing engine `ears.vad.engine` names, `silero` (default) or the `ears.silence_ms` frame gap (EARS-CON-001 to 005, EARS-VAD-001 to 008); ears reads no Discord token and never loads `discord.js` (EARS-CON-002).
- `http` takes POSTed 16-bit PCM or WAV, `dir` takes WAV files dropped in a polled directory, both bounded by the shared inject limits and both working with `ears.stt_engine: stub` (EARS-CAP-*). A container serving `http` needs `ears.http.host: 0.0.0.0` and a published port, left to the operator.
- The `desktop` source is a connector whose clips arrive over the `http` listener until the capture helper writes frames (EARS-SRC-009 to 023, CONN-DESK-*).
- Injection (`inject.request`, kind `audio`) works in every plan (EARS-INJ-*, SHARED-INJ-*).
- STT engines: batch (`speaches`, `openai`, `stub`) and streaming (`nemotron`, `kyutai`) behind one contract; one session per open utterance; echo-suppressed sources, `http`, `dir` and injection never use a session; a session that cannot serve falls back to the batch engine `ears.stt_fallback_engine` (EARS-ENG-*, EARS-SES-*, EARS-NEM-*, EARS-KYU-*, EARS-HLTH-004 to 011).

## Barge-in and echo gate

EARS-ECHO-001 to EARS-ECHO-009 are the echo gate for `ears.echo_suppress_sources`; EARS-INJ-012 stamps `meta.source` on an injected clip's `speech.heard`. Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (195 specs: 161 `[x]`, 32 `[ ]`, 2 `[D]`; the gaps are the early-reply specs (EARS-EARLY-001 to 026, with EARS-PART-009 and EARS-HEAR-012 revised and opened) and the desktop helper's hardware-only parts, EARS-SRC-014, 018, 019 and 022; the Silero loader runs `onnxruntime-node` over the Silero VAD v5.1.2 model committed under `services/ears/models/`, pinned by `services/ears/test/silero.test.ts`)

### Spec Coverage

| IDs | Topic | Specs | Markers |
| --- | --- | --- | --- |
| EARS-START-001 to 008 | startup plans, consumer group | 6 | 6 `[x]` |
| EARS-HEAR-001 to 012 | listening and transcription, audio-end stamp | 11 | 10 `[x]`, 1 `[ ]` (HEAR-012) |
| EARS-VAD-001 to 008 | endpointing | 8 | 8 `[x]` |
| EARS-PART-001 to 022 | partial transcripts | 22 | 20 `[x]`, 1 `[ ]`, 1 `[D]` |
| EARS-CAP-001 to 012 | capture sources (`http`, `dir`) | 12 | 12 `[x]` |
| EARS-SRC-001 to 016 | multiple sources, desktop source | 15 | 13 `[x]`, 1 `[ ]`, 1 `[D]` |
| EARS-SRC-017 to 023 | desktop helper: clip cutting, delivery, token, CI | 7 | 4 `[x]`, 3 `[ ]` |
| EARS-CON-001 to 005 | connector sources | 5 | 5 `[x]` |
| EARS-ECHO-001 to 009 | echo gate | 9 | 9 `[x]` |
| EARS-INJ-005 to 012 | audio injection | 7 | 7 `[x]` |
| EARS-STUB-001 to 002 | stub transcriber | 2 | 2 `[x]` |
| EARS-HLTH-001 to 012 | health | 12 | 12 `[x]` |
| EARS-ENG-001 to 012 | STT engines, batch engine, fallback, timeouts, gaps | 12 | 12 `[x]` |
| EARS-SES-001 to 013 | streaming session | 13 | 13 `[x]` |
| EARS-NEM-001 to 007 | Nemotron engine | 7 | 7 `[x]` |
| EARS-KYU-001 to 014 | Kyutai engine, end of turn | 14 | 14 `[x]` |

### Tests
- crates/cohost-desktop-audio/tests/*.rs (`cli`, `clip_cutter`, `deliver`, `lifecycle`, `pcm_convert`, `post_clip`, `registration`, `select_source`, `ci`)
- services/ears/test/*.test.ts (`audio`, `ears`, `filter`, `transcript`, `stub`, `loop`, `service`, `session`, `health`, `inject`, `inject-limits`, `capture`, `capture-http`, `capture-dir`, `connector-source`, `endpointing`, `partials`, `echo`, `timing`, `silero`, `no-discord`, `engines`, `sessions`, `nemotron`, `kyutai`)
- packages/config/test/config-ears-sources.test.ts
- packages/bus/test/bus.test.ts

### Code
- crates/cohost-desktop-audio/src/{clip,pcm,post,retry,registration,cli,deliver,source,lifecycle}.rs (the desktop helper's pure core)
- services/ears/src/{index,service,sources,session,health,hearing,transcript,audio,inject}.ts
- services/ears/src/{capture,capture-http,capture-dir,connector-source,vad,echo}.ts
- services/ears/src/{engines,stt}.ts (the engine contract and selection; the router that owns batch calls, sessions, slots and the probe)
- services/ears/src/{nemotron,kyutai}.ts (the streaming adapters: NeMo-Speech.cpp WebSocket and moshi-server MessagePack)
- packages/config/src/schema.ts

## Architecture

**Purpose:** Turn every enabled audio source into `speech.heard` and transcribe uploaded audio on request. It plays nothing, never reads `control`, and reads `voice.playing` and `voice.done` only for the echo gate.

**Key Components:**
1. `index.ts` / `service.ts`: start through `runService`, choose the startup plan with `earsPlan`, wire the heartbeat and inject handler, register the one shutdown.
2. `sources.ts`, `capture.ts`: resolve `ears.sources` into adapters; `capture-http.ts`, `capture-dir.ts` and `connector-source.ts` are the adapters.
3. `session.ts`: the `ears` bus loop (`inject.request`, plus `voice.playing` and `voice.done` for the echo gate), group creation with start mode `latest`, the single shutdown sequence.
4. `hearing.ts`: resampling of any clip rate to 16 kHz mono, min-length gate, the whole-clip batch call through the router, the word and drop-phrase checks, `speech.heard` publish with the clip's `source`. A streamed utterance's final enters here by `heardText`.
4a. `engines.ts`, `stt.ts`: the engine contract and selection (`buildEngines`), the batch engines, and the router that owns every batch call, session open and final, the session slots of `ears.max_stt_sessions` and the readiness probe. `connector-source.ts` runs each utterance's session (buffered start, close, abort, batch fallback) and its streamed partials.
5. `vad.ts`, `echo.ts`: the Silero endpointing detector and the echo gate.
6. `audio.ts`, `inject.ts`, `health.ts`, `transcript.ts`: WAV header reading, the inject handler, the plan and heartbeat, `ears.drop_phrases`.

## Key Findings

1. A source with no connector, or a `dir` source with no path, is `down` and logged while the others keep running; with no runnable source ears idles through the shared idle plan and still handles injection (EARS-SRC-005, EARS-SRC-008).
2. Bot accounts are never transcribed and her own lines never become `speech.heard`: the connector filters them (CONN-DISC-007).
3. `mute` / `pause` are ignored by ears by design; cortex and salience enforce them (EARS-HEAR-009).
4. The WAV parser and writer are shared with voice (`packages/shared/src/audio.ts`: `parseWav`, `wavWrap`; test `packages/shared/test/wav.test.ts`; SHARED-AUDIO-004).

## Work Required

### Must Fix
None.

### Drift
None.

### Should Fix
- Audit the example audio clients (EARS-EX-001..007), cited by the docs site's Extend pages.
The desktop capture helper's capture back ends (libpulse, WASAPI loopback) are compiled but not run on hardware, so EARS-SRC-014, 018, 019 and 022 stay open until the checks in #239; EARS-SRC-016 follows when the helper writes frames.
