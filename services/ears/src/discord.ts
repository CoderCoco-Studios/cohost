import { Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import {
  EndBehaviorType, entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import type { Bus, Heartbeat, BusEvent } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { createJoiner } from "@cohost/shared";
import { Hearing, sttTranscriber } from "./hearing.js";
import type { EarsHealth } from "./health.js";
import { EARS_JOIN_OPTIONS, EARS_LOOP_TYPES, createEarsHandler, isHumanSpeaker, subscribeEars, voiceTarget } from "./session.js";

export interface DiscordDeps {
  cfg: Config;
  bus: Bus;
  log: Logger;
  health: EarsHealth;
  heartbeat: Heartbeat;
  /** The listening bot's token (`EARS_DISCORD_TOKEN`); never `DISCORD_TOKEN`. */
  token: string;
  setVoiceReady(ready: boolean): void;
  /** Handles `inject.request` (shares the `ears` consumer group, so it must be subscribed here). */
  onInject: (ev: BusEvent<"inject.request">) => Promise<void>;
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
  const { cfg, bus, log, health } = deps;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
  let connection: VoiceConnection | undefined;
  const listening = new Set<string>();
  const hearing = new Hearing({ cfg: cfg.ears, bus, log, transcribe: health.track(sttTranscriber(cfg.ears)) });

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

  let stopped = false;

  // @spec EARS-SESS-002, EARS-SESS-003, EARS-SESS-004, EARS-SESS-007, CFG-USR-005
  async function join() {
    const target = voiceTarget(cfg.ears.discord);
    const guild = await client.guilds.fetch(target.guildId);
    const channel = (await guild.channels.fetch(target.channelId)) as VoiceBasedChannel | null;
    if (!channel?.isVoiceBased()) throw new Error("ears.discord.voice_channel_id is not a voice channel");
    await guild.members.fetch().catch(() => undefined);

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      ...EARS_JOIN_OPTIONS,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy(); // a half-open connection would block the retry
      connection = undefined;
      throw err;
    }
    deps.setVoiceReady(true);
    deps.heartbeat.ready();
    log.info({ channel: channel.name }, "joined voice");

    // @spec EARS-HEAR-001
    connection.receiver.speaking.on("start", (userId) => {
      if (listening.has(userId)) return;
      void isHumanSpeaker(userId, client.users).then((human) => {
        if (human) listenTo(userId, channel);
      });
    });
    // @spec EARS-SESS-005
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        deps.setVoiceReady(false);
        log.warn("voice disconnected, rejoining in 5s");
        connection?.destroy();
        void joiner.run(5000);
      }
    });
  }

  // @spec EARS-SESS-006
  const joiner = createJoiner({
    join,
    isStopped: () => stopped,
    onFailure: (err, attempt) => {
      deps.setVoiceReady(false);
      log.warn({ err: String(err), attempt }, "voice join failed, retrying");
      deps.heartbeat.degraded(`voice join failed: ${String(err)}`);
    },
  });

  // Bus handling starts before the join and does not depend on it (injection works whether or not the join succeeds).
  // @spec EARS-INJ-007, EARS-START-003, EARS-START-006
  await subscribeEars(bus, EARS_LOOP_TYPES, createEarsHandler({ onInject: deps.onInject }), log);

  client.once("ready", () => {
    log.info({ user: client.user?.tag }, "discord ready");
    void joiner.run().catch((err) => log.error({ err }, "voice join loop failed"));
  });

  // @spec EARS-SESS-001, EARS-SESS-009
  client.login(deps.token).catch((err) => { log.error({ err }, "discord login failed"); process.exit(1); });

  return {
    // @spec EARS-SESS-008
    async stop() {
      stopped = true;
      connection?.destroy();
      await client.destroy();
    },
  };
}
