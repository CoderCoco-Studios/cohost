---
parent: high-level-design
prefix: MOUTH
---

# mouth

> The speaking half of the co-host, separate from the listening half in [ears](../ears/ears-design.md); its specs are in [mouth-specs.md](./mouth-specs.md). The split itself is argued in the decision doc [listen-speak-split](../ears/decisions/listen-speak-split.md); Discord is reached through the Discord connector of [connections](../connections/connections-design.md), argued in [connector-protocol](../connections/decisions/connector-protocol.md). HLD: [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

mouth is the co-host's speaking module. It is one Node process (`services/mouth`) that plays the co-host's synthesized lines on the **outputs** the owner configures, and says a short pre-generated fallback line when a line cannot play. It does not synthesize ([voice](../voice/voice-design.md) does), does not decide what to say (cortex and salience do) and does not listen ([ears](../ears/ears-design.md) does).

Each output is a **sink** in the audio-sink arbitration protocol owned by voice: it fetches the WAV a `voice.utterance` points at, plays it, and reports `voice.playing` / `voice.done` (and `voice.failed` when it gives up) with `sink` set to the output's name. There are four output kinds: `discord` (a connector sink: mouth writes the line's audio to `audio.out.discord` and the Discord connector plays it in the voice channel), `file` (appends each line's WAV to a bounded rotating directory under the data directory), `http` (POSTs each line's WAV to a configured URL) and the test-only `dryrun`. The output table is the seam for more kinds (a local audio device, a virtual cable); adding one is a new output adapter inside mouth and a new key under `mouth.outputs`, with no change to voice, cortex or avatar, because the protocol already admits any sink name.

The owner decides where the co-host's voice goes by editing `mouth.outputs` in `config.yaml`: which outputs are on, where each one connects, and how loud each one plays. A running mouth can also be re-routed without a restart through a bus command (Live routing); that override lasts until the next restart. The dashboard's browser sink is a separate sink, outside mouth (see Outputs and routing).

Design leanings:

- **Outputs are independent.** Each enabled output has its own connection, queue, current item and fallback timer, so a stall or a failure on one never delays another (MOUTH-ROUTE-004).
- **Pure logic is split from the device glue.** The plan choice (`mouthPlan`), the per-output playback queue, the fallback line, the clip cache and the gain take their effects as injected functions so they are unit-tested with fakes; the frame writer is the only layer that needs a Redis stream and a fake connector to test.
- **Never exit for a configuration gap.** No enabled output leaves the process up and idle with an honest heartbeat (MOUTH-START-001). A connector that is not present is an output that is not ready, not an exit (MOUTH-CONN-003).
- **No Discord library in mouth.** The bot, the voice connection and the Opus encoding belong to the Discord connector, so mouth carries no gateway client, no native voice dependency and no Discord token (MOUTH-CONN-001).
- **Playback never depends on the path that just failed.** The fallback line plays from mouth's own prefetched clip cache, never from voice at the moment of failure.

Ownership notes: the `voice.*` schemas belong to [event-bus](../event-bus/event-bus-design.md); the arbitration rules, the virtual sink and the clip generation and routes belong to [voice](../voice/voice-design.md); the `mouth` config section's schema belongs to [config](../config/config-design.md) (CFG-SCH-018, CFG-SCH-020, CFG-USR-011); the heartbeat contract belongs to [control-plane](../control-plane/control-plane-design.md); the Compose service and profile belong to [deployment](../deployment/deployment-design.md).

## Outputs and routing

### Config shape

```yaml
mouth:
  outputs:
    discord:
      enabled: ${MOUTH_DISCORD_ENABLED:-true}   # a connector sink (the Discord connector plays it); false = no Discord output; isolated runs
      gain_db: 0                                # loudness on this output only; -40..12
    dryrun:
      enabled: ${MOUTH_DRYRUN_ENABLED:-false}   # test-only output: plays nothing, reports as a sink (Dry-run output)
      fail_every: 0                             # n > 0: give up on every n-th line
    file:
      enabled: ${MOUTH_FILE_ENABLED:-false}     # appends each line's WAV to a rotating directory (File output)
      dir: mouth/outputs                        # relative to the data directory; no absolute path, no `..`
      max_files: 100                            # the newest this many files are kept
    http:
      enabled: ${MOUTH_HTTP_ENABLED:-false}     # POSTs each line's WAV to `url` (HTTP output)
      url: "${MOUTH_HTTP_URL:-}"                # http(s) URL; empty = the output is down
      timeout_ms: 5000                          # per attempt
      retries: 3                                # attempts after the first, with exponential backoff
      max_queue: 20                             # undelivered lines held; the oldest is dropped past it
  fallback:
    min_interval_ms: 20000     # at most one fallback line per 20 s on an output
```

