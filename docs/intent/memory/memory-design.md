---
parent: high-level-design
prefix: MEM
---

# memory

Brownfield: this document describes the intended behaviour and, where the code
lags, says so with the spec ID of the gap. It was audited against the code on
2026-11-01 and carries the owner's decisions of 2026-11-01.

## Context and Design Philosophy

memory is the brain's "hippocampus" (`services/memory/src/index.ts:2`):
the only region that touches Postgres/pgvector. It turns what happened on stream
into embedded rows, answers "what do we remember about X" requests over the bus,
and tells the cortex who a viewer is: whether they are new or a regular, and the
short, fading notes the co-host keeps about each viewer (Viewer notes). A
separate, offline CLI (`reflect.ts`) consolidates stored memories into the
`## Learned` section of `personality.md`.

Guiding shape, as observed:

- Memory is a bus region like the others: it talks only through events
  (`chat.message`, `speech.heard`, `brain.say`, `brain.status`,
  `memory.recall.request`, `memory.notes.request`, `memory.viewers.request` in;
  `memory.viewer`, `memory.recall.reply`, `memory.notes.reply`,
  `memory.viewers.reply` out). The dashboard reaches viewer notes only through
  these events, never through Postgres. The cortex is the usual caller but
  "any region may ask" (`index.ts:10`). Memory does not subscribe to `control`, so
  `pause`, `resume`, `mute` or `forget_context` addressed to it have no effect:
  only cortex and salience act on mute and pause, and memory keeps recording
  while the co-host is muted.
- Writes are best effort. The Postgres `remember` and `recall` swallow errors and
  log a warning (`store.ts:116-118`, `store.ts:135-138`), and a failed viewer upsert
  is logged without losing the mention (`MEM-VIEWER-006`); the cortex tolerates a
  missing or slow memory by timing out (see the cortex segment). A configuration
  error that would make every write fail, a vector-dimension mismatch, fails
  startup instead (`MEM-STORE-002`).
- Memory is the durable region: it is the one subscriber that keeps the backlog
  across a restart (start mode `resume`).
- Backends are swappable by config so the whole service can run on Redis alone
  (`brain.memory.store: memory`, `brain.memory.embedder: hash`), at the price of
  `mode: mock` and no durability.

## Event flow

Handler: `createMemoryHandler` in `services/memory/src/region.ts:18`. One handler
function is shared by both consumer groups (`startup.ts:60-61`).

| Direction | Event | Group | What happens | Evidence |
|-----------|-------|-------|--------------|----------|
| in | `chat.message` | `memory` | `touchViewer(userId ?? user, user)` on every line; if `mentionsCohost`, publish `memory.viewer` then `remember("chat", user, text)` | `region.ts:22-36` |
| in | `speech.heard` | `memory` | `remember("speech", speaker, text)` for every utterance | `region.ts:38-43` |
| in | `brain.say` | `memory` | if `text.length >= 2`, `remember("self", cfg.cohost.name, text)`; any publisher (cortex, reflex, operator) | `region.ts:45-50` |
| in | `memory.recall.request` | `memory-recall` | `store.recall(query, k)` then publish `memory.recall.reply` | `region.ts:52-60` |
| in | `chat.message` | `memory-notes` | live note capture on every non-skipped line (Viewer notes, `MEM-CAPTURE-*`) | `capture.ts` |
| in | `brain.status` | `memory` | remember the cortex's latest state, so a consolidation pass runs only while the cortex is idle (`MEM-CONSOL-002`) | gap |
| in | `memory.notes.request` | `memory-recall` | answer the cortex with the notes of the named viewers (`MEM-SURF-*`) | `surface.ts`, `region.ts` |
| in | `memory.viewers.request` | `memory-recall` | owner operations from the dashboard Viewers page (`MEM-ADMIN-*`) | `admin.ts`, `region.ts` |
| out | `memory.viewer` | | `{user, isNew, msgCount, regular}`; published before the slow embed so the cortex has it when it builds the reply | `region.ts`; `MEM-VIEWER-002` |
| out | `memory.recall.reply` | | `{id, memories:[{ts(epoch ms), kind, who, text, similarity}]}` | `region.ts:55-58` |
| out | `memory.notes.reply` | | `{id, viewers:[{user, regular, msgCount, notes:[{layer, category, text? (never for health or family), hint?, strength}]}]}` | `surface.ts` (`MEM-SURF-001`) |
| out | `memory.viewers.reply` | | `{id, ok, error?, detail?, data?}` | `admin.ts` (`MEM-ADMIN-007`) |

Two consumer groups exist so a recall never queues behind the embed plus INSERT
writes (`startup.ts:59`). A third group, `memory-notes`, runs live note capture,
so a slow classifier call never delays memory writes or recall answers
(`MEM-CAPTURE-001`). All subscribe with the bus start mode `resume`
(`MEM-EVT-001`): a group the subscription creates starts at the newest entry
(`XGROUP CREATE ... $`), and a group that already exists resumes after its last
delivered entry. So:

- on the very first start (no groups yet), events published before the groups are
  created are never seen;
- on any later start the service receives everything published while it was
  down, up to the stream's approximate 20 000-entry cap
  (`packages/bus/src/index.ts:9`), and stores it. Every other subscribing service
  uses start mode `latest`, which resets its group to `$` on each start; memory
  is the exception because the backlog is exactly what it exists to keep.

Every subscription passes `start: "resume"` (`startup.ts`). The control-plane
manifest also starts memory in `resume` mode (`packages/control/src/manifest.ts`);
a control-plane `fresh` start resets its three groups to `$` first.

`ready` should be reported once both consumer groups exist (`MEM-START-005`, open).
The bus reports no event for group creation, so `startup.ts` starts the
subscriptions with `void` and calls `heartbeat.ready()` at once (`startup.ts:60-62`):
`ready` can precede group creation. Closing the gap needs a bus hook (for example
`onReady` in `SubscribeOptions`, called once the group exists and is positioned,
before the first read) owned by the event-bus segment. Calling `resetGroup` from
memory is not an option: it would move a resumed group to `$` and drop the backlog.

Bus handler errors are caught, logged, and the entry is acked
(`packages/bus/src/index.ts:160-166`), so an exception in this handler drops
that event rather than retrying it. The handler therefore catches a failed
`touchViewer` itself, logs it, skips `memory.viewer` and still remembers the
mention (`MEM-VIEWER-006`, `region.ts:25-29`).

### Test injection

`skipInjected` (`region.ts:14`) returns true for `injected === true && remember !== true`.
For `chat.message`, `speech.heard` and `brain.say` an injected, not-remembered event
causes no viewer row, no `memory.viewer`, and no memory row (`region.ts:24,40,47`).
`remember` is ignored on events that are not `injected` (`region.test.ts:96-102`).
`memory.recall.request` has no injection flag and is always served.

### Viewers

Every non-skipped chat line upserts `viewers` keyed by `lower(userId ?? user)`
(`store.ts:142-152`). A new row starts at `msg_count` 1 (the INSERT sets it
explicitly, `store.ts:144`; the column default is 0, `store.ts:87`) and each later
message adds 1, so `msgCount` is the number of messages seen and `isNew`
(`msg_count <= 1`, `store.ts:150`) is true for the first message only, in both
stores (`MEM-VIEWER-001`, in-memory: `fake-store.ts:54-57`). On conflict the row's
`display` is replaced, `last_seen` refreshed and `msg_count` incremented
(`store.ts:145`). `first_seen`
and `last_seen` are selected but unused.

A viewer is a **regular** when the owner has flagged them as one or when their
lifetime `msg_count` is above `brain.memory.regular_messages` (default 25)
(`MEM-REG-001`). `msg_count` is never reset. Regular status decides only how the
co-host frames a viewer ("a regular"); it does not decide whether notes are
captured or shown: notes are kept for every viewer from their first message
(see Viewer notes below). `memory.viewer` carries `{user, isNew, msgCount,
regular}` (`MEM-VIEWER-002`); the threshold is a config value rather than a
literal in the cortex. The legacy `viewers.notes` text column is no longer read or
published; it stays in the table so no migration drops data.

