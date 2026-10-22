import type { Config, Emotion } from "@cohost/config";
import { NEUTRAL, type AvatarDriver, type AvatarParams } from "./types.js";

interface Utterance { id: string; emotion: Emotion; gesture?: string; envelope: number[]; envelopeHz: number; durationMs: number }

/**
 * The animation loop. Owns timing, smoothing, idle motion and lip-sync
 * playback so drivers stay trivial. Runs at cfg.fps.
 */
export class Engine {
  private cur: AvatarParams = { ...NEUTRAL };
  private target: AvatarParams = { ...NEUTRAL };
  private emotion: Emotion = "neutral";
  private emotionUntil = 0;
  /** Resting face from the affect region; what we fall back to when an utterance's emotion wears off. */
  private mood: Emotion = "neutral";
  private known = new Map<string, Utterance>();
  private playing?: { u: Utterance; startedAt: number };
  private nextBlink = Date.now() + 3000;
  private blinkUntil = 0;
  private timer?: NodeJS.Timeout;
  private t0 = Date.now();

  constructor(private cfg: Config["avatar"], private driver: AvatarDriver, private onState?: (p: AvatarParams, emotion: Emotion, intensity: number) => void) {}

  start(): void {
    const dt = 1000 / this.cfg.fps;
    this.timer = setInterval(() => this.frame(), dt);
  }
  stop(): void { clearInterval(this.timer); }

  /** Audio is ready; remember it so we can lip-sync when a sink starts playing. */
  prepare(u: Utterance): void {
    this.known.set(u.id, u);
    if (this.known.size > 20) this.known.delete(this.known.keys().next().value!);
  }

  /** A sink started playing this utterance. */
  play(id: string): void {
    const u = this.known.get(id);
    if (!u) return;
    this.playing = { u, startedAt: Date.now() };
    this.setEmotion(u.emotion, u.durationMs + 4000);
    if (u.gesture) this.driver.trigger(u.gesture);
  }

  done(id: string): void {
    if (this.playing?.u.id === id) this.playing = undefined;
  }

  setEmotion(e: Emotion, holdMs = 4000): void {
    this.emotion = e;
    this.emotionUntil = Date.now() + holdMs;
    this.driver.setExpression(e, 1);
  }

  /** Mood changes show up softly, and only when no utterance is holding the face. */
  setMood(e: Emotion): void {
    if (e === this.mood) return;
    this.mood = e;
    if (Date.now() > this.emotionUntil) {
      this.emotion = e;
      this.driver.setExpression(e, e === "neutral" ? 0 : 0.5);
    }
  }

  private frame(): void {
    const now = Date.now();
    const t = (now - this.t0) / 1000;

    // --- mouth from envelope
    let mouth = 0;
    if (this.playing) {
      const { u, startedAt } = this.playing;
      const i = Math.floor(((now - startedAt) / 1000) * u.envelopeHz);
      if (i < u.envelope.length) mouth = u.envelope[i] ?? 0;
      else if (now - startedAt > u.durationMs + 500) this.playing = undefined;
    }
    this.target.mouthOpen = mouth;

    // --- emotion decay back to the resting mood
    if (this.emotion !== this.mood && now > this.emotionUntil) {
      this.emotion = this.mood;
      this.driver.setExpression(this.mood, this.mood === "neutral" ? 0 : 0.5);
    }
    this.target.mouthSmile = this.emotion === "happy" || this.emotion === "laugh" || this.emotion === "smug" ? 0.7 : 0.15;

    // --- idle motion: slow drifting sines, a bit livelier while talking
    if (this.cfg.idle_motion) {
      const k = this.playing ? 1.6 : 1;
      this.target.headX = k * (4 * Math.sin(t / 3.1) + 2 * Math.sin(t / 1.3));
      this.target.headY = k * (3 * Math.sin(t / 4.7));
      this.target.headZ = 2 * Math.sin(t / 5.3);
      this.target.eyeX = 0.35 * Math.sin(t / 2.3);
      this.target.eyeY = 0.2 * Math.sin(t / 3.7);
    }

    // --- blink
    if (now > this.nextBlink) {
      this.blinkUntil = now + 120;
      this.nextBlink = now + 2500 + Math.random() * 3500;
    }
    this.target.blink = now < this.blinkUntil ? 1 : 0;

    // --- smoothing (mouth and blink snap faster than the head)
    const s = this.cfg.smoothing;
    for (const k of Object.keys(this.cur) as (keyof AvatarParams)[]) {
      const rate = k === "mouthOpen" ? Math.min(1, s * 3) : k === "blink" ? 1 : s;
      this.cur[k] += (this.target[k] - this.cur[k]) * rate;
    }

    this.driver.setParams(this.cur);
    this.onState?.(this.cur, this.emotion, this.emotion === "neutral" ? 0 : now <= this.emotionUntil ? 1 : 0.5);
  }
}
