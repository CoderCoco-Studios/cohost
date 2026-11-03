---
parent: high-level-design
prefix: WM
---

# working-memory

Status: AUDITED 2026-11-02 at git `1b57790` (mapped 2026-10-31 at `686cc8f`; every EARS line checked against code and tests on 2026-11-01; owner decisions of 2026-11-01 applied). Describes the intended design; where the code lags, the gap is named with its spec ID. Parent: [high-level-design](../../high-level-design.md). Specs: [working-memory-specs.md](working-memory-specs.md). Arrow: [docs/arrows/working-memory.md](../../arrows/working-memory.md).

## Context and Design Philosophy

`@cohost/working-memory` (`packages/working-memory/src/index.ts`, 116 lines) is a small, pure, in-process library: a rolling window of the most recent perception events, with per-event "seen" tracking and a renderer that turns the window into the transcript text that goes into the LLM prompt. It has no I/O, timers or Redis access. Its only runtime effect is `Date.now()` in `pushSelf` (`index.ts:62`).

It exists because two brain regions need the same view of "what has happened lately" and each keeps its own copy, fed by the same bus events:

- [salience](../salience/salience-design.md) builds a `Context` (`services/salience/src/salience.ts:32`) to decide whether anything unseen is worth responding to; its scorer also imports the `ContextEvent` type (`services/salience/src/scoring.ts:3`).
- [cortex](../cortex/cortex-design.md) builds a `Context` (`services/cortex/src/cortex.ts:35`) to render the prompt transcript and the "on screen right now" line.
- affect does not use it: `services/affect/package.json:16` and `services/affect/tsconfig.json:8` still list it with no importing file, and the affect segment drops both.

Both windows are sized by the same config key `brain.working_memory_events` (default 24, `packages/config/src/schema.ts:102`; config segment). The two copies are independent; nothing synchronizes them except receiving the same events.

The package also owns the plumbing for **test-injection flags** (OpenSpec `add-test-injection`): contexts retain `injected` / `remember` on the events they store, and `propagatedFlags` copies them onto derived bus events so a reply to an injected input is itself marked injected. The flags are defined on the bus schemas in [event-bus](../event-bus/event-bus-design.md); the policy of what to do with them lives in [memory](../memory/memory-design.md) (`services/memory/src/region.ts:12-13`), [salience](../salience/salience-design.md) and [cortex](../cortex/cortex-design.md).

## The `Context` window

`ContextEvent` is a discriminated union on `kind` (`index.ts:22-26`):

| kind | Built from | Fields | Seen on arrival |
|---|---|---|---|
| `chat` | bus `chat.message` | `ts` (bus event ts), `user`, `text`, `mention` (from `mentionsCohost`), `isMod`, `isSub`, `seen`, plus `InjectionFlags` | no |
| `vision` | bus `vision.summary` | `ts`, `text`, `changed`, `seen`, plus `InjectionFlags` | `seen = !changed` |
| `speech` | bus `speech.heard` | `ts`, `speaker`, `text`, `seen`, plus `InjectionFlags` | no |
| `self` | `pushSelf(text, emotion)` (not a bus event) | `ts` (`Date.now()`), `text`, `emotion`, `seen: true` (literal type), no flags | always |

`Context` (`index.ts:29-105`) holds a private `events` array, the public string `lastVision`, and a `max` count from the constructor.

