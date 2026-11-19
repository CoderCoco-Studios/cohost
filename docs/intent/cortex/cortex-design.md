---
parent: high-level-design
prefix: CTX
---

# cortex

Brownfield: this document describes the intended behaviour and, where the code
lags, says so with the spec ID of the gap. It was audited against the code on
2026-11-01 and carries the owner's decisions of 2026-11-01.

## Context and Design Philosophy

cortex is the language region (`services/cortex`): the only region
that generates the main reply (salience and affect `llm` hooks and the cortex critic
hook may also call a model, per the HLD). It does not decide whether to speak
(salience does) and it does not remember beyond a rolling window (memory does).
It waits for `attention.focus`, assembles a prompt from personality, mood, viewer
notes, recalled memories and a working-memory transcript, calls the model, runs the
reply past the `cortex.critic` hook, and publishes `brain.say`.

Observed principles:

- Single-threaded thinking: at most one LLM call in flight, and nothing is spoken
  over someone else's line.
- Every exit from `think()` reports a `brain.status`, because salience assumes the
  cortex is busy once it fires (`cortex.ts` comment); a failed status publish is
  logged, never left as an unhandled rejection (`CTX-GATE-008`).
- Turn-taking is owned upstream of the body: cortex and salience are the only
  services that read `mute` and `pause`; voice, mouth and ears stay unaware of them. The
  operator's `say` is an override that bypasses mute, pause and busy.
- Degrade rather than block: a silent memory region costs `recall_timeout_ms`, a
  failing LLM or critic goes back to `idle`, a down model backend is waited for at
  startup and reported `degraded`.
- All logic lives in the `Cortex` class (`cortex.ts`) with the bus, LLM, critic,
  logger and personality loader injected (`CortexDeps`, `cortex.ts`);
  `index.ts` and `main.ts` are only wiring.

## Event wiring

Subscription (`startup.ts`): group `cortex`, start mode `latest`, types
`chat.message, chat.removed, speech.heard, vision.summary, brain.say, voice.done, voice.stop, voice.failed,
attention.focus, memory.recall.reply, memory.notes.reply, memory.viewer, affect.state, control`
(`CTX-EVT-001`; `voice.failed` carries the spoken fallback line, `CTX-EVT-008`; never
`speech.partial`: an interim transcript is not speech to the cortex, CTX-EVT-009). The service publishes `brain.status`,
`brain.say`, `memory.recall.request` and `memory.notes.request`.

Subscribing happens only after the model backend answered `ping()` (`main.ts`).
Start mode `latest` resets the `cortex` group to the stream's newest entry on every
start (`CTX-EVT-001`), so nothing published while the cortex was down or waiting
for its backend is delivered: a stale `attention.focus` must never trigger an LLM
call and a late `brain.say`. Delivery across a restart is at-most-once (event-bus).
The control plane's `fresh` start, cortex's default manifest mode
(`packages/control/src/manifest.ts`), resets the group as well; `latest` makes a
plain crash or container restart behave the same.

`ready` is reported once the `cortex` group exists (`CTX-START-003`): `startCortex`
(`startup.ts`) awaits `bus.resetGroup("cortex")`, which creates the group at
the stream's newest entry if it is missing, before it starts the subscription and
calls `heartbeat.ready()`. `Bus.subscribe` creates its group asynchronously and gives
the caller no signal when it has, so readiness cannot hang off it.

| Event in | Handling | Evidence |
|----------|----------|----------|
| `chat.message`, `speech.heard`, `vision.summary` | `ctx.push(ev)` into the `Context` window (`brain.working_memory_events`, default 24) | `cortex.ts` |
| `brain.say` (any source) | `ctx.pushSelf(text, emotion)`; if `ev.source !== "cortex"` also add `d.id` to the pending lines with the time and arm its speaking-timeout release (`startSpeaking`) | `cortex.ts` |
| `voice.done` | if `d.id` is a pending line: end it; once no line is pending, publish `brain.status` `muted` (muted or paused) else `idle`. Whether or not the line is still pending, an interrupted `voice.done` with `spokenText` records it as what was heard (`markHeard`, see Repetition check), and a `voice.done` that is not interrupted clears an earlier record that nobody heard the line | `cortex.ts` |
| `voice.stop` | end every pending line the order names (all when `ids` is absent); once no line is pending, publish `brain.status` `muted` (muted or paused) else `idle`; an in-flight think is left alone (see Interruption) | `CTX-EVT-010`, `CTX-GATE-010` |
| `voice.failed` | with `fallback`: mark the line's transcript entry and keep a pending glitch for the next reply (see Fallback acknowledgement); without `fallback`: record the line as heard by nobody (`markHeard` with the empty string) and change nothing else | `CTX-FALL-002`, `CTX-FALL-003`, `CTX-FALL-007` |
| `attention.focus` | `this.think(...)` not awaited, so the recall reply can be delivered; a rejection is logged | `cortex.ts` |
| `memory.recall.reply` | resolve the pending recall with the same `id`; unknown or late ids ignored | `cortex.ts` |
| `memory.notes.reply` | resolve the pending notes request with the same `id`; unknown or late ids ignored (`CTX-NOTES-003`) | `cortex.ts` |
| `memory.viewer` | build or clear a one-line note for that viewer, keyed by platform and user id | `cortex.ts` |
| `chat.removed` | `ctx.forget(removal)`; for `scope: user`, also delete that viewer's familiarity note (Forgetting a removed message); a think already in flight keeps the transcript it took (`CTX-FORGET-001`, `CTX-FORGET-002`) | `cortex.ts` |
| `affect.state` | store as the latest `Mood` | `cortex.ts` |
| `control` | see Control commands | `cortex.ts` |

Own versus other lines are distinguished purely by the bus source string:
`ev.source !== "cortex"` (`cortex.ts`) depends on `new Bus("cortex", ...)`
(`main.ts`). The cortex's own line is added to the pending lines inside `say()` before
it publishes; lines from salience reflexes or the operator are added on arrival. Pending
lines are a map by `brain.say` id, not a single id: a line stays pending until its own
`voice.done` or its valve, so an operator `say` over a playing line does not forget it
(`CTX-SAY-005`).

## The think pipeline

`think(focus)` (`cortex.ts`):

