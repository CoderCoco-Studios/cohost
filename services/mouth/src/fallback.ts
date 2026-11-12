/**
 * The spoken fallback line's choice: mouth's memory of which sinks claimed a line, and, per output, whether a clip from the
 * clip cache (`clips.ts`) says a given-up utterance and which. Pure of Discord: playback lives in `playback.ts`.
 */
import type { ClipCache, FallbackClip } from "./clips.js";

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
