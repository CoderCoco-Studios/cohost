---
parent: high-level-design
prefix: CHAT
---

# chat

Segment `chat` (`services/chat`, package `@cohost/chat`). Mapped 2026-10-31 at git `686cc8f`. Describes what the code does today.

## Context and Design Philosophy

`chat` is the text sense. It turns Twitch IRC lines into `chat.message` events on the bus (see [HLD](../../high-level-design.md)). It is one of three senses (`chat`, `eyes`, `ears`) that publish and never consume brain events; it consumes only `inject.request` (test injection). Downstream consumers of `chat.message`: `salience`, `affect`, `memory` (each via `bus.subscribe`, `services/salience/src/index.ts:31`, `services/affect/src/index.ts:26`, `services/memory/src/index.ts:58`) and the `dashboard` feed.

Observed design stance (all `[inferred]` from code and comments):

- Read-only by default. `index.ts:3-6` says anonymous IRC works with only `TWITCH_CHANNEL`; credentials are optional and framed as "needed later" to let the co-host type. Nothing in the service ever sends a chat line.
- Pure translation is separated from I/O. `filter.ts` has no side effects and is unit-tested; `index.ts` is untested glue.
- A configuration gap is not a crash. With no channel the service idles and reports `degraded` rather than `process.exit(1)` (`index.ts:46-52`), so a supervisor sees a health state instead of a restart loop.
- The service must run on Redis alone. `chat.source: fake` replaces Twitch with stdin or a scripted loop, and `@twurple/*` is loaded with dynamic `import()` only on the Twitch path (`index.ts:58`, `index.ts:76`).

## Source Selection (plan)

`chatPlan(cfg.chat)` (`filter.ts:22-25`) maps config to one of three plans, chosen once at boot (`index.ts:22`):

| `chat.source` | `chat.twitch.channel` | Plan | Behaviour | Heartbeat |
|---|---|---|---|---|
| `fake` | any | `fake` | `startFakeSource`, no network | mode `mock`, `twitch: n/a`, `ready()` immediately (`index.ts:44`) |
| `twitch` | non-empty | `twitch` | `startTwitch(channel)` | mode `live`, `twitch: ok` while connected else `down`; `ready()` on first connect (`index.ts:82`) |
| `twitch` | empty | `idle` | logs an error at start and every 60 s, publishes nothing (`index.ts:48-52`) | mode `live`, `twitch: down`, `degraded("TWITCH_CHANNEL is not set")` |

`channelName` strips one leading `#` and lowercases (`filter.ts:14-16`). `chat.source` blank resolves to `twitch` via `z.preprocess` (`packages/config/src/schema.ts:84`); `chat.fake.interval_ms` defaults 8000 (`schema.ts:85`). Env presets: `CHAT_SOURCE` (`config/config.example.yaml:49`), `TWITCH_CHANNEL` (`:53`). The control plane's isolated start sets `CHAT_SOURCE=fake` (`packages/control/src/manifest.ts:39`, owned by `control-plane`).

In all three plans the `inject.request` subscription is wired before the plan branches (`index.ts:28-31`), so test injection works with no channel and no connection.

## Twitch Path

`startTwitch` (`index.ts:75-97`):

1. Dynamic `import("@twurple/chat")`, then `buildAuth()`.
2. `buildAuth()` (`index.ts:57-73`) returns `undefined` (anonymous) unless `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_ACCESS_TOKEN` are all set. Otherwise it builds a `RefreshingAuthProvider`, logs `twitch token refreshed` with `expiresIn` on refresh, and registers the token via `addUserForToken` with `expiresIn: 0`, `obtainmentTimestamp: 0` and scope `["chat"]`. `TWITCH_REFRESH_TOKEN` is optional (`?? null`). The `addUserForToken` promise is fire-and-forget (`void`, `index.ts:63`) and the `ChatClient` is constructed immediately after. Refreshed tokens are logged but never persisted anywhere.
3. `new ChatClient({ authProvider, channels: [channel], logger: { minLevel: "warning" } })`.
4. `onConnect`: `connected = true`, `heartbeat.ready()`, info log with `channel` and `authenticated`. `onDisconnect`: `connected = false`, warn log with `manually` and `reason`; no explicit reconnect code (reconnect behaviour is whatever `@twurple/chat` does by default; `node_modules` was not installed at mapping so this was not verified).
5. `onMessage` runs `toEvent(user, text, msg.userInfo)` and, if it returns an event, `await bus.publish("chat.message", ev)` (`index.ts:90-93`) with no try/catch.
6. `client.connect()` is not awaited; `onShutdown` calls `client.quit()` and `bus.stop()`.

The `connected` flag feeds the heartbeat `twitch` dependency; when the flag goes false after `ready`, the shared heartbeat derives `degraded` automatically (`packages/bus/src/heartbeat.ts:68-70`).

## Filter and Payload (`filter.ts`)

`createChatFilter(cfg)` returns `(user, text, info) => EventInput<"chat.message"> | undefined` (`filter.ts:28-46`). Order of checks:

