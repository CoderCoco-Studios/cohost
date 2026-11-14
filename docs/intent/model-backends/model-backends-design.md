---
parent: high-level-design
prefix: LLM
---

# model-backends

Status: AUDITED; every spec is `[x]`. Describes the intended design. See [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

`@cohost/llm` (`packages/llm`) hides the chat-model backend behind one small interface, `ChatProvider`, so that "use a stronger model" is a config change (`llm.provider`, `llm.model`) rather than a code change (`packages/llm/src/index.ts`). The regions that talk to a model (cortex, the memory reflect job, and the `llm`-kind hooks built by `region-hooks`) call `chat()` and `ping()` and never learn which vendor is behind them.

Observed principles:

- **One interface, five implementations.** `ollama` (local GPU, the config default), `openai` (any server that speaks `POST /chat/completions`), `anthropic` (Claude API), `bedrock` (Claude on Amazon Bedrock) and `mock` (offline, opt-in only). `index.ts`, `index.ts`.
- **Embeddings are decoupled from the chat model.** The header comment says embeddings always come from Ollama so that switching the chat model never changes the vector size of the memory table (`index.ts:12-13`). The one exception is the `mock` provider, which pairs with a 64-dimension hash embedder (`index.ts:71-75`, `mock.ts:26-50`).
- **No retries, no streaming, no tool use.** Every call is a single non-streaming request (`stream: false` at `index.ts`, `index.ts`). Failures are thrown as `Error` (HTTP providers) or propagate from the SDK (Claude); callers decide what to do (hooks fall back to rules, the cortex waits and retries at the call site).
- **Every request is bounded.** A caller's `AbortSignal` cancels a request; without one, the default timeout `llm.timeout_ms` (default 60000 ms, CFG-SCH-013) applies to chat, embed and ping, so a black-holed backend fails a call rather than hanging it. `requestSignal` returns the caller's signal when there is one and `AbortSignal.timeout(llm.timeout_ms)` otherwise; the Claude path passes the SDK request option `timeout` instead of a signal (LLM-CHAT-008). The package reads `llm.timeout_ms` directly from the config object it is given; the config schema always supplies it.
- **The package is a pure library.** It owns no bus subscriptions, publishes no events, runs no timers, and emits no heartbeat. Its only health surface is `ping()` plus `lastError`, which cortex consumes (`services/cortex/src/startup.ts`).

Dependencies: `@cohost/config` (types, `urls.ollama()`), `@cohost/working-memory` (`TRANSCRIPT_TAGS`), `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk` (`packages/llm/package.json`). The mock backend lives in `packages/llm/src/mock.ts` and is re-exported from the index (`index.ts`).

## Provider contract and factory

```ts
interface ChatMessage { role: "system" | "user" | "assistant"; content: string; images?: string[] }  // base64 images for a vision model (LLM-VIS-001)
interface ChatOptions { maxTokens?: number; temperature?: number; json?: boolean; signal?: AbortSignal }
interface ChatProvider { readonly name: string; readonly model: string;
  chat(messages, opts?): Promise<string>; ping(): Promise<boolean>; lastError?: string;
  readonly pingIsNominal?: boolean }  // true only on bedrock: ping() is not a probe (LLM-PING-006)
interface Embedder { embed(text: string): Promise<number[]> }
```

(`index.ts`.) `chat()` resolves to the trimmed reply text. `json: true` means "a JSON reply is wanted": no stop sequences are sent and, where the backend has a schema-free JSON mode, it is requested: Ollama `format: "json"` and OpenAI-compatible `response_format: {type: "json_object"}` (LLM-CHAT-010). Claude has none, so its reply is parsed by the caller; the token cap can still truncate a JSON reply mid-object, which the caller treats as unusable. `signal` aborts the in-flight request and exists for hook timeouts (`index.ts`).

`createChatProvider(cfg.llm)` is a `switch` over `cfg.provider` with no default branch; it relies on the config enum for exhaustiveness. `createEmbedder(cfg.llm)` returns `new HashEmbedder()` for `mock` and `new Ollama(cfg)` for every other provider (`index.ts:72-75`).

| Provider (`name`) | Class | Chat endpoint | Auth | Stops on reply calls | `ping()` |
| --- | --- | --- | --- | --- | --- |
| `ollama` | `Ollama` (`index.ts`) | `POST ${OLLAMA_URL}/api/chat` | none | `REPLY_STOPS` in `options.stop` | `GET /api/tags` |
| `openai` | `OpenAICompatible` (`index.ts`) | `POST ${base_url}/chat/completions` | `Authorization: Bearer` only if `openai.api_key` non-empty | `REPLY_STOPS` in `stop` | `GET ${base_url}/models` |
| `anthropic` | `AnthropicProvider` (`index.ts`) | SDK `beta.messages.create` | `claude.api_key`, else SDK default (`ANTHROPIC_API_KEY` or a profile) | `TRANSCRIPT_STOPS` as `stop_sequences` | `models.retrieve(model)` |
| `bedrock` | `BedrockProvider` (`index.ts`) | SDK `beta.messages.create` via `AnthropicBedrockMantle` | AWS credential chain, region from `bedrock.region` if set | `TRANSCRIPT_STOPS` | always `true` |
| `mock` | `MockProvider` (`mock.ts`) | none (no I/O) | none | n/a | always `true` |

Ollama specifics: body carries `model`, `messages`, `stream:false`, `keep_alive:"24h"` and `options` with `temperature`, `num_ctx` (from config), `num_predict` (from `opts.maxTokens ?? max_tokens`) (`index.ts`). The base URL is `urls.ollama()` evaluated as a default constructor argument, i.e. `OLLAMA_URL` or `http://127.0.0.1:11434` (`index.ts`, `packages/config/src/index.ts`). Non-2xx throws `ollama chat <status>: <body>` (`index.ts`). A missing `message.content` yields `""` (`index.ts`).

OpenAI-compatible specifics: trailing slashes are stripped from `base_url` once at construction (`index.ts`); `temperature` and `max_tokens` default from config (`index.ts`); non-2xx throws `openai chat <status>: <body>` (`index.ts`); `choices[0].message.content` null or missing yields `""` (`index.ts`).

Class-level facts: `ClaudeBase` is not exported; tests reach into the protected `client` field by cast (`llm.test.ts`).

## Stop sequences and the transcript coupling

Two constants drive truncation (`index.ts`):

- `TRANSCRIPT_STOPS` = `"\n"` followed by each tag in working-memory's `TRANSCRIPT_TAGS` (`"\n[chat]"`, `"\n[voice]"`, `"\n[screen]"` today), derived rather than copied (LLM-STOP-007): "the model started writing the next transcript entry".
- `REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]` - a blank line also ends a spoken reply. The comment states "Exactly four entries: OpenAI-style APIs reject more than four stops" (`index.ts`).

Behavior matrix:

| Call | Ollama / OpenAI | Claude (Anthropic and Bedrock) |
| --- | --- | --- |
| reply (`json` not true) | `REPLY_STOPS` (4 entries) | `TRANSCRIPT_STOPS` (3 entries, no `"\n\n"`) |
| `json: true` | no stop key at all | no `stop_sequences` key |

The Claude path deliberately omits `"\n\n"`; the test comment says "thinking-era replies may use it" (`llm.test.ts`).

The coupling to working-memory is string-based. working-memory owns the tag list (WM-TRANS-006); working-memory exports it as `TRANSCRIPT_TAGS` (WM-TRANS-009) and this segment's `TRANSCRIPT_STOPS` is derived from it (LLM-STOP-006, LLM-STOP-007). End to end, the contract has four parts, two of them owned by other segments:

1. **Producer (working-memory).** `Context.transcript(name)` renders one line per event, oldest first, joined with `"\n"`: `[chat] <user>[ (mod)]: <text>`, `[voice] <speaker>: <text>`, `[screen] <text>`, and the co-host's own lines as `<name>: [<emotion>] <text>` (`packages/working-memory/src/index.ts`). Field values are interpolated unescaped.
2. **Framing (cortex).** `buildMessages` puts the transcript in the user turn after `## Recent transcript\n` and ends that turn with a nudge whose last token is `<name>:` (`services/cortex/src/prompt.ts`); the system turn asks for one short line that starts with an emotion tag (`prompt.ts`). The model is therefore primed to continue the transcript as the co-host.
3. **Stops (this segment).** Each `TRANSCRIPT_STOPS` entry is a tag prefix preceded by `"\n"`, so a stop fires only when the generated text contains a newline followed by `[chat]`, `[voice]` or `[screen]`; a reply that itself begins with a tag is not cut. Ollama and OpenAI-compatible calls also stop at the first blank line (`REPLY_STOPS`); Claude calls do not. `json: true` calls send no stops at all.
4. **Consumer (cortex).** `parseReply` trims the reply, keeps only its first line, and strips a leading `Name:` in front of the emotion tag (`services/cortex/src/prompt.ts`), so everything after the first newline is discarded whether or not a provider stop fired.

Rules that follow:

- The stops are a token and latency saver. Correctness of the spoken line rests on `parseReply`'s first-line rule in cortex, which holds whether or not a provider stop fired.
- The self-line form `<name>: [<emotion>] text` is not a stop. A model that runs past its own line into another `<name>:` line is cut by `parseReply` after the extra tokens are generated; the four-stop cap (`index.ts`) leaves no room for a fifth entry, and the first-line rule already guards the output.
- The literals are linked by a cortex-level test that renders a transcript with working-memory and checks every line after the first against the stop list (owned by the cortex segment); `llm.test.ts` pins the stop list and `packages/working-memory/test/context.test.ts` pins the tags.
- A new transcript line kind added to working-memory needs a matching stop here; adding it to `REPLY_STOPS` would exceed the four-stop limit (`index.ts`), so such a change revisits the `"\n\n"` entry or accepts that the new kind is cut only by `parseReply`.

## The Claude path (Anthropic API and Bedrock)

`ClaudeBase.chat` (`index.ts`) is shared; subclasses differ in client, ping, and whether server-side fallbacks are enabled.

1. **Messages.** All `system` messages are joined with `"\n\n"` into the `system` field (omitted when empty); the rest become turns. If there are no turns, or the first is not `user`, a `user` turn with content `(begin)` is prepended (`index.ts`).
2. **Token budget.** `max_tokens` is the caller's `maxTokens` when given (raised to 1, the API minimum), else `claude.max_tokens` (default 2048, minimum 256 per schema). Thinking and text share the budget, so a hook that names a very small one can get an empty reply and fall back to its rules (LLM-CLAUDE-003).
3. **Effort and sampling.** `output_config: { effort: claude.effort }` (default `low`); no `temperature` is ever sent, so `opts.temperature` and `llm.temperature` are ignored for Claude (`index.ts`, schema comment `schema.ts`).
4. **Stop sequences.** `TRANSCRIPT_STOPS` unless `json` (`index.ts`).
5. **Server-side fallbacks.** When `serverFallbacks` is true the request adds `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. `AnthropicProvider` sets this from `claude.fallbacks` (default `true`); `BedrockProvider` hard-codes `false` (`index.ts`). The installed, lockfile-pinned SDKs type all three: `@anthropic-ai/sdk` 1.8.0 lists `server-side-fallback-2026-07-01` in `AnthropicBeta` and types `fallbacks` as `Array<BetaFallbackParam> | 'default'`, and `@anthropic-ai/bedrock-sdk` 1.1.2 exports `AnthropicBedrockMantle` with an optional `awsRegion`; `tsc -b` compiles the request against those types. An opt-in live smoke test (LLM-CLAUDE-013) pings and completes one chat when `ANTHROPIC_API_KEY` and `COHOST_LIVE_CLAUDE_MODEL` are set.
6. **Refusal.** If `res.stop_reason === "refusal"` the method returns `""` ("say nothing") (`index.ts`).
7. **Reply assembly.** Only `text` blocks are kept, concatenated and trimmed; `thinking` blocks are dropped (`index.ts`, `llm.test.ts`).
8. **Abort.** `opts.signal` is passed as the SDK request option (`index.ts`).

`AnthropicProvider` builds `new Anthropic({ apiKey })` only when `claude.api_key` is non-empty, else `new Anthropic({})` (`index.ts`). `BedrockProvider` builds `new AnthropicBedrockMantle({ awsRegion })` only when `bedrock.region` is non-empty (`index.ts`); an empty region leaves the SDK to resolve it from the environment (`AWS_REGION`); `backends.test.ts` asserts that a provider built with an empty region and `AWS_REGION` set completes a chat.

## Health ping semantics

`ping()` answers "is the backend reachable and answering"; on `false`, `lastError` says why. A successful ping clears `lastError`.

- **Ollama:** `GET /api/tags`; non-OK sets `ollama <status> at <base>`; a thrown fetch error sets `cannot reach ollama at <base>: <err>` (`index.ts`).
- **OpenAI-compatible:** `GET <base>/models` with the same headers; non-OK sets `<base>/models answered <status>` plus ` (check llm.openai.api_key)` on 401/403; thrown error sets `cannot reach <base>: <err>` (`index.ts`).
- **Anthropic:** `client.models.retrieve(model)`; on failure the SDK error's `status` selects `Claude API rejected the credentials (<status>): check ANTHROPIC_API_KEY` (401/403), `Claude API has no model "<model>": check llm.model` (404), or `String(err)` (`index.ts`).
- **Bedrock:** always `true`, and the provider exposes `pingIsNominal = true` so a caller can tell the answer is not a probe (LLM-PING-006); the comment says there is no cheap probe and errors surface on the first chat (`index.ts`).
- **Mock:** always `true`, `lastError` stays undefined (`mock.ts`).

Consumers: cortex blocks startup in a 3-second retry loop until `ping()` is true (`services/cortex/src/startup.ts`, owned by `cortex`), reporting each miss through `heartbeat.degraded` via the `onDown` callback wired at `services/cortex/src/main.ts`; memory pings only an `Ollama` instance for its embeddings (`services/memory/src/startup.ts`, owned by `memory`). Because Bedrock always reports reachable, a bad Bedrock credential or un-enabled model would show as a healthy `llm` dependency and fail only on the first `chat()`; the Bedrock ping stays optimistic, and cortex states that it is unprobed in its heartbeat `detail` (cortex segment).

## Embeddings and the mock backend

`Ollama.embed` POSTs `{model: embed_model, input, keep_alive:"24h"}` to `/api/embed`, returns `embeddings[0]`, and throws `ollama embed <status>: <body>` on non-OK or `ollama embed returned no vector` when the array is empty (`index.ts`).

`HashEmbedder` (`mock.ts`): lowercases, tokenizes with `/[\p{L}\p{N}]+/gu`, hashes each token with 32-bit FNV-1a into one of `HASH_DIMS = 64` buckets with a +1/-1 sign taken from bit 16, then L2-normalises. Empty or token-free text yields the unit vector e0 so downstream cosine math never sees NaN. It is deterministic and dependency-free.

`MockProvider` (`mock.ts`): throws `mock chat aborted` if the signal is already aborted; returns `"{}"` for `json: true` (valid JSON that the salience, affect and critic `validate` functions all reject, so mock-backed `llm` hooks always fall back to rules); otherwise returns `[happy] mock: <last user message, whitespace-collapsed, first 80 chars, or "hello">`, in the `[emotion] text` format cortex parses. It sleeps for nothing and does no I/O.

Who builds embedders: memory, not this package. `services/memory/src/backend.ts` switches on its own key `brain.memory.embedder` (`ollama` or `hash`), constructing `HashEmbedder` or `Ollama` directly, so a mock chat provider leaves memory on the Ollama embedder unless `MEMORY_EMBEDDER=hash` is set as well (LLM-EMBED-004; the `memory` segment owns that key). The separate switch avoids a silently offline memory: "Memory always uses the real Ollama embedder unless `MEMORY_EMBEDDER=hash`, even with `LLM_PROVIDER=mock` (deliberate, avoids silent offline)" (commit `51d5a9c`). `createEmbedder`'s "mock implies hash" rule (LLM-EMBED-003) is exercised only by tests (`llm.test.ts:267-272`).

## Configuration read

From `cfg.llm` (`packages/config/src/schema.ts`): `provider`, `model`, `num_ctx` (Ollama only, `index.ts`), `temperature` (Ollama/OpenAI only), `max_tokens` (Ollama/OpenAI reply cap; the Claude path uses its own), `embed_model`, `openai.base_url`, `openai.api_key`, `claude.api_key`, `claude.effort`, `claude.max_tokens`, `claude.fallbacks`, `bedrock.region`. Environment: `OLLAMA_URL` via `urls.ollama()`; `ANTHROPIC_API_KEY` and AWS credentials are resolved inside the SDKs, not by this package. Operator-facing recipes are in `examples/providers/README.md`; their keys exist in the schema (`schema.ts`). `scripts/dev/stub-llm.ts` is a separate fake Ollama server (`GET /api/tags`, `POST /api/chat`; `:11434` or `STUB_LLM_PORT`; no `/api/embed`; ignores `stop`, `options` and `json`; always replies `Stub brain here. You said: <tail>`, which carries no emotion tag and is not JSON) used for local runs without a GPU. `docs/TESTING.md` documents the stub and the offline `LLM_PROVIDER=mock` setting.

## Hash embedder users

`HashEmbedder` is the one deterministic offline embedder: memory's hash mode on Postgres and memory's in-memory store both embed with it (memory MEM-BACKEND-003, MEM-BACKEND-004), and no other package carries a hasher of its own.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Backend abstraction | Single `ChatProvider` interface with five concrete classes | Per-region vendor code; a generic LLM framework | A stronger model must be "a config change, not a code change" (header comment `index.ts`); commit `969f6d7` ("Make the chat model pluggable"). |
| Embedding source | Always Ollama, except `mock` -> `HashEmbedder` | Embed with the chat vendor; per-provider embedders | "Embeddings always come from Ollama: they're cheap, and switching the chat model must not change the vector size of the memory table" (`index.ts:12-13`; same wording in commit `969f6d7`). Hash embedder for isolated runs (`mock.ts:1-3`, commit `51d5a9c`). Memory keeps its own `brain.memory.embedder` switch: owner decision 2026-11-01, a mock chat provider must not silently take memory offline (commit `51d5a9c`). |
| Reply truncation | Client-side stop sequences, `"\n\n"` plus transcript tags, as a token and latency saver | Stops as the correctness guard; prompt-only instructions; max-length cut | Stops mark "the model started writing the next transcript entry" and "Blank line ends a spoken reply" (comments `index.ts`). Owner decision 2026-11-01: the guard for the spoken line is cortex's first-line parse; stops only cut generation early. |
| Tag list ownership | working-memory owns the transcript tags and exports them; `TRANSCRIPT_STOPS` is derived from the export; a cortex-level test checks rendered lines against the stops | A third shared-constants package; this segment owns the tags and working-memory mirrors them | Owner decision 2026-11-01: the segment that renders the lines owns their format; the check lives where both meet (cortex). |
| Self line as a stop | Not a stop | Add `\n<name>:` | Owner decision 2026-11-01: the four-stop cap leaves no room and `parseReply` already drops everything after the first line. |
| Stop count | Exactly four on Ollama/OpenAI | More stops | "OpenAI-style APIs reject more than four stops" (comment `index.ts`). |
| Claude reply stops | Transcript stops only, no `"\n\n"` | Reuse `REPLY_STOPS` | "thinking-era replies may use it" (test comment `llm.test.ts`). |
| `json: true` | Drop stop sequences and request the backend's JSON mode where it has one (Ollama, OpenAI-compatible) | Stops dropped only; tool calls or prefill for Claude; keep stops | "a blank line or a transcript tag inside JSON would truncate it" (comment `index.ts`); commit `969f6d7` "JSON calls send no stop sequences". Ollama `format` and OpenAI `response_format` are cheap to request and make a well-formed object likely; Claude has no schema-free equivalent without tools or prefill, so its path stays prompt-and-extract, as does the caller's validation for every backend (`region-hooks` extracts the first balanced value, the region validates it, an unusable reply falls back to rules). `json_object` mode requires an object root and a prompt that mentions JSON; every current hook asks for an object. A server that rejects `response_format` fails the call and the hook falls back. 
| Claude token cap | The caller's `maxTokens` when given (minimum 1), else `claude.max_tokens` | `max(opts.maxTokens, claude.max_tokens)` as a floor; a larger floor for hooks | `max_tokens` caps thinking + text together, so the cortex's reply, which names no budget, gets the roomy `claude.max_tokens`. A hook names its own small budget (60 to 160) and gets it: the floor made every hook call carry 2048 tokens and ignore the budget the hook chose. Effort stays low, so thinking is short; a budget too small for any text yields an empty reply and the hook's rules answer (LLM-CLAUDE-003). |
| SDK versions | `@anthropic-ai/sdk` 1.8.0 and `@anthropic-ai/bedrock-sdk` 1.1.2, upgraded after a registry check; Claude and Bedrock paths tested through the real clients against recorded fixtures; an opt-in live smoke test | Stay on the older lockfile versions; mock the client object in tests; call the live API in CI | Casting a recorder over the client proved only that the code sends what it thinks it sends. Replaying recorded responses through the SDK checks the request and response on the wire, with no network and no key (LLM-CLAUDE-011, LLM-CLAUDE-012); the live test runs only when an operator supplies a key and a model (LLM-CLAUDE-013). |
| Claude effort | Config value, default `low` | Fixed effort | "keeps effort low — the prompt asks for one line" (comment `index.ts`); commit `969f6d7` "a configurable effort level defaulting to low". |
| Refusal handling | Return `""` | Throw; retry | "a refusal just means 'say nothing'" (comment `index.ts`). |
| Server-side fallbacks | On for `anthropic` (config-gated), never on `bedrock` | On everywhere | "Not offered on Bedrock" (comment `index.ts`); commit `969f6d7` "server-side refusal fallbacks on the Claude API". |
| Bedrock ping | Always `true`; cortex flags the unprobed backend in its heartbeat `detail` | Probe via a tiny call | "no cheap probe on Bedrock; errors surface on first chat" (comment `index.ts`). Owner decision 2026-11-01: keep it, and make the optimism visible to the operator. |
| Request timeouts | Config-driven default timeout (`llm.timeout_ms`, which the config schema defaults to 60000) when the caller passes no signal (LLM-CHAT-008) | Caller-supplied signals only; no timeout; a package-local constant with no config key | Owner decision 2026-11-01: a black-holed backend must fail a call, not hang the region. |
| Mock announcement | Each consumer that builds a mock provider warns once (cortex, hooks, reflect) | The package logs on construction; silent mock | Owner decision 2026-11-01: mock is never hidden; the warning belongs to the consumer that knows its context (LLM-MOCK-005). |
| Mock default | Opt-in only; never selected unless configured | Fall back to mock when no backend | "never a default" (`index.ts`, `mock.ts`, `schema.ts`); commit `51d5a9c` "Mock is never the default". |
| Mock JSON reply | `"{}"` | Realistic hook JSON | "{} is valid and makes them fall back to their rules" (comment `mock.ts`). |
| Hash dimensionality | 64 dims, FNV-1a, signed buckets | Larger vectors; real embeddings | The hash embedder is a deterministic, dependency-free stand-in for isolated runs (`mock.ts`), not a similarity model (LLM-EMBED-005). 64 dimensions keep the vectors and the pgvector column small while giving short test texts few full collisions; the exact size carries no meaning, because memory sizes its table from the embedder's output and refuses to start on a mismatch with an existing table (memory segment, `services/memory/src/store.ts`). A real embedding model is what the Ollama embedder is for. |
| Hash similarity | An expectation, not a guarantee (LLM-EMBED-005) | Guarantee shared-token ordering with more buckets | Owner decision 2026-11-01: the hash embedder is an isolated-run stand-in, not a similarity model. |
| HTTP client | Global `fetch`; no retry or backoff in this package's own code (LLM-CHAT-009). The Claude and Bedrock paths go through the SDK, whose built-in default of 2 retries is left unconfigured (`index.ts`) | HTTP library; retries and backoff on Ollama and OpenAI-compatible calls | Owner decision 2026-11-08: accept no retry. A failed call rejects `chat()` once (LLM-CHAT-005, LLM-CHAT-008) and each caller already has a defined failure path. cortex's `think` catches it, logs `think failed` and returns to `idle`; the next focus starts a fresh think (CTX-GATE-007), and `trackLlm` feeds the failure into the heartbeat, so `deps.llm` reads `down` until a later reply succeeds (CTX-HEALTH-003). Hooks fall back to their `rules` implementation (HOOK-FALLBACK-002). The memory reflect job logs `reflect failed`, exits 1 and leaves the cursor in place for the next run (MEM-REFLECT-009). Retries are deferred because the supported backends are local (Ollama, OpenAI-compatible servers on the LAN or localhost) and fail fast, and a retry would hold the cortex's single think slot and delay a live reply that may already be stale. Revisit if a backend proves flaky in practice. |

## Open Questions & Future Decisions

None.

## References

Segment files:
- `packages/llm/src/index.ts`, `packages/llm/src/mock.ts`
- `packages/llm/test/llm.test.ts`, `packages/llm/test/backends.test.ts`, `packages/llm/test/fixtures/` (recorded Claude and Bedrock responses)
- `packages/llm/package.json`, `packages/llm/tsconfig.json`
- `examples/providers/README.md` (operator recipes)
- `scripts/dev/stub-llm.ts` (fake Ollama server; reference only)

Other segments:
- config (depends on, outbound): `Config["llm"]` schema (`packages/config/src/schema.ts`), `urls.ollama()`.
- region-hooks (depended on by): builds providers for `llm`-kind hooks (`packages/modules/src/index.ts`).
- cortex (depended on by): `createChatProvider`, `ping()` (`services/cortex/src/main.ts`, `startup.ts`).
- memory (depended on by): `Ollama` / `HashEmbedder` / `createChatProvider` (`services/memory/src/backend.ts`, `reflect.ts`).
- working-memory (implicit coupling): transcript tags vs stop sequences.
- control-plane: cortex heartbeat `mode`/`deps.llm` derives from provider and ping (`services/cortex/src/health.ts`).

External: `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`; Ollama (`/api/chat`, `/api/embed`, `/api/tags`); OpenAI-style `/v1/chat/completions` and `/v1/models`; Amazon Bedrock.
