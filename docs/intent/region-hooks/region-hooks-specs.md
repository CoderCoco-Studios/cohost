# region-hooks specs

Design: [region-hooks-design.md](region-hooks-design.md). Prefix `HOOK`. Verified against the code at git `49ba935` (audit pass 2026-11-01). Owner decisions of 2026-11-01 applied at git `1b57790`; gap-closure dispositions implemented. `[x]` = implemented, `[ ]` = intended but not yet implemented (gap), `[D]` = deferred. Test paths are relative to the repo root.

## Kinds and construction

- [x] **HOOK-KIND-001**: When a `Module` has `kind` `rules`, `run(input)` shall return `impl.rules(input)` without performing any I/O. <!-- openspec: modules § Three implementation kinds --> <!-- test: packages/modules/test/module.test.ts:24 -->
- [x] **HOOK-KIND-002**: The `Module` shall expose the configured kind (`rules`, `llm` or `http`) through its `kind` getter. <!-- test: packages/modules/test/module.test.ts:24 (rules only) -->
- [x] **HOOK-KIND-003**: If a `Module` is constructed with `kind` `llm` and the hook supplies no `llm` implementation, then the constructor shall throw an error naming the hook and stating it has no llm implementation. <!-- openspec: modules § Construction-time validation --> <!-- test: packages/modules/test/module.test.ts:31 -->
- [x] **HOOK-KIND-004**: If a `Module` is constructed with `kind` `http` and the hook supplies no `http` implementation, then the constructor shall throw an error naming the hook and stating it has no http implementation. <!-- openspec: modules § Construction-time validation --> <!-- test: packages/modules/test/module.test.ts:132 -->
- [x] **HOOK-KIND-005**: If a `Module` is constructed with `kind` `http` and an empty `module.url`, then the constructor shall throw an error naming the hook and stating the url is empty. <!-- openspec: modules § Construction-time validation --> <!-- test: packages/modules/test/module.test.ts:31 -->

## LLM kind

- [x] **HOOK-LLM-001**: When a `Module` of kind `llm` is constructed, the runner shall create one chat provider from the cortex `llm` config, overriding the provider and the model only when `module.llm.provider` or `module.llm.model` is set. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:89 (no-override case) -->
- [x] **HOOK-LLM-002**: Where `module.llm.model` is set without a provider, the `llm`-kind hook shall use that model on the inherited cortex provider. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:101 -->
- [x] **HOOK-LLM-003**: When an `llm`-kind hook runs, the runner shall send one system message and one user message built from the hook input, with `temperature` 0, `json` true and `maxTokens` defaulting to 200 when the hook specifies none. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/hooks.test.ts (the 200 default, temperature 0 and json true), packages/modules/test/module.test.ts -->
- [x] **HOOK-LLM-004**: While an `llm`-kind or `http`-kind call is in flight, the runner shall enforce `module.timeout_ms` with one abort controller whose timer both rejects the call and aborts the signal passed to the provider, so that `run` settles within roughly the timeout even if the provider ignores the signal. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/hooks.test.ts (a provider that ignores the signal), packages/modules/test/module.test.ts -->
- [x] **HOOK-LLM-005**: When an `llm`-kind reply is received, the runner shall extract JSON from it with `extractJson` and pass the result and the input to the hook's `llm.validate`. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:89 -->
- [x] **HOOK-LLM-006**: When the timeout elapses before an `llm`-kind or `http`-kind call settles, the runner shall abort the signal it handed to the provider or to `fetch`, so a cooperative provider stops the request that lost. A provider that ignores the signal cannot be cancelled. <!-- test: packages/modules/test/hooks.test.ts -->

## HTTP kind

- [x] **HOOK-HTTP-001**: When an `http`-kind hook runs, the runner shall `POST` `JSON.stringify(input)` to `module.url` with `content-type: application/json` and an abort signal of `module.timeout_ms`. <!-- openspec: modules § HTTP kind behaviour --> <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-HTTP-002**: When the `http` endpoint answers 2xx with JSON, the runner shall pass the parsed body and the input to the hook's `http.validate` and return its result if defined. <!-- openspec: modules § HTTP kind behaviour --> <!-- test: packages/modules/test/module.test.ts:50 -->
- [x] **HOOK-HTTP-003**: If the `http` endpoint answers a non-2xx status, then the runner shall treat the call as failed and return the rules result. <!-- openspec: modules § HTTP kind behaviour --> <!-- test: packages/modules/test/module.test.ts:57 -->

## Fallback

