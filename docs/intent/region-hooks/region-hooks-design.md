---
parent: high-level-design
prefix: HOOK
---

# region-hooks

Status: AUDITED 2026-11-02 at git `1b57790` (mapped 2026-10-31 at `686cc8f`; every EARS line checked against code and tests on 2026-11-01; owner decisions of 2026-11-01 applied); the gap-closure dispositions for this segment are implemented and every spec is `[x]`. Describes the intended design. See [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

Each brain region has one place where its judgement lives: salience scores events, affect appraises a line of chat or speech, and the cortex critic vets a reply before it is spoken. `@cohost/modules` (`packages/modules/src/index.ts`) is the shared runner for those three "hooks". A hook is a `Module<I, O>` that runs one of three implementations chosen in config (`index.ts:1-19`):

- `rules`: the region's built-in heuristic. Default. Zero latency, no I/O.
- `llm`: ask a chat model for JSON; any `@cohost/llm` provider, optionally a different/cheaper model than the cortex (`index.ts:9-10`).
- `http`: `POST` the hook input as JSON to a URL the operator serves; this is the slot for a self-trained model (`index.ts:11-12`, `examples/modules/`).

The governing rule is the last line of the header: "Whatever the kind, failure falls back to the rules so the show goes on" (`index.ts:14`). A hook can be slow, down, redeployed, or wrong without breaking the stream.

The package has no bus subscriptions and no timers beyond the per-call timeout. Per `Module` it keeps a warning timestamp, a consecutive-failure count with a cool-off deadline, and whether its provider was last seen answering; the services read that standing through `hookHealth` for their heartbeat. It depends on `@cohost/llm` (`createChatProvider`, `ChatProvider`, `Config` type) and `@cohost/config` (`Logger` type) (`index.ts:20-21`, `packages/modules/package.json:11`). The region owns the I/O types, the prompts, the rules and the `validate` functions; this package owns only the dispatch, timeout, parse and fallback mechanics.

Consumers (each in its own segment): `services/salience/src/scoring.ts:61` (`salience.scorer`, called at `scheduler.ts:54`), `services/affect/src/appraise.ts:55` (`affect.appraiser`, called at `affect.ts:96`), `services/cortex/src/critic.ts:46` (`cortex.critic`, called at `cortex.ts:143`). Planned (memory segment, Viewer notes): `memory.capture`, the live note classifier, and `memory.consolidator`, the model part of the consolidation pass; memory builds both on the local `ollama` provider when the hook names none, instead of inheriting `llm.provider`, even when the cortex uses a hosted model (memory `MEM-NOTE-011`). The runner itself does not change.

## The Module runner

```ts
interface ModuleImpl<I, O> {
  rules: (input: I) => O;                                   // always present: the fallback
  llm?:  { system: string; user: (i: I) => string; maxTokens?: number; validate: (raw: unknown, i: I) => O | undefined };
  http?: { validate: (raw: unknown, i: I) => O | undefined };
}
new Module<I, O>(name, cfg /* ModuleConfig */, llmCfg /* cfg.llm */, impl, log, opts?: ModuleOptions)
module.kind        // "rules" | "llm" | "http"
await module.run(input): Promise<O>        // never rejects because of the hook itself
await module.ping(): Promise<boolean | undefined>   // llm kind: ask the provider; other kinds: undefined
module.health(): HookHealth                // { name, kind, provider?, mock, reachable, coolingOff, detail? }
module.coolingOff: boolean
hookHealth(modules) -> { mode(), deps() }  // heartbeat parts for a service
pingHooks(modules, log)                    // startup ping of every non-rules hook
```

`ModuleOptions` carries test and wiring seams only: `now` (a monotonic millisecond clock, default `performance.now`), `provider` (a ready-made `ChatProvider` instead of one built from config), `coolOffAfter` and `coolOffMs`.

### Construction

Constructor-time checks throw synchronously and name the hook (`index.ts:46-54`):

| `cfg.kind` | Requirement | Error |
| --- | --- | --- |
| `rules` | none | none |
| `llm` | `impl.llm` present | `<name>: this hook has no llm implementation` |
| `http` | `impl.http` present and `cfg.url` non-empty | `<name>: this hook has no http implementation` / `<name>: module.kind is http but module.url is empty` |

For `kind: llm` a provider is created once, at construction: `createChatProvider({ ...llmCfg, provider?, model? })` where `provider` and `model` come from `cfg.llm.provider` / `cfg.llm.model` only when truthy (`index.ts:48`). So an `llm` hook inherits the whole cortex `llm` block, including `openai.base_url`, `claude.*` and `bedrock.region`, and overrides only the provider and/or model. A model-only override stays on the inherited provider (`module.test.ts:101`). The config schema, not this package, rejects `llm.provider` without `llm.model` on a hook (`packages/config/src/schema.ts:24-27`). The hook-level provider enum is `ollama`, `openai`, `anthropic`, `bedrock` (`schema.ts:22`), so a hook cannot select `mock` itself; it reaches a hook only by inheritance from the top-level `llm.provider` (`schema.ts:45`). A hook that inherits `mock` gets `"{}"` for every call, which every current region `validate` rejects, so it falls back to rules; that is intended, because isolated runs exercise wiring rather than hook quality (HOOK-FALLBACK-006). The constructor logs one warning when the resolved provider is `mock`, so a mock-backed hook is never silent (HOOK-WARN-004; `index.ts:49`, test `module.test.ts:168`).

### run()

```
rules -> return impl.rules(input)                       (no try/catch, no I/O)
llm | http -> cooling off -> return impl.rules(input)   (no call is made)
              try { out = viaLlm | viaHttp }
              out !== undefined -> success; return out
              out === undefined -> failure; warn "module returned something unusable; using rules"
              throw             -> failure; warn "module failed (<first 120 chars of error>); using rules"
              return impl.rules(input)
```

"Failure" is any of: network error, abort/timeout, non-2xx (http), unparseable body, no JSON found in an LLM reply, or `validate` returning `undefined`. A `validate` that throws is also caught because it runs inside the `try`. `impl.rules` is called unguarded: regions must supply rules that never throw (HOOK-FALLBACK-005), because there is no further fallback value of type `O`; `module.test.ts` pins that a throwing `rules` surfaces to the caller on both the `rules` path and the fallback.

### Cool-off (HOOK-COOL-001 to HOOK-COOL-003)

A hosted hook that fails every call still costs a request and still stalls the caller for the timeout. After `HOOK_COOLOFF_AFTER` (5) failures in a row an `llm` or `http` hook is skipped for `HOOK_COOLOFF_MS` (60 s, a monotonic clock): `run` returns the rules result without calling out, and one warn-level entry says the hook is cooling off. When the period ends the next call is a trial; a success resets the streak, a failure starts another cool-off at once. A `rules` hook has nothing to skip. The numbers are constants, not config keys: they protect the show and an operator has no better value to choose.

### Health (HOOK-HEALTH-001 to HOOK-HEALTH-005)

`ping()` asks an `llm` hook's provider whether it answers and remembers the answer (`reachable`); a call's outcome updates the same flag afterwards (success true, failure false). A provider whose ping is nominal (bedrock, `pingIsNominal`) leaves `reachable` unknown rather than claiming success. `pingHooks` pings every non-rules hook once at startup and logs one warning per hook that does not answer. `hookHealth(hooks)` gives a service its heartbeat parts: `mode()` is `mock` while any hook sits on the mock provider and `live` otherwise; `deps()` has one `hook.<name>` entry per non-rules hook, `ok` or `down` once known (`down` also while cooling off) and `n/a` before that. Salience and affect spread these into their heartbeat spec; a hook is a soft dependency (the rules answer when it is down), so it shows as a dependency, not as a failed start.

### The `llm` kind (`viaLlm`)

- Sends two messages: `system` = `spec.system`, `user` = `spec.user(input)`.
- Options: `maxTokens = spec.maxTokens ?? 200`, `temperature: 0`, `json: true` (so providers send no stop sequences and ask for JSON mode where they have one), and the signal of the call's deadline.
- The call runs under `withTimeout(fn, cfg.timeout_ms)`: one `AbortController` whose timer both rejects the call with `timeout after <ms>ms` and aborts the signal handed to the provider. A cooperative provider stops its request when the signal fires; a provider that ignores the signal cannot hold `run()` past the deadline, but its request cannot be cancelled either (HOOK-LLM-004, HOOK-LLM-006).
- The reply goes through `extractJson` then `spec.validate(raw, input)`.
- On Claude, `maxTokens` is honoured down to the API's minimum and no temperature is sent (see model-backends); thinking shares the budget, so a very small hook budget can come back empty and fall back.

### The `http` kind (`viaHttp`)

`POST cfg.url`, `content-type: application/json`, body `JSON.stringify(input)`, under the same `withTimeout` as the `llm` kind, so the deadline covers the connection and reading the body. A non-OK status throws `http <status>`; otherwise the parsed body is passed to `impl.http.validate`. A non-JSON body makes the parse throw, which is a failure like any other. There are no auth headers, no retries, no redirects policy beyond `fetch` defaults, and no content-type check on the response.

### Warning rate limit

`warn()` logs `log.warn({ module: name, kind }, msg)` at most once per 30 s per `Module` instance, measured on the module's monotonic clock (the first failure always logs). The next warning after a suppressed stretch carries the number of fallbacks suppressed since the previous one, so a log reader can see the fallback rate (HOOK-WARN-003: a `suppressed` field on the log entry, present only when the count is above zero). The error text appears only in the message (first 120 characters), not as a structured field. The cool-off entry is separate and not rate limited: it fires once per cool-off.

### Helpers

- `extractJson(text)` returns the first balanced JSON object or array in the text, or `undefined` when there is none (HOOK-HELP-001 to HOOK-HELP-003; `index.ts:104-139`). It scans for each `{` or `[` in order, finds the bracket that closes it while skipping bracket characters inside JSON strings (`balancedEnd`), and returns the first span that `JSON.parse` accepts; a bracketed span that is not JSON (`[events]`) is skipped. So two values in one reply, a bracketed note before the JSON, and a closing bracket or brace in prose after it all still yield the first value (`module.test.ts:196`).
- `clamp(x, lo, hi)` and `isNum(x)` (finite number) are exported for region `validate` functions (`index.ts:148-149`); all three regions use them.

### `ModuleConfig`

The hook's config type has one definition, `z.infer<typeof ModuleSchema>` in `@cohost/config`; `@cohost/modules` re-exports it so `import { Module, type ModuleConfig } from "@cohost/modules"` keeps working (HOOK-CFG-001).

## The HTTP hook contract and the reference server

`examples/modules/server.py` is a dependency-free Python 3 stdlib server (`ThreadingHTTPServer` on `0.0.0.0:8900`, built by `make_server`) that documents the three contracts the regions implement. Contracts are owned by the regions' `validate` functions; they are summarized here because they define what an `http` hook must return.

| Endpoint | Region | Request body | Valid response | Region-side checks |
| --- | --- | --- | --- | --- |
| `POST /salience` | salience | `{events:[{kind: chat or speech or vision, who?, text, mention, isMod, isSub, changed}], arousal}` (`scoring.ts:6-9,13-21`) | `{scores:[0..1,...]}` exactly one per event, in order | array length must equal event count, all finite numbers, then clamped to 0..1 (`scoring.ts:39-43`) |
| `POST /affect` | affect | `{source: chat or speech, who, text, mention, valence, arousal}` (`appraise.ts:5-13`) | `{valence_delta, arousal_delta}` | both finite numbers, clamped to +-0.5 (`appraise.ts:34-38`) |
| `POST /critic` | cortex | `{text, emotion, reason, transcript}` (`critic.ts:5-11`) | `{ok:true}`, `{ok:true,text,emotion?}` or `{ok:false,note}` | `ok` must be boolean; `text` kept if non-blank after trim; `emotion` kept only if in `EMOTIONS`; `note` kept if string (`critic.ts:15-23`) |

The same replies are published as JSON Schema: `HOOK_REPLY_SCHEMAS` in `packages/modules/src/schemas.ts`, written by `scripts/gen-hook-schemas.mjs` to `examples/modules/schemas/{salience,affect,critic}.json` and cited by the example README (HOOK-SCHEMA-001 to HOOK-SCHEMA-003). The validators stay the run-time authority; `schemas.test.ts` checks that every reply a schema accepts the region's validator uses, and every reply of the wrong shape makes the region fall back. A schema cannot say "one score per event", so the validator alone enforces that count.

Implied contract for a server: accept `POST` with a JSON body, answer 2xx with JSON within `timeout_ms` (default 8000; the shipped example config sets the critic to 2500), and treat anything else as "use the rules". Out-of-range numbers are clamped client-side rather than rejected; wrong-length or non-numeric arrays are rejected whole. Scored events are cached by the salience scheduler so an `http`/`llm` scorer is asked once per event (`services/salience/src/scheduler.ts:50-55`).

Reference server behavior (`server.py`):

- Routes: the dict `ROUTES = {"/salience": salience, "/affect": affect, "/critic": critic}` (`:82`); only `do_POST` exists (a `GET` gets the stdlib 501). Routing uses the parsed path alone, so a query string or fragment does not matter (HOOK-EX-008); any other path, including a trailing slash, is a 404 `{"error":"unknown module"}`.
- Any exception while reading, parsing or handling becomes `500 {"error": str(e)}` (`:97-98`), which the TypeScript side treats as a failure and falls back to rules.
- `salience` (`:48-62`): `speech` 0.9, else `mention` 1.0, else `vision` 0.3 if `changed` else 0.0, else 0.15; plus 0.25 (capped at 1.0) if the text matches `GAME_WORDS`. It ignores `who`, `isMod`, `isSub` and `arousal`; it is a toy and differs from the built-in rules (no 0.55 for questions, no 0.35 for mods/subs, no `reply_on_mention` switch; `scoring.ts:24-37`).
- `affect` (`:65-70`): `valence_delta` +0.2 if "love" in text, -0.2 if "hate", else 0; `arousal_delta` 0.25 if `mention` else 0.05. Ignores `source`, current mood and `who`.
- `critic`: `{ok:false, note:"no links on air"}` if the lowercased text contains `http` (so `HTTP://` is blocked too, and so is any word containing it; HOOK-EX-009); otherwise trims to the first sentence and returns `{ok:true, text, emotion}` when that differs from the original, carrying the request's `emotion` (`neutral` when absent; HOOK-EX-010), else `{ok:true}`.
- Empty bodies: a request with `Content-Length: 0` or no `Content-Length` header is read as `{}` (HOOK-EX-006). The handlers then reject the empty object with their own `KeyError`, a 500 that the TypeScript side treats as a failure.
- The server is threaded, one thread per request, so a slow or stalled client does not serialize the three regions' calls (HOOK-EX-007); it binds all interfaces with no auth. `GAME_WORDS` and the salience mention/speech precedence are stand-ins, not a spec.
- The server carries `# @spec HOOK-EX-*` annotations. `packages/modules/test/example-server.test.ts` checks it two ways: every response recorded in `examples/modules/fixtures/contracts.json` must pass the real salience, affect and critic `validate` functions (an `http`-kind `Module` per region, imported from the services' sources; no Python needed), and, when `python3` is installed, the live server must answer the fixture requests with those responses, 404 an unknown path and tolerate an empty body. `docs/TESTING.md:159` describes running it by hand for the `http` kind.

## Configuration read

Per hook, from `ModuleSchema` (`packages/config/src/schema.ts:15-28`): `kind` (blank -> `rules`), `url` (default `""`), `timeout_ms` (default 8000), `llm.provider` / `llm.model` (blank -> inherit). The three hook locations are `brain.salience.module`, `brain.affect.module` and `brain.cortex.critic`. This package reads no environment variables and sets no timers other than the per-call timeout. Operator documentation: `examples/modules/README.md`; its keys, contracts and the timeout default match the schema and the table above. The default is 8000 ms so that a hosted Claude model with thinking can answer; the shipped example config sets the critic to 2500.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Fallback policy | Any failure or unusable answer -> region's built-in rules | Surface errors; skip the event | "Whatever the kind, failure falls back to the rules so the show goes on" (header comment `index.ts:14`); commit `969f6d7` "Any failure falls back to rules". |
| Three kinds behind one class | `rules` / `llm` / `http` in one `Module` | Separate classes per kind | The kind is an operator's config choice, so region code must not change with it: each region builds one `Module` and calls `run()` whatever the kind (`scoring.ts:61`, `appraise.ts:55`, `critic.ts:46`). One class also keeps the shared parts in one place: every kind falls back to the same `rules`, through the same rate-limited warning. Separate classes would push a kind switch into each region. |
| Where logic lives | Region supplies `rules`, prompt and `validate`; package supplies mechanics | Package owns prompts | A hook's judgement depends on its region's input and output types, which only the region knows; the package stays generic over `I` and `O` (`ModuleImpl`, `index.ts:25-32`) and owns only what is the same for every hook: dispatch, timeout, JSON extraction and fallback. Prompts and `validate` functions live beside the rules they replace, in each service, so a change to a region's judgement stays inside that region's segment. |
| LLM output format | Prompted JSON, first balanced JSON value extracted, region validation; `json: true` also asks the backends that have a JSON mode for it | Provider JSON mode alone; tool calls; first-opener-to-last-closer span | Extraction exists because "models love to add prose" (comment `index.ts:104`); `json: true` drops stops in `@cohost/llm` (commit `969f6d7` "JSON calls send no stop sequences") and, where the backend has a schema-free JSON mode (Ollama, OpenAI-compatible), requests it. Owner decision 2026-11-01: the first balanced value, so extra values or brackets in prose do not force a fallback (HOOK-HELP-003). Prompted JSON plus extraction and region validation stays the contract because Claude has no schema-free JSON mode and tool calls differ across the backends a hook can select (Ollama, OpenAI-compatible servers, Claude API, Bedrock); any reply that still fails falls back to rules. |
| Timeout for LLM and http calls | One `AbortController` whose timer rejects the call and aborts the signal | Signal only; a separate signal and promise timer; abandoning the losing request | The abort signal stops the in-flight request on providers that honour it (commit `969f6d7`). The same timer also rejects the promise so `run` settles within the timeout even on a provider that ignores `signal` (HOOK-LLM-004); the region is waiting on that answer, and the fallback to rules is only useful if it comes on time. A signal alone would let one non-cooperative provider stall the region. One controller replaces the earlier signal-plus-timer pair, so the signal is aborted whenever the timer wins; a provider that ignores the signal still cannot be cancelled. |
| LLM determinism | `temperature: 0`, default `maxTokens` 200 | Inherit cortex sampling | A hook is a judgement, not speech: the same input should score, appraise or vet the same way, so `temperature` is 0 rather than the cortex's conversational sampling (`index.ts:76`, HOOK-LLM-003). A hook answer is a small JSON object, so 200 tokens is enough by default and keeps the call short; a hook can set its own `maxTokens`. On the Claude path no temperature is sent, and the hook's `maxTokens` is honoured down to the API minimum (see model-backends). |
| Provider override | Spread cortex `llm` config, override provider/model if set | Separate full llm block per hook | "optionally a different/cheaper one than the cortex uses" (header `index.ts:9-10`); "provider overrides must come with a model" (commit `969f6d7`, enforced at `schema.ts:24-27`). The hook spreads the cortex `llm` block and overrides only provider and model (HOOK-LLM-001, HOOK-LLM-002), so the backend settings (`openai.base_url`, `claude.*`, `bedrock.region`, credentials) are written once and every hook that picks a provider uses the same settings the cortex would for it. A full per-hook block would repeat those settings three more times. The cost is that a hook cannot point at a second server of the same provider kind. |
| Warning rate limit | One warn per 30 s per instance, carrying the count suppressed since the previous warning | Warn every time; drop suppressed warnings silently; a metric | "don't flood the log when a module is down" (comment `index.ts:96`). Owner decision 2026-11-01: include the suppressed count so a permanently broken hook is distinguishable from a noisy one (HOOK-WARN-003). |
| Throwing rules | Precondition: region rules never throw; `run` does not guard them | Catch and rethrow; a second-level default | Owner decision 2026-11-01: there is no fallback value of type `O` to return, so the guarantee belongs to the region (HOOK-FALLBACK-005). |
| Mock-backed hooks | Inherit `mock` only from the top-level provider, always fall back, warn once at construction | Let hooks select `mock`; make mock hooks succeed | Owner decision 2026-11-01: isolated runs are for wiring, not hook quality; explicit `mock` on a hook stays rejected by config (CFG-SCH-009); the warning keeps mock visible (HOOK-WARN-004). |
| Repeated failure | Skip a hook for 60 s after 5 failures in a row, then try once; constants, not config | Retry forever; a config key for the count and period; disable the hook until restart | A dead hosted hook costs a billed request or a stalled caller per call and gains nothing: the rules answer anyway. Five in a row distinguishes an outage from a bad reply, and a trial call after a minute notices recovery without operator action. An operator has no better value to choose, so no key (HOOK-COOL-001 to HOOK-COOL-003). |
| Hook health | `ping()` at startup, call outcomes thereafter, reported as `hook.<name>` heartbeat dependencies and `mode: mock` | A new health topic; failing the service when a hook is down | The heartbeat already carries mode and dependencies, and a down hook leaves the service working on rules, so it is a dependency status, not a failed start (HOOK-HEALTH-001 to HOOK-HEALTH-005). A nominal ping (bedrock) is reported unknown, as cortex does. |
| `ModuleConfig` | One definition in `@cohost/config`, re-exported by `@cohost/modules` | Keep both; move the type into `@cohost/modules` | The type is the schema's output, so it belongs with the schema; the re-export keeps every import from `@cohost/modules` valid (HOOK-CFG-001). |
| Hook timeout default | 8000 ms | 1500 ms; per-provider defaults | A hosted Claude model with thinking usually takes longer than 1500 ms, so every call timed out, fell back and was still billed. One number is chosen because the schema cannot see the provider; operators with a small local model can lower it (HOOK-CFG-002). |
| Reply contract as JSON Schema | Schemas written in `packages/modules/src/schemas.ts`, emitted to `examples/modules/schemas/`, checked against the validators by a test | Generate from the validators; leave the contract in prose | The validators are hand-written functions in three other segments and clamp or ignore as well as check, so a schema cannot be derived from them. The test makes drift fail instead (HOOK-SCHEMA-001 to HOOK-SCHEMA-003). |
| HTTP hook protocol | Plain JSON POST, no auth, no schema negotiation | gRPC; versioned API; authenticated hooks | Owner decision 2026-11-01 (project trust boundary): the operator's LAN is the trust boundary, so an operator-run hook endpoint needs no auth. The stdlib Python example (`server.py:8`) follows from that. |
| Reference server | Toy stand-ins in `examples/`, owned by this segment, threaded, annotated and smoke-tested against the region validators | Real model; untested example | "Replace these bodies with your model" (comment `server.py:43`). Owner decision 2026-11-01: keep HOOK-EX here and test the server so its contracts cannot drift from the validators. |

## Open Questions & Future Decisions

None.

## References

Segment files:
- `packages/modules/src/index.ts`, `packages/modules/src/schemas.ts`
- `packages/modules/test/module.test.ts`, `packages/modules/test/hooks.test.ts`, `packages/modules/test/schemas.test.ts`, `packages/modules/test/example-server.test.ts`
- `scripts/gen-hook-schemas.mjs`, `examples/modules/schemas/`
- `packages/modules/package.json`, `packages/modules/tsconfig.json`
- `examples/modules/README.md`, `examples/modules/server.py`

Other segments:
- model-backends (depends on, outbound): `createChatProvider`, `ChatProvider`, `Config` type from `@cohost/llm`.
- config (depends on, outbound): `Logger` type; `ModuleSchema` fields (`packages/config/src/schema.ts:15-29`) and the three hook config locations.
- salience, affect, cortex (depended on by): each builds one `Module` with its own rules/prompt/validate (`services/salience/src/scoring.ts`, `services/affect/src/appraise.ts`, `services/cortex/src/critic.ts`).
- deployment: `docs/TESTING.md:159` references running `server.py` for the `http` kind.

External: global `fetch`, `AbortController`; Python 3 stdlib (`http.server`) for the example server.

OpenSpec: `openspec/specs/modules/spec.md` (no change delta touches this capability).
