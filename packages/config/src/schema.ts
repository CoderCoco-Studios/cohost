import { z } from "zod";
import { isLanEntry } from "./egress.js";

// @spec CFG-SCH-007
export const Emotion = z.enum([
  "neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think",
]);
export type Emotion = z.infer<typeof Emotion>;

/** Kokoro-FastAPI voice-name syntax (its VOICE_NAME_BODY): ids and `+` mixes with optional `(weight)`. */
const KOKORO_VOICE = /^[a-zA-Z0-9_][a-zA-Z0-9_+\-(). ]*$/;
/** A string key with a default: an empty string means "use the default". */
// @spec CFG-SCH-024
const str = (def: string) => z.preprocess((v) => (v === "" ? undefined : v), z.string().default(def));

/**
 * Dotted paths (from the config root) of the credentials (CFG-SEC-003): the seventeen wildcard-free keys and
 * `tools.servers.*.token`, where one `*` segment matches exactly one key of the map `config.yaml` holds there (CFG-SEC-016).
 * They live in `secrets.yaml` (the loader merges them there and ignores any value `config.yaml` holds at one), the settings
 * editor never shows or writes them, and a section's `secrets` list is derived from this one list.
 */
// @spec CFG-SEC-003, CFG-SEC-016, MOD-CFG-002
export const SECRET_PATHS: readonly string[] = [
  "llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key", "vision.obs.password",
  "ears.http.token", "ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key", "voice.openai.api_key", "voice.pocket.hf_token",
  "chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.access_token", "chat.twitch.refresh_token",
  "chat.youtube.api_key", "connections.discord.token", "tools.servers.*.token",
];

/** Whether a dotted path matches a secret path: a `*` segment matches one non-empty key, and the segment counts are equal. */
// @spec CFG-SEC-016
export function secretPathMatches(path: string, pattern: string): boolean {
  const a = path.split(".");
  const b = pattern.split(".");
  return a.length === b.length && b.every((seg, i) => (seg === "*" ? a[i] !== "" : seg === a[i]));
}

/** The secret path (CFG-SEC-003) a dotted path matches, or undefined when it is not a credential. */
// @spec CFG-SEC-016
export const secretPathOf = (path: string): string | undefined => SECRET_PATHS.find((p) => secretPathMatches(path, p));

/** Whether a dotted path is a proper prefix of some secret path, so a mapping may sit there (`llm`, `tools.servers`, ...). */
export function isSecretPrefix(path: string): boolean {
  const a = path.split(".");
  return SECRET_PATHS.some((p) => {
    const b = p.split(".");
    return b.length > a.length && a.every((seg, i) => b[i] === "*" ? seg !== "" : b[i] === seg);
  });
}

export const EMOTIONS = Emotion.options;

/**
 * `{}` as the input of an object that holds a `z.preprocess` key: zod 4 types that key's input as `unknown`, so it is
 * required in the input type, although the preprocess step turns the missing key into the default at run time.
 */
const EMPTY_INPUT = {} as never;

/**
 * A region's pluggable judgement: built-in rules, a chat model parsed as JSON,
 * or a URL you serve yourself (a model you trained). See packages/modules.
 */
// @spec CFG-SCH-003, CFG-SCH-009
export const ModuleSchema = z.object({
  kind: z.preprocess((v) => v || "rules", z.enum(["rules", "llm", "http"])),
  /** http: POST endpoint. */
  url: z.string().default(""),
  timeout_ms: z.number().int().positive().default(8000),
  /** llm: override the provider/model (e.g. a small local model while the cortex uses Claude). */
  llm: z.object({
    provider: z.preprocess((v) => v || undefined, z.enum(["ollama", "openai", "anthropic", "bedrock"]).optional()),
    model: z.preprocess((v) => v || undefined, z.string().optional()),
  }).prefault({}).superRefine((v, ctx) => {
    // A model id only means something to one provider; inheriting the cortex's id across providers 404s every call.
    if (v.provider && !v.model) ctx.addIssue({ code: "custom", path: ["model"], message: "required when llm.provider is set on a hook (model ids are provider-specific)" });
  }),
}).prefault(EMPTY_INPUT);
// @spec CFG-SCH-027
export type ModuleConfig = z.infer<typeof ModuleSchema>;

/** Default `vision.prompt`: one sentence for a co-host, and the exact `SAME` reply eyes parses as "nothing changed". */
export const DEFAULT_VISION_PROMPT =
  "You watch a live video game stream through a screenshot. Reply with ONE short sentence describing what is happening " +
  "that a co-host would care about: the game, the situation, anything dramatic, funny, or new (menus, deaths, wins, chat on screen). " +
  "No preamble. If nothing meaningful changed versus the previous description, reply exactly: SAME";

// @spec CFG-SCH-001, CFG-SCH-006, CFG-SCH-008, CFG-SCH-010, CFG-SCH-011, CFG-SCH-012, CFG-SCH-013, CFG-SCH-037, CFG-SCH-039, CFG-ISO-001, CFG-ISO-002, CFG-ISO-003, CFG-ISO-005
/** A listening source name: `http`, `dir` or a connector source tag (CONN-TAG-001). */
const EARS_SOURCE_TAG = /^[a-z][a-z0-9-]{0,31}$/;

/** A TCP port. */
const PORT = z.number().int().min(1).max(65535);

/** A Discord id: a string, because a YAML number cannot hold 19 digits without losing some (CFG-SCH-040). */
// @spec CFG-SCH-040
const DISCORD_ID = z
  .string({ error: (iss) => (typeof iss.input === "number" ? "write the id in quotes: a YAML number cannot hold a 19-digit id without losing digits" : undefined) })
  .default("");

/** An optional `http` or `https` URL: blank is allowed and stays blank (CFG-SCH-024). */
/** An absolute `http` or `https` URL with a host (the form a request is sent to). */
const isHttpUrl = (u: string): boolean => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol);
const optionalUrl = (message: string) => z.string().refine((u) => u === "" || isHttpUrl(u), message);

/** The name of a `.vrm` model file: a letter or digit first, then letters, digits, spaces, dots, underscores or hyphens, ending in `.vrm` (CFG-SCH-098). The model store reuses it. */
export const RENDERER_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*\.vrm$/;

