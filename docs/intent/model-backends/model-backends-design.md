---
parent: high-level-design
prefix: LLM
---

# model-backends

Status: MAPPED 2026-10-31 at git `686cc8f`; every EARS line checked against code and tests on 2026-11-01. Describes what the code does today, not what it should do. See [high-level-design](../../high-level-design.md).

## Context and Design Philosophy

`@cohost/llm` (`packages/llm`) hides the chat-model backend behind one small interface, `ChatProvider`, so that "use a stronger model" is a config change (`llm.provider`, `llm.model`) rather than a code change (`packages/llm/src/index.ts:1-14`). The regions that talk to a model (cortex, the memory reflect job, and the `llm`-kind hooks built by `region-hooks`) call `chat()` and `ping()` and never learn which vendor is behind them.

Observed principles:

- **One interface, five implementations.** `ollama` (local GPU, the config default), `openai` (any server that speaks `POST /chat/completions`), `anthropic` (Claude API), `bedrock` (Claude on Amazon Bedrock) and `mock` (offline, opt-in only). `index.ts:5-10`, `index.ts:49-57`.
- **Embeddings are decoupled from the chat model.** The header comment says embeddings always come from Ollama so that switching the chat model never changes the vector size of the memory table (`index.ts:12-13`). The one exception is the `mock` provider, which pairs with a 64-dimension hash embedder (`index.ts:59-63`, `mock.ts:26-50`).
- **No retries, no streaming, no tool use.** Every call is a single non-streaming request (`stream: false` at `index.ts:79`, `index.ts:147`). Failures are thrown as `Error` (HTTP providers) or propagate from the SDK (Claude); callers decide what to do (hooks fall back to rules, the cortex waits and retries at the call site).
- **The package is a pure library.** It owns no bus subscriptions, publishes no events, runs no timers, and emits no heartbeat. Its only health surface is `ping()` plus `lastError`, which cortex consumes (`services/cortex/src/startup.ts:22`, `:25-26`).

Dependencies: `@cohost/config` (types, `urls.ollama()`), `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk` (`packages/llm/package.json:12-16`). The mock backend lives in `packages/llm/src/mock.ts` and is re-exported from the index (`index.ts:18-20`).

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

Class-level facts: `ClaudeBase` is not exported; tests reach into the protected `client` field by cast (`llm.test.ts:132`, `:205`, `:220`).

## Stop sequences and the transcript coupling

Two constants drive truncation (`index.ts:44-47`):

- `TRANSCRIPT_STOPS = ["\n[chat]", "\n[voice]", "\n[screen]"]` - "the model started writing the next transcript entry".
- `REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]` - a blank line also ends a spoken reply. The comment states "Exactly four entries: OpenAI-style APIs reject more than four stops" (`index.ts:46`).

Behavior matrix:

| Call | Ollama / OpenAI | Claude (Anthropic and Bedrock) |
| --- | --- | --- |
| reply (`json` not true) | `REPLY_STOPS` (4 entries) | `TRANSCRIPT_STOPS` (3 entries, no `"\n\n"`) |
| `json: true` | no stop key at all | no `stop_sequences` key |

The Claude path deliberately omits `"\n\n"`; the test comment says "thinking-era replies may use it" (`llm.test.ts:185`).

The coupling to working-memory is implicit and string-based. End to end, the contract the code implements has four parts, two of them owned by other segments:

