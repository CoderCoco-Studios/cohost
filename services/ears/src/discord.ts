import { Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import {
  createAudioPlayer, createAudioResource, EndBehaviorType, entersState, joinVoiceChannel,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { Readable } from "node:stream";
import type { Bus, Heartbeat, BusEvent } from "@cohost/bus";
import { join as joinPath } from "node:path";
import { dataDir, env, urls, type Config, type Logger } from "@cohost/config";
import { createJoiner } from "@cohost/shared";
import { Hearing, sttTranscriber } from "./hearing.js";
import { ClipCache, ClipMirror, FallbackLine, startClipSync } from "./fallback.js";
import { Playback, httpAudio } from "./playback.js";
import type { EarsHealth } from "./health.js";
import { DISCORD_LOOP_TYPES, createEarsHandler, subscribeEars, voiceTarget } from "./session.js";

export interface DiscordDeps {
  cfg: Config;
  bus: Bus;
  log: Logger;
  health: EarsHealth;
  heartbeat: Heartbeat;
  setVoiceReady(ready: boolean): void;
  isVoiceReady(): boolean;
  /** Handles `inject.request` (shares the `ears` consumer group, so it must be subscribed here). */
  onInject: (ev: BusEvent<"inject.request">) => Promise<void>;
}

/** A running Discord session; `stop` tears down the voice connection and the client. */
export interface DiscordSession {
  stop(): Promise<void>;
}

/**
 * The Discord session: handles the bus first, then joins the voice channel (retrying until it
 * succeeds), transcribes speakers and plays `voice.utterance`. Only loaded for `ears.source:
 * discord` with a token. The caller owns shutdown: it calls `stop()` and then stops the bus.
 */
export async function startDiscord(deps: DiscordDeps): Promise<DiscordSession> {
  const { cfg, bus, log, health } = deps;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
  const player = createAudioPlayer();
  let connection: VoiceConnection | undefined;
  const listening = new Set<string>();
  const hearing = new Hearing({ cfg: cfg.ears, bus, log, transcribe: health.track(sttTranscriber(cfg.ears)) });
  // The spoken fallback line: ears' own clip cache (memory + disk mirror), refreshed from voice's HTTP routes.
  const clipCache = new ClipCache();
  const fallback = new FallbackLine({ cache: clipCache, minIntervalMs: cfg.ears.fallback.min_interval_ms });
  const playback = new Playback({
    bus, log, fallback, fetchAudio: httpAudio,
    play: (pcm) => player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })),
  });

  // @spec EARS-HEAR-001, EARS-HEAR-002, EARS-HEAR-003
  function listenTo(userId: string, channel: VoiceBasedChannel) {
    if (!connection || listening.has(userId)) return;
    listening.add(userId);
    const receiver = connection.receiver;
    const member = channel.guild.members.cache.get(userId);
    const name = member?.displayName ?? userId;

    const start = () => {
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
    };
    start();
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
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy(); // a half-open connection would block the retry
      connection = undefined;
      throw err;
    }
    connection.subscribe(player);
    deps.setVoiceReady(true);
    deps.heartbeat.ready();
    log.info({ channel: channel.name }, "joined voice");

    // @spec EARS-HEAR-001
    connection.receiver.speaking.on("start", (userId) => {
      if (userId === client.user?.id) return;
      listenTo(userId, channel);
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

  // ---- playback
  // @spec EARS-PLAY-004
  player.on(AudioPlayerStatus.Idle, () => void playback.onIdle());
  // @spec EARS-PLAY-007
  player.on("error", (err) => log.warn({ err: err.message }, "player error"));

  // Bus handling starts before the join and does not depend on it (injection works whether or not the join succeeds).
  // One loop for the whole `ears` group: two loops with different type filters would drop each other's events.
  // @spec EARS-PLAY-001, EARS-INJ-007, EARS-START-006, EARS-FALL-010
  await subscribeEars(
    bus,
    DISCORD_LOOP_TYPES,
    createEarsHandler({ onInject: deps.onInject, playback, isVoiceReady: deps.isVoiceReady, log, claims: fallback }),
    log,
  );

  // @spec EARS-FALL-012, EARS-FALL-014, EARS-FALL-018
  const clipSync = startClipSync({ baseUrl: urls.voice(), cache: clipCache, mirror: new ClipMirror(joinPath(dataDir(), "ears", "fallback-clips")), log });

  client.once("ready", () => {
    log.info({ user: client.user?.tag }, "discord ready");
    void joiner.run().catch((err) => log.error({ err }, "voice join loop failed"));
  });

  // @spec EARS-SESS-001
  client.login(env("DISCORD_TOKEN")).catch((err) => { log.error({ err }, "discord login failed"); process.exit(1); });

  return {
    // @spec EARS-SESS-008
    async stop() {
      stopped = true;
      clipSync.stop();
      connection?.destroy();
      await client.destroy();
    },
  };
}
