import { z } from "zod";
// @spec BUS-EVT-019
import { Emotion } from "@cohost/config";

/**
 * Every message on the bus is one of these. Services only ever talk through
 * these events — never directly to each other — so any piece can be swapped.
 */
// @spec BUS-EVT-001
export const EventPayloads = {
  /** A viewer said something (Twitch / YouTube / Discord text). */
  // @spec BUS-EVT-002, BUS-EVT-005
  "chat.message": z.object({
    platform: z.enum(["twitch", "youtube", "discord"]),
    user: z.string(),
    userId: z.string().optional(),
    text: z.string(),
    isMod: z.boolean().default(false),
    isSub: z.boolean().default(false),
    /** The co-host's name appeared in the message. */
    mentionsCohost: z.boolean().default(false),
    /** Set by test injection; absent on real events. */
    injected: z.boolean().optional(),
    remember: z.boolean().optional(),
  }),

  /** The eyes looked at the game and this is what they saw. */
  // @spec BUS-EVT-012, BUS-EVT-005
  "vision.summary": z.object({
    text: z.string(),
    /** True when materially different from the previous summary. */
    changed: z.boolean().default(true),
    /** Set by test injection; absent on real events. */
    injected: z.boolean().optional(),
    remember: z.boolean().optional(),
  }),

  /** Someone spoke in Discord voice and it was transcribed. */
  // @spec BUS-EVT-013, BUS-EVT-005
  "speech.heard": z.object({
    speaker: z.string(),
    speakerId: z.string().optional(),
    text: z.string(),
    durationMs: z.number(),
    /** Set by test injection; absent on real events. */
    injected: z.boolean().optional(),
    remember: z.boolean().optional(),
  }),

  /** The brain decided to say something. Voice + avatar react to this. */
  // @spec BUS-EVT-014, BUS-EVT-005
  "brain.say": z.object({
    id: z.string(),
    text: z.string(),
    emotion: Emotion,
    gesture: z.string().optional(),
    /** Why it spoke, for the dashboard. */
    reason: z.string().optional(),
    /** Set by test injection; absent on real events. */
    injected: z.boolean().optional(),
    remember: z.boolean().optional(),
  }),

  /** The brain's current state, for the dashboard. */
  // @spec BUS-EVT-015
  "brain.status": z.object({
    state: z.enum(["idle", "thinking", "speaking", "muted"]),
    detail: z.string().optional(),
  }),

  // ---- brain regions talk to each other through these ----

  /** salience → cortex: something is worth responding to right now. */
  // @spec BUS-EVT-010, BUS-EVT-005
  "attention.focus": z.object({
    /** "mentioned" | "engaged" | "idle chatter" ... free text for the dashboard. */
    reason: z.string(),
    score: z.number(),
    /** The single event most worth replying to, if any. */
    focus: z
      .object({
        kind: z.enum(["chat", "speech", "vision"]),
        who: z.string().optional(),
        text: z.string(),
        mention: z.boolean().default(false),
      })
      .optional(),
    /** Set by test injection; absent on real events. */
    injected: z.boolean().optional(),
    remember: z.boolean().optional(),
  }),

  /** affect → everyone: the co-host's running mood. Decays on its own. */
  // @spec BUS-EVT-003
  "affect.state": z.object({
    /** -1 (miserable) .. 1 (delighted) */
    valence: z.number().min(-1).max(1),
    /** 0 (flat) .. 1 (buzzing) */
    arousal: z.number().min(0).max(1),
    /** Nearest canonical emotion, for the avatar's resting face and the prompt. */
    mood: Emotion,
    /** What last moved it, for the dashboard. */
    cause: z.string().optional(),
  }),

  /** cortex → memory: what do we remember that relates to this? */
  // @spec BUS-EVT-010
  "memory.recall.request": z.object({
    id: z.string(),
    query: z.string(),
    k: z.number().int().positive().optional(),
  }),
  /** memory → cortex: the answer. Empty list is a valid answer. */
  // @spec BUS-EVT-010
  "memory.recall.reply": z.object({
    id: z.string(),
    memories: z.array(
      z.object({
        ts: z.number(),
        kind: z.enum(["chat", "speech", "self", "note"]),
        who: z.string(),
        text: z.string(),
        similarity: z.number().optional(),
      }),
    ),
  }),

  /** memory → cortex: who this viewer is, emitted when they address the co-host. Carries no note text. */
  // @spec BUS-EVT-010
  "memory.viewer": z.object({
    user: z.string(),
    isNew: z.boolean(),
    msgCount: z.number().int(),
    regular: z.boolean(),
  }),

  /** cortex → memory: the viewer notes for these names. The first is the viewer being replied to. */
  // @spec BUS-EVT-020
  "memory.notes.request": z.object({
    id: z.string(),
    users: z.array(z.string()).nonempty(),
  }),
  /**
   * memory → cortex: the notes of each viewer memory resolved, no subscriber status. `text` is absent for
   * `health` and `family` notes, which carry only a handling hint. Carries note text: never forwarded to `/ws`.
   */
  // @spec BUS-EVT-020
  "memory.notes.reply": z.object({
    id: z.string(),
    viewers: z.array(
      z.object({
        user: z.string(),
        regular: z.boolean(),
        msgCount: z.number().int(),
        notes: z.array(
          z.object({
            layer: z.enum(["core", "recent"]),
            category: z.enum(["general", "health", "family"]),
            text: z.string().optional(),
            hint: z.string().optional(),
            strength: z.number().min(0).max(1),
          }),
        ),
      }),
    ),
  }),

  /** dashboard → memory: an owner operation on viewer notes (Viewers page). Never forwarded to the browser feed. */
  // @spec BUS-EVT-021
  "memory.viewers.request": z.union([
    z.object({ id: z.string(), op: z.literal("list"), query: z.string().optional() }),
    z.object({ id: z.string(), op: z.literal("get"), key: z.string() }),
    z.object({ id: z.string(), op: z.literal("delete_note"), noteId: z.string(), reason: z.string().optional() }),
    z.object({ id: z.string(), op: z.literal("restore"), deletionId: z.string() }),
    z.object({ id: z.string(), op: z.literal("clear"), key: z.string(), reason: z.string().optional() }),
    z.object({
      id: z.string(), op: z.literal("set_regular"), regular: z.boolean(), key: z.string().optional(), name: z.string().min(1).optional(),
    }).refine((d) => d.key !== undefined || d.name !== undefined, { message: "set_regular needs a key or a name" }),
  ]),
  /** memory → dashboard: the answer, correlated by `id`. `data` is the operation's result. */
  // @spec BUS-EVT-021
  "memory.viewers.reply": z.object({
    id: z.string(),
    ok: z.boolean(),
    error: z.enum(["not_found", "failed"]).optional(),
    detail: z.string().optional(),
    data: z.unknown().optional(),
  }),

  /** Audio for an utterance is ready. envelope = mouth-open level per frame (0..1). */
  // @spec BUS-EVT-016
  "voice.utterance": z.object({
    id: z.string(),
    text: z.string(),
    emotion: Emotion,
    gesture: z.string().optional(),
    durationMs: z.number(),
    envelopeHz: z.number(),
    envelope: z.array(z.number()),
    /** Path on the voice service: GET http://voice:8700/audio/<id>.wav */
    audioUrl: z.string(),
    sampleRate: z.number(),
  }),

  /** Playback of an utterance started somewhere (dashboard sink / Discord). Avatar syncs to this. */
  // @spec BUS-EVT-017
  "voice.playing": z.object({ id: z.string(), sink: z.string() }),
  "voice.done": z.object({ id: z.string(), sink: z.string() }),

  /** Avatar's smoothed state, for the dashboard preview. */
  // @spec BUS-EVT-018
  "avatar.state": z.object({
    emotion: Emotion,
    intensity: z.number(),
    mouthOpen: z.number(),
    mouthSmile: z.number(),
    headX: z.number(),
    headY: z.number(),
    headZ: z.number(),
    eyeX: z.number(),
    eyeY: z.number(),
    blink: z.number(),
    driver: z.string(),
    connected: z.boolean(),
  }),

  /** Operator controls from the dashboard. */
  // @spec BUS-EVT-004
  control: z.object({
    cmd: z.enum(["mute", "unmute", "say", "forget_context", "reload_personality", "pause", "resume"]),
    text: z.string().optional(),
    /** Service the command is addressed to; absent = all services (back-compat). */
    target: z.string().optional(),
  }),

  /**
   * dashboard → eyes/ears/chat: run this test input through the service's real
   * code path. Binaries never ride the stream; `url` points at the dashboard
   * upload store.
   */
  // @spec BUS-EVT-006
  "inject.request": z.object({
    id: z.string(),
    target: z.enum(["eyes", "ears", "chat"]),
    kind: z.enum(["image", "audio", "text"]),
    url: z.string().optional(),
    text: z.string().optional(),
    meta: z
      .object({
        user: z.string().optional(),
        platform: z.enum(["twitch", "youtube", "discord"]).optional(),
        isMod: z.boolean().optional(),
        isSub: z.boolean().optional(),
      })
      .optional(),
    remember: z.boolean(),
  }),

  /** eyes/ears/chat → dashboard: outcome of an inject.request, correlated by id. */
  // @spec BUS-EVT-007
  "inject.result": z.object({
    id: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
  }),

  /** Audit record of a start/stop/restart attempt made through the service controller. */
  // @spec BUS-EVT-008
  "service.lifecycle": z.object({
    service: z.string(),
    action: z.enum(["start", "stop", "restart"]),
    /** Who asked: "dashboard" for HTTP callers, "cohostctl" for the CLI. */
    by: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
  }),

  /**
   * Liveness/readiness report from a service. Carried on the separate
   * `cohost:health` stream (see publishHealth), never on `cohost:events`.
   */
  // @spec BUS-EVT-009
  "service.heartbeat": z.object({
    service: z.string(),
    /** Unique per process (the bus consumer name). */
    instance: z.string(),
    pid: z.number().int(),
    version: z.string(),
    /** Epoch ms the process started; constant for its lifetime. */
    startedAt: z.number(),
    state: z.enum(["starting", "ready", "degraded", "stopping"]),
    deps: z.record(z.enum(["ok", "down", "n/a"])),
    /** "live" | "mock" | "off" by convention. */
    mode: z.string(),
    detail: z.string().optional(),
    intervalMs: z.number().int().positive(),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export type EventData<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;
export type EventInput<T extends EventType> = z.input<(typeof EventPayloads)[T]>;

export interface BusEvent<T extends EventType = EventType> {
  /** Redis stream id, e.g. "1718000000000-0" */
  id: string;
  type: T;
  ts: number;
  source: string;
  data: EventData<T>;
}

// @spec BUS-EVT-001
export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];
