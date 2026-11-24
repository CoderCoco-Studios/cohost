// The relay's avatar frame as the renderer page reads it (DASH-AVP-032). Pure: no DOM, no WebGL, no 3D library, and no
// import of zod or the config package, so the page carries neither (the emotion list is written out here).

/** The nine canonical emotions of the bus (CFG-SCH-007); the page tests frames against this list, not against config. */
export const EMOTIONS = ["neutral", "happy", "laugh", "surprised", "smug", "sad", "angry", "confused", "think"] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** One frame of the avatar state (BUS-AVF-002): unit ranges, head angles in degrees, signed unit gaze. */
export interface Frame {
  mouthOpen: number;
  mouthSmile: number;
  headX: number;
  headY: number;
  headZ: number;
  eyeX: number;
  eyeY: number;
  blink: number;
  emotion: Emotion;
  intensity: number;
  expression: string;
}

/** The rest values the page draws before any frame and eases to (DASH-AVP-030). */
export const REST_FRAME: Frame = { mouthOpen: 0, mouthSmile: 0.15, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0, emotion: "neutral", intensity: 0, expression: "" };

const RANGES: Record<"mouthOpen" | "mouthSmile" | "intensity" | "blink" | "headX" | "headY" | "headZ" | "eyeX" | "eyeY", [number, number]> = {
  mouthOpen: [0, 1], mouthSmile: [0, 1], intensity: [0, 1], blink: [0, 1],
  headX: [-90, 90], headY: [-90, 90], headZ: [-90, 90], eyeX: [-1, 1], eyeY: [-1, 1],
};

/**
 * The frame a message carries, or null when it is not one: a missing field, a non-finite or out-of-range number, an
 * emotion outside EMOTIONS or an expression that is not a string of at most 64 characters (DASH-AVP-032). Only the
 * known fields are copied, so an unknown field is ignored and never reaches the pose.
 */
// @spec DASH-AVP-032
export function parseFrame(v: unknown): Frame | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const num = (k: keyof typeof RANGES): number | null => {
    const x = o[k];
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    const [lo, hi] = RANGES[k];
    return x < lo || x > hi ? null : x;
  };
  const n: Partial<Record<keyof typeof RANGES, number>> = {};
  for (const k of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const x = num(k);
    if (x === null) return null;
    n[k] = x;
  }
  const emotion = o.emotion;
  if (typeof emotion !== "string" || !(EMOTIONS as readonly string[]).includes(emotion)) return null;
  const expression = o.expression;
  if (typeof expression !== "string" || expression.length > 64) return null;
  return {
    mouthOpen: n.mouthOpen!, mouthSmile: n.mouthSmile!, headX: n.headX!, headY: n.headY!, headZ: n.headZ!,
    eyeX: n.eyeX!, eyeY: n.eyeY!, blink: n.blink!, emotion: emotion as Emotion, intensity: n.intensity!, expression,
  };
}