- **`push(ev: BusEvent)`** (`index.ts:35-59`) switches on `ev.type`. `chat.message`, `vision.summary` and `speech.heard` are converted and appended; every other type hits `default: return` and leaves the window untouched (`index.ts:55-56`). `brain.say` is therefore not ingested here; own and other speakers' lines enter only via `pushSelf`, which the owning region calls (`services/cortex/src/cortex.ts:51` for every `brain.say`, including reflexes and operator lines from other sources).
- **Vision is special-cased** (`index.ts:42-49`): `lastVision` is set to the new text, every earlier `vision` entry is removed from the window, and the new one is appended. Only the newest screen description is ever present in the window. `changed: false` entries arrive already seen, so an unchanged screen does not count as new input, but still updates `lastVision`.
- **Trimming** (`index.ts:102-104`) is by count only: when the window exceeds `max`, the oldest entries are spliced off. There is no time-based eviction. Self lines count against `max` (`pushSelf` also trims, `index.ts:61-64`). Note the vision filter removes an old vision entry before the new one is pushed, so a vision update can lower the window length.
- **Seen tracking:** `unseen()` returns entries with `seen === false` (`index.ts:66-68`); `markSeen()` marks all (`:78-80`); `markSeenEvents(events)` marks only the given entries, matched by **object identity** through a `Set` of references (`:70-73`), so callers must pass entries obtained from this same `Context` (via `unseen()`, `last()` or `all()`); entries already trimmed or foreign objects are ignored silently. This is what lets salience mark only the events it scored while newer arrivals stay unseen (`services/salience/src/salience.ts:97,117`).
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

**Cross-segment contract:** this segment owns the tags `[chat]`, `[voice]`, `[screen]` (WM-TRANS-006); the package exports the list as `TRANSCRIPT_TAGS` (WM-TRANS-009), and the LLM stop sequences are derived from it (LLM-STOP-006, LLM-STOP-007). `packages/llm/src/index.ts:45` defines `TRANSCRIPT_STOPS = ["\n[chat]", "\n[voice]", "\n[screen]"]` with the comment "Lines that mean 'the model started writing the next transcript entry': stop there"; Ollama and OpenAI-compatible reply calls send `REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]` (`:47`, `:86`, `:150`; the comment caps the list at four because OpenAI-style APIs reject more), Claude reply calls send `TRANSCRIPT_STOPS` alone (`:199`), and `json: true` calls send none. Because this renderer joins lines with `"\n"`, every entry after the first starts with `"\n" + tag`, which is exactly what the stops match. The cortex frames the transcript (`services/cortex/src/prompt.ts:48`) so the model writes the co-host's next line after a closing `<name>:` (`prompt.ts:61-69`), in the `[emotion] text` form the system turn asks for (`prompt.ts:37-38`), and `parseReply` keeps only the first line of the reply and strips a leading `Name:` (`prompt.ts:75-76`). The full four-part contract is written up in [model-backends](../model-backends/model-backends-design.md) under "Stop sequences and the transcript coupling".

What follows for this package:

- A change to a tag, or a new line kind, changes `TRANSCRIPT_TAGS` here and the stops follow because they derive from it; otherwise a model that continues the transcript is no longer cut at that line by any provider (the cortex still drops everything after the first line, after the tokens are generated).
- The stops are a token and latency saver; the correctness guard for the spoken line is the cortex's first-line parse.
- The `self` line `<name>: [<emotion>] <text>` is deliberately not a stop: the four-stop cap leaves no room, and `parseReply` already cuts a model that runs on into another `<name>:` line.
- The pair is checked by a cortex-level test that renders a transcript with this package and asserts every line after the first starts with a stop (cortex segment); within this package `context.test.ts:161` pins the exported list against the rendered lines.

Consumers of `transcript`: `services/cortex/src/prompt.ts:43` (the prompt) and `services/cortex/src/cortex.ts:143` (passed to the critic). Consumers of `lastVision`: `services/cortex/src/prompt.ts:33` and the recall query fallback `cortex.ts:127`.

## Injection flags

Defined in `index.ts:4-20`.

