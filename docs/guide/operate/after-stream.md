---
title: After a stream
description: Wrap up a stream the tidy way, with a reflection pass that lets the co-host learn from the show and an optional consolidation pass over its viewer notes.
track: simple
verified: f126b94
---

# After a stream

When the stream ends you do not have to do anything but press Stop. Two optional jobs make the next stream better: the **reflection pass**, where the co-host writes down what it learned, and the **consolidation pass**, which tidies its notes about viewers. This page shows both, and when to skip them.

## What you need

- A co-host that ran for a while with real [memory](../tune/memory.md). In [mock mode](../../start/glossary.md#mock-mode) the memory is not kept, so the passes have nothing to work on.
- The stack still up for the reflection pass. A [Stop](start-stop.md) comes before the consolidation pass.

## The reflection pass

Reflection lets the co-host update its own [personality file](../tune/personality.md). It reads what was said since the last reflection (up to 600 memories, oldest first), asks the [language model](../../start/glossary.md#llm) for three to six short bullet points about what it learned, and adds them under a dated heading in the file's `## Learned` section.

Run it while the stack is up:

```bash
docker compose run --rm memory node services/memory/dist/reflect.js
```

If you run services on the host rather than in [containers](../../start/glossary.md#container), `pnpm reflect` does the same. The first command uses [Docker](../../start/glossary.md#docker) to run the memory image once.

The pass is careful about when to do nothing:

- With fewer than 5 new memories it does nothing and tries again next time with the new ones included.
- If the model's answer holds no bullet points, it does nothing and reports so.
- If another memory job is running, it does nothing and leaves your place marked for next time.
- With the in-memory store used by mock mode it does nothing, because the memories are already gone.

When it works, it prints the bullets it added. Open `config/personality.md` and read them. **Edit or delete anything you do not like.** It is only a file, and what is left is what the co-host acts on next time.

::: aside
I write notes to myself after every show. Last week's said "Chris, stop dying to the same door." You can delete that. It will be true again.
:::

Reflection uses the same model as the [cortex](../../start/glossary.md#cortex), so it counts toward a hosted model's bill; see [Choose a model](../tune/model.md).

## The consolidation pass

While the co-host runs, it jots short notes about viewers and lets them fade. The consolidation pass tidies them: it merges duplicates, fixes wording, rechecks whether a note is sensitive, promotes notes that kept coming up and drops ones that faded away.

It is optional. The memory service starts one on its own when 20 notes are waiting (the `dirty_threshold`) and the co-host is idle, and it catches up at its next start anyway, so skipping it loses nothing.

Run it after Stop by whichever route you like:

- On the dashboard's **Services** screen, press **Run consolidation pass** (it appears after a successful Stop) and confirm.
- From a terminal:

  ```bash
  pnpm cohostctl consolidate
  ```

- Or with Docker directly:

  ```bash
  docker compose run --rm consolidate
  ```

It starts the database and [Ollama](../../start/glossary.md#ollama) if they are down and leaves them running. It can take up to half an hour when there is a lot to tidy; the terminal command exits 0 when it is done and 1 if it failed.

## Look at what it learned

Two places show what the co-host kept:

- The **Viewers** screen on the dashboard lists each viewer's notes. Delete or correct any you disagree with. See [Memory and viewer notes](../tune/memory.md).
- The `## Learned` section of `config/personality.md` holds the bullets from reflection.

## How you know it worked

- Reflection printed its bullets, and `config/personality.md` has a new dated block under `## Learned`.
- Consolidation finished with exit code 0, or the dashboard stack panel shows `consolidate: ok`.

## If it didn't

- Reflection says it did nothing: that is usually the rule about fewer than 5 new memories. Run a longer stream first.
- The command cannot connect to the database: the stack is not up. See [Starting and stopping](start-stop.md).
- Anything else: [Troubleshooting](../troubleshooting.md).
