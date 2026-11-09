# Arrow: ears

Discord voice in (per-speaker capture, STT, `speech.heard`), Discord voice out (the `discord` audio sink), audio-upload injection, and the `off` / no-token idle modes.

## Status

**AUDITED** — audited 2026-11-02 (git SHA `1b57790`); mapped 2026-10-31 (`686cc8f`). 47 specs: 46 implemented, 1 deferred, 0 gaps. The owner answered the audit questions on 2026-11-01; the decisions are applied below and every scheduled gap fix has landed. With the spoken fallback line (build chunk 1): 66 specs: 66 implemented, 0 gaps, 0 deferred.

## Spoken fallback line: built (chunk 1)

Design: LLD § Fallback Line (owner decisions, `[proposed]` items, edge cases, build order). When ears cannot play a line it reports `voice.failed` and says a pre-generated funny line in its place, played from ears' own cache of the clips voice serves over HTTP.

- `EARS-PLAY-005` (give up instead of a silent skip) and `EARS-PLAY-006` (publish `voice.failed`) are implemented in `playback.ts`; `services/ears/test/ears.test.ts` now asserts the give-up report instead of the old silent skip.
- `EARS-FALL-001` to `019` are implemented: `fallback.ts` holds the clip cache, the disk mirror, the manifest refresh (startup, then every 60 s) and clip choice; `session.ts` reads `voice.playing` for the claim memory; `discord.ts` wires them.
- Chunk 1 of the build order. Until chunk 2 (voice generates and serves clips) lands, voice answers the manifest with 404, so the cache stays empty and a give-up is the report plus a silent skip.
- Deferred decisions recorded in the LLD: separate source-agnostic listening and speaking modules with owner-tunable routing (HLD Deferred goals); tuning the co-host's voice (voice segment).

## Decisions applied

Owner decisions of 2026-11-01 on the audit questions (P product, B bug, R robustness, S small choice, H housekeeping).