- `InjectionFlags { injected?: boolean; remember?: boolean }` is exported and intersected onto the `chat`, `vision` and `speech` variants only. `self` never carries them (`index.ts:26`).
- `flagsOf(d)` (`index.ts:8-13`, private) copies only the flags that are actually defined on the bus event's data, so real events yield entries with neither key (asserted by `context.test.ts:107`: `"injected" in real` is false).
- `propagatedFlags(src)` (`index.ts:16-20`, exported) returns `{}` unless `src.injected` is truthy (`if (!e?.injected) return {}`); for an injected source it returns `{ injected: true }` plus `remember` when defined. A stray `remember` on a real (non-injected) event is dropped. `src` may be `undefined` (the cast comment says "`self` events have no flags"). Callers spread the result into a publish: salience reflex reply (`salience.ts:98`) and focus (`salience.ts:130`), cortex reply (`cortex.ts:153`, via `propagatedFlags(focus)`). `focus` there is the bus `attention.focus` payload, so flags flow chat.message/etc. -> context entry -> `attention.focus` -> `brain.say`.
- Because a real vision update replaces an injected one (and vice versa), the single vision slot can switch between injected and real provenance.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where the window lives | One `Context` instance per region (salience, cortex), each fed independently from the bus | A shared service or Redis-backed window | `[inferred]` Services "only ever talk through these events — never directly to each other" (`packages/bus/src/events.ts:4-7`); each region constructs its own (`salience.ts:32`, `cortex.ts:35`). Nothing records why a shared window was not chosen. |
| Eviction | Count-based (`max` from `brain.working_memory_events`) | Time-based or token-based | `[inferred]` Simplest bound on prompt size; `index.ts:102-104` and config default 24 (`packages/config/src/schema.ts:97`). |
| Vision handling | Keep only the newest vision entry; `clear()` also resets `lastVision` | Keep all vision lines; keep `lastVision` across `clear()` | Older vision lines "are noise" (comment `index.ts:45`). Owner decision 2026-11-01: `forget_context` forgets the screen as well, so neither the prompt nor the recall fallback carries a pre-reset screen line (WM-WIN-003). |
| Seen tracking | Per-entry `seen` flag; `markSeenEvents` by object identity | Index/ts-based marking; mark-all only | "Mark only these events seen (not ones that arrived while a decision was in flight)" (comment `index.ts:69`); commit `969f6d7` fixed "a mention that lands mid-await is no longer marked seen unscored". Identity rather than id matching is `[inferred]`. |
| Self lines | Not derived from bus events; the region calls `pushSelf` | Ingest `brain.say` in `push` | `[inferred]` Lets cortex decide to record every `brain.say` regardless of source, with `Date.now()` ts and the emotion; `push` explicitly ignores other types (`index.ts:55`). |
| Transcript tags | `[chat]`, `[voice]`, `[screen]` prefixes; own lines as `Name: [emotion] text` | Role-based chat messages; structured JSON | `[inferred]` Nothing records why the tags themselves were chosen; the stop-sequence list in `packages/llm/src/index.ts:45` exists to cut the model off when it starts the next transcript entry (comment `:44`). |
| Tag ownership | This segment owns the tag list and exports it as `TRANSCRIPT_TAGS`; model-backends derives its stops from the export; a cortex-level test checks the pair; the self line is not a stop | A third shared-constants package; model-backends owns the tags and this segment mirrors them; a self-line stop | Owner decision 2026-11-01: the segment that renders the lines owns their format, and the stops are a token saver rather than the correctness guard (WM-TRANS-006, LLM-STOP-006). |
| Multi-line fields | Flatten `\r`/`\n` to a space when rendering | Escape them; reject multi-line text at ingest | Owner decision 2026-11-01: `transcript` is the one place lines are built, and flattening keeps the text readable to the model (WM-TRANS-008). |
| `all()` result | A shallow copy, elements identical | The live array | Owner decision 2026-11-01: callers cannot mutate the window, and identity-based `markSeenEvents` keeps working (WM-WIN-006). |
| Injected events in the prompt | Rendered exactly like real ones | A visible marker for the model or critic | Owner decision 2026-11-01: injection exists to exercise the real path (WM-TRANS-007). |
| Injection flag propagation | Free function `propagatedFlags(src)` in this package; copy only when `injected` is truthy | Each region copies flags itself; always copy | Copy "only for injected inputs, never for real ones (a stray `remember` is dropped)" (comment `index.ts:15`); commit `3fae9f7` "flags propagate via working-memory → salience/cortex". Placing the helper here rather than in each region is `[inferred]`. |

