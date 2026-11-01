# Arrow: voice

`brain.say` to audio: TTS (Kokoro or silent stub), WAV parsing, lip-sync envelope, bounded in-memory audio store served over HTTP, and the audio-sink arbitration protocol shared with ears and dashboard.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f). 30 of 32 specs implemented, 24 of them exercised by a test; 2 gaps, both in sink arbitration. Boot wiring (`index.ts`) is untested. Audit pass complete 2026-11-02, awaiting index update.

## Questions for the user

1. **VOICE-SINK-004 / VOICE-SINK-008: what should happen when a real sink starts after the 1.5 s window?** The claim set is checked once, when the 1.5 s timer fires (`services/voice/src/voice.ts:107-109`); a later claim does not cancel the pending virtual `voice.done` (`voice.ts:110`), so cortex is released early and avatar restarts lip-sync on the late `voice.playing`, then may close the mouth on the virtual `voice.done` while audio is still playing (`services/avatar/src/engine.ts:39-49`). ears reaches this case whenever a line is queued behind a long one (`services/ears/src/playback.ts:38-45`). VOICE-SINK-004 now says what the code does (a claim counts only if it arrives within the window); VOICE-SINK-008 is worded for the whole protocol and could need sink changes. Recommended: have a late claim cancel the pending virtual `voice.done` (a voice-only change), and reword VOICE-SINK-008 as that voice-side rule.
2. **VOICE-SYN-001: should voice ever speak lines published while it was down?** `fromNow` only positions a newly created consumer group (`packages/bus/src/index.ts:126-131`); an existing `voice` group resumes where it stopped, so a compose restart (`docker-compose.yml:9`, `restart: unless-stopped`) speaks the backlog. Only a control-plane `fresh` start skips it (`packages/control/src/manifest.ts:44`). avatar has the same behavior. Recommended: no; decide it once in event-bus (for example reset the group to `$` on every `fromNow` start) so voice and avatar inherit it.
3. **What should voice do when a bus publish or the subscription fails?** The virtual-sink timer publishes (`voice.ts:107-110`) and `void bus.subscribe(...)` (`services/voice/src/index.ts:30`) have no `.catch`; no `unhandledRejection` handler exists in `packages/` or `services/`, so on Node 22 a Redis outage that outlasts the publisher's three retries (`packages/bus/src/index.ts:43`) ends the process (checked with a stand-alone probe: a rejected `await` inside a `setTimeout` callback exits with code 1). No spec covers it. Recommended: catch and log the timer publishes; add a voice gap line for the subscription matching AVATAR-BUS-008.
4. **VOICE-SINK-005: keep, test, or delete?** Excluding the virtual sink's own `voice.playing` from `claimed` (`voice.ts:84`) has no observable effect unless an utterance id is re-used, because the virtual `voice.playing` is published only after the claim check. The test that appears to cover it sends a virtual echo for an id that was never said (`services/voice/test/voice.test.ts:55`). Recommended: keep the line and add a test that re-uses an id.
5. **VOICE-SYN-004: should the store-before-publish ordering get a test?** It is what lets a sink fetch `audioUrl` the moment `voice.utterance` arrives, and today only statement order holds it (`voice.ts:96-98`). Recommended: yes; assert from a `FakeBus` publish hook that the WAV is already served.
6. **VOICE-SYN-005: is voice meant to be unaware of mute?** Voice speaks every `brain.say` regardless of `reason`, `injected`, `remember` or `control` mute (`voice.ts:88-93`; it never subscribes to `control`, `index.ts:30`). Recommended: confirm that muting belongs upstream (cortex, salience) and record that in the HLD's turn-taking protocol.
7. **Is playing the same line on two sinks acceptable?** Claims only suppress voice's own fallback; Discord and an open dashboard page both play and both report (`voice.ts:84`; `services/dashboard/public/index.html:135-143`). Recommended: accept it for now and say so in the LLD; revisit with question 1.
8. **Are host-side sinks a supported topology?** Compose does not publish 8700 (`docker-compose.yml:129-134`); in-network sinks fetch `http://voice:8700` and browsers go through the dashboard proxy (`services/dashboard/src/routes.ts:55-60`). The loopback `urls.voice()` default is deliberate (commit `e53badc`). Recommended: no; document the dashboard proxy as the only path for host-side players.

## References

### HLD
- docs/high-level-design.md (segments table, Cross-cutting protocols: Audio sink arbitration)

### LLD
- docs/intent/voice/voice-design.md (documents the full Sink Arbitration Protocol)

### EARS
- docs/intent/voice/voice-specs.md (32 specs: 30 `[x]`, 2 `[ ]`, 0 `[D]`; prefix `VOICE`)

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

21 `@spec` annotations in code, citing all 30 `[x]` spec IDs. No annotation cites a missing or non-`[x]` ID.

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
| Synthesis | VOICE-SYN-001 to 005 | 5 | 2 | 0 | 0 |
| Stub engine | VOICE-STUB-001 to 003 | 3 | 2 | 0 | 0 |
| Utterance publication | VOICE-UTT-001 to 003 | 3 | 3 | 0 | 0 |
| WAV and envelope | VOICE-ENV-001 to 004 | 4 | 4 | 0 | 0 |
| Sink arbitration | VOICE-SINK-001 to 008 | 6 | 5 | 0 | 2 |
| Audio store and HTTP | VOICE-HTTP-001 to 005 | 5 | 4 | 0 | 0 |
| Health | VOICE-HLTH-001 to 004 | 4 | 4 | 0 | 0 |

