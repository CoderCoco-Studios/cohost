---
title: Memory and viewer notes
description: What the co-host remembers, how it tells regulars from first-timers, how its short fading notes about viewers work, and how to see, correct and delete them.
track: simple
verified: f126b94
---

# Memory and viewer notes

The co-host remembers. It recalls things people said earlier, it knows regulars from first-timers, and it keeps short notes about individual viewers ("plays the cello", "asked about the new patch"). This page explains what is kept, where, and how you stay in charge of it.

## What you need

- A running co-host. [Install for real](../install/real-install.md) sets up the database that keeps memory. In [mock mode](../../start/glossary.md#mock-mode) memory lives in the computer's RAM and is lost when you stop.
- For the Viewers page: the dashboard's `CONTROL_TOKEN` in `.env`, which the installer writes (see below).

## What it remembers

The memory part of the co-host is the only part that touches the database, a [Postgres](../../start/glossary.md#postgres) server with the [pgvector](../../start/glossary.md#pgvector) add-on. It stores:

- every chat message that addresses the co-host,
- everything said in voice,
- everything the co-host says itself.

Each one is turned into a list of numbers that captures its meaning, called an [embedding](../../start/glossary.md#embedding), made by a small model running on [Ollama](../../start/glossary.md#ollama) (`nomic-embed-text` by default). Before each reply the [cortex](../../start/glossary.md#cortex) asks memory for the `recall_k` (6) stored memories most similar to what is going on, and weaves them into the prompt. If memory is slow or down (more than `brain.cortex.recall_timeout_ms`, 2500, so two and a half seconds), the co-host just answers without them.

Memory also keeps a row per viewer with a message count, so the co-host can tell regulars from newcomers. A viewer is a regular once they pass `regular_messages` (25) lifetime messages, and you can mark someone as a regular yourself, even before they have chatted.

The embeddings always come from local Ollama, whichever model writes the replies, so memory never has to be rebuilt when you [choose another model](model.md).

## Viewer notes

On top of that the co-host keeps short, fading notes about each viewer. They work like a human's memory of a stranger:

- A note starts **recent** and fades. A recent note loses half its strength every 7 days (`recent_half_life_days`).
- Mentioned again, it gets stronger. After 3 mentions (`promote_mentions`) it becomes **core**, which fades more slowly (60-day half life).
- A core note that fades below 0.3 falls back to recent, and a recent note below 0.1 is forgotten.
- Each note has a category: `general`, `health` or `family`. Health and family notes carry a handling hint ("only if they bring it up; never quote it" for health) and are brought up at most once a day (`sensitive_cooldown_hours`, 24).
- The co-host is shown at most 5 notes per viewer and 15 in all, so the prompt stays short.

Two things it never stores as a note: a viewer's political views and their money or spending. A subscriber is kept as a flag on the viewer, not as a note.

A very small model reads each chat line and decides whether it holds a note worth keeping. By default that is the model named by `brain.memory.notes.capture.llm.model` in `config/config.yaml` (`gemma3:4b`), served by your own Ollama (`brain.memory.notes.capture.llm.provider: ollama`), separate from the model that writes replies, so chat lines and health or family notes stay on your own machine. A second pass, the consolidation, tidies new notes later: merging duplicates, fixing wording and rechecking sensitivity. [After a stream](../operate/after-stream.md) covers it.

## See and edit notes: the Viewers screen

Open the dashboard's **Viewers** screen. The left side lists every viewer, with a search box. Select one to see their notes, shown in **Core**, **Recent** and **Deleted notes** groups, each note with its category and a strength meter.

| You want to | Do this |
| --- | --- |
| Remove a note | Press **Delete** beside it. You are asked for an optional reason. |
| Bring a deleted note back | Press **Undo** beside it under **Deleted notes**. |
| Wipe everything about someone | Press **Clear all notes**. |
| Mark someone as a regular | Switch on **Always a regular**, or type their name into the box above the list and press **Mark regular**. |
| Join a voice-channel speaker to their chat account | Press **Link to a chat viewer** on a viewer heard in the voice channel. |

**Give a reason when you delete.** A deletion with a reason stops the co-host from learning similar notes about that viewer again. A deletion without one is forgotten after 30 days, and if the viewer keeps raising the topic it can come back, weakly.

### Unlock the screen

Notes can include health and family details, so the screen needs the dashboard's one token, `CONTROL_TOKEN`, like every other control. A browser you unlocked with the unlock link the dashboard prints in its terminal opens the Viewers screen without asking; otherwise the Access dialog asks for the token (it stays unlocked for this tab, or for this browser if you choose that). Notes never travel on the live feed, and every viewers request needs the token or the unlocked browser's cookie.

If the dashboard has no `CONTROL_TOKEN` (the installer writes one), the screen stays locked. Add one:

```bash
echo "CONTROL_TOKEN=$(openssl rand -hex 24)" >> .env
```

Then restart the dashboard and open the unlock link it prints. The token is sent over plain HTTP, so keep the dashboard on a trusted network, as the [Install for real](../install/real-install.md) page advises.

::: aside
I do like knowing my regulars. I do not enjoy being asked to forget them. But yes, the delete button is there, and it works.
:::

## Forgetting

- **A note:** delete it on the Viewers screen, as above.
- **Everything about a viewer:** **Clear all notes**.
- **The current conversation only:** the **Wipe context** button on the **Live** screen clears what the co-host is holding in mind right now. It does not delete stored memories or notes.
- **The reflection notes in the personality file:** edit the `## Learned` block of [the personality file](personality.md).
- **Everything:** stop the stack and remove the database's volume with [Docker](../../start/glossary.md#docker). That is a deliberate, destructive step: it deletes every stored message, memory and note.

  ```bash
  docker compose down
  docker volume rm <project>_pg18-data
  ```

  `<project>` is the [Compose](../../start/glossary.md#docker-compose) project name, which is the name of the folder the repository is in (run `docker volume ls` to see the exact name). The next launch creates an empty database. A volume named `<project>_pg-data` belongs to an older Postgres version and is not used; remove it by hand with `docker volume rm <project>_pg-data`.

## Changing the embedding model

If you switch the embedding model to one with a different vector size, the memory service refuses to start, because stored vectors no longer fit. Stop memory, then run the re-embed one-shot from [Starting and stopping](../operate/start-stop.md). Keeping the default avoids all this.

## How you know it worked

- After a few chat messages, the viewer shows up on the **Viewers** screen with a message count.
- After a note-worthy chat line (for example, "I play the cello") the viewer gains a note, which can take a moment while the notes model works.
- Once a viewer passes the regular threshold, or you mark them, the Viewers screen lists them as a regular and the co-host is told so.

## If it didn't

- The Viewers screen says it is not set up or answers 403: set `CONTROL_TOKEN` and restart the dashboard.
- No notes ever appear: the notes model may not have downloaded. A failed download of the model named by `brain.memory.notes.capture.llm.model` is only a warning, and capture then writes no notes. See [Troubleshooting](../troubleshooting.md).
- The memory service will not start after you changed the embedder: see "Changing the embedding model" above.
