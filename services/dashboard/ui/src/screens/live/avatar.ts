/** `avatar.state` as the face needs it; every number is finite (a missing or malformed field reads as 0). */
export interface AvatarParams {
  driver: string;
  connected: boolean;
  headX: number; headY: number; headZ: number;
  blink: number; eyeX: number; eyeY: number;
  mouthOpen: number; mouthSmile: number;
  emotion: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Reads an `avatar.state` event's data defensively. */
export function avatarParams(d: Record<string, unknown> | undefined): AvatarParams {
  const s = d ?? {};
  return {
    driver: text(s.driver), connected: s.connected === true,
    headX: num(s.headX), headY: num(s.headY), headZ: num(s.headZ),
    blink: num(s.blink), eyeX: num(s.eyeX), eyeY: num(s.eyeY),
    mouthOpen: num(s.mouthOpen), mouthSmile: num(s.mouthSmile),
    emotion: text(s.emotion),
  };
}

/** The face's SVG geometry for the parameters (the driver's own mapping: head offset and roll, eye size and gaze, mouth curve). */
export function faceGeometry(p: AvatarParams) {
  const open = 4 + p.mouthOpen * 22, smile = p.mouthSmile * 10;
  return {
    head: `translate(${p.headX * 0.8} ${-p.headY * 0.8}) rotate(${p.headZ} 100 100)`,
    eyeRy: Math.max(0.5, 9 * (1 - p.blink)),
    eyeLeft: { cx: 75 + p.eyeX * 4, cy: 88 + p.eyeY * 3 },
    eyeRight: { cx: 125 + p.eyeX * 4, cy: 88 + p.eyeY * 3 },
    mouth: `M80 128 Q100 ${128 + smile + open} 120 128 Q100 ${128 + smile - open * 0.3} 80 128`,
  };
}
