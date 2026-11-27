---
title: Personality
description: Write who your co-host is in one plain text document, edit it from the dashboard or a terminal, and learn what the Learned section is.
track: simple
verified: a86e930
---

# Personality

Your co-host is whoever its personality says it is. The personality is one plain text document (Markdown) kept in the settings store; you can edit it in the dashboard while the stream runs, and the co-host picks up the change without a restart.

## What you need

- A running co-host: [Try it with no accounts](../install/first-run.md) or [Install for real](../install/real-install.md).
- The dashboard open in your browser (`http://localhost:3000`). The [dashboard tour](../operate/dashboard.md) shows where everything is.

## Where it lives

The personality lives in the [settings store](../operate/settings.md#where-your-settings-live), with every other setting. When the installer creates the store, it starts the personality from the committed example, `config/personality.example.md`. From then on the personality is yours: pulling new code never changes it, and editing the example changes nothing.

Edit it on the dashboard, or from a terminal (both below). The example is a good map of what goes in:

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
- **Keep it short.** The whole text travels with every request to the [language model](../../start/glossary.md#llm) that writes the replies, so a long personality costs time and leaves less room for the conversation.

::: aside
Give me a flaw or two. "Occasionally wrong and cheerful about it" is a much better character than "flawless". I would know.
:::

The co-host's name and yours come from the settings `cohost.name` and `cohost.streamer` (the **Identity** section of the Settings screen), not from the personality. The prompt carries them for you.

## Edit it from the dashboard

1. Open the dashboard's **Settings** screen and choose **Personality**, the first entry under **Identity**. It shows the personality as it is now.
2. Change the text.
3. Press **Save** (or Ctrl+S in the editor).

If the dashboard asks for a token in the Access dialog, it is the control token you keep in your password manager, or open the unlock link the dashboard prints. Saving stores the text and tells the [cortex](../../start/glossary.md#cortex), the part that writes replies, to read it again before its next reply.

## Edit it from a terminal

```bash
mise run config:personality
mise run config:personality -- --edit
```

The first prints the personality. The second opens it in your `$EDITOR` and stores it when you save and close the editor. The cortex reads text stored this way at its next start, so restart it afterwards (the [Starting and stopping](../operate/start-stop.md) page shows how). A restart from the dashboard or `cohostctl` writes the cortex's settings for it first; a hand-run `docker compose restart cortex` does not, so run `mise run config:project` before it (and `mise run deliver` after it, unless the dashboard is running to deliver its credentials).

## The Learned section

At the end of the personality is `## Learned`. After a stream you can run a reflection pass that reads what the co-host heard and said, asks the language model for three to six short bullet points about what it learned, and adds them under a dated heading such as `### 2026-11-15`. Next time the co-host reads its personality, those bullets are part of it.

You are in charge of that section: delete lines you do not like, rewrite the ones that are almost right, or empty it, in the dashboard's editor or with `mise run config:personality -- --edit`. It is just text. If you edit the personality while a reflection pass is running, your edit wins and that pass's bullets are not stored. [After a stream](../operate/after-stream.md) shows how to run the pass and why you might skip it.

## How you know it worked

- After **Save** the co-host's next lines follow the new instructions. Try it with the **Say a line** and **Test inputs** cards on the **Live** screen, described in the [dashboard tour](../operate/dashboard.md).
- `mise run config:personality` prints your change.

## If it didn't

- The save is refused: this browser is locked or the token is wrong. Enter the control token from your password manager, or open the unlock link. See [The control token and the unlock link](../operate/settings.md#the-control-token-and-the-unlock-link).
- The co-host sounds the same: the cortex may not be running. Check the [service health page](../operate/health.md).
- The co-host says the emotion tags aloud or its face never changes: the `## Format` section was changed or removed. Put it back from the committed example, `config/personality.example.md`.