**Summary:** 30 of 32 specs implemented; 0 deferred; 2 gaps (VOICE-SINK-007, VOICE-SINK-008). Implemented but untested: VOICE-SYN-001, VOICE-SYN-004, VOICE-SYN-005, VOICE-STUB-003, VOICE-SINK-005 (not observable), VOICE-HTTP-005. VOICE-HLTH-001 and VOICE-HLTH-004 are tested only through the heartbeat spec, not the boot wiring; VOICE-UTT-003 only for synthesis and parse failures.

## Key Findings

1. **A late real sink gets a double lifecycle, and its claim does not stop the virtual `voice.done`.** The claim check runs once at 1.5 s (`services/voice/src/voice.ts:107-109`); the virtual `voice.done` timer never re-checks (`voice.ts:110`). ears reaches this whenever a line queues behind a long one (`services/ears/src/playback.ts:38-45`). Cortex is released by the first `voice.done` from any sink (`services/cortex/src/cortex.ts:53-57`); avatar restarts lip-sync on the second `voice.playing` (`services/avatar/src/engine.ts:39-45`). VOICE-SINK-004 was reworded to state the window rule the code implements. (VOICE-SINK-004, VOICE-SINK-008)
2. **A restart can speak stale lines.** `fromNow` applies only when the group is created (`packages/bus/src/index.ts:126-131`); a compose restart resumes the existing `voice` group, and only the control plane's `fresh` start resets it (`packages/control/src/manifest.ts:44`). VOICE-SYN-001 was reworded to say this. (VOICE-SYN-001)
3. **Unguarded publishes and subscription end the process on failure.** `voice.ts:107-110` and `services/voice/src/index.ts:30` have no `.catch`, and nothing in the workspace handles `unhandledRejection`; on Node 22 that exits the process. No spec covers it.
4. **Claims are read by the same loop that runs TTS.** One sequential subscription handles `brain.say` (seconds of synthesis) and `voice.playing` claims (`services/voice/src/index.ts:30`, `packages/bus/src/index.ts:151-159`), so a claim for line A can be stuck behind synthesis of line B and the virtual timer for A may fire anyway. `[inferred]` not reproduced in tests.
5. **`claimed` is never pruned** while the audio store is capped at 50 (`voice.ts:70,77,84`). There is also no sink exclusivity: Discord and a dashboard page both play and both report. (VOICE-SINK-007)
6. **Two invariants have no test.** VOICE-SINK-005 is not observable without id re-use (the test at `services/voice/test/voice.test.ts:55` does not observe it), and VOICE-SYN-004's store-before-publish ordering rests on statement order (`voice.ts:96-98`).
7. **Two near-duplicate WAV parsers and a cross-service test import.** `services/voice/src/wav.ts:12-34` vs `services/ears/src/audio.ts:41-52`; `services/voice/test/voice.test.ts:5` imports `../../ears/src/audio.js`.
8. **Port 8700 is not published by compose.** Compose sets `VOICE_URL=http://voice:8700` (`docker-compose.yml:18`) and never publishes the port (`docker-compose.yml:129-134`); `urls.voice()` defaults to loopback by design (`packages/config/src/index.ts:163`, commit `e53badc`), so the frozen OpenSpec's `http://voice:<VOICE_PORT>` default is stale and the LID line (VOICE-UTT-002) is authoritative.
9. **WAV handling is narrow.** Only 16-bit PCM; envelope reads the first channel only; `parseWav` ignores the format tag and a missing `fmt ` gives a non-finite duration (`wav.ts:17-29,41`). Kokoro returns mono 16-bit today so nothing trips.
10. **Store eviction counts duplicates.** Re-using an id pushes it into `order` twice (`voice.ts:74-78`); and a failed `voice.utterance` publish is reported as `tts failed` because the whole path shares one `try` (`voice.ts:92-116`).
11. **Spec changes in this pass.** No `[x]`/`[ ]` marker was wrong. Reworded to match the code: VOICE-SYN-001 (group creation), VOICE-SINK-004 (claim window). Added: VOICE-SYN-005 (voice speaks every `brain.say`). Test pointers corrected on VOICE-SYN-004 and VOICE-SINK-005, which no test exercises.

## Work Required

### Must Fix
1. Decide and implement a protocol fix for late real sinks: cancel the pending virtual `voice.done` on a late claim, widen the claim window, or let sinks drop lines voice already timed (VOICE-SINK-004, VOICE-SINK-008). Document the chosen rule in the voice LLD.

### Should Fix
2. Catch and log failures of the virtual-sink timer publishes and of the subscription loop.
3. Decide whether a restart may replay the `brain.say` backlog (VOICE-SYN-001), with event-bus and avatar.
4. Prune `claimed` alongside store eviction (VOICE-SINK-007).
5. Move synthesis off the shared loop (or use a second group for claims) so claims are not delayed by TTS.
6. Share one WAV reader/writer between voice and ears and remove the cross-service import in `voice.test.ts`.

### Nice to Have
7. Tighten `parseWav` (format tag, `fmt ` ordering) and handle stereo envelopes by mixing channels.
8. Tests for boot wiring (VOICE-SYN-001, VOICE-STUB-003, VOICE-HTTP-005), for VOICE-SYN-004 ordering, for VOICE-SINK-005 with a re-used id, and for a real sink claiming after the virtual pair has fired; clear virtual timers on shutdown.
9. Align the `voice.speed` default (schema 1 vs example YAML 1.05).
