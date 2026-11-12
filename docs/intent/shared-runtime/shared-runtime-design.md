---
parent: high-level-design
prefix: SHARED
---

# shared-runtime

Status: implemented; every EARS spec in [shared-runtime-specs.md](shared-runtime-specs.md) is `[x]`. Parent: [high-level-design](../../high-level-design.md) (System Design: Module contract, Shared runtime). Sibling: [module-contract](../module-contract/module-contract-design.md), whose fourth obligation this segment fulfils.

## Context and Design Philosophy

`@cohost/shared` (`packages/shared`) is the one home of runtime behaviour that more than one service needs. Ten services each start, stop, beat, retry, idle when a credential is missing, read `control`, take `inject.request`, handle WAV audio or hold a Discord voice connection, and each of those concerns has been written several times with small differences: five retry loops with five delay rules, three idle-plan reminders, three `control` switch blocks, three injection handlers, three WAV and resampling files, and two Discord session files that share most of their lines. Code shared across modules or services belongs in a shared package rather than being copied (owner decision of 2026-11-08); this segment is that package, specified as behaviour.

Guiding rules:

- **Two users make a module.** A behaviour moves here when a second service needs it. Behaviour that only one service uses stays in that service, however general it looks (Boundary, below).
- **Mechanism here, policy in the service.** A shared module takes every service-specific value as a parameter: which variable is missing, which `control` commands matter, which injection kinds are accepted, the delays of a retry. The service's own LLD and specs say which values it passes; this segment says what the module does with them.
- **Injectable for tests.** Every module takes its clock, sleep, fetch, exit and bus as optional parameters, so a service's tests drive it without timers, network or process exit.
- **No new behaviour by moving.** Moving code here changes nothing a service, the bus or the dashboard can observe, except where a decision below says otherwise and names the change.

## Package shape and dependencies

| Entry point | Holds | Workspace dependencies |
|---|---|---|
| `@cohost/shared` | bootstrap, lifecycle, retry, idle plan, control, injection, audio | `@cohost/config`, `@cohost/bus` |
| `@cohost/shared/discord-voice` | the Discord voice session | the above, plus `discord.js`, `@discordjs/voice` and the native voice dependencies (`libsodium-wrappers`, `@snazzah/davey`, `opusscript`) |

The package depends on the bus and config packages and on no service, no `@cohost/control` and no `@cohost/llm` (SHARED-BOUND-002). The bus package keeps only the transport (publish, subscribe, tail, health stream, `resetGroup`); the process-lifecycle helpers that sat in it because every service already imported it live here. The Discord voice session is a separate subpath so that a service that does not use Discord never loads `discord.js` or a native module; only ears and mouth import it.

## Service bootstrap (`runService`)

Every service's `main` is one call:

```ts
runService({
  service: "mouth",
  health: (cfg) => HeartbeatSpec,          // mode and deps, from config
  main: async (ctx) => { ... },            // the service; resolves once it is running
  // injectable: loadConfig, createBus, onShutdown, exit, log
});
```

Sequence:

1. Create the service logger.
2. Load the configuration. A config that is present but invalid ends the process with status 1 after logging the loader's message; this is the one startup exit the failure posture allows (HLD Key Design Decisions, Failure posture).
3. Create the bus under the service name and start the heartbeat in `starting` with the service's spec.
4. Call `main(ctx)` with `{ cfg, bus, log, heartbeat, onStop }`. `onStop(fn)` registers a teardown step. The service calls `heartbeat.ready()` or an idle plan itself; `runService` never declares readiness.
5. Any throw or rejection out of `main`, and any subscription that rejects after the bus's own retry, is logged with message `fatal` and ends the process with status 1.
6. On SIGINT or SIGTERM the lifecycle sequence runs (below): the heartbeat's `stopping`, the service's teardown steps in reverse registration order, then `bus.stop()`, then exit 0. Teardown steps get 5 s in all; past that the bootstrap stops waiting, stops the bus and exits 0, so a hung step cannot keep a container from stopping. A signal that arrives while `main` is still starting runs the steps registered so far; a step registered after shutdown began never runs.