## Viewer notes

The co-host remembers recent, relevant things about viewers (what they are doing,
a cool new thing they got) and who they are as people, without storing or
surfacing sensitive things badly. Notes are kept for every viewer from their first
message; regular status does not gate them. The feature is implemented: its specs
are `[x]`, with tests citing them.

Settled intent: the purpose, the two layers, strength
with reinforcement and fade, the sensitivity rules, live capture by a small model,
the consolidation pass and its two triggers, the delete semantics, owner control
in the dashboard and that every number is configurable; also the categories, the
local-only notes models, hint-only surfacing of sensitive notes, no subscriber
status in the prompt, the 24-hour sensitive cooldown, the 30-day retention of
soft memories, the best-effort shutdown one-shot with a guaranteed catch-up pass,
and the consolidator on the cortex's model; also the other formulas, defaults,
names, event shapes and storage layout described below.

### Notes, layers and strength

A note is one short sentence about one viewer, in one of two layers:

- **Core**: who the viewer is; it sticks around.
- **Recent**: what the viewer is up to lately; it fades.

Each note carries a category, an optional handling hint, a strength between 0 and
1, the number of mentions that reinforced it, a dirty flag and a version
(`MEM-NOTE-001`). Categories are `general`, `health` and `family`.
Politics is never stored, and money is never a note: the only money-related fact
memory keeps is the viewer row's subscriber flag, refreshed from each
`chat.message`'s `isSub` (`MEM-NOTE-009`, `MEM-REG-005`). A `health` or `family`
note always carries a handling hint, a short instruction that shapes how the
co-host behaves rather than text it repeats (for example "check in gently, don't
quote"); when the writer supplies none, the category default applies
(`MEM-NOTE-010`).

Strength is stored as a value and the time it was set; the effective strength at
any later time decays exponentially with the layer's half-life (`MEM-NOTE-002`):

```
effective(t) = strength × 0.5 ^ ((t − strength_at) / half_life(layer))
half_life(recent) = brain.memory.notes.recent_half_life_days   (default 7)
half_life(core)   = brain.memory.notes.core_half_life_days     (default 60)
```

Effective strength is computed when read, so nothing has to run for a note to
fade; values outside 0 to 1 (including a non-finite result after a very long gap)
are clamped (`MEM-NOTE-003`). The rules that move notes between layers:

| Event | Effect | Spec |
|---|---|---|
| A fresh mention reinforces a note | `strength = e + (1 − e) × reinforce` (default 0.6) where `e` is the effective strength now; `strength_at = now`; `mentions + 1` | `MEM-NOTE-005` |
| A recent note reaches `promote_mentions` (default 3) | moves to core, keeping its strength | `MEM-NOTE-006` |
| A core note's effective strength falls below `demote_below` (default 0.3) | moves to recent at that strength, mentions reset to 0, so it fades on the faster clock and can be promoted again | `MEM-NOTE-007` |
| A recent note's effective strength falls below `drop_below` (default 0.1) | deleted with no deletion record (fading is not an owner deletion) | `MEM-NOTE-008` |

With the defaults a core note left alone falls from 1 to 0.3 in about 104 days,
then fades as a recent note to 0.1 in about 11 more days and is dropped; a recent
note left alone drops after about 23 days. Repeated mentions keep a note near full
strength, and a note mentioned on three separate occasions becomes core. Notes
whose effective strength is below `drop_below` are never sent to the cortex even
before a pass deletes them (`MEM-SURF-003`).

### Storage

Postgres (created by `init`, `MEM-STORE-001`):

- `viewers` gains `regular_manual boolean` (the owner's flag), `is_sub boolean`
  and `placeholder boolean` (a row the owner created before the viewer ever
  chatted).
- `viewer_notes(id, user_key → viewers, layer, category, text, hint, strength,
  strength_at, mentions, dirty, version, created_at, last_surfaced_at, embedding
  vector(dims))`. The embedding uses the memory embedder (`brain.memory.embedder`),
  so note similarity follows the same local model as recall.
- `viewer_note_deletions(id, user_key, layer, category, text, hint, strength,
  reason, deleted_at, embedding)`: the owner's deleted notes. A row with a reason
  is a **suppression rule**; a row without one is a **soft memory** of the
  deletion.
- `meta` keys `notes.last_consolidation` and `notes.shutdown_run_owed`.

The in-memory store keeps the same records in process and loses them on exit, as
it does for everything else (`MEM-BACKEND-005`).

### Live capture

Capture runs as chat comes in, in the `memory-notes` consumer group, on every
`chat.message` except injected lines not marked `remember` and lines shorter than
`capture_min_chars` (default 8) (`MEM-CAPTURE-001`, `MEM-CAPTURE-002`).
It uses a very small, cheap classifier model through a region hook,
`memory.capture`, configured by `brain.memory.notes.capture` (a `ModuleSchema`
block: `kind`, `url`, `timeout_ms`, `llm{provider, model}`), so it has its own
model slot and never shares the cortex's configuration
(`MEM-CAPTURE-003`). The example ships `gemma3:4b` on local Ollama (`NOTES_MODEL`,
CFG-USR-008). The hook decides whether the line is noteworthy, picks the
category, drops politics and money, and writes the short note text and an optional
hint (`MEM-CAPTURE-004`). Its rules fallback writes no note, so a slow, down or
confused classifier costs only a missed note. The hook input is the viewer's name,
the line, the viewer's current note texts and the reasons of their suppression
rules, so the model can avoid duplicates and learned refusals.

Model calls for notes stay on the LAN unless the operator names a hosted provider
on the notes hook itself: with no provider on the hook, memory builds it on the
local `ollama` provider instead of inheriting `llm.provider` (which may be a
hosted chat model), except that `llm.provider: mock` is still inherited so the
isolation preset keeps working (`MEM-NOTE-011`). This holds even when the cortex
uses a hosted model. This keeps viewer
notes, including health and family notes, under the HLD rule that memories leave
the LAN only through explicitly configured egress.

The writer then applies, in order (`MEM-CAPTURE-006` to `MEM-CAPTURE-009`):

1. **Suppression.** A candidate whose embedding is at least `suppress_similarity`
   (default 0.8) similar to one of the viewer's suppression rules is discarded.
2. **Duplicate.** A candidate whose normalised text (lower-cased, whitespace
   collapsed, trailing punctuation removed) equals one of the viewer's notes
   reinforces that note instead of adding a new one.
3. **Soft return.** A candidate that similar to one of the viewer's soft
   memories is kept, but starts at `returning_strength` (default 0.3): the topic
   can come back if the viewer keeps raising it.
4. **Insert.** Otherwise a new recent note at strength 1 with one mention.

Every note the writer inserts or reinforces is dirty. If the viewer row does not
exist yet (the `memory` group has not handled the same line), the writer creates
it without counting a message (`MEM-CAPTURE-011`). A failing hook, embedding or
write logs a warning and stores nothing for that line (`MEM-CAPTURE-010`).

### Consolidation

A stronger model runs an after-the-fact quality pass over dirty notes: it merges
duplicates, reinforces repeated notes, rewrites unclear text, rechecks sensitivity
and drops what the weak classifier should not have kept. Fade, demotion,
promotion and dropping are plain arithmetic done by code in the same pass
(`MEM-CONSOL-004`). The model part is a second region hook, `memory.consolidator`,
configured by `brain.memory.notes.consolidator`; its rules fallback proposes no
changes, so a failed model call still leaves the arithmetic done
(`MEM-CONSOL-005`). By default the consolidator runs on the cortex's model through
the local provider, because it runs only while the cortex is idle.

There is no nightly schedule. A note written live stays dirty until a pass has
processed it. A pass is triggered:

- **Mid-stream**, when the number of dirty notes reaches `dirty_threshold`
  (default 20) (`MEM-CONSOL-001`). It starts only while the cortex is idle and
  pauses between viewers whenever the cortex starts thinking or speaking
  (`MEM-CONSOL-002`, `MEM-CONSOL-003`). Memory learns the cortex's
  state from `brain.status`; `muted` counts as idle, and so does no status seen
  since memory started (no cortex running means nothing to compete with).
- **Once after the owner shuts the AI down**, by a separate one-shot command,
  `consolidate` (`pnpm consolidate`, `node services/memory/dist/consolidate.js`),
  started once the services are down. It processes every dirty note, ignores the
  threshold and does not wait for idle (`MEM-CONSOL-012`). It runs outside the
  memory service because Docker's default 10 s stop grace, and the bus's 2 s
  `beforeShutdown` cap (event-bus SHARED-LIFE-001), are far too short for a model
  pass. The owner stops the stack in several ways (`docker compose down`,
  Ctrl-C, the dashboard), so the design depends on none of them: the one-shot is
  a best-effort extra, reachable from Compose (the `consolidate` one-shot service, deployment
  DEPLOY-COMPOSE-018) and from `cohostctl consolidate` (control-plane
  CTRL-CLI-008), and the guaranteed path is
  the catch-up pass at the next start described below.

Missing a run is safe. Dirty flags are the catch-up state, mirroring the reflection
cursor: a later pass processes whatever is still dirty. At startup memory counts
dirty notes and schedules a pass when the count is at or above the threshold
(`MEM-CONSOL-015`). On graceful shutdown memory sets `notes.shutdown_run_owed`; the
one-shot clears it, and when memory starts with the flag still set and dirty notes
present it schedules one idle-gated pass in its place (`MEM-CONSOL-013`). Every
graceful stop (Compose `down`/`stop` send SIGTERM, Ctrl-C sends SIGINT) sets the
flag, so the next start always catches up when the one-shot did not run; after a
crash the dirty-count check at startup (`MEM-CONSOL-015`) covers it.

A pass, per viewer that has at least one dirty note (`MEM-CONSOL-004`):

1. Read all the viewer's notes with their versions, and the viewer's suppression
   rules.
2. Apply fade: demote core notes below `demote_below`, drop recent notes below
   `drop_below`, promote recent notes that reached `promote_mentions`.
3. Drop notes similar to a suppression rule (the same check as capture,
   `MEM-CONSOL-009`).
4. Run `memory.consolidator` on the remaining notes and the suppression reasons.
   It answers with operations: `merge` (several note ids into one text),
   `rewrite` (new text, category or hint for one note) and `drop` (one note id);
   operations naming unknown ids, or producing politics or money, are discarded
   (`MEM-CONSOL-005`). A merged note keeps the strongest member's layer (core
   wins), takes the reinforcement rule once per extra member and the sum of their
   mentions (`MEM-CONSOL-006`).
5. Commit the viewer's changes in one transaction, only for notes whose version
   still equals the version read in step 1; a note changed or deleted meanwhile
   (a live reinforcement, an owner deletion) is left as it now is and stays dirty
   if it still exists (`MEM-CONSOL-007`). Processed, unchanged notes are marked
   clean (`MEM-CONSOL-008`).

One pass runs at a time across the service and the one-shot, guarded by a
Postgres advisory lock; a pass that cannot take the lock is skipped
(`MEM-CONSOL-010`). A pass interrupted partway keeps the viewers it committed and
leaves the rest dirty (`MEM-CONSOL-011`). Each completed pass records
`notes.last_consolidation` (`MEM-CONSOL-014`) and purges soft memories older than
`deleted_retention_days` (default 30) (`MEM-CONSOL-016`); suppression rules
(deletions with a reason) are kept until the owner restores them.

### Surfacing to the cortex

The cortex asks for notes when it replies, with `memory.notes.request {id, users}`,
handled in the `memory-recall` group next to recall (`MEM-SURF-001`). The first name in `users` is the viewer being replied to; the rest
are the other viewers in the cortex's working-memory window. A name resolves to
the viewer row whose display name matches it case-insensitively, the most recently
seen one when several do (`MEM-SURF-002`), so a renamed viewer is found by their
current name once they have chatted under it. The reply lists, per resolved
viewer, `regular`, `msgCount` and their notes (never subscriber status, which is
stored but not surfaced), strongest first, at most
`max_notes_per_viewer` (default 5) each and `max_notes_total` (default 15) overall,
filling the replied-to viewer first (`MEM-SURF-003`). `health` and
`family` notes are included only for the replied-to viewer and at most once per
`sensitive_cooldown_hours` (default 24) per note, and with their category and
hint only: the note text never leaves memory toward the cortex. Including one
records the time (`MEM-SURF-004`). A store error answers an empty list
(`MEM-SURF-005`). How the cortex renders notes, and sensitive ones as handling
guidance, is the cortex's design.

### Owner operations

The owner sees and controls every stored note from the dashboard's Viewers page.
The dashboard cannot touch Postgres (HLD tenet 1), so it sends
`memory.viewers.request {id, op, ...}` and memory answers `memory.viewers.reply
{id, ok, error?, detail?, data?}` (`MEM-ADMIN-*`). Operations:

| `op` | Effect | Spec |
|---|---|---|
| `list` | viewers ordered by last seen, optionally filtered by a case-insensitive substring of the display name: key, display, regular, whether the flag is manual, message and note counts | `MEM-ADMIN-001` |
| `get` | one viewer's notes split into core and recent (id, text, category, hint, effective strength) and their deleted notes with reasons | `MEM-ADMIN-002` |
| `delete_note` | delete one note with an optional reason; the deleted note is recorded | `MEM-ADMIN-003` |
| `restore` | undo a deletion: the note comes back as it was, at the strength it had when deleted, and its suppression rule (if any) is lifted | `MEM-ADMIN-004` |
| `clear` | delete every note of one viewer with one optional reason; regular flag and counts unchanged | `MEM-ADMIN-005` |
| `set_regular` | set or clear the owner's regular flag, by key or by a name with no row yet | `MEM-ADMIN-006` |

**Delete semantics.** A deletion with a reason becomes a suppression rule: capture
and consolidation discard similar notes for that viewer, and the reason text is
given to both hooks so it can inform handling. A deletion without a reason is
remembered only softly: the topic can return later, starting weak, if the viewer
keeps raising it. Every deletion stays listed, with its reason, so it can be
undone.

**Regular flag before any message.** Setting the flag on a name with no viewer row
creates a placeholder row keyed by the lower-cased name with `msg_count` 0
(`MEM-REG-003`). Twitch rows are keyed by user id, so when the first
`chat.message` arrives from a key with no row and a placeholder's display matches
the message's `user` case-insensitively, memory re-keys the placeholder to the
message's key and counts the message on it, keeping the flag (`MEM-REG-004`).

### Edge cases

How the design handles the interactions a cold reader is likely to ask about:

| Case | Handling | Spec |
|---|---|---|
| Owner deletes a note while a pass is running | the pass's commit skips the note because its version changed or it no longer exists; the deletion stands | `MEM-CONSOL-007` |
| Live capture reinforces a note while a pass is running | same version check; the pass leaves the note as reinforced and dirty for the next pass | `MEM-CONSOL-007` |
| Pass interrupted by shutdown or an error | committed viewers stay committed; the others stay dirty; the next pass catches up | `MEM-CONSOL-011` |
| Mid-stream pass and the one-shot overlap | advisory lock: the second pass is skipped | `MEM-CONSOL-010` |
| Classifier model down or slow | rules fallback: no note for that line; the hook warns at most once per 30 s (region-hooks) | `MEM-CAPTURE-003`, `MEM-CAPTURE-010` |
| Consolidator model down | arithmetic still runs; no merges or rewrites; notes are marked clean, so the next model attempt happens only for notes that become dirty again | `MEM-CONSOL-005`, `MEM-CONSOL-008` |
| Capture runs before the `memory` group created the viewer row | the writer creates the row without counting a message | `MEM-CAPTURE-011` |
| Manual regular flag for a viewer with no row | placeholder row, claimed by the first matching chat line | `MEM-REG-003`, `MEM-REG-004` |
| Viewer renames | rows are keyed by user id; `display` follows the latest message; notes follow the key; name lookups use the current display | `MEM-VIEWER-001`, `MEM-SURF-002` |
| Subscriber status changes | the flag follows the latest `chat.message`; no history is kept | `MEM-REG-005` |
| Duplicate or conflicting notes | exact duplicates reinforce at capture; near-duplicates and contradictions are merged or rewritten by the consolidator | `MEM-CAPTURE-008`, `MEM-CONSOL-005` |
| Strength underflow after a long gap | effective strength is clamped to 0 to 1; a non-finite result counts as 0 | `MEM-NOTE-003` |
| Clearing all notes | each note becomes a deletion record carrying the one reason (or none), so each can be restored | `MEM-ADMIN-005` |
| Undoing a deletion | the note returns at the strength it had when deleted and fades from the restore time; its suppression rule is lifted | `MEM-ADMIN-004` |
| Sensitive cooldown under concurrent requests | Each sensitive note is timed by `last_surfaced_at`, with no lock between concurrent `memory.notes.request`s | a row lock or an atomic claim-and-return per note | Owner decision: accepted. The cooldown is a once-per-24-hours courtesy, not a safety property (the note text never leaves memory), and the cortex asks once per reply, so two requests racing in the same instant is rare and costs at most one repeated hint. `MEM-SURF-004` |
| Suppression matching | embedding similarity against the same viewer's reason-carrying deletions only; the hash embedder (isolation) matches on shared words | `MEM-CAPTURE-006`, `MEM-CONSOL-009` |
| Mute, pause, `forget_context` | memory ignores `control`; notes are unaffected | `MEM-EVT-002` |
| How the stack was stopped | irrelevant: graceful stops set `notes.shutdown_run_owed` and the next start catches up; the one-shot is optional | `MEM-CONSOL-012`, `MEM-CONSOL-013` |
| Voice speakers | `speech.heard` speakers have no viewer row and get no notes | `MEM-CAPTURE-002` |

### Build order

The feature lands in four pull requests, in this order, so each spec maps to one:

| # | Chunk | Specs |
|---|---|---|
| 1 | Memory core: notes store, regular flag, decay math, config, consolidation job and triggers | `MEM-NOTE-001` to `011`, `MEM-REG-001` to `005`, `MEM-CONSOL-001` to `016`, `MEM-STORE-001`, `MEM-BACKEND-005`; config `CFG-SCH-014` to `016`, `CFG-USR-007` |
| 2 | Live capture classifier | `MEM-CAPTURE-001` to `011`; config `CFG-USR-008` |
| 3 | Cortex surfacing | `MEM-SURF-001` to `005`, `MEM-VIEWER-002`; cortex `CTX-NOTES-*`, `CTX-VIEWER-001`, `CTX-EVT-001`; event-bus `BUS-EVT-010`, `BUS-EVT-020`; dashboard `DASH-FEED-007` (notes first appear on the bus here, so the feed must stop forwarding them in the same change) |
| 4 | Dashboard Viewers page with access protection | `MEM-ADMIN-001` to `007`; dashboard `DASH-VIEWERS-*`; event-bus `BUS-EVT-021`; config `CFG-ENV-009` |

`BUS-EVT-001` (the event catalogue) changes in chunks 3 and 4 and is marked
implemented after chunk 4. Chunk 1 has no owner-facing surface yet: notes can be
inspected only in the database until chunk 4.

## Stores and embedders

Factories in `services/memory/src/backend.ts`:

- `createMemoryEmbedder(cfg)`: `brain.memory.embedder === "hash"` gives `HashEmbedder`
  from `@cohost/llm` (no network); anything else gives `new Ollama(cfg.llm)`
  regardless of `llm.provider` (`backend.ts:8-10`). This differs from
  `@cohost/llm`'s own `createEmbedder`, which switches to hash when
  `llm.provider === "mock"` (`packages/llm/src/index.ts:60-62`); memory does not
  call `createEmbedder`.
- `createStore(cfg, embedder, log)`: `brain.memory.store === "memory"` gives
  `InMemoryStore`, which ignores the supplied embedder; anything else gives the
  Postgres `MemoryStore` (`backend.ts:14-18`).

Both stores implement `MemoryBackend` (`services/memory/src/store.ts`): `init, remember,
recall, touchViewer, recentSince, getMeta, setMeta, close` for memories, viewers and
metadata, and for viewer notes `getViewer, setRegular, insertNote, reinforceNote,
listNotes, listDeletions, deleteNote, ensureViewer, embedText, dirtyNoteCount, dirtyViewerKeys, commitViewer,
purgeSoftDeletions, withConsolidationLock`. `region.ts` types the store as
`Pick<MemoryStore, ...>` of the methods it uses, which either backend satisfies
structurally.

### Postgres `MemoryStore` (`store.ts:49-175`)

- Pool: `new pg.Pool({ connectionString: urls.database(), max: 4 })`
  (`store.ts:58`); `DATABASE_URL`, default `postgres://cohost:cohost@127.0.0.1:5432/cohost`
  (`packages/config/src/index.ts:158`). The pool is built in the constructor, so
  `reflect` (with the Postgres store) and the unit tests create one.
- Every pool query goes through `MemoryStore.query` (`store.ts:62`), which wraps it
  with `tracked()` and reports the outcome to the `onQuery` callback; the service
  passes `health.setPostgres` (`index.ts:28`), so `deps.postgres` follows the latest
  query (`MEM-HEALTH-005`).
- `init()` (`store.ts:67-98`): embeds the literal `"hello"` to learn the vector
  dimension, then `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TABLE IF NOT
  EXISTS` for `memories(id, ts, kind, who, text, embedding vector(dims))`,
  `viewers(user_key PK, display, first_seen, last_seen, msg_count, notes)` and
  `meta(k PK, v)`, then an hnsw cosine index whose failure is only a warning.
  The dimension is fixed when the table is first created. `init` compares the
  existing column's dimension (`atttypmod` of `memories.embedding`,
  `checkDimensions`, `store.ts:100-106`) with the probed one and throws
  `DimensionMismatchError` (`store.ts:33-42`, code `MEMORY_DIM_MISMATCH`) naming
  both when they differ. Startup does not retry that error, so the service ends in
  its fatal exit instead of running with every write and recall failing
  (`MEM-STORE-002`). The operator's way out is the `reembed` command (Re-embedding).
