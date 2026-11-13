---
parent: high-level-design
prefix: WM
---

# working-memory

Status: AUDITED 2026-11-02 at git `1b57790` (mapped 2026-10-31 at `686cc8f`; every EARS line checked against code and tests on 2026-11-01; owner decisions of 2026-11-01 applied). Describes the intended design; where the code lags, the gap is named with its spec ID. Parent: [high-level-design](../../high-level-design.md). Specs: [working-memory-specs.md](working-memory-specs.md). Arrow: [docs/arrows/working-memory.md](../../arrows/working-memory.md).

## Context and Design Philosophy

`@cohost/working-memory` (`packages/working-memory/src/index.ts`, 116 lines) is a small, pure, in-process library: a rolling window of the most recent perception events, with per-event "seen" tracking and a renderer that turns the window into the transcript text that goes into the LLM prompt. It has no I/O, timers or Redis access.

It exists because two brain regions need the same view of "what has happened lately" and each keeps its own instance of this one implementation, fed by the same bus events:

- [salience](../salience/salience-design.md) builds a `Context` (`services/salience/src/salience.ts:32`) to decide whether anything unseen is worth responding to; its scorer also imports the `ContextEvent` type (`services/salience/src/scoring.ts:3`).
- [cortex](../cortex/cortex-design.md) builds a `Context` (`services/cortex/src/cortex.ts:35`) to render the prompt transcript and the "on screen right now" line.
- affect does not use it: `services/affect/package.json:16` and `services/affect/tsconfig.json:8` still list it with no importing file, and the affect segment drops both.

Both windows are sized by the same config key `brain.working_memory_events` (default 24, `packages/config/src/schema.ts:102`; config segment), read in one place, `Context.forBrain` (WM-WIN-008). The two instances are independent; nothing synchronizes them except receiving the same events.

The package also owns the plumbing for **test-injection flags** (OpenSpec `add-test-injection`): contexts retain `injected` / `remember` on the events they store, and `propagatedFlags` copies them onto derived bus events so a reply to an injected input is itself marked injected. The flags are defined on the bus schemas in [event-bus](../event-bus/event-bus-design.md); the policy of what to do with them lives in [memory](../memory/memory-design.md) (`services/memory/src/region.ts:12-13`), [salience](../salience/salience-design.md) and [cortex](../cortex/cortex-design.md).

## The `Context` window

`ContextEvent` is a discriminated union on `kind` (`index.ts:22-26`):

