---
title: Discord
description: Create and invite the one Discord bot, start the discord, ears and mouth services, and choose the voice channel the co-host hears and speaks in.
track: simple
verified: f126b94
---

# Discord

By the end of this page the co-host will sit in a Discord voice channel of your choice, hear what is said there, and speak its replies into it. It uses exactly one Discord bot for both jobs.

::: aside
One bot. One seat. I do not need a second account to talk over myself. I can manage that for free.
:::

## What you need

- A [real install](../install/real-install.md) with the dashboard running.
- A Discord server where you can add a bot, and a voice channel in it.
- A free Discord developer application at `https://discord.com/developers`.

## How the pieces fit

Three optional services cooperate. They are [Compose profiles](../../start/glossary.md#compose-profile), so none of them runs until you list it:

| Service (profile) | Job | Holds the Discord login? |
| --- | --- | --- |
| `discord` | The [connector](../../start/glossary.md#connector): the one bot login and the one voice connection. It carries the channel's audio in and the co-host's voice out. | Yes, the only one |
| `ears` | Listens: turns the audio the connector hears into text with [speech-to-text](../../start/glossary.md#stt) | No |
| `mouth` | Speaks: sends the co-host's voice to the connector to play | No |

Because only the connector logs in, `ears` and `mouth` need no Discord token, and any of the three can be restarted without the others. The connector ignores every bot account, so the co-host never answers its own voice.

## Steps

1. At `https://discord.com/developers`, create a new application and add a bot to it. Copy the bot's token.

2. On the bot's page, turn on the **Server Members** privileged intent.

3. Invite the bot to your server with the permissions **Connect** and **Speak** in the voice channel.

4. In Discord's advanced settings, turn on Developer Mode. Then right-click your server and choose to copy its ID, and do the same for the voice channel.

5. Put all three values in `.env`:

   ```dotenv
   DISCORD_TOKEN=your-bot-token
   DISCORD_GUILD_ID=your-server-id
   DISCORD_VOICE_CHANNEL_ID=your-voice-channel-id
   ```

6. Tell [Compose](../../start/glossary.md#docker-compose) to run the three services, and keep them on across restarts and Launch, by listing them in `.env`:

   ```dotenv
   COMPOSE_PROFILES=discord,ears,mouth
   ```

   If you also turned on vision, add `eyes` to the list.

7. Start them. In the dashboard press **Launch** again, or from a terminal in the cohost folder:

   ```bash
   docker compose --profile discord --profile ears --profile mouth up -d
   ```

8. Join the voice channel yourself, unmuted, and say something.

## Where the voice goes

The co-host's voice goes to the places named under `mouth.outputs` in `config/config.yaml`. There is one output today, `discord`. The connector's connection is set under `connections.discord`:

```yaml
connections:
  discord:
    enabled: true        # false = the connector idles and holds no connection
    guild_id: "${DISCORD_GUILD_ID}"
    voice_channel_id: "${DISCORD_VOICE_CHANNEL_ID}"
mouth:
  outputs:
    discord:
      enabled: true      # false = mouth plays nothing
      gain_db: 0         # loudness on this output only, -40..12 dB
  fallback:
    min_interval_ms: 20000   # at most one fallback line per 20 s on an output
```

The values in `.env` reach these keys by themselves, so you do not edit them. If you change a routing key, restart `mouth` from the Services tab.

The dashboard's sink page in a browser (often an [OBS](../../start/glossary.md#obs) [Browser Source](../../start/glossary.md#browser-source)) is a different [sink](../../start/glossary.md#sink), not one of these outputs: open it wherever else you want the voice. See [OBS and the voice on stream](obs.md).

Listening is a list of [audio sources](../../start/glossary.md#audio-source) in `ears.sources`; it defaults to `[discord]`. Two others need no account: `http` (post audio clips to a local address) and `dir` (drop `.wav` files in a folder). The [configuration reference](../../advanced/reference/config.md) lists their keys.

## How you know it worked

- On the Services tab, `discord`, `ears` and `mouth` all show `up`. `ears` shows its Discord dependency as `ok`.
- When you speak in the channel, a `speech.heard` line with your display name and the source `discord` appears on the dashboard's live feed.
- When the co-host replies, you hear it in the channel.
- The co-host never answers its own voice.

## If it didn't

- **`discord` shows `degraded`.** `DISCORD_TOKEN` is missing or empty, so the connector idles and registers nothing. Fill it in and restart the connector.
- **It joins but nothing is heard.** Check you turned on the **Server Members** intent, that the bot has **Connect** and **Speak** in that channel, and that the guild and channel IDs are the right ones.
- **It hears you but never speaks.** Check that `mouth` is running and that `mouth.outputs.discord.enabled` is `true`.
- **Voice quality or joining problems.** The Discord voice path depends on native audio libraries that have not yet been run against a real Discord server. If it fails to join, read the connector's log with `docker compose logs connector-discord` and open an issue.

More cases are on the [troubleshooting page](../troubleshooting.md).

## Next

Put the voice on your stream: [OBS and the voice on stream](obs.md).