1. Gates, in order, each publishing a status and returning without an LLM call:
   already `thinking` → `thinking` with the new reason (`cortex.ts`);
   `muted || paused` → `muted` (`cortex.ts`); `voiceBusy()` → `speaking`
   (`cortex.ts`). A failed publish on these paths is logged and the think
   returns (`CTX-GATE-008`; `statusLogged`, `cortex.ts`).
2. Set `thinking = true` (cleared in `finally`, `cortex.ts`), publish
   `thinking` with `focus.reason` as detail.
3. Recall (`cortex.ts`): the query is the focus text when it is
   non-empty, else the last vision summary; when both are empty recall is skipped
   (`CTX-RECALL-001`). If
   `brain.memory.recall_k <= 0` no request is made. Otherwise publish
   `memory.recall.request {id: uuid, query, k: recall_k}` and wait up to
   `brain.cortex.recall_timeout_ms` (default 2500) for the reply; timeout logs
   `memory region did not answer in time` and continues with `[]`; a failed publish
   resolves `[]` immediately.
   In parallel, publish `memory.notes.request` for the viewers in the focus and the
   window and wait for its reply under the same deadline (`CTX-NOTES-001`,
   `CTX-NOTES-002`; see Viewer notes).
4. Viewer note: look up the `viewerKey` of `focus.focus` (its `platform`, `userId` and `who`) and put the note in the prompt; it
   is deleted only once the reply's `brain.say` is published, so a vetoed, dropped
   or failed reply keeps it for the next one (`CTX-VIEWER-003`; looked up at
   `cortex.ts`, deleted by the `onPublished` callback of `say()`,
   `cortex.ts`, and only if a newer note has not replaced it meanwhile).
5. `buildMessages` (below), then `llm.chat(messages)` with no per-call options, so
   the provider's configured defaults (`llm.max_tokens` etc.) apply. Elapsed ms,
   reason and memory count are logged at `info`; the raw model text, which can echo
   chat and is unfiltered by the critic, only at `debug` (`CTX-PROMPT-007`, `cortex.ts`). Each `llm.chat`
   outcome also feeds `deps.llm` (`CTX-HEALTH-003`; the provider is wrapped by
   `trackLlm`, `startup.ts`).
6. `parseReply`; if the text is shorter than 2 characters the think ends without a line (No-line exit, below).
7. Critic (`cortex.critic` module): `ok:false` → log and end without a line. A returned `text` goes through the same `parseReply` as the model's reply, so a rewrite is one line with its bracketed spans and its delimiters stripped before anything else reads it; the parsed text replaces the original, and a rewrite that parses to fewer than 2 characters ends the think without a line. A returned `emotion` that is valid replaces the original; an emotion tag inside the rewritten text does not. The gesture of the model's reply is kept, and a `[gesture:...]` inside the rewrite is stripped like any bracketed span (`cortex.ts`; CTX-CRITIC-012).
8. Repetition check (below): when the text that would be said is too similar to a line the co-host recently said, log and end without a line. It runs on the final text, after any critic rewrite.
9. Re-check after the slow work: muted/paused → publish `muted`; `voiceBusy()` (a
   reflex or operator line began) → log `dropped`, publish `speaking`
   (`cortex.ts`).
10. `say(text, emotion, gesture, focus.reason, propagatedFlags(focus))` publishes
   `brain.say {id, text, emotion, gesture, reason, ...flags}` then `brain.status`
   `speaking` with the text as detail. Flags `injected` and `remember` are copied
   only from an injected focus (`@cohost/working-memory` `propagatedFlags`).
11. Any thrown error is logged `think failed` and publishes `idle` (publish failure
    swallowed, `cortex.ts`).

**No-line exit.** A think that ends without a line (an empty reply, a critic veto, a repetition hit) publishes no `brain.say` and publishes `brain.status` `muted` when the cortex is muted or paused at that moment, else `speaking` while any line is pending or playing, else `idle`. The status rule is one, so the same state is reported on each of the three paths (CTX-GATE-012).

**Order of a think.** The think runs these steps in this order: parse the model reply, run the critic, run the repetition check, run the mute and busy re-check, then publish `brain.say` (CTX-GATE-013). The built re-check (CTX-GATE-005, CTX-GATE-006) already runs after the critic returns, so the repetition check sits between two steps that exist.

