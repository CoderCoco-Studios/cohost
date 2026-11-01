---
parent: high-level-design
prefix: WM
---

# working-memory

Status: MAPPED 2026-10-31 at git `686cc8f` (reverse-engineered from code; not audited). Parent: [high-level-design](../../high-level-design.md). Specs: [working-memory-specs.md](working-memory-specs.md). Arrow: [docs/arrows/working-memory.md](../../arrows/working-memory.md).

## Context and Design Philosophy

`@cohost/working-memory` (`packages/working-memory/src/index.ts`, 105 lines) is a small, pure, in-process library: a rolling window of the most recent perception events, with per-event "seen" tracking and a renderer that turns the window into the transcript text that goes into the LLM prompt. It has no I/O, timers or Redis access. Its only runtime effect is `Date.now()` in `pushSelf` (`index.ts:62`).

It exists because two brain regions need the same view of "what has happened lately" and each keeps its own copy, fed by the same bus events:

- [salience](../salience/salience-design.md) builds a `Context` (`services/salience/src/salience.ts:32`) to decide whether anything unseen is worth responding to.
- [cortex](../cortex/cortex-design.md) builds a `Context` (`services/cortex/src/cortex.ts:35`) to render the prompt transcript and the "on screen right now" line.
- `services/affect/package.json:16` also lists the dependency, but no file under `services/affect` imports it (unused dependency).

Both windows are sized by the same config key `brain.working_memory_events` (default 24, `packages/config/src/schema.ts:97`; config segment). The two copies are independent; nothing synchronizes them except receiving the same events.

The package also owns the plumbing for **test-injection flags** (added by `add-test-injection`): contexts retain `injected` / `remember` on the events they store, and `propagatedFlags` copies them onto derived bus events so a reply to an injected input is itself marked injected. The flags are defined on the bus schemas in [event-bus](../event-bus/event-bus-design.md); the policy of what to do with them lives in [memory](../memory/memory-design.md) (`services/memory/src/region.ts:11-12`), [salience](../salience/salience-design.md) and [cortex](../cortex/cortex-design.md).

## The `Context` window

`ContextEvent` is a discriminated union on `kind` (`index.ts:22-26`):

| kind | Built from | Fields | Seen on arrival |
|---|---|---|---|
| `chat` | bus `chat.message` | `ts` (bus event ts), `user`, `text`, `mention` (from `mentionsCohost`), `isMod`, `isSub`, `seen`, plus `InjectionFlags` | no |
| `vision` | bus `vision.summary` | `ts`, `text`, `changed`, `seen`, plus `InjectionFlags` | `seen = !changed` |
| `speech` | bus `speech.heard` | `ts`, `speaker`, `text`, `seen`, plus `InjectionFlags` | no |
| `self` | `pushSelf(text, emotion)` (not a bus event) | `ts` (`Date.now()`), `text`, `emotion`, `seen: true` (literal type), no flags | always |

`Context` (`index.ts:29-105`) holds a private `events` array, the public string `lastVision`, and a `max` count from the constructor.

- **`push(ev: BusEvent)`** (`index.ts:35-59`) switches on `ev.type`. `chat.message`, `vision.summary` and `speech.heard` are converted and appended; every other type hits `default: return` and leaves the window untouched (`index.ts:55-56`). `brain.say` is therefore not ingested here; own and other speakers' lines enter only via `pushSelf`, which the owning region calls (`services/cortex/src/cortex.ts:49` for every `brain.say`, including reflexes and operator lines from other sources).
- **Vision is special-cased** (`index.ts:42-49`): `lastVision` is set to the new text, every earlier `vision` entry is removed from the window, and the new one is appended. Only the newest screen description is ever present in the window. `changed: false` entries arrive already seen, so an unchanged screen does not count as new input, but still updates `lastVision`.
- **Trimming** (`index.ts:102-104`) is by count only: when the window exceeds `max`, the oldest entries are spliced off. There is no time-based eviction. Self lines count against `max` (`pushSelf` also trims, `index.ts:61-64`). Note the vision filter removes an old vision entry before the new one is pushed, so a vision update can lower the window length.
- **Seen tracking:** `unseen()` returns entries with `seen === false` (`index.ts:66-68`); `markSeen()` marks all (`:78-80`); `markSeenEvents(events)` marks only the given entries, matched by **object identity** through a `Set` of references (`:70-73`), so callers must pass entries obtained from this same `Context` (via `unseen()`, `last()` or `all()`); entries already trimmed or foreign objects are ignored silently. This is what lets salience mark only the events it scored while newer arrivals stay unseen (`services/salience/src/salience.ts:97,117`).
- **`last()`** returns the newest entry (`:75-77`); salience uses it right after a synchronous push to identify the trigger (`salience.ts:93`).
- **`clear()`** empties the window but leaves `lastVision` untouched (`:81-83`; asserted by `context.test.ts:55`). Both services call it on the `forget_context` control command (`salience.ts:81`, `cortex.ts:91`).
- **`all()`** exposes the live array as `readonly ContextEvent[]` (`:84-86`), not a copy.

