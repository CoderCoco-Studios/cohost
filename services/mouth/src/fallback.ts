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
 * mouth's memory of `voice.playing` claims for the newest 50 lines (by line id), per clause, from the one `mouth` loop. One memory
 * serves every output (MOUTH-FALL-010); each output's `FallbackLine` excludes its own sink name when it reads it.
 */
export class ClaimMemory {
  private claims = new Map<string, Map<number, Set<string>>>();

  private remember(id: string, seq: number): Set<string> {
    let clauses = this.claims.get(id);
    if (!clauses) {
      clauses = new Map();
      this.claims.set(id, clauses);
      if (this.claims.size > REMEMBERED_IDS) this.claims.delete(this.claims.keys().next().value!);
    }
    let sinks = clauses.get(seq);
    if (!sinks) clauses.set(seq, (sinks = new Set()));
    return sinks;
  }

  /** A `voice.utterance` mouth read: clause `seq` of line `id`. */
  seen(id: string, seq = 0): void { this.remember(id, seq); } // @spec MOUTH-FALL-010

  /** A `voice.playing` mouth read: `sink` claimed clause `seq` of `id`. Virtual and error claims are not real sinks and are not kept. */
  claim(id: string, sink: string, seq = 0): void { // @spec MOUTH-FALL-010
    if (NOT_REAL_SINKS.has(sink)) return;
    this.remember(id, seq).add(sink);
  }

  /** The real sinks that claimed clause `seq` of `id` so far. */
  claimedBy(id: string, seq = 0): ReadonlySet<string> { return this.claims.get(id)?.get(seq) ?? new Set(); }
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

  /** The clip to say in place of clause `seq` of line `id`, or none (claimed elsewhere, storm limit, nothing eligible). */
  pick(id: string, seq = 0): FallbackClip | undefined { // @spec MOUTH-FALL-004, MOUTH-FALL-005, MOUTH-FALL-006, MOUTH-FALL-007, MOUTH-FALL-009
    for (const sink of this.d.claims.claimedBy(id, seq)) if (sink !== this.d.sink) return undefined;
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