- `mouth.outputs` is a map from output name to that output's settings. The name is also the `sink` value mouth publishes for the output (MOUTH-ROUTE-001), so `discord` keeps the sink name every consumer already sees.
- The schema knows each output kind's keys. An unknown output name (a typo such as `discrod`) is reported by config's unknown-key warning and ignored, like any unknown key (config Decisions: Unknown keys); the misspelt output is then simply absent.
- `enabled: false` means mouth opens no connection for that output and never claims, plays or gives up a line on it (MOUTH-ROUTE-002). With every output disabled, mouth idles in the `off` plan.
- `gain_db` scales the samples mouth hands that output, for utterances and fallback clips alike, clamped to the 16-bit range (MOUTH-ROUTE-005). It is a per-output trim, so the co-host can be quieter in Discord than on stream; the synthesized voice itself (speed, voice id) is tuned in voice.
- The `mouth` section is optional. A `config.yaml` written before mouth existed loads with the defaults: the Discord output enabled, gain 0, interval 20000 (CFG-SCH-020).
- Which guild and voice channel the co-host sits in is the Discord connector's setting (`connections.discord.guild_id` and `voice_channel_id`, defaulting through `config.example.yaml` to `DISCORD_GUILD_ID` / `DISCORD_VOICE_CHANNEL_ID`): one bot holds one connection, so listening and speaking share one channel.

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

At boot mouth loads config, creates a `Bus("mouth")` and derives a plan with the pure function `mouthPlan(outputs)` (MOUTH-START-003):

| Outputs enabled | Plan | Heartbeat |
| --- | --- | --- |
| none | `off` | mode `off`, every dep `n/a`, state `ready` at once (MOUTH-START-001) |
| `discord`, alone or with others | `discord` | mode `live`; `deps.discord` follows the connector sink's readiness (MOUTH-CONN-003); `ready` once the loop is subscribed |
| only `dryrun`, `file` or `http` | `local` | mode `mock` when `dryrun` is the only output, else `live`; `deps.dryrun: ok`, state `ready` (MOUTH-DRY-004, MOUTH-DRY-005) |

mouth reads no token and creates no Discord client in any plan. In the `off` plan mouth subscribes to nothing, fetches no clips, plays nothing and publishes no `voice.*` event; shutdown stops the bus (MOUTH-START-004). An output kind that needs no secret (`dryrun`, `file`, `http`) never makes the plan wait on anything. With the Discord output enabled and the connector absent, the output is simply not ready and skips lines (MOUTH-ROUTE-003).

The service starts through the shared `runService` (MOUTH-START-006): the plan, the bus loop, the clip refresh and the outputs are wired in `main`, and each teardown is an `onStop` step.

In the `discord` and `local` plans mouth creates its consumer group `mouth` with start mode `latest` and starts one loop for `voice.utterance` and `voice.playing` before any output starts (MOUTH-PLAY-001, MOUTH-START-005). The group is reset to the newest entry on every start, so lines published while mouth was down are never played late. One loop reads both types, because two loops with different type filters in one group would acknowledge and drop each other's events.

Environment and config read by mouth:

| Source | Key | Use |
| --- | --- | --- |
| env | `VOICE_URL` | via `urls.voice()`: the base of the fallback clip routes; utterance audio comes from each event's `audioUrl` |
| config | `mouth.outputs.discord.{enabled, gain_db}` | the Discord output (CFG-SCH-020) |
| config | `mouth.outputs.dryrun.{enabled, fail_every}` | the dry-run output (CFG-SCH-023) |
| config | `mouth.outputs.file.{enabled, dir, max_files}` | the file output (CFG-SCH-031) |
| config | `mouth.outputs.http.{enabled, url, timeout_ms, retries, max_queue}` | the HTTP output (CFG-SCH-031) |
| config | `mouth.fallback.min_interval_ms` (20000) | the storm limit (CFG-SCH-018) |
| env | `COHOST_DATA_DIR` | via `dataDir()`: the clip cache under `<dataDir()>/mouth/fallback-clips` |