- `remember` embeds `"<who>: <text>"` and inserts the pgvector literal `[a,b,...]`
  (`store.ts:109-119`, `toVector` at `store.ts:177`). Kinds: `chat`, `speech`, `self`.
- `recall` (`store.ts:122-140`): `k <= 0` returns `[]` with no query; otherwise embeds
  the query and selects `1 - (embedding <=> $1) AS similarity` where `ts < now() -
  interval '2 minutes'` ordered by cosine distance, limit `k`, then filters in JS by
  `similarity >= min_similarity`. The 2-minute exclusion keeps the immediate
  conversation out of "memories". `k` defaults to `brain.memory.recall_k` (default 6;
  `min_similarity` default 0.35, `packages/config/src/schema.ts:147-148`).
- `recentSince(cursor, limit=400)` and `getMeta/setMeta` back the reflection job
  (`store.ts:154-170`). `recentSince` selects `WHERE (ts, id) > ($1::timestamptz, $2)
  ORDER BY ts, id LIMIT $3`, returning `ts` also as microsecond text (`"tsText"`).

### In-memory `InMemoryStore` (`fake-store.ts`)

Same interface, state in JS arrays and maps, lost on exit. It embeds with
`@cohost/llm`'s `HashEmbedder` (64 dims, signed FNV-1a buckets over
`[\p{L}\p{N}]+` tokens, L2-normalised, a fixed unit vector for empty text;
model-backends LLM-EMBED-005, 006), the same embedder `store=postgres` with
`embedder=hash` uses, so hash-mode recall behaves the same in both stores
(MEM-BACKEND-004). Signed buckets make unrelated texts score near or below zero
and related texts lower than plain word overlap would, so the fake store's recall
tests choose fixtures whose similarity clears `min_similarity` (default 0.35)
rather than relying on any overlap scoring positive. `recall` mirrors the SQL semantics: 2-minute cutoff against an
injectable clock, cosine by dot product, sort, top `k`, `min_similarity` filter
(`fake-store.ts:39-49`). `touchViewer` lowercases the key, counts from 1 and never
returns notes other than `""` (`fake-store.ts:52-58`). `recentSince` returns rows
after the `(ts, id)` cursor in `(ts, id)` order with a default limit of 400, and
`meta` is a `Map` (`fake-store.ts:61-71`).

