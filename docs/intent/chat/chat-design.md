---
parent: high-level-design
prefix: CHAT
---

# chat

Segment `chat` (`services/chat`, package `@cohost/chat`). Mapped 2026-10-31 at git `686cc8f`. Describes what the code does today.

## Context and Design Philosophy

`chat` is the text sense. It turns Twitch IRC lines into `chat.message` events on the bus (see [HLD](../../high-level-design.md)). It is one of three senses (`chat`, `eyes`, `ears`) that publish and never consume brain events; it consumes only `inject.request` (test injection). Downstream consumers of `chat.message`: `salience`, `affect`, `memory` (each via `bus.subscribe`, `services/salience/src/index.ts:31`, `services/affect/src/index.ts:26`, `services/memory/src/index.ts:58`) and the `dashboard` feed.

Design stance (evidence per bullet; `[inferred]` where only the code shows it):

- Read-only by default. The header comment (`index.ts:3-6`) says anonymous IRC works with only `TWITCH_CHANNEL`; credentials are optional and framed as "needed later" to let the co-host type. Nothing in the service ever sends a chat line.
- Pure translation is separated from I/O. `filter.ts` has no side effects and is unit-tested; `index.ts` is untested glue. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": chat gained `createChatFilter` / `channelName` so the logic could be tested without Twitch).
- A configuration gap is not a crash. With no channel the service idles and reports `degraded` rather than `process.exit(1)` (`index.ts:51-59`), so a supervisor sees a health state instead of a restart loop. Evidence: comment at `index.ts:53`; commit 51d5a9c; add-isolated-backends design D6 ("the supervisor must not see a crash loop for a configuration gap").
- The service must run on Redis alone. `chat.source: fake` replaces Twitch with stdin or a scripted loop, and `@twurple/*` is loaded with dynamic `import()` only on the Twitch path (`index.ts:66`, `index.ts:85`). Evidence: commit 51d5a9c ("mock/off backends so any service runs on Redis alone"); add-isolated-backends design D6 ("Does not touch `@twurple`").

## Source Selection (plan)

`chatPlan(cfg.chat)` (`filter.ts:24-27`) maps config to one of three plans, chosen once at boot (`index.ts:22`):

| `chat.source` | `chat.twitch.channel` | Plan | Behaviour | Heartbeat |
|---|---|---|---|---|
| `fake` | any | `fake` | `startFakeSource`, no network | mode `mock`, `twitch: n/a`, `ready()` immediately (`index.ts:48`) |
| `twitch` | non-empty | `twitch` | `startTwitch(channel)` | mode `live`, `twitch: ok` while connected else `down`; `ready()` on first connect (`index.ts:92`) |
| `twitch` | empty | `idle` | logs an error at start and every 60 s, publishes nothing (`index.ts:54-59`) | mode `live`, `twitch: down`, `degraded("TWITCH_CHANNEL is not set")` |

`channelName` strips one leading `#` and lowercases (`filter.ts:15-17`). `chat.source` blank resolves to `twitch` via `z.preprocess` (`packages/config/src/schema.ts:84`); `chat.fake.interval_ms` defaults 8000 (`schema.ts:85`). Env presets: `CHAT_SOURCE` (`config/config.example.yaml:49`), `TWITCH_CHANNEL` (`:53`). The control plane's isolated start sets `CHAT_SOURCE=fake` (`packages/control/src/manifest.ts:39`, owned by `control-plane`).

In all three plans the `inject.request` subscription is wired before the plan branches (`index.ts:30-33`), so test injection works with no channel and no connection.

## Twitch Path

`startTwitch` (`index.ts:84-110`):

