# Arrow: mouth

The co-host's speaking module: plays `voice.utterance` on the outputs the owner routes it to (a connector sink such as `discord`, the test-only `dryrun`, a rotating `file` archive and an `http` push), one sink per output, and says a pre-generated fallback line when a line cannot play. mouth holds no Discord client or token; the Discord output writes frames to `audio.out.discord` and the Discord connector ([connections](connections.md)) plays them.

## Status

**#372 settings-store design (docs only, not built):** 101 specs: 100 `[x]`, 0 `[ ]`, 1 `[D]`; MOUTH-LIVE-005 reworded ([settings-store.md](settings-store.md)). The status paragraphs below describe the code before that design.

Built since the one-place configuration design ([decision](../decisions/config-in-one-place.md)): mouth uses no Discord token key (MOUTH-CONN-001). Total 101 specs: 100 `[x]`, 0 `[ ]`, 1 `[D]`.

**AUDITED**, 2026-11-12, counts recomputed at #198: 101 specs, 100 implemented (`[x]`), 0 gaps, 1 deferred (`[D]`: MOUTH-POS-001, playback position). The service is wired into the manifest, Compose (profile `mouth`, off by default) and the dashboard's unit list. Design: [LLD](../intent/mouth/mouth-design.md); decision records: [listen-speak-split](../intent/ears/decisions/listen-speak-split.md), [connector-protocol](../intent/connections/decisions/connector-protocol.md).

## Cross-segment lines

config CFG-SCH-018, CFG-SCH-020, CFG-SCH-031, CFG-ISO-001, CFG-ISO-004, CFG-USR-009, CFG-USR-011, CFG-USR-014; control-plane CTRL-MANIFEST-001 to 003, CTRL-HEALTH-005; deployment DEPLOY-COMPOSE-001, 004, 017, 020, DEPLOY-README-004, 005; dashboard DASH-ROUTE-*; connections CONN-DISC-*, CONN-AUD-*.

## Edge audit

1. **Not hearing herself.** The Discord connector ignores bot accounts, so her own lines never become `speech.heard` (CONN-DISC-007). Her voice leaking through a human's microphone is unfiltered.
2. **Sink name continuity.** MOUTH-ROUTE-001 names the Discord output `discord`; the fallback claim check (MOUTH-FALL-009) excludes only the giving-up output's own name.
3. **Two outputs and the early release.** VOICE-SINK-011 releases cortex at the end of the claim window when a `voice.failed` without `fallback` arrives and nothing has claimed. With two outputs, one giving up and the other starting late, cortex can be released while the second still plays, and the next line can overlap on the first output. This is the non-exclusivity between sinks (voice LLD Decisions).
4. **Per-output state.** MOUTH-ROUTE-004 makes the storm limit, the last phrase and the bad-clip marks per output; MOUTH-FALL-005 to 008 say "for that output".
5. **Readiness at intake.** MOUTH-ROUTE-003 judges an output's readiness when the `voice.utterance` is read; a line queued on a ready output that then disconnects ends on schedule with `voice.done` (MOUTH-CONN-005) or through the stuck-playback guard (MOUTH-PLAY-011).
6. **Isolation preset.** CTRL-MANIFEST-003 (`MOUTH_DISCORD_ENABLED=false`), CFG-ISO-004 (the literal default), CFG-ISO-007 (the override by key path) and DEPLOY-COMPOSE-017 (the `COHOST_ISOLATION` pass-through) name one override; an isolated mouth is plan `off`, mode `off`, `ready` (MOUTH-START-001).
7. **Launch and profiles.** CTRL-STACK-002 starts mouth only when `COMPOSE_PROFILES` names it; a mouth with no connector reports a degraded dependency but its heartbeat is fresh, so the container is healthy (DEPLOY-HC-001).
8. **Restart replay.** The `mouth` group starts at the newest entry (MOUTH-START-005).
9. **Injection.** `inject.request` keeps target `ears` (BUS-EVT-006); mouth takes no injection.
10. **Gain at zero.** MOUTH-ROUTE-005 applies only when `gain_db` is not 0, so the default path is bit-identical to unamplified playback.

## Barge-in and echo gate

MOUTH-STOP-001 to MOUTH-STOP-010 flush queues, stop the line and report it interrupted with spoken and unsaid text; MOUTH-POS-001 is `[D]` (playback position). Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (Approach; Segments table; Audio sink arbitration; Key Design Decisions: Listening and speaking)

### LLD
- docs/intent/mouth/mouth-design.md

### EARS
- docs/intent/mouth/mouth-specs.md (101 specs: 100 `[x]`, 0 `[ ]`, 1 `[D]`)

### Tests
- services/mouth/test/{audio,clause-outputs,clause-routing,clause-stop,clauses,connector-output,dryrun,fallback,guard,health,mouth,no-discord,outputs,playback,routing,session,stop}.test.ts

### Code
- services/mouth/src/{index,mouth,session,routing,playback,fallback,clips,audio,health,timed}.ts
- services/mouth/src/{connector-output,dryrun,file-output,http-output}.ts

## Architecture

**Purpose:** Put the co-host's synthesized voice on every output the owner routes it to, report each output as a sink, and cover a failed line with a spoken fallback.

**Key Components:**
1. `index.ts` / `mouth.ts`: the plan, heartbeat and one shutdown.
2. `session.ts`, `routing.ts`: the `mouth` loop (`voice.utterance`, `voice.playing`, `voice.stop`, `control`) and routing to outputs.
3. `playback.ts`: one queue per output; claim, done, give-up.
4. `fallback.ts`, `clips.ts`: clip cache, mirror, manifest refresh, claim memory, per-output choice, storm limit and bad marks.
5. `audio.ts`: WAV to 48 kHz stereo PCM, gain.
6. `connector-output.ts`, `dryrun.ts`, `file-output.ts`, `http-output.ts`: the outputs.
7. `health.ts`: the plan and `MouthHealth` (one dependency per output).

## Spec Coverage

| IDs | Topic | Specs | Markers |
| --- | --- | --- | --- |
| MOUTH-START-001 to 006 | startup plans | 5 | 5 `[x]` |
| MOUTH-CONN-001 to 005 | connector sink, no Discord client | 5 | 5 `[x]` |
| MOUTH-ROUTE-001 to 008 | routing, gain | 8 | 8 `[x]` |
| MOUTH-PLAY-001 to 012 | playback queue, give-up, guard | 12 | 12 `[x]` |
| MOUTH-CLAUSE-001 to 017 | clauses of a streamed line, final, stop between clauses | 17 | 17 `[x]` |
| MOUTH-STOP-001 to 010 | stop and interrupted reporting | 10 | 10 `[x]` |
| MOUTH-POS-001 | playback position | 1 | 1 `[D]` |
| MOUTH-AUD-002 | audio conversion | 1 | 1 `[x]` |
| MOUTH-DRY-001 to 005 | dryrun output | 5 | 5 `[x]` |
| MOUTH-FILE-001 to 003 | file output | 3 | 3 `[x]` |
| MOUTH-HTTP-001 to 006 | http output | 6 | 6 `[x]` |
| MOUTH-SINK-001 | file and http outputs: no fallback, no gain | 1 | 1 `[x]` |
| MOUTH-LIVE-001 to 006 | live routing | 6 | 6 `[x]` |
| MOUTH-FALL-001 to 019 | fallback clips | 19 | 19 `[x]` |
| MOUTH-HLTH-001, 002 | health | 2 | 2 `[x]` |

## Work Required

None.
