/**
 * Browser driver: writes the Engine's whole state to the avatar-frame stream once per tick, for the dashboard's renderer
 * page to draw. It opens no port and needs no host, port or plugin setting.
 *
 * Directions, as a viewer of the stream sees the face (avatar design, Direction of the angles):
 * - headX: positive turns the face toward the viewer's left (AVATAR-DIR-001)
 * - headY: positive tips the face down, chin toward the chest (AVATAR-DIR-002)
 * - headZ: positive tilts the top of the head toward the viewer's right (AVATAR-DIR-003)
 * - eyeX: positive moves the gaze toward the viewer's right (AVATAR-DIR-004)
 * - eyeY: positive moves the gaze up (AVATAR-DIR-005)
 *
 * The renderer page applies the head angles through the same `eulerToQuat` the VMC driver uses; the gaze values are
 * passed through unchanged, so the page must apply them with those directions.
 */
import type { AvatarFrame } from "@cohost/bus";
import type { Emotion } from "@cohost/config";
import type { AvatarDriver, AvatarParams, DriverContext } from "../types.js";

/** Built-in expression names for an emotion the `browser` block leaves out (AVATAR-BRW-007). `think` and `neutral` have none. */
const DEFAULT_EXPRESSIONS: Partial<Record<Emotion, string>> = {
  happy: "happy", laugh: "happy", surprised: "surprised", smug: "relaxed", sad: "sad", angry: "angry", confused: "sad",
};

/** A failed write is logged at most this often, on the monotonic clock (AVATAR-BRW-009). */
const WARN_INTERVAL_MS = 10_000;

/** Round to three decimals; `+ 0` turns a rounded -0 into 0 so frames compare equal. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

export class BrowserDriver implements AvatarDriver { // @spec AVATAR-BRW-001
  readonly name = "browser";
  private frames!: DriverContext["frames"];
  private open = false; // true from connect until disconnect
  private log?: DriverContext["log"];
  private expressions: Record<string, string> = {};
  private emotion: Emotion = "neutral";
  private intensity = 0;
  private writing = false;
  private failed = false;
  private warnedAt = -Infinity;

  async connect(ctx: DriverContext): Promise<void> { // @spec AVATAR-BRW-003
    this.frames = ctx.frames;
    this.open = true;
    this.log = ctx.log;
    this.expressions = ctx.expressions;
  }

  async disconnect(): Promise<void> { this.open = false; } // @spec AVATAR-BRW-012

  /** True from construction; false from a failed write until the next successful one (AVATAR-BRW-010). */
  connected(): boolean { return !this.failed; } // @spec AVATAR-BRW-010

  setParams(p: AvatarParams): void { // @spec AVATAR-BRW-004, AVATAR-BRW-008
    if (!this.open || this.writing) return; // after disconnect: nothing; one write in flight: this frame is dropped, not queued
    const frame: AvatarFrame = {
      mouthOpen: r3(p.mouthOpen), mouthSmile: r3(p.mouthSmile),
      headX: r3(p.headX), headY: r3(p.headY), headZ: r3(p.headZ),
      eyeX: r3(p.eyeX), eyeY: r3(p.eyeY), blink: r3(p.blink),
      emotion: this.emotion, intensity: this.intensity, expression: this.expression(),
    };
    this.write(this.frames, frame);
  }

  /** Records the pair for the frames that follow; writes nothing (AVATAR-BRW-005). */
  setExpression(emotion: Emotion, intensity: number): void { // @spec AVATAR-BRW-005
    this.emotion = emotion;
    this.intensity = intensity;
  }

  /** Does nothing: gesture timing belongs to the Engine, and a VRM has no hotkeys (AVATAR-BRW-011). */
  trigger(_gesture: string): void { /* no-op */ } // @spec AVATAR-BRW-011

  private write(frames: DriverContext["frames"], frame: AvatarFrame): void { // @spec AVATAR-BRW-008, AVATAR-BRW-010
    this.writing = true;
    let pending: Promise<unknown>;
    try { pending = frames.publishAvatarFrame(frame); } catch (err) { pending = Promise.reject(err); }
    pending.then(
      () => { this.writing = false; this.failed = false; },
      (err: unknown) => { this.writing = false; this.failed = true; this.warn(err); },
    );
  }

  /** Logs a failed write at most once every 10 s; the driver keeps running (AVATAR-BRW-009). */
  private warn(err: unknown): void { // @spec AVATAR-BRW-009
    const now = performance.now();
    if (now - this.warnedAt < WARN_INTERVAL_MS) return;
    this.warnedAt = now;
    this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "avatar frame publish failed");
  }

  /**
   * The VRM expression name for the recorded emotion: empty at an intensity of 0.05 or below and for `neutral`; else the
   * `browser` block's value when the block holds the key (an empty string means none), else the built-in default.
   */
  private expression(): string { // @spec AVATAR-BRW-006, AVATAR-BRW-007
    if (this.emotion === "neutral" || !(this.intensity > 0.05)) return "";
    if (Object.prototype.hasOwnProperty.call(this.expressions, this.emotion)) return this.expressions[this.emotion]!;
    return DEFAULT_EXPRESSIONS[this.emotion] ?? "";
  }
}
