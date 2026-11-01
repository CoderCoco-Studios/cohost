# Arrow: chat

Twitch chat sense: Twitch IRC (or a fake source) in, filtered `chat.message` events out, plus service-level test injection and a heartbeat.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f). Audit pass complete 2026-11-01, awaiting index update.

## Questions for the user

1. **CHAT-HEALTH-006: is `mode: "live"` with `deps.twitch: "down"` the intended heartbeat for a missing channel?** The line now states the shipped behavior (`services/chat/src/health.ts:10-14`, asserted by `services/chat/test/health.test.ts:23`) and is `[x]`. The add-service-health delta said `mode: "off"` with `deps.twitch: "n/a"`; add-isolated-backends design D6 chose `down`. Recommended: confirm `live` / `down`.
2. **CHAT-TW-006: should the user token be registered before `ChatClient` asks for credentials?** `addUserForToken` is fire-and-forget (`services/chat/src/index.ts:71`) and the client is built right after (`index.ts:87`); a rejection is unhandled. The intent is `[inferred]`; no source records it. Recommended: yes, keep the gap and await the registration.
3. **CHAT-TW-007: should a failed `chat.message` publish on the Twitch path be logged and skipped?** `onMessage` awaits `bus.publish` with no try/catch (`services/chat/src/index.ts:102-105`); the fake source already logs and continues (CHAT-FAKE-006). Intent is `[inferred]`. Recommended: yes, mirror CHAT-FAKE-006.
4. **CHAT-FILT-003: should `ignore_prefixes` match after trimming?** It is checked on the raw text (`services/chat/src/filter.ts:36`), so `" !cmd"` is published as chat. No test covers it. Recommended: trim first, so a leading space does not defeat the command filter (spec and code change).
5. **CHAT-FILT-007: is substring mention matching still wanted?** `cocoa` and `@coco_fan` count as mentioning `Coco`; a test comment says "substring match, by design" (`services/chat/test/filter.test.ts:36`). Recommended: keep substring matching.
6. **Twitch reconnect has no spec line. Should it get one?** Recovery after a drop comes from the `ircv3` default `reconnect: true` under `@twurple/chat` 8.2.0; `onConnect` then re-signals `ready` (`services/chat/src/index.ts:90-94`). Nothing tests it. Recommended: add a CHAT-TW line that states the library-driven reconnect, marked untested.
7. **Should fake chat keep `platform: "twitch"`, and injected chat keep omitting `userId`?** The filter hard-codes `platform: "twitch"` for fake lines too (`services/chat/src/filter.ts:40`); injected messages carry no `userId` (`services/chat/src/inject.ts:32-41`). Recommended: keep both (the payload schema has no `fake` platform, and `userId` is optional).

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (41 specs: 39 `[x]`, 2 `[ ]`, 0 `[D]`)

### Tests
- services/chat/test/filter.test.ts
- services/chat/test/fake.test.ts
- services/chat/test/inject.test.ts
- services/chat/test/health.test.ts

21 `@spec` annotations in tests, citing 27 distinct spec IDs.

### Code
- services/chat/src/index.ts
- services/chat/src/filter.ts
- services/chat/src/fake.ts
- services/chat/src/inject.ts
- services/chat/src/health.ts
- services/chat/package.json, services/chat/tsconfig.json

19 `@spec` annotations in code, citing all 39 `[x]` spec IDs. No annotation cites a missing or non-`[x]` ID.

### OpenSpec (frozen, historical)
- openspec/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/chat/spec.md (rationale: `.../add-isolated-backends/design.md` D6)
- openspec/changes/archive/2026-11-01-add-test-injection/specs/chat/spec.md (rationale: `.../add-test-injection/design.md` D8)

## Architecture

**Purpose:** Turn Twitch chat (or scripted/stdin chat in isolated runs) into `chat.message` bus events, drop noise, and let the operator inject test messages through the same publish path.

**Key Components:**
1. `index.ts` — wiring: picks a plan (`fake` / `twitch` / `idle`), builds optional Twitch auth, connects `ChatClient`, subscribes `inject.request`, starts the heartbeat. Untested glue.
2. `filter.ts` — pure `createChatFilter`, `channelName`, `chatPlan`; ignore lists, whitespace cleanup, mention flag, payload shape.
3. `fake.ts` — `startFakeSource`: stdin lines or a cycled 6-line script through the same filter.
4. `inject.ts` — `createInjectHandler` for `inject.request` (target `chat`, kind `text`); bypasses the ignore rules.
5. `health.ts` — `chatHealth` heartbeat spec (mode `mock`/`live`, dep `twitch`).

