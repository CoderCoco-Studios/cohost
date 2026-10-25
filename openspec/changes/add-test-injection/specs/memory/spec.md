## MODIFIED Requirements

### Requirement: Storing memories
The system SHALL store via `MemoryStore.remember(kind, who, text)` an embedding of `"<who>: <text>"` in table `memories` (kinds `chat`, `speech`, `self`, `note`): chat only when `mentionsCohost` is true, every `speech.heard` (who = speaker), and `brain.say` text of length >= 2 (who = `cfg.cohost.name`, kind `self`). A `chat.message` or `speech.heard` with `injected: true` SHALL be stored only when `remember` is true; with `remember` false or absent it MUST NOT be stored. A `brain.say` with `injected: true` SHALL be stored as kind `self` only when `remember` is true. `remember` has no effect on events without `injected: true`.

#### Scenario: Unaddressed chat
- **WHEN** a chat message does not mention the co-host
- **THEN** it is not stored as a memory, though the viewer row is touched

#### Scenario: Short self line
- **WHEN** `brain.say` text is 1 character
- **THEN** nothing is remembered

#### Scenario: Write failure
- **WHEN** embedding or INSERT throws
- **THEN** a warning is logged and the error is not propagated

#### Scenario: Injected, not remembered
- **WHEN** a `speech.heard` with `injected: true` and `remember: false` arrives
- **THEN** nothing is stored

#### Scenario: Injected, remembered
- **WHEN** a `speech.heard` with `injected: true` and `remember: true` arrives
- **THEN** it is stored as kind `speech` as for a real event

#### Scenario: Reply to injected input
- **WHEN** a `brain.say` with `injected: true` and `remember` false or absent arrives
- **THEN** it is not stored as a `self` memory

#### Scenario: Remembered reply
- **WHEN** a `brain.say` with `injected: true` and `remember: true` arrives
- **THEN** it is stored as kind `self`

#### Scenario: Flag ignored on real events
- **WHEN** a `speech.heard` without `injected` carries `remember: false`
- **THEN** it is stored

## ADDED Requirements

### Requirement: Injected chat and viewers
A `chat.message` with `injected: true` and `remember` false or absent SHALL NOT touch the `viewers` table and SHALL NOT cause `memory.viewer` to be published. With `remember: true` it SHALL be handled exactly like a real message.

#### Scenario: Not remembered
- **WHEN** an injected mentioning `chat.message` with `remember: false` arrives
- **THEN** no viewer row is upserted, no `memory.viewer` is published and nothing is stored

#### Scenario: Remembered
- **WHEN** an injected mentioning `chat.message` with `remember: true` arrives
- **THEN** the viewer is upserted, `memory.viewer` is published and the message is stored
