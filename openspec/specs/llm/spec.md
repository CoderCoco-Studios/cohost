# llm Specification

## Purpose
`@cohost/llm` hides the chat model backend behind `ChatProvider` so changing model is a config change. Embeddings always come from local Ollama.

## Requirements

### Requirement: Provider factory
`createChatProvider(cfg.llm)` SHALL return an `Ollama`, `OpenAICompatible`, `AnthropicProvider` or `BedrockProvider` according to `provider` (`ollama`, `openai`, `anthropic`, `bedrock`), each exposing `name`, `model`, `chat`, `ping` and `lastError`.

#### Scenario: Provider selection
- **WHEN** `provider` is `openai`
- **THEN** the returned provider has `name` "openai"

### Requirement: Embeddings are always Ollama
`createEmbedder` SHALL return an Ollama client using `embed_model` regardless of chat provider; `embed` POSTs `/api/embed` and MUST throw on non-OK status or when no vector is returned.

#### Scenario: Missing vector
- **WHEN** Ollama returns no embeddings
- **THEN** `embed` throws "ollama embed returned no vector"

### Requirement: Ollama and OpenAI-compatible chat
These providers SHALL POST non-streaming requests (`/api/chat`, or `<base_url>/chat/completions` with trailing slashes trimmed), defaulting temperature and max tokens to `llm.temperature` and `llm.max_tokens`, trim the reply, send `Authorization: Bearer` only when `openai.api_key` is set, and throw on non-OK status including status and body.

#### Scenario: HTTP error
- **WHEN** the server returns 500
- **THEN** `chat` throws an error containing the status

### Requirement: Stop sequences
Unless `opts.json` is true, Ollama and OpenAI providers SHALL send stop sequences `"\n\n"`, `"\n[chat]"`, `"\n[voice]"`, `"\n[screen]"` (at most four); Claude providers SHALL send the three transcript stops. With `json: true` no stop sequences are sent.

#### Scenario: JSON mode
- **WHEN** `chat` is called with `json: true`
- **THEN** the request has no stop sequences

### Requirement: Claude message handling
Anthropic and Bedrock providers SHALL join system messages into the `system` field, ensure the turns start with a user turn (inserting `(begin)` otherwise), use `max(opts.maxTokens, claude.max_tokens)`, send `output_config.effort`, concatenate text blocks, and return `""` when `stop_reason` is `refusal`.

#### Scenario: Refusal
- **WHEN** the response stop reason is `refusal`
- **THEN** `chat` returns an empty string

### Requirement: Server-side fallbacks
Only `AnthropicProvider` with `claude.fallbacks` true SHALL send the server-side-fallback beta; `BedrockProvider` MUST NOT.

#### Scenario: Bedrock
- **WHEN** Bedrock `chat` is called
- **THEN** no `betas` or `fallbacks` are sent

### Requirement: Health ping
`ping()` SHALL return true when the backend is reachable, else false with a descriptive `lastError` (Ollama `/api/tags`, OpenAI `/models` with an api-key hint on 401/403, Anthropic model retrieve with credential/model hints on 401/403/404); Bedrock always returns true.

#### Scenario: Unreachable
- **WHEN** Ollama cannot be reached
- **THEN** `ping` returns false and `lastError` names the URL
