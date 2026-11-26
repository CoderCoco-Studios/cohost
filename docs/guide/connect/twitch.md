---
title: Twitch chat
description: Point the co-host at a Twitch channel so it reads chat, with an optional login for the full Twitch connection.
track: simple
verified: f126b94
---

# Twitch chat

By the end of this page the co-host will be reading the chat of the Twitch channel you choose and answering the lines that deserve it. Reading chat needs no Twitch login at all, so this is the quickest account to connect.

## What you need

- A [real install](../install/real-install.md) with the dashboard running.
- The name of the Twitch channel to read: yours, or any channel that is live, if you only want to test.
- Optional: a Twitch developer application, if you want the logged-in connection. You can skip it.

## Steps

1. Open `config/config.yaml` and set the channel name, without the `#`.

   ```yaml
   chat:
     sources: [twitch]
     twitch:
       channel: "yourchannel"
   ```

2. Check that `chat.sources` lists `twitch`. Every source listed is read at once, so a `fake` in the list also plays scripted messages alongside Twitch.

3. Restart the `chat` service. In the dashboard, open the Services screen and restart `chat`. Or, from a terminal in the cohost folder:

   ```bash
   mise run cohostctl restart chat
   ```

4. Say something in your channel's chat from another account or browser tab.

## Logging in (optional)

Without a login the co-host reads chat anonymously. That works for reading. If you also want the logged-in connection, create an application at the Twitch developer console (`https://dev.twitch.tv/console`), authorise it for the scopes `chat:read` and `chat:edit`, and put what you get into the secret fields of **Settings**, **Twitch chat** (each shows **Set** or **Not set**; saving needs your control token), or into `secrets/secrets.yaml` by hand:

```yaml
chat:
  twitch:
    client_id: "your-client-id"
    client_secret: "your-client-secret"
    access_token: "your-access-token"
    refresh_token: "your-refresh-token"
```

Both tokens are required together: the refresh token must be set whenever the access token is. Twitch tokens expire, and cohost renews them itself. It keeps the renewed token on your machine in `data/chat/twitch-token.json`, so a restart does not lose it. If you generate a new pair and put it in the secret fields (or `secrets.yaml`) and restart `chat`, cohost notices and uses the new pair.

The co-host does not write into Twitch chat today. It reads chat and speaks. The logged-in path has not been run against real Twitch yet, so treat it as the least-tested part of this page.

## What cohost forgets when a moderator removes chat

The chat service reports what Twitch removes: a deleted line, a ban, a timeout, or a cleared chat. It publishes each as a `chat.removed` notice and ignores `chat.ignore_users` for it. Forgetting those lines, in the co-host's short-term window and in stored memory, arrives with #180–#183; until then the co-host still holds them.

cohost never sends a delete, ban or timeout to Twitch. It only reports what Twitch did.

Whether Twitch sends these removal notices to the anonymous, read-only connection has not been checked against a live channel yet. It is on the manual check list for #330.

## How you know it worked

- The Services screen shows `chat` as `up` with mode `live`.
- The `chat` log says it connected to Twitch chat (`docker compose logs chat` shows it). The line `authenticated: false` is normal without a login.
- Lines typed in your channel appear on the dashboard's live feed within a few seconds. A quiet channel stays quiet.

::: aside
If chat is quiet, I will not make things up. Well. Not until the idle chatter kicks in.
:::

## If it didn't

- **`chat` shows `degraded`.** `chat.twitch.channel` is empty, so the service is waiting for you. Set it and restart `chat`.
- **Fake messages keep arriving.** `chat.sources` still lists `fake` in `config/config.yaml`. Remove `fake` from it and restart `chat`.
- **`chat` will not start once the access token is set.** The refresh token is missing. Both are required together.
- **Nothing appears and the channel is busy.** Check the channel name for a typo, and read the `chat` log with `docker compose logs chat`.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Give the co-host somewhere to talk: [Discord](discord.md), or [OBS and the voice on stream](obs.md).