1. `user` (lowercased) in `chat.ignore_users` (lowercased set) drops the message.
2. Raw `text` (not yet trimmed or collapsed) starting with any `chat.ignore_prefixes` entry drops it. Default prefixes `["!"]` (`schema.ts:88`); the example config ships `ignore_users: ["nightbot","streamelements","moobot"]`.
3. `text` with `\s+` collapsed to a single space and trimmed; empty result drops it.

Payload: `platform: "twitch"` (hard-coded, also for `fake`), `user: info.displayName || user`, `userId: info.userId`, cleaned `text`, `isMod: info.isMod || info.isBroadcaster`, `isSub: info.isSubscriber`, `mentionsCohost: clean.toLowerCase().includes(cfg.cohost.name.toLowerCase())`. The mention test is a plain substring match: a test records `@coco_fan hi` matching cohost name `Coco` and comments "substring match, by design" (`test/filter.test.ts:32`). `cohost.name` is `z.string().min(1)` so the empty-name always-true case cannot occur through config.

`ChatUserInfo` (`filter.ts:5-11`) is a structural subset of twurple's `ChatUser`, so the filter and tests need no twurple import.

## Fake Source (`fake.ts`)

`startFakeSource({ toEvent, publish, cohostName, intervalMs, stdin, onError })` returns a stop function (`fake.ts:38-61`).

- Every emitted line goes through `toEvent` (the real filter), so `ignore_users`, `ignore_prefixes` and whitespace rules apply. Users are synthetic (`fake_viewer1..3`); `userId` equals the username and all flag fields are false (`fake.ts:31`).
- If `stdin` is supplied, a `readline` interface turns each line into a message from `fake_viewer1` and sets `stdinSeen`.
- If `stdin.isTTY`, the script is not started at all (interactive mode) (`fake.ts:51`).
- Otherwise a `setInterval` cycles a 6-line script (`fakeScript`, `fake.ts:9-18`: two mentions, a question, a `!uptime` line the filter drops, two plain lines) every `intervalMs`; once any stdin line has been seen the timer keeps ticking but emits nothing (`fake.ts:56`).
- Publish failures are caught and passed to `onError` (the entry point logs a warning) (`fake.ts:42`, `index.ts:42`).
- `index.ts` always passes `process.stdin`, so in a container with no TTY and a closed or empty stdin the script runs.

## Test Injection (`inject.ts`)

`createInjectHandler({ bus, log, cohostName, now? })` handles `inject.request` (group `chat`, `fromNow: true`, `index.ts:28-31`). Steps (`inject.ts:19-48`):

1. `target !== "chat"` returns silently.
2. Any other path answers with `inject.result {id, ok, detail?}`.
3. Stale if `now() - ev.ts > INJECT_STALE_MS` (60 000) gives `ok:false, detail:"stale"`.
4. `kind !== "text"` gives `ok:false` with `chat cannot handle kind '<kind>'`.
5. Text is collapsed and trimmed; blank gives `ok:false, detail:"blank text"`.
6. Publishes `chat.message` with `platform: meta.platform ?? "twitch"`, `user: meta.user || "injected_viewer"`, `isMod`/`isSub` from `meta` (default false), `mentionsCohost` from the lowercased `cohostName` substring, `injected: true`, `remember: r.remember`; no `userId`. `ignore_users`/`ignore_prefixes` are deliberately not applied.
7. Then `inject.result {ok:true}`. Any thrown error becomes `ok:false` with `String(err)`; if even the failure result cannot be published the error is swallowed.

The `inject.*` schemas belong to `event-bus`; the HTTP side and bus-level (skip-the-service) injection belong to `dashboard`.

## Health (`health.ts`)

`chatHealth(channel, twitchConnected, source)` returns the `HeartbeatSpec` consumed by `startHeartbeat` (`index.ts:24`); the heartbeat contract is owned by `control-plane`.