`voiceBusy()` also ends every pending line once `speaking_timeout_ms` (default 20000)
has elapsed since it began (`cortex.ts`): a stuck voice sink releases the cortex. The
elapsed time is measured on the monotonic clock (`performance.now`), so a wall
clock stepped forward by NTP or VM time sync does not release a playing line early.
A timer
armed per line when it starts (`startSpeaking`; cleared by that line's `voice.done`)
publishes `idle` (or `muted` when muted or paused) when the timeout elapses and no other
line is pending, so salience and the dashboard see the release (`CTX-GATE-009`); it
stays silent while a think is in flight, which ends with a status of its own, and it
schedules no think.

### Prompt and reply (`prompt.ts`)

`buildMessages` returns exactly two messages. System: trimmed personality, `## Now`
(local time in `cohost.timezone`, streamer, co-host name), optional screen line
(`ctx.lastVision`), optional mood line (`describeMood`: valence to
"in a great mood / cheerful / even / a bit down / fed up", arousal to
"buzzing / engaged / relaxed"), optional viewer note, optional
`## Things you remember` block of `- (YYYY-MM-DD) who: text`, the standing instruction about viewer text, and an `## Output`
instruction (one short spoken line, leading `[emotion]` tag from `EMOTIONS`, optional
`[gesture:name]`). User: `## Recent transcript` (or `(quiet)`) and a closing nudge
chosen by `reason` and focus kind (`describeFocus`, `prompt.ts`).

**Viewer text in the prompt.** Viewer-authored text reaches this prompt only bounded and quoted (HLD tenet 13), through the shared untrusted text guard ([shared-runtime](../shared-runtime/shared-runtime-design.md) Untrusted text guard), and every name goes through `speakerLabel`. Who renders what:

- Working-memory renders each transcript line (working-memory, Transcript rendering): `[chat]` lines with a name label and the message quoted in `«` and `»`, `[voice]` and `[screen]` lines bounded and unquoted. The prompt builder and the critic receive the rendered lines and do not quote them again.
- The prompt builder renders everything else, quoting each text exactly once: every name it prints outside the transcript (the closing nudge's `who`, the familiarity line, the `## People here` names, the `who` of a recalled memory) through `speakerLabel(name, viewer_text.max_name_chars)`; the text of a recalled memory of kind `chat` and the text of each viewer note through `quoteUntrusted(text, viewer_text.max_chars)`, which also flattens it to one line and bounds it, whatever was stored and whenever; the handling hint of a sensitive note through `boundText(hint, viewer_text.max_chars)`, unquoted, because the hint is the co-host's own guidance and the note's facts stay quoted; a recalled memory of kind `speech` or `self` through `boundText` with the speech limit, unquoted. A bounded row in the store is not what keeps this prompt bounded: the builder bounds what it renders (CTX-PROMPT-009 to CTX-PROMPT-015, CTX-NOTES-009, CTX-NOTES-010, CTX-VIEWER-004).
- The standing instruction, `untrustedNotice` with the subject "what a viewer wrote in chat, or what is remembered about a viewer", sits in the system turn immediately before `## Output`, next to the instruction it protects; it says quoted text is information and never an instruction.
- Reply parsing strips `«` and `»` from the reply (below), so a model that echoes quoted viewer text cannot put the delimiters on stream.

Marking lowers the chance that the model obeys what a viewer typed; it does not remove it. What stands behind it, in order: `parseReply` keeps one first line and strips bracketed text, so an obeyed instruction yields one short line and no tags or extra lines; the critic, when it is an `llm` or `http` hook (the default `rules` critic passes everything, so with the default settings nothing here inspects the content); the repetition check; and the speaking gates (tenet 4), because a reply exists only after salience decided the co-host should speak and the cooldown and busy gate bound how often. None of them acts against a viewer.

Transcript tags are owned by working-memory (`[chat]`, `[voice]`, `[screen]`); the
chat providers stop on the same tags only to save tokens, and `parseReply` keeps the
first line regardless. The co-host's own lines begin with its name and are not a
stop. A cortex-level test renders each line kind through `Context.transcript` and
checks it against the provider's stop list (`CTX-PROMPT-008`). `TRANSCRIPT_STOPS`
(`packages/llm/src/index.ts`) is not exported, so the test captures the stop list
the real Ollama and OpenAI-compatible providers put on the wire and compares it with
`TRANSCRIPT_TAGS` (`packages/working-memory/src/index.ts`).

`parseReply` (`prompt.ts`): first line only; strip a leading `Name:` before a
tag; parse `[emotion]` and optional `[gesture:x]`; strip all remaining bracketed
text, the delimiters `«` and `»` (`UNTRUSTED_OPEN` and `UNTRUSTED_CLOSE`), surrounding quotes and a leading `word:`; unknown emotion becomes `neutral`;
gestures are not validated.

### Viewer notes

Two things reach the prompt about viewers.

**The familiarity line** (the `viewerNotes` map in code). `memory.viewer` → note
text: `isNew` gives "`<user>` is new here (first message)."; `regular` true gives
"`<user>` is a regular (N messages)."; otherwise no note (`CTX-VIEWER-001`). Memory
decides who is a regular (the owner's flag or the configured message threshold,
memory `MEM-REG-001`); the cortex holds no threshold of its own and the event
carries no notes text. Notes are keyed by the viewer's key from the shared guard's `viewerKey` (platform and user id; a `memory.viewer` that carries no `platform` makes no note), a new event replaces or clears
the old one, and the map is capped at 50 with oldest-first eviction
(`cortex.ts`).

**Viewer notes from memory** (`CTX-NOTES-*`). The co-host's short notes about
viewers (core: who they are; recent: what they are up to lately) are fetched for
each reply, for the viewer being replied to and for the other viewers in the
working-memory window, whatever their message count. Step 3 of the think pipeline
publishes `memory.notes.request {id, viewers}` alongside the recall request; `viewers`
is the focus's viewer (`who`, `platform`, `userId`) followed by the distinct chat viewers in the window, one entry per `viewerKey`, newest
first, each entry carrying the display name and the platform and user id of its window entry (`CTX-NOTES-001`). Memory identifies each by platform and user id, so notes about one viewer never reach another viewer who shares the name. Both replies share one
`recall_timeout_ms` deadline, and a missing reply means no notes, never a stalled
reply (`CTX-NOTES-002`, HLD tenet 3). Memory has already capped, ordered and
filtered the notes (strongest first, a per-viewer and a total cap, sensitive
notes only for the replied-to viewer and rarely; memory `MEM-SURF-*`).

The notes are rendered in a `## People here` block of the system message
(`CTX-NOTES-004`):

```
## People here
- alice: «got a new puppy named Biscuit»; «speedrunning Celeste lately»
  - handle gently: check in warmly and gently; never name or quote it
- bob: «new to the channel's Minecraft server»
```

Each fact is one quoted, bounded line; a handling hint is the co-host's own guidance, one bounded line, unquoted (Viewer text in the prompt). A viewer's regular status reaches the prompt only through the familiarity line, never as a marker in this block. `general` notes are plain facts. For `health` and `family` notes the model receives
only the handling hint, never the note text: memory leaves the text out of the
reply (memory `MEM-SURF-004`), and a sympathetic check-in works from the hint
alone (`CTX-NOTES-005`). Subscriber status, though memory stores it, never appears
in the prompt, nor does any other money-related detail (`CTX-NOTES-006`). Notes live only
for the think that asked for them, so a note the owner deletes is gone from the
next reply and `forget_context` has nothing to clear (`CTX-NOTES-007`). Note text
never appears in `info` logs or `brain.status` details (`CTX-NOTES-008`).

### Fallback acknowledgement

When one of the co-host's lines fails to play and a fallback line is said in its place ([mouth](../mouth/mouth-design.md) Fallback Line), she should know she glitched and may joke about it. Owner decisions: the transcript records the fallback as her line with a note that the intended line failed; her next reply gets a prompt hint about the failed line that states a base chance of 1 in 4 (`brain.cortex.fallback_ack_chance`, default 0.25) as a nudge; the model decides in character whether to acknowledge. The cortex does not enforce the chance: there is no random draw, no per-personality number and no check of the reply (`CTX-FALL-006`). A shy personality will mostly shrug it off and a goofy one will milk it, so the real acknowledgement rate drifts with the personality, the model and the moment, and it is not expected to match the configured number. The hint wording, expiry and the handling of several glitches are.

- Every `brain.say` goes into working memory with its id (`CTX-FALL-001`, working-memory `WM-PUSH-007`).
- A `voice.failed` carrying `fallback` marks that line's transcript entry with the fallback text (`CTX-FALL-002`, `WM-PUSH-008`), so every later prompt and the critic's transcript show what was heard and that the intended line failed. It applies to any line, including reflexes and operator lines, because each is in the transcript.
- The same event sets a **pending glitch** (intended text, fallback text), replacing an older one (`CTX-FALL-003`).
- The next think that builds a prompt while a glitch is pending and its line is still in the window (`WM-WIN-007`) adds one line to the `## Now` block (`CTX-FALL-004`): `- Your voice glitched: your line "<intended>" failed to play and everyone heard "<fallback>" instead. You may react to it in character if that fits you; as a rough guide, about <N>% of the time. If it does not fit, let it go.` where `<N>` is the chance as a whole percentage.
- The glitch is consumed once that think's reply is published as `brain.say`; a vetoed, empty or failed reply keeps it for the next think. `forget_context` drops it, and so does its line leaving the window (`CTX-FALL-005`). One reply is the window in which a reaction still reads as one.
- With `fallback_ack_chance` 0 there is no hint line at all; the transcript note stays (`CTX-FALL-004`).
- A `voice.failed` without `fallback` (nothing played on that sink) records the line as heard by nobody, for the repetition check only (`CTX-FALL-007`); it changes neither the pending glitch nor the speaking state, and voice already releases the speaking state through the arbitration protocol. The line may still play on another sink: its non-interrupted `voice.done` then clears the record.

### Critic (`critic.ts`)

`createCritic` wraps `Module("cortex.critic", cfg.brain.cortex.critic, ...)`
(`critic.ts`) from `@cohost/modules`. Kinds: `rules` (default, always
`{ok:true}`: it inspects nothing, so the default critic checks neither content nor repetition), `llm` (an "inner editor" system prompt, JSON reply, 160 tokens,
`critic.ts`) and `http` (POST the `CriticInput`, whose `transcript` is the rendered transcript with its `«` and `»` marks and no notice; CTX-CRITIC-013). The `llm` critic reads the same marked transcript as the reply, so its system turn carries `untrustedNotice` too: a quoted viewer line that tells the editor to approve something is data. Its rule against repeating "something said moments ago" has the co-host's own last lines in front of it whatever the chat volume (working-memory, Keeping the co-host's own lines in the window); it is a semantic judgement by a model that can fail or be absent, which is why the built-in repetition check below exists beside it and not in its place. A returned `text` is parsed like a model reply (pipeline step 7; CTX-CRITIC-007 to CTX-CRITIC-011). The llm critic applies the
reply prompt's length rule, one short spoken line (`CTX-CRITIC-006`,
`critic.ts`). `validate` requires boolean
`ok`, trims `text` and drops blank text, drops unknown `emotion`, keeps `note` only
if a string (`critic.ts`). Anything unusable, a thrown error or a timeout falls
back to the rules result (pass-through) inside `Module.run`
(`packages/modules/src/index.ts`), so the critic can never block speech by
failing at run time. A critic configuration the `Module` constructor rejects (for
example `kind: http` with an empty `url`, `packages/modules/src/index.ts`)
throws while `cortexMain` builds the critic, inside the bootstrap's handler, so it
takes the `fatal` path and exits 1 (`CTX-START-005`).

