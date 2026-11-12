---
parent: high-level-design
prefix: AFF
---

# affect

Parent: [high-level-design](../../high-level-design.md). Specs: [affect-specs.md](affect-specs.md). Arrow: [docs/arrows/affect.md](../../arrows/affect.md).

## Context and Design Philosophy

affect is the "mood" region (limbic system metaphor, `services/affect/src/index.ts:2`, `mood.ts:7-12`). It keeps two numbers - valence (how good, -1..1) and arousal (how awake, 0..1) - nudges them from bus events, lets them relax back to a baseline with an exponential half-life, and publishes the result as `affect.state` with a nearest-emotion label. Consumers (outside this segment): the avatar wears the label as its resting face, the cortex colours its prompt with it, and salience lowers its speak threshold when arousal is high (`index.ts:5-8`; consumers at `services/avatar/src/index.ts:35`, `services/cortex/src/cortex.ts:81`, `services/salience/src/salience.ts:71-73`).

Design philosophy as the code shows it:

- Cheap and continuous: the core is a few floats and `Math.pow(0.5, dt / half_life)` (`mood.ts:25-31`). Decay is lazy - applied whenever the state is touched (`tick()` inside `nudge`, `appraise`, `publish`), not on its own timer.
- Judgement of a line of speech is a pluggable hook (`affect.appraiser`: `rules` / `llm` / `http`, owned by region-hooks) that falls back to the word-list rules (`appraise.ts:40-56`).
- Slow appraisers must never stall the bus consumer, and a stale mood update is worse than a missed one, so llm/http appraisal runs on a small drop-oldest queue (`affect.ts:14-20`).
- State is in-memory only; there is no persistence or database (`mood.ts:13-17`).
- No model is on the default path: the `rules` appraiser is word lists and arithmetic. An operator who sets `brain.affect.module.kind` to `llm` or `http` puts a model (or their own service) behind the appraisal of each line; the mood arithmetic itself never calls one. The `index.ts` header comment says the same; the README "Mood" section still says "No LLM" unconditionally and needs the same wording (README is outside this segment).

Code layout: `index.ts` calls `runAffect()` (`main.ts`), which runs `affectMain` on the shared bootstrap `runService`; `affectMain` wires the appraiser, an `Affect` instance and a publish timer. `affect.ts` maps events to nudges, runs the appraisal queue and gates publishing. `mood.ts` is the state, decay and label. `appraise.ts` is the rule weights, the module factory and validation. `health.ts` is the static heartbeat spec.

## Event Wiring

