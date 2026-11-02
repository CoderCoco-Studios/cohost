# Arrow: ears

Discord voice in (per-speaker capture, STT, `speech.heard`), Discord voice out (the `discord` audio sink), audio-upload injection, and the `off` / no-token idle modes.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 46 specs: 39 implemented, 1 deferred, 6 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and the gap fixes are scheduled.

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B12** Failed voice join → log, report `degraded` / `discord: down`, keep the subscription, retry with increasing delay (also for rejoins). Specs: EARS-SESS-006 (`[ ]`, reworded).
2. **B13** Injection before the Discord join → subscribe before joining. Specs: EARS-INJ-007 (`[ ]`, reworded).
3. **S15** Unplayable line → keep the silent skip; voice's virtual sink times it. Specs: EARS-PLAY-006 (`[ ]` → `[D]`); EARS-PLAY-005 unchanged.
4. **B19** `ears.discord.guild_id` / `voice_channel_id` → read the config keys. Specs: EARS-SESS-007 (`[ ]`, reworded).
5. **R2** Shutdown in the `discord` plan → one sequence: destroy connection and client, then stop the bus. Specs: EARS-SESS-008 (`[ ]`, reworded).
6. **S16** Injected `speech.heard` in the `off` plan → confirmed as the exception. Specs: EARS-START-001 (unchanged, `[x]`).
7. **P7** Mute and pause → ears stays unaware; cortex and salience enforce them. Specs: EARS-PLAY-008 (new, `[x]`).
8. **P8** Restart replay → the `ears` group uses start mode `latest`. Specs: EARS-START-006 (new, `[ ]`); EARS-START-003, EARS-PLAY-001 (reworded).
9. **R1** Publish failures → log and continue. Specs: EARS-PLAY-009 (new, `[ ]`, the `voice.done` publish).

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (46 specs: 39 `[x]`, 6 `[ ]`, 1 `[D]`)

### Tests
- services/ears/test/audio.test.ts
- services/ears/test/ears.test.ts (playback queue, hearing, STT client)
- services/ears/test/health.test.ts
- services/ears/test/inject.test.ts

28 `@spec` annotations in tests, citing 24 distinct spec IDs.

### Code
- services/ears/src/index.ts
- services/ears/src/discord.ts
- services/ears/src/hearing.ts
- services/ears/src/playback.ts
- services/ears/src/audio.ts
- services/ears/src/inject.ts
- services/ears/src/health.ts
- services/ears/package.json, services/ears/tsconfig.json

25 `@spec` annotations in code, citing 38 of the 39 `[x]` spec IDs; EARS-PLAY-008 (ears does not subscribe to `control`) is a boundary statement with no code entry point. No annotation cites a missing or non-`[x]` ID.

### OpenSpec (frozen, historical)
- openspec/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md (rationale: `.../add-isolated-backends/design.md` D7)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md (rationale: `.../add-test-injection/design.md` D2, D8)

## Architecture

**Purpose:** Be the co-host's ears and one of its mouths. Turns each Discord speaker's audio into `speech.heard`, plays `voice.utterance` audio into the voice channel as the `discord` sink, and transcribes uploaded audio on request.

**Key Components:**
1. `index.ts` — picks a startup plan (`off` / `no-token` / `discord`) with `earsPlan`, wires the heartbeat and inject handler, lazy-loads `discord.ts`.
2. `discord.ts` — Discord client, voice join/rejoin, per-speaker Opus capture, the single `ears` bus loop for `voice.utterance` + `inject.request`.
3. `hearing.ts` — min-length gate, 48k-to-16k conversion, STT HTTP client, `speech.heard` publish.
4. `playback.ts` — FIFO playback queue; publishes `voice.playing` / `voice.done` with `sink: "discord"`.
5. `audio.ts` — PCM resampling and WAV header read/write.
6. `inject.ts` — `inject.request` (audio) handler with dashboard-origin URL guard.
7. `health.ts` — startup plan decision and `EarsHealth` heartbeat spec.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Startup plans | EARS-START-001 to 006 | 5 | 0 | 1 (START-006) |
| Discord session | EARS-SESS-001 to 008 | 5 | 0 | 3 (SESS-006 to 008) |
| Listening and transcription | EARS-HEAR-001 to 008 | 8 | 0 | 0 |
| Audio conversion | EARS-AUD-001 to 003 | 3 | 0 | 0 |
| Playback sink | EARS-PLAY-001 to 009 | 7 | 1 (PLAY-006) | 1 (PLAY-009) |
| Audio injection | EARS-INJ-001 to 009 | 8 | 0 | 1 (INJ-007) |
| Health | EARS-HLTH-001 to 003 | 3 | 0 | 0 |

