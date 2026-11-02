# Arrow: voice

`brain.say` to audio: TTS (Kokoro or silent stub), WAV parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, and the audio-sink arbitration protocol shared with ears and dashboard.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 34 specs: 29 implemented, 0 deferred, 5 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B1** Late real sink → a real sink's `voice.playing` after the virtual one cancels the pending virtual `voice.done` (voice-only change). Specs: VOICE-SINK-008 rewritten; VOICE-SINK-004 unchanged.
2. **P8** Restart replay → start mode `latest`: the `voice` group moves to the newest entry on every start; no backlog is spoken. Specs: VOICE-SYN-001 (`[x]` → `[ ]`).
3. **R1** Bus failures → virtual-sink publish failures are logged and voice continues; a subscription rejection that survives the bus retry is logged `fatal` and exits non-zero. Specs: VOICE-SINK-009, VOICE-SYN-006 (new).
4. **S44** VOICE-SINK-005 → keep; add a test that re-uses an id. Specs: unchanged.
5. **S45** Store-before-publish → add a test. Specs: VOICE-SYN-004 unchanged.
6. **P7** Mute awareness → voice speaks every `brain.say` and never subscribes to `control`; mute and pause belong to cortex and salience. Specs: VOICE-SYN-005 reworded.
7. **S46** Same line on two sinks → accepted; LLD note and Decisions row.
8. **P4** Host-side sinks → not supported except through the dashboard `/audio/*` proxy; 8700 stays unpublished; the loopback `urls.voice()` default stays. LLD Decisions row.

## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (34 specs: 29 `[x]`, 5 `[ ]`, 0 `[D]`; prefix `VOICE`)

### Tests
- services/voice/test/voice.test.ts (pipeline, virtual sink, HTTP, store, Kokoro client)
- services/voice/test/stub.test.ts
- services/voice/test/wav.test.ts
- services/voice/test/health.test.ts

23 `@spec` annotations in tests, citing 24 distinct spec IDs.

### Code
- services/voice/src/index.ts
- services/voice/src/voice.ts
- services/voice/src/wav.ts
- services/voice/src/health.ts
- services/voice/package.json, services/voice/tsconfig.json

21 `@spec` annotations in code, citing all 29 `[x]` spec IDs plus VOICE-SYN-001, which is now a gap (its annotation marks the subscription the start-mode fix changes). No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/voice/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/voice/spec.md (rationale for keeping `/health`: `.../add-service-health/design.md` D5)
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/voice/spec.md (rationale for the stub: `.../add-isolated-backends/design.md` D5)

## Architecture

**Purpose:** Convert the brain's lines into audio the body can play, and guarantee the brain is released whether or not any sink plays it.

**Key Components:**
1. `index.ts` — boot: config, heartbeat, HTTP server on `VOICE_PORT` (8700), one bus loop on `brain.say` + `voice.playing`.
2. `voice.ts` — `Voice` class: synth, store (50 newest), `voice.utterance`, claimed set, 1.5 s virtual sink, error release, HTTP handler; plus `kokoroSynth` and `stubSynth`.
3. `wav.ts` — `parseWav` and the 30 Hz mouth envelope.
4. `health.ts` — `VoiceHealth` (`kokoro` dep, modes `live` / `mock`).
5. Consumers/peers of the protocol: ears (`discord` sink), dashboard (`dashboard` sink, `/audio/*` proxy), cortex (released by `voice.done`), avatar (lip-sync on `voice.playing`).

## Spec Coverage

| Category | Spec IDs | Implemented | Tested | Deferred | Gaps |
|----------|----------|-------------|--------|----------|------|
| Synthesis | VOICE-SYN-001 to 006 | 4 | 2 | 0 | 2 |
| Stub engine | VOICE-STUB-001 to 003 | 3 | 2 | 0 | 0 |
| Utterance publication | VOICE-UTT-001 to 003 | 3 | 3 | 0 | 0 |
| WAV and envelope | VOICE-ENV-001 to 004 | 4 | 4 | 0 | 0 |
| Sink arbitration | VOICE-SINK-001 to 009 | 6 | 5 | 0 | 3 |
| Audio store and HTTP | VOICE-HTTP-001 to 005 | 5 | 4 | 0 | 0 |
| Health | VOICE-HLTH-001 to 004 | 4 | 4 | 0 | 0 |

**Summary:** 29 of 34 specs implemented; 0 deferred; 5 gaps (VOICE-SYN-001, VOICE-SYN-006, VOICE-SINK-007, VOICE-SINK-008, VOICE-SINK-009). Implemented but untested: VOICE-SYN-004, VOICE-SYN-005, VOICE-STUB-003, VOICE-SINK-005 (observable only with a re-used id), VOICE-HTTP-005. VOICE-HLTH-001 and VOICE-HLTH-004 are tested only through the heartbeat spec, not the boot wiring; VOICE-UTT-003 only for synthesis and parse failures.