### Transcript rendering and the stop-string contract

`transcript(cohostName)` (`index.ts:89-100`) maps each event to one line and joins with `"\n"`:

| kind | Line |
|---|---|
| `chat` | `[chat] <user>` + ` (mod)` if `isMod` + `: <text>` |
| `speech` | `[voice] <speaker>: <text>` |
| `vision` | `[screen] <text>` |
| `self` | `<cohostName>: [<emotion>] <text>` |

`isSub`, `mention`, `changed`, timestamps, and the injection flags are **not** rendered, so an injected event is indistinguishable from a real one in the prompt.

**Cross-segment contract:** the tags `[chat]`, `[voice]`, `[screen]` are coupled to the LLM stop sequences. `packages/llm/src/index.ts:45` defines `TRANSCRIPT_STOPS = ["\n[chat]", "\n[voice]", "\n[screen]"]` with the comment "Lines that mean 'the model started writing the next transcript entry': stop there", and `REPLY_STOPS = ["\n\n", ...TRANSCRIPT_STOPS]` (`:47`, comment: exactly four entries because OpenAI-style APIs reject more than four) is sent as `stop` for every non-JSON chat call (`:86`, `:150`). If a tag here is renamed, or a new line kind is added without a matching stop, a model that continues the transcript will not be cut off and will speak invented viewer lines. The coupling is documented only by comments and one test title (`context.test.ts:79`, "transcript renders each kind with the tags the LLM stop sequences rely on"); no test spans both packages. The model-backends segment owns the stop list; see [model-backends](../model-backends/model-backends-design.md). The `self` format (`Coco: [emotion] text`) is the shape the prompt asks the model to produce (`services/cortex/src/prompt.ts:36` instructs an emotion tag first); the self line is deliberately not a stop string because it is the expected reply form.

Consumers of `transcript`: `services/cortex/src/prompt.ts:42` (the prompt) and `services/cortex/src/cortex.ts:121` (passed to the critic). Consumers of `lastVision`: `services/cortex/src/prompt.ts:32` and the recall query fallback `cortex.ts:109`.

## Injection flags

Introduced by `add-test-injection`; defined in `index.ts:4-20`.

- `InjectionFlags { injected?: boolean; remember?: boolean }` is exported and intersected onto the `chat`, `vision` and `speech` variants only. `self` never carries them (`index.ts:26`).
- `flagsOf(d)` (`index.ts:8-13`, private) copies only the flags that are actually defined on the bus event's data, so real events yield entries with neither key (asserted by `context.test.ts:99`: `"injected" in real` is false).
- `propagatedFlags(src)` (`index.ts:16-20`, exported) returns `{}` unless `src.injected` is truthy; for an injected source it returns `{ injected: true }` plus `remember` when defined. A stray `remember` on a real (non-injected) event is dropped. `src` may be `undefined` (the cast comment says "`self` events have no flags"). Callers spread the result into a publish: salience reflex reply (`salience.ts:98`) and focus (`salience.ts:130`), cortex reply (`cortex.ts:128`, via `propagatedFlags(focus)`). `focus` there is the bus `attention.focus` payload, so flags flow chat.message/etc. -> context entry -> `attention.focus` -> `brain.say`.
- Because a real vision update replaces an injected one (and vice versa), the single vision slot can switch between injected and real provenance.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where the window lives | One `Context` instance per region (salience, cortex), each fed independently from the bus | A shared service or Redis-backed window | `[inferred]` Regions only talk through the bus and keep no shared state (`packages/bus/src/events.ts:3-6`); each constructs its own (`salience.ts:32`, `cortex.ts:35`). |
| Eviction | Count-based (`max` from `brain.working_memory_events`) | Time-based or token-based | `[inferred]` Simplest bound on prompt size; `index.ts:102-104` and config default 24 (`packages/config/src/schema.ts:97`). |
| Vision handling | Keep only the newest vision entry; `lastVision` survives `clear()` | Keep all vision lines | `[inferred]` Comment at `index.ts:45`: older lines "are noise"; `lastVision` kept so recall queries still work after a context wipe (`context.test.ts:55-68`). |
| Seen tracking | Per-entry `seen` flag; `markSeenEvents` by object identity | Index/ts-based marking; mark-all only | `[inferred]` Comment at `index.ts:69`: do not mark events that arrived while a decision was in flight; salience relies on it (`salience.ts:97,117`). |
| Self lines | Not derived from bus events; the region calls `pushSelf` | Ingest `brain.say` in `push` | `[inferred]` Lets cortex decide to record every `brain.say` regardless of source, with `Date.now()` ts and the emotion; `push` explicitly ignores other types (`index.ts:55`). |
| Transcript tags | `[chat]`, `[voice]`, `[screen]` prefixes; own lines as `Name: [emotion] text` | Role-based chat messages; structured JSON | `[inferred]` Matches the stop-sequence list in `packages/llm/src/index.ts:45`, which exists to cut the model off when it hallucinates the next input line. |
| Injection flag propagation | Free function `propagatedFlags(src)` in this package; copy only when `injected` is truthy | Each region copies flags itself; always copy | `[inferred]` One place guarantees real traffic never gains `injected` / `remember` and that a stray `remember` is dropped (`index.ts:15`); used from two services. |

