# region-hooks specs

## Kinds and construction

- [x] **HOOK-KIND-001**: When a `Module` has `kind` `rules`, `run(input)` shall return `impl.rules(input)` without performing any I/O. <!-- openspec: modules § Three implementation kinds --> <!-- test: packages/modules/test/module.test.ts:24 -->
- [x] **HOOK-KIND-002**: The `Module` shall expose the configured kind (`rules`, `llm` or `http`) through its `kind` getter. <!-- test: packages/modules/test/module.test.ts:24 (rules only) -->
- [x] **HOOK-KIND-003**: If a `Module` is constructed with `kind` `llm` and the hook supplies no `llm` implementation, then the constructor shall throw an error naming the hook and stating it has no llm implementation. <!-- openspec: modules § Construction-time validation --> <!-- test: packages/modules/test/module.test.ts:31 -->
- [x] **HOOK-KIND-004**: If a `Module` is constructed with `kind` `http` and the hook supplies no `http` implementation, then the constructor shall throw an error naming the hook and stating it has no http implementation. <!-- openspec: modules § Construction-time validation --> <!-- test: packages/modules/test/module.test.ts:132 -->
- [x] **HOOK-KIND-005**: If a `Module` is constructed with `kind` `http` and an empty `module.url`, then the constructor shall throw an error naming the hook and stating the url is empty. <!-- openspec: modules § Construction-time validation --> <!-- test: packages/modules/test/module.test.ts:31 -->

## LLM kind

- [x] **HOOK-LLM-001**: When a `Module` of kind `llm` is constructed, the runner shall create one chat provider from the cortex `llm` config, overriding the provider and the model only when `module.llm.provider` or `module.llm.model` is set. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:89 (no-override case) -->
- [x] **HOOK-LLM-002**: Where `module.llm.model` is set without a provider, the `llm`-kind hook shall use that model on the inherited cortex provider. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:101 -->
- [x] **HOOK-LLM-003**: When an `llm`-kind hook runs, the runner shall send one system message and one user message built from the hook input, with `temperature` 0, `json` true and `maxTokens` defaulting to 200 when the hook specifies none. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:89 (the 200 default is not exercised; the test hook sets maxTokens 30) -->
- [x] **HOOK-LLM-004**: While an `llm`-kind call is in flight, the runner shall enforce `module.timeout_ms` both with an abort signal passed to the provider and with an independent timer, so that `run` settles within roughly the timeout even if the provider ignores the signal. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:109 (uses a provider that honors the signal; the ignore-the-signal case is not exercised) -->
- [x] **HOOK-LLM-005**: When an `llm`-kind reply is received, the runner shall extract JSON from it with `extractJson` and pass the result and the input to the hook's `llm.validate`. <!-- openspec: modules § LLM kind behaviour --> <!-- test: packages/modules/test/module.test.ts:89 -->

## HTTP kind

- [x] **HOOK-HTTP-001**: When an `http`-kind hook runs, the runner shall `POST` `JSON.stringify(input)` to `module.url` with `content-type: application/json` and an abort signal of `module.timeout_ms`. <!-- openspec: modules § HTTP kind behaviour --> <!-- no test asserts the request: packages/modules/test/module.test.ts:50 reaches the endpoint but checks neither body nor header -->
- [x] **HOOK-HTTP-002**: When the `http` endpoint answers 2xx with JSON, the runner shall pass the parsed body and the input to the hook's `http.validate` and return its result if defined. <!-- openspec: modules § HTTP kind behaviour --> <!-- test: packages/modules/test/module.test.ts:50 -->
- [x] **HOOK-HTTP-003**: If the `http` endpoint answers a non-2xx status, then the runner shall treat the call as failed and return the rules result. <!-- openspec: modules § HTTP kind behaviour --> <!-- test: packages/modules/test/module.test.ts:57 -->

## Fallback

