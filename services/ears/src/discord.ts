import { Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import {
  createAudioPlayer, createAudioResource, EndBehaviorType, entersState, joinVoiceChannel,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { Readable } from "node:stream";
import { onShutdown, type Bus, type Heartbeat, type BusEvent } from "@cohost/bus";
import { env, type Config, type Logger } from "@cohost/config";
import { Hearing, sttTranscriber } from "./hearing.js";
import { Playback, httpAudio } from "./playback.js";
import type { EarsHealth } from "./health.js";

export interface DiscordDeps {
  cfg: Config;
  bus: Bus;
  log: Logger;
  health: EarsHealth;
  heartbeat: Heartbeat;
  setVoiceReady(ready: boolean): void;
  /** Handles `inject.request` (shares the `ears` consumer group, so it must be subscribed here). */
  onInject: (ev: BusEvent<"inject.request">) => Promise<void>;
}

/** The Discord session: joins the voice channel, transcribes speakers, plays `voice.utterance`. Only loaded for `ears.source: discord` with a token. */
export function startDiscord(deps: DiscordDeps): void {
  const { cfg, bus, log, health } = deps;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
  const player = createAudioPlayer();
  let connection: VoiceConnection | undefined;
  const listening = new Set<string>();
  const hearing = new Hearing({ cfg: cfg.ears, bus, log, transcribe: health.track(sttTranscriber(cfg.ears)) });
  const playback = new Playback({
    bus, log, fetchAudio: httpAudio,
    play: (pcm) => player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })),
  });

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

  async function join() {
    const guild = await client.guilds.fetch(env("DISCORD_GUILD_ID"));
    const channel = (await guild.channels.fetch(env("DISCORD_VOICE_CHANNEL_ID"))) as VoiceBasedChannel | null;
    if (!channel?.isVoiceBased()) throw new Error("DISCORD_VOICE_CHANNEL_ID is not a voice channel");
    await guild.members.fetch().catch(() => undefined);

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connection.subscribe(player);
    deps.setVoiceReady(true);
    deps.heartbeat.ready();
    log.info({ channel: channel.name }, "joined voice");

    connection.receiver.speaking.on("start", (userId) => {
      if (userId === client.user?.id) return;
      listenTo(userId, channel);
    });
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
        setTimeout(() => void join().catch((e) => log.error({ e }, "rejoin failed")), 5000);
      }
    });
  }

  // ---- playback
  player.on(AudioPlayerStatus.Idle, () => void playback.onIdle());
  player.on("error", (err) => log.warn({ err: err.message }, "player error"));

  client.once("ready", async () => {
    log.info({ user: client.user?.tag }, "discord ready");
    await join();
    // One loop for the whole `ears` group: two loops with different type filters would drop each other's events.
    void bus.subscribe({ group: "ears", types: ["voice.utterance", "inject.request"], fromNow: true }, async (ev: BusEvent) => {
      if (ev.type === "inject.request") return deps.onInject(ev as BusEvent<"inject.request">);
      const d = ev.data as BusEvent<"voice.utterance">["data"];
      void playback.enqueue(d.id, d.audioUrl);
    });
  });

  client.login(env("DISCORD_TOKEN")).catch((err) => { log.error({ err }, "discord login failed"); process.exit(1); });
  onShutdown(async () => { connection?.destroy(); await client.destroy(); });
}