## Repetition check

The co-host should not say the same thing twice in a row, and chat must not be able to make it: a model given a flood of near-identical messages tends to answer them with near-identical lines. The built-in check is deterministic, runs no model and does no I/O, and is part of cortex rather than of the critic hook, so it holds with every critic kind, the default `rules` critic included. Having no model it has no fallback of its own (HLD tenet 3). Specified by CTX-REPEAT-001 to CTX-REPEAT-015.

- **What it compares.** The line about to be said (after the critic, so a rewrite is checked too) against every `self` entry the working-memory window holds, whatever its source: cortex replies, reflex lines and operator lines. It never compares against chat.
- **What each recent line is taken to be.** What was heard: the entry's `heard` text when it has one, else its `fallback` text when a fallback line played in its place, else its text as the co-host meant it. The `heard` record is the spoken part of an interrupted line (an interrupted `voice.done` carries `spokenText` when mouth can compute it) or the empty string when nobody heard the line (a `voice.failed` without a fallback, until a non-interrupted `voice.done` for the same id clears it); a line with an empty `heard` is not compared. An interrupted line whose `spokenText` is absent is compared as meant. A line for which cortex has no playback event (one voice dropped before it started publishes none) is compared as meant: the check cannot tell it was never heard, and errs towards holding a reply back (CTX-REPEAT-003).
- **Similarity.** A word is a maximal run of characters in the Unicode categories L, M and N in the lower-cased text (`toLowerCase()` with no locale argument), with apostrophes (U+0027 and U+2019) removed inside a word first, so `don't` is `dont`. A line's word set is its distinct words. Two empty word sets are never a repeat. When either word set has fewer than three words, the lines are a repeat only if their word sets are equal and non-empty. Otherwise the similarity is the size of the intersection of the two word sets divided by the size of their union (Jaccard), and the lines are a repeat when it is at least `brain.cortex.repeat_similarity`. The value 0 turns the check off. Config owns the key, its default and its range.
- **On a hit.** Cortex stays silent: it ends the think without a line (No-line exit), logs the similarity and which recent line matched (the texts only at `debug`, as for the raw reply) and publishes no `brain.say`. It does not retry with another prompt: a veto does not retry either, and a retry would add a model call and its latency to a line that is already late. The viewer note and a pending glitch are kept for the next think, as for a veto, because they are consumed only by a published reply. Salience has already marked the focus seen, so the same events do not trigger another think.
- **Lines that are not from a think.** The check never withholds one: a salience reflex, an operator `say` (an explicit override that bypasses every gate) and the spoken fallback line are not cortex replies, so the check does not run on them. They are `self` entries in the window, so they are in the comparison set a later reply is checked against.
- **No window, no hit.** With no `self` entry in the window the check does nothing.

The check is count-based like the window: the lines in the window are compared however old they are. A co-host that spoke once an hour ago and speaks again compares against that hour-old line; on a quiet stream a genuine repeat after a long gap is therefore also held back. Which lines the window still holds is working-memory's rule: the newest few `self` entries survive a flood of chat, older ones until the window evicts them.

## Interruption

