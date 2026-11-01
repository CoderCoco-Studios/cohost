## ADDED Requirements

### Requirement: Targeted pause and resume
The cortex service SHALL treat `control` events with a `target` other than `cortex` as not addressed to it, and SHALL handle `pause` and `resume` (target `cortex` or undefined) by idling and resuming in-process without exiting.

#### Scenario: Pause addressed to this service
- **WHEN** `control {cmd:"pause", target:"cortex"}` arrives
- **THEN** the service enters the paused state and no LLM call is started while paused

#### Scenario: Pause for another service
- **WHEN** `control {cmd:"pause", target:"voice"}` arrives
- **THEN** the cortex service state is unchanged

#### Scenario: Resume
- **WHEN** `control {cmd:"resume"}` (no target) arrives while paused
- **THEN** normal processing resumes