1. **B12** Failed voice join → log, report `degraded` / `discord: down`, keep the subscription, retry with increasing delay (also for rejoins). Specs: EARS-SESS-006 (`[x]`, reworded).
2. **B13** Injection before the Discord join → subscribe before joining. Specs: EARS-INJ-007 (`[x]`, reworded).
3. **S15** Unplayable line → keep the silent skip; voice's virtual sink times it. Specs: EARS-PLAY-006 (`[ ]` → `[D]`); EARS-PLAY-005 unchanged.
4. **B19** `ears.discord.guild_id` / `voice_channel_id` → read the config keys. Specs: EARS-SESS-007 (`[x]`, reworded).
5. **R2** Shutdown in the `discord` plan → one sequence: destroy connection and client, then stop the bus. Specs: EARS-SESS-008 (`[x]`, reworded).
6. **S16** Injected `speech.heard` in the `off` plan → confirmed as the exception. Specs: EARS-START-001 (unchanged, `[x]`).
7. **P7** Mute and pause → ears stays unaware; cortex and salience enforce them. Specs: EARS-PLAY-008 (new, `[x]`).
8. **P8** Restart replay → the `ears` group uses start mode `latest`. Specs: EARS-START-006 (new, `[x]`); EARS-START-003, EARS-PLAY-001 (reworded).
9. **R1** Publish failures → log and continue. Specs: EARS-PLAY-009 (new, `[x]`, the `voice.done` publish).

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (66 specs: 66 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- services/ears/test/audio.test.ts
- services/ears/test/fallback.test.ts (clip cache, mirror, refresh against a fake voice HTTP server, clip choice)
- services/ears/test/ears.test.ts (playback queue, hearing, STT client)
- services/ears/test/health.test.ts
- services/ears/test/inject.test.ts
- services/ears/test/session.test.ts (join retry, config target, event handler gating, subscription, shutdown)

37 `@spec` annotations in tests, citing 31 distinct spec IDs.

### Code
- services/ears/src/index.ts
- services/ears/src/discord.ts
- services/ears/src/session.ts
- services/ears/src/hearing.ts
- services/ears/src/playback.ts
- services/ears/src/fallback.ts
- services/ears/src/audio.ts
- services/ears/src/inject.ts
- services/ears/src/health.ts
- services/ears/package.json, services/ears/tsconfig.json

32 `@spec` annotations in code, citing 45 of the 46 spec IDs (EARS-PLAY-006 is deferred); EARS-PLAY-008 (ears does not subscribe to `control`) is a boundary statement with no code entry point. No annotation cites a missing ID.

### OpenSpec (frozen, historical)
- openspec/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/ears/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/ears/spec.md (rationale: `.../add-isolated-backends/design.md` D7)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/ears/spec.md (rationale: `.../add-test-injection/design.md` D2, D8)

## Architecture

**Purpose:** Be the co-host's ears and one of its mouths. Turns each Discord speaker's audio into `speech.heard`, plays `voice.utterance` audio into the voice channel as the `discord` sink, and transcribes uploaded audio on request.

**Key Components:**
1. `index.ts` — picks a startup plan (`off` / `no-token` / `discord`) with `earsPlan`, wires the heartbeat and inject handler, lazy-loads `discord.ts`, registers the one shutdown (`stopEars`).
2. `discord.ts` — Discord client, voice join/rejoin (with `createJoiner` retry), per-speaker Opus capture; establishes the single `ears` bus loop for `voice.utterance` + `inject.request` before logging in.
3. `session.ts` — testable session logic: `voiceTarget` (config keys), `createJoiner` (retry with increasing delay), `createEarsHandler` (inject always; utterance only while voice is ready), `subscribeEars` (group created first, start mode `latest`), `stopEars` (single shutdown sequence).
4. `hearing.ts` — min-length gate, 48k-to-16k conversion, STT HTTP client, `speech.heard` publish.
5. `playback.ts` — FIFO playback queue; publishes `voice.playing` / `voice.done` with `sink: "discord"`.
6. `audio.ts` — PCM resampling; the WAV writer `wavWrap` and parser `parseWav` come from `@cohost/shared`, and `readWavHeader` is a thin adapter over `parseWav` from `@cohost/shared`.
7. `inject.ts` — `inject.request` (audio) handler with dashboard-origin URL guard.
8. `health.ts` — startup plan decision and `EarsHealth` heartbeat spec.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Startup plans | EARS-START-001 to 006 | 6 | 0 | 0 |
| Discord session | EARS-SESS-001 to 008 | 8 | 0 | 0 |
| Listening and transcription | EARS-HEAR-001 to 008 | 8 | 0 | 0 |
| Audio conversion | EARS-AUD-001 to 004 | 4 | 0 | 0 |
| Playback sink | EARS-PLAY-001 to 009 | 9 | 0 | 0 |
| Fallback line | EARS-FALL-001 to 019 | 19 | 0 | 0 |
| Audio injection | EARS-INJ-001 to 009 | 9 | 0 | 0 |
| Health | EARS-HLTH-001 to 003 | 3 | 0 | 0 |

**Summary:** 66 of 66 specs implemented; 0 gaps; 0 deferred (counts of specs with a test below are from the 2026-11-02 audit; the fallback-line specs each cite a test). 32 of the 46 implemented specs have a test citing them. The 14 without a test are the Discord and plan glue in `discord.ts` / `index.ts` (EARS-START-003, EARS-SESS-001 to 005, EARS-HEAR-001 to 003, EARS-PLAY-001, EARS-PLAY-007, EARS-INJ-009) plus EARS-INJ-003 (wrong kind) and EARS-PLAY-008 (boundary statement). EARS-INJ-004's redirect and non-2xx paths are untested in ears.

## Key Findings

1. **EARS-START-001** excludes only non-injected `speech.heard` in the `off` plan, consistent with EARS-INJ-009 (S16). EARS-START-005 `[x]` covers shutdown in the idle plans.
2. **A failed voice join no longer ends the process.** `createJoiner` (`services/ears/src/session.ts`) retries the join (initial and rejoin) with a delay doubling from 5 s to a 60 s cap, `onFailure` marks `deps.discord` down and the heartbeat `degraded`, and the bus subscription is independent of the join. (EARS-SESS-006, B12)
3. **Injection works before Discord is joined in the `discord` plan.** `startDiscord` establishes the `ears` loop before login; `createEarsHandler` always handles `inject.request` and skips a `voice.utterance` while the voice connection is not ready. The shared loop still awaits the inject handler, so a slow STT call delays `voice.utterance` pickup. (EARS-INJ-007, B13)
4. **Shutdown in the `discord` plan is one sequence.** `index.ts` registers a single `onShutdown` running `stopEars`: Discord teardown, then `bus.stop()`. (EARS-SESS-008, R2)
5. **A given-up line is reported with `voice.failed`, and the queue still has no fetch timeout.** `Playback.giveUp` (`services/ears/src/playback.ts`) publishes `voice.failed` and plays a cached fallback clip when one is eligible (EARS-PLAY-005, EARS-PLAY-006, EARS-FALL-*), replacing the silent skip of decision S15; a hung `httpAudio` fetch (no timeout) still blocks every later utterance, so a hang is never a give-up. Publish failures are logged (EARS-PLAY-009).
6. **Guild/channel come from config.** `voiceTarget` reads `ears.discord.guild_id` / `voice_channel_id`; the env vars are no longer read by ears. (EARS-SESS-007, B19)
7. **`mute` / `pause` are ignored by ears by design.** It never subscribes to `control` (`discord.ts:113`); cortex and salience enforce muting (EARS-PLAY-008, P7).
8. **Decisions evidenced; WAV parser and writer shared** — LLD Decisions rows cite a comment, test, commit, archived OpenSpec design (add-isolated-backends D7, add-test-injection D2/D8) or the owner decision of 2026-11-01; utterance boundary, resampling, STT language and playback format stay `[inferred]`. `readWavHeader` (`services/ears/src/audio.ts`) now wraps the `parseWav` shared with voice (`packages/shared/src/wav.ts`, owner decision of 2026-11-08); `wavWrap` (`packages/shared/src/wav.ts`, EARS-AUD-004) is the one WAV writer, also used by voice's stub engine.

## Work Required

### Must Fix
None: all six gap specs are implemented.

### Should Fix
1. Add a fetch timeout / stuck-playback guard to the playback queue (LLD Open Question 2).
2. Add tests for the remaining `discord.ts` glue (login failure, rejoin on disconnect, per-speaker capture) behind a fake client.

### Nice to Have
3. Make the transcript filter Unicode-aware (`services/ears/src/hearing.ts:44`).
