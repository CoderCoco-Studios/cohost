import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { createInjectHandler as createSharedInjectHandler, type InjectHandler } from "@cohost/shared";

export interface InjectDeps {
  bus: Publisher;
  log: Logger;
  cohostName: string;
  now?: () => number;
}

// @spec CHAT-INJ-002, CHAT-INJ-003, CHAT-INJ-004, CHAT-INJ-005, CHAT-INJ-006, CHAT-INJ-007, CHAT-INJ-008
/**
 * Handles `inject.request` for chat through the shared inject handler (target `chat`, the one kind `text`): the text
 * is published as an injected `chat.message`, as a viewer. `chat.ignore_users` / `chat.ignore_prefixes` are deliberately
 * NOT applied (a dropped test is useless), and nothing here depends on `chat.source` or a Twitch connection.
 */
export function createInjectHandler(d: InjectDeps): InjectHandler {
  const name = d.cohostName.toLowerCase();
  return createSharedInjectHandler({
    target: "chat", bus: d.bus, log: d.log, dashboardUrl: "", now: d.now, maxBytes: {},
    kinds: {
      text: async (r) => {
        const text = (r.text ?? "").replace(/\s+/g, " ").trim();
        if (!text) return { ok: false, detail: "blank text" };
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
        return {};
      },
    },
  });
}
