## ADDED Requirements

### Requirement: Startup with the mock provider
The cortex SHALL start and subscribe once `llm.ping()` is true; with `llm.provider: mock` this is immediate, and it MUST then answer `attention.focus` with `brain.say` using the mock reply through the normal parsing, critic and inhibition paths. With a real provider it SHALL keep waiting for `ping()` as before, while reporting `degraded` with the model backend down (heartbeat from change `add-service-health`) rather than silently blocking.

#### Scenario: Mock answers
- **WHEN** `llm.provider` is `mock` and `attention.focus` arrives
- **THEN** a `brain.say` is published with non-empty text and a valid emotion

#### Scenario: Real backend down
- **WHEN** `llm.provider` is `ollama` and Ollama is unreachable
- **THEN** the cortex keeps retrying and reports degraded; it does not exit

### Requirement: Isolation preset and closure
`LLM_PROVIDER=mock` SHALL be the cortex isolation preset (heartbeat `mode` `mock`). An isolated cortex run MUST include its bus-level requirements salience and affect (the supervisor change `add-service-control` computes the closure); memory is optional because the cortex answers without recall after `brain.cortex.recall_timeout_ms`.

#### Scenario: Closure without memory
- **WHEN** only cortex, salience and affect run with the mock provider
- **THEN** a recall times out after `recall_timeout_ms` and the cortex still publishes `brain.say`