## Discord Output

The Discord output is a **connector sink**. The co-host's one Discord bot, the one voice connection, the join and rejoin loop and the player belong to the Discord connector ([connections](../connections/connections-design.md#discord-connector)); mouth holds none of them (MOUTH-CONN-001).

1. **Readiness.** The output is ready while a live registration offers `audio-out` for the sink `discord` with `ready` true (MOUTH-CONN-003). mouth reads the connector registry (CONN-REG-006); it never asks the connector to join and notices a rejoin only as the sink becoming ready again. While the connector is absent or still joining, the output skips lines (MOUTH-ROUTE-003) and `deps.discord` is `down`.
2. **Delivery.** To play a line the output converts the WAV to the sink's declared format (48 kHz stereo s16le by the shared `resample`, SHARED-AUDIO-006), applies its gain, and writes the frames to `audio.out.discord` tagged with the line's id, the last one marked `last`. It writes at real time with a lead of one second, not as a burst, because the stream is capped and a burst would evict the start of a long line (CONN-BP-004). It publishes `voice.playing` once the first frame is written and `voice.done` when the last frame's scheduled play time has passed (MOUTH-CONN-004). The connector plays the frames; mouth has no player and no Opus encoder.
3. **A sink that goes away mid-line.** The line's schedule finishes and `voice.done` follows; the line is not given up and no fallback plays, because nothing failed on mouth's side (MOUTH-CONN-005). A line written while the sink is not ready never starts: it is skipped at intake.

## Playback

Each enabled output has a `Playback` queue: FIFO with one current slot.

- **Intake.** A `voice.utterance` is queued on every enabled output that is ready, narrowed to the outputs its `route` names when it has one (Routing per line); an output that is not ready skips it (MOUTH-ROUTE-003). mouth plays every utterance it reads, whatever the mute or pause state: it reads `control` events only for `set_routing` and ignores `mute`, `pause` and every other command, because cortex and salience enforce mute and pause upstream (MOUTH-PLAY-008).
- **Play.** The output takes the head, fetches the WAV from `audioUrl`, converts it (SHARED-AUDIO-006), applies the output's gain (MOUTH-ROUTE-005), hands it to its player, and **then** publishes `voice.playing { id, sink: <name> }` (MOUTH-PLAY-002, MOUTH-PLAY-003).
- **Finish.** When the player goes idle with an item current, the output publishes `voice.done { id, sink: <name> }` and starts the next item (MOUTH-PLAY-004). A failed `voice.done` publish is logged and the queue continues (MOUTH-PLAY-009).
- **Give up.** If the fetch, the conversion or the hand-over to the player throws before any audio started, the output logs `playback failed` and gives up on that line (MOUTH-PLAY-005): exactly one `voice.failed { id, sink: <name>, reason }` (MOUTH-PLAY-006), a fallback clip in its place when one is eligible, and the next item. A player error after audio started is not a give-up; it is logged (MOUTH-PLAY-007) and ends in Idle like any line.

**Stuck-playback guard.** Three fixed limits keep one bad line from blocking an output's later lines (they are constants, not settings; Decisions):

- The WAV fetch is abandoned 15 s after it starts and handled as a failed fetch, so it ends in the give-up path (MOUTH-PLAY-010).
- A watchdog runs from the moment audio is handed to the player: if the player is not idle within the audio's duration plus 10 s, the output logs `playback stuck`, stops the player, gives up on an utterance (or ends a fallback clip with `voice.done`) and goes on to its next item (MOUTH-PLAY-011). The stop's own Idle event is ignored so it ends nothing twice.
- Each output holds at most 20 queued utterances besides the current one; a 21st drops the oldest, which is skipped like a line on an output that is not connected, with no `voice.failed` and no fallback (MOUTH-PLAY-012). A stale line is never played late (the same stance as start mode `latest`).

## File and HTTP outputs

Both are sinks like `discord`: each has its own `Playback` queue, claims a line with `voice.playing { sink: <name> }` once it has taken the audio, and releases it with `voice.done` after the WAV's own duration (as `dryrun` does), so the arbitration protocol sees a sink that finishes when the line would have finished. Reporting `voice.done` at once would release cortex early while another sink, such as Discord, is still speaking the line. Neither is a device, so neither is ever "not ready" except the HTTP output with no `url`. Neither plays a fallback clip: a line that fails on an archive output is reported with `voice.failed` and nothing is said in its place. Neither has `gain_db` (the WAV is delivered as synthesized).

