---
parent: high-level-design
prefix: SAL
---

# salience

Parent: [high-level-design](../../high-level-design.md). Specs: [salience-specs.md](salience-specs.md). Arrow: [docs/arrows/salience.md](../../arrows/salience.md).

## Context and Design Philosophy

salience is the "attention" region of the brain (amygdala / salience network metaphor, `services/salience/src/index.ts:2`). It is a standalone Redis-bus service (`@cohost/salience`, `services/salience/package.json:2`) whose one job is deciding *when* the co-host should speak. It never produces the words: when something is worth a reply it publishes `attention.focus` and the cortex segment takes over; separately it owns a "reflex" fast path that publishes `brain.say` directly with canned lines and no model in the loop (`index.ts:5-8`).

Design philosophy as the code shows it:

- Cheap and continuous: scoring defaults to hard-coded rule weights (`scoring.ts:24-37`); the region keeps its own small `Context` rather than querying anything (`salience.ts:19,32`).
- Timing lives in `Scheduler`, judgement lives in a pluggable `salience.scorer` hook (`rules` / `llm` / `http`, owned by region-hooks) that always falls back to rules (`scoring.ts:61`, `packages/modules/src/index.ts:53-63`).
- Turn-taking is inferred from bus traffic only: `brain.status`, `brain.say` and `affect.state`; salience does not subscribe to `voice.playing` / `voice.done` (`index.ts:31`).
- Everything is in-process mutable state (muted, paused, arousal, cortex state, cooldown timestamps, score cache); nothing is persisted (`salience.ts:22-29`, `scheduler.ts:23-25`).

Code layout: `index.ts` wires config, bus, heartbeat, scorer, a `Salience` instance and a tick timer. `salience.ts` is event intake + reflex + tick. `scheduler.ts` is the speak/no-speak decision. `scoring.ts` is score input/output types, rule weights and the module factory. `reflex.ts` is the regex rule engine. `health.ts` is the static heartbeat spec.

## Event Wiring

