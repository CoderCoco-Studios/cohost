# mouth specs

Segment `mouth` (prefix `MOUTH`). LLD: [mouth-design.md](mouth-design.md). Markers: `[x]` implemented, `[ ]` intended but not yet implemented (gap), `[D]` deferred. A spec line marked `[proposed]` states a design choice that awaits the owner's confirmation.

Terms used below: an "output" is one entry under `mouth.outputs` (today only `discord`), and its "sink name" is the entry's key. An output is "ready" while its connection can play audio (for `discord`, while the voice connection is Ready). "Give up" means MOUTH-PLAY-005. "The clip cache" is the set of fallback clips mouth holds in memory, mirrored under `<dataDir()>/mouth/fallback-clips` (CFG-DIR-006, CFG-DIR-007). "Voice's manifest" and the clip routes are VOICE-CLIP-011 and VOICE-CLIP-012. A "real sink" is any `sink` other than `virtual` and `error`.

## Startup plans

- [ ] **MOUTH-START-001**: Where no output under `mouth.outputs` is enabled, the mouth service shall create no Discord client, subscribe to no bus event type, fetch no fallback clips, publish no `voice.playing`, `voice.done` or `voice.failed`, and stay running idle with heartbeat mode `off` and state `ready`.
- [ ] **MOUTH-START-002**: Where `mouth.outputs.discord.enabled` is true and `DISCORD_TOKEN` is unset or empty, the mouth service shall not exit, shall create no Discord client, subscribe to no bus event type and fetch no fallback clips, shall log an error at startup and the warning "DISCORD_TOKEN is not set; mouth still idle" every 60 s, and shall report heartbeat state `degraded` with detail `DISCORD_TOKEN is not set`, mode `live` and `deps.discord` `down`.
- [ ] **MOUTH-START-003**: The mouth service shall choose its startup plan with the pure function `mouthPlan(outputs, hasToken)` returning `off` when no output is enabled, `no-token` when the `discord` output is enabled and `hasToken` is false, and `discord` otherwise, and shall load discord.js and `@discordjs/voice` only when the plan is `discord`.
- [ ] **MOUTH-START-004**: When the process receives a shutdown signal in the `off` or `no-token` plan, the mouth service shall clear its idle warning timer, stop the bus and exit with code 0.
- [ ] **MOUTH-START-005**: While the mouth plan is `discord`, the mouth service shall subscribe its consumer group `mouth` with start mode `latest`, so the group is reset to the newest entry on every start and no `voice.utterance` published while mouth was down is played.

## Discord output session

- [ ] **MOUTH-SESS-001**: If the Discord login fails while the mouth plan is `discord`, then the mouth service shall log the error and exit the process with code 1.
- [ ] **MOUTH-SESS-002**: When the Discord client is ready in the mouth `discord` plan, the mouth service shall join the voice channel `mouth.outputs.discord.voice_channel_id` of guild `mouth.outputs.discord.guild_id`, self-deafened and not self-muted, and wait up to 20 s for the connection to reach Ready. `[proposed]` (self-deafened)
- [ ] **MOUTH-SESS-003**: If `mouth.outputs.discord.guild_id` or `mouth.outputs.discord.voice_channel_id` is empty, or the configured channel is not a voice-based channel, then the mouth join attempt shall fail with the error "mouth.outputs.discord.guild_id is not set", "mouth.outputs.discord.voice_channel_id is not set" or "mouth.outputs.discord.voice_channel_id is not a voice channel" respectively, handled as a failed join (MOUTH-SESS-006).
- [ ] **MOUTH-SESS-004**: When the mouth Discord voice connection reaches Ready, the mouth service shall subscribe the `discord` output's audio player to it, mark the `discord` output ready, set `deps.discord` to `ok`, and report the heartbeat `ready`.
- [ ] **MOUTH-SESS-005**: When the mouth Discord voice connection is Disconnected and does not enter Signalling or Connecting within 5 s, the mouth service shall mark the `discord` output not ready, set `deps.discord` to `down`, destroy the connection, and attempt to rejoin after 5 s.
- [ ] **MOUTH-SESS-006**: If a mouth voice-channel join fails (the initial join or a rejoin after a disconnect), then the mouth service shall log the failure, report heartbeat `degraded` with `deps.discord` `down` and the failure in the detail, keep its bus loop running, and retry the join after a delay that starts at 5 s and doubles up to 60 s until a join succeeds or mouth stops.
- [ ] **MOUTH-SESS-007**: When the process receives a shutdown signal in the mouth `discord` plan, the mouth service shall run one shutdown sequence that stops the fallback clip refresh, destroys the voice connection and the Discord client, and then stops the bus before exiting.
- [ ] **MOUTH-SESS-008**: The mouth service shall log in to Discord with the token in `DISCORD_TOKEN` and shall read no other Discord token variable. `[proposed]`

