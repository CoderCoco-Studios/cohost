## ADDED Requirements

### Requirement: Targeted pause and resume
The salience service SHALL treat `control` events with a `target` other than `salience` as not addressed to it, and SHALL handle `pause` and `resume` (target `salience` or undefined) by idling and resuming in-process without exiting.

#### Scenario: Pause addressed to this service
- **WHEN** `control {cmd:"pause", target:"salience"}` arrives
- **THEN** the service enters the paused state and no `attention.focus` is published while paused

#### Scenario: Pause for another service
- **WHEN** `control {cmd:"pause", target:"voice"}` arrives
- **THEN** the salience service state is unchanged

#### Scenario: Resume
- **WHEN** `control {cmd:"resume"}` (no target) arrives while paused
- **THEN** normal processing resumes