/** A DNS host name as `dashboard.allowed_hosts` lists it: labels of letters, digits and hyphens or underscores, dots between, optionally ending in a dot. */
const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?\.?$/;

/** Pocket catalogue voice names: letters, digits, `_` and `-`. */
const POCKET_VOICE = /^[A-Za-z0-9_-]+$/;

/**
 * The voice of `voice.engine`: blank resolves to the engine's own voice (`af_heart` under kokoro, `alba` under pocket; stub
 * keeps Kokoro's default), a non-blank value must be in the engine's form, and openai takes any non-blank text.
 */
// @spec CFG-SCH-056, CFG-SCH-057, CFG-SCH-029
function resolveVoice(engine: string, voice: string, ctx: z.RefinementCtx): string {
  if (engine === "openai") return voice;
  if (engine === "pocket") {
    if (voice === "") return "alba";
    if (POCKET_VOICE.test(voice) || isHttpUrl(voice)) return voice;
    ctx.addIssue({ code: "custom", path: ["voice"], message: "must be a Pocket voice name (letters, digits, _ and -) or an http or https URL" });
    return voice;
  }
  if (voice === "" || engine === "stub") return voice === "" ? "af_heart" : voice; // stub calls no voice server: any text
  if (KOKORO_VOICE.test(voice)) return voice;
  ctx.addIssue({ code: "custom", path: ["voice"], message: "must be a Kokoro voice name or mix, such as af_heart or af_bella(2)+af_sky" });
  return voice;
}

/** A `tools.servers` key: the server's name, which carries no `_` so that `__` can separate a server from its tool (CFG-SCH-083). */
const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** A `tools.allow` key: a tool's name as the catalogue spells it (CFG-SCH-089). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** An HTTP header name (RFC 9110 token characters); blank is allowed and means `Authorization` (CFG-SCH-087). */
const HTTP_HEADER = /^(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+)?$/;
/** Query parameter names that suggest a credential; a server URL holding one loads with a warning (CFG-SCH-086). */
export const CREDENTIAL_QUERY_NAMES: readonly string[] = ["key", "token", "api_key", "apikey", "secret", "auth", "password", "access_token"];

/**
 * An MCP server URL: http or https, with no user name or password (CFG-SCH-084, CFG-SCH-085). The message never quotes the
 * value, which may hold a host name the owner does not want in a log.
 */
const isServerUrl = (u: string): boolean => {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
};

const TOOL_FILLER_LINES = ["Let me check.", "Hold on, let me look.", "One sec, checking.", "Hang on, looking that up.", "Give me a moment.", "Let me see."];

/** A `tools.servers` entry (CFG-SCH-084 to CFG-SCH-088). */
// @spec CFG-SCH-084, CFG-SCH-085, CFG-SCH-087, CFG-SCH-088
const ToolServerSchema = z.object({
  url: z.string().refine(isServerUrl, "must be an http or https URL with no user name or password"),
  /** A blank header means `Authorization` (TOOL-MCP-005). */
  header: z.string().regex(HTTP_HEADER, "must be a valid HTTP header name, or blank for Authorization").default(""),
  /** The credential, a secret (CFG-SEC-016): merged from `secrets.yaml` at `tools.servers.<name>.token`. */
  token: z.string().default(""),
  /** True forces the server off the LAN whatever its host (CFG-EGR-015). */
  external: z.boolean().default(false),
});

/** A `tools.allow` entry (CFG-SCH-090, CFG-SCH-091): a tool is enabled only when an entry names it. */
// @spec CFG-SCH-090, CFG-SCH-091
const ToolAllowSchema = z
  .object({
    enabled: z.boolean().default(false),
    acts: z.boolean().default(false),
    chat: z.boolean().default(false),
    confirm: z.boolean().default(true),
    hash: z.string().default(""),
    effect: z.enum(["read", "acts", "unlabelled"]).default("read"),
  })
  .superRefine((v, ctx) => {
    if (v.acts && v.chat) ctx.addIssue({ code: "custom", message: "acts and chat cannot both be true: a tool either acts or speaks in chat" });
  });

/** `tools.owner_sources`: the word `all`, or a list of `ears.sources` names (CFG-SCH-082). */
// @spec CFG-SCH-082
const OwnerSourcesSchema = z.any().optional().transform((v, ctx): "all" | string[] => {
  if (v === undefined || v === "all") return "all";
  const list = z.array(z.string().regex(EARS_SOURCE_TAG, "must be all or a list of source names matching [a-z][a-z0-9-]{0,31}")).safeParse(v);
  if (list.success) return list.data;
  if (Array.isArray(v)) for (const issue of list.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  else ctx.addIssue({ code: "custom", message: "must be all or a list of source names" });
  return z.NEVER;
});

/** The `tools` section: MCP servers, the allow list and the reply limits (CFG-SCH-075 to CFG-SCH-095). */
// @spec CFG-SCH-075, CFG-SCH-076, CFG-SCH-077, CFG-SCH-078, CFG-SCH-079, CFG-SCH-080, CFG-SCH-081, CFG-SCH-082, CFG-SCH-083, CFG-SCH-089, CFG-SCH-092, CFG-SCH-093, CFG-SCH-094, CFG-SCH-095
const ToolsSchema = z
  .object({
    /** Blank is live; `mock` runs the tools with canned results and no server (CFG-SCH-076). */
    mode: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["live", "mock"]).default("live")),
    timeout_ms: z.number().int().positive().default(10000),
    confirm_timeout_ms: z.number().int().positive().default(20000),
    max_result_chars: z.number().int().min(64).default(1500),
    max_concurrent: z.number().int().min(1).default(4),
    catalog_ms: z.number().int().min(5000).default(30000),
    max_tools_per_server: z.number().int().min(1).default(32),
    max_tools: z.number().int().min(1).default(64),
    owner_sources: OwnerSourcesSchema,
    servers: z.record(z.string().regex(SERVER_NAME, "must be a lower-case name: a letter, then letters, digits or hyphens, at most 32 characters"), ToolServerSchema).default({}),
    allow: z.record(z.string().regex(TOOL_NAME, "must be a tool name of letters, digits, _ and -, at most 64 characters"), ToolAllowSchema).default({}),
    timer: z.object({
      max_active: z.number().int().min(1).default(5),
      max_minutes: z.number().int().min(1).default(120),
    }).prefault({}),
    stream_info: z.object({
      cache_ms: z.number().int().nonnegative().default(30000),
    }).prefault({}),
    reply: z.object({
      max_rounds: z.number().int().min(1).default(3),
      max_calls: z.number().int().min(1).default(3),
      budget_ms: z.number().int().min(1).default(30000),
      filler_after_ms: z.number().int().nonnegative().default(1500),
      max_tokens: z.number().int().min(1).default(512),
      /** Lines spoken while a tool runs; an empty list says none. */
      filler_lines: z.array(z.string().min(1).max(200)).default(TOOL_FILLER_LINES),
    }).prefault({}),
  })
  .prefault(EMPTY_INPUT);

