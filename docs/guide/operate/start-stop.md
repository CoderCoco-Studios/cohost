---
title: Starting and stopping
description: Start the whole co-host with Launch, stop it cleanly, restart one part, switch optional services on, and do the same from a terminal with cohostctl.
track: simple
verified: a86e930
---

# Starting and stopping

You start, stop and restart the co-host from the dashboard with a click, or from a terminal with `cohostctl`. This page covers both, plus how to switch the optional parts (Discord, ears, mouth, eyes) on so they stay on.

## What you need

- A finished install: [Install for real](../install/real-install.md), or [Try it with no accounts](../install/first-run.md) for [mock mode](../../start/glossary.md#mock-mode).
- The dashboard running on your PC with `mise run dashboard`. The dashboard is not part of the stack it controls, so it must be started by hand first.

## Start everything

1. Run the dashboard.

   ```bash
   mise run dashboard
   ```

2. Open the unlock link the terminal prints (`Unlock this browser: http://127.0.0.1:3000/unlock?n=...`), or `http://localhost:<dashboard.port>` (3000 by default) in a browser that is already unlocked, and open the **Services** screen. A browser that is not unlocked asks for the control token from your password manager in the [Access dialog](dashboard.md#the-access-dialog); `mise run dashboard:unlock` prints a fresh link if the first one has expired.
3. Press **Launch** and confirm.

Launch rebuilds any service whose code changed (a quick no-op when nothing did, several minutes when something did), hands each service its settings from the [settings store](settings.md#where-your-settings-live), starts every [container](../../start/glossary.md#container) of the stack, passes each one its credentials, and waits until they are ready. The **Stack** card shows the phase and a timer while it works, and a Launch panel below it with a row per service being built (building, cached or built, its current step and the steps done) and a **Build log** you can open to read the last 200 lines of build output. If a build fails, the panel names the image and shows its last error lines. The panel stays after Launch finishes or fails, until the next Launch, Rebuild or Restart all, and the same output goes to the dashboard's log, `data/logs/dashboard.log`. While images build, a container left over from the previous run reads as "from the previous run" rather than `exited`: Launch recreates it once the builds are done. The very first Launch is the slowest, because images are built and models are downloaded.

**Launch** shows while the stack is down; while it is up, **Rebuild** rebuilds the images from the current code and brings the stack up again.

## Stop everything

Press **Stop stack** on the **Stack** card and confirm. Every container stops, including the database and the [bus](../../start/glossary.md#bus). Nothing is deleted, so Launch brings it all back, memories included.

After a successful Stop, a **Run consolidation pass** button appears. It tidies the co-host's viewer notes and is optional; see [After a stream](after-stream.md).

Stopping the stack leaves the dashboard running; stop it with Ctrl+C in its terminal. After a reboot, Docker starts the containers again on its own, but they wait for their credentials until you start the dashboard or run `mise run deliver`; see [After a reboot](settings.md#after-a-reboot).

## Restart one part, or all of them

On the **Services** screen each service row has **Start** or **Restart** and **Stop** buttons (**Start** while the service is down, **Restart** and **Stop** otherwise). **Stop** asks you to confirm; **Start** and **Restart** open a dialog. **Restart all** on the **Stack** card restarts every running co-host service. Restarting is the way to apply a change you saved on the **Settings** screen or with `mise run config:set`, because services read their settings when they start.

The **Start** and **Restart** dialog holds two options that change how a start behaves:

- **Start mode:** `resume` picks up the backlog of unread [events](../../start/glossary.md#event) where the service left off; `fresh` skips the backlog and starts from now. The default is `fresh` for every co-host service except memory, so a restart never makes the co-host answer chat from five minutes ago. Memory resumes, so it does not miss anything it should store.
- **Isolated:** starts only that service, with its pretend backends (the isolation overrides for that unit) and no accounts. `mise run cohostctl start <service> --isolated` does the same from a terminal. It is for testing one piece. See [One service on its own](../../advanced/testing/isolated.md).

The three brain parts [salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect) and [cortex](../../start/glossary.md#cortex) also have **Pause** and **Resume**. Pausing idles one in place without stopping its container.

The [Redis](../../start/glossary.md#redis) and [Postgres](../../start/glossary.md#postgres) rows are read-only unless you set `CONTROL_ADVANCED=1` in `.env`. The dashboard can never stop itself.

## Do it from a terminal

`cohostctl` does everything the buttons do. It runs on the same PC as the dashboard and uses your own [Docker](../../start/glossary.md#docker) access. It does not need the dashboard running and does not ask for the control token, because you are already you. Like the dashboard, it hands each service its settings before a start and its credentials after it.

| Command | What it does |
| --- | --- |
| `mise run cohostctl status` | Prints the state of every service. Add a name for one. See [Service health](health.md). |
| `mise run cohostctl launch` | Builds the images, starts the whole stack, waits until it is ready. |
| `mise run cohostctl rebuild` | The same as `launch`. |
| `mise run cohostctl stop-all` | Stops every container; nothing is removed. |
| `mise run cohostctl restart-all` | Restarts every running co-host service. |
| `mise run cohostctl start cortex` | Starts one service. Also `stop` and `restart`. |
| `mise run cohostctl restart cortex --mode fresh` | Restarts with a start mode (`resume` or `fresh`). `--isolated` starts it with pretend backends. |
| `mise run cohostctl consolidate` | Runs the viewer-note pass. See [After a stream](after-stream.md). |
| `mise run cohostctl reembed` | Re-embeds stored memories after you change the [embedding](../../start/glossary.md#embedding) model. See below. |
| `mise run deliver` | Hands their credentials to every running service that waits for them, as after a reboot. The same as `mise run cohostctl deliver`. |
| `mise run cohostctl latency` | Prints how long each stage of the speech and sight paths takes, from recent history. Read-only. |

Each command exits with 0 on success and 1 on failure or refusal. A mistyped command prints the usage and exits with 2.

The dashboard and `cohostctl` take turns. While one is running a stack or service action, the other refuses with a message that starts `busy:` and names who holds the lock, so two of you cannot launch and stop at once. A lock left by a crashed process clears itself.

## Switch the optional parts on

The core of the co-host starts with Launch. Some parts are optional and live behind [Compose profiles](../../start/glossary.md#compose-profile), named switches in [Docker Compose](../../start/glossary.md#docker-compose), the tool that runs the containers:

| Profile | Switches on | Needs |
| --- | --- | --- |
| `discord` | The Discord [connector](../../start/glossary.md#connector), which holds the bot's one voice connection. | [Discord setup](../connect/discord.md) |
| `ears` | The listener that turns voice into text. | A source to listen to; see [Discord](../connect/discord.md) |
| `mouth` | The speaker that sends the co-host's voice to its outputs. | [Discord](../connect/discord.md) or the [OBS sink](../connect/obs.md) |
| `eyes` | The screenshot sense that looks at your game. | [OBS](../connect/obs.md) |
| `maintenance` | The one-shot jobs `consolidate` and `reembed`. Never started by Launch. | nothing |

To keep profiles on across restarts and Launch, list them in `.env`:

```dotenv
COMPOSE_PROFILES=discord,ears,mouth
```

Then press **Launch** again.

## Change the embedding model

If you change the `llm.embed_model` setting to one that produces a different vector size (from `nomic-embed-text` to `mxbai-embed-large`, say), the memory service refuses to start, because the stored vectors no longer fit. Stop memory, then re-embed every stored row in place:

```bash
mise run cohostctl reembed
```

An interrupted run changes nothing, and running it again resumes where it stopped. Start memory again afterwards.

## How you know it worked

- After **Launch**, the header reads `Stack: Up` and the **Services** screen shows each row `up`. See [Service health](health.md).
- After **Stop stack**, the header reads `Stack: Down`.
- After **Restart**, the row is `up` again within a few seconds.

## If it didn't

- **Launch** is disabled or the header says `Stack: Docker unavailable`: the dashboard cannot reach Docker. See [Troubleshooting](../troubleshooting.md).
- A button answers `busy`: the other of the dashboard and `cohostctl` is mid-action. Wait for it.
- A service stays `degraded` with `waiting for credentials`: nothing has handed it its credentials since it started. Start the dashboard or run `mise run deliver`.
- A service stays `down` or `crash-looping`: see [Troubleshooting](../troubleshooting.md).
