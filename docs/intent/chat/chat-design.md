---
parent: high-level-design
prefix: CHAT
---

# chat

Segment `chat` (`services/chat`, package `@cohost/chat`). Mapped 2026-10-31 at git `686cc8f`; audited 2026-11-02 at `1b57790` with the owner's decisions of 2026-11-01 applied. Describes the implemented behaviour.

## Context and Design Philosophy

`chat` is the text sense. It turns Twitch IRC lines into `chat.message` events on the bus (see [HLD](../../high-level-design.md)). It is one of three senses (`chat`, `eyes`, `ears`) that publish and never consume brain events; it consumes only `inject.request` (test injection). Downstream consumers of `chat.message`: `salience`, `affect`, `memory` (each via `bus.subscribe`, `services/salience/src/index.ts:31`, `services/affect/src/index.ts:26`, `services/memory/src/index.ts:63`) and the `dashboard` feed.

Multi-platform chat is a project goal; Twitch is the only implemented platform. `chat.message.platform` already admits `youtube` and `discord` (`packages/bus/src/events.ts:14`), so another platform arrives as a new chat source that sets its own `platform` value, with no change to the brain.

Design stance (evidence per bullet):

- Read-only by default. The header comment (`index.ts:3-6`) says anonymous IRC works with only `TWITCH_CHANNEL`; credentials are optional. Typing in chat is a deferred project goal: the authenticated path stays so that a later body output beside `voice` can send lines, but nothing in the service sends a chat line today.
- Pure translation is separated from I/O. `filter.ts` has no side effects and is unit-tested; `index.ts` is untested glue. Evidence: commit 95afa19 ("Split service entrypoints into testable region modules": chat gained `createChatFilter` / `channelName` so the logic could be tested without Twitch).
- A configuration gap is not a crash. With no channel the service idles and reports `degraded` rather than `process.exit(1)` (`index.ts:53-60`), so a supervisor sees a health state instead of a restart loop. Evidence: comment at `index.ts:53`; commit 51d5a9c; add-isolated-backends design D6 ("the supervisor must not see a crash loop for a configuration gap").
- The service must run on Redis alone. `chat.source: fake` replaces Twitch with stdin or a scripted loop, and `@twurple/*` is loaded with dynamic `import()` only on the Twitch path (`index.ts:66`, `index.ts:85`). Evidence: commit 51d5a9c ("mock/off backends so any service runs on Redis alone"); add-isolated-backends design D6 ("Does not touch `@twurple`").

## Source Selection (plan)

`chatPlan(cfg.chat)` (`filter.ts:24-27`) maps config to one of three plans, chosen once at boot (`index.ts:22`):

| `chat.source` | `chat.twitch.channel` | Plan | Behaviour | Heartbeat |
|---|---|---|---|---|
| `fake` | any | `fake` | `startFakeSource`, no network | mode `mock`, `twitch: n/a`, `ready()` immediately (`index.ts:49`) |
| `twitch` | non-empty | `twitch` | `startTwitch(channel)` | mode `live`, `twitch: ok` while connected else `down`; `ready()` on first connect (`index.ts:86`) |
| `twitch` | empty | `idle` | logs an error at start and every 60 s, publishes nothing (`index.ts:55-60`) | mode `live`, `twitch: down`, `degraded("TWITCH_CHANNEL is not set")` |

`channelName` strips one leading `#` and lowercases (`filter.ts:15-17`). `chat.source` blank resolves to `twitch` via `z.preprocess` (`packages/config/src/schema.ts:88`); `chat.fake.interval_ms` defaults 8000 (`schema.ts:89`). Env presets: `CHAT_SOURCE` (`config/config.example.yaml:49`), `TWITCH_CHANNEL` (`:53`). The control plane's isolated start sets `CHAT_SOURCE=fake` (`packages/control/src/manifest.ts:39`, owned by `control-plane`).