When salience stops a line it publishes `voice.stop` ([salience](../salience/salience-design.md) Barge-in), and a decision later it publishes `attention.focus` for the person who interrupted. The cortex must be able to think about that focus, and a pending line would make it answer `speaking` and decline (CTX-GATE-003). Two events could release the line, `voice.done` flagged `interrupted` from the sink and the `voice.stop` itself, and they reach cortex in an order nothing fixes: a sink publishes its `voice.done` after it has handled the stop, which can be after the `attention.focus`. So the cortex does not wait for the sink: on `voice.stop` it ends every pending line the order names (all of them when `ids` is absent, which is what salience sends), then publishes `idle` (or `muted`) once none is pending, exactly as for a `voice.done` (CTX-EVT-010). The interrupted `voice.done` that follows names a line that is no longer pending: it ends nothing and publishes no status (CTX-EVT-005), and its `spokenText`, when present, is recorded for the repetition check. This is also why lines that voice dropped before they started, which publish no `voice.done`, cannot leave the cortex waiting out `speaking_timeout_ms`.

The cortex neither aborts nor starts a think because of a stop (CTX-GATE-010): the one-thought-at-a-time rule stands, and an interruption is only a release of the lines that were speaking. The reply to the interrupter is an ordinary think on the next focus. The transcript keeps the interrupted line as the co-host meant to say it; the `unsaidText` that the interrupted `voice.done` can carry is not read, which is the deferred interrupted-thought work (WM-STACK-001, CTX-REPLAN-001), and `spokenText` is read only by the repetition check.

A think already in flight when a stop is read is not cancelled and its reply is subject to the usual rechecks (CTX-GATE-005, CTX-GATE-006). That case arises only when a line spoken by someone other than the cortex (an operator `say`) was playing while the cortex thought, and salience stopped it; see Open Questions.

## Control commands and status machine

`brain.status` states published: `idle`, `thinking`, `speaking`, `muted`
(`cortex.ts`; schema `packages/bus/src/events.ts`, field `detail`).

| Command | Effect | Evidence |
|---------|--------|----------|
| any with `target` other than `cortex` | ignored entirely; absent target = all services | `cortex.ts` |
| `pause` | `paused = true`, publish `muted` with detail `paused`; events still ingest, no LLM call | `cortex.ts` |
| `resume` | `paused = false`, publish `muted` if also muted, else `idle` | `cortex.ts` |
| `mute` / `unmute` | `muted` flag; `unmute` publishes `muted` if still paused, else `idle` | `cortex.ts` |
| `forget_context` | clear the `Context` event window, the last vision summary and viewer notes; the mood and pending recalls are kept (`CTX-CTRL-004`) | `cortex.ts`, `packages/working-memory/src/index.ts` |
| `reload_personality` | re-read via injected `loadPersonality` | `cortex.ts` |
| `say` with `text` | operator override: `say(text, "neutral", undefined, "operator")` with no mute, pause or busy check, and no injection flags; leaves any pending line pending (`CTX-SAY-005`) | `cortex.ts` |

The bus schema (`packages/bus/src/events.ts`) has eight `control` commands; the
cortex handles these seven and ignores `set_routing`, which mouth reads. State summary: the cortex reports `muted` for
both mute and pause so salience stops waiting on it. After a successful `say` it
stays `speaking` until the matching `voice.done` returns it to `idle`/`muted`, or
until `speaking_timeout_ms` releases it (`CTX-GATE-009`).

## Startup, health and shutdown

`index.ts` calls `runCortex()` (`main.ts`), which runs `cortexMain` on the shared
bootstrap `runService`: logger, configuration, `Bus("cortex")` and the heartbeat in
`starting` come from the bootstrap, whose `health` reads the model backend state
`cortexMain` keeps current (`cortexHealth(() => llmOk, cfg.llm.provider, () => llmProbed, pingIsNominal)`).
`cortexMain` then builds the chat provider (`createChatProvider(cfg.llm)`), wrapped by
`trackLlm`, the critic and the `Cortex`, and:

1. Warns if the provider is `mock` (`main.ts`).
2. `waitForLlm` (`startup.ts`): loop `llm.ping()`; every result goes to
   `setOk` (so `llmOk`); each miss logs a warning and calls
   `heartbeat.degraded("model backend unreachable (name/model): lastError")`; sleep 3 s
   (`retryMs`); never throws, never gives up. The mock provider answers at once.
3. `startCortex` (`startup.ts`): publish `brain.status idle`, await
   `bus.resetGroup("cortex")`, start the subscription, `heartbeat.ready()`
   (`CTX-START-003`); then log `cortex online`.

Health (`health.ts`): service `cortex`, mode `mock` if the provider is `mock`
else `live`, deps `{llm: ok|down|n/a}` read from `llmOk` and `llmProbed`. After
startup every `llm.chat` outcome feeds `llmOk` through `tracked()` (`trackLlm`,
`startup.ts`), so a model outage during operation shows as `degraded` and a
recovered backend as `ok` again (`CTX-HEALTH-003`). Bedrock has no cheap probe and
its `ping()` always answers true (`pingIsNominal`, `packages/llm/src/index.ts`);
with that provider `llm` reads `n/a` (not probed) until the first reply outcome. The
marker is a standing heartbeat `detail` (`CTX-HEALTH-004`) that `HeartbeatSpec`
(`packages/shared/src/lifecycle.ts`) carries and `cortexHealth` sets for a nominal-ping provider.

The critic hook reports through the same `hookHealth` and `pingHooks` as the other region hooks (region-hooks, HOOK-HEALTH-004, HOOK-HEALTH-005). `cortexMain` builds the critic, publishes `hookHealth([critic])` to a sink the bootstrap's `health` reads, and starts `pingHooks([critic], log)` without waiting. The heartbeat adds `hook.cortex.critic` to `deps` for an llm or http critic (nothing for a rules critic) and is `mock` when the provider is `mock` or the critic hook sits on the mock provider (`CTX-HEALTH-006`, `CTX-HEALTH-007`). The hook is a soft dependency: a down critic leaves the cortex speaking, since its fallback passes the line.

Shutdown: the bootstrap runs the teardown steps (`Cortex.stop` releases the line timers),
then stops the bus; the `stopping` heartbeat is the heartbeat module's job. A pause also
shows as the heartbeat `detail` `paused` (`CTX-HEALTH-005`). Errors thrown inside
`cortexMain` log `fatal` and exit 1; a configuration that does not load logs the
loader's message and exits 1 (`CTX-START-004`).

