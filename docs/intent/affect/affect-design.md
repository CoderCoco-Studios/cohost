---
parent: high-level-design
prefix: AFF
---

# affect

Parent: [high-level-design](../../high-level-design.md). Specs: [affect-specs.md](affect-specs.md). Arrow: [docs/arrows/affect.md](../../arrows/affect.md).

## Context and Design Philosophy

affect is the "mood" region (limbic system metaphor, `services/affect/src/index.ts:2`, `mood.ts:6-11`). It keeps two numbers - valence (how good, -1..1) and arousal (how awake, 0..1) - nudges them from bus events, lets them relax back to a baseline with an exponential half-life, and publishes the result as `affect.state` with a nearest-emotion label. Consumers (outside this segment): the avatar wears the label as its resting face, the cortex colours its prompt with it, and salience lowers its speak threshold when arousal is high (`index.ts:5-8`; consumers at `services/avatar/src/index.ts:35`, `services/cortex/src/cortex.ts:81`, `services/salience/src/salience.ts:71-73`).

Design philosophy as the code shows it:

- Cheap and continuous: the core is a few floats and `Math.pow(0.5, dt / half_life)` (`mood.ts:23-29`). Decay is lazy - applied whenever the state is touched (`tick()` inside `nudge`, `appraise`, `publish`), not on its own timer.
- Judgement of a line of speech is a pluggable hook (`affect.appraiser`: `rules` / `llm` / `http`, owned by region-hooks) that falls back to the word-list rules (`appraise.ts:40-56`).
- Slow appraisers must never stall the bus consumer, and a stale mood update is worse than a missed one, so llm/http appraisal runs on a small drop-oldest queue (`affect.ts:14-20`).
- State is in-memory only; there is no persistence or database (`mood.ts:12-16`).
- No model is on the default path: the `rules` appraiser is word lists and arithmetic. An operator who sets `brain.affect.module.kind` to `llm` or `http` puts a model (or their own service) behind the appraisal of each line; the mood arithmetic itself never calls one. The `index.ts:9` header comment and the README "Mood" section still say "No LLM" unconditionally.

Code layout: `index.ts` wires config, bus, heartbeat, appraiser, an `Affect` instance and a publish timer. `affect.ts` maps events to nudges, runs the appraisal queue and gates publishing. `mood.ts` is the state, decay and label. `appraise.ts` is the rule weights, the module factory and validation. `health.ts` is the static heartbeat spec.

## Event Wiring

