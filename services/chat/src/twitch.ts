import type { RefreshingAuthProvider } from "@twurple/auth";
import type { EventInput, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { ChatUserInfo } from "./filter.js";

export interface MessageDeps {
  toEvent: (user: string, text: string, info: ChatUserInfo) => EventInput<"chat.message"> | undefined;
  bus: Publisher;
  log: Logger;
}

// @spec CHAT-TW-008, CHAT-TW-007
/** `ChatClient.onMessage` handler: filter, publish, and survive a failed publish. */
export function createMessageHandler({ toEvent, bus, log }: MessageDeps) {
  return async (user: string, text: string, info: ChatUserInfo): Promise<void> => {
    const ev = toEvent(user, text, info);
    if (!ev) return;
    try {
      await bus.publish("chat.message", ev);
    } catch (err) {
      log.warn({ err: String(err) }, "chat.message publish failed");
    }
  };
}

/** The part of a twurple auth provider that registers a user token. */
export interface TokenRegistry {
  addUserForToken(token: Parameters<RefreshingAuthProvider["addUserForToken"]>[0], intents?: string[]): Promise<string>;
}

// @spec CHAT-TW-006, CHAT-TW-010
/**
 * Register the user token and wait for it, so the chat client never asks for credentials first.
 * A missing refresh token is rejected up front: twurple's `addUserForToken` cannot register without one.
 */
export async function registerUserToken(
  provider: TokenRegistry,
  tokens: { accessToken: string; refreshToken: string | undefined },
): Promise<void> {
  const refreshToken = tokens.refreshToken?.trim();
  if (!refreshToken) {
    throw new Error("TWITCH_REFRESH_TOKEN is required when TWITCH_ACCESS_TOKEN is set (the authenticated Twitch path)");
  }
  await provider.addUserForToken(
    { accessToken: tokens.accessToken, refreshToken, expiresIn: 0, obtainmentTimestamp: 0 },
    ["chat"],
  );
}