Config keys read: `brain.working_memory_events` and `brain.working_memory_own_lines` (through `Context.forBrain`), `viewer_text.max_chars`, `viewer_text.max_name_chars`, `brain.input_limits.speech_max_chars`, `brain.memory.recall_k`,
`brain.cortex.{recall_timeout_ms, speaking_timeout_ms, fallback_ack_chance, repeat_similarity, critic.*}`, `cohost.{name,
streamer, timezone}`, `llm.*`. Env: `HEARTBEAT_INTERVAL_MS`; an isolated start's `LLM_PROVIDER`
override selects the mock preset through `COHOST_ISOLATION` (config CFG-ISO-007).

## Latency stamps

A `brain.say` the cortex publishes for an `attention.focus` carries `timing` (CTX-SAY-006, CTX-SAY-007): the focus's own `timing` (`audioEndedAt`, `heardAt`) copied unchanged, `focusedAt` (the `attention.focus` envelope `ts`), `llmStartedAt` (just before the think's first LLM request) and `llmEndedAt` (after the reply call returns), and `criticEndedAt` when the `cortex.critic` hook's call returns (CTX-SAY-008). The hook runs for every think that reaches it, whatever its kind (the default `rules` critic included), so every think's `brain.say` carries the stamp. The time between `focusedAt` and `llmStartedAt` is recall and viewer-note lookups; the time after the last of these stamps up to the `brain.say` envelope `ts` is the publish itself. A think whose reply is vetoed, too similar to a recent line, empty, a single character (dropped before the critic is asked) or failed publishes no `brain.say` and so no sample. An operator `say` and a salience reflex are not thinks and carry no `llm` stamps.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Releasing lines on a stop | Cortex ends its pending lines when it reads `voice.stop`; the sink's interrupted `voice.done` then ends nothing, since its line is no longer pending | Wait for `voice.done` flagged `interrupted`; salience delays the `attention.focus` until it sees the done | `voice.stop` and the sink's `voice.done` race the `attention.focus` for the interrupter, and a focus that finds a line pending is answered `speaking` and lost (CTX-GATE-003); salience does not read `voice.done`, so delaying the focus would give it a new subscription and a wait with its own valve. Ending the lines on the stop itself is the only order-independent release, and it also frees lines voice dropped unstarted, which publish no `voice.done`. |
| No abort on a stop | A stop ends pending lines only; a think in flight finishes and its reply goes through the ordinary rechecks | Abort the in-flight think on a stop; drop its reply on a stop | One thought at a time and no cancellation stand (below): an in-flight chat-model call has no useful abort, and the lines a stop ends are the cortex's own speaking, not a think. Dropping a reply on a stop would lose a thought whose focus salience has already marked seen. |
| Interrupted line in the transcript | The line stays in working memory as meant; `unsaidText` is not read; `spokenText` is read only to record what was heard for the repetition check | Rewrite the self line to the spoken part | Same stance as for a failed line (mouth Decisions, Long-term memory keeps the intended line). Using the texts needs an interrupted-thought stack (deferred, WM-STACK-001). |
| Interruptible, dynamic speech (deferred) | Recorded as a deferred spec (CTX-REPLAN-001); not built | Build clause-boundary re-thinking now | The deferred ideal ([HLD](../../high-level-design.md) Future / ideal state) would supersede One thought at a time and the rejection of cancelling an in-flight think: at each clause boundary of a speaking line the cortex would decide to continue, adapt, pivot or resume an interrupted thought. It needs clause-chunked speech and streaming model output, a playback position, a boundary re-think inside the latency budget and, for screen events, live vision, none of which exist. |
| Do not await `attention.focus` | `void this.think()` | await inside the handler | Comment `cortex.ts`: "the LLM call must not block the subscription loop, or the memory reply we're waiting on could never be delivered"; test `cortex.region.test.ts` |
| Pending lines | A map of lines by id, each with its own valve and timer; idle is published when the map empties | A single speaking id that a newer line overwrites | Owner decision 2026-11-11: an operator `say` over a playing line must not make the cortex forget it, so each line's `voice.done` is reconciled and the cortex reports idle only when nothing is playing. Overlap itself is voice's documented non-exclusivity. |
| Service construction | Provider, critic and `Cortex` are built inside `cortexMain` under `runService` | Build them at module load | A critic configuration the hook rejects must fail through the `fatal` path with the other startup errors, not as an uncaught exception at import (`CTX-START-005`). |
| Reply emotion type | `parseReply` returns an `Emotion`, narrowing the model's tag against the emotion list | A string cast to `Emotion` at each use | The cast hid the one place where the value is checked. |
| Recall over the bus with timeout | request/reply with `recall_timeout_ms`, proceed with `[]` | call Postgres directly; no timeout | Only memory touches Postgres and the cortex answers without recall when memory is down or slow: comment in `main.ts`, `config/config.example.yaml`, commit `969f6d7` ("cortex: ... answers without recall if memory doesn't reply in time") |
| One thought at a time | `thinking` flag plus status echo | queue focuses; cancel in-flight | Status echo: comment `cortex.ts` ("Salience assumes we're busy once it fires, so every path out of here reports a status"). Single flight instead of a queue: a queued focus would be answered after the conversation had moved on, and salience re-decides on fresh context every tick once the cortex reports idle, so a dropped focus costs nothing; cancelling the in-flight call would waste the model work already spent. Test `cortex.region.test.ts` |
| Own vs other `brain.say` | compare `ev.source` to `"cortex"` | tag lines with an origin field | The bus stamps every event with the publishing service's name (`new Bus("cortex")`), so no extra field is needed. Cortex marks its own lines speaking at publish time (`say()`), so only another source's line (for example a salience reflex) starts the speaking state from the echo. This relies on each service using its own name as the bus source; `cortex.ts` |
| Restart start mode | `latest`: reset the `cortex` group to `$` on every start | `resume` (replay the backlog); drop old focuses by age | owner decision 2026-11-01: a stale `attention.focus` must not produce an LLM call and a late line; only memory keeps its backlog; `CTX-EVT-001` |
| Who sees mute and pause | cortex and salience only | voice, mouth and ears also gate on mute | owner decision 2026-11-01: the services that decide to speak own the gate; the body plays what it is given |
| Status publish failures | log and continue on every think exit | let the unawaited think reject | owner decision 2026-11-01: an unhandled rejection ends the process; `CTX-GATE-008` |
| Speaking-timeout release | publish `idle`/`muted` when the timeout fires | release silently on the next think | owner decision 2026-11-01: salience and the dashboard see the release; `CTX-GATE-009` |
| Raw reply logging | raw model text at `debug`, timings and counts at `info` | raw text at `info` | owner decision 2026-11-01: the raw reply can echo chat and is unfiltered; `CTX-PROMPT-007` |
| Reply length | one short spoken line in both the prompt and the llm critic | critic allows two sentences | owner decision 2026-11-01: the critic enforces the prompt's rule; `CTX-CRITIC-006` |
| Transcript tags and stops | working-memory owns the tags; provider stops are a token saver; the self line is not a stop; a cortex test pins tags against stops | model-backends owns the list; stops as a correctness guard | owner decision 2026-11-01: `parseReply` keeps only the first line, so stops only save tokens; `CTX-PROMPT-008` |
| Runtime model health | every `llm.chat` outcome feeds `deps.llm`; Bedrock flagged as unprobed (a standing `detail`; `deps.llm: n/a` until the first reply) | startup ping only | owner decision 2026-11-01: the heartbeat reflects runtime dependency state; `CTX-HEALTH-003`, `CTX-HEALTH-004` |
| Readiness | `ready` after `resetGroup("cortex")` resolves, then the subscription starts | `ready` straight after `void subscribe`; a bus hook announcing group creation | `Bus.subscribe` creates its group inside the long-running call and signals nothing; `resetGroup` is awaitable, creates a missing group at `$` and is the same start-mode `latest` move; `CTX-START-003`, test `startup.test.ts` |
| Re-check busy and mute after the LLM | drop the reply if something else started speaking | speak anyway | Comment `cortex.ts`: "A reflex or operator line may have started while we were thinking; don't talk over it."; test `cortex.region.test.ts` |
| Stuck-sink release | `speaking_timeout_ms` inside `voiceBusy()`, plus a timer that publishes the release (`CTX-GATE-009`) | rely on `voice.done` only | Comment `cortex.ts` ("stuck-sink safety valve"), `packages/config/src/schema.ts` ("Give up on a stuck utterance / voice sink after this long") |
| Operator `say` bypasses gates | no mute, pause or busy check | route through `think` | owner decision 2026-11-01: `say` is the operator's override; `cortex.ts`, `CTX-CTRL-006` |
| Acknowledging a fallback line | A one-shot hint stating the base chance; the model decides in character; no enforcement | A random draw in code that adds the hint only on a hit; a per-personality chance; always acknowledge | Owner decision: the co-host's character should decide, so a shy personality shrugs a glitch off and a goofy one milks it. The cost is that the real rate drifts from the configured value; the configured value is a nudge, not a guarantee. `CTX-FALL-004`, `CTX-FALL-006` |
| Glitch lifetime | Consumed by the next published reply; dropped by `forget_context` or when its line leaves the window | A time limit; keep until the model acknowledges | The next reply is where a reaction makes sense; tying expiry to the window needs no new setting. `CTX-FALL-005` |
| Viewer notes one-shot, capped | delete after the reply is published, 50 entries FIFO | delete before the LLM call; persistent per-viewer notes | Per-viewer keying: comment `cortex.ts` ("so one viewer's framing never lands on another's reply"). Delete after success: owner decision 2026-11-01, so a vetoed or failed reply does not lose the note (`CTX-VIEWER-003`). The 50 cap bounds memory on a long stream: a note is replaced on each `memory.viewer` for that viewer and used once, so evicting the oldest only loses a note for a viewer not replied to since 50 newer viewer notes arrived |
| Who gets viewer notes in the prompt | The replied-to viewer and every other chat user in the working-memory window, regardless of message count | replied-to viewer only; regulars only (the earlier `msgCount > 25` gate) | Owner decision: the co-host should know the people in the conversation it is answering, and notes are kept for everyone from their first message. `CTX-NOTES-001`, `CTX-NOTES-007` |
| Fetching notes | Request/reply per think, in parallel with recall, one shared deadline | cache notes pushed by memory |. Current notes on every reply (owner deletions take effect at once) and no added latency beyond the recall wait the cortex already accepts; memory's design records the alternatives. `CTX-NOTES-002` |
| Rendering sensitive notes | Handling hint only, bounded and unquoted; the note text never reaches the model, and a note's facts stay quoted | plain facts like any note; hint plus the text as private background | Owner decision (the safest option): sensitive notes shape behaviour rather than being quoted, and a model that never sees the text cannot repeat it on stream. The cost is a vaguer check-in than the text would allow. `CTX-NOTES-005` |
| Subscriber status in the prompt | Never rendered | `(subscriber)` marker | Owner decision (the safest option): memory may remember it, but no money-related detail reaches the prompt, so the co-host cannot call anyone out by it. `CTX-NOTES-006` |
| `forget_context` scope | clear the window, the vision summary and viewer notes; keep mood and pending recalls | keep the vision summary | owner decision 2026-11-01: a forgotten screen must not keep feeding the prompt and the recall fallback; `CTX-CTRL-004` |
| Recall query | focus text, else the vision summary when the text is empty | fall back only when there is no focus object | owner decision 2026-11-01; `CTX-RECALL-001` |
| Pause reported as `muted` | reuse existing status | add a `paused` state | Comment `cortex.ts`: "Reported as \"muted\" so salience stops waiting." |
| Where the repetition check runs | Inside cortex, after the critic and before the mute and busy re-check, on the final text; a hit is silence by the No-line exit; reflex, operator and fallback lines are exempt | Inside the critic's `rules` implementation; before the critic; before and after it; retry the think with a "say something different" hint; only the `llm` critic's repetition rule | A rules critic that checked repetition would not run when the owner configures an `http` or `llm` critic, and the check must hold with every kind. After the critic is the one position that also covers a rewritten line; the check is cheap, so the only cost is the critic call on a line that is then dropped, paid only by an `llm` or `http` critic. A retry is a second model call on a line that is already late, and a veto does not retry (One thought at a time). Reflexes and operator lines never pass through `think`, and an operator `say` is an override. |
| No-line exit status | One rule for an empty reply, a veto and a repetition hit: `muted` if muted or paused, else `speaking` while any line is pending or playing, else `idle` | `idle` on each of the three; a separate status per path | A mute or pause that lands during the think is reported on every path that ends without a line, as the re-check already reports it; a line still playing keeps the cortex `speaking` so salience's busy gate and the dashboard do not read an end of think as an end of speech. |
| Critic rewrite is parsed | A critic's `text` goes through `parseReply` like a model reply; its `emotion` wins when valid; a tag in the text does not | Trust the rewrite as returned | An `http` or `llm` critic is a model or an owner's service and can return several lines, brackets or delimiters; whatever reaches `brain.say` must meet the same single-line rule. |
| Similarity measure | Jaccard of word sets (characters of categories L, M and N, lower-cased, apostrophes removed), with an exact-set rule when either line has under three words; threshold `brain.cortex.repeat_similarity`, 0 off | Exact match only; character n-gram overlap; edit distance; embedding similarity; Jaccard alone | Exact match misses "Nice shot!" then "nice shot!!"; edit distance and n-grams score long lines inconsistently and are hard to explain to the owner who tunes the key; an embedding needs a model call, against a check meant to need none. Jaccard alone would call "Nice shot" and "Nice play" half similar and "ok" and "ok then" half similar, so for short lines only equality counts, and two empty sets (a line of emoji or punctuation) never count. A reworded repeat with different words is not caught, which the `llm` critic's judgement can still catch. |
| Compared lines | Every `self` entry in the window, by what was heard | Only the protected own lines; a separate longer history; a time limit | The same lines the model sees, so the check and the prompt cannot disagree, with no second record. Comparing only the protected few would let a line repeat the moment it left them while it was still on screen. A time limit needs a clock the window does not use (WM-WIN-002); the cost is that a quiet stream holds back a repeat after a long gap. |
| What was heard | `heard`, else `fallback`, else the meant text; an empty `heard` skips the line; a dropped line cannot be observed and is compared as meant | Always the meant text; compare nothing that did not play | Repeating what the audience heard is what a viewer notices. Cortex sees no event for a line voice dropped unstarted, so it cannot exclude it; comparing it is the conservative error (a held-back reply rather than a spoken repeat). |
| Marking viewer text | The prompt carries the standing instruction and quoted viewer-authored text; reply parsing strips the delimiters; the defence behind the model is parsing, the critic, the repetition check and the speaking gates | Rely on the instruction alone; a content classifier on chat before the prompt | A model can be talked into obeying; the mechanical lines behind it bound what an obeyed instruction can do to one short line per gated decision. A classifier on chat would be moderation by another name and one more model on the live path (HLD tenet 3, Non-Goal 1). |
| Critic as a `Module` hook | `rules` / `llm` / `http` with rules fallback | built-in moderation only | Commit `969f6d7`: regions "expose their judgement as a Module"; "cortex.critic: inhibition; can veto or rewrite a reply before it's spoken"; "Any failure falls back to rules". `critic.ts` |
| Wait for the LLM before subscribing | infinite `ping()` loop, reported `degraded` | exit and let a supervisor restart | Comment `startup.ts` ("Never silent and never fatal ... a supervisor sees `degraded` instead of a service that just hangs"); commit `51d5a9c` ("cortex (LLM down) now idle and report `degraded` instead of exiting or blocking silently") |
| Mock provider path | no special-casing in `Cortex`; the provider replies in tag format | stub inside cortex | Comment `packages/llm/src/mock.ts`: "`[happy] mock: <last user message>`, in the tag format the cortex parses"; tested in `mock.test.ts` |
| Critic stamped separately | `llmEndedAt` ends at the reply call; the critic has its own `criticEndedAt` | Fold the critic into `llm`; stamp only the reply call | The critic's model call can be as long as the reply when the critic is an `llm` hook; its own stage shows what that costs, and a `rules` critic shows as a stage of near-zero length. |