The entry file (`src/index.ts`) only calls `runService`; `main` lives in a module the tests import, with fakes for every injectable. A service that already has a `boot.ts` with an injected `runX` (voice, avatar) keeps its tests and swaps its hand-written sequence for `runService`.

## Lifecycle: shutdown and heartbeat

`onShutdown(fn)`, `beforeShutdown(fn)` and `startHeartbeat(bus, opts)` move here from the bus package unchanged in behaviour:

- **Shutdown.** On SIGINT or SIGTERM, every `beforeShutdown` hook runs and is awaited, all of them capped together at 2 s, then the service callback, then `process.exit(0)`. A second signal during the sequence does not start it again.
- **Heartbeat publisher.** The payload, cadence, change watcher, dependency-derived `degraded`, standing `detail` precedence, interval from `HEARTBEAT_INTERVAL_MS` and the `stopping` beat registered with `beforeShutdown` are as the control plane's heartbeat contract states them (control-plane, Heartbeat contract). The publisher sends through the bus's `publishHealth`; a rejected publish is logged at warn and swallowed.

The heartbeat also gets `setDetail(detail)`, which replaces the standing detail; the control reader uses it to publish `paused`. A failed publish is logged at most once per 60 s, with the count of failures since the last warning, so a dashboard running while Redis is down does not log every interval.

The heartbeat's meaning (the states, what observers derive from them) stays the control plane's; this module is its one publisher. Moving the helpers out of the bus package removes the import cycle between the bus's entry module and its heartbeat module.

## Retry with backoff (`retryWithBackoff`)

```ts
retryWithBackoff(attempt, {
  baseMs, maxMs, factor = 2, firstDelayMs = 0,
  isStopped, onFailure(err, attemptNo, nextDelayMs), isFatal?(err),
  sleep,
}): Promise<T | undefined>
```

Calls `attempt()` until it resolves, returning its value. After the n-th consecutive failure it calls `onFailure` and sleeps `min(maxMs, baseMs * factor^(n-1))`. With `factor: 1` the delay is fixed. It never rejects for an ordinary failure: when `isStopped()` turns true it resolves `undefined` at its next check, and a sleep is cut short by stop. An error for which `isFatal(err)` is true (a configuration error that retrying cannot fix) rejects at once.

`singleFlight(fn)` wraps any async function so concurrent callers share one running call; the Discord join loop is `singleFlight` over `retryWithBackoff`.

Each user keeps its own delays, stated in its own segment:

| User | Base | Cap | Factor |
|---|---|---|---|
| Discord join (ears, mouth) | 5 s | 60 s | 2 |
| OBS connect (eyes) | 10 s | 60 s | 2 |
| Postgres wait (memory), recall startup (cortex) | 3 s | 3 s | 1 |
| Fallback clip regeneration (voice) | 60 s | 15 min | 2 |
| VTube Studio reconnect (avatar) | 5 s | 5 s | 1 |
| Feed seed (dashboard) | 250 ms | 30 s | 2 |

The bus's own subscription and tail retry is not a user: the shared package depends on the bus, so the bus keeps its private backoff (250 ms doubling to 30 s).

## Missing-credentials idle plan (`startIdle`)

A service whose optional dependency is absent stays up (HLD tenet 5) through one helper:

```ts
startIdle({ heartbeat, log, kind: "off" | "degraded", reason, warnEveryMs = 60_000, now }): { stop(): void }
```

- `off`: the service was configured off. One warning naming the reason, heartbeat `ready` with mode `off`, no reminders.
- `degraded`: something the service needs is missing (a token, a channel). One error naming the missing variable or key, heartbeat `degraded` with `reason` as its detail, and a reminder warning `<reason>; still idle` at most once per `warnEveryMs` (60 s) while idle.
- `stop()` ends the reminders; `runService` registers it as a teardown step.

The idle plan does not decide what else runs: a service that still takes test injection while idle (tenet 5) subscribes its injection handler itself. The reason text is the service's (chat names `TWITCH_CHANNEL`, mouth `DISCORD_TOKEN`, ears `EARS_DISCORD_TOKEN`, eyes `vision.enabled`).

## Control handling (`controlFor`)