**Summary:** 39 of 46 specs implemented; 6 gaps (EARS-START-006, EARS-SESS-006, EARS-SESS-007, EARS-SESS-008, EARS-PLAY-009, EARS-INJ-007); 1 deferred (EARS-PLAY-006). 24 of the 39 implemented specs have a test citing them. The 15 without a test are the Discord and plan glue in `discord.ts` / `index.ts` (EARS-START-003, EARS-START-005, EARS-SESS-001 to 005, EARS-HEAR-001 to 003, EARS-PLAY-001, EARS-PLAY-007, EARS-INJ-009) plus EARS-INJ-003 (wrong kind) and EARS-PLAY-008 (boundary statement). EARS-INJ-004's redirect and non-2xx paths are untested in ears.

## Key Findings

1. **EARS-START-001** excludes only non-injected `speech.heard` in the `off` plan, consistent with EARS-INJ-009 (S16). EARS-START-005 `[x]` covers shutdown in the idle plans.
2. **A failed initial voice join kills the subscription and the process.** `join()` is awaited bare in the client `ready` listener and `bus.subscribe` comes after it (`services/ears/src/discord.ts:108-113`); the rejection is unhandled and no `unhandledRejection` handler exists in `packages/` or `services/`, so Node exits. A failed rejoin logs and is never retried (`discord.ts:97`). (EARS-SESS-006, B12)
3. **Injection does not work before Discord is joined in the `discord` plan.** It works for `off` / `no-token` (`services/ears/src/index.ts:43`) but the `discord`-plan subscription starts after `join()` (`discord.ts:110-117`). The shared loop also awaits the inject handler, so a slow STT call delays `voice.utterance` pickup (`discord.ts:114`). (EARS-INJ-007, B13)
4. **Shutdown in the `discord` plan skips the Discord teardown.** Two `onShutdown` registrations (`index.ts:39`, `discord.ts:122`) each end in `process.exit(0)` (`packages/bus/src/index.ts:242-256`); the bus-stop one exits first. Found by reading. (EARS-SESS-008, R2)
5. **Playback failure sends no `voice.done`, and the queue has no timeout.** Recovery depends on voice's virtual sink (`services/ears/src/playback.ts:47-51`, pinned by `services/ears/test/ears.test.ts:51`), kept by decision (S15, EARS-PLAY-006 deferred); a hung `httpAudio` fetch (no timeout, `playback.ts:14-18`) blocks every later utterance. The `voice.done` publish in `onIdle` is unguarded (`playback.ts:35`, EARS-PLAY-009).
6. **Guild/channel config keys are unread.** `ears.discord.guild_id` / `voice_channel_id` are in the schema and example YAML but the code reads env vars directly (`discord.ts:63-64`). (EARS-SESS-007, B19)
7. **`mute` / `pause` are ignored by ears by design.** It never subscribes to `control` (`discord.ts:113`); cortex and salience enforce muting (EARS-PLAY-008, P7).
8. **Decisions evidenced; duplicate WAV code** — LLD Decisions rows cite a comment, test, commit, archived OpenSpec design (add-isolated-backends D7, add-test-injection D2/D8) or the owner decision of 2026-11-01; utterance boundary, resampling, STT language and playback format stay `[inferred]`. `readWavHeader` (`services/ears/src/audio.ts:44-55`) still duplicates voice's `parseWav` (`services/voice/src/wav.ts:12-34`).

## Work Required

### Must Fix
1. Handle voice-join failure in the `discord` plan: log, report `degraded` / `discord: down`, keep the subscription, retry the initial join and rejoins with increasing delay (EARS-SESS-006, B12).
2. Start the `ears` loop before the voice join so injection works while Discord is not connected (EARS-INJ-007, B13). Keep one loop per group: two loops with different type filters in the same group lose events (comment at `discord.ts:111`).
3. Read `ears.discord.guild_id` / `voice_channel_id` from config (EARS-SESS-007, B19).
4. One shutdown sequence in the `discord` plan, relying on the bus's composed `onShutdown` (EARS-SESS-008, R2).
5. Catch and log a failed `voice.done` publish (EARS-PLAY-009, R1).
6. Subscribe the `ears` group with start mode `latest` once the bus offers it (EARS-START-006, P8).

### Should Fix
7. Add a fetch timeout / stuck-playback guard to the playback queue (LLD Open Question 2).
8. Add tests for `discord.ts` wiring (plan selection, join failure and retry, rejoin, injection before join, shutdown) behind a fake client.

### Nice to Have
9. Share one WAV parser/writer between ears and voice (e.g. in a package) and stop `voice/test/voice.test.ts` importing from ears.
10. Make the transcript filter Unicode-aware (`services/ears/src/hearing.ts:44`).
