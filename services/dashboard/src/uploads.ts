export type UploadKind = "image" | "audio";

/** What the dashboard enforces on an injected upload; the bytes themselves live in Redis (`Bus.putUpload`). */
export interface UploadLimits {
  maxImageBytes: number;
  maxAudioBytes: number;
  /** Expiry of the Redis key, ms. */
  ttlMs: number;
}

const MiB = 1024 * 1024;

// @spec DASH-UPL-001, DASH-UPL-002
/**
 * Defaults per the spec, overridable by INJECT_MAX_IMAGE_BYTES / INJECT_MAX_AUDIO_BYTES / INJECT_TTL_MS
 * (a non-numeric or non-positive value falls back to the default). The 5 minute TTL outlasts the 60 s
 * staleness window of `inject.request`, so a request still answered is never answered with an expired upload.
 */
export function uploadOptionsFromEnv(env: NodeJS.ProcessEnv): UploadLimits {
  const num = (k: string, d: number) => {
    const n = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxImageBytes: num("INJECT_MAX_IMAGE_BYTES", 8 * MiB),
    maxAudioBytes: num("INJECT_MAX_AUDIO_BYTES", 25 * MiB),
    ttlMs: num("INJECT_TTL_MS", 300_000),
  };
}

export function uploadMaxBytes(limits: UploadLimits, kind: UploadKind): number {
  return kind === "image" ? limits.maxImageBytes : limits.maxAudioBytes;
}