Subscription (`main.ts`): consumer group `affect`, types `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `control`, in the event-bus start mode `latest`: the group is moved to the stream tail on every start, so lines published while affect was down never nudge the mood (AFF-IN-001), in keeping with "a missed line costs less than a stale one" (`affect.ts:17-18`). The mode is named explicitly (`start: "latest"`), so a plain process restart does not replay the backlog; a control-plane start in `fresh` mode, affect's manifest default (`packages/control/src/manifest.ts:42`), resets the group to `$` as well. The handler `affect.onEvent` is synchronous and returns void (`affect.ts:38`). `bus.subscribe` resolves only when the bus stops, so `main()` starts it with `void` after creating the group with `bus.resetGroup("affect")` (see Health); a rejection of the started subscription is logged as `fatal` and exits 1.

| Event in | Effect (file:line) |
|---|---|
| `chat.message` | appraise as source `chat` with `mentionsCohost`; additionally, if `isSub`, nudge valence by `nudge_sub_valence` (default +0.05) and arousal by `nudge_sub_arousal` (default +0.05), cause `sub: <user>` (`affect.ts:42-47`) |
| `speech.heard` | appraise as source `speech`, mention always false; speech's higher base arousal stands in for the mention boost (`affect.ts:48-52`) |
| `vision.summary` | if `changed`: arousal by `nudge_screen_arousal` (default +0.08), cause `screen changed` (`affect.ts:53-57`) |
| `brain.say` | valence `nudge_said_valence` (default +0.08) for emotion `happy`/`laugh`/`smug`, its negative for `sad`/`angry`, 0 otherwise; arousal `nudge_said_arousal` (default +0.05); cause `said: <emotion>` (`affect.ts:58-64`) |
| `control` | filtered by target; `pause` / `resume`; `forget_context` resets toward baseline (`affect.ts:65-77`; see Control) |

| Event out | When |
|---|---|
| `affect.state` `{valence, arousal, mood, cause}` | `publish()` every `brain.affect.publish_ms` (default 2000) but only when changed or `republish_ms` (default 15000) since last publish (`affect.ts:114-126`, `main.ts`) |
| `service.heartbeat` | via `startHeartbeat` (`main.ts`) |

## Mood Model

`Mood` (`mood.ts:13-56`) holds `valence` (initialised to `baseline_valence`, default 0.15), `arousal` (initialised to the resting arousal, default 0.1), `cause`, and `lastTick`.

- `tick(now)`: `k = 0.5 ^ ((now - lastTick) / half_life_ms)` (default half-life 45000 ms); `valence = baseline_valence + (valence - baseline_valence) * k`; `arousal = baseline_arousal + (arousal - baseline_arousal) * k`. The resting arousal comes from `brain.affect.baseline_arousal` (default 0.1; AFF-MOOD-006); it is also the initial arousal and the value `reset` restores. `now` defaults to the mood's clock, a monotonic millisecond clock (`AffectDeps.now`, default `performance.now`, shared with the 15 s publish heartbeat): decay depends on elapsed time, so a wall clock stepped by NTP or VM time sync must neither collapse the mood at once nor (stepped back, a negative `dt`) amplify it. Tests inject a fake clock to step time.
- `nudge(dv, da, cause)`: `tick()`, then add and clamp valence to [-1, 1] and arousal to [0, 1], set `cause` (`mood.ts:33-38`). `reset(cause)` applies the pending decay, then sets valence and arousal to their resting values and the cause (AFF-IN-007). `applyAppraisal` is an alias for `nudge` with the module's two deltas (`mood.ts:48-51`).
- `state()`: values rounded to 3 decimals, label from `label(valence, arousal)`, plus `cause` (`mood.ts:53-55`).
- `label(v, a)` (`mood.ts:58-62`): `a > 0.6` -> `laugh` (v > 0.3) / `angry` (v < -0.3) / `surprised`; `a > 0.3` -> `happy` (v > 0.2) / `confused` (v < -0.2) / `think`; else `smug` (v > 0.35) / `sad` (v < -0.3) / `neutral`. All nine `Emotion` values are reachable. Resting state (0.15, 0.1) labels `neutral`.

## Appraisal

`appraiseRules` (`appraise.ts:23-32`), applied to one line of chat or speech:

| Condition | Effect |
|---|---|
| base | arousal +0.15 (speech) or +0.03 (chat) |
| `mention` | arousal +0.2 |
| POSITIVE word list (lol, lmao, haha, pog, gg, w, love, nice, hype, clutch, ... and a few emoji) | valence +0.12, arousal +0.05 |
| NEGATIVE word list (boo, l, ratio, trash, cringe, hate, f, oof, ... and a few emoji) | valence -0.15, arousal +0.08 |
| `!!` or five consecutive capitals | arousal +0.05 |
| contains `?` | arousal +0.03 |

The single-letter tokens (`w` positive, `l` and `f` negative) are deliberate stream slang, so a lone "W" or "L" in chat moves the mood. Both lists use whole-word matching with `iu` flags; emoji are written as alternations rather than character classes to avoid surrogate-pair collisions (`appraise.ts:17-20`, regression test `test/affect.test.ts:58-66`). Positive and negative can both apply and net out (`lol this is trash` -> -0.03, `test/appraiser.test.ts:47-52`). The rule output is not clamped; a maximum chat mention is +0.44 arousal, bounded afterwards by `nudge`.

`createAppraiser` builds `new Module("affect.appraiser", cfg.brain.affect.module, cfg.llm, impl, log)` (`appraise.ts:40-56`). llm and http share `validate`, which requires both deltas to be finite numbers and clamps each to +-0.5, else returns undefined so `Module.run` falls back to rules (`appraise.ts:34-38`, `packages/modules/src/index.ts:53-63`). The +-0.5 range is the appraiser contract for both kinds (also documented for http at `examples/modules/README.md:110`). The llm kind uses a JSON-only system prompt naming the co-host and streamer that asks for each delta within that range, `maxTokens: 60`, and a user prompt carrying the current mood and the line (AFF-HOOK-009); the prompt text still asks for the narrower "valence_delta: -0.3 .. 0.3, arousal_delta: 0 .. 0.3" (`appraise.ts:47`). Default module `timeout_ms` is 1500 (`packages/config/src/schema.ts:18`).

### Inline versus queued

`Affect.appraise` (`affect.ts:85-98`) first calls `mood.tick()` and builds an `AppraiseInput` carrying the current valence and arousal. It applies `appraiseRules` inline when the appraiser kind is `rules`, or when the line is not a mention and `text.trim().length < 4` ("a line too short to carry tone isn't worth a model call"). Otherwise the job goes onto a queue capped at `MAX_QUEUED = 8` (oldest shifted off first), and a single worker promise (`draining`) drains it one job at a time; each job re-reads the mood at run time, so a queued line is appraised against the mood as it is then (`affect.ts:100-107`, test `test/affect.region.test.ts:97-111`). `settled()` awaits the worker and exists for tests (`affect.ts:80-83`).

## Publishing

`Affect.publish()` (`affect.ts:114-126`) runs on a `setInterval` of `publish_ms` in `main.ts`. It ticks the mood, builds a key `mood:valence.toFixed(2):arousal.toFixed(2)`, and returns without publishing if the key equals the last published key and less than 15 000 ms (hard-coded) have passed. Otherwise it records the key and time and publishes `affect.state`. The first call always publishes (`lastPublished` starts empty). `cause` is not part of the key. A failed publish is logged (`affect.state publish failed`, warn) by a rejection handler on the un-awaited call, and the service continues (AFF-PUB-004); the key was already recorded, so the next evaluation publishes only if the state has moved or 15 s have passed.

## Control, Pause and Health

`control` (`affect.ts:65-77`): ignored if `target` is set and is not `affect`. `pause` sets `paused`; while paused every non-`control` event returns early (`affect.ts:40`) so the mood is not nudged, while `publish()` keeps ticking decay and publishing so consumers keep a live mood (`affect.ts:31` comment; the test at `test/affect.region.test.ts:150-157` asserts the decay tick only). `resume` clears it. While paused, the appraisal worker drops each queued llm/http job without applying it (AFF-HOOK-008). `forget_context` applies the pending decay and then sets the mood exactly to baseline with cause `reset`, and discards every queued appraisal job (AFF-IN-007, AFF-HOOK-008). Pause and `forget_context` each bump an `epoch` counter that every queued job carries; `drain` drops a job (before running it, and again when the appraiser returns) if affect is paused or the job's epoch is stale, so an appraisal that was queued or in flight before a pause or reset never changes the mood afterwards. `forget_context` also empties the queue. `forget_context` works while paused because control events pass the guard. `mute` / `unmute` / `say` / `reload_personality` are ignored. Pause state and mood are in-memory only; a restart starts unpaused at baseline.

Health: `affectHealth(cfg)` returns `{ service: "affect", mode, deps: {} }`, where `mode` is `mock` for an `llm` appraiser hook that inherits the mock provider and `live` otherwise (AFF-HEALTH-003); a pause shows as the heartbeat `detail` `paused` (AFF-HEALTH-004). `startHeartbeat` emits `starting` at boot; `heartbeat.ready()` follows once the consumer group has been created and the publish timer is set (AFF-HEALTH-001): `main()` awaits `bus.resetGroup("affect")` (creates a missing group at `$`, moves an existing one there: the same position start mode `latest` takes) before starting the subscription, because `bus.subscribe` resolves only on stop and offers no readiness signal. `stopping` comes from a `beforeShutdown` hook that the shared `onShutdown` runs before the service's callback (`packages/bus/src/heartbeat.ts:111-117`, `packages/bus/src/index.ts:242-254`). Heartbeat semantics belong to control-plane. Every startup step runs inside `main()` (`main.ts`: `loadConfig`, `new Bus`, `startHeartbeat`, `createAppraiser`, `new Affect`, group creation, subscription), so any failure logs `fatal` and exits 1 (AFF-HEALTH-002); `createAppraiser` throws for `kind: http` with an empty `url` (`packages/modules/src/index.ts:45-48`). `main()` takes its collaborators (`loadConfig`, `createBus`, `createAppraiser`, `onShutdown`, `exit`) as an optional parameter, which is how tests run it against a fake bus. The shutdown callback clears the publish `setInterval` and calls `bus.stop()`; the shared helper then `process.exit(0)`s (`packages/bus/src/index.ts`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| State model | Two scalars (valence, arousal) with nearest-emotion label | discrete emotion state machine; LLM-held mood | `mood.ts:7-12` doc comment: "cheap, continuous, and the rest of the brain can read it without anyone calling an LLM"; commit `969f6d7` ("valence/arousal mood that decays toward baseline"). |
| Decay | Exponential half-life, applied lazily on access | periodic decay timer | The decay is closed-form (`0.5^(dt/half_life)`), so applying it at the moment of each read or write gives the same value a timer would, with no extra timer to run or stop; the publish interval already reads the mood regularly, so consumers see a decaying value. `mood.ts:24-31`; `tick()` is called from `nudge`, `appraise` and `publish`; test `test/affect.test.ts:34-47`. |
| Arousal baseline | `brain.affect.baseline_arousal`, default 0.1, beside `baseline_valence` | hard-coded 0.1 | owner decision 2026-11-01: both resting values are personality knobs and belong in config; the default keeps today's behaviour. |
| Slow appraiser handling | Worker queue, max 8, drop oldest | block the bus handler; drop newest; unbounded queue | `affect.ts:14-19` comment ("the consumer never stalls behind a slow module ... a missed line costs less than a stale one"); commit `969f6d7` ("affect runs llm/http appraisal on a bounded worker queue instead of inside the bus handler"); test `test/affect.region.test.ts:124-131`. The cap of 8 is a small fixed bound rather than a config key: with one worker and drop-oldest it only limits how far behind the mood can lag, and mood is smoothed, so the exact number is not a tuning surface. |
| Short lines | Lines under `short_line_chars` (default 4) without a mention use rules inline even for llm/http | always call the model | `affect.ts:90` comment ("a line too short to carry tone isn't worth a model call"); test `test/affect.region.test.ts:113-122`. |
| Queued job input | Re-read current mood when the job runs | use mood captured at enqueue | Deliberate per the test assertion message "the queued line is appraised against the mood as it is now" (`test/affect.region.test.ts:107`); consistent with "a missed line costs less than a stale one" (`affect.ts:17-18`). |
| Timing clock | Injected monotonic clock (`AffectDeps.now`, default `performance.now`) for decay and the heartbeat | `Date.now` | Decay and the heartbeat are durations. With `Date.now`, a wall-clock step back gave a negative `dt` and `k > 1`, pushing the mood away from baseline, and a step forward decayed it at once (seen as flapping tests on a WSL2 host whose clock flapped by about 25 s). An injected clock also lets tests step time without mocking the global `Date`. |
| Publish gating | Change key (mood + 2-dp valence/arousal) plus a republish every `republish_ms` (default 15 s) | publish every interval; publish every change | `affect.ts:119` comment ("Only publish when it moved, plus a heartbeat so late joiners get a value"); test `test/affect.region.test.ts:77-95`. The key uses 2 dp while the payload carries 3 dp (`mood.ts:65`), so drift under a hundredth from decay alone does not republish; `cause` is left out of the key because it is descriptive and no region reads it to decide anything. The 15 s heartbeat bounds how long a consumer that starts in mode `latest` waits for its first `affect.state`. |
| Pause semantics | Stop nudging, keep decaying and publishing | stop everything; exit process | `affect.ts:31` comment ("events no longer nudge the mood; decay and publishing continue"); OpenSpec affect pause scenario ("decay continues"); test `test/affect.region.test.ts:150-157`. owner decision 2026-11-01: keep publishing while paused, because consumers (salience, cortex, avatar) need a live, decaying mood; the retired add-service-control design's "treated like muted for output" (`openspec/changes/archive/2026-11-01-add-service-control/design.md:27`) does not apply. |
| Own speech feedback | The co-host's own `brain.say` emotion nudges its mood | ignore own speech; extra damping | `affect.ts:59` comment: "Saying something emotional reinforces the mood a little (and talking is arousing)". owner decision 2026-11-01: the self-reinforcing loop is intended gain; the half-life is the only damping. |
| Emoji matching | Alternations with `u` flag, not character classes | `[...]` classes | `appraise.ts:17-18` comment (a class without `u` matches single UTF-16 units, so emoji sharing a high surrogate hit both lists); commit `969f6d7` ("unicode-safe emoji matching"); regression test `test/affect.test.ts:58-66`. |
| Restart start mode | Event-bus start mode `latest`: the `affect` group moves to the tail on every start | `resume` (replay the backlog after a restart) | owner decision 2026-11-01: a backlog would nudge the mood all at once; delivery across restarts is at-most-once project-wide, and only memory resumes. |
| Queued appraisals on pause and reset | `forget_context` discards the queue; the worker drops jobs while paused | hold the queue until `resume`; leave the queue alone | owner decision 2026-11-01: a job queued before a pause or reset must not move the mood afterwards, and a held job would be stale on resume. |
| Speech and mentions | Speech is appraised with `mention` false; its 0.15 base arousal stands in for the boost | detect a co-host mention in a voice line | owner decision 2026-11-01: keep; speech already outweighs chat. |
| Slang tokens | Single-letter `w` (positive), `l` and `f` (negative) are whole-word list entries | multi-letter words only | owner decision 2026-11-01: deliberate stream slang. |
| Failure posture | A failed `affect.state` publish is logged and the service continues; every startup step runs inside `main()` so a startup failure logs `fatal`; `ready` follows consumer-group creation | crash and let compose restart | owner decision 2026-11-01: a crash resets the mood to baseline and hides the cause; `ready` should mean the subscription is running. |
| Readiness signal | `main()` awaits `bus.resetGroup("affect")`, then starts `subscribe` (start mode `latest`) and reports `ready` | add a readiness callback or promise to `Bus.subscribe`; report `ready` right after starting `subscribe` | `Bus.subscribe` resolves only on stop and has no readiness signal, and the bus is another segment. `resetGroup` leaves the group at `$`, the position `latest` takes anyway, so the second move inside `subscribe` is harmless. A readiness signal in event-bus would remove the extra call. |
| Job staleness | An epoch counter bumped by pause and `forget_context`; a job is dropped if paused or its epoch is stale, before and after the appraiser runs | clear only the queue on reset and check `paused` only when dequeuing | the in-flight job is outside the queue, and a pause followed by a resume before it returns would otherwise let a pre-pause appraisal land. |
| Reset | `Mood.reset` applies decay, then assigns the resting values | compute deltas after a `tick()` and `nudge` | assigning is exact; deltas re-derived around a second internal `tick()` are one clock read away from the same overshoot. |
| Delta bounds | llm/http deltas clamped to +-0.5; the llm prompt asks for the same range | trust the model; clamp to the narrower prompt ranges | Contract documented at `appraise.ts:14` and `examples/modules/README.md:110` (`-0.5..0.5`); test `test/appraiser.test.ts:31-37`. owner decision 2026-11-01: the validator range is the contract and the prompt is widened to match. |
| Tunable constants | The republish interval, the nudge sizes and the short-line cutoff are `brain.affect` keys with the former constants as defaults (CFG-SCH-028); `MAX_QUEUED` (8) stays a code bound | Keep all of them in code; make `MAX_QUEUED` a key too | Owner decision 2026-11-11: the operator tunes how reactive the mood is from the settings editor. `MAX_QUEUED` bounds memory and appraisal latency, a resource limit rather than behaviour. The emotion lists that give `brain.say` its valence sign (`happy`/`laugh`/`smug`, `sad`/`angry`) are the meaning of those emotions and stay in code. |
| Publish key precision | The key uses 2-decimal valence and arousal and excludes the cause | Key at the 3-decimal precision of `state()`; include the cause | Owner decision 2026-11-11: the key deliberately suppresses imperceptible moves, and the republish interval bounds how stale a cause-only change can be. |
| Heartbeat mode | `mock` only where the appraiser is an `llm` hook inheriting the mock provider (AFF-HEALTH-003) | Always `live`; `mock` whenever `llm.provider` is `mock` | A rules or http appraiser never calls the provider, so `mock` there would mislead; an inheriting llm hook falls back to the rules on every call. |
| Bootstrap | `runService` from `@cohost/shared`; `affectMain` holds the service, `runAffect` wires it with replaceable collaborators | A hand-written `main` per service | One bootstrap gives every service the same logger, config failure, heartbeat, shutdown and `fatal` path (SHARED-BOOT-*). |

## Open Questions & Future Decisions

None.

## References

Code (`services/affect/`): `src/index.ts`, `src/main.ts`, `src/affect.ts`, `src/mood.ts`, `src/appraise.ts`, `src/health.ts`, `package.json`, `tsconfig.json`.
Tests: `test/affect.test.ts` (rules, label, Mood decay, emoji), `test/affect.region.test.ts` (Affect class: nudges, reset, publish gating, queue, pause), `test/appraiser.test.ts` (http appraiser validation), `test/health.test.ts`, `test/main.test.ts` (startup wiring against a fake bus).

Segments depended on:
- event-bus (BUS): `Bus`, `Publisher`, `onShutdown`; consumes `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `control`; produces `affect.state`.
- config (CFG): `loadConfig`, `brain.affect.*` (`publish_ms`, `half_life_ms`, `baseline_valence`, `module`), `Emotion`.
- region-hooks (HOOK): `Module` / `affect.appraiser`.
- control-plane (CTRL): heartbeat contract and `control` pause/resume semantics.

affect does not use working-memory and lists no dependency on it. `@cohost/llm` is only a transitive dependency via `@cohost/modules`.

Downstream consumers: salience (arousal -> threshold), cortex (prompt colour), avatar (resting expression), dashboard (display).

External: Redis (via the bus); optional LLM provider or HTTP endpoint for the appraiser hook.

OpenSpec: `openspec/specs/affect/spec.md`; deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/affect/spec.md`, `openspec/changes/archive/2026-11-01-add-service-control/specs/affect/spec.md`.
