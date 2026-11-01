---
parent: high-level-design
prefix: HOOK
---

# region-hooks

Status: MAPPED 2026-10-31 at git `686cc8f`; every EARS line checked against code and tests on 2026-11-01. Describes what the code does today, not what it should do. See [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

Each brain region has one place where its judgement lives: salience scores events, affect appraises a line of chat or speech, and the cortex critic vets a reply before it is spoken. `@cohost/modules` (`packages/modules/src/index.ts`) is the shared runner for those three "hooks". A hook is a `Module<I, O>` that runs one of three implementations chosen in config (`index.ts:1-15`):

- `rules`: the region's built-in heuristic. Default. Zero latency, no I/O.
- `llm`: ask a chat model for JSON; any `@cohost/llm` provider, optionally a different/cheaper model than the cortex (`index.ts:9-10`).
- `http`: `POST` the hook input as JSON to a URL the operator serves; this is the slot for a self-trained model (`index.ts:11-12`, `examples/modules/`).

The governing rule is the last line of the header: "Whatever the kind, failure falls back to the rules so the show goes on" (`index.ts:14`). A hook can be slow, down, redeployed, or wrong without breaking the stream.

The package has no bus subscriptions, no timers, no state beyond a warning timestamp, and no health surface. It depends on `@cohost/llm` (`createChatProvider`, `ChatProvider`, `Config` type) and `@cohost/config` (`Logger` type) (`index.ts:16-17`, `packages/modules/package.json:11`). The region owns the I/O types, the prompts, the rules and the `validate` functions; this package owns only the dispatch, timeout, parse and fallback mechanics.

Consumers (each in its own segment): `services/salience/src/scoring.ts:61` (`salience.scorer`, called at `scheduler.ts:54`), `services/affect/src/appraise.ts:55` (`affect.appraiser`, called at `affect.ts:96`), `services/cortex/src/critic.ts:44` (`cortex.critic`, called at `cortex.ts:121`).

## The Module runner

```ts
interface ModuleImpl<I, O> {
  rules: (input: I) => O;                                   // always present: the fallback
  llm?:  { system: string; user: (i: I) => string; maxTokens?: number; validate: (raw: unknown, i: I) => O | undefined };
  http?: { validate: (raw: unknown, i: I) => O | undefined };
}
new Module<I, O>(name, cfg /* ModuleSchema */, llmCfg /* cfg.llm */, impl, log)
module.kind   // "rules" | "llm" | "http"
await module.run(input): Promise<O>   // never rejects because of the hook itself
```

(`index.ts:21-34`, `:51-53`.)

### Construction

Constructor-time checks throw synchronously and name the hook (`index.ts:41-48`):

| `cfg.kind` | Requirement | Error |
| --- | --- | --- |
| `rules` | none | none |
| `llm` | `impl.llm` present | `<name>: this hook has no llm implementation` |
| `http` | `impl.http` present and `cfg.url` non-empty | `<name>: this hook has no http implementation` / `<name>: module.kind is http but module.url is empty` |

For `kind: llm` a provider is created once, at construction: `createChatProvider({ ...llmCfg, provider?, model? })` where `provider` and `model` come from `cfg.llm.provider` / `cfg.llm.model` only when truthy (`index.ts:43`). So an `llm` hook inherits the whole cortex `llm` block, including `openai.base_url`, `claude.*` and `bedrock.region`, and overrides only the provider and/or model. A model-only override stays on the inherited provider (`module.test.ts:101`). The config schema, not this package, rejects `llm.provider` without `llm.model` on a hook (`packages/config/src/schema.ts:22-25`). The hook-level provider enum is `ollama`, `openai`, `anthropic`, `bedrock` (`schema.ts:20`), so a hook cannot select `mock` itself; it reaches a hook only by inheritance from the top-level `llm.provider` (`schema.ts:41`). A hook that inherits `mock` gets `"{}"` for every call, which every current region `validate` rejects, so it falls back to rules.

### run()

```
rules -> return impl.rules(input)                       (no try/catch, no I/O)
llm | http -> try { out = viaLlm | viaHttp }
              out !== undefined -> return out
              out === undefined -> warn "module returned something unusable; using rules"
              throw             -> warn "module failed (<first 120 chars of error>); using rules"
              return impl.rules(input)
```

(`index.ts:53-63`.) "Failure" is any of: network error, abort/timeout, non-2xx (http), unparseable body, no JSON found in an LLM reply, or `validate` returning `undefined`. A `validate` that throws is also caught because it runs inside the `try` (`viaLlm`/`viaHttp` are awaited inside it). A throw from `impl.rules` itself is not caught anywhere and propagates to the region.

### The `llm` kind (`viaLlm`, `index.ts:65-75`)

- Sends two messages: `system` = `spec.system`, `user` = `spec.user(input)`.
- Options: `maxTokens = spec.maxTokens ?? 200`, `temperature: 0`, `json: true` (so providers send no stop sequences), and `signal: AbortSignal.timeout(cfg.timeout_ms)`.
- The call is also wrapped in `withTimeout(promise, cfg.timeout_ms)` (`index.ts:67-73`, `:103-109`), a second, independent timer that rejects with `timeout after <ms>ms`. The timeout is therefore enforced twice for this kind: the abort signal cancels cooperative providers (and the mock, which honors an already-aborted signal), while `withTimeout` guarantees `run()` settles even for a provider that ignores the signal. `withTimeout` does not cancel the underlying request.
- The reply goes through `extractJson` then `spec.validate(raw, input)`.
- On Claude, `maxTokens` and `temperature` do not behave as written: the Claude path floors `max_tokens` at `claude.max_tokens` and sends no temperature (see model-backends).

### The `http` kind (`viaHttp`, `index.ts:77-86`)

`POST cfg.url`, `content-type: application/json`, body `JSON.stringify(input)`, `signal: AbortSignal.timeout(cfg.timeout_ms)`. A non-OK status throws `http <status>`; otherwise `res.json()` is passed to `impl.http.validate`. A non-JSON body makes `res.json()` throw, which is a failure like any other. There are no auth headers, no retries, no redirects policy beyond `fetch` defaults, and no content-type check on the response.

### Warning rate limit (`index.ts:88-93`)

`warn()` logs `log.warn({ module: name, kind }, msg)` at most once per 30 s per `Module` instance (`lastWarn` starts at 0 so the first failure always logs). Suppressed warnings are dropped without a count, so a log reader cannot tell how many fallbacks occurred in the window; the error text appears only in the message (first 120 characters), not as a structured field.

### Helpers

- `extractJson(text)`: the regex `/[\[{][\s\S]*[\]}]/` matches from the first `[` or `{` to the LAST `]` or `}` in the text (greedy), then `JSON.parse`; no match or a parse error yields `undefined` (`index.ts:96-101`). The doc comment and OpenSpec both say "first JSON object or array", but with two JSON values in one reply, or with a bracketed note before the JSON, the span covers non-JSON text and parsing fails, so the hook falls back to rules. The same happens when the prose after the JSON contains a closing bracket or brace. Only a single value surrounded by bracket-free prose is exercised by tests (`module.test.ts:16-21`).
- `clamp(x, lo, hi)` and `isNum(x)` (finite number) are exported for region `validate` functions (`index.ts:110-111`); all three regions use them.

### Name collision

`index.ts:19` exports `type ModuleConfig = Config["brain"]["salience"]["module"]` while `packages/config/src/schema.ts:27` also exports `type ModuleConfig = z.infer<typeof ModuleSchema>`. They are structurally the same type (every hook uses `ModuleSchema`, `schema.ts:108,134,150`), but the modules alias is derived from the salience field by accident of convenience and nothing imports either name today (grep over `services` and `packages`).

## The HTTP hook contract and the reference server

`examples/modules/server.py` is a dependency-free Python 3 stdlib server (`HTTPServer` on `0.0.0.0:8900`, `server.py:110-112`) that documents the three contracts the regions implement. Contracts are owned by the regions' `validate` functions; they are summarized here because they define what an `http` hook must return.

| Endpoint | Region | Request body | Valid response | Region-side checks |
| --- | --- | --- | --- | --- |
| `POST /salience` | salience | `{events:[{kind: chat or speech or vision, who?, text, mention, isMod, isSub, changed}], arousal}` (`scoring.ts:6-9,13-21`) | `{scores:[0..1,...]}` exactly one per event, in order | array length must equal event count, all finite numbers, then clamped to 0..1 (`scoring.ts:39-43`) |
| `POST /affect` | affect | `{source: chat or speech, who, text, mention, valence, arousal}` (`appraise.ts:5-13`) | `{valence_delta, arousal_delta}` | both finite numbers, clamped to +-0.5 (`appraise.ts:34-38`) |
| `POST /critic` | cortex | `{text, emotion, reason, transcript}` (`critic.ts:5-11`) | `{ok:true}`, `{ok:true,text,emotion?}` or `{ok:false,note}` | `ok` must be boolean; `text` kept if non-blank after trim; `emotion` kept only if in `EMOTIONS`; `note` kept if string (`critic.ts:15-23`) |

Implied contract for a server: accept `POST` with a JSON body, answer 2xx with JSON within `timeout_ms` (default 1500; the shipped example config sets the critic to 2500, `config/config.example.yaml:122`), and treat anything else as "use the rules". Out-of-range numbers are clamped client-side rather than rejected; wrong-length or non-numeric arrays are rejected whole. Scored events are cached by the salience scheduler so an `http`/`llm` scorer is asked once per event (`services/salience/src/scheduler.ts:50-55`).

Reference server behavior (`server.py`):

- Routes: the dict `ROUTES = {"/salience": salience, "/affect": affect, "/critic": critic}` (`:82`); only `do_POST` exists (a `GET` gets the stdlib 501). `ROUTES.get(self.path)` compares the raw path, so a query string or trailing slash is a 404 `{"error":"unknown module"}` (`:89-91`).
- Any exception while reading, parsing or handling becomes `500 {"error": str(e)}` (`:95-96`), which the TypeScript side treats as a failure and falls back to rules.
- `salience` (`:48-62`): `speech` 0.9, else `mention` 1.0, else `vision` 0.3 if `changed` else 0.0, else 0.15; plus 0.25 (capped at 1.0) if the text matches `GAME_WORDS`. It ignores `who`, `isMod`, `isSub` and `arousal`; it is a toy and differs from the built-in rules (no 0.55 for questions, no 0.35 for mods/subs, no `reply_on_mention` switch; `scoring.ts:24-37`).
- `affect` (`:65-70`): `valence_delta` +0.2 if "love" in text, -0.2 if "hate", else 0; `arousal_delta` 0.25 if `mention` else 0.05. Ignores `source`, current mood and `who`.
- `critic` (`:73-79`): `{ok:false, note:"no links on air"}` if the lowercase substring `http` appears (case-sensitive, so `HTTP://` passes; also matches any word containing it); otherwise trims to the first sentence and returns `{ok:true, text}` when that differs from the original, else `{ok:true}`. It never returns `emotion`.
- Known defects in the reference server: `server.py:93` computes `int(content-length) or b"{}"`, so a request with `Content-Length: 0` (or no `Content-Length` header) passes bytes to `rfile.read()` and raises `TypeError: argument should be integer or None, not 'bytes'` (caught, 500). The `or b"{}"` suggests a default empty-object body was meant. The server is single-threaded (`HTTPServer`, not a threading server), so one slow handler serializes all three regions' calls; it binds all interfaces with no auth. `GAME_WORDS` and the salience mention/speech precedence are stand-ins, not a spec.
- There is no automated test of `server.py`; `docs/TESTING.md:159` describes running it by hand for the `http` kind.

## Configuration read

Per hook, from `ModuleSchema` (`packages/config/src/schema.ts:13-26`): `kind` (blank -> `rules`), `url` (default `""`), `timeout_ms` (default 1500), `llm.provider` / `llm.model` (blank -> inherit). The three hook locations are `brain.salience.module`, `brain.affect.module` and `brain.cortex.critic`. This package reads no environment variables and sets no timers other than the per-call timeout and the 30 s warning window. Operator documentation: `examples/modules/README.md`; its keys and contracts match the schema and the table above, including the note that hosted Claude with thinking usually exceeds the 1500 ms default, which the code handles only by timing out and falling back. One wording mismatch: `README.md:72` says "default 1500 for salience and affect", implying the critic differs, but the schema default is 1500 for all three hooks (`schema.ts:17`, used at `:108`, `:134`, `:150`); only the shipped example config sets the critic to 2500 (`config/config.example.yaml:122`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Fallback policy | Any failure or unusable answer -> region's built-in rules | Surface errors; skip the event | "Whatever the kind, failure falls back to the rules so the show goes on" (header comment `index.ts:14`); commit `969f6d7` "Any failure falls back to rules". |
| Three kinds behind one class | `rules` / `llm` / `http` in one `Module` | Separate classes per kind | `[inferred]` Regions hold one `Module` and call `run()` regardless of kind (`scoring.ts:61`, `appraise.ts:55`, `critic.ts:44`). |
| Where logic lives | Region supplies `rules`, prompt and `validate`; package supplies mechanics | Package owns prompts | `[inferred]` `ModuleImpl` shape (`index.ts:21-28`); prompts live in each service. |
| LLM output format | Prompted JSON, first-opener-to-last-closer extraction, region validation | Provider JSON mode; tool calls | Extraction exists because "models love to add prose" (comment `index.ts:96`); `json: true` merely drops stops in `@cohost/llm` (commit `969f6d7` "JSON calls send no stop sequences"). Not using provider JSON modes is `[inferred]`. |
| Timeout for LLM calls | Abort signal plus a separate promise timer | Signal only | The abort signal was added so "timeouts abort the in-flight request" (commit `969f6d7`, review fixes). Keeping `withTimeout` as a second guard for providers that ignore `signal` is `[inferred]` (`index.ts:67-73`, `:103-109`). |
| LLM determinism | `temperature: 0`, default `maxTokens` 200 | Inherit cortex sampling | `[inferred]` Scoring/appraisal should be repeatable (`index.ts:70`). |
| Provider override | Spread cortex `llm` config, override provider/model if set | Separate full llm block per hook | "optionally a different/cheaper one than the cortex uses" (header `index.ts:9-10`); "provider overrides must come with a model" (commit `969f6d7`, enforced at `schema.ts:22-25`). Spreading the cortex block rather than a full per-hook block is `[inferred]`. |
| Warning rate limit | One warn per 30 s per instance, no counter | Warn every time; metric | "don't flood the log when a module is down" (comment `index.ts:90`). Not counting suppressed warnings is `[inferred]`. |
| HTTP hook protocol | Plain JSON POST, no auth, no schema negotiation | gRPC; versioned API | `[inferred]` Example server is stdlib Python (`server.py:8`); operator-run, trusted network. |
| Reference server | Toy stand-ins in `examples/` | Real model | "Replace these bodies with your model" (comment `server.py:43`). |

## Open Questions & Future Decisions

1. **`extractJson` is not "first".** `/[\[{][\s\S]*[\]}]/` spans first opener to last closer (`index.ts:98`). Two values in one reply, prose containing brackets before the JSON (`"[note] {...}"`), or a stray `]`/`}` in prose after it all yield `undefined` and a fallback. The comment (`:96`) and OpenSpec (`modules § LLM kind behaviour`) say "first JSON object or array"; HOOK-HELP-003 records that intent for the first two cases only. HOOK-HELP-001 is worded to the bracket-free case the code handles. No test covers the failing cases (`module.test.ts:16-21`).
2. **Timeout vs slow models.** `timeout_ms` defaults to 1500 for all hooks (`schema.ts:17`); `examples/modules/README.md:72-76` warns Claude with thinking usually exceeds it, so an `llm`-kind Claude hook can time out on every call, fall back, and still be billed. Nothing in the package detects a hook that has failed N times in a row and stops calling it.
3. **Only warnings reveal fallbacks.** No counter, metric or heartbeat detail exposes the fraction of calls served by rules; suppressed warnings are silent (`index.ts:88-93`). The error is embedded in the message string, truncated to 120 chars.
4. **`impl.rules` throwing is unguarded** (`index.ts:54`, `:62`). Region rules are pure and tested, but a bug in them would propagate out of `run()` into the region loop (salience tick, affect drain, cortex think).
5. **`ModuleConfig` is defined twice** with different derivations (`index.ts:19` vs `packages/config/src/schema.ts:27`); the modules one is keyed off the salience field. Neither is imported anywhere outside its own file.
6. **Hook providers are not pinged or health-checked.** `createChatProvider` is called in the constructor but `ping()` is never called for hook providers; a misconfigured provider fails per call (and then falls back). A wrong `llm.provider: bedrock` or missing Anthropic key is visible only as repeated warnings.
7. **`withTimeout` leaks the losing request.** If the timer wins on a provider that ignores `signal`, the request continues in the background (`index.ts:103-109`). In practice the abort signal fires at the same `timeout_ms`, so only non-cooperative providers are affected.
8. **HTTP hook transport has no auth, TLS policy or response size limit** (`index.ts:78-85`); the reference server binds `0.0.0.0` unauthenticated (`server.py:112`). Reasonable for a local tool; not a statement of intent.
9. **Reference server defects** (`server.py:93` empty-body TypeError, single-threaded `HTTPServer` at `:112`, raw-path routing at `:89`, case-sensitive `http` check at `:76`, critic never returns `emotion` although its docstring example shows one at `:35`). The README presents it as a stand-in with the exact contracts, which holds for shapes but not for the empty-body edge.
10. **Prompts and contracts are split across segments.** The only machine-checked contract is each region's `validate`; `examples/modules/README.md` and `server.py` restate it by hand, so drift is possible (no test exercises the Python server against the TypeScript validators).
11. **Mock-backed `llm` hooks** always receive `"{}"` and therefore always fall back (and warn); this is by design in `mock.ts:16` but means an isolated run never exercises the llm-hook success path. A hook can only inherit `mock` (`schema.ts:20`), so the case arises only when the whole deployment runs on the mock provider.
12. **Untested spec lines.** No test covers: `validate` throwing (HOOK-FALLBACK-004), the warning message text (HOOK-WARN-002), the http request body and header (HOOK-HTTP-001; `module.test.ts:50` never inspects the request), the `maxTokens` default of 200 (HOOK-LLM-003; the test hook sets 30), a provider that ignores `signal` (HOOK-LLM-004), warn recurrence after the 30 s window (HOOK-WARN-001), a mock-backed hook (HOOK-FALLBACK-006), a non-JSON http body, array-rooted JSON through `run`, and every HOOK-EX line (the Python server has no test).
13. **`@spec` coverage of the reference server.** HOOK-EX-001 to HOOK-EX-006 are implemented in `examples/modules/server.py`, which carries no `@spec` annotations; this audit pass did not edit files under `examples/`. Source annotations in `packages/modules/src` are trailing comments so other segments' line citations stay valid.

## References

Segment files:
- `packages/modules/src/index.ts`, `packages/modules/test/module.test.ts`
- `packages/modules/package.json`, `packages/modules/tsconfig.json`
- `examples/modules/README.md`, `examples/modules/server.py`

Other segments:
- model-backends (depends on, outbound): `createChatProvider`, `ChatProvider`, `Config` type from `@cohost/llm`.
- config (depends on, outbound): `Logger` type; `ModuleSchema` fields (`packages/config/src/schema.ts:13-27`) and the three hook config locations.
- salience, affect, cortex (depended on by): each builds one `Module` with its own rules/prompt/validate (`services/salience/src/scoring.ts`, `services/affect/src/appraise.ts`, `services/cortex/src/critic.ts`).
- deployment: `docs/TESTING.md:159` references running `server.py` for the `http` kind.

External: global `fetch`, `AbortSignal.timeout`; Python 3 stdlib (`http.server`) for the example server.

OpenSpec: `openspec/specs/modules/spec.md` (no change delta touches this capability).