- [x] **HOOK-FALLBACK-001**: If a `llm` or `http` hook's `validate` returns undefined, then `run` shall return `impl.rules(input)`. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:57 -->
- [x] **HOOK-FALLBACK-002**: If an `llm` or `http` hook call throws, is aborted or times out, then `run` shall return `impl.rules(input)`. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:57 (http), packages/modules/test/module.test.ts:109 (llm timeout) -->
- [x] **HOOK-FALLBACK-003**: If an `llm`-kind reply contains no parseable JSON or JSON of the wrong shape, then `run` shall return `impl.rules(input)`. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:109 -->
- [x] **HOOK-FALLBACK-004**: If a hook's `validate` function throws, then `run` shall return `impl.rules(input)` rather than reject. <!-- no test -->
- [ ] **HOOK-FALLBACK-005**: If `impl.rules` itself throws, then `run` shall not let the error escape the hook. Gap: `impl.rules` is called unguarded on both the rules path and the fallback path (`packages/modules/src/index.ts:54`, `:62`), so a rules bug propagates to the region loop. <!-- openspec: modules § Fallback to rules -->
- [x] **HOOK-FALLBACK-006**: Where the top-level `llm.provider` is `mock` and an `llm`-kind hook sets no `module.llm.provider` of its own, the hook shall inherit the mock provider, receive `{}` on every call, and fall back to rules whenever the region's `validate` rejects `{}` (the salience, affect and critic validators all do). A hook cannot select `mock` itself: the hook-level provider enum excludes it (`packages/config/src/schema.ts:20`). <!-- no test: no test builds a Module on the mock provider; packages/llm/test/llm.test.ts:232 asserts only the `{}` reply -->

## Warnings

- [x] **HOOK-WARN-001**: When a hook falls back to rules, the runner shall log one warn-level entry with fields `module` (the hook name) and `kind`, and shall log at most one such entry per 30 seconds per `Module` instance. <!-- openspec: modules § Fallback to rules --> <!-- test: packages/modules/test/module.test.ts:122 (suppression inside one window; recurrence after 30 s is not exercised) -->
- [x] **HOOK-WARN-002**: When a hook falls back because a call failed, the warning message shall include the first 120 characters of the error text, and when it falls back because validation returned undefined the message shall say the module returned something unusable. <!-- openspec: modules § Fallback to rules --> <!-- no test: the warn test records only the fields object, not the message -->

## Helpers

- [x] **HOOK-HELP-001**: When `extractJson` is given text containing a single JSON object or array whose surrounding prose contains no `[`, `]`, `{` or `}`, it shall return the parsed value. <!-- openspec: modules § Helpers --> <!-- test: packages/modules/test/module.test.ts:16 -->
- [x] **HOOK-HELP-002**: If `extractJson` finds no bracketed span or the span does not parse, then it shall return undefined. <!-- openspec: modules § Helpers --> <!-- test: packages/modules/test/module.test.ts:16 -->
- [ ] **HOOK-HELP-003**: When `extractJson` is given text containing more than one JSON value, or bracketed prose before the JSON, it shall return the first JSON value. Gap: the regex spans from the first opener to the last closer (`packages/modules/src/index.ts:98`), so such text yields undefined and a rules fallback; the doc comment and OpenSpec both say "first". <!-- openspec: modules § LLM kind behaviour -->
- [x] **HOOK-HELP-004**: The runner package shall export `clamp(x, lo, hi)` returning `x` bounded to the inclusive range and `isNum(x)` returning true only for finite numbers. <!-- openspec: modules § Helpers --> <!-- test: packages/modules/test/module.test.ts:137 -->

## Reference HTTP server

- [x] **HOOK-EX-001**: When `examples/modules/server.py` is run, it shall listen on port 8900 and answer `POST /salience`, `POST /affect` and `POST /critic` with JSON, and answer any other path with 404 and `{"error":"unknown module"}`. <!-- no test -->
- [x] **HOOK-EX-002**: When the reference server receives `POST /salience` with an `events` array, it shall return `{"scores": [...]}` with exactly one score in 0..1 per event, in the same order. <!-- no test -->
- [x] **HOOK-EX-003**: When the reference server receives `POST /affect`, it shall return `{"valence_delta", "arousal_delta"}` numbers. <!-- no test -->
- [x] **HOOK-EX-004**: When the reference server receives `POST /critic`, it shall return `{"ok": true}`, `{"ok": true, "text": <fixed line>}` or `{"ok": false, "note": <reason>}`. <!-- no test -->
- [x] **HOOK-EX-005**: If a reference-server handler raises while reading or answering a request, then the server shall respond 500 with `{"error": <message>}` so that the calling region falls back to its rules. <!-- no test -->
- [ ] **HOOK-EX-006**: If the reference server receives a request with `Content-Length: 0`, then it shall treat the body as an empty JSON object. Gap: `examples/modules/server.py:93` passes the bytes default `b"{}"` to `rfile.read()` as a size, raising `TypeError` and returning 500.
