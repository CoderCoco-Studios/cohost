/**
 * The spoken fallback line: the clip cache ears keeps (memory plus a disk mirror), how it is refreshed from voice's
 * HTTP routes, and how a clip is chosen when ears gives up on an utterance. Pure of Discord: playback lives in `playback.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "@cohost/config";
import { parseWav } from "@cohost/shared";

/** One clip as voice's manifest lists it, plus its bytes. */
export interface FallbackClip {
  name: string;
  text: string;
  durationMs: number;
  bytes: number;
  sha256: string;
  wav: Buffer;
}

export interface ClipSet {
  fingerprint: string;
  clips: FallbackClip[];
}

/** How often ears asks voice for its manifest (EARS-FALL-014). */
export const CLIP_POLL_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 10_000;
/** Clip names become file names and URL path segments, so only plain ones are accepted. */
const SAFE_NAME = /^[\w][\w.-]*$/;

// ---- the cache

/** The clips ears may say, in memory; bad marks reset when the set's fingerprint changes. */
export class ClipCache {
  fingerprint: string | undefined;
  clips: FallbackClip[] = [];
  private bad = new Set<string>();

  /** Swap the whole set at once. */
  replace(set: ClipSet): void { // @spec EARS-FALL-015, EARS-FALL-008
    if (set.fingerprint !== this.fingerprint) this.bad.clear();
    this.fingerprint = set.fingerprint;
    this.clips = set.clips;
  }

  markBad(name: string): void { this.bad.add(name); } // @spec EARS-FALL-008

  eligible(): FallbackClip[] { return this.clips.filter((c) => !this.bad.has(c.name)); }
}

// ---- choosing a clip

export interface FallbackLineDeps {
  cache: ClipCache;
  /** `ears.fallback.min_interval_ms`. */
  minIntervalMs: number;
  now?: () => number;
  random?: () => number;
}

const REMEMBERED_IDS = 50;

/**
 * Decides whether ears says a fallback clip for a given-up utterance, and which. Also remembers which of the newest
 * utterance ids a real sink other than `discord` has claimed (EARS-FALL-010).
 */
export class FallbackLine {
  private claimedElsewhere = new Map<string, boolean>();
  private lastStartedAt: number | undefined;
  private lastText: string | undefined;
  private now: () => number;
  private random: () => number;

  constructor(private d: FallbackLineDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  private remember(id: string): boolean {
    if (!this.claimedElsewhere.has(id)) {
      this.claimedElsewhere.set(id, false);
      if (this.claimedElsewhere.size > REMEMBERED_IDS) this.claimedElsewhere.delete(this.claimedElsewhere.keys().next().value!);
    }
    return this.claimedElsewhere.has(id);
  }

  /** A `voice.utterance` ears read. */
  seen(id: string): void { this.remember(id); } // @spec EARS-FALL-010

  /** A `voice.playing` ears read: a real sink other than `discord` (and not voice's own virtual one) claimed `id`. */
  claim(id: string, sink: string): void { // @spec EARS-FALL-010
    if (sink === "discord" || sink === "virtual") return;
    if (this.remember(id)) this.claimedElsewhere.set(id, true);
  }

  /** The clip to say in place of `id`, or none (claimed elsewhere, storm limit, nothing eligible). */
  pick(id: string): FallbackClip | undefined { // @spec EARS-FALL-004, EARS-FALL-005, EARS-FALL-006, EARS-FALL-007, EARS-FALL-009
    if (this.claimedElsewhere.get(id)) return undefined;
    if (this.lastStartedAt !== undefined && this.now() - this.lastStartedAt < this.d.minIntervalMs) return undefined;
    const eligible = this.d.cache.eligible();
    const fresh = eligible.filter((c) => c.text !== this.lastText);
    const pool = fresh.length > 0 ? fresh : eligible;
    if (pool.length === 0) return undefined;
    return pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
  }

  /** The player has the clip: start the storm interval and remember the phrase. */
  started(clip: FallbackClip): void { // @spec EARS-FALL-007, EARS-FALL-006
    this.lastStartedAt = this.now();
    this.lastText = clip.text;
  }

  markBad(clip: FallbackClip): void { this.d.cache.markBad(clip.name); } // @spec EARS-FALL-008
}

// ---- the disk mirror

interface ManifestEntry { name: string; text: string; durationMs: number; bytes: number; sha256: string }

/** Throws unless `wav` is exactly the clip `entry` describes and parses as a 16-bit WAV. */
function verify(wav: Buffer, entry: ManifestEntry): void {
  if (wav.length !== entry.bytes) throw new Error(`${entry.name}: ${wav.length} bytes, manifest says ${entry.bytes}`);
  if (createHash("sha256").update(wav).digest("hex") !== entry.sha256) throw new Error(`${entry.name}: checksum mismatch`);
  const info = parseWav(wav);
  if (info.bitsPerSample !== 16) throw new Error(`${entry.name}: ${info.bitsPerSample}-bit WAV`);
}

/** The manifest's shape, or a thrown error. Extra fields (version, generatedAt) are ignored. */
function parseManifest(json: unknown): { fingerprint: string; clips: ManifestEntry[] } {
  const m = json as { fingerprint?: unknown; clips?: unknown } | null;
  if (!m || typeof m !== "object" || typeof m.fingerprint !== "string" || !Array.isArray(m.clips)) throw new Error("bad manifest");
  const clips = m.clips.map((c: Record<string, unknown>): ManifestEntry => {
    const ok = c && typeof c.name === "string" && SAFE_NAME.test(c.name) && typeof c.text === "string"
      && typeof c.bytes === "number" && typeof c.sha256 === "string" && typeof c.durationMs === "number";
    if (!ok) throw new Error("bad manifest clip");
    return { name: c.name as string, text: c.text as string, durationMs: c.durationMs as number, bytes: c.bytes as number, sha256: c.sha256 as string };
  });
  return { fingerprint: m.fingerprint, clips };
}

/**
 * ears' own copy of the set on disk: `manifest.json` plus one file per clip, in `dir` (`<dataDir()>/ears/fallback-clips`).
 * Nothing else reads or writes it (EARS-FALL-012).
 */
export class ClipMirror {
  constructor(private dir: string) {}

