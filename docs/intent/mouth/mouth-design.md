---
parent: high-level-design
prefix: MOUTH
---

# mouth

> The speaking half of the co-host, separate from the listening half in [ears](../ears/ears-design.md); its specs are in [mouth-specs.md](./mouth-specs.md). The split itself (two services, two Discord bots) is argued in the decision doc [listen-speak-split](../ears/decisions/listen-speak-split.md). HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

mouth is the co-host's speaking module. It is one Node process (`services/mouth`) that plays the co-host's synthesized lines on the **outputs** the owner configures, and says a short pre-generated fallback line when a line cannot play. It does not synthesize ([voice](../voice/voice-design.md) does), does not decide what to say (cortex and salience do) and does not listen ([ears](../ears/ears-design.md) does).

Each output is a **sink** in the audio-sink arbitration protocol owned by voice: it fetches the WAV a `voice.utterance` points at, plays it, and reports `voice.playing` / `voice.done` (and `voice.failed` when it gives up) with `sink` set to the output's name. Today there is one output kind, `discord`: a Discord bot that sits in a voice channel and speaks there. The output table is the seam for more output kinds later (a local audio device, a virtual cable); adding one is a new output adapter inside mouth and a new key under `mouth.outputs`, with no change to voice, cortex or avatar, because the protocol already admits any sink name.

The owner decides where the co-host's voice goes by editing `mouth.outputs` in `config.yaml`: which outputs are on, where each one connects, and how loud each one plays. The dashboard's browser sink is a separate sink, outside mouth (see Outputs and routing).

Design leanings:

- **Outputs are independent.** Each enabled output has its own connection, queue, current item and fallback timer, so a stall or a failure on one never delays another (MOUTH-ROUTE-004).
- **Pure logic is split from the device glue.** The plan choice (`mouthPlan`), the per-output playback queue, the fallback line, the clip cache and the gain take their effects as injected functions so they are unit-tested with fakes; the discord.js glue is the only untested layer, as in ears today.
- **Never exit for a configuration gap.** No enabled output, or a missing `DISCORD_TOKEN`, leaves the process up and idle with an honest heartbeat (MOUTH-START-001, MOUTH-START-002). A login failure with a token present still exits 1 (MOUTH-SESS-001).
- **Device libraries load only when needed.** discord.js and `@discordjs/voice` are imported dynamically only in the `discord` plan (MOUTH-START-003).
- **Playback never depends on the path that just failed.** The fallback line plays from mouth's own prefetched clip cache, never from voice at the moment of failure.

Ownership notes: the `voice.*` schemas belong to [event-bus](../event-bus/event-bus-design.md); the arbitration rules, the virtual sink and the clip generation and routes belong to [voice](../voice/voice-design.md); the `mouth` config section's schema belongs to [config](../config/config-design.md) (CFG-SCH-018, CFG-SCH-020, CFG-USR-011); the heartbeat contract belongs to [control-plane](../control-plane/control-plane-design.md); the Compose service and profile belong to [deployment](../deployment/deployment-design.md).

## Outputs and routing

### Config shape

```yaml
mouth:
  outputs:
    discord:
      enabled: ${MOUTH_DISCORD_ENABLED:-true}   # false = mouth idles (mode off); isolated runs
      guild_id: "${DISCORD_GUILD_ID}"
      voice_channel_id: "${DISCORD_VOICE_CHANNEL_ID}"
      gain_db: 0                                # loudness on this output only; -40..12
  fallback:
    min_interval_ms: 20000     # at most one fallback line per 20 s on an output
```