## Key Findings

1. **A late real sink gets a double lifecycle, and its claim does not stop the virtual `voice.done`.** The claim check runs once at 1.5 s (`services/voice/src/voice.ts:107-109`); the virtual `voice.done` timer never re-checks (`voice.ts:110`). ears reaches this whenever a line queues behind a long one (`services/ears/src/playback.ts:39-46`). Cortex is released by the first `voice.done` from any sink (`services/cortex/src/cortex.ts:56-60`); avatar restarts lip-sync on the second `voice.playing` (`services/avatar/src/engine.ts:39-45`). (VOICE-SINK-008, B1)
2. **A restart can speak stale lines.** `fromNow` applies only when the group is created (`packages/bus/src/index.ts:133-138`); a compose restart resumes the existing `voice` group, and only the control plane's `fresh` start resets it (`packages/control/src/manifest.ts:45`). (VOICE-SYN-001, P8)
3. **Unguarded publishes and subscription end the process on failure.** `voice.ts:107-110` and `services/voice/src/index.ts:30` have no `.catch`, and nothing in the workspace handles `unhandledRejection`; on Node 22 that exits the process. (VOICE-SINK-009, VOICE-SYN-006, R1)
4. **Claims are read by the same loop that runs TTS.** One sequential subscription handles `brain.say` (seconds of synthesis) and `voice.playing` claims (`services/voice/src/index.ts:30`, `packages/bus/src/index.ts:157-167`), so a claim for line A can be stuck behind synthesis of line B and the virtual timer for A may fire anyway. `[inferred]` not reproduced in tests.
5. **`claimed` is never pruned** while the audio store is capped at 50 (`voice.ts:70,77,84`). There is no sink exclusivity: Discord and a dashboard page both play and both report, which is accepted (S46). (VOICE-SINK-007)
6. **Two invariants have no test.** VOICE-SINK-005 is not observable without id re-use (the test at `services/voice/test/voice.test.ts:55` does not observe it), and VOICE-SYN-004's store-before-publish ordering rests on statement order (`voice.ts:96-98`). (S44, S45)
7. **Two near-duplicate WAV parsers and a cross-service test import.** `services/voice/src/wav.ts:12-34` vs `services/ears/src/audio.ts:44-55`; `services/voice/test/voice.test.ts:5` imports `../../ears/src/audio.js`.
8. **Port 8700 is not published by compose, by design.** Compose sets `VOICE_URL=http://voice:8700` (`docker-compose.yml:18`) and never publishes the port (`docker-compose.yml:129-134`); `urls.voice()` defaults to loopback (`packages/config/src/index.ts:173`, commit `e53badc`); host-side players go through the dashboard proxy (P4). The frozen OpenSpec's `http://voice:<VOICE_PORT>` default is stale and the LID line (VOICE-UTT-002) is authoritative.
9. **WAV handling is narrow.** Only 16-bit PCM; envelope reads the first channel only; `parseWav` ignores the format tag and a missing `fmt ` gives a non-finite duration (`wav.ts:17-29,41`). Kokoro returns mono 16-bit today so nothing trips.
10. **Store eviction counts duplicates.** Re-using an id pushes it into `order` twice (`voice.ts:74-78`); and a failed `voice.utterance` publish is reported as `tts failed` because the whole path shares one `try` (`voice.ts:92-116`).

## Work Required

### Must Fix
1. Cancel the pending virtual `voice.done` when a real sink's `voice.playing` arrives late (VOICE-SINK-008, B1).
2. Catch and log failures of the virtual-sink timer publishes (VOICE-SINK-009, R1).
3. Log `fatal` and exit non-zero when the subscription rejects after the bus's retry (VOICE-SYN-006, R1).
4. Subscribe with the event-bus `latest` start mode once BUS-SUB-010 lands (VOICE-SYN-001, P8).

### Should Fix
5. Prune `claimed` alongside store eviction (VOICE-SINK-007).
6. Move synthesis off the shared loop (or use a second group for claims) so claims are not delayed by TTS.
7. Share one WAV reader/writer between voice and ears and remove the cross-service import in `voice.test.ts`.

### Nice to Have
8. Tests: VOICE-SINK-005 with a re-used id (S44); VOICE-SYN-004 store-before-publish, asserting from a `FakeBus` publish hook that the WAV is already served (S45); a real sink claiming after the virtual pair has fired (VOICE-SINK-008); boot wiring (VOICE-SYN-001, VOICE-SYN-006, VOICE-STUB-003, VOICE-HTTP-005). Clear virtual timers on shutdown.
9. Tighten `parseWav` (format tag, `fmt ` ordering) and handle stereo envelopes by mixing channels.
10. Align the `voice.speed` default (schema 1 vs example YAML 1.05).
