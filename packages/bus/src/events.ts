import { z } from "zod";
import { Emotion } from "@cohost/config";

/**
 * Every message on the bus is one of these. Services only ever talk through
 * these events — never directly to each other — so any piece can be swapped.
 */
export const EventPayloads = {
  /** A viewer said something (Twitch / YouTube / Discord text). */
  "chat.message": z.object({
    platform: z.enum(["twitch", "youtube", "discord"]),
    user: z.string(),
    userId: z.string().optional(),
    text: z.string(),
    isMod: z.boolean().default(false),
    isSub: z.boolean().default(false),
    /** The co-host's name appeared in the message. */
    mentionsCohost: z.boolean().default(false),
  }),

  /** The eyes looked at the game and this is what they saw. */
  "vision.summary": z.object({
    text: z.string(),
    /** True when materially different from the previous summary. */
    changed: z.boolean().default(true),
  }),

  /** Someone spoke in Discord voice and it was transcribed. */
  "speech.heard": z.object({
    speaker: z.string(),
    speakerId: z.string().optional(),
    text: z.string(),
    durationMs: z.number(),
  }),

  /** The brain decided to say something. Voice + avatar react to this. */
  "brain.say": z.object({
    id: z.string(),
    text: z.string(),
    emotion: Emotion,
    gesture: z.string().optional(),
    /** Why it spoke, for the dashboard. */
    reason: z.string().optional(),
  }),

  /** The brain's current state, for the dashboard. */
  "brain.status": z.object({
    state: z.enum(["idle", "thinking", "speaking", "muted"]),
    detail: z.string().optional(),
  }),

  /** Audio for an utterance is ready. envelope = mouth-open level per frame (0..1). */
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
  "voice.playing": z.object({ id: z.string(), sink: z.string() }),
  "voice.done": z.object({ id: z.string(), sink: z.string() }),

  /** Avatar's smoothed state, for the dashboard preview. */
  "avatar.state": z.object({
    emotion: Emotion,
    intensity: z.number(),
    mouthOpen: z.number(),
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
  control: z.object({
    cmd: z.enum(["mute", "unmute", "say", "forget_context", "reload_personality"]),
    text: z.string().optional(),
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

export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];