- [x] **HOOK-FALLBACK-001**: If a `llm` or `http` hook's `validate` returns undefined, then `run` shall return `impl.rules(input)`. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:57 -->
- [x] **HOOK-FALLBACK-002**: If an `llm` or `http` hook call throws, is aborted or times out, then `run` shall return `impl.rules(input)`. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:57 (http), packages/modules/test/module.test.ts:109 (llm timeout) -->
- [x] **HOOK-FALLBACK-003**: If an `llm`-kind reply contains no parseable JSON or JSON of the wrong shape, then `run` shall return `impl.rules(input)`. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:109 -->
- [x] **HOOK-FALLBACK-004**: If a hook's `validate` function throws, then `run` shall return `impl.rules(input)` rather than reject. <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-FALLBACK-005**: Every region's `impl.rules` shall return a value of the hook's output type for every input and shall not throw; `run` relies on this precondition, calling `impl.rules` unguarded on the `rules` path and as the fallback (`packages/modules/src/index.ts:60`, `:68`), because there is no further fallback value to return. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:186 (a throwing `rules` surfaces on both paths); the regions' rules are exercised by each region's own tests -->
- [x] **HOOK-FALLBACK-006**: Where the top-level `llm.provider` is `mock` and an `llm`-kind hook sets no `module.llm.provider` of its own, the hook shall inherit the mock provider, receive `{}` on every call, and fall back to rules whenever the region's `validate` rejects `{}` (the salience, affect and critic validators all do). A hook cannot select `mock` itself: the hook-level provider enum excludes it (`packages/config/src/schema.ts:22`, CFG-SCH-009). Mock-backed hooks are not meant to succeed: isolated runs exercise wiring, not hook quality. <!-- test: packages/modules/test/module.test.ts:168 (a Module on the mock provider falls back); packages/llm/test/llm.test.ts:232 asserts the `{}` reply -->

## Warnings

- [x] **HOOK-WARN-001**: When a hook falls back to rules, the runner shall log one warn-level entry with fields `module` (the hook name) and `kind`, and shall log at most one such entry per 30 seconds, measured on a monotonic clock, per `Module` instance. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:148 (suppression inside one window), packages/modules/test/hooks.test.ts (recurrence after 30 s) -->
- [x] **HOOK-WARN-002**: When a hook falls back because a call failed, the warning message shall include the first 120 characters of the error text, and when it falls back because validation returned undefined the message shall say the module returned something unusable. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-WARN-003**: When the runner logs a fallback warning and earlier fallbacks of the same `Module` were suppressed by the 30-second limit, the warning shall carry the number of fallbacks suppressed since the previous warning. <!-- test: packages/modules/test/module.test.ts:148, packages/modules/test/hooks.test.ts -->
- [x] **HOOK-WARN-004**: When a `Module` of kind `llm` is constructed and its resolved chat provider is `mock`, the runner shall log one warn-level message naming the hook and stating that it runs on the mock provider (so every call falls back to rules). <!-- openspec: llm § Mock is reported, not hidden --> <!-- test: packages/modules/test/module.test.ts:168 -->

## Cool-off

- [x] **HOOK-COOL-001**: If an `llm`-kind or `http`-kind hook fails 5 calls in a row (`HOOK_COOLOFF_AFTER`), then the runner shall skip the hook for 60 seconds (`HOOK_COOLOFF_MS`, measured on a monotonic clock), returning `impl.rules(input)` without making the call, shall log one warn-level entry saying the hook is cooling off, and shall make one trial call when the period ends, starting another cool-off at once if the trial fails. <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-COOL-002**: When an `llm`-kind or `http`-kind call yields a usable result, the runner shall reset the consecutive-failure count; a call whose result `validate` rejects counts as a failure. <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-COOL-003**: A `Module` of kind `rules` shall never enter a cool-off and shall never make a call. <!-- test: packages/modules/test/hooks.test.ts -->

## Health

- [x] **HOOK-HEALTH-001**: When `ping()` is called on an `llm`-kind `Module`, the runner shall call its provider's `ping()`, record the answer as the hook's reachable state, and return it, and `health()` shall report that state with the provider's `lastError` after a failed ping; `ping()` on any other kind shall return undefined. <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-HEALTH-002**: Where the provider's ping is nominal (`pingIsNominal`), `ping()` shall return true and `health()` shall report the reachable state as unknown. <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-HEALTH-003**: When an `llm`-kind or `http`-kind call succeeds, `health()` shall report the hook reachable, and when it fails, not reachable. <!-- test: packages/modules/test/hooks.test.ts -->
- [x] **HOOK-HEALTH-004**: `hookHealth(hooks)` shall report mode `mock` while any hook runs on the mock provider and `live` otherwise, and shall report one dependency `hook.<name>` per non-rules hook: `down` while it is cooling off or not reachable, `ok` when reachable, `n/a` while unknown. Salience and affect shall spread it into their heartbeat spec. <!-- test: packages/modules/test/hooks.test.ts --> <!-- test: services/salience/test/main.test.ts, services/affect/test/main.test.ts (the services still start with it) -->
- [x] **HOOK-HEALTH-005**: When `pingHooks(hooks, log)` is called, the runner shall ping every non-rules hook once and log one warn-level entry naming each hook whose provider does not answer; it shall not throw. Salience and affect shall call it once at startup, without waiting for it. <!-- test: packages/modules/test/hooks.test.ts -->

## Configuration

- [x] **HOOK-CFG-001**: The hook config type `ModuleConfig` shall have one definition, in `@cohost/config`, and `@cohost/modules` shall re-export that type under the same name. <!-- test: packages/modules/test/hooks.test.ts (type-checked by tsc through the services that import it from `@cohost/modules`) -->
- [x] **HOOK-CFG-002**: The default `module.timeout_ms` of every hook shall be 8000 (CFG-SCH-003), long enough for a hosted Claude model that thinks. <!-- test: packages/modules/test/hooks.test.ts -->

