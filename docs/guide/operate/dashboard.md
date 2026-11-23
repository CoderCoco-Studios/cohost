---
title: Dashboard tour
description: A screen-by-screen tour of the cohost dashboard, the web page where you watch, steer and test your co-host.
track: simple
verified: 11075e1
glossary-skip: [affect]
---

# Dashboard tour

The dashboard is a web page that runs on your own PC. It is where you watch what the co-host is thinking, make it say things, start and stop the whole system, tune its settings and look at what it remembers. This page walks through every part of it.

## What you need

- A running dashboard. If you followed [Try it with no accounts](../install/first-run.md) or [Install for real](../install/real-install.md), you started it with `pnpm dashboard`.
- A browser pointed at `http://localhost:3000` (the port is `dashboard.port` in `config/config.yaml`).
- Your control token, for anything that changes something. The dashboard asks for it in the [Access dialog](#the-access-dialog) the first time you need it.

## Open it

```bash
pnpm dashboard
```

`pnpm dashboard` builds the page before it starts. If the page's build fails, it prints the error and stops without starting the dashboard, so you never get an old or missing page; fix the error it printed and run it again. (A failed build of the documentation alone does not stop it.)

Then visit `http://localhost:3000`. (The number is `dashboard.port` in `config/config.yaml`; the startup log prints the address it actually uses.) The dashboard listens only on your own PC by default. It is separate from the other pieces of cohost, which run in [containers](../../start/glossary.md#container); the dashboard sits outside them and starts them for you.

The address after the `#` picks the screen: `#live`, `#services`, `#viewers`, `#settings` and `#settings/<section>`. The browser's back and forward buttons move between screens, and you can bookmark any of them.

## The header

The strip across the top is the same on every screen. On a narrow window the navigation drops to its own row.

| Item | What it tells you |
| --- | --- |
| Name and `cohost` | The co-host's name (`cohost.name`) beside the product name. |
| Navigation | **Live**, **Services**, **Viewers** and **Settings**; the one you are on is marked as current. **Services** shows a count, such as `2`, when services are down, crash-looping or stale. |
| **Docs** | Last in the navigation, with an arrow-out icon. It opens, in a new tab, the documentation your dashboard serves at `/cohost/`: the same pages you are reading now, built from the copy of cohost on your PC, so they match the version you run and work offline. It is not shown on the [sink](../../start/glossary.md#sink) page. |
| Co-host status | What the co-host is doing: `Idle`, `Thinking`, `Speaking` or `Muted`, with a shape as well as a colour. It reads `Waiting for the co-host` until the first status arrives. |
| Stack status | `Stack: Up`, `Starting`, `Stopping`, `Degraded`, `Down` or `Docker unavailable`. |
| **Audio on** / **Audio off** | Whether this browser tab plays the co-host's voice. Browsers insist you press it once; the OBS sink page turns it on by itself. |
| **Mute co-host** / **Unmute co-host** | Silences the co-host, or lets it speak again. There is one Mute button, here, on every screen. After it works the header says `Muted`. |
| **Locked** / **Unlocked** | Whether this page holds your control token. It opens the [Access panel](#the-access-dialog). |
| **Theme** | **Auto** follows your system's light or dark setting; **Light** and **Dark** override it. Your choice other than Auto is remembered in this browser. |

If the connection to the dashboard drops, a banner says that live updates stopped and when the next attempt is; the page reconnects by itself every two seconds, and the lists and feeds are dimmed until it does.

## The Access dialog

Anything that changes something needs your control token. When you press a button that needs it, a dialog opens naming what is waiting ("Restart voice", say), and the action runs once the token is accepted. Cancelling does nothing and the control reports `not done: locked`. You can also press **Locked** or **Unlocked** in the header to see both tokens at any time.

| Token | Where it comes from | What it unlocks |
| --- | --- | --- |
| Control token (`CONTROL_TOKEN`) | The installer generated it into `.env`. In the cohost folder, `grep ^CONTROL_TOKEN= .env` prints the line; paste the value after the equals sign. | Muting, saying lines, saving settings, saving secrets, test inputs and controlling services. |
| Viewers token (`VIEWERS_TOKEN`) | The installer does not generate it. Add one with `echo "VIEWERS_TOKEN=$(openssl rand -hex 24)" >> .env`, then restart the dashboard. | Reading and editing viewer notes on the Viewers screen. |

The dialog has a masked field with **Show**, **Hide** and **Paste** buttons, and a **Copy** button for the command. The token is checked with the dashboard before it is kept; a wrong one is refused and the dialog says what to check (the whole value after the name, with no spaces or quotes, and a restart of the dashboard if `.env` changed after it started). **Stay unlocked** chooses **This tab** (the default; forgotten when the tab closes) or **This browser** (kept until you lock it). In the Access panel, **Change token** replaces a token and **Lock** forgets it. Both tokens are read from `.env` once when the dashboard starts, so a change there takes effect after you restart the dashboard.

## The Live screen

Where you spend a stream.

- **Say a line** speaks a line you type, as the co-host. **Send to specific outputs** opens the **Outputs** box, which names which outputs get the audio (`discord`, `dryrun`, `file`, `http`, separated by commas; blank means every enabled output). The card warns you when the co-host is muted, when audio is off in this tab and when the bus is unreachable.
- **Activity** shows every [event](../../start/glossary.md#event) passing on the [bus](../../start/glossary.md#bus) between the parts of the co-host: chat lines, things heard, replies, moods, voice. Filter it by **All**, **Conversation**, **Vision** or **System**. It keeps the last 300 rows and shows times in your local time. It follows the newest row until you scroll up; **Jump to latest** brings you back. It is the quickest way to see what is going on.
- **Avatar** is a simple face that follows the co-host's current emotion, with the driver's name and whether it is connected, so you can see mood changes without an avatar app.
- **Test inputs** feeds the co-host fake input without any account. Choose **Text**, **Image** or **Audio**. For text, type a fake viewer message, choose a viewer name and platform, and switch on **Moderator** or **Subscriber** to pretend the viewer is one. For an image, pick a PNG, JPEG or WebP file; for audio, pick a clip or, where your browser allows it, **Record from microphone**. **Store in memory** is off by default: it makes the memory part ignore the input and any reply to it. Press **Send**; the line under the button shows the service's answer. Everything you send here is treated as real by the brain and may be spoken aloud. Under **Advanced: skip perception and publish straight to the bus**, **Bus only** skips the listening and seeing stage and lands straight in the brain (then **Publish as** picks chat, speech or vision); image and audio need the real pipeline.
- **Wipe context** makes the co-host forget the conversation it is holding in mind, after you confirm. Viewer notes are kept.

## The Services screen

The control room. The top card, **Stack**, shows the state of the whole system in words. Where the dashboard's controls are on (they are by default) it holds the whole-system buttons:

| Button | What it does |
| --- | --- |
| **Launch** | Shown while the stack is down. Builds anything that changed, starts every container and waits until they are ready. |
| **Restart all** | Restarts every running co-host service. |
| **Rebuild** | Rebuilds the images from the current code, then brings the stack up. |
| **Stop stack** | Stops every container. Nothing is deleted. |
| **Run consolidation pass** | Appears after a successful stop. Tidies the viewer notes; optional. See [After a stream](after-stream.md). |

Each asks you to confirm. While one runs, the buttons are disabled and the card shows the phase and elapsed time and, afterwards, how it ended. With the controls off the card says so and tells you to set `CONTROL_ENABLED=1` in `.env`, or use `cohostctl` on the PC.

Below it, a table lists every service with its state, a one-sentence **Why**, when it was **Last seen** and its actions; services that are down, crash-looping or stale come first. Above the table, **How to read these states** opens [Service health](health.md) in a new tab, at the table of states. When you open Service health from the dashboard's own **Docs** link, it also shows a small Live screenle of your services. Each row that is a cohost service has a **Test** button, whether the controls are on or not; when they are on it also has **Start**, **Restart** and **Stop** buttons and, for the brain parts that can be paused, **Pause** and **Resume**. **Start** and **Restart** open a dialog with a **start mode** (service default, resume keeping the backlog of events, or fresh skipping it) and an **Isolated** switch, which starts only that service with pretend backends. **Test** opens a side panel for feeding just that service one input, starting it isolated, and watching the events it reacts to. [Starting and stopping](start-stop.md) goes into detail.

## The Viewers screen

Everything the co-host remembers about people, one viewer at a time: pick someone from the list (or search by name) to see their core and recent notes with how strong each memory is, a **Always a regular** switch, and the buttons to **Delete** a note, **Undo** a deletion and **Clear all notes**. **Mark regular** at the top marks a name as a regular before they have chatted. It is locked until you set `VIEWERS_TOKEN`: until then the screen shows three setup steps and **Check again**. See [Memory and viewer notes](../tune/memory.md).

## The Settings screen

A form for `config/config.yaml`, and for your credentials. The list on the left groups the sections under **Identity**, **Brain**, **Senses**, **Voice and body** and **System**; the number beside a section counts your unsaved edits. **Personality** is the first entry under Identity: an editor for the co-host's [personality file](../tune/personality.md), saved with **Save** or Ctrl+S, which applies at once without a restart.

For the other sections, change values, press **Check** to validate them without saving, and **Save** to write them; **Discard** drops your edits. Saving keeps your comments and unknown keys, and refuses if the file changed since you loaded it (press **Reload**). Settings apply when the services that read them restart, and after a save a banner names those services with a **Restart** button. A few keys, such as an address a credential is sent to, need the control token to change. Every key is explained on the [configuration reference](../../advanced/reference/config.md).

Beside the engine and provider keys (`voice.engine`, `ears.stt_engine`, `ears.stt_fallback_engine`, `vision.provider` and `llm.provider`) the screen shows an egress note for any destination that leaves your LAN, such as "spoken text goes to speech.example.com" or "the conversation goes to chat.example.com". It appears before you restart the service, so you can see where audio, text or frames will go. The Services screen marks the same destinations on each service's row.

Secrets are set here too. A key such as an API key shows **Set** or **Not set** and a masked field, and never shows the saved value: type the value and press **Save** to write it to `config/secrets.yaml`, or **Clear** (after confirming) to remove it. Writing a secret always needs the control token, even with the dashboard controls off.

## The sink page

The dashboard has a second face for streaming: the same address with `?sink=1` on the end (`http://localhost:3000/?sink=1`) shows only the name, whether audio is on and a one-line status, with no navigation. Audio starts on without a click. That is the page [OBS](../../start/glossary.md#obs) plays on stream. It is covered on [OBS and the voice on stream](../connect/obs.md).

On another PC, load it from the LAN port with the AI PC's **IP address**, `http://192.168.1.20:3001/?sink=1`. To load it by the computer's name (`http://streampc:3001/?sink=1`), add the name to `dashboard.allowed_hosts` in `config/config.yaml` and restart the dashboard (it reads the list when it starts); a name that is not listed is refused outright, because a page reached by a name could be a web page you visited acting as the dashboard, and an IP address cannot be. On the same PC, `localhost` is fine.

A streamed reply plays clause by clause in this browser, and the feed shows it as one **Co-host** row that grows as the clauses arrive, with one **Voice** row per clause. A `voice.stop` (a barge-in, for example) cuts the clip that is playing and reports how much was said; a browser that refuses to start a clip turns **Audio on** back to **Audio off** and says so.

## Avatar models

The browser renderer draws a `.vrm` model from the dashboard's model store, a folder in the data directory: `data/dashboard/avatar-models/` (under `COHOST_DATA_DIR` when that is set). Copy a model in there and it is listed the next time the list is read. A file is listed only when its name follows the rule of `renderer.model` (at most 80 characters: letters, digits, spaces, `_`, `.` and `-`, starting with a letter or digit, ending in a lower-case `.vrm`) and its head is a [VRM](../../start/glossary.md#vrm) file the renderer can load; a file that fails the head check is listed with an error and cannot be selected. Links in the folder are never followed.

Choose the model in `renderer.model` (blank draws the built-in placeholder). A save that names a model not in the store, or one listed with an error, is refused, and a save takes effect at once without a restart. The largest file the store accepts is `dashboard.models.max_bytes` (default 100 MiB, between 1 MiB and 1 GiB). The store holds at most 20 models and 2 GiB in all; a model that is applied cannot be deleted until another is selected.

The model is served to anyone who can reach the LAN listener, without a token, so keep that listener off networks you do not trust if the model is under a licence that forbids redistribution. The terms a model carries are its author's; cohost enforces none of them.

## Keyboard shortcuts

Press `?` anywhere to see this list.

| Key | What it does |
| --- | --- |
| `/` | Open Live and focus the **Say** field |
| `1` to `4` | Open Live, Services, Viewers or Settings |
| `m` | Mute or unmute the co-host |
| `Esc` | Close the open dialog |
| `?` | Show the list of shortcuts |

Shortcuts do nothing while you are typing in a field, with Ctrl, Alt or Meta held, or while a dialog is open (except `Esc`).

::: aside
The dashboard has a lot of buttons. Only one of them says **Mute co-host**. Learn where it is before you go live.
:::

## How you know it worked

- The header shows the co-host status and a `Stack:` status, and the **Activity** feed scrolls.
- Typing a line into **Say a line** and pressing **Say** makes the co-host speak it (after you turn audio on).

## If it didn't

- The page does not load, or a banner says live updates stopped: the dashboard is not running. Start it again with `pnpm dashboard`. If that command stops with a build error instead of starting, the dashboard is deliberately not started; fix the error and run it again.
- The Stack card says service control is off: check that `CONTROL_ENABLED=1` is set in `.env`, restart the dashboard, and see [Troubleshooting](../troubleshooting.md).
- The Access dialog asks for a token you do not know: it is the `CONTROL_TOKEN` line in `.env`.
- The Viewers screen says it is not set up: add a `VIEWERS_TOKEN` as above and restart the dashboard.
- No sound: turn audio on in the header first, and see [Troubleshooting](../troubleshooting.md).
