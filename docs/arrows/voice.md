# Arrow: voice

`brain.say` to audio: TTS (Kokoro or silent stub), WAV parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, and the audio-sink arbitration protocol shared with ears and dashboard.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 34 specs: 34 implemented, 0 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes have landed.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B1** Late real sink → a real sink's `voice.playing` after the virtual one cancels the pending virtual `voice.done` (voice-only change). Specs: VOICE-SINK-008 rewritten; VOICE-SINK-004 unchanged.
2. **P8** Restart replay → start mode `latest`: the `voice` group moves to the newest entry on every start; no backlog is spoken. Specs: VOICE-SYN-001.
3. **R1** Bus failures → virtual-sink publish failures are logged and voice continues; a subscription rejection that survives the bus retry is logged `fatal` and exits non-zero. Specs: VOICE-SINK-009, VOICE-SYN-006 (new).
4. **S44** VOICE-SINK-005 → keep; add a test that re-uses an id. Specs: unchanged.
5. **S45** Store-before-publish → add a test. Specs: VOICE-SYN-004 unchanged.
6. **P7** Mute awareness → voice speaks every `brain.say` and never subscribes to `control`; mute and pause belong to cortex and salience. Specs: VOICE-SYN-005 reworded.
7. **S46** Same line on two sinks → accepted; LLD note and Decisions row.
8. **P4** Host-side sinks → not supported except through the dashboard `/audio/*` proxy; 8700 stays unpublished; the loopback `urls.voice()` default stays. LLD Decisions row.
9. **R3** `ready` timing and setup → all setup runs inside `runVoice`, so every startup failure logs `fatal`; `ready` is reported only after the HTTP server listens and the consumer group is positioned. Specs: VOICE-HLTH-001 reworded, VOICE-SYN-006 widened to startup failures.

## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (34 specs: 34 `[x]`, 0 `[ ]`, 0 `[D]`; prefix `VOICE`)

### Tests
- services/voice/test/voice.test.ts (pipeline, virtual sink, late claims, claim pruning, publish failures, HTTP, store, Kokoro client)
- services/voice/test/boot.test.ts (boot wiring: subscription options, readiness, fatal paths, shutdown)
- services/voice/test/stub.test.ts
- services/voice/test/wav.test.ts
- services/voice/test/health.test.ts

38 `@spec` annotations in tests, citing all 34 spec IDs.

### Code
- services/voice/src/index.ts
- services/voice/src/boot.ts
- services/voice/src/voice.ts
- services/voice/src/wav.ts
- services/voice/src/health.ts
- services/voice/package.json, services/voice/tsconfig.json

26 `@spec` annotations in code, citing all 34 spec IDs. No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/voice/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/voice/spec.md (rationale for keeping `/health`: `.../add-service-health/design.md` D5)
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/voice/spec.md (rationale for the stub: `.../add-isolated-backends/design.md` D5)

## Architecture

**Purpose:** Convert the brain's lines into audio the body can play, and guarantee the brain is released whether or not any sink plays it.

**Key Components:**
1. `index.ts` — supplies the real setup (config, `Bus`, `VOICE_PORT` 8700, `urls.voice()`) to `runVoice`.
2. `boot.ts` — `runVoice`: heartbeat, HTTP server, consumer-group positioning, `ready`, one bus loop on `brain.say` + `voice.playing` (`latest`); every failure logs `fatal` and exits 1.
3. `voice.ts` — `Voice` class: synth, store (50 newest), `voice.utterance`, claimed set (pruned with the store), 1.5 s virtual sink with a cancellable virtual done, error release, HTTP handler; plus `kokoroSynth` and `stubSynth`.
4. `wav.ts` — `parseWav` and the 30 Hz mouth envelope.
5. `health.ts` — `VoiceHealth` (`kokoro` dep, modes `live` / `mock`).
6. Consumers/peers of the protocol: ears (`discord` sink), dashboard (`dashboard` sink, `/audio/*` proxy), cortex (released by `voice.done`), avatar (lip-sync on `voice.playing`).

## Spec Coverage

