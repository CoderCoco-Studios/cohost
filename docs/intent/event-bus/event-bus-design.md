---
parent: high-level-design
prefix: BUS
---

# event-bus

Status: AUDITED 2026-11-02 at git `1b57790`. Mapped 2026-10-31 at git `686cc8f` (reverse-engineered from code); specs verified against the code and `@spec` annotations added at git `49ba935`; owner decisions of 2026-11-01 applied. Where the code does not yet do what this document intends, the text names the `[ ]` spec line. Parent: [high-level-design](../../high-level-design.md). Specs: [event-bus-specs.md](event-bus-specs.md). Arrow: [docs/arrows/event-bus.md](../../arrows/event-bus.md).

## Context and Design Philosophy

`@cohost/bus` (`packages/bus`) is the only channel between cohost services. The header of `packages/bus/src/events.ts:5-8` says so directly: services "only ever talk through these events - never directly to each other - so any piece can be swapped". The package has three jobs:

1. A **schema registry** (`events.ts`): one zod schema per event type, plus the derived TypeScript types (`EventType`, `EventData`, `EventInput`, `BusEvent`) and `EVENT_TYPES`.
2. A **thin typed wrapper over two Redis Streams** (`index.ts`): `cohost:events` for domain events and `cohost:health` for heartbeats. Publish is validate-then-`XADD`; subscribe is a consumer-group loop; `tail` / `recent` are non-group reads for the dashboard.
3. **Process-lifecycle helpers** that happen to live here: `onShutdown` and `beforeShutdown` (`index.ts:231-257`), and the heartbeat helper `startHeartbeat` (`heartbeat.ts`, owned by [control-plane](../control-plane/control-plane-design.md)).

Guiding principles visible in the code:

