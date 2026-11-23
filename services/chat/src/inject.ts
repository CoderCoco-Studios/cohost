import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { createInjectHandler as createSharedInjectHandler, type InjectHandler } from "@cohost/shared";
import { boundText } from "@cohost/shared/untrusted";
import { mentionsCohost } from "./filter.js";

export interface InjectDeps {
  bus: Publisher;
  log: Logger;
  cohostName: string;
  viewerText: { max_chars: number; max_name_chars: number };
  now?: () => number;
}

// @spec CHAT-INJ-010, CHAT-INJ-004, CHAT-INJ-005, CHAT-INJ-006, CHAT-INJ-007, CHAT-INJ-008, CHAT-INJ-011, CHAT-INJ-012
/**
 * Handles `inject.request` for chat through the shared inject handler (target `chat`, the one kind `text`): the text
 * is published as an injected `chat.message`, as a viewer. `chat.ignore_users` / `chat.ignore_prefixes` are deliberately
 * NOT applied (a dropped test is useless), and nothing here depends on `chat.sources` or a Twitch connection.
 */
export function createInjectHandler(d: InjectDeps): InjectHandler {
  const { max_chars, max_name_chars } = d.viewerText;
  return createSharedInjectHandler({
    target: "chat", bus: d.bus, log: d.log, now: d.now, maxBytes: {},
    kinds: {
      text: async (r) => {
        const text = boundText(r.text ?? "", max_chars);
        if (!text) return { ok: false, detail: "blank text" };
        const user = boundText(r.meta?.user ?? "", max_name_chars) || "injected_viewer";
        await d.bus.publish("chat.message", {
          platform: r.meta?.platform ?? "twitch",
          user,
          text,
          isMod: r.meta?.isMod ?? false,
          isSub: r.meta?.isSub ?? false,
          mentionsCohost: mentionsCohost(text, d.cohostName),
          injected: true,
          remember: r.remember,
        });
        d.log.info({ id: r.id, user }, "injected chat message");
        return {};
      },
    },
  });
}
