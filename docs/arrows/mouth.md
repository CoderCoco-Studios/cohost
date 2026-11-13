# Arrow: mouth

The co-host's speaking module: plays `voice.utterance` on the outputs the owner routes it to (a connector sink such as `discord`, the test-only `dryrun`, a rotating `file` archive and an `http` push), one sink per output, and says a pre-generated fallback line when a line cannot play. mouth holds no Discord client or token; the Discord output writes frames to `audio.out.discord` and the Discord connector ([connections](connections.md)) plays them.

## Status

**AUDITED**, 2026-11-12: all 73 specs are `[x]`. The service is wired into the manifest, Compose (profile `mouth`, off by default) and the dashboard's unit list. Design: [LLD](../intent/mouth/mouth-design.md); decision records: [listen-speak-split](../intent/ears/decisions/listen-speak-split.md), [connector-protocol](../intent/connections/decisions/connector-protocol.md).

## Cross-segment lines

config CFG-SCH-018, CFG-SCH-020, CFG-SCH-031, CFG-ISO-001, CFG-ISO-004, CFG-USR-009, CFG-USR-011, CFG-USR-014; control-plane CTRL-MANIFEST-001 to 003, CTRL-HEALTH-005; deployment DEPLOY-COMPOSE-001, 004, 017, 020, DEPLOY-README-004, 005; dashboard DASH-ROUTE-*; connections CONN-DISC-*, CONN-AUD-*.

## Edge audit

1. **Not hearing herself.** The Discord connector ignores bot accounts, so her own lines never become `speech.heard` (CONN-DISC-007). Her voice leaking through a human's microphone is unfiltered.
2. **Sink name continuity.** MOUTH-ROUTE-001 names the Discord output `discord`; the fallback claim check (MOUTH-FALL-009) excludes only the giving-up output's own name.
3. **Two outputs and the early release.** VOICE-SINK-011 releases cortex at the end of the claim window when a `voice.failed` without `fallback` arrives and nothing has claimed. With two outputs, one giving up and the other starting late, cortex can be released while the second still plays, and the next line can overlap on the first output. This is the non-exclusivity between sinks (voice LLD Decisions).
4. **Per-output state.** MOUTH-ROUTE-004 makes the storm limit, the last phrase and the bad-clip marks per output; MOUTH-FALL-005 to 008 say "for that output".
5. **Readiness at intake.** MOUTH-ROUTE-003 judges an output's readiness when the `voice.utterance` is read; a line queued on a ready output that then disconnects ends through the player's events or the stuck-playback guard (MOUTH-PLAY-011).
6. **Isolation preset.** CTRL-MANIFEST-003 (`MOUTH_DISCORD_ENABLED=false`), CFG-ISO-004 (the placeholder) and DEPLOY-COMPOSE-017 (the pass-through) name one variable; an isolated mouth is plan `off`, mode `off`, `ready` (MOUTH-START-001).
7. **Launch and profiles.** CTRL-STACK-002 starts mouth only when `COMPOSE_PROFILES` names it; a mouth with no connector reports a degraded dependency but its heartbeat is fresh, so the container is healthy (DEPLOY-HC-001).
8. **Restart replay.** The `mouth` group starts at the newest entry (MOUTH-START-005).
9. **Injection.** `inject.request` keeps target `ears` (BUS-EVT-006); mouth takes no injection.
10. **Gain at zero.** MOUTH-ROUTE-005 applies only when `gain_db` is not 0, so the default path is bit-identical to unamplified playback.

## Barge-in and echo gate: built

Built with tests (barge-in and echo-gate slice); the deferred dynamic-speech ideal stays `[D]`. MOUTH-STOP-001 to MOUTH-STOP-010 are `[x]` (flush queues, stop the line, report it interrupted with spoken and unsaid text); MOUTH-POS-001 is `[D]` (playback position). Spec file totals: 84 specs, 83 `[x]`, 0 `[ ]`, 1 `[D]`. Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (Approach; Segments table; Audio sink arbitration; Key Design Decisions: Listening and speaking)

### LLD
- docs/intent/mouth/mouth-design.md

### EARS
- docs/intent/mouth/mouth-specs.md (84 specs: 73 `[x]`, 10 `[ ]`, 1 `[D]`)

### Tests
- services/mouth/test/*.test.ts (audio, connector output, dryrun, fallback, guard, health, routing, outputs, playback, session, `no-discord.test.ts` guarding that no Discord client or token is referenced)
- services/voice/test/mouth-sync.test.ts (voice's real clip service read by mouth's real clip sync)

### Code
- services/mouth/src/{index,mouth,session,routing,playback,fallback,clips,audio,health,timed}.ts
- services/mouth/src/{connector-output,dryrun,file-output,http-output}.ts
- packages/config/src/schema.ts (the `mouth` section: CFG-SCH-020), config/config.example.yaml (CFG-USR-011, CFG-ISO-004, CFG-USR-009)

## Architecture

**Purpose:** Put the co-host's synthesized voice on every output the owner routes it to, report each output as a sink, and cover a failed line with a spoken fallback.

**Key Components:**
1. `index.ts` / `mouth.ts`: the plan, heartbeat and one shutdown.
2. `session.ts`, `routing.ts`: the `mouth` loop (`voice.utterance`, `voice.playing`) and routing to outputs.
3. `playback.ts`: one queue per output; claim, done, give-up.
4. `fallback.ts`, `clips.ts`: clip cache, mirror, manifest refresh, claim memory, per-output choice, storm limit and bad marks.
5. `audio.ts`: WAV to 48 kHz stereo PCM, gain.
6. `connector-output.ts`, `dryrun.ts`, `file-output.ts`, `http-output.ts`: the outputs.
7. `health.ts`: the plan and `MouthHealth` (one dependency per output).

## Spec Coverage

All 73 specs are implemented and carry a test `@spec` annotation. `node scripts/lid-check.mjs` finds no reverse orphans.

## Work Required

None.
