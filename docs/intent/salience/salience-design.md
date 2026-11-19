---
parent: high-level-design
prefix: SAL
---

# salience

Parent: [high-level-design](../../high-level-design.md). Specs: [salience-specs.md](salience-specs.md). Arrow: [docs/arrows/salience.md](../../arrows/salience.md).

## Context and Design Philosophy

salience is the "attention" region of the brain (amygdala / salience network metaphor, `services/salience/src/index.ts`). It is a standalone Redis-bus service (`@cohost/salience`, `services/salience/package.json`) whose one job is deciding *when* the co-host should speak. It never produces the words: when something is worth a reply it publishes `attention.focus` and the cortex segment takes over; separately it owns a "reflex" fast path that publishes `brain.say` directly with canned lines and no model in the loop (`index.ts`).

Design philosophy as the code shows it:

- Cheap and continuous: scoring defaults to hard-coded rule weights (`scoring.ts`); the region keeps its own small `Context` rather than querying anything (`salience.ts`).
- Timing lives in `Scheduler`, judgement lives in a pluggable `salience.scorer` hook (`rules` / `llm` / `http`, owned by region-hooks) that always falls back to rules (`scoring.ts`, `packages/modules/src/index.ts`).
- Turn-taking is inferred from bus traffic only: `brain.status`, `brain.say` and `affect.state`; salience does not subscribe to `voice.playing` / `voice.done` (`main.ts`). The one thing it sends the body is `voice.stop`, on a barge-in.
- Everything is in-process mutable state (muted, paused, arousal, cortex state, cooldown timestamps, score cache); nothing is persisted (`salience.ts`, `scheduler.ts`).

Code layout: `index.ts` calls `runSalience()` (`main.ts`), which runs `salienceMain` on the shared bootstrap `runService`; `salienceMain` wires the scorer, a `Salience` instance and a tick timer. `salience.ts` is event intake + reflex + tick. `scheduler.ts` is the speak/no-speak decision. `scoring.ts` is score input/output types, rule weights and the module factory. `reflex.ts` is the regex rule engine. `health.ts` builds the heartbeat spec from the configuration.

## Event Wiring

