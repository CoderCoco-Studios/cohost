# Arrow: voice

`brain.say` to audio: TTS (Kokoro or silent stub), WAV parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, fallback clips, obeying `voice.stop`, and the audio-sink arbitration protocol shared with mouth and dashboard.

## Status

**AUDITED**: 67 specs: 65 implemented, 0 gaps, 2 deferred (`VOICE-CHUNK-001`, `VOICE-CHUNK-002`, dynamic speech).

## Listening and speaking split

voice's arbitration protocol, events and clip routes serve [mouth](mouth.md): its outputs are the sinks (the Discord output keeps `sink: "discord"`) and it is the clip consumer. `services/voice/test/mouth-sync.test.ts` runs voice's manifest and routes against mouth's real clip sync.

## Spoken fallback line

Design: LLD § Sink Arbitration Protocol rule 8 and § Fallback Clips. voice reads `voice.failed` and releases cortex early when nothing plays; it generates the fallback clips from `voice.fallback.lines`, regenerating when a fingerprint of the phrases and voice settings changes, with an atomic manifest swap, and serves the set over HTTP for mouth to cache.

- `VOICE-SINK-010` to `013`: voice reads `voice.failed` and releases cortex early when nothing plays.
- `VOICE-CLIP-001` to `012`: `services/voice/src/clips.ts` (`ClipService`: fingerprint, startup check, background regeneration, atomic set swap, retry, cleanup) and the `/fallback/*` routes in `Voice.handle`. The stub engine builds no clip service, so it never touches the store and answers 404.
- Kokoro tuning knobs: `VOICE-SYN-009` and `CFG-SCH-029`, verified against Kokoro-FastAPI `v0.10.0`.

## Barge-in and echo gate

`VOICE-STOP-001` to `VOICE-STOP-008` obey `voice.stop`; `VOICE-CHUNK-001` and `VOICE-CHUNK-002` are `[D]` (dynamic speech). Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (67 specs: 65 `[x]`, 0 `[ ]`, 2 `[D]`; prefix `VOICE`)

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

Also in the segment: services/voice/test/contract.test.ts (no `@spec` annotation).

### Code
Files with `@spec VOICE-` annotations:
- services/voice/src/boot.ts
- services/voice/src/voice.ts
- services/voice/src/clips.ts
- services/voice/src/wav.ts
- services/voice/src/health.ts

Also: services/voice/src/index.ts, services/voice/package.json, services/voice/tsconfig.json. `parseWav` and `wavWrap` come from `@cohost/shared` (`packages/shared/src/audio.ts`).

## Architecture

**Purpose:** Convert the brain's lines into audio the body can play, and guarantee the brain is released whether or not any sink plays it.

**Key Components:**
1. `index.ts`: supplies the real setup (config, `Bus`, `VOICE_PORT` 8700, `urls.voice()`) to `runVoice`.
2. `boot.ts`: `runVoice`: heartbeat, HTTP server, consumer-group positioning, `ready`, one bus loop on `brain.say`, `voice.playing`, `voice.failed` and `voice.stop` (`latest`); a startup failure after the configuration loads, or a rejecting subscription, logs `fatal` and exits 1.
3. `voice.ts`: `Voice` class: internal synthesis queue, store (50 newest), `voice.utterance`, claimed set (pruned with the store), 1.5 s virtual sink with a cancellable virtual done, error release, stop handling, HTTP handler; plus `kokoroSynth` and `stubSynth`.
4. `clips.ts`: `ClipService`, the fallback clips.
5. `wav.ts`: the 30 Hz mouth envelope; `parseWav` comes from `@cohost/shared` (`packages/shared/src/audio.ts`, shared with ears and mouth), as does `wavWrap`, which `stubSynth` uses.
6. `health.ts`: `VoiceHealth` (`kokoro` dep, modes `live` / `mock`).
7. Consumers and peers of the protocol: mouth (`discord` sink and clip consumer), dashboard (`dashboard` sink, `/audio/*` proxy), cortex (released by `voice.done`), avatar (lip-sync on `voice.playing`).

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps | Test-annotated |
|----------|----------|-------------|----------|------|----------------|
| Synthesis | VOICE-SYN-001 to VOICE-SYN-009 | 9 | 0 | 0 | 9 |
| Stub engine | VOICE-STUB-001 to VOICE-STUB-003 | 3 | 0 | 0 | 3 |
| Utterance publication | VOICE-UTT-001 to VOICE-UTT-004 | 4 | 0 | 0 | 4 |
| WAV and lip-sync envelope | VOICE-ENV-003 to VOICE-ENV-005 | 3 | 0 | 0 | 3 |
| Sink arbitration | VOICE-SINK-001 to VOICE-SINK-013 | 13 | 0 | 0 | 13 |
| Stopping a line | VOICE-STOP-001 to VOICE-STOP-008 | 8 | 0 | 0 | 8 |
| Dynamic speech | VOICE-CHUNK-001 to VOICE-CHUNK-002 | 0 | 2 | 0 | 0 |
| Audio store and HTTP | VOICE-HTTP-001 to VOICE-HTTP-008 | 8 | 0 | 0 | 8 |
| Fallback clips | VOICE-CLIP-001 to VOICE-CLIP-012 | 12 | 0 | 0 | 12 |
| Health | VOICE-HLTH-001 to VOICE-HLTH-005 | 5 | 0 | 0 | 5 |

**Summary:** 65 of 67 specs implemented; 2 deferred; 0 gaps. 65 carry a test `@spec` annotation (every spec except the two deferred). `node scripts/lid-check.mjs` finds no reverse orphans.

## Key Findings

1. **`ready` needs a duplicate positioning call.** The bus has no "subscribed" notification, so boot calls `resetGroup` before `ready` and `subscribe` positions the group again. A hook in event-bus would remove the duplicate (cross-segment follow-up).
2. **WAV parser and writer are shared.** `parseWav` and `wavWrap` live in `@cohost/shared`; voice uses both (`stubSynth` calls `wavWrap`, SHARED-AUDIO-004), and ears' and mouth's `readWavHeader` adapt `parseWav`. Voice tests import `wavWrap` from `@cohost/shared`.
3. **Port 8700 is published on loopback only.** Compose sets `VOICE_URL=http://voice:8700` for the TS services and publishes `127.0.0.1:8700` for the host-run dashboard (DEPLOY-COMPOSE-007); `urls.voice()` defaults to loopback; browser and OBS sinks go through the dashboard proxy. VOICE-UTT-002 is authoritative for the `audioUrl` base.
4. **WAV handling is narrow.** Only 16-bit PCM, and the envelope reads the first channel only. Kokoro returns mono 16-bit, so nothing trips.

## Work Required

### Must Fix
None.

### Should Fix
1. Add an event-bus "subscribed" hook so `ready` does not need the duplicate `resetGroup` call (event-bus segment).

### Nice to Have
2. Handle stereo envelopes by mixing channels.