Subscription (`index.ts:25-28`): consumer group `affect`, types `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `control`, in the event-bus start mode `latest`: the group is moved to the stream tail on every start, so lines published while affect was down never nudge the mood (AFF-IN-001), in keeping with "a missed line costs less than a stale one" (`affect.ts:17-18`). The code does not do this yet: it passes `fromNow: true`, which positions only a newly created group (`packages/bus/src/index.ts:17,22,133-138`), so a plain process restart replays the backlog; only a control-plane start in `fresh` mode, affect's manifest default (`packages/control/src/manifest.ts:42`), resets the group to `$` first. The handler `affect.onEvent` is synchronous and returns void (`affect.ts:36`). `bus.subscribe` is started with `void` and not awaited.

| Event in | Effect (file:line) |
|---|---|
| `chat.message` | appraise as source `chat` with `mentionsCohost`; additionally, if `isSub`, nudge valence +0.05, arousal +0.05, cause `sub: <user>` (`affect.ts:40-45`) |
| `speech.heard` | appraise as source `speech`, mention always false; speech's higher base arousal stands in for the mention boost (`affect.ts:46-50`) |
| `vision.summary` | if `changed`: arousal +0.08, cause `screen changed` (`affect.ts:51-55`) |
| `brain.say` | valence +0.08 for emotion `happy`/`laugh`/`smug`, -0.08 for `sad`/`angry`, 0 otherwise; arousal +0.05; cause `said: <emotion>` (`affect.ts:56-62`) |
| `control` | filtered by target; `pause` / `resume`; `forget_context` resets toward baseline (`affect.ts:63-70`; see Control) |

| Event out | When |
|---|---|
| `affect.state` `{valence, arousal, mood, cause}` | `publish()` every `brain.affect.publish_ms` (default 2000) but only when changed or 15 s since last publish (`affect.ts:101-111`, `index.ts:29`) |
| `service.heartbeat` | via `startHeartbeat` (`index.ts:20,30`) |

## Mood Model

`Mood` (`mood.ts:12-46`) holds `valence` (initialised to `baseline_valence`, default 0.15), `arousal` (initialised to the resting arousal, default 0.1), `cause`, and `lastTick`.

- `tick(now)`: `k = 0.5 ^ ((now - lastTick) / half_life_ms)` (default half-life 45000 ms); `valence = baseline_valence + (valence - baseline_valence) * k`; `arousal = baseline_arousal + (arousal - baseline_arousal) * k`. The resting arousal comes from `brain.affect.baseline_arousal` (default 0.1; AFF-MOOD-006); the code still uses the literal 0.1 in three places (`mood.ts:14,28`, `affect.ts:68`) and the schema has no such key yet.
- `nudge(dv, da, cause)`: `tick()`, then add and clamp valence to [-1, 1] and arousal to [0, 1], set `cause` (`mood.ts:31-36`). `applyAppraisal` is an alias for `nudge` with the module's two deltas (`mood.ts:39-41`).
- `state()`: values rounded to 3 decimals, label from `label(valence, arousal)`, plus `cause` (`mood.ts:43-45`).
- `label(v, a)` (`mood.ts:49-53`): `a > 0.6` -> `laugh` (v > 0.3) / `angry` (v < -0.3) / `surprised`; `a > 0.3` -> `happy` (v > 0.2) / `confused` (v < -0.2) / `think`; else `smug` (v > 0.35) / `sad` (v < -0.3) / `neutral`. All nine `Emotion` values are reachable. Resting state (0.15, 0.1) labels `neutral`.

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

`Affect.appraise` (`affect.ts:79-92`) first calls `mood.tick()` and builds an `AppraiseInput` carrying the current valence and arousal. It applies `appraiseRules` inline when the appraiser kind is `rules`, or when the line is not a mention and `text.trim().length < 4` ("a line too short to carry tone isn't worth a model call"). Otherwise the job goes onto a queue capped at `MAX_QUEUED = 8` (oldest shifted off first), and a single worker promise (`draining`) drains it one job at a time; each job re-reads the mood at run time, so a queued line is appraised against the mood as it is then (`affect.ts:94-99`, test `test/affect.region.test.ts:97-111`). `settled()` awaits the worker and exists for tests (`affect.ts:75-77`).

## Publishing

`Affect.publish()` (`affect.ts:101-111`) runs on a `setInterval` of `publish_ms` in `index.ts:29`. It ticks the mood, builds a key `mood:valence.toFixed(2):arousal.toFixed(2)`, and returns without publishing if the key equals the last published key and less than 15 000 ms (hard-coded) have passed. Otherwise it records the key and time and publishes `affect.state`. The first call always publishes (`lastPublished` starts empty). `cause` is not part of the key. A failed publish is logged and the service continues (AFF-PUB-004); today the call is `void`-ed with no catch (`affect.ts:110`), so a Redis failure becomes an unhandled rejection that ends the process under Node defaults.

## Control, Pause and Health

`control` (`affect.ts:63-70`): ignored if `target` is set and is not `affect`. `pause` sets `paused`; while paused every non-`control` event returns early (`affect.ts:38`) so the mood is not nudged, while `publish()` keeps ticking decay and publishing so consumers keep a live mood (`affect.ts:29` comment; the test at `test/affect.region.test.ts:150-157` asserts the decay tick only). `resume` clears it. While paused, the appraisal worker drops each queued llm/http job without applying it (AFF-HOOK-008). `forget_context` applies the pending decay and then sets the mood exactly to baseline with cause `reset`, and discards every queued appraisal job (AFF-IN-007, AFF-HOOK-008). The code lags on both: it calls `nudge(baseline_valence - valence, 0.1 - arousal, "reset")` (`affect.ts:68`) with deltas evaluated before `nudge` applies the pending decay (`mood.ts:31-34`), so the result lands past baseline by the decay accrued since the last tick (about 3% of the distance at the default 2 s publish interval; the test uses a 10 000 000 ms half-life, which hides it), and neither control path touches the queue nor does `drain` check `paused` (`affect.ts:94-99`). `forget_context` works while paused because control events pass the guard. `mute` / `unmute` / `say` / `reload_personality` are ignored. Pause state and mood are in-memory only; a restart starts unpaused at baseline.

Health: `affectHealth = { service: "affect", mode: "live", deps: {} }` (`health.ts:4`). `startHeartbeat` emits `starting` at boot; `heartbeat.ready()` follows once the consumer group has been created and the publish timer is set (AFF-HEALTH-001). Today `ready()` is called right after `bus.subscribe` is started, not awaited (`index.ts:25-30`). `stopping` comes from a `beforeShutdown` hook that the shared `onShutdown` runs before the service's callback (`packages/bus/src/heartbeat.ts:111-117`, `packages/bus/src/index.ts:242-254`). Heartbeat semantics belong to control-plane. Every startup step runs inside `main()`, so any failure logs `fatal` and exits 1 (AFF-HEALTH-002). Today only `main()` rejecting is handled (`index.ts:34`); `main()` awaits nothing, and the code that can throw at startup (`loadConfig`, `new Bus`, `startHeartbeat`, `createAppraiser`, `new Affect` at `index.ts:17-22`; `createAppraiser` throws for `kind: http` with an empty `url`, `packages/modules/src/index.ts:45-48`) runs at module load, outside that handler. `onShutdown` only calls `bus.stop()` (`index.ts:35`) and the shared helper then `process.exit(0)`s (`packages/bus/src/index.ts:253`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| State model | Two scalars (valence, arousal) with nearest-emotion label | discrete emotion state machine; LLM-held mood | `mood.ts:6-11` doc comment: "cheap, continuous, and the rest of the brain can read it without anyone calling an LLM"; commit `969f6d7` ("valence/arousal mood that decays toward baseline"). |
| Decay | Exponential half-life, applied lazily on access | periodic decay timer | `[inferred]` `mood.ts:22-29`; `tick()` is called from `nudge`, `appraise` and `publish`; test `test/affect.test.ts:34-47`. No stated reason for lazy over a timer. |
| Arousal baseline | `brain.affect.baseline_arousal`, default 0.1, beside `baseline_valence` | hard-coded 0.1 | owner decision 2026-11-01: both resting values are personality knobs and belong in config; the default keeps today's behaviour. |
| Slow appraiser handling | Worker queue, max 8, drop oldest | block the bus handler; drop newest; unbounded queue | `affect.ts:14-19` comment ("the consumer never stalls behind a slow module ... a missed line costs less than a stale one"); commit `969f6d7` ("affect runs llm/http appraisal on a bounded worker queue instead of inside the bus handler"); test `test/affect.region.test.ts:124-131`. The cap of 8: `[inferred]`. |
| Short lines | Lines under 4 chars without a mention use rules inline even for llm/http | always call the model | `affect.ts:84` comment ("a line too short to carry tone isn't worth a model call"); test `test/affect.region.test.ts:113-122`. |
| Queued job input | Re-read current mood when the job runs | use mood captured at enqueue | Deliberate per the test assertion message "the queued line is appraised against the mood as it is now" (`test/affect.region.test.ts:107`); consistent with "a missed line costs less than a stale one" (`affect.ts:17-18`). |
| Publish gating | Change key (mood + 2-dp valence/arousal) plus 15 s heartbeat | publish every interval; publish every change | `affect.ts:106` comment ("Only publish when it moved, plus a heartbeat so late joiners get a value"); test `test/affect.region.test.ts:77-95`. Key precision (2 dp, no `cause`) and the 15 s period: `[inferred]`. |
| Pause semantics | Stop nudging, keep decaying and publishing | stop everything; exit process | `affect.ts:29` comment ("events no longer nudge the mood; decay and publishing continue"); OpenSpec affect pause scenario ("decay continues"); test `test/affect.region.test.ts:150-157`. owner decision 2026-11-01: keep publishing while paused, because consumers (salience, cortex, avatar) need a live, decaying mood; the retired add-service-control design's "treated like muted for output" (`openspec/changes/archive/2026-11-01-add-service-control/design.md:27`) does not apply. |
| Own speech feedback | The co-host's own `brain.say` emotion nudges its mood | ignore own speech; extra damping | `affect.ts:57` comment: "Saying something emotional reinforces the mood a little (and talking is arousing)". owner decision 2026-11-01: the self-reinforcing loop is intended gain; the half-life is the only damping. |
| Emoji matching | Alternations with `u` flag, not character classes | `[...]` classes | `appraise.ts:17-18` comment (a class without `u` matches single UTF-16 units, so emoji sharing a high surrogate hit both lists); commit `969f6d7` ("unicode-safe emoji matching"); regression test `test/affect.test.ts:58-66`. |
| Restart start mode | Event-bus start mode `latest`: the `affect` group moves to the tail on every start | `resume` (replay the backlog after a restart) | owner decision 2026-11-01: a backlog would nudge the mood all at once; delivery across restarts is at-most-once project-wide, and only memory resumes. |
| Queued appraisals on pause and reset | `forget_context` discards the queue; the worker drops jobs while paused | hold the queue until `resume`; leave the queue alone | owner decision 2026-11-01: a job queued before a pause or reset must not move the mood afterwards, and a held job would be stale on resume. |
| Speech and mentions | Speech is appraised with `mention` false; its 0.15 base arousal stands in for the boost | detect a co-host mention in a voice line | owner decision 2026-11-01: keep; speech already outweighs chat. |
| Slang tokens | Single-letter `w` (positive), `l` and `f` (negative) are whole-word list entries | multi-letter words only | owner decision 2026-11-01: deliberate stream slang. |
| Failure posture | A failed `affect.state` publish is logged and the service continues; every startup step runs inside `main()` so a startup failure logs `fatal`; `ready` follows consumer-group creation | crash and let compose restart | owner decision 2026-11-01: a crash resets the mood to baseline and hides the cause; `ready` should mean the subscription is running. |
| Delta bounds | llm/http deltas clamped to +-0.5; the llm prompt asks for the same range | trust the model; clamp to the narrower prompt ranges | Contract documented at `appraise.ts:14` and `examples/modules/README.md:110` (`-0.5..0.5`); test `test/appraiser.test.ts:31-37`. owner decision 2026-11-01: the validator range is the contract and the prompt is widened to match. |

## Open Questions & Future Decisions

1. **Duplicated `clamp`.** `mood.ts:55` defines a local `clamp` while `appraise.ts:1` of the same service imports the exported one from `@cohost/modules` (`packages/modules/src/index.ts:110`).
2. **Hard-coded constants.** The 15 s heartbeat (`affect.ts:107`), the nudge sizes (`affect.ts:43,53,59-60`), the `MAX_QUEUED` of 8 (`affect.ts:20`), the 4-character short-line cutoff (`affect.ts:85`) and the emotion lists for `brain.say` (`affect.ts:59`) are not configurable.
3. **Docblock misplaced.** The multi-line queue design comment (`affect.ts:14-19`) sits above `const MAX_QUEUED`, not above the class.
4. **Timer not cleared on shutdown** (`index.ts:29,35`); cosmetic because the shared `onShutdown` ends in `process.exit(0)`.
5. **Publish key coarser than the state.** The key uses 2 decimals (`affect.ts:104`) while `state()` rounds to 3 (`mood.ts:44`) and excludes `cause`; small movements and cause-only changes are not published until the 15 s heartbeat.
6. **Test gaps.** No test for `index.ts` wiring (subscription list, `publish_ms` timer, `ready()`, `fatal` exit: AFF-IN-001, AFF-PUB-001, AFF-HEALTH-001, AFF-HEALTH-002), for the llm prompt text (AFF-HOOK-009), for restart state (AFF-CTRL-005), for label boundary equalities (e.g. exactly 0.6), for the 4-character cutoff boundary, or for pause/reset interacting with the queue (AFF-HOOK-008). Several annotated tests check direction or cause rather than the specified sizes: AFF-IN-004 (cause only), AFF-IN-006 (arousal +0.05 unasserted), AFF-APPR-001..003 (only the net -0.03 is asserted exactly), AFF-CTRL-003 (decay tick asserted, publishing while paused not), and AFF-IN-007 (a near-infinite half-life hides the reset error). The http-kind tests monkey-patch `Module.run` (`test/affect.region.test.ts:21`).

## References

Code (`services/affect/`): `src/index.ts`, `src/affect.ts`, `src/mood.ts`, `src/appraise.ts`, `src/health.ts`, `package.json`, `tsconfig.json`.
Tests: `test/affect.test.ts` (rules, label, Mood decay, emoji), `test/affect.region.test.ts` (Affect class: nudges, reset, publish gating, queue, pause), `test/appraiser.test.ts` (http appraiser validation), `test/health.test.ts`.

Segments depended on:
- event-bus (BUS): `Bus`, `Publisher`, `onShutdown`; consumes `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `control`; produces `affect.state`.
- config (CFG): `loadConfig`, `brain.affect.*` (`publish_ms`, `half_life_ms`, `baseline_valence`, `module`), `Emotion`.
- region-hooks (HOOK): `Module` / `affect.appraiser`.
- control-plane (CTRL): heartbeat contract and `control` pause/resume semantics.

affect does not use working-memory; the `@cohost/working-memory` entry in `package.json:16` and the reference in `tsconfig.json:8` are unused and are to be removed. `@cohost/llm` is only a transitive dependency via `@cohost/modules`.

Downstream consumers: salience (arousal -> threshold), cortex (prompt colour), avatar (resting expression), dashboard (display).

External: Redis (via the bus); optional LLM provider or HTTP endpoint for the appraiser hook.

OpenSpec: `openspec/specs/affect/spec.md`; deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/affect/spec.md`, `openspec/changes/archive/2026-11-01-add-service-control/specs/affect/spec.md`.
