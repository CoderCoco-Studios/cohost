---
title: Built-in tools
description: The four tools cohost ships with (clock, stream info, memory lookup and timers), how to switch each on, what the stream info tool sends to Twitch and YouTube, and how timers survive a restart.
track: simple
---

# Built-in tools

By the end of this page you will know which tools cohost has built in, how to let the co-host use each one, what leaves your machine when it asks about your stream, and what happens to a timer when `tools` restarts. The built-in tools need no server: they are part of the `tools` service. MCP servers you add are covered on the [MCP tool servers](mcp.md) page.

Every built-in tool is off until you turn it on under **Settings**, **Tools**, in its **enabled** mark. The co-host sees a tool only when it is enabled.

## What you need

- A [real install](../install/real-install.md) with the dashboard running, for the stream info and memory lookup tools. The clock and timers need only the `tools` service.
- For `stream_info`, the Twitch and YouTube app credentials you already set for chat.

## The four tools

| Tool | What it does | Needs |
| --- | --- | --- |
| `clock` | Tells the time, date, weekday and zone, in the zone set by `cohost.timezone`. | Nothing. |
| `stream_info` | Tells whether your stream is live on Twitch or YouTube, with its title, viewer count, how long it has been live and, for Twitch, its category. | The Twitch and YouTube app credentials you already set for chat. |
| `memory_lookup` | Looks up what the co-host remembers about a query, when the memories in its reply were not the ones it needed. It searches the memories of every viewer, as the co-host's own recall does. It asks the memory service and reads no database. | Nothing. The memory service must be running. |
| `timer` | Sets a timer, from 1 minute up to `tools.timer.max_minutes` (120 by default), with a note. When it runs out the co-host says the note in its own words. It needs both its **enabled** and its **acts** marks: without the acts mark the catalog does not offer it, and a call is refused as `acts_not_allowed`. | Nothing. |

Each answer is one short result, cut to `tools.max_result_chars`. The clock answers one sentence: `It is 03:05:09 on Tuesday, 2026-11-24 in Pacific/Auckland.`

## What leaves your machine for stream info

`stream_info` is the only built-in tool that calls outside your machine. It calls two platform APIs, and only these:

- **Twitch.** It asks Twitch for an app access token with your Twitch client ID and client secret, then asks whether the channel in `chat.twitch.channel` is live. It sends the channel name, the app token, and the client ID in its `Client-Id` header. It never uses a user token, and it sends no chat text.
- **YouTube.** It asks the YouTube Data API about the video in `chat.youtube.video`, with your YouTube API key in a request header. It sends the video ID and the key. It sends no chat text.

Both calls go over `https` only, to `id.twitch.tv`, `api.twitch.tv` and `www.googleapis.com`. Nothing else is contacted, and no redirect is followed. A platform that does not answer within its own wait, a share (90%) of the call's time limit, counts as one failed platform, and the other platform's answer is still given. An answer is kept for `tools.stream_info.cache_ms` (30 seconds by default), so the co-host does not ask on every reply; a failed call is never kept.

If a platform's channel, video or credentials are missing, the tool says so for that platform and does not call it. If you ask for a platform by name that is not `twitch` or `youtube`, the call is refused.

## Timers and restarts

A timer is kept in [Redis](../../start/glossary.md#redis), in the hash `<prefix>:tools:timers`, until it runs out. A restart of `tools` does not lose a timer:

- A timer that ran out while `tools` was down is announced as soon as the service starts, oldest first.
- A timer still to run is kept until its time comes.
- A timer that could not be announced stays stored and is announced at the next start.

The co-host cannot cancel or list its timers. At most `tools.timer.max_active` (5 by default) run at once; a call over that limit ends as an `error` result with the reason `limit`, and no timer is set, until one runs out. A timer set for longer than one timer can wait at a time (about 24 days) is handled in steps. Any `tools.timer.max_minutes` up to the largest due time a timer can hold (about 1.4 × 10^11 minutes from now) works; a request past that is refused as `invalid_arguments`.

In [mock mode](../../start/glossary.md#mock-mode) (the isolated start), timers live in the service's memory only, and a restart loses them.

## How you know it worked

- The dashboard lists each built-in tool with its label: `clock`, `stream_info` and `memory_lookup` are **read**, and `timer` is **acts**.
- Ask the co-host the time after a long reply. A `clock` call appears in the live feed with its answer.
- Set a short timer, such as one minute, and watch the feed for the reminder when it runs out.
- The `tools` service reports `stream.twitch` and `stream.youtube` while `stream_info` is on, as `ok` after a good answer and `down` after a failed call, and `memory` while `memory_lookup` is on.

## If it didn't

- **The stream info answer says a platform is not configured.** Its channel, video or credential is empty. Set it in the chat configuration (`chat.twitch` or `chat.youtube`) and restart `tools`.
- **The stream info answer says a platform did not answer.** The platform was slow or unreachable, or refused the credential. Check the credential, and try again.
- **The memory lookup says the memory service did not answer in time.** Check that the memory service is running.
- **The timer says the limit is reached.** Wait for one to run out, or raise `tools.timer.max_active`.

For anything else, see the [troubleshooting page](../troubleshooting.md).