**File output** (MOUTH-FILE-*). On each line mouth fetches the WAV, checks it parses as a 16-bit WAV, and writes it to `<dataDir()>/<dir>/<epoch-ms>-<seq>-<id>.wav`, creating the directory on demand. After each write it lists the directory's `.wav` files and deletes the oldest until at most `max_files` remain, so the directory is bounded. A directory that cannot be created or written is a failed hand-over: the output gives up on that line (MOUTH-PLAY-005). `dir` is validated by the schema as a relative path without `..`, so the output can only write under the data directory.

**HTTP output** (MOUTH-HTTP-*). On each line mouth fetches the WAV, checks it parses, takes it as played (claim, timed release) and hands it to a delivery queue, so a slow or down endpoint never delays the co-host. The queue holds at most `max_queue` undelivered lines; one more drops the oldest with a warning. A delivery is `POST <url>` with `content-type: audio/wav`, header `x-cohost-utterance-id: <id>` and the WAV as the body, abandoned after `timeout_ms`; a non-2xx answer or a network error is retried with the shared `retryWithBackoff` (base 250 ms doubling to a 5 s cap) for at most `retries` attempts after the first, after which the line is dropped with a warning and the next one is delivered. Deliveries run one at a time, in order. Shutdown stops retrying and drops what is undelivered. With an empty `url` the output is down (`deps.http` `down`), skips lines as an unconnected output does, and mouth logs an error naming `mouth.outputs.http.url` at startup, without exiting.

## Live routing

The owner changes where the co-host's voice goes while mouth runs by sending the bus command `control { cmd: "set_routing", target: "mouth", routing: { <output id>: { enabled?, gain_db? } } }`. The dashboard's `POST /mouth/routing` sends it (DASH-ROUTE-001); any bus client may.

- **Where it is read.** The one `mouth` loop also reads `control` in the `discord` and `local` plans, and hands each event to the shared `controlFor("mouth", { set_routing })`. The `off` plan subscribes to nothing, so a `set_routing` sent to them has no effect.
- **What it changes.** A `routing` entry sets one output's *live* `enabled` flag and, for `discord` only, its live `gain_db`. An output switched off live skips every later `voice.utterance` exactly as a disabled output does (MOUTH-ROUTE-002: nothing queued, claimed or given up); lines it already queued, and the one it is playing, finish. Switched on again it queues lines as before. A new gain applies to the next audio handed to that output's player.
- **Only what runs can be routed.** The live flags toggle outputs mouth started. An output that was disabled in `config.yaml` when mouth started was never constructed (no Discord client, no directory, no queue), and a live command cannot build one: naming it is rejected as not running. So a live command can never create a Discord client or log in, in particular in the `local` plan.
- **Validation.** The command is applied whole or not at all. It is rejected, with a warning, when `routing` is missing or empty, an id is not an output kind (`discord`, `dryrun`, `file`, `http`: "unknown output id"), an id is an output kind that is not running, `gain_db` is given for an output without gain, or `gain_db` is outside -40..12. A malformed event shape never reaches mouth: the bus schema rejects it at publish (BUS-EVT-004).
- **Not persisted.** mouth never writes `config.yaml`. The override lives in memory; a restart returns to the file, which is also how routing is made permanent (the settings editor, then a restart).
- **What the operator sees.** After every `set_routing`, applied or rejected, mouth sets the heartbeat's standing detail to the current routing in the shape of the config keys, `routing {"discord":{"enabled":true,"gain_db":0},"dryrun":{"enabled":false}}`, prefixed `set_routing rejected: <reason>; ` after a rejection. The Services tab shows it as mouth's detail; its keys match the settings editor's `mouth.outputs.<id>.<key>` view, so the owner can copy a live routing into `config.yaml`. A live-disabled output reports `deps.<id>` `n/a`.

### Routing per line

