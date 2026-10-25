# modules Specification

## Purpose
`@cohost/modules` provides `Module`, the pluggable judgement hook used by brain regions. A hook runs built-in rules, a chat model, or an HTTP endpoint, and always falls back to rules on failure.

## Requirements

### Requirement: Three implementation kinds
The system SHALL run a hook according to `module.kind`: `rules` calls `impl.rules(input)` directly; `llm` asks a chat provider; `http` POSTs the input as JSON to `module.url`.

#### Scenario: Rules kind
- **WHEN** `kind` is `rules`
- **THEN** `run` returns `impl.rules(input)` with no I/O

### Requirement: Construction-time validation
The constructor SHALL throw if `kind` is `llm` without `impl.llm`, `http` without `impl.http`, or `http` with an empty `module.url`.

#### Scenario: Empty URL
- **WHEN** `kind` is `http` and `url` is empty
- **THEN** construction throws an error naming the hook

### Requirement: LLM kind behaviour
For `kind: llm` the system SHALL create a provider from the cortex `llm` config overridden by `module.llm.provider`/`model` if set, send a system and user message with `temperature: 0`, `json: true`, `maxTokens` (default 200) and a `timeout_ms` abort, extract the first JSON object/array from the reply, and pass it to `validate`.

#### Scenario: Prose around JSON
- **WHEN** the model replies `Sure: {"score":0.5} done`
- **THEN** `extractJson` yields `{score: 0.5}`

### Requirement: HTTP kind behaviour
For `kind: http` the system SHALL POST `application/json` with `timeout_ms` as abort timeout and pass the parsed response to `http.validate`; a non-2xx status MUST count as failure.

#### Scenario: Server error
- **WHEN** the endpoint returns 500
- **THEN** `run` returns the rules result

### Requirement: Fallback to rules
When the module throws, times out, or `validate` returns `undefined`, `run` SHALL return `impl.rules(input)`, and SHALL log a warning at most once per 30 seconds.

#### Scenario: Unusable output
- **WHEN** `validate` returns `undefined`
- **THEN** `run` returns the rules result and a warning is logged

### Requirement: Helpers
The package SHALL export `extractJson` (returns `undefined` when no parseable JSON is found), `clamp(x, lo, hi)` and `isNum` (finite number check).

#### Scenario: No JSON
- **WHEN** `extractJson("no json here")` is called
- **THEN** it returns `undefined`
