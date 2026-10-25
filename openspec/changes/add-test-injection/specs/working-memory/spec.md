## ADDED Requirements

### Requirement: Injection flags retained
Context events built from `chat.message`, `speech.heard` and `vision.summary` SHALL keep the bus event's `injected` and `remember` values when present, and `self` events SHALL never carry them.

#### Scenario: Injected chat kept
- **WHEN** a `chat.message` with `injected: true, remember: false` is pushed
- **THEN** the resulting context event exposes `injected: true` and `remember: false`

#### Scenario: Real event
- **WHEN** a `chat.message` without the flags is pushed
- **THEN** the context event has neither flag