- `mouth.outputs` is a map from output name to that output's settings. The name is also the `sink` value mouth publishes for the output (MOUTH-ROUTE-001), so `discord` keeps the sink name every consumer already sees.
- The schema knows each output kind's keys. An unknown output name (a typo such as `discrod`) is reported by config's unknown-key warning and ignored, like any unknown key (config Decisions: Unknown keys); the misspelt output is then simply absent.
- `enabled: false` means mouth opens no connection for that output and never claims, plays or gives up a line on it (MOUTH-ROUTE-002). With every output disabled, mouth idles in the `off` plan.
- `gain_db` scales the samples mouth hands that output, for utterances and fallback clips alike, clamped to the 16-bit range (MOUTH-ROUTE-005). It is a per-output trim, so the co-host can be quieter in Discord than on stream; the synthesized voice itself (speed, voice id) is tuned in voice.
- The `mouth` section is optional. A `config.yaml` written before mouth existed loads with the defaults: the Discord output enabled, an empty guild and channel (so the join fails with a message naming the key, MOUTH-SESS-003), gain 0, interval 20000 (CFG-SCH-020).
- The guild and channel are mouth's own keys. They default, through `config.example.yaml`, to the same `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID` ears uses (CFG-USR-011), so out of the box the co-host speaks in the channel she listens to. The owner may point them at another channel or guild.

### How routing meets sink arbitration

The arbitration protocol is unchanged. mouth's outputs are sinks like any other:

| Situation | What happens |
| --- | --- |
| An output is enabled and ready | It queues every `voice.utterance`, claims each with `voice.playing { sink: <name> }` when it starts, and releases with `voice.done` (MOUTH-PLAY-002 to 004) |
| An output is enabled but not connected | It skips each `voice.utterance` (no queue, no claim, no `voice.failed`); voice's virtual sink covers the line unless another sink claims it (MOUTH-ROUTE-003, MOUTH-FALL-013) |
| An output is disabled, or mouth is not running | Nothing from that output; the virtual sink covers the line unless another sink claims it |
| Two outputs, or an output and the dashboard page, are active | Both play and both claim; cortex is released by the first `voice.done`, avatar lip-syncs from the first `voice.playing` (voice LLD, Decisions: sink exclusivity) |
| An output gives up on a line | It publishes `voice.failed { sink: <name> }` and, when eligible, plays a fallback clip under the line's id (Fallback line) |

Because each output has its own queue, two outputs can drift apart in time: a line that queues behind a long line on one output may already be playing on another. That is the same non-exclusivity voice already accepts between Discord and the dashboard page.

### The dashboard sink is not a mouth output

The dashboard's browser page (`?sink=1`, often an OBS Browser Source) is a sink the dashboard owns ([dashboard](../dashboard/dashboard-design.md) audio sink). The owner routes the co-host's voice to it by opening the page where it should play, and switches it with the page's own audio toggle. mouth neither starts it nor gates it, and the `mouth.outputs` table does not list it (Decisions: dashboard sink in the routing table). The dashboard's Services tab shows mouth's health like any service; its per-output state is the heartbeat's `deps` (one key per output, MOUTH-HLTH-001).

## Startup Plans

At boot mouth loads config, creates a `Bus("mouth")`, reads `DISCORD_TOKEN`, and derives a plan with the pure function `mouthPlan(outputs, hasToken)` (MOUTH-START-003):

| Outputs enabled | `DISCORD_TOKEN` | Plan | Discord client | Heartbeat |
| --- | --- | --- | --- | --- |
| none | any | `off` | none | mode `off`, `deps.discord: n/a`, state `ready` at once (MOUTH-START-001) |
| `discord` | unset | `no-token` | none | mode `live`, `deps.discord: down`, state `degraded`, detail `DISCORD_TOKEN is not set` (MOUTH-START-002) |
| `discord` | set | `discord` | yes | mode `live`; `ready` once the voice connection is Ready (MOUTH-SESS-004) |

In the idle plans (`off`, `no-token`) mouth subscribes to nothing, fetches no clips, plays nothing and publishes no `voice.*` event; in `no-token` it logs a warning every 60 s. Shutdown clears that timer and stops the bus (MOUTH-START-004). With more output kinds, the plan generalizes to "the set of enabled outputs that can start"; an output kind that needs no secret never makes the plan `no-token`.

In the `discord` plan mouth creates its consumer group `mouth` with start mode `latest` and starts one loop for `voice.utterance` and `voice.playing` before the Discord login (MOUTH-PLAY-001, MOUTH-START-005). The group is reset to the newest entry on every start, so lines published while mouth was down are never played late. One loop reads both types, because two loops with different type filters in one group would acknowledge and drop each other's events.

