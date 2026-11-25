---
title: YouTube chat
description: Point the co-host at a YouTube live broadcast so it reads the live chat with a Data API key, and what the polling floor and the quota mean.
track: simple
verified: 7b10576a
---

# YouTube chat

By the end of this page the co-host will be reading the live chat of a YouTube broadcast you choose. It reads with an API key only: there is no YouTube login, and the co-host sends nothing to the chat.

## What you need

- A [real install](../install/real-install.md) with the dashboard running.
- A YouTube Data API key from a Google Cloud project with the YouTube Data API v3 enabled.
- The broadcast's URL or video id, and the broadcast must be live, or scheduled to start, with live chat enabled.

## Steps

1. Put the key in `secrets/secrets.yaml`, never in `config.yaml`. Or write it through the dashboard's secrets route, which never shows it again once saved.

   ```yaml
   chat:
     youtube:
       api_key: "your-api-key"
   ```

2. Set the broadcast and list `youtube` in the sources in `config/config.yaml`.

   ```yaml
   chat:
     sources: [youtube]
     youtube:
       video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
   ```

   The video value accepts a bare id, a `watch`, `youtu.be`, `live`, `embed` or `live_chat` link. A channel URL, a playlist or a search phrase names no video and leaves the source off with a gap message in the dashboard.

3. Restart the `chat` service. A new broadcast has a new video id, so restart chat for each stream. From a terminal in the cohost folder:

   ```bash
   pnpm cohostctl restart chat
   ```

4. Check the Services screen: the `youtube` source reads when the broadcast is live. A broadcast that has not started is `waiting` and is looked up again every `recheck_ms`.

## Transport and polling floor

`transport: stream` (the default) holds a server stream open and gets messages as they come. If the stream cannot be opened at start, the co-host reads by polling for the rest of the run. `transport: poll` polls only, so use it when the stream stays unreliable.

Polling waits the larger of the server's interval and `poll_floor_ms` (default 12000) between calls. A 6 hour broadcast polled at the default floor costs about 9,000 of the 10,000 daily units, so raise the floor for longer streams or when the key's project shares its quota.

## Quota

The co-host counts the units it spends in memory and logs the total every ten minutes. It keeps no count across restarts and does not act on it. When YouTube answers that the daily quota is spent, the source shows `retrying` with the reason `quota` and looks the broadcast up again every hour until the quota returns.

## Removals

A deleted message and a ban or timeout are reported as removals, so the co-host forgets that text and viewer. The co-host never deletes, bans or times out on YouTube.

## How you know it worked

The Services screen shows `youtube` as `reading`, and a message typed in the broadcast's chat reaches the co-host's log within the poll floor (or at once on the stream).

## If it didn't

- `chat.youtube.video is not a YouTube video URL or id`: the value names no video. Use the watch link or the video id.
- `the API key was rejected` or `authentication failed`: the key is wrong or not in `secrets.yaml`. The key is read at start, so restart chat after you change it.
- `live chat is disabled for this broadcast` or `the broadcast has ended`: the source stops and does not retry. Start a new broadcast, set its URL and restart chat.
- `retrying` with the reason `quota`: the daily quota is spent. It resumes on its own; a higher `poll_floor_ms` spends less.

More cases are on the [troubleshooting page](../troubleshooting.md#the-youtube-chat-source-stops-with-a-reason).

## Limits

- A Super Chat publishes its comment as an ordinary line; the amount is never read or used.
- Membership and gift notices, polls and sponsor-only mode changes publish nothing.
- The co-host reads only the messages from the moment it connects, not the history before.
- The live check of some message fields is still open: a Super Chat comment, the removal field names and the stream's batching are confirmed on a real broadcast before the platform behaviour is relied on.