## Re-embedding (`reembed.ts`, `reembed-run.ts`)

After the owner changes the embedder to one with another vector size, `init` refuses the
existing tables (`MEM-STORE-002`). The `reembed` one-shot (`pnpm reembed`,
`node services/memory/dist/reembed.js`, the Compose `reembed` job in the `tools` profile, or
`cohostctl reembed`) is the way forward; run it with the memory service stopped.

- `runReembed` (`reembed-run.ts`) takes the consolidation lock (`MEM-REEMBED-004`), calls
  `MemoryStore.reembed`, logs per-table progress and a summary, and closes the store.
  With `store=memory` it only warns (`MEM-REEMBED-005`); a failure logs `reembed failed` and
  sets exit code 1 (`MEM-REEMBED-006`).
- `MemoryStore.reembed` probes the embedder's dimension, then for each of `memories`,
  `viewer_notes` and `viewer_note_deletions` that exists and whose `embedding` column has another
  dimension: adds a staging column `embedding_new vector(N)` (dropping a leftover one of another
  dimension), embeds the rows that still have no new vector in pages of 100 (`memories` from
  `<who>: <text>`, the note tables from `text`, the text the write path embeds) and stores each
  vector as it is made. Only when every row of every table is done does one transaction drop the old
  columns and rename the staging ones, after which the hnsw index on `memories` is recreated
  (a failure is a warning, as in `init`). Nothing but the vectors changes (`MEM-REEMBED-001`,
  `MEM-REEMBED-003`). When every column already has the right dimension it does nothing
  (`MEM-REEMBED-002`).