`speech.partial` is not subscribed to: an interim transcript is never speech to salience (SAL-IN-007). Subscription (`main.ts`): consumer group `salience`, types `chat.message`, `chat.removed`, `speech.heard`, `vision.summary`, `brain.say`, `brain.status`, `affect.state`, `control`, in the event-bus start mode `latest`: the group is moved to the stream tail on every start, so nothing published while salience was down is delivered (SAL-IN-001). Stale chat would otherwise fire reflexes and stale `brain.say` / `brain.status` would corrupt the busy state. The mode is named explicitly (`start: "latest"`) so a plain process restart (for example compose's `restart: unless-stopped`) does not replay the backlog; a control-plane start in `fresh` mode, salience's manifest default (`packages/control/src/manifest.ts`), resets the group to `$` as well. The handler is `salience.onEvent`; the bus catches and logs handler errors and acks regardless (`packages/bus/src/index.ts`), so a failed reflex publish is logged, not fatal. `bus.subscribe` resolves only when the bus stops, so `main()` starts it with `void` after creating the group with `bus.resetGroup("salience")` (see Health and Lifecycle); a rejection of the started subscription is logged as `fatal` and exits 1.

| Event in | Handling (file:line) |
|---|---|
| `chat.message` | `ctx.push`, `scheduler.noteActivity()`, then `reflex("chat", text)` (`salience.ts`) |
| `chat.removed` | `ctx.forget(removal)`, whether or not paused: the removed chat leaves the window, so it counts toward no later decision (Forgetting a removed message) |
| `speech.heard` | `ctx.push`, `noteActivity()`, the barge-in check (Barge-in, SAL-BARGE-001), `reflex("speech", text)`; when no reflex fired and `trigger_on_speech` is true, a speech trigger (Decision and Tick, SAL-TRIG-001) |
| `vision.summary` | `ctx.push`; `reflex("vision", text)` only if `changed`; does NOT call `noteActivity()` (`salience.ts`) |
| `brain.say` (from anyone: cortex, reflex echo, operator) | `scheduler.noteSpoke()` (starts cooldown, resets idle timer), cortex state `speaking` (`salience.ts`) |
| `brain.status` | store `state` and timestamp (`salience.ts`) |
| `affect.state` | store `arousal` only (`salience.ts`) |
| `control` | see Control section (`salience.ts`) |

| Event out | When |
|---|---|
| `attention.focus` `{reason, score, focus?, injected?, remember?}` | tick decides to speak (`salience.ts`) |
| `brain.say` `{id, text, emotion, gesture?, reason: "reflex: <regex>", injected?, remember?}` | reflex hit (`salience.ts`) |
| `voice.stop` `{reason: "barge-in"}` | a barge-in (Barge-in below) |
| `service.heartbeat` (via `startHeartbeat`) | boot, ready, periodic, stopping (`main.ts`) |

Working memory: `Context` from the working-memory segment, sized `brain.working_memory_events` (default 24, `packages/config/src/schema.ts`). It is private to this process; salience never pushes `self` lines (it does not call `pushSelf`), though the scheduler and `toScoreInput` still defensively skip `self` events (`scheduler.ts`, `scoring.ts`).

## Scoring

`scoreRules` (`scoring.ts`) returns one number per event, in order:

| Event | Score |
|---|---|
| speech | 0.9 |
| chat, mentions co-host and `reply_on_mention` | 1.0 |
| chat containing `?` | 0.55 |
| chat from mod or sub | 0.35 |
| other chat | 0.15 |
| vision, `changed` | 0.3 (unchanged vision: 0) |

These match the weights quoted on the docs site's When it talks page (`docs/guide/tune/talkativeness.md`) and `config/config.example.yaml` and are asserted in `test/salience.test.ts`. `toScoreInput` flattens unseen context events into `ScoreInput.events` (kind, who, text, mention, isMod, isSub, changed) plus the current arousal (`scoring.ts`).

`createScorer` builds `new Module("salience.scorer", cfg.brain.salience.module, cfg.llm, impl, log)` (`scoring.ts`). `rules` uses `reply_on_mention`; `llm` has a JSON-only system prompt naming the co-host and streamer, a user prompt listing arousal and numbered events marked with kind, mention, mod and sub, `maxTokens: 120` (SAL-SCORE-008). The prompt treats chat as viewer text (see Viewer text in the scorer prompt below); `http` and `llm` share `validate`, which accepts only an object with a `scores` array of the same length as the input whose members are all finite numbers, clamping each to 0..1, and otherwise returns undefined so `Module.run` falls back to rules (`scoring.ts`, `packages/modules/src/index.ts`). Module default `timeout_ms` is 8000 (HOOK-CFG-002, `packages/config/src/schema.ts`). Module construction and fallback semantics are owned by region-hooks; salience owns the input/output shapes and weights.

### Viewer text in the scorer prompt

An `llm` scorer reads chat, so its prompt applies the shared untrusted text guard ([shared-runtime](../shared-runtime/shared-runtime-design.md) Untrusted text guard). The system turn carries `untrustedNotice` (subject: what a viewer typed in chat) and says that a score judges how much the event deserves a reaction, so a line asking for a high score or telling the scorer what to answer is not a reason to give one. The scorer prompt builder is the code that renders these lines, so it quotes each chat text exactly once. The user turn is the current arousal followed by one numbered line per event, built as:

`<n>. [<kind><, mentions co-host><, mod><, sub>] <label>: <text>`

where `<n>` counts from 1; `<kind>` is the literal `chat`, `speech` or `vision`, and the marks are spelled `, mentions co-host`, `, mod` and `, sub`; each mark appears only when it holds and sits inside the brackets, before the label, outside any quotes, because the marks come from platform flags and not from the text; `<label>` is `speakerLabel(who, viewer_text.max_name_chars)` and is omitted, with its colon, for a `vision` event; and `<text>` is `quoteUntrusted(text, viewer_text.max_chars)` for a `chat` event and the bounded text unquoted for a `speech` or `vision` event. Each line is one line, so the line count equals the event count and the reply's "one number per event" contract (`validate`) holds whatever a message contains. The number of events one prompt carries is bounded by the working-memory window (`brain.working_memory_events`), from which unseen events come, so no separate line cap exists. The `http` kind receives the structured events with the bounded text the window holds and no markers; the `rules` scorer builds no prompt (SAL-SCORE-009 to SAL-SCORE-014).

A manipulated score is bounded by the burst rule below: however high the scorer rates one viewer's lines, the viewer counts once, and the scorer's output is clamped to 0..1 (`validate`). One event scored 1.0 still clears the threshold alone, as a mention does, so the cooldown and the busy gate remain the limit on how often that can happen.

## Decision and Tick

`Salience.tick()` is one scheduling pass. Two things start it: the poll, a timer every `brain.salience.tick_ms` (default 1500; `main.ts`, SAL-FOCUS-001), and the speech trigger described below. It never rejects: a failure of the decision or of the `attention.focus` publish is logged (`tick failed`) and the next tick runs (SAL-HEALTH-002). Flow (`salience.ts`, `decideAndPublish`):

1. Return immediately if paused or a previous decision is still in flight (`deciding` flag; an llm/http scorer can outlast a tick).
2. `scheduler.decide(ctx, busy(), muted, arousal)`.
3. If it says speak: mark exactly `decision.scored` seen (events that arrived while an async scorer ran stay unseen), set cortex state to `thinking` optimistically (so the next tick does not double-fire), and publish `attention.focus` with the focus mapped to `{kind:"chat", who, text, mention}`, `{kind:"speech", who, text}`, `{kind:"vision", text}` or undefined, plus `propagatedFlags(focus)`. The bus schema fills a missing focus `mention` with `false` (`packages/bus/src/events.ts`).

When the focus is a `chat` event, the published `attention.focus` carries the entry's `platform` and `userId` (when it has one) beside `who`, so the cortex identifies the viewer by them and uses `who` only to render (SAL-FOCUS-003, BUS-EVT-036). When the focus is a `speech` event, the published `attention.focus` also carries `timing`: the focused event's `timing.audioEndedAt` and `heardAt`, the `ts` of its `speech.heard` envelope (SAL-FOCUS-006). When the focus is a `vision` event, it carries that event's `capturedAt` and `describedAt` (SAL-FOCUS-006). Salience adds no stamp of its own; the `attention.focus` envelope `ts` is the end of the salience stage, and cortex reads it as `focusedAt`. A focus of any other kind carries no `timing`. When several speech events are unseen at one tick they merge into one decision, and only the focus (the top-scoring unseen event) contributes `timing`; the other merged utterances are not measured. With the speech trigger on, the stage's duration is the decision itself plus any wait on an earlier decision, cooldown or busy cortex; with it off, or for a line the trigger did not cover, it includes the wait for the next poll, up to `tick_ms`.

When the decision returns, `tick` re-checks `muted`, `paused` and `busy()` and drops the focus if any holds, and it drops the focus when a `chat.removed` took the focused chat line out of the window while the scorer ran (SAL-FOCUS-007), so a `mute` or `pause` that arrives while an llm/http scorer is running stops that decision (SAL-FOCUS-005). With the `rules` scorer the await resolves before the next bus event is handled, so the window only opens for llm/http scorers.

### Speech trigger

A person who has finished speaking should not wait for the next poll before the co-host starts to answer. When a final `speech.heard` arrives, is not paused, and no reflex fired for the line, `onEvent` starts one pass of the same `tick()` the poll runs, at once (SAL-TRIG-001). `brain.salience.trigger_on_speech` (default true, CFG-SCH-034) turns this off, leaving the poll as the only starter (SAL-TRIG-007). The trigger adds no decision logic: muted, busy, cooldown, threshold, the post-scorer re-check, mark-seen and the optimistic `thinking` marker all apply unchanged (SAL-TRIG-008), so a trigger can only bring forward a focus the poll would have published at its next tick, never one the poll would withhold, and the seen/`thinking` bookkeeping stops a trigger and a poll from both publishing a focus for the same events.

Only `speech.heard` triggers (SAL-TRIG-002). A `speech.partial` is not subscribed to (SAL-IN-007), chat and vision wait for the poll, and a line a reflex answered has already been marked seen and has produced a `brain.say`, so evaluating it would add nothing (SAL-TRIG-003).

`onEvent` is the bus handler, and an `llm` or `http` scorer can take seconds, so the trigger is not awaited: the handler returns and the next event is read while the decision runs (SAL-TRIG-004). The pass never rejects, so an unawaited call cannot leave an unhandled rejection (SAL-TRIG-009).

A decision in flight makes a new pass a no-op (SAL-FOCUS-002), which would leave a second utterance, one that landed while the scorer was running, waiting for the poll. A trigger that lands while a decision is in flight therefore sets a single pending-rerun flag, and when that decision ends salience clears the flag and runs one more pass (SAL-TRIG-005). Triggers that land during the same decision share the one rerun, and a trigger that lands during the rerun sets the flag again, so the number of passes is bounded by the number of utterances, never by a loop of its own. While paused a trigger does nothing and sets no flag, and a pass run for a stale flag returns at the pause check (SAL-TRIG-006).

A trigger that finds the cooldown running or the cortex busy returns no-speak and nothing re-evaluates at the moment the cooldown or valve ends; the next poll does. Expiry timers are deferred (SAL-TRIG-010). The poll stays for that reason, and because it alone starts decisions for chat, vision and idle chatter (SAL-DECIDE-004).

`Scheduler.decide` (`scheduler.ts`) evaluates in this order and returns the first that applies:

1. `muted` -> no speak, reason `muted`.
2. `busy` -> `cortex busy`.
3. `now - lastSpoke < cooldown_ms` (default 6000) -> `cooldown`.
4. No unseen non-`self` events -> `nothing new`.
5. Score only events not already in the `WeakMap` score cache (so an event waiting across ticks is never re-sent to an llm/http scorer), then total the *counted* events (Counting a burst, below): `score` = the sum of the cached scores of the counted events, `focus` = the highest-scoring counted one (`scheduler.ts`).
6. `threshold = max(0.1, speak_threshold - arousal_bias * arousal)`; defaults 0.6 and 0.2. If `score >= threshold` -> speak, reason `mentioned` when the focus is a chat mention and `reply_on_mention` is true, else `engaged` (SAL-DECIDE-008).
7. Else if `idle_chatter_ms > 0` (default 90000) and `now - lastActivity > idle_chatter_ms` -> speak, reason `idle chatter`.
8. Else no speak, reason `score X < Y`.

### Counting a burst

Chat can arrive as a lively room (many viewers, many different lines) or as a flood (one viewer, or one pasted line from many). The first adds up to a reply; the second does not. Every unseen event is scored once and cached; the decision adds up only the counted events. Salience counts and discounts; it never drops a line from the window, never hides one from the transcript and never acts against a viewer (HLD Non-Goal 1).

Counting is one walk over the unseen non-`self` events of this decision, with one `createOnceCounter()` from the shared guard created for the walk (no window). The walk takes the events by cached score, highest first, and among equal scores the later one in window order (arrival order, not a timestamp) first:

- A speech or vision event always counts.
- A chat line counts when `counter.admit(viewerKey, text)` returns true, with `viewerKey` the shared guard's key of the entry's platform and user id, and is discounted otherwise. A discounted line adds nothing to the total and cannot be the focus.
- The total is the sum of the counted scores. The focus is the first counted event: the highest-scoring one, the later in window order among equals.

"Same viewer" is the same platform and the same user id, through the guard's `viewerKey`; "same text" is the guard's `normalizeKey` comparison (`toLowerCase()` with no locale argument, whitespace collapsed, punctuation kept). Both are the functions affect uses. The display name is for rendering and takes no part: a Twitch `Sam` and a YouTube `Sam` are two viewers, two channels that share a display name are two viewers, and one viewer who changes display name is still one. A chat entry with no user id (a test-injected line) is keyed by platform and its lowercased name, the fallback `viewerKey` defines once; every injected line named `unknown` on one platform is therefore one viewer. One viewer's burst counts once, at its best line: a mention anywhere in it makes it a mention, a question outranks plain chat, a mod's or sub's line carries its weight. A pasted line from thirty viewers counts once. Four different viewers with four different plain lines total four plain-chat weights; one viewer's four lines total one.

The walk runs over the events unseen at this decision. Every one of them, counted or not, is reported as `scored` and marked seen when a decision to speak is made (SAL-DECIDE-007). A discounted line that stays unseen across ticks is discounted at every tick, so waiting does not add it up. Once marked seen, a viewer who writes again starts a new burst that counts once toward the next decision. (SAL-DECIDE-009 to SAL-DECIDE-016.) Reflexes are outside the walk: they react to one arriving line under their own per-rule cooldown and the global busy and cooldown gates, so a flood cannot fire one repeatedly (see Reflexes). Mentions and questions keep their weights; a mention that crosses the threshold on its own makes the co-host speak, whoever sent it.

`lastActivity` is reset by chat and speech intake and by any `brain.say` (`scheduler.ts`, `salience.ts`). Because step 4 returns before step 7, idle chatter only fires when at least one unseen event exists: a fully silent stream stays silent (SAL-DECIDE-005), matching the config comment "speak unprompted if quiet this long and there's fresh context" (`config/config.example.yaml`). Breaking a dead stream unprompted is a deferred goal of the project, not current behaviour.

## Busy Gating and Cooldown

`busy()` (`salience.ts`) looks at the last cortex state seen on the bus and its age:

- `thinking`: busy while age < `brain.salience.thinking_timeout_ms` (default 60000; SAL-BUSY-001).
- `speaking`: busy while age < `brain.cortex.speaking_timeout_ms` (default 20000) - a key owned by the cortex segment's config block (`schema.ts`), read here.
- `idle` and `muted` (and the initial `idle`): not busy. A cortex reporting `muted` does not gate salience; salience's own mute flag (from `control`) does.

Every duration here (both valves, the cooldown, the idle-chatter timer, each reflex rule's cooldown) is measured on one monotonic millisecond clock, `SalienceDeps.now` (default `performance.now`), which `Salience` hands to its `Scheduler` and passes to `Reflexes.test`. A wall clock stepped by NTP or VM time sync therefore neither stretches nor cuts a valve or the cooldown. Tests inject a fake clock to step time.

Cortex state is set from `brain.status` (`salience.ts`), set to `speaking` on any `brain.say` (`salience.ts`) and set to `thinking` locally after publishing `attention.focus` (`salience.ts`). The return to `idle` depends on the cortex publishing `brain.status idle` (cortex segment); the two valves above are the safety net.

Arousal: `affect.state.arousal` is stored raw; it lowers the speak threshold (step 6 above) and is passed to the scorer as `ScoreInput.arousal` (`scheduler.ts`). Initial arousal is 0 until the first `affect.state` arrives (`salience.ts`).

## Barge-in

While the co-host speaks, a person can stop it by speaking. Salience owns the decision, because it is the region that decides when the co-host may speak, and it owns the busy state that a stop must release. It never stops audio itself: it publishes `voice.stop` and the body obeys ([voice](../voice/voice-design.md) Stopping, [mouth](../mouth/mouth-design.md) Stopping a line, [connections](../connections/connections-design.md) Flush, [cortex](../cortex/cortex-design.md) Interruption).

**Trigger.** The check runs in the `speech.heard` handler, right after the line enters the window and before the reflex test. A line interrupts when every one of these holds (SAL-BARGE-001):

1. `brain.salience.barge_in` is true (default false, CFG-SCH-035);
2. salience is neither paused nor muted (SAL-BARGE-008);
3. the cortex is `speaking` and `busy()` still holds, so a speaking valve that has expired is not an interruption (SAL-BARGE-007);
4. the line that is speaking is not a reflex line (SAL-BARGE-006);
5. the event's `source` is listed in `brain.salience.barge_in_sources` (default `["discord"]`), so an event with no `source` never interrupts (SAL-BARGE-004);
6. the transcript has at least `brain.salience.barge_in_min_words` words (default 2), counting whitespace-separated tokens that contain a letter or a number (SAL-BARGE-005), so a one-word backchannel does not stop the co-host.

A `speech.partial` is never an interruption: salience does not subscribe to it (SAL-IN-007). Partials and voice-activity edges are unstable; the final transcript is the one speech event the brain acts on.

**Effect.** Salience publishes `voice.stop` with reason `barge-in` and no `ids` (SAL-BARGE-001), then in the same synchronous step sets its cortex state to `idle` and clears the cooldown (SAL-BARGE-002), so the reply to the interrupter is held back by neither the busy gate nor the cooldown that the interrupted line started. Control then continues through the handler as for any speech line: the reflex test sees the freed state, so a reflex that matches what the interrupter said can answer, and the speech trigger starts a decision that publishes `attention.focus` for the interrupter under every ordinary gate (threshold, mute, pause; SAL-BARGE-003). When the reply's `brain.say` arrives it starts the cooldown and the `speaking` state as for any line. If publishing `voice.stop` fails, salience logs it and changes nothing else: the line is treated as an ordinary line that found the cortex busy (SAL-BARGE-009).

**One stop per speaking episode.** Setting the state to `idle` means a second person who speaks over the same line, or the same person continuing, finds the cortex not `speaking` and publishes no second `voice.stop`; their line takes the ordinary path (SAL-BARGE-010). A new `brain.say` starts a new episode.

**Reflex lines.** Salience remembers whether the `brain.say` that last put the cortex in `speaking` was a reflex line, one whose `reason` starts with `reflex:` (SAL-BARGE-006). A reflex line is a short canned reaction, and cutting it off to answer the interrupter would waste both. A later non-reflex `brain.say` replaces the memory, so a reflex that is followed by a cortex line makes the line interruptible again.

**Echo.** A `speech.heard` that is the co-host's own voice heard back would interrupt itself. The defences are upstream: the Discord connector reads no bot account's audio, and ears drops utterances of sources named in `ears.echo_suppress_sources` while a line plays ([ears](../ears/ears-design.md) Echo gate). `brain.salience.barge_in_sources` defaults to the one source that cannot carry echo.

## Reflexes

`Reflexes` (`reflex.ts`) compiles each configured rule's `match` into a case-insensitive `RegExp` at construction. `test(sense, text, now)` walks rules in config order and returns the first that: lists `sense` in `on`, is past its own `cooldown_ms` (default 30000, per rule, tracked in `lastFired`), and matches. A hit stamps `lastFired`, picks a random `say` entry (`Math.random`), and returns `{text, emotion, gesture, rule: rule.match}`. Config validation guarantees a valid regex and non-empty `say` (`schema.ts`).

`Salience.reflex()` (`salience.ts`) runs inline in the intake handler:

1. Skip if paused, muted, or no rules.
2. Skip if `busy()` or `scheduler.cooling()` - gated BEFORE `test()` so a gated line does not spend the rule's own cooldown.
3. `reflexes.test(...)`; on hit, log, `ctx.markSeenEvents([trigger])` where `trigger` is the entry returned by `ctx.push` for the arriving event (SAL-REFLEX-008; only the triggering event is consumed; other unseen events still count toward the next decision), and publish `brain.say` with `reason: "reflex: <match>"` and `propagatedFlags(trigger)`.

The global cooldown is shared with the main path: any `brain.say` (including a reflex's own echo coming back through the subscription) starts it. A reflex also starts the cooldown and marks the cortex `speaking` locally before it publishes, so no tick or second rule can fire in the window before the echo returns (SAL-REFLEX-007); a reflex whose publish then fails still holds the cooldown.

## Control, Pause and Injection Flags

`control` events (`salience.ts`): if `target` is set and is not `salience`, ignore. `pause` / `resume` set `paused` (intake continues; `tick` and `reflex` return early); the window's arrivals hold (`holdArrivals` on `pause`, `releaseArrivals` on `resume`, working-memory WM-SEEN-004) records the entries taken in while paused, at most one window's worth, and marks them seen on `resume` (SAL-CTRL-007). `mute` / `unmute` set `muted` (decide returns `muted`; reflex returns early). `forget_context` clears the `Context`. `say` and `reload_personality` are ignored. Nothing is published when pausing or muting, and none of this state is persisted: a restarted salience starts unmuted and unpaused (SAL-CTRL-006), even if the dashboard still shows it muted.

Mute and pause are turn-taking controls seen only by the two regions that decide to speak: salience (here) and cortex. voice and ears never subscribe to `control`; an operator `say` goes through cortex and bypasses mute.

Test injection: `propagatedFlags(src)` from working-memory copies `injected: true` (and `remember` if defined) from the focus/trigger event onto `attention.focus` / reflex `brain.say`; real events get neither flag even if a stray `remember` is present (`packages/working-memory/src/index.ts`). Injected events are otherwise scored and reacted to like real ones. A mixed batch follows only the focus event's flags (`test/salience.region.test.ts`).

## Health and Lifecycle

`salienceHealth(cfg)` returns `{ service: "salience", mode, deps: {} }`, the config-derived base, where `mode` is `mock` for an `llm` scorer hook that inherits the mock provider and `live` otherwise (SAL-HEALTH-005). Once `salienceMain` has built the scorer, the heartbeat takes its mode and merges its `deps` from `hookHealth` (`hook.salience.scorer` for an llm or http scorer, nothing for a rules scorer; HOOK-HEALTH-004, SAL-HEALTH-001). A pause shows as the heartbeat `detail` `paused` (SAL-HEALTH-004). `startHeartbeat` emits `starting` at boot; `heartbeat.ready()` follows once the consumer group has been created and the tick timer is set (SAL-HEALTH-001): `salienceMain` awaits `bus.resetGroup("salience")` (creates a missing group at `$`, moves an existing one there: the same position start mode `latest` takes) before starting the subscription, because `bus.subscribe` resolves only on stop and offers no readiness signal. `stopping` is sent by a `beforeShutdown` hook that the shared `onShutdown` runs before the service's own callback (`packages/shared/src/lifecycle.ts`). Heartbeat semantics are owned by control-plane.

Every startup step runs under `runService` (`loadConfig`, `new Bus`, `startHeartbeat`) or inside `salienceMain` (`createScorer`, `new Salience`, group creation, subscription), so any failure exits 1 (SAL-HEALTH-003): a configuration that does not load logs the loader's message, every other step logs `fatal`; `createScorer` throws for `kind: http` with an empty `url` (`packages/modules/src/index.ts`). `runSalience` takes its collaborators (`loadConfig`, `createBus`, `createScorer`, `onShutdown`, `exit`, `log`) as an optional parameter, which is how tests run it against a fake bus. A failed tick or `attention.focus` publish is logged and the next tick runs (SAL-HEALTH-002). The teardown step registered with `onStop` clears the tick `setInterval`; the bootstrap then calls `bus.stop()` and the shared helper calls `process.exit(0)`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Aggregate score | The sum of the counted events' scores vs a threshold, focus = the highest counted: speech and vision always count, a chat line counts once per viewer and once per distinct text (Counting a burst) | Sum every unseen event; max-only; per-event threshold; a per-viewer rate limit across decisions | The threshold is the "Summed event score needed to speak" (`packages/config/src/schema.ts`, `config/config.example.yaml`). A sum lets a lively room of different viewers add up to a reply while one strong event (a mention at 1.0, speech at 0.9) clears the threshold alone; max-only would leave a busy chat of small lines unanswered and a per-event threshold would do the same. A sum of every line hands the co-host's speaking to whoever types fastest, because one viewer's lines alone reach the threshold (owner decision: a burst counts once per viewer, identical text counts once across all viewers). The discount is in the sum, not at intake, so every line stays in the window, the transcript and memory. A rate limit across decisions is a different rule (Open Questions). |
| What counts once | A chat line is discounted when a counted line has the same viewer (`viewerKey`: platform and user id) or the same text under `normalizeKey` (shared-runtime) | Identical text within one viewer only; strip punctuation before comparing; key a viewer on the display name | Owner decision 2026-11-16: a viewer is a platform and a user id, never a display name, because two viewers can share a name across platforms (and YouTube does not keep display names unique), and a sensitive note about one must never be applied to the other (HLD tenet 9). Across-viewer text identity is what stops a pasted copy from a raid (owner decision); the same-viewer rule alone would make an identical repeat from one viewer redundant with the viewer rule. A wave of the same `lol` from several viewers counts once; such a moment usually comes with something the streamer said or showed, which scores on its own. Stripping punctuation is hard to explain and a viewer varying punctuation is still one viewer. The window entry carries the platform and user id beside the name for this. |
| One comparison for salience and affect | Both use `createOnceCounter` and `normalizeKey` from the shared guard | A comparison in each region | HLD tenet 11: "same viewer" and "same text" must mean the same where the co-host decides to speak and where its mood moves. |
| Walk order and focus ties | Highest score first, later in window order among equal scores; the first counted event is the focus | Earlier first among ties; window order | The later of a viewer's equal lines is the one a reply should answer, and a fixed order makes the counted set the same on every tick. Arrival order is the order the window holds, so it needs no clock and cannot tie. Keeping the earlier would answer the oldest of equal lines while newer ones wait. |
| Flood versus reflexes | Reflexes are outside the counting walk; their per-rule cooldown and the global gates bound a flood | Count reflex-matching lines once per viewer too | A reflex consumes only its triggering line and fires at most once per rule cooldown and never while cooling or busy, so a flood cannot repeat one; counting would add a second mechanism to a path that is already bounded. |
| Discounting, not dropping | Discounted lines stay in the window, the transcript and memory; they only add nothing to the total | Mark discounted lines seen at intake and drop them; filter at the sense | The co-host still sees what chat looks like in the transcript, memory still records addressed lines, and the sense stays a pure translator. Nothing here is a moderation action. |
| Score caching | `WeakMap<ContextEvent, number>`, scorer only sees fresh events | re-score all unseen each tick | `scheduler.ts` comment ("an llm/http scorer must not be re-asked about the same input"); commit `969f6d7` ("Fix review findings": "ticks stop re-asking an llm/http scorer about the same input"); test `salience.test.ts`. |
| Mark-seen granularity | Mark only `decision.scored` / reflex trigger | `markSeen()` all | `salience.ts` comment and `scheduler.ts` doc comment; commit `969f6d7` ("a mention that lands mid-await is no longer marked seen unscored"; "Reflexes ... mark only their triggering event"); tests `salience.test.ts`, `salience.region.test.ts`. |
| Re-entrancy | `deciding` flag skips overlapping ticks | queue ticks; abort in-flight | `salience.ts` comment: an llm/http scorer can take longer than a tick; test `salience.region.test.ts`. |
| Optimistic busy after focus | Set cortex `thinking` locally on publish | wait for cortex `brain.status` | `salience.ts` comment: stops double-firing on the next tick; test `salience.region.test.ts`. |
| Reflexes gated by busy/cooldown | Gate before `test()` | let reflexes interrupt | `salience.ts` comment ("A reflex is still a line of speech"; gate before `test()`, which spends the rule's cooldown); commit `969f6d7` ("Reflexes now respect busy and the cooldown"); test `salience.region.test.ts`. Barge-in keeps this stance in both directions: a reflex never interrupts a line, and a reflex line is never interrupted (SAL-BARGE-006); a person's speech interrupts the line first, and the reflex test then runs against the freed state. |
| Who decides to stop a line | salience, on a final `speech.heard`, by publishing `voice.stop` | cortex decides and aborts its think; ears publishes a stop on speech start; voice stops itself when it hears speech | salience already owns when the co-host may speak and the busy state a stop must release (tenet 4, Speaking is gated); cortex has no turn-taking role and abort is rejected (cortex Decisions); ears has no knowledge of the co-host's state and a speech-start edge fires on coughs and backchannel. The final transcript is the one speech event every region already trusts (SAL-IN-007). |
| Interrupter's reply is not held back | The stop sets the cortex state to `idle` and clears the cooldown at once | Wait for cortex to report `idle`; leave the cooldown running | Waiting makes the reply to the interrupter depend on a round trip through cortex and voice that the person is already waiting through; a cooldown started by the line just cut off would hold back the very reply the stop exists to allow. The `brain.status` that cortex then publishes agrees with the local state. |
| Interruptible, dynamic speech (deferred) | Salience only stops a whole line and hands the interrupter to the ordinary decision | Re-evaluate at clause boundaries during a line, with continue, adapt, pivot and resume outcomes | The deferred ideal ([HLD](../../high-level-design.md) Future / ideal state, CTX-REPLAN-001) would supersede the rejections of aborting an in-flight decision (Re-entrancy) and of letting reflexes interrupt, because the decision to continue or pivot would move into the speaking line itself. It needs chunked speech, a streaming model, a playback position and live vision, none of which exist, so salience keeps the single stop. |
| Barge-in off by default | `brain.salience.barge_in` defaults to false | On by default | Owner decision: it is off until verified live; the only live source today is Discord, which needs a bot token. |
| Barge-in sources default | `["discord"]` | Every source; the desktop source too | Desktop audio can contain the co-host's own voice and the game's, neither of which is a person interrupting; the echo gate drops desktop audio while a line plays anyway. An event with no `source` (injected, older) is not interruptive. |
| Minimum words | At least `barge_in_min_words` (default 2) whitespace-separated tokens that contain a letter or a number | Any final transcript; a duration threshold; a list of backchannel words | A one-word "mm" or "yeah" is the common listening noise and a word count needs no list or tuning per language. A two-token backchannel such as "uh huh" does interrupt; raising the key is the lever. |
| Order of the barge-in check | Before the reflex test | After the reflex test | The reflex gate would hold back a reflex on the interrupter's own words while the co-host is still marked speaking; checking first lets a matching reflex answer them. |
| Barge-in and the speaking valve | No stop once the speaking valve has expired (`busy()` false) | Stop whenever the last state is `speaking` | An expired valve means the cortex is assumed idle already; a stop then has nothing to stop and the line takes the ordinary path. |
| Cooldown trigger | Any `brain.say` from any source starts it | only salience's own focus | `salience.ts` comment ("Whoever spoke (cortex, a reflex, the operator), the cooldown starts now") and `scheduler.ts` ("anyone's, including reflexes"); test `salience.region.test.ts`. |
| Mood coupling | Arousal lowers threshold, floor 0.1 | ignore mood | Coupling: `scheduler.ts` ("excited = chattier"), `packages/config/src/schema.ts`, commit `969f6d7` (salience "gets chattier when affect reports high arousal"); test `salience.region.test.ts`. The 0.1 floor (`scheduler.ts`) keeps a positive bar whatever the mood and the configured threshold, so a total of zero (unchanged vision, or scores that an llm/http scorer set to 0) never makes the co-host speak; it also applies when `speak_threshold` itself is set below 0.1. |
| Safety valves | `brain.salience.thinking_timeout_ms` (default 60 s) for `thinking`, cortex `speaking_timeout_ms` for `speaking` | rely only on cortex reporting; hard-coded 60 s thinking valve | Valves exist for "a cortex that never reports back, or a voice sink that never says done" (`salience.ts` comment). owner decision 2026-11-01: the thinking valve is a `brain.salience` key like every other salience timing knob; the 60 s default matches the default chat-model request timeout (`llm.timeout_ms`, 60000), so a cortex stuck on a hung model call is released at about the time that call would time out; a think also spends up to `recall_timeout_ms` on recall and a critic call, so a slow but healthy think can outlast the valve, which costs at most one extra focus that the cortex answers with `thinking` (`CTX-GATE-001`). |
| Timing clock | Injected monotonic clock (`SalienceDeps.now`, default `performance.now`) | `Date.now` | Valves and cooldown are durations; `Date.now` follows wall-clock steps, so a time-sync step backwards held a speaking valve shut and a step forwards ended a cooldown early (seen as flapping tests on a WSL2 host whose clock flapped by about 25 s). An injected clock also lets tests step time without mocking the global `Date`. |
| Busy states | `thinking` and `speaking` are busy; cortex `muted` is not | treat cortex `muted` as busy | owner decision 2026-11-01: salience has its own mute flag from `control`; a cortex-side `muted` status adds nothing. |
| Pause semantics | Keep ingesting events, stop deciding/reflexing | drop events while paused; exit process | `salience.ts` comment ("context is not lost"); test `salience.region.test.ts`. |
| Control targeting | `target` filter applies to all control commands | pause-only filter | `packages/bus/src/events.ts` ("Service the command is addressed to; absent = all services (back-compat)"); test `salience.region.test.ts`. |
| Flag propagation | Copy `injected`/`remember` only from the focus/trigger event | copy from any event in batch; correlate by id | Mixed batches follow the focus event (the one being replied to), because that is what the reply is about; reflexes copy from the triggering event; id correlation is rejected (stateful, unordered across regions). Tests `salience.region.test.ts`, `:220-231`. |
| Idle chatter on a silent stream | Idle chatter needs at least one unseen event; a fully silent stream stays silent | speak unprompted after `idle_chatter_ms` of total silence | owner decision 2026-11-01: the code and the config comment (`config/config.example.yaml`, "and there's fresh context") are the intent; breaking a dead stream on its own is a deferred project goal. |
| Restart start mode | Event-bus start mode `latest`: the `salience` group moves to the tail on every start | `resume` (replay the backlog after a restart) | owner decision 2026-11-01: stale chat would fire reflexes and stale `brain.say` / `brain.status` would corrupt the busy state; delivery across restarts is at-most-once project-wide, and only memory resumes. |
| Mute ownership | Mute and pause gate salience and cortex only | mute every output service (voice, ears) | owner decision 2026-11-01: the regions that decide to speak are the ones that stop; voice and ears play whatever `brain.say` they get, and an operator `say` (through cortex) bypasses mute. |
| Decision in flight at mute/pause | Re-check muted, paused and busy after the scorer returns; drop the focus if any holds | let the in-flight decision publish | owner decision 2026-11-01: "while muted, publish no `attention.focus`" covers a decision already started. |
| Reflex self-gating | A reflex starts the cooldown and marks `speaking` locally at publish | wait for the `brain.say` echo | owner decision 2026-11-01: closes the window in which a tick or a second rule fires before the echo. |
| Mute and pause persistence | In process memory only; a restart starts unmuted and unpaused | persist in Redis or the control plane | owner decision 2026-11-01: accepted for now; revisit if the control plane gains persisted state. |
| Reason label | `mentioned` only when the focus is a mention and `reply_on_mention` is true | label every mention `mentioned` | owner decision 2026-11-01: the reason reports why salience spoke; with `reply_on_mention` off a mention is ordinary chat. |
| LLM scorer prompt | Marks mention, mod and sub inside the brackets before the label; names are `speakerLabel`s, chat text is quoted, speech and screen text is bounded and unquoted; a standing notice says a score is a judgement, not an order | mention and mod only; plain lines; quote every kind | The prompt carries every signal the rules scorer weights (owner decision 2026-11-01). The scorer reads text anyone can type, so it uses the shared guard like every prompt that carries viewer text; one line per event keeps the "one number per event" contract true whatever a message contains. Speech is the streamer's, so it is not quoted (shared-runtime Decisions, What is guarded). |
| Failure posture | A failed tick or publish is logged and the loop continues; every startup step runs inside `main()` so a startup failure logs `fatal`; `ready` follows consumer-group creation | crash and let compose restart | owner decision 2026-11-01: a crash loses mute and pause (SAL-CTRL-006) and hides the cause; `ready` should mean the subscription is running. |
| Readiness signal | `salienceMain` awaits `bus.resetGroup("salience")`, then starts `subscribe` (start mode `latest`) and reports `ready` | add a readiness callback or promise to `Bus.subscribe`; report `ready` right after starting `subscribe` | `Bus.subscribe` resolves only on stop and has no readiness signal, and the bus is another segment. `resetGroup` leaves the group at `$`, the position `latest` takes anyway, so the second move inside `subscribe` is harmless. A readiness signal in event-bus would remove the extra call. |
| Tick failure handling | `tick()` catches and logs its own failures | catch at the timer call site in `main.ts` | the guarantee (SAL-HEALTH-002) then holds for every caller of `tick()`, tests included, not just the timer. |
| Void decision at mute/pause or removal | The decision's events stay unseen and the optimistic `thinking` state is not set; the same when the focused chat line was removed while the scorer ran | mark them seen anyway | a dropped decision published nothing, so the cortex never saw the events; they are scored (cached) and still count at the next decision, as events that arrive during a pause do. |
| Pause and resume | A pause is reported in the heartbeat `detail` (`paused`, through `controlFor`); on `resume` the events the window took in while paused are marked seen (SAL-HEALTH-004, SAL-CTRL-007) | Silent pause; score the backlog on resume; drop events while paused | Owner decision 2026-11-11: the operator must see the pause on the Services row, and a burst that accumulated while the co-host was silenced is stale, so answering it on resume would speak about old news. Intake continues during the pause so the window still carries context. Events from before the pause stay unseen: only what arrived during it is stale. |
| Reflex trigger | `Context.push` returns the entry and the reflex path receives it (SAL-REFLEX-008) | Read `ctx.last()` after the push | The result of a push does not depend on the window staying unchanged between the push and the read, which concurrent intake would break. |
| Cooldown check | One `Scheduler.cooling()` used by `decide` and by the reflex gate | A second inline comparison in `decide` | A single definition cannot drift. |
| Vision | Vision never resets the idle timer, and an unchanged summary enters the window already seen, so only changed screens are scored | Score every summary; reset idle on vision | Only a changed screen is worth scoring or a reply; an unchanged one is not new input. |
| Heartbeat mode | `mock` only where the scorer is an `llm` hook inheriting the mock provider (SAL-HEALTH-005) | Always `live`; `mock` whenever `llm.provider` is `mock` | A rules or http scorer never calls the provider, so `mock` there would mislead; an inheriting llm hook falls back to the rules on every call, which is what `mock` tells the operator. |
| Bootstrap | `runService` from `@cohost/shared`; `salienceMain` holds the service, `runSalience` wires it with replaceable collaborators | A hand-written `main` per service | One bootstrap gives every service the same logger, config failure, heartbeat, shutdown and `fatal` path (SHARED-BOOT-*). |
| Speech trigger | A final `speech.heard` that no reflex handled starts one `tick()` at once, unawaited, behind `brain.salience.trigger_on_speech` (default true) | Only shorten `tick_ms`; trigger from `speech.partial`; a bus hop (salience republishes an internal event and handles it) instead of an inline call; score a speech line in the intake handler | A shorter poll still averages half a tick of wait and multiplies idle scoring work; a partial is an unstable transcript (ears Decisions, "Partials never reach the brain"); a bus hop adds a publish and a read for a call that is already in-process; scoring in the handler would put an unbounded scorer call in the intake path. An inline unawaited call reuses `decideAndPublish` and every gate unchanged, so the trigger cannot differ from the poll in what it publishes. |
| Poll kept beside the trigger | `tick_ms` keeps running whatever `trigger_on_speech` is | Replace the poll with triggers only; poll only while the trigger is off | Chat, vision and idle chatter have no trigger, a trigger that meets a cooldown or busy cortex needs a later pass, and a poll costs one early-returning call per `tick_ms` when nothing is unseen. |
| Rerun after a decision in flight | One boolean pending-rerun flag, cleared when the rerun starts | Drop a trigger that lands mid-decision and wait for the poll; queue one pass per trigger; abort the in-flight decision | Dropping makes the utterance wait up to `tick_ms` behind a slow scorer, which is the latency the trigger removes; a queue runs passes that find nothing unseen; aborting wastes a scorer call whose scores are cached anyway (SAL-SCORE-006). |
| No expiry timers (deferred) | Nothing re-evaluates when a cooldown or busy valve ends, except the poll (SAL-TRIG-010) | A timer set at the end of cooldown or valve | A timer per gate is state with its own cancel, pause and mute handling, and the poll already bounds the wait to `tick_ms` after expiry; it is a separate change if the wait proves audible. |
| Latency stamps on `attention.focus` | Copy the focused `speech.heard`'s `audioEndedAt` and envelope `ts`, or the focused `vision.summary`'s `capturedAt` and `describedAt`, into `timing` | Carry nothing and let the report join `attention.focus` to the nearest earlier `speech.heard` by text; stamp a salience-side receive time | `attention.focus` has no id of the event it answers, so a text join misattributes repeated phrases; a receive time would add a stamp that differs from the envelope `ts` by queueing the report cannot attribute. Copying costs two numbers and keeps the chain exact. |

## Open Questions & Future Decisions

- **A viewer who is answered again and again.** The count is per decision, so one viewer who mentions the co-host every few seconds is answered once per decision, at most once per cooldown, and a different phrasing each time defeats the identical-text rule. Readings: leave it (a mention is meant to be answered, and cortex's repetition check stops the co-host repeating itself); or discount a viewer for a period after they were answered, which needs a clock, a per-viewer record that salience does not keep, and a new key. Not decided.
- **Several viewers named `unknown`.** The burst rule counts every viewer with no user id whose name bounded to nothing as one viewer per platform; the question and its readings are in [chat](../chat/chat-design.md) Open Questions.
- **Re-evaluation at cooldown or valve expiry.** Deferred (SAL-TRIG-010): a speech line that arrives during the cooldown or while the cortex is busy waits for the next poll after the gate opens.
- **The co-host hearing itself.** Salience does not recognise the co-host's own voice: a `speech.heard` that echoes it is an ordinary speech line. Echo is handled upstream, by the source choice of `brain.salience.barge_in_sources` and by ears' echo gate (EARS-ECHO-001 to EARS-ECHO-009), not here.
- **Barge-in during a think.** Barge-in applies when the cortex is `speaking`. A line spoken by the operator (`say`) while the cortex is thinking also sets salience's state to `speaking`; interrupting it then leaves the think running (cortex CTX-GATE-010), and salience has no record of the think. Whether that case needs a rule of its own is undecided.
- **Interrupting an operator line.** An operator `say` line is interruptible like a cortex line; whether it should be exempt as an explicit override is undecided.

## References

Code (`services/salience/`): `src/index.ts`, `src/main.ts`, `src/salience.ts`, `src/scheduler.ts`, `src/scoring.ts`, `src/reflex.ts`, `src/health.ts`, `package.json`, `tsconfig.json`.
Tests: `test/salience.test.ts`, `test/salience.region.test.ts`, `test/scorer.test.ts`, `test/health.test.ts`, `test/main.test.ts`, `test/salience.dispositions.test.ts`, `test/salience.trigger.test.ts`, `test/salience.barge.test.ts`, `test/timing.test.ts`, `test/independence.test.ts`, `test/contract.test.ts`.

Segments depended on:
- event-bus (BUS): `Bus`, `Publisher`, `onShutdown`, event schemas for the events above (consumes `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `brain.status`, `affect.state`, `control`; produces `attention.focus`, `brain.say`, `voice.stop`).
- config (CFG): `loadConfig`; keys read: `viewer_text.max_chars`, `viewer_text.max_name_chars`, `brain.salience.*` (including `barge_in`, `barge_in_sources`, `barge_in_min_words`, CFG-SCH-035), `brain.working_memory_events`, `brain.cortex.speaking_timeout_ms`.
- working-memory (WM): `Context`, `propagatedFlags`.
- shared-runtime (SHARED): `quoteUntrusted`, `speakerLabel`, `untrustedNotice`, `createOnceCounter` and `normalizeKey` from `@cohost/shared/untrusted`.
- region-hooks (HOOK): `Module` / `salience.scorer`.
- control-plane (CTRL): heartbeat contract (`startHeartbeat`), `control` pause/resume semantics.

Downstream/peers: cortex (consumes `attention.focus`, publishes `brain.status`), affect (publishes `affect.state`), chat / ears / eyes (senses), dashboard (injection source).

External: Redis (via the bus); optional LLM provider or HTTP endpoint for the scorer hook.
