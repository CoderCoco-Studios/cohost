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

Code layout: `index.ts` wires config, bus, heartbeat, appraiser, an `Affect` instance and a publish timer. `affect.ts` maps events to nudges, runs the appraisal queue and gates publishing. `mood.ts` is the state, decay and label. `appraise.ts` is the rule weights, the module factory and validation. `health.ts` is the static heartbeat spec.

## Event Wiring

Subscription (`index.ts:25-28`): consumer group `affect`, `fromNow: true`, types `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `control`. The handler `affect.onEvent` is synchronous and returns void (`affect.ts:36`). `bus.subscribe` is started with `void` and not awaited.

| Event in | Effect (file:line) |
|---|---|
| `chat.message` | appraise as source `chat` with `mentionsCohost`; additionally, if `isSub`, nudge valence +0.05, arousal +0.05, cause `sub: <user>` (`affect.ts:40-45`) |
| `speech.heard` | appraise as source `speech`, mention always false (`affect.ts:46-50`) |
| `vision.summary` | if `changed`: arousal +0.08, cause `screen changed` (`affect.ts:51-55`) |
| `brain.say` | valence +0.08 for emotion `happy`/`laugh`/`smug`, -0.08 for `sad`/`angry`, 0 otherwise; arousal +0.05; cause `said: <emotion>` (`affect.ts:56-62`) |
| `control` | filtered by target; `pause` / `resume`; `forget_context` snaps to baseline (`affect.ts:63-70`) |

| Event out | When |
|---|---|
| `affect.state` `{valence, arousal, mood, cause}` | `publish()` every `brain.affect.publish_ms` (default 2000) but only when changed or 15 s since last publish (`affect.ts:101-111`, `index.ts:29`) |
| `service.heartbeat` | via `startHeartbeat` (`index.ts:20,30`) |

## Mood Model

`Mood` (`mood.ts:12-46`) holds `valence` (initialised to `baseline_valence`, default 0.15), `arousal` (initialised to 0.1), `cause`, and `lastTick`.

- `tick(now)`: `k = 0.5 ^ ((now - lastTick) / half_life_ms)` (default half-life 45000 ms); `valence = baseline + (valence - baseline) * k`; `arousal = 0.1 + (arousal - 0.1) * k`. The resting arousal 0.1 is a hard-coded literal in three places (`mood.ts:14,28`, `affect.ts:68`).
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

Both lists use whole-word matching with `iu` flags; emoji are written as alternations rather than character classes to avoid surrogate-pair collisions (`appraise.ts:17-20`, regression test `test/affect.test.ts:58-66`). Positive and negative can both apply and net out (`lol this is trash` -> -0.03, `test/appraiser.test.ts:47-52`). The rule output is not clamped; a maximum chat mention is +0.44 arousal, bounded afterwards by `nudge`.

`createAppraiser` builds `new Module("affect.appraiser", cfg.brain.affect.module, cfg.llm, impl, log)` (`appraise.ts:40-56`). The llm kind uses a JSON-only system prompt naming the co-host and streamer with "valence_delta: -0.3 .. 0.3, arousal_delta: 0 .. 0.3", `maxTokens: 60`, and a user prompt carrying the current mood and the line; llm and http share `validate`, which requires both deltas to be finite numbers and clamps each to +-0.5, else returns undefined so `Module.run` falls back to rules (`appraise.ts:34-38`, `packages/modules/src/index.ts:53-63`). Default module `timeout_ms` is 1500 (`packages/config/src/schema.ts:17`).

### Inline versus queued

`Affect.appraise` (`affect.ts:79-92`) first calls `mood.tick()` and builds an `AppraiseInput` carrying the current valence and arousal. It applies `appraiseRules` inline when the appraiser kind is `rules`, or when the line is not a mention and `text.trim().length < 4` ("a line too short to carry tone isn't worth a model call"). Otherwise the job goes onto a queue capped at `MAX_QUEUED = 8` (oldest shifted off first), and a single worker promise (`draining`) drains it one job at a time; each job re-reads the mood at run time, so a queued line is appraised against the mood as it is then (`affect.ts:94-99`, test `test/affect.region.test.ts:97-111`). `settled()` awaits the worker and exists for tests (`affect.ts:75-77`).

## Publishing

`Affect.publish()` (`affect.ts:101-111`) runs on a `setInterval` of `publish_ms` in `index.ts:29`. It ticks the mood, builds a key `mood:valence.toFixed(2):arousal.toFixed(2)`, and returns without publishing if the key equals the last published key and less than 15 000 ms (hard-coded) have passed. Otherwise it records the key and time and calls `bus.publish("affect.state", state)` with `void`. The first call always publishes (`lastPublished` starts empty). `cause` is not part of the key.

## Control, Pause and Health

`control` (`affect.ts:63-70`): ignored if `target` is set and is not `affect`. `pause` sets `paused`; while paused every non-`control` event returns early (`affect.ts:38`) so the mood is not nudged, but `publish()` keeps ticking decay and publishing (test `test/affect.region.test.ts:150-157`). `resume` clears it. `forget_context` nudges valence to `baseline_valence` and arousal to 0.1 with cause `reset` (and works while paused because control events pass the guard). `mute` / `unmute` / `say` are ignored.

Health: `affectHealth = { service: "affect", mode: "live", deps: {} }` (`health.ts:4`); `startHeartbeat` runs at module load (`index.ts:20`) and `heartbeat.ready()` is called after `bus.subscribe` is started (not awaited) and the publish timer is set (`index.ts:25-30`). Heartbeat semantics belong to control-plane. Fatal startup errors log and exit 1 (`index.ts:34`); `onShutdown` only calls `bus.stop()` (`index.ts:35`) and the shared helper then `process.exit(0)`s (`packages/bus/src/index.ts:241`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| State model | Two scalars (valence, arousal) with nearest-emotion label | discrete emotion state machine; LLM-held mood | `[inferred]` `mood.ts:6-11` doc comment ("cheap, continuous... without anyone calling an LLM"). |
| Decay | Exponential half-life, applied lazily on access | periodic decay timer | `[inferred]` `mood.ts:22-29`; `tick()` is called from `nudge`, `appraise` and `publish`; test `test/affect.test.ts:34-47`. |
| Arousal baseline | Hard-coded 0.1; only valence baseline configurable | `baseline_arousal` config key | `[inferred]` `mood.ts:14,28`; schema has only `baseline_valence` (`schema.ts:132`). No documented reason. |
| Slow appraiser handling | Worker queue, max 8, drop oldest | block the bus handler; drop newest; unbounded queue | `[inferred]` `affect.ts:14-20` doc comment; test `test/affect.region.test.ts:124-131`. |
| Short lines | Lines under 4 chars without a mention use rules inline even for llm/http | always call the model | `[inferred]` `affect.ts:84-85` comment; test `test/affect.region.test.ts:113-122`. |
| Queued job input | Re-read current mood when the job runs | use mood captured at enqueue | `[inferred]` `affect.ts:96`; test `test/affect.region.test.ts:107`. |
| Publish gating | Change key (mood + 2-dp valence/arousal) plus 15 s heartbeat | publish every interval; publish every change | `[inferred]` `affect.ts:105-107` comment "Only publish when it moved, plus a heartbeat so late joiners get a value"; test `test/affect.region.test.ts:77-95`. |
| Pause semantics | Stop nudging, keep decaying and publishing | stop everything; exit process | `[inferred]` `affect.ts:29` comment; test `test/affect.region.test.ts:150-157`. |
| Own speech feedback | The co-host's own `brain.say` emotion nudges its mood | ignore own speech | `[inferred]` `affect.ts:57` comment "Saying something emotional reinforces the mood a little (and talking is arousing)". |
| Emoji matching | Alternations with `u` flag, not character classes | `[...]` classes | `[inferred]` `appraise.ts:17-18` comment; regression test `test/affect.test.ts:58-66`. |
| Delta bounds | llm/http deltas clamped to +-0.5 | trust the model; clamp to prompt range | `[inferred]` `appraise.ts:37`; test `test/appraiser.test.ts:31-37`. |

## Open Questions & Future Decisions

1. **Stale "No LLM, no database" claims.** `index.ts:9` and `README.md` ("Mood": "No LLM, no database") predate the `affect.appraiser` hook; with `module.kind: llm` the service does call a model (`appraise.ts:43-54`). OpenSpec says only that it never calls a database.
2. **Unused dependency.** `@cohost/working-memory` is listed in `package.json:16` and referenced in `tsconfig.json:8`, but nothing under `services/affect/src` or `test` imports it (grep verified). `@cohost/llm` is only a transitive dependency via `@cohost/modules`.
3. **Duplicated `clamp`.** `mood.ts:55` defines a local `clamp` while `appraise.ts:1` of the same service imports the exported one from `@cohost/modules` (`packages/modules/src/index.ts:110`).
4. **Hard-coded constants.** Resting arousal 0.1 (`mood.ts:14,28`, `affect.ts:68`), the 15 s heartbeat (`affect.ts:107`), the nudge sizes (`affect.ts:43,53,59-60`), the `MAX_QUEUED` of 8 (`affect.ts:20`), the 4-character short-line cutoff (`affect.ts:85`) and the emotion lists for `brain.say` (`affect.ts:59`) are not configurable.
5. **Docblock misplaced.** The multi-line queue design comment (`affect.ts:14-19`) sits above `const MAX_QUEUED`, not above the class.
6. **Unhandled rejections.** `publish()` does `void this.d.bus.publish(...)` with no catch (`affect.ts:110`) and `drain()` runs under `.finally` with no catch (`affect.ts:91`); the interval callback is `() => affect.publish()` (`index.ts:29`). A Redis failure becomes an unhandled rejection, which terminates the process under Node defaults (no handler exists in the repo). `Module.run` itself does not throw (falls back to rules).
7. **Timer not cleared on shutdown** (`index.ts:29,35`); cosmetic because the shared `onShutdown` ends in `process.exit(0)`.
8. **Queue survives pause and reset.** `pause` and `forget_context` do not clear queued llm/http jobs, and `drain` does not check `paused` (`affect.ts:36-38,68,94-99`), so a job queued before a pause or reset can still nudge the mood afterwards. Not covered by tests.
9. **Prompt ranges disagree with validation.** The llm prompt asks for valence_delta -0.3..0.3 and arousal_delta 0..0.3 (`appraise.ts:47`) but `validate` accepts -0.5..0.5 for both (`appraise.ts:37`), and the rules output is unclamped (up to +0.44 arousal).
10. **Publish key coarser than the state.** The key uses 2 decimals (`affect.ts:104`) while `state()` rounds to 3 (`mood.ts:44`) and excludes `cause`; small movements and cause-only changes are not published until the 15 s heartbeat.
11. **Single-letter tokens in word lists.** POSITIVE contains `w`, NEGATIVE contains `l` and `f` as whole words (`appraise.ts:19-20`), so a lone "L" or "W" in chat moves the mood. May be deliberate stream slang.
12. **Self-reinforcing loop.** The co-host's own `brain.say` emotion feeds back into mood (`affect.ts:56-62`), and the label of that mood feeds the cortex prompt and avatar; there is no damping beyond the half-life. Whether this is intended gain is unstated.
13. **Mentions on speech.** Speech is always appraised with `mention = false` (`affect.ts:48`), so a voice line addressed to the co-host does not get the +0.2 mention arousal; speech instead has a higher base (0.15).
14. **Test gaps.** No test for `index.ts` wiring (subscription list, `publish_ms` timer, `ready()`), for label boundary equalities (e.g. exactly 0.6), for the 4-character cutoff boundary, or for pause/reset interacting with the queue. The http-kind tests monkey-patch `Module.run` (`test/affect.region.test.ts:21`).
15. **`ready()` precedes subscription readiness.** `heartbeat.ready()` fires right after the un-awaited `bus.subscribe(...)` call (`index.ts:25,30`).

## References

Code (`services/affect/`): `src/index.ts`, `src/affect.ts`, `src/mood.ts`, `src/appraise.ts`, `src/health.ts`, `package.json`, `tsconfig.json`.
Tests: `test/affect.test.ts` (rules, label, Mood decay, emoji), `test/affect.region.test.ts` (Affect class: nudges, reset, publish gating, queue, pause), `test/appraiser.test.ts` (http appraiser validation), `test/health.test.ts`.

Segments depended on:
- event-bus (BUS): `Bus`, `Publisher`, `onShutdown`; consumes `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `control`; produces `affect.state`.
- config (CFG): `loadConfig`, `brain.affect.*` (`publish_ms`, `half_life_ms`, `baseline_valence`, `module`), `Emotion`.
- region-hooks (HOOK): `Module` / `affect.appraiser`.
- control-plane (CTRL): heartbeat contract and `control` pause/resume semantics.

Downstream consumers: salience (arousal -> threshold), cortex (prompt colour), avatar (resting expression), dashboard (display).

External: Redis (via the bus); optional LLM provider or HTTP endpoint for the appraiser hook.

OpenSpec: `openspec/specs/affect/spec.md`; deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/affect/spec.md`, `openspec/changes/archive/2026-11-01-add-service-control/specs/affect/spec.md`.
