import type { Bus } from "@cohost/bus";
import type { Emotion, Logger } from "@cohost/config";

/**
 * Canonical avatar state. The brain/voice side only ever produces this; a
 * driver translates it into whatever the avatar app understands.
 * Angles in degrees, everything else 0..1 (eyes -1..1).
 */
export interface AvatarParams {
  mouthOpen: number;
  mouthSmile: number;
  // Directions are as a viewer of the stream sees the face (avatar design, Direction of the angles); a driver signs
  // each value for its app to match.
  headX: number;   // yaw, -30..30: positive turns the face toward the viewer's left (AVATAR-DIR-001)
  headY: number;   // pitch: positive tips the face down, chin toward the chest (AVATAR-DIR-002)
  headZ: number;   // roll: positive tilts the top of the head toward the viewer's right (AVATAR-DIR-003)
  eyeX: number;    // -1..1: positive moves the gaze toward the viewer's right (AVATAR-DIR-004)
  eyeY: number;    // -1..1: positive moves the gaze up (AVATAR-DIR-005)
  blink: number;   // 0 open .. 1 closed
}

export interface DriverContext {
  log: Logger;
  /** canonical emotion -> app-specific expression name (from expressions.yaml) */
  expressions: Record<string, string>;
  /** canonical gesture -> app-specific name */
  gestures: Record<string, string>;
  /** Directory the driver may persist small state in (auth tokens etc.). */
  stateDir: string;
  /** The bus client's avatar-frame writer, used only by the browser driver (AVATAR-BRW-002); absent in tests of other drivers. */
  frames?: Pick<Bus, "publishAvatarFrame">;
}

/**
 * Implement this to support a new avatar app. Keep drivers dumb: no timing,
 * no smoothing, no decisions — the engine does that. Drivers just translate.
 */
export interface AvatarDriver { // @spec AVATAR-DRV-001
  readonly name: string;
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