## Helpers

- [x] **HOOK-HELP-001**: When `extractJson` is given text containing a single JSON object or array whose surrounding prose contains no `[`, `]`, `{` or `}`, it shall return the parsed value. <!-- openspec: modules § Helpers --> <!-- test: packages/modules/test/module.test.ts:16 -->
- [x] **HOOK-HELP-002**: If `extractJson` finds no bracketed span or the span does not parse, then it shall return undefined. <!-- openspec: modules § Helpers --> <!-- test: packages/modules/test/module.test.ts:16 -->
- [x] **HOOK-HELP-003**: When `extractJson` is given text, it shall return the first balanced JSON object or array in the text, so that a reply with more than one JSON value, bracketed prose before the JSON, or a closing bracket or brace in prose after it still yields that first value. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:196 -->
- [x] **HOOK-HELP-004**: The runner package shall export `clamp(x, lo, hi)` returning `x` bounded to the inclusive range and `isNum(x)` returning true only for finite numbers. <!-- openspec: modules § Helpers --> <!-- test: packages/modules/test/module.test.ts:137 -->

## Reference HTTP server

- [x] **HOOK-EX-001**: When `examples/modules/server.py` is run, it shall listen on port 8900 (`make_server`) and answer `POST /salience`, `POST /affect` and `POST /critic` with JSON, and answer any other path with 404 and `{"error":"unknown module"}`. <!-- test: packages/modules/test/example-server.test.ts (live server, skipped without python3; fixture responses against the region validators) -->
- [x] **HOOK-EX-002**: When the reference server receives `POST /salience` with an `events` array, it shall return `{"scores": [...]}` with exactly one score in 0..1 per event, in the same order. <!-- test: packages/modules/test/example-server.test.ts:89 (live server, skipped without python3), packages/modules/test/example-server.test.ts:55 (fixture responses against the region validators) -->
- [x] **HOOK-EX-003**: When the reference server receives `POST /affect`, it shall return `{"valence_delta", "arousal_delta"}` numbers. <!-- test: packages/modules/test/example-server.test.ts:89 (live server, skipped without python3), packages/modules/test/example-server.test.ts:55 (fixture responses against the region validators) -->
- [x] **HOOK-EX-004**: When the reference server receives `POST /critic`, it shall return `{"ok": true}`, `{"ok": true, "text": <fixed line>, "emotion": <the request's emotion>}` or `{"ok": false, "note": <reason>}`.
- [x] **HOOK-EX-005**: If a reference-server handler raises while reading or answering a request, then the server shall respond 500 with `{"error": <message>}` so that the calling region falls back to its rules. <!-- test: packages/modules/test/example-server.test.ts:89 (the 500 on an empty body, which the handlers reject with a KeyError) -->
- [x] **HOOK-EX-006**: If the reference server receives a request with `Content-Length: 0` or no `Content-Length` header, then it shall treat the body as an empty JSON object. <!-- test: packages/modules/test/example-server.test.ts:89 -->
- [x] **HOOK-EX-007**: While one client has sent request headers but not its body, the reference server shall keep answering other requests (one thread per request). <!-- test: packages/modules/test/example-server.test.ts (live server, skipped without python3) -->
- [x] **HOOK-EX-008**: The reference server shall route on the parsed request path alone, so a query string or fragment does not change which module answers; any other path is 404. <!-- test: packages/modules/test/example-server.test.ts (live server, skipped without python3) -->
- [x] **HOOK-EX-009**: When the text of a `POST /critic` request contains `http` in any letter case, the reference server shall answer `{"ok": false, "note": "no links on air"}`. <!-- test: packages/modules/test/example-server.test.ts (live server, skipped without python3) -->
- [x] **HOOK-EX-010**: When the reference server rewrites a critic line, it shall return the request's `emotion` (`neutral` when the request has none) beside the new `text`. <!-- test: packages/modules/test/example-server.test.ts (live server, skipped without python3), examples/modules/fixtures/contracts.json -->

## Reply schemas

- [x] **HOOK-SCHEMA-001**: The runner package shall export `HOOK_REPLY_SCHEMAS`, a JSON Schema for the reply of each of the `salience`, `affect` and `critic` hooks, such that a reply the schema accepts is used by the region's validator and a reply of the wrong type or shape makes the region fall back to its rules. <!-- test: packages/modules/test/schemas.test.ts -->
- [x] **HOOK-SCHEMA-002**: A reply the schema cannot judge (a score count that differs from the event count) shall be rejected by the region's validator alone. <!-- test: packages/modules/test/schemas.test.ts -->
- [x] **HOOK-SCHEMA-003**: `scripts/gen-hook-schemas.mjs` shall write each schema to `examples/modules/schemas/<hook>.json`, the files shall equal `HOOK_REPLY_SCHEMAS`, and `examples/modules/README.md` shall cite each file. <!-- test: packages/modules/test/schemas.test.ts -->