Environment and config read by mouth:

| Source | Key | Use |
| --- | --- | --- |
| env | `DISCORD_TOKEN` | plan selection and login of the co-host's Discord bot (MOUTH-SESS-008) |
| env | `VOICE_URL` | via `urls.voice()`: the base of the fallback clip routes; utterance audio comes from each event's `audioUrl` |
| config | `mouth.outputs.discord.{enabled, guild_id, voice_channel_id, gain_db}` | the Discord output (CFG-SCH-020) |
| config | `mouth.fallback.min_interval_ms` (20000) | the storm limit (CFG-SCH-018) |
| env | `COHOST_DATA_DIR` | via `dataDir()`: the clip cache under `<dataDir()>/mouth/fallback-clips` |

## Discord Output

The Discord output is the co-host's own Discord bot, the one viewers see speak. It logs in with `DISCORD_TOKEN` (MOUTH-SESS-008). [ears](../ears/ears-design.md) listens through a second bot of its own (`EARS_DISCORD_TOKEN`), because Discord holds one voice connection per bot per guild and the two halves are separate processes ([listen-speak-split](../ears/decisions/listen-speak-split.md)).

1. **Intents.** `Guilds` and `GuildVoiceStates`. mouth needs no member names, so it does not request the privileged `GuildMembers` intent.
2. **Join.** On the client's `ready` event mouth fetches the guild and channel named by `mouth.outputs.discord.guild_id` and `voice_channel_id` (MOUTH-SESS-003 for empty or non-voice values), joins with `selfDeaf: true, selfMute: false` (MOUTH-SESS-002), and waits up to 20 s for Ready. Self-deafened, the bot receives no audio it would only discard, and the channel shows that the speaking bot does not listen. On Ready it subscribes its audio player to the connection, marks the output ready, sets `deps.discord: ok` and reports `ready` (MOUTH-SESS-004).
3. **Retry and rejoin.** A failed join is logged, reported `degraded` with `deps.discord: down`, and retried with a delay that starts at 5 s and doubles to a 60 s cap until it succeeds; the bus loop keeps running (MOUTH-SESS-006). A disconnect that does not recover within 5 s marks the output not ready, destroys the connection and rejoins after 5 s (MOUTH-SESS-005). The retry loop is the same pure `createJoiner` ears uses, moved to `@cohost/shared`.
4. **Shutdown.** One sequence: stop the clip refresh, destroy the voice connection and the client, then stop the bus (MOUTH-SESS-007).

The player and resampling are the ones ears has today: a WAV of any rate, mono or stereo, 16-bit, becomes 48 kHz stereo s16le PCM by linear interpolation (MOUTH-AUD-001), and `@discordjs/voice` Opus-encodes it as `StreamType.Raw`.

## Playback

Each enabled output has a `Playback` queue: FIFO with one current slot.

- **Intake.** A `voice.utterance` is queued on every enabled output that is ready; an output that is not ready skips it (MOUTH-ROUTE-003). mouth plays every utterance it reads, whatever the mute or pause state: it never subscribes to `control`, because cortex and salience enforce mute and pause upstream (MOUTH-PLAY-008).
- **Play.** The output takes the head, fetches the WAV from `audioUrl`, converts it (MOUTH-AUD-001), applies the output's gain (MOUTH-ROUTE-005), hands it to its player, and **then** publishes `voice.playing { id, sink: <name> }` (MOUTH-PLAY-002, MOUTH-PLAY-003).
- **Finish.** When the player goes idle with an item current, the output publishes `voice.done { id, sink: <name> }` and starts the next item (MOUTH-PLAY-004). A failed `voice.done` publish is logged and the queue continues (MOUTH-PLAY-009).
- **Give up.** If the fetch, the conversion or the hand-over to the player throws before any audio started, the output logs `playback failed` and gives up on that line (MOUTH-PLAY-005): exactly one `voice.failed { id, sink: <name>, reason }` (MOUTH-PLAY-006), a fallback clip in its place when one is eligible, and the next item. A player error after audio started is not a give-up; it is logged (MOUTH-PLAY-007) and ends in Idle like any line.

