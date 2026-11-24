// Hold and ease (DASH-AVP-030): what the page draws once frames stop. Pure: the clock is passed in.
import { REST_FRAME, type Frame } from "./frame";

/** How long the last valid frame is held after it arrives. */
export const HOLD_MS = 2000;
/** How long the ease to the rest values takes after the hold. */
export const EASE_MS = 1000;

/** The last valid frame and the `performance.now()` reading at which it arrived. */
export interface HeldFrame { frame: Frame; at: number }

/**
 * The pose at `now`: the rest values before any frame; the frame itself for the hold and at its first instant of the
 * ease; then a straight line to the rest values over the ease, the expression fading with its intensity and gone at the
 * end; the rest values after it. A clock that steps back holds the frame.
 */
// @spec DASH-AVP-030
export function poseAt(held: HeldFrame | null, now: number): Frame {
  if (held === null) return { ...REST_FRAME };
  const elapsed = Math.max(0, now - held.at);
  if (elapsed <= HOLD_MS) return held.frame;
  const t = Math.min(1, (elapsed - HOLD_MS) / EASE_MS);
  if (t >= 1) return { ...REST_FRAME };
  const f = held.frame;
  const lerp = (a: number, b: number): number => a + (b - a) * t;
  return {
    mouthOpen: lerp(f.mouthOpen, REST_FRAME.mouthOpen),
    mouthSmile: lerp(f.mouthSmile, REST_FRAME.mouthSmile),
    headX: lerp(f.headX, REST_FRAME.headX),
    headY: lerp(f.headY, REST_FRAME.headY),
    headZ: lerp(f.headZ, REST_FRAME.headZ),
    eyeX: lerp(f.eyeX, REST_FRAME.eyeX),
    eyeY: lerp(f.eyeY, REST_FRAME.eyeY),
    blink: lerp(f.blink, REST_FRAME.blink),
    emotion: f.emotion,
    intensity: lerp(f.intensity, REST_FRAME.intensity),
    expression: f.expression,
  };
}
