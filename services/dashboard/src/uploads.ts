import { randomBytes } from "node:crypto";

export type UploadKind = "image" | "audio";

export interface Upload {
  id: string;
  kind: UploadKind;
  contentType: string;
  data: Buffer;
  expiresAt: number;
}

export interface UploadStoreOptions {
  maxImageBytes: number;
  maxAudioBytes: number;
  ttlMs: number;
  maxEntries: number;
  maxTotalBytes: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const MiB = 1024 * 1024;

/** Defaults per the spec, overridable by INJECT_MAX_IMAGE_BYTES / INJECT_MAX_AUDIO_BYTES / INJECT_TTL_MS. */
export function uploadOptionsFromEnv(env: NodeJS.ProcessEnv): UploadStoreOptions {
  const num = (k: string, d: number) => {
    const n = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxImageBytes: num("INJECT_MAX_IMAGE_BYTES", 8 * MiB),
    maxAudioBytes: num("INJECT_MAX_AUDIO_BYTES", 25 * MiB),
    ttlMs: num("INJECT_TTL_MS", 600_000),
    maxEntries: 16,
    maxTotalBytes: 64 * MiB,
  };
}

/**
 * Bounded in-memory store for injected test uploads. Entries expire after `ttlMs` (swept lazily on
 * access and by `sweep()`), and the oldest are evicted past `maxEntries` / `maxTotalBytes`.
 * Ids are 128 random bits: the URL is the capability, ids are never listed.
 */
export class UploadStore {
  private readonly entries = new Map<string, Upload>(); // insertion order = age order
  private total = 0;
  private readonly now: () => number;
  constructor(readonly opts: UploadStoreOptions) {
    this.now = opts.now ?? Date.now;
  }

  maxBytes(kind: UploadKind): number {
    return kind === "image" ? this.opts.maxImageBytes : this.opts.maxAudioBytes;
  }

  /** Stores the bytes and returns the new id. Throws when over the per-kind cap. */
  put(kind: UploadKind, contentType: string, data: Buffer): string {
    if (data.length > this.maxBytes(kind)) throw new Error(`${kind} upload exceeds ${this.maxBytes(kind)} bytes`);
    this.sweep();
    const id = randomBytes(16).toString("hex");
    this.entries.set(id, { id, kind, contentType, data, expiresAt: this.now() + this.opts.ttlMs });
    this.total += data.length;
    while (this.entries.size > this.opts.maxEntries || (this.total > this.opts.maxTotalBytes && this.entries.size > 1)) {
      const oldest = this.entries.keys().next().value as string;
      this.drop(oldest);
    }
    return id;
  }

  get(id: string): Upload | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) { this.drop(id); return undefined; }
    return e;
  }

  /** Removes expired entries. */
  sweep(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= t) this.drop(id);
  }

  get size(): number { return this.entries.size; }

  private drop(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.total -= e.data.length;
    this.entries.delete(id);
  }
}
