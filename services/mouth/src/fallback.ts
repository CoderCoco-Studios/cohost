/**
 * The spoken fallback line: the clip cache mouth keeps (memory plus a disk mirror), how it is refreshed from voice's
 * HTTP routes, and how a clip is chosen when mouth gives up on an utterance. Pure of Discord: playback lives in `playback.ts`.
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

/** How often mouth asks voice for its manifest (MOUTH-FALL-014). */
export const CLIP_POLL_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 10_000;
/** Clip names become file names and URL path segments, so only plain ones are accepted. */
const SAFE_NAME = /^[\w][\w.-]*$/;

// ---- the cache

/** The clips mouth may say, in memory, shared by every output. Bad marks are per output (`FallbackLine`). */
export class ClipCache {
  fingerprint: string | undefined;
  clips: FallbackClip[] = [];

  /** Swap the whole set at once. */
  replace(set: ClipSet): void { // @spec MOUTH-FALL-015
    this.fingerprint = set.fingerprint;
    this.clips = set.clips;
  }
}

/** The directory the clip mirror lives in: `<dataDir()>/mouth/fallback-clips`, mouth's alone. */
export function clipDir(dataRoot: string): string { // @spec MOUTH-FALL-012
  return join(dataRoot, "mouth", "fallback-clips");
}

// ---- which real sinks have claimed a line

const REMEMBERED_IDS = 50;

/** Sinks that are not a real audience: voice's own virtual sink and the error pseudo-sink. */
const NOT_REAL_SINKS = new Set(["virtual", "error"]);

/**
 * mouth's memory of `voice.playing` claims for the newest 50 utterance ids, from the one `mouth` loop. One memory serves
 * every output (MOUTH-FALL-010); each output's `FallbackLine` excludes its own sink name when it reads it.
 */
export class ClaimMemory {
  private claims = new Map<string, Set<string>>();

  private remember(id: string): Set<string> {
    let sinks = this.claims.get(id);
    if (!sinks) {
      sinks = new Set();
      this.claims.set(id, sinks);
      if (this.claims.size > REMEMBERED_IDS) this.claims.delete(this.claims.keys().next().value!);
    }
    return sinks;
  }

  /** A `voice.utterance` mouth read. */
  seen(id: string): void { this.remember(id); } // @spec MOUTH-FALL-010

  /** A `voice.playing` mouth read: `sink` claimed `id`. Virtual and error claims are not real sinks and are not kept. */
  claim(id: string, sink: string): void { // @spec MOUTH-FALL-010
    if (NOT_REAL_SINKS.has(sink)) return;
    this.remember(id).add(sink);
  }

  /** The real sinks that claimed `id` so far. */
  claimedBy(id: string): ReadonlySet<string> { return this.claims.get(id) ?? new Set(); }
}

// ---- choosing a clip

export interface FallbackLineDeps {
  cache: ClipCache;
  claims: Pick<ClaimMemory, "claimedBy">;
  /** The output's sink name: claims by this name do not count as another sink having the line. */
  sink: string;
  /** `mouth.fallback.min_interval_ms`. */
  minIntervalMs: number;
  now?: () => number;
  random?: () => number;
}

/**
 * One output's fallback state over the shared clip cache: whether it says a clip for a given-up utterance and which,
 * its storm timer, the phrase it started last and its bad-clip marks (MOUTH-ROUTE-004). All of it lives in memory; the
 * marks reset when the cache's fingerprint changes.
 */
export class FallbackLine {
  private lastStartedAt: number | undefined;
  private lastText: string | undefined;
  private bad = new Set<string>();
  private badFor: string | undefined;
  private now: () => number;
  private random: () => number;

  constructor(private d: FallbackLineDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  /** Cached clips not marked bad for this output. */
  eligible(): FallbackClip[] { // @spec MOUTH-FALL-005, MOUTH-FALL-008
    if (this.badFor !== this.d.cache.fingerprint) { this.bad.clear(); this.badFor = this.d.cache.fingerprint; }
    return this.d.cache.clips.filter((c) => !this.bad.has(c.name));
  }

  /** The clip to say in place of `id`, or none (claimed elsewhere, storm limit, nothing eligible). */
  pick(id: string): FallbackClip | undefined { // @spec MOUTH-FALL-004, MOUTH-FALL-005, MOUTH-FALL-006, MOUTH-FALL-007, MOUTH-FALL-009
    for (const sink of this.d.claims.claimedBy(id)) if (sink !== this.d.sink) return undefined;
    if (this.lastStartedAt !== undefined && this.now() - this.lastStartedAt < this.d.minIntervalMs) return undefined;
    const eligible = this.eligible();
    const fresh = eligible.filter((c) => c.text !== this.lastText);
    const pool = fresh.length > 0 ? fresh : eligible;
    if (pool.length === 0) return undefined;
    return pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
  }

  /** The player has the clip: start the storm interval and remember the phrase. */
  started(clip: FallbackClip): void { // @spec MOUTH-FALL-007, MOUTH-FALL-006
    this.lastStartedAt = this.now();
    this.lastText = clip.text;
  }

  /** The clip failed conversion: never pick it again for this output until the cache's fingerprint changes. */
  markBad(clip: FallbackClip): void { // @spec MOUTH-FALL-008
    this.eligible(); // settle the marks against the current fingerprint first
    this.bad.add(clip.name);
  }
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
 * mouth's own copy of the set on disk: `manifest.json` plus one file per clip, in `dir` (`<dataDir()>/mouth/fallback-clips`).
 * Nothing else reads or writes it (MOUTH-FALL-012).
 */
export class ClipMirror {
  constructor(private dir: string) {}

  /** The mirrored set, or `undefined` when there is no mirror yet. Throws when it exists but is unreadable or fails its checks. */
  async load(): Promise<ClipSet | undefined> { // @spec MOUTH-FALL-018
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
  async save(set: ClipSet): Promise<void> { // @spec MOUTH-FALL-015, MOUTH-FALL-012
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
// @spec MOUTH-FALL-015, MOUTH-FALL-016, MOUTH-FALL-017, MOUTH-FALL-019, MOUTH-FALL-012
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
// @spec MOUTH-FALL-014, MOUTH-FALL-018
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
