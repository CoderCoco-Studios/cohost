import { GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import prism from "prism-media";
import type { Bus, BusEvent } from "@cohost/bus";
import type { Heartbeat } from "@cohost/shared";
import type { Config, Logger } from "@cohost/config";
import { createDiscordVoiceSession as defaultCreateSession } from "@cohost/shared/discord-voice";
import { Hearing } from "./hearing.js";
import { EARS_JOIN_OPTIONS, EARS_LOOP_TYPES, createEarsHandler, isHumanSpeaker, subscribeEars, voiceTarget } from "./session.js";

export interface DiscordDeps {
  cfg: Config;
  bus: Bus;
  log: Logger;
  heartbeat: Heartbeat;
  /** The listening bot's token (`EARS_DISCORD_TOKEN`); never `DISCORD_TOKEN`. */
  token: string;
  setVoiceReady(ready: boolean): void;
  /** Handles `inject.request` (shares the `ears` consumer group, so it must be subscribed here). */
  onInject: (ev: BusEvent<"inject.request">) => void | Promise<void>;
  /** The tracked transcriber (real or stub), shared with injection. */
  transcribe: (audio: Buffer, hint?: { contentType: string }) => Promise<string>;
  /** Replacement for tests: the shared Discord voice session. */
  createSession?: typeof defaultCreateSession;
}

/** A running Discord session; `stop` tears down the voice connection and the client. */
export interface DiscordSession {
  stop(): Promise<void>;
}

/**
 * The Discord session: handles the bus first, then logs in as ears' own bot, joins the voice channel self-muted
 * (retrying until it succeeds) and transcribes each human speaker. Only loaded for `ears.source: discord` with a usable
 * token. The caller owns shutdown: it calls `stop()` and then stops the bus.
 */
export async function startDiscord(deps: DiscordDeps): Promise<DiscordSession> {
  const { cfg, bus, log } = deps;
  let connection: VoiceConnection | undefined;
  const listening = new Set<string>();
  const hearing = new Hearing({ cfg: cfg.ears, bus, log, transcribe: deps.transcribe });

  // @spec EARS-HEAR-001, EARS-HEAR-002, EARS-HEAR-003
  function listenTo(userId: string, channel: VoiceBasedChannel) {
    if (!connection || listening.has(userId)) return;
    listening.add(userId);
    const receiver = connection.receiver;
    const member = channel.guild.members.cache.get(userId);
    const name = member?.displayName ?? userId;

    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: cfg.ears.silence_ms } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    opus.pipe(decoder);
    decoder.on("data", (c: Buffer) => chunks.push(c));
    decoder.on("end", () => {
      listening.delete(userId);
      void hearing.heard(Buffer.concat(chunks), name, userId);
    });
    decoder.on("error", (err: Error) => { listening.delete(userId); log.warn({ err: err.message }, "decoder error"); });
  }

  // The connection itself (join, retry, rejoin on disconnect) is the shared Discord voice session; ears only attaches its
  // receiver and reports what the heartbeat needs.
  // @spec EARS-SESS-002, EARS-SESS-003, EARS-SESS-004, EARS-SESS-007, EARS-SESS-010, CFG-USR-005
  const session = (deps.createSession ?? defaultCreateSession)({
    token: deps.token,
    guildId: () => voiceTarget(cfg.ears.discord).guildId,
    channelId: () => voiceTarget(cfg.ears.discord).channelId,
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
    ...EARS_JOIN_OPTIONS,
    join: { baseMs: 5000, maxMs: 60_000 },
    fetchMembers: true,
    log,
    onConnected(conn, { client, channel }) {
      connection = conn;
      deps.setVoiceReady(true);
      deps.heartbeat.ready();
      // @spec EARS-HEAR-001
      conn.receiver.speaking.on("start", (userId) => {
        if (listening.has(userId)) return;
        void isHumanSpeaker(userId, client.users).then((human) => {
          if (human) listenTo(userId, channel);
        });
      });
    },
    onDisconnected: () => deps.setVoiceReady(false),
    onJoinFailed(err) {
      deps.setVoiceReady(false);
      deps.heartbeat.degraded(`voice join failed: ${String(err)}`);
    },
  });

  // Bus handling starts before the join and does not depend on it (injection works whether or not the join succeeds).
  // @spec EARS-INJ-007, EARS-START-003, EARS-START-006
  await subscribeEars(bus, EARS_LOOP_TYPES, createEarsHandler({ onInject: deps.onInject }), log);

  // @spec EARS-SESS-001, EARS-SESS-009
  // A failed login is fatal: the error propagates to `runService`, which exits with status 1.
  await session.start().catch((err) => { log.error({ err }, "discord login failed"); throw err; });

  // @spec EARS-SESS-008
  return { stop: () => session.stop() };
}
