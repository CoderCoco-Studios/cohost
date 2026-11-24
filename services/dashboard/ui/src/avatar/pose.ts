// The frame-to-pose mapping (DASH-AVP-009 to DASH-AVP-016, DASH-AVP-018): pure arithmetic, no 3D library. The renderer
// applies what these return to the model; the values are pinned by the UI tests.
import { eulerToQuat } from "@cohost/shared/head-rotation";
import { REST_FRAME, type Frame } from "./frame";

/** The VRM version of a loaded model: the 1.0 and the 0.x bone and expression conventions differ (DASH-AVP-014, -015). */
export type VrmVersion = "1.0" | "0.x";

/** The smile weight of DASH-AVP-012: the rest value 0.15 shows nothing, the Engine's 0.7 shows 0.65. */
export function smileWeight(mouthSmile: number): number {
  return Math.min(1, Math.max(0, (mouthSmile - REST_FRAME.mouthSmile) / (1 - REST_FRAME.mouthSmile)));
}

/**
 * The head bone's quaternion for a frame (DASH-AVP-014, DASH-AVP-015): `eulerToQuat(headY, headX, headZ)` of the shared
 * head rotation, converted to the 3D library's right-handed space: `[x, -y, -z, w]` for 1.0 and `[-x, -y, z, w]` for 0.x.
 */
// @spec DASH-AVP-014, DASH-AVP-015
export function headQuaternion(f: Frame, version: VrmVersion): [number, number, number, number] {
  const [x, y, z, w] = eulerToQuat(f.headY, f.headX, f.headZ);
  return version === "1.0" ? [x, -y, -z, w] : [-x, -y, z, w];
}

/** The 0.x preset names of the VRM 0.x blend shape groups and their VRM 1.0 names (DASH-AVP-009). */
const V0_PRESETS: ReadonlyMap<string, string> = new Map([
  ["neutral", "neutral"], ["a", "aa"], ["i", "ih"], ["u", "ou"], ["e", "ee"], ["o", "oh"], ["joy", "happy"], ["angry", "angry"],
  ["sorrow", "sad"], ["fun", "relaxed"], ["blink", "blink"], ["blink_l", "blinkLeft"], ["blink_r", "blinkRight"],
  ["lookup", "lookUp"], ["lookdown", "lookDown"], ["lookleft", "lookLeft"], ["lookright", "lookRight"],
]);

/** The name an expression is addressed by: a 0.x preset under its 1.0 name, anything else as given (DASH-AVP-009). */
// @spec DASH-AVP-009
export function presetName(name: string): string {
  return V0_PRESETS.get(name) ?? name;
}

/** One expression weight to write to the model. */
export interface ExpressionWrite { name: string; weight: number }

/**
 * The expression weights of a frame, in the order DASH-AVP-010 gives: the previous expression to 0 when this frame names
 * another one (or none); the frame's expression to its intensity; `happy` to the larger of the smile weight and the
 * intensity when the frame's expression is happy (the smile weight alone otherwise); then `aa` to `mouthOpen` and
 * `blink` to `blink` (DASH-AVP-011), written last so the Engine's mouth and blink win. A name the model lacks is the
 * applier's to skip (DASH-AVP-013).
 */
// @spec DASH-AVP-010, DASH-AVP-011
export function expressionWrites(previous: string, f: Frame): ExpressionWrite[] {
  const out: ExpressionWrite[] = [];
  if (previous !== "" && previous !== f.expression) out.push({ name: previous, weight: 0 });
  if (f.expression !== "") out.push({ name: f.expression, weight: f.intensity });
  const smile = smileWeight(f.mouthSmile);
  out.push({ name: "happy", weight: f.expression === "happy" ? Math.max(smile, f.intensity) : smile });
  out.push({ name: "aa", weight: f.mouthOpen });
  out.push({ name: "blink", weight: f.blink });
  return out;
}

/**
 * Writes the weights to the model's expressions by name (DASH-AVP-013): a name the model does not define has no target and
 * is skipped. Targets are looked up as own entries of a Map, so a frame's expression name (`__proto__`, `constructor`) can
 * never reach a prototype.
 */
// @spec DASH-AVP-013
export function applyExpressionWrites(targets: ReadonlyMap<string, { weight: number }>, writes: readonly ExpressionWrite[]): void {
  for (const w of writes) {
    const target = targets.get(w.name);
    if (target !== undefined) target.weight = w.weight;
  }
}

/** The look-at range maps' `inputMaxValue`s in degrees, from the model (DASH-AVP-016). */
export interface LookAtRanges { horizontalOuter: number; verticalUp: number; verticalDown: number }

/** The gaze angles in degrees: yaw toward the viewer's right for a positive `eyeX`, pitch up for a positive `eyeY`. */
export interface Gaze { yaw: number; pitch: number }

/**
 * The gaze of a frame (DASH-AVP-016): yaw is `eyeX` times the horizontal outer range, pitch is `eyeY` times the vertical
 * up range for a positive `eyeY` and the vertical down range for a negative one. A model with no look-at has no gaze.
 */
// @spec DASH-AVP-016
export function gazeAngles(f: Frame, ranges: LookAtRanges | null): Gaze | null {
  if (ranges === null) return null;
  const yaw = f.eyeX * ranges.horizontalOuter;
  const pitch = f.eyeY >= 0 ? f.eyeY * ranges.verticalUp : f.eyeY * ranges.verticalDown;
  return { yaw: yaw === 0 ? 0 : yaw, pitch: pitch === 0 ? 0 : pitch };
}

/**
 * The static rest quaternion of an upper arm, a rotation of 65 degrees about the model's Z axis (DASH-AVP-018): the left
 * arm -65 and the right +65 on a 1.0 model, mirrored on a 0.x one, so both arms hang down on both versions.
 */
// @spec DASH-AVP-018
export function armRestQuaternion(side: "left" | "right", version: VrmVersion): [number, number, number, number] {
  const sideSign = side === "left" ? -1 : 1;
  const versionSign = version === "1.0" ? 1 : -1;
  const half = (sideSign * versionSign * 65 * Math.PI) / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
}