- `source === "fake"`: `{service:"chat", mode:"mock", deps: {twitch:"n/a"}}`.
- else: `mode:"live"`, `deps.twitch = channel && twitchConnected() ? "ok" : "down"`.
- Before the first connect the state stays `starting`, not `degraded` (the shared heartbeat only derives `degraded` from `down` deps once the base state is `ready`, `heartbeat.ts:69`).
- `mode` is a static string, not a getter; it cannot change at runtime.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Anonymous vs authenticated IRC | Anonymous unless all of client id, secret and access token are set (`index.ts:60`) | Always require credentials; Twitch EventSub | `[inferred]` Lowest setup cost for a read-only sense; header comment (`index.ts:3-6`) calls auth future-proofing for typing in chat. |
| Token registration | `addUserForToken` with `expiresIn: 0`, `obtainmentTimestamp: 0` (`index.ts:63-71`) | Pass real expiry; persist refreshed tokens | `[inferred]` Zero expiry forces the provider to refresh immediately because env tokens carry no expiry metadata. No evidence of intent beyond the values. |
| Missing channel | Idle plus `degraded` heartbeat, error log every 60 s (`index.ts:46-52`) | `process.exit(1)` (old behaviour in baseline OpenSpec) | `[inferred]` Avoid restart loops under a supervisor; comment at `index.ts:47` says so. |
| Lazy `@twurple` import | Dynamic `import()` inside `startTwitch`/`buildAuth` (`index.ts:58`, `:76`) | Static import | `[inferred]` The fake/idle plans must not load the IRC library; comment at `index.ts:34`. |
| Mention detection | Substring on lowercased cleaned text (`filter.ts:43`) | Word-boundary or `@name` match | `[inferred]` Test comment "substring match, by design" (`test/filter.test.ts:32`); simplest rule, accepts false positives. |
| Fake source reuses real filter | `toEvent` injected into `startFakeSource` (`fake.ts:6`, `:41`) | Publish scripted events directly | `[inferred]` So fake runs exercise ignore rules and cleaning exactly like Twitch; header comment `fake.ts:35`. |
| Injection bypasses ignore rules | `inject.ts` does not call the filter (`inject.ts:15-17`) | Reuse `createChatFilter` | `[inferred]` Comment: "a dropped test is useless". |
| Platform | Hard-coded `"twitch"` in filter (`filter.ts:37`) | Carry platform from the source | `[inferred]` Only one live source exists; the schema allows `youtube`/`discord` (`packages/bus/src/events.ts:11`) but only injection can set them. |
| Health mode for idle channel | `live` with `twitch: down` (`health.ts:9-13`; asserted at `test/health.test.ts:20-25`) | `off` with `twitch: n/a` (as written in the add-service-health delta) | `[inferred]` Test is titled "stays live-mode", so the choice looks deliberate; the delta spec text was not updated. |

## Open Questions & Future Decisions

### Deferred / unexplained

1. `addUserForToken` is not awaited (`index.ts:63`). `ChatClient` is built right after and may ask the auth provider for a token before the user is registered; a rejection is unhandled. Race and unhandled rejection both unconfirmed (twurple internals not read).
2. `onMessage` has no try/catch around `bus.publish` (`index.ts:90-93`). A Redis failure rejects inside the twurple listener; effect depends on twurple.
3. `void bus.subscribe(...)` for `inject.request` (`index.ts:28`) has no `.catch`; a Redis error at group creation is an unhandled rejection.
4. Reconnect after disconnect is not coded here (`index.ts:85-88` only flips a flag and logs). Relies on twurple defaults, unverified.
5. Refreshed tokens are never persisted (`index.ts:62` logs only). After a refresh the env token can be stale on restart.
6. `ignore_prefixes` is checked on the untrimmed text (`filter.ts:33`): `" !cmd"` is not treated as a command. No test covers this.
7. Mention matching is substring-only, so `@coco_fan` and `cocoa` both count as mentioning `Coco` (`test/filter.test.ts:32`).
8. The header says credentials are for typing in chat later (`index.ts:5-6`), but no code ever sends messages; scope is only `["chat"]` (read) (`index.ts:70`).
9. Injected `chat.message` carries no `userId` (`inject.ts:31-40`) while real ones do (`filter.ts:39`).
10. Staleness compares publisher `ev.ts` with the local clock (`inject.ts:27`), so clock skew between hosts can mis-drop requests.
11. `index.ts` (plan dispatch, auth, ChatClient wiring, idle timer) has no test; only `filter`, `fake`, `health`, `inject` are covered.
12. Idle plan logs an error every 60 s forever (`index.ts:51`); log noise rather than a state change.
13. Baseline OpenSpec "No channel" scenario (exit code 1) is superseded by the isolated-backends delta; the baseline file still says exit 1 (`openspec/specs/chat/spec.md`).
14. add-service-health "Unconfigured channel" scenario (`mode: off`, `twitch: n/a`) disagrees with the code (`mode: live`, `twitch: down`). See CHAT-HEALTH-006.

## References

### Files in this segment
- `services/chat/src/index.ts`, `filter.ts`, `fake.ts`, `health.ts`, `inject.ts`
- `services/chat/test/filter.test.ts`, `fake.test.ts`, `health.test.ts`, `inject.test.ts`
- `services/chat/package.json`, `services/chat/tsconfig.json`

### Other segments
- `event-bus` (depends on): `Bus`, `chat.message`, `inject.request`/`inject.result` schemas.
- `config` (depends on): `loadConfig`, `chat.*` and `cohost.name` keys, `createLogger`.
- `control-plane` (depends on): `startHeartbeat`, `HeartbeatSpec`, `cohost:health`.
- `dashboard` (called by): publishes `inject.request`, shows `inject.result`, renders `chat.message`.
- `salience`, `affect`, `memory` (consumed by): subscribe to `chat.message`.
- `deployment`: compose service `chat` (`docker-compose.yml:99-101`).

### External
- `@twurple/chat` and `@twurple/auth` (`^8.2.0`), Twitch IRC.

### OpenSpec
- `openspec/specs/chat/spec.md`
- `openspec/changes/add-service-health/specs/chat/spec.md`
- `openspec/changes/add-isolated-backends/specs/chat/spec.md`
- `openspec/changes/add-test-injection/specs/chat/spec.md`

### Docs
- [HLD](../../high-level-design.md), [specs](chat-specs.md), [arrow](../../arrows/chat.md)