| Category | Spec IDs | Implemented | Tested | Deferred | Gaps |
|----------|----------|-------------|--------|----------|------|
| Synthesis | VOICE-SYN-001 to 006 | 6 | 6 | 0 | 0 |
| Stub engine | VOICE-STUB-001 to 003 | 3 | 3 | 0 | 0 |
| Utterance publication | VOICE-UTT-001 to 003 | 3 | 3 | 0 | 0 |
| WAV and envelope | VOICE-ENV-001 to 004 | 4 | 4 | 0 | 0 |
| Sink arbitration | VOICE-SINK-001 to 009 | 9 | 9 | 0 | 0 |
| Audio store and HTTP | VOICE-HTTP-001 to 005 | 5 | 5 | 0 | 0 |
| Health | VOICE-HLTH-001 to 004 | 4 | 4 | 0 | 0 |

**Summary:** 34 of 34 specs implemented; 0 deferred; 0 gaps. Every spec has a test. VOICE-UTT-003 is tested for synthesis and parse failures only. Process exit and signal handling are injected in the boot tests, so VOICE-SYN-006 and VOICE-HLTH-004 are tested through `runVoice`, not through a real process.

## Key Findings

1. **Late real sink (fixed).** A real sink's `voice.playing` after the virtual one now cancels the pending virtual `voice.done` (`services/voice/src/voice.ts:105-107`), so cortex is released by the sink that is playing. avatar still restarts lip-sync on the second `voice.playing` for the id. (VOICE-SINK-008, B1)
2. **Restart replay (fixed).** voice subscribes with `start: "latest"` and positions its group before `ready` (`services/voice/src/boot.ts:41-45`). (VOICE-SYN-001, P8)
3. **Bus failures (fixed).** Virtual-sink publishes go through `publishVirtual`, which logs and continues; every startup step and the subscription are inside `runVoice`'s `try`, which logs `fatal` and exits 1. (VOICE-SINK-009, VOICE-SYN-006, R1, R3)
4. **Claims share the TTS loop.** One sequential subscription handles `brain.say` (seconds of synthesis) and `voice.playing` claims (`packages/bus/src/index.ts`), so a claim for line A can be stuck behind synthesis of line B and the virtual timer for A may fire anyway. `[inferred]` not reproduced in tests.
5. **`claimed` is pruned with the store (fixed).** There is no sink exclusivity: Discord and a dashboard page both play and both report, which is accepted (S46, documented in the LLD). (VOICE-SINK-007)
6. **`ready` needs a duplicate positioning call.** The bus has no "subscribed" notification, so boot calls `resetGroup` before `ready` and `subscribe` positions the group again. A hook in event-bus would remove the duplicate (cross-segment follow-up).
7. **Two near-duplicate WAV parsers and a cross-service test import.** `services/voice/src/wav.ts:12-34` vs `services/ears/src/audio.ts:44-55`; `services/voice/test/voice.test.ts:5` imports `../../ears/src/audio.js`.
8. **Port 8700 is not published by compose, by design.** Compose sets `VOICE_URL=http://voice:8700` (`docker-compose.yml:18`) and never publishes the port; `urls.voice()` defaults to loopback (commit `e53badc`); host-side players go through the dashboard proxy (P4). The frozen OpenSpec's `http://voice:<VOICE_PORT>` default is stale and the LID line (VOICE-UTT-002) is authoritative.
9. **WAV handling is narrow.** Only 16-bit PCM; envelope reads the first channel only; `parseWav` ignores the format tag and a missing `fmt ` gives a non-finite duration (`wav.ts:17-29,41`). Kokoro returns mono 16-bit today so nothing trips.
10. **Store eviction counts duplicates.** Re-using an id pushes it into `order` twice (`voice.ts:77-85`); and a failed `voice.utterance` publish is reported as `tts failed` because the whole path shares one `try` (`voice.ts:115-144`).

## Work Required

### Must Fix
None.

### Should Fix
1. Move synthesis off the shared loop (or use a second group for claims) so claims are not delayed by TTS.
2. Share one WAV reader/writer between voice and ears and remove the cross-service import in `voice.test.ts`.
3. Add an event-bus "subscribed" hook so `ready` does not need the duplicate `resetGroup` call (event-bus segment).

### Nice to Have
4. Clear the 1.5 s virtual timer and any pending virtual done on shutdown.
5. Tighten `parseWav` (format tag, `fmt ` ordering) and handle stereo envelopes by mixing channels.
6. Align the `voice.speed` default (schema 1 vs example YAML 1.05).