Only the regions that decide to speak read `control`: salience and cortex honour `mute` and `pause`, affect honours `pause` for its own appraisal (HLD, Who honours mute and pause). They share one reader:

```ts
const control = controlFor("cortex", {
  pause?, resume?, mute?, unmute?, forget_context?, reload_personality?, say?,
});
control.handle(ev)   // true when ev was a control event for this service
control.paused / control.muted / control.epoch
```

- **Target filter.** An event with no `target` applies to every service; an event whose `target` names another service is ignored and `handle` returns true without calling anything.
- **State.** `paused` and `muted` are kept here and start false on every process start. `epoch` increases on `pause` and `forget_context`, so work queued under an older epoch can be discarded (affect's appraisal queue).
- **Dispatch.** Each command calls the matching callback, if the service gave one, after the state is updated. A callback's throw is logged and does not stop later events.
- **Pause in the heartbeat.** Given the service's heartbeat, the reader publishes the standing detail `paused` while paused, so the dashboard shows the real pause state (module-contract).
- voice, mouth and ears never call `controlFor`: they never read `control`.

## Test injection (`createInjectHandler`)

chat, eyes and ears take `inject.request` through one handler:

```ts
createInjectHandler({
  target: "ears", bus, log, takeUpload,
  kinds: { text?: (req) => Result, image?: (bytes, req) => Result, audio?: (bytes, req) => Result },
  maxBytes: { image, audio }, readTimeoutMs, staleMs = INJECT_STALE_MS, now,
})
```

For each `inject.request`:

1. A request for another `target` is ignored.
2. A request older than `staleMs` (60 s, publisher `ts` against the local clock, judged when the request leaves the queue) gets `inject.result` with `ok: false` and detail `stale`; nothing is read.
3. A `kind` the service does not accept gets `inject.result` with `ok: false` and detail `<target> cannot handle kind '<kind>'`.
4. For `image` and `audio`, the request must carry an `uploadId` (32 hex digits; else `request carries no upload id`). The bytes are taken from Redis with `takeUpload(uploadId)` (`Bus.takeUpload`: `GETDEL` of `cohost:upload:<id>`, so the key is deleted by the read), bounded by `readTimeoutMs` and the kind's byte cap. A missing or expired key gives `upload expired or missing`, a timeout `read upload timed out after <ms> ms`, a body over the cap `upload larger than the <n> byte limit`; each gives `ok: false` with that detail. The kind function receives the bytes and `{ contentType }` from the request.
5. The service's kind function runs and its result is published as `inject.result` with the request's `id`. A throw becomes `ok: false` with the error text.

Each service passes its own limits: eyes `vision.upload_max_bytes` and `vision.upload_timeout_ms`; ears 25 MiB (the dashboard's audio upload cap) and 30 s. chat's injection is text only and keeps its own lines (chat CHAT-INJ-*) until it moves onto the handler.

Requests are handled one at a time in arrival order, off the bus read loop: the subscription handler queues the request and returns, so a slow transcription or vision call never delays reading the next event. The queue holds at most 8 requests; a request that arrives to a full queue gets `ok: false, error: "busy"`.

## Audio (`parseWav`, `wavWrap`, `resample`)

One module handles every WAV and PCM conversion that more than one service needs:

- `parseWav(buf, { requireRiff })` walks the RIFF chunks and returns sample rate, channels, bits per sample, data offset and length, and duration. It rejects a `fmt ` chunk whose format is neither PCM (1) nor extensible with a PCM subformat, a `data` chunk that comes before `fmt `, a missing `fmt `, zero channels or rate, and any bit depth other than 16, each with an error naming the cause.
- `wavWrap(pcm, rate, channels)` writes a canonical 44-byte PCM16 header.
- `resample(pcm, { from: { rate, channels }, to: { rate, channels } })` converts signed 16-bit little-endian PCM. Channels are mixed down by averaging and up by copying. An integer downsampling ratio averages each group of input frames; any other ratio interpolates linearly. Samples are rounded and clamped to 16 bits; trailing bytes that do not make a whole input frame are ignored. The two conversions in use today keep their exact output: Discord's 48 kHz stereo to 16 kHz mono for speech-to-text (ears) and any WAV to 48 kHz stereo for Discord playback (mouth).

What one service alone needs stays with it: voice's lip-sync envelope and mouth's output gain.

## Discord voice session (`@cohost/shared/discord-voice`)

ears and mouth each hold a Discord voice connection through their own bot (HLD, Listening and speaking). Both run the same session:

```ts
createDiscordVoiceSession({
  token, guildId, channelId, intents, selfMute, selfDeaf, log,
  onConnected(connection), onDisconnected(), onJoinFailed(err, attempt),
  join: { baseMs: 5000, maxMs: 60000 },
})  // -> { start(): Promise<void>, isReady(): boolean, stop(): Promise<void> }
```

- `start()` logs in, waits for the client to be ready, then joins with `retryWithBackoff` under `singleFlight`, waiting up to 20 s for each join to reach Ready; each failed join destroys the half-open connection and calls `onJoinFailed` before the next attempt. A failed login rejects `start()`; ears and mouth treat that as fatal (exit 1), as they do today.
- When the connection is ready, `isReady()` turns true and `onConnected` runs; the service attaches its receiver (ears) or player (mouth) there.
- On a disconnect, the session waits up to 5 s for Discord to move the connection back to signalling or connecting; if it does not, `isReady()` turns false, `onDisconnected` runs, the connection is destroyed and the join loop starts again after a 5 s delay.
- `stop()` ends the join loop, destroys the connection and the client, and resolves; a second `stop()` does nothing.

The service decides what a failed join or a disconnect means for its heartbeat (both report `deps.discord` `down`). Service-specific parts stay in the service: ears refuses a token equal to `DISCORD_TOKEN`, ignores bot accounts and asks for the members intent to name speakers; mouth plays utterances and runs the fallback line.

## Hash embedding

The deterministic offline embedder is not a shared-runtime module: `@cohost/llm`'s `HashEmbedder` is the one implementation, and memory's in-memory store embeds with it instead of a hasher of its own (memory MEM-BACKEND-004). It stays in `@cohost/llm` because it implements that package's `Embedder` interface, and moving it here would make this package depend on `@cohost/llm`.

## Boundary: what stays in a service

| Behaviour | Stays in | Why |
|---|---|---|
| Fallback clip cache, mirror and refresh; claim memory; the fallback line | mouth, split into a clip module and a fallback-line module | Only mouth plays fallback clips; the split is for size (one 300-line file holding four classes), not reuse. |
| Speech synthesis queue and sink claims | voice | Only voice synthesizes. Synthesis moves off the bus read loop onto an internal serial queue, so claim events (`voice.playing`, `voice.failed`) are read while a line synthesizes. |
| Lip-sync envelope | voice | One user. |
| Output gain | mouth | One user. |
| Speaker capture and transcription | ears | One user. |

## Spec ownership

Moved behaviour is specified here once; its old lines are retired and their numbers never reused:

| Retired | Now |
|---|---|
| event-bus BUS-STOP-002 to 006 | SHARED-LIFE-001 to 005 |
| control-plane CTRL-HEARTBEAT-001 to 006, 008, 009 | SHARED-LIFE-006 to 013 |
| ears EARS-SESS-005, mouth MOUTH-SESS-005 | SHARED-DVS-003 |
| ears EARS-SESS-006, mouth MOUTH-SESS-006 | SHARED-DVS-004 |
| voice VOICE-ENV-001, ears EARS-AUD-003 | SHARED-AUDIO-001 |
| voice VOICE-ENV-002 | SHARED-AUDIO-002 |
| ears EARS-AUD-004 | SHARED-AUDIO-004 |
| ears EARS-AUD-001 | SHARED-AUDIO-005 |
| mouth MOUTH-AUD-001 | SHARED-AUDIO-006 |
| ears EARS-INJ-001 to 004, eyes EYES-INJ-002 to 006, 012, 013, 015 | SHARED-INJ-001 to 008 |

Each using segment keeps a line that states its own parameters and cites the module: EARS-SESS-010, EARS-AUD-005, EARS-INJ-010, MOUTH-SESS-009, MOUTH-AUD-002, EYES-INJ-016, VOICE-ENV-005. The heartbeat's meaning stays in control-plane (CTRL-HEALTH-*); the bus's own stop stays BUS-STOP-001.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Shared package as a segment | `@cohost/shared` is an arrow segment with its own specs | Keep it a package of helpers specified by each owning segment | The package now holds bootstrap, idle plans, control handling and a Discord session: behaviour with its own states and failure rules. Specifying each in the first segment that used it would leave the shared rule hidden in one service's specs and copied in the others'. |
| One leaf or several | One leaf with within-leaf facets (BOOT, LIFE, RETRY, IDLE, CTRL, INJ, AUDIO, DVS, BOUND) | A sub-HLD with a child leaf per module; one segment per module | The modules share one parent intent (one implementation of each cross-service concern) but no module has enough design of its own to warrant a node; a sub-HLD would be a table of contents. Promote if one module (most likely the Discord session) grows its own design. |
| Lifecycle helpers' home | `@cohost/shared` | Stay in the bus package; a new `@cohost/lifecycle` package | They are process concerns, not transport, and their place in the bus package caused an import cycle. A package of their own would be a fourth package every service imports for three functions. |
| `@cohost/shared` dependencies | Depends on config and bus | No workspace dependencies (helpers only) | Bootstrap and the heartbeat need the bus and the config loader; structural copies of their types would drift. The bus cannot then import shared, so the bus keeps its private read backoff. |
| DiscordVoiceSession in shared | In `@cohost/shared` behind the `discord-voice` subpath export (owner decision) | A dedicated `@cohost/discord-voice` package; keep two copies in ears and mouth | Two services with near-identical session code is the case the owner's sharing rule covers. A subpath keeps `discord.js` and the native modules out of every other service's load path; the image already installs every workspace dependency, so a separate package buys nothing until per-service installs exist (deployment open question). Promote to its own package then. |
| Hash embedder dedupe | memory's in-memory store embeds with `@cohost/llm`'s `HashEmbedder`; no embedder in shared | Keep both; make the fake's non-negative variant the one; move the hasher into shared | Two embedders that disagree make fake-store tests prove nothing about hash mode. Keeping the production algorithm keeps vectors already stored in Postgres comparable (same 64 dimensions, so a change would not trip the dimension check and would silently degrade recall). The embedder implements `@cohost/llm`'s `Embedder` interface, so it stays there; memory already depends on that package. Owner decision. |
| Retry rule | One `retryWithBackoff` with per-user base, cap and factor | One fixed delay rule for all; leave each loop as written | Five loops with five rules had drifted (eyes had no backoff at all). One mechanism with per-user numbers keeps the behaviour each user chose and gives every loop stop handling and failure reporting. |
| Idle reminder | Error once, then a reminder at most every 60 s while idle | One error only; a reminder forever at a fixed interval in each service | A single line scrolls away in a long-running container log, and the owner reads logs after the fact; a capped, uniform reminder keeps the cause visible without flooding. |
| `control` handling | `controlFor` used by salience, cortex and affect only | Every service reads `control`; each region keeps its own switch | One reader keeps target filtering and the start-false state identical across the three regions. The body never reads `control` (HLD decision), so giving it the reader would invite half-applied mutes. |
| Injection off the read loop | A serial queue of at most 8, handled in arrival order | Await the handler in the read loop; unbounded concurrency | Awaiting stalled the next read behind a slow STT call; concurrency would reorder results and let a burst of uploads exhaust memory. 8 matches affect's queue bound. |
| Upload transport | Uploads are read from Redis by id through the service's own bus connection, then deleted | Keep the URL fetch from the dashboard and document the firewall; base64 in the event; a separate HTTP relay | A URL fetch needs the container to reach a host process, which WSL2 NAT with the Hyper-V firewall forbids; Redis is already the shared endpoint. Base64 bloats the stream and every backfill; a relay is one more listener. The fetch's SSRF guard, redirect refusal and `uploadUrl` disappear with the fetch. |
| One resampler | Averaging for integer downsampling ratios, linear interpolation otherwise, exact output of today's two conversions preserved | Linear interpolation everywhere; a resampling library | Averaging is the low-pass ears relies on for 48 kHz to 16 kHz; linear interpolation is what mouth uses for any rate to 48 kHz. Preserving both outputs keeps the move behaviour-free. A library adds a native or WASM dependency for quality speech-to-text does not need. |
| mouth `fallback.ts` split | Stays in mouth, split into a clip module and a fallback-line module | Move clip sync into shared for voice and mouth | Only mouth fetches and caches clips; voice serves them. Shared code with one user is the wrong abstraction. |
| voice TTS and claim loop | Synthesis on an internal serial queue inside voice; one consumer group | Two consumer groups (`voice` for `brain.say`, a second for claims); keep one awaited loop | An awaited synthesis delayed claim reads and produced spurious virtual pairs. An internal queue fixes that without a new consumer group, manifest change or reset rule, and keeps `brain.say` order. A crash loses queued lines, which at-most-once delivery already accepts. |
| Moving spec lines | Retire the moved lines in six segments and specify each behaviour once here; each user keeps a parameter line | Leave the lines where they are and cite the module; duplicate them | One rule in one place is the reason the package exists; a parameter line keeps each service's choices visible in its own specs. Owner decision. |
| Teardown time limit | 5 s for all `onStop` steps together, then exit 0 | No limit; the 2 s `beforeShutdown` cap only | A hung step (a Discord client that never closes) would hold a container past Compose's grace period and end in a SIGKILL that skips the bus stop. 5 s fits inside Compose's default 10 s grace period after the 2 s hooks. |
| Stale injection result | `inject.result` `ok: false`, detail `stale`, judged when the request leaves the queue | Drop silently; judge on arrival | eyes and ears publish this result today, and the dashboard waits for a result; judging at dequeue keeps a request that waited behind a slow one from being processed late. |
| ears injection limits | 25 MiB and 30 s | No limit; new config keys | ears had no cap; the dashboard already refuses audio over 25 MiB, so the cap only guards a request not made by the dashboard. New keys would add settings nobody tunes. |
| Login failure in the session | `start()` rejects; the service exits 1 | Retry the login with backoff; idle degraded | A rejected login is almost always a wrong token, a configuration error that retrying cannot fix; ears and mouth already exit on it (EARS-SESS-001, MOUTH-SESS-001). |
| Heartbeat publish warning | At most once per 60 s, with a failure count | One warning per failed publish | The dashboard starts before Redis exists and would otherwise warn every 5 s until Launch. |
| chat's injection lines | chat keeps CHAT-INJ-002 and 003 until chat moves onto the handler | Retire them now with the eyes and ears lines | The owner's move list names eyes and ears; chat's lines still describe chat's current code, and its adoption (chunk C9) retires them in the same cascade that changes the code. |
| Per-service installs | The Discord session stays a `discord-voice` subpath of `@cohost/shared` | A package of its own | One image installs every service's dependencies today; split it when the image installs only one service's dependencies. |
| Retry jitter | None | Randomised delay | One instance per service, so no thundering herd; add it if several instances ever reconnect to one backend at once. |
| Injection queue bound | 8 | A parameter | A starting value no service has needed to change; make it a parameter when one does. |

## Open Questions & Future Decisions

None.

## References

- HLD: System Design (Module contract, Shared runtime); Key Design Decisions (Failure posture, Listening and speaking, Who honours mute and pause).
- [module-contract](../module-contract/module-contract-design.md) (obligation 4).
- [control-plane](../control-plane/control-plane-design.md) Heartbeat contract; [event-bus](../event-bus/event-bus-design.md) Shutdown helpers.
- [ears](../ears/ears-design.md), [mouth](../mouth/mouth-design.md), [eyes](../eyes/eyes-design.md), [chat](../chat/chat-design.md), [voice](../voice/voice-design.md), [memory](../memory/memory-design.md), [model-backends](../model-backends/model-backends-design.md).
- Code today: `packages/shared/src/{inject,join,wav}.ts`; `packages/bus/src/{index,heartbeat}.ts`; `services/{ears,mouth}/src/{discord,session,audio}.ts`; `services/voice/src/wav.ts`; `services/memory/src/fake-store.ts`; `packages/llm/src/mock.ts`.
