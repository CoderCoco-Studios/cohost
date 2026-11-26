---
title: Personality
description: Write who your co-host is in one plain text file, edit it from the dashboard, and learn what the Learned section is.
track: simple
verified: f126b94
---

# Personality

Your co-host is whoever `config/personality.md` says it is. It is one plain text file, you can edit it in the dashboard while the stream runs, and the co-host picks up the change without a restart.

## What you need

- A running co-host: [Try it with no accounts](../install/first-run.md) or [Install for real](../install/real-install.md).
- The dashboard open in your browser (`http://localhost:3000`). The [dashboard tour](../operate/dashboard.md) shows where everything is.

## Where the file lives

The installer copies `config/personality.example.md` to `config/personality.md` the first time it runs. The copy is yours: git ignores it, so pulling new code never overwrites it. If the file goes missing, a service that needs it copies the example again when it starts.

Open it in any text editor, or use the editor on the dashboard. The example is a good map of what goes in:

| Section | What it is for |
| --- | --- |
| The opening paragraph | Who the co-host is and who it is talking with. |
| `## Voice` | How it sounds: casual or formal, short lines, whether it uses your viewers' names. |
| `## Rules` | Things it must never do, and when to stay quiet. |
| `## Format` | The emotion tag it starts each line with, such as `[smug]` or `[laugh]`. The [avatar](../connect/avatar.md) uses the tag to pick a face. |
| `## Learned` | Notes the co-host writes about itself after a stream. See below. |

A few habits that work well:

- **Write short lines on purpose.** The words are read aloud by a [text-to-speech](../../start/glossary.md#tts) voice, so one or two sentences with no lists and no emoji sound best.
- **Say what to do, not only what to avoid.** "Dry humour over slapstick" steers better than a page of "don't".
- **Keep the `## Format` section.** The emotion tags are how the co-host's face follows what it says.
- **Keep it short.** The whole file travels with every request to the [language model](../../start/glossary.md#llm) that writes the replies, so a long file costs time and leaves less room for the conversation.

::: aside
Give me a flaw or two. "Occasionally wrong and cheerful about it" is a much better character than "flawless". I would know.
:::

The co-host's name and yours come from `cohost.name` and `cohost.streamer` in `config/config.yaml`, not from this file. The prompt carries them for you.

## Edit it from the dashboard

1. Open the dashboard's **Settings** screen and choose **Personality**, the first entry under **Identity**. It shows the file as it is now.
2. Change the text.
3. Press **Save** (or Ctrl+S in the editor).

On the dashboard's own PC the save needs no token. From another machine the Access dialog asks for one: it is the `CONTROL_TOKEN` from your `.env` file. Saving writes the file and tells the [cortex](../../start/glossary.md#cortex), the part that writes replies, to read it again before its next reply.

If you edit the file in a text editor instead, restart the cortex so it reads the new text (the [Starting and stopping](../operate/start-stop.md) page shows how).

## The Learned section

At the bottom of the file is `## Learned`. After a stream you can run a reflection pass that reads what the co-host heard and said, asks the language model for three to six short bullet points about what it learned, and adds them under a dated heading such as `### 2026-11-15`. Next time the co-host reads its personality, those bullets are part of it.

You are in charge of that section: delete lines you do not like, rewrite the ones that are almost right, or empty it. It is just text. [After a stream](../operate/after-stream.md) shows how to run the pass and why you might skip it.

## How you know it worked

- After **Save** the co-host's next lines follow the new instructions. Try it with the **Say a line** and **Test inputs** cards on the **Live** screen, described in the [dashboard tour](../operate/dashboard.md).
- Opening the file in a text editor shows your change.

## If it didn't

- The save is refused from another machine: the `CONTROL_TOKEN` you entered is wrong, or `.env` has none. Check `.env`. See [Troubleshooting](../troubleshooting.md).
- The co-host sounds the same: the cortex may not be running. Check the [service health page](../operate/health.md).
- The co-host says the emotion tags aloud or its face never changes: the `## Format` section was changed or removed. Put it back from `config/personality.example.md`.