A line may name where it goes. `voice.utterance` carries an optional `route`, a list of output ids (`discord`, `dryrun`, `file`, `http`) set by whoever said the line (the operator's `say` box, `POST /inject/event` with a `brain.say`) and passed through by cortex and voice unchanged (event-bus BUS-EVT-023, VOICE-UTT-004, CTX-CTRL-007).

- **Absent `route`.** Today's behaviour: the line goes to every enabled output that is ready (MOUTH-ROUTE-003).
- **Present `route`.** The line is queued only on outputs that are named in `route`, enabled (configured and not switched off live) and ready; every other output skips it exactly as an output that is not ready does (MOUTH-ROUTE-006). `route` narrows the enabled set; it never switches an output on.
- **Unknown ids.** An id that is not an output kind is ignored. mouth logs it and sets the heartbeat's standing detail to `route ignored unknown output id "<id>"; ` followed by the routing detail of MOUTH-LIVE-006 (MOUTH-ROUTE-007). The rest of the route still applies.
- **A line that goes nowhere.** When `route` names no enabled output (an empty list, only unknown ids, or only outputs that are off or not running), mouth queues nothing and completes the line itself: `voice.playing { id, sink: "mouth" }` then `voice.done { id, sink: "mouth" }`, with no `voice.failed` and no fallback clip (MOUTH-ROUTE-008). The `voice.playing` is a claim, so voice's virtual sink does not also play the line; the `voice.done` releases cortex at once. An enabled output named by `route` that is merely not ready is the ordinary skip of MOUTH-ROUTE-003: voice's virtual sink covers the line.
- **What `route` does not reach.** The dashboard's browser sink page is not an output (see How routing meets sink arbitration) and plays every line it hears; `route` addresses mouth's outputs only.

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
5. **Play.** Convert as an utterance (SHARED-AUDIO-006), apply the output's gain, hand to the player (MOUTH-FALL-001). A clip that fails conversion means no fallback, a warning naming the clip, and the clip is not picked again until the cache's `fingerprint` changes; a player throw means no fallback and marks nothing; there is no second try (MOUTH-FALL-008).
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
| Hung fetch | abandoned after 15 s and given up like any failed fetch | MOUTH-PLAY-010 |
| Player never reaches Idle | after the audio's duration plus 10 s the player is stopped and the line is given up (a clip ends with `voice.done`) | MOUTH-PLAY-011 |
| Queue grows without bound (voice far ahead of the output) | the oldest queued line is dropped past 20, silently | MOUTH-PLAY-012 |

## Health

`MouthHealth` is the `HeartbeatSpec` for `service: "mouth"` (MOUTH-HLTH-001):

- `mode`: `off` in the `off` plan, `mock` when the `dryrun` output is the only enabled output (MOUTH-DRY-004), else `live`.
- `deps`: one key per output kind under `mouth.outputs` (`discord`, `dryrun`, `file`, `http`): `n/a` for a disabled output, `ok` only while that output is ready (`discord`: the connector sink is ready, MOUTH-CONN-003; `dryrun` is ready while enabled), `down` otherwise (MOUTH-HLTH-002).
- State: `starting` until the first join attempt resolves; `ready` on Ready; `degraded` with a detail while a join fails (SHARED-DVS-004); `startHeartbeat` turns any `down` dep on a `ready` service into `degraded`.

mouth has no `voice` dependency in its heartbeat: an unreachable voice shows up as give-ups and an unchanged clip cache, and voice reports its own health.

## Running Without the Other Half

ears and mouth share no process, consumer group or file, and reach Discord only through the connector's streams, so either runs, restarts or fails without the other.

| Situation | Listening (ears) | Speaking (mouth) |
| --- | --- | --- |
| Both up, connector up | hears every human (the connector reads no bot account, CONN-DISC-007) | speaks in the channel |
| mouth down or restarting | unaffected | lines published meanwhile are covered by the virtual sink or the dashboard page and never replayed (`latest`); no `voice.failed`, no fallback; after restart the clip cache comes from the mirror |
| ears down or restarting | `speech.heard` and audio injection stop; nothing replays | unaffected, including the fallback line |
| Only mouth deployed (profile `mouth` without `ears`) | — | the co-host speaks in Discord but does not hear it; chat and the dashboard still drive her |
| Only ears deployed | hears Discord through the connector | no Discord output; the dashboard page or the virtual sink times every line |
| Discord connector down | `deps.discord` `down`; other sources keep running | the `discord` output is not ready and skips lines; the dashboard page or the virtual sink covers them; `file`, `http` and `dryrun` outputs are unaffected (CONN-ISO-001) |
| voice down | unaffected | every line gives up; fallback clips play from the cache, at most one per 20 s |

## Dry-run output and shared modules

An output named `dryrun` (`mouth.outputs.dryrun`, CFG-SCH-023; enabled by the isolation preset) lets mouth be tested with no Discord. It is ready from startup, fetches each line like any output, reads its duration, claims it with `voice.playing` under sink name `dryrun`, waits that long and publishes `voice.done`, sending audio nowhere. With `fail_every` n > 0 it gives up on every n-th line, so the fallback line path runs end to end (MOUTH-DRY-*). When `dryrun` is enabled and the Discord output is disabled or has no token, mouth runs in the `local` plan: no Discord client, the bus loop, the clip refresh and the `dryrun` output (MOUTH-START-003). It is a real sink in voice's arbitration while enabled, so it is off by default and on only in the isolation preset or when the owner turns it on.

Conversion runs through the shared audio module (MOUTH-AUD-002).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Service name | `mouth` | `voice` (rename); `speaker`; `playback`; `audio-out`; `discord-sink` | `voice` is the TTS and arbitration service, and its name is in every `voice.*` event. `speaker` already means the human who spoke (`speech.heard.speaker`). `playback` and `audio-out` describe one mechanism, not a part of the co-host. `discord-sink` names one output, which the module outgrows. `mouth` fits the senses-and-body model beside `ears` and `eyes`. Its one collision is avatar's lip-sync parameter `mouthOpen`, which lives inside avatar and never appears on the bus. |
| A process of its own | mouth is a separate service from ears and from voice | One process with listening and speaking modules; speaking folded into voice | Owner direction: listening and speaking are separate modules the owner tunes and routes separately. A separate process restarts, fails and is deployed without touching listening. Folding outputs into voice would put playback on the process whose failure the fallback line exists to survive, and would end voice's rule that it plays nothing. Full comparison: [listen-speak-split](../ears/decisions/listen-speak-split.md) (its Discord-identity choice superseded by [connector-protocol](../connections/decisions/connector-protocol.md). |
| Discord identity | mouth holds no Discord client; the `discord` output writes audio to the connector's `audio.out.discord` and the Discord connector, which holds the one bot, plays it | Two bots, one per service (the earlier choice); one bot in mouth with ears as a consumer; ears and mouth merged | Owner direction: one bot login. The connector keeps the bot viewers see speak, gives one login and keeps ears and mouth separately restartable. Full comparison: [connector-protocol](../connections/decisions/connector-protocol.md). |
| Routing table | `mouth.outputs.<name>` map with per-output `enabled`, target and `gain_db` | One `mouth.output` enum; routing by a field on `voice.utterance` set by voice | A map lets several outputs run at once and keeps each output's settings together. Routing on the event would make voice decide where audio goes, which is the speaking module's job, and would change the protocol for every consumer. |
| Sink name | The output's name; the Discord output keeps `discord` | `mouth`; `mouth:discord` | Every existing consumer (voice, avatar, cortex, the dashboard feed, working-memory) and the fallback claim check already treat `discord` as the Discord sink; one name per output keeps two outputs distinguishable. |
| Per-output state | Own queue, current item, storm timer and last phrase per output | One queue feeding all outputs in lockstep; one storm timer for mouth | Lockstep would let one slow or broken output stall the others. The storm limit exists to keep one audience from hearing a run of fallback lines, and each output reaches its own audience. |
| Output loudness | `gain_db` per output, applied by mouth to utterances and clips, clamped | No per-output level; Discord's per-user volume only | The owner tunes where and how loud the co-host is heard. Discord's per-user volume is set by each listener, not by the owner. |
| Dashboard sink in the routing table | Not listed; the page stays the dashboard's sink, switched by where it is opened and its own toggle | `mouth.outputs.dashboard.enabled` read by the dashboard | The page is opened deliberately in each place it should play, so a config flag would duplicate its toggle, and the host-run dashboard would have to read and obey another service's config section. |
| Unknown output names | The unknown-key warning, as for every config key | Fail the config load for an unknown output (`.strict()` on `mouth.outputs`) | Config's project-wide rule is to warn and load; failing every service's config load over one mouth typo would stop the whole stack, while the warning names the key. |
| Output delivery | mouth writes a line's frames paced at real time with a one-second lead; `voice.done` is timed from that schedule | Burst the whole line; a played-up-to acknowledgement from the connector | The sink stream is capped, and a burst would evict the start of a long line; pacing needs no feedback stream. The cost is a `voice.done` that follows the schedule rather than the player (connections open question 1). |
| Missing `mouth` section | Optional with defaults | Required section | A `config.yaml` written before mouth existed still loads. |
| Failed playback | Give up: report `voice.failed` and say a pre-generated fallback line | Skip silently; report `voice.done` with an error sink | Owner decision: dead air after a glitch is worse than owning it; the report lets voice, avatar and cortex stop waiting. |
| Where fallback audio comes from | Clips voice pre-generates and serves over HTTP, prefetched into mouth's own cache | Synthesize at failure; a canned WAV in the repo; a directory shared with voice | Owner decision: playback must not depend on the path that just failed and must sound like the co-host. A shared directory would break HLD tenet 1. |
| Fallback text source | The manifest voice serves, cached with the clips | mouth reads `voice.fallback.lines` itself | mouth reports the text of the audio it actually plays, even while a regeneration is pending. |
| Refreshing the cache | Poll the manifest at startup and every 60 s; download on a fingerprint change; swap the whole set | A bus event per new set; fetch on every give-up; startup only | A small poll needs no new event and covers voice restarts and regenerations; fetching at give-up would put the failing path back in. |
| Cache persistence | Memory, mirrored to mouth's data directory; no Compose volume | Memory only; a named volume | The mirror covers a mouth restart while voice is down; voice can always serve the clips again after a recreate. |
| Clip choice | Uniform random, never the phrase started last on that output when there is a choice | Round-robin; weighted | Random keeps it fresh; avoiding the previous line stops the same joke twice in a row. |
| A bad clip | Skip this give-up, mark the clip bad until the set changes, no second try | Try the next clip; mark bad forever | One attempt keeps the queue moving; marks reset when voice regenerates, the likely fix. |
| Start mode | `latest` on group `mouth` | `resume` | Owner decision 2026-11-01 (project-wide): stale lines are never played late. |
| Mute and pause | mouth reads `control` only for `set_routing` and ignores `mute` and `pause` | Gate playback on mute | Owner decision 2026-11-01 (project-wide): only cortex and salience see mute and pause; an operator `say` must still be heard. |
| Publish failures | Logged; the queue continues | Unhandled rejection | Owner decision 2026-11-01 (project-wide). |
| Stuck-playback limits | Fixed constants: fetch 15 s, watchdog duration + 10 s, queue 20 | Settings under `mouth.fallback` or per output | One fetch of a local WAV or one clip has no legitimate reason to take longer, and a setting would be a knob the owner has no way to size; the numbers are generous against the 1.5 s claim window and cortex's `speaking_timeout_ms`. A stuck output otherwise blocks every later line of that output. |
| Stuck line outcome | Give up (`voice.failed` plus a fallback clip when eligible); a stuck fallback clip ends with `voice.done` | Report `voice.done` for a stuck line; silently stop | Owner disposition: the guard ends in the give-up path, so voice, avatar and cortex learn the line failed. A clip's failure is already reported, so only its release is owed. |
| A full queue | Drop the oldest queued line, skip it silently | Drop the newest; give up on the dropped line | The oldest line is the stalest; a late line is worse than a missing one. A skip leaves voice's virtual sink to cover it, as for a disconnected output, instead of speaking a fallback for a line nobody was waiting on. |
| Process wiring | The shared `runService` with `MouthHealth`; teardown as `onStop` steps | A bespoke `index.ts` | One bootstrap for every service (shared-runtime); `main` is a function a test runs with a fake bus and a faked Discord session. |
| Source files | `clips.ts` (clip cache, mirror, refresh) and `fallback.ts` (claim memory, the fallback line) | One 317-line `fallback.ts` | The clip module is about files and HTTP, the fallback line about choosing; they share only the `FallbackClip` shape. |
| More output kinds | `file` (bounded rotating directory under the data directory) and `http` (POST with timeout, shared `retryWithBackoff`, bounded queue) beside `discord` and `dryrun`; both report `voice.done` after the WAV's duration and play no fallback clip | Only `discord` and `dryrun`; a local audio device or virtual cable now; `voice.done` straight after the write or POST | The per-output queue, health key and sink name generalize, so each kind is an adapter plus a key under `mouth.outputs`. Both need no account or device, so they run in the `local` plan. An early `voice.done` from an archive output would release cortex while Discord still speaks the line. A fallback clip delivered to an archive is noise. A device output needs a native audio dependency and is not needed to prove the seam. |
| Routing per line | Optional `route` list of output ids on `control say`, `brain.say` and `voice.utterance`; mouth queues the line only on the named enabled, ready outputs, ignores unknown ids with a heartbeat note, and completes a line that goes nowhere with `voice.playing` and `voice.done` sink `mouth` | Drop the idea; a routing field only on `voice.utterance` set by voice; a per-line `outputs` object with gains; completing with `voice.failed` | An operator wants one line only in the archive (`file`) or only on stream, which the whole-output `set_routing` switch cannot say for one line. The field is optional and additive, so every existing publisher and consumer is unchanged. Completion by `voice.playing` plus `voice.done` releases cortex at once without a spoken fallback, and the claim keeps voice's virtual sink from timing the same line a second time. `voice.failed` would invite a fallback clip for a line the operator chose not to play. |
| Re-routing | Persisted routing is `config.yaml`, applied by restart through the settings editor (module-contract); the bus command `set_routing` is the runtime override, read through `controlFor`, held in memory and reverted by a restart | Restart only; a live config reload; a mouth-private HTTP port | Settings take effect by restart (HLD tenet), so the file stays the one persisted source. An operator still needs to silence or re-level an output mid-stream without dropping the Discord connection, which a restart does. The bus is how every other service is commanded and `controlFor` is the shared reader, so no new transport is added. The override toggles only outputs that were started, so it cannot create a Discord client. |
| Avatar during a fallback clip | Avatar lip-syncs the given-up line's envelope while the clip plays | Publish a clip envelope | Owner decision: accepted. |
| Long-term memory keeps the intended line | memory stores every `brain.say` when published, so a failed line is remembered as said | Correct memory on `voice.failed` | Owner decision: accepted. |

## Open Questions & Future Decisions

None.

## Manual verification

1. **Connector sink.** Checked with the Discord connector against a real guild ([connections](../connections/connections-design.md#manual-verification)): a line is spoken and heard in the channel, the connector is killed and restarted mid-stream and the output skips lines while it is down and speaks again after it returns, without restarting mouth.

## References

Files in this segment:

- `services/mouth/src/index.ts` (the `runService` call), `mouth.ts` (plan, wiring, shutdown), `discord.ts` (the connector-sink output: registry check, paced frame writer), `dryrun.ts` (the dry-run output), `session.ts` (output target, bus loop and handler), `playback.ts` (queue, stuck-playback guard), `clips.ts` (clip cache, mirror, refresh), `fallback.ts` (claim memory, the fallback line), `audio.ts` (WAV to 48 kHz PCM, gain), `health.ts` (plan, token, `MouthHealth`)
- `services/mouth/test/*.test.ts`; `services/voice/test/mouth-sync.test.ts` (voice's clip routes read by mouth's clip sync)
- `packages/shared`: `runService`, `retryWithBackoff`, `parseWav`, `resample`

Other segments (arrow shows direction):

- mouth -> [event-bus](../event-bus/event-bus-design.md): publishes `voice.playing`, `voice.done`, `voice.failed`, heartbeats; consumes `voice.utterance`, `voice.playing` (group `mouth`, start `latest`).
- mouth -> [voice](../voice/voice-design.md) HTTP: fetches `audioUrl` and the clip routes (`/fallback/manifest.json`, `/fallback/<name>`).
- mouth <- [voice](../voice/voice-design.md): owns the arbitration protocol; each mouth output is a sink.
- mouth -> [config](../config/config-design.md): `loadConfig` (`mouth.*`), `urls.voice()`, `dataDir()`, `env()`.
- mouth -> [control-plane](../control-plane/control-plane-design.md): heartbeat contract; manifest unit `mouth` with group `mouth` and isolated preset `MOUTH_DISCORD_ENABLED=false`.
- mouth -> [deployment](../deployment/deployment-design.md): Compose service `mouth` in profile `mouth`.
- mouth -> [avatar](../avatar/avatar-design.md), [cortex](../cortex/cortex-design.md), [working-memory](../working-memory/working-memory-design.md): consumers of the `voice.*` events it publishes.
- mouth -> [connections](../connections/connections-design.md): writes `audio.out.discord` and reads connector registrations; the Discord connector plays it.
- mouth <-> [ears](../ears/ears-design.md): no runtime link; both reach Discord through the connector.
- mouth <-> [dashboard](../dashboard/dashboard-design.md): the dashboard page is another sink; the dashboard shows mouth's heartbeat.

External: Redis Streams (the connector's `audio.out` stream).

EARS specs: [mouth-specs.md](./mouth-specs.md).
