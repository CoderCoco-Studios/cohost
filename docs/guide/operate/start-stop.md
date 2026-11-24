---
title: Starting and stopping
description: Start the whole co-host with Launch, stop it cleanly, restart one part, switch optional services on, and do the same from a terminal with cohostctl.
track: simple
verified: f126b94
---

# Starting and stopping

You start, stop and restart the co-host from the dashboard with a click, or from a terminal with `cohostctl`. This page covers both, plus how to switch the optional parts (Discord, ears, mouth, eyes) on so they stay on.

## What you need

- A finished install: [Install for real](../install/real-install.md), or [Try it with no accounts](../install/first-run.md) for [mock mode](../../start/glossary.md#mock-mode).
- The dashboard running on your PC with `pnpm dashboard`. The dashboard is not part of the stack it controls, so it must be started by hand first.

## Start everything

1. Run the dashboard.

   ```bash
   pnpm dashboard
   ```

2. Open `http://localhost:<dashboard.port>` (3000 by default), open the **Services** screen, and enter the `CONTROL_TOKEN` from `.env` in the [Access dialog](dashboard.md#the-access-dialog) when it asks.
3. Press **Launch** and confirm.

Launch rebuilds any service whose code changed (a quick no-op when nothing did, several minutes when something did), starts every [container](../../start/glossary.md#container) of the stack, and waits until they are ready. The **Stack** card shows the phase and a timer while it works. The very first Launch is the slowest, because images are built and models are downloaded.

**Launch** shows while the stack is down; while it is up, **Rebuild** rebuilds the images from the current code and brings the stack up again.

## Stop everything

Press **Stop stack** on the **Stack** card and confirm. Every container stops, including the database and the [bus](../../start/glossary.md#bus). Nothing is deleted, so Launch brings it all back, memories included.

After a successful Stop, a **Run consolidation pass** button appears. It tidies the co-host's viewer notes and is optional; see [After a stream](after-stream.md).

## Restart one part, or all of them

On the **Services** screen each service row has **Start** or **Restart** and **Stop** buttons (**Start** while the service is down, **Restart** and **Stop** otherwise). **Stop** asks you to confirm; **Start** and **Restart** open a dialog. **Restart all** on the **Stack** card restarts every running co-host service. Restarting is the way to apply a change you saved on the **Settings** screen, because services read their settings when they start.

The **Start** and **Restart** dialog holds two options that change how a start behaves:

- **Start mode:** `resume` picks up the backlog of unread [events](../../start/glossary.md#event) where the service left off; `fresh` skips the backlog and starts from now. The default is `fresh` for every co-host service except memory, so a restart never makes the co-host answer chat from five minutes ago. Memory resumes, so it does not miss anything it should store.
- **Isolated:** starts only that service, with its pretend backends (the isolation overrides for that unit) and no accounts. `pnpm cohostctl start <service> --isolated` does the same from a terminal. It is for testing one piece. See [One service on its own](../../advanced/testing/isolated.md).

The three brain parts [salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect) and [cortex](../../start/glossary.md#cortex) also have **Pause** and **Resume**. Pausing idles one in place without stopping its container.

The [Redis](../../start/glossary.md#redis) and [Postgres](../../start/glossary.md#postgres) rows are read-only unless you set `CONTROL_ADVANCED=1` in `.env`. The dashboard can never stop itself.

## Do it from a terminal

`cohostctl` does everything the buttons do. It runs on the same PC as the dashboard and uses your own [Docker](../../start/glossary.md#docker) access. It does not need the dashboard running and ignores `CONTROL_TOKEN`, because you are already you.

| Command | What it does |
| --- | --- |
| `pnpm cohostctl status` | Prints the state of every service. Add a name for one. See [Service health](health.md). |
| `pnpm cohostctl launch` | Builds the images, starts the whole stack, waits until it is ready. |
| `pnpm cohostctl rebuild` | The same as `launch`. |
| `pnpm cohostctl stop-all` | Stops every container; nothing is removed. |
| `pnpm cohostctl restart-all` | Restarts every running co-host service. |
| `pnpm cohostctl start cortex` | Starts one service. Also `stop` and `restart`. |
| `pnpm cohostctl restart cortex --mode fresh` | Restarts with a start mode (`resume` or `fresh`). `--isolated` starts it with pretend backends. |
| `pnpm cohostctl consolidate` | Runs the viewer-note pass. See [After a stream](after-stream.md). |
| `pnpm cohostctl reembed` | Re-embeds stored memories after you change the [embedding](../../start/glossary.md#embedding) model. See below. |
| `pnpm cohostctl latency` | Prints how long each stage of the speech and sight paths takes, from recent history. Read-only. |

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

If you change `llm.embed_model` in `config/config.yaml` to one that produces a different vector size (from `nomic-embed-text` to `mxbai-embed-large`, say), the memory service refuses to start, because the stored vectors no longer fit. Stop memory, then re-embed every stored row in place:

```bash
pnpm cohostctl reembed
```

An interrupted run changes nothing, and running it again resumes where it stopped. Start memory again afterwards.

## How you know it worked

- After **Launch**, the header reads `Stack: Up` and the **Services** screen shows each row `up`. See [Service health](health.md).
- After **Stop stack**, the header reads `Stack: Down`.
- After **Restart**, the row is `up` again within a few seconds.

## If it didn't

- **Launch** is disabled or the header says `Stack: Docker unavailable`: the dashboard cannot reach Docker. See [Troubleshooting](../troubleshooting.md).
- A button answers `busy`: the other of the dashboard and `cohostctl` is mid-action. Wait for it.
- A service stays `down` or `crash-looping`: see [Troubleshooting](../troubleshooting.md).
