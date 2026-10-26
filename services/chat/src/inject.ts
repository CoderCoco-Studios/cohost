import type { BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";

/** Requests older than this are dropped (consumer groups resume after a restart). */
export const INJECT_STALE_MS = 60_000;

export interface InjectDeps {
  bus: Publisher;
  log: Logger;
  cohostName: string;
  now?: () => number;
}

/**
 * Handles `inject.request` for chat: publishes the text as an injected `chat.message`, as a viewer.
 * `chat.ignore_users` / `chat.ignore_prefixes` are deliberately NOT applied (a dropped test is useless),
 * and nothing here depends on `chat.source` or a Twitch connection.
 */
export function createInjectHandler(d: InjectDeps): (ev: BusEvent<"inject.request">) => Promise<void> {
  const now = d.now ?? Date.now;
  const name = d.cohostName.toLowerCase();
  return async (ev) => {
    const r = ev.data;
    if (r.target !== "chat") return;
    const result = (ok: boolean, detail?: string) => d.bus.publish("inject.result", { id: r.id, ok, ...(detail ? { detail } : {}) });
    try {
      if (now() - ev.ts > INJECT_STALE_MS) return void (await result(false, "stale"));
      if (r.kind !== "text") return void (await result(false, `chat cannot handle kind '${r.kind}'`));
      const text = (r.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) return void (await result(false, "blank text"));
      await d.bus.publish("chat.message", {
        platform: r.meta?.platform ?? "twitch",
        user: r.meta?.user || "injected_viewer",
        text,
        isMod: r.meta?.isMod ?? false,
        isSub: r.meta?.isSub ?? false,
        mentionsCohost: text.toLowerCase().includes(name),
        injected: true,
        remember: r.remember,
      });
      d.log.info({ id: r.id, user: r.meta?.user }, "injected chat message");
      await result(true);
    } catch (err) {
      d.log.warn({ err: String(err), id: r.id }, "chat injection failed");
      try { await result(false, String(err)); } catch { /* bus down: nothing more to do */ }
    }
  };
}
