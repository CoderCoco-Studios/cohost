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
notes, recalled memories and a working-memory transcript, streams the model's reply,
cuts it into clauses, checks each clause (the `cortex.critic` hook, the repetition check, the
mute and busy re-checks), and publishes the first clause as `brain.say` and the rest as
`brain.clause` events of the same line.

Observed principles:

- Single-threaded thinking: at most one LLM call in flight, and nothing is spoken
  over someone else's line. A reply that is being streamed is one thought until its
  last clause is published.
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
`chat.message, chat.removed, speech.heard, vision.summary, brain.say, brain.clause, voice.utterance, voice.playing, voice.done, voice.stop, voice.failed,
attention.focus, memory.recall.reply, memory.notes.reply, memory.viewer, affect.state, control`
(`CTX-EVT-001`; `voice.failed` carries the spoken fallback line, `CTX-EVT-008`; never
`speech.partial`: an interim transcript is not speech to the cortex, CTX-EVT-009). The service publishes `brain.status`,
`brain.say`, `brain.clause`, `voice.stop` (when a mute or pause lands while a line of its own is being spoken), `memory.recall.request` and `memory.notes.request`.

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
| `brain.clause` (the cortex's own) | add the clause text to the line's `self` entry (`ctx.extendSelf(id, seq, text)`); a clause for an entry the window no longer holds changes nothing | `cortex.ts` |
| `voice.utterance`, `voice.playing` | for a pending line: count as progress for the valve; `voice.playing` also records the publishing sink as a player of the line (Releasing a streamed line) | `cortex.ts` |
| `voice.done` | for a pending line: record that sink as having completed the line when the clause is the line's last produced clause or the done is `final` or `interrupted`, count it as progress, and end the line when its release rule holds (Releasing a streamed line); once no line is pending, publish `brain.status` `muted` (muted or paused) else `idle`. Whether or not the line is still pending, an interrupted `voice.done` with `spokenText` records it as what was heard (`markHeard`, see Repetition check), and a `voice.done` that is flagged neither interrupted nor `final` clears an earlier record that nobody heard the line | `cortex.ts` |
| `voice.stop` | end every pending line the order names (all when `ids` is absent) and stop reading the stream of each such line that is still being streamed; once no line is pending, publish `brain.status` `muted` (muted or paused) else `idle`; a think that has not published its first clause is left alone (see Interruption). The stops cortex publishes itself (Stopping its own line on a mute or pause) take this path too | `CTX-EVT-010`, `CTX-GATE-010` |
| `voice.failed` | a streamed line: only that sink stops playing it, and the reply ends only under the two conditions of Releasing a streamed line. With `fallback`: mark the line's transcript entry and keep a pending glitch for the next reply; without `fallback`: record what was heard, the clauses before the failed `seq` (the empty string when that is clause 0), by `markHeard` when no other sink has played the line (see Fallback acknowledgement). A line that is not streamed: the same records, and nothing else changes | `CTX-FALL-002`, `CTX-FALL-003`, `CTX-FALL-007` |
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
release (a `voice.done` for it, below) or its valve, so an operator `say` over a playing line does not forget it
(`CTX-SAY-005`). Each own pending line is marked as a reply (published by a think) or not (the operator's `say`); only a reply line is stopped by a mute. A pending line is the whole reply, whatever the number of clauses; a line from a reflex or an operator `say` is one clause and is released by its first `voice.done`.

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
   is deleted only once the reply's `brain.say` (its first clause) is published, so a vetoed, dropped
   or failed reply keeps it for the next one (`CTX-VIEWER-003`; looked up at
   `cortex.ts`, deleted by the `onPublished` callback of `say()`,
   `cortex.ts`, and only if a newer note has not replaced it meanwhile).
5. `buildMessages` (below), then `llm.stream(messages, { signal })` with no tools and no other per-call options, so
   the provider's configured defaults (`llm.max_tokens` etc.) apply. `signal` is the think's own, aborted only to stop reading the stream (Streaming the reply). Elapsed ms,
   reason and memory count are logged at `info`; the raw model text, which can echo
   chat and is unfiltered by the critic, only at `debug` (`CTX-PROMPT-007`, `cortex.ts`). The outcome of each `llm.stream`
   call also feeds `deps.llm` (`CTX-HEALTH-003`; the provider is wrapped by
   `trackLlm`, `startup.ts`): a stream that ends, or that cortex aborts, is a success; a thrown error is a failure.
6. Read the reply as clauses (Streaming the reply): decide the leading tags, cut the text into clauses, and for each clause run the critic by its type, the repetition check on the reply so far and the mute and busy re-check, then publish it. The first clause to pass is `brain.say`; every later one is a `brain.clause` of the same line. A reply that is shorter than 2 characters once cleaned ends the think without a line (No-line exit, below).
7. Close the line: a line that was published with `more` ends with one closing `brain.clause` (Streaming the reply, Ending the reply).
8. Any thrown error is logged `think failed` and publishes `idle` (publish failure
   swallowed, `cortex.ts`) when nothing was published; after a clause was published the reply ends cut (Streaming the reply, Failure).

**No-line exit.** A think that ends without a line (an empty reply, a critic veto, a repetition hit on the first clause, a mute or busy re-check that fails before the first clause) publishes no `brain.say` and publishes `brain.status` `muted` when the cortex is muted or paused at that moment, else `speaking` while any line is pending or playing, else `idle`. The status rule is one, so the same state is reported on each of these paths (CTX-GATE-012). A reply cut after its first clause was published is not a no-line exit: its line exists and is released like any other.

**Order of a think.** Every clause is checked in this order before it is published: the critic (by its type), the repetition check, then the mute and busy re-check (CTX-GATE-013). For the first clause this is the order CTX-GATE-013 gives a whole reply; with an `llm` or `http` critic the whole reply passes the critic and the repetition check once, before any clause is published, and the mute and busy re-check then runs before each clause.

`voiceBusy()` also ends every pending line once `speaking_timeout_ms` (default 20000)
has elapsed without progress (`cortex.ts`): a stuck voice sink releases the cortex. A line makes **progress** when a `voice.utterance`, `voice.playing` or `voice.done` for it is read from any publisher, and when a clause is published while none of its clauses is outstanding. The valve runs while at least one published clause has not finished and restarts at each progress, so it bounds the wait for each step of a line and not the whole reply: a clause queued behind earlier ones is waited for from the moment the previous step progressed, not from its own publication. Salience's busy valve is renewed by the same playback events ([salience](../salience/salience-design.md) Busy Gating and Cooldown), so a long reply stays busy to it while it plays. The
elapsed time is measured on the monotonic clock (`performance.now`), so a wall
clock stepped forward by NTP or VM time sync does not release a playing line early.
A timer
armed per line while it has an outstanding clause (`startSpeaking`; re-armed on each progress; cleared when the line is released)
publishes `idle` (or `muted` when muted or paused) when the timeout elapses and no other
line is pending, so salience and the dashboard see the release (`CTX-GATE-009`); it
stays silent while a think is in flight, which ends with a status of its own, and it
schedules no think.

**Worst case, end to end.** The longest reply is `max_clauses` × `clause_max_chars` characters (8 × 160 = 1280 with the defaults), further capped by `llm.max_tokens`; text past the last allowed clause is never spoken and ends the reply cut `length`. Every wait on the way has a bound. The model: no first output within `llm.timeout_ms` fails the stream, and so does a gap longer than `llm.timeout_ms` between events (model-backends), so a stalled model ends the think, and a model that keeps producing is bounded by `llm.max_tokens` and the clause limit. Each wait after a clause is published is bounded by `speaking_timeout_ms` without progress, and a sink that goes silent mid-line, with no `voice.done` and no `final`, is ended by it: `speaking_timeout_ms` after the last progress cortex releases the line, aborts the stream and publishes `idle`. Voice's synthesis of a clause is bounded by `voice.timeout_ms`, and a clause it fails ends the line with a `final` done. Nothing waits without a bound (HLD tenet 3).

The default `speaking_timeout_ms` of 20 000 ms must be longer than the longest silent stretch of a healthy line, so a healthy line is never released. The stretches are: from publishing a clause to its `voice.utterance`, the wait behind earlier clauses' synthesis (each of which publishes an utterance and so progresses) plus its own synthesis, a second or two for a clause of up to 160 characters on Kokoro, plus on `pocket` at most one clip phrase already in the gate; from the utterance to `voice.playing`, the claim window (1.5 s) and, at a mouth output, the fetch and conversion (under a second when healthy, abandoned after 15 s), or the rest of an earlier clause, which ends in a `voice.done`; and from `voice.playing` to `voice.done`, the clause's own playing time, which for 160 characters at the default `voice.speed` is about 12 seconds. The longest healthy stretch is therefore the clause's playing time, and no default has to change. A voice speed below about 0.6 makes a full clause outlast the valve; the owner then raises `speaking_timeout_ms` or lowers `clause_max_chars`. A hung engine can exceed the valve before `voice.timeout_ms` fires (a hung request after a clip phrase on `pocket`), and the valve ending that line is the intended result.

### Streaming the reply

The reply is read as the model produces it and spoken a clause at a time, so the wait before the co-host starts depends on the first clause and not on the whole reply ([HLD](../../high-level-design.md) Streamed speech). Cortex is the only service that reads the model's stream. A reply is meant to be one short spoken line (the prompt and the `llm` critic's length rule keep it so): the clauses divide that line for speaking, and `max_clauses` × `clause_max_chars` is a ceiling, not a target. The tool loop the HLD gives cortex (Tool runtime) is designed with the tools service; the stream described here is the text reply, offers no tools, and ignores a `tool_call` event the provider might still yield.

**The first line.** Cortex reads `text` events into a reply buffer, ignoring whitespace until the first non-whitespace character. A newline ends the reply (the first-line rule): cortex stops reading, aborts the stream through the `signal` it passed, and treats the text before the newline as the whole reply. The provider's stop sequences end the stream at the same places ([model-backends](../model-backends/model-backends-design.md) Stop sequences).

**The leading tags.** The emotion and the gesture belong to the line, so they are known before the first clause is published. Cortex holds the start of the stream until the leading tags are complete (an optional `Name:`, then `[emotion]`, then an optional `[gesture:name]`, each bracket closed) or it is clear there are none: the text, after an optional `Name:`, does not begin with `[`, or 80 characters have arrived without the bracket closing. When the 80 characters arrive with a bracket still open, the emotion is `neutral`, there is no gesture, the bracketed text is kept as ordinary reply text, and the first clause starts at the start of the buffer. An unknown emotion is `neutral` and a gesture is not validated, as for a whole reply. The first clause starts after the tags.

**The clause rule.** Cortex cuts the cleaned text into clauses at the first boundary that satisfies this rule:

- A boundary is a punctuation mark of `. ! ? … ; : ,` or of the full-width forms `。！？、，；：`, followed by whitespace, and with any closing quote or bracket that directly follows the mark kept inside the clause. A mark inside a bracketed span, and a mark not followed by whitespace (`3.5`, `v1.2`), is not a boundary.
- A boundary is taken only when the clause so far has at least `brain.cortex.clause_min_chars` characters (default 24), so the first clause is not a fragment such as "Oh," or "Ok." and the text before an early boundary joins the next clause.
- When `brain.cortex.clause_max_chars` cleaned characters (default 160: the characters that will be spoken, bracketed text excluded) arrive with no boundary, the clause ends at the last whitespace before that length, or at the length when there is none, so a reply with no punctuation still ends its clauses.
- The text left when the stream ends, or at the newline, is the last clause whatever its length.

Each clause is cleaned as a whole reply is by `parseReply`: bracketed spans, the delimiters `«` and `»` and surrounding quotes are removed, a leading `Name:` is stripped from the first clause only, and a bracket still open at a boundary delays the cut until it closes or `clause_max_chars` is reached: the limit applies while a bracket is open, the clause is cut there, and the rest of the bracketed span is dropped when it closes. A clause with no word character left is not published and its text is dropped. Clauses are numbered by `seq` from 0, and a reply holds at most `brain.cortex.max_clauses` clauses (default 8, at most 16, below mouth's queue of 20), so the default allows `seq` 0 to 7: the model's text beyond the last allowed clause is not spoken and the reply ends cut with the reason `length`. The three keys are `brain.cortex` settings ([config](../config/config-design.md)).

**Checks by critic type.** What the critic can do depends on whether it has to see the whole reply.

- *`rules` critic* (the default). It passes every text, so nothing about a clause needs the whole reply: each clause is checked and published as it arrives. The hook is still asked once, on the first clause, so the reply carries the `criticEndedAt` stamp; later clauses do not call it.
- *`llm` or `http` critic.* The critic may veto the reply or rewrite it, and its rules (a repeat of a recent line, "longer than one short line") need all of it. Cortex reads the stream to its end, parses and criticises the whole reply as one text (the veto, the rewrite parsed like a model reply and the emotion rules above stand), runs the repetition check on it, cuts the final text into clauses by the clause rule, and publishes them one after another, each behind the mute and busy re-check. voice still synthesizes them clause by clause and a sink starts on the first, so `tts` and playback overlap with the publication; the `llm` stage covers the whole reply (Latency stamps). A stream that fails before it ends publishes nothing, even when text had arrived.

**Before each clause is published.** In this order, on the reply so far (every clause cut up to and including this one, joined by single spaces):

1. *Repetition check* (Repetition check). A hit on the first clause is the no-line exit. A hit on a later clause ends the reply: the clause is not published, and the closing event is empty with `cut` `repeat`.
2. *Mute and busy re-check.* Muted or paused ends the reply (`cut` `muted`); a line from someone else that is pending or playing ends it (`cut` `busy`), where the reply's own line does not count as busy and an operator `say` counts as someone else's line. On the first clause each drops the reply: publish `muted`, or log `dropped` and publish `speaking`.
3. *Publish.* The first clause is `brain.say` (the clause is its `text`, with the line's `emotion`, `gesture`, `reason`, `timing` and the flags of an injected focus), the later ones `brain.clause`. `brain.say` carries `more` unless the reply has already ended after its first clause (the stream ended and nothing but whitespace remains after the boundary), which is a reply that fits in one clause and is published exactly as a reply without streaming. After the first clause cortex publishes `brain.status` `speaking` with that clause's text as detail (CTX-SAY-001); later clauses publish no status of their own. Salience sets its cooldown and `speaking` state once per line, from the `brain.say`, and renews its valve for a streamed line from the line's `voice.playing` and `voice.done` events only while it still holds `speaking` for that line.

**Ending the reply.** Cortex publishes exactly one closing `brain.clause` (`last`) for every line whose `brain.say` carried `more`, whatever ends the reply, so no consumer waits for the event-bus bound except after a crash. It carries `through` (event-bus Streamed lines) and, when the reply ended before the model finished, a `cut` naming why. It carries the last text when the stream ended normally and the text passed its checks, and is empty otherwise. The ending paths are: the stream ended (no `cut`, `through` the last clause with text); a check ended it (`repeat`, `muted`, `busy`, `length`, `through` the last published clause); the stream failed after the first clause (`failed`); voice reported that a clause failed to synthesize (`failed`, `through` the clause before it); every player of the line ended it after the claim window (`failed`); a `voice.stop` covered the line (`stopped`; `muted` for a mute or pause of cortex's own line, the `voice.stop` it publishes then having the reason `muted` or `paused`); the no-progress valve ended the line (`timeout`); and cortex stopping (`stopped`, best effort). On every path cortex aborts the model stream first if it is being streamed, publishes the closing event, and the think then ends: the thinking flag is cleared, and, when no line is pending, `idle` (or `muted`) is published (Releasing a streamed line). Only a crash leaves a line without its closing event.

**Failure.** A stream that fails (a provider error, the stream timeout of model-backends) with nothing published is a failed think: it logs `think failed` and publishes `idle` (CTX-SAY-003). A stream that fails after at least one clause was published ends the reply with the closing event cut `failed`; cortex never tries to repair the line, and no fallback line is spoken (fallback lines belong to [mouth](../mouth/mouth-design.md) and play only when playback fails). A stream whose `finish` is `refusal` says nothing more: with nothing published it is the no-line exit; after a clause it closes the reply normally.

### Releasing a streamed line

A **streamed line** is a line whose `brain.say` carried `more` ([event-bus](../event-bus/event-bus-design.md) Streamed lines); a line without `more` is released by the first `voice.done` of its one clause from any sink, as the turn-taking protocol says (CTX-EVT-005), whatever other sinks are playing, and nothing in this section applies to it beyond the stop and the valve. A streamed line is **pending** from its `brain.say` until cortex **releases** it. A line with no player at all (no sink published `voice.playing`) is released once its reply has closed and either its failure condition holds or voice reported that clause 0 failed to synthesize; that failure closes the line with `cut` `failed`, and the working-memory line is recorded as heard by nobody. Cortex's words here are its own: the reply is **being streamed** while the model stream is read, **closed** once its closing `brain.clause` is published, and the think is **in flight** until its reply closes, or, when it publishes no line, until it ends; a streamed line's think holds the thinking flag for that whole time. A clause is **outstanding** from its publication until every player of the line has reported a `voice.done` for it, or a `final` done.

For each pending streamed line cortex keeps the line's **players**, the sinks that published `voice.playing` for any clause of it (including voice's `virtual` sink and a mouth output's `mouth` sink), whether each has **completed** the line, and the line's **last produced clause**. A player has completed the line when it reported a `voice.done` for the last produced clause, or a `final` or interrupted `voice.done`. The last produced clause is the highest `seq` cortex has published; a `final` done from voice's sink `error` at `seq` k lowers it to k minus 1, because clause k failed to synthesize. Whenever the last produced clause changes, each player's completion is judged again against the new value, so a player that had completed the clause before is not completed any longer when a further clause is published, and one that already reported the new last clause is completed.

A pending streamed line is released, and `voiceBusy()` stops reporting it, when the first of these happens:

- its reply has closed and every player has completed the line; or its reply has closed, no sink has published `voice.playing` for it and the failure condition below holds (nothing will play);
- a `voice.stop` names it, or carries no `ids` (including the stop cortex publishes for a mute, below);
- `speaking_timeout_ms` passes with a clause outstanding and no progress (above).

Whatever releases a line, cortex aborts the model stream if it is being streamed, publishes the closing `brain.clause` if the reply had not closed (Streaming the reply, Ending the reply; an `llm` or `http` critic's clauses stop being published as soon as the line is released or stopped), ends the think, and, when no line is then pending, publishes `idle`, or `muted` when muted or paused. A think that ends while a line is still pending publishes no status of its own.

**What a failure does.** `final` is per sink: one sink's `final` `voice.done` or `voice.failed` means only that sink plays no more of the line, so the reply keeps being streamed and the other sinks keep playing. The failed sink plays its fallback clip under mouth's rules ([mouth](../mouth/mouth-design.md) Fallback Line) and takes no more of the line. A sink that never started the line publishes nothing for it. Cortex ends the reply early, closing it with `cut` `failed`, in two cases only: voice reports that a clause failed to synthesize (a `final` `voice.done` from sink `error`: no audio can exist for the clause, and a reply is not played with a hole; `through` is the clause before it), or the **failure condition** holds: at least one `voice.failed` or `final` `voice.done` has been read for the line, the claim window has ended, and every sink that published `voice.playing` for the line has ended it (a `final` done or `voice.failed` from each), so nobody is hearing it. The claim window ends 1500 ms (voice's claim window, [voice](../voice/voice-design.md) Sink Arbitration Protocol rule 2) after cortex reads the first `voice.utterance` of the line; until then a failure from one sink cuts nothing, because a slower sink may not have published `voice.playing` yet. Clauses already published and queued on a healthy sink play out, and the release waits for them by the rule above.

**What is recorded for a failed sink.** When a `voice.failed` is applied (once the line's closing `brain.clause` has been read back, or at once when the line is not streamed or the reply closed before the failure), cortex looks at the other players. When another sink has played part of the line, the line was heard on another output: it sets no glitch, marks no transcript entry and records no heard text, so the line stays as cortex published it. When no other sink has played any of it, the transcript mark, the glitch and the heard text of Fallback acknowledgement apply to the clauses from the failed `seq` on.

**A cut falls on a clause boundary.** Every cut of the reply stops publishing after a whole clause: a clause is published whole or not at all, so the co-host stops at a pause and never mid-word. A stop (barge-in, or a mute) is different: it cuts the audio that is playing at once.

A line whose clauses have all played while the model is still producing the next one stays pending; the gap is bounded by the model-backends stream timeouts, so nothing waits without a bound (HLD tenet 3). A line from a reflex or an operator `say` has one clause, so its one `voice.done` releases it.

### Stopping its own line on a mute or pause

Voice, mouth and ears never read `control`, so a mute that lands while the co-host is speaking would otherwise leave every clause already handed to voice to be spoken; with a whole-reply critic that is a full reply. When a `mute` or `pause` is read while cortex has a reply line of its own pending (a line a think published, streamed or not), it stops that line at once:

1. it aborts the model stream of each such line that is being streamed;
2. for a streamed line whose reply had not closed, it publishes the closing `brain.clause` empty with `cut` `muted` and `through` the last published clause (a closed reply has no closing event to add);
3. it publishes one `voice.stop` with `reason` `muted` (or `paused`) and `ids` naming those lines, so the clause playing is cut and the queued clauses dropped on every sink ([voice](../voice/voice-design.md) rule 9, [mouth](../mouth/mouth-design.md) Stopping a line);
4. it ends the lines as for any stop, and publishes `muted` once none is pending.

The records follow the ordinary stopped-line path: the interrupted `voice.done` carries `spokenText` and `unsaidText`, and the transcript and memory keep the clauses published. A line that is not a reply is never stopped this way: an operator `say` is spoken while muted, and a salience reflex line is a short single line left to play (salience publishes no `voice.stop` while muted). Voice, mouth and ears stay unaware of mute; they obey a `voice.stop` as they obey any.

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
gestures are not validated. A streamed reply is parsed as it arrives under the same rules: the tags once at the start (Streaming the reply), the stripping on each clause, and the first line as the first newline. The critic's rewrite and a collected reply are parsed whole.

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
- A `voice.failed` carrying `fallback` marks that line's transcript entry with the fallback text (`CTX-FALL-002`, `WM-PUSH-008`), so every later prompt and the critic's transcript show what was heard and that the intended line failed. It applies to any line, including reflexes and operator lines, because each is in the transcript. For a streamed line the entry is marked once, with the clause the failure began at: the transcript shows the clauses that played, then the fallback text, and the note quotes only the clauses that were not heard. The output that failed ends the line on its side (mouth, Fallback Line), and the reply ends (Releasing a streamed line), so the clauses after the failed one are not published.
- The same event sets a **pending glitch** (the text that was not heard, the fallback text, and the clause the failure began at), replacing an older one (`CTX-FALL-003`). For a line that is not streamed the unheard text is the whole line; for a streamed line it is the clauses published from the failed `seq` on, because the clauses before it played. The transcript note and the glitch are computed from the same published clauses: for a streamed line cortex applies both when the line's closing `brain.clause` has been read back from the stream (stream order puts every clause's echo before it, so the entry holds every clause), or at once when that has already happened or the reply ended without a closing event, and only when no other sink has played part of the line (Releasing a streamed line, What is recorded for a failed sink).
- The next think that builds a prompt while a glitch is pending and its line is still in the window (`WM-WIN-007`) adds one line to the `## Now` block (`CTX-FALL-004`): `- Your voice glitched: your line "<intended>" failed to play and everyone heard "<fallback>" instead. You may react to it in character if that fits you; as a rough guide, about <N>% of the time. If it does not fit, let it go.` where `<N>` is the chance as a whole percentage. When the failure began after the first clause, the hint says "the rest of your line" in place of "your line" and `<intended>` is only what was not heard, so it never claims the part that played failed.
- The glitch is consumed once that think's reply is published as `brain.say`, which for a streamed reply is its first clause; a vetoed, empty or failed reply keeps it for the next think. `forget_context` drops it, and so does its line leaving the window (`CTX-FALL-005`). One reply is the window in which a reaction still reads as one.
- With `fallback_ack_chance` 0 there is no hint line at all; the transcript note stays (`CTX-FALL-004`).
- A `voice.failed` without `fallback` (nothing played on that sink) records what was heard for the repetition check only (`CTX-FALL-007`): for a line that is not streamed nothing, the empty string; for a streamed line the clauses before the failed `seq`, because they played. It changes neither the pending glitch nor the speaking state, and voice already releases the speaking state through the arbitration protocol. The line may still play on another sink: its non-interrupted `voice.done` then clears the record.

### Critic (`critic.ts`)

`createCritic` wraps `Module("cortex.critic", cfg.brain.cortex.critic, ...)`
(`critic.ts`) from `@cohost/modules`. Kinds: `rules` (default, always
`{ok:true}`: it inspects nothing, so the default critic checks neither content nor repetition), `llm` (an "inner editor" system prompt, JSON reply, 160 tokens,
`critic.ts`) and `http` (POST the `CriticInput`, whose `transcript` is the rendered transcript with its `«` and `»` marks and no notice; CTX-CRITIC-013). The `llm` critic reads the same marked transcript as the reply, so its system turn carries `untrustedNotice` too: a quoted viewer line that tells the editor to approve something is data. Its rule against repeating "something said moments ago" has the co-host's own last lines in front of it whatever the chat volume (working-memory, Keeping the co-host's own lines in the window); it is a semantic judgement by a model that can fail or be absent, which is why the built-in repetition check below exists beside it and not in its place. A returned `text` is parsed like a model reply (Streaming the reply, Checks by critic type; CTX-CRITIC-007 to CTX-CRITIC-011). The `llm` and `http` kinds see the whole reply, which is why a reply is collected before any clause is published when one of them is configured; the `rules` kind sees nothing and lets each clause go as it arrives. The llm critic applies the
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

- **What it compares.** The reply about to be said (after the critic, so a rewrite is checked too) against every `self` entry the working-memory window holds, whatever its source: cortex replies, reflex lines and operator lines, except the entry of the line being streamed, which is the reply itself. It never compares against chat. For a streamed reply the text compared is the reply so far, every clause up to and including the one about to be published, and the check runs before each clause, so a reply that begins to repeat a recent line is cut at the clause where the overlap reaches the threshold. A reply collected for an `llm` or `http` critic is compared once, whole.
- **What each recent line is taken to be.** What was heard: the entry's `heard` text when it has one, else its `fallback` text when a fallback line played in its place, else its text as the co-host meant it. The `heard` record is the spoken part of an interrupted line (an interrupted `voice.done` carries `spokenText` when mouth can compute it) or the empty string when nobody heard the line (a `voice.failed` without a fallback, until a non-interrupted `voice.done` for the same id clears it; for a streamed line the clauses before the failed one); a line with an empty `heard` is not compared. An interrupted line whose `spokenText` is absent is compared as meant. A line for which cortex has no playback event (one voice dropped before it started publishes none) is compared as meant: the check cannot tell it was never heard, and errs towards holding a reply back (CTX-REPEAT-003).
- **Similarity.** A word is a maximal run of characters in the Unicode categories L, M and N in the lower-cased text (`toLowerCase()` with no locale argument), with apostrophes (U+0027 and U+2019) removed inside a word first, so `don't` is `dont`. A line's word set is its distinct words. Two empty word sets are never a repeat. When either word set has fewer than three words, the lines are a repeat only if their word sets are equal and non-empty. Otherwise the similarity is the size of the intersection of the two word sets divided by the size of their union (Jaccard), and the lines are a repeat when it is at least `brain.cortex.repeat_similarity`. The value 0 turns the check off. Config owns the key, its default and its range.
- **On a hit.** On the first clause cortex stays silent: it ends the think without a line (No-line exit), logs the similarity and which recent line matched (the texts only at `debug`, as for the raw reply) and publishes no `brain.say`. On a later clause the reply ends there: the clause is not published, the closing event is empty with `cut` `repeat`, and what was already said stays said. It does not retry with another prompt: a veto does not retry either, and a retry would add a model call and its latency to a line that is already late. When nothing was published the viewer note and a pending glitch are kept for the next think, as for a veto, because they are consumed only by a published reply. Salience has already marked the focus seen, so the same events do not trigger another think.
- **Lines that are not from a think.** The check never withholds one: a salience reflex, an operator `say` (an explicit override that bypasses every gate) and the spoken fallback line are not cortex replies, so the check does not run on them. They are `self` entries in the window, so they are in the comparison set a later reply is checked against.
- **No window, no hit.** With no `self` entry in the window the check does nothing.

The check is count-based like the window: the lines in the window are compared however old they are. A co-host that spoke once an hour ago and speaks again compares against that hour-old line; on a quiet stream a genuine repeat after a long gap is therefore also held back. Which lines the window still holds is working-memory's rule: the newest few `self` entries survive a flood of chat, older ones until the window evicts them.

## Interruption

When salience stops a line it publishes `voice.stop` ([salience](../salience/salience-design.md) Barge-in), and a decision later it publishes `attention.focus` for the person who interrupted. The cortex must be able to think about that focus, and a pending line would make it answer `speaking` and decline (CTX-GATE-003). Two events could release the line, `voice.done` flagged `interrupted` from the sink and the `voice.stop` itself, and they reach cortex in an order nothing fixes: a sink publishes its `voice.done` after it has handled the stop, which can be after the `attention.focus`. So the cortex does not wait for the sink: on `voice.stop` it ends every pending line the order names (all of them when `ids` is absent, which is what salience sends), then publishes `idle` (or `muted`) once none is pending, exactly as for a `voice.done` (CTX-EVT-010). A stop covers every clause of a line, queued or playing, because the order names the line's id; and when a line being streamed is stopped, cortex aborts the model stream and publishes the closing clause (`cut` `stopped`) and no other, so nothing is synthesized or played for a reply the person talked over. The interrupted `voice.done` that follows names a line that is no longer pending: it ends nothing and publishes no status (CTX-EVT-005), and its `spokenText`, when present, is recorded for the repetition check. This is also why lines that voice dropped before they started, which publish no `voice.done`, cannot leave the cortex waiting out `speaking_timeout_ms`.

The cortex neither starts a think because of a stop, and aborts none that has not published its first clause (CTX-GATE-010): the one-thought-at-a-time rule stands, and an interruption is only a release of the lines that were speaking, plus the end of reading a stream whose line was one of them. The reply to the interrupter is an ordinary think on the next focus. The transcript keeps the interrupted line as cortex published it, every clause of it, whether it finished, was cut or was interrupted; the `unsaidText` that the interrupted `voice.done` can carry is not read, which is the deferred interrupted-thought work (WM-STACK-001, CTX-REPLAN-001), and `spokenText` is read only by the repetition check. The two texts are the sink's, over the clauses that sink received; cortex's own record holds every clause it published, so the part of the line that was never said is the sink's `unsaidText` plus the published clauses the sink never received, which cortex adds on its side; only `spokenText` is read.

A think that has not published its first clause when a stop is read is not cancelled and its reply is subject to the usual rechecks (CTX-GATE-005, CTX-GATE-006). That case arises only when a line spoken by someone other than the cortex (an operator `say`) was playing while the cortex thought, and salience stopped it; see Open Questions. A stop that finds the cortex's own line mid-stream is the stop above: the line ends and the stream is aborted.

## Control commands and status machine

`brain.status` states published: `idle`, `thinking`, `speaking`, `muted`
(`cortex.ts`; schema `packages/bus/src/events.ts`, field `detail`).

| Command | Effect | Evidence |
|---------|--------|----------|
| any with `target` other than `cortex` | ignored entirely; absent target = all services | `cortex.ts` |
| `pause` | `paused = true`, stop the cortex's own reply lines (Stopping its own line on a mute or pause), publish `muted` with detail `paused`; events still ingest, no LLM call | `cortex.ts` |
| `resume` | `paused = false`, publish `muted` if also muted, else `idle` | `cortex.ts` |
| `mute` / `unmute` | `muted` flag; `mute` stops the cortex's own reply lines (Stopping its own line on a mute or pause); `unmute` publishes `muted` if still paused, else `idle` | `cortex.ts` |
| `forget_context` | clear the `Context` event window, the last vision summary and viewer notes; the mood and pending recalls are kept (`CTX-CTRL-004`) | `cortex.ts`, `packages/working-memory/src/index.ts` |
| `reload_personality` | re-read via injected `loadPersonality` | `cortex.ts` |
| `say` with `text` | operator override: `say(text, "neutral", undefined, "operator")` with no mute, pause or busy check, and no injection flags; leaves any pending line pending (`CTX-SAY-005`) | `cortex.ts` |

The bus schema (`packages/bus/src/events.ts`) has eight `control` commands; the
cortex handles these seven and ignores `set_routing`, which mouth reads. State summary: the cortex reports `muted` for
both mute and pause so salience stops waiting on it. After a successful `say` it
stays `speaking` until the line's release (Releasing a streamed line) returns it to `idle`/`muted`, or
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
startup every `llm.stream` outcome feeds `llmOk` through `tracked()` (`trackLlm`,
`startup.ts`), so a model outage during operation shows as `degraded` and a
recovered backend as `ok` again (`CTX-HEALTH-003`). Bedrock has no cheap probe and
its `ping()` always answers true (`pingIsNominal`, `packages/llm/src/index.ts`);
with that provider `llm` reads `n/a` (not probed) until the first reply outcome. The
marker is a standing heartbeat `detail` (`CTX-HEALTH-004`) that `HeartbeatSpec`
(`packages/shared/src/lifecycle.ts`) carries and `cortexHealth` sets for a nominal-ping provider.

The critic hook reports through the same `hookHealth` and `pingHooks` as the other region hooks (region-hooks, HOOK-HEALTH-004, HOOK-HEALTH-005). `cortexMain` builds the critic, publishes `hookHealth([critic])` to a sink the bootstrap's `health` reads, and starts `pingHooks([critic], log)` without waiting. The heartbeat adds `hook.cortex.critic` to `deps` for an llm or http critic (nothing for a rules critic) and is `mock` when the provider is `mock` or the critic hook sits on the mock provider (`CTX-HEALTH-006`, `CTX-HEALTH-007`). The hook is a soft dependency: a down critic leaves the cortex speaking, since its fallback passes the line.

Shutdown: the bootstrap runs the teardown steps (`Cortex.stop` releases the line timers and, best effort, closes each streamed line whose reply had not closed with `cut` `stopped`),
then stops the bus; the `stopping` heartbeat is the heartbeat module's job. A pause also
shows as the heartbeat `detail` `paused` (`CTX-HEALTH-005`). Errors thrown inside
`cortexMain` log `fatal` and exit 1; a configuration that does not load logs the
loader's message and exits 1 (`CTX-START-004`).

Config keys read: `brain.working_memory_events` and `brain.working_memory_own_lines` (through `Context.forBrain`), `viewer_text.max_chars`, `viewer_text.max_name_chars`, `brain.input_limits.speech_max_chars`, `brain.memory.recall_k`,
`brain.cortex.{recall_timeout_ms, speaking_timeout_ms, fallback_ack_chance, repeat_similarity, clause_min_chars, clause_max_chars, max_clauses, critic.*}`, `cohost.{name,
streamer, timezone}`, `llm.*`. Env: `HEARTBEAT_INTERVAL_MS`; an isolated start's `LLM_PROVIDER`
override selects the mock preset through `COHOST_ISOLATION` (config CFG-ISO-007).

## Latency stamps

A `brain.say` the cortex publishes for an `attention.focus` carries `timing` (CTX-SAY-006, CTX-SAY-007): the focus's own `timing` (`audioEndedAt`, `heardAt`) copied unchanged, `focusedAt` (the `attention.focus` envelope `ts`), `llmStartedAt` (just before the think's first LLM request) and `llmEndedAt` (when the first clause has been cut from the stream; with an `llm` or `http` critic, when the stream has ended and the whole reply is in hand), and `criticEndedAt` when the `cortex.critic` hook's call returns (CTX-SAY-008; with the `rules` critic that is the call on the first clause). The hook runs for every think that reaches it, whatever its kind (the default `rules` critic included), so every think's `brain.say` carries the stamp. The time between `focusedAt` and `llmStartedAt` is recall and viewer-note lookups; the time after the last of these stamps up to the `brain.say` envelope `ts` is the publish itself, which includes the repetition check and the mute and busy re-check of the first clause. A streamed line has one `brain.say` and so one sample: the stamps describe the first clause, and the later clauses carry none ([control-plane](../control-plane/control-plane-design.md) Latency report measures `tts` and `sink` on the first clause too). A think whose reply is vetoed, too similar to a recent line on its first clause, empty, a single character (dropped before the critic is asked) or failed before its first clause publishes no `brain.say` and so no sample. An operator `say` and a salience reflex are not thinks and carry no `llm` stamps.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Releasing lines on a stop | Cortex ends its pending lines when it reads `voice.stop`; the sink's interrupted `voice.done` then ends nothing, since its line is no longer pending | Wait for `voice.done` flagged `interrupted`; salience delays the `attention.focus` until it sees the done | `voice.stop` and the sink's `voice.done` race the `attention.focus` for the interrupter, and a focus that finds a line pending is answered `speaking` and lost (CTX-GATE-003); salience does not read `voice.done`, so delaying the focus would give it a new subscription and a wait with its own valve. Ending the lines on the stop itself is the only order-independent release, and it also frees lines voice dropped unstarted, which publish no `voice.done`. |
| No abort of a think on a stop | A stop ends pending lines, and stops reading the stream of a line it ended; a think that has not published its first clause finishes and its reply goes through the ordinary rechecks | Abort the in-flight think on a stop; drop its reply on a stop; keep reading a stopped line's stream and discard its clauses | One thought at a time and no cancellation of an unspoken thought stand (below): a chat-model call that has produced nothing the person heard has no useful abort, and the lines a stop ends are the cortex's own speaking, not a think. Dropping a reply on a stop would lose a thought whose focus salience has already marked seen. A stream whose line was stopped is different: its text is already being thrown away, and a stream left running would hold the thinking flag and the model against the reply to the interrupter, so it is aborted. |
| Interrupted line in the transcript | The line stays in working memory as the clauses cortex published, whether the reply finished, was cut by a check or was interrupted; `unsaidText` is not read; `spokenText`, over the clauses the sink received, is read only to record what was heard for the repetition check | Rewrite the self line to the spoken part; record only the clause that was playing | Same stance as for a failed line (mouth Decisions, Long-term memory keeps the intended line): the record is what cortex decided to say. Using the texts needs an interrupted-thought stack (deferred, WM-STACK-001). |
| Interruptible, dynamic speech (deferred) | Recorded as a deferred spec (CTX-REPLAN-001); not built. Streaming and clause-sized speech are built | Build clause-boundary re-thinking with streaming | The deferred ideal ([HLD](../../high-level-design.md) Future / ideal state) would supersede One thought at a time and the rejection of cancelling an in-flight think: at each clause boundary of a speaking line the cortex would decide to continue, adapt, pivot or resume an interrupted thought. It needs a playback position, a boundary re-think inside the latency budget and, for screen events, live vision, none of which exist; the clause boundaries and the stream it would act on are the streamed reply above. |
| Do not await `attention.focus` | `void this.think()` | await inside the handler | Comment `cortex.ts`: "the LLM call must not block the subscription loop, or the memory reply we're waiting on could never be delivered"; test `cortex.region.test.ts` |
| Pending lines | A map of lines by id, each with its own valve and timer; a line is a whole reply, however many clauses; idle is published when the map empties | A single speaking id that a newer line overwrites; a pending entry per clause | Owner decision 2026-11-11: an operator `say` over a playing line must not make the cortex forget it, so each line's release is reconciled and the cortex reports idle only when nothing is playing. A reply is one line with one id (event-bus Streamed lines), so it is one pending entry whose release waits for its last clause. Overlap itself is voice's documented non-exclusivity. |
| Service construction | Provider, critic and `Cortex` are built inside `cortexMain` under `runService` | Build them at module load | A critic configuration the hook rejects must fail through the `fatal` path with the other startup errors, not as an uncaught exception at import (`CTX-START-005`). |
| Reply emotion type | `parseReply` returns an `Emotion`, narrowing the model's tag against the emotion list | A string cast to `Emotion` at each use | The cast hid the one place where the value is checked. |
| Recall over the bus with timeout | request/reply with `recall_timeout_ms`, proceed with `[]` | call Postgres directly; no timeout | Only memory touches Postgres and the cortex answers without recall when memory is down or slow: comment in `main.ts`, `config/config.example.yaml`, commit `969f6d7` ("cortex: ... answers without recall if memory doesn't reply in time") |
| One thought at a time | `thinking` flag plus status echo, held until the reply's last clause is published | queue focuses; cancel in-flight | Status echo: comment `cortex.ts` ("Salience assumes we're busy once it fires, so every path out of here reports a status"). Single flight instead of a queue: a queued focus would be answered after the conversation had moved on, and salience re-decides on fresh context every tick once the cortex reports idle, so a dropped focus costs nothing; cancelling a call that has produced nothing spoken would waste the model work already spent. Test `cortex.region.test.ts` |
| Own vs other `brain.say` | compare `ev.source` to `"cortex"` | tag lines with an origin field | The bus stamps every event with the publishing service's name (`new Bus("cortex")`), so no extra field is needed. Cortex marks its own lines speaking at publish time (`say()`), so only another source's line (for example a salience reflex) starts the speaking state from the echo. This relies on each service using its own name as the bus source; `cortex.ts` |
| Restart start mode | `latest`: reset the `cortex` group to `$` on every start | `resume` (replay the backlog); drop old focuses by age | owner decision 2026-11-01: a stale `attention.focus` must not produce an LLM call and a late line; only memory keeps its backlog; `CTX-EVT-001` |
| Who sees mute and pause | cortex and salience only; cortex enforces a mute on its own speaking by publishing `voice.stop` | voice, mouth and ears also gate on mute | owner decision 2026-11-01: the services that decide to speak own the gate; the body plays what it is given and obeys `voice.stop`, so it needs no mute logic |
| Status publish failures | log and continue on every think exit | let the unawaited think reject | owner decision 2026-11-01: an unhandled rejection ends the process; `CTX-GATE-008` |
| Speaking-timeout release | publish `idle`/`muted` when the timeout fires | release silently on the next think | owner decision 2026-11-01: salience and the dashboard see the release; `CTX-GATE-009` |
| Raw reply logging | raw model text at `debug`, timings and counts at `info` | raw text at `info` | owner decision 2026-11-01: the raw reply can echo chat and is unfiltered; `CTX-PROMPT-007` |
| Reply length | one short spoken line in both the prompt and the llm critic | critic allows two sentences | owner decision 2026-11-01: the critic enforces the prompt's rule; `CTX-CRITIC-006` |
| Transcript tags and stops | working-memory owns the tags; provider stops are a token saver; the self line is not a stop; a cortex test pins tags against stops | model-backends owns the list; stops as a correctness guard | owner decision 2026-11-01: `parseReply` keeps only the first line, so stops only save tokens; `CTX-PROMPT-008` |
| Runtime model health | every `llm.stream` outcome feeds `deps.llm`; Bedrock flagged as unprobed (a standing `detail`; `deps.llm: n/a` until the first reply) | startup ping only | owner decision 2026-11-01: the heartbeat reflects runtime dependency state; `CTX-HEALTH-003`, `CTX-HEALTH-004` |
| Readiness | `ready` after `resetGroup("cortex")` resolves, then the subscription starts | `ready` straight after `void subscribe`; a bus hook announcing group creation | `Bus.subscribe` creates its group inside the long-running call and signals nothing; `resetGroup` is awaitable, creates a missing group at `$` and is the same start-mode `latest` move; `CTX-START-003`, test `startup.test.ts` |
| Re-check busy and mute before every clause | Drop the first clause, or end the reply after a later one, if mute or pause is set or someone else's line started; the reply's own line does not count as busy | Check once after the model; check only the first clause; let a started reply finish | Comment `cortex.ts`: "A reflex or operator line may have started while we were thinking; don't talk over it." A streamed reply can run for seconds after its first clause, so one check at the start leaves it free to talk over a line that began meanwhile or past a mute; a cut reply ends cleanly with a closing event. Test `cortex.region.test.ts` |
| Stuck-sink release | `speaking_timeout_ms` inside `voiceBusy()` as a no-progress bound on each clause, plus a timer that publishes the release (`CTX-GATE-009`) | One bound on the whole reply; per clause from its publication; rely on `voice.done` only | Comment `cortex.ts` ("stuck-sink safety valve"), `packages/config/src/schema.ts` ("Give up on a stuck utterance / voice sink after this long"). A bound on the whole reply would release a healthy long reply, and one from each clause's publication would release a reply whose later clauses queue behind earlier ones (a reply of eight clauses can take longer to play than the timeout while every clause starts promptly). Counting from the later of a clause's publication and the previous clause's end keeps the bound on the wait for that clause: tenet 3's every wait has a way out. |
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
| Where the repetition check runs | Inside cortex, after the critic and before the mute and busy re-check, on the reply so far before each clause (the whole reply once for a collected one); a hit is silence by the No-line exit on the first clause and a cut on a later one; reflex, operator and fallback lines are exempt | Inside the critic's `rules` implementation; before the critic; before and after it; on the first clause only; on each clause alone; retry the think with a "say something different" hint; only the `llm` critic's repetition rule | A rules critic that checked repetition would not run when the owner configures an `http` or `llm` critic, and the check must hold with every kind. After the critic is the one position that also covers a rewritten line; the check is cheap, so the only cost is the critic call on a line that is then dropped, paid only by an `llm` or `http` critic. Checking the cumulative text catches a reply that starts differently and then repeats a recent line, which a first-clause check would miss and a per-clause check would score as short lines; the line's own entry is excluded because it is the reply. A retry is a second model call on a line that is already late, and a veto does not retry (One thought at a time). Reflexes and operator lines never pass through `think`, and an operator `say` is an override. |
| No-line exit status | One rule for an empty reply, a veto and a repetition hit: `muted` if muted or paused, else `speaking` while any line is pending or playing, else `idle` | `idle` on each of the three; a separate status per path | A mute or pause that lands during the think is reported on every path that ends without a line, as the re-check already reports it; a line still playing keeps the cortex `speaking` so salience's busy gate and the dashboard do not read an end of think as an end of speech. |
| Critic rewrite is parsed | A critic's `text` goes through `parseReply` like a model reply; its `emotion` wins when valid; a tag in the text does not | Trust the rewrite as returned | An `http` or `llm` critic is a model or an owner's service and can return several lines, brackets or delimiters; whatever reaches `brain.say` must meet the same single-line rule. |
| Similarity measure | Jaccard of word sets (characters of categories L, M and N, lower-cased, apostrophes removed), with an exact-set rule when either line has under three words; threshold `brain.cortex.repeat_similarity`, 0 off | Exact match only; character n-gram overlap; edit distance; embedding similarity; Jaccard alone | Exact match misses "Nice shot!" then "nice shot!!"; edit distance and n-grams score long lines inconsistently and are hard to explain to the owner who tunes the key; an embedding needs a model call, against a check meant to need none. Jaccard alone would call "Nice shot" and "Nice play" half similar and "ok" and "ok then" half similar, so for short lines only equality counts, and two empty sets (a line of emoji or punctuation) never count. A reworded repeat with different words is not caught, which the `llm` critic's judgement can still catch. |
| Compared lines | Every `self` entry in the window, by what was heard | Only the protected own lines; a separate longer history; a time limit | The same lines the model sees, so the check and the prompt cannot disagree, with no second record. Comparing only the protected few would let a line repeat the moment it left them while it was still on screen. A time limit needs a clock the window does not use (WM-WIN-002); the cost is that a quiet stream holds back a repeat after a long gap. |
| What was heard | `heard`, else `fallback`, else the meant text; an empty `heard` skips the line; a dropped line cannot be observed and is compared as meant | Always the meant text; compare nothing that did not play | Repeating what the audience heard is what a viewer notices. Cortex sees no event for a line voice dropped unstarted, so it cannot exclude it; comparing it is the conservative error (a held-back reply rather than a spoken repeat). |
| Marking viewer text | The prompt carries the standing instruction and quoted viewer-authored text; reply parsing strips the delimiters; the defence behind the model is parsing, the critic, the repetition check and the speaking gates | Rely on the instruction alone; a content classifier on chat before the prompt | A model can be talked into obeying; the mechanical lines behind it bound what an obeyed instruction can do to one short line per gated decision. A classifier on chat would be moderation by another name and one more model on the live path (HLD tenet 3, Non-Goal 1). |
| Critic as a `Module` hook | `rules` / `llm` / `http` with rules fallback | built-in moderation only | Commit `969f6d7`: regions "expose their judgement as a Module"; "cortex.critic: inhibition; can veto or rewrite a reply before it's spoken"; "Any failure falls back to rules". `critic.ts` |
| Wait for the LLM before subscribing | infinite `ping()` loop, reported `degraded` | exit and let a supervisor restart | Comment `startup.ts` ("Never silent and never fatal ... a supervisor sees `degraded` instead of a service that just hangs"); commit `51d5a9c` ("cortex (LLM down) now idle and report `degraded` instead of exiting or blocking silently") |
| Mock provider path | no special-casing in `Cortex`; the provider replies in tag format | stub inside cortex | Comment `packages/llm/src/mock.ts`: "`[happy] mock: <last user message>`, in the tag format the cortex parses"; tested in `mock.test.ts` |
| A mute stops the cortex's own line | On `mute` or `pause`, cortex aborts the open stream, closes the line with `cut` `muted` and publishes one `voice.stop` (reason `muted` or `paused`) naming its reply lines; operator and reflex lines are left to play | Finish the clause that is playing and drop the rest; let the published clauses play out; make voice and mouth read `control` | With a whole-reply critic up to a full reply is handed to voice at once and can play for a minute or more, and a mute must silence the co-host promptly, so the clause playing is cut and the queue dropped on every sink. Finishing the playing clause leaves seconds of speech after the owner asked for quiet. Letting published clauses play out would make the mute lag by the whole reply. Voice, mouth and ears stay unaware of mute (Who sees mute and pause): they obey a `voice.stop`, so the only new publisher is cortex, which already owns the mute gate. An operator `say` is an explicit override and a reflex is a short single line. |
| Release with several sinks | Release when the reply has closed and every sink that played part of the line has finished its last produced clause or ended the line; a `final` from one sink never releases while another is unfinished; a release that leaves nothing pending publishes `idle` or `muted` | Release on the first `voice.done` of the last clause; release on the first `final` | Two sinks can play one line and reach different points, and releasing on the first would start the next think while one is still speaking. Each sink reports its own end, and the valve bounds the wait. The status is what tells salience and memory the line is over. |
| One sink's failure does not cut the reply | `final` and `voice.failed` are per sink; the reply is aborted and closed `cut` `failed` only when voice reports a clause failed to synthesize, or when every sink that played part of the line has ended it; clauses queued on a healthy sink play out | Any sink's failure ends the reply; ignore failures and always finish the reply | A browser page that refuses autoplay, or a closed tab, would cut the reply on Discord if any failure ended it. A clause that cannot be synthesized leaves no audio for any sink, and a reply is not played with a hole, so that one ends it for all. When nobody is left hearing the line, finishing the stream only holds the model. |
| Critic stamped separately | `llmEndedAt` ends when the first clause is cut (the whole reply with an `llm` or `http` critic); the critic has its own `criticEndedAt` | Fold the critic into `llm`; stamp every clause | The critic's model call can be as long as the reply when the critic is an `llm` hook; its own stage shows what that costs, and a `rules` critic shows as a stage of near-zero length. The `llm` stage is the wait before the co-host can start, which is the first clause, so later clauses add no stamp: the line is one `brain.say` and one sample. |
| Reply streamed, without tools | Cortex calls `llm.stream()` with no tools; a `tool_call` event is ignored | Keep `chat()` and publish the whole reply; stream with the tool loop | The stream is what lets the first clause start before the reply exists ([HLD](../../high-level-design.md) Latency budget). The tool loop (HLD, Tool runtime) is designed in the tools service's work, not here: offering tools on this stream would need a rule for text spoken before a call (model-backends delivers calls after the text) that the tool design owns, so the two do not contradict, this design just carries none. |
| One reply, one line | The first clause is `brain.say`, later clauses `brain.clause` with the same id; one pending entry, one `self` entry, one memory row | A `brain.say` per clause | Everything that acts once per line (salience's cooldown and `speaking`, affect's nudge, the avatar's gesture, `voice.stop.ids`, the latency join) keys on one id per line (event-bus Streamed lines). |
| Clause boundary | Punctuation `. ! ? … ; : ,` (and full-width forms) followed by whitespace, taken only after `clause_min_chars` (24); a clause with no boundary ends at the last whitespace before `clause_max_chars` (160); the text left at the end is the last clause; at most `max_clauses` (8) | Sentence ends only; any comma; a fixed word or character count; a model-marked boundary | The first clause sets how soon the co-host starts, so commas count and the minimum keeps it from being a fragment that sounds clipped ("Oh,"); sentence ends alone would make the first clause a whole sentence, which is what the stream exists to avoid. A maximum keeps a clause bounded when the model writes no punctuation, and a clause bounds one TTS request. A count of words splits mid-phrase. Asking the model to mark boundaries adds prompt rules a small local model breaks. The values are starting points to tune by ear, like the claim window. The clause count bounds how long one reply can queue in voice and mouth; the prompt already asks for one short line, so the cap rarely applies. |
| Critic by type | `rules`: each clause is checked as it arrives. `llm` and `http`: the whole reply is collected, criticised, then published clause by clause | Run the `llm` critic on the first clause and trust the rest; per clause for every kind; skip the critic when streaming | The `rules` critic inspects nothing, so waiting for the whole reply would only delay the first clause. A model critic can veto or rewrite and judges length and repetition over the reply; a clause already spoken cannot be unsaid, so it must see all of it first, and the cost (the first clause waits for the reply) is paid only by an owner who chose that critic. Clause-by-clause voice synthesis still overlaps with playback. |
| Tags before the first clause | The start of the stream is held until the leading tags are complete or absent (at most 80 characters) | Publish the first clause and read the tags later; tags on a later event | The emotion and the gesture are properties of the line that avatar and voice read from `brain.say`; a tag that arrived after the clause would be too late for the face and the gesture. The hold is a few tokens at the start of the stream. |
| A newline ends the reply | The first line is the reply: cortex stops reading and aborts the stream at the first newline | Read to the end and discard what follows | A model that runs on into another speaker's line costs tokens and time for text that is thrown away; the abort frees the model for the next focus. The first-line rule applies while reading. |
| Records hold what cortex published | The `self` entry and the memory row hold the clauses published, whether the reply finished, was cut or was interrupted; barge-in's texts cover all published clauses | Record the meant whole reply; record only what was heard | The model's unspoken tail was never published and was never the co-host's line; the published clauses are what the co-host decided to say, the stance already taken for a failed or interrupted line. |
| Closing event and cut reason | Every streamed line ends with exactly one `brain.clause` flagged `last`, whatever ended the reply, carrying `through` and, for an early end, a `cut` (`repeat`, `muted`, `busy`, `failed`, `length`, `stopped`, `timeout`) | No closing event after a stop or a release, consumers infer the end; a cut as a separate event; `last` on `voice.utterance` | Sinks, memory and the dashboard need a definite end of the text without a timer, and `through` is how sinks learn where the audio stops, including after a synthesis failure. Publishing it on every path means only a crash leaves a line to the 300 s bound, and clearing the thinking flag on the same path is what keeps cortex from staying `thinking`. |
| Stream failure | Nothing published: a failed think. After a clause: the reply ends cut `failed`; no spoken fallback | Say the fallback line on any failure; retry the stream; drop the clauses already published | Fallback lines belong to mouth and play only when playback fails ([mouth](../mouth/mouth-design.md) Fallback Line). A retry would repeat what was said (model-backends, Failure after output), and a clause already published cannot be recalled. |
| Releasing a streamed line | Released when its reply has closed and every player has completed the line, on a stop that names it or has no `ids`, or on the no-progress valve; a line with no player is released when a failure is read after the claim window | Release on the first `voice.done`; release on the first `final`; wait for a done per clause with a count; release when the closing event is published | The first clause's done is not the end of the line, and releasing at the closing event would let the next think start while the clauses still play. `voice.done` is what releases cortex, as the turn-taking protocol says, and waiting for every player's last done keeps a second sink that is still speaking from being talked over; `final` is per sink and ends only that sink's part. |
| `rules` critic hook on the first clause only | The hook is asked once per reply; later clauses do not call it | Ask per clause; do not ask | The rules critic's answer is fixed, so a call per clause costs nothing useful, and the one call gives every reply the `criticEndedAt` stamp. |

## Open Questions & Future Decisions

- **A reply left unspoken by a hit.** A repeat that stays silent also leaves a mentioned viewer unanswered, as a critic veto does. Readings: leave it (a retry adds a model call to a late line); or retry once with a hint when the focus is a mention. Not decided.
- **A stop while a think is in flight.** An operator `say` that plays while the cortex thinks can be interrupted. The stop ends that line; the think continues and speaks its reply to an earlier focus, while the focus for the interrupter was answered `thinking` by CTX-GATE-001 and its events are already marked seen in salience, so the interrupter is not answered. Whether the cortex should drop the in-flight reply, requeue the interrupter's focus, or leave the case as it is is undecided.

## References

- Code: `services/cortex/src/{index,main,startup,cortex,prompt,critic,health}.ts`,
  `services/cortex/package.json`, `services/cortex/tsconfig.json`
- Tests: `services/cortex/test/{cortex.region,cortex,cortex.dispositions,cortex.stop,critic,health,mock,prompt,startup,transcript-stops,fallback,timing,partial,main,independence,contract}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (`Bus`, event schemas for the seventeen subscribed types and
  `brain.status`, `brain.say`, `brain.clause`, `memory.recall.request`, start mode `latest`),
  config (`loadConfig`, `loadPersonality`, `EMOTIONS`), model-backends
  (`createChatProvider`, `ChatProvider.ping`, `ChatProvider.stream`, `MockProvider`), region-hooks (`Module`
  for `cortex.critic`), working-memory (`Context`, `extendSelf`, `propagatedFlags`), shared-runtime (`quoteUntrusted`, `boundText`, `speakerLabel`, `untrustedNotice` and the delimiters from `@cohost/shared/untrusted`), control-plane
  (heartbeat contract: `startHeartbeat`, `HeartbeatSpec`; manifest start mode `fresh`
  and group `cortex`), memory (request/reply and `memory.viewer`), salience
  (`attention.focus` producer, consumes `brain.status`), affect (`affect.state`),
  voice (`voice.done`)
- Depended on by: salience (waits on `brain.status`), voice (consumes `brain.say` and `brain.clause`), avatar (consumes `brain.say`),
  memory (stores a line, `brain.say` and its `brain.clause` events, as `self`), dashboard (displays `brain.status`, sends `control`)
- External: the configured chat LLM backend (Ollama, OpenAI-compatible, Anthropic, Bedrock, or mock), optional HTTP critic endpoint