## Routing

- [ ] **MOUTH-ROUTE-001**: When the mouth service publishes `voice.playing`, `voice.done` or `voice.failed` for an output, it shall set `sink` to that output's sink name (`discord` for the Discord output).
- [ ] **MOUTH-ROUTE-002**: Where an output's `enabled` is false, the mouth service shall open no connection for that output and shall queue, play, claim and give up no utterance on it.
- [ ] **MOUTH-ROUTE-003**: When a `voice.utterance` arrives in the mouth `discord` plan, the mouth service shall queue it on every enabled output that is ready, and on every enabled output that is not ready shall skip it without queueing it, publishing no `voice.playing` and no `voice.failed` for it on that output.
- [ ] **MOUTH-ROUTE-004**: The mouth service shall keep a separate playback queue, current item, fallback storm timer, last-started fallback phrase and bad-clip marks for each enabled output, so that a give-up, a stall or a fallback on one output does not delay or suppress playback on another. `[proposed]`
- [ ] **MOUTH-ROUTE-005**: When the mouth service hands utterance or fallback-clip audio to an output whose `gain_db` is not 0, it shall first multiply every sample by 10^(`gain_db`/20) and clamp each result to the signed 16-bit range. `[proposed]`

## Playback

- [ ] **MOUTH-PLAY-001**: While the mouth plan is `discord`, the mouth service shall read `voice.utterance` and `voice.playing` through one loop of consumer group `mouth`, established before the Discord login.
- [ ] **MOUTH-PLAY-002**: When a `voice.utterance` is queued on a mouth output, that output shall play its queued utterances one at a time in arrival order, fetching each WAV from the event's `audioUrl`, converting it (MOUTH-AUD-001) and handing it to the output's audio player.
- [ ] **MOUTH-PLAY-003**: When a mouth output has handed an utterance's audio to its audio player, it shall publish `voice.playing` with the utterance `id` and the output's sink name.
- [ ] **MOUTH-PLAY-004**: When a mouth output's audio player becomes idle while an item is current, the output shall publish `voice.done` with that `id` and the output's sink name and then start its next queued item; when the player becomes idle with nothing current, it shall publish nothing.
- [ ] **MOUTH-PLAY-005**: If fetching or converting the audio for an utterance queued on a mouth output fails, or handing it to the output's audio player throws, before any of its audio has started, then the output shall log the warning "playback failed", give up on that utterance (playing none of its audio and handling it by MOUTH-PLAY-006 and the MOUTH-FALL lines) and only then start its next queued item; a player error after audio has started is not a give-up and ends the item through MOUTH-PLAY-007 and MOUTH-PLAY-004.
- [ ] **MOUTH-PLAY-006**: When a mouth output gives up on a queued utterance, it shall publish exactly one `voice.failed` for that utterance with its `id`, the output's sink name as `sink`, and `reason` set to the failure's error text.
- [ ] **MOUTH-PLAY-007**: If a mouth output's audio player emits an error, then the mouth service shall log the warning "player error" naming the output.
- [ ] **MOUTH-PLAY-008**: The mouth service shall not subscribe to `control`: it plays every `voice.utterance` it receives regardless of `mute` or `pause`, which cortex and salience enforce upstream.
- [ ] **MOUTH-PLAY-009**: If publishing `voice.done` for a finished item fails, then the mouth output shall log a warning and continue with its next queued item.

## Audio conversion

- [ ] **MOUTH-AUD-001**: When converting an utterance or a fallback clip for the mouth Discord output, the mouth service shall convert a mono or stereo 16-bit WAV of any sample rate to 48 kHz stereo s16le PCM by linear interpolation, duplicating a mono channel and preserving duration.

## Fallback line