- The old columns keep serving until the swap, so a failed or killed run is harmless and a rerun
  continues where it stopped. The lock is a session advisory lock, so a crashed run never leaves
  it held.

## Startup, health and shutdown

Config read: `brain.memory.{store, embedder, recall_k, min_similarity}` (env
overrides `MEMORY_STORE`, `MEMORY_EMBEDDER` via `config/config.example.yaml:109-110`),
`cohost.name`, `cohost.streamer` (reflect), `llm.*` (Ollama client), `DATABASE_URL`,
`HEARTBEAT_INTERVAL_MS` (heartbeat package).

Startup sequence (`startMemory` in `services/memory/src/startup.ts`, called from
`index.ts:31`; its dependencies are injected so `startup.test.ts` runs it without
Redis, Ollama or Postgres):

1. `index.ts` starts the heartbeat immediately (`index.ts:26`): state `starting`.
2. If store or embedder is non-default, warn `mode mock; data is not durable`.
3. If `store=postgres` and `embedder=ollama`: ping Ollama every 3 s forever; each miss
   sets `deps.ollama=down` and reports heartbeat `degraded` with the detail
   `waiting for ollama (embeddings)`, as the cortex does while it waits for its
   backend (`MEM-HEALTH-007`); success sets `ok` (`startup.ts:31-39`).
4. If `store=postgres`: `store.init()` with a retry every 3 s; each failure sets
   `deps.postgres=down` and reports `degraded` with a detail naming Postgres
   (`MEM-HEALTH-007`), success sets `ok`, and the 21st failure rethrows so the
   process logs `fatal` and exits 1 (`startup.ts:41-54`, `index.ts:45-46`). A
   `DimensionMismatchError` is rethrown at once, without a retry
   (`MEM-STORE-002`). Otherwise a single `store.init()` on the fake
   (`startup.ts:56`).
5. Start the subscriptions (`memory`, `memory-recall` and `memory-notes`) with `start: "resume"`, call `heartbeat.ready()`
   (once every group exists, `MEM-START-005`), log `memory online`
   (`startup.ts:58-63`).

Health (`health.ts`): `MemoryHealth` builds the `HeartbeatSpec`. `mode` is `live`
only for postgres plus ollama, else `mock`. `deps.postgres` is `n/a` unless the
store is Postgres; `deps.ollama` is `n/a` unless postgres plus ollama. The embedder
handed to the store is wrapped with `tracked()` so each `embed()` success or failure
sets `deps.ollama` (`health.ts:33-36`), giving `degraded` at runtime when Ollama
stops answering. Postgres pool queries are wrapped the same way (`store.ts:54,62`),
so `deps.postgres` follows the latest query and a Postgres outage after startup
shows as `degraded` even though `remember`/`recall` swallow the error
(`MEM-HEALTH-005`). Heartbeat contract and `degraded` derivation are owned by the
control-plane segment (`packages/bus/src/heartbeat.ts:68-85`).

Shutdown: `onShutdown` stops the bus then closes the store (`index.ts:47`); the
`stopping` heartbeat is sent by the heartbeat package's `beforeShutdown` hook.
Before closing the store, memory records that a shutdown consolidation run is owed
(`MEM-CONSOL-013`, Viewer notes).

## Reflection pass (`reflect.ts`, `learned.ts`)

A CLI run between streams (`pnpm reflect` which is `tsx src/reflect.ts`, or
`node services/memory/dist/reflect.js`). It is not a bus region. It takes the
consolidation advisory lock (`withConsolidationLock`, the one the service's note
passes and the `consolidate` one-shot share), so it never overlaps them.

1. `store=memory`: log a warning and return (nothing persists across processes).
2. `connect()` the store: check that `memories` and `meta` exist, with no DDL and no
   embedder call, so reflection works while Ollama is down (`MEM-REFLECT-011`).
   Take the consolidation lock; when another pass holds it, log a warning and
   return with nothing read or changed (`MEM-REFLECT-012`). Read
   `meta.last_reflection` (default: before the first row), `recentSince(cursor, 600)`.
3. Fewer than 5 rows: log and return with the cursor unchanged, so those rows are
   read again, together with the ones that arrive later, in a later pass. The final
   batch of a backlog may be partial: 5 to 599 rows reflect normally.
4. Ask the chat LLM (`createChatProvider(cfg.llm)`, `maxTokens 400`, `temperature
   0.5`) for 3 to 6 bullets given the current personality and the `who: text`
   transcript (`reflect-run.ts:41-54`).
5. `parseBullets` keeps only lines that start with `- ` after trim
   (`learned.ts:7-9`); none: warn and stop without saving.
6. The `### YYYY-MM-DD` (UTC) block goes at the end of the `## Learned` section,
   before the next `## ` heading or at the end of the text when `## Learned` is the
   last section; a `## Learned` heading is added at the end when the text has none
   (`MEM-REFLECT-007`, `appendLearned`, `learned.ts:16-27`; only a line that is
   exactly `## Learned` is the heading). The shipped template ends with `## Learned`
   (`config/personality.example.md:26`). The result is saved with
   `savePersonality`, `meta.last_reflection` advances (below), and the block is
   printed (`reflect-run.ts:59-64`).
