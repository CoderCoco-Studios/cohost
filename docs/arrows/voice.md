# Arrow: voice

`brain.say` to audio: TTS (Kokoro, any OpenAI-speech-route server, Kyutai Pocket TTS, or a silent stub) behind one engine contract, WAV reading and parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, fallback clips, obeying `voice.stop`, and the audio-sink arbitration protocol shared with mouth and dashboard.

## Status

**PARTIAL**: 147 specs: 96 implemented, 50 gaps, 1 deferred (`VOICE-ENG-017`, Qwen3-TTS). The TTS engine contract, the `kokoro`, `openai`, `pocket` and `stub` adapters, the shared WAV reader, the first-byte and gap bounds, the concurrency gate, the error classes, the configuration gaps, the `tts` dependency with the Pocket probe, the engine fingerprint and the egress warning are implemented (#186). Open: clause-chunked and streamed speech (`VOICE-CHUNK-*`, `VOICE-CLAUSE-*`, `VOICE-ENG-005`: epic #192) and the sink, stop, store and utterance gaps in Spec Coverage.

## Listening and speaking split

voice's arbitration protocol, events and clip routes serve [mouth](mouth.md): its outputs are the sinks (the Discord output keeps `sink: "discord"`) and it is the clip consumer. `services/voice/test/mouth-sync.test.ts` runs voice's manifest and routes against mouth's real clip sync.

## Spoken fallback line

Design: LLD § Sink Arbitration Protocol rule 8 and § Fallback Clips. voice reads `voice.failed` and releases cortex early when nothing plays; it generates the fallback clips from `voice.fallback.lines`, regenerating when a fingerprint of the phrases and voice settings changes, with an atomic manifest swap, and serves the set over HTTP for mouth to cache.

- `VOICE-SINK-010` to `013`: voice reads `voice.failed` and releases cortex early when nothing plays.
- `VOICE-CLIP-001` to `016`: `services/voice/src/clips.ts` (`ClipService`: fingerprint, startup check, background regeneration, atomic set swap, retry, cleanup) and the `/fallback/*` routes in `Voice.handle`. The stub engine builds no clip service, so it never touches the store and answers 404.
- Kokoro tuning knobs: `VOICE-SYN-009` and `CFG-SCH-029`, verified against Kokoro-FastAPI `v0.10.0`.

## Barge-in and echo gate

`VOICE-STOP-001` to `VOICE-STOP-010` obey `voice.stop`; `VOICE-CHUNK-001` and `VOICE-CHUNK-002` are `[D]` (clause-chunked synthesis and streaming input). Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (147 specs: 96 `[x]`, 50 `[ ]`, 1 `[D]`; prefix `VOICE`)

### Tests
Files with `@spec VOICE-` annotations:
- services/voice/test/voice.test.ts
- services/voice/test/queue.test.ts
- services/voice/test/stop.test.ts
- services/voice/test/boot.test.ts
- services/voice/test/clips.test.ts
- services/voice/test/mouth-sync.test.ts
- services/voice/test/kokoro-request.test.ts
- services/voice/test/stub.test.ts
- services/voice/test/wav.test.ts
- services/voice/test/health.test.ts
- services/voice/test/engine.test.ts
- services/voice/test/engines.test.ts
- services/voice/test/wav-reader.test.ts
- services/voice/test/voice-engine.test.ts
- services/voice/test/health-engine.test.ts
- services/voice/test/clips-engine.test.ts
- services/voice/test/boot-engine.test.ts

Also in the segment: services/voice/test/contract.test.ts (no `@spec` annotation).

### Code
Files with `@spec VOICE-` annotations:
- services/voice/src/boot.ts
- services/voice/src/voice.ts
- services/voice/src/clips.ts
- services/voice/src/wav.ts
- services/voice/src/health.ts
- services/voice/src/engine.ts
- services/voice/src/engines.ts
- services/voice/src/wav-reader.ts

Also: services/voice/src/index.ts, services/voice/package.json, services/voice/tsconfig.json. `parseWav` and `wavWrap` come from `@cohost/shared` (`packages/shared/src/audio.ts`).

## Architecture

**Purpose:** Convert the brain's lines into audio the body can play, and guarantee the brain is released whether or not any sink plays it.

**Key Components:**
1. `index.ts`: supplies the real setup (config, `Bus`, `VOICE_PORT` 8700, `urls.voice()`) to `runVoice`.
2. `boot.ts`: `runVoice`: heartbeat, HTTP server, consumer-group positioning, `ready`, one bus loop on `brain.say`, `voice.playing`, `voice.failed` and `voice.stop` (`latest`); a startup failure after the configuration loads, or a rejecting subscription, logs `fatal` and exits 1.
3. `voice.ts`: `Voice` class: internal synthesis queue, store (50 newest), `voice.utterance`, claimed set (pruned with the store), 1.5 s virtual sink with a cancellable virtual done, error release, stop handling, HTTP handler; HTTP handler; it takes a `Synth` and aborts nothing on `voice.stop` (only at shutdown).
4. `clips.ts`: `ClipService`, the fallback clips.
5. `wav.ts`: the 30 Hz mouth envelope; `parseWav` comes from `@cohost/shared` (`packages/shared/src/audio.ts`, shared with ears and mouth), as does `wavWrap`, which `collect` uses.
   - `engine.ts`: the `TtsEngine` contract, `TtsAudio`, `Synth`, `TtsError`, `classifyFailure` (line or outage), `collect` (whole audio as a WAV, zero frames rejected) and `TtsGate` (the shared concurrency gate, lines before clip phrases).
   - `engines.ts`: `createEngine(cfg.voice)` for `kokoro`, `openai`, `pocket` and `stub`; each request is bounded by `voice.timeout_ms` and holds its gate place until the response ends or its connection closes. Incomplete configuration gives a gap engine.
   - `wav-reader.ts`: `readWavStream`, the streaming WAV reader the HTTP adapters share.
6. `health.ts`: `VoiceHealth(engine)`: dependency `tts` (modes `live` / `mock`, `n/a` for stub); `track` classifies each synthesis outcome; a Pocket-style probe (`ping`) starts it down and runs every 10 s while down; the heartbeat `reason` names an incomplete configuration (`VOICE-HLTH-001` to `010`).
7. Consumers and peers of the protocol: mouth (`discord` sink and clip consumer), dashboard (`dashboard` sink, `/audio/*` proxy), cortex (released by `voice.done`), avatar (lip-sync on `voice.playing`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Synthesis | VOICE-SYN-001 to VOICE-SYN-009 | 6 | 0 | 3 | 9 |
| Stub engine | VOICE-STUB-001 to VOICE-STUB-003 | 3 | 0 | 0 | 3 |
| Utterance publication | VOICE-UTT-001 to VOICE-UTT-004 | 1 | 0 | 3 | 4 |
| WAV and lip-sync envelope | VOICE-ENV-003 to VOICE-ENV-005 | 3 | 0 | 0 | 3 |
| Sink arbitration | VOICE-SINK-001 to VOICE-SINK-013 | 3 | 0 | 10 | 13 |
| Stopping a line | VOICE-STOP-001 to VOICE-STOP-010 | 8 | 0 | 2 | 10 |
| Clause-chunked synthesis | VOICE-CHUNK-001 to VOICE-CHUNK-002 | 0 | 0 | 2 | 0 |
| Audio store and HTTP | VOICE-HTTP-001 to VOICE-HTTP-008 | 3 | 0 | 5 | 8 |
| Fallback clips | VOICE-CLIP-001 to VOICE-CLIP-016 | 16 | 0 | 0 | 16 |
| Health | VOICE-HLTH-001 to VOICE-HLTH-010 | 10 | 0 | 0 | 10 |
| TTS engine contract | VOICE-ENG-001 to VOICE-ENG-017 | 15 | 1 | 1 | 15 |
| Shared WAV reader | VOICE-WAV-001 to VOICE-WAV-008 | 8 | 0 | 0 | 8 |
| Engines | VOICE-KOK-001, VOICE-OAI-001 to VOICE-OAI-003, VOICE-POC-001 to VOICE-POC-006 | 10 | 0 | 0 | 10 |
| Errors and configuration gaps | VOICE-ERR-001 to VOICE-ERR-003, VOICE-GAP-001 to VOICE-GAP-005 | 8 | 0 | 0 | 8 |
| Egress | VOICE-EGR-001, VOICE-EGR-002 | 2 | 0 | 0 | 2 |
| Clause and streamed speech | VOICE-CLAUSE-* | 0 | 0 | 24 | 0 |

**Summary:** 147 specs: 96 implemented, 50 gaps, 1 deferred. The gaps are the clause-chunked and streamed-speech specs (`VOICE-CHUNK-*`, `VOICE-CLAUSE-*`, `VOICE-ENG-005`) and the sink, stop, store and utterance specs listed above.

## Key Findings

1. **`ready` needs a duplicate positioning call.** The bus has no "subscribed" notification, so boot calls `resetGroup` before `ready` and `subscribe` positions the group again. A hook in event-bus would remove the duplicate (cross-segment follow-up).
2. **WAV parser and writer are shared.** `parseWav` and `wavWrap` live in `@cohost/shared`; voice uses both (`collect` in `engine.ts` wraps an engine's PCM with `wavWrap`, SHARED-AUDIO-004, and `parseWav` checks the assembled WAV), and ears' and mouth's `readWavHeader` adapt `parseWav`. Voice's own streaming reader (`wav-reader.ts`) is the one the adapters share.
3. **Port 8700 is published on loopback only.** Compose sets `VOICE_URL=http://voice:8700` for the TS services and publishes `127.0.0.1:8700` for the host-run dashboard (DEPLOY-COMPOSE-007); `urls.voice()` defaults to loopback; browser and OBS sinks go through the dashboard proxy. VOICE-UTT-002 is authoritative for the `audioUrl` base.
4. **WAV handling is narrow.** Only 16-bit mono PCM at 8000 to 48000 Hz reaches the pipeline; the shared reader names every other format (`VOICE-WAV-*`), and the envelope reads the first channel only.
5. **Shared heartbeat hook.** `startHeartbeat` (`packages/shared/src/lifecycle.ts`) gained an optional `reason` getter, read only while a dependency is down. Without it the heartbeat reports the generic `dependency down` note, so an incomplete voice configuration (`VOICE-GAP-003`) could not name its reason. No other service sets it.

## Work Required

### Must Fix
1. Clause-chunked and streamed speech (`VOICE-CHUNK-001`, `-002`, `VOICE-CLAUSE-*`) and `VOICE-ENG-005` (a connection ending before the audio does): epic #192.

### Should Fix
1. Add an event-bus "subscribed" hook so `ready` does not need the duplicate `resetGroup` call (event-bus segment).

### Nice to Have
2. Handle stereo envelopes by mixing channels.