## Open Questions & Future Decisions

1. **Stop-string coupling is implicit.** `[chat]` / `[voice]` / `[screen]` are string literals at `index.ts:93-95` and again at `packages/llm/src/index.ts:45` with no shared constant or cross-package test. A rename on one side silently breaks reply truncation. (Flagged in sweep-1; still true at `686cc8f`.)
2. **Transcript injection / forging.** `transcript` interpolates `text`, `user` and `speaker` without escaping newlines. A multi-line chat, STT result or injected text that contains `\n[chat] ...` would forge a transcript line in the prompt (`index.ts:93-95`). Twitch chat is normally single-line, but `speech.heard` and dashboard-injected text are not constrained by the bus schema (`packages/bus/src/events.ts:35-43`).
3. **Injected events look real to the model.** The flags are not rendered (`index.ts:93-96`), by design of the injection feature (the test input should take the real code path). Whether the model or critic should ever see a marker is undecided.
4. **`propagatedFlags` has no unit test in this package.** It is covered indirectly by salience (`services/salience/test/salience.region.test.ts:195-222`) and cortex (`services/cortex/test/cortex.region.test.ts:310-320`) region tests; `context.test.ts` only covers flag retention (`:99`).
5. **`markSeenEvents` identity semantics are fragile.** It silently ignores events not in the window (tested at `context.test.ts:70`), and `all()` / `unseen()` return live references, so a caller that clones events cannot mark them.
6. **`all()` leaks the internal array** (`index.ts:84-86`) as `readonly` only at the type level.
7. **Unused/over-broad dependencies.** `@cohost/bus` and `@cohost/config` are listed as runtime `dependencies` but used type-only (`index.ts:1-2`, `packages/working-memory/package.json:8`); `services/affect/package.json:16` depends on the package without importing it.
8. **Duplicate windows.** Salience and cortex each keep a full copy and could drift (for example `forget_context` is handled separately in each; cortex also clears `viewerNotes`, `cortex.ts:91`). Salience never calls `pushSelf` (its `unseen()` consumer filters `self` anyway, `services/salience/src/scheduler.ts:47`), so its window lacks own lines while cortex's has them.
9. **Timestamp clocks differ by kind.** Sense entries use the publisher's bus `ts` (`index.ts:39,47,52`); `self` entries use the consumer's `Date.now()` (`index.ts:62`).
10. **Redundant casts.** `ev.data as BusEvent<"chat.message">["data"]` inside each case (`index.ts:38,43,51`) because `BusEvent` defaults to the union type and does not narrow on `ev.type`.
11. **Vision entry is placed last on update**, not in its original position, so the transcript order of `[screen]` relative to chat changes whenever vision updates (`index.ts:46-47`).

## References

- Segment files: `packages/working-memory/src/index.ts`, `packages/working-memory/test/context.test.ts`, `packages/working-memory/package.json`, `packages/working-memory/tsconfig.json`.
- Depends on: [event-bus](../event-bus/event-bus-design.md) (type import of `BusEvent`; consumes `chat.message`, `vision.summary`, `speech.heard` and their injection flags), [config](../config/config-design.md) (type import of `Emotion`; sizing key `brain.working_memory_events`).
- Depended on by: [salience](../salience/salience-design.md) (`Context`, `propagatedFlags`), [cortex](../cortex/cortex-design.md) (`Context`, `propagatedFlags`, `InjectionFlags` type, `transcript`, `lastVision`); `services/affect/package.json` lists it but does not use it.
- Coupled contract: [model-backends](../model-backends/model-backends-design.md), `packages/llm/src/index.ts:45` (`TRANSCRIPT_STOPS`) and `:47` (`REPLY_STOPS`).
- Flag consumers: [memory](../memory/memory-design.md) (`services/memory/src/region.ts:11-12` `skipInjected`), [dashboard](../dashboard/dashboard-design.md) (injection producer).
- External libs: none at runtime (types only).
- OpenSpec: `openspec/specs/working-memory/spec.md` (baseline); delta `openspec/changes/add-test-injection/specs/working-memory/spec.md` ("Injection flags retained"). `propagatedFlags` is covered by the salience and cortex "Injection flag propagation" requirements in `openspec/changes/add-test-injection/specs/salience/spec.md` and `.../cortex/spec.md`, not by a working-memory requirement.
- Sweeps: `sweep-1-packages.md` (working-memory), `sweep-5-delta-packages.md` (injection-flag delta).
