/**
 * The spoken fallback line's clips: one WAV per phrase of `voice.fallback.lines`, generated with the current TTS voice
 * settings, kept in voice's own store under `<dataDir()>/voice/fallback-clips` and served over HTTP for ears to cache.
 * A regeneration commits a whole set by rename, so what the routes serve is always complete. See the voice LLD, Fallback Clips.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@cohost/config";
import { parseWav, retryWithBackoff } from "@cohost/shared";
import { TtsError } from "./voice.js";

/** Bump when the clip format (naming, manifest shape, what a clip is) changes, so every set regenerates. */
export const CLIP_FORMAT_VERSION = 1;
export const CLIP_RETRY_INITIAL_MS = 60_000;
export const CLIP_RETRY_MAX_MS = 15 * 60_000;
/** A clip shorter than this is treated as an unspeakable phrase. */
const MIN_CLIP_MS = 100;
const STALE_TMP_MS = 60 * 60_000;

/** One clip as `manifest.json` lists it. */
export interface ClipEntry { name: string; text: string; durationMs: number; bytes: number; sha256: string }
/** `manifest.json` on disk. */
export interface StoredManifest { version: number; fingerprint: string; generatedAt: number; set: string; clips: ClipEntry[] }
/** The manifest the route serves: the stored one without `set`. */
export type ServedManifest = Omit<StoredManifest, "set">;

/** What `Voice.handle` needs from the clip store. */
export interface ClipRoutes {
  /** The committed manifest, or `undefined` when no set is committed. */
  manifest(): ServedManifest | undefined;
  /** The bytes of a clip of the committed set, or `undefined`. Never rejects. */
  clipBytes(name: string): Promise<Buffer | undefined>;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]))
      : v;

export interface FingerprintInputs {
  lines: string[];
  engine: string;
  /** Everything the synthesizer sends to the TTS server apart from the text (model, voice, speed ...). */
  settings: Record<string, unknown>;
}

/** SHA-256 of a canonical JSON of what decides how the clips sound (VOICE-CLIP-001). */
export function clipFingerprint({ lines, engine, settings }: FingerprintInputs): string { // @spec VOICE-CLIP-001
  const json = JSON.stringify(canonical({ lines: lines.map((l) => l.trim()), engine, settings, format: CLIP_FORMAT_VERSION }));
  return createHash("sha256").update(json).digest("hex");
}

export interface ClipServiceDeps extends FingerprintInputs {
  /** The clip store directory (`<dataDir()>/voice/fallback-clips`). */
  dir: string;
  synth: (text: string) => Promise<Buffer>;
  log: Pick<Logger, "warn" | "info" | "debug">;
  now?: () => number;
}

/** A phrase the TTS server will not turn into a usable clip: it is left out of the set. */
class Unspeakable extends Error {}

const SET_PATH = /^sets\/[\w.-]+$/;

/** Reads a stored manifest and checks its shape, that its set path stays inside the store and that every clip file exists and is not empty. */
async function loadCommitted(dir: string): Promise<StoredManifest | undefined> {
  let m: StoredManifest;
  try {
    m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as StoredManifest;
  } catch { return undefined; }
  if (!m || typeof m.fingerprint !== "string" || typeof m.set !== "string" || !SET_PATH.test(m.set) || !Array.isArray(m.clips)) return undefined;
  for (const c of m.clips) {
    if (!c || typeof c.name !== "string" || !/^[\w][\w.-]*$/.test(c.name)) return undefined;
    try { if ((await stat(join(dir, m.set, c.name))).size === 0) return undefined; } catch { return undefined; }
  }
  return m;
}

export class ClipService implements ClipRoutes {
  readonly fingerprint: string;
  private committed: StoredManifest | undefined;
  /** The attempt in progress (or, while a retry timer is about to fire, the attempt it will start); what `idle()` waits for. */
  private current: Promise<void> = Promise.resolve();
  private endCurrent: (() => void) | undefined;
  /** A retry timer has fired and made `current` for the attempt the loop is about to run. */
  private armed = false;
  private first: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private now: () => number;
  private lines: string[];

  constructor(private d: ClipServiceDeps) {
    this.now = d.now ?? Date.now;
    this.lines = d.lines.map((l) => l.trim());
    this.fingerprint = clipFingerprint(d);
  }

  manifest(): ServedManifest | undefined {
    if (!this.committed) return undefined;
    const { set: _set, ...served } = this.committed;
    return served;
  }

  async clipBytes(name: string): Promise<Buffer | undefined> {
    const m = this.committed;
    if (!m || !m.clips.some((c) => c.name === name)) return undefined;
    try { return await readFile(join(this.d.dir, m.set, name)); } catch { return undefined; }
  }

  /** Resolves when the regeneration or retry in progress has ended (a scheduled retry is not waited for). */
  idle(): Promise<void> { return this.current; }

