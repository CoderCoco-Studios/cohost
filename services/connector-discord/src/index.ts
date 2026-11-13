/**
 * connector-discord: the co-host's one Discord login, as a bus connector.
 *
 * It holds the bot's single voice connection (undeafened, unmuted), publishes each human speaker's audio as source `discord`
 * on `audio.in.discord` and plays sink `discord` (`audio.out.discord`) into the channel. ears and mouth never touch Discord.
 *
 * Setup: create a bot at discord.com/developers, invite it with Connect, Speak and the Server Members intent, set DISCORD_TOKEN
 * and the guild and channel under `connections.discord` (DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID by default).
 * This MUST be a bot account: automating a user account gets it banned.
 */
import { runService } from "@cohost/shared";
import { createConnectorService } from "./service.js";

await runService({ service: "discord", ...createConnectorService() });