1. Dynamic `import("@twurple/chat")`, then `buildAuth()`.
2. `buildAuth()` (`index.ts:65-81`) returns `undefined` (anonymous) unless `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_ACCESS_TOKEN` are all set. Otherwise it builds a `RefreshingAuthProvider`, logs `twitch token refreshed` with `expiresIn` on refresh, and registers the token via `addUserForToken` with `expiresIn: 0`, `obtainmentTimestamp: 0` and scope `["chat"]`. `TWITCH_REFRESH_TOKEN` is optional (`?? null`). The `addUserForToken` promise is fire-and-forget (`void`, `index.ts:71`) and the `ChatClient` is constructed immediately after. Refreshed tokens are logged but never persisted anywhere.
3. `new ChatClient({ authProvider, channels: [channel], logger: { minLevel: "warning" } })`.
4. `onConnect`: `connected = true`, `heartbeat.ready()`, info log with `channel` and `authenticated`. `onDisconnect`: `connected = false`, warn log with `manually` and `reason`; no explicit reconnect code. Reconnect is the library default: `@twurple/chat` 8.2.0 drives an `ircv3` 0.33.1 client whose `connection.reconnect` option defaults to `true` (`ircv3/lib/IrcClient.js:88`, `:591`), and `ChatClient` is constructed without overriding it, so an unexpected drop is retried and `onConnect` fires again (re-signalling `ready`).
5. `onMessage` runs `toEvent(user, text, msg.userInfo)` and, if it returns an event, `await bus.publish("chat.message", ev)` (`index.ts:102-105`) with no try/catch.
6. `client.connect()` is not awaited; `onShutdown` calls `client.quit()` and `bus.stop()`.

The `connected` flag feeds the heartbeat `twitch` dependency; when the flag goes false after `ready`, the shared heartbeat derives `degraded` automatically (`packages/bus/src/heartbeat.ts:68-70`).

## Filter and Payload (`filter.ts`)

`createChatFilter(cfg)` returns `(user, text, info) => EventInput<"chat.message"> | undefined` (`filter.ts:31-49`). Order of checks:

1. `user` (lowercased) in `chat.ignore_users` (lowercased set) drops the message.
2. Raw `text` (not yet trimmed or collapsed) starting with any `chat.ignore_prefixes` entry drops it. Default prefixes `["!"]` (`schema.ts:88`); the example config ships `ignore_users: ["nightbot","streamelements","moobot"]`.
3. `text` with `\s+` collapsed to a single space and trimmed; empty result drops it.

Payload: `platform: "twitch"` (hard-coded, also for `fake`), `user: info.displayName || user`, `userId: info.userId`, cleaned `text`, `isMod: info.isMod || info.isBroadcaster`, `isSub: info.isSubscriber`, `mentionsCohost: clean.toLowerCase().includes(cfg.cohost.name.toLowerCase())`. The mention test is a plain substring match: a test records `@coco_fan hi` matching cohost name `Coco` and comments "substring match, by design" (`test/filter.test.ts:36`). `cohost.name` is `z.string().min(1)` so the empty-name always-true case cannot occur through config.

`ChatUserInfo` (`filter.ts:5-11`) is a structural subset of twurple's `ChatUser`, so the filter and tests need no twurple import.

## Fake Source (`fake.ts`)

`startFakeSource({ toEvent, publish, cohostName, intervalMs, stdin, onError })` returns a stop function (`fake.ts:39-62`).

- Every emitted line goes through `toEvent` (the real filter), so `ignore_users`, `ignore_prefixes` and whitespace rules apply. Users are synthetic (`fake_viewer1..3`); `userId` equals the username and all flag fields are false (`fake.ts:31`).
- If `stdin` is supplied, a `readline` interface turns each line into a message from `fake_viewer1` and sets `stdinSeen`.
- If `stdin.isTTY`, the script is not started at all (interactive mode) (`fake.ts:52`).
- Otherwise a `setInterval` cycles a 6-line script (`fakeScript`, `fake.ts:9-18`: two mentions, a question, a `!uptime` line the filter drops, two plain lines) every `intervalMs`; once any stdin line has been seen the timer keeps ticking but emits nothing (`fake.ts:57`).
- Publish failures are caught and passed to `onError` (the entry point logs a warning) (`fake.ts:43`, `index.ts:46`).
- `index.ts` always passes `process.stdin`, so in a container with no TTY and a closed or empty stdin the script runs.

## Test Injection (`inject.ts`)

