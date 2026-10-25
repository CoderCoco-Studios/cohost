## ADDED Requirements

### Requirement: Injection flag propagation
When the `attention.focus` focus event has `injected: true`, salience SHALL publish `attention.focus` with `injected: true` and that event's `remember`; with no focus event or a real focus event it MUST omit both. A reflex `brain.say` SHALL carry `injected` and `remember` copied from the triggering event when that event is injected, and omit them otherwise. Injected events are otherwise scored and reacted to like real ones.

#### Scenario: Injected focus
- **WHEN** the speak decision's focus is an injected chat message with `remember: false`
- **THEN** `attention.focus` has `injected: true, remember: false`

#### Scenario: Real focus
- **WHEN** the focus is a real chat message
- **THEN** `attention.focus` has no `injected` or `remember`

#### Scenario: Injected reflex
- **WHEN** an injected chat line matches a reflex rule
- **THEN** the reflex `brain.say` has `injected: true` and the line's `remember`

#### Scenario: Real reflex
- **WHEN** a real line matches a reflex rule
- **THEN** the `brain.say` carries neither flag
