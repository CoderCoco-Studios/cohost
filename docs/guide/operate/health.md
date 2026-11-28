---
title: Service health
description: How to read the Services screen and cohostctl status to tell which parts of the co-host are up, degraded, off or pretending.
track: simple
verified: a86e930
---

# Service health

cohost is a handful of small programs, called services, working together. Each one reports in regularly to say how it is. This page explains those reports, so when something goes quiet you can tell which part, and why.

## What you need

- A running co-host and the [dashboard](dashboard.md).

## How services report in

Every service sends a small "I am alive" message, a [heartbeat](../../start/glossary.md#heartbeat), every `HEARTBEAT_INTERVAL_MS` milliseconds (5000 by default, so every five seconds; you can change it in `.env`). Heartbeats travel on their own stream, so they never get lost in the busy chat traffic. A heartbeat says:

- the service's own state: `starting` when it boots, `ready` once it is working, `degraded` when something it relies on is down, `stopping` when it is shutting down;
- its **mode**: `live`, `mock` or `off`;
- its **dependencies**: the things it relies on, each marked `ok`, `down` or `n/a`;
- an optional **detail** note, such as `paused`.

The dashboard watches those heartbeats and works out a verdict for each service. It reflects the same signal in `docker compose ps`, where each application [container](../../start/glossary.md#container)'s health check passes only while its heartbeat is fresh.

## The states

Open the dashboard's **Services** screen. The **State** column shows one of these:

| State | What it means | Usual cause |
| --- | --- | --- |
| `up` | Heartbeats are arriving, the service says it is ready and nothing it relies on is down. | All is well. |
| `degraded` | It is running but not at full strength: it said `starting` or `degraded`, or one of its dependencies is `down`. | A model server or database it uses is not answering yet, or it is still booting. A detail of `waiting for credentials` means it started without the dashboard to hand it its credentials, as after a reboot; see [After a reboot](settings.md#after-a-reboot). |
| `stale` | No heartbeat for more than 3 intervals (15 seconds at the default). | Busy, stuck or just slow. Often clears by itself. |
| `down` | No heartbeat for more than 10 intervals (50 seconds at the default), or the service reported `stopping`. | It stopped, crashed or was never started. |
| `crash-looping` | It started three times within 60 seconds. | It keeps dying at boot; look at its container logs. |
| `unknown` | The dashboard has never heard from it. | It was never started, or it dies before its first heartbeat. |

When several apply, the worst wins, in the order crash-looping, down, stale, degraded, up. The **Services** item in the header shows a count such as `2`, and the **Services** heading says "2 need attention", when any service is `down`, `stale` or `crash-looping`; those rows are listed first.

A container that [Docker](../../start/glossary.md#docker) keeps restarting before it ever sends a heartbeat is also reported as `crash-looping`, so a service that dies at once does not hide as `unknown`.

## The mode

| Mode | Meaning |
| --- | --- |
| `live` | Using its real backend: the real model, the real voice, the real chat. |
| `mock` | Using a pretend backend that needs no account or model server, such as [mock mode](../../start/glossary.md#mock-mode) or an isolated start. Fine for testing, silent or scripted for a real stream. |
| `off` | Running but idle, because it is not configured or is switched off. It logs one warning saying why. Not an error by itself. |

A `—` in the column means no heartbeat has been seen.

## Chat sources in the deps column

`chat` reports one dependency per source it reads, `twitch` and `youtube`, and a source not listed in `chat.sources` shows `n/a`. A listed source is `ok` only while it is reading; while it waits for a broadcast, retries or has stopped (for example because `chat.twitch.channel` or the YouTube key is not set) it shows `down`, and the service shows `degraded` with the reasons as its detail. The mode is `mock` when `fake` is listed, `off` when `chat.sources` is empty, and `live` otherwise.

## The other columns

- **deps** lists each dependency with `ok` or `down`. A dependency marked `n/a` is not applicable right now.
- **last seen** is the time since the last heartbeat. It should stay within a few seconds.
- **restarts**, under the last-seen time, is how many times Docker has restarted the service's container since it was created. It only grows while the container lives and starts again from 0 when Launch recreates the container. Starts in the last minute are what makes a service `crash-looping`; the **Why** cell then says how many there were.
- **detail** is the service's own note. `paused` also appears as a badge beside the state, when you have paused a brain part.
- A line under the state such as `needs cortex (down)` says that a service this one relies on is in trouble. It is a hint about where to look; the service's own state is unchanged.

## Infrastructure rows

Below the services, an **Infrastructure** group lists the containers that send no heartbeat: Redis, [Postgres](../../start/glossary.md#postgres), [Ollama](../../start/glossary.md#ollama), the speech servers and the `models` job. Their state is what Docker reports (`running`, `running, healthy`, `exited`, ...), and the why and last-seen cells read "n/a — container only", since there is no heartbeat to show; the restart count is Docker's, as for the other rows. `models` downloads the configured models and stops, so after a good Launch it reads `completed`, and `failed (exit n)` if the download failed. Ollama, the speech servers and, with `CONTROL_ADVANCED=1`, Redis and Postgres have a **Restart** button.

## Live, from your dashboard

When you open these docs from your own dashboard (the **Docs** link in its header), this page shows your services as they are right now, refreshed every few seconds. The columns are the ones described on this page. Anywhere else, such as the public copy of the docs, you will see a short note instead, because only your dashboard knows how your services are doing.

<LiveHealth />

## Hooks in the deps column

Three brain parts, and memory, let you swap their judgement for a model through a [hook](../../start/glossary.md#hook). When a hook is set to ask a model (`llm`) or your own server (`http`), the service reports it as a dependency named `hook.<name>`: `hook.salience.scorer`, `hook.affect.appraiser`, `hook.cortex.critic`, `hook.memory.capture` and `hook.memory.consolidator`. A built-in rules hook is not listed.

- `ok`: the hook's model answered.
- `down`: it is cooling off after a failure, or not reachable. The service carries on with its built-in rules, so the co-host keeps talking, but the service shows as `degraded` until the hook recovers.
- `n/a`: not known yet.

A hook running on the pretend provider makes its service report mode `mock`.

## Read it from a terminal

`cohostctl`, the command-line twin of the dashboard, prints the same verdicts:

```bash
mise run cohostctl status
```

Each line is a service, its state, its mode (`-` when the service has not reported one) and how long ago it was last heard from, or `never`. Your own output will list every service; this example shows just the layout:

```console
$ mise run cohostctl status
cortex     up            live  3s ago
memory     degraded      live  2s ago
eyes       down          -     never
```

To look at one service, add its name, as in `mise run cohostctl status cortex`. An unknown name is an error. This command only reads, so it is safe to run at any time, including while the dashboard is busy.

## The stack status

The `Stack:` status in the dashboard header is the system as a whole:

| Status | Meaning |
| --- | --- |
| `Up` | Every long-running container is running and ready. |
| `Degraded` | At least one is not ready. |
| `Starting` | A Launch is in progress, or every container that is not ready is still passing its first health checks. |
| `Stopping` | A Stop is in progress. |
| `Down` | Nothing is running. |
| `Docker unavailable` | The dashboard cannot talk to Docker at all; the **Stack** card shows what Docker said. |

If [Redis](../../start/glossary.md#redis) is down, the **Stack** card also says the [bus](../../start/glossary.md#bus) is unreachable. It comes back when you Launch.

## How you know it worked

After **Launch**, the **Services** screen fills up: every row turns `up` within a minute or two (the first Launch takes much longer while images build and models download). A row showing `mock` mode, or `off` for a service you did not set up, is expected.

## If it didn't

- Everything `unknown`: nothing has been started, or the dashboard cannot reach Redis (the bus). Press **Launch**, and see [Starting and stopping](start-stop.md).
- Services stay `degraded` with `waiting for credentials`: start the dashboard with `mise run dashboard`, or run `mise run deliver`.
- One service `down` or `crash-looping`: see [Troubleshooting](../troubleshooting.md), then read that service's logs.
- Services `degraded` with a `down` dependency: that dependency is the thing to fix. A hook that is `down` means its model server is not reachable; see [Choose a model](../tune/model.md).
