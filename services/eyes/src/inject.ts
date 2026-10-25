import type { BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";

/** Requests older than this are dropped (consumer groups resume after a restart). */
export const INJECT_STALE_MS = 60_000;

export interface InjectDeps {
  bus: Publisher;
  log: Logger;
  /** `urls.dashboard()`: the only origin uploads may be fetched from. */
  dashboardUrl: string;
  /** Same describer `Eyes.look()` uses. */
  describe: (b64: string, previous: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Returns the URL to fetch when it lies under `<dashboardUrl>/uploads/` (same origin, normalised
 * path), else undefined. Guards against the bus being used to make eyes fetch arbitrary URLs.
 */
export function uploadUrl(raw: string | undefined, dashboardUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const base = new URL(dashboardUrl);
    if (u.origin !== base.origin || u.username || u.password) return undefined;
    const prefix = base.pathname.replace(/\/+$/, "") + "/uploads/";
    return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handles `inject.request` for eyes: fetches the uploaded image, describes it with an empty
 * previous description (so it neither sees SAME nor touches `Eyes.look()`'s change tracking) and
 * publishes an injected `vision.summary`. Needs no OBS and works with `vision.enabled=false`.
 */
export function createInjectHandler(d: InjectDeps): (ev: BusEvent<"inject.request">) => Promise<void> {
  const doFetch = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  return async (ev) => {
    const r = ev.data;
    if (r.target !== "eyes") return;
    const result = (ok: boolean, detail?: string) => d.bus.publish("inject.result", { id: r.id, ok, ...(detail ? { detail } : {}) });
    try {
      if (now() - ev.ts > INJECT_STALE_MS) return void (await result(false, "stale"));
      if (r.kind !== "image") return void (await result(false, `eyes cannot handle kind '${r.kind}'`));
      const target = uploadUrl(r.url, d.dashboardUrl);
      if (!target) return void (await result(false, "url is not an upload of this dashboard"));
      const res = await doFetch(target, { redirect: "error" });
      if (!res.ok) return void (await result(false, `fetch upload ${res.status}`));
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
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