| kind | Built from | Fields | Seen on arrival |
|---|---|---|---|
| `chat` | bus `chat.message` | `eventId` (bus event id), `ts` (bus event ts), `user`, `text`, `mention` (from `mentionsCohost`), `isMod`, `isSub`, `seen`, plus `InjectionFlags` | no |
| `vision` | bus `vision.summary` | `eventId`, `ts`, `text`, `changed`, `seen`, plus `InjectionFlags` | `seen = !changed` |
| `speech` | bus `speech.heard` | `eventId`, `ts`, `speaker`, `text`, `timing?` (the event's `timing`, WM-PUSH-011), `seen`, plus `InjectionFlags` | no |
| `self` | `pushSelf(text, emotion, ts, id?)` (not a bus event) | `ts` (the bus `ts` of the `brain.say` it records), `text`, `emotion`, `seen: true` (literal type), no flags; `id` (the `brain.say` id) and `fallback` (the text heard instead) for the spoken fallback line (gap, WM-PUSH-007, WM-PUSH-008) | always |

`Context` (`index.ts:29-105`) holds a private `events` array, the public string `lastVision`, and a `max` count from the constructor.

- **`push(ev: BusEvent)`** switches on `ev.type` (one cast to a type narrowed per event type at the entry, so each case reads its own payload) and returns the context entry it appended, or `undefined` when the type is ignored (WM-PUSH-009); callers that react to what they just pushed hold the entry instead of reading `last()` afterwards. `chat.message`, `vision.summary` and `speech.heard` are converted and appended; every other type hits `default: return` and leaves the window untouched (`index.ts:55-56`). `brain.say` is therefore not ingested here; own and other speakers' lines enter only via `pushSelf`, which the owning region calls (`services/cortex/src/cortex.ts:51` for every `brain.say`, including reflexes and operator lines from other sources).
- **Vision is special-cased** (`index.ts:42-49`): `lastVision` is set to the new text, every earlier `vision` entry is removed from the window, and the new one is appended. Only the newest screen description is ever present in the window. `changed: false` entries arrive already seen, so an unchanged screen does not count as new input, but still updates `lastVision`.
- **Trimming** (`index.ts:102-104`) is by count only: when the window exceeds `max`, the oldest entries are spliced off. There is no time-based eviction. Self lines count against `max` (`pushSelf` also trims, `index.ts:61-64`). Note the vision filter removes an old vision entry before the new one is pushed, so a vision update can lower the window length.
- **Seen tracking:** `unseen()` returns entries with `seen === false` (`index.ts:66-68`); `markSeen()` marks all (`:78-80`); `markSeenEvents(events)` marks only the given entries, matched by **event id** (`eventId`, WM-SEEN-002): a copy of an entry marks its original, while entries already trimmed, `self` entries and ids the window does not hold are ignored silently. This is what lets salience mark only the events it scored while newer arrivals stay unseen (`services/salience/src/salience.ts:97,117`).
- **Arrivals hold** (WM-SEEN-004): `holdArrivals()` starts recording the entry that each `push` returns (at most `max` of them, oldest dropped first; `clear()` empties the record but keeps holding); `releaseArrivals()` stops recording and marks every recorded entry seen. Salience holds while paused, so the first decision after `resume` does not score a burst that accumulated meanwhile (SAL-CTRL-007); the record is window state, so it lives here and not in the region.
- **Latency stamps.** A `speech` entry keeps the `speech.heard`'s `timing` object, when it has one, so salience can copy `audioEndedAt` onto `attention.focus` ([salience](../salience/salience-design.md), SAL-FOCUS-006). The window only carries it: it is never rendered into the transcript and never read by the window's own logic.
- **`last()`** returns the newest entry (`:75-77`); salience uses it right after a synchronous push to identify the trigger (`salience.ts:93`).
- **`clear()`** empties the window and resets `lastVision` to the empty string, so `forget_context` forgets the screen too (WM-WIN-003). Both services call it on the `forget_context` control command (`salience.ts:81`, `cortex.ts:102`).
- **`all()`** returns a shallow copy of the window, oldest first: a new array whose elements are the window's own objects, so `markSeenEvents` still matches them and a caller cannot mutate the window (WM-WIN-006). The return type stays `readonly ContextEvent[]`. Outside this package only a salience test calls it (`services/salience/test/salience.region.test.ts:91`).

### Transcript rendering and the stop-string contract

`transcript(cohostName)` (`index.ts:89-100`) maps each event to one line and joins with `"\n"`:

| kind | Line |
|---|---|
| `chat` | `[chat] <user>` + ` (mod)` if `isMod` + `: <text>` |
| `speech` | `[voice] <speaker>: <text>` |
| `vision` | `[screen] <text>` |
| `self` | `<cohostName>: [<emotion>] <text>` |

`isSub`, `mention`, `changed`, timestamps, and the injection flags are **not** rendered, so an injected event is indistinguishable from a real one in the prompt: injection exists to drive the real code path (WM-TRANS-007).

Each event renders as exactly one line: `\r` and `\n` inside an interpolated user, speaker or text become a single space, so bus text can never forge a `[chat]`-style line or a co-host line (WM-TRANS-008). The flattening is needed because no bus text field is constrained to one line (`packages/bus/src/events.ts:17`, `:43`, `:193`).

**Cross-segment contract:** this segment owns the tags `[chat]`, `[voice]`, `[screen]` (WM-TRANS-006); the package exports the list as `TRANSCRIPT_TAGS` (WM-TRANS-009), and the LLM stop sequences are derived from it (LLM-STOP-006, LLM-STOP-007). `packages/llm/src/index.ts:47` defines `TRANSCRIPT_STOPS = ["\n[chat]", "\n[voice]", "\n[screen]"]` with the comment "Lines that mean 'the model started writing the next transcript entry': stop there"; Ollama and OpenAI-compatible reply calls send `REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]` (`:49`, `:98`, `:163`; the comment caps the list at four because OpenAI-style APIs reject more), Claude reply calls send `TRANSCRIPT_STOPS` alone (`:212`), and `json: true` calls send none. Because this renderer joins lines with `"\n"`, every entry after the first starts with `"\n" + tag`, which is exactly what the stops match. The cortex frames the transcript (`services/cortex/src/prompt.ts:48`) so the model writes the co-host's next line after a closing `<name>:` (`prompt.ts:61-69`), in the `[emotion] text` form the system turn asks for (`prompt.ts:37-38`), and `parseReply` keeps only the first line of the reply and strips a leading `Name:` (`prompt.ts:75-76`). The full four-part contract is written up in [model-backends](../model-backends/model-backends-design.md) under "Stop sequences and the transcript coupling".

What follows for this package:

- A change to a tag, or a new line kind, changes `TRANSCRIPT_TAGS` here and the stops follow because they derive from it; otherwise a model that continues the transcript is no longer cut at that line by any provider (the cortex still drops everything after the first line, after the tokens are generated).
- The stops are a token and latency saver; the correctness guard for the spoken line is the cortex's first-line parse.
- The `self` line `<name>: [<emotion>] <text>` is deliberately not a stop: the four-stop cap leaves no room, and `parseReply` already cuts a model that runs on into another `<name>:` line.
- The pair is checked by a cortex-level test that renders a transcript with this package and asserts every line after the first starts with a stop (cortex segment); within this package `context.test.ts:161` pins the exported list against the rendered lines.

Consumers of `transcript`: `services/cortex/src/prompt.ts:43` (the prompt) and `services/cortex/src/cortex.ts:143` (passed to the critic). Consumers of `lastVision`: `services/cortex/src/prompt.ts:33` and the recall query fallback `cortex.ts:127`.

### Fallback lines

When a line the co-host meant to say fails to play and a pre-generated fallback line is said in its place ([mouth](../mouth/mouth-design.md) Fallback Line), the transcript must show what was actually heard and that the intended line glitched, so the co-host knows she glitched. The owner decided the fallback goes into the transcript as something she said, together with a note that the line she meant failed to play; the format below is.

- `pushSelf(text, emotion, id?)` keeps the optional `id` on the `self` event; it is not rendered (WM-PUSH-007). cortex passes the `brain.say` id.
- `markFallback(id, fallbackText)` finds the `self` event with that id still in the window and records the fallback text on it; with no such event it changes nothing and reports that it marked nothing (WM-PUSH-008). Marking does not move the event or change its `seen` state.
- `hasSelf(id)` reports whether a `self` event with that id is still in the window (WM-WIN-007); cortex uses it to drop an acknowledgement hint whose line has scrolled out.
- A marked `self` event renders as one line: `<cohostName>: [<emotion>] <fallback text> [your line "<intended text>" failed to play; this came out instead]`, with CR and LF in both texts flattened to a space (WM-TRANS-010).

The note rides on the co-host's own line rather than a new tagged line. Every tag in `TRANSCRIPT_TAGS` is an LLM stop sequence, and the reply-stop list is already at the four entries OpenAI-style APIs accept (model-backends), so a fifth tag could not be a stop. A bracketed note after the text is safe on the output side too: `parseReply` strips every `[...]` from a reply (cortex), so a model that imitates the note cannot put it on stream. The fallback is shown as the spoken text because it is what viewers heard; the intended line stays visible inside the note so the co-host knows what she meant.

## Injection flags

Defined in `index.ts:4-20`.

- `InjectionFlags { injected?: boolean; remember?: boolean }` is exported and intersected onto the `chat`, `vision` and `speech` variants only. `self` never carries them (`index.ts:26`).
- `flagsOf(d)` (`index.ts:8-13`, private) copies only the flags that are actually defined on the bus event's data, so real events yield entries with neither key (asserted by `context.test.ts:107`: `"injected" in real` is false).
- `propagatedFlags(src)` (`index.ts:16-20`, exported) returns `{}` unless `src.injected` is truthy (`if (!e?.injected) return {}`); for an injected source it returns `{ injected: true }` plus `remember` when defined. A stray `remember` on a real (non-injected) event is dropped. `src` may be `undefined` (the cast comment says "`self` events have no flags"). Callers spread the result into a publish: salience reflex reply (`salience.ts:98`) and focus (`salience.ts:130`), cortex reply (`cortex.ts:153`, via `propagatedFlags(focus)`). `focus` there is the bus `attention.focus` payload, so flags flow chat.message/etc. -> context entry -> `attention.focus` -> `brain.say`.
- Because a real vision update replaces an injected one (and vice versa), the single vision slot can switch between injected and real provenance.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where the window lives | One window implementation in this package; each region (salience, cortex) holds its own instance, built by `Context.forBrain(cfg.brain)` and fed from the bus. Window size, eviction, seen-marking and the arrivals hold (WM-SEEN-004) exist only here | A shared service or Redis-backed window; each region carrying its own window code | Services "only ever talk through these events — never directly to each other" (`packages/bus/src/events.ts:4-7`), so a region cannot query another region's window and the instances stay separate processes' state (WM-WIN-005). An in-process instance costs no I/O on the reply path and each region keeps working while the other is paused or restarting; a shared service or Redis-backed window would add a network hop to every decision and a new dependency between regions. Behaviour that both regions need lives in the package, so the two instances differ only in what each feeds them: the same bus events converge them, and `forget_context` is one `clear()` call in each region. |
| Eviction | Count-based (`max` from `brain.working_memory_events`) | Time-based or token-based | A count is the simplest bound on prompt size and needs no clock or tokenizer (`index.ts:103-105`, config default 24 at `packages/config/src/schema.ts:110`; WM-WIN-001, WM-WIN-002). Time-based eviction would empty the window during a quiet stretch and lose the context a reply needs; token-based eviction would need a tokenizer for every backend. Older context beyond the window is long-term memory's job. |
| Vision handling | Keep only the newest vision entry; `clear()` also resets `lastVision` | Keep all vision lines; keep `lastVision` across `clear()` | Older vision lines "are noise" (comment `index.ts:45`). Owner decision 2026-11-01: `forget_context` forgets the screen as well, so neither the prompt nor the recall fallback carries a pre-reset screen line (WM-WIN-003). |
| Seen tracking | Per-entry `seen` flag; `markSeenEvents` by bus event id | Object identity; index/ts-based marking; mark-all only | "Mark only these events seen (not ones that arrived while a decision was in flight)" (comment `index.ts:69`); commit `969f6d7` fixed "a mention that lands mid-await is no longer marked seen unscored". Entries are matched by the bus event id each sense entry keeps as `eventId` (WM-SEEN-002, WM-PUSH-010): ids are unique where `ts` can repeat, and a caller that clones an entry (or holds a copy) can still mark it. Object identity, the earlier rule, silently ignored any clone. |
| Self lines | Not derived from bus events; the region calls `pushSelf(text, emotion, ts, id?)` with the `brain.say` event's bus `ts` | Ingest `brain.say` in `push`; stamp with the consumer's `Date.now()` | `push` ingests perception only and ignores every other event type (`index.ts:55`, WM-PUSH-003), so a region that shares it, such as salience, never sees its own speech as new input. Recording own lines is the region's choice through `pushSelf` (WM-PUSH-006); the caller passes the `brain.say` event's bus `ts`, so all four kinds share the publisher's clock and the package reads no clock of its own: cortex records every `brain.say`, whatever its source, with the emotion it was spoken with, so the prompt shows what was actually said. |
| Transcript tags | `[chat]`, `[voice]`, `[screen]` prefixes; own lines as `Name: [emotion] text` | Role-based chat messages; structured JSON | The transcript is plain text in one user turn so that every backend, including small local models, gets the same prompt shape. A short bracketed tag per source tells the model where a line came from (viewer chat, someone speaking, the screen) without role semantics that would make each viewer a "user" turn, and gives the LLM layer a fixed prefix to stop on when the model starts the next entry (`packages/llm/src/index.ts:47`). The co-host's own line uses `Name: [emotion] text`, the same form the cortex asks the model to produce, so the transcript shows the model its own past lines in the format it is to continue. |
| Tag ownership | This segment owns the tag list and exports it as `TRANSCRIPT_TAGS`; model-backends derives its stops from the export; a cortex-level test checks the pair; the self line is not a stop | A third shared-constants package; model-backends owns the tags and this segment mirrors them; a self-line stop | Owner decision 2026-11-01: the segment that renders the lines owns their format, and the stops are a token saver rather than the correctness guard (WM-TRANS-006, LLM-STOP-006). |
| Multi-line fields | Flatten `\r`/`\n` to a space when rendering | Escape them; reject multi-line text at ingest | Owner decision 2026-11-01: `transcript` is the one place lines are built, and flattening keeps the text readable to the model (WM-TRANS-008). |
| `all()` result | A shallow copy, elements identical | The live array | Owner decision 2026-11-01: callers cannot mutate the window, and identity-based `markSeenEvents` keeps working (WM-WIN-006). |
| Injected events in the prompt | Rendered exactly like real ones | A visible marker for the model or critic | Owner decision 2026-11-01: injection exists to exercise the real path (WM-TRANS-007). |
| Fallback line in the transcript | The co-host's `self` line shows the fallback text, followed by a bracketed note quoting the line that failed (WM-TRANS-010) | A new `[glitch]` tagged line; replace the text silently; drop the failed line | The owner decided both must appear: what she said and that the intended line failed. A new tag would need a fifth stop sequence where the provider cap allows four; a silent replacement hides the glitch from her; dropping the line loses what she meant. |
| Injection flag propagation | Free function `propagatedFlags(src)` in this package; copy only when `injected` is truthy | Each region copies flags itself; always copy | Copy "only for injected inputs, never for real ones (a stray `remember` is dropped)" (comment `index.ts:15`); commit `3fae9f7` "flags propagate via working-memory → salience/cortex". The helper lives here because this package already keeps the flags on its context entries (WM-FLAG-001, WM-FLAG-002) and both salience and cortex need the same rule; one function keeps the rule from drifting between them (WM-FLAG-003, WM-FLAG-004). |
| Vision entry position | The newest vision entry is placed last on update | Keep it at its original position | The transcript shows the current screen most recently, which is what the prompt needs; an older position would put a stale screen line before newer chat. |
| Injection flag test | `propagatedFlags` tests `injected` for truthiness | Require `true` | The bus schema types the flag as a boolean and rejects other values, so the two readings differ only for input that never reaches the package. |
| Package dependencies | `@cohost/bus` and `@cohost/config` are development dependencies | Runtime dependencies | The package imports both for types alone (WM-PKG-001). |

## Open Questions & Future Decisions

None.

## References

- Segment files: `packages/working-memory/src/index.ts`, `packages/working-memory/test/context.test.ts`, `packages/working-memory/package.json`, `packages/working-memory/tsconfig.json`.
- Depends on: [event-bus](../event-bus/event-bus-design.md) (type import of `BusEvent`; consumes `chat.message`, `vision.summary`, `speech.heard` and their injection flags), [config](../config/config-design.md) (type import of `Emotion`; sizing key `brain.working_memory_events`).
- Depended on by: [salience](../salience/salience-design.md) (`Context`, `propagatedFlags`), [cortex](../cortex/cortex-design.md) (`Context`, `propagatedFlags`, `InjectionFlags` type, `transcript`, `lastVision`); `services/affect/package.json` lists it without using it (removed by the affect segment).
- Coupled contract: [model-backends](../model-backends/model-backends-design.md), `packages/llm/src/index.ts:47` (`TRANSCRIPT_STOPS`) and `:47` (`REPLY_STOPS`).
- Flag consumers: [memory](../memory/memory-design.md) (`services/memory/src/region.ts:12-13` `skipInjected`), [dashboard](../dashboard/dashboard-design.md) (injection producer).
- External libs: none at runtime (types only).
- OpenSpec: `openspec/specs/working-memory/spec.md` (baseline); delta `openspec/changes/archive/2026-11-01-add-test-injection/specs/working-memory/spec.md` ("Injection flags retained"). `propagatedFlags` is covered by the salience and cortex "Injection flag propagation" requirements in `openspec/changes/archive/2026-11-01-add-test-injection/specs/salience/spec.md` and `.../cortex/spec.md`, not by a working-memory requirement.
