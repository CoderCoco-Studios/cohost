# working-memory Specification

## Purpose
`Context` in `@cohost/working-memory` is the brain's rolling window of recent events, rendered as a transcript for prompts and tracked for what the brain has already seen.

## Requirements

### Requirement: Bounded window
`new Context(max)` SHALL keep at most `max` events, dropping the oldest on overflow.

#### Scenario: Overflow
- **WHEN** more than `max` events are pushed
- **THEN** only the newest `max` remain

### Requirement: Ingesting bus events
`push(ev)` SHALL convert `chat.message`, `vision.summary` and `speech.heard` bus events into unseen context events and SHALL ignore all other event types.

#### Scenario: Other types
- **WHEN** a `brain.status` event is pushed
- **THEN** the window is unchanged

### Requirement: Single vision entry
A `vision.summary` SHALL replace any earlier vision entry, set `lastVision` to its text, and be marked seen when `changed` is false.

#### Scenario: Unchanged vision
- **WHEN** a summary with `changed: false` is pushed
- **THEN** it is not returned by `unseen()`

### Requirement: Self utterances
`pushSelf(text, emotion)` SHALL add a `self` event that is already seen.

#### Scenario: Self not unseen
- **WHEN** `pushSelf` is called
- **THEN** `unseen()` does not include it

### Requirement: Seen tracking
`unseen()` SHALL return unseen events; `markSeenEvents(events)` SHALL mark only the given events seen; `markSeen()` marks all; `clear()` empties the window; `last()` returns the newest event.

#### Scenario: Late arrivals
- **WHEN** an event arrives after `unseen()` was read and `markSeenEvents` is called with the earlier list
- **THEN** the late event stays unseen

### Requirement: Transcript rendering
`transcript(name)` SHALL render one line per event: `[chat] user: text` (with ` (mod)` after mods), `[voice] speaker: text`, `[screen] text`, and `<name>: [emotion] text` for self.

#### Scenario: Mod chat
- **WHEN** a chat from a mod is rendered
- **THEN** the line is `[chat] alice (mod): hi`
