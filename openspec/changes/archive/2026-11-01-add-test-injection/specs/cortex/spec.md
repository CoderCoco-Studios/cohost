## ADDED Requirements

### Requirement: Injection flag propagation
When thinking about an `attention.focus` with `injected: true`, the cortex SHALL publish the resulting `brain.say` with `injected: true` and the focus's `remember` unchanged. A `brain.say` produced for a real focus, or by `control` `say`, MUST NOT carry either flag.

#### Scenario: Reply to injected input
- **WHEN** an `attention.focus {injected: true, remember: false}` is answered
- **THEN** `brain.say` has `injected: true, remember: false`

#### Scenario: Remembered injection
- **WHEN** the focus has `injected: true, remember: true`
- **THEN** `brain.say` has `injected: true, remember: true`

#### Scenario: Real input and operator say
- **WHEN** the focus is real, or `control` `say` is handled
- **THEN** `brain.say` carries neither flag
