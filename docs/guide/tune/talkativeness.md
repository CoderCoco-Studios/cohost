---
title: When it talks
description: Control how often the co-host speaks up, when it stays quiet, when it chimes in unprompted, and how to give it instant canned reactions.
track: simple
verified: f126b94
---

# When the co-host talks

The co-host does not answer every chat message. A part called [salience](../../start/glossary.md#salience) scores what is going on and decides whether it is worth speaking. This page shows the dials that change that decision, and the [reflexes](../../start/glossary.md#reflex) that skip the decision entirely.

## What you need

- A running co-host. Start with [Try it with no accounts](../install/first-run.md) if you have not yet.
- A text editor, or the dashboard's **Settings** screen. The [dashboard tour](../operate/dashboard.md) shows the screen.

## How it decides

Salience gives each new thing a score. The bigger the score, the more it wants to answer.

| What happened | Score |
| --- | --- |
| Someone said the co-host's name | 1.0 |
| Someone spoke in voice | 0.9 |
| A chat message with a question mark | 0.55 |
| A message from a moderator or subscriber | 0.35 |
| The screen changed | 0.3 |
| Plain chat | 0.15 |

The scores add up as unanswered things pile up. The co-host speaks when the total reaches `speak_threshold` (0.6). So a mention of its name always gets a reply, but a lone "lol" never does, and a few plain chat lines in a row eventually might.

Even then it stays polite:

- It never speaks within `cooldown_ms` (6000, so six seconds) of its last line.
- It never talks while it is still thinking or while its voice is still playing.
- After `idle_chatter_ms` (90000, a minute and a half) of quiet it may pipe up on its own, but only if something new has happened that it has not reacted to. A completely silent stream stays silent.
- An excited [mood](mood.md) lowers the threshold by up to `arousal_bias` (0.2), so a buzzing co-host is chattier.

Salience decides the moment a finished line of speech arrives (`trigger_on_speech` is on by default) and otherwise checks every `tick_ms` (1500).

## Change the dials

All of these live under `brain.salience` in `config/config.yaml`. The dashboard's **Settings** screen edits the same file: pick the section, change a value, press **Check**, then **Save**. It keeps your comments and never shows a saved secret. Settings apply when the services that read them restart, and after a save the page offers to restart them.

| You want | Change |
| --- | --- |
| A quieter co-host | Raise `speak_threshold` (try 0.8) or `cooldown_ms`. |
| A chattier co-host | Lower `speak_threshold` (try 0.4) or `idle_chatter_ms`. |
| No unprompted chatter | Set `idle_chatter_ms` very high, such as 3600000 (an hour). |
| No automatic reply to its name | Set `reply_on_mention` to `false`. |

::: aside
Silence is a feature. The best co-hosts know when you are mid-clutch and say nothing. I am working on it. Mostly.
:::

Every key is listed in the [configuration reference](../../advanced/reference/config.md).

## Interrupting

With `barge_in: true` (off by default, because it has not been tried live yet), someone speaking over the co-host stops its voice mid-line and the co-host answers the interrupter. Only speech from the sources in `barge_in_sources` (by default `discord`) counts, and only lines of at least `barge_in_min_words` words (default 2), so "mm-hm" does not cut it off. Lines a reflex said are never interrupted.

A source that can hear the co-host's own voice, such as a capture of your desktop sound, would otherwise make the co-host answer itself. That source is deaf while a line plays and for `ears.echo_tail_ms` afterwards (1500). `ears.echo_suppress_sources` lists those sources (default `desktop`). Discord already filters the bot's own audio.

## Reflexes

A reflex is a reaction that skips the thinking. You give it a pattern to look for and some lines to say. When an [event](../../start/glossary.md#event) matches, the co-host says one of the lines instantly, with no language model in the loop. That suits things that should get a reaction before anyone has time to think: a death on screen, a raid.

Each rule is an entry in `brain.salience.reflexes`:

```yaml
brain:
  salience:
    reflexes:
      - match: "\\b(you died|game over|wasted)\\b"
        on: [vision]
        say: ["Oof.", "Welp.", "That one hurt."]
        emotion: surprised
        cooldown_ms: 45000
      - match: "\\braid\\b"
        on: [chat]
        say: ["Oh hey, welcome in everyone!"]
        emotion: happy
        cooldown_ms: 120000
```

| Key | Meaning |
| --- | --- |
| `match` | A case-insensitive pattern (a regular expression). Backslashes are doubled in YAML. |
| `on` | Which senses to look at: `chat`, `speech` or `vision`. |
| `say` | Lines to choose from at random. |
| `emotion` | The face to wear while saying it. |
| `cooldown_ms` | How long this rule waits before it can fire again. Each rule has its own. |

The `vision` sense needs the screenshot sense running; the [OBS page](../connect/obs.md) sets it up. Without it, only chat and speech can trigger a reflex.

## How you know it worked

- Send a chat line that mentions the co-host's name using **Test inputs** on the dashboard's Live screen. It should answer within a few seconds.
- For a reflex, send a line that matches. The co-host answers with one of your lines at once.
- The [bus](../../start/glossary.md#bus) **Activity** feed on the **Live** screen shows an `attention.focus` event each time salience decides to speak.

## If it didn't

- Nothing happens at all: check that `salience` is `up` on the [service health page](../operate/health.md).
- A change did not apply: settings apply when the service restarts. See [Starting and stopping](../operate/start-stop.md).
- A reflex never fires: the pattern probably has a typo or the wrong `on` sense. See [Troubleshooting](../troubleshooting.md).
