export type UploadKind = "image" | "audio";

/** What the dashboard enforces on an injected upload; the bytes themselves live in Redis (`Bus.putUpload`). */
export interface UploadLimits {
  maxImageBytes: number;
  maxAudioBytes: number;
  /** Expiry of the Redis key, ms. */
  ttlMs: number;
}

/**
 * The limits from `dashboard.inject` of the loaded config, which validated them (positive integers) and holds the defaults: 8 MiB
 * image, 25 MiB audio, a 5 minute expiry that outlasts the 60 s staleness window of `inject.request`, so a request still answered
 * is never answered with an expired upload. No environment variable is read.
 */
// @spec DASH-UPL-001, DASH-UPL-002
export function uploadLimits(inject: { max_image_bytes: number; max_audio_bytes: number; ttl_ms: number }): UploadLimits {
  return { maxImageBytes: inject.max_image_bytes, maxAudioBytes: inject.max_audio_bytes, ttlMs: inject.ttl_ms };
}

export function uploadMaxBytes(limits: UploadLimits, kind: UploadKind): number {
  return kind === "image" ? limits.maxImageBytes : limits.maxAudioBytes;
}
