import type { AuthProvider, RefreshingAuthProvider } from "@twurple/auth";
import type { EventInput, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { ChatUserInfo } from "./filter.js";
import type { ChatSource, ChatSourceStartEnv, ChatSourceState, ChatSourceStatus } from "./source.js";
import { loadStoredToken, saveStoredToken, type StoredToken } from "./token-store.js";

/** The part of `@twurple/chat`'s `ChatClient` the source uses. */
export interface ChatClientLike {
  onConnect(cb: () => void): unknown;
  onDisconnect(cb: (manually: boolean, reason?: Error) => void): unknown;
  onMessage(cb: (channel: string, user: string, text: string, msg: { userInfo: ChatUserInfo }) => void): unknown;
  connect(): unknown;
  quit(): unknown;
}

export interface MessageDeps {
  toEvent: (user: string, text: string, info: ChatUserInfo) => EventInput<"chat.message"> | undefined;
  bus: Publisher;
  log: Logger;
}

// @spec CHAT-TW-008, CHAT-TW-007
/** Filter a line, publish it as `chat.message`, and survive a failed publish. */
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

  constructor(private readonly opts: TwitchSourceOptions) {}

  state(): ChatSourceStatus {
    return this.status;
  }

  async start(env: ChatSourceStartEnv): Promise<void> {
    const { channel } = this.opts;
    const authProvider = await this.buildAuth(env);
    const client = await (this.opts.createClient ?? defaultCreateClient)({ authProvider, channels: [channel], logger: { minLevel: "warning" } });
    this.client = client;
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
    client.onMessage((_chan, user, text, msg) => {
      const u = msg.userInfo;
      env.emit({ login: user, displayName: u.displayName, userId: u.userId, isMod: u.isMod, isBroadcaster: u.isBroadcaster, isSubscriber: u.isSubscriber, platform: "twitch" }, text);
    });
    client.connect();
  }

  stop(): void {
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