7. Failures (including missing tables at `connect`) log `reflect failed` and
   set `process.exitCode = 1`; the store is closed in `finally` (`reflect-run.ts:26-29`).

The pass itself is `runReflect` in `reflect-run.ts`, with the config, chat provider,
store, personality load/save and clock injected; `reflect.ts` is the wiring that
runs it at load. When the chat provider is the mock backend (`name === "mock"`),
`runReflect` logs one warning naming it before reading any memory
(`MEM-REFLECT-010`, `LLM-MOCK-005`), so canned bullets are never mistaken for a real
reflection.

`recentSince` reads at most 600 rows, which bounds the prompt. The reflection
cursor is the pair `(ts, id)` of the newest row read: after a successful save
`meta.last_reflection` stores it as `<ISO ts>#<id>` (`cursor.ts`), where the timestamp is the
exact text Postgres produced (microsecond precision, selected as `"tsText"` by
`recentSince`) and is passed back as `$1::timestamptz`, and the next
pass reads rows strictly after it in `(ts, id)` order, so with more than 600 new
rows the remainder is reflected on in the next pass, and rows sharing the last
row's timestamp are not skipped (`MEM-REFLECT-008`). A timestamp-only cursor would
skip such rows because `ts > $1` excludes them. A plain ISO timestamp left in
`meta.last_reflection` by an earlier version is read as that timestamp with the
lowest id.
The running cortex does not learn of the change until a `reload_personality` control.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Where vectors live | Postgres with pgvector, hnsw cosine index | in-process index; dedicated vector DB | One durable store holds memories, viewers and the reflection cursor (`meta`), so a vector search, a viewer update and the cursor share one dependency and one backup; pgvector's hnsw index gives approximate cosine search without running a separate vector service, and an in-process index would not survive a restart; `store.ts:71-98` |
| Embedder for memory | Always local Ollama unless `embedder=hash` | follow `llm.provider` | Keeps the vector size independent of the chat model: commit `969f6d7` ("Embeddings always come from local Ollama so the memory table's vector size is independent of the chat model"), `packages/config/src/schema.ts:38-41`. Not following `llm.provider: mock` is deliberate, "avoids silent offline" (commit `51d5a9c` review notes). |
| Vector dimension | Probed from a live embedding at first `init` | fixed constant in config | Comment `store.ts:68`: "Probe embedding size so the table matches whatever model is configured." |
| Two consumer groups | `memory` (writes) and `memory-recall` | one group | Comment `startup.ts:59`: "so a recall never queues behind the (embed + INSERT) writes." |
| Announce viewer before embed | publish `memory.viewer` then `remember` | after | Comment `region.ts:31`: "before the slow embed so the cortex has it when the reply is built." |
| Recency exclusion | `ts < now() - 2 minutes` | include everything | Keeps the live conversation, which the cortex already has in its working-memory transcript, out of recalled memories, so a reply does not "remember" what was said a moment ago. The window is a fixed time span while the cortex window is a count of events (`brain.working_memory_events`), so the two are an approximation of each other, not an exact match; `store.ts:129`, `fake-store.ts:42` |
| Write error handling | `remember`/`recall` swallow and warn; a failed `touchViewer` is caught, logged, and the mention is still remembered | throw everywhere; let the bus drop the whole event | owner decision 2026-11-01: the show goes on without memory, and a viewer-table error must not lose the memory itself; `store.ts:116-118,135-138`, `MEM-VIEWER-006` |
| Vector dimension mismatch | Fail `init` loudly, no retry, fatal exit | silently keep running; report degraded; migrate or re-embed | owner decision 2026-11-01: a mismatch makes every write and recall fail while health says `ok`, so it must stop startup; migration is decided separately; `MEM-STORE-002` |
| Moving to a new vector dimension | A `reembed` one-shot (also `cohostctl reembed`) that stages new vectors in `embedding_new` and swaps every table's column in one transaction | a table per model; drop and start over; migrate lazily inside the running service | The stored text is the source of truth and the owner keeps memories and viewer notes across an embedder change; staging keeps the old vectors serving until every row is done, so an interrupted run loses nothing. A table per model would split recall across vector spaces that cannot be compared; starting over throws away notes the owner curated; a running service would race live writes with half-migrated columns. The dimension check at `init` stays fatal (`MEM-STORE-002`). `MEM-REEMBED-*` |
| Reflection's access to the store | `connect()` (tables exist, no DDL, no embedder) and the consolidation lock | `init()` with its embed probe; no lock | Reflection reads rows and a cursor and calls the chat model, so an unreachable embedder must not stop it; the lock keeps it from overlapping a note pass or another reflection. `MEM-REFLECT-011`, `MEM-REFLECT-012` |
| Unused kind `note` | Removed from `MemoryKind` | keep it declared | Nothing wrote it; the stored kinds are `chat`, `speech` and `self`. |
| Recall `k` validation | Left to the bus schema, which rejects `k <= 0` (`packages/bus/src/events.ts`); the stores keep their `k <= 0` short-circuit for `recall_k: 0` from config | validate again in the handler | A second check would restate the schema; `recall_k: 0` never reaches the store as a request because the cortex sends none. |
| Voice speakers and viewer notes | Voice speakers get no notes; no link between a Discord voice speaker and a chat viewer | map a Discord user id to a viewer identity | Owner decision: out of scope. A mapping needs an identity source the system does not have, and notes about people should come from lines they addressed to the co-host in chat. |
| Consumer-group readiness | The bus's `onReady` subscription option (event-bus); startup waits for every group's `onReady` before `ready` | wait with a timer; `resetGroup` first | Implemented in the shared foundation; `MEM-START-005`. |
| Real-Postgres coverage | The store contract and the Postgres-specific checks run against pgvector in CI (`COHOST_TEST_DATABASE_URL`); they skip with a message where no database is configured | recorded SQL only | The `atttypmod` dimension query, the `(ts, id)` row comparison and `listViewers` are SQL the fakes cannot check. |
| Restart start mode | `resume` for both groups: the backlog published while memory was down is stored | `latest` (reset to `$` each start) like every other subscriber | owner decision 2026-11-01: memory is the durable region and wants the backlog; delivery is still at-most-once across a crash (event-bus); `MEM-EVT-001` |
| Mute and pause | Memory never reads `control`; it records while the co-host is muted | honour mute/pause | owner decision 2026-11-01: only the services that act on mute and pause (cortex, salience) see them |
| Viewer count | A new viewer row starts at `msg_count` 1 in both stores | keep Postgres at 0 | owner decision 2026-11-01: `isNew` once and `msgCount` equal to messages seen, matching the in-memory store; `MEM-VIEWER-001` |
| Viewer notes writer | Live capture by a small classifier model, cleaned by a consolidation pass; the owner deletes and restores from the dashboard | reflection pass writes notes between streams; dashboard-only hand-written notes; hand-edited SQL | Owner decision: notes must be current during the stream ("what they're doing lately"), which a between-streams reflection cannot give, and the owner wants to curate, not author, them. A cheap model can afford every line; a stronger model cleans up its mistakes afterwards. `MEM-CAPTURE-*`, `MEM-CONSOL-*`, `MEM-ADMIN-*` |
| Note shape | Two layers (core, recent) with a strength that mentions reinforce and time fades; core fades slower and can fall back to recent and drop | one flat list with a fixed expiry; an importance score set once by the model; keep notes forever | Owner decision: something mentioned a lot becomes or stays core, stale recent notes disappear, and even core facts eventually go when never mentioned again. Formulas and defaults are. `MEM-NOTE-002` to `MEM-NOTE-008` |
| Fade computation | Effective strength computed at read time from stored strength and time | a timer that decays stored values | Read-time math needs no scheduler and is exact for any gap; the consolidation pass only persists layer moves and drops.; `MEM-NOTE-002` |
| Sensitive categories | Politics never stored; health and family stored with a handling hint, surfaced rarely; money only as the subscriber flag | store everything and let the cortex decide; drop all sensitive topics | Owner decision: the co-host should understand viewers as people, including a death in the family, without quoting it back or exposing it; nobody is called out by wealth. `MEM-NOTE-009`, `MEM-NOTE-010`, `MEM-SURF-004` |
| Capture model slot | Region hook `memory.capture` with its own `ModuleSchema` block (`kind`, `timeout_ms`, `llm{provider, model}`) and a rules fallback that writes nothing | reuse the cortex's `llm` block; a keyword rules classifier; extract notes inside the cortex's reply call |. A hook gives a separate model, a timeout, a failure fallback and an `http` slot for an owner-trained classifier with no new mechanism (HLD "judgement is a hook"); sharing the cortex's call would slow every reply and see only addressed lines. `MEM-CAPTURE-003` |
| Capture model | `gemma3:4b` (`NOTES_MODEL`), capture `timeout_ms` 20000 | `gemma3:1b` (rejected: a live run against Ollama on 2026-11-09 showed it answering in the wrong JSON shape, hint and category at the top level with `note: null`, so it silently writes no notes); a larger model (more GPU time for little gain on a short classification) | Owner decision 2026-11-09: `gemma3:4b` follows the schema and the politics, money and noise rules, at 2 to 4 s per line on CPU and about 13 s on the first, cold call; 20 s covers the cold call (`MEM-CAPTURE-003`, CFG-USR-008). The consolidator, on the cortex's model, cleans up what the small model gets wrong. |
| Notes model egress | Notes hooks use local `ollama` unless the hook names a provider, even when the cortex is hosted; `mock` is inherited | inherit `llm.provider` like the other hooks | Owner decision. A hosted cortex model must not silently carry every chat line and health or family notes off the LAN (HLD tenet 8); the isolation preset still reaches the hooks. `MEM-NOTE-011` |
| Capture consumer group | Third group `memory-notes` | classify inside the `memory` group handler |. The classifier call is slower than an embed; in the shared handler it would delay memory writes and, through ordering, `memory.viewer`. `MEM-CAPTURE-001` |
| Consolidation trigger | Dirty-note count reaches `dirty_threshold` (default 20), plus one run after the owner shuts the AI down; dirty flags are the catch-up state | nightly schedule; every N minutes; after every write | Owner decision: no nightly schedule (the box may be off); work scales with what was captured; a missed run is caught up by the next one, as the reflection cursor does. `MEM-CONSOL-001`, `MEM-CONSOL-012`, `MEM-CONSOL-015` |
| Mid-stream pacing | Start only while the cortex is idle (from `brain.status`), pause between viewers when it gets busy | run immediately; run only between streams |. On one GPU a consolidation call competing with a reply call delays the co-host's line; between-viewer pauses bound the delay to one hook call. `MEM-CONSOL-002`, `MEM-CONSOL-003` |
| Shutdown run placement | Guaranteed: memory leaves `notes.shutdown_run_owed` on every graceful stop and the next start runs an idle-gated catch-up pass. Best-effort extra: a one-shot `consolidate` command reachable from Compose and `cohostctl` | run in memory's `beforeShutdown` with a long Compose `stop_grace_period`; depend on one stop path launching the one-shot | Owner decision: the owner stops the stack in several ways (Compose `down`, Ctrl-C, the dashboard), so no single path may be required. The bus caps `beforeShutdown` hooks at 2 s (SHARED-LIFE-001) and Docker's default stop grace is 10 s; a model pass can take minutes, and a hung model would block every shutdown. Running only at the next start would not be "after shutdown". `MEM-CONSOL-012`, `MEM-CONSOL-013` |
| Pass vs live writes | Per-viewer transaction that commits only notes whose version is unchanged since the pass read them | hold row locks across the model call; pause capture during a pass |. Locks held across a model call would stall capture and owner deletions for seconds; a version check lets the newer write win and leaves the note dirty for the next pass. `MEM-CONSOL-007` |
| One pass at a time | Postgres advisory lock shared by the service and the one-shot | a `meta` flag |. An advisory lock is released when its session ends, so a crashed pass never leaves a stale lock behind. `MEM-CONSOL-010` |
| Passes cover dirty viewers only | A pass processes only viewers with at least one dirty note, so a quiet viewer's fade, demotion and drop are persisted when they next get a dirty note | a pass that sweeps every viewer's notes | Owner decision. Persisting a fade is housekeeping, not correctness: effective strength is computed from the stored strength and `strength_at` whenever a note is read, so a quiet viewer's stale rows are never shown stronger than they are (notes below `drop_below` are not surfaced, `MEM-SURF-003`). `MEM-CONSOL-004`, `MEM-NOTE-003` |
| Strength at promotion | A promoted note keeps its stored strength and `strength_at`, so its effective strength rises at promotion because the core half-life is longer | restart the clock or rebase the strength at promotion | Owner decision: accepted. A note mentioned three times is meant to be held more firmly. `MEM-NOTE-006` |
| Surfacing transport | Cortex asks with `memory.notes.request` at reply time, in parallel with recall | memory pushes notes in `memory.viewer` on every chat line and the cortex caches them; the cortex reads Postgres |. Asking at reply time returns current notes (a deleted note is gone on the next reply), covers the other viewers in the window, and puts notes on the bus only when a reply needs them. Pushing on every line doubles stream traffic and leaves stale notes cached; reading Postgres breaks HLD tenet 1. `MEM-SURF-001` |
| Viewer lookup for surfacing | By current display name, case-insensitive, most recently seen first | carry `userId` through working memory and `attention.focus` |. The cortex holds names only (`attention.focus.who`, the working-memory chat lines); a name lookup needs no change to working-memory or salience. A name shared by two viewers resolves to the one seen last. `MEM-SURF-002` |
| Suppression matching | Embedding similarity (`suppress_similarity`, default 0.8) against the same viewer's reason-carrying deletions, plus the reasons in the hook prompts | exact text match; leave it to the model |. Exact text misses rewordings; a model alone is the component whose mistakes suppression exists to stop. `MEM-CAPTURE-006`, `MEM-CONSOL-009` |
| Owner access path | `memory.viewers.request` / `memory.viewers.reply` over the bus | the dashboard queries Postgres; memory serves an HTTP API the dashboard calls | HLD tenet 1: only memory touches Postgres and services do not call each other over HTTP. event names. `MEM-ADMIN-*` |
| Legacy `viewers.notes` column | Left in place, unread | drop it in `init` |. Dropping a column is irreversible and the column is empty in practice (nothing ever wrote it). |
| Postgres health | Every pool query feeds `deps.postgres` through `tracked()`; `degraded` with a detail while waiting for Ollama or Postgres at startup | startup-only flag; stay `starting` while waiting | owner decision 2026-11-01: the heartbeat reflects runtime dependency state, as the cortex does; `MEM-HEALTH-005`, `MEM-HEALTH-007` |
| Recall k=0 | Short-circuit with no embed or query | query anyway | `config/config.example.yaml:111` documents `recall_k: 0` as "disables recall"; `store.ts:123`, `fake-store.ts:40` |
| Isolated backend | Separate in-process store that embeds with `@cohost/llm`'s `HashEmbedder` | Its own unsigned hash embedder | One embedder means fake-store tests exercise the vectors hash mode really stores; a second hasher with different tokens, signs and empty-text output made the two disagree. The fake still ignores `brain.memory.embedder` and needs no network. Owner decision (shared-runtime, Hash embedding). |
| Reflection with the in-memory store | Logged no-op | reflect over the fake | Commit `719ce5a`: "`reflect` still uses the Postgres store (it runs in a separate process, so a fake would be empty)"; `reflect.ts:22-25` |
| Mode reporting | `mock` if either store or embedder is non-default | per-dependency mode | `live` means memory as a real stream needs it: persistent rows and semantic recall. Either substitute (the in-process store forgets on restart; the hash embedder matches words, not meaning) means recall is not real, so the mode says `mock`; which dependency is substituted is already visible per dependency as `n/a` in `deps`; `health.ts:7-11,24` |
| Reflection placement | Offline CLI, writes personality file | in-service timer; DB-only learned facts | Comments `index.ts:12` ("Consolidation (\"sleep\") is reflect.ts, run between streams") and `reflect.ts:1-9` ("This is how the personality drifts over time instead of resetting every stream. Edit the file by hand whenever you like.") |
| Reflection input cap | Oldest 600 rows since last reflection; the cursor `(ts, id)` advances to the newest row read; fewer than 5 rows leaves it unchanged | newest 600; jump the cursor to now; timestamp-only cursor; paginate within one run | Cap: 600 rows bounds the size of one reflection prompt; rows beyond it are read in the next pass. The cap is a row count, not a token budget, so whether 600 rows fit depends on line length and the model's context (`llm.num_ctx`) (`reflect-run.ts:19,32`). Cursor: owner decision 2026-11-01, so no memory is skipped permanently; `MEM-REFLECT-008` |
| Cursor timestamp representation | The exact microsecond ISO text Postgres returns (`to_char(ts AT TIME ZONE 'UTC', ...US"Z"')`), compared as `$1::timestamptz` | the JS `Date` of the row's `ts` | A `Date` keeps milliseconds, so the cursor would round down and the newest row read would be read again every pass, inflating the "fewer than 5" count (`MEM-REFLECT-003`) and re-feeding a row to the LLM; `MEM-REFLECT-008` |
| Learned block placement | End of the `## Learned` section | end of file | owner decision 2026-11-01 (low priority: the shipped template ends with `## Learned`); `MEM-REFLECT-007` |
| Pure text helpers split out | `learned.ts` holds bullet parsing and heading logic | inline in reflect.ts | Extracted so the reflection logic could be tested (`reflect.ts` runs at import): commit `95afa19` ("reflection merge logic (extracted from reflect.ts into learned.ts, behaviour unchanged)"), `learned.ts:1` |
| Testable reflection and startup | `runReflect` (`reflect-run.ts`) and `startMemory` (`startup.ts`) take their dependencies as arguments; `reflect.ts` and `index.ts` only wire them | keep the logic at module load | Both entry files run at import, which made the cursor, readiness, retry and subscription behaviour untestable; `MEM-REFLECT-008`, `MEM-HEALTH-007`, `MEM-EVT-001` |
| Startup readiness vs group creation | `ready` is reported right after the subscriptions are started | call `resetGroup` first; raw Redis `XGROUP CREATE`; wait with a timer | `resetGroup` would move a resumed group to `$`, and raw Redis access would bypass the bus; the correct fix is a bus `onReady` hook (open, `MEM-START-005`) |