## Open Questions & Future Decisions

- **Streamed replies and the checks after parsing.** This pipeline describes a whole reply that is parsed, criticised, checked for repetition and re-checked before one `brain.say`. The HLD specifies a streamed reply spoken clause by clause ([model-backends](../model-backends/model-backends-design.md) Streamed replies), where speech starts before the reply exists. A veto or a repetition hit cannot unsay a clause already sent. Readings: run the critic and the repetition check on the first clause before anything is spoken, and treat later clauses as unchecked; or hold the first clause until the checks pass on the text so far; or exempt streamed replies from the repetition check and rely on the critic. The streamed pipeline is designed with the rest of the streaming change, and the check's position moves with it.
- **A reply left unspoken by a hit.** A repeat that stays silent also leaves a mentioned viewer unanswered, as a critic veto does. Readings: leave it (a retry adds a model call to a late line); or retry once with a hint when the focus is a mention. Not decided.
- **A stop while a think is in flight.** An operator `say` that plays while the cortex thinks can be interrupted. The stop ends that line; the think continues and speaks its reply to an earlier focus, while the focus for the interrupter was answered `thinking` by CTX-GATE-001 and its events are already marked seen in salience, so the interrupter is not answered. Whether the cortex should drop the in-flight reply, requeue the interrupter's focus, or leave the case as it is is undecided.

