import type { ApiResult } from "../../state/api";

/** The test-input constants, in one place: the chat platforms, which service answers each kind, and how long to wait for it. */
export const PLATFORMS = ["twitch", "youtube", "discord"] as const;
export type InjectKind = "text" | "image" | "audio";
export type BusAs = "chat" | "speech" | "vision";
/** The service that answers a service-level injection of each kind (its `inject.result` is what the status line waits for). */
export const INJECT_TARGET: Record<InjectKind, string> = { text: "chat", image: "eyes", audio: "ears" };
/** How long a service-level injection waits for its `inject.result` before the target is reported as not responding (DASH-UI-010). */
export const RESULT_TIMEOUT_MS = 10_000;
/** `inject.result` events kept so one that arrives before its HTTP response can still be matched. */
export const RESULT_CACHE = 50;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export const MIB = 1024 * 1024;
/** The upload caps used until `GET /config/dashboard` answers, and when it fails: the config schema's defaults (DASH-UPL-001). */
export const DEFAULT_LIMITS = { image: 8 * MIB, audio: 25 * MIB } as const;
export type Limits = { image: number; audio: number };

/** Bytes as MiB text without trailing zeros ("8", "2.5"). */
export const formatMiB = (bytes: number): string => String(Number((bytes / MIB).toFixed(1)));

/** The two caps from a `GET /config/dashboard` body (`keys["inject.max_image_bytes"].value`); a missing or odd value keeps its default. */
export function parseLimits(data: unknown): Limits {
  const keys = (data as { keys?: Record<string, { value?: unknown }> } | undefined)?.keys ?? {};
  const pick = (k: string, fallback: number): number => {
    const v = keys[k]?.value;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return { image: pick("inject.max_image_bytes", DEFAULT_LIMITS.image), audio: pick("inject.max_audio_bytes", DEFAULT_LIMITS.audio) };
}

/** The refusal text for a file over its cap, shown beside the picker (DASH-UI-034). */
export const tooLarge = (name: string, size: number, limit: number): string => `${name} is ${formatMiB(size)} MiB; the limit is ${formatMiB(limit)} MiB.`;

/** A failed request as one line: the HTTP status and the server's detail, or the detail alone for a network error or a cancelled unlock. */
export const failureText = (r: Extract<ApiResult<unknown>, { ok: false }>): string => (r.locked || r.status === 0 ? r.detail : `${r.status} ${r.detail}`);

/** An `inject.result`'s data as the status line states it. */
export interface InjectResult { id: string; ok?: boolean; detail?: string }
export function resultStatus(r: InjectResult): { tone: "ok" | "bad"; text: string } {
  const detail = typeof r.detail === "string" && r.detail ? `: ${r.detail}` : "";
  return r.ok ? { tone: "ok", text: `ok${detail}` } : { tone: "bad", text: `failed${detail}` };
}