  /**
   * Check the store against the fingerprint and regenerate when it is stale. Returns when that first attempt has ended;
   * callers that must not wait (boot) do not await it. A failed attempt is retried in the background by the shared
   * `retryWithBackoff` (60 s doubling to 15 min). Starting twice does nothing.
   */
  start(): Promise<void> { // @spec VOICE-CLIP-002, VOICE-CLIP-003
    if (!this.started) {
      this.started = true;
      let isFirst = true;
      let firstDone!: () => void;
      this.first = new Promise<void>((r) => { firstDone = r; });
      void retryWithBackoff(async () => {
        const wasFirst = isFirst;
        isFirst = false;
        if (!this.armed) { this.current = new Promise<void>((r) => { this.endCurrent = r; }); }
        this.armed = false;
        try { await this.attempt(wasFirst); firstDone(); }
        finally { this.endCurrent?.(); }
      }, {
        baseMs: CLIP_RETRY_INITIAL_MS, maxMs: CLIP_RETRY_MAX_MS, isStopped: () => this.stopped,
        sleep: (ms) => new Promise<void>((resolve) => {
          const fire = () => {
            clearTimeout(this.timer);
            this.wake = undefined;
            // The attempt this timer starts is what `idle()` must wait for, even before the loop gets to run it.
            this.current = new Promise<void>((r) => { this.endCurrent = r; });
            this.armed = true;
            resolve();
          };
          this.timer = setTimeout(fire, ms);
          this.wake = resolve;
        }),
        // @spec VOICE-CLIP-005
        onFailure: (err, _n, delayMs) => {
          this.d.log.warn({ err: String(err), retryInMs: delayMs }, "fallback clip regeneration abandoned: keeping the previous clips");
          firstDone(); // the first attempt has ended, successfully or not
        },
      }).catch((err) => this.d.log.warn({ err: String(err) }, "fallback clip retry loop ended")).finally(() => firstDone());
    }
    return this.first!;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.wake?.();
    this.endCurrent?.();
  }

  /** One attempt; throws on failure so the retry loop reports and schedules the next. */
  private async attempt(first: boolean): Promise<void> {
    if (first) {
      this.committed = await loadCommitted(this.d.dir);
      if (this.committed?.fingerprint === this.fingerprint) return; // @spec VOICE-CLIP-002
    }
    if (this.stopped) return;
    await this.regenerate();
  }

  /** Synthesize one phrase; `Unspeakable` for a 4xx, a reply that is not a 16-bit WAV, or a clip under 100 ms. Anything else throws. */
  private async speak(index: number, text: string): Promise<{ wav: Buffer; durationMs: number }> {
    let wav: Buffer;
    try {
      wav = await this.d.synth(text);
    } catch (err) {
      if (err instanceof TtsError && err.status >= 400 && err.status < 500) throw new Unspeakable(String(err));
      throw err; // connection error or 5xx: TTS is down
    }
    try {
      const info = parseWav(wav);
      if (info.bitsPerSample !== 16) throw new Error(`${info.bitsPerSample}-bit WAV`);
      if (!(info.durationMs >= MIN_CLIP_MS)) throw new Error(`clip is ${Math.round(info.durationMs)} ms`);
      return { wav, durationMs: Math.round(info.durationMs) };
    } catch (err) {
      throw new Unspeakable(`phrase ${index}: ${String(err)}`);
    }
  }

  /** Synthesize every phrase and commit the set (VOICE-CLIP-003, VOICE-CLIP-004, VOICE-CLIP-006, VOICE-CLIP-009, VOICE-CLIP-010). */
  private async regenerate(): Promise<void> { // @spec VOICE-CLIP-003, VOICE-CLIP-004, VOICE-CLIP-006, VOICE-CLIP-009, VOICE-CLIP-010
    const { dir, log } = this.d;
    const pad = Math.max(2, String(Math.max(0, this.lines.length - 1)).length);
    const clips: (ClipEntry & { wav: Buffer })[] = [];
    for (const [index, text] of this.lines.entries()) { // one phrase at a time, in list order
      if (this.stopped) return;
      try {
        const { wav, durationMs } = await this.speak(index, text);
        const sha256 = createHash("sha256").update(wav).digest("hex");
        clips.push({ name: `${String(index).padStart(pad, "0")}-${sha256.slice(0, 8)}.wav`, text, durationMs, bytes: wav.length, sha256, wav });
      } catch (err) {
        if (!(err instanceof Unspeakable)) throw err;
        log.warn({ index, text, err: err.message }, "fallback phrase skipped: not speakable");
      }
    }
    if (this.stopped) return;

    const generatedAt = this.now();
    const tag = randomBytes(4).toString("hex");
    const tmpDir = join(dir, `.tmp-${tag}`);
    const setName = `${generatedAt}-${tag}`;
    const setDir = join(dir, "sets", setName);
    const manifestTmp = join(dir, `.tmp-${tag}.json`);
    try {
      await mkdir(tmpDir, { recursive: true });
      for (const c of clips) await writeFile(join(tmpDir, c.name), c.wav);
      await mkdir(join(dir, "sets"), { recursive: true });
      await rename(tmpDir, setDir);
      const manifest: StoredManifest = {
        version: CLIP_FORMAT_VERSION, fingerprint: this.fingerprint, generatedAt, set: `sets/${setName}`,
        clips: clips.map(({ wav: _wav, ...entry }) => entry),
      };
      await writeFile(manifestTmp, JSON.stringify(manifest));
      await rename(manifestTmp, join(dir, "manifest.json"));
      this.committed = manifest;
    } catch (err) {
      await Promise.all([tmpDir, setDir, manifestTmp].map((p) => rm(p, { recursive: true, force: true }).catch(() => undefined)));
      throw err;
    }
    log.info({ clips: clips.length, set: setName }, "fallback clips committed");
    await this.cleanup(setName);
  }

  /** After a commit: drop every other set and every temporary entry older than an hour (VOICE-CLIP-007). Failures only log. */
  private async cleanup(keepSet: string): Promise<void> { // @spec VOICE-CLIP-007
    const { dir, log } = this.d;
    try {
      for (const name of await readdir(join(dir, "sets"))) {
        if (name !== keepSet) await rm(join(dir, "sets", name), { recursive: true, force: true });
      }
      for (const name of await readdir(dir)) {
        if (!name.startsWith(".tmp-")) continue;
        const age = Date.now() - (await stat(join(dir, name))).mtimeMs;
        if (age > STALE_TMP_MS) await rm(join(dir, name), { recursive: true, force: true });
      }
    } catch (err) {
      log.warn({ err: String(err) }, "fallback clip store cleanup failed");
    }
  }
}