## References

- Code: `services/cortex/src/{index,main,startup,cortex,prompt,critic,health}.ts`,
  `services/cortex/package.json`, `services/cortex/tsconfig.json`
- Tests: `services/cortex/test/{cortex.region,cortex,cortex.dispositions,cortex.stop,critic,health,mock,prompt,startup,transcript-stops,fallback,timing,partial,main,independence,contract}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (`Bus`, event schemas for the thirteen subscribed types and
  `brain.status`, `brain.say`, `memory.recall.request`, start mode `latest`),
  config (`loadConfig`, `loadPersonality`, `EMOTIONS`), model-backends
  (`createChatProvider`, `ChatProvider.ping`, `MockProvider`), region-hooks (`Module`
  for `cortex.critic`), working-memory (`Context`, `propagatedFlags`), shared-runtime (`quoteUntrusted`, `boundText`, `speakerLabel`, `untrustedNotice` and the delimiters from `@cohost/shared/untrusted`), control-plane
  (heartbeat contract: `startHeartbeat`, `HeartbeatSpec`; manifest start mode `fresh`
  and group `cortex`), memory (request/reply and `memory.viewer`), salience
  (`attention.focus` producer, consumes `brain.status`), affect (`affect.state`),
  voice (`voice.done`)
- Depended on by: salience (waits on `brain.status`), voice and avatar (consume `brain.say`),
  memory (stores `brain.say` as `self`), dashboard (displays `brain.status`, sends `control`)
- External: the configured chat LLM backend (Ollama, OpenAI-compatible, Anthropic, Bedrock, or mock), optional HTTP critic endpoint