The queue is unbounded and the fetch has no timeout; both are carried over from ears (Open Questions 1).

## Fallback Line

When an output cannot play a line, the co-host says something funny aloud instead of going silent: a short line such as "Error: unable to play line.", picked at random from the owner's list (`voice.fallback.lines`). voice pre-generates one clip per line in the co-host's TTS voice and serves the set over HTTP ([voice](../voice/voice-design.md) Fallback Clips). mouth prefetches the set into its own cache, so playing a clip never touches voice or TTS at the moment of failure. mouth never synthesizes clips. The fallback replaces a line that already passed the speaking gates (HLD tenet 4): it carries the given-up line's id and takes that line's place in turn-taking.

Owner decisions (carried over unchanged from when the feature lived in ears):

- The fallback is said aloud, chosen at random from a configurable list.
- voice generates and serves the clips; the playing service prefetches and caches them. No file store is shared between services.
- Clips regenerate automatically when the list or the voice settings change.
- The transcript keeps the fallback as her line, plus a note that the intended line failed; her next reply gets a hint (default 1 in 4) and decides in character whether to riff on it.
- The giving-up output reports `voice.failed` for the id, claims the id with `voice.playing` when the fallback starts and publishes `voice.done` when it ends.
- When no clip plays, voice waits out the 1.5 s claim window and then releases cortex.
- No fallback when another real sink already claimed the line.
- At most one fallback per 20 s on an output.
- avatar lip-syncs the failed line's envelope during the clip, accepted for now; memory keeps the failed line as said.

The fallback stays with the sink that gives up, so it lives in mouth, beside the playback queue it serves.

Ownership across segments:

| Part | Segment |
| --- | --- |
| Giving up, choosing and playing a clip, the storm limit, the clip cache | mouth (MOUTH-PLAY-005, MOUTH-PLAY-006, MOUTH-FALL-*) |
| `voice.failed` semantics in arbitration; clip generation, fingerprint, store and HTTP routes | [voice](../voice/voice-design.md) (VOICE-SINK-010 to 013, VOICE-CLIP-*) |
| `voice.failed` payload schema | [event-bus](../event-bus/event-bus-design.md) (BUS-EVT-022) |
| Phrase list, storm interval, acknowledgement chance, data directory | [config](../config/config-design.md) (CFG-SCH-017, CFG-SCH-018, CFG-SCH-019, CFG-USR-009, CFG-USR-010, CFG-DIR-006, CFG-DIR-007) |
| Transcript entry for a fallback | [working-memory](../working-memory/working-memory-design.md) (WM-PUSH-007, WM-PUSH-008, WM-WIN-007, WM-TRANS-010) |
| Acknowledgement hint | [cortex](../cortex/cortex-design.md) (CTX-EVT-008, CTX-FALL-*) |

### Giving up

An output gives up on a queued line when fetching its audio fails, converting it fails, or handing it to the player throws before any audio started (MOUTH-PLAY-005). It publishes exactly one `voice.failed` with its own `sink` name and the error text as `reason` (MOUTH-PLAY-006). The event carries `fallback { clip, text }` exactly when a fallback clip is playing for that id (MOUTH-FALL-011).

A line an output never took is not given up: an output that is not connected skips the line and publishes no `voice.failed` for it (MOUTH-FALL-013); the idle plans read no `voice.utterance` at all.

### The clip cache

mouth keeps the clips in memory, already parsed, and mirrors them to `<dataDir()>/mouth/fallback-clips`, which belongs to mouth alone (MOUTH-FALL-012). One cache serves every output.