`createInjectHandler({ bus, log, cohostName, now? })` handles `inject.request` (group `chat`, `fromNow: true`, `index.ts:30-33`). Steps (`inject.ts:20-49`):

1. `target !== "chat"` returns silently.
2. Any other path answers with `inject.result {id, ok, detail?}`.
3. Stale if `now() - ev.ts > INJECT_STALE_MS` (60 000) gives `ok:false, detail:"stale"`.
4. `kind !== "text"` gives `ok:false` with `chat cannot handle kind '<kind>'`.
5. Text is collapsed and trimmed; blank gives `ok:false, detail:"blank text"`.
6. Publishes `chat.message` with `platform: meta.platform ?? "twitch"`, `user: meta.user || "injected_viewer"`, `isMod`/`isSub` from `meta` (default false), `mentionsCohost` from the lowercased `cohostName` substring, `injected: true`, `remember: r.remember`; no `userId`. `ignore_users`/`ignore_prefixes` are deliberately not applied.
7. Then `inject.result {ok:true}`. Any thrown error becomes `ok:false` with `String(err)`; if even the failure result cannot be published the error is swallowed.

The `inject.*` schemas belong to `event-bus`; the HTTP side and bus-level (skip-the-service) injection belong to `dashboard`.

## Health (`health.ts`)

`chatHealth(channel, twitchConnected, source)` returns the `HeartbeatSpec` consumed by `startHeartbeat` (`index.ts:25`); the heartbeat contract is owned by `control-plane`.

- `source === "fake"`: `{service:"chat", mode:"mock", deps: {twitch:"n/a"}}`.
- else: `mode:"live"`, `deps.twitch = channel && twitchConnected() ? "ok" : "down"`.
- Before the first connect the state stays `starting`, not `degraded` (the shared heartbeat only derives `degraded` from `down` deps once the base state is `ready`, `heartbeat.ts:69`).
- `mode` is a static string, not a getter; it cannot change at runtime.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Anonymous vs authenticated IRC | Anonymous unless all of client id, secret and access token are set (`index.ts:68`) | Always require credentials; Twitch EventSub | Header comment (`index.ts:3-6`): works read-only with just `TWITCH_CHANNEL`; credentials are for typing in chat later. EventSub was not considered in any recorded source (`[inferred]` alternative). |
| Token registration | `addUserForToken` with `expiresIn: 0`, `obtainmentTimestamp: 0` (`index.ts:71-79`) | Pass real expiry; persist refreshed tokens | `[inferred]` Zero expiry forces the provider to refresh immediately because env tokens carry no expiry metadata. No evidence of intent beyond the values. |
| Missing channel | Idle plus `degraded` heartbeat, error log every 60 s (`index.ts:51-59`) | `process.exit(1)` (old behaviour in baseline OpenSpec) | Avoid restart loops under a supervisor: comment at `index.ts:53`; commit 51d5a9c; add-isolated-backends design D6. |
| Lazy `@twurple` import | Dynamic `import()` inside `startTwitch`/`buildAuth` (`index.ts:66`, `:85`) | Static import | The fake and idle plans must not load the IRC library: comment at `index.ts:37`; add-isolated-backends design D6 ("Does not touch `@twurple`"). |
| Mention detection | Substring on lowercased cleaned text (`filter.ts:46`) | Word-boundary or `@name` match | Deliberate per the test comment "substring match, by design" (`test/filter.test.ts:36`). Why substring was preferred over word matching is not recorded (`[inferred]`: simplest rule, accepts false positives). |
| Fake source reuses real filter | `toEvent` injected into `startFakeSource` (`fake.ts:6`, `:42`) | Publish scripted events directly | So fake runs exercise ignore rules and cleaning exactly like Twitch: header comment `fake.ts:36`; add-isolated-backends design D6 ("passing each through the normal `createChatFilter` so ignore rules apply"). |
| Injection bypasses ignore rules | `inject.ts` does not call the filter (`inject.ts:16-18`) | Reuse `createChatFilter` | "A dropped test is useless": comment at `inject.ts:16-18`; add-test-injection design D8, listed under its owner-confirmed decisions. |
| Platform | Hard-coded `"twitch"` in filter (`filter.ts:40`) | Carry platform from the source | `[inferred]` Only one live source exists; the schema allows `youtube`/`discord` (`packages/bus/src/events.ts:11`) but only injection can set them. |
| Health mode for idle channel | `live` with `twitch: down` (`health.ts:10-14`; asserted at `test/health.test.ts:23-28`) | `off` with `twitch: n/a` (the add-service-health delta) | add-isolated-backends design D6 specifies idle `degraded` with `deps: {twitch: "down"}`, and its D2 says services with a real source report `live`; the test is titled "stays live-mode" (`test/health.test.ts:23`). |