- Validate on both sides. `publish` parses against `EventPayloads[type]` before writing (`index.ts:50`); `decode` parses again on every read (`index.ts:224`). Malformed entries are dropped rather than delivered (`index.ts:217`, `index.ts:226-228`).
- Keep services decoupled from Redis. Region logic depends on `Publisher = Pick<Bus, "publish">` (`index.ts:30`) so tests can pass a recorder (see [Test double](#test-double-packagestestingsrcindexts)).
- Heartbeats must not evict domain events, so they have their own capped stream (`index.ts:10-12`, comment at line 10).
- Binary payloads never ride the stream. `inject.request` carries a `url` into the dashboard upload store (`events.ts:182-185` comment).

Scope of this segment: `packages/bus/src/index.ts`, `packages/bus/src/events.ts`, `packages/bus/test/bus.test.ts`, `packages/bus/test/shutdown.fixture.ts`, `packages/bus/package.json`, `packages/bus/tsconfig.json`, and (documented here because it is the test double for `Bus`) `packages/testing/src/index.ts`. `packages/bus/src/heartbeat.ts` and the `service.heartbeat` / `service.lifecycle` semantics belong to [control-plane](../control-plane/control-plane-design.md); this document records only their schemas and the `Bus` methods that carry them.

## Stream layout and envelope

| Stream | Constant | Trim | Carries |
|---|---|---|---|
| `cohost:events` | `STREAM` (`index.ts:8`) | `MAXLEN ~ 20000` (`index.ts:9`, used at `index.ts:52`) | every event type except `service.heartbeat` |
| `cohost:health` | `HEALTH_STREAM` (`index.ts:11`) | `MAXLEN ~ 1000` (`HEALTH_MAXLEN`, `index.ts:12`, used at `index.ts:67`) | `service.heartbeat` only |

Both streams use the same entry fields (`index.ts:53-56`, `index.ts:68-71`): `type`, `ts` (`String(Date.now())`, publisher clock), `source` (the `Bus` constructor's first argument, usually the service name), `data` (`JSON.stringify` of the zod-parsed payload). The Redis stream id is the event id. `decode` (`index.ts:213-229`) rebuilds a `BusEvent`: `{ id, type, ts: Number(m.ts ?? 0), source: m.source ?? "?", data }` and returns `undefined` for an unknown type, non-JSON `data`, or a schema failure.

Typing detail: `publish` accepts `EventInput<T>` (`z.input`, defaults optional), subscribers receive `EventData<T>` (`z.infer`, defaults applied). So `chat.message` published without `isMod` is stored and delivered with `isMod: false`.

## Bus API

Constructor: `new Bus(source, log?, url = urls.redis())` (`index.ts:43`). `urls.redis()` is `REDIS_URL` or `redis://127.0.0.1:6379` (`packages/config/src/index.ts:167`). The publish connection is opened eagerly (`lazyConnect: false`, `maxRetriesPerRequest: 3`, `index.ts:44`). Each `subscribe`, `tail` and `tailHealth` opens its own extra connection with `maxRetriesPerRequest: null` (infinite ioredis reconnect, `index.ts:79`, `index.ts:131`, `index.ts:176`). `consumer` is `${HOSTNAME ?? "local"}-<8 hex of a random uuid>` (`index.ts:41`), fixed for the life of the `Bus` instance.

| Method | Behavior | Lines |
|---|---|---|
| `publish(type, data)` | throws for `service.heartbeat`; zod-parses; `XADD cohost:events MAXLEN ~ 20000`; returns stream id; debug log | `index.ts:48-60` |
| `publishHealth(data)` | zod-parses as `service.heartbeat`; `XADD cohost:health MAXLEN ~ 1000`; returns id | `index.ts:64-74` |
| `subscribe(opts, handler)` | consumer-group loop (below); resolves only after `stop()` | `index.ts:130-171` |
| `tail(handler, fromId="$")` | non-group `XREAD COUNT 100 BLOCK 5000` loop on `cohost:events`; no ack, no replay | `index.ts:175-195` |
| `tailHealth(handler, fromId="$")` | same loop on `cohost:health`; only `service.heartbeat` entries reach the handler | `index.ts:78-98` |
| `recent(count=100)` | `XREVRANGE + - COUNT n`, decoded, undecodable entries filtered, reversed to oldest-first | `index.ts:199-202` |
| `recentHealth(count=100)` | same on `cohost:health` | `index.ts:102-108` |
| `resetGroup(group)` | `XGROUP SETID cohost:events group $`; on `NOGROUP` create at `$` with `MKSTREAM`; tolerate `BUSYGROUP`; rethrow anything else | `index.ts:115-126` |
| `stop()` | sets the instance-wide `stopped` flag, disconnects every sub/tail connection and the publish connection | `index.ts:205-209` |

### Consumer-group subscription loop

`SubscribeOptions` (`index.ts:16-25`): `group` (one per service), `types?` (client-side filter), `fromNow?` (start at `$` instead of `0`), `blockMs?` (default 5000).

**Start mode.** Every subscription names where it starts reading after a process start (BUS-SUB-011):

- `latest`: the group is moved to the newest entry (`$`) on every start, so a restarted subscriber never acts on events published while it was down (BUS-SUB-010). Used by every subscribing service except memory: a co-host that speaks, reacts or animates must not replay stale chat, focus or speech lines after a restart.
- `resume`: an existing group keeps its stored position, so the backlog still held by the 20000-entry stream is delivered after a restart (BUS-SUB-002). Used by memory, which wants to store what it missed.
- In either mode a missing group is created at `$` (BUS-SUB-001); a first-ever start never replays the stream.

The code does not have the option yet: `fromNow` only positions a newly created group (`$` when true, `0` otherwise) and an existing group always resumes (`index.ts:133-138`). Every subscriber passes `fromNow: true`, so today a plain restart resumes and only a control-plane `fresh` start skips the backlog (`Bus.resetGroup`).

Loop:

1. Create the group with `XGROUP CREATE cohost:events <group> <$ or 0> MKSTREAM`; a `BUSYGROUP` error is ignored (`index.ts:133-138`).
2. Read loop (`index.ts:143-169`): starts with cursor `"0"` (this consumer's pending entries), switches to `">"` (new entries) once the pending read returns nothing (or after the first non-empty pending batch). Batches are `COUNT 50` with `BLOCK blockMs`.
3. For each entry: `decode`; if it decodes and passes the `types` filter, `await handler(ev)` inside try/catch (error logged as `"handler failed"`, `index.ts:163`); then `XACK` regardless of filter result, decode failure, or handler failure (`index.ts:166`). Handlers therefore run strictly one at a time per subscription, and failed events are dropped with no retry or dead-letter.
4. A read error while `stopped` breaks the loop quietly. Any other read error is logged and the read retried after a delay that grows with each consecutive failure up to a cap, so a Redis outage never ends the subscription (BUS-SUB-009). The code does not yet retry: it rethrows, rejecting the `subscribe` promise (`index.ts:150-153`), and callers use `void bus.subscribe(...)` with no `.catch` (e.g. `services/voice/src/index.ts:30`), so the failure is an unhandled rejection.

**Delivery is at most once** (BUS-SUB-008). Handler failures are acknowledged, and an entry read but not acknowledged by a process that then dies is not redelivered to its successor: each `Bus` instance reads under its own consumer name (`index.ts:41`) and nothing claims another consumer's pending entries. The pending drain at the top of the loop (cursor `0`, one batch of 50) only matters within one process lifetime; the code comment calling it "crash recovery" (`index.ts:142`) overstates it.

### Health-stream methods

`publishHealth`, `tailHealth` and `recentHealth` exist because `publish("service.heartbeat", ...)` throws `service.heartbeat goes on the health stream: use publishHealth()` (`index.ts:49`). `tailHealth` and `recentHealth` are used by the dashboard feed (`services/dashboard/src/feed.ts:46,49`) and by control-plane's CLI and healthcheck (`packages/control/src/cli.ts:111`, `packages/control/src/healthcheck.ts:23`). `resetGroup` is used by the service controller for "fresh" starts (`packages/control/src/controller.ts:23,42`). This segment owns the heartbeat transport (BUS-STREAM-004, BUS-HEALTH-001 to 004); what a heartbeat means and how it is consumed is [control-plane](../control-plane/control-plane-design.md)'s.

`tail` and `tailHealth` follow the same failure rule as `subscribe`: a non-stop read error is logged and retried with a capped, growing delay from the last delivered id (BUS-TAIL-003), and a handler that throws is logged and the loop continues (BUS-TAIL-004). The code does neither yet: both loops rethrow (`index.ts:86-89`, `index.ts:183-186`) and call the handler unguarded (`index.ts:94`, `index.ts:191`).

### Shutdown helpers

- `beforeShutdown(fn)` pushes onto a module-global list (`index.ts:231-238`). The only in-repo registrant is `startHeartbeat` (`heartbeat.ts:117`), which registers its `stop()` so a `stopping` heartbeat goes out first.
- `onShutdown(fn)` (`index.ts:242-257`) installs SIGINT and SIGTERM handlers. On the first signal for that registration it runs all pre-shutdown hooks concurrently via `Promise.allSettled`, raced against a 2000 ms `HOOK_TIMEOUT_MS` (unref'd timer), then awaits `fn()`, then `process.exit(0)` in a `finally` (BUS-STOP-002 to 004). This segment owns these mechanics (hook window, callback order, exit code); control-plane only registers the heartbeat's `stop()` as a hook (CTRL-HEARTBEAT-005).
- Intended composition: one shutdown sequence per process. The hooks run once, then every registered `onShutdown` callback runs to completion, a callback that throws or rejects is logged and does not stop the others, and the process exits once with code 0 (BUS-STOP-005). A hook that throws synchronously is treated like a rejected one (BUS-STOP-006). The code differs on both: each registration exits on its own, so two live registrations race (eyes, `services/eyes/src/index.ts:90,94`; ears under the Discord plan, `services/ears/src/index.ts:39` and `services/ears/src/discord.ts:122`; chat's three at `services/chat/src/index.ts:50,59,109` sit in exclusive branches), a failing callback is not logged, and a synchronously throwing hook escapes the `map` (`index.ts:249`), skips `fn` and goes straight to the exit (the one in-repo hook, the heartbeat `stop`, is `async`, so it cannot).
- `index.ts` re-exports `./heartbeat.js` at its last line (`index.ts:259`) and `heartbeat.ts` imports `beforeShutdown` from `./index.js`; the cycle works because `beforeShutdown` is only called at runtime.
- The subprocess fixture `packages/bus/test/shutdown.fixture.ts` proves the ordering `hb:starting`, `hb:ready`, `hb:stopping`, `bus.stop` (asserted at `bus.test.ts:257-261`).

## Event catalogue (19 types)

Source: `packages/bus/src/events.ts`. Producer / consumer columns are observed from `publish(` and `subscribe(` call sites at `686cc8f`; the schema encodes neither (comments only). Optional fields marked `?`; `default` shows the zod default. Flags `injected?` and `remember?` are both `z.boolean().optional()` with no default.

| # | Type | Payload | Producers -> consumers (observed) | events.ts (spec) |
|---|---|---|---|---|
| 1 | `chat.message` | `platform` (`twitch`, `youtube`, `discord`), `user`, `userId?`, `text`, `isMod` default false, `isSub` default false, `mentionsCohost` default false, `injected?`, `remember?` | chat (`services/chat/src/index.ts:41,104`, `inject.ts:32`), dashboard direct inject (`services/dashboard/src/inject.ts:103`) -> salience, affect, memory, cortex | 13-25 (BUS-EVT-002) |
| 2 | `vision.summary` | `text`, `changed` default true, `injected?`, `remember?` | eyes (`eyes.ts:71`, `inject.ts:59`), dashboard (`inject.ts:111`) -> salience, affect, cortex | 29-36 (BUS-EVT-012) |
| 3 | `speech.heard` | `speaker`, `speakerId?`, `text`, `durationMs`, `injected?`, `remember?` | ears (`hearing.ts:46`, `inject.ts:70`), dashboard (`inject.ts:109`) -> salience, affect, memory, cortex | 40-48 (BUS-EVT-013) |
| 4 | `brain.say` | `id`, `text`, `emotion`, `gesture?`, `reason?`, `injected?`, `remember?` | cortex (`cortex.ts:193`), salience reflex (`salience.ts:98`) -> voice, avatar, memory, salience, cortex (self line), dashboard | 52-62 (BUS-EVT-014) |
| 5 | `brain.status` | `state` (`idle`, `thinking`, `speaking`, `muted`), `detail?` | cortex (`cortex.ts:163`) -> salience, dashboard | 66-69 (BUS-EVT-015) |
| 6 | `attention.focus` | `reason`, `score`, `focus?` (`kind` of `chat`, `speech`, `vision`; `who?`; `text`; `mention` default false), `injected?`, `remember?` | salience (`salience.ts:122`) -> cortex | 75-91 (BUS-EVT-010) |
| 7 | `affect.state` | `valence` in -1..1, `arousal` in 0..1, `mood` (Emotion), `cause?` | affect (`affect.ts:110`) -> salience, avatar, cortex | 95-104 (BUS-EVT-003) |
| 8 | `memory.recall.request` | `id`, `query`, `k?` (positive int) | cortex (`cortex.ts:182`) -> memory | 108-112 (BUS-EVT-010) |
| 9 | `memory.recall.reply` | `id`, `memories` (array of `ts`, `kind` of `chat`, `speech`, `self`, `note`; `who`; `text`; `similarity?`) | memory (`region.ts:50`) -> cortex | 115-126 (BUS-EVT-010) |
| 10 | `memory.viewer` | `user`, `isNew`, `msgCount` (int), `notes` default `""` | memory (`region.ts:27`) -> cortex | 130-135 (BUS-EVT-010) |
| 11 | `voice.utterance` | `id`, `text`, `emotion`, `gesture?`, `durationMs`, `envelopeHz`, `envelope` (number array), `audioUrl`, `sampleRate` | voice (`voice.ts:98`) -> avatar, ears (Discord sink), dashboard | 139-150 (BUS-EVT-016) |
| 12 | `voice.playing` | `id`, `sink` | voice virtual sink (`voice.ts:109`), ears Discord sink (`playback.ts:46`) -> voice, avatar | 154 (BUS-EVT-017) |
| 13 | `voice.done` | `id`, `sink` | voice (`voice.ts:110,115`), ears (`playback.ts:35`) -> cortex, avatar | 155 (BUS-EVT-017) |
| 14 | `avatar.state` | `emotion`, `intensity`, `mouthOpen`, `mouthSmile`, `headX`, `headY`, `headZ`, `eyeX`, `eyeY`, `blink` (numbers, unconstrained), `driver`, `connected` | avatar (`services/avatar/src/index.ts:26`) -> dashboard | 159-171 (BUS-EVT-018) |
| 15 | `control` | `cmd` (`mute`, `unmute`, `say`, `forget_context`, `reload_personality`, `pause`, `resume`), `text?`, `target?` (service name; absent = all) | dashboard (`routes.ts:107,115`) -> cortex, salience, affect | 175-180 (BUS-EVT-004) |
| 16 | `inject.request` | `id`, `target` (`eyes`, `ears`, `chat`), `kind` (`image`, `audio`, `text`), `url?`, `text?`, `meta?` (`user?`, `platform?`, `isMod?`, `isSub?`), `remember` (required boolean) | dashboard (`inject.ts:94,134`) -> eyes, ears, chat | 188-203 (BUS-EVT-006; per-kind completeness is checked by each target service) |
| 17 | `inject.result` | `id`, `ok`, `detail?` | eyes, ears, chat (`inject.ts` in each) -> dashboard | 207-211 (BUS-EVT-007) |
| 18 | `service.lifecycle` | `service`, `action` (`start`, `stop`, `restart`), `by` (`dashboard` or `cohostctl` by convention), `ok`, `detail?` | dashboard (`control.ts:40`), control CLI (`packages/control/src/cli.ts:107`) -> dashboard tail | 215-222 (BUS-EVT-008) |
| 19 | `service.heartbeat` | `service`, `instance`, `pid` (int), `version`, `startedAt`, `state` (`starting`, `ready`, `degraded`, `stopping`), `deps` (record of `ok`, `down`, `n/a`), `mode` (string; `live`, `mock`, `off` by convention), `detail?`, `intervalMs` (positive int) | every service via `publishHealth` on `cohost:health` -> dashboard tracker, control-plane | 229-243 (BUS-EVT-009) |

`Emotion` is imported from `@cohost/config` (`packages/config/src/schema.ts:4-7`): `neutral`, `happy`, `laugh`, `surprised`, `smug`, `sad`, `angry`, `confused`, `think`.

### Injection flags

Added by the `add-test-injection` change. `injected` marks an event that came from the dashboard test-injection panel; `remember` says whether an injected event may be persisted to long-term memory (`remember` is meaningful only when `injected` is true; `services/memory/src/region.ts:13` `skipInjected`). The five flagged types are `chat.message`, `vision.summary`, `speech.heard` (the perception inputs) and `brain.say`, `attention.focus` (derived outputs that carry the flags of the input that caused them). Real traffic never carries the keys: zod `.optional()` with no default leaves them absent (asserted at `bus.test.ts:321-333`). Copying flags from an input onto a derived output is done by `propagatedFlags` in [working-memory](../working-memory/working-memory-design.md), not here.

### Other schema notes

- `control.target` is optional so old publishers stay valid (`events.ts:178` comment).
- `voice.utterance.audioUrl`'s comment hard-codes `http://voice:8700/audio/<id>.wav` (`events.ts:147`), a compose hostname/port inside a schema comment.
- `voice.playing` and `voice.done` are identical single-line schemas (`events.ts:154-155`).
- `avatar.state` numeric fields carry no range constraints, unlike `affect.state` (`events.ts:159-172` vs `95-104`).
- `EVENT_TYPES` (`events.ts:260`) is exported and used by the dev scripts `scripts/dev/bus-pub.ts` and `scripts/dev/bus-tail.ts` and by tests; `decode` uses `type in EventPayloads` instead (`index.ts:217`).

## Test double: `packages/testing/src/index.ts`

`@cohost/testing` is the shared helper package for region and service tests (30 import sites across service/package tests). It has no tests of its own (no `test/` dir). Exports:

- `testConfig(over?)` (`:15-28`): deep-merges `over` onto a minimal base (`cohost` Coco/Chris/UTC, `llm` model `m` / embed `e`, `vision` model `v`, twitch channel `chan`, `brain.salience.cooldown_ms: 0` and `idle_chatter_ms: 0`, placeholder avatar hosts, empty `voice`, `ears.discord`, `dashboard`) and returns `ConfigSchema.parse(...)`, so a test config is always schema-valid with timing knobs zeroed. The local `merge` / `isObj` helpers (`:3-12`) duplicate a lambda in `packages/config/src/index.ts`.
- `silentLog` (`:31`) and `recordingLog()` (`:35-40`): pino-shaped loggers cast `as never`. `recordingLog` returns `{ log, lines, msgs(level) }` and implements only `warn`, `info`, `error`, `debug` (no `fatal` / `trace`, unlike `silentLog`).
- `FakeBus implements Publisher` (`:44-80`):
  - `published: { type, data }[]` holds the zod-parsed payload of each accepted publish; `of(type)` returns the payloads of one type, `types()` the type sequence, `clear()` empties both `published` and `health`.
  - `publish(type, data)` (`:66-72`) mirrors the real bus ordering: throws for `service.heartbeat`, then zod-parses (so invalid payloads throw and defaults are applied), then throws `publish <type> failed` when the optional `fail(type)` predicate returns true, then records. Returns the 1-based count as the id.
  - Health: `publishHealth` (`:53-58`) validates, throws `publishHealth failed` when `failHealth` is true, otherwise records into `health`. `recentHealth(count=100)` (`:60-64`) returns the last `count` heartbeats wrapped as `BusEvent`s (id is the slice index, `source` is `data.service`). `consumer` is the constant `fake-instance` (`:48`).
  - It does **not** implement `subscribe`, `tail`, `tailHealth`, `recent`, `resetGroup` or `stop`; services that depend on those (dashboard feed, controller) take narrower `Pick<Bus, ...>` types and use their own fakes.
- `event(type, data, source="test")` (`:84-86`): builds a `BusEvent` as a subscriber would receive it, with `EventPayloads[type].parse(data)` (defaults applied), `ts: Date.now()`, and a random uuid id (real ids are Redis stream ids).
- `runHeartbeat(spec, drive?)` (`:93-103`): runs `startHeartbeat` against a `FakeBus` at `intervalMs: 60_000`, calls `drive(hb)` (default `hb.ready()`), waits 10 ms, calls `hb.stop()`, returns `bus.health`. Each call registers another `beforeShutdown` hook in the module-global list (never removed); harmless in tests, a small leak.
- `waitFor(cond, what="condition", ms=2000)` (`:106-112`): polls every 2 ms and throws `timed out waiting for <what>`.

## Tests

`packages/bus/test/bus.test.ts` (node:test, run from the repo root by `pnpm test`, which first runs `tsc -b`; `package.json:test` globs `packages/*/test/*.test.ts` so `shutdown.fixture.ts` is not picked up directly):

- Pure schema tests (run without Redis): catalogue and shape checks for the region events, `service.heartbeat`, `service.lifecycle`, `control` (target, pause, resume), the injection flags, `inject.request`, `inject.result`, plus the `startHeartbeat`/`tracked` tests that use an in-memory recorder (control-plane behavior).
- Redis integration tests (auto-skip when no Redis at `REDIS_URL`, probed by top-level `await redisUp()` at `bus.test.ts:7-10,42`): round trip, validate-before-write, handler-throw-is-acked, `recent` ordering and undecodable-skip, `tail`, `stop()` interrupting blocked reads, heartbeat routing, `recentHealth` / `tailHealth`, `resetGroup`.
- The integration tests use the production stream keys and leave `test-*`, `throw-*`, `stop-*` groups and raw malformed entries behind in a shared dev Redis (`bus.test.ts:84-98` writes malformed entries with raw `XADD`). They synchronize with fixed 200-300 ms sleeps.
- Every test carries an `@spec` annotation; the arrow doc's Spec Coverage table is generated from them.
- Not covered by any test: MAXLEN trimming (BUS-STREAM-002), the consumer name format (BUS-STREAM-005), the full `chat.message` shape (BUS-EVT-002) and the shapes of `vision.summary`, `speech.heard`, `brain.say`, `brain.status`, `voice.utterance`, `voice.playing`/`voice.done`, `avatar.state` (apart from BUS-EVT-018) and the `Emotion` fields (BUS-EVT-012 to 019; `bus.test.ts:321-333` parses some of them only to check the injection flags), resuming an existing group (BUS-SUB-002), the pending-entry drain (BUS-SUB-003), sequential delivery (BUS-SUB-006), a non-stop read error (BUS-SUB-009), decode drops inside `subscribe` (only `recent` covers BUS-SUB-007), a throwing `tail` handler, `onShutdown` idempotence and exit code on a throwing callback (BUS-STOP-003, BUS-STOP-004), the `beforeShutdown` timeout, multiple `onShutdown` registrations, and the whole of `packages/testing` (BUS-TEST-001 to 010; exercised only indirectly by service tests).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Transport | Redis Streams with consumer groups, one stream for all domain events | Pub/sub, per-event-type streams, direct HTTP between services | Services never talk to each other directly so any piece can be swapped (header comment `events.ts:5-8`), and each service's group keeps its own read position (comment `index.ts:17`). Why Streams rather than pub/sub or one stream per type: `[inferred]` per-service read positions plus a bounded backlog that `resume` subscribers and the dashboard backfill can read; `packages/bus/src/index.ts:133-138`. |
| Validation | zod schema per type, parsed on publish and on read | Validate only on publish; trust the stream | `[inferred]` Defence against hand-written `XADD` and schema drift between versions; `index.ts:50` and `index.ts:224`, with the malformed-entry test at `bus.test.ts:84-98`. |
| Heartbeats on a separate stream | `cohost:health`, `MAXLEN ~ 1000` | Same stream as events | Comment `index.ts:10`: heartbeats live on their own capped stream "so they never evict domain events" from the 20000-entry cap; `publish` hard-rejects the type at `index.ts:49`. Introduced with that split in commit `691b079`. |
| Handler failure | Log, ack, continue | Leave pending and retry; dead-letter stream | Owner decision 2026-11-01: delivery is at most once, and a poison event must not wedge a live co-host. Pinned by the XPENDING assertion at `bus.test.ts:56-81`. |
| Delivery across restarts | At most once: a dead process's unacknowledged entries are not redelivered (BUS-SUB-008) | At least once via stable consumer names plus `XAUTOCLAIM` of dead consumers' pending entries | Owner decision 2026-11-01: nearly every subscriber wants only fresh input and handlers already ack on failure, so redelivery would only replay a line the co-host has moved past; the in-process pending drain stays. |
| Start position after a restart | Explicit per-subscription start mode: `latest` resets the group to `$` on every start, `resume` keeps the stored position; memory uses `resume`, every other subscriber `latest` (BUS-SUB-002, BUS-SUB-010, BUS-SUB-011) | `fromNow` that only positions a new group (an existing group always resumes); leave the reset to control-plane `fresh` starts | Owner decision 2026-11-01: a compose or crash restart must not make the co-host speak, react to or animate stale events, while memory still stores what it missed. Putting the choice in the subscription makes it hold for every restart path, not only control-plane starts. |
| Subscribe and tail read failures | Log and retry with a capped, growing delay; guard tail handlers (BUS-SUB-009, BUS-TAIL-003, BUS-TAIL-004) | Reject the promise and let the process crash for compose to restart; leave reconnection to ioredis alone | Owner decision 2026-11-01: an unhandled rejection ends a Node 22 process, and a crash-restart loop hides the cause behind a container restart instead of a log line. |
| `onShutdown` with several registrations | One sequence: hooks once, every callback to completion with errors logged, exit 0 once; synchronous hook throws treated like rejections (BUS-STOP-005, BUS-STOP-006) | Each registration exits on its own; exit non-zero when a callback fails | Owner decision 2026-11-01: services such as eyes and ears register more than one cleanup, and a failing cleanup must not skip the others; exit 0 keeps compose from treating a deliberate stop as a crash. |
| Per-kind `inject.request` completeness | Checked by each target service's `inject.ts`, which answers `inject.result` | Enforce `url` / `text` per `kind` in the bus schema | Owner decision 2026-11-01: the target service already validates and reports a readable failure to the dashboard; a schema rejection would only surface as a publish error. (Former BUS-EVT-011 is retired; the number is not reused.) |
| Ownership of heartbeat transport and shutdown mechanics | event-bus owns `publishHealth` / the `cohost:health` stream (BUS-STREAM-004, BUS-HEALTH-001 to 004) and the `onShutdown` / `beforeShutdown` sequence (BUS-STOP-001 to 006); control-plane owns heartbeat meaning and the heartbeat's `beforeShutdown` registration (CTRL-HEARTBEAT-005) | Restate the same statements in both segments | Owner decision 2026-11-01: one spec line per behaviour; the code entry points carry one segment's IDs. |
| Type filtering | Client-side after read; filtered entries acked | One group/stream per type | `[inferred]` Simplicity; every service group reads and acks the whole stream (`index.ts:159-166`). |
| Live dashboard read | Non-group `XREAD` (`tail`) from `$`, plus `recent` backfill | A group per dashboard | `[inferred]` Dashboard needs no ack or replay state; comment at `index.ts:173`. |
| Fresh start of a service | `resetGroup` moves the group to `$` | Delete and recreate the group | The doc comment `index.ts:110-113` says it exists for "fresh" service starts; commit `1d316ff` adds it with the controller's fresh/resume start (`packages/control/src/controller.ts:42`). Why `SETID` rather than delete and recreate: `[inferred]`. |
| Shutdown ordering | Module-global `beforeShutdown` hooks run before `onShutdown` callbacks, 2 s cap | Each service flushes its own heartbeat | Commit `691b079`: a `beforeShutdown` hook "so a `stopping` beat goes out first"; doc comments `index.ts:232,235` (hooks must finish before the service's own callback; the cap bounds how long they may delay exit). Verified by `shutdown.fixture.ts` and `bus.test.ts:257`. |
| Test double | `FakeBus` implements only the publish and health halves, with real zod validation | Mock Redis; full in-memory bus | Comment `packages/testing/src/index.ts:42`: it "validates like the real Bus, records instead of talking to Redis". Why only those halves: `[inferred]` region tests only need to record publishes. |

## Open Questions & Future Decisions

### Resolved by observation

1. **OpenSpec divergence.** The frozen OpenSpec `bus` baseline (`openspec/specs/bus/spec.md`, 12 requirements) lists all 19 event types and the seven `control` commands and has health-stream, heartbeat-helper and injection requirements. Only the archived `add-service-health` bus delta still lists five `control` commands (`openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md:8`), and the baseline "Shutdown" requirement does not mention `beforeShutdown` or the 2 s hook cap. The LID specs here (BUS-EVT-004, BUS-STOP-002) describe the code and supersede it (`CLAUDE.md` § Specs).

### Observed, unexplained, or debt

1. **The pending drain reads one batch.** Within a process lifetime the drain reads a single `COUNT 50` batch of this consumer's pending entries before switching to `>` (`index.ts:168`), so a larger pending backlog would stay pending until the process ends (and then is abandoned, BUS-SUB-008).
2. **`stopped` is instance-wide and never reset** (`index.ts:40`, `index.ts:206`). One `Bus` cannot be restarted, and stopping it stops every subscription on that instance. A `stop()` that lands while a handler is running leaves the following `XACK` (`index.ts:166`) to run on a disconnected connection; its outcome is unspecified.
3. **Process-lifecycle helpers live in the bus package.** `onShutdown` / `beforeShutdown` / `startHeartbeat` are not bus concerns; they sit here because every service already depends on `@cohost/bus`. The `index.ts` <-> `heartbeat.ts` import cycle (`index.ts:259`, `heartbeat.ts:2`) is an artifact of that.
4. **Consumer-side half of BUS-EVT-004.** "An absent `target` means all services" is implemented by the consumers (`services/cortex/src/cortex.ts:94`, `services/salience/src/salience.ts:76`, `services/affect/src/affect.ts:65`), which belong to other segments; this segment annotates only the schema.
5. **Test hygiene.** Integration tests write to the real `cohost:events` / `cohost:health` streams and leave groups behind (`bus.test.ts:23-45`, `84-98`); `redisUp()` is evaluated twice (`bus.test.ts:23`, `:42`); the first test (`bus.test.ts:13-20`) checks only six region schemas.
6. **Schema looseness.** `avatar.state` has no numeric ranges (`events.ts:159-172`); `voice.playing` and `voice.done` duplicate a shape (`events.ts:154-155`).
7. **`decode` swallows every parse error silently** (`index.ts:226-228`) and `subscribe` acks the entry, so a producer/consumer schema mismatch loses events with no log line.
8. **Hostname in a comment.** `events.ts:147` embeds `http://voice:8700/audio/<id>.wav`.
9. **`FakeBus` ids differ from real ones.** `event()` uses a random uuid and `FakeBus.recentHealth` uses slice indices (`packages/testing/src/index.ts:60-64,84-86`), whereas real ids are Redis stream ids; tests that depend on id ordering would not transfer.

## References

- Segment files: `packages/bus/src/index.ts`, `packages/bus/src/events.ts`, `packages/bus/test/bus.test.ts`, `packages/bus/test/shutdown.fixture.ts`, `packages/bus/package.json`, `packages/bus/tsconfig.json`, `packages/testing/src/index.ts`, `packages/testing/package.json`, `packages/testing/tsconfig.json`.
- Owned elsewhere but exported from this package: `packages/bus/src/heartbeat.ts` (see [control-plane](../control-plane/control-plane-design.md)).
- Segments depended on: [config](../config/config-design.md) (`urls.redis`, `Logger`, `Emotion`; bus -> config).
- Segments that depend on this one: every service segment ([chat](../chat/chat-design.md), [eyes](../eyes/eyes-design.md), [ears](../ears/ears-design.md), [salience](../salience/salience-design.md), [affect](../affect/affect-design.md), [memory](../memory/memory-design.md), [cortex](../cortex/cortex-design.md), [voice](../voice/voice-design.md), [avatar](../avatar/avatar-design.md), [dashboard](../dashboard/dashboard-design.md)), [control-plane](../control-plane/control-plane-design.md), and [working-memory](../working-memory/working-memory-design.md) (type import). Services take `Publisher` (`Pick<Bus, "publish">`) in their region classes, e.g. `services/affect/src/affect.ts:9`, `services/eyes/src/eyes.ts:1`.
- External: `ioredis` ^5.4.0 (Redis Streams commands), `zod` ^3.24.0 (`packages/bus/package.json`), Redis server.
- OpenSpec (frozen, historical): `openspec/specs/bus/spec.md` (baseline, 12 requirements, includes the archived deltas); deltas `openspec/changes/archive/2026-11-01-add-service-health/specs/bus/spec.md`, `openspec/changes/archive/2026-11-01-add-service-control/specs/bus/spec.md`, `openspec/changes/archive/2026-11-01-add-test-injection/specs/bus/spec.md` (no bus delta in `add-isolated-backends`). `packages/testing` has no OpenSpec capability.
