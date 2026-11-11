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
import { Bus, onShutdown, startHeartbeat, type BusEvent } from "@cohost/bus";
import { createLogger, loadConfig, urls } from "@cohost/config";
import { EarsHealth, earsPlan, idleDetail, readEarsToken } from "./health.js";
import { sttTranscriber } from "./hearing.js";
import { createInjectHandler } from "./inject.js";
import { EARS_LOOP_TYPES, createEarsHandler, stopEars, subscribeEars } from "./session.js";

const log = createLogger("ears");
const cfg = loadConfig();
const bus = new Bus("ears", log);
const earsToken = readEarsToken();
const plan = earsPlan(cfg.ears.source, earsToken.hasToken);
let voiceReady = false;
const health = new EarsHealth(plan, () => voiceReady);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });

// Injected clips only need the STT service, so this works in every plan (off / no-token / discord).
const onInject = createInjectHandler({ bus, log, dashboardUrl: urls.dashboard(), transcribe: health.track(sttTranscriber(cfg.ears)) });

const fatal = (err: unknown): never => { log.error({ err }, "fatal"); process.exit(1); };

// @spec EARS-START-004
if (plan === "discord") {
  // discord.js and friends are only loaded when a session will actually be opened.
  const { startDiscord } = await import("./discord.js");
  // Subscribes to the bus before joining voice; `ready` is signalled once the voice connection is Ready.
  const session = await startDiscord({
    cfg, bus, log, health, heartbeat, onInject, token: earsToken.token,
    setVoiceReady: (v) => { voiceReady = v; },
  }).catch(fatal);
  // One shutdown sequence: voice connection and client, then the bus.
  // @spec EARS-SESS-008, EARS-START-005
  onShutdown(() => stopEars({ session, bus, log }), log);
} else {
  // @spec EARS-START-003, EARS-INJ-009, EARS-START-006
  // Idle: no Discord client; only inject.request is consumed, process stays up.
  await subscribeEars(bus, EARS_LOOP_TYPES, createEarsHandler({ onInject: (ev: BusEvent<"inject.request">) => onInject(ev) }), log).catch(fatal);
  // @spec EARS-START-001
  if (plan === "off") {
    log.warn("ears.source is off: idle, no Discord client, nothing heard (mode off)");
    heartbeat.ready();
  } else {
    // @spec EARS-START-002, EARS-START-007
    const detail = idleDetail(earsToken);
    log.error(`${detail}; ears is idle (no Discord client)`);
    heartbeat.degraded(detail);
  }
  const timer = setInterval(() => {
    if (plan === "no-token") log.warn(`${idleDetail(earsToken)}; ears still idle`);
  }, 60_000);
  // @spec EARS-START-005
  onShutdown(() => stopEars({ idleTimer: timer, bus, log }), log);
}