Depends on `event-bus`, `config`, `control-plane` (heartbeat). Consumed by `salience`, `affect`, `memory`, `dashboard`.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|----------|----------|-------------|----------|------|
| Source selection | CHAT-PLAN-001 to 006 | 6 | 0 | 0 |
| Twitch connection | CHAT-TW-001 to 008 | 6 | 0 | 2 |
| Filtering and payload | CHAT-FILT-001 to 007 | 7 | 0 | 0 |
| Fake source | CHAT-FAKE-001 to 006 | 6 | 0 | 0 |
| Test injection | CHAT-INJ-001 to 008 | 8 | 0 | 0 |
| Health | CHAT-HEALTH-001 to 006 | 6 | 0 | 0 |

**Summary:** 39 of 41 specs implemented; 2 gaps (CHAT-TW-006, CHAT-TW-007); 0 deferred. 27 of the 39 implemented specs have a test citing them. The 12 without a test are the `index.ts` wiring (CHAT-PLAN-005, CHAT-PLAN-006, CHAT-TW-001 to 005, CHAT-TW-008, CHAT-INJ-001) plus CHAT-FILT-003, CHAT-FAKE-005 and CHAT-FAKE-006. CHAT-PLAN-001 to 003 are tested only through the pure `chatPlan`, not the branch wiring.

## Key Findings

1. **Marker flipped: CHAT-HEALTH-006 `[ ]` → `[x]`.** The line asked for `mode: "off"` / `deps.twitch: "n/a"`, which the code never did; it now states the shipped `live` / `down` (`services/chat/src/health.ts:10-14`, test `services/chat/test/health.test.ts:23`), backed by add-isolated-backends design D6. The old wording is Question 1.
2. **New spec CHAT-TW-008.** The Twitch `onMessage` → filter → publish path (`services/chat/src/index.ts:102-105`) had no line of its own; added as `[x]`, untested.
3. **Auth registration is fire-and-forget** — `void provider.addUserForToken(...)` (`services/chat/src/index.ts:71`) with `expiresIn: 0, obtainmentTimestamp: 0`; `ChatClient` is built immediately after (`:87`). Possible race and unhandled rejection. Refreshed tokens are only logged (`:70`), never persisted. (CHAT-TW-006)
4. **No error handling around publish in the live path** — `onMessage` awaits `bus.publish` bare (`index.ts:102-105`); the `inject.request` `bus.subscribe` is `void` with no `.catch` (`index.ts:30`). (CHAT-TW-007)
5. **Reconnect is the library default, now verified** — `onDisconnect` only flips `connected` and logs (`index.ts:96-99`); `@twurple/chat` 8.2.0 runs an `ircv3` 0.33.1 client whose `reconnect` option defaults to `true`, and `ChatClient` does not override it. No spec line or test covers this (Question 6).
6. **Filter quirks** — substring mention match is deliberate per a test comment (`test/filter.test.ts:36`); `ignore_prefixes` is checked on untrimmed text (`filter.ts:36`) with no test; platform is hard-coded `"twitch"` (`filter.ts:40`) even for fake chat.
7. **Dead-end credentials story** — the header says credentials are for typing in chat later (`index.ts:5-6`), but nothing ever calls `say`; scope is read-only `["chat"]` (`index.ts:78`).
8. **Decisions evidenced** — seven of nine LLD Decisions rows now cite a comment, test, commit (51d5a9c) or archived OpenSpec design (add-isolated-backends D2 and D6, add-test-injection D8) instead of `[inferred]`; token registration and platform stay `[inferred]`, as do the EventSub alternative and the reason substring matching was preferred.
9. **Line references elsewhere now stale** — the `@spec` lines shift `services/chat/src/index.ts`. References from outside this segment's write scope need a refresh by their owners: `docs/intent/event-bus/event-bus-design.md:80,159` (`index.ts:38,92`; `:45,52,96`), `docs/intent/config/config-design.md:62,98` (`index.ts:21,35`; `:59`).

## Work Required

### Must Fix
1. None identified; no spec is both broken and user-visible beyond the items below.

### Should Fix
1. Await (or handle rejection of) `addUserForToken` before creating `ChatClient` (CHAT-TW-006), once Question 2 is answered.
2. Wrap the `onMessage` publish in try/catch with a warn log; add `.catch` on the `inject.request` subscription (CHAT-TW-007).
3. Add tests for the `index.ts` wiring: idle plan degraded heartbeat, auth selection, message publish (CHAT-PLAN-003, CHAT-TW-001, CHAT-TW-002, CHAT-TW-008).

### Nice to Have
1. Persist refreshed Twitch tokens, or document that restarts re-use the env token (CHAT-TW-002).
2. Decide whether `ignore_prefixes` should be applied after trimming, and add a test (CHAT-FILT-003).
3. Carry `platform` and `userId` consistently, including on injected messages (CHAT-FILT-005, CHAT-INJ-005).
