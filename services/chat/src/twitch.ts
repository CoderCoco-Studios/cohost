import type { AuthProvider, RefreshingAuthProvider } from "@twurple/auth";
import type { EventInput, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { ChatSender } from "./filter.js";
import type { ChatSource, ChatSourceStartEnv, ChatSourceState, ChatSourceStatus } from "./source.js";
import { loadStoredToken, saveStoredToken, type StoredToken } from "./token-store.js";

/** The sender fields twurple's `ChatUser` gives the source. */
export interface TwitchUserInfo {
  displayName: string;
  userId: string;
  isMod: boolean;
  isBroadcaster: boolean;
  isSubscriber: boolean;
}

/** The part of `@twurple/chat`'s `ChatClient` the source uses: its message, removal and connection events, and connect/quit. */
export interface ChatClientLike {
  onConnect(cb: () => void): unknown;
  onDisconnect(cb: (manually: boolean, reason?: Error) => void): unknown;
  onMessage(cb: (channel: string, user: string, text: string, msg: { id: string; userInfo: TwitchUserInfo }) => void): unknown;
  onMessageRemove(cb: (channel: string, messageId: string, msg: unknown) => void): unknown;
  onBan(cb: (channel: string, user: string, msg: { targetUserId: string | null }) => void): unknown;
  onTimeout(cb: (channel: string, user: string, duration: number, msg: { targetUserId: string | null }) => void): unknown;
  onChatClear(cb: (channel: string, msg: unknown) => void): unknown;
  connect(): unknown;
  quit(): unknown;
}

export interface MessageDeps {
  toEvent: (sender: ChatSender, text: string, messageId?: string) => EventInput<"chat.message"> | undefined;
  bus: Publisher;
  log: Logger;
}

// @spec CHAT-TW-008, CHAT-TW-007
/** Filter a line, publish it as `chat.message`, and survive a failed publish. */
export function createMessageHandler({ toEvent, bus, log }: MessageDeps) {
  return async (sender: ChatSender, text: string, messageId?: string): Promise<void> => {
    const ev = toEvent(sender, text, messageId);
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

// @spec CHAT-TW-006, CHAT-TW-010, CHAT-TW-012
/**
 * Register the user token and wait for it, so the chat client never asks for credentials first.
 * A missing refresh token is rejected up front: twurple's `addUserForToken` cannot register without one.
 * With `stored` the stored token is registered as it is; otherwise the `secrets.yaml` pair is, marked as already
 * expired so the first use refreshes it.
 */
export async function registerUserToken(
  provider: TokenRegistry,
  tokens: { accessToken: string; refreshToken: string | undefined; stored?: StoredToken },
): Promise<void> {
  const refreshToken = tokens.refreshToken?.trim();
  if (!refreshToken) {
    throw new Error("chat.twitch.refresh_token is required when chat.twitch.access_token is set (the authenticated Twitch path)");
  }
  await provider.addUserForToken(
    tokens.stored ?? { accessToken: tokens.accessToken, refreshToken, expiresIn: 0, obtainmentTimestamp: 0 },
    ["chat"],
  );
}

export type CreateClient = (opts: { authProvider?: AuthProvider; channels: string[]; logger: { minLevel: "warning" } }) => ChatClientLike | Promise<ChatClientLike>;
export type CreateAuth = (clientId: string, clientSecret: string) => Promise<RefreshingAuthProvider> | RefreshingAuthProvider;

async function defaultCreateClient(opts: Parameters<CreateClient>[0]): Promise<ChatClientLike> {
  const { ChatClient } = await import("@twurple/chat");
  return new ChatClient(opts) as unknown as ChatClientLike;
}

async function defaultCreateAuth(clientId: string, clientSecret: string): Promise<RefreshingAuthProvider> {
  const { RefreshingAuthProvider } = await import("@twurple/auth");
  return new RefreshingAuthProvider({ clientId, clientSecret });
}

export interface TwitchSourceOptions {
  /** The normalised channel (CHAT-PLAN-004); the plan guarantees it is not empty. */
  channel: string;
  twitch: Config["chat"]["twitch"];
  /** Where refreshed tokens are kept. */
  tokenPath: string;
  createClient?: CreateClient;
  createAuth?: CreateAuth;
}

// @spec CHAT-TW-004, CHAT-TW-005, CHAT-TW-008, CHAT-TW-009, CHAT-PLAN-002, CHAT-PLAN-005
/**
 * The Twitch chat source: anonymous (read-only) unless all of the client id, secret and access token are set. The
 * `@twurple/*` libraries load only here, when the source starts. `reconnect` is left at the library default (true),
 * so a dropped connection comes back on its own and reports `reading` again.
 */
export class TwitchSource implements ChatSource {
  readonly name = "twitch" as const;
  private status: ChatSourceStatus = { state: "starting" };
  private client?: ChatClientLike;
  private stopped = false;

  constructor(private readonly opts: TwitchSourceOptions) {}

  state(): ChatSourceStatus {
    return this.status;
  }

  async start(env: ChatSourceStartEnv): Promise<void> {
    const { channel } = this.opts;
    const authProvider = await this.buildAuth(env);
    if (this.stopped) return;
    const client = await (this.opts.createClient ?? defaultCreateClient)({ authProvider, channels: [channel], logger: { minLevel: "warning" } });
    this.client = client;
    // A stop that arrived while the client was being built: quit it and never connect.
    if (this.stopped) {
      client.quit();
      return;
    }
    const setState = (state: ChatSourceState, reason?: string) => {
      this.status = { state, reason };
      env.onState(state, reason);
    };

    client.onConnect(() => {
      setState("reading");
      env.log.info({ channel, authenticated: !!authProvider }, "connected to twitch chat");
    });
    client.onDisconnect((manually, reason) => {
      setState("retrying");
      env.log.warn({ manually, reason }, "twitch chat disconnected");
    });
    // @spec CHAT-TW-013, CHAT-FILT-012
    client.onMessage((_chan, user, text, msg) => {
      const u = msg.userInfo;
      // The broadcaster counts as a moderator; the ignore identifiers are the login and the display name.
      env.emit({
        displayName: u.displayName, login: user, userId: u.userId, isMod: u.isMod || u.isBroadcaster, isSub: u.isSubscriber,
        ignoreIdentifiers: [user, u.displayName],
      }, text, msg.id);
    });

    // Removals only listen: cohost forgets what the platform removed and sends nothing back (CHAT-FORGET-007).
    // @spec CHAT-TW-014, CHAT-FORGET-001
    client.onMessageRemove((_chan, messageId) => {
      env.emitRemoval({ platform: "twitch", scope: "message", messageId });
    });
    // @spec CHAT-TW-015, CHAT-TW-016, CHAT-TW-018, CHAT-FORGET-008
    const removeViewer = (user: string, targetUserId: string | null, reason: "banned" | "timeout") => {
      if (!targetUserId) {
        env.log.warn({ channel, user, reason }, "twitch removal names no target user id; nothing forgotten");
        return;
      }
      env.emitRemoval({ platform: "twitch", scope: "user", userId: targetUserId, reason });
    };
    client.onBan((_chan, user, msg) => removeViewer(user, msg.targetUserId, "banned"));
    client.onTimeout((_chan, user, _duration, msg) => removeViewer(user, msg.targetUserId, "timeout"));
    // @spec CHAT-TW-017
    client.onChatClear(() => {
      env.emitRemoval({ platform: "twitch", scope: "all", reason: "cleared" });
    });
    client.connect();
  }

  stop(): void {
    this.stopped = true;
    this.client?.quit();
  }

  // @spec CHAT-TW-001, CHAT-TW-002, CHAT-TW-003, CHAT-TW-010, CHAT-TW-011, CHAT-TW-012
  private async buildAuth(env: ChatSourceStartEnv): Promise<AuthProvider | undefined> {
    const { client_id: clientId, client_secret: clientSecret, access_token: accessToken, refresh_token: refreshToken } = this.opts.twitch;
    if (!clientId || !clientSecret || !accessToken) return undefined;
    const provider = await (this.opts.createAuth ?? defaultCreateAuth)(clientId, clientSecret);
    const file = this.opts.tokenPath;
    const startingRefresh = refreshToken.trim();
    provider.onRefresh((_userId, token) => {
      env.log.info({ expiresIn: token.expiresIn }, "twitch token refreshed");
      if (!token.refreshToken) return;
      try {
        saveStoredToken(file, { ...token, refreshToken: token.refreshToken } as StoredToken, startingRefresh);
      } catch (err) {
        env.log.warn({ err: String(err), file }, "could not persist the refreshed twitch token");
      }
    });
    // @spec CHAT-TW-006
    const stored = startingRefresh ? loadStoredToken(file, startingRefresh) : undefined;
    if (stored) env.log.info({ file }, "using the stored twitch token");
    await registerUserToken(provider, { accessToken, refreshToken, stored });
    return provider;
  }
}
