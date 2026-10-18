import { z } from "zod";

export const Emotion = z.enum([
  "neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think",
]);
export type Emotion = z.infer<typeof Emotion>;
export const EMOTIONS = Emotion.options;

export const ConfigSchema = z.object({
  cohost: z.object({
    name: z.string().min(1),
    streamer: z.string().min(1),
    timezone: z.string().default("UTC"),
  }),
  llm: z.object({
    model: z.string().min(1),
    num_ctx: z.number().int().positive().default(8192),
    temperature: z.number().min(0).max(2).default(0.9),
    max_tokens: z.number().int().positive().default(120),
    embed_model: z.string().min(1),
  }),
  vision: z.object({
    enabled: z.boolean().default(false),
    model: z.string().min(1),
    interval_ms: z.number().int().positive().default(8000),
    obs: z.object({
      host: z.string().default("host.docker.internal"),
      port: z.number().int().default(4455),
      password: z.string().default(""),
      source: z.string().default("Game Capture"),
      width: z.number().int().positive().default(896),
    }),
  }),
  chat: z.object({
    twitch: z.object({ channel: z.string().default("") }),
    ignore_users: z.array(z.string()).default([]),
    ignore_prefixes: z.array(z.string()).default(["!"]),
  }),
  brain: z.object({
    tick_ms: z.number().int().positive().default(1500),
    cooldown_ms: z.number().int().nonnegative().default(6000),
    idle_chatter_ms: z.number().int().nonnegative().default(90000),
    reply_on_mention: z.boolean().default(true),
    max_context_events: z.number().int().positive().default(24),
    memory: z.object({
      recall_k: z.number().int().nonnegative().default(6),
      min_similarity: z.number().min(0).max(1).default(0.35),
    }),
  }),
  voice: z.object({
    engine: z.enum(["kokoro"]).default("kokoro"),
    voice: z.string().default("af_heart"),
    speed: z.number().positive().default(1),
    sample_rate: z.number().int().positive().default(24000),
  }),
  avatar: z.object({
    driver: z.enum(["vtube-studio", "vmc", "null"]).default("null"),
    fps: z.number().int().positive().default(30),
    smoothing: z.number().min(0).max(1).default(0.25),
    idle_motion: z.boolean().default(true),
    vtube_studio: z.object({
      host: z.string(),
      port: z.number().int(),
      plugin_name: z.string().default("cohost"),
      plugin_developer: z.string().default("cohost"),
    }),
    vmc: z.object({ host: z.string(), port: z.number().int() }),
  }),
  ears: z.object({
    discord: z.object({
      guild_id: z.string().default(""),
      voice_channel_id: z.string().default(""),
    }),
    silence_ms: z.number().int().positive().default(700),
    min_speech_ms: z.number().int().positive().default(400),
    stt_model: z.string().default("Systran/faster-whisper-small"),
  }),
  dashboard: z.object({ port: z.number().int().default(3000) }),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Per-driver expression map: canonical emotion -> app-specific name, plus gestures. */
export const ExpressionMapSchema = z.record(
  z.string(),
  z
    .object({ gestures: z.record(z.string(), z.string()).default({}) })
    .catchall(z.string()),
);
export type ExpressionMap = z.infer<typeof ExpressionMapSchema>;