## Open Questions & Future Decisions

1. **Truthy, not `true`.** `propagatedFlags` tests `injected` for truthiness (`index.ts:18`), so WM-FLAG-003 and WM-FLAG-004 say truthy / falsy. The bus schema types the flag as a boolean, so the two readings differ only for malformed input.
2. **`markSeenEvents` identity semantics are fragile.** It silently ignores events not in the window (tested at `context.test.ts:76`), and `all()` / `unseen()` hand out the window's own objects, so a caller that clones events cannot mark them.
3. **Over-broad dependencies.** `@cohost/bus` and `@cohost/config` are listed as runtime `dependencies` but used type-only (`index.ts:1-2`, `packages/working-memory/package.json:10`).
4. **Duplicate windows.** Salience and cortex each keep a full copy and could drift (for example `forget_context` is handled separately in each; cortex also clears `viewerNotes`, `cortex.ts:102`). Salience never calls `pushSelf` (its `unseen()` consumer filters `self` anyway, `services/salience/src/scheduler.ts:47`), so its window lacks own lines while cortex's has them.
5. **Timestamp clocks differ by kind.** Sense entries use the publisher's bus `ts` (`index.ts:39,47,52`); `self` entries use the consumer's `Date.now()` (`index.ts:62`). No test asserts either timestamp (`context.test.ts:14` masks `ts`).
6. **Redundant casts.** `ev.data as BusEvent<"chat.message">["data"]` inside each case (`index.ts:38,43,51`) because `BusEvent` defaults to the union type and does not narrow on `ev.type`.
7. **Vision entry is placed last on update**, not in its original position, so the transcript order of `[screen]` relative to chat changes whenever vision updates (`index.ts:46-47`).
8. **Untested spec lines.** WM-WIN-002 (no age eviction) and WM-WIN-005 (sizing in salience/cortex) have no test; WM-WIN-004's newest-event case is used only as setup (`context.test.ts:79`); WM-TRANS-007 is asserted only for non-injected events.

## References

- Segment files: `packages/working-memory/src/index.ts`, `packages/working-memory/test/context.test.ts`, `packages/working-memory/package.json`, `packages/working-memory/tsconfig.json`.
- Depends on: [event-bus](../event-bus/event-bus-design.md) (type import of `BusEvent`; consumes `chat.message`, `vision.summary`, `speech.heard` and their injection flags), [config](../config/config-design.md) (type import of `Emotion`; sizing key `brain.working_memory_events`).
- Depended on by: [salience](../salience/salience-design.md) (`Context`, `propagatedFlags`), [cortex](../cortex/cortex-design.md) (`Context`, `propagatedFlags`, `InjectionFlags` type, `transcript`, `lastVision`); `services/affect/package.json` lists it without using it (removed by the affect segment).
- Coupled contract: [model-backends](../model-backends/model-backends-design.md), `packages/llm/src/index.ts:45` (`TRANSCRIPT_STOPS`) and `:47` (`REPLY_STOPS`).
- Flag consumers: [memory](../memory/memory-design.md) (`services/memory/src/region.ts:12-13` `skipInjected`), [dashboard](../dashboard/dashboard-design.md) (injection producer).
- External libs: none at runtime (types only).
- OpenSpec: `openspec/specs/working-memory/spec.md` (baseline); delta `openspec/changes/archive/2026-11-01-add-test-injection/specs/working-memory/spec.md` ("Injection flags retained"). `propagatedFlags` is covered by the salience and cortex "Injection flag propagation" requirements in `openspec/changes/archive/2026-11-01-add-test-injection/specs/salience/spec.md` and `.../cortex/spec.md`, not by a working-memory requirement.
