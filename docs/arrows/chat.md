# Arrow: chat

Twitch chat sense: Twitch IRC (or a fake source) in, filtered `chat.message` events out, plus service-level test injection and a heartbeat.

## Status

**MAPPED** — mapped 2026-10-31 (git SHA 686cc8f), not yet audited.

## References

### HLD
- docs/high-level-design.md (System Design, senses)

### LLD
- docs/intent/chat/chat-design.md

### EARS
- docs/intent/chat/chat-specs.md (40 specs: 37 `[x]`, 3 `[ ]`)

### Tests
- services/chat/test/filter.test.ts
- services/chat/test/fake.test.ts
- services/chat/test/inject.test.ts
- services/chat/test/health.test.ts

### Code
- services/chat/src/index.ts
- services/chat/src/filter.ts
- services/chat/src/fake.ts
- services/chat/src/inject.ts
- services/chat/src/health.ts
- services/chat/package.json, services/chat/tsconfig.json

### OpenSpec
- openspec/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-service-health/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-isolated-backends/specs/chat/spec.md
- openspec/changes/archive/2026-11-01-add-test-injection/specs/chat/spec.md

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
| Twitch connection | CHAT-TW-001 to 007 | 5 | 0 | 2 |
| Filtering and payload | CHAT-FILT-001 to 007 | 7 | 0 | 0 |
| Fake source | CHAT-FAKE-001 to 006 | 6 | 0 | 0 |
| Test injection | CHAT-INJ-001 to 008 | 8 | 0 | 0 |
| Health | CHAT-HEALTH-001 to 006 | 5 | 0 | 1 |

**Summary:** 37 of 40 specs observed working; 3 gaps; 0 deferred. Of the working specs, `index.ts`-level behaviours (the Twitch/idle wiring behind PLAN-003, PLAN-005, PLAN-006, TW-001 to 005, INJ-001) have no test; only the pure `chatPlan` is covered.

## Key Findings

1. **Auth registration is fire-and-forget** — `void provider.addUserForToken(...)` (`services/chat/src/index.ts:63`) with `expiresIn: 0, obtainmentTimestamp: 0`; `ChatClient` is built immediately after (`:78`). Possible race and unhandled rejection. Refreshed tokens are only logged (`:62`), never persisted. (CHAT-TW-006)
2. **No error handling around publish in the live path** — `onMessage` awaits `bus.publish` bare (`index.ts:90-93`); the `inject.request` `bus.subscribe` is `void` with no `.catch` (`index.ts:28`). (CHAT-TW-007)
3. **OpenSpec health scenario disagrees with code and test** — add-service-health says no channel gives `mode: off`, `twitch: n/a`; code gives `live` / `down` (`services/chat/src/health.ts:9-13`) and `test/health.test.ts:20-25` asserts that. Spec text probably stale. (CHAT-HEALTH-006)
4. **Filter quirks are by-design or accidental, and partly untested** — substring mention match is blessed by a test comment (`test/filter.test.ts:32`); `ignore_prefixes` is checked on untrimmed text (`filter.ts:33`) with no test; platform is hard-coded `"twitch"` (`filter.ts:37`) even for fake chat. `[inferred]`
5. **Superseded baseline spec** — `openspec/specs/chat/spec.md` still says an empty channel exits with code 1; the code idles and degrades (`index.ts:46-52`) per the isolated-backends delta.
6. **Reconnect is delegated** — `onDisconnect` only flips `connected` and logs (`index.ts:85-88`); recovery depends on `@twurple/chat` defaults, not verified (dependencies not installed at mapping).
7. **Dead-end credentials story** — header says credentials are for typing in chat later (`index.ts:5-6`) but nothing ever calls `say`; scope is read-only `["chat"]` (`index.ts:70`).

## Work Required

### Must Fix
1. None identified; no spec is both broken and user-visible beyond the items below.

### Should Fix
1. Await (or handle rejection of) `addUserForToken` before creating `ChatClient` (CHAT-TW-006).
2. Wrap the `onMessage` publish in try/catch with a warn log; add `.catch` on the `inject.request` subscription (CHAT-TW-007).
3. Reconcile the add-service-health "Unconfigured channel" scenario with the shipped `live`/`down` behaviour, by updating the spec (CHAT-HEALTH-006).
4. Add tests for the `index.ts` wiring (idle plan degraded heartbeat, auth selection) (CHAT-PLAN-003, CHAT-TW-001, CHAT-TW-002).

### Nice to Have
1. Persist refreshed Twitch tokens, or document that restarts re-use the env token (CHAT-TW-002).
2. Decide whether `ignore_prefixes` should be applied after trimming, and add a test (CHAT-FILT-003).
3. Carry `platform` and `userId` consistently, including on injected messages (CHAT-FILT-005, CHAT-INJ-005).
4. Update the baseline OpenSpec "No channel" scenario (exit 1) so it is not misleading.