  /** The mirrored set, or `undefined` when there is no mirror yet. Throws when it exists but is unreadable or fails its checks. */
  async load(): Promise<ClipSet | undefined> { // @spec EARS-FALL-018
    let raw: string;
    try {
      raw = await readFile(join(this.dir, "manifest.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const m = parseManifest(JSON.parse(raw));
    const clips: FallbackClip[] = [];
    for (const entry of m.clips) {
      const wav = await readFile(join(this.dir, entry.name));
      verify(wav, entry);
      clips.push({ ...entry, wav });
    }
    return { fingerprint: m.fingerprint, clips };
  }

  /** Write the set to a temporary directory next to `dir` and swap it in by rename. Cleans up after a failure. */
  async save(set: ClipSet): Promise<void> { // @spec EARS-FALL-015, EARS-FALL-012
    const parent = dirname(this.dir);
    const tag = randomBytes(4).toString("hex");
    const tmpDir = join(parent, `.${basename(this.dir)}.tmp-${tag}`);
    const oldDir = join(parent, `.${basename(this.dir)}.old-${tag}`);
    await mkdir(parent, { recursive: true });
    try {
      await mkdir(tmpDir);
      for (const c of set.clips) await writeFile(join(tmpDir, c.name), c.wav);
      const manifest = { version: 1, fingerprint: set.fingerprint, clips: set.clips.map(({ wav: _wav, ...entry }) => entry) };
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest));
      let hadOld = true;
      await rename(this.dir, oldDir).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; hadOld = false; });
      try {
        await rename(tmpDir, this.dir);
      } catch (err) {
        if (hadOld) await rename(oldDir, this.dir).catch(() => undefined);
        throw err;
      }
      if (hadOld) await rm(oldDir, { recursive: true, force: true });
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }
}

// ---- refreshing from voice

export interface RefreshDeps {
  /** `urls.voice()`. */
  baseUrl: string;
  cache: ClipCache;
  mirror: ClipMirror;
  log: Pick<Logger, "warn" | "debug" | "info">;
  fetch?: typeof fetch;
}

/**
 * Ask voice for its manifest and, when the fingerprint differs from the cache's, download and verify the whole set and
 * swap it in. Anything that goes wrong keeps the current set (`kept`); never throws.
 */
// @spec EARS-FALL-015, EARS-FALL-016, EARS-FALL-017, EARS-FALL-019, EARS-FALL-012
export async function refreshClips({ baseUrl, cache, mirror, log, fetch: doFetch = fetch }: RefreshDeps): Promise<"unchanged" | "replaced" | "kept"> {
  const get = (path: string) => doFetch(`${baseUrl}/fallback/${path}`, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  let manifest: ReturnType<typeof parseManifest>;
  try {
    const res = await get("manifest.json");
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      log.debug({ status: res.status }, "fallback manifest unavailable: keeping the clip cache");
      return "kept";
    }
    manifest = parseManifest(await res.json());
  } catch (err) {
    log.debug({ err: String(err) }, "fallback manifest request failed: keeping the clip cache");
    return "kept";
  }
  if (manifest.fingerprint === cache.fingerprint) return "unchanged";

  const clips: FallbackClip[] = [];
  try {
    for (const entry of manifest.clips) {
      const res = await get(encodeURIComponent(entry.name));
      if (!res.ok) throw new Error(`${entry.name}: voice answered ${res.status}`);
      const wav = Buffer.from(await res.arrayBuffer());
      verify(wav, entry);
      clips.push({ ...entry, wav });
    }
  } catch (err) {
    log.warn({ err: String(err) }, "fallback clip download abandoned: keeping the previous clips");
    return "kept";
  }

  const set = { fingerprint: manifest.fingerprint, clips };
  cache.replace(set);
  log.info({ clips: clips.length }, "fallback clips refreshed");
  try {
    await mirror.save(set);
  } catch (err) {
    log.warn({ err: String(err) }, "fallback clip mirror not written: using the clips from memory");
  }
  return "replaced";
}

export interface ClipSyncDeps extends RefreshDeps {
  intervalMs?: number;
}

/**
 * Load the mirrored set, then refresh from voice at once and every `intervalMs`. A poll never overlaps the previous one.
 * `first` resolves when the mirror is loaded and the first refresh is done; `stop` ends the polling.
 */
// @spec EARS-FALL-014, EARS-FALL-018
export function startClipSync(deps: ClipSyncDeps): { first: Promise<void>; stop(): void } {
  const { cache, mirror, log } = deps;
  let stopped = false;
  let running = false;
  let loaded = false; // the mirror is read before any manifest request
  const poll = async () => {
    if (running || stopped) return;
    running = true;
    try { await refreshClips(deps); } finally { running = false; }
  };
  const first = (async () => {
    try {
      const set = await mirror.load();
      if (set) { cache.replace(set); log.info({ clips: set.clips.length }, "fallback clips loaded from the mirror"); }
    } catch (err) {
      log.warn({ err: String(err) }, "fallback clip mirror unreadable: starting with no clips");
    }
    loaded = true;
    await poll();
  })();
  const timer = setInterval(() => { if (loaded) void poll(); }, deps.intervalMs ?? CLIP_POLL_MS);
  return { first, stop: () => { stopped = true; clearInterval(timer); } };
}