- **At startup** (the `discord` plan only), mouth loads the mirror into memory before its first manifest request; an unreadable manifest or a missing or failing clip means an empty cache and a warning (MOUTH-FALL-018).
- **Refresh.** `GET <urls.voice()>/fallback/manifest.json` at startup and every 60 s (MOUTH-FALL-014). On a new `fingerprint` mouth downloads every listed clip, checks each one's byte count, SHA-256 and that it parses as a 16-bit WAV, and only when all pass replaces the in-memory set and the mirror at once; the mirror is written to a temporary directory and renamed into place (MOUTH-FALL-015). A 200 manifest with no clips empties the cache.
- **Voice unreachable, 404 or any non-200** keeps the cache unchanged (MOUTH-FALL-016). A failed or mismatching clip download abandons that refresh, deletes the partial download and keeps the previous set (MOUTH-FALL-017). A mirror that cannot be written still leaves the new set in memory, with a warning (MOUTH-FALL-019).

In Compose the data directory is the container's filesystem with no volume: it survives a restart, not a recreate, after which mouth re-fetches from voice.

### Choosing and playing a clip

On a give-up, in the same queue slot and before the next queued line:

1. **Another sink already has it.** mouth reads `voice.playing` on its loop and, for the newest 50 utterance ids, remembers which real sinks claimed each id (MOUTH-FALL-010). If a real sink other than the giving-up output claimed the id before the give-up (the dashboard page, or another mouth output), the line is already being heard there, so no fallback (MOUTH-FALL-009). A claim after the fallback started does not stop it.
2. **Storm limit.** If this output last handed a fallback clip to its player less than `mouth.fallback.min_interval_ms` ago, no fallback (MOUTH-FALL-007). `voice.failed` still goes out for every give-up.
3. **Use the cache.** The clip comes from the in-memory cache, with no network or disk read at that moment (MOUTH-FALL-004). An empty cache, or one where every clip is marked bad, means no fallback (MOUTH-FALL-005).
4. **Pick.** Uniformly at random among clips not marked bad, excluding the phrase this output started last when another eligible clip exists (MOUTH-FALL-006).
5. **Play.** Convert as an utterance (MOUTH-AUD-001), apply the output's gain, hand to the player (MOUTH-FALL-001). A clip that fails conversion means no fallback, a warning naming the clip, and the clip is not picked again until the cache's `fingerprint` changes; a player throw means no fallback and marks nothing; there is no second try (MOUTH-FALL-008).
6. **Report.** Once the player has the clip: `voice.playing { id, sink: <name> }` for the given-up id, then `voice.failed` with `fallback` (MOUTH-FALL-002). The clip is then the current item; on Idle the output publishes `voice.done` for the id and moves on (MOUTH-FALL-003).

Bad-clip marks, the last-started phrase and the storm timer live in memory, per output, and reset on restart.

### Fallback edge cases

