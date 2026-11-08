import type { Bus, BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { INJECT_STALE_MS, uploadUrl } from "@cohost/shared";
import { isTimeout } from "./eyes.js";

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

/** The slice of `Bus` the inject subscription needs. */
export type InjectBus = Pick<Bus, "resetGroup" | "subscribe">;

// @spec EYES-INJ-001, EYES-INJ-014
/**
 * Subscribe the `eyes` consumer group to `inject.request` with start mode `latest`. Resolves once
 * the group exists (`resetGroup` creates it at `$`), so the caller can signal `ready` only after the
 * subscription is established; the read loop itself keeps running in the background.
 */
export async function subscribeInject(
  bus: InjectBus,
  handler: (ev: BusEvent<"inject.request">) => Promise<void>,
  log: Pick<Logger, "error">,
): Promise<void> {
  await bus.resetGroup("eyes");
  bus.subscribe({ group: "eyes", types: ["inject.request"], start: "latest" }, handler).catch((err) => {
    log.error({ err }, "inject.request subscription failed");
    process.exit(1);
  });
}

/** Read a response body, giving up (undefined) as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// @spec EYES-INJ-002, EYES-INJ-003, EYES-INJ-004, EYES-INJ-005, EYES-INJ-006, EYES-INJ-007, EYES-INJ-008, EYES-INJ-009, EYES-INJ-010, EYES-INJ-012, EYES-INJ-013
/**
 * Handles `inject.request` for eyes: fetches the uploaded image, describes it with an empty
 * previous description (so it neither sees SAME nor touches `Eyes.look()`'s change tracking) and
 * publishes an injected `vision.summary`. Needs no OBS and works with `vision.enabled=false`.
 */
export function createInjectHandler(d: InjectDeps): (ev: BusEvent<"inject.request">) => Promise<void> {
  const doFetch = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const timeoutMs = d.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  const maxBytes = d.uploadMaxBytes ?? UPLOAD_MAX_BYTES;
  return async (ev) => {
    const r = ev.data;
    if (r.target !== "eyes") return;
    const result = (ok: boolean, detail?: string) => d.bus.publish("inject.result", { id: r.id, ok, ...(detail ? { detail } : {}) });
    try {
      if (now() - ev.ts > INJECT_STALE_MS) return void (await result(false, "stale"));
      if (r.kind !== "image") return void (await result(false, `eyes cannot handle kind '${r.kind}'`));
      const target = uploadUrl(r.url, d.dashboardUrl);
      if (!target) return void (await result(false, "url is not an upload of this dashboard"));
      let bytes: Buffer | undefined;
      // A ref'd timer, not `AbortSignal.timeout`: that one is unref'd, so on Node 22 a fetch that never
      // answers lets the event loop drain before the abort fires. Cleared once headers and body are in.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
      try {
        const res = await doFetch(target, { redirect: "error", signal: ctl.signal });
        if (!res.ok) return void (await result(false, `fetch upload ${res.status}`));
        bytes = await readCapped(res, maxBytes);
      } catch (err) {
        if (!isTimeout(err)) throw err;
        return void (await result(false, `fetch upload timed out after ${timeoutMs} ms`));
      } finally {
        clearTimeout(timer);
      }
      if (!bytes) return void (await result(false, `upload larger than the ${maxBytes} byte limit`));
      const b64 = bytes.toString("base64");
      const text = (await d.describe(b64, "")).trim();
      if (!text || /^same\b/i.test(text)) return void (await result(false, "no description"));
      await d.bus.publish("vision.summary", { text, changed: true, injected: true, remember: r.remember });
      d.log.info({ id: r.id, text }, "saw (injected)");
      await result(true, text);
    } catch (err) {
      d.log.warn({ err: String(err), id: r.id }, "image injection failed");
      try { await result(false, String(err)); } catch { /* bus down */ }
    }
  };
}
