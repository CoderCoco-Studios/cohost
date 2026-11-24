// Framing arithmetic, canvas fit and the step clamp (DASH-AVP-007, DASH-AVP-019, DASH-AVP-021). Pure: no DOM, no 3D library.

/** The vertical field of view of the camera, in degrees (DASH-AVP-021). */
export const FOV_DEGREES = 30;
/** The largest step the spring bones take in one draw, in milliseconds (DASH-AVP-019). */
export const MAX_STEP_MS = 50;

/** The framing a `view` carries (DASH-AVP-021): zoom divides the frame height, offsetY and turn are as the owner set them. */
export interface Framing { zoom: number; offsetY: number; turn: number }

/** The model's bounding box at rest pose, in metres. */
export interface Box { min: [number, number, number]; max: [number, number, number] }

export type Vec3 = [number, number, number];

/** Where the camera stands, what it looks at and how the model sits in the frame. */
export interface FramePlan {
  fov: number;
  camera: Vec3;
  target: Vec3;
  pivot: Vec3;
  frameHeight: number;
  modelOffsetY: number;
  modelRotationY: number;
}

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/**
 * The plan for a framing: a camera with a 30 degree field of view at the middle of the box's front, the frame height
 * 1.05 times the box height at the target's distance divided by `zoom`, the model moved up by `offsetY` frame heights and
 * turned by `turn` degrees about the vertical axis through the box's centre. A non-finite or non-positive zoom or a
 * non-finite offset or turn falls back to the neutral value, so the plan is always finite.
 */
// @spec DASH-AVP-021
export function framingPlan(box: Box, f: Framing): FramePlan {
  const zoom = Number.isFinite(f.zoom) && f.zoom > 0 ? f.zoom : 1;
  const offsetY = finiteOr(f.offsetY, 0);
  const turn = finiteOr(f.turn, 0);
  const target: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const height = Math.max(0, box.max[1] - box.min[1]);
  const frameHeight = (1.05 * height) / zoom;
  const distance = frameHeight / (2 * Math.tan((FOV_DEGREES / 2) * (Math.PI / 180)));
  return {
    fov: FOV_DEGREES,
    camera: [target[0], target[1], target[2] + distance],
    target,
    pivot: [...target] as Vec3,
    frameHeight,
    modelOffsetY: offsetY * frameHeight,
    modelRotationY: turn * (Math.PI / 180),
  };
}

/** The canvas size for a window (DASH-AVP-007): CSS size at least 1 px, the device pixel ratio capped at 2 and 1 when absent. */
// @spec DASH-AVP-007
export function canvasSize(w: { width: number; height: number; devicePixelRatio: number }): { width: number; height: number; pixelRatio: number } {
  const pixelRatio = w.devicePixelRatio > 0 ? Math.min(2, w.devicePixelRatio) : 1;
  return { width: Math.max(1, Math.floor(w.width)), height: Math.max(1, Math.floor(w.height)), pixelRatio };
}

/** The spring-bone step for the time since the last draw: seconds, at most 50 ms, 0 for a negative or non-finite time. */
// @spec DASH-AVP-019
export function clampStepSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_STEP_MS) / 1000;
}
