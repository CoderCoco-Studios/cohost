/**
 * ears — a Discord bot that sits in your voice channel.
 *
 * Listens: each speaker's audio is captured separately, transcribed by the STT
 * container (speaches / faster-whisper, OpenAI-compatible) and published as
 * `speech.heard` with the speaker's name — so the brain knows who said what.
 *
 * Speaks: plays every `voice.utterance` into the channel and reports
 * `voice.playing` / `voice.done` so the avatar lip-syncs and the brain waits.
 *
 * Setup: create a bot at discord.com/developers, invite it with Connect + Speak
 * permissions, set DISCORD_TOKEN / DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID.
 * This MUST be a bot account — automating a user account gets it banned.
 */
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig, urls } from "@cohost/config";
import { EarsHealth, earsPlan } from "./health.js";
import { sttTranscriber } from "./hearing.js";
import { createInjectHandler } from "./inject.js";

const log = createLogger("ears");
const cfg = loadConfig();
const bus = new Bus("ears", log);
const token = process.env.DISCORD_TOKEN ?? "";
const plan = earsPlan(cfg.ears.source, !!token);
let voiceReady = false;
const health = new EarsHealth(plan, () => voiceReady);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });

// Injected clips only need the STT service, so this works in every plan (off / no-token / discord).
const onInject = createInjectHandler({ bus, log, dashboardUrl: urls.dashboard(), transcribe: health.track(sttTranscriber(cfg.ears)) });

if (plan === "discord") {
  // discord.js and friends are only loaded when a session will actually be opened.
  const { startDiscord } = await import("./discord.js");
  startDiscord({ cfg, bus, log, health, heartbeat, onInject, setVoiceReady: (v) => { voiceReady = v; } });
  onShutdown(() => { bus.stop(); });
} else {
  // Idle: no Discord client; voice.utterance is ignored (only inject.request is consumed), process stays up.
  void bus.subscribe({ group: "ears", types: ["inject.request"], fromNow: true }, onInject);
  if (plan === "off") {
    log.warn("ears.source is off: idle, no Discord client, nothing heard or played (mode off)");
    heartbeat.ready();
  } else {
    log.error("DISCORD_TOKEN is not set; ears is idle (no Discord client)");
    heartbeat.degraded("DISCORD_TOKEN is not set");
  }
  const timer = setInterval(() => {
    if (plan === "no-token") log.warn("DISCORD_TOKEN is not set; ears still idle");
  }, 60_000);
  onShutdown(() => { clearInterval(timer); bus.stop(); });
}
