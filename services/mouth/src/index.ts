/**
 * mouth — the co-host's speaking module.
 *
 * Plays every `voice.utterance` on the outputs configured under `mouth.outputs` (today one: a Discord bot that sits in a
 * voice channel and speaks there) and reports `voice.playing` / `voice.done` with the output's name as the sink, so the
 * avatar lip-syncs and the brain waits. When a line cannot play it says a short pre-generated fallback line instead.
 *
 * Setup: create a bot at discord.com/developers, invite it with Connect + Speak permissions, set DISCORD_TOKEN and the
 * guild and channel under `mouth.outputs.discord` (DISCORD_GUILD_ID / DISCORD_VOICE_CHANNEL_ID by default).
 * This MUST be a bot account — automating a user account gets it banned.
 */
import { Bus } from "@cohost/bus";
import { onShutdown, startHeartbeat } from "@cohost/shared";
import { createLogger, loadConfig } from "@cohost/config";
import { MouthHealth, mouthPlan, readToken } from "./health.js";
import { startIdle, stopMouth } from "./session.js";

const log = createLogger("mouth");
const cfg = loadConfig();
const bus = new Bus("mouth", log);
const plan = mouthPlan(cfg.mouth.outputs, !!readToken());
let ready = false;
const health = new MouthHealth(plan, cfg.mouth.outputs, () => ready);
const heartbeat = startHeartbeat(bus, { ...health.spec, log });

const fatal = (err: unknown): never => { log.error({ err }, "fatal"); process.exit(1); };

// @spec MOUTH-START-003
if (plan === "discord") {
  // discord.js and friends are only loaded when a session will actually be opened.
  const { startDiscord } = await import("./discord.js");
  // Subscribes to the bus before logging in; `ready` is signalled once the voice connection is Ready.
  const { session, clipSync } = await startDiscord({
    cfg, bus, log, heartbeat,
    setReady: (v) => { ready = v; },
    isReady: () => ready,
  }).catch(fatal);
  // One shutdown sequence: clip refresh, voice connection and client, then the bus.
  // @spec MOUTH-SESS-007
  onShutdown(() => stopMouth({ clipSync, session, bus, log }), log);
} else {
  // @spec MOUTH-START-001, MOUTH-START-002, MOUTH-START-004
  // Idle: no Discord client, no subscription, no clips; the process stays up with an honest heartbeat.
  const idleTimer = startIdle(plan, { log, heartbeat });
  onShutdown(() => stopMouth({ idleTimer, bus, log }), log);
}
