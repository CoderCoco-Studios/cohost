/**
 * ears — the co-host's hearing: a Discord bot that sits in your voice channel and listens.
 *
 * Each speaker's audio is captured separately, transcribed by the STT container (speaches / faster-whisper,
 * OpenAI-compatible) and published as `speech.heard` with the speaker's name — so the brain knows who said what.
 * It also transcribes uploaded audio on `inject.request`. ears never speaks: her voice is the `mouth` service.
 *
 * Setup: create a second bot at discord.com/developers (not the speaking bot), invite it with Connect permission and
 * the Server Members intent, set EARS_DISCORD_TOKEN / DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID. It must be a
 * different bot from DISCORD_TOKEN. This MUST be a bot account — automating a user account gets it banned.
 */
import { runService } from "@cohost/shared";
import { createEarsService } from "./service.js";

// @spec EARS-START-008
await runService({ service: "ears", ...createEarsService() });
