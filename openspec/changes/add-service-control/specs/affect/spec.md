## ADDED Requirements

### Requirement: Targeted pause and resume
The affect service SHALL treat `control` events with a `target` other than `affect` as not addressed to it, and SHALL handle `pause` and `resume` (target `affect` or undefined) by idling and resuming in-process without exiting.

#### Scenario: Pause addressed to this service
- **WHEN** `control {cmd:"pause", target:"affect"}` arrives
- **THEN** the service enters the paused state and mood is not nudged by incoming events while paused (decay continues)

#### Scenario: Pause for another service
- **WHEN** `control {cmd:"pause", target:"voice"}` arrives
- **THEN** the affect service state is unchanged

#### Scenario: Resume
- **WHEN** `control {cmd:"resume"}` (no target) arrives while paused
- **THEN** normal processing resumes
