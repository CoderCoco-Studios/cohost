---
title: Dashboard tour
description: A tab-by-tab tour of the cohost dashboard, the web page where you watch, steer and test your co-host.
track: simple
verified: f126b94
glossary-skip: [affect]
---

# Dashboard tour

The dashboard is a web page that runs on your own PC. It is where you watch what the co-host is thinking, make it say things, start and stop the whole system, tune its settings and look at what it remembers. This page walks through every part of it.

## What you need

- A running dashboard. If you followed [Try it with no accounts](../install/first-run.md) or [Install for real](../install/real-install.md), you started it with `pnpm dashboard`.
- A browser pointed at `http://localhost:3000`. If a page asks for a token, it is the `CONTROL_TOKEN` line in your `.env` file.

## Open it

```bash
pnpm dashboard
```

Then visit `http://localhost:3000`. (The number is `DASHBOARD_PORT` in `.env`; the startup log prints the address it actually uses.) The dashboard listens only on your own PC by default. It is separate from the other pieces of cohost, which run in [containers](../../start/glossary.md#container); the dashboard sits outside them and starts them for you.

## The header

The strip across the top is the same on every tab.

| Item | What it tells you |
| --- | --- |
| The status pill | What the co-host is doing: `idle`, `thinking`, `speaking` or `muted`. It says `connecting` until the page reaches the dashboard. |
| `avatar:` pill | Which avatar driver is in use, or none. |
| `stack:` pill | The state of the whole system: `up`, `starting`, `stopping`, `degraded`, `down` or `docker unavailable`. |
| Tabs | **live**, **services**, **viewers** and **settings**. The services tab shows a count, such as `services (2)`, when something needs attention. |
| **enable audio** | The dashboard page can play the co-host's voice. Browsers insist you press this once. |
| **mute** | Silences the co-host. Press again to unmute. |

## The live tab

Where you spend a stream.

**Left column**

- The [bus](../../start/glossary.md#bus) panel shows every [event](../../start/glossary.md#event) passing between the parts of the co-host: chat lines, things heard, replies, moods, voice. It is the quickest way to see what is going on. It scrolls fast, so do not be alarmed.
- **say something** speaks a line you type, as the co-host. The optional **route** box names which outputs get the audio (blank means every enabled output). **wipe context** makes the co-host forget what it is currently holding in mind, without touching its stored memories.
- **test inputs** feeds the co-host fake input without any account. Type a fake viewer message, choose a name and platform, and tick **mod** or **sub** to pretend the viewer is one. **level** picks how deep it goes in: `service` runs it through the real pipeline, `bus` skips the listening and seeing stage and lands straight in the brain (and then **as** picks chat, speech or vision). **store in memory** off makes the memory part ignore the input and any reply to it. You can also send an image or an audio clip. Everything you send here is treated as real by the brain and may be spoken aloud.

**Right column**

- **avatar preview** is a simple face that follows the co-host's current emotion, so you can see mood changes without an avatar app.
- **personality.md** is an editor for the co-host's [personality file](../tune/personality.md). Press **save & reload** to apply.

## The services tab

The control room. The top panel, **stack**, appears when the dashboard's controls are on (they are by default) and holds the whole-system buttons:

| Button | What it does |
| --- | --- |
| **Launch** | Builds anything that changed, starts every container and waits until they are ready. |
| **Rebuild** | The same as Launch. Both rebuild the images from the current code. |
| **Stop** | Stops every container. Nothing is deleted. |
| **Restart all** | Restarts every running co-host service. |
| **Run consolidation pass** | Appears after a successful Stop. Tidies the viewer notes; optional. See [After a stream](after-stream.md). |

Each asks you to confirm. While one runs, the others are greyed out, and the panel shows the phase and elapsed time and, afterwards, how it ended.

Below it, a table lists every service with its state, mode, dependencies, when it was last heard from, restart count and a detail note. [Service health](health.md) explains how to read every column. When the controls are on, each row also has Start, Stop and Restart buttons, a **test** button that opens a panel for feeding just that service, and, for the three brain parts that can be paused, **pause** and **resume**. Two options above the table affect starts: **start mode** (resume keeps the backlog of events; fresh skips it) and **isolated**, which starts only that service with pretend backends. [Starting and stopping](start-stop.md) goes into detail.

## The viewers tab

Everything the co-host remembers about people, one viewer at a time: their notes, a regular flag, and the buttons to delete, undo and clear. It is locked until you set `VIEWERS_TOKEN`. See [Memory and viewer notes](../tune/memory.md).

## The settings tab

A form for `config/config.yaml`. Pick a section from the list, change values, press **Validate** to check them and **Save** to write them. It keeps your comments and unknown keys, never shows secrets (those stay in `.env`), and refuses to save if the file changed since you loaded it (press **Reload section**). Settings apply when the services that read them restart, and after a save the page offers to restart them. Every key is explained on the [configuration reference](../../advanced/reference/config.md).

## The sink page

The dashboard has a second face for streaming: the same address with `?sink=1` on the end shows only the audio, with every other tab hidden. That is the page [OBS](../../start/glossary.md#obs) plays on stream. It is covered on [OBS and the voice on stream](../connect/obs.md).

::: aside
The dashboard has a lot of buttons. Only one of them says **mute**. Learn where it is before you go live.
:::

## How you know it worked

- The header shows the status pill and a `stack:` pill, and the **bus** feed scrolls.
- Typing a line into **say something** and pressing **say** makes the co-host speak it (after you press **enable audio**).

## If it didn't

- The page does not load, or the pill stays on `connecting`: the dashboard is not running. Start it again with `pnpm dashboard`.
- The stack panel is missing: stack controls are off. Check that `CONTROL_ENABLED=1` is set in `.env`, and see [Troubleshooting](../troubleshooting.md).
- Buttons ask for a token you do not know: it is the `CONTROL_TOKEN` in `.env`.
- No sound: press **enable audio** first, and see [Troubleshooting](../troubleshooting.md).
