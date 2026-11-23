/**
 * The avatar frame: one browser-avatar snapshot on `<prefix>:avatar.frames` (avatar frames, event-bus design "Avatar
 * frames"). Its schema is the `avatar.state` ranges (BUS-EVT-018), so the two cannot disagree about a parameter.
 * Pure: no Redis, no transport. Specs: BUS-AVF-002, BUS-AVF-006, BUS-AVF-008, BUS-AVF-011.
 */
import { z } from "zod";
import { Emotion } from "@cohost/config";

/** `MAXLEN ~` of the producer's write: about four seconds at 30 fps (BUS-AVF-005, BUS-AVF-006). */
// @spec BUS-AVF-006
export const AVATAR_FRAMES_MAXLEN = 120;
/** The producer's `PEXPIRE` on every write: a stream whose producer stopped is gone within this long (BUS-AVF-006). */
// @spec BUS-AVF-006
export const AVATAR_FRAMES_TTL_MS = 10_000;

const unit = z.number().min(0).max(1);
const signed = z.number().min(-1).max(1);
const degrees = z.number().min(-90).max(90);

/** A frame: finite numbers in their ranges, one of the nine emotions, an expression of at most 64 characters, no other field (BUS-AVF-002). */
// @spec BUS-AVF-002, BUS-AVF-011
export const AvatarFrameSchema = z.strictObject({
  mouthOpen: unit,
  mouthSmile: unit,
  headX: degrees,
  headY: degrees,
  headZ: degrees,
  eyeX: signed,
  eyeY: signed,
  blink: unit,
  emotion: Emotion,
  intensity: unit,
  expression: z.string().max(64),
});

export type AvatarFrame = z.infer<typeof AvatarFrameSchema>;

/** One entry as read: its stream id and the decoded frame. */
export interface AvatarFrameEntry { id: string; frame: AvatarFrame }

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : undefined);

/**
 * Decode the field list of one stream entry (`ts`, `data`, as strings or Buffers). Never throws: a missing `data` field,
 * invalid JSON or a frame that fails the schema gives `null`, so the reader drops the entry (BUS-AVF-008).
 */
// @spec BUS-AVF-008, BUS-AVF-011
export function decodeAvatarFrame(fields: unknown): AvatarFrame | null {
  try {
    if (!Array.isArray(fields)) return null;
    let data: string | undefined;
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (text(fields[i]) === "data") { data = text(fields[i + 1]); break; }
    }
    if (data === undefined) return null;
    const parsed = AvatarFrameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
