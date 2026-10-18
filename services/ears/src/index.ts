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
import { Client, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import {
  createAudioPlayer, createAudioResource, EndBehaviorType, entersState, joinVoiceChannel,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { Readable } from "node:stream";
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, env, loadConfig, urls } from "@cohost/config";
import { discordPcmToWav16k, wavToDiscordPcm } from "./audio.js";

const log = createLogger("ears");
const cfg = loadConfig();
const bus = new Bus("ears", log);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers] });
const player = createAudioPlayer();
let connection: VoiceConnection | undefined;
const listening = new Set<string>();
const queue: { id: string; url: string }[] = [];
let current: string | undefined;

async function transcribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", cfg.ears.stt_model);
  form.append("language", "en");
  form.append("response_format", "json");
  const res = await fetch(`${urls.stt()}/v1/audio/transcriptions`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

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
    const t0 = Date.now();
    opus.pipe(decoder);
    decoder.on("data", (c: Buffer) => chunks.push(c));
    decoder.on("end", async () => {
      listening.delete(userId);
      const pcm = Buffer.concat(chunks);
      const durationMs = (pcm.length / 4 / 48000) * 1000;
      if (durationMs < cfg.ears.min_speech_ms) return;
      try {
        const text = await transcribe(discordPcmToWav16k(pcm));
        if (!text || /^\W*$/.test(text)) return;
        log.info({ speaker: name, durationMs: Math.round(durationMs), text }, "heard");
        await bus.publish("speech.heard", { speaker: name, speakerId: userId, text, durationMs: Math.round(durationMs) });
      } catch (err) {
        log.warn({ err: String(err) }, "transcription failed");
      } finally {
        void t0;
      }
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
      log.warn("voice disconnected, rejoining in 5s");
      connection?.destroy();
      setTimeout(() => void join().catch((e) => log.error({ e }, "rejoin failed")), 5000);
    }
  });
}

// ---- playback
async function pump() {
  if (current || queue.length === 0) return;
  const next = queue.shift()!;
  current = next.id;
  try {
    const res = await fetch(next.url);
    if (!res.ok) throw new Error(`fetch audio ${res.status}`);
    const pcm = wavToDiscordPcm(Buffer.from(await res.arrayBuffer()));
    player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }));
    await bus.publish("voice.playing", { id: next.id, sink: "discord" });
  } catch (err) {
    log.warn({ err: String(err) }, "playback failed");
    current = undefined;
    void pump();
  }
}
player.on(AudioPlayerStatus.Idle, () => {
  if (current) { void bus.publish("voice.done", { id: current, sink: "discord" }); current = undefined; }
  void pump();
});
player.on("error", (err) => log.warn({ err: err.message }, "player error"));

client.once("ready", async () => {
  log.info({ user: client.user?.tag }, "discord ready");
  await join();
  void bus.subscribe({ group: "ears", types: ["voice.utterance"], fromNow: true }, (ev: BusEvent) => {
    const d = ev.data as BusEvent<"voice.utterance">["data"];
    queue.push({ id: d.id, url: d.audioUrl });
    void pump();
  });
});

client.login(env("DISCORD_TOKEN")).catch((err) => { log.error({ err }, "discord login failed"); process.exit(1); });
onShutdown(async () => { connection?.destroy(); await client.destroy(); bus.stop(); });