Subscription (`index.ts:28-35`): consumer group `salience`, `fromNow: true`, types `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `brain.status`, `affect.state`, `control`. `fromNow` only positions a group the bus has to create: a new group starts at the stream tail (`$`), while an existing group resumes after its last delivered entry (`packages/bus/src/index.ts:17,22,126-131`). A process restart (for example compose's `restart: unless-stopped`) therefore replays whatever was published while salience was down; a control-plane start in `fresh` mode, salience's manifest default (`packages/control/src/manifest.ts:40`), first resets the group to `$` (`packages/bus/src/index.ts:109-120`). The handler is `salience.onEvent`; the bus catches and logs handler errors and acks regardless (`packages/bus/src/index.ts:153-159`), so a failed reflex publish is logged, not fatal. `bus.subscribe` is started with `void` and not awaited (`index.ts:28`).

| Event in | Handling (file:line) |
|---|---|
| `chat.message` | `ctx.push`, `scheduler.noteActivity()`, then `reflex("chat", text)` (`salience.ts:39-45`) |
| `speech.heard` | `ctx.push`, `noteActivity()`, `reflex("speech", text)` (`salience.ts:46-52`) |
| `vision.summary` | `ctx.push`; `reflex("vision", text)` only if `changed`; does NOT call `noteActivity()` (`salience.ts:53-58`) |
| `brain.say` (from anyone: cortex, reflex echo, operator) | `scheduler.noteSpoke()` (starts cooldown, resets idle timer), cortex state `speaking` (`salience.ts:59-64`) |
| `brain.status` | store `state` and timestamp (`salience.ts:65-70`) |
| `affect.state` | store `arousal` only (`salience.ts:71-73`) |
| `control` | see Control section (`salience.ts:74-83`) |

| Event out | When |
|---|---|
| `attention.focus` `{reason, score, focus?, injected?, remember?}` | tick decides to speak (`salience.ts:122-131`) |
| `brain.say` `{id, text, emotion, gesture?, reason: "reflex: <regex>", injected?, remember?}` | reflex hit (`salience.ts:98`) |
| `service.heartbeat` (via `startHeartbeat`) | boot, ready, periodic, stopping (`index.ts:23,37`) |

Working memory: `Context` from the working-memory segment, sized `brain.working_memory_events` (default 24, `packages/config/src/schema.ts:97`). It is private to this process; salience never pushes `self` lines (it does not call `pushSelf`), though the scheduler and `toScoreInput` still defensively skip `self` events (`scheduler.ts:47`, `scoring.ts:15-19`).

## Scoring

`scoreRules` (`scoring.ts:24-37`) returns one number per event, in order:

| Event | Score |
|---|---|
| speech | 0.9 |
| chat, mentions co-host and `reply_on_mention` | 1.0 |
| chat containing `?` | 0.55 |
| chat from mod or sub | 0.35 |
| other chat | 0.15 |
| vision, `changed` | 0.3 (unchanged vision: 0) |

These match the weights quoted in `README.md` ("Talkativeness") and `config/config.example.yaml:68` and are asserted in `test/salience.test.ts:21-36`. `toScoreInput` flattens unseen context events into `ScoreInput.events` (kind, who, text, mention, isMod, isSub, changed) plus the current arousal (`scoring.ts:13-21`).

`createScorer` builds `new Module("salience.scorer", cfg.brain.salience.module, cfg.llm, impl, log)` (`scoring.ts:45-62`). `rules` uses `reply_on_mention`; `llm` has a JSON-only system prompt naming the co-host and streamer, a user prompt listing arousal and numbered events marked with kind, mention and mod (not sub), `maxTokens: 120`; `http` and `llm` share `validate`, which accepts only an object with a `scores` array of the same length as the input whose members are all finite numbers, clamping each to 0..1, and otherwise returns undefined so `Module.run` falls back to rules (`scoring.ts:39-43`, `packages/modules/src/index.ts:53-63`). Module default `timeout_ms` is 1500 (`packages/config/src/schema.ts:17`). Module construction and fallback semantics are owned by region-hooks; salience owns the input/output shapes and weights.

## Decision and Tick

`Salience.tick()` runs every `brain.salience.tick_ms` (default 1500; `index.ts:36`). Flow (`salience.ts:109-133`):

1. Return immediately if paused or a previous decision is still in flight (`deciding` flag; an llm/http scorer can outlast a tick).
2. `scheduler.decide(ctx, busy(), muted, arousal)`.
3. If it says speak: mark exactly `decision.scored` seen (events that arrived while an async scorer ran stay unseen), set cortex state to `thinking` optimistically (so the next tick does not double-fire), and publish `attention.focus` with the focus mapped to `{kind:"chat", who, text, mention}`, `{kind:"speech", who, text}`, `{kind:"vision", text}` or undefined, plus `propagatedFlags(focus)`. The bus schema fills a missing focus `mention` with `false` (`packages/bus/src/events.ts:77`).

`muted`, `busy()` and `paused` are read once, before the scorer is awaited; `tick` does not re-read them when the decision returns, so a `mute` or `pause` that arrives while an llm/http scorer is running does not stop that decision's `attention.focus` (see Open Questions).

`Scheduler.decide` (`scheduler.ts:41-76`) evaluates in this order and returns the first that applies:

1. `muted` -> no speak, reason `muted`.
2. `busy` -> `cortex busy`.
3. `now - lastSpoke < cooldown_ms` (default 6000) -> `cooldown`.
4. No unseen non-`self` events -> `nothing new`.
5. Score only events not already in the `WeakMap` score cache (so an event waiting across ticks is never re-sent to an llm/http scorer), `score` = SUM of cached scores over all unseen events, `focus` = highest-scoring one (`scheduler.ts:50-64`).
6. `threshold = max(0.1, speak_threshold - arousal_bias * arousal)`; defaults 0.6 and 0.2. If `score >= threshold` -> speak, reason `mentioned` (focus is a chat mention) else `engaged`.
7. Else if `idle_chatter_ms > 0` (default 90000) and `now - lastActivity > idle_chatter_ms` -> speak, reason `idle chatter`.
8. Else no speak, reason `score X < Y`.

`lastActivity` is reset by chat and speech intake and by any `brain.say` (`scheduler.ts:29-39`, `salience.ts:44,50,61`). Because step 4 returns before step 7, idle chatter can only fire when at least one unseen event exists (see Open Questions).

## Busy Gating and Cooldown

`busy()` (`salience.ts:101-107`) looks at the last cortex state seen on the bus and its age:

- `thinking`: busy while age < 60 000 ms (hard-coded).
- `speaking`: busy while age < `brain.cortex.speaking_timeout_ms` (default 20000) - a key owned by the cortex segment's config block (`schema.ts:148`), read here.
- `idle` and `muted` (and the initial `idle`): not busy.

Cortex state is set from `brain.status` (`salience.ts:65-70`), set to `speaking` on any `brain.say` (`salience.ts:62`) and set to `thinking` locally after publishing `attention.focus` (`salience.ts:119`). The return to `idle` depends on the cortex publishing `brain.status idle` (cortex segment); the two valves above are the safety net.

Arousal: `affect.state.arousal` is stored raw; it lowers the speak threshold (step 6 above) and is passed to the scorer as `ScoreInput.arousal` (`scheduler.ts:54`). Initial arousal is 0 until the first `affect.state` arrives (`salience.ts:25`).

## Reflexes

`Reflexes` (`reflex.ts:13-33`) compiles each configured rule's `match` into a case-insensitive `RegExp` at construction. `test(sense, text, now)` walks rules in config order and returns the first that: lists `sense` in `on`, is past its own `cooldown_ms` (default 30000, per rule, tracked in `lastFired`), and matches. A hit stamps `lastFired`, picks a random `say` entry (`Math.random`), and returns `{text, emotion, gesture, rule: rule.match}`. Config validation guarantees a valid regex and non-empty `say` (`schema.ts:110-124`).

`Salience.reflex()` (`salience.ts:88-99`) runs inline in the intake handler:

1. Skip if paused, muted, or no rules.
2. Skip if `busy()` or `scheduler.cooling()` - gated BEFORE `test()` so a gated line does not spend the rule's own cooldown.
3. `reflexes.test(...)`; on hit, log, `ctx.markSeenEvents([trigger])` where `trigger = ctx.last()` (only the triggering event is consumed; other unseen events still count toward the next decision), and publish `brain.say` with `reason: "reflex: <match>"` and `propagatedFlags(trigger)`.

The global cooldown is shared with the main path: any `brain.say` (including a reflex's own echo coming back through the subscription) starts it.

## Control, Pause and Injection Flags

`control` events (`salience.ts:74-83`): if `target` is set and is not `salience`, ignore. `pause` / `resume` set `paused` (intake continues; `tick` and `reflex` return early). `mute` / `unmute` set `muted` (decide returns `muted`; reflex returns early). `forget_context` clears the `Context`. `say` and `reload_personality` are ignored. Nothing is published when pausing or muting, and none of this state is persisted.

Test injection: `propagatedFlags(src)` from working-memory copies `injected: true` (and `remember` if defined) from the focus/trigger event onto `attention.focus` / reflex `brain.say`; real events get neither flag even if a stray `remember` is present (`packages/working-memory/src/index.ts:15-20`). Injected events are otherwise scored and reacted to like real ones. A mixed batch follows only the focus event's flags (`test/salience.region.test.ts:210-218`).

## Health and Lifecycle

`salienceHealth = { service: "salience", mode: "live", deps: {} }` (`health.ts:4`). `startHeartbeat` is called at module load (`index.ts:23`, emitting `starting`), and `heartbeat.ready()` is called after `bus.subscribe` is *started* (not awaited) and the tick timer is set (`index.ts:28-37`). `stopping` is sent by a `beforeShutdown` hook that the shared `onShutdown` runs before the service's own callback (`packages/bus/src/heartbeat.ts:115`, `packages/bus/src/index.ts:236-240`). Heartbeat semantics are owned by control-plane. If `main()` rejects the process logs `fatal` and exits 1 (`index.ts:41`); `main()` itself awaits nothing, and the work that can throw at startup (`loadConfig`, `new Bus`, `startHeartbeat`, `createScorer`, `new Salience` at `index.ts:20-25`; `createScorer` throws for `kind: http` with an empty `url`, `packages/modules/src/index.ts:45-48`) runs at module load, outside that handler. `onShutdown` only calls `bus.stop()` (`index.ts:42`); the shared helper then calls `process.exit(0)` (`packages/bus/src/index.ts:241`), so the uncleared tick `setInterval` (`index.ts:36`) does not outlive the process in practice.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Aggregate score | Sum of every unseen event's score vs a threshold, focus = max | max-only; per-event threshold | Summing is deliberate: the threshold is documented as the "Summed event score needed to speak" (`packages/config/src/schema.ts:103`, `config/config.example.yaml:68`) and tests assert sums (`test/salience.test.ts:77`, `test/salience.region.test.ts:35,100`). Why a sum rather than a max: `[inferred]` so a burst of low-value chat can add up. |
| Score caching | `WeakMap<ContextEvent, number>`, scorer only sees fresh events | re-score all unseen each tick | `scheduler.ts:50-51` comment ("an llm/http scorer must not be re-asked about the same input"); commit `969f6d7` ("Fix review findings": "ticks stop re-asking an llm/http scorer about the same input"); test `salience.test.ts:101-115`. |
| Mark-seen granularity | Mark only `decision.scored` / reflex trigger | `markSeen()` all | `salience.ts:116` comment and `scheduler.ts:12` doc comment; commit `969f6d7` ("a mention that lands mid-await is no longer marked seen unscored"; "Reflexes ... mark only their triggering event"); tests `salience.test.ts:117-137`, `salience.region.test.ts:121-128`. |
| Re-entrancy | `deciding` flag skips overlapping ticks | queue ticks; abort in-flight | `salience.ts:110` comment: an llm/http scorer can take longer than a tick; test `salience.region.test.ts:108-119`. |
| Optimistic busy after focus | Set cortex `thinking` locally on publish | wait for cortex `brain.status` | `salience.ts:118` comment: stops double-firing on the next tick; test `salience.region.test.ts:52-62`. |
| Reflexes gated by busy/cooldown | Gate before `test()` | let reflexes interrupt | `salience.ts:90-91` comment ("A reflex is still a line of speech"; gate before `test()`, which spends the rule's cooldown); commit `969f6d7` ("Reflexes now respect busy and the cooldown"); test `salience.region.test.ts:141-160`. |
| Cooldown trigger | Any `brain.say` from any source starts it | only salience's own focus | `salience.ts:60` comment ("Whoever spoke (cortex, a reflex, the operator), the cooldown starts now") and `scheduler.ts:33` ("anyone's, including reflexes"); test `salience.region.test.ts:75-82`. |
| Mood coupling | Arousal lowers threshold, floor 0.1 | ignore mood | Coupling: `scheduler.ts:19-20` ("excited = chattier"), `packages/config/src/schema.ts:105`, commit `969f6d7` (salience "gets chattier when affect reports high arousal"); test `salience.region.test.ts:98-106`. The 0.1 floor (`scheduler.ts:66`): `[inferred]`, no stated reason. |
| Safety valves | 60 s thinking, `speaking_timeout_ms` speaking | rely only on cortex reporting | Valves exist for "a cortex that never reports back, or a voice sink that never says done" (`salience.ts:103` comment). The 60 s figure and why `thinking` reads no config key: `[inferred]`, no evidence. |
| Pause semantics | Keep ingesting events, stop deciding/reflexing | drop events while paused; exit process | `salience.ts:23` comment ("context is not lost"); `openspec/changes/archive/2026-11-01-add-service-control/design.md:27` ("event intake continues so context is not lost"); test `salience.region.test.ts:162-181`. |
| Control targeting | `target` filter applies to all control commands | pause-only filter | `packages/bus/src/events.ts:162-163` ("Service the command is addressed to; absent = all services (back-compat)"); `openspec/changes/archive/2026-11-01-add-service-control/design.md:27`; test `salience.region.test.ts:183-189`. |
| Flag propagation | Copy `injected`/`remember` only from the focus/trigger event | copy from any event in batch; correlate by id | `openspec/changes/archive/2026-11-01-add-test-injection/design.md:49-50` ("Mixed batches follow the focus event (the one being replied to), because that is what the reply is about"; reflexes copy from `ctx.last()`); id correlation rejected at `:53` (stateful, unordered across regions). Tests `salience.region.test.ts:210-218`, `:220-231`. |

## Open Questions & Future Decisions

1. **Idle chatter needs an unseen event.** `decide` returns `nothing new` (`scheduler.ts:47-48`) before the idle branch (`scheduler.ts:71-73`), so a fully silent stream never triggers idle chatter; every idle test pushes a chat line first (`test/salience.test.ts:92-98`). `config/config.example.yaml:66` says "if quiet this long *and there's fresh context*" and the OpenSpec ordering agrees, but `README.md` ("pipes up on its own after `idle_chatter_ms` of quiet") reads unconditional. Observed behavior, not asserted as a bug; intent to be confirmed.
2. **Tick interval not cleared on shutdown** (`index.ts:36`, `index.ts:42`). Cosmetic in practice because `onShutdown` ends with `process.exit(0)` (`packages/bus/src/index.ts:241`), but an in-flight tick during `bus.stop()` could race a publish on a closed connection.
3. **Unhandled rejections.** `void salience.tick()` (`index.ts:36`) and `void bus.subscribe(...)` (`index.ts:28`) discard promises. `tick` can reject if `bus.publish` fails (Redis down or zod parse error, `packages/bus/src/index.ts:46-58`); `subscribe` rethrows on non-BUSYGROUP errors or a failed `xreadgroup` (`packages/bus/src/index.ts:128-146`). No `unhandledRejection` handler exists in the repo, so Node's default terminates the process and compose's `restart: unless-stopped` (`docker-compose.yml:10`) brings it back, resetting all in-memory state.
4. **Hard-coded 60 s thinking valve** (`salience.ts:104`) while the speaking valve is configurable via another region's key (`salience.ts:105`, `schema.ts:148`). Cross-region config coupling; unclear why thinking is not configurable.
5. **Reflex does not record its own utterance locally.** The reflex path publishes `brain.say` (`salience.ts:98`) without calling `noteSpoke()` or setting cortex `speaking`; those happen only when the echo returns via the subscription (`salience.ts:59-64`). Between publish and echo, a tick could still fire `attention.focus` (cortex state/cooldown not yet updated) and a second reflex rule could match. Not exercised by tests (FakeBus does not loop back).
6. **`brain.status muted` is not busy** (`salience.ts:104-106`); mute is tracked only via `control` (`salience.ts:79`). If the cortex is muted but salience is not, salience still publishes `attention.focus`.
7. **Pause is silent and resume may release a stale burst.** No status is published on pause/mute (`salience.ts:77-80`). Events keep accumulating while paused (`salience.ts:37-58`, `tick` early return at `:110`), so on resume the first decision scores everything that arrived during the pause (bounded by the 24-event window).
8. **LLM scorer prompt omits `isSub`** (`scoring.ts:55` prints only mention and mod) though the rules weight subs at 0.35 (`scoring.ts:31`).
9. **Reason `mentioned` ignores `reply_on_mention`.** The reason keys on `focus.mention` (`scheduler.ts:68`), so with `reply_on_mention: false` a mention can still be labelled `mentioned`.
10. **Implicit ordering assumption.** `reflex()` treats `ctx.last()` as the triggering event "because reflex() runs synchronously after the push" (`salience.ts:93`). True today; breaks if intake is ever made concurrent.
11. **Duplicated cooldown check** in `Scheduler.cooling()` (`scheduler.ts:34-36`) and inline in `decide` (`scheduler.ts:45`).
12. **Header comment says salience "never talks to the LLM"** (`index.ts:5`) while the scorer hook can be `llm` kind (`scoring.ts:48-58`); the claim is only true of the chat path.
13. **Vision handling.** Vision never resets the idle timer (`salience.ts:53-58`), and unchanged vision summaries are inserted already-seen by working-memory (`packages/working-memory/src/index.ts:47`), so only changed screens are ever scored.
14. **Test gaps.** No test for the 60 s thinking valve (SAL-BUSY-001), for arousal being forwarded in `ScoreInput` (SAL-IN-004), for `index.ts` wiring (subscription list, tick interval, `ready()` ordering, `fatal` exit: SAL-IN-001, SAL-FOCUS-001, SAL-HEALTH-003), for the llm prompt text (SAL-SCORE-008), for chat/speech resetting and vision not resetting the idle timer (SAL-IN-002, SAL-IN-003), for `nothing new` winning over an elapsed idle timer (SAL-DECIDE-005), for the `score X < Y` reason text (SAL-DECIDE-006), for config-order precedence between two matching reflex rules (SAL-REFLEX-003), for a gated reflex not spending its rule cooldown (SAL-REFLEX-005: the test rule has `cooldown_ms: 0`), for the no-focus case of SAL-INJ-002 (the test named for it only covers a real focus), for `brain.status muted` not being busy (SAL-BUSY-004), or for the initial and restart state (SAL-IN-006, SAL-CTRL-006). Region tests use real timers (`test/salience.region.test.ts:70`).
15. **`ready()` precedes subscription readiness.** `heartbeat.ready()` is called right after the un-awaited `bus.subscribe(...)` call (`index.ts:28,37`), i.e. before the consumer group exists. SAL-HEALTH-001 states this observed timing; the OpenSpec heartbeat requirement reads "`ready` once its subscriptions are running", which may be the intended contract.
16. **Mute or pause during an in-flight decision.** `tick` passes `muted` and `busy()` to `decide` and checks `paused` before awaiting the scorer, and does not re-check any of them afterwards (`salience.ts:110-122`). With an llm/http scorer, a `mute` or `pause` that lands during the await does not stop that decision's `attention.focus` (reproduced with a gated scorer against the current code). With the `rules` scorer the await resolves before the next bus event is handled, so the window does not arise. Whether SAL-CTRL-002 / SAL-CTRL-004 ("while muted ... publish no `attention.focus`") cover a decision already in flight is unstated.
17. **Startup failures outside `main()`.** SAL-HEALTH-003 covers only `main()` rejecting, but `main()` awaits nothing; configuration, Redis client, heartbeat and scorer construction run at module load (`index.ts:20-25`), so for example `module.kind: http` with an empty `url` throws from `createScorer` (`packages/modules/src/index.ts:45-48`) as an uncaught exception, without the `fatal` log line. The exit code is still non-zero under Node defaults. The earlier wording ("If salience fails during startup") may have been the intended scope.
18. **Restart replays the backlog.** `fromNow` positions only a newly created consumer group (`packages/bus/src/index.ts:126-131`); after a crash and compose restart the existing `salience` group resumes and the new process receives everything published while it was down, so stale chat can fire reflexes and stale `brain.say` / `brain.status` update busy state. Control-plane `fresh` starts reset the group first (`packages/control/src/manifest.ts:40`). An earlier reading of SAL-IN-001 ("a restart skips backlog and starts at the stream tail") may have been the intent; crash-recovery semantics are an open event-bus decision (`docs/arrows/index.yaml`, event-bus `next`).

## References

Code (`services/salience/`): `src/index.ts`, `src/salience.ts`, `src/scheduler.ts`, `src/scoring.ts`, `src/reflex.ts`, `src/health.ts`, `package.json`, `tsconfig.json`.
Tests: `test/salience.test.ts`, `test/salience.region.test.ts`, `test/scorer.test.ts`, `test/health.test.ts`.

Segments depended on:
- event-bus (BUS): `Bus`, `Publisher`, `onShutdown`, event schemas for the events above (consumes `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `brain.status`, `affect.state`, `control`; produces `attention.focus`, `brain.say`).
- config (CFG): `loadConfig`, `brain.salience.*`, `brain.working_memory_events`, `brain.cortex.speaking_timeout_ms`.
- working-memory (WM): `Context`, `propagatedFlags`.
- region-hooks (HOOK): `Module` / `salience.scorer`.
- control-plane (CTRL): heartbeat contract (`startHeartbeat`), `control` pause/resume semantics.

Downstream/peers: cortex (consumes `attention.focus`, publishes `brain.status`), affect (publishes `affect.state`), chat / ears / eyes (senses), dashboard (injection source).

External: Redis (via the bus); optional LLM provider or HTTP endpoint for the scorer hook.

OpenSpec: `openspec/specs/salience/spec.md`; deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/salience/spec.md`, `openspec/changes/archive/2026-11-01-add-service-control/specs/salience/spec.md`, `openspec/changes/archive/2026-11-01-add-test-injection/specs/salience/spec.md`.