1. **Producer (working-memory).** `Context.transcript(name)` renders one line per event, oldest first, joined with `"\n"`: `[chat] <user>[ (mod)]: <text>`, `[voice] <speaker>: <text>`, `[screen] <text>`, and the co-host's own lines as `<name>: [<emotion>] <text>` (`packages/working-memory/src/index.ts:89-100`). Field values are interpolated unescaped.
2. **Framing (cortex).** `buildMessages` puts the transcript in the user turn after `## Recent transcript\n` and ends that turn with a nudge whose last token is `<name>:` (`services/cortex/src/prompt.ts:47`, `:58-67`); the system turn asks for one short line that starts with an emotion tag (`prompt.ts:36-37`). The model is therefore primed to continue the transcript as the co-host.
3. **Stops (this segment).** Each `TRANSCRIPT_STOPS` entry is a tag prefix preceded by `"\n"`, so a stop fires only when the generated text contains a newline followed by `[chat]`, `[voice]` or `[screen]`; a reply that itself begins with a tag is not cut. Ollama and OpenAI-compatible calls also stop at the first blank line (`REPLY_STOPS`); Claude calls do not. `json: true` calls send no stops at all.
4. **Consumer (cortex).** `parseReply` trims the reply, keeps only its first line, and strips a leading `Name:` in front of the emotion tag (`services/cortex/src/prompt.ts:71-72`), so everything after the first newline is discarded whether or not a provider stop fired.

What follows from the code as written:

- The self-line form `<name>: [<emotion>] text` is not a stop. A model that runs past its own line into another `<name>:` line is cut by `parseReply`, not by the provider, after the extra tokens have been generated and billed.
- The stops save tokens and latency on the reply path; correctness of the spoken line rests on `parseReply`'s first-line rule. Whether the stops are also meant as a correctness guard is not recorded anywhere.
- The two lists are linked by nothing but matching literals: `llm.test.ts:27` pins the stop list, `packages/working-memory/test/context.test.ts:86` pins the tags, and no test imports both packages. The same invariant is specified twice, as LLM-STOP-006 here and WM-TRANS-006 in working-memory.
- A new transcript line kind added to working-memory without a stop here would not be cut on any provider, and adding it to `REPLY_STOPS` would exceed the four-stop limit (`index.ts:46`).

## The Claude path (Anthropic API and Bedrock)

`ClaudeBase.chat` (`index.ts:185-210`) is shared; subclasses differ in client, ping, and whether server-side fallbacks are enabled.