- [ ] **MOUTH-FALL-001**: When a mouth output gives up on a queued utterance and none of MOUTH-FALL-005, MOUTH-FALL-007, MOUTH-FALL-008 or MOUTH-FALL-009 applies, the output shall play one fallback clip from the clip cache in that utterance's place, converted as in MOUTH-AUD-001 with the output's gain (MOUTH-ROUTE-005), before starting its next queued item.
- [ ] **MOUTH-FALL-002**: When a mouth output has handed a fallback clip to its audio player, it shall publish `voice.playing` with the given-up utterance's `id` and the output's sink name, and after that publish the utterance's `voice.failed` (MOUTH-PLAY-006).
- [ ] **MOUTH-FALL-003**: While a fallback clip is playing on a mouth output, the output shall treat the given-up utterance as its current item, so that when its audio player becomes idle it publishes `voice.done` with that `id` (MOUTH-PLAY-004) and starts its next queued item.
- [ ] **MOUTH-FALL-004**: When a mouth output gives up on an utterance, the mouth service shall choose the fallback clip from its in-memory clip cache, making no network request and reading no file at that moment.
- [ ] **MOUTH-FALL-005**: If the clip cache is empty or every clip in it is marked bad for the giving-up output (MOUTH-FALL-008), then that output shall play no fallback for the given-up utterance.
- [ ] **MOUTH-FALL-006**: When choosing a fallback clip for a mouth output, the mouth service shall pick uniformly at random among the cached clips not marked bad for that output, excluding the clip whose phrase text matches the last fallback clip that output started whenever at least one other eligible clip exists.
- [ ] **MOUTH-FALL-007**: If a mouth output last handed a fallback clip to its audio player successfully (since mouth started) less than `mouth.fallback.min_interval_ms` (default 20000, CFG-SCH-018) before a give-up, then that output shall play no fallback for that give-up.
- [ ] **MOUTH-FALL-008**: If converting the chosen fallback clip fails, then the mouth output shall play no fallback for that give-up, log a warning naming the clip, and not pick that clip again until the clip cache's `fingerprint` changes; if handing a converted clip to the output's audio player throws, the output shall play no fallback for that give-up without marking the clip.
- [ ] **MOUTH-FALL-009**: If a real sink other than the giving-up output's own sink name has published `voice.playing` for an utterance `id` before a mouth output gives up on that utterance, then that output shall play no fallback for it.
- [ ] **MOUTH-FALL-010**: While the mouth plan is `discord`, the mouth service shall remember, for the newest 50 utterance ids it has seen in `voice.playing` on its one `mouth` loop (MOUTH-PLAY-001), which real sink names have claimed each id.
- [ ] **MOUTH-FALL-011**: When a mouth output publishes `voice.failed` for a given-up utterance, it shall include `fallback` with the clip's name (`clip`) and phrase text (`text`) from the cached manifest if and only if a fallback clip is playing on that output for that `id`.
- [ ] **MOUTH-FALL-012**: The mouth service shall obtain fallback clips only from voice's fallback HTTP routes (VOICE-CLIP-011, VOICE-CLIP-012) and shall write fallback-clip files only under its own directory `<dataDir()>/mouth/fallback-clips`.
- [ ] **MOUTH-FALL-013**: While a mouth output is not ready, the mouth service shall publish no `voice.failed` and play no fallback on that output for a `voice.utterance` it skips (MOUTH-ROUTE-003).
- [ ] **MOUTH-FALL-014**: When the mouth plan is `discord` and the service has started, the mouth service shall request voice's manifest (`GET <urls.voice()>/fallback/manifest.json`) and then repeat the request every 60 s.
- [ ] **MOUTH-FALL-015**: When voice's manifest answers 200 with a `fingerprint` different from the clip cache's, the mouth service shall download every listed clip, check each one's byte count and SHA-256 against the manifest and that it parses as a 16-bit WAV, and only when all pass replace the whole in-memory clip cache and its disk mirror with the new set, writing the mirror into a temporary directory that it then renames into place.
- [ ] **MOUTH-FALL-016**: If the manifest request fails, times out, or answers anything but 200, then the mouth service shall keep its clip cache unchanged; a 200 manifest that lists no clips shall empty the clip cache.
- [ ] **MOUTH-FALL-017**: If any clip download fails, or a clip fails the size, checksum or WAV check, then the mouth service shall abandon that refresh, keep the previous clip cache, delete the partial download, and retry at the next manifest request.
- [ ] **MOUTH-FALL-018**: When the mouth plan is `discord`, at startup and before its first manifest request, the mouth service shall load the mirrored set from its cache directory into memory; if the mirror's manifest is unreadable or any listed clip is missing or fails its checks, it shall start with an empty clip cache and log a warning.
- [ ] **MOUTH-FALL-019**: If writing the disk mirror fails during a refresh, then the mouth service shall still use the verified new set from memory and log a warning.

## Health

- [ ] **MOUTH-HLTH-001**: The mouth service shall publish heartbeats with `service` `mouth`, mode `off` in the `off` plan and `live` otherwise, and `deps` holding one key per output kind under `mouth.outputs` (today `discord`), set to `n/a` for a disabled output.
- [ ] **MOUTH-HLTH-002**: While the `discord` output is enabled, the mouth service shall report `deps.discord` `ok` only while that output is ready and `down` otherwise (always `down` in the `no-token` plan).
