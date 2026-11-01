---
parent: high-level-design
prefix: LLM
---

# model-backends

Status: MAPPED 2026-10-31 at git `686cc8f`. Describes what the code does today, not what it should do. See [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

`@cohost/llm` (`packages/llm`) hides the chat-model backend behind one small interface, `ChatProvider`, so that "use a stronger model" is a config change (`llm.provider`, `llm.model`) rather than a code change (`packages/llm/src/index.ts:1-14`). The regions that talk to a model (cortex, the memory reflect job, and the `llm`-kind hooks built by `region-hooks`) call `chat()` and `ping()` and never learn which vendor is behind them.

Observed principles:

- **One interface, five implementations.** `ollama` (local GPU, the config default), `openai` (any server that speaks `POST /chat/completions`), `anthropic` (Claude API), `bedrock` (Claude on Amazon Bedrock) and `mock` (offline, opt-in only). `index.ts:5-10`, `index.ts:49-57`.
- **Embeddings are decoupled from the chat model.** The header comment says embeddings always come from Ollama so that switching the chat model never changes the vector size of the memory table (`index.ts:12-13`). The one exception is the `mock` provider, which pairs with a 64-dimension hash embedder (`index.ts:59-63`, `mock.ts:26-50`).
- **No retries, no streaming, no tool use.** Every call is a single non-streaming request (`stream: false` at `index.ts:79`, `index.ts:147`). Failures are thrown as `Error` (HTTP providers) or propagate from the SDK (Claude); callers decide what to do (hooks fall back to rules, the cortex waits and retries at the call site).
- **The package is a pure library.** It owns no bus subscriptions, publishes no events, runs no timers, and emits no heartbeat. Its only health surface is `ping()` plus `lastError`, which cortex consumes (`services/cortex/src/startup.ts:22`).

Dependencies: `@cohost/config` (types, `urls.ollama()`), `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk` (`packages/llm/package.json:11-15`). The mock backend lives in `packages/llm/src/mock.ts` and is re-exported from the index (`index.ts:18-20`).

## Provider contract and factory

```ts
interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
interface ChatOptions { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal }
interface ChatProvider { readonly name: string; readonly model: string;
  chat(messages, opts?): Promise<string>; ping(): Promise<boolean>; lastError?: string }
interface Embedder { embed(text: string): Promise<number[]> }
```

(`index.ts:22-42`.) `chat()` resolves to the trimmed reply text. `json: true` means "a JSON reply is wanted, do not send stop sequences" (`index.ts:26`); it does not switch on any vendor JSON mode (no `format`, `response_format` or prefill is sent anywhere). `signal` aborts the in-flight request and exists for hook timeouts (`index.ts:28`).

`createChatProvider(cfg.llm)` is a `switch` over `cfg.provider` with no default branch; it relies on the config enum for exhaustiveness (`index.ts:49-57`). `createEmbedder(cfg.llm)` returns `new HashEmbedder()` for `mock` and `new Ollama(cfg)` for every other provider (`index.ts:60-63`).

| Provider (`name`) | Class | Chat endpoint | Auth | Stops on reply calls | `ping()` |
| --- | --- | --- | --- | --- | --- |
| `ollama` | `Ollama` (`index.ts:68`) | `POST ${OLLAMA_URL}/api/chat` | none | `REPLY_STOPS` in `options.stop` | `GET /api/tags` |
| `openai` | `OpenAICompatible` (`index.ts:125`) | `POST ${base_url}/chat/completions` | `Authorization: Bearer` only if `openai.api_key` non-empty | `REPLY_STOPS` in `stop` | `GET ${base_url}/models` |
| `anthropic` | `AnthropicProvider` (`index.ts:216`) | SDK `beta.messages.create` | `claude.api_key`, else SDK default (`ANTHROPIC_API_KEY` or a profile) | `TRANSCRIPT_STOPS` as `stop_sequences` | `models.retrieve(model)` |
| `bedrock` | `BedrockProvider` (`index.ts:241`) | SDK `beta.messages.create` via `AnthropicBedrockMantle` | AWS credential chain, region from `bedrock.region` if set | `TRANSCRIPT_STOPS` | always `true` |
| `mock` | `MockProvider` (`mock.ts:8`) | none (no I/O) | none | n/a | always `true` |

Ollama specifics: body carries `model`, `messages`, `stream:false`, `keep_alive:"24h"` and `options` with `temperature`, `num_ctx` (from config), `num_predict` (from `opts.maxTokens ?? max_tokens`) (`index.ts:77-88`). The base URL is `urls.ollama()` evaluated as a default constructor argument, i.e. `OLLAMA_URL` or `http://127.0.0.1:11434` (`index.ts:71`, `packages/config/src/index.ts:159`). Non-2xx throws `ollama chat <status>: <body>` (`index.ts:91`). A missing `message.content` yields `""` (`index.ts:93`).

OpenAI-compatible specifics: trailing slashes are stripped from `base_url` once at construction (`index.ts:131`); `temperature` and `max_tokens` default from config (`index.ts:148-149`); non-2xx throws `openai chat <status>: <body>` (`index.ts:154`); `choices[0].message.content` null or missing yields `""` (`index.ts:156`).

Class-level facts: `ClaudeBase` is not exported; tests reach into the protected `client` field by cast (`llm.test.ts:125`, `:192`, `:206`).

## Stop sequences and the transcript coupling

Two constants drive truncation (`index.ts:44-47`):

- `TRANSCRIPT_STOPS = ["\n[chat]", "\n[voice]", "\n[screen]"]` - "the model started writing the next transcript entry".
- `REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]` - a blank line also ends a spoken reply. The comment states "Exactly four entries: OpenAI-style APIs reject more than four stops" (`index.ts:46`).

Behavior matrix:

| Call | Ollama / OpenAI | Claude (Anthropic and Bedrock) |
| --- | --- | --- |
| reply (`json` not true) | `REPLY_STOPS` (4 entries) | `TRANSCRIPT_STOPS` (3 entries, no `"\n\n"`) |
| `json: true` | no stop key at all | no `stop_sequences` key |

The Claude path deliberately omits `"\n\n"`; the test comment says "thinking-era replies may use it" (`llm.test.ts:174`).

The coupling to working-memory is implicit and string-based. `Context.transcript()` renders `[chat] user: text`, `[voice] speaker: text`, `[screen] text`, and the co-host's own line as `Name: [emotion] text` (`packages/working-memory/src/index.ts:93-96`). The stop strings are exactly the first three tag prefixes. The self-line format is not covered by any stop, so a model that continues the transcript with its own next line is not truncated. Nothing in the repo links the two lists mechanically; `packages/working-memory` has a test that pins the tag format, and `llm.test.ts:26` pins the stop list, but a change to one does not fail the other.

## The Claude path (Anthropic API and Bedrock)

`ClaudeBase.chat` (`index.ts:185-210`) is shared; subclasses differ in client, ping, and whether server-side fallbacks are enabled.

1. **Messages.** All `system` messages are joined with `"\n\n"` into the `system` field (omitted when empty); the rest become turns. If there are no turns, or the first is not `user`, a `user` turn with content `(begin)` is prepended (`index.ts:186-190`).
2. **Token budget.** `max_tokens = Math.max(opts.maxTokens ?? 0, claude.max_tokens)` (default 2048, minimum 256 per schema `packages/config/src/schema.ts:61`). Callers can raise the cap but never lower it below `claude.max_tokens`, because thinking and text share the budget (`index.ts:172-175`, `index.ts:192`).
3. **Effort and sampling.** `output_config: { effort: claude.effort }` (default `low`); no `temperature` is ever sent, so `opts.temperature` and `llm.temperature` are ignored for Claude (`index.ts:198`, schema comment `schema.ts:45`).
4. **Stop sequences.** `TRANSCRIPT_STOPS` unless `json` (`index.ts:199`).
5. **Server-side fallbacks.** When `serverFallbacks` is true the request adds `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. `AnthropicProvider` sets this from `claude.fallbacks` (default `true`); `BedrockProvider` hard-codes `false` (`index.ts:202`, `:224`, `:244`). The beta header string, the `fallbacks: "default"` field and the `AnthropicBedrockMantle` class could not be verified from the repository (see Open Questions).
6. **Refusal.** If `res.stop_reason === "refusal"` the method returns `""` ("say nothing") (`index.ts:204`).
7. **Reply assembly.** Only `text` blocks are kept, concatenated and trimmed; `thinking` blocks are dropped (`index.ts:205-209`, `llm.test.ts:128`).
8. **Abort.** `opts.signal` is passed as the SDK request option (`index.ts:203`).

`AnthropicProvider` builds `new Anthropic({ apiKey })` only when `claude.api_key` is non-empty, else `new Anthropic({})` (`index.ts:223`). `BedrockProvider` builds `new AnthropicBedrockMantle({ awsRegion })` only when `bedrock.region` is non-empty (`index.ts:248`); the schema comment claims an empty region falls back to `AWS_REGION` / `AWS_DEFAULT_REGION` (`schema.ts:66`), which is SDK behavior not asserted here.

## Health ping semantics

`ping()` answers "is the backend reachable and answering"; on `false`, `lastError` says why. A successful ping clears `lastError`.

- **Ollama:** `GET /api/tags`; non-OK sets `ollama <status> at <base>`; a thrown fetch error sets `cannot reach ollama at <base>: <err>` (`index.ts:110-116`).
- **OpenAI-compatible:** `GET <base>/models` with the same headers; non-OK sets `<base>/models answered <status>` plus ` (check llm.openai.api_key)` on 401/403; thrown error sets `cannot reach <base>: <err>` (`index.ts:160-166`).
- **Anthropic:** `client.models.retrieve(model)`; on failure the SDK error's `status` selects `Claude API rejected the credentials (<status>): check ANTHROPIC_API_KEY` (401/403), `Claude API has no model "<model>": check llm.model` (404), or `String(err)` (`index.ts:226-238`).
- **Bedrock:** always `true`; the comment says there is no cheap probe and errors surface on the first chat (`index.ts:250`).
- **Mock:** always `true`, `lastError` stays undefined (`mock.ts:23`).

Consumers: cortex blocks startup in a 3-second retry loop until `ping()` is true, reporting each miss through `heartbeat.degraded` (`services/cortex/src/startup.ts:19-33`, owned by `cortex`); memory pings only an `Ollama` instance for its embeddings (`services/memory/src/index.ts:35-41`, owned by `memory`). Because Bedrock always reports reachable, a bad Bedrock credential or un-enabled model shows as a healthy `llm` dependency and fails only on the first `chat()`.

## Embeddings and the mock backend

`Ollama.embed` POSTs `{model: embed_model, input, keep_alive:"24h"}` to `/api/embed`, returns `embeddings[0]`, and throws `ollama embed <status>: <body>` on non-OK or `ollama embed returned no vector` when the array is empty (`index.ts:96-107`).

`HashEmbedder` (`mock.ts:39-50`): lowercases, tokenizes with `/[\p{L}\p{N}]+/gu`, hashes each token with 32-bit FNV-1a into one of `HASH_DIMS = 64` buckets with a +1/-1 sign taken from bit 16, then L2-normalises. Empty or token-free text yields the unit vector e0 so downstream cosine math never sees NaN. It is deterministic and dependency-free.

`MockProvider` (`mock.ts:8-24`): throws `mock chat aborted` if the signal is already aborted; returns `"{}"` for `json: true` (valid JSON, which `region-hooks` validation rejects, so mock-backed `llm` hooks always fall back to rules); otherwise returns `[happy] mock: <last user message, whitespace-collapsed, first 80 chars, or "hello">`, in the `[emotion] text` format cortex parses. It sleeps for nothing and does no I/O.

Who actually builds embedders: no service calls `createEmbedder`. `services/memory/src/backend.ts:7-9` switches on its own key `brain.memory.embedder` (`ollama` or `hash`), constructing `HashEmbedder` or `Ollama` directly. So the package's "mock provider implies hash embedder" rule is exercised only by tests (`llm.test.ts:249-254`); in a deployment, isolation of memory depends on `MEMORY_EMBEDDER=hash` being set separately (the `memory` segment owns that key).

## Configuration read

From `cfg.llm` (`packages/config/src/schema.ts:39-69`): `provider`, `model`, `num_ctx` (Ollama only, `index.ts:84`), `temperature` (Ollama/OpenAI only), `max_tokens` (Ollama/OpenAI reply cap; the Claude path uses its own), `embed_model`, `openai.base_url`, `openai.api_key`, `claude.api_key`, `claude.effort`, `claude.max_tokens`, `claude.fallbacks`, `bedrock.region`. Environment: `OLLAMA_URL` via `urls.ollama()`; `ANTHROPIC_API_KEY` and AWS credentials are resolved inside the SDKs, not by this package. Operator-facing recipes are in `examples/providers/README.md`; they match the schema keys. `scripts/dev/stub-llm.ts` is a separate fake Ollama server (`GET /api/tags`, `POST /api/chat`; `:11434` or `STUB_LLM_PORT`; no `/api/embed`, ignores stop sequences) used for local runs without a GPU; it is superseded for cortex by `llm.provider: mock` but still documented in `docs/TESTING.md:130`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Backend abstraction | Single `ChatProvider` interface with five concrete classes | Per-region vendor code; a generic LLM framework | `[inferred]` Header comment says a stronger model must be a config change, not a code change (`index.ts:1-4`). |
| Embedding source | Always Ollama, except `mock` -> `HashEmbedder` | Embed with the chat vendor; per-provider embedders | `[inferred]` Switching chat model must not change memory vector size (`index.ts:12-13`, `schema.ts:35-38`); hash embedder added so isolated runs need no Ollama (`mock.ts:1-3`). |
| Reply truncation | Client-side stop sequences, `"\n\n"` plus transcript tags | Prompt-only instructions; max-length cut | `[inferred]` Models continue the transcript format; stops cut at the next entry (`index.ts:44-47`). |
| Stop count | Exactly four on Ollama/OpenAI | More stops | `[inferred]` OpenAI-style APIs reject more than four (`index.ts:46`). |
| Claude reply stops | Transcript stops only, no `"\n\n"` | Reuse `REPLY_STOPS` | `[inferred]` Thinking-era replies may contain blank lines (`llm.test.ts:174`). |
| `json: true` | Drop stop sequences, nothing else | Vendor JSON modes; keep stops | `[inferred]` A blank line or transcript tag inside JSON would truncate it (`index.ts:26`); JSON extraction is left to the caller (`region-hooks`). |
| Claude token cap | `max(opts.maxTokens, claude.max_tokens)` | Honor caller cap | `[inferred]` Thinking and text share `max_tokens` (`index.ts:172-175`, `schema.ts:60`). |
| Claude effort | Config value, default `low` | Fixed effort | `[inferred]` The prompt asks for one line (`index.ts:174-175`, `schema.ts:58`). |
| Refusal handling | Return `""` | Throw; retry | `[inferred]` "a refusal just means say nothing" (`index.ts:201`, `llm.test.ts:184`). |
| Server-side fallbacks | On for `anthropic` (config-gated), never on `bedrock` | On everywhere | `[inferred]` Comment: not offered on Bedrock (`index.ts:200-201`, `:244`). |
| Bedrock ping | Always `true` | Probe via a tiny call | `[inferred]` "no cheap probe on Bedrock" (`index.ts:250`). |
| Mock default | Opt-in only; never selected unless configured | Fall back to mock when no backend | `[inferred]` "never a default" (`index.ts:10`, `mock.ts:3`, `schema.ts:40`). |
| Mock JSON reply | `"{}"` | Realistic hook JSON | `[inferred]` `{}` is valid JSON and makes hooks fall back to rules (`mock.ts:16`). |
| Hash dimensionality | 64 dims, FNV-1a, signed buckets | Larger vectors; real embeddings | `[inferred]` Cheap deterministic stand-in (`mock.ts:26`, `:35-38`). |
| HTTP client | Global `fetch`, no retry/backoff | HTTP library; retries | `[inferred]` Minimal clients per the comment at `index.ts:67`; no retry code exists anywhere in the package. |

## Open Questions & Future Decisions

1. **Unverifiable Claude/Bedrock surface.** The beta header `server-side-fallback-2026-07-01`, the request field `fallbacks: "default"` and the `AnthropicBedrockMantle` class from `@anthropic-ai/bedrock-sdk` (`index.ts:16`, `:202`, `:248`) cannot be confirmed or refuted from the repository; tests only assert that the code sends them (`llm.test.ts:177-178`). This mapping makes no claim about whether they exist in the SDK or API. The SDK versions `^1.1.0` / `^1.0.0` (`package.json:12-13`) were not checked against a registry.
2. **No request timeouts.** Ollama/OpenAI `chat()` and `ping()` call `fetch` with no timeout unless the caller passes `signal` (`index.ts:74`, `:112`, `:141`, `:162`); cortex calls `llm.chat(messages)` with no signal (`services/cortex/src/cortex.ts:116`) and `waitForLlm` pings with none, so a black-holed host can hang a call indefinitely. Claude calls inherit whatever default timeout/retry behavior the SDK has; not configured here.
3. **Bedrock ping is optimistic.** `index.ts:250` always returns `true`, so heartbeat `deps.llm` reads `ok` for bad credentials, a wrong region, or a model not enabled in the console. Contrast with Anthropic's real probe (`index.ts:228`). Spec'd as intentional by OpenSpec; flagged as a design weakness.
4. **`createEmbedder` is dead in production.** No service calls it (`services/memory/src/backend.ts:7-9` re-implements the choice via `brain.memory.embedder`); only tests do (`llm.test.ts:63`, `:250-252`). The OpenSpec rule "mock provider -> hash embedder" is therefore not what isolates memory in a running system. Also, nothing guards pairing `HashEmbedder` (64-d) with the Postgres pgvector table sized for the Ollama embed model.
5. **Mock reporting is partial.** OpenSpec requires services using the mock provider to log a startup warning and report heartbeat `mode: mock` (`openspec/changes/add-isolated-backends/specs/llm/spec.md`, "Mock is reported, not hidden"). Cortex does both (`services/cortex/src/index.ts:34`, `services/cortex/src/health.ts:5`). `services/memory/src/reflect.ts:17` and `llm`-kind hooks (`packages/modules/src/index.ts:43`) build a mock provider with no warning. The package itself logs nothing.
6. **Stop list vs transcript coupling is unenforced.** See "Stop sequences..." above: stops duplicate working-memory tag prefixes by hand (`index.ts:45` vs `packages/working-memory/src/index.ts:93-95`), and the co-host self-line `Name: [emotion] text` is not a stop (`working-memory/src/index.ts:96`).
7. **`opts.maxTokens` is a floor, not a cap, on Claude.** Hooks pass `maxTokens` 60-160 (`services/affect/src/appraise.ts:50`, `services/cortex/src/critic.ts:39`) and get 2048 (`index.ts:192`); with `effort: low` this is probably fine but means hook calls on Claude carry a large budget and ignore `temperature: 0`.
8. **`json` is only "no stops".** No provider requests structured output; a reply with surrounding prose is tolerated only because `region-hooks` extracts JSON greedily. For Ollama and OpenAI the `num_predict` / `max_tokens` cap (config default 120, `schema.ts:48`) can truncate a JSON reply mid-object.
9. **Provider recipe drift.** `examples/providers/README.md:86` suggests `AWS_PROFILE` with a mounted `~/.aws`, but `docker-compose.yml:21-22` mounts only `./config`, so that recipe may not work in Docker; owned by `deployment`, noted here because the doc lives in this segment.
10. **Style debt.** `lastError` is declared between methods in `Ollama` and `OpenAICompatible` (`index.ts:109`, `:159`) and on `ClaudeBase` (`:212`) while the `ChatProvider` interface marks it optional; tests mutate a private field by cast and share module-level `lastBody`/`status` across tests (`llm.test.ts:10-11`, `:125`).
11. **Test coverage gaps.** No test constructs a real SDK client call; the Anthropic ping hint for non-401/403/404 statuses is only covered by status 500 (`llm.test.ts:193`); `Ollama.chat` `num_ctx`/`num_predict`/`keep_alive` body fields are not asserted; the mock-JSON-through-Module fallback is not tested in this package.

## References

Segment files:
- `packages/llm/src/index.ts`, `packages/llm/src/mock.ts`
- `packages/llm/test/llm.test.ts`
- `packages/llm/package.json`, `packages/llm/tsconfig.json`
- `examples/providers/README.md` (operator recipes)
- `scripts/dev/stub-llm.ts` (fake Ollama server; reference only)

Other segments:
- config (depends on, outbound): `Config["llm"]` schema (`packages/config/src/schema.ts:39-69`), `urls.ollama()`.
- region-hooks (depended on by): builds providers for `llm`-kind hooks (`packages/modules/src/index.ts:43`).
- cortex (depended on by): `createChatProvider`, `ping()` (`services/cortex/src/index.ts:28`, `startup.ts:22`).
- memory (depended on by): `Ollama` / `HashEmbedder` / `createChatProvider` (`services/memory/src/backend.ts:2`, `reflect.ts:11`).
- working-memory (implicit coupling): transcript tags vs stop sequences.
- control-plane: cortex heartbeat `mode`/`deps.llm` derives from provider and ping (`services/cortex/src/health.ts:5`).

External: `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`; Ollama (`/api/chat`, `/api/embed`, `/api/tags`); OpenAI-style `/v1/chat/completions` and `/v1/models`; Amazon Bedrock.

OpenSpec: `openspec/specs/llm/spec.md`; `openspec/changes/add-isolated-backends/specs/llm/spec.md` (MODIFIED factory and embedder; ADDED mock provider, hash embedder, "Mock is reported, not hidden").
