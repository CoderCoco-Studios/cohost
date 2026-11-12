/**
 * mouth — the co-host's speaking module.
 *
 * Plays every `voice.utterance` on the outputs configured under `mouth.outputs` (a Discord bot that sits in a voice channel
 * and speaks there, and the test-only `dryrun` output) and reports `voice.playing` / `voice.done` with the output's name as
 * the sink, so the avatar lip-syncs and the brain waits. When a line cannot play it says a short pre-generated fallback line.
 *
 * Setup: create a bot at discord.com/developers, invite it with Connect + Speak permissions, set DISCORD_TOKEN and the
 * guild and channel under `mouth.outputs.discord` (DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID by default).
 * This MUST be a bot account — automating a user account gets it banned.
 */
import { runService } from "@cohost/shared";
import { createMouth, type MouthBus } from "./mouth.js";

// @spec MOUTH-START-006
const mouth = createMouth();
void runService<MouthBus>({ service: "mouth", health: mouth.health, main: mouth.main });
