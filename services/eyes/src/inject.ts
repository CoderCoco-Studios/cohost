import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { createInjectHandler as createSharedInjectHandler, type InjectHandler } from "@cohost/shared";

/** Defaults for the `vision.upload_timeout_ms` and `vision.upload_max_bytes` config keys. */
export const UPLOAD_TIMEOUT_MS = 10_000;
export const UPLOAD_MAX_BYTES = 8_388_608;

export interface InjectDeps {
  bus: Publisher;
  log: Logger;
  /** `urls.dashboard()`: the only origin uploads may be fetched from. */
  dashboardUrl: string;
  /** Same describer `Eyes.look()` uses. */
  describe: (b64: string, previous: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Abort the upload fetch (headers and body) after this long, ms (`vision.upload_timeout_ms`). */
  uploadTimeoutMs?: number;
  /** Refuse an upload larger than this many bytes (`vision.upload_max_bytes`). */
  uploadMaxBytes?: number;
}

// @spec EYES-INJ-016, EYES-INJ-007, EYES-INJ-008, EYES-INJ-009, EYES-INJ-010
/**
 * Handles `inject.request` for eyes through the shared inject handler (target `eyes`, the one kind `image`): the
 * uploaded image is described with an empty previous description (so it neither sees SAME nor touches
 * `Eyes.look()`'s change tracking) and published as an injected `vision.summary`. Needs no OBS and works with
 * `vision.enabled=false`.
 */
export function createInjectHandler(d: InjectDeps): InjectHandler {
  return createSharedInjectHandler({
    target: "eyes", bus: d.bus, log: d.log, dashboardUrl: d.dashboardUrl, fetch: d.fetch, now: d.now,
    fetchTimeoutMs: d.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
    maxBytes: { image: d.uploadMaxBytes ?? UPLOAD_MAX_BYTES },
    kinds: {
      image: async (bytes, r) => {
        const text = (await d.describe(bytes.toString("base64"), "")).trim();
        if (!text || /^same\b/i.test(text)) return { ok: false, detail: "no description" };
        await d.bus.publish("vision.summary", { text, changed: true, injected: true, remember: r.remember });
        d.log.info({ id: r.id, text }, "saw (injected)");
        return { detail: text };
      },
    },
  });
}