1. **Messages.** All `system` messages are joined with `"\n\n"` into the `system` field (omitted when empty); the rest become turns. If there are no turns, or the first is not `user`, a `user` turn with content `(begin)` is prepended (`index.ts:186-190`).
2. **Token budget.** `max_tokens = Math.max(opts.maxTokens ?? 0, claude.max_tokens)` (default 2048, minimum 256 per schema `packages/config/src/schema.ts:61`). Callers can raise the cap but never lower it below `claude.max_tokens`, because thinking and text share the budget (`index.ts:172-175`, `index.ts:192`).
3. **Effort and sampling.** `output_config: { effort: claude.effort }` (default `low`); no `temperature` is ever sent, so `opts.temperature` and `llm.temperature` are ignored for Claude (`index.ts:198`, schema comment `schema.ts:45`).
4. **Stop sequences.** `TRANSCRIPT_STOPS` unless `json` (`index.ts:199`).
5. **Server-side fallbacks.** When `serverFallbacks` is true the request adds `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. `AnthropicProvider` sets this from `claude.fallbacks` (default `true`); `BedrockProvider` hard-codes `false` (`index.ts:202`, `:224`, `:244`). The installed, lockfile-pinned SDKs type all three: `@anthropic-ai/sdk` 1.1.0 lists `server-side-fallback-2026-07-01` in `AnthropicBeta` and types `fallbacks` as `Array<BetaFallbackParam> | 'default'`, and `@anthropic-ai/bedrock-sdk` 1.0.0 exports `AnthropicBedrockMantle` with an optional `awsRegion`; `tsc -b` compiles the request against those types. No test calls the live API (see Open Questions).
6. **Refusal.** If `res.stop_reason === "refusal"` the method returns `""` ("say nothing") (`index.ts:204`).
7. **Reply assembly.** Only `text` blocks are kept, concatenated and trimmed; `thinking` blocks are dropped (`index.ts:205-209`, `llm.test.ts:135`).
8. **Abort.** `opts.signal` is passed as the SDK request option (`index.ts:203`).

`AnthropicProvider` builds `new Anthropic({ apiKey })` only when `claude.api_key` is non-empty, else `new Anthropic({})` (`index.ts:223`). `BedrockProvider` builds `new AnthropicBedrockMantle({ awsRegion })` only when `bedrock.region` is non-empty (`index.ts:248`); the schema comment claims an empty region falls back to `AWS_REGION` / `AWS_DEFAULT_REGION` (`schema.ts:66`), which is SDK behavior not asserted here.

## Health ping semantics

`ping()` answers "is the backend reachable and answering"; on `false`, `lastError` says why. A successful ping clears `lastError`.

- **Ollama:** `GET /api/tags`; non-OK sets `ollama <status> at <base>`; a thrown fetch error sets `cannot reach ollama at <base>: <err>` (`index.ts:110-116`).
- **OpenAI-compatible:** `GET <base>/models` with the same headers; non-OK sets `<base>/models answered <status>` plus ` (check llm.openai.api_key)` on 401/403; thrown error sets `cannot reach <base>: <err>` (`index.ts:160-166`).
- **Anthropic:** `client.models.retrieve(model)`; on failure the SDK error's `status` selects `Claude API rejected the credentials (<status>): check ANTHROPIC_API_KEY` (401/403), `Claude API has no model "<model>": check llm.model` (404), or `String(err)` (`index.ts:226-238`).
- **Bedrock:** always `true`; the comment says there is no cheap probe and errors surface on the first chat (`index.ts:250`).
- **Mock:** always `true`, `lastError` stays undefined (`mock.ts:23`).

Consumers: cortex blocks startup in a 3-second retry loop until `ping()` is true (`services/cortex/src/startup.ts:19-30`, owned by `cortex`), reporting each miss through `heartbeat.degraded` via the `onDown` callback wired at `services/cortex/src/index.ts:34`; memory pings only an `Ollama` instance for its embeddings (`services/memory/src/index.ts:35-41`, owned by `memory`). Because Bedrock always reports reachable, a bad Bedrock credential or un-enabled model shows as a healthy `llm` dependency and fails only on the first `chat()`.

## Embeddings and the mock backend

`Ollama.embed` POSTs `{model: embed_model, input, keep_alive:"24h"}` to `/api/embed`, returns `embeddings[0]`, and throws `ollama embed <status>: <body>` on non-OK or `ollama embed returned no vector` when the array is empty (`index.ts:96-107`).

`HashEmbedder` (`mock.ts:39-50`): lowercases, tokenizes with `/[\p{L}\p{N}]+/gu`, hashes each token with 32-bit FNV-1a into one of `HASH_DIMS = 64` buckets with a +1/-1 sign taken from bit 16, then L2-normalises. Empty or token-free text yields the unit vector e0 so downstream cosine math never sees NaN. It is deterministic and dependency-free.

`MockProvider` (`mock.ts:8-24`): throws `mock chat aborted` if the signal is already aborted; returns `"{}"` for `json: true` (valid JSON that the salience, affect and critic `validate` functions all reject, so mock-backed `llm` hooks always fall back to rules); otherwise returns `[happy] mock: <last user message, whitespace-collapsed, first 80 chars, or "hello">`, in the `[emotion] text` format cortex parses. It sleeps for nothing and does no I/O.

Who actually builds embedders: no service calls `createEmbedder`. `services/memory/src/backend.ts:7-9` switches on its own key `brain.memory.embedder` (`ollama` or `hash`), constructing `HashEmbedder` or `Ollama` directly. So the package's "mock provider implies hash embedder" rule is exercised only by tests (`llm.test.ts:267-272`); in a deployment, isolation of memory depends on `MEMORY_EMBEDDER=hash` being set separately (the `memory` segment owns that key). The PR that added the mock backend records the separate switch as deliberate: "Memory always uses the real Ollama embedder unless `MEMORY_EMBEDDER=hash`, even with `LLM_PROVIDER=mock` (deliberate, avoids silent offline)" (commit `51d5a9c`). That note and LLM-EMBED-004 disagree; see Open Questions.

## Configuration read

From `cfg.llm` (`packages/config/src/schema.ts:39-69`): `provider`, `model`, `num_ctx` (Ollama only, `index.ts:84`), `temperature` (Ollama/OpenAI only), `max_tokens` (Ollama/OpenAI reply cap; the Claude path uses its own), `embed_model`, `openai.base_url`, `openai.api_key`, `claude.api_key`, `claude.effort`, `claude.max_tokens`, `claude.fallbacks`, `bedrock.region`. Environment: `OLLAMA_URL` via `urls.ollama()`; `ANTHROPIC_API_KEY` and AWS credentials are resolved inside the SDKs, not by this package. Operator-facing recipes are in `examples/providers/README.md`; their keys exist in the schema (`schema.ts:39-69`). `scripts/dev/stub-llm.ts` is a separate fake Ollama server (`GET /api/tags`, `POST /api/chat`; `:11434` or `STUB_LLM_PORT`; no `/api/embed`; ignores `stop`, `options` and `json`; always replies `Stub brain here. You said: <tail>`, which carries no emotion tag and is not JSON) used for local runs without a GPU. `docs/TESTING.md:130` documents the stub and never mentions `llm.provider: mock`.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Backend abstraction | Single `ChatProvider` interface with five concrete classes | Per-region vendor code; a generic LLM framework | A stronger model must be "a config change, not a code change" (header comment `index.ts:1-4`); commit `969f6d7` ("Make the chat model pluggable"). |
| Embedding source | Always Ollama, except `mock` -> `HashEmbedder` | Embed with the chat vendor; per-provider embedders | "Embeddings always come from Ollama: they're cheap, and switching the chat model must not change the vector size of the memory table" (`index.ts:12-13`; same wording in commit `969f6d7`). Hash embedder for isolated runs (`mock.ts:1-3`, commit `51d5a9c`). Memory keeps its own switch on purpose (commit `51d5a9c`, see Open Question 4). |
| Reply truncation | Client-side stop sequences, `"\n\n"` plus transcript tags | Prompt-only instructions; max-length cut | Stops mark "the model started writing the next transcript entry" and "Blank line ends a spoken reply" (comments `index.ts:44`, `:46`). The rejected alternatives are `[inferred]`. |
| Stop count | Exactly four on Ollama/OpenAI | More stops | "OpenAI-style APIs reject more than four stops" (comment `index.ts:46`). |
| Claude reply stops | Transcript stops only, no `"\n\n"` | Reuse `REPLY_STOPS` | "thinking-era replies may use it" (test comment `llm.test.ts:185`). |
| `json: true` | Drop stop sequences, nothing else | Vendor JSON modes; keep stops | "a blank line or a transcript tag inside JSON would truncate it" (comment `index.ts:26`); commit `969f6d7` "JSON calls send no stop sequences". Not using vendor JSON modes is `[inferred]`. |
| Claude token cap | `max(opts.maxTokens, claude.max_tokens)` | Honor caller cap | "`max_tokens` caps thinking + text together, so this path uses its own, roomier `max_tokens`" (comment `index.ts:172-175`; commit `969f6d7`). |
| Claude effort | Config value, default `low` | Fixed effort | "keeps effort low — the prompt asks for one line" (comment `index.ts:175`); commit `969f6d7` "a configurable effort level defaulting to low". |
| Refusal handling | Return `""` | Throw; retry | "a refusal just means 'say nothing'" (comment `index.ts:201`). |
| Server-side fallbacks | On for `anthropic` (config-gated), never on `bedrock` | On everywhere | "Not offered on Bedrock" (comment `index.ts:200-201`); commit `969f6d7` "server-side refusal fallbacks on the Claude API". |
| Bedrock ping | Always `true` | Probe via a tiny call | "no cheap probe on Bedrock; errors surface on first chat" (comment `index.ts:250`). |
| Mock default | Opt-in only; never selected unless configured | Fall back to mock when no backend | "never a default" (`index.ts:10`, `mock.ts:3`, `schema.ts:40`); commit `51d5a9c` "Mock is never the default". |
| Mock JSON reply | `"{}"` | Realistic hook JSON | "{} is valid and makes them fall back to their rules" (comment `mock.ts:16`). |
| Hash dimensionality | 64 dims, FNV-1a, signed buckets | Larger vectors; real embeddings | `[inferred]` Cheap deterministic stand-in (`mock.ts:1-3`, `:35-38`); nothing records why 64. |
| HTTP client | Global `fetch`, no retry/backoff | HTTP library; retries | `[inferred]` No retry code exists anywhere in the package; nothing records the choice. |

## Open Questions & Future Decisions

1. **Claude/Bedrock surface is typed, not exercised.** The beta header `server-side-fallback-2026-07-01`, the request field `fallbacks: "default"`, `output_config` and the `AnthropicBedrockMantle` class (`index.ts:16`, `:198`, `:202`, `:248`) all exist in the lockfile-pinned SDK types (`@anthropic-ai/sdk` 1.1.0: `resources/beta/beta.d.ts:52`, `resources/beta/messages/messages.d.ts:3964`, `:4032`, `:7094`; `@anthropic-ai/bedrock-sdk` 1.0.0: `mantle-client.d.ts:70`), and `tsc -b` compiles the request. Tests only assert that the code sends them (`llm.test.ts:188-189`); no test calls the live Claude API or Bedrock. The registry has newer releases (`@anthropic-ai/sdk` 1.3.0, `@anthropic-ai/bedrock-sdk` 1.1.0 on 2026-11-01) inside the declared `^` ranges (`package.json:13-14`); the lockfile holds the older ones.
2. **No request timeouts.** Ollama/OpenAI `chat()` and `ping()` call `fetch` with no timeout unless the caller passes `signal` (`index.ts:74`, `:112`, `:141`, `:162`); cortex calls `llm.chat(messages)` with no signal (`services/cortex/src/cortex.ts:116`) and `waitForLlm` pings with none, so a black-holed host can hang a call indefinitely. Claude calls inherit whatever default timeout/retry behavior the SDK has; not configured here.
3. **Bedrock ping is optimistic.** `index.ts:250` always returns `true`, so heartbeat `deps.llm` reads `ok` for bad credentials, a wrong region, or a model not enabled in the console. Contrast with Anthropic's real probe (`index.ts:228`). The code comment states the reason (no cheap probe); whether an optimistic `ok` is acceptable is undecided.
4. **`createEmbedder` is unused in production, and two sources disagree about whether it should be.** No service calls it; only tests do (`llm.test.ts:68`, `:268-270`). Memory chooses its embedder from `brain.memory.embedder` (`services/memory/src/backend.ts:8`). OpenSpec (`add-isolated-backends`, "Embeddings are always Ollama") and LLM-EMBED-004 say a mock provider implies the hash embedder and Ollama is never contacted; `config/config.example.yaml:18` describes mock as "deterministic offline replies + hash embeddings"; but commit `51d5a9c` calls memory's separate `MEMORY_EMBEDDER` switch "deliberate, avoids silent offline". Nothing guards pairing `HashEmbedder` (64-d) with a Postgres pgvector table sized for the Ollama embed model.
5. **Mock reporting is partial.** OpenSpec requires services using the mock provider to log a startup warning and report heartbeat `mode: mock` ("Mock is reported, not hidden"). Cortex does both (`services/cortex/src/index.ts:33` warns; `:27` and `services/cortex/src/health.ts:5` set `mode`). The memory reflect script (`services/memory/src/reflect.ts:17`, a one-shot with no heartbeat) and `llm`-kind hooks (`packages/modules/src/index.ts:43`) build a mock provider with no warning, and the salience and affect heartbeats hard-code `mode: "live"` (`services/salience/src/health.ts:4`, `services/affect/src/health.ts:4`). Commit `51d5a9c` lists the hooks case as a "possible follow-up". The package itself logs nothing.
6. **Stop list vs transcript coupling is unenforced.** See "Stop sequences and the transcript coupling": the stops duplicate working-memory tag prefixes by hand (`index.ts:45` vs `packages/working-memory/src/index.ts:93-95`), the co-host self-line `Name: [emotion] text` is not a stop (`packages/working-memory/src/index.ts:96`), and the invariant is specified in two segments (LLM-STOP-006, WM-TRANS-006). Which segment owns the tag list, and whether the self line should be a stop, are not recorded.
7. **`opts.maxTokens` is a floor, not a cap, on Claude.** Hooks pass `maxTokens` 60-160 (`services/affect/src/appraise.ts:50`, `services/cortex/src/critic.ts:39`) and get 2048 (`index.ts:192`); with `effort: low` this is probably fine but means hook calls on Claude carry a large budget and ignore `temperature: 0`.
8. **`json` is only "no stops".** No provider requests structured output; a reply with surrounding prose is tolerated only because `region-hooks` extracts JSON with a first-opener-to-last-closer regex. For Ollama and OpenAI the `num_predict` / `max_tokens` cap (config default 120, `schema.ts:48`) can truncate a JSON reply mid-object.
9. **Provider recipe drift.** `examples/providers/README.md:86` suggests `AWS_PROFILE` with a mounted `~/.aws`, but `docker-compose.yml:21-22` mounts only `./config` (no compose file mounts `~/.aws`), so that recipe may not work in Docker; `examples/providers/README.md:96` names the hook override `brain.<region>.module.llm`, which does not fit the critic (`brain.cortex.critic.llm`). Compose is owned by `deployment`; the README lives in this segment.
10. **Style debt.** `lastError` is declared between methods in `Ollama` and `OpenAICompatible` (`index.ts:109`, `:159`) and on `ClaudeBase` (`:212`) while the `ChatProvider` interface marks it optional; tests mutate a private field by cast and share module-level `lastBody`/`status` across tests (`llm.test.ts:10-11`, `:132`).
11. **Test coverage gaps.** No test asserts the Ollama chat body (LLM-CHAT-001), empty message content (LLM-CHAT-007), client construction without a key or region (LLM-CLAUDE-009), or the cross-package stop/tag invariant (LLM-STOP-006). Several tests assert less than their spec line: `llm.test.ts:33` checks only that the Ollama stop list includes `"\n\n"` (LLM-STOP-001); `:143` does not assert that `temperature` is absent (LLM-CLAUDE-004); `:180` checks only that `fallbacks` is absent when off, not `betas` (LLM-CLAUDE-007); `:101` has no Ollama ping success case (LLM-PING-001); `:232` does not assert the 80-character cut or the exact `hello` fallback (LLM-MOCK-001); the Anthropic ping hint for other statuses is covered only by status 500 (`:206`). LLM-IF-001 and LLM-IF-003 are structural (types, a `switch` with no default) and have no runtime test; the OpenSpec `add-isolated-backends` design promised a shared provider/embedder contract suite run against mock and real backends, which does not exist.
12. **Hash-embedder similarity is not guaranteed.** OpenSpec ("Hash embedder") states that texts sharing tokens have higher cosine similarity than unrelated texts. With 64 signed buckets this fails on collisions: `dog cat` vs `dog park` scores 0.50 while `dog cat` vs `fight` scores 0.71. LLM-EMBED-005 therefore states the property as an expectation, not a guarantee. Whether the guarantee was intended (and the stand-in should use more buckets) is undecided. The test checks one example triple (`llm.test.ts:253`).
13. **`@spec` placement.** Annotations in `src/` are trailing comments on the entry-point line so that line citations from other segments' docs stay valid.

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

OpenSpec: `openspec/specs/llm/spec.md`; `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/llm/spec.md` (MODIFIED factory and embedder; ADDED mock provider, hash embedder, "Mock is reported, not hidden").