| Case | Handling | Spec |
| --- | --- | --- |
| No clips anywhere (fresh install, voice in `stub`, voice down at mouth's first start, empty phrase list) | no fallback; `voice.failed` without `fallback`; voice releases cortex when the claim window closes | MOUTH-FALL-005, MOUTH-FALL-016, VOICE-SINK-011 |
| Voice down at mouth startup with a mirror present | plays from the mirrored set and keeps polling | MOUTH-FALL-018, MOUTH-FALL-016 |
| Stale cache after voice regenerated | the next poll (within 60 s) replaces the set | MOUTH-FALL-015 |
| Partial download or checksum mismatch | refresh abandoned, previous set kept, retried next poll | MOUTH-FALL-017 |
| Mirror corrupt at startup / not writable | empty cache and a warning / new set used from memory and a warning | MOUTH-FALL-018, MOUTH-FALL-019 |
| Clip fails conversion at play time | no fallback; warning naming the clip; not picked again until the set changes | MOUTH-FALL-008 |
| The fallback clip itself fails to play | no `voice.playing`; `voice.failed` without `fallback`; voice releases cortex when the window closes | MOUTH-FALL-008, MOUTH-PLAY-007 |
| Output not connected | the line is skipped, not given up; no `voice.failed`, no fallback | MOUTH-FALL-013, MOUTH-ROUTE-003 |
| Failure storm (voice down, every queued line fails) | at most one fallback per 20 s per output; every failure still publishes `voice.failed` | MOUTH-FALL-007, MOUTH-PLAY-006 |
| Dashboard page or another output already claimed the id | no fallback on this output; `voice.failed` without `fallback` | MOUTH-FALL-009 |
| Fallback claim arrives after the 1.5 s window | voice's late-claim rule cancels the pending virtual `voice.done` while voice still holds the audio; if the audio was evicted, cortex can be released while the clip plays and the next line queues behind it on the same output | VOICE-SINK-007, VOICE-SINK-008 |
| Hung fetch | never a give-up, because the fetch has no timeout (Open Questions 1) | — |

## Health

`MouthHealth` is the `HeartbeatSpec` for `service: "mouth"` (MOUTH-HLTH-001):

- `mode`: `off` in the `off` plan, else `live`.
- `deps`: one key per output kind under `mouth.outputs` (today `discord`): `n/a` for a disabled output, `ok` only while that output's connection is ready, `down` otherwise, so `no-token` is always `down` (MOUTH-HLTH-002).
- State: `starting` until the first join attempt resolves; `ready` on Ready; `degraded` with a detail while a join fails (MOUTH-SESS-006); `startHeartbeat` turns any `down` dep on a `ready` service into `degraded`.

mouth has no `voice` dependency in its heartbeat: an unreachable voice shows up as give-ups and an unchanged clip cache, and voice reports its own health.

## Running Without the Other Half

ears and mouth share no process, connection, consumer group or file, so either runs, restarts or fails without the other.

| Situation | Listening (ears) | Speaking (mouth) |
| --- | --- | --- |
| Both up, same channel | hears every human; ignores both bots' audio (EARS-HEAR-001) | speaks in the channel |
| mouth down or restarting | unaffected | lines published meanwhile are covered by the virtual sink or the dashboard page and never replayed (`latest`); no `voice.failed`, no fallback; after restart the clip cache comes from the mirror |
| ears down or restarting | `speech.heard` and audio injection stop; nothing replays | unaffected, including the fallback line |
| Only mouth deployed (profile `mouth` without `ears`) | — | the co-host speaks in Discord but does not hear it; chat and the dashboard still drive her |
| Only ears deployed | hears Discord | no Discord output; the dashboard page or the virtual sink times every line |
| ears and mouth in different channels or guilds | hears its channel | speaks in its own; allowed, the owner's choice |
| voice down | unaffected | every line gives up; fallback clips play from the cache, at most one per 20 s |

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Service name | `mouth` | `voice` (rename); `speaker`; `playback`; `audio-out`; `discord-sink` | `voice` is the TTS and arbitration service, and its name is in every `voice.*` event. `speaker` already means the human who spoke (`speech.heard.speaker`). `playback` and `audio-out` describe one mechanism, not a part of the co-host. `discord-sink` names one output, which the module outgrows. `mouth` fits the senses-and-body model beside `ears` and `eyes`. Its one collision is avatar's lip-sync parameter `mouthOpen`, which lives inside avatar and never appears on the bus. |
| A process of its own | mouth is a separate service from ears and from voice | One process with listening and speaking modules; speaking folded into voice | Owner direction: listening and speaking are separate modules the owner tunes and routes separately. A separate process restarts, fails and is deployed without touching listening. Folding outputs into voice would put playback on the process whose failure the fallback line exists to survive, and would end voice's rule that it plays nothing. Full comparison: [listen-speak-split](../ears/decisions/listen-speak-split.md). |
| Discord identity | The co-host's existing bot (`DISCORD_TOKEN`) speaks; ears listens through a second bot (`EARS_DISCORD_TOKEN`) | One bot shared through a session broker; ears keeps `DISCORD_TOKEN` and mouth gets a new bot | Discord holds one voice connection per bot per guild, so two processes need two bots or a broker that streams audio between processes ([listen-speak-split](../ears/decisions/listen-speak-split.md)). The bot viewers see speak should stay the one they know, and losing listening on an upgrade is milder than losing speech. |
| Routing table | `mouth.outputs.<name>` map with per-output `enabled`, target and `gain_db` | One `mouth.output` enum; routing by a field on `voice.utterance` set by voice | A map lets several outputs run at once and keeps each output's settings together. Routing on the event would make voice decide where audio goes, which is the speaking module's job, and would change the protocol for every consumer. |
| Sink name | The output's name; the Discord output keeps `discord` | `mouth`; `mouth:discord` | Every existing consumer (voice, avatar, cortex, the dashboard feed, working-memory) and the fallback claim check already treat `discord` as the Discord sink; one name per output keeps two outputs distinguishable. |
| Per-output state | Own queue, current item, storm timer and last phrase per output | One queue feeding all outputs in lockstep; one storm timer for mouth | Lockstep would let one slow or broken output stall the others. The storm limit exists to keep one audience from hearing a run of fallback lines, and each output reaches its own audience. |
| Output loudness | `gain_db` per output, applied by mouth to utterances and clips, clamped | No per-output level; Discord's per-user volume only | The owner tunes where and how loud the co-host is heard. Discord's per-user volume is set by each listener, not by the owner. |
| Dashboard sink in the routing table | Not listed; the page stays the dashboard's sink, switched by where it is opened and its own toggle | `mouth.outputs.dashboard.enabled` read by the dashboard | The page is opened deliberately in each place it should play, so a config flag would duplicate its toggle, and the host-run dashboard would have to read and obey another service's config section. |
| Unknown output names | The unknown-key warning, as for every config key | Fail the config load for an unknown output (`.strict()` on `mouth.outputs`) | Config's project-wide rule is to warn and load; failing every service's config load over one mouth typo would stop the whole stack, while the warning names the key. |
| Self-deafen | The Discord output joins self-deafened | Join undeafened, as the combined ears did | mouth discards received audio; deafened, Discord sends none and the channel shows the bot only speaks. |
| Missing `mouth` section | Optional with defaults; an empty target fails the join with a message naming the key | Required section; inherit `ears.discord.*` when mouth's keys are empty | A `config.yaml` written before mouth existed still loads, and the heartbeat says exactly what to add. Inheriting another service's keys would couple the two halves the split separates. |
| Failed playback | Give up: report `voice.failed` and say a pre-generated fallback line | Skip silently; report `voice.done` with an error sink | Owner decision: dead air after a glitch is worse than owning it; the report lets voice, avatar and cortex stop waiting. |
| Where fallback audio comes from | Clips voice pre-generates and serves over HTTP, prefetched into mouth's own cache | Synthesize at failure; a canned WAV in the repo; a directory shared with voice | Owner decision: playback must not depend on the path that just failed and must sound like the co-host. A shared directory would break HLD tenet 1. |
| Fallback text source | The manifest voice serves, cached with the clips | mouth reads `voice.fallback.lines` itself | mouth reports the text of the audio it actually plays, even while a regeneration is pending. |
| Refreshing the cache | Poll the manifest at startup and every 60 s; download on a fingerprint change; swap the whole set | A bus event per new set; fetch on every give-up; startup only | A small poll needs no new event and covers voice restarts and regenerations; fetching at give-up would put the failing path back in. |
| Cache persistence | Memory, mirrored to mouth's data directory; no Compose volume | Memory only; a named volume | The mirror covers a mouth restart while voice is down; voice can always serve the clips again after a recreate. |
| Clip choice | Uniform random, never the phrase started last on that output when there is a choice | Round-robin; weighted | Random keeps it fresh; avoiding the previous line stops the same joke twice in a row. |
| A bad clip | Skip this give-up, mark the clip bad until the set changes, no second try | Try the next clip; mark bad forever | One attempt keeps the queue moving; marks reset when voice regenerates, the likely fix. |
| Failed join | Log, `degraded` with `deps.discord: down`, keep the loop, retry 5 s doubling to 60 s | Exit and let the supervisor restart | Owner decision 2026-11-01 (carried from ears): a wrong channel is an operational fault, not a crash loop. Login failure still exits 1. |
| Start mode | `latest` on group `mouth` | `resume` | Owner decision 2026-11-01 (project-wide): stale lines are never played late. |
| Mute and pause | mouth does not subscribe to `control` | Gate playback on mute | Owner decision 2026-11-01 (project-wide): only cortex and salience see mute and pause; an operator `say` must still be heard. |
| Publish failures | Logged; the queue continues | Unhandled rejection | Owner decision 2026-11-01 (project-wide). |

## Open Questions & Future Decisions

1. **No stuck-playback guard.** Each output's queue is unbounded and the WAV fetch has no timeout; a hung fetch, or a player that never reaches Idle, blocks that output's later lines and is never a give-up. cortex's `speaking_timeout_ms` is the only backstop. Carried from ears.
2. **Untested glue.** The discord.js layer (login, join, rejoin, player events) has no test, as in ears.
3. **Native dependencies.** `@discordjs/voice` loads `libsodium-wrappers` (transport encryption), `@snazzah/davey` (DAVE end-to-end encryption) and `opusscript` (Opus encode) itself; mouth carries them as ears does. Unverified against real Discord.
4. **Avatar during a fallback clip.** avatar lip-syncs the given-up line's envelope while the clip plays. Accepted for now (owner decision).
5. **Long-term memory keeps the intended line.** memory stores every `brain.say` when published, so a failed line is remembered as said. Accepted (owner decision).

### Deferred decisions

1. **More output kinds.** A local audio device, a virtual audio cable, or another voice platform. Each is an adapter inside mouth and a key under `mouth.outputs`; the per-output queue, gain, health key and sink name already generalize.
2. **Routing per line.** Sending some lines to some outputs only (for example, reflexes to Discord but not to the stream). Needs a routing field on `brain.say` or a rule in mouth; deferred until an output kind needs it.
3. **Re-routing without a restart.** Config is read once per process, so a routing change takes a mouth restart (the Services tab's Restart). A live toggle from the dashboard would need a runtime routing API.

## References

Files in this segment:

- `services/mouth/src/index.ts` (plan, wiring, shutdown), `discord.ts` (the Discord output), `session.ts` (output target, bus loop and handler, shutdown, idle plans), `playback.ts`, `fallback.ts`, `audio.ts` (WAV to 48 kHz PCM, gain), `health.ts` (plan, token, `MouthHealth`)
- `services/mouth/test/*.test.ts`; `services/voice/test/mouth-sync.test.ts` (voice's clip routes read by mouth's clip sync)
- `packages/shared`: `createJoiner` (the join retry loop shared with ears)

Other segments (arrow shows direction):

- mouth -> [event-bus](../event-bus/event-bus-design.md): publishes `voice.playing`, `voice.done`, `voice.failed`, heartbeats; consumes `voice.utterance`, `voice.playing` (group `mouth`, start `latest`).
- mouth -> [voice](../voice/voice-design.md) HTTP: fetches `audioUrl` and the clip routes (`/fallback/manifest.json`, `/fallback/<name>`).
- mouth <- [voice](../voice/voice-design.md): owns the arbitration protocol; each mouth output is a sink.
- mouth -> [config](../config/config-design.md): `loadConfig` (`mouth.*`), `urls.voice()`, `dataDir()`, `env()`.
- mouth -> [control-plane](../control-plane/control-plane-design.md): heartbeat contract; manifest unit `mouth` with group `mouth` and isolated preset `MOUTH_DISCORD_ENABLED=false`.
- mouth -> [deployment](../deployment/deployment-design.md): Compose service `mouth` in profile `mouth`.
- mouth -> [avatar](../avatar/avatar-design.md), [cortex](../cortex/cortex-design.md), [working-memory](../working-memory/working-memory-design.md): consumers of the `voice.*` events it publishes.
- mouth <-> [ears](../ears/ears-design.md): no runtime link; a second Discord bot, so both can sit in one channel.
- mouth <-> [dashboard](../dashboard/dashboard-design.md): the dashboard page is another sink; the dashboard shows mouth's heartbeat.

External: discord.js 14, `@discordjs/voice`.

EARS specs: [mouth-specs.md](./mouth-specs.md).