## Open Questions & Future Decisions

### Deferred / unexplained

1. `addUserForToken` is not awaited (`index.ts:71`). `ChatClient` is built right after and may ask the auth provider for a token before the user is registered; a rejection is unhandled. Race and unhandled rejection both unconfirmed (twurple internals not read).
2. `onMessage` has no try/catch around `bus.publish` (`index.ts:102-105`). A Redis failure rejects inside the twurple listener; effect depends on twurple.
3. `void bus.subscribe(...)` for `inject.request` (`index.ts:30`) has no `.catch`; a Redis error at group creation is an unhandled rejection.
4. Reconnect after disconnect is not coded here (`index.ts:96-99` only flips a flag and logs); it relies on the `ircv3` default `reconnect: true` (see Twitch Path). No spec line covers reconnect and no test exercises it.
5. Refreshed tokens are never persisted (`index.ts:70` logs only). After a refresh the env token can be stale on restart.
6. `ignore_prefixes` is checked on the untrimmed text (`filter.ts:36`): `" !cmd"` is not treated as a command. No test covers this.
7. Mention matching is substring-only, so `@coco_fan` and `cocoa` both count as mentioning `Coco` (`test/filter.test.ts:36`).
8. The header says credentials are for typing in chat later (`index.ts:5-6`), but no code ever sends messages; scope is only `["chat"]` (read) (`index.ts:78`).
9. Injected `chat.message` carries no `userId` (`inject.ts:32-41`) while real ones do (`filter.ts:42`).
10. Staleness compares publisher `ev.ts` with the local clock (`inject.ts:28`), so clock skew between hosts can mis-drop requests.
11. `index.ts` (plan dispatch, auth, ChatClient wiring, idle timer) has no test; only `filter`, `fake`, `health`, `inject` are covered.
12. Idle plan logs an error every 60 s forever (`index.ts:57`); log noise rather than a state change.
13. The frozen OpenSpec baseline "No channel" scenario says exit code 1 (`openspec/specs/chat/spec.md`); CHAT-PLAN-003 (idle, never exit) governs.
14. CHAT-HEALTH-006 states the shipped behavior for a missing channel (`mode: live`, `deps.twitch: down`). The add-service-health "Unconfigured channel" scenario (`mode: off`, `deps.twitch: n/a`) may have been the intended one; add-isolated-backends design D6 chose `down`. Owner to confirm.
15. CHAT-TW-008 (Twitch message to `chat.message`) has no test: the `onMessage` wiring lives in untested `index.ts` (`index.ts:102-105`).
16. CHAT-TW-006 and CHAT-TW-007 state `[inferred]` intent (await token registration; survive a publish failure) that no code, test, comment or commit records. Owner to confirm before they are implemented.

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
- `openspec/changes/archive/2026-11-01-add-isolated-backends/design.md` ("add-isolated-backends design", D2 and D6 cited above)
- `openspec/changes/archive/2026-11-01-add-test-injection/design.md` ("add-test-injection design", D8 and owner-confirmed decisions cited above)
- `openspec/changes/archive/2026-11-01-add-service-health/specs/chat/spec.md`
- `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/chat/spec.md`
- `openspec/changes/archive/2026-11-01-add-test-injection/specs/chat/spec.md`

### Docs
- [HLD](../../high-level-design.md), [specs](chat-specs.md), [arrow](../../arrows/chat.md)