## Open Questions & Future Decisions

### Resolved
1. The owner's decisions of 2026-11-01 (start mode, dimension mismatch, viewer
   count, Postgres health, startup `degraded`, viewer-upsert failures, reflection
   cursor and placement) are recorded in the Decisions table and the spec lines
   they cite.
2. The viewer notes design (purpose, layers, strength, sensitivity, capture,
   consolidation triggers, delete semantics, owner control) is recorded in Viewer
   notes and the Decisions table. MEM-VIEWER-004 (notes text in `memory.viewer`)
   and MEM-VIEWER-005 (deferred notes writer) are retired by it; their numbers are
   not reused.

### Open (viewer notes, owner decisions needed)
1. **Voice speakers.** Discord voice speakers get no notes; linking a speaker to a
   chat viewer is out of scope.

Settled by the owner and recorded above: categories are `general`, `health` and
`family` plus the politics drop; soft memories are purged after 30 days and
suppression rules kept until restored; "surfaced rarely" means at most once per
note per 24 hours, replied-to viewer only; there is no viewer-initiated forget
command (the owner deletes notes by hand, keeping the "not a command bot"
non-goal); turning "Mark as regular" off returns the viewer to the message-count
rule, with no "never regular" option; the shutdown one-shot is best-effort and
the catch-up pass is the guarantee.