In all three plans the `inject.request` subscription is established before the plan branches (`index.ts:34`), so test injection works with no channel and no connection. `subscribeInject` (`subscribe.ts`) first creates the `chat` consumer group (`Bus.resetGroup`) and then starts the read loop with the bus start mode `latest` (the group is reset to the newest entry on every start), so requests published while chat was down are never handled (CHAT-INJ-009). Because the group exists before any plan runs, heartbeat `ready` is only ever signalled after the subscription is established. A failure to create the group is logged as `fatal` and exits non-zero. A failing subscription read is retried with backoff inside the bus ([event-bus](../event-bus/event-bus-design.md)).

## Twitch Path

`startTwitch` (`index.ts:77-103`):

1. Dynamic `import("@twurple/chat")`, then `buildAuth()`.
2. `buildAuth()` (`index.ts:65-75`) returns `undefined` (anonymous) unless `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and `TWITCH_ACCESS_TOKEN` are all set. Otherwise it builds a `RefreshingAuthProvider`, logs `twitch token refreshed` with `expiresIn` on refresh, and registers the token via `addUserForToken` (`registerUserToken`, `twitch.ts`) with `expiresIn: 0`, `obtainmentTimestamp: 0` and intent `["chat"]`. `TWITCH_REFRESH_TOKEN` is optional (`?? null`). `buildAuth` awaits the registration before it returns, so the `ChatClient` is constructed only after the token is registered; a failed registration rejects `startTwitch` and is logged as `fatal` (CHAT-TW-006). Refreshed tokens are logged but never persisted anywhere.
3. `new ChatClient({ authProvider, channels: [channel], logger: { minLevel: "warning" } })`.
4. `onConnect`: `connected = true`, `heartbeat.ready()`, info log with `channel` and `authenticated`. `onDisconnect`: `connected = false`, warn log with `manually` and `reason`; no explicit reconnect code. Reconnect is the library default: `@twurple/chat` 8.2.0 drives an `ircv3` 0.33.1 client whose `connection.reconnect` option defaults to `true` (`ircv3/lib/IrcClient.js:88`, `:591`), and `ChatClient` is constructed without overriding it, so an unexpected drop is retried and `onConnect` fires again (re-signalling `ready`). This library reconnect is the specified behaviour (CHAT-TW-009); the service adds no reconnect code of its own.
5. `onMessage` runs `createMessageHandler` (`twitch.ts`): `toEvent(user, text, msg.userInfo)` and, if it returns an event, publish `chat.message`. A failed publish is caught, logged at warn level (`chat.message publish failed`) and the next message is handled normally, as on the fake path (CHAT-TW-007).
6. `client.connect()` is not awaited; `onShutdown` calls `client.quit()` and `bus.stop()`.

The `connected` flag feeds the heartbeat `twitch` dependency; when the flag goes false after `ready`, the shared heartbeat derives `degraded` automatically (`packages/bus/src/heartbeat.ts:71`).

## Filter and Payload (`filter.ts`)

`createChatFilter(cfg)` returns `(user, text, info) => EventInput<"chat.message"> | undefined` (`filter.ts:31-49`). Order of checks:

1. `user` (lowercased) in `chat.ignore_users` (lowercased set) drops the message.
2. `text` trimmed of leading and trailing whitespace and starting with any `chat.ignore_prefixes` entry drops it, so `" !cmd"` is a command too (CHAT-FILT-003). Default prefixes `["!"]` (`schema.ts:92`); the example config ships `ignore_users: ["nightbot","streamelements","moobot"]`.
3. `text` with `\s+` collapsed to a single space and trimmed; empty result drops it.

Payload: `platform: "twitch"` (hard-coded, also for `fake`), `user: info.displayName || user`, `userId: info.userId`, cleaned `text`, `isMod: info.isMod || info.isBroadcaster`, `isSub: info.isSubscriber`, `mentionsCohost: clean.toLowerCase().includes(cfg.cohost.name.toLowerCase())`. The mention test is a plain substring match, so `cocoa` and `@coco_fan` both mention `Coco`; a test pins `@coco_fan hi` and comments "substring match, by design" (`test/filter.test.ts:36`). `cohost.name` is `z.string().min(1)` so the empty-name always-true case cannot occur through config.

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

`createInjectHandler({ bus, log, cohostName, now? })` handles `inject.request` (group `chat`, start mode `latest` per CHAT-INJ-009, `index.ts:34`). Steps (`inject.ts:20-49`):

1. `target !== "chat"` returns silently.
2. Any other path answers with `inject.result {id, ok, detail?}`.
3. Stale if `now() - ev.ts > INJECT_STALE_MS` (60 000) gives `ok:false, detail:"stale"`.
4. `kind !== "text"` gives `ok:false` with `chat cannot handle kind '<kind>'`.
5. Text is collapsed and trimmed; blank gives `ok:false, detail:"blank text"`.
6. Publishes `chat.message` with `platform: meta.platform ?? "twitch"`, `user: meta.user || "injected_viewer"`, `isMod`/`isSub` from `meta` (default false), `mentionsCohost` from the lowercased `cohostName` substring, `injected: true`, `remember: r.remember`; no `userId` (the field is optional and an injected viewer has no Twitch id). `ignore_users`/`ignore_prefixes` are deliberately not applied.
7. Then `inject.result {ok:true}`. Any thrown error becomes `ok:false` with `String(err)`; if even the failure result cannot be published the error is swallowed.

The `inject.*` schemas belong to `event-bus`; the HTTP side and bus-level (skip-the-service) injection belong to `dashboard`.

## Health (`health.ts`)

`chatHealth(channel, twitchConnected, source)` returns the `HeartbeatSpec` consumed by `startHeartbeat` (`index.ts:25`); the heartbeat contract is owned by `control-plane`.

- `source === "fake"`: `{service:"chat", mode:"mock", deps: {twitch:"n/a"}}`.
- else: `mode:"live"`, `deps.twitch = channel && twitchConnected() ? "ok" : "down"`.
- Before the first connect the state stays `starting`, not `degraded` (the shared heartbeat only derives `degraded` from `down` deps once the base state is `ready`, `heartbeat.ts:71`).
- `mode` is a static string, not a getter; it cannot change at runtime.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Anonymous vs authenticated IRC | Anonymous unless all of client id, secret and access token are set (`index.ts:68`) | Always require credentials; remove the credential path; Twitch EventSub | Header comment (`index.ts:3-6`): chat works read-only with just `TWITCH_CHANNEL`, so a stream needs no Twitch app registration to give the co-host its text sense. Typing in chat is a deferred project goal; the credential path stays so that a later body output beside `voice` can send lines with the same client. Requiring credentials would make the simplest setup harder for no read-side gain, and removing the path would have to be undone for that goal. Twitch EventSub chat subscriptions need an app and a user token even to read, so they lose the anonymous read-only setup; IRC through `@twurple/chat` keeps it. |
| Token registration | `addUserForToken` with `expiresIn: 0`, `obtainmentTimestamp: 0` (`index.ts:71-79`) | Pass real expiry; persist refreshed tokens | `[inferred]` Env tokens carry no expiry metadata, and zero expiry makes the provider treat the access token as already expired, so it refreshes before first use. In `@twurple/auth` 8.2.0 `addUserForToken` then requires a refresh token (it throws `InvalidTokenError` without one), and `addUser` rejects any token without a refresh token, so the authenticated path fails at registration (CHAT-TW-006, fatal) when `TWITCH_REFRESH_TOKEN` is unset, although CHAT-TW-002 treats that variable as optional. |
| Token registration ordering | Await `addUserForToken` before the `ChatClient` asks for credentials (CHAT-TW-006) | Fire-and-forget (the original code) | Owner decision 2026-11-01: the client must not race the registration, and a failed registration must surface instead of becoming an unhandled rejection. |
| Twitch publish failure | Log and handle the next message (CHAT-TW-007) | Let the rejection escape the twurple listener; crash and restart | Owner decision 2026-11-01 (project-wide): a failed bus publish is logged and the service continues, as the fake path already does (CHAT-FAKE-006). |
| Reconnect | Library default: `ircv3` `reconnect: true`, `onConnect` re-signals `ready` (CHAT-TW-009) | Own reconnect loop | Owner decision 2026-11-01: the library already retries an unexpected drop; the spec records it rather than adding code. |
| Missing channel | Idle plus `degraded` heartbeat, error log every 60 s (`index.ts:51-59`) | `process.exit(1)` (old behaviour in baseline OpenSpec) | Avoid restart loops under a supervisor: comment at `index.ts:53`; commit 51d5a9c; add-isolated-backends design D6. |
| Lazy `@twurple` import | Dynamic `import()` inside `startTwitch`/`buildAuth` (`index.ts:66`, `:85`) | Static import | The fake and idle plans must not load the IRC library: comment at `index.ts:37`; add-isolated-backends design D6 ("Does not touch `@twurple`"). |
| Mention detection | Substring on lowercased cleaned text (`filter.ts:46`) | Word-boundary or `@name` match | Test comment "substring match, by design" (`test/filter.test.ts:36`). Owner decision 2026-11-01: keep substring matching; false positives such as `cocoa` are accepted. |
| Command prefixes | Matched after trimming (CHAT-FILT-003) | Match the raw text (the original code) | Owner decision 2026-11-01: a leading space must not defeat the command filter. |
| Fake source reuses real filter | `toEvent` injected into `startFakeSource` (`fake.ts:6`, `:42`) | Publish scripted events directly | So fake runs exercise ignore rules and cleaning exactly like Twitch: header comment `fake.ts:36`; add-isolated-backends design D6 ("passing each through the normal `createChatFilter` so ignore rules apply"). |
| Injection bypasses ignore rules | `inject.ts` does not call the filter (`inject.ts:16-18`) | Reuse `createChatFilter` | "A dropped test is useless": comment at `inject.ts:16-18`; add-test-injection design D8, listed under its owner-confirmed decisions. |
| Platform | Hard-coded `"twitch"` in filter (`filter.ts:40`), also for fake chat; injected chat carries no `userId` | Carry platform from the source; a `fake` platform value | Owner decision 2026-11-01: keep both. The schema has no `fake` platform and `userId` is optional. Multi-platform chat is a goal and Twitch the only implementation; the schema already allows `youtube`/`discord` (`packages/bus/src/events.ts:14`), so a new platform is a new source that sets its own value. |
| Health mode for idle channel | `live` with `twitch: down` (`health.ts:10-14`; asserted at `test/health.test.ts:23-28`) | `off` with `twitch: n/a` (the add-service-health delta) | add-isolated-backends design D6 specifies idle `degraded` with `deps: {twitch: "down"}`, and its D2 says services with a real source report `live`; the test is titled "stays live-mode" (`test/health.test.ts:23`). Owner decision 2026-11-01 confirms `live` / `down`. |
| Injection start mode | `latest`: the `chat` group is reset to the newest entry on every start (CHAT-INJ-009) | `resume` (replay requests published while down) | Owner decision 2026-11-01 (project-wide): every subscriber except memory uses `latest`; a stale test request has no value after a restart, and delivery across restarts is at-most-once. |

## Open Questions & Future Decisions

### Deferred / unexplained

1. Refreshed tokens are never persisted (`index.ts:70` logs only). After a refresh the env token can be stale on restart.
2. Staleness compares publisher `ev.ts` with the local clock (`inject.ts:28`), so clock skew between hosts can mis-drop requests.
3. `index.ts` (plan dispatch, auth, ChatClient wiring, idle timer) has no test; only `filter`, `fake`, `health`, `inject` are covered. CHAT-TW-008 and CHAT-TW-009 have no test for that reason.
4. Idle plan logs an error every 60 s forever (`index.ts:57`); log noise rather than a state change.
5. The frozen OpenSpec baseline "No channel" scenario says exit code 1 (`openspec/specs/chat/spec.md`); CHAT-PLAN-003 (idle, never exit) governs.

## References

### Files in this segment
- `services/chat/src/index.ts`, `filter.ts`, `fake.ts`, `health.ts`, `inject.ts`, `subscribe.ts`, `twitch.ts`
- `services/chat/test/filter.test.ts`, `fake.test.ts`, `health.test.ts`, `inject.test.ts`, `twitch.test.ts`
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
