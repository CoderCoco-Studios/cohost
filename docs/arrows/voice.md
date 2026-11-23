# Arrow: voice

`brain.say` to audio: TTS (Kokoro, any OpenAI-speech-route server, Kyutai Pocket TTS, or a silent stub) behind one engine contract, WAV reading and parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, fallback clips, obeying `voice.stop`, and the audio-sink arbitration protocol shared with mouth and dashboard.

## Status

**MAPPED**: 147 specs: 146 implemented, 0 gaps, 1 deferred (`VOICE-ENG-017`, Qwen3-TTS). The TTS engine contract, the `kokoro`, `openai`, `pocket` and `stub` adapters, the shared WAV reader, the first-byte and gap bounds, the concurrency gate, the error classes, the configuration gaps, the `tts` dependency with the Pocket probe, the engine fingerprint and the egress warning are implemented (#186). Clause-by-clause synthesis and streamed arbitration (`VOICE-CHUNK-*`, `VOICE-CLAUSE-*`, `VOICE-ENG-005`, epic #192, issue #195) are implemented. The status stays MAPPED until an audit pass compares the new arbitration and store code with the specs.

## Listening and speaking split

voice's arbitration protocol, events and clip routes serve [mouth](mouth.md): its outputs are the sinks (the Discord output keeps `sink: "discord"`) and it is the clip consumer. `services/voice/test/mouth-sync.test.ts` runs voice's manifest and routes against mouth's real clip sync.

## Spoken fallback line

Design: LLD § Sink Arbitration Protocol rule 8 and § Fallback Clips. voice reads `voice.failed` and releases cortex early when nothing plays; it generates the fallback clips from `voice.fallback.lines`, regenerating when a fingerprint of the phrases and voice settings changes, with an atomic manifest swap, and serves the set over HTTP for mouth to cache.

- `VOICE-SINK-010` to `013`: voice reads `voice.failed` and releases cortex early when nothing plays, per clause (`VOICE-SINK-011` to `012` with the line's virtual player).
- `VOICE-CLIP-001` to `016`: `services/voice/src/clips.ts` (`ClipService`: fingerprint, startup check, background regeneration, atomic set swap, retry, cleanup) and the `/fallback/*` routes in `Voice.handle`. The stub engine builds no clip service, so it never touches the store and answers 404.
- Kokoro tuning knobs: `VOICE-SYN-009` and `CFG-SCH-029`, verified against Kokoro-FastAPI `v0.10.0`.

## Barge-in and echo gate

`VOICE-STOP-001` to `VOICE-STOP-010` obey `voice.stop`, and `VOICE-CLAUSE-024` to `026` extend it to streamed lines (the spoken/unsaid split). Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## Clause-by-clause synthesis

Design: LLD § Lines and clauses, Sink Arbitration Protocol. `VOICE-CHUNK-001` and `002`, `VOICE-CLAUSE-001` to `026`, `VOICE-SYN-001`, `004`, `008`, `VOICE-UTT-001` to `003`, `VOICE-HTTP-001` to `003`, `007`, `008`, `VOICE-ENG-005`.

- `brain.say` with `more` opens a line record (newest 50); `brain.clause` joins the same FIFO queue as `brain.say` and is synthesized clause by clause, one engine request each (`services/voice/src/voice.ts`, `Voice.say`, `Voice.read`, `Voice.synthesize`).
- Each clause is stored under `<id>-<seq>` (newest 100 clauses) and announced with its own `voice.utterance`; `more` and `gesture` ride clause 0 only; `audioUrl` is `<urls.voice()>/audio/<id>-<seq>.wav`.
- The claim window opens with clause 0 only; the virtual player then plays published clauses in order, one `voice.playing` and `voice.done` each, with the same `seq`. A real claim on a streamed line ends the virtual player with an interrupted done for the clause playing, or for the last one played between clauses.
- A clause that fails ends the line with `voice.done` `sink: error` `final: true`; earlier clauses keep playing. A `voice.failed` for a streamed line releases it with a `final` done (`VOICE-SINK-011`, `012`).
- `voice.stop` drops queued and in-flight clauses, and publishes one interrupted virtual done with `spokenText` and `unsaidText` when a virtual clause is playing or open between clauses (`VOICE-STOP-006`, `010`, `VOICE-CLAUSE-026`).
- A line with no clause activity for 300 s ends at the next sweep (`VOICE-CLAUSE-012`); the sweep is an unref'd interval armed while lines exist and cleared on stop.
- Evicted line records still synthesize their queued clauses but arm no timers, so the store bound never strands a clause.
- Not covered here: producing the clauses (`#196`) and the real sinks that play them (`#198`, `#199`).



## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (147 specs: 146 `[x]`, 0 `[ ]`, 1 `[D]`; prefix `VOICE`)

### Tests
Files with `@spec VOICE-` annotations:
- services/voice/test/voice.test.ts
- services/voice/test/clauses.test.ts
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
2. `boot.ts`: `runVoice`: heartbeat, HTTP server, consumer-group positioning, `ready`, one bus loop on `brain.say`, `brain.clause`, `voice.playing`, `voice.failed` and `voice.stop` (`latest`); a startup failure after the configuration loads, or a rejecting subscription, logs `fatal` and exits 1.
3. `voice.ts`: `Voice` class: internal synthesis queue (one clause at a time), store (100 newest clauses under `<id>-<seq>`), `voice.utterance` per clause, line records (50 newest), claimed keys (pruned with the store), the per-line 1.5 s claim window and virtual player, error release, stop handling, the 300 s sweep and the HTTP handler; it takes a `Synth` and aborts nothing on `voice.stop` (only at shutdown).
4. `clips.ts`: `ClipService`, the fallback clips.
5. `wav.ts`: the 30 Hz mouth envelope; `parseWav` comes from `@cohost/shared` (`packages/shared/src/audio.ts`, shared with ears and mouth), as does `wavWrap`, which `collect` uses.
   - `engine.ts`: the `TtsEngine` contract, `TtsAudio`, `Synth`, `TtsError`, `classifyFailure` (line or outage), `collect` (whole audio as a WAV, zero frames rejected) and `TtsGate` (the shared concurrency gate, lines before clip phrases).
   - `engines.ts`: `createEngine(cfg.voice)` for `kokoro`, `openai`, `pocket` and `stub`; each request is bounded by `voice.timeout_ms` and holds its gate place until the response ends or its connection closes. Incomplete configuration gives a gap engine.
   - `wav-reader.ts`: `readWavStream`, the streaming WAV reader the HTTP adapters share.
6. `health.ts`: `VoiceHealth(engine)`: dependency `tts` (modes `live` / `mock`, `n/a` for stub); `track` classifies each synthesis outcome; a Pocket-style probe (`ping`, bounded by `voice.timeout_ms`) starts it down and runs every 10 s while down. Once `bind`-ed to the heartbeat, the state is `ready` while `tts` is ok and `degraded` with the engine, host and reason (`VOICE-HLTH-001` to `010`).
7. Consumers and peers of the protocol: mouth (`discord` sink and clip consumer), dashboard (`dashboard` sink, `/audio/*` proxy), cortex (released by `voice.done`), avatar (lip-sync on `voice.playing`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Synthesis | VOICE-SYN-001 to VOICE-SYN-009 | 9 | 0 | 0 | 9 |
| Stub engine | VOICE-STUB-001 to VOICE-STUB-003 | 3 | 0 | 0 | 3 |
| Utterance publication | VOICE-UTT-001 to VOICE-UTT-004 | 4 | 0 | 0 | 4 |
| WAV and lip-sync envelope | VOICE-ENV-003 to VOICE-ENV-005 | 3 | 0 | 0 | 3 |
| Sink arbitration | VOICE-SINK-001 to VOICE-SINK-013 | 13 | 0 | 0 | 13 |
| Stopping a line | VOICE-STOP-001 to VOICE-STOP-010 | 10 | 0 | 0 | 10 |
| Clause-chunked synthesis | VOICE-CHUNK-001 to VOICE-CHUNK-002 | 2 | 0 | 0 | 2 |
| Audio store and HTTP | VOICE-HTTP-001 to VOICE-HTTP-008 | 8 | 0 | 0 | 8 |
| Fallback clips | VOICE-CLIP-001 to VOICE-CLIP-016 | 16 | 0 | 0 | 16 |
| Health | VOICE-HLTH-001 to VOICE-HLTH-010 | 10 | 0 | 0 | 10 |
| TTS engine contract | VOICE-ENG-001 to VOICE-ENG-017 | 16 | 1 | 0 | 16 |
| Shared WAV reader | VOICE-WAV-001 to VOICE-WAV-008 | 8 | 0 | 0 | 8 |
| Engines | VOICE-KOK-001, VOICE-OAI-001 to VOICE-OAI-003, VOICE-POC-001 to VOICE-POC-006 | 10 | 0 | 0 | 10 |
| Errors and configuration gaps | VOICE-ERR-001 to VOICE-ERR-003, VOICE-GAP-001 to VOICE-GAP-005 | 8 | 0 | 0 | 8 |
| Egress | VOICE-EGR-001, VOICE-EGR-002 | 2 | 0 | 0 | 2 |
| Clause and streamed speech | VOICE-CLAUSE-001 to VOICE-CLAUSE-026 (no 022, 023) | 24 | 0 | 0 | 24 |

**Summary:** 147 specs: 146 implemented, 0 gaps, 1 deferred (`VOICE-ENG-017`). Test-annotated counts the spec IDs carrying a `@spec` annotation in `services/voice/test/`; `VOICE-ENG-017` has none because it is deferred.

## Key Findings

1. **`ready` needs a duplicate positioning call.** The bus has no "subscribed" notification, so boot calls `resetGroup` before `ready` and `subscribe` positions the group again. A hook in event-bus would remove the duplicate (cross-segment follow-up).
2. **WAV parser and writer are shared.** `parseWav` and `wavWrap` live in `@cohost/shared`; voice uses both (`collect` in `engine.ts` wraps an engine's PCM with `wavWrap`, SHARED-AUDIO-004, and `parseWav` checks the assembled WAV), and ears' and mouth's `readWavHeader` adapt `parseWav`. Voice's own streaming reader (`wav-reader.ts`) is the one the adapters share.
3. **Port 8700 is published on loopback only.** Compose sets `VOICE_URL=http://voice:8700` for the TS services and publishes `127.0.0.1:8700` for the host-run dashboard (DEPLOY-COMPOSE-007); `urls.voice()` defaults to loopback; browser and OBS sinks go through the dashboard proxy. VOICE-UTT-002 is authoritative for the `audioUrl` base.
4. **WAV handling is narrow.** Only 16-bit mono PCM at 8000 to 48000 Hz reaches the pipeline; the shared reader names every other format (`VOICE-WAV-*`), and the envelope reads the first channel only.
5. **Heartbeat detail while down.** voice publishes `degraded` with the engine, host and reason through the existing `heartbeat.degraded(detail)` call, the same pattern connector-discord uses. No shared code changed.

## Work Required

### Must Fix
1. Audit pass: compare the arbitration, store and HTTP code with the spec file (the status is MAPPED).

### Should Fix
1. Add an event-bus "subscribed" hook so `ready` does not need the duplicate `resetGroup` call (event-bus segment).

### Nice to Have
2. Handle stereo envelopes by mixing channels.