### Deferred (observed, unexplained, or technical debt)
1. **Migrating a table to a new vector dimension.** `MEM-STORE-002` stops startup
   on a mismatch; what an operator does next (re-embed, a table per model, drop and
   start over) is not decided. `dims` is held in memory only (`store.ts:51,69`).
2. **Reflection needs a reachable embedder** because `init()` embeds `"hello"`
   (`store.ts:69`) even though reflect only reads. It also runs without any lock
   alongside the live service.
3. **Two hash embedders.** `fake-store.ts:hashEmbed` and `@cohost/llm` `HashEmbedder`
   differ in tokenisation, sign handling and empty-text output; both 64 dims. The
   fake keeps its own: it is self-contained and its non-negative scores suit
   `min_similarity` (it also predates `HashEmbedder`, commit `719ce5a`).
4. **Kind `note` is declared but never written** (`store.ts:7`).
5. **Recall request validation:** the bus schema makes `k` positive
   (`packages/bus/src/events.ts:108-112`, `k` at 111), so `k=0` can only occur
   through config (`recall_k=0`, where the cortex does not send a request) even
   though the store handles it.
6. **Test gaps.** `index.ts` and `reflect.ts` (wiring only) have no tests;
   `startup.ts` and `reflect-run.ts` are tested with fakes, so no test runs
   against a real Postgres: the `atttypmod` dimension query and the
   `(ts, id)` row comparison are exercised only against recorded SQL.
7. **Consumer-group readiness.** `MEM-START-005` waits on a bus hook that does not
   exist yet.

## References

- Code: `services/memory/src/{index,startup,region,store,cursor,backend,fake-store,reflect,reflect-run,learned,health}.ts`,
  `services/memory/package.json`, `services/memory/tsconfig.json`
- Tests: `services/memory/test/{backend,fake-store,health,memory,region,reflect,startup}.test.ts`
- Parent: [high-level-design](../../high-level-design.md)
- Depends on: event-bus (events `chat.message`, `speech.heard`, `brain.say`,
  `memory.*`, `Bus.subscribe/publish`, start mode `resume`, a future group-ready hook), config
  (`loadConfig`, `urls.database`, `loadPersonality/savePersonality`,
  `brain.memory.*`), model-backends (`Ollama`, `HashEmbedder`, `createChatProvider`),
  region-hooks (`Module` for `memory.capture` and `memory.consolidator`, planned),
  control-plane (heartbeat contract, `startHeartbeat`, `tracked`, manifest start
  mode `resume` and groups `memory`, `memory-recall`, and `memory-notes` once
  capture lands), cortex (`brain.status`, read to pace consolidation)
- Depended on by: cortex (sends `memory.recall.request` and `memory.notes.request`,
  consumes `memory.recall.reply`, `memory.notes.reply` and `memory.viewer`),
  dashboard (test injection of chat and speech reaches memory with
  `injected`/`remember` flags; Viewers page through `memory.viewers.*`),
  deployment (compose service `memory`, reflect and consolidate invocation, the
  notes model pull)
- External: PostgreSQL with the pgvector extension (`pg` ^8.13), Ollama embeddings, Redis streams
- OpenSpec: `openspec/specs/memory/spec.md`; deltas
  `openspec/changes/archive/2026-11-01-add-service-health/specs/memory/spec.md`,
  `openspec/changes/archive/2026-11-01-add-isolated-backends/specs/memory/spec.md`,
  `openspec/changes/archive/2026-11-01-add-test-injection/specs/memory/spec.md`