export const ConfigSchema = z.object({
  cohost: z.object({
    name: z.string().min(1),
    streamer: z.string().min(1),
    timezone: str("UTC"),
  }),
  /**
   * Which model answers for the co-host. Embeddings always use local Ollama so
   * the memory table's vector size never changes when the chat model does.
   */
  // @spec CFG-SCH-002
  llm: z.object({
    /** `mock` is deterministic and offline (isolated runs); opt-in only, never the default. */
    provider: z.preprocess((v) => v || "ollama", z.enum(["ollama", "openai", "anthropic", "bedrock", "mock"])),
    /** Model id as the provider names it (ollama tag, OpenAI-style id, claude-opus-5-5, anthropic.claude-opus-5-5 ...). */
    model: z.string().min(1),
    num_ctx: z.number().int().positive().default(8192),
    /** ollama + openai only; Claude models no longer take sampling parameters. */
    temperature: z.number().min(0).max(2).default(0.9),
    /** ollama + openai: reply length cap. */
    max_tokens: z.number().int().positive().default(120),
    embed_model: z.string().min(1),
    /** Request timeout for chat(), embed() and ping() when the caller passes no AbortSignal. */
    timeout_ms: z.number().int().positive().default(60000),
    openai: z.object({
      base_url: str("https://api.openai.com/v1"),
      api_key: z.string().default(""),
    }).prefault({}),
    /** Shared by provider=anthropic and provider=bedrock. */
    claude: z.object({
      /** Claude API key (a secret, from `secrets.yaml`). */
      api_key: z.string().default(""),
      /** Thinking depth. "low" is right for one-line chat replies. */
      effort: z.preprocess((v) => v || "low", z.enum(["low", "medium", "high", "xhigh", "max"])),
      /** Caps thinking + reply together, so it must be roomier than max_tokens above. */
      max_tokens: z.number().int().min(256).default(2048),
      /** Claude API only: re-run on another Claude model if a safety classifier declines. */
      fallbacks: z.boolean().default(true),
    }).prefault(EMPTY_INPUT),
    bedrock: z.object({
      /** AWS region of the Bedrock endpoint; all three of region, access key id and secret access key are needed. */
      region: z.string().default(""),
      /** Secrets, from `secrets.yaml`. A session token is not supported. */
      access_key_id: z.string().default(""),
      secret_access_key: z.string().default(""),
    }).prefault({}),
  }),
  // @spec CFG-SCH-021
  vision: z.object({
    enabled: z.boolean().default(false),
    /** Describer model id; blank loads whatever `enabled` is (CFG-SCH-025), and eyes reports it as a down dependency. */
    model: z.string().default(""), // @spec CFG-SCH-025
    /** The chat provider that describes frames; `stub` describes images with fixed text and no model call (isolated runs). */
    provider: z.preprocess((v) => v || "ollama", z.enum(["ollama", "openai", "anthropic", "bedrock", "stub"])), // @spec CFG-SCH-001
    /** System prompt of the describe call. It must keep the instruction to reply exactly SAME when nothing changed. */
    prompt: z.preprocess((v) => (typeof v === "string" && v.trim() ? v : undefined), z.string().default(DEFAULT_VISION_PROMPT)),
    temperature: z.number().min(0).max(2).default(0.2),
    /** Longest reply the vision model may write, in tokens. */
    num_predict: z.number().int().positive().default(60),
    /** JPEG quality of the OBS screenshot, 1 to 100. */
    jpeg_quality: z.number().int().min(1).max(100).default(70),
    interval_ms: z.number().int().positive().default(8000),
    /** Describe-call (VLM request) timeout. */
    timeout_ms: z.number().int().positive().default(30000),
    /** Timeout for reading an injected upload from Redis. */
    upload_timeout_ms: z.number().int().positive().default(10000),
    /** Largest injected image accepted (the dashboard's default image upload cap, 8 MiB). */
    upload_max_bytes: z.number().int().positive().default(8388608),
    obs: z.object({
      host: str("host.docker.internal"),
      port: z.number().int().default(4455),
      password: z.string().default(""),
      source: str("Game Capture"),
      width: z.number().int().positive().default(896),
    }),
  }),
  // @spec CFG-SCH-010
  chat: z.object({
    /**
     * The chat sources read at once: `twitch`, `youtube`, and `fake` (scripted/stdin messages, no channel).
     * Absent or null is `[twitch]`; a name listed twice is read once, in first-occurrence order.
     */
    // @spec CFG-SCH-048
    sources: z.preprocess((v) => (v == null ? ["twitch"] : v), z.array(z.enum(["twitch", "youtube", "fake"])).transform((names) => [...new Set(names)])),
    fake: z.object({ interval_ms: z.number().int().positive().default(8000) }).prefault({}),
    // @spec CFG-SCH-054
    twitch: z.object({
      channel: z.string().default(""),
      /** Credentials (secrets, from `secrets.yaml`); the refresh token is required whenever the access token is set. */
      client_id: z.string().default(""),
      client_secret: z.string().default(""),
      access_token: z.string().default(""),
      refresh_token: z.string().default(""),
    }).prefault({}),
    // @spec CFG-SCH-049, CFG-SCH-050, CFG-SCH-051, CFG-SCH-052, CFG-SCH-053
    youtube: z.object({
      /** The video (or live stream) whose chat is read: any string; a value that names no video is a source gap, not a load failure. */
      video: z.string().default(""),
      /** Credential (secret, from `secrets.yaml`, CFG-SEC-003). */
      api_key: z.string().default(""),
      /** `stream` reads the live chat stream; `poll` asks for new messages on an interval. Blank is `stream`. */
      transport: z.preprocess((v) => v || "stream", z.enum(["stream", "poll"])),
      /** The shortest gap between two chat polls, in ms. */
      poll_floor_ms: z.number().int().min(1000).default(12000),
      /** How often the video is rechecked for a live chat, in ms. */
      recheck_ms: z.number().int().min(30000).default(120000),
    }).prefault(EMPTY_INPUT),
    ignore_users: z.array(z.string()).default([]),
    ignore_prefixes: z.array(z.string()).default(["!"]),
  }),
  /**
   * The brain is several containers ("regions") that only talk over the bus:
   * salience (when to speak + reflexes), affect (mood), memory (hippocampus),
   * cortex (what to say). Each has its own knobs; they share working_memory_events.
   */
  // @spec CFG-SCH-005, CFG-SCH-028
  brain: z.object({
    /** Recent events each region keeps as its working memory / prompt window. */
    working_memory_events: z.number().int().positive().default(24),
    /** How many of the co-host's own recent lines the window never evicts; less than `working_memory_events` (the refinement below). */
    working_memory_own_lines: z.number().int().min(1).default(4), // @spec CFG-SCH-045
    /** The longest speech transcript and screen description a consumer takes in. The minimum keeps the truncation mark from being the whole text. */
    // @spec CFG-SCH-044
    input_limits: z.object({
      speech_max_chars: z.number().int().min(16).default(1000),
      vision_max_chars: z.number().int().min(16).default(500),
    }).prefault({}),
    salience: z.object({
      /** The poll: a decision pass every `tick_ms`, the fallback for the speech trigger and the only starter for chat, vision and idle chatter. */
      tick_ms: z.number().int().positive().default(1500),
      /** Whether a final `speech.heard` starts a decision at once instead of waiting for the next poll (CFG-SCH-034, SAL-TRIG-001). */
      trigger_on_speech: z.boolean().default(true),
      /** Stop the voice when someone speaks over the co-host (SAL-BARGE-001); off until live-tested. */
      // @spec CFG-SCH-035
      barge_in: z.boolean().default(false),
      /** Sources whose final speech counts as a barge-in: `http`, `dir` or a connector source tag. */
      barge_in_sources: z.array(z.string().regex(EARS_SOURCE_TAG, "must be http, dir or a source tag matching [a-z][a-z0-9-]{0,31}")).default(["discord"]),
      /** Words a transcript needs to count as a barge-in (a backchannel like "mm-hm" does not). */
      barge_in_min_words: z.number().int().min(1).default(2),
      /** Whether salience may interject: answer a sentence while the speaker is still talking (SAL-INTJ-001). Off by default. */
      interject: z.boolean().default(false), // @spec CFG-SCH-107
      /** The chance, from 0 to 1, that an eligible interjection is taken (SAL-INTJ-004). */
      interject_chance: z.number().min(0).max(1).default(0.15), // @spec CFG-SCH-107
      /** Whether a speaker who resumes talking cancels the interjection (SAL-INTJ-009). */
      interject_yield: z.boolean().default(true), // @spec CFG-SCH-107
      /** The shortest pause between two interjections (SAL-INTJ-003). */
      interject_min_gap_ms: z.number().int().positive().default(120000), // @spec CFG-SCH-108
      /** Words a sentence needs before it may be interjected on (SAL-INTJ-002). */
      interject_min_words: z.number().int().min(1).default(4), // @spec CFG-SCH-108
      /** Words a follow-up sentence needs to be interjected on (SAL-INTJ-010). */
      interject_followup_min_words: z.number().int().min(1).default(3), // @spec CFG-SCH-108
      /** How long a provisional focus may stay unresolved before salience gives up on it (SAL-PROV-012). */
      unresolved_limit_ms: z.number().int().positive().default(4000), // @spec CFG-SCH-109
      cooldown_ms: z.number().int().nonnegative().default(6000),
      /** How long a `thinking` cortex counts as busy before salience stops waiting on it. */
      thinking_timeout_ms: z.number().int().positive().default(60000),
      idle_chatter_ms: z.number().int().nonnegative().default(90000),
      reply_on_mention: z.boolean().default(true),
      /** How long past its `dueAt` a timer may still be spoken (SAL-REM-003). */
      reminder_expiry_ms: z.number().int().positive().default(1800000), // @spec CFG-SCH-096
      /** Summed event score needed to speak. */
      speak_threshold: z.number().min(0).default(0.6),
      /** How much a high-arousal mood lowers the threshold (0 = ignore mood). */
      arousal_bias: z.number().min(0).max(1).default(0.2),
      /** How events are scored: rules | llm | http. */
      module: ModuleSchema,
      /** Fast path: no LLM, canned line, fires the instant a matching event arrives. */
      // @spec CFG-SCH-004
      reflexes: z
        .array(
          z.object({
            /** Regex (case-insensitive) tested against the event text. */
            match: z.string().min(1).refine((m) => { try { RegExp(m, "i"); return true; } catch { return false; } }, { message: "not a valid regular expression" }),
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
    }).prefault({}),
    affect: z.object({
      /** How often affect.state is published while it's changing. */
      publish_ms: z.number().int().positive().default(2000),
      /** Time for a mood swing to fade halfway back to baseline. */
      half_life_ms: z.number().int().positive().default(45000),
      /** Resting valence (-1..1). A sunny co-host sits above 0. */
      baseline_valence: z.number().min(-1).max(1).default(0.15),
      /** Resting arousal (0..1). */
      baseline_arousal: z.number().min(0).max(1).default(0.1),
      /** An unchanged mood is published again this often so late joiners get a value. */
      republish_ms: z.number().int().positive().default(15000),
      /** With an llm/http appraiser, a line shorter than this (trimmed, no mention) is appraised by the rules inline. */
      short_line_chars: z.number().int().nonnegative().default(4),
      /** How long a viewer, and a text, once counted toward the mood, are not counted again. */
      count_window_ms: z.number().int().positive().default(30000), // @spec CFG-SCH-047
      /** Mood nudges per event, as magnitudes 0..1: a sub's chat line, a changed screen, the co-host's own emotional line. */
      nudge_sub_valence: z.number().min(0).max(1).default(0.05),
      nudge_sub_arousal: z.number().min(0).max(1).default(0.05),
      nudge_screen_arousal: z.number().min(0).max(1).default(0.08),
      nudge_said_valence: z.number().min(0).max(1).default(0.08),
      nudge_said_arousal: z.number().min(0).max(1).default(0.05),
      /** How a line of chat/speech moves the mood: rules | llm | http. */
      module: ModuleSchema,
    }).prefault({}),
    memory: z.object({
      /** postgres = pgvector + Ollama embeddings; `memory` = in-process fake (lost on exit; for dev/CI and isolated runs). */
      store: z.preprocess((v) => v || "postgres", z.enum(["postgres", "memory"])),
      /** `hash` is a deterministic offline embedder; never contacts Ollama. */
      embedder: z.preprocess((v) => v || "ollama", z.enum(["ollama", "hash"])),
      recall_k: z.number().int().nonnegative().default(6),
      min_similarity: z.number().min(0).max(1).default(0.35),
      /** Lifetime message count above which a viewer is a regular (the owner's flag also makes one). */
      // @spec CFG-SCH-014
      regular_messages: z.number().int().positive().default(25),
      /** Viewer notes: fade, promotion, caps and the two model hooks. */
      // @spec CFG-SCH-015, CFG-SCH-016
      notes: z.object({
        /** Dirty notes that trigger a consolidation pass. */
        dirty_threshold: z.number().int().positive().default(20),
        recent_half_life_days: z.number().positive().default(7),
        core_half_life_days: z.number().positive().default(60),
        /** Fraction of the gap to full strength a fresh mention closes. */
        reinforce: z.number().min(0).max(1).default(0.6),
        /** A recent note mentioned this often becomes core. */
        promote_mentions: z.number().int().positive().default(3),
        demote_below: z.number().min(0).max(1).default(0.3),
        drop_below: z.number().min(0).max(1).default(0.1),
        returning_strength: z.number().min(0).max(1).default(0.3),
        suppress_similarity: z.number().min(0).max(1).default(0.8),
        capture_min_chars: z.number().int().nonnegative().default(8),
        max_notes_per_viewer: z.number().int().positive().default(5),
        max_notes_total: z.number().int().positive().default(15),
        sensitive_cooldown_hours: z.number().nonnegative().default(24),
        deleted_retention_days: z.number().positive().default(30),
        /** Hook: live note capture (a small, cheap model). rules = writes no note. */
        capture: ModuleSchema,
        /** Hook: the after-the-fact quality pass (a stronger model). rules = proposes no change. */
        consolidator: ModuleSchema,
      }).prefault({}),
    }).prefault(EMPTY_INPUT),
    cortex: z.object({
      /** How long to wait for the memory region before answering without it. */
      recall_timeout_ms: z.number().int().positive().default(2500),
      /** Give up on a stuck utterance / voice sink after this long. */
      speaking_timeout_ms: z.number().int().positive().default(20000),
      /** Base chance, stated to the model as a nudge, that she riffs on a spoken line that failed to play. Never enforced. */
      fallback_ack_chance: z.number().min(0).max(1).default(0.25), // @spec CFG-SCH-019
      /** How long a provisional think may hold its reply back before a confirm; past it the think is dropped unspoken (CTX-PROV-010, CTX-PROV-014). */
      hold_limit_ms: z.number().int().positive().default(5000), // @spec CFG-SCH-110
      /** The cortex stays silent rather than say a line this similar (0..1) to a recent one of its own; 0 turns the check off. */
      repeat_similarity: z.number().min(0).max(1).default(0.8), // @spec CFG-SCH-046
      /** The shortest clause a streamed reply is cut into (cortex cuts at a clause boundary once it has this many characters). */
      clause_min_chars: z.number().int().min(1).default(24), // @spec CFG-SCH-072
      /** The longest clause; a clause over it is cut at the last word boundary. Not below clause_min_chars (checked on the brain). */
      clause_max_chars: z.number().int().default(160), // @spec CFG-SCH-073
      /** The most clauses one streamed reply may have before the cortex closes it with cut `length`. */
      max_clauses: z.number().int().min(1).max(16).default(8), // @spec CFG-SCH-074
      /** Inhibition: a check on each reply before it's spoken. rules = pass-through. */
      critic: ModuleSchema,
    }).prefault({}),
  }).superRefine((v, ctx) => {
    // @spec CFG-SCH-045
    // The issue sits on the key, so the loader names `brain.working_memory_own_lines` and not the parent object.
    if (v.working_memory_own_lines >= v.working_memory_events) {
      ctx.addIssue({ code: "custom", path: ["working_memory_own_lines"], message: `must be less than brain.working_memory_events (${v.working_memory_events}): the window has to keep room for events other than the co-host's own lines` });
    }
    // @spec CFG-SCH-073
    if (v.cortex.clause_max_chars < v.cortex.clause_min_chars) {
      ctx.addIssue({ code: "custom", path: ["cortex", "clause_max_chars"], message: `must not be below brain.cortex.clause_min_chars (${v.cortex.clause_min_chars})` });
    }
  }),
  /**
   * The longest chat message and viewer name a consumer takes in or renders. The whole section is optional. The minimums
   * keep the truncation mark from being the whole text.
   */
  // @spec CFG-SCH-042, CFG-SCH-043
  viewer_text: z.object({
    /** 500 is Twitch's own message limit. */
    max_chars: z.number().int().min(16).default(500),
    max_name_chars: z.number().int().min(8).default(40),
  }).prefault({}),
  // @spec CFG-SCH-055, CFG-SCH-056, CFG-SCH-057, CFG-SCH-058, CFG-SCH-059, CFG-SCH-060, CFG-SCH-061, CFG-SCH-062
  voice: z.object({
    /** `stub` returns silence sized from the text; no TTS call (isolated runs). `openai` and `pocket` call their own speech server. */
    engine: z.preprocess((v) => v || "kokoro", z.enum(["kokoro", "openai", "pocket", "stub"])), // @spec CFG-SCH-055
    /**
     * The voice, checked in the form of `engine` and resolved after parse (`resolveVoice`): blank is the engine's own voice
     * under kokoro and pocket, and stays blank under openai (CFG-SCH-056, CFG-SCH-057).
     */
    voice: z.string().default(""),
    /** The bound on the wait for the first audio byte of a synthesis and on each gap between its chunks. */
    timeout_ms: z.number().int().positive().default(15000), // @spec CFG-SCH-058
    /** Pace multiplier sent to Kokoro-FastAPI (its accepted range is 0.25 to 4). */
    speed: z.number().min(0.25).max(4).default(1.05), // @spec CFG-SCH-006
    /** Kokoro language code for text processing; blank leaves it to the first letter of the voice name. */
    lang_code: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["a", "b", "e", "f", "h", "i", "j", "p", "z"]).optional()), // @spec CFG-SCH-029
    /** Output gain sent to Kokoro-FastAPI (0 to 10); unset keeps the server's own default. */
    volume_multiplier: z.number().min(0).max(10).optional(), // @spec CFG-SCH-029
    /** Kokoro-FastAPI text normalization switches; a key left out keeps the server's own default. */
    normalization: z.object({
      normalize: z.boolean().optional(),
      unit_normalization: z.boolean().optional(),
      url_normalization: z.boolean().optional(),
      email_normalization: z.boolean().optional(),
      optional_pluralization_normalization: z.boolean().optional(),
      phone_normalization: z.boolean().optional(),
      caps_normalization: z.boolean().optional(),
      replace_remaining_symbols: z.boolean().optional(),
      remove_emoji: z.boolean().optional(),
    }).prefault({}), // @spec CFG-SCH-029
    /** Read only by the `stub` engine to size its silence; the Kokoro engine ignores it. */
    sample_rate: z.number().int().positive().default(24000), // @spec CFG-SCH-026
    fallback: z.object({
      /** Phrases the co-host says when a line fails to play; voice turns each into a clip. Empty turns the feature off. */
      lines: z.array(
        z.string().max(200).refine((s) => s.trim().length > 0, "must not be empty"),
      ).default([]), // @spec CFG-SCH-017
    }).prefault({}),
    /** The OpenAI-compatible speech server (`engine` openai). */
    openai: z.object({
      /** Empty or an http(s) URL; trailing slashes are dropped (CFG-SCH-060). */
      base_url: optionalUrl("must be empty or an http or https URL").transform((u) => u.replace(/\/+$/, "")).default(""), // @spec CFG-SCH-059, CFG-SCH-060
      model: z.string().default(""), // @spec CFG-SCH-059
      /** A secret, from `secrets.yaml` (CFG-SEC-003). */
      api_key: z.string().default(""), // @spec CFG-SCH-059
    }).prefault({}),
    /** The Pocket TTS server (`engine` pocket). */
    pocket: z.object({
      /** Empty (a configuration gap, CFG-SCH-062) or an http(s) URL. */
      url: optionalUrl("must be empty or an http or https URL").default("http://tts-pocket:8000"), // @spec CFG-SCH-061
      /** A secret, from `secrets.yaml`: only an owner who has accepted the gated Pocket TTS weights needs it (CFG-SEC-003). */
      hf_token: z.string().default(""), // @spec CFG-SCH-061
    }).prefault({}),
  }).transform((v, ctx) => ({ ...v, voice: resolveVoice(v.engine, v.voice, ctx) })),
  avatar: z.object({
    // A blank value means "no avatar app"; a non-empty unknown value still fails.
    driver: z.preprocess((v) => v || "null", z.enum(["vtube-studio", "vmc", "browser", "null"])), // @spec AVATAR-DRV-004, CFG-SCH-006
    fps: z.number().int().positive().default(30),
    smoothing: z.number().min(0).max(1).default(0.25),
    idle_motion: z.boolean().default(true),
    vtube_studio: z.object({
      host: str("host.docker.internal"),
      port: z.number().int().default(8001),
      plugin_name: str("cohost"),
      plugin_developer: str("cohost"),
    }),
    vmc: z.object({ host: str("host.docker.internal"), port: z.number().int().default(39539) }),
  }),
  /**
   * The browser avatar renderer's settings (config design, Schema: key groups). The `avatar` container reads them from
   * `./config` at its start; the dashboard pushes a saved section to a running renderer (CFG-LOAD-008).
   */
  // @spec CFG-SCH-097
  renderer: z.object({
    /** A `.vrm` file name in the model directory, or empty for the built-in placeholder model. */
    model: z.string().max(80).refine((v) => v === "" || RENDERER_MODEL_NAME.test(v), "must be empty or a .vrm file name: a letter or digit first, then letters, digits, spaces, dots, underscores or hyphens, ending in .vrm").default(""), // @spec CFG-SCH-098
    /** Camera distance multiplier. */
    zoom: z.number().min(0.5).max(3).default(1), // @spec CFG-SCH-099
    /** Vertical framing offset, in frame heights: 0 is centred, a positive value raises the model. */
    offset_y: z.number().min(-1.5).max(1.5).default(0), // @spec CFG-SCH-099
    /** Yaw of the model in degrees. */
    turn: z.number().min(-90).max(90).default(0), // @spec CFG-SCH-099
  }).prefault({}),
  ears: z.object({
    /**
     * The enabled listening sources, started together: `http` (clips POSTed to `ears.http`), `dir` (WAV files dropped in
     * `ears.dir.path`), `discord` or any other connector source tag. Empty is off; unset is `[discord]` (see `earsSources`).
     * Read at start.
     */
    // @spec CFG-SCH-030
    sources: z.array(z.string().regex(EARS_SOURCE_TAG, "must be http, dir or a source tag matching [a-z][a-z0-9-]{0,31}")).optional(),
    /** The `http` source's listener; port 0 picks a free port. */
    http: z.object({
      host: z.preprocess((v) => v || "127.0.0.1", z.string()),
      port: z.number().int().min(0).max(65535).default(8765),
      /** Bearer token `POST /audio` must carry; empty requires none (EARS-SRC-013). */
      token: z.string().default(""),
    }).prefault(EMPTY_INPUT),
    /** The `dir` source: the directory polled for dropped `.wav` files (empty = not configured) and the poll period. */
    dir: z.object({
      path: z.string().default(""),
      poll_ms: z.number().int().positive().default(1000),
    }).prefault({}),
    silence_ms: z.number().int().positive().default(700),
    /** Sources deaf to the co-host's own voice while a line plays and for `echo_tail_ms` after (EARS-ECHO-004). */
    // @spec CFG-SCH-036
    echo_suppress_sources: z.array(z.string().regex(EARS_SOURCE_TAG, "must be http, dir or a source tag matching [a-z][a-z0-9-]{0,31}")).default(["desktop"]),
    echo_tail_ms: z.number().int().min(0).default(1500),
    /**
     * How a connector source's frames are cut into utterances: `silero` (default) runs a speech-activity detector over each
     * speaker's frames, `gap` cuts on the frame gap alone. `threshold` is the speech probability a frame needs (EARS-VAD-*).
     */
    // @spec CFG-SCH-033
    vad: z.object({
      engine: z.preprocess((v) => v || "silero", z.enum(["silero", "gap"])),
      threshold: z.number().min(0).max(1).default(0.5),
    }).prefault(EMPTY_INPUT),
    /** An utterance whose buffered audio reaches this is closed and the speaker's next speech opens a new one (EARS-VAD-005). */
    max_utterance_ms: z.number().int().positive().default(15000),
    /** `on` publishes `speech.partial` while a connector utterance is open (EARS-PART-001); costs speech-to-text calls. */
    partials: z.preprocess((v) => v || "off", z.enum(["on", "off"])),
    /** Declares that the speech-to-text backend runs on a GPU; only gates the startup warning of EARS-PART-012. */
    stt_gpu: z.boolean().default(false),
    /** How often a growing partial transcription is made, ms. */
    partial_step_ms: z.number().int().positive().default(1000),
    min_speech_ms: z.number().int().positive().default(400),
    stt_model: str("Systran/faster-whisper-small"),
    /** The STT engine: `stub` transcribes every clip to fixed text with no STT server (isolated runs); blank is `speaches`. */
    // @spec CFG-SCH-022
    stt_engine: z.preprocess((v) => v || "speaches", z.enum(["speaches", "openai", "nemotron", "kyutai", "stub"])),
    /** The batch engine that transcribes whole clips and utterances a streaming engine cannot serve; `none` has none. */
    stt_fallback_engine: z.preprocess((v) => v || "speaches", z.enum(["speaches", "openai", "none"])), // @spec CFG-SCH-063
    /** The bound on one speech-to-text request. */
    stt_timeout_ms: z.number().int().positive().default(20000), // @spec CFG-SCH-064
    /** How many speech-to-text sessions may run at once. */
    max_stt_sessions: z.number().int().min(1).default(2), // @spec CFG-SCH-064
    /** The OpenAI-compatible transcription server (`stt_engine` or fallback openai). */
    openai: z.object({
      /** Empty or an http(s) URL; trailing slashes are dropped. */
      base_url: optionalUrl("must be empty or an http or https URL").transform((u) => u.replace(/\/+$/, "")).default(""), // @spec CFG-SCH-065
      /** A secret, from `secrets.yaml` (CFG-SEC-003). */
      api_key: z.string().default(""), // @spec CFG-SCH-065
    }).prefault({}),
    /** The NVIDIA Nemotron speech-to-text server. */
    nemotron: z.object({
      url: optionalUrl("must be empty or an http or https URL").default("http://stt-nemotron:8080"), // @spec CFG-SCH-066
      /** A secret, from `secrets.yaml` (CFG-SEC-003). */
      api_key: z.string().default(""), // @spec CFG-SCH-066
    }).prefault({}),
    /** The Kyutai speech-to-text server, with its end-of-turn detection. */
    kyutai: z.object({
      url: optionalUrl("must be empty or an http or https URL").default("http://stt-kyutai:8080"), // @spec CFG-SCH-067
      /** A secret, from `secrets.yaml` (CFG-SEC-003). */
      api_key: z.string().default(""), // @spec CFG-SCH-067
      /** Whether the server's end-of-turn detection closes a sentence (`on`) or the silence gap does (`off`). */
      end_of_turn: z.preprocess((v) => v || "off", z.enum(["on", "off"])), // @spec CFG-SCH-068
      /** The end-of-turn probability needed to close a sentence: above 0 and below 1. */
      end_of_turn_threshold: z.number().gt(0).lt(1).default(0.5), // @spec CFG-SCH-068
    }).prefault(EMPTY_INPUT),
    /** Live transcripts equal to one of these (case, spacing and edge punctuation ignored) are dropped: Whisper's silence hallucinations. */
    // @spec EARS-HEAR-010
    drop_phrases: z.array(z.string()).default([]),
    /**
     * Early reply: a provisional transcript of a sentence still being spoken, published `after_ms` into a pause (EARS-EARLY-001).
     * `max_per_utterance` caps the early transcripts of one utterance (EARS-EARLY-004). `after_ms` must stay below `silence_ms`.
     */
    early: z.object({
      /** Off by default; a streaming engine is not required (CFG-SCH-106). */
      enabled: z.boolean().default(false), // @spec CFG-SCH-102
      after_ms: z.number().int().min(100).default(250), // @spec CFG-SCH-103
      max_per_utterance: z.number().int().min(1).max(5).default(2), // @spec CFG-SCH-104
    }).prefault({}),
  }).superRefine((v, ctx) => {
    // @spec CFG-SCH-105
    if (v.early.after_ms >= v.silence_ms) {
      ctx.addIssue({ code: "custom", path: ["early", "after_ms"], message: `must be below ears.silence_ms (${v.silence_ms})` });
    }
  }),
  /**
   * The co-host's speaking module. The whole section is optional.
   * Each key under `outputs` is one output and its sink name (`discord`, `dryrun`, `file`, `http`).
   */
  // @spec CFG-SCH-020, CFG-SCH-018
  mouth: z.object({
    outputs: z.object({
      discord: z.object({
        enabled: z.boolean().default(true),
        /** Loudness on this output only, applied to utterances and fallback clips. */
        gain_db: z.number().min(-40).max(12).default(0),
      }).prefault({}),
      /** Test-only output: plays nothing, reports as a sink; `fail_every` n > 0 gives up on every n-th line. */
      // @spec CFG-SCH-023
      dryrun: z.object({
        enabled: z.boolean().default(false),
        fail_every: z.number().int().nonnegative().default(0),
      }).prefault({}),
      /** Appends each line's WAV to a bounded rotating directory under the data directory. */
      // @spec CFG-SCH-031
      file: z.object({
        enabled: z.boolean().default(false),
        /** Relative to the data directory; no absolute path and no `..` segment, so the output cannot write elsewhere. */
        dir: z.string().refine((d) => d !== "" && !d.startsWith("/") && !/^[A-Za-z]:/.test(d) && !d.split(/[\\/]/).includes(".."), "must be a relative path without `..`").default("mouth/outputs"),
        /** The newest this many files are kept. */
        max_files: z.number().int().min(1).default(100),
      }).prefault({}),
      /** POSTs each line's WAV to `url`, with a timeout, bounded retries and a bounded queue. */
      // @spec CFG-SCH-031
      http: z.object({
        enabled: z.boolean().default(false),
        /** Empty or an http(s) URL; empty while enabled leaves the output down. */
        url: z.string().refine((u) => u === "" || /^https?:\/\/\S+$/.test(u), "must be empty or an http(s) URL").default(""),
        timeout_ms: z.number().int().positive().default(5000),
        retries: z.number().int().nonnegative().default(3),
        max_queue: z.number().int().positive().default(20),
      }).prefault({}),
    }).prefault({}),
    fallback: z.object({
      /** At most one spoken fallback line per this many ms on an output (storm limit). */
      min_interval_ms: z.number().int().nonnegative().default(20000),
    }).prefault({}),
  }).prefault({}),
  /**
   * External connectors that attach to the bus (service `connector-discord`, unit `discord`). The whole section is optional so a
   * config.yaml written before connectors existed still loads. The Discord connector reads the guild and voice channel.
   */
  // @spec CFG-SCH-032
  connections: z.object({
    discord: z.object({
      /** false = the connector idles with heartbeat mode `off` and holds no Discord client. */
      enabled: z.boolean().default(true),
      guild_id: DISCORD_ID,
      voice_channel_id: DISCORD_ID,
      /** The bot token (a secret, from `secrets.yaml`). */
      token: z.string().default(""),
    }).prefault({}),
  }).prefault({}),
  /** The machines and networks that count as the LAN for the egress rule (CFG-EGR-011); the whole section is optional. */
  // @spec CFG-SCH-071
  network: z.object({
    /** Host names, single addresses, dot suffixes and CIDR ranges. */
    lan: z.array(z.string().refine(isLanEntry, "must be a host name, an IP address, a dot suffix such as .ts.net, or a CIDR range")).default([]),
  }).optional(),
  /** MCP servers and tool permissions (CFG-SCH-075); no tool is enabled unless `tools.allow` names it. */
  tools: ToolsSchema,
  // @spec CFG-SCH-038
  dashboard: z.object({
    /** The full surface's port; applies at the dashboard's next start. */
    port: PORT.default(3000), // @spec CFG-SCH-026
    /** The LAN listener's port (the sink page and audio only); applies at the dashboard's next start. */
    lan_port: PORT.default(3001), // @spec CFG-SCH-026
    /** Host names (besides IP addresses and `localhost`) a request to a listener other machines can reach may use; applies at the dashboard's next start. */
    allowed_hosts: z.array(z.string().regex(HOST_NAME, "must be a host name only: no scheme, port or path (for example streampc or streampc.local)")).default([]), // @spec CFG-SCH-041
    /** Limits of the dashboard's test uploads. */
    inject: z.object({
      max_image_bytes: z.number().int().positive().default(8388608),
      max_audio_bytes: z.number().int().positive().default(26214400),
      ttl_ms: z.number().int().positive().default(300000),
    }).prefault({}),
    /** Limits of the model store the dashboard keeps `.vrm` files in. */
    models: z.object({
      /** The largest `.vrm` file the store accepts; 1 MiB to 1 GiB. */
      max_bytes: z.number().int().min(1048576).max(1073741824).default(104857600), // @spec CFG-SCH-100
    }).prefault({}),
  }).superRefine((v, ctx) => {
    if (v.port === v.lan_port) ctx.addIssue({ code: "custom", path: ["lan_port"], message: "must differ from dashboard.port: the full surface and the LAN listener cannot share a port" });
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

// @spec CFG-SCH-030, EARS-SRC-001, EARS-SRC-002
/**
 * The enabled listening sources, without repeats: `ears.sources` when set, else `[discord]`.
 */
export function earsSources(ears: Pick<Config["ears"], "sources">): string[] {
  return [...new Set(ears.sources ?? ["discord"])];
}

/** The longest value of the `browser` block of expressions.yaml (CFG-SCH-101). */
export const BROWSER_EXPRESSION_MAX = 64;

/** Per-driver expression map: canonical emotion -> app-specific name, plus gestures. */
// @spec CFG-SCH-007
export const ExpressionMapSchema = z.record(
  z.string(),
  z
    .object({ gestures: z.record(z.string(), z.string()).prefault({}) })
    .catchall(z.string()),
).superRefine((map, ctx) => {
  // @spec CFG-SCH-101
  for (const [driver, block] of Object.entries(map)) {
    if (driver !== "browser") continue;
    for (const [name, value] of Object.entries(block)) {
      if (name !== "gestures" && typeof value === "string" && value.length > BROWSER_EXPRESSION_MAX) {
        ctx.addIssue({ code: "custom", path: [driver, name], message: `must be at most ${BROWSER_EXPRESSION_MAX} characters` });
      }
    }
  }
});
export type ExpressionMap = z.infer<typeof ExpressionMapSchema>;
