import { z } from "zod";

export const Emotion = z.enum([
  "neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think",
]);
export type Emotion = z.infer<typeof Emotion>;
export const EMOTIONS = Emotion.options;

/**
 * A region's pluggable judgement: built-in rules, a chat model parsed as JSON,
 * or a URL you serve yourself (a model you trained). See packages/modules.
 */
export const ModuleSchema = z.object({
  kind: z.preprocess((v) => v || "rules", z.enum(["rules", "llm", "http"])),
  /** http: POST endpoint. */
  url: z.string().default(""),
  timeout_ms: z.number().int().positive().default(1500),
  /** llm: override the provider/model (e.g. a small local model while the cortex uses Claude). */
  llm: z.object({
    provider: z.preprocess((v) => v || undefined, z.enum(["ollama", "openai", "anthropic", "bedrock"]).optional()),
    model: z.preprocess((v) => v || undefined, z.string().optional()),
  }).default({}).superRefine((v, ctx) => {
    // A model id only means something to one provider; inheriting the cortex's id across providers 404s every call.
    if (v.provider && !v.model) ctx.addIssue({ code: "custom", path: ["model"], message: "required when llm.provider is set on a hook (model ids are provider-specific)" });
  }),
}).default({});
export type ModuleConfig = z.infer<typeof ModuleSchema>;

export const ConfigSchema = z.object({
  cohost: z.object({
    name: z.string().min(1),
    streamer: z.string().min(1),
    timezone: z.string().default("UTC"),
  }),
  /**
   * Which model answers for the co-host. Embeddings always use local Ollama so
   * the memory table's vector size never changes when the chat model does.
   */
  llm: z.object({
    provider: z.preprocess((v) => v || "ollama", z.enum(["ollama", "openai", "anthropic", "bedrock"])),
    /** Model id as the provider names it (ollama tag, OpenAI-style id, claude-opus-5-5, anthropic.claude-opus-5-5 ...). */
    model: z.string().min(1),
    num_ctx: z.number().int().positive().default(8192),
    /** ollama + openai only; Claude models no longer take sampling parameters. */
    temperature: z.number().min(0).max(2).default(0.9),
    /** ollama + openai: reply length cap. */
    max_tokens: z.number().int().positive().default(120),
    embed_model: z.string().min(1),
    openai: z.object({
      base_url: z.string().default("https://api.openai.com/v1"),
      api_key: z.string().default(""),
    }).default({}),
    /** Shared by provider=anthropic and provider=bedrock. */
    claude: z.object({
      /** Claude API key; leave empty to use ANTHROPIC_API_KEY or an `ant auth login` profile. */
      api_key: z.string().default(""),
      /** Thinking depth. "low" is right for one-line chat replies. */
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
      /** Caps thinking + reply together, so it must be roomier than max_tokens above. */
      max_tokens: z.number().int().min(256).default(2048),
      /** Claude API only: re-run on another Claude model if a safety classifier declines. */
      fallbacks: z.boolean().default(true),
    }).default({}),
    bedrock: z.object({
      /** Empty = AWS_REGION / AWS_DEFAULT_REGION from the environment. */
      region: z.string().default(""),
    }).default({}),
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
  /**
   * The brain is several containers ("regions") that only talk over the bus:
   * salience (when to speak + reflexes), affect (mood), memory (hippocampus),
   * cortex (what to say). Each has its own knobs; they share working_memory_events.
   */
  brain: z.object({
    /** Recent events each region keeps as its working memory / prompt window. */
    working_memory_events: z.number().int().positive().default(24),
    salience: z.object({
      tick_ms: z.number().int().positive().default(1500),
      cooldown_ms: z.number().int().nonnegative().default(6000),
      idle_chatter_ms: z.number().int().nonnegative().default(90000),
      reply_on_mention: z.boolean().default(true),
      /** Summed event score needed to speak. */
      speak_threshold: z.number().min(0).default(0.6),
      /** How much a high-arousal mood lowers the threshold (0 = ignore mood). */
      arousal_bias: z.number().min(0).max(1).default(0.2),
      /** How events are scored: rules | llm | http. */
      module: ModuleSchema,
      /** Fast path: no LLM, canned line, fires the instant a matching event arrives. */
      reflexes: z
        .array(
          z.object({
            /** Regex (case-insensitive) tested against the event text. */
            match: z.string().min(1).refine((m) => { try { new RegExp(m, "i"); return true; } catch { return false; } }, { message: "not a valid regular expression" }),
            /** Which senses this reflex listens to. */
            on: z.array(z.enum(["chat", "speech", "vision"])).default(["chat", "speech", "vision"]),
            /** One is picked at random. */
            say: z.array(z.string().min(1)).min(1),
            emotion: Emotion.default("surprised"),
            gesture: z.string().optional(),
            cooldown_ms: z.number().int().nonnegative().default(30000),
          }),
        )
        .default([]),
    }).default({}),
    affect: z.object({
      /** How often affect.state is published while it's changing. */
      publish_ms: z.number().int().positive().default(2000),
      /** Time for a mood swing to fade halfway back to baseline. */
      half_life_ms: z.number().int().positive().default(45000),
      /** Resting valence (-1..1). A sunny co-host sits above 0. */
      baseline_valence: z.number().min(-1).max(1).default(0.15),
      /** How a line of chat/speech moves the mood: rules | llm | http. */
      module: ModuleSchema,
    }).default({}),
    memory: z.object({
      recall_k: z.number().int().nonnegative().default(6),
      min_similarity: z.number().min(0).max(1).default(0.35),
    }).default({}),
    cortex: z.object({
      /** How long to wait for the memory region before answering without it. */
      recall_timeout_ms: z.number().int().positive().default(2500),
      /** Give up on a stuck utterance / voice sink after this long. */
      speaking_timeout_ms: z.number().int().positive().default(20000),
      /** Inhibition: a check on each reply before it's spoken. rules = pass-through. */
      critic: ModuleSchema,
    }).default({}),
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
