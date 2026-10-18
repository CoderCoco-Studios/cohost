import type { Emotion, Logger } from "@cohost/config";

/**
 * Canonical avatar state. The brain/voice side only ever produces this; a
 * driver translates it into whatever the avatar app understands.
 * Angles in degrees, everything else 0..1 (eyes -1..1).
 */
export interface AvatarParams {
  mouthOpen: number;
  mouthSmile: number;
  headX: number;   // yaw, -30..30
  headY: number;   // pitch
  headZ: number;   // roll
  eyeX: number;    // -1..1
  eyeY: number;
  blink: number;   // 0 open .. 1 closed
}

export type Capability = "expressions" | "params" | "gestures" | "lipsync";

export interface DriverContext {
  log: Logger;
  /** canonical emotion -> app-specific expression name (from expressions.yaml) */
  expressions: Record<string, string>;
  /** canonical gesture -> app-specific name */
  gestures: Record<string, string>;
  /** Directory the driver may persist small state in (auth tokens etc.). */
  stateDir: string;
}

/**
 * Implement this to support a new avatar app. Keep drivers dumb: no timing,
 * no smoothing, no decisions — the engine does that. Drivers just translate.
 */
export interface AvatarDriver {
  readonly name: string;
  capabilities(): ReadonlySet<Capability>;
  connect(ctx: DriverContext): Promise<void>;
  disconnect(): Promise<void>;
  connected(): boolean;
  /** Called at engine fps with the smoothed state. */
  setParams(p: AvatarParams): void;
  /** Called when the emotion changes. intensity 0..1. */
  setExpression(emotion: Emotion, intensity: number): void;
  /** Fire-and-forget named animation. */
  trigger(gesture: string): void;
}

export const NEUTRAL: AvatarParams = { mouthOpen: 0, mouthSmile: 0, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0 };
